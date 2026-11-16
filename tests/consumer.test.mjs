import assert from 'node:assert/strict';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { parse, stringify } from 'yaml';
import { workflowCommand } from '../.github/remote-codex/control.mjs';
import { registrationKey } from '../.github/remote-codex/checkpoint-policy.mjs';
import { prepareQueue, queuePrepared } from '../.github/remote-codex/submission.mjs';
import { verifyProtocol } from '../.github/remote-codex/protocol-policy.mjs';
import { prepareInvocation } from '../.build/invocation.js';
import { exec, fixture, root } from './helpers.mjs';

const provider = 'markhuangai/agent-remote-dev-codex', sourceSha = 'b'.repeat(40), revision = 'a'.repeat(40);
const template = await readFile(join(root, 'skills/remote-codex/assets/runner-task.yml'), 'utf8');
const caller = template.replace('/remote-codex.yml@v1', `/remote-codex.yml@${sourceSha}`);
function transport() {
  const state = { config: 'allowed-actors: [Z-M-Huang]\nskills: []\n', caller, permission: 'write', calls: [] };
  const api = async (path, options = {}) => {
    state.calls.push(path); assert.equal(options.method ?? 'GET', 'GET');
    if (path === '/user') return { login: 'Z-M-Huang' };
    if (path.includes('/git/ref/heads/main')) return { object: { sha: revision } };
    if (path.includes('/collaborators/')) return { permission: state.permission };
    if (path.includes('/commits/')) return { sha: path.split('/').at(-1) };
    if (path.includes('/actions/runs?')) return { workflow_runs: [] };
    if (path.endsWith('/actions/workflows/runner-task.yml')) return { path: '.github/workflows/runner-task.yml', state: 'active' };
    if (path.includes('/contents/')) {
      const name = path.split('/contents/')[1].split('?')[0];
      assert.ok(['remote-codex.yml', '.github/workflows/runner-task.yml', 'skills/remote-codex/assets/runner-task.yml'].includes(name), `Consumer must not supply ${name}`);
      const bytes = Buffer.from(name === 'remote-codex.yml' ? state.config : name.startsWith('skills/') ? template : state.caller);
      return { type: 'file', encoding: 'base64', size: bytes.length, content: bytes.toString('base64') };
    }
    throw new Error(`Unexpected transport ${path}`);
  };
  return { state, api };
}
test('consumer workflow verification needs only the caller file and the provider template', async () => {
  const { state, api } = transport(), verified = await verifyProtocol(api, 'fixture/repo');
  assert.equal(verified.protocol_version, 3); assert.equal(verified.provider.sha, sourceSha);
  assert.ok(!state.calls.some(path => /contents\/\.github\/remote-codex/.test(path)));
  const reordered = parse(caller); reordered.name = 'Project Codex'; reordered.on.workflow_run.workflows = [reordered.name];
  reordered.on = Object.fromEntries(Object.entries(reordered.on).reverse());
  reordered.jobs.remote.with = Object.fromEntries(Object.entries(reordered.jobs.remote.with).reverse());
  state.caller = stringify(reordered); assert.equal((await verifyProtocol(api, 'fixture/repo')).provider.sha, sourceSha);
  for (const change of [value => { delete value.on.workflow_run; }, value => { value['run-name'] = 'Unreconcilable'; },
    value => { value.jobs.remote.with.request = '${{ inputs.plan }}'; }, value => { value.permissions.actions = 'read'; },
    value => { value.name = 'Unsubscribed workflow'; }]) {
    const value = parse(caller); change(value); state.caller = stringify(value);
    await assert.rejects(verifyProtocol(api, 'fixture/repo'), { reason: 'incompatible_consumer_workflow' });
  }
});
test('reusable preparation freezes a verbatim plan and passes its request to native execution without consumer helpers', async t => {
  const f = await fixture(t), { state, api } = transport(), records = [];
  const sink = Object.fromEntries(['info', 'warning', 'error', 'debug'].map(level => [level, line => records.push(JSON.parse(line))]));
  const event = join(f.temporary, 'event.json'); await writeFile(event, JSON.stringify({ inputs: {} }));
  const plan = 'Implement https://github.com/fixture/repo/issues/4 using $chosen-skill.\n';
  const env = { GITHUB_REPOSITORY: 'fixture/repo', GITHUB_ACTOR: 'Z-M-Huang', TRIGGERING_ACTOR: 'Z-M-Huang', GITHUB_REF: 'refs/heads/main',
    GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_EVENT_PATH: event, GITHUB_WORKFLOW_SHA: revision, GITHUB_RUN_ID: '200', GITHUB_RUN_ATTEMPT: '1',
    GITHUB_WORKFLOW_REF: 'fixture/repo/.github/workflows/codex.yml@refs/heads/main', GITHUB_JOB: 'resolve', CODEX_RUNNER_PROTOCOL: '3', RUNNER_TEMP: f.temporary,
    PROVIDER_REPOSITORY: provider, PROVIDER_SHA: sourceSha, TASK_PLAN: plan, TASK_REQUEST: '' };
  assert.deepEqual(await workflowCommand('authorize', { api, env, sink }), { operation: 'execute' });
  assert.ok(!state.calls.some(path => path.includes('/commits/')));
  const frozen = await workflowCommand('prepare', { api, env, sink });
  assert.equal(frozen.plan, plan); assert.equal(frozen.task_id, '200'); assert.equal(frozen.source_sha, sourceSha);
  const prepared = JSON.parse(frozen.request); assert.equal(prepared.project_config.content, state.config);
  for (const [change, reason] of [[{ source_repository: 'fixture/repo' }, 'provider_runtime_repository_mismatch'],
    [{ source_repository: 'other/action' }, 'provider_runtime_repository_mismatch'], [{ source_sha: 'c'.repeat(40) }, 'provider_runtime_revision_mismatch']]) {
    const changed = { ...prepared, ...change }; changed.registration_key = registrationKey(changed);
    for (const mode of ['authorize', 'prepare', 'task']) await assert.rejects(workflowCommand(mode, { api, sink,
      env: { ...env, TASK_REQUEST: JSON.stringify(changed) } }), new RegExp(reason));
  }
  const queued = await prepareQueue(api, { repo: 'fixture/repo', plan });
  assert.equal(queued.request.source_repository, provider); assert.equal(queued.request.source_sha, sourceSha);
  await assert.rejects(prepareQueue(api, { repo: 'fixture/repo', plan, source_repository: 'fixture/repo', source_ref: sourceSha }), { reason: 'provider_runtime_source_changed' });
  env.CODEX_TASK_REQUEST = frozen.request;
  const invoke = supplied => prepareInvocation({ api, plan: supplied, source: { repository: provider, sha: sourceSha }, core: sink, env });
  assert.equal((await invoke(plan)).plan, plan);
  await assert.rejects(invoke('Changed prompt'), { reason: 'plan_hash_mismatch' });
  state.config += 'budget-minutes: 5\n';
  await assert.rejects(invoke(plan), /project_config_hash_mismatch/);
  assert.ok(records.some(record => record.event === 'submission.resolve' && record.outcome === 'verified'));
  assert.ok(!JSON.stringify(records).includes(plan.trim()));
  state.permission = 'read'; await assert.rejects(workflowCommand('authorize', { api, env, sink }), /operator_write_permission_required/);
});
test('a changed caller provider revision rejects a prepared client request before dispatch', async () => {
  const { state, api } = transport(), prepared = await prepareQueue(api, { repo: 'fixture/repo', plan: 'Implement the authorized task.' });
  state.caller = caller.replace(sourceSha, 'c'.repeat(40));
  await assert.rejects(queuePrepared(api, prepared), error => {
    assert.equal(error.reason, 'provider_runtime_source_changed'); assert.equal(error.details.expected, sourceSha); assert.equal(error.details.observed, 'c'.repeat(40)); return true;
  });
});
for (const variant of ['valid', 'missing', 'duplicate', 'sha', 'head', 'repository', 'attempt', 'event'])
  test(`actual reusable workflow bootstrap ${variant} publishes only a verified provider revision`, async () => {
    const workflow = parse(await readFile(join(root, '.github/workflows/remote-codex.yml'), 'utf8'));
    const bootstrap = workflow.jobs.resolve.steps.find(step => step.id === 'source');
    const run = { id: 200, run_attempt: 1, head_sha: revision, repository: { full_name: 'fixture/repo' }, event: 'workflow_dispatch', head_branch: 'main',
      referenced_workflows: [{ path: `${provider}/.github/workflows/remote-codex.yml@refs/tags/v1`, sha: sourceSha }] };
    if (variant === 'missing') run.referenced_workflows = [];
    if (variant === 'duplicate') run.referenced_workflows.push({ ...run.referenced_workflows[0] });
    if (variant === 'sha') run.referenced_workflows[0].sha = 'private-invalid-source-body';
    if (variant === 'head') run.head_sha = sourceSha;
    if (variant === 'repository') run.repository.full_name = 'other/repo';
    if (variant === 'attempt') run.run_attempt = 2;
    if (variant === 'event') run.event = 'pull_request';
    const outputs = new Map(), records = [], core = { setOutput: (key, value) => outputs.set(key, value), info: line => records.push(JSON.parse(line)), error: line => records.push(JSON.parse(line)) };
    const github = { rest: { actions: { getWorkflowRun: async input => { assert.deepEqual(input, { owner: 'fixture', repo: 'repo', run_id: 200 }); return { data: run }; } } } };
    const context = { repo: { owner: 'fixture', repo: 'repo' }, runId: 200, eventName: 'workflow_dispatch' };
    const previous = { GITHUB_RUN_ATTEMPT: process.env.GITHUB_RUN_ATTEMPT, GITHUB_WORKFLOW_SHA: process.env.GITHUB_WORKFLOW_SHA };
    Object.assign(process.env, { GITHUB_RUN_ATTEMPT: '1', GITHUB_WORKFLOW_SHA: revision });
    try {
      const invoke = () => new (Object.getPrototypeOf(async function () {}).constructor)('github', 'context', 'core', bootstrap.with.script)(github, context, core);
      if (variant === 'valid') { await invoke(); assert.deepEqual([...outputs], [['repository', provider], ['sha', sourceSha]]); }
      else { await assert.rejects(invoke(), /provider_workflow_identity_unavailable/); assert.equal(outputs.size, 0); }
      assert.equal(records[0].event, 'submission.provider'); assert.equal(records[0].outcome, variant === 'valid' ? 'verified' : 'blocked');
      assert.ok(!JSON.stringify(records).includes('private-invalid-source-body'));
    } finally {
      for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    }
  });

test('the built workflow helper executes outside the source checkout and reports a rejected operator safely', async t => {
  const f = await fixture(t), bundled = join(f.temporary, 'bundle'), bin = join(f.temporary, 'bin'), event = join(f.temporary, 'event.json'), outputs = join(f.temporary, 'outputs');
  await mkdir(bundled); await mkdir(bin); await writeFile(event, '{}'); await writeFile(outputs, '');
  for (const name of ['control.mjs', 'yaml.cjs', 'archive.py']) await cp(join(root, 'dist', name), join(bundled, name));
  await writeFile(join(bin, 'gh'), `#!/usr/bin/env node
const path=process.argv[3];let data;
if(path.endsWith('/git/ref/heads/main'))data={object:{sha:'a'.repeat(40)}};
else if(path.includes('/contents/remote-codex.yml?')){const b=Buffer.from('allowed-actors: [Z-M-Huang]\\nskills: []\\n');data={type:'file',size:b.length,encoding:'base64',content:b.toString('base64')}}
else if(path.includes('/collaborators/'))data={permission:process.env.FIXTURE_PERMISSION};
else process.exit(2);
process.stdout.write(JSON.stringify(data));
`, { mode: 0o700 });
  const env = { ...f.job.env, PATH: `${bin}:${f.job.env.PATH}`, FIXTURE_PERMISSION: 'write', GITHUB_REPOSITORY: 'fixture/repo', GITHUB_ACTOR: 'Z-M-Huang',
    TRIGGERING_ACTOR: 'Z-M-Huang', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_PATH: event, GITHUB_OUTPUT: outputs,
    PROVIDER_REPOSITORY: provider, PROVIDER_SHA: sourceSha };
  await exec(process.execPath, [join(bundled, 'control.mjs'), 'authorize'], { cwd: f.temporary, env });
  assert.match(await readFile(outputs, 'utf8'), /execute/);
  await assert.rejects(exec(process.execPath, [join(bundled, 'control.mjs'), 'authorize'], { cwd: f.temporary, env: { ...env, FIXTURE_PERMISSION: 'read' } }), error => {
    assert.match(error.stdout, /submission.workflow/); assert.match(error.stdout, /operator_write_permission_required/);
    assert.doesNotMatch(error.stdout + error.stderr, /fixture-api-credential|fixture-github-credential/); process.stdout.write(error.stdout); return true;
  });
});
