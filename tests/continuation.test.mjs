import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { authorize, executionSource, hash, versions } from '../.build/contracts.js';
import { exportCheckpoint, durableCheckpoint } from '../.build/checkpoint.js';
import { loadCheckpoint, restoreCheckpoint, unpackArchive, validateCheckpoint } from '../.build/resume.js';
import { budgetOutcome, verifyResumeSettings } from '../.build/continuation.js';
import { configure, installSkillSource, removeJob } from '../.build/setup.js';
import { TaskGit } from '../.build/git.js';
import { drive } from '../.build/driver.js';
import { checkpointName, debitReviewBudget, recordName, savedAuditAuthority, savedAuditHistory, validateManifest, validateProducer } from '../.github/scripts/checkpoint-policy.mjs';
import { childRunName, manualRunName, continuationDecision, prepareTaskRequest, runController } from '../.github/scripts/continuation-policy.mjs';
import { verifyProtocol } from '../.github/scripts/protocol-policy.mjs';
import { exec, fixture, message, policy, portableSource, provider, repository, root, tool, turn } from './helpers.mjs';

const repo = 'fixture/repo', taskId = 'fixture-task', branch = `codex/task-${taskId}`, sourceSha = 'a'.repeat(40);
const execution = (extra = {}) => ({ source_sha: sourceSha, auto_continue: true, max_continuations: 3, continuation_count: 0, budget_minutes: 3,
  root_run_id: '13', root_run_attempt: '1', parent_run_id: null, parent_run_attempt: null, git_author_name: 'Fixture Author', git_author_email: 'fixture@example.invalid', ...extra });
const lineage = { repository: repo, workflow_ref: `${repo}/.github/workflows/runner-task.yml@refs/heads/main`, workflow_sha: sourceSha,
  run_id: '13', run_attempt: '1', actor: 'Z-M-Huang', triggering_actor: 'Z-M-Huang', credential_owner: 'Z-M-Huang' };
const state = (session, extra = {}) => ({ worker_session: session, auditor_session: null, turn: 1, pr_url: null, validation_policy: null,
  audit_rounds: [], reconsidered: [], review_budget: null, ...extra });
const json = value => JSON.stringify(value);
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
      sessions: [session], skills: [executionSource], progress: { kind: 'accomplishment' }, lineage, audit: null, previous: null,
      execution: execution(), driver: state(session), workspace: '/old/project' }, f.log);
    manifest = JSON.parse(await readFile(join(exported.root, 'manifest.json'), 'utf8'));
    checkpointZip = await zipDirectory(f, 'checkpoint', exported.root);
  }
  const parent = { id: 13, run_attempt: 1, status: 'completed', conclusion: 'timed_out', event: 'workflow_dispatch', path: '.github/workflows/runner-task.yml',
    head_branch: 'main', head_sha: sourceSha, workflow_id: 7, repository: { full_name: repo }, head_repository: { full_name: repo },
    actor: { login: 'Z-M-Huang' }, triggering_actor: { login: 'Z-M-Huang' }, html_url: `https://github.com/${repo}/actions/runs/13` };
  const request = { schema_version: 2, repository: repo, task_id: taskId, branch, base_sha: manifest.base_sha, plan_sha256: manifest.plan_sha256,
    authorization: manifest.authorization, execution: manifest.execution, lineage, job_name: 'execute', resume_artifact_id: null, review_budget: null,
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
  model.protocol = JSON.parse(await readFile(join(root, '.github/runner-protocol.json'), 'utf8'));
  model.sources = new Map();
  for (const path of Object.keys(model.protocol.files)) model.sources.set(path, await readFile(join(root, path)));
  model.jobs = new Map();
  const api = async (endpoint, options = {}) => {
    const method = options.method ?? 'GET';
    if (endpoint === `/repos/${repo}/git/ref/heads/main`) return { object: { sha: sourceSha } };
    if (endpoint.startsWith(`/repos/${repo}/contents/`)) {
      const path = endpoint.split('/contents/')[1].split('?')[0];
      const bytes = path === '.github/runner-protocol.json' ? Buffer.from(json(model.protocol)) : model.sources.get(path);
      return { size: bytes.length, encoding: 'base64', content: bytes.toString('base64') };
    }
    if (endpoint.match(/\/actions\/artifacts\/[0-9]+(?:\/zip)?$/)) {
      const id = Number(endpoint.match(/artifacts\/([0-9]+)/)[1]);
      return endpoint.endsWith('/zip') ? payloads.get(id) : artifacts.get(id);
    }
    if (endpoint === `/repos/${repo}/commits/${sourceSha}`) return { sha: sourceSha };
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
    if (endpoint.startsWith(`/repos/${repo}/actions/workflows/runner-task.yml/runs?`)) return { workflow_runs: model.children };
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
  env.CODEX_RUNNER_PROTOCOL = '2';
  const context = { repo: { owner: 'fixture', repo: 'repo' }, actor: 'github-actions[bot]', eventName: 'workflow_run', payload: { workflow_run: { ...parent } } };
  return { ...f, runtimeRecords: f.records, model, api, github, env, context, addArtifact, ...normalCore() };
}

test('schema-2 manifest binds authority, skills, sessions, versions and producer identity', async t => {
  const f = await protocolFixture(t), m = f.model.manifest;
  assert.equal(validateCheckpoint(m, repo).driver.worker_session, m.sessions[0]);
  for (const [change, reason] of [
    [{ schema_version: 1 }, 'unsupported_checkpoint_schema'], [{ repository: 'other/repo' }, 'checkpoint_repository_mismatch'],
    [{ versions: { ...versions, codex: '0.168.0' } }, 'checkpoint_version_mismatch'], [{ plan: 'Changed plan' }, 'checkpoint_plan_hash_mismatch'],
    [{ authorization: { ...m.authorization, request: '' } }, 'checkpoint_authorization_mismatch'],
    [{ driver: { ...m.driver, worker_session: randomUUID() } }, 'checkpoint_session_mismatch'],
    [{ skills: [{ ...executionSource, revision: 'f'.repeat(40) }] }, 'checkpoint_skills_missing'],
    [{ branch: 'main' }, 'invalid_checkpoint_git_identity'], [{ files: [{ path: '../escape' }] }, 'unsafe_checkpoint_path'],
  ]) assert.throws(() => validateManifest({ ...m, ...change }, { repository: repo, versions }), { reason });
  const artifact = f.model.artifacts.get(41);
  assert.equal(validateProducer(artifact, f.model.parent, m, repo), artifact);
  for (const run of [{ ...f.model.parent, event: 'pull_request' }, { ...f.model.parent, head_branch: 'feature' }, { ...f.model.parent, head_sha: 'c'.repeat(40) },
    { ...f.model.parent, run_attempt: 2 }, { ...f.model.parent, actor: { login: 'other' } }]) assert.throws(() => validateProducer(artifact, run, m, repo));
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
    if (variant === 'schema') { assert.equal(error.details.expected, 2); assert.equal(error.details.observed, 1); }
    return true;
  });
  await assert.rejects(readFile(join(destination, 'manifest.json')), { code: 'ENOENT' });
});

test('continuation and review limits remain bounded across interruption and queue time', () => {
  const budget = { head_sha: sourceSha, remaining_ms: 5000, active_since: 10000 };
  const carried = debitReviewBudget(budget, 13000);
  assert.deepEqual(carried, { head_sha: sourceSha, remaining_ms: 2000, active_since: null });
  assert.equal(debitReviewBudget(carried, 999999999).remaining_ms, 2000);
  assert.equal(debitReviewBudget({ ...carried, active_since: 15000 }, 19000).remaining_ms, 0);
  assert.equal(budgetOutcome(execution(), { artifact_id: 41 }), 'continuing');
  assert.equal(budgetOutcome(execution({ continuation_count: 3 }), { artifact_id: 41 }), 'incomplete');
  assert.equal(budgetOutcome(execution(), null), 'incomplete');
  assert.equal(budgetOutcome(execution({ auto_continue: false }), { artifact_id: 41 }), 'incomplete');
  verifyResumeSettings(execution(), execution({ parent_run_id: '13', parent_run_attempt: '1', continuation_count: 1 }));
  for (const field of [{ max_continuations: 4 }, { source_sha: 'c'.repeat(40) }, { git_author_email: 'changed@example.invalid' }])
    assert.throws(() => verifyResumeSettings(execution(), execution({ parent_run_id: '13', parent_run_attempt: '1', continuation_count: 1, ...field })), { reason: 'resume_settings_changed' });
});

test('active registration cannot substitute for a compatible trusted protocol', async t => {
  const f = await protocolFixture(t);
  const verified = await verifyProtocol(f.api, repo);
  assert.equal(verified.protocol_version, 2); assert.equal(verified.revision, sourceSha);
  f.model.protocol.protocol_version = 1;
  await assert.rejects(verifyProtocol(f.api, repo), { reason: 'incompatible_runner_protocol' });
  let calls = 0;
  assert.equal(await verifyProtocol(async () => { calls++; throw Error('Disabled mode must not request a controller'); }, repo, false), null);
  assert.equal(calls, 0);
  f.model.protocol.protocol_version = 2;
  f.model.sources.set('.github/workflows/runner-task.yml', Buffer.from('name: incompatible registered workflow'));
  await assert.rejects(verifyProtocol(f.api, repo), { reason: 'protocol_source_mismatch' });
});

test('malformed manifest diagnostic values cannot carry arbitrary payload text into controller logs', async t => {
  const f = await protocolFixture(t), manifest = structuredClone(f.model.manifest), sentinel = 'PRIVATE_PLAN_HISTORY_CONFIGURATION_SENTINEL_7832';
  manifest.versions = { codex: { payload: sentinel }, provider_body: sentinel };
  const file = manifest.files[0];
  const bytes = await zipEntries(f, 'poisoned-versions', [{ name: 'manifest.json', text: json(manifest) },
    { name: file.path, text: json({ type: 'session_meta', payload: { id: manifest.sessions[0] } }) + '\n' }]);
  f.addArtifact(41, checkpointName(manifest), bytes);
  await assert.rejects(runController(f), { reason: 'checkpoint_version_mismatch' });
  assert.doesNotMatch(json(f.records), new RegExp(sentinel));
  assert.equal(f.records.at(-1).observed, '[invalid object]');
  assert.equal(f.records.at(-1).reason, 'checkpoint_version_mismatch');
  assert.equal(f.records.at(-1).artifact_id, 41);
  assert.equal(f.records.at(-1).parent_run_id, 13);
  assert.equal(f.records.at(-1).parent_run_attempt, 1);
});

test('malformed artifact rejection retains parent, task and artifact correlation at normal verbosity', async t => {
  const f = await protocolFixture(t);
  f.model.payloads.set(41, Buffer.from('malformed ZIP input'));
  await assert.rejects(runController(f), { reason: 'archive_read_failed' });
  const record = f.records.at(-1);
  assert.equal(record.event, 'continuation.dispatch'); assert.equal(record.level, 'ERROR');
  assert.equal(record.parent_run_id, 13); assert.equal(record.parent_run_attempt, 1);
  assert.equal(record.artifact_id, 41); assert.equal(record.task_id, taskId);
  assert.equal(record.reason, 'archive_read_failed'); assert.ok(record.corrective_action.includes('durable artifact'));
});

for (const conclusion of ['cancelled', 'failure', 'skipped', 'action_required']) test(`controller never restarts a ${conclusion} parent`, async t => {
  const f = await protocolFixture(t); f.model.parent.conclusion = conclusion; f.context.payload.workflow_run.conclusion = conclusion;
  const result = await runController(f);
  assert.equal(result.eligible, false); assert.equal(f.model.dispatches.length, 0);
  assert.equal(f.records.at(-1).reason, `parent_${conclusion}`);
});

test('controller recovers a native timeout, persists a claim, reconciles an ambiguous dispatch and never dispatches it twice', async t => {
  const f = await protocolFixture(t); f.model.registration = 'ambiguous';
  f.env.CONTINUATION_MODE = 'prepare';
  const prepared = await runController(f);
  assert.equal(prepared.upload, true); assert.equal(f.model.dispatches.length, 0);
  const claimZip = await zipDirectory(f, 'claim', join(prepared.claim_path, '..'));
  f.addArtifact(50, prepared.claim_name, claimZip, 99);
  f.env.CONTINUATION_MODE = 'dispatch'; f.env.CLAIM_ARTIFACT_ID = '50'; f.env.NEW_CLAIM = 'true';
  const dispatched = await runController({ ...f, sleep: async () => {} });
  assert.equal(dispatched.child_run_id, 100); assert.equal(f.model.dispatches.length, 1);
  assert.equal(f.model.dispatches[0].resume_artifact_id, 41); assert.equal(f.model.dispatches[0].continuation_count, 1);
  f.env.GITHUB_RUN_ATTEMPT = '2'; f.env.NEW_CLAIM = 'false';
  await runController(f);
  assert.equal(f.model.dispatches.length, 1); assert.equal(f.records.at(-1).outcome, 'registered');
  assert.equal(f.records.at(-1).parent_run_id, 13); assert.equal(f.records.at(-1).claim_artifact_id, 50);
});

test('an existing claim without a child blocks after five minutes and cannot issue another request', async t => {
  const f = await protocolFixture(t); f.env.CONTINUATION_MODE = 'prepare';
  const prepared = await runController(f);
  f.addArtifact(50, prepared.claim_name, await zipDirectory(f, 'claim', join(prepared.claim_path, '..')), 99);
  f.env.CONTINUATION_MODE = 'dispatch'; f.env.GITHUB_RUN_ATTEMPT = '2'; f.env.CLAIM_ARTIFACT_ID = '50'; f.env.NEW_CLAIM = 'false';
  let clock = 0;
  await assert.rejects(runController({ ...f, now: () => clock, sleep: async ms => { clock += ms; } }), { reason: 'claimed_dispatch_unreconciled' });
  assert.equal(clock, 300000); assert.equal(f.model.dispatches.length, 0);
  assert.equal(f.records.at(-1).reason, 'claimed_dispatch_unreconciled');
});

test('failed terminal outcomes and remote Git drift veto native timeout recovery', async t => {
  const f = await protocolFixture(t);
  const outcome = { ...f.model.request, status: 'failed', reason: 'authentication_failed', checkpoint: { artifact_id: 41, checkpoint_sha: f.model.manifest.checkpoint_sha } };
  f.addArtifact(42, recordName('outcome', taskId, '13', '1'), await zipEntries(f, 'failed', [{ name: 'record.json', text: json(outcome) }]));
  assert.equal((await runController(f)).eligible, false);
  f.model.artifacts.delete(42); f.env.GITHUB_RUN_ATTEMPT = '2'; f.model.observedHead = 'c'.repeat(40);
  await assert.rejects(runController(f), { reason: 'resume_branch_drift' });
  const record = f.records.at(-1); assert.equal(record.expected, f.model.manifest.checkpoint_sha); assert.equal(record.observed, 'c'.repeat(40));
  assert.equal(f.model.dispatches.length, 0);
});

for (const status of ['completed', 'blocked', 'cancelled']) test(`a recorded ${status} outcome vetoes timeout recovery`, async t => {
  const f = await protocolFixture(t), outcome = { ...f.model.request, status, reason: status };
  f.addArtifact(42, recordName('outcome', taskId, '13', '1'), await zipEntries(f, 'terminal', [{ name: 'record.json', text: json(outcome) }]));
  assert.equal((await runController(f)).eligible, false); assert.equal(f.model.dispatches.length, 0);
  assert.equal(f.records.at(-1).reason, `outcome_${status}`);
});

test('trusted task requests freeze defaults and automatic children require the unique native claim', async t => {
  const f = await protocolFixture(t);
  const env = { ...f.env, GITHUB_RUN_ID: '13', GITHUB_JOB: 'resolve-new', TRIGGERING_ACTOR: 'Z-M-Huang',
    TASK_REQUEST: json({ task_id: taskId, source_sha: sourceSha, plan: f.model.manifest.plan, authorization: f.model.manifest.authorization,
      git_author_name: 'Fixture Author', git_author_email: 'fixture@example.invalid' }) };
  const context = { ...f.context, actor: 'Z-M-Huang', eventName: 'workflow_dispatch' };
  const initial = await prepareTaskRequest({ ...f, env, context });
  assert.equal(JSON.parse(initial.execution).max_continuations, 3); assert.equal(JSON.parse(initial.execution).auto_continue, true);
  assert.equal(initial.authorization, json(f.model.manifest.authorization));
  await assert.rejects(prepareTaskRequest({ ...f, env: { ...env, GITHUB_JOB: 'untrusted' }, context: { ...context, actor: 'other' } }), { reason: 'untrusted_task_actor' });
  f.env.CONTINUATION_MODE = 'prepare';
  const prepared = await runController(f);
  f.addArtifact(50, prepared.claim_name, await zipDirectory(f, 'unique-claim', join(prepared.claim_path, '..')), 99);
  f.env.CONTINUATION_MODE = 'dispatch'; f.env.CLAIM_ARTIFACT_ID = '50'; f.env.NEW_CLAIM = 'true';
  await runController({ ...f, sleep: async () => {} });
  const childEnv = { ...f.env, GITHUB_RUN_ID: '100', GITHUB_JOB: 'execute', TASK_REQUEST: json(f.model.dispatches[0]), TRIGGERING_ACTOR: 'github-actions[bot]' };
  const childContext = { ...f.context, eventName: 'workflow_dispatch' };
  const child = await prepareTaskRequest({ ...f, env: childEnv, context: childContext });
  assert.equal(child.resume_artifact_id, 41); assert.equal(JSON.parse(child.execution).continuation_count, 1);
  assert.equal(child.authorization, initial.authorization); assert.equal(child.source_sha, sourceSha);
  f.model.children.push({ ...f.model.children[0], id: 101 });
  await assert.rejects(prepareTaskRequest({ ...f, env: { ...childEnv, GITHUB_RUN_ID: '101' }, context: childContext }), { reason: 'duplicate_child_refused' });
  assert.equal(f.model.dispatches.length, 1);
});

test('real remote branch drift rejects restore before switching or modifying the fresh checkout', async t => {
  const f = await protocolFixture(t), r = await repository(f);
  await r.git('branch', '-m', branch); r.branch = branch;
  await r.git('push', 'origin', branch);
  const original = await r.git('rev-parse', 'HEAD');
  await writeFile(join(r.cwd, 'drift.txt'), 'external change');
  await r.git('add', 'drift.txt'); await r.git('commit', '-m', 'External branch advance'); await r.git('push', 'origin', branch);
  const cwd = join(f.temporary, 'fresh'); await exec('git', ['clone', '--branch', 'main', r.remote, cwd], { env: f.job.env });
  const git = new TaskGit(cwd, f.job.env, f.log, branch);
  const archive = join(f.temporary, 'valid.zip'); await writeFile(archive, f.model.payloads.get(41));
  const snapshot = join(f.temporary, 'valid-snapshot'); await unpackArchive(f.job, archive, snapshot, 'checkpoint', f.log);
  const manifest = { ...f.model.manifest, checkpoint_sha: original, base_sha: original };
  await assert.rejects(restoreCheckpoint(f.job, snapshot, manifest, git, f.log), { reason: 'resume_branch_drift' });
  assert.equal(await git.head(), original); assert.equal((await git.run(['branch', '--show-current'])).trim(), 'main');
  const failure = f.runtimeRecords.find(record => record.event === 'resume.restore');
  assert.equal(failure.reason, 'resume_branch_drift'); assert.equal(failure.expected_sha, original);
  assert.equal(failure.observed_sha, await r.git('rev-parse', 'HEAD'));
  await assert.rejects(readFile(join(cwd, 'drift.txt')), { code: 'ENOENT' });
});

test('a timed-out child can reuse its inherited checkpoint without replenishing review time or continuation count', async t => {
  const f = await protocolFixture(t);
  const child = { ...f.model.parent, id: 100, actor: { login: 'github-actions[bot]' }, triggering_actor: { login: 'github-actions[bot]' } };
  f.model.runs.set(100, child); f.context.payload.workflow_run = { ...child };
  const request = { ...f.model.request, execution: execution({ continuation_count: 2, parent_run_id: '90', parent_run_attempt: '1' }),
    lineage: { ...lineage, run_id: '100', actor: 'github-actions[bot]', triggering_actor: 'github-actions[bot]' }, resume_artifact_id: 41, review_budget: null };
  f.addArtifact(60, recordName('run', taskId, '100', '1'), await zipEntries(f, 'child-request', [{ name: 'record.json', text: json(request) }]), 100);
  const decision = await runController(f);
  assert.equal(decision.eligible, true);
  f.env.CONTINUATION_MODE = 'prepare';
  const claim = await runController(f);
  const value = JSON.parse(await readFile(claim.claim_path, 'utf8'));
  assert.equal(value.continuation_count, 3); assert.equal(value.artifact_id, 41);
  request.execution.continuation_count = 3;
  f.addArtifact(60, recordName('run', taskId, '100', '1'), await zipEntries(f, 'child-exhausted', [{ name: 'record.json', text: json(request) }]), 100);
  f.env.CONTINUATION_MODE = 'resolve'; f.env.GITHUB_RUN_ATTEMPT = '2';
  assert.equal((await runController(f)).eligible, false);
  assert.equal(f.records.at(-1).reason, 'continuation_limit');
});

test('the real normal Actions logger diagnoses an expired artifact without exposing transport payloads or credentials', async t => {
  const f = await fixture(t), entry = join(f.temporary, 'diagnostic.mjs');
  await writeFile(entry, `import {loadCheckpoint} from ${json(join(root, '.build/resume.js'))};
import {Diagnostics} from ${json(join(root, '.build/diagnostics.js'))};
const log=new Diagnostics({repository:'fixture/repo',task_id:'fixture-task',run_id:'13',run_attempt:'1'});
log.protect('fixture-private-credential-8267');
try{await loadCheckpoint(${json(f.job)},async()=>({id:41,expired:true,private:'fixture-private-credential-8267'}),'fixture/repo',41,log)}catch(error){if(error.reason!=='checkpoint_artifact_expired')throw error}
`);
  const output = await exec(process.execPath, [entry]);
  const records = output.stdout.split('\n').map(line => { try { return JSON.parse(line.replace(/^::error::/, '')); } catch { return null; } }).filter(Boolean);
  assert.doesNotMatch(json(records), /private-credential|"private"|authorization|headers/);
  assert.equal(records[0].event, 'resume.validate'); assert.equal(records[0].level, 'INFO');
  const rejected = records.find(record => record.outcome === 'rejected');
  assert.equal(rejected.level, 'ERROR'); assert.equal(rejected.reason, 'checkpoint_artifact_expired');
  assert.equal(rejected.artifact_id, 41); assert.equal(rejected.task_id, 'fixture-task'); assert.ok(rejected.corrective_action.includes('unexpired'));
  process.stdout.write(records.map(record => json(record)).join('\n') + '\n');
});

test('a real version-1 artifact reports its schema compatibility failure at normal Actions verbosity', async t => {
  const f = await fixture(t), archive = join(f.temporary, 'version-one.zip'), bin = join(f.job.root, 'api-bin');
  const bytes = await zipEntries(f, 'version-one-source', [{ name: 'manifest.json', text: json({ schema_version: 1 }) }]);
  await writeFile(archive, bytes); await mkdir(bin);
  await writeFile(join(bin, 'gh'), `#!/usr/bin/env node\nprocess.stdout.write(require('node:fs').readFileSync(${json(archive)}));\n`, { mode: 0o700 });
  f.job.env.PATH = `${bin}:${f.job.env.PATH}`;
  const metadata = { id: 41, expired: false, expires_at: new Date(Date.now() + 86400000).toISOString(), size_in_bytes: bytes.length };
  const entry = join(f.temporary, 'schema-diagnostic.mjs');
  await writeFile(entry, `import {loadCheckpoint} from ${json(join(root, '.build/resume.js'))};
import {Diagnostics} from ${json(join(root, '.build/diagnostics.js'))};
try{await loadCheckpoint(${json(f.job)},async()=>(${json(metadata)}),'fixture/repo',41,new Diagnostics({task_id:'fixture-task',run_id:'13',run_attempt:'1'}))}catch(error){if(error.reason!=='unsupported_checkpoint_schema')throw error}
`);
  const output = (await exec(process.execPath, [entry])).stdout;
  const line = output.split('\n').find(line => line.includes('"outcome":"rejected"'));
  const record = JSON.parse(line.slice(line.indexOf('{')));
  assert.equal(record.event, 'resume.validate'); assert.equal(record.level, 'ERROR'); assert.equal(record.reason, 'unsupported_checkpoint_schema');
  assert.equal(record.expected, 2); assert.equal(record.observed, 1); assert.equal(record.artifact_id, 41);
  process.stdout.write(json(record) + '\n');
});

test('real cold resume carries worker, auditor and review allowance through interrupted observation and pre-setup recovery', async t => {
  const f = await fixture(t), r = await repository(f), source = await portableSource(f);
  await r.git('branch', '-m', branch); r.branch = branch;
  await installSkillSource(f.job, executionSource, source, 0, f.log);
  const plan = 'Implement the cold-resume-marker-9153 fixture and preserve its verified history.';
  const validation = { ...policy, local_checks: ['node --check greeting.js'] };
  const audit = { verdict: 'conformant', findings: [], summary: 'Fixture conformance', auditor: { session: 'not exposed by CLI', model: 'not exposed by CLI' }, base_sha: r.base, audited_state: 'Whole fixture worktree' };
  const api = await provider(t, [
    [tool("printf '%s\\n' 'console.log(42);' > greeting.js")],
    [message(turn('audit', { validation_policy: validation }))], [message(audit)],
    [message(turn('accomplishment', { paths: ['greeting.js'], commit_message: 'Save cold resume fixture', validation_policy: validation, pr_url: `https://github.com/${repo}/pull/9` }))], { hang: true },
  ]);
  await configure(f.job, api.config, f.log);
  const git = new TaskGit(r.cwd, f.job.env, f.log, branch);
  let saved, artifactId = 40;
  const driver = { job: f.job, git, log: f.log, plan, planSource: 'inline', authorization: { repository: repo, plan_sha256: hash(plan), request: 'Implement with audited checkpoint publication and bounded continuation.' },
    repository: repo, taskId, base: r.base, budgetMs: 240000, started: Date.now(), skills: [executionSource], lineage, execution: execution(),
    checkpoint: input => durableCheckpoint(f.job, input, f.log, sha => git.verify(sha), async (name, files, directory) => {
      const id = ++artifactId;
      saved = { artifact_id: id, manifest: JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')), checkpointZip: await zipDirectory(f, 'cold-checkpoint', directory) };
      if (input.progress.kind === 'review_observation') driver.started = Date.now() - driver.budgetMs + 121000;
      return { id };
    }), complete: async () => { throw new Error('Fixture cannot claim PR completion'); } };
  const result = await drive(driver);
  assert.equal(result.status, 'continuing'); assert.ok(saved.manifest.driver.auditor_session);
  assert.ok(saved.manifest.driver.review_budget.active_since > 0);
  assert.equal(saved.manifest.driver.review_budget.remaining_ms, 5400000);
  const auditSource = { base_sha: r.base, checkpoint_sha: saved.manifest.checkpoint_sha, sessions: saved.manifest.sessions, session_identifiers: saved.manifest.session_identifiers };
  assert.equal(savedAuditAuthority(saved.manifest.audit, saved.manifest.driver, auditSource, saved.manifest.source_state_hash), true);
  for (const corrupt of [
    value => { value.audit.base_sha = 'c'.repeat(40); },
    value => { value.audit.auditor.session = randomUUID(); },
    value => { value.audit.validation[0].command = 'true'; },
    value => { value.audit.validation_assignments = { ...validation, checks: ['Other CI'] }; },
    value => { value.driver.audit_rounds.at(-1).receipt.base_sha = 'd'.repeat(40); },
  ]) {
    const changed = structuredClone(saved.manifest); corrupt(changed);
    assert.equal(savedAuditAuthority(changed.audit, changed.driver, auditSource, changed.source_state_hash), false);
  }
  const cold = await protocolFixture(t, saved);
  cold.model.endedAt = new Date().toISOString();
  cold.env.CONTINUATION_MODE = 'prepare';
  const prepared = await runController(cold);
  const firstClaim = JSON.parse(await readFile(prepared.claim_path, 'utf8'));
  const expected = 5400000 - (Date.parse(cold.model.endedAt) - saved.manifest.driver.review_budget.active_since);
  assert.equal(firstClaim.review_budget.remaining_ms, expected); assert.equal(firstClaim.review_budget.active_since, null);
  assert.ok(expected < 5400000 && expected > 0);
  cold.addArtifact(50, prepared.claim_name, await zipDirectory(cold, 'first-claim', join(prepared.claim_path, '..')), 99);
  cold.env.CONTINUATION_MODE = 'dispatch'; cold.env.CLAIM_ARTIFACT_ID = '50'; cold.env.NEW_CLAIM = 'true';
  await runController({ ...cold, sleep: async () => {} });
  const interrupted = cold.model.children[0]; interrupted.status = 'completed'; interrupted.conclusion = 'timed_out';
  cold.model.jobs.set(interrupted.id, [{ id: 71, name: 'resolve', status: 'completed', completed_at: new Date().toISOString() }]);
  const nextController = { ...cold.model.controller, id: 101 }; cold.model.runs.set(101, nextController);
  const nextEnv = { ...cold.env, GITHUB_RUN_ID: '101', CONTINUATION_MODE: 'prepare' };
  const nextContext = { ...cold.context, payload: { workflow_run: { ...interrupted } } };
  const recovered = await runController({ ...cold, env: nextEnv, context: nextContext });
  const nextClaim = JSON.parse(await readFile(recovered.claim_path, 'utf8'));
  assert.equal(nextClaim.continuation_count, 2); assert.equal(nextClaim.artifact_id, saved.artifact_id);
  assert.equal(nextClaim.review_budget.remaining_ms, expected); assert.equal(nextClaim.parent_job_name, 'resolve');
  cold.addArtifact(60, recovered.claim_name, await zipDirectory(cold, 'second-claim', join(recovered.claim_path, '..')), 101);
  await runController({ ...cold, env: { ...nextEnv, CONTINUATION_MODE: 'dispatch', CLAIM_ARTIFACT_ID: '60', NEW_CLAIM: 'true' }, context: nextContext, sleep: async () => {} });
  const nextChild = cold.model.children.at(-1);
  const parameters = await prepareTaskRequest({ ...cold,
    env: { ...cold.env, GITHUB_RUN_ID: String(nextChild.id), GITHUB_JOB: 'execute', TASK_REQUEST: json(cold.model.dispatches.at(-1)) },
    context: { ...cold.context, eventName: 'workflow_dispatch' } });
  const carried = JSON.parse(parameters.review_budget);
  assert.equal(carried.remaining_ms, expected); assert.equal(parameters.parent_job_name, 'resolve');
  assert.ok(Date.now() > Date.parse(cold.model.endedAt));
  await removeJob(f.job.root);
  const cwd = join(cold.temporary, 'relocated project');
  await exec('git', ['clone', '--branch', 'main', r.remote, cwd], { env: cold.job.env });
  const freshGit = new TaskGit(cwd, cold.job.env, cold.log, branch);
  const zipBin = join(cold.job.root, 'zip-bin'); await mkdir(zipBin);
  const archive = join(cold.temporary, 'download.zip'); await writeFile(archive, saved.checkpointZip);
  const requestArchive = join(cold.temporary, 'request-download.zip'); await writeFile(requestArchive, cold.model.payloads.get(40));
  await writeFile(join(zipBin, 'gh'), `#!/usr/bin/env node\nconst fs=require('node:fs');const endpoint=process.argv[3];if(endpoint.endsWith('/${saved.artifact_id}/zip'))process.stdout.write(fs.readFileSync(${json(archive)}));else if(endpoint.endsWith('/40/zip'))process.stdout.write(fs.readFileSync(${json(requestArchive)}));else process.exit(1);\n`, { mode: 0o700 });
  cold.job.env.PATH = `${zipBin}:${cold.job.env.PATH}`;
  cold.job.env.CODEX_API_KEY = 'fresh-model-credential-9153'; cold.job.env.OPENAI_API_KEY = cold.job.env.CODEX_API_KEY;
  cold.log.protect(cold.job.env.CODEX_API_KEY);
  const freshProvider = await provider(t, (body, ordinal, headers) => {
    assert.equal(headers.authorization, 'Bearer fresh-model-credential-9153');
    if (ordinal === 1) return [tool("pwd > cold-cwd.txt; printf '%s\\n' 'console.log(43);' > followup.js")];
    if (ordinal === 2) return [message(turn('accomplishment', { paths: ['cold-cwd.txt', 'followup.js'], commit_message: 'Save resumed progress', validation_policy: validation }))];
    return [message(turn('blocked', { validation_policy: validation }))];
  });
  await configure(cold.job, freshProvider.config, cold.log);
  await installSkillSource(cold.job, executionSource, source, 0, cold.log);
  const loaded = await loadCheckpoint(cold.job, endpoint => cold.api('/' + endpoint), repo, saved.artifact_id, cold.log, taskId);
  await restoreCheckpoint(cold.job, loaded.root, loaded.manifest, freshGit, cold.log);
  assert.equal(await freshGit.head(), saved.manifest.checkpoint_sha); assert.equal(await freshGit.remoteHead(), saved.manifest.checkpoint_sha);
  const db = new DatabaseSync(join(cold.job.codexHome, 'state_5.sqlite'), { readOnly: true });
  try {
    const rows = db.prepare('SELECT id,rollout_path,cwd FROM threads').all();
    assert.ok(rows.some(row => row.id === result.session && row.cwd === cwd));
    assert.ok(rows.every(row => row.rollout_path.startsWith(cold.job.codexHome + '/')));
  } finally { db.close(); }
  loaded.manifest.driver.review_budget = carried;
  const snapshots = [];
  let resumedArtifact = 80;
  const resumed = await drive({ job: cold.job, git: freshGit, log: cold.log, plan, planSource: 'inline', authorization: loaded.manifest.authorization,
    repository: repo, taskId, base: r.base, budgetMs: 240000, started: Date.now(), skills: loaded.manifest.skills,
    lineage: { ...lineage, run_id: String(nextChild.id), actor: 'github-actions[bot]', triggering_actor: 'github-actions[bot]' }, execution: JSON.parse(parameters.execution),
    resume: { state: loaded.manifest.driver, checkpoint: loaded.receipt, audit: loaded.manifest.audit, sessions: loaded.manifest.sessions, sessionIdentifiers: loaded.manifest.session_identifiers },
    checkpoint: input => durableCheckpoint(cold.job, input, cold.log, sha => freshGit.verify(sha), async (name, files, directory) => {
      snapshots.push(JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'))); return { id: ++resumedArtifact };
    }), complete: async () => { throw new Error('No completion'); } });
  assert.equal(resumed.status, 'blocked'); assert.equal(resumed.session, result.session);
  assert.equal(snapshots[0].driver.review_budget.remaining_ms, expected);
  const changedHead = snapshots.find(snapshot => snapshot.checkpoint_sha !== saved.manifest.checkpoint_sha);
  assert.ok(changedHead); assert.equal(changedHead.driver.review_budget.remaining_ms, 5400000);
  assert.equal(changedHead.driver.review_budget.head_sha, changedHead.checkpoint_sha);
  assert.equal(await freshGit.head(), changedHead.checkpoint_sha); assert.equal(await freshGit.remoteHead(), changedHead.checkpoint_sha);
  assert.match(json(freshProvider.requests), /cold-resume-marker-9153/); assert.match(json(freshProvider.requests), /relocated project/);
  assert.equal((await readFile(join(cwd, 'cold-cwd.txt'), 'utf8')).trim(), cwd);
  await assert.rejects(readFile(join(r.cwd, 'cold-cwd.txt')), { code: 'ENOENT' });
  assert.equal(JSON.parse(await readFile(join(cold.job.root, 'audit-history.json'), 'utf8')).length, saved.manifest.driver.audit_rounds.length);
  const exhausted = structuredClone(saved.manifest); exhausted.driver.review_budget.remaining_ms = 1;
  const depleted = await protocolFixture(t, { artifact_id: saved.artifact_id, manifest: exhausted, checkpointZip: await replaceManifest(cold, 'exhausted', saved.checkpointZip, exhausted) });
  depleted.model.endedAt = cold.model.endedAt;
  assert.equal((await runController(depleted)).eligible, false); assert.equal(depleted.records.at(-1).reason, 'review_observation_budget');
});

test('cold resume preserves a nonconformant auditor, finding history and consumed reconsideration', async t => {
  const f = await fixture(t), r = await repository(f), source = await portableSource(f);
  await r.git('branch', '-m', branch); r.branch = branch;
  await installSkillSource(f.job, executionSource, source, 0, f.log);
  const plan = 'Preserve nonconformant-audit-history-7193 and its consumed reconsideration.';
  const validation = { ...policy, local_checks: ['node -e \'throw Error("Nonconformant checks must not run")\''] };
  const verdict = { verdict: 'nonconformant', findings: [{ plan_item: 'Fixture criterion', category: 'missing_behavior', evidence: 'greeting.js:1',
    gap: 'Pending fixture correction', required_outcome: 'Finish the fixture', guidance: 'Inspect the fixture' }], summary: 'Independent fixture finding',
    auditor: { session: 'not exposed by CLI', model: 'not exposed by CLI' }, base_sha: r.base, audited_state: 'Complete fixture source' };
  const api = await provider(t, [[tool("printf '%s\\n' 'console.log(42);' > greeting.js")],
    [message(turn('audit', { validation_policy: validation }))], [message(verdict)],
    [message(turn('audit', { validation_policy: validation, summary: 'Reconsider the fixture finding against its source.' }))], [message(verdict)],
    [message(turn('accomplishment', { paths: ['greeting.js'], commit_message: 'Save audited fixture', validation_policy: validation }))],
    [message(turn('blocked', { validation_policy: validation }))]]);
  await configure(f.job, api.config, f.log);
  const git = new TaskGit(r.cwd, f.job.env, f.log, branch);
  let saved;
  const initial = await drive({ job: f.job, git, log: f.log, plan, planSource: 'inline',
    authorization: { repository: repo, plan_sha256: hash(plan), request: 'Implement with preserved independent audit coordination.' },
    repository: repo, taskId, base: r.base, budgetMs: 240000, started: Date.now(), skills: [executionSource], lineage, execution: execution(),
    checkpoint: input => durableCheckpoint(f.job, input, f.log, sha => git.verify(sha), async (name, files, directory) => {
      saved = { manifest: JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')), bytes: await zipDirectory(f, 'audit-history', directory) };
      return { id: 41 };
    }), complete: async () => { throw Error('Nonconformant source cannot complete'); } });
  assert.equal(initial.status, 'blocked'); assert.equal(saved.manifest.driver.audit_rounds.length, 2);
  assert.equal(saved.manifest.driver.reconsidered.length, 1);
  const auditSource = { base_sha: r.base, sessions: saved.manifest.sessions, session_identifiers: saved.manifest.session_identifiers };
  assert.equal(savedAuditHistory(saved.manifest.driver, auditSource), true);
  assert.equal(savedAuditAuthority(saved.manifest.audit, saved.manifest.driver, auditSource, saved.manifest.source_state_hash), false);
  const corrupt = structuredClone(saved.manifest.driver); corrupt.audit_rounds[0].receipt.base_sha = 'c'.repeat(40);
  assert.equal(savedAuditHistory(corrupt, auditSource), false);
  await removeJob(f.job.root);
  const cold = await fixture(t), cwd = join(cold.temporary, 'relocated audit project'), archive = join(cold.temporary, 'checkpoint.zip');
  await exec('git', ['clone', '--branch', 'main', r.remote, cwd], { env: cold.job.env });
  await writeFile(archive, saved.bytes);
  const snapshot = join(cold.temporary, 'snapshot'); await unpackArchive(cold.job, archive, snapshot, 'checkpoint', cold.log);
  const freshGit = new TaskGit(cwd, cold.job.env, cold.log, branch);
  await restoreCheckpoint(cold.job, snapshot, saved.manifest, freshGit, cold.log);
  await installSkillSource(cold.job, executionSource, source, 0, cold.log);
  const resumedApi = await provider(t, [[tool("printf '%s\\n' 'console.log(43);' >> greeting.js")],
    [message(turn('audit', { validation_policy: validation }))], [message(verdict)], [message(turn('audit', { validation_policy: validation }))]]);
  await configure(cold.job, resumedApi.config, cold.log);
  const resumed = await drive({ job: cold.job, git: freshGit, log: cold.log, plan, planSource: 'inline', authorization: saved.manifest.authorization,
    repository: repo, taskId, base: r.base, budgetMs: 240000, started: Date.now(), skills: [executionSource],
    lineage: { ...lineage, run_id: '100' }, execution: execution({ continuation_count: 1, parent_run_id: '13', parent_run_attempt: '1' }),
    resume: { state: saved.manifest.driver, checkpoint: { artifact_id: 41, checkpoint_sha: saved.manifest.checkpoint_sha, sequence: 1 },
      audit: saved.manifest.audit, sessions: saved.manifest.sessions, sessionIdentifiers: saved.manifest.session_identifiers },
    checkpoint: async () => { throw Error('Unpublished correction cannot be checkpointed'); },
    complete: async () => { throw Error('Nonconformant source cannot complete'); } });
  assert.equal(resumed.session, initial.session); assert.equal(resumed.status, 'failed'); assert.equal(resumed.reason, 'audit_dispute_unresolved');
  const history = JSON.parse(await readFile(join(cold.job.root, 'audit-history.json'), 'utf8'));
  assert.equal(history.length, 3); assert.equal(history[2].receipt.auditor_session, saved.manifest.driver.auditor_session);
  assert.deepEqual(history.slice(0, 2), saved.manifest.driver.audit_rounds.slice(0, 2));
  assert.equal(cold.records.find(record => record.coordination_history === 'restored').reconsiderations_consumed, 1);
  assert.match(json(resumedApi.requests), /nonconformant-audit-history-7193/);
  assert.match(json(resumedApi.requests[2]), /Reconsider the fixture finding against its source/);
});

test('a real failed required check leaves a durable veto when interrupted during its repair turn', async t => {
  const f = await fixture(t), r = await repository(f), source = await portableSource(f);
  await r.git('branch', '-m', branch); r.branch = branch;
  await installSkillSource(f.job, executionSource, source, 0, f.log);
  const plan = 'Exercise a failed check followed by an interrupted repair.';
  const validation = { ...policy, local_checks: ['node -e \'require("node:fs").writeFileSync("check-attempted","yes");process.exit(2)\''] };
  const verdict = { verdict: 'conformant', findings: [], summary: 'Fixture audit', auditor: { session: 'not exposed by CLI', model: 'not exposed by CLI' }, base_sha: r.base, audited_state: 'Complete fixture' };
  const api = await provider(t, [[tool("printf '%s\\n' 'console.log(42);' > greeting.js")],
    [message(turn('accomplishment', { paths: ['greeting.js'], commit_message: 'Save pre-check state', validation_policy: validation }))],
    [message(turn('audit', { validation_policy: validation }))], [message(verdict)], { hang: true }]);
  await configure(f.job, api.config, f.log);
  const git = new TaskGit(r.cwd, f.job.env, f.log, branch), markers = [];
  let saved;
  const driver = { job: f.job, git, log: f.log, plan, planSource: 'inline', authorization: { repository: repo, plan_sha256: hash(plan), request: 'Implement with bounded continuation and required checks.' },
    repository: repo, taskId, base: r.base, budgetMs: 240000, started: Date.now(), skills: [executionSource], lineage, execution: execution(),
    checkpoint: input => durableCheckpoint(f.job, input, f.log, sha => git.verify(sha), async (name, files, directory) => {
      saved = { manifest: JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')), checkpointZip: await zipDirectory(f, 'failed-check-checkpoint', directory) }; return { id: 41 };
    }), validation: async (round, phase, stateHash) => {
      markers.push({ round, phase, audit_state_hash: stateHash });
      if (phase === 'failed') driver.started = Date.now() - driver.budgetMs + 121000;
    }, complete: async () => { throw Error('No completion'); } };
  const result = await drive(driver);
  assert.equal(result.status, 'blocked'); assert.equal(result.reason, 'validation_failed');
  assert.equal(await readFile(join(r.cwd, 'check-attempted'), 'utf8'), 'yes');
  assert.deepEqual(markers.map(marker => marker.phase), ['started', 'failed']);
  const recovery = await protocolFixture(t, saved);
  for (const [index, marker] of markers.entries()) {
    const record = { ...recovery.model.request, ...marker };
    recovery.addArtifact(70 + index, recordName(`validation-${marker.round}-${marker.phase}`, taskId, '13', '1'),
      await zipEntries(recovery, `validation-${index}`, [{ name: 'record.json', text: json(record) }]));
  }
  assert.equal((await runController(recovery)).eligible, false);
  assert.equal(recovery.records.at(-1).reason, 'required_validation_failed'); assert.equal(recovery.model.dispatches.length, 0);
});

test('manual resume preserves consumed native runs when the selected checkpoint was inherited', async t => {
  const f = await protocolFixture(t); f.env.CONTINUATION_MODE = 'prepare';
  const prepared = await runController(f);
  f.addArtifact(50, prepared.claim_name, await zipDirectory(f, 'manual-count-claim', join(prepared.claim_path, '..')), 99);
  f.env.CONTINUATION_MODE = 'dispatch'; f.env.CLAIM_ARTIFACT_ID = '50'; f.env.NEW_CLAIM = 'true';
  await runController({ ...f, sleep: async () => {} });
  f.model.children[0].status = 'completed'; f.model.children[0].conclusion = 'failure';
  const parameters = await prepareTaskRequest({ ...f,
    env: { ...f.env, GITHUB_RUN_ID: '200', GITHUB_JOB: 'manual-execute', TRIGGERING_ACTOR: 'Z-M-Huang',
      TASK_REQUEST: json({ task_id: taskId, source_sha: sourceSha, resume_artifact_id: 41 }) },
    context: { ...f.context, actor: 'Z-M-Huang', eventName: 'workflow_dispatch' } });
  assert.equal(JSON.parse(parameters.execution).continuation_count, 2);
  assert.equal(JSON.parse(parameters.execution).max_continuations, 3);
  assert.equal(parameters.authorization, json(f.model.manifest.authorization));
});

test('a manual resume interrupted before its first record recovers from its native immutable artifact reference', async t => {
  const f = await protocolFixture(t);
  const manual = { ...f.model.parent, id: 200, display_title: manualRunName(taskId, 41, sourceSha) };
  f.model.runs.set(200, manual); f.model.children.push(manual);
  f.model.jobs.set(200, [{ id: 75, name: 'resolve', status: 'completed', completed_at: new Date().toISOString() }]);
  const recovered = await runController({ ...f, env: { ...f.env, GITHUB_RUN_ID: '201', CONTINUATION_MODE: 'prepare' },
    context: { ...f.context, payload: { workflow_run: { ...manual } } } });
  const claim = JSON.parse(await readFile(recovered.claim_path, 'utf8'));
  assert.equal(claim.artifact_id, 41); assert.equal(claim.continuation_count, 2); assert.equal(claim.parent_job_name, 'resolve');
  assert.equal(f.model.dispatches.length, 0);
});

test('review observations never checkpoint history that refers to unpublished fixes', async t => {
  const f = await fixture(t), r = await repository(f), source = await portableSource(f);
  await r.git('branch', '-m', branch); r.branch = branch;
  await installSkillSource(f.job, executionSource, source, 0, f.log);
  const validation = { ...policy, local_checks: [] };
  const verdict = { verdict: 'nonconformant', findings: [{ plan_item: 'Fixture criterion', category: 'missing_behavior', evidence: 'greeting.js:1',
    gap: 'Pending fixture fix', required_outcome: 'Finish the fixture', guidance: 'Inspect the fixture' }], summary: 'Fixture finding',
    auditor: { session: 'not exposed by CLI', model: 'not exposed by CLI' }, base_sha: r.base, audited_state: 'Complete fixture source' };
  const api = await provider(t, [[tool("printf '%s\\n' 'console.log(42);' > greeting.js")],
    [message(turn('accomplishment', { paths: ['greeting.js'], commit_message: 'Save fixture', validation_policy: validation, pr_url: `https://github.com/${repo}/pull/9` }))],
    [tool("printf '%s\\n' 'console.log(43);' >> greeting.js")], [message(turn('audit', { validation_policy: validation }))],
    [message(verdict)], [message(turn('blocked', { validation_policy: validation }))]]);
  await configure(f.job, api.config, f.log);
  const git = new TaskGit(r.cwd, f.job.env, f.log, branch), plan = 'Preserve only published fixture progress.';
  let uploads = 0;
  const result = await drive({ job: f.job, git, log: f.log, plan, planSource: 'inline', authorization: { repository: repo, plan_sha256: hash(plan), request: 'Implement the fixture with audited checkpoint publication.' },
    repository: repo, taskId, base: r.base, budgetMs: 240000, started: Date.now(), skills: [executionSource], lineage, execution: execution(),
    checkpoint: async input => {
      assert.deepEqual(await git.changedPaths(), []);
      return durableCheckpoint(f.job, input, f.log, sha => git.verify(sha), async () => ({ id: ++uploads }));
    }, complete: async () => { throw Error('No completion'); } });
  assert.equal(result.status, 'blocked'); assert.equal(uploads, 2);
  assert.deepEqual(await git.changedPaths(), ['greeting.js']);
  assert.equal(await git.remoteHead(), result.checkpoint.checkpoint_sha);
});
