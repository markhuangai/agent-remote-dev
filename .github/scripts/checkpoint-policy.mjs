import { createHash } from 'node:crypto';

export const checkpointSchema = 2;
export const runnerVersions = { codex: '0.169.0', skills_cli: '1.8.1', artifact_sdk: '6.3.1', execution_skills: '224a5be4ddf40c6cf0a50b97885cb353e8522e2e' };
export const checkpointBytes = 256 * 1024 * 1024;
export const taskPattern = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const shaPattern = /^[a-f0-9]{40}$/;
export const positiveId = value => /^[1-9][0-9]*$/.test(String(value)) && Number.isSafeInteger(Number(value));
export const digest = value => createHash('sha256').update(value).digest('hex');
export const databases = ['state_5.sqlite', 'thread_history_1.sqlite', 'goals_1.sqlite', 'queue_1.sqlite', 'memories_1.sqlite', 'memories_v2_1.sqlite'];
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function identity(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.length <= 200 && (/^[a-f0-9]{40,64}$/.test(value) || taskPattern.test(value) || /^[\w.-]+\/[\w.-]+$/.test(value) || /^\d+(?:\.\d+){1,3}(?:-[\w.]+)?$/.test(value))) return value;
  if (isObject(value) && Object.keys(value).every(key => Object.hasOwn(runnerVersions, key))) return Object.fromEntries(Object.keys(runnerVersions).map(key => {
    const version = value[key], valid = typeof version === 'string' && (key === 'execution_skills' ? shaPattern.test(version) : /^\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(version));
    return [key, valid ? version : `[invalid ${typeof version}]`];
  }));
  return `[invalid ${Array.isArray(value) ? 'array' : typeof value}]`;
}
export function invariant(condition, reason, expected = null, observed = null) {
  if (!condition) throw Object.assign(new Error(reason), { reason, details: { expected: identity(expected), observed: identity(observed) } });
}
export const protocolContract = { protocol_version: 2, checkpoint_schema: 2, request_input: 'request', task_workflow: 'runner-task.yml', controller_workflow: 'runner-continuation.yml' };
export const protocolFiles = ['.github/workflows/runner-task.yml', '.github/workflows/runner-continuation.yml', '.github/scripts/continuation-policy.mjs',
  '.github/scripts/checkpoint-policy.mjs', '.github/scripts/artifact-io.mjs', '.github/scripts/protocol-policy.mjs', 'src/archive.py'];
export function validationPolicy(value) {
  return isObject(value) && Object.keys(value).sort().join() === 'checks,local_checks,marked_review_count,reviewers' &&
    [value.checks, value.reviewers, value.local_checks].every(list => Array.isArray(list) && list.every(name => typeof name === 'string' && name.length > 0)) &&
    value.checks.length > 0 && Number.isSafeInteger(value.marked_review_count) && value.marked_review_count >= 0;
}
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
function savedAuditIdentity(receipt, state, source) {
  return isObject(receipt) && receipt.base_sha === source.base_sha && receipt.auditor?.session === receipt.auditor_session &&
    source.sessions.includes(receipt.auditor_session) &&
    source.session_identifiers.some(entry => entry.thread_id === receipt.auditor_session && entry.session_id === receipt.session_id) &&
    typeof receipt.auditor.model === 'string' && receipt.auditor.model.length > 0 && typeof receipt.audited_state === 'string' && receipt.audited_state.trim() &&
    shaPattern.test(receipt.audited_head) && /^[a-f0-9]{64}$/.test(receipt.state_hash) && same(receipt.validation_assignments, state.validation_policy);
}
export function savedAuditHistory(state, source) {
  return validationPolicy(state.validation_policy) && Array.isArray(state.audit_rounds) && state.audit_rounds.length > 0 &&
    state.audit_rounds.at(-1)?.receipt?.auditor_session === state.auditor_session &&
    state.audit_rounds.every((round, index) => savedAuditIdentity(round?.receipt, state, source) && round.receipt.round === index + 1 &&
      ['conformant', 'nonconformant', 'blocked'].includes(round.receipt.verdict) && Array.isArray(round.receipt.findings) && Array.isArray(round.dispositions)) &&
    Array.isArray(state.reconsidered) && state.reconsidered.every(key => typeof key === 'string' && /^[a-f0-9]{64}$/.test(key));
}
export function savedAuditAuthority(audit, state, source, fingerprint) {
  if (!savedAuditHistory(state, source) || !savedAuditIdentity(audit, state, source)) return false;
  const last = state.audit_rounds.at(-1)?.receipt;
  return audit.auditor_session === state.auditor_session && audit.verdict === 'conformant' && last.verdict === 'conformant' &&
    Array.isArray(audit.findings) && audit.findings.length === 0 && Array.isArray(last.findings) && last.findings.length === 0 &&
    audit.round === state.audit_rounds.length && last.round === audit.round && audit.state_hash === fingerprint && last.state_hash === fingerprint &&
    audit.audited_head === last.audited_head && same(audit.rounds, state.audit_rounds) &&
    state.audit_rounds.every(round => Array.isArray(round.dispositions) && round.dispositions.every(finding => finding.disposition !== 'unresolved')) &&
    Array.isArray(audit.validation) && audit.validation.length === state.validation_policy.local_checks.length &&
    audit.validation.every((entry, index) => entry.command === state.validation_policy.local_checks[index] && entry.exit_code === 0);
}
export function executionSettings(value) {
  invariant(isObject(value), 'invalid_execution_settings');
  invariant(shaPattern.test(value.source_sha), 'invalid_action_source', 'immutable SHA', value.source_sha);
  invariant(typeof value.auto_continue === 'boolean' && Number.isSafeInteger(value.max_continuations) && value.max_continuations >= 0,
    'invalid_continuation_limit');
  invariant(Number.isSafeInteger(value.continuation_count) && value.continuation_count >= 0 && value.continuation_count <= value.max_continuations,
    'continuation_limit_exceeded', value.max_continuations, value.continuation_count);
  invariant(Number.isFinite(value.budget_minutes) && value.budget_minutes >= 3 && value.budget_minutes <= 300, 'invalid_budget');
  invariant(positiveId(value.root_run_id) && positiveId(value.root_run_attempt), 'invalid_root_lineage');
  invariant((value.parent_run_id === null && value.parent_run_attempt === null && value.continuation_count === 0) ||
    (positiveId(value.parent_run_id) && positiveId(value.parent_run_attempt)), 'invalid_parent_lineage');
  invariant(typeof value.git_author_name === 'string' && value.git_author_name.trim() && typeof value.git_author_email === 'string' &&
    value.git_author_email.trim() && !/[\r\n\0]/.test(value.git_author_name + value.git_author_email), 'invalid_git_identity');
  return value;
}
export function validateManifest(value, { repository, versions, taskId } = {}) {
  invariant(isObject(value) && value.schema_version === checkpointSchema, 'unsupported_checkpoint_schema', checkpointSchema, value?.schema_version ?? null);
  invariant(value.repository === repository, 'checkpoint_repository_mismatch', repository, value.repository);
  invariant(typeof value.task_id === 'string' && taskPattern.test(value.task_id) && (!taskId || value.task_id === taskId), 'checkpoint_task_mismatch', taskId, value.task_id);
  invariant(value.branch === `codex/task-${value.task_id}` && shaPattern.test(value.base_sha) && shaPattern.test(value.checkpoint_sha), 'invalid_checkpoint_git_identity');
  invariant(typeof value.plan === 'string' && Buffer.byteLength(value.plan) <= 1024 * 1024 && digest(value.plan) === value.plan_sha256, 'checkpoint_plan_hash_mismatch');
  const authorization = value.authorization;
  invariant(isObject(authorization) && Object.keys(authorization).sort().join() === 'plan_sha256,repository,request' &&
    authorization.repository === repository && authorization.plan_sha256 === value.plan_sha256 &&
    typeof authorization.request === 'string' && authorization.request.trim(), 'checkpoint_authorization_mismatch');
  invariant(value.permission_mode === 'full-access', 'checkpoint_execution_mode_mismatch');
  invariant(isObject(value.versions) && Object.keys(value.versions).sort().join() === Object.keys(versions ?? {}).sort().join() &&
    Object.entries(versions ?? {}).every(([key, version]) => value.versions[key] === version), 'checkpoint_version_mismatch', versions, value.versions);
  invariant(value.plan_source === 'inline' || typeof value.plan_source === 'string' &&
    value.plan_source.startsWith(`https://github.com/${repository}/issues/`) && positiveId(value.plan_source.split('/').at(-1)), 'invalid_checkpoint_plan_source');
  invariant(Array.isArray(value.skills) && value.skills.length > 0 && value.skills.length <= 21 && value.skills[0].repository === 'markhuangai/agent-remote-dev-skills' &&
    value.skills[0].revision === runnerVersions.execution_skills && JSON.stringify(value.skills[0].names) === JSON.stringify(['sdlc-plan-implementation', 'plan-audit', 'pr-review-loop']), 'checkpoint_skills_missing');
  const skillNames = new Set();
  for (const source of value.skills) {
    invariant(isObject(source) && Object.keys(source).sort().join() === 'names,repository,revision' && /^[\w.-]+\/[\w.-]+$/.test(source.repository) &&
      shaPattern.test(source.revision) && Array.isArray(source.names) && source.names.length > 0, 'invalid_checkpoint_skill_source');
    for (const name of source.names) {
      invariant(typeof name === 'string' && /^[a-z0-9][a-z0-9_-]{0,99}$/.test(name) && !skillNames.has(name), 'invalid_checkpoint_skill_name');
      skillNames.add(name);
    }
  }
  invariant(Number.isSafeInteger(value.sequence) && value.sequence > 0 && Array.isArray(value.files) && value.files.length <= 10000, 'invalid_checkpoint_inventory');
  invariant(isObject(value.limits) && value.limits.max_bytes <= checkpointBytes && value.limits.max_bytes > 0, 'invalid_checkpoint_limit');
  const paths = new Set();
  let bytes = 0;
  for (const file of value.files) {
    invariant(isObject(file) && typeof file.path === 'string' && file.path.length <= 512 && !paths.has(file.path) &&
      /^codex\//.test(file.path) && !file.path.includes('\\') && !file.path.split('/').some(part => !part || part === '.' || part === '..') &&
      (/^codex\/(?:sessions|archived_sessions)\/.+\.jsonl(?:\.zst)?$/.test(file.path) || databases.some(name => file.path === `codex/${name}`)), 'unsafe_checkpoint_path');
    invariant(/^[a-f0-9]{64}$/.test(file.sha256) && Number.isSafeInteger(file.bytes) && file.bytes >= 0, 'invalid_checkpoint_file');
    paths.add(file.path); bytes += file.bytes;
  }
  invariant(bytes + Buffer.byteLength(JSON.stringify(value)) <= value.limits.max_bytes, 'checkpoint_size_limit');
  invariant(isObject(value.lineage) && positiveId(value.lineage.run_id) && positiveId(value.lineage.run_attempt) &&
    shaPattern.test(value.lineage.workflow_sha) && value.lineage.repository === repository &&
    ['runner-task.yml', 'runner-acceptance.yml'].some(name => value.lineage.workflow_ref === `${repository}/.github/workflows/${name}@refs/heads/main`), 'untrusted_checkpoint_producer');
  executionSettings(value.execution);
  const state = value.driver;
  const sessionId = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
  invariant(isObject(state) && typeof state.worker_session === 'string' && sessionId.test(state.worker_session) &&
    (state.auditor_session === null || typeof state.auditor_session === 'string' && sessionId.test(state.auditor_session)) &&
    Number.isSafeInteger(state.turn) && state.turn > 0 && Array.isArray(state.reconsidered) && Array.isArray(state.audit_rounds), 'invalid_driver_state');
  invariant(state.validation_policy === null || validationPolicy(state.validation_policy), 'invalid_checkpoint_validation_policy');
  invariant(Array.isArray(value.sessions) && value.sessions.includes(state.worker_session) &&
    (state.auditor_session === null || value.sessions.includes(state.auditor_session)) && Array.isArray(value.session_identifiers) &&
    value.sessions.every(id => typeof id === 'string' && value.session_identifiers.some(entry => entry.thread_id === id)), 'checkpoint_session_mismatch');
  invariant(typeof value.workspace === 'string' && value.workspace.startsWith('/') && typeof value.codex_home === 'string' && value.codex_home.startsWith('/'), 'invalid_checkpoint_locations');
  invariant(state.pr_url === null || typeof state.pr_url === 'string' && state.pr_url.startsWith(`https://github.com/${repository}/pull/`) &&
    /^[1-9][0-9]*$/.test(state.pr_url.split('/').at(-1)), 'invalid_checkpoint_pr');
  if (state.review_budget !== null) validateReviewBudget(state.review_budget, value.checkpoint_sha);
  invariant(state.pr_url === null || state.review_budget !== null, 'missing_review_budget');
  return value;
}
export function validateReviewBudget(value, head) {
  invariant(isObject(value) && value.head_sha === head && Number.isFinite(value.remaining_ms) && value.remaining_ms >= 0 && value.remaining_ms <= 5400000 &&
    (value.active_since === null || Number.isFinite(value.active_since) && value.active_since > 0), 'invalid_review_budget');
  return value;
}
export function debitReviewBudget(value, endedAt) {
  if (value === null) return null;
  validateReviewBudget(value, value.head_sha);
  invariant(Number.isFinite(endedAt) && (value.active_since === null || endedAt >= value.active_since), 'invalid_review_end_time');
  return { ...value, remaining_ms: Math.max(0, value.remaining_ms - (value.active_since === null ? 0 : endedAt - value.active_since)), active_since: null };
}
export function checkpointName(manifest) {
  return `codex-${manifest.task_id}-${manifest.sequence}-r${manifest.lineage.run_id}-a${manifest.lineage.run_attempt}`;
}
export function recordName(kind, taskId, runId, attempt) { return `codex-${kind}-${taskId}-r${runId}-a${attempt}`; }
export function validateProducer(artifact, run, manifest, repository) {
  invariant(isObject(artifact) && positiveId(artifact.id) && !artifact.expired && Date.parse(artifact.expires_at) > Date.now(), 'checkpoint_artifact_expired');
  invariant(artifact.size_in_bytes > 0 && artifact.size_in_bytes <= checkpointBytes && artifact.name === checkpointName(manifest), 'checkpoint_artifact_identity_mismatch');
  invariant(artifact.workflow_run?.id === run.id && String(run.id) === String(manifest.lineage.run_id) &&
    Number(run.run_attempt) === Number(manifest.lineage.run_attempt) && run.repository?.full_name === repository &&
    run.head_repository?.full_name === repository && run.event === 'workflow_dispatch' && run.head_branch === 'main' &&
    run.head_sha === manifest.lineage.workflow_sha && run.path === manifest.lineage.workflow_ref.split(`${repository}/`)[1].split('@')[0],
    'checkpoint_producer_mismatch');
  invariant(typeof manifest.lineage.actor === 'string' && typeof manifest.lineage.triggering_actor === 'string' &&
    run.actor?.login === manifest.lineage.actor && run.triggering_actor?.login === manifest.lineage.triggering_actor, 'checkpoint_actor_mismatch');
  return artifact;
}
export function validateFrozenRoot(manifest, request, root) {
  const repository = manifest.repository;
  invariant(root.repository?.full_name === repository && root.head_repository?.full_name === repository && root.event === 'workflow_dispatch' &&
    root.head_branch === 'main' && ['.github/workflows/runner-task.yml', '.github/workflows/runner-acceptance.yml'].includes(root.path) &&
    root.actor?.login === 'Z-M-Huang' && root.triggering_actor?.login === 'Z-M-Huang', 'untrusted_task_owner');
  const frozenKeys = ['source_sha', 'auto_continue', 'max_continuations', 'budget_minutes', 'root_run_id', 'root_run_attempt', 'git_author_name', 'git_author_email'];
  invariant(request.schema_version === 2 && request.repository === repository && request.task_id === manifest.task_id &&
    request.lineage?.workflow_sha === root.head_sha && request.lineage?.actor === root.actor.login && request.lineage?.triggering_actor === root.triggering_actor.login &&
    request.plan_sha256 === manifest.plan_sha256 && JSON.stringify(request.authorization) === JSON.stringify(manifest.authorization) &&
    frozenKeys.every(key => request.execution?.[key] === manifest.execution[key]) &&
    request.branch === manifest.branch && request.base_sha === manifest.base_sha && request.execution.continuation_count === 0 &&
    request.plan_source === manifest.plan_source && JSON.stringify(request.skills) === JSON.stringify(manifest.skills), 'checkpoint_frozen_contract_mismatch');
}
