import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { skillSources, hash } from '../.build/contracts.js';
import { fetchInstructions } from '../src/platform/instructions.mjs';
import { digest, registrationKey, runnerLabels } from '../src/platform/checkpoint-policy.mjs';
import { dispatchOnce, prepareQueue, queuePrepared, resolveSkills, resolveSource, waitForStop } from '../src/platform/submission.mjs';
import { exec, root } from './helpers.mjs';

test('the complete selected skill list defaults empty and permits SDLC names without reserved defaults', () => {
  assert.deepEqual(skillSources([]), []);
  const chosen = [{ repository: 'fixture/skills', revision: 'a'.repeat(40), names: ['plan-audit', 'sdlc-plan-implementation'] }];
  assert.deepEqual(skillSources(chosen), chosen);
  assert.throws(() => skillSources([{ ...chosen[0], revision: 'main' }]));
  assert.throws(() => skillSources([...chosen, ...chosen]));
  assert.deepEqual(runnerLabels(['self-hosted', 'Linux', 'ARM64']), ['self-hosted', 'Linux', 'ARM64']);
  for (const labels of [['windows-latest'], ['self-hosted'], ['self-hosted', 'Linux', 'Windows'], []]) assert.throws(() => runnerLabels(labels));
});
test('the real HTTPS instruction download freezes exact UTF-8 bytes and rejects a changed expected hash', async () => {
  const url = 'https://raw.githubusercontent.com/markhuangai/agent-remote-dev-codex/06b75388297a0bb163320193e31b7c426805bb62/AGENTS.md';
  const fetched = await fetchInstructions(url);
  assert.match(fetched.content, /^# Repository development/); assert.equal(fetched.sha256, hash(fetched.content));
  await assert.rejects(fetchInstructions(url, 'f'.repeat(64)), { reason: 'user_agents_hash_mismatch' });
});
test('instruction transport errors, unsafe redirects, over-limit data and invalid encoding fail without truncation', async () => {
  const url = 'https://fixture.invalid/AGENTS.md';
  const bodies = [
    [new Response('x'.repeat(65537)), 'user_agents_size_limit'],
    [new Response(new Uint8Array([255])), 'invalid_user_agents_encoding'],
    [new Response('missing', { status: 404 }), 'user_agents_download_failed'],
    [new Response('', { status: 302, headers: { location: 'http://fixture.invalid/AGENTS.md' } }), 'invalid_user_agents_url'],
  ];
  for (const [response, reason] of bodies) await assert.rejects(fetchInstructions(url, undefined, async () => response), { reason });
  await assert.rejects(fetchInstructions('https://user:password@fixture.invalid/AGENTS.md'), { reason: 'invalid_user_agents_url' });
  await assert.rejects(fetchInstructions('http://fixture.invalid/AGENTS.md'), { reason: 'invalid_user_agents_url' });
});
test('skill repository URLs, mutable refs and omitted names expand to an immutable explicit selection', async () => {
  const api = async path => {
    if (path === '/repos/fixture/skills') return { default_branch: 'main' };
    if (path.endsWith('/commits/main')) return { sha: 'a'.repeat(40) };
    if (path.includes('/git/trees/')) return { truncated: false, tree: [{ type: 'blob', path: 'skills/alpha/SKILL.md' }, { type: 'blob', path: 'skills/beta/SKILL.md' }] };
    if (path.includes('/contents/')) { const name = path.includes('/alpha/') ? 'alpha' : 'beta', bytes = Buffer.from(`---\nname: ${name}\ndescription: Fixture\n---\n`); return { size: bytes.length, encoding: 'base64', content: bytes.toString('base64') }; }
    throw new Error(`Unexpected transport ${path}`);
  };
  assert.deepEqual(await resolveSkills(api, ['https://github.com/fixture/skills']), [{ repository: 'fixture/skills', revision: 'a'.repeat(40), names: ['alpha', 'beta'] }]);
  assert.deepEqual((await resolveSkills(api, [{ repository: 'fixture/skills', names: ['beta'] }]))[0].names, ['beta']);
  await assert.rejects(resolveSkills(api, [{ repository: 'fixture/skills', names: ['missing'] }]), { reason: 'missing_selected_skill' });
});
test('published aliases resolve only to a matching exact release in their channel', async () => {
  const sha = 'a'.repeat(40), releases = [{ id: 1, tag_name: 'v1.0.0', draft: false, prerelease: false, published_at: '2026-11-15T00:00:00Z' },
    { id: 2, tag_name: 'v1.0.0-rc.0', draft: false, prerelease: true, published_at: '2026-11-14T00:00:00Z' }];
  const api = async path => path.includes('/git/ref/tags/') ? { object: { type: 'commit', sha } } : path.includes('/releases?') ? releases : { sha };
  assert.equal((await resolveSource(api, 'fixture/action', 'v1')).release_tag, 'v1.0.0');
  assert.equal((await resolveSource(api, 'fixture/action', 'v1-prerelease')).release_tag, 'v1.0.0-rc.0');
  releases[1].draft = true;
  await assert.rejects(resolveSource(api, 'fixture/action', 'v1-prerelease'), { reason: 'alias_release_missing' });
});
test('ambiguous initial submission reconciles one native task and does not POST twice', async () => {
  let run, posts = 0, now = 0;
  const request = { request_id: 'submission-fixture', source_repository: 'fixture/action', source_sha: 'a'.repeat(40) };
  const api = async (path, options) => {
    if (options?.method === 'POST') { posts++; const payload = JSON.parse(options.inputs.request); run = { id: 15, actor: { login: 'Z-M-Huang' }, path: '.github/workflows/runner-task.yml', head_branch: 'main',
      head_sha: 'b'.repeat(40), repository: { full_name: 'fixture/repo' }, display_title: `Codex request submission-fixture / request-${payload.registration_key}`, html_url: 'https://github.com/fixture/repo/actions/runs/15' };
      throw Object.assign(new Error('private-api-body'), { status: 502 }); }
    return { workflow_runs: run ? [run] : [] };
  };
  const timing = { now: () => now, sleep: async ms => { now += ms; } };
  assert.equal((await dispatchOnce(api, 'fixture/repo', request, 'Z-M-Huang', timing)).run_id, 15);
  assert.equal((await dispatchOnce(api, 'fixture/repo', request, 'Z-M-Huang', timing)).run_id, 15); assert.equal(posts, 1);
  run = undefined;
  await assert.rejects(dispatchOnce(async (path, options) => { if (options?.method === 'POST') { posts++; throw new Error('lost'); } return { workflow_runs: [] }; }, 'fixture/repo', request, 'Z-M-Huang', timing), { reason: 'ambiguous_dispatch_registration' });
  assert.equal(now >= 300000, true); assert.equal(posts, 2);
});
test('reconciliation cannot bind changed prompt or source hashes to an already registered task', async () => {
  const request = { request_id: 'collision-fixture', source_repository: 'fixture/action', source_sha: 'a'.repeat(40), plan: 'Approved bytes', plan_sha256: digest('Approved bytes') };
  let posts = 0;
  const api = async (_path, options) => {
    if (options?.method === 'POST') { posts++; throw new Error('No duplicate dispatch expected'); }
    return { workflow_runs: [{ id: 15, actor: { login: 'Z-M-Huang' }, path: '.github/workflows/runner-task.yml', head_branch: 'main', repository: { full_name: 'fixture/repo' },
      display_title: `Codex request collision-fixture / request-${registrationKey(request)}` }] };
  };
  const receipt = await dispatchOnce(api, 'fixture/repo', request, 'Z-M-Huang');
  assert.equal(receipt.request_sha256, registrationKey(request)); assert.equal(receipt.source_sha, request.source_sha); assert.equal(receipt.plan_sha256, request.plan_sha256);
  for (const changed of [{ ...request, source_sha: 'b'.repeat(40) }, { ...request, plan: 'Changed bytes', plan_sha256: digest('Changed bytes') }]) {
    await assert.rejects(dispatchOnce(api, 'fixture/repo', changed, 'Z-M-Huang'), { reason: 'task_registration_request_mismatch' });
  }
  assert.equal(posts, 0);
});
test('a retained checkpoint can start a new explicit resume activation while retries reuse the same registration', async () => {
  const runs = []; let posts = 0, now = 0;
  const api = async (_path, options) => {
    if (options?.method === 'POST') {
      posts++; const payload = JSON.parse(options.inputs.request);
      assert.equal(payload.registration_key, registrationKey(payload));
      runs.push({ id: 15 + posts, actor: { login: 'Z-M-Huang' }, path: '.github/workflows/runner-task.yml', head_branch: 'main', repository: { full_name: 'fixture/repo' },
        display_title: `Codex task resume-fixture / manual-resume-${payload.resume_artifact_id}-${payload.source_sha}-${payload.registration_key}`, status: 'completed', conclusion: 'cancelled' });
      throw Object.assign(new Error('Ambiguous response'), { status: 502 });
    }
    return { workflow_runs: runs };
  };
  const first = { task_id: 'resume-fixture', source_repository: 'fixture/action', source_sha: 'a'.repeat(40), resume_artifact_id: 41, activation_key: 'a'.repeat(32) };
  const timing = { now: () => now, sleep: async ms => { now += ms; } };
  const stopped = await dispatchOnce(api, 'fixture/repo', first, 'Z-M-Huang', timing);
  assert.equal((await dispatchOnce(api, 'fixture/repo', first, 'Z-M-Huang', timing)).run_id, stopped.run_id);
  const second = { ...first, activation_key: 'b'.repeat(32) }, resumed = await dispatchOnce(api, 'fixture/repo', second, 'Z-M-Huang', timing);
  assert.notEqual(resumed.run_id, stopped.run_id); assert.equal(resumed.activation_key, second.activation_key);
  assert.equal((await dispatchOnce(api, 'fixture/repo', second, 'Z-M-Huang', timing)).run_id, resumed.run_id); assert.equal(posts, 2);
});
test('queue freezes repository configuration and passes issue references verbatim without issue interpretation', async () => {
  const repository = 'fixture/repo', plan = 'Implement https://github.com/fixture/repo/issues/4 using $chosen-skill.\n';
  let content = 'allowed-actors: [Z-M-Huang]\nskills: []\n';
  const files = new Map(), manifest = JSON.parse(await readFile(join(root, 'dist/protocol.json'), 'utf8'));
  for (const path of Object.keys(manifest.files)) files.set(path, await readFile(join(root, path)));
  let dispatches = 0;
  const api = async (path, options) => {
    if (options?.method === 'POST') { dispatches++; throw new Error('No dispatch expected'); }
    if (path === '/user') return { login: 'Z-M-Huang' };
    if (path.includes('/collaborators/')) return { permission: 'write' };
    if (path.includes('/git/ref/heads/main')) return { object: { sha: 'a'.repeat(40) } };
    if (path.includes('/contents/')) {
      const name = path.split('/contents/')[1].split('?')[0];
      const bytes = name === 'remote-codex.yml' ? Buffer.from(content) : name.endsWith('/protocol.json') ? Buffer.from(JSON.stringify(manifest)) : files.get(name);
      assert.ok(bytes, `Unexpected resource ${name}`); return { size: bytes.length, encoding: 'base64', content: bytes.toString('base64') };
    }
    if (path.includes('/commits/')) return { sha: 'a'.repeat(40) };
    if (path.includes('/actions/workflows/')) return { path: `.github/workflows/${path.split('/').at(-1)}`, state: 'active' };
    throw new Error(`Unexpected fixture ${path}`);
  };
  const prepared = await prepareQueue(api, { repo: repository, plan, source_repository: 'fixture/action', source_ref: 'a'.repeat(40) });
  assert.equal(prepared.request.plan, plan); assert.equal(prepared.request.plan_sha256, digest(plan));
  assert.equal(prepared.request.project_config.content, content); assert.equal(prepared.request.project_config.sha256, digest(content));
  assert.equal(prepared.request.task_id, undefined); assert.equal(prepared.request.authorization, undefined); assert.equal(prepared.request.issue_url, undefined);
  content += 'budget-minutes: 5\n';
  await assert.rejects(queuePrepared(api, prepared), error => { assert.equal(error.reason, 'project_config_hash_mismatch'); assert.equal(error.details.observed, digest(content)); return true; });
  assert.equal(dispatches, 0);
});
test('stop waits for native workers and continuation controllers and fails within its bounded timeout', async () => {
  let now = 0, stuck = false;
  const api = async path => {
    if (path.endsWith('/actions/runs/99')) return { status: now >= 10000 ? 'completed' : 'in_progress', conclusion: 'success' };
    if (path.includes('/actions/runs?event=workflow_dispatch')) return { workflow_runs: [{ id: 15, display_title: 'Codex task stop-fixture / manual', status: !stuck && now >= 20000 ? 'completed' : 'in_progress' }] };
    if (path.includes('/actions/runs?event=workflow_run')) return { workflow_runs: [{ id: 16, display_title: 'Codex continuation / 15', status: !stuck && now >= 30000 ? 'completed' : 'in_progress' }] };
    throw new Error('Unexpected stop transport');
  };
  const timing = { now: () => now, sleep: async ms => { now += ms; } }, receipt = { run_id: 99 };
  assert.equal((await waitForStop(api, 'fixture/repo', 'stop-fixture', receipt, timing)).infrastructure_status, 'stopped');
  assert.equal(now, 30000); stuck = true; now = 0;
  await assert.rejects(waitForStop(api, 'fixture/repo', 'stop-fixture', receipt, timing), { reason: 'stop_cancellation_timeout' });
  assert.equal(now, 900000);
});
test('real Actions logging retains safe dispatch failure evidence without API bodies at normal verbosity', async () => {
  const policy = new URL('../src/platform/continuation-policy.mjs', import.meta.url).href;
  const registration = new URL('../src/platform/checkpoint-policy.mjs', import.meta.url).href;
  const script = `import * as core from '@actions/core';import {prepareTaskRequest} from ${JSON.stringify(policy)};import {registrationKey} from ${JSON.stringify(registration)};const request={request_id:'log-fixture'};const github={request:async()=>{throw Object.assign(new Error('private-api-body-8821'),{status:403})}};try{await prepareTaskRequest({github,context:{repo:{owner:'fixture',repo:'repo'},actor:'Z-M-Huang',eventName:'workflow_dispatch'},core,env:{GITHUB_REF:'refs/heads/main',CODEX_RUNNER_PROTOCOL:'3',TASK_REQUEST:JSON.stringify({...request,registration_key:registrationKey(request)}),TRIGGERING_ACTOR:'Z-M-Huang',RUNNER_TEMP:'/tmp',GITHUB_RUN_ID:'13',GITHUB_JOB:'fixture'}})}catch{}`;
  const output = (await exec(process.execPath, ['--input-type=module', '-e', script], { cwd: root })).stdout;
  assert.match(output, /::error::/); assert.doesNotMatch(output, /private-api-body-8821/);
  const line = output.split('\n').find(line => line.includes('"event":"submission.resolve"'));
  const record = JSON.parse(line.slice(line.indexOf('{')));
  assert.equal(record.level, 'ERROR'); assert.equal(record.task_id, '13'); assert.equal(record.submission_id, 'log-fixture'); assert.equal(record.http_status, 403); assert.equal(record.outcome, 'rejected');
});
