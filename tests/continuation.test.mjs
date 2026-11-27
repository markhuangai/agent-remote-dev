import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import test from 'node:test';
import { exportCheckpoint } from '../.build/checkpoint.js';
import { unpackArchive, validateCheckpoint } from '../.build/resume.js';
import { checkpointName, validateManifest, validateProducer } from '../src/platform/checkpoint-policy.mjs';
import { loadRunCheckpoint, nativeTimedOut, prepareExecution, pruneSnapshots, recoverExecution, recoveryCooldownMs } from '../src/platform/continuation-policy.mjs';
import { workflowCommand } from '../src/platform/control.mjs';
import { actionsRecords, exec, checkpoint, fixture, root as projectRoot, sessionId } from './helpers.mjs';

const repository = 'fixture/repo';
async function archive(f, entries) {
  const path = join(f.temporary, `archive-${Math.random()}.zip`);
  await exec('python3', ['-c', `import json,stat,sys,zipfile
with zipfile.ZipFile(sys.argv[1], 'w', compression=zipfile.ZIP_DEFLATED) as z:
 for item in json.loads(sys.argv[2]):
  info=zipfile.ZipInfo(item['name']);info.external_attr=item.get('mode',stat.S_IFREG|0o600)<<16
  z.writestr(info,item.get('text',''))`, path, JSON.stringify(entries)]);
  return path;
}
async function transport(t, runner = 'codex', metadata = {}) {
  const f = await fixture(t, runner);
  if (runner === 'codex') {
    await mkdir(join(f.job.runnerHome, 'sessions'));
    await writeFile(join(f.job.runnerHome, 'sessions/rollout.jsonl'), JSON.stringify({ type: 'session_meta', payload: { id: sessionId } }) + '\n');
  } else {
    await mkdir(join(f.job.runnerHome, 'projects/remote-fixture'), { recursive: true });
    await writeFile(join(f.job.runnerHome, `projects/remote-fixture/${sessionId}.jsonl`), JSON.stringify({ sessionId, type: 'user' }) + '\n');
  }
  const exported = await exportCheckpoint(f.job, checkpoint(metadata), f.log);
  const zip = join(f.temporary, 'snapshot.zip');
  await exec('python3', ['-c', `import json,sys,zipfile
with zipfile.ZipFile(sys.argv[1],'w',compression=zipfile.ZIP_DEFLATED) as z:
 for name in json.loads(sys.argv[3]): z.write(name,name[len(sys.argv[2])+1:])`, zip, exported.root, JSON.stringify(exported.files)]);
  const bytes = await readFile(zip), info = { full_name: repository };
  const parent = { id: 13, run_attempt: 1, workflow_id: 7, path: '.github/workflows/custom.yml', head_sha: 'a'.repeat(40),
    repository: info, head_repository: info, head_branch: 'main', event: 'workflow_dispatch', status: 'completed', conclusion: 'failure' };
  const current = { ...parent, id: 20, status: 'in_progress' };
  const job = { id: 70, status: 'completed', conclusion: 'timed_out', steps: [
    { number: 1, name: 'Install and compile locked provider source', status: 'completed', conclusion: 'success', started_at: '2026-11-17T00:00:00Z' },
    { number: 2, name: 'Execute agent', status: 'completed', conclusion: 'timed_out', started_at: '2026-11-17T00:01:00Z' },
    { number: 3, name: 'Save final session', status: 'skipped', conclusion: 'skipped', started_at: null },
  ] };
  const artifact = { id: 55, name: checkpointName(exported.manifest), workflow_run: { id: 13 }, size_in_bytes: bytes.length, expired: false, expires_at: '2099-01-01T00:00:00Z' };
  const state = { config: 'allowed-actors: [Z-M-Huang]\nskills: []\nauto-continue: true\n', permission: 'write', job, parent, current, artifact, artifacts: [artifact], calls: [] };
  const api = async (path, options) => {
    state.calls.push({ path, options });
    if (path === `/repos/${repository}`) return { default_branch: 'main' };
    if (path.includes('/commits/main')) return { sha: 'a'.repeat(40) };
    if (path.includes('/collaborators/')) return { permission: state.permission };
    if (path.includes('/contents/.remote-dev.yml?')) { const bytes = Buffer.from(state.config); return { type: 'file', encoding: 'base64', size: bytes.length, content: bytes.toString('base64') }; }
    if (path.includes('/attempts/1/jobs?')) return { jobs: [state.job] };
    if (path.includes('/actions/runs/13/artifacts?')) return { artifacts: state.artifacts };
    if (path.endsWith('/actions/runs/13')) return state.parent;
    if (path.endsWith('/actions/runs/20')) return state.current;
    if (path.endsWith('/actions/artifacts/55/zip')) return bytes;
    if (path.endsWith('/actions/artifacts/55')) return state.artifact;
    if (options?.method === 'POST' && path.endsWith('/dispatches')) return null;
    if (options?.method === 'DELETE') return null;
    throw new Error(`Unexpected transport: ${path}`);
  };
  const root = () => mkdtemp(join(f.temporary, 'download-'));
  const records = [];
  const emit = line => records.push(JSON.parse(line));
  const core = { info: emit, warning: emit, error: emit };
  const recover = async () => recoverExecution({ api, repository, runId: '13', attempt: '1', root: await root(), core });
  const prepare = async (extra = {}) => prepareExecution({ api, repository, runId: '20', attempt: '1', actor: 'Z-M-Huang', triggeringActor: 'Z-M-Huang',
    ref: 'refs/heads/main', resumeRunId: '13', plan: 'New context', runner, root: await root(), ...extra });
  return { f, api, state, root, recover, prepare, exported, records, core };
}
test('run-ID resume loads the latest verified full native state from an arbitrary caller workflow', async t => {
  const x = await transport(t), loaded = await loadRunCheckpoint(x.api, repository, '13', await x.root());
  assert.equal(loaded.manifest.session_id, sessionId); assert.equal(loaded.manifest.lineage.workflow_path, '.github/workflows/custom.yml');
  assert.equal(loaded.artifact.id, 55);
  const prepared = await x.prepare();
  assert.equal(prepared.root_run_id, '13'); assert.equal(prepared.activation_run_id, '20'); assert.equal(prepared.auto_count, 0);
  x.state.config = 'allowed-actors: [Z-M-Huang]\nskills: []\nmax-continuations: 1\n';
  const current = await x.prepare(); assert.equal(current.settings.max_continuations, 1); assert.equal(current.settings.auto_continue, false);
});
for (const failure of ['expired', 'missing', 'unrelated', 'version', 'active', 'workflow', 'authorization']) test(`resume rejects ${failure} state without dispatch`, async t => {
  const x = await transport(t);
  let extra = {};
  if (failure === 'expired') x.state.artifact.expired = true;
  if (failure === 'missing') x.state.artifacts = [];
  if (failure === 'unrelated') x.state.parent.repository = { full_name: 'other/repo' };
  if (failure === 'version') extra.runnerVersion = 'incompatible';
  if (failure === 'active') x.state.parent.status = 'in_progress';
  if (failure === 'workflow') x.state.current.workflow_id = 8;
  if (failure === 'authorization') x.state.permission = 'read';
  await assert.rejects(x.prepare(extra));
  assert.ok(!x.state.calls.some(call => call.options?.method === 'POST'));
});
test('timeout recovery dispatches the actual consumer workflow with only plan/resume inputs', async t => {
  const x = await transport(t); assert.equal((await x.recover()).dispatched, true);
  const dispatch = x.state.calls.find(call => call.options?.method === 'POST');
  assert.equal(dispatch.path, '/repos/fixture/repo/actions/workflows/7/dispatches');
  assert.deepEqual(dispatch.options, { method: 'POST', ref: 'main', inputs: { runner: 'codex', 'resume-run-id': '13', plan: '' } });
  x.state.parent.status = 'in_progress';
  const child = await x.prepare({ actor: 'github-actions[bot]', triggeringActor: 'github-actions[bot]', plan: '' });
  assert.equal(child.auto_count, 1); assert.equal(child.activation_run_id, '13');
});
test('Claude timeout recovery keeps its runner and rejects a Codex resume', async t => {
  const x = await transport(t, 'claude');
  assert.equal((await x.recover()).dispatched, true);
  assert.equal(x.state.calls.find(call => call.options?.method === 'POST').options.inputs.runner, 'claude');
  assert.equal((await x.prepare()).restored.manifest.runner, 'claude');
  await assert.rejects(x.prepare({ runner: 'codex' }), /checkpoint_runner_mismatch/);
});
test('legacy artifacts and invalid runner inputs fail with explicit migration/configuration reasons', async t => {
  const x = await transport(t);
  await assert.rejects(x.prepare({ runner: 'unknown' }), /invalid_runner/);
  x.state.artifacts = [{ ...x.state.artifact, name: 'codex-session-r13-a1-1' }];
  await assert.rejects(x.prepare(), /legacy_checkpoint_unsupported/);
});
test('workflow recovery adapter needs no scheduling environment or arguments', async context => {
  const recovery = await transport(context);
  const github = { request: async (route, data) => {
    const [method, path] = route.split(' '); return { data: await recovery.api(path, { ...data, method }) };
  } };
  const result = await workflowCommand('recover', { github, core: { info() {}, setFailed(text) { assert.fail(text); } },
    env: { GITHUB_REPOSITORY: repository, GITHUB_RUN_ID: '13', GITHUB_RUN_ATTEMPT: '1', RUNNER_TEMP: recovery.f.temporary } });
  assert.equal(result.dispatched, true);
  assert.deepEqual(recovery.state.calls.find(call => call.options?.method === 'POST').options.inputs, { runner: 'codex', 'resume-run-id': '13', plan: '' });
});
for (const scenario of ['error', 'clarification', 'cancelled', 'setup-timeout', 'upload-timeout', 'disabled', 'limit']) test(`automatic continuation stops for ${scenario}`, async t => {
  const x = await transport(t);
  if (scenario === 'error' || scenario === 'clarification') x.state.job.conclusion = scenario === 'error' ? 'failure' : 'success';
  if (scenario === 'cancelled') x.state.job.conclusion = 'cancelled';
  if (scenario === 'setup-timeout') x.state.job.steps[1].started_at = null;
  if (scenario === 'upload-timeout') { x.state.job.steps[1].conclusion = 'success'; x.state.job.steps[2] = { ...x.state.job.steps[2], status: 'completed', conclusion: 'timed_out', started_at: '2026-11-17T00:04:00Z' }; }
  if (scenario === 'disabled') x.state.config = x.state.config.replace('auto-continue: true', 'auto-continue: false');
  if (scenario === 'limit') x.state.config += 'max-continuations: 0\n';
  assert.equal((await x.recover()).dispatched, false);
  assert.ok(!x.state.calls.some(call => call.options?.method === 'POST'));
});
test('an ambiguous dispatch response is attempted once and reruns cannot dispatch again', async t => {
  const x = await transport(t); let dispatches = 0;
  const api = async (path, options) => { if (options?.method === 'POST') { dispatches++; throw new Error('uncertain response'); } return x.api(path, options); };
  await assert.rejects(recoverExecution({ api, repository, runId: '13', attempt: '1', root: await x.root(), core: x.core }), /uncertain response/);
  assert.equal(dispatches, 1);
  assert.equal((await recoverExecution({ api, repository, runId: '13', attempt: '2', core: x.core })).dispatched, false); assert.equal(dispatches, 1);
  assert.equal(x.records[0].outcome, 'unconfirmed');
});

const interrupted = { outcome: 'failed', recovery_reason: 'native_worker_sigkill' };
const bot = { actor: 'github-actions[bot]', triggeringActor: 'github-actions[bot]', plan: '' };
function interruptedJob(job) {
  job.conclusion = 'failure';
  job.steps[1].conclusion = 'failure';
  Object.assign(job.steps[2], { status: 'completed', conclusion: 'success', started_at: '2026-11-17T00:04:00Z' });
}

for (const runner of ['codex', 'claude']) test(`verified ${runner} worker interruption dispatches and admits one continuation`, async t => {
  const x = await transport(t, runner, interrupted);
  interruptedJob(x.state.job);
  x.state.parent.status = 'in_progress';
  assert.equal((await x.recover()).dispatched, true);
  const posts = x.state.calls.filter(call => call.options?.method === 'POST');
  assert.equal(posts.length, 1);
  assert.deepEqual(posts[0].options.inputs, { runner, 'resume-run-id': '13', plan: '' });
  const resumed = await x.prepare(bot);
  assert.equal(resumed.restored.manifest.session_id, sessionId);
  assert.equal(resumed.restored.manifest.runner, runner);
  assert.equal(resumed.restored.manifest.recovery_reason, 'native_worker_sigkill');
  assert.equal(resumed.automatic_recovery, 'native_worker_sigkill');
  assert.equal(resumed.auto_count, 1);
  const [decision] = x.records;
  assert.equal(decision.event, 'continuation.dispatch');
  assert.equal(decision.reason, 'native_worker_sigkill');
  assert.equal(decision.parent_job_id, 70);
  assert.equal(decision.artifact_id, 55);
  assert.equal(decision.run_attempt, '1');
  assert.equal(decision.native_conclusion, 'failure');
  assert.equal(decision.final_save_conclusion, 'success');
  assert.equal(decision.max_continuations, 3);
  assert.ok(decision.elapsed_ms >= 0);
  t.diagnostic(JSON.stringify(decision));
});

for (const scenario of ['cleanup-only failure', 'stale running snapshot', 'ordinary failed snapshot', 'failed final save', 'cancelled run', 'disabled policy', 'exhausted allowance']) {
  test(`worker interruption recovery stops for ${scenario}`, async t => {
    const metadata = scenario === 'stale running snapshot' || scenario === 'cleanup-only failure' ? {} :
      scenario === 'ordinary failed snapshot' ? { outcome: 'failed' } : interrupted;
    const x = await transport(t, 'codex', metadata);
    interruptedJob(x.state.job);
    if (scenario === 'cleanup-only failure') x.state.job.steps[1].conclusion = 'success';
    if (scenario === 'cleanup-only failure' || scenario === 'failed final save') x.state.job.steps[2].conclusion = 'failure';
    if (scenario === 'cancelled run') x.state.parent.conclusion = 'cancelled';
    if (scenario === 'disabled policy') x.state.config = x.state.config.replace('auto-continue: true', 'auto-continue: false');
    if (scenario === 'exhausted allowance') x.state.config += 'max-continuations: 0\n';
    assert.equal((await x.recover()).dispatched, false);
    assert.ok(!x.state.calls.some(call => call.options?.method === 'POST'));
    await assert.rejects(x.prepare(bot));
    if (scenario === 'cleanup-only failure') assert.equal((await x.prepare()).restored.manifest.session_id, sessionId);
  });
}

for (const change of ['newer-attempt', 'failed-save', 'newer-checkpoint', 'ambiguous-checkpoint']) {
  test(`worker interruption recovery fences ${change} before dispatch`, async t => {
    const x = await transport(t, 'codex', interrupted);
    interruptedJob(x.state.job);
    let runReads = 0, jobReads = 0, artifactReads = 0;
    const api = async (path, options) => {
      const data = await x.api(path, options);
      if (path.endsWith('/actions/runs/13') && ++runReads === 3 && change === 'newer-attempt') return { ...data, run_attempt: 2 };
      if (path.includes('/attempts/1/jobs?') && ++jobReads === 2 && change === 'failed-save') {
        return { jobs: [{ ...x.state.job, steps: x.state.job.steps.map(step =>
          step.name === 'Save final session' ? { ...step, conclusion: 'failure' } : step) }] };
      }
      if (path.includes('/actions/runs/13/artifacts?') && ++artifactReads === 2 && change.endsWith('-checkpoint')) {
        const name = change === 'newer-checkpoint' ? 'remote-dev-session-r13-a1-2' : x.state.artifact.name;
        return { artifacts: [...data.artifacts, { ...x.state.artifact, id: 56, name }] };
      }
      return data;
    };
    await assert.rejects(recoverExecution({ api, repository, runId: '13', attempt: '1', root: await x.root(), core: x.core }),
      /parent_execution_changed|recovery_checkpoint_changed|ambiguous_latest_checkpoint/);
    assert.ok(!x.state.calls.some(call => call.options?.method === 'POST'));
  });
}

test('transient cooldown is clamped and other recovery reasons have no delay', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 100].map(count => recoveryCooldownMs('native_provider_transient', count)),
    [30000, 60000, 120000, 240000, 300000, 300000, 300000]);
  assert.equal(recoveryCooldownMs('native_worker_sigkill', 3), 0);
  assert.equal(recoveryCooldownMs('native_timeout', 3), 0);
});

for (const runner of ['codex', 'claude']) test(`verified ${runner} transient failure waits, fences, and admits a continuation`, async t => {
  const x = await transport(t, runner, { outcome: 'failed', recovery_reason: 'native_provider_transient' });
  interruptedJob(x.state.job);
  let delay;
  const result = await recoverExecution({ api: x.api, repository, runId: '13', attempt: '1', root: await x.root(), core: x.core,
    wait: async ms => { delay = ms; } });
  assert.equal(delay, 30000); assert.equal(result.dispatched, true);
  const decision = x.records.find(record => record.event === 'continuation.dispatch');
  assert.equal(decision.recovery_reason, 'native_provider_transient');
  assert.equal(decision.post_cooldown_rechecked, true);
  assert.equal(decision.cooldown_outcome, 'completed');
  assert.deepEqual(x.records.filter(record => record.event === 'continuation.cooldown').map(record => record.outcome), ['started', 'completed']);
  x.state.parent.status = 'in_progress';
  assert.equal((await x.prepare(bot)).automatic_recovery, 'native_provider_transient');
  await assert.rejects(x.prepare({ ...bot, plan: 'untrusted instructions' }), /untrusted_automatic_resume/);
});

for (const scenario of ['cancelled', 'disabled', 'limit', 'permission', 'changed-parent', 'missing-checkpoint']) {
  test(`transient recovery fences ${scenario} after cooldown`, async t => {
    const x = await transport(t, 'codex', { outcome: 'failed', recovery_reason: 'native_provider_transient' });
    interruptedJob(x.state.job);
    const wait = async () => {
      if (scenario === 'cancelled') x.state.parent.conclusion = 'cancelled';
      if (scenario === 'disabled') x.state.config = x.state.config.replace('auto-continue: true', 'auto-continue: false');
      if (scenario === 'limit') x.state.config += 'max-continuations: 0\n';
      if (scenario === 'permission') x.state.permission = 'read';
      if (scenario === 'changed-parent') x.state.parent = { ...x.state.parent, run_attempt: 2 };
      if (scenario === 'missing-checkpoint') x.state.artifacts = [];
    };
    const recovery = recoverExecution({ api: x.api, repository, runId: '13', attempt: '1', root: await x.root(), core: x.core, wait });
    if (scenario === 'changed-parent' || scenario === 'missing-checkpoint' || scenario === 'permission') {
      const reason = { 'changed-parent': 'parent_execution_changed', 'missing-checkpoint': 'run_checkpoint_unavailable', permission: 'operator_write_permission_required' }[scenario];
      await assert.rejects(recovery, error => error.reason === reason);
      assert.equal(x.records.at(-1).reason, reason); assert.equal(x.records.at(-1).outcome, 'blocked');
    }
    else {
      const result = await recovery;
      assert.equal(result.dispatched, false);
      assert.equal(result.reason, { cancelled: 'parent_run_cancelled', disabled: 'automatic_continuation_disabled', limit: 'continuation_limit_exceeded' }[scenario]);
    }
    assert.ok(!x.state.calls.some(call => call.options?.method === 'POST'));
    assert.equal(x.records.at(-1).post_cooldown_rechecked, true);
  });
}

test('transient recovery stops before waiting when the checkpoint or policy is unavailable', async t => {
  for (const scenario of ['missing', 'disabled', 'limit']) {
    const x = await transport(t, 'codex', { outcome: 'failed', recovery_reason: 'native_provider_transient' });
    interruptedJob(x.state.job);
    if (scenario === 'missing') x.state.artifacts = [];
    if (scenario === 'disabled') x.state.config = x.state.config.replace('auto-continue: true', 'auto-continue: false');
    if (scenario === 'limit') x.state.config += 'max-continuations: 0\n';
    const result = await recoverExecution({ api: x.api, repository, runId: '13', attempt: '1', root: await x.root(), core: x.core,
      wait: async () => assert.fail('wait must not run') });
    assert.equal(result.reason, { missing: 'run_checkpoint_unavailable', disabled: 'automatic_continuation_disabled', limit: 'continuation_limit_exceeded' }[scenario]);
    assert.ok(!x.state.calls.some(call => call.options?.method === 'POST'));
  }
});

test('a signal cancels the cooldown without dispatch and restores signal listeners', async t => {
  const x = await transport(t, 'codex', { outcome: 'failed', recovery_reason: 'native_provider_transient' });
  interruptedJob(x.state.job);
  const before = [process.listenerCount('SIGTERM'), process.listenerCount('SIGINT')];
  const result = await recoverExecution({ api: x.api, repository, runId: '13', attempt: '1', root: await x.root(), core: x.core,
    wait: async (_ms, signal) => { process.emit('SIGTERM'); assert.equal(signal.aborted, true); throw new Error('aborted'); } });
  assert.equal(result.reason, 'cooldown_cancelled');
  assert.deepEqual([process.listenerCount('SIGTERM'), process.listenerCount('SIGINT')], before);
  assert.equal(x.records.find(record => record.event === 'continuation.cooldown' && record.outcome === 'cancelled').level, 'WARN');
  assert.ok(!x.state.calls.some(call => call.options?.method === 'POST'));
});

for (const scenario of ['policy-drift', 'signal', 'permanent', 'uncertain-dispatch']) {
  test(`real Actions logger explains recovery ${scenario}`, async t => {
    const metadata = scenario === 'permanent' ? { outcome: 'failed' } : { outcome: 'failed', recovery_reason: 'native_provider_transient' };
    const x = await transport(t, 'codex', metadata);
    interruptedJob(x.state.job);
    let configReads = 0;
    const server = createServer(async (request, response) => {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const { path, options } = JSON.parse(Buffer.concat(chunks).toString());
      if (path.includes('/contents/.remote-dev.yml?') && ++configReads === 2 && scenario === 'policy-drift')
        x.state.config = x.state.config.replace('auto-continue: true', 'auto-continue: false');
      if (path.endsWith('/dispatches') && scenario === 'uncertain-dispatch') {
        response.writeHead(503, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ message: 'private-dispatch-body-9724', authorization: 'Bearer fixture-dispatch-token-4231' }));
        return;
      }
      try {
        const data = await x.api(path, options);
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(Buffer.isBuffer(data) ? { bytes: data.toString('base64') } : { data }));
      } catch (error) { response.writeHead(500); response.end(JSON.stringify({ message: error.message })); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
    const script = `
      import * as core from '@actions/core';
      import { workflowCommand } from './src/platform/control.mjs';
      const original = globalThis.setTimeout;
      globalThis.setTimeout = (callback, delay, ...args) => original(callback, delay === 30000 ? ${scenario === 'signal' ? 5000 : 30} : delay, ...args);
      const endpoint = process.argv[1];
      const github = { request: async (route, data) => {
        const [method, path] = route.split(' ');
        const response = await fetch(endpoint, { method: 'POST', body: JSON.stringify({ path, options: { ...data, method } }) });
        const payload = await response.json();
        if (!response.ok) throw Object.assign(new Error(payload.message), { status: response.status, response: { headers: { authorization: payload.authorization } } });
        return { data: payload.bytes ? Buffer.from(payload.bytes, 'base64') : payload.data };
      } };
      await workflowCommand('recover', { github, core, env: { GITHUB_REPOSITORY: 'fixture/repo', GITHUB_RUN_ID: '13',
        GITHUB_RUN_ATTEMPT: '1', RUNNER_TEMP: process.argv[2] } });
    `;
    const env = { ...process.env }; delete env.ACTIONS_STEP_DEBUG;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, `http://127.0.0.1:${server.address().port}`, x.f.temporary],
      { cwd: projectRoot, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', errors = '', sent = false;
    child.stdout.setEncoding('utf8'); child.stdout.on('data', chunk => {
      output += chunk;
      if (scenario === 'signal' && !sent && output.includes('"event":"continuation.cooldown"') && output.includes('"outcome":"started"')) {
        sent = true; child.kill('SIGTERM');
      }
    });
    child.stderr.setEncoding('utf8'); child.stderr.on('data', chunk => { errors += chunk; });
    const [code] = await once(child, 'close');
    assert.equal(code, scenario === 'uncertain-dispatch' ? 1 : 0, errors);
    const records = actionsRecords(output);
    const decision = records.find(record => record.event === 'continuation.dispatch');
    assert.equal(decision.repository, repository); assert.equal(decision.run_id, '13');
    assert.ok(!(output + errors).includes('private-dispatch-body-9724')); assert.ok(!(output + errors).includes('fixture-dispatch-token-4231'));
    for (const key of ['parent_run_id', 'parent_attempt', 'workflow_id', 'parent_job_id', 'parent_head_sha', 'artifact_id', 'checkpoint_sha',
      'session_id', 'runner', 'runner_version', 'root_run_id', 'activation_run_id', 'operator', 'trigger', 'native_outcome', 'recovery_reason',
      'auto_continue', 'continuation_count', 'max_continuations', 'cooldown_ms', 'cooldown_elapsed_ms', 'cooldown_outcome',
      'post_cooldown_rechecked', 'reason', 'outcome', 'elapsed_ms', 'truncated']) {
      assert.ok(Object.hasOwn(decision, key), key); assert.notEqual(decision[key], undefined, key);
    }
    const cooldowns = records.filter(record => record.event === 'continuation.cooldown');
    assert.deepEqual(cooldowns.map(record => record.outcome), scenario === 'permanent' ? [] :
      scenario === 'signal' ? ['started', 'cancelled'] : ['started', 'completed']);
    for (const cooldown of cooldowns) {
      for (const key of ['reason', 'trigger', 'recovery_reason', 'cooldown_ms', 'cooldown_elapsed_ms', 'continuation_count', 'max_continuations', 'elapsed_ms'])
        assert.ok(Object.hasOwn(cooldown, key), key);
      if (cooldown.outcome !== 'cancelled') assert.equal(cooldown.reason, null);
      assert.equal(cooldown.trigger, 'native_provider_transient'); assert.equal(cooldown.recovery_reason, 'native_provider_transient');
      assert.equal(cooldown.cooldown_ms, 30000); assert.equal(cooldown.continuation_count, 0); assert.equal(cooldown.max_continuations, 3);
    }
    assert.equal(decision.native_outcome, 'failed'); assert.equal(decision.artifact_id, 55); assert.equal(decision.session_id, sessionId);
    if (scenario === 'policy-drift') { assert.equal(decision.reason, 'automatic_continuation_disabled'); assert.equal(decision.post_cooldown_rechecked, true); assert.equal(decision.auto_continue, false); }
    if (scenario === 'signal') { assert.equal(decision.reason, 'cooldown_cancelled'); assert.equal(decision.cooldown_outcome, 'cancelled'); }
    if (scenario === 'permanent') { assert.equal(decision.reason, 'native_interruption_unconfirmed'); assert.equal(decision.recovery_reason, null); }
    if (scenario === 'uncertain-dispatch') { assert.equal(decision.outcome, 'unconfirmed'); assert.equal(decision.http_status, 503); assert.ok(decision.corrective_action); }
  });
}

test('snapshot retention removes only old snapshots of this run and attempt after replacement', async t => {
  const x = await transport(t);
  x.state.artifacts = [1, 2, 3, 4].map(id => ({ ...x.state.artifact, id, name: `remote-dev-session-r13-a1-${id}` }));
  x.state.artifacts.push({ id: 9, name: 'remote-dev-session-r13-a2-1' }, { id: 10, name: 'unrelated-evidence' });
  await pruneSnapshots(x.api, repository, '13', '1');
  assert.deepEqual(x.state.calls.filter(call => call.options?.method === 'DELETE').map(call => call.path), ['/repos/fixture/repo/actions/artifacts/2', '/repos/fixture/repo/actions/artifacts/1']);
});
for (const scenario of ['traversal', 'symlink', 'duplicate', 'schema', 'hash', 'extra']) test(`actual archive extraction rejects ${scenario}`, async t => {
  const f = await fixture(t); let entries;
  if (scenario === 'traversal') entries = [{ name: '../escape', text: 'bad' }];
  if (scenario === 'symlink') entries = [{ name: 'manifest.json', mode: 0o120777, text: 'outside' }];
  if (scenario === 'duplicate') entries = [{ name: 'manifest.json', text: '{}' }, { name: 'manifest.json', text: '{}' }];
  if (scenario === 'schema') entries = [{ name: 'manifest.json', text: JSON.stringify({ schema_version: 3, files: [] }) }];
  if (scenario === 'hash') entries = [{ name: 'manifest.json', text: JSON.stringify({ schema_version: 5, runner: 'codex', files: [{ path: 'codex/sessions/rollout.jsonl', bytes: 4, sha256: '0'.repeat(64) }] }) }, { name: 'codex/sessions/rollout.jsonl', text: 'bad!' }];
  if (scenario === 'extra') entries = [{ name: 'manifest.json', text: JSON.stringify({ schema_version: 5, runner: 'codex', files: [] }) }, { name: 'auth.json', text: 'credential' }];
  await assert.rejects(unpackArchive(f.job, await archive(f, entries), join(f.temporary, 'restore'), 'checkpoint', f.log));
  await assert.rejects(readFile(join(f.temporary, 'escape')), { code: 'ENOENT' });
});
test('manifest validation rejects legacy schemas, unsupported native versions and unsafe inventories', async t => {
  const x = await transport(t), manifest = x.exported.manifest;
  assert.equal(validateCheckpoint(manifest, repository).session_id, sessionId);
  for (const changed of [{ ...manifest, schema_version: 4 }, { ...manifest, runner_version: '0.0.1' }, { ...manifest, files: [{ path: '../auth', bytes: 0, sha256: 'a'.repeat(64) }] }]) assert.throws(() => validateCheckpoint(changed, repository));
  assert.throws(() => validateProducer({ ...x.state.artifact, workflow_run: { id: 99 } }, x.state.parent, manifest, repository));
  assert.throws(() => validateManifest({ ...manifest, recovery_reason: 'native_worker_sigkill' }, { repository }), /invalid_checkpoint_recovery_reason/);
  assert.throws(() => validateManifest({ ...manifest, recovery_reason: 'native_provider_transient' }, { repository }), /invalid_checkpoint_recovery_reason/);
  assert.throws(() => validateManifest({ ...manifest, outcome: 'failed', recovery_reason: 'unknown' }, { repository }), /invalid_checkpoint_recovery_reason/);
  assert.equal(validateManifest({ ...manifest, outcome: 'failed', recovery_reason: 'native_provider_transient' }, { repository }).recovery_reason, 'native_provider_transient');
});

test('native timeout remains eligible when skipped cleanup steps have timestamps', () => {
  assert.equal(nativeTimedOut({ status: 'completed', conclusion: 'timed_out', steps: [
    { number: 1, name: 'Execute agent', started_at: '2026-11-17T00:00:00Z', conclusion: 'failure' },
    { number: 2, name: 'Save final session', started_at: '2026-11-17T01:00:00Z', status: 'completed', conclusion: 'skipped' },
  ] }), true);
});
