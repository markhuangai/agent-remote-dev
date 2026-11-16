import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { hash, versions } from '../.build/contracts.js';
import { exportCheckpoint } from '../.build/checkpoint.js';
import { restoreCheckpoint, unpackArchive, validateCheckpoint } from '../.build/resume.js';
import { TaskGit } from '../.build/git.js';
import { verifyResumeSettings } from '../.build/continuation.js';
import { prepareInvocation } from '../.build/invocation.js';
import { checkpointName, recordName, registrationKey, validateManifest, validateProducer } from '../src/platform/checkpoint-policy.mjs';
import { authorizeActivation, childRunName, continuationDecision, prepareTaskRequest, resolveTaskRequest, runController, requireActive, cancelTaskRuns } from '../src/platform/continuation-policy.mjs';
import { verifyProtocol } from '../src/platform/protocol-policy.mjs';
import { parseProjectConfig } from '../src/platform/project-config.mjs';
import { workflowCommand } from '../src/platform/control.mjs';
import { exec, execution, fixture, lineage as fixtureLineage, repository, root } from './helpers.mjs';

const repo = 'fixture/repo', taskId = '13', branch = 'skill/selected-branch', sourceSha = 'a'.repeat(40);
const lineage = fixtureLineage;
const json = value => JSON.stringify(value);
const registered = value => json({ ...value, registration_key: registrationKey(value) });
async function zipEntries(f, name, entries) {
  const path = join(f.temporary, `${name}.zip`);
  await exec('python3', ['-c', `import json,stat,sys,zipfile
with zipfile.ZipFile(sys.argv[1],'w',compression=zipfile.ZIP_DEFLATED) as z:
 for item in json.loads(sys.argv[2]):
  entry=zipfile.ZipInfo(item['name']);entry.external_attr=item.get('mode',stat.S_IFREG|0o600)<<16
  z.writestr(entry,item.get('text',''))`, path, json(entries)]);
  return readFile(path);
}
async function zipDirectory(f, name, directory) {
  const path = join(f.temporary, `${name}.zip`);
  await exec('python3', ['-c', `import pathlib,sys,zipfile
root=pathlib.Path(sys.argv[2])
with zipfile.ZipFile(sys.argv[1],'w',compression=zipfile.ZIP_DEFLATED) as z:
 for p in sorted(root.rglob('*')):
  if p.is_file():z.write(p,str(p.relative_to(root)))`, path, directory]);
  return readFile(path);
}
async function replaceManifest(f, name, bytes, manifest) {
  const input = join(f.temporary, `${name}-input.zip`), output = join(f.temporary, `${name}-output.zip`);
  await writeFile(input, bytes);
  await exec('python3', ['-c', `import sys,zipfile
with zipfile.ZipFile(sys.argv[1]) as original,zipfile.ZipFile(sys.argv[2],'w',compression=zipfile.ZIP_DEFLATED) as target:
 for entry in original.infolist():target.writestr(entry,sys.argv[3].encode() if entry.filename=='manifest.json' else original.read(entry.filename))`, input, output, json(manifest)]);
  return readFile(output);
}
function normalCore() {
  const records = [], sink = line => records.push(JSON.parse(line));
  return { records, core: { info: sink, warning: sink, error: sink, debug() {} } };
}
async function protocolFixture(t, supplied) {
  const f = await fixture(t);
  let manifest, checkpointZip;
  if (supplied) ({ manifest, checkpointZip } = supplied);
  else {
    const session = randomUUID(), plan = 'Continue the approved fixture plan.';
    await mkdir(join(f.job.codexHome, 'sessions'));
    await writeFile(join(f.job.codexHome, 'sessions', 'rollout.jsonl'), json({ type: 'session_meta', payload: { id: session } }) + '\n');
    const exported = await exportCheckpoint(f.job, { task_id: taskId, repository: repo, branch, base_sha: sourceSha, checkpoint_sha: 'b'.repeat(40),
      plan, plan_source: 'inline', authorization: { repository: repo, plan_sha256: hash(plan), request: 'Implement through bounded continuation and audited PR delivery.' },
      session_id: session, sessions: [session], skills: [], user_agents: null, lineage, previous: null,
      execution: execution(), workspace: '/old/project' }, f.log);
    manifest = JSON.parse(await readFile(join(exported.root, 'manifest.json'), 'utf8'));
    checkpointZip = await zipDirectory(f, 'checkpoint', exported.root);
  }
  const parent = { id: 13, run_attempt: 1, status: 'completed', conclusion: 'timed_out', event: 'workflow_dispatch', path: '.github/workflows/runner-task.yml',
    head_branch: 'main', head_sha: sourceSha, workflow_id: 7, display_title: childRunName(taskId), repository: { full_name: repo }, head_repository: { full_name: repo },
    actor: { login: 'Z-M-Huang' }, triggering_actor: { login: 'Z-M-Huang' }, html_url: `https://github.com/${repo}/actions/runs/13` };
  const request = { schema_version: 3, repository: repo, task_id: taskId, branch, base_sha: manifest.base_sha, plan_sha256: manifest.plan_sha256,
    authorization: manifest.authorization, execution: manifest.execution, lineage, resume_artifact_id: null,
    plan_source: manifest.plan_source, skills: manifest.skills };
  const artifacts = new Map(), payloads = new Map();
  const addArtifact = (id, name, bytes, producer = 13) => {
    const artifact = { id, name, size_in_bytes: bytes.length, expired: false, expires_at: new Date(Date.now() + 86400000).toISOString(), workflow_run: { id: producer } };
    artifacts.set(id, artifact); payloads.set(id, bytes); return artifact;
  };
  addArtifact(supplied?.artifact_id ?? 41, checkpointName(manifest), checkpointZip);
  addArtifact(40, recordName('run', taskId, '13', '1'), await zipEntries(f, 'request', [{ name: 'record.json', text: json(request) }]));
  const controller = { ...parent, id: 99, event: 'workflow_run', path: '.github/workflows/runner-continuation.yml' };
  const model = { manifest, parent, request, artifacts, payloads, children: [], dispatches: [], registration: 'normal', controller,
    runs: new Map([[13, parent], [99, controller]]), endedAt: new Date(Date.now() - 1000).toISOString(), observedHead: manifest.checkpoint_sha };
  model.protocol = JSON.parse(await readFile(join(root, 'dist/protocol.json'), 'utf8'));
  model.sources = new Map();
  for (const path of Object.keys(model.protocol.files)) model.sources.set(path, await readFile(join(root, path)));
  model.sources.set('remote-codex.yml', await readFile(join(root, 'remote-codex.yml')));
  model.jobs = new Map(); model.cancelled = [];
  const api = async (endpoint, options = {}) => {
    const method = options.method ?? 'GET';
    if (endpoint.startsWith('/repos/markhuangai/agent-remote-dev-codex/contents/skills/remote-codex/assets/runner-task.yml?')) {
      const bytes = await readFile(join(root, 'skills/remote-codex/assets/runner-task.yml'));
      return { size: bytes.length, encoding: 'base64', content: bytes.toString('base64') };
    }
    if (endpoint === `/repos/markhuangai/agent-remote-dev-codex/commits/${sourceSha}`) return { sha: sourceSha };
    if (endpoint.includes('/collaborators/')) return { permission: model.permissions?.[endpoint.split('/collaborators/')[1].split('/')[0]] ?? model.permission ?? 'write' };
    if (endpoint === `/repos/${repo}/git/ref/heads/main`) return { object: { sha: sourceSha } };
    if (endpoint.startsWith(`/repos/${repo}/contents/`)) {
      const path = endpoint.split('/contents/')[1].split('?')[0];
      const bytes = path === 'dist/protocol.json' ? Buffer.from(json(model.protocol)) : model.sources.get(path);
      return { size: bytes.length, encoding: 'base64', content: bytes.toString('base64') };
    }
    if (endpoint.match(/\/actions\/artifacts\/[0-9]+(?:\/zip)?$/)) {
      const id = Number(endpoint.match(/artifacts\/([0-9]+)/)[1]);
      return endpoint.endsWith('/zip') ? payloads.get(id) : artifacts.get(id);
    }
    if (endpoint === `/repos/action/source/commits/${sourceSha}` || endpoint === `/repos/${repo}/commits/${sourceSha}`) return { sha: sourceSha };
    if (method === 'POST' && /\/actions\/runs\/[0-9]+\/cancel$/.test(endpoint)) { model.cancelled.push(Number(endpoint.match(/runs\/([0-9]+)/)[1])); return undefined; }
    if (/\/actions\/runs\/[0-9]+(?:\/attempts\/[0-9]+)?$/.test(endpoint)) return model.runs.get(Number(endpoint.match(/runs\/([0-9]+)/)[1]));
    if (endpoint === `/repos/${repo}/actions/workflows/7`) return { path: parent.path, state: 'active' };
    if (endpoint === `/repos/${repo}/actions/workflows/runner-task.yml`) return { path: '.github/workflows/runner-task.yml', state: 'active' };
    if (endpoint === `/repos/${repo}/actions/workflows/runner-continuation.yml`) return { path: '.github/workflows/runner-continuation.yml', state: 'active' };
    if (endpoint === `/repos/${repo}/actions/workflows/runner-published.yml`) return { path: '.github/workflows/runner-published.yml', state: 'active' };
    if (/\/actions\/runs\/[0-9]+\/artifacts\?/.test(endpoint)) return { artifacts: [...artifacts.values()].filter(artifact => artifact.workflow_run.id === Number(endpoint.match(/runs\/([0-9]+)/)[1])) };
    if (endpoint.startsWith(`/repos/${repo}/actions/artifacts?`)) {
      const name = new URL('https://api.invalid' + endpoint).searchParams.get('name');
      return { artifacts: [...artifacts.values()].filter(artifact => !name || artifact.name === name) };
    }
    if (endpoint === `/repos/${repo}/git/ref/heads/${branch}`) return { object: { sha: model.observedHead } };
    if (/\/actions\/runs\/[0-9]+\/attempts\/[0-9]+\/jobs\?/.test(endpoint)) return { jobs: model.jobs.get(Number(endpoint.match(/runs\/([0-9]+)/)[1])) ?? [{ id: 70, name: 'execute', status: 'completed', completed_at: model.endedAt }] };
    if (endpoint.startsWith(`/repos/${repo}/actions/runs?`) || endpoint.startsWith(`/repos/${repo}/actions/workflows/runner-task.yml/runs?`)) return { workflow_runs: [model.parent, ...model.children] };
    if (method === 'POST' && endpoint.endsWith('/runner-task.yml/dispatches')) {
      const submitted = JSON.parse(options.inputs.request); model.dispatches.push(submitted);
      if (model.registration !== 'absent') {
        const id = Math.max(...model.runs.keys(), ...model.children.map(child => child.id)) + 1;
        const child = { ...parent, id, status: 'queued', conclusion: null, html_url: `https://github.com/${repo}/actions/runs/${id}`,
          display_title: childRunName(taskId, submitted.dispatch_key), actor: { login: 'github-actions[bot]' }, triggering_actor: { login: 'github-actions[bot]' } };
        model.children.push(child); model.runs.set(id, child);
      }
      if (model.registration === 'ambiguous') throw Object.assign(new Error('Transport disconnected'), { code: 'ECONNRESET' });
      return undefined;
    }
    throw new Error(`Unexpected fixture API ${method} ${endpoint}`);
  };
  const github = { request: async (route, options) => ({ data: await api(route.slice(route.indexOf(' ') + 1), { ...options, method: route.split(' ')[0] }) }) };
  const env = { ...process.env, GITHUB_REF: 'refs/heads/main', GITHUB_REPOSITORY: repo, GITHUB_RUN_ID: '99', GITHUB_RUN_ATTEMPT: '1',
    GITHUB_WORKFLOW_SHA: sourceSha, GITHUB_WORKFLOW_REF: `${repo}/.github/workflows/runner-task.yml@refs/heads/main`, RUNNER_TEMP: f.temporary, CONTINUATION_MODE: 'resolve', GITHUB_JOB: 'resolve', TRIGGERING_ACTOR: 'github-actions[bot]' };
  env.CODEX_RUNNER_PROTOCOL = '3';
  const context = { repo: { owner: 'fixture', repo: 'repo' }, actor: 'github-actions[bot]', eventName: 'workflow_run', payload: { workflow_run: { ...parent } } };
  return { ...f, runtimeRecords: f.records, model, api, github, env, context, addArtifact, ...normalCore() };
}


test('schema-3 checkpoints bind selected inputs and native sessions without an SDLC package or branch convention', async t => {
  const f = await protocolFixture(t), m = f.model.manifest;
  assert.equal(validateCheckpoint(m, repo).session_id, m.sessions[0]); assert.deepEqual(m.skills, []);
  assert.equal(validateManifest({ ...m, branch: 'main' }, { repository: repo }).branch, 'main');
  for (const [change, reason] of [
    [{ schema_version: 2 }, 'unsupported_checkpoint_schema'], [{ repository: 'other/repo' }, 'checkpoint_repository_mismatch'],
    [{ versions: { ...versions, codex: '0.168.0' } }, 'checkpoint_version_mismatch'], [{ plan: 'Changed prompt' }, 'checkpoint_plan_hash_mismatch'],
    [{ authorization: { ...m.authorization, request: '' } }, 'authorization_mismatch'], [{ session_id: randomUUID() }, 'checkpoint_session_mismatch'],
    [{ user_agents: { url: 'https://example.invalid/AGENTS.md', sha256: hash('original'), content: 'changed' } }, 'user_agents_hash_mismatch'],
    [{ branch: '../escape' }, 'invalid_checkpoint_git_identity'], [{ files: [{ path: '../escape' }] }, 'unsafe_checkpoint_path'],
  ]) assert.throws(() => validateManifest({ ...m, ...change }, { repository: repo, versions }), { reason });
  const artifact = f.model.artifacts.get(41);
  validateProducer(artifact, f.model.parent, m, repo);
  for (const run of [{ ...f.model.parent, event: 'pull_request' }, { ...f.model.parent, head_branch: 'feature' }, { ...f.model.parent, head_sha: 'c'.repeat(40) },
    { ...f.model.parent, run_attempt: 2 }, { ...f.model.parent, actor: { login: 'other' } }]) assert.throws(() => validateProducer(artifact, run, m, repo));
});

test('trusted protocol verification rejects missing, changed and incompatible resources', async t => {
  const f = await protocolFixture(t);
  assert.equal((await verifyProtocol(f.api, repo)).protocol_version, 3);
  f.model.protocol.protocol_version = 2;
  await assert.rejects(verifyProtocol(f.api, repo), { reason: 'incompatible_runner_protocol' });
  f.model.protocol.protocol_version = 3;
  f.model.sources.set('src/platform/archive.py', Buffer.from('changed archive helper'));
  await assert.rejects(verifyProtocol(f.api, repo), { reason: 'protocol_source_mismatch' });
});

test('real remote branch drift rejects native restore without changing the fresh checkout or session destination', async t => {
  const f = await protocolFixture(t), r = await repository(f);
  await r.git('branch', '-m', branch); await r.git('push', 'origin', branch);
  const original = await r.git('rev-parse', 'HEAD');
  await writeFile(join(r.cwd, 'drift.txt'), 'External branch advance');
  await r.git('add', 'drift.txt'); await r.git('commit', '-m', 'Advance remote branch'); await r.git('push', 'origin', branch);
  const advanced = await r.git('rev-parse', 'HEAD');
  const fresh = await fixture(t), cwd = join(fresh.temporary, 'fresh');
  await exec('git', ['clone', '--branch', 'main', r.remote, cwd], { env: fresh.job.env });
  const git = new TaskGit(cwd, fresh.job.env, fresh.log), homeBefore = await readdir(fresh.job.codexHome);
  const archive = join(fresh.temporary, 'checkpoint.zip'), snapshot = join(fresh.temporary, 'snapshot');
  await writeFile(archive, f.model.payloads.get(41));
  await unpackArchive(fresh.job, archive, snapshot, 'checkpoint', fresh.log);
  const manifest = { ...f.model.manifest, base_sha: original, checkpoint_sha: original };
  await assert.rejects(restoreCheckpoint(fresh.job, snapshot, manifest, git, fresh.log), { reason: 'resume_branch_drift' });
  assert.equal(await git.head(), original); assert.equal((await git.run(['branch', '--show-current'])).trim(), 'main');
  assert.equal(await git.changedPaths(), ''); assert.deepEqual(await readdir(fresh.job.codexHome), homeBefore);
  await assert.rejects(readFile(join(cwd, 'drift.txt')), { code: 'ENOENT' });
  await assert.rejects(readFile(join(fresh.job.codexHome, 'sessions/rollout.jsonl')), { code: 'ENOENT' });
  const failure = fresh.records.find(record => record.event === 'resume.restore');
  assert.equal(failure.reason, 'resume_branch_drift'); assert.equal(failure.level, 'ERROR');
  assert.equal(failure.expected_sha, original); assert.equal(failure.observed_sha, advanced);
  assert.equal(failure.session_id, manifest.session_id); process.stdout.write(json(failure) + '\n');
});

test('trusted fresh requests freeze selected setup and reject unlisted or read-only operators', async t => {
  const f = await protocolFixture(t), plan = 'Run an arbitrary selected workflow.';
  const content = 'allowed-actors: [Z-M-Huang]\nrunner: [self-hosted, Linux, X64]\ngit-author: {name: Fixture Author, email: fixture@example.invalid}\n';
  f.model.sources.set('remote-codex.yml', Buffer.from(content));
  const { allowed_actors, ...settings } = parseProjectConfig(content);
  const request = { request_id: 'new-request', source_repository: 'action/source', source_sha: sourceSha, plan, plan_sha256: hash(plan),
    ...settings, user_agents_sha256: null, project_config: { revision: sourceSha, sha256: hash(content), content } };
  const env = { ...f.env, GITHUB_RUN_ID: '200', GITHUB_JOB: 'fresh', GITHUB_RUN_ATTEMPT: '1', TRIGGERING_ACTOR: 'Z-M-Huang', TASK_REQUEST: registered(request) };
  const context = { ...f.context, actor: 'Z-M-Huang', eventName: 'workflow_dispatch' };
  const result = await prepareTaskRequest({ github: f.github, context, core: f.core, env });
  const fixed = JSON.parse(result.execution);
  assert.deepEqual(fixed.runner, request.runner); assert.equal(fixed.source_repository, 'action/source'); assert.equal(fixed.budget_minutes, 300);
  assert.equal(result.skills, '[]'); assert.equal(fixed.activation_run_id, '200'); assert.equal(result.task_id, '200');
  assert.equal(fixed.project_config.sha256, hash(content));
  const resolved = await resolveTaskRequest({ github: f.github, context, core: f.core, env });
  assert.deepEqual(resolved.execution, fixed); assert.deepEqual(resolved.runner, request.runner);
  assert.deepEqual(resolved.skills, []); assert.equal(resolved.authorization.request, plan);
  await assert.rejects(prepareTaskRequest({ github: f.github, context, core: f.core, env: { ...env, TASK_REQUEST: json({ ...request, plan: 'Changed bytes', registration_key: registrationKey(request) }) } }), /request_registration_mismatch/);
  const changed = content + 'budget-minutes: 5\n';
  f.model.sources.set('remote-codex.yml', Buffer.from(changed));
  await assert.rejects(prepareTaskRequest({ github: f.github, context, core: f.core, env }), /project_config_hash_mismatch/);
  const failure = f.records.findLast(record => record.reason === 'project_config_hash_mismatch');
  assert.equal(failure.expected, hash(content)); assert.equal(failure.observed, hash(changed));
  f.model.sources.set('remote-codex.yml', Buffer.from(content));
  await assert.rejects(prepareTaskRequest({ github: f.github, context: { ...context, actor: 'outsider' }, core: f.core, env }), /untrusted_task_actor/);
  f.model.permission = 'read';
  await assert.rejects(prepareTaskRequest({ github: f.github, context, core: f.core, env }), /operator_write_permission_required/);
  assert.ok(f.records.some(record => record.event === 'submission.resolve' && record.reason === 'operator_write_permission_required'));
});

test('a stop received before root run registration fences the initial request nonce', async t => {
  const f = await protocolFixture(t), content = await readFile(join(root, 'remote-codex.yml'), 'utf8');
  const { allowed_actors, ...settings } = parseProjectConfig(content), plan = 'Run this prompt.';
  const request = { request_id: 'not-yet-registered', source_repository: 'action/source', source_sha: sourceSha, plan, plan_sha256: hash(plan),
    ...settings, user_agents_sha256: null, project_config: { revision: sourceSha, content, sha256: hash(content) } };
  const stop = { operation: 'stop', task_id: request.request_id, stop_key: 'e'.repeat(32) };
  const stopArgs = { github: f.github, context: { ...f.context, actor: 'Z-M-Huang', eventName: 'workflow_dispatch' }, core: f.core,
    env: { ...f.env, GITHUB_RUN_ID: '200', TRIGGERING_ACTOR: 'Z-M-Huang', TASK_REQUEST: registered(stop) } };
  assert.deepEqual(await resolveTaskRequest(stopArgs), stop);
  assert.deepEqual(await prepareTaskRequest(stopArgs), stop);
  f.model.children.push({ ...f.model.parent, id: 150, display_title: `Codex stop ${request.request_id} / ${'e'.repeat(32)}` });
  await assert.rejects(prepareTaskRequest({ github: f.github, context: { ...f.context, actor: 'Z-M-Huang', eventName: 'workflow_dispatch' }, core: f.core,
    env: { ...f.env, GITHUB_RUN_ID: '200', TRIGGERING_ACTOR: 'Z-M-Huang', TASK_REQUEST: registered(request) } }), /request_stopped/);
  assert.equal(f.model.dispatches.length, 0);
  assert.ok(f.records.some(record => record.reason === 'request_stopped' && record.submission_id === request.request_id));
});
test('stop refuses unrelated workflow run IDs without cancelling any jobs', async t => {
  const f = await protocolFixture(t);
  Object.assign(f.model.parent, { status: 'in_progress', path: '.github/workflows/release.yml', display_title: 'Publish release' });
  f.model.artifacts.delete(40);
  await assert.rejects(cancelTaskRuns({ github: f.github, context: { ...f.context, actor: 'Z-M-Huang' }, core: f.core, taskId,
    env: { ...f.env, TRIGGERING_ACTOR: 'Z-M-Huang' } }), /unproven_task_root/);
  assert.deepEqual(f.model.cancelled, []);
});
test('stop verifies a standalone root record and cancels only its root, children and controllers', async t => {
  const f = await protocolFixture(t);
  Object.assign(f.model.parent, { status: 'in_progress', path: '.github/workflows/custom.yml', display_title: 'Remote Codex' });
  f.model.request.lineage = { ...f.model.request.lineage, workflow_ref: `${repo}/.github/workflows/custom.yml@refs/heads/main` };
  f.model.payloads.set(40, await zipEntries(f, 'standalone-root-record', [{ name: 'record.json', text: json(f.model.request) }]));
  f.model.artifacts.get(40).size_in_bytes = f.model.payloads.get(40).length;
  f.model.children.push(
    { ...f.model.parent, id: 200, path: '.github/workflows/runner-task.yml', display_title: childRunName(taskId, 'e'.repeat(64)), status: 'queued' },
    { ...f.model.parent, id: 201, path: '.github/workflows/runner-continuation.yml', display_title: 'Codex continuation / 13' },
    { ...f.model.parent, id: 202, path: '.github/workflows/ci.yml', display_title: 'Unrelated CI' },
  );
  const cancelled = await cancelTaskRuns({ github: f.github, context: { ...f.context, actor: 'Z-M-Huang' }, core: f.core, taskId,
    env: { ...f.env, TRIGGERING_ACTOR: 'Z-M-Huang' } });
  assert.deepEqual(cancelled, [13, 200, 201]); assert.deepEqual(f.model.cancelled, [13, 200, 201]);
});
test('a queued kit root is cancellable before its first durable record', async t => {
  const f = await protocolFixture(t);
  Object.assign(f.model.parent, { status: 'queued', display_title: `Codex request queued-fixture / request-${'e'.repeat(64)}` });
  f.model.artifacts.delete(40);
  const cancelled = await cancelTaskRuns({ github: f.github, context: { ...f.context, actor: 'Z-M-Huang' }, core: f.core, taskId,
    env: { ...f.env, TRIGGERING_ACTOR: 'Z-M-Huang' } });
  assert.deepEqual(cancelled, [13]);
});
test('a pre-registration stop also fences later deadline transport until explicit activation', async t => {
  const f = await protocolFixture(t), stop = { ...f.model.parent, id: 12, display_title: `Codex stop fixture-request / ${'e'.repeat(32)}` };
  f.model.children.push(stop);
  await assert.rejects(requireActive(f.api, repo, taskId, '13', 'fixture-request'), { reason: 'task_stopped' });
  const io = async (id, kind) => ({ artifact: f.model.artifacts.get(id), value: kind === 'checkpoint' ? f.model.manifest : f.model.request });
  assert.equal((await continuationDecision({ api: f.api, io, repository: repo, parent: f.model.parent })).reason, 'task_stopped');
  await requireActive(f.api, repo, taskId, '200', 'fixture-request');
});

test('qualification overrides require the actual trusted registry artifact and exact recorded settings', async t => {
  const f = await protocolFixture(t), content = await readFile(join(root, 'remote-codex.yml'), 'utf8');
  const task = { task_id: 'qual-fixture-fresh', labels: ['ubuntu-latest'], scenario: 'fresh' };
  const registry = { repository: repo, run_id: '170', source_sha: sourceSha, author: 'Fixture Author', email: 'fixture@example.invalid', tasks: [task] };
  f.model.runs.set(170, { ...f.model.parent, id: 170, path: '.github/workflows/runner-acceptance.yml' });
  f.addArtifact(180, 'linux-qualification-170-registry', await zipEntries(f, 'qualification-registry', [{ name: 'record.json', text: json(registry) }]), 170);
  const plan = 'Execute the supplied qualification scenario.';
  const request = { request_id: task.task_id, source_repository: repo, source_sha: sourceSha, plan, plan_sha256: hash(plan), qualification_artifact_id: 180,
    project_config: { revision: sourceSha, content, sha256: hash(content) }, runner: task.labels, budget_minutes: 5, max_continuations: 3, auto_continue: false,
    git_author_name: registry.author, git_author_email: registry.email, user_agents_url: null, user_agents_sha256: null,
    skills: [] };
  const context = { ...f.context, actor: 'Z-M-Huang', eventName: 'workflow_dispatch' };
  const env = { ...f.env, GITHUB_RUN_ID: '200', GITHUB_JOB: 'qualification', TRIGGERING_ACTOR: 'Z-M-Huang', TASK_REQUEST: registered(request) };
  assert.equal((await prepareTaskRequest({ github: f.github, context, core: f.core, env })).task_id, '200');
  await assert.rejects(prepareTaskRequest({ github: f.github, context, core: f.core,
    env: { ...env, GITHUB_JOB: 'altered-qualification', TASK_REQUEST: registered({ ...request, runner: ['self-hosted', 'Linux'] }) } }), /qualification_settings_mismatch/);
  await assert.rejects(prepareTaskRequest({ github: f.github, context, core: f.core,
    env: { ...env, GITHUB_JOB: 'injected-skill', TASK_REQUEST: registered({ ...request, skills: [{ repository: repo, revision: sourceSha, names: ['injected'] }] }) } }), /qualification_settings_mismatch/);
  f.model.runs.get(170).path = '.github/workflows/unrelated.yml';
  await assert.rejects(prepareTaskRequest({ github: f.github, context, core: f.core,
    env: { ...env, GITHUB_JOB: 'untrusted-qualification' } }), /untrusted_parent_run/);
});

test('a single consumer caller handles continuation claims and native child preparation without copied helpers', async t => {
  const f = await protocolFixture(t);
  f.model.sources.set('.github/workflows/runner-task.yml', Buffer.from((await readFile(join(root, 'skills/remote-codex/assets/runner-task.yml'), 'utf8')).replace('/remote-codex.yml@v1', `/remote-codex.yml@${sourceSha}`)));
  f.model.controller.path = '.github/workflows/runner-task.yml';
  assert.equal((await runController({ github: f.github, context: f.context, core: f.core, env: f.env })).eligible, true);
  const prepared = await runController({ github: f.github, context: f.context, core: f.core, env: { ...f.env, CONTINUATION_MODE: 'prepare' } });
  f.addArtifact(43, prepared.claim_name, await zipEntries(f, 'single-workflow-claim', [{ name: 'record.json', text: await readFile(prepared.claim_path, 'utf8') }]), 99);
  const result = await runController({ github: f.github, context: f.context, core: f.core,
    env: { ...f.env, CONTINUATION_MODE: 'dispatch', CLAIM_ARTIFACT_ID: '43', NEW_CLAIM: 'true' } });
  assert.equal(f.model.dispatches.length, 1);
  const child = await prepareTaskRequest({ github: f.github, context: { ...f.context, eventName: 'workflow_dispatch' }, core: f.core,
    env: { ...f.env, GITHUB_RUN_ID: String(result.child_run_id), GITHUB_JOB: 'consumer-child', TASK_REQUEST: json(f.model.dispatches[0]) } });
  assert.equal(JSON.parse(child.execution).root_run_id, taskId); assert.equal(child.resume_artifact_id, 41);
  assert.ok(f.records.some(record => record.event === 'continuation.dispatch' && record.outcome === 'registered'));
});

test('reusable authorization and preparation preserve an older frozen provider revision and reject unrelated history', async t => {
  const f = await protocolFixture(t), provider = 'markhuangai/agent-remote-dev-codex', currentSha = 'b'.repeat(40);
  f.model.manifest.execution.source_repository = provider;
  f.model.payloads.set(41, await replaceManifest(f, 'provider-resume', f.model.payloads.get(41), f.model.manifest));
  f.model.artifacts.get(41).size_in_bytes = f.model.payloads.get(41).length;
  f.model.payloads.set(40, await zipEntries(f, 'provider-root-record', [{ name: 'record.json', text: json(f.model.request) }]));
  f.model.artifacts.get(40).size_in_bytes = f.model.payloads.get(40).length;
  f.model.sources.set('.github/workflows/runner-task.yml', Buffer.from((await readFile(join(root, 'skills/remote-codex/assets/runner-task.yml'), 'utf8')).replace('/remote-codex.yml@v1', `/remote-codex.yml@${currentSha}`)));
  const request = { task_id: taskId, source_repository: provider, source_sha: sourceSha, resume_artifact_id: 41, activation_key: 'a'.repeat(32) };
  const event = join(f.temporary, 'provider-event.json'); await writeFile(event, json({ inputs: { request: registered(request) } }));
  let history = 'ahead';
  const api = (path, options) => path === `/repos/${provider}/commits/${currentSha}` ? { sha: currentSha } :
    path === `/repos/${provider}/compare/${sourceSha}...${currentSha}` ? { status: history } : f.api(path, options);
  const env = { ...f.env, GITHUB_RUN_ID: '200', GITHUB_ACTOR: 'Z-M-Huang', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_EVENT_PATH: event,
    GITHUB_JOB: 'consumer-resume', TRIGGERING_ACTOR: 'Z-M-Huang', TASK_REQUEST: registered(request), PROVIDER_REPOSITORY: provider, PROVIDER_SHA: currentSha };
  for (const mode of ['authorize', 'prepare', 'task']) {
    const result = await workflowCommand(mode, { api, env, sink: f.core });
    assert.equal(result.source_sha, sourceSha); assert.equal(JSON.parse(result.execution).source_sha, sourceSha);
    assert.equal(result.resume_artifact_id, 41);
  }
  for (history of ['behind', 'diverged']) await assert.rejects(workflowCommand('task', { api, sink: f.core,
    env: { ...env, GITHUB_JOB: `rejected-${history}` } }), { reason: 'provider_resume_revision_unverified' });
});

test('controller claims reconcile an ambiguous dispatch and cannot blindly issue it twice', async t => {
  const f = await protocolFixture(t);
  const resolve = await runController({ github: f.github, context: f.context, core: f.core, env: f.env });
  assert.equal(resolve.eligible, true);
  const prepared = await runController({ github: f.github, context: f.context, core: f.core, env: { ...f.env, CONTINUATION_MODE: 'prepare' } });
  const claim = JSON.parse(await readFile(prepared.claim_path, 'utf8'));
  f.addArtifact(43, prepared.claim_name, await zipEntries(f, 'claim', [{ name: 'record.json', text: json(claim) }]), 99);
  f.model.registration = 'ambiguous';
  const env = { ...f.env, CONTINUATION_MODE: 'dispatch', NEW_CLAIM: 'true', CLAIM_ARTIFACT_ID: '43' };
  const first = await runController({ github: f.github, context: f.context, core: f.core, env });
  assert.ok(first.child_run_id); assert.equal(f.model.dispatches.length, 1);
  const second = await runController({ github: f.github, context: f.context, core: f.core, env: { ...env, GITHUB_RUN_ATTEMPT: '2', NEW_CLAIM: 'false' } });
  assert.equal(second.child_run_id, first.child_run_id); assert.equal(f.model.dispatches.length, 1);
  const childEnv = { ...f.env, GITHUB_RUN_ID: String(first.child_run_id), GITHUB_JOB: 'child', TASK_REQUEST: json(f.model.dispatches[0]), TRIGGERING_ACTOR: 'github-actions[bot]' };
  const child = await prepareTaskRequest({ github: f.github, context: { ...f.context, eventName: 'workflow_dispatch' }, core: f.core, env: childEnv });
  assert.equal(JSON.parse(child.execution).continuation_count, 1); assert.equal(JSON.parse(child.execution).source_sha, sourceSha);
  assert.deepEqual(JSON.parse(child.skills), []);
});

test('a claimed but unregistered dispatch blocks after five minutes without another POST', async t => {
  const f = await protocolFixture(t), prepared = await runController({ github: f.github, context: f.context, core: f.core, env: { ...f.env, CONTINUATION_MODE: 'prepare' } });
  const claim = JSON.parse(await readFile(prepared.claim_path, 'utf8'));
  f.addArtifact(43, prepared.claim_name, await zipEntries(f, 'unregistered-claim', [{ name: 'record.json', text: json(claim) }]), 99);
  let now = 0;
  await assert.rejects(runController({ github: f.github, context: f.context, core: f.core, env: { ...f.env, CONTINUATION_MODE: 'dispatch', CLAIM_ARTIFACT_ID: '43', NEW_CLAIM: 'false' },
    now: () => now, sleep: async ms => { now += ms; } }), /claimed_dispatch_unreconciled/);
  assert.equal(now, 300000); assert.equal(f.model.dispatches.length, 0);
});

for (const revocation of ['allowlist', 'permission', 'triggering_permission', 'attempt']) test(`automatic continuation rejects current activation ${revocation} changes`, async t => {
  const f = await protocolFixture(t);
  const prepared = await runController({ github: f.github, context: f.context, core: f.core, env: { ...f.env, CONTINUATION_MODE: 'prepare' } });
  const claim = JSON.parse(await readFile(prepared.claim_path, 'utf8'));
  f.addArtifact(43, prepared.claim_name, await zipEntries(f, `revoked-${revocation}`, [{ name: 'record.json', text: json(claim) }]), 99);
  if (revocation === 'allowlist') f.model.sources.set('remote-codex.yml', Buffer.from('allowed-actors: [New-Operator]\nskills: []\n'));
  if (revocation === 'permission') f.model.permission = 'read';
  if (revocation === 'triggering_permission') {
    f.model.parent.triggering_actor = { login: 'New-Operator' };
    f.model.sources.set('remote-codex.yml', Buffer.from('allowed-actors: [Z-M-Huang, New-Operator]\nskills: []\n'));
    f.model.permissions = { 'New-Operator': 'read' };
  }
  if (revocation === 'attempt') f.model.parent.run_attempt = 2;
  const reason = revocation === 'allowlist' ? 'untrusted_task_actor' : revocation === 'attempt' ? 'parent_run_active_or_rerun' : 'operator_write_permission_required';
  await assert.rejects(runController({ github: f.github, context: f.context, core: f.core,
    env: { ...f.env, CONTINUATION_MODE: 'dispatch', CLAIM_ARTIFACT_ID: '43', NEW_CLAIM: 'true' } }), new RegExp(reason));
  assert.equal(f.model.dispatches.length, 0);
  assert.ok(f.records.some(record => record.level === 'ERROR' && record.reason === reason));
});

test('a queued automatic child rechecks revoked authority before execution', async t => {
  const f = await protocolFixture(t), prepared = await runController({ github: f.github, context: f.context, core: f.core, env: { ...f.env, CONTINUATION_MODE: 'prepare' } });
  f.addArtifact(43, prepared.claim_name, await zipEntries(f, 'queued-claim', [{ name: 'record.json', text: await readFile(prepared.claim_path, 'utf8') }]), 99);
  const child = await runController({ github: f.github, context: f.context, core: f.core, env: { ...f.env, CONTINUATION_MODE: 'dispatch', CLAIM_ARTIFACT_ID: '43', NEW_CLAIM: 'true' } });
  f.model.permission = 'read';
  await assert.rejects(prepareTaskRequest({ github: f.github, context: { ...f.context, eventName: 'workflow_dispatch' }, core: f.core,
    env: { ...f.env, GITHUB_RUN_ID: String(child.child_run_id), GITHUB_JOB: 'revoked-child', TASK_REQUEST: json(f.model.dispatches[0]) } }), /operator_write_permission_required/);
  assert.ok(f.records.some(record => record.event === 'submission.resolve' && record.activation_run_id === '13' && record.activation_run_attempt === '1' && record.reason === 'operator_write_permission_required'));
});

test('authority revoked during registration reconciliation is checked again immediately before POST', async t => {
  const f = await protocolFixture(t), prepared = await runController({ github: f.github, context: f.context, core: f.core, env: { ...f.env, CONTINUATION_MODE: 'prepare' } });
  f.addArtifact(43, prepared.claim_name, await zipEntries(f, 'late-revocation-claim', [{ name: 'record.json', text: await readFile(prepared.claim_path, 'utf8') }]), 99);
  const github = { request: async (route, options) => {
    const response = await f.github.request(route, options);
    if (route.includes('/actions/workflows/runner-task.yml/runs?')) f.model.permission = 'read';
    return response;
  } };
  await assert.rejects(runController({ github, context: f.context, core: f.core,
    env: { ...f.env, CONTINUATION_MODE: 'dispatch', CLAIM_ARTIFACT_ID: '43', NEW_CLAIM: 'true' } }), /operator_write_permission_required/);
  assert.equal(f.model.dispatches.length, 0);
  assert.ok(f.records.some(record => record.level === 'ERROR' && record.activation_run_id === '13' && record.activation_run_attempt === '1'));
});

test('a stop during child reconciliation fences a prepared continuation claim before dispatch', async t => {
  const f = await protocolFixture(t), prepared = await runController({ github: f.github, context: f.context, core: f.core,
    env: { ...f.env, CONTINUATION_MODE: 'prepare' } });
  assert.equal(prepared.eligible, true); assert.equal(prepared.upload, true);
  f.addArtifact(43, prepared.claim_name, await zipEntries(f, 'stop-race-claim', [{ name: 'record.json', text: await readFile(prepared.claim_path, 'utf8') }]), 99);
  let stopped = false;
  const github = { request: async (route, options) => {
    const response = await f.github.request(route, options);
    if (!stopped && route.includes('/actions/workflows/runner-task.yml/runs?')) {
      const stop = { ...f.model.parent, id: 150, display_title: `Codex stop ${taskId} / ${'e'.repeat(32)}` };
      f.model.children.push(stop); f.model.runs.set(stop.id, stop); stopped = true;
    }
    return response;
  } };
  await assert.rejects(runController({ github, context: f.context, core: f.core,
    env: { ...f.env, CONTINUATION_MODE: 'dispatch', CLAIM_ARTIFACT_ID: '43', NEW_CLAIM: 'true' } }), /task_stopped/);
  assert.equal(stopped, true); assert.equal(f.model.dispatches.length, 0);
  const failure = f.records.find(record => record.event === 'continuation.dispatch' && record.reason === 'task_stopped');
  assert.equal(failure.level, 'ERROR'); assert.equal(failure.outcome, 'blocked');
  assert.equal(failure.task_id, taskId); assert.equal(failure.parent_run_id, 13); assert.equal(failure.activation_run_id, '13');
  assert.equal(failure.expected, 13); assert.equal(failure.observed, 150); process.stdout.write(json(failure) + '\n');
});

test('authorized manual takeover replaces revoked original authority and binds its exact attempt', async t => {
  const f = await protocolFixture(t);
  f.model.sources.set('remote-codex.yml', Buffer.from('allowed-actors: [New-Operator]\nskills: []\n'));
  f.model.permissions = { 'Z-M-Huang': 'read', 'New-Operator': 'write' };
  const request = { task_id: taskId, source_repository: 'action/source', source_sha: sourceSha, resume_artifact_id: 41, activation_key: 'a'.repeat(32) };
  const resumed = await prepareTaskRequest({ github: f.github, context: { ...f.context, actor: 'New-Operator', eventName: 'workflow_dispatch' }, core: f.core,
    env: { ...f.env, GITHUB_RUN_ID: '200', GITHUB_RUN_ATTEMPT: '2', GITHUB_JOB: 'takeover', TRIGGERING_ACTOR: 'New-Operator', TASK_REQUEST: registered(request) } });
  const settings = JSON.parse(resumed.execution);
  assert.equal(settings.activation_run_id, '200'); assert.equal(settings.activation_run_attempt, '2');
  f.model.runs.set(200, { ...f.model.parent, id: 200, run_attempt: 2, actor: { login: 'New-Operator' }, triggering_actor: { login: 'New-Operator' } });
  assert.equal(await authorizeActivation(f.api, repo, settings), sourceSha);
  f.model.runs.get(200).run_attempt = 3;
  await assert.rejects(authorizeActivation(f.api, repo, settings), { reason: 'activation_attempt_changed' });
});

test('native failures, cancellation, drift and exhausted limits veto automatic continuation', async t => {
  const f = await protocolFixture(t), io = async (id, kind) => ({ artifact: f.model.artifacts.get(id), value: kind === 'checkpoint' ? f.model.manifest : f.model.request });
  for (const conclusion of ['cancelled', 'failure', 'action_required']) assert.equal((await continuationDecision({ api: f.api, io, repository: repo, parent: { ...f.model.parent, conclusion } })).eligible, false);
  f.model.observedHead = 'c'.repeat(40);
  await assert.rejects(continuationDecision({ api: f.api, io, repository: repo, parent: f.model.parent }), { reason: 'resume_branch_drift' });
  f.model.observedHead = f.model.manifest.checkpoint_sha;
  const before = f.model.request.execution;
  f.model.request.execution = { ...before, continuation_count: 3, parent_run_id: '11', parent_run_attempt: '1' };
  assert.equal((await continuationDecision({ api: f.api, io, repository: repo, parent: f.model.parent })).reason, 'continuation_limit');
});
test('a native stop request fences existing claims and later queued execution; explicit resume reactivates', async t => {
  const f = await protocolFixture(t);
  const stop = { ...f.model.parent, id: 150, display_title: `Codex stop ${taskId} / ${'e'.repeat(32)}` };
  f.model.children.push(stop); f.model.runs.set(stop.id, stop);
  await assert.rejects(requireActive(f.api, repo, taskId, '13'), { reason: 'task_stopped' });
  const io = async (id, kind) => ({ artifact: f.model.artifacts.get(id), value: kind === 'checkpoint' ? f.model.manifest : f.model.request });
  assert.equal((await continuationDecision({ api: f.api, io, repository: repo, parent: f.model.parent })).reason, 'task_stopped');
  const request = { task_id: taskId, source_repository: 'action/source', source_sha: sourceSha, resume_artifact_id: 41, activation_key: 'a'.repeat(32) };
  const env = { ...f.env, GITHUB_RUN_ID: '200', GITHUB_JOB: 'manual', TRIGGERING_ACTOR: 'Z-M-Huang', TASK_REQUEST: registered(request) };
  const context = { ...f.context, actor: 'Z-M-Huang', eventName: 'workflow_dispatch' };
  const resumed = await prepareTaskRequest({ github: f.github, context, core: f.core, env });
  assert.equal(JSON.parse(resumed.execution).activation_run_id, '200'); assert.equal(JSON.parse(resumed.execution).continuation_count, 1);
  assert.deepEqual(JSON.parse(resumed.execution).project_config, f.model.manifest.execution.project_config);
  const resolved = await resolveTaskRequest({ github: f.github, context, core: f.core, env: { ...env, GITHUB_JOB: 'structured-resume' } });
  assert.deepEqual(resolved.execution, JSON.parse(resumed.execution));
  assert.deepEqual(resolved.skills, f.model.manifest.skills);
  assert.deepEqual(resolved.authorization, f.model.manifest.authorization);
  const native = await prepareInvocation({ api: f.api, source: { repository: 'action/source', sha: sourceSha }, plan: '', core: f.core,
    env: { ...env, GITHUB_ACTOR: 'Z-M-Huang', GITHUB_EVENT_NAME: 'workflow_dispatch', CODEX_TASK_REQUEST: registered(request), GITHUB_JOB: 'native-resume' } });
  assert.equal(native.taskId, taskId); assert.equal(native.resumeArtifactId, 41); assert.equal(native.plan, '');
  assert.deepEqual(native.execution, resolved.execution); assert.deepEqual(native.skills, resolved.skills);
  assert.deepEqual(native.authorization, resolved.authorization);
  await assert.rejects(prepareTaskRequest({ github: f.github, context, core: f.core, env: { ...env, TASK_REQUEST: registered({ ...request, runner: ['ubuntu-latest'] }) } }), /resume_settings_changed/);
});

test('resume setting comparison freezes runner, instruction and source identities', () => {
  const recorded = execution(), resumed = { ...recorded, parent_run_id: '13', parent_run_attempt: '1', continuation_count: 1, activation_run_id: '15' };
  verifyResumeSettings(recorded, resumed);
  for (const change of [{ runner: ['self-hosted', 'Linux'] }, { source_sha: 'f'.repeat(40) }, { project_config: { ...recorded.project_config, content: 'changed', sha256: hash('changed') } },
    { user_agents_sha256: 'b'.repeat(64), user_agents_url: 'https://example.invalid/AGENTS.md' }]) assert.throws(() => verifyResumeSettings(recorded, { ...resumed, ...change }), { reason: 'resume_settings_changed' });
});

for (const variant of ['traversal', 'absolute', 'drive', 'symlink', 'duplicate', 'unexpected', 'hash', 'schema', 'encrypted', 'oversized', 'malformed']) test(`actual ZIP restoration rejects ${variant} before creating its destination`, async t => {
  const f = await protocolFixture(t), m = structuredClone(f.model.manifest);
  const sessionFile = m.files.find(file => file.path.endsWith('.jsonl'));
  const contents = json({ type: 'session_meta', payload: { id: m.sessions[0] } }) + '\n';
  let entries = [{ name: 'manifest.json', text: json(m) }, { name: sessionFile.path, text: contents }];
  if (variant === 'traversal') entries.push({ name: '../escaped', text: 'unsafe' });
  if (variant === 'absolute') entries.push({ name: '/tmp/escaped', text: 'unsafe' });
  if (variant === 'drive') entries.push({ name: 'C:\\escaped', text: 'unsafe' });
  if (variant === 'symlink') entries.push({ name: 'codex/sessions/link.jsonl', mode: 0o120777, text: '/tmp/escaped' });
  if (variant === 'duplicate') entries.push(entries[1]);
  if (variant === 'unexpected') entries.push({ name: 'codex/config.toml', text: 'untrusted configuration' });
  if (variant === 'hash') entries[1].text = 'corrupt';
  if (variant === 'schema') entries[0].text = json({ ...m, schema_version: 1 });
  const bytes = await zipEntries(f, `bad-${variant}`, entries), archive = join(f.temporary, `input-${variant}.zip`), destination = join(f.temporary, 'restored');
  const header = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  if (variant === 'encrypted') bytes.writeUInt16LE(1, header + 8);
  if (variant === 'oversized') bytes.writeUInt32LE(256 * 1024 * 1024 + 1, header + 24);
  if (variant === 'malformed') bytes.fill(0);
  await writeFile(archive, bytes);
  const reasons = { traversal: 'unsafe_archive_path', absolute: 'unsafe_archive_path', drive: 'unsafe_archive_path', symlink: 'linked_archive_entry',
    duplicate: 'duplicate_archive_entry', unexpected: 'archive_inventory_mismatch', hash: 'checkpoint_file_hash_mismatch', schema: 'unsupported_checkpoint_schema',
    encrypted: 'encrypted_archive', oversized: 'archive_expansion_limit', malformed: 'archive_read_failed' };
  await assert.rejects(unpackArchive(f.job, archive, destination, 'checkpoint', f.log), error => {
    assert.equal(error.reason, reasons[variant]);
    if (variant === 'schema') { assert.equal(error.details.expected, 3); assert.equal(error.details.observed, 1); }
    return true;
  });
  await assert.rejects(readFile(join(destination, 'manifest.json')), { code: 'ENOENT' });
});
