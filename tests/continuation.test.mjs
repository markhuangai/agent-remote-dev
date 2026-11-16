import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { hash, versions } from '../.build/contracts.js';
import { exportCheckpoint } from '../.build/checkpoint.js';
import { unpackArchive, validateCheckpoint } from '../.build/resume.js';
import { verifyResumeSettings } from '../.build/continuation.js';
import { checkpointName, recordName, registrationKey, validateManifest, validateProducer } from '../.github/remote-codex/checkpoint-policy.mjs';
import { childRunName, continuationDecision, prepareTaskRequest, runController, requireActive } from '../.github/remote-codex/continuation-policy.mjs';
import { verifyProtocol } from '../.github/remote-codex/protocol-policy.mjs';
import { exec, execution, fixture, lineage as fixtureLineage, root } from './helpers.mjs';

const repo = 'fixture/repo', taskId = 'fixture-task', branch = 'skill/selected-branch', sourceSha = 'a'.repeat(40);
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
  model.protocol = JSON.parse(await readFile(join(root, '.github/remote-codex/protocol.json'), 'utf8'));
  model.sources = new Map();
  for (const path of Object.keys(model.protocol.files)) model.sources.set(path, await readFile(join(root, path)));
  model.jobs = new Map();
  const api = async (endpoint, options = {}) => {
    const method = options.method ?? 'GET';
    if (endpoint.includes('/collaborators/')) return { permission: model.permission ?? 'write' };
    if (endpoint === `/repos/${repo}/git/ref/heads/main`) return { object: { sha: sourceSha } };
    if (endpoint.startsWith(`/repos/${repo}/contents/`)) {
      const path = endpoint.split('/contents/')[1].split('?')[0];
      const bytes = path === '.github/remote-codex/protocol.json' ? Buffer.from(json(model.protocol)) : model.sources.get(path);
      return { size: bytes.length, encoding: 'base64', content: bytes.toString('base64') };
    }
    if (endpoint.match(/\/actions\/artifacts\/[0-9]+(?:\/zip)?$/)) {
      const id = Number(endpoint.match(/artifacts\/([0-9]+)/)[1]);
      return endpoint.endsWith('/zip') ? payloads.get(id) : artifacts.get(id);
    }
    if (endpoint === `/repos/action/source/commits/${sourceSha}` || endpoint === `/repos/${repo}/commits/${sourceSha}`) return { sha: sourceSha };
    if (/\/actions\/runs\/[0-9]+(?:\/attempts\/[0-9]+)?$/.test(endpoint)) return model.runs.get(Number(endpoint.match(/runs\/([0-9]+)/)[1]));
    if (endpoint === `/repos/${repo}/actions/workflows/7`) return { path: parent.path, state: 'active' };
    if (endpoint === `/repos/${repo}/actions/workflows/runner-task.yml`) return { path: '.github/workflows/runner-task.yml', state: 'active' };
    if (endpoint === `/repos/${repo}/actions/workflows/runner-continuation.yml`) return { path: '.github/workflows/runner-continuation.yml', state: 'active' };
    if (/\/actions\/runs\/[0-9]+\/artifacts\?/.test(endpoint)) return { artifacts: [...artifacts.values()].filter(artifact => artifact.workflow_run.id === Number(endpoint.match(/runs\/([0-9]+)/)[1])) };
    if (endpoint.startsWith(`/repos/${repo}/actions/artifacts?`)) {
      const name = new URL('https://api.invalid' + endpoint).searchParams.get('name');
      return { artifacts: [...artifacts.values()].filter(artifact => !name || artifact.name === name) };
    }
    if (endpoint === `/repos/${repo}/git/ref/heads/${branch}`) return { object: { sha: model.observedHead } };
    if (/\/actions\/runs\/[0-9]+\/attempts\/[0-9]+\/jobs\?/.test(endpoint)) return { jobs: model.jobs.get(Number(endpoint.match(/runs\/([0-9]+)/)[1])) ?? [{ id: 70, name: 'execute', status: 'completed', completed_at: model.endedAt }] };
    if (endpoint.startsWith(`/repos/${repo}/actions/workflows/runner-task.yml/runs?`)) return { workflow_runs: [model.parent, ...model.children] };
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
    GITHUB_WORKFLOW_SHA: sourceSha, RUNNER_TEMP: f.temporary, CONTINUATION_MODE: 'resolve', GITHUB_JOB: 'resolve', TRIGGERING_ACTOR: 'github-actions[bot]' };
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
  f.model.sources.set('.github/remote-codex/archive.py', Buffer.from('changed archive helper'));
  await assert.rejects(verifyProtocol(f.api, repo), { reason: 'protocol_source_mismatch' });
});

test('trusted fresh requests freeze selected setup and reject unlisted or read-only operators', async t => {
  const f = await protocolFixture(t), plan = 'Run an arbitrary selected workflow.';
  const request = { task_id: 'new-task', source_repository: 'action/source', source_sha: sourceSha, plan,
    authorization: { repository: repo, plan_sha256: hash(plan), request: 'Run this prompt remotely.' }, skills: [], runner: ['self-hosted', 'Linux', 'X64'],
    git_author_name: 'Fixture Author', git_author_email: 'fixture@example.invalid' };
  const env = { ...f.env, GITHUB_RUN_ID: '200', GITHUB_JOB: 'fresh', GITHUB_RUN_ATTEMPT: '1', TRIGGERING_ACTOR: 'Z-M-Huang', TASK_REQUEST: registered(request) };
  const context = { ...f.context, actor: 'Z-M-Huang', eventName: 'workflow_dispatch' };
  const result = await prepareTaskRequest({ github: f.github, context, core: f.core, env });
  const fixed = JSON.parse(result.execution);
  assert.deepEqual(fixed.runner, request.runner); assert.equal(fixed.source_repository, 'action/source'); assert.equal(fixed.budget_minutes, 300);
  assert.equal(result.skills, '[]'); assert.equal(fixed.activation_run_id, '200');
  await assert.rejects(prepareTaskRequest({ github: f.github, context, core: f.core, env: { ...env, TASK_REQUEST: json({ ...request, plan: 'Changed bytes', registration_key: registrationKey(request) }) } }), /request_registration_mismatch/);
  await assert.rejects(prepareTaskRequest({ github: f.github, context: { ...context, actor: 'outsider' }, core: f.core, env }), /untrusted_task_actor/);
  f.model.permission = 'read';
  await assert.rejects(prepareTaskRequest({ github: f.github, context, core: f.core, env }), /operator_write_permission_required/);
  assert.ok(f.records.some(record => record.event === 'submission.resolve' && record.reason === 'operator_write_permission_required'));
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
  await assert.rejects(prepareTaskRequest({ github: f.github, context, core: f.core, env: { ...env, TASK_REQUEST: registered({ ...request, runner: ['ubuntu-latest'] }) } }), /resume_settings_changed/);
});

test('resume setting comparison freezes runner, instruction and source identities', () => {
  const recorded = execution(), resumed = { ...recorded, parent_run_id: '13', parent_run_attempt: '1', continuation_count: 1, activation_run_id: '15' };
  verifyResumeSettings(recorded, resumed);
  for (const change of [{ runner: ['self-hosted', 'Linux'] }, { source_sha: 'f'.repeat(40) }, { user_agents_sha256: 'b'.repeat(64), user_agents_url: 'https://example.invalid/AGENTS.md' }]) assert.throws(() => verifyResumeSettings(recorded, { ...resumed, ...change }), { reason: 'resume_settings_changed' });
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
