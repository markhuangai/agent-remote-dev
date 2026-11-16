import { createHash } from 'node:crypto';

export const checkpointSchema = 3;
export const runnerVersions = { codex: '0.169.0', skills_cli: '1.8.1', artifact_sdk: '6.3.1' };
export const checkpointBytes = 256 * 1024 * 1024;
export const instructionBytes = 64 * 1024;
export const taskPattern = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const shaPattern = /^[a-f0-9]{40}$/;
export const hashPattern = /^[a-f0-9]{64}$/;
export const repositoryPattern = /^[\w.-]+\/[\w.-]+$/;
export const positiveId = value => /^[1-9][0-9]*$/.test(String(value)) && Number.isSafeInteger(Number(value));
export const digest = value => createHash('sha256').update(value).digest('hex');
export function registrationKey(request) {
  const { registration_key, ...frozen } = request;
  return digest(JSON.stringify(frozen));
}
export const databases = ['state_5.sqlite', 'thread_history_1.sqlite', 'goals_1.sqlite', 'queue_1.sqlite', 'memories_1.sqlite', 'memories_v2_1.sqlite'];
export const protocolContract = { protocol_version: 3, checkpoint_schema: 3, request_input: 'request', task_workflow: 'runner-task.yml', controller_workflow: 'runner-continuation.yml', published_workflow: 'runner-published.yml' };
export const protocolFiles = ['.github/workflows/runner-task.yml', '.github/workflows/runner-continuation.yml', '.github/workflows/runner-published.yml',
  ...['checkpoint-policy.mjs', 'continuation-policy.mjs', 'artifact-io.mjs', 'protocol-policy.mjs', 'runtime-log.mjs', 'instructions.mjs', 'archive.py',
    'project-config.mjs', 'sources.mjs', 'yaml.cjs', 'yaml-licenses.txt'].map(name => `.github/remote-codex/${name}`)];
export const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const identity = value => value === null || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value) ? value :
  typeof value === 'string' && value.length <= 200 && /^(?:[a-f0-9]{40,64}|[a-z0-9_-]+|[\w.-]+\/[\w.-]+|\d+(?:\.\d+){1,3})$/.test(value) ? value : `[invalid ${typeof value}]`;
export function invariant(condition, reason, expected, observed) {
  if (condition) return;
  const error = new Error(reason);
  error.reason = reason;
  error.details = expected === undefined && observed === undefined ? {} : { expected: identity(expected), observed: identity(observed) };
  throw error;
}
export function sources(value) {
  invariant(Array.isArray(value) && value.length <= 20, 'invalid_skill_sources');
  const names = new Set();
  for (const source of value) {
    invariant(object(source) && Object.keys(source).sort().join() === 'names,repository,revision' && repositoryPattern.test(source.repository) && shaPattern.test(source.revision) &&
      Array.isArray(source.names) && source.names.length > 0 && source.names.length <= 100, 'invalid_skill_source');
    for (const name of source.names) {
      invariant(typeof name === 'string' && /^[a-z0-9][a-z0-9_-]{0,99}$/.test(name) && !names.has(name), 'duplicate_or_invalid_skill_name');
      names.add(name);
    }
  }
  return value;
}
export function runnerLabels(value = ['ubuntu-latest']) {
  invariant(Array.isArray(value) && value.length > 0 && value.length <= 10 && new Set(value).size === value.length &&
    value.every(label => typeof label === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(label)), 'invalid_runner_labels');
  invariant(same(value, ['ubuntu-latest']) || same(value, ['ubuntu-24.04-arm']) || value.includes('self-hosted') && value.some(label => label.toLowerCase() === 'linux') &&
    !value.some(label => ['windows', 'macos'].includes(label.toLowerCase())), 'unsupported_runner');
  return value;
}
export function instructionURL(value) {
  let url;
  try { url = new URL(value); } catch { invariant(false, 'invalid_user_agents_url'); }
  invariant(url.protocol === 'https:' && !url.username && !url.password && !url.hash && url.hostname && value.length <= 2048, 'invalid_user_agents_url');
  return value;
}
export function instructions(value) {
  if (value === null) return null;
  invariant(object(value) && Object.keys(value).sort().join() === 'content,sha256,url', 'invalid_user_agents');
  instructionURL(value.url);
  invariant(hashPattern.test(value.sha256) && typeof value.content === 'string' && value.content.trim() && Buffer.byteLength(value.content) <= instructionBytes &&
    !value.content.includes('\0') && digest(value.content) === value.sha256, 'user_agents_hash_mismatch', value.sha256, typeof value.content === 'string' ? digest(value.content) : null);
  return value;
}
export function authorization(value, repository, plan) {
  invariant(object(value) && Object.keys(value).sort().join() === 'plan_sha256,repository,request' && value.repository === repository &&
    value.plan_sha256 === digest(plan) && typeof value.request === 'string' && value.request.trim(), 'authorization_mismatch', digest(plan), value?.plan_sha256);
  return value;
}
export function executionSettings(value) {
  invariant(object(value) && repositoryPattern.test(value.source_repository) && shaPattern.test(value.source_sha), 'invalid_action_source');
  runnerLabels(value.runner);
  invariant(typeof value.auto_continue === 'boolean' && Number.isSafeInteger(value.max_continuations) && value.max_continuations >= 0 && value.max_continuations <= 100, 'invalid_continuation_limit');
  invariant(Number.isSafeInteger(value.continuation_count) && value.continuation_count >= 0 && value.continuation_count <= value.max_continuations, 'continuation_limit_exceeded', value.max_continuations, value.continuation_count);
  invariant(Number.isFinite(value.budget_minutes) && value.budget_minutes >= 3 && value.budget_minutes <= 300, 'invalid_budget');
  invariant(positiveId(value.root_run_id) && positiveId(value.root_run_attempt) && positiveId(value.activation_run_id) && positiveId(value.activation_run_attempt), 'invalid_root_lineage');
  invariant(value.continuation_count === 0 && value.parent_run_id === null && value.parent_run_attempt === null || positiveId(value.parent_run_id) && positiveId(value.parent_run_attempt), 'invalid_parent_lineage');
  invariant(typeof value.git_author_name === 'string' && value.git_author_name.trim() && typeof value.git_author_email === 'string' && value.git_author_email.trim() &&
    !/[\r\n\0]/.test(value.git_author_name + value.git_author_email), 'invalid_git_identity');
  invariant(value.user_agents_url === null && value.user_agents_sha256 === null || typeof value.user_agents_url === 'string' && hashPattern.test(value.user_agents_sha256), 'invalid_user_agents_reference');
  if (value.user_agents_url !== null) instructionURL(value.user_agents_url);
  invariant(object(value.project_config) && shaPattern.test(value.project_config.revision) &&
    typeof value.project_config.content === 'string' && Buffer.byteLength(value.project_config.content) <= 65536 &&
    digest(value.project_config.content) === value.project_config.sha256, 'project_config_hash_mismatch');
  invariant(typeof value.request_id === 'string' && taskPattern.test(value.request_id), 'invalid_request_identity');
  invariant(value.published_ref === null || ['v1', 'v1-prerelease'].includes(value.published_ref) && value.auto_continue === false, 'invalid_published_reference');
  return value;
}
export function validBranch(value) {
  return value === null || typeof value === 'string' && value.length > 0 && value.length <= 255 && value !== '@' &&
    !/[\x00-\x20\x7f~^:?*\[\\]/.test(value) && !value.includes('..') && !value.includes('@{') &&
    value.split('/').every(part => part && !part.startsWith('.') && !part.endsWith('.') && !part.endsWith('.lock')) && !value.startsWith('-');
}
export function validateManifest(value, { repository, versions = runnerVersions, taskId } = {}) {
  invariant(object(value) && value.schema_version === checkpointSchema, 'unsupported_checkpoint_schema', checkpointSchema, value?.schema_version ?? null);
  invariant(value.repository === repository, 'checkpoint_repository_mismatch', repository, value.repository);
  invariant(typeof value.task_id === 'string' && taskPattern.test(value.task_id) && (!taskId || value.task_id === taskId), 'checkpoint_task_mismatch', taskId, value.task_id);
  invariant(validBranch(value.branch) && shaPattern.test(value.base_sha) && shaPattern.test(value.checkpoint_sha), 'invalid_checkpoint_git_identity');
  invariant(typeof value.plan === 'string' && Buffer.byteLength(value.plan) <= 1024 * 1024 && digest(value.plan) === value.plan_sha256, 'checkpoint_plan_hash_mismatch');
  authorization(value.authorization, repository, value.plan);
  invariant(value.permission_mode === 'full-access', 'checkpoint_execution_mode_mismatch');
  invariant(object(value.versions) && Object.keys(value.versions).sort().join() === Object.keys(versions).sort().join() && Object.entries(versions).every(([key, version]) => value.versions[key] === version), 'checkpoint_version_mismatch');
  invariant(value.plan_source === 'inline' || typeof value.plan_source === 'string' && value.plan_source.startsWith(`https://github.com/${repository}/issues/`) && positiveId(value.plan_source.split('/').at(-1)), 'invalid_checkpoint_plan_source');
  sources(value.skills);
  executionSettings(value.execution);
  const user = instructions(value.user_agents);
  invariant((user?.url ?? null) === value.execution.user_agents_url && (user?.sha256 ?? null) === value.execution.user_agents_sha256, 'checkpoint_user_agents_mismatch');
  invariant(typeof value.session_id === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value.session_id), 'invalid_session_identity');
  invariant(Array.isArray(value.sessions) && value.sessions.includes(value.session_id) && new Set(value.sessions).size === value.sessions.length && Array.isArray(value.session_identifiers) &&
    value.sessions.every(id => typeof id === 'string' && value.session_identifiers.some(entry => entry.thread_id === id && typeof entry.session_id === 'string')), 'checkpoint_session_mismatch');
  invariant(Number.isSafeInteger(value.sequence) && value.sequence > 0 && Array.isArray(value.files) && value.files.length <= 10000 && object(value.limits) && value.limits.max_bytes > 0 && value.limits.max_bytes <= checkpointBytes, 'invalid_checkpoint_inventory');
  const paths = new Set();
  let bytes = 0;
  for (const file of value.files) {
    invariant(object(file) && typeof file.path === 'string' && file.path.length <= 512 && !paths.has(file.path) && /^codex\//.test(file.path) && !file.path.includes('\\') &&
      !file.path.split('/').some(part => !part || part === '.' || part === '..') && (/^codex\/(?:sessions|archived_sessions)\/.+\.jsonl(?:\.zst)?$/.test(file.path) || databases.some(name => file.path === `codex/${name}`)), 'unsafe_checkpoint_path');
    invariant(hashPattern.test(file.sha256) && Number.isSafeInteger(file.bytes) && file.bytes >= 0, 'invalid_checkpoint_file');
    paths.add(file.path); bytes += file.bytes;
  }
  invariant(bytes + Buffer.byteLength(JSON.stringify(value)) <= value.limits.max_bytes, 'checkpoint_size_limit');
  invariant(object(value.lineage) && positiveId(value.lineage.run_id) && positiveId(value.lineage.run_attempt) && shaPattern.test(value.lineage.workflow_sha) && value.lineage.repository === repository &&
    typeof value.lineage.workflow_ref === 'string' && value.lineage.workflow_ref.startsWith(`${repository}/.github/workflows/`) &&
    /^[A-Za-z0-9_.-]+\.ya?ml@refs\/heads\/main$/.test(value.lineage.workflow_ref.slice(`${repository}/.github/workflows/`.length)), 'untrusted_checkpoint_producer');
  invariant(typeof value.workspace === 'string' && value.workspace.startsWith('/') && typeof value.codex_home === 'string' && value.codex_home.startsWith('/'), 'invalid_checkpoint_locations');
  return value;
}
export function checkpointName(manifest) { return `codex-${manifest.task_id}-${manifest.sequence}-r${manifest.lineage.run_id}-a${manifest.lineage.run_attempt}`; }
export function recordName(kind, taskId, runId, attempt) { return `codex-${kind}-${taskId}-r${runId}-a${attempt}`; }
export function validateProducer(artifact, run, manifest, repository) {
  invariant(object(artifact) && positiveId(artifact.id) && !artifact.expired && Date.parse(artifact.expires_at) > Date.now(), 'checkpoint_artifact_expired');
  invariant(artifact.size_in_bytes > 0 && artifact.size_in_bytes <= checkpointBytes && artifact.name === checkpointName(manifest), 'checkpoint_artifact_identity_mismatch');
  invariant(artifact.workflow_run?.id === run.id && String(run.id) === String(manifest.lineage.run_id) && Number(run.run_attempt) === Number(manifest.lineage.run_attempt) &&
    run.repository?.full_name === repository && run.head_repository?.full_name === repository && run.head_sha === manifest.lineage.workflow_sha && run.event === 'workflow_dispatch' &&
    run.head_branch === 'main' && run.actor?.login === manifest.lineage.actor && run.triggering_actor?.login === manifest.lineage.triggering_actor &&
    manifest.lineage.workflow_ref === `${repository}/${run.path}@refs/heads/main`, 'untrusted_checkpoint_producer');
  return artifact;
}
export function frozenExecution(value) {
  const { continuation_count, parent_run_id, parent_run_attempt, activation_run_id, activation_run_attempt, ...fixed } = value;
  return fixed;
}
export function validateFrozenRoot(manifest, request, root) {
  invariant(request.schema_version === 3 && request.repository === manifest.repository && request.task_id === manifest.task_id && request.plan_sha256 === manifest.plan_sha256 &&
    same(request.authorization, manifest.authorization) && same(request.skills, manifest.skills) && request.plan_source === manifest.plan_source &&
    same(frozenExecution(request.execution), frozenExecution(manifest.execution)) && String(root.id) === manifest.execution.root_run_id && Number(root.run_attempt) === Number(manifest.execution.root_run_attempt) &&
    request.lineage?.workflow_sha === root.head_sha && String(request.lineage?.run_id) === String(root.id) && Number(request.lineage?.run_attempt) === Number(root.run_attempt) &&
    request.lineage?.actor === root.actor?.login && request.lineage?.triggering_actor === root.triggering_actor?.login, 'checkpoint_root_contract_mismatch');
}
