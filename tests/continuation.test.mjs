import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import test from 'node:test';
import { exportCheckpoint } from '../.build/checkpoint.js';
import { unpackArchive, validateCheckpoint } from '../.build/resume.js';
import { checkpointName, validateManifest, validateProducer } from '../src/platform/checkpoint-policy.mjs';
import { loadRunCheckpoint, nativeTimedOut, prepareExecution, pruneSnapshots, recoverExecution } from '../src/platform/continuation-policy.mjs';
import { exec, checkpoint, fixture, sessionId } from './helpers.mjs';

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
async function transport(t) {
  const f = await fixture(t);
  await mkdir(join(f.job.codexHome, 'sessions'));
  await writeFile(join(f.job.codexHome, 'sessions/rollout.jsonl'), JSON.stringify({ type: 'session_meta', payload: { id: sessionId } }) + '\n');
  const exported = await exportCheckpoint(f.job, checkpoint(), f.log);
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
    { number: 2, name: 'Execute Codex', status: 'completed', conclusion: 'timed_out', started_at: '2026-11-17T00:01:00Z' },
    { number: 3, name: 'Save final session', status: 'skipped', conclusion: 'skipped', started_at: null },
  ] };
  const artifact = { id: 55, name: checkpointName(exported.manifest), workflow_run: { id: 13 }, size_in_bytes: bytes.length, expired: false, expires_at: '2099-01-01T00:00:00Z' };
  const state = { config: 'allowed-actors: [Z-M-Huang]\nskills: []\nauto-continue: true\n', permission: 'write', job, parent, current, artifact, artifacts: [artifact], calls: [] };
  const api = async (path, options) => {
    state.calls.push({ path, options });
    if (path === `/repos/${repository}`) return { default_branch: 'main' };
    if (path.includes('/commits/main')) return { sha: 'a'.repeat(40) };
    if (path.includes('/collaborators/')) return { permission: state.permission };
    if (path.includes('/contents/.remote-codex.yml?')) { const bytes = Buffer.from(state.config); return { type: 'file', encoding: 'base64', size: bytes.length, content: bytes.toString('base64') }; }
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
  const core = { info: () => {}, warning: () => {}, error: () => {} };
  const recover = async () => recoverExecution({ api, repository, runId: '13', attempt: '1', root: await root(), core,
    inputs: { 'runs-on': '["self-hosted","Linux","ARM64"]', 'timeout-minutes': '90' } });
  const prepare = async (extra = {}) => prepareExecution({ api, repository, runId: '20', attempt: '1', actor: 'Z-M-Huang', triggeringActor: 'Z-M-Huang',
    ref: 'refs/heads/main', resumeRunId: '13', plan: 'New context', root: await root(), ...extra });
  return { f, api, state, root, recover, prepare, exported };
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
  if (failure === 'version') extra.codexVersion = 'incompatible';
  if (failure === 'active') x.state.parent.status = 'in_progress';
  if (failure === 'workflow') x.state.current.workflow_id = 8;
  if (failure === 'authorization') x.state.permission = 'read';
  await assert.rejects(x.prepare(extra));
  assert.ok(!x.state.calls.some(call => call.options?.method === 'POST'));
});
test('timeout recovery dispatches the actual consumer workflow with preserved runner and timeout inputs', async t => {
  const x = await transport(t); assert.equal((await x.recover()).dispatched, true);
  const dispatch = x.state.calls.find(call => call.options?.method === 'POST');
  assert.equal(dispatch.path, '/repos/fixture/repo/actions/workflows/7/dispatches');
  assert.deepEqual(dispatch.options.inputs, { 'resume-run-id': '13', plan: '', 'runs-on': '["self-hosted","Linux","ARM64"]', 'timeout-minutes': '90' });
  x.state.parent.status = 'in_progress';
  const child = await x.prepare({ actor: 'github-actions[bot]', triggeringActor: 'github-actions[bot]', plan: '' });
  assert.equal(child.auto_count, 1); assert.equal(child.activation_run_id, '13');
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
  await assert.rejects(recoverExecution({ api, repository, runId: '13', attempt: '1', root: await x.root(), core: { info() {} }, inputs: { 'runs-on': '["ubuntu-latest"]', 'timeout-minutes': '360' } }));
  assert.equal(dispatches, 1);
  assert.equal((await recoverExecution({ api, repository, runId: '13', attempt: '2', core: { info() {} } })).dispatched, false); assert.equal(dispatches, 1);
});
test('snapshot retention removes only old snapshots of this run and attempt after replacement', async t => {
  const x = await transport(t);
  x.state.artifacts = [1, 2, 3, 4].map(id => ({ ...x.state.artifact, id, name: `codex-session-r13-a1-${id}` }));
  x.state.artifacts.push({ id: 9, name: 'codex-session-r13-a2-1' }, { id: 10, name: 'linux-qualification-evidence' });
  await pruneSnapshots(x.api, repository, '13', '1');
  assert.deepEqual(x.state.calls.filter(call => call.options?.method === 'DELETE').map(call => call.path), ['/repos/fixture/repo/actions/artifacts/2', '/repos/fixture/repo/actions/artifacts/1']);
});
for (const scenario of ['traversal', 'symlink', 'duplicate', 'schema', 'hash', 'extra']) test(`actual archive extraction rejects ${scenario}`, async t => {
  const f = await fixture(t); let entries;
  if (scenario === 'traversal') entries = [{ name: '../escape', text: 'bad' }];
  if (scenario === 'symlink') entries = [{ name: 'manifest.json', mode: 0o120777, text: 'outside' }];
  if (scenario === 'duplicate') entries = [{ name: 'manifest.json', text: '{}' }, { name: 'manifest.json', text: '{}' }];
  if (scenario === 'schema') entries = [{ name: 'manifest.json', text: JSON.stringify({ schema_version: 3, files: [] }) }];
  if (scenario === 'hash') entries = [{ name: 'manifest.json', text: JSON.stringify({ schema_version: 4, files: [{ path: 'codex/sessions/rollout.jsonl', bytes: 4, sha256: '0'.repeat(64) }] }) }, { name: 'codex/sessions/rollout.jsonl', text: 'bad!' }];
  if (scenario === 'extra') entries = [{ name: 'manifest.json', text: JSON.stringify({ schema_version: 4, files: [] }) }, { name: 'auth.json', text: 'credential' }];
  await assert.rejects(unpackArchive(f.job, await archive(f, entries), join(f.temporary, 'restore'), 'checkpoint', f.log));
  await assert.rejects(readFile(join(f.temporary, 'escape')), { code: 'ENOENT' });
});
test('manifest validation rejects legacy schemas, unsupported native versions and unsafe inventories', async t => {
  const x = await transport(t), manifest = x.exported.manifest;
  assert.equal(validateCheckpoint(manifest, repository).session_id, sessionId);
  for (const changed of [{ ...manifest, schema_version: 3 }, { ...manifest, codex_version: '0.0.1' }, { ...manifest, files: [{ path: '../auth', bytes: 0, sha256: 'a'.repeat(64) }] }]) assert.throws(() => validateCheckpoint(changed, repository));
  assert.throws(() => validateProducer({ ...x.state.artifact, workflow_run: { id: 99 } }, x.state.parent, manifest, repository));
});

test('native timeout remains eligible when skipped cleanup steps have timestamps', () => {
  assert.equal(nativeTimedOut({ status: 'completed', conclusion: 'timed_out', steps: [
    { number: 1, name: 'Execute Codex', started_at: '2026-11-17T00:00:00Z', conclusion: 'failure' },
    { number: 2, name: 'Save final session', started_at: '2026-11-17T01:00:00Z', status: 'completed', conclusion: 'skipped' },
  ] }), true);
});
