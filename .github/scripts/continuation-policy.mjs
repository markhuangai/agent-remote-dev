import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { checkpointName, debitReviewBudget, digest, executionSettings, invariant, positiveId, recordName, runnerVersions,
  shaPattern, taskPattern, validateManifest, validateProducer, validateFrozenRoot } from './checkpoint-policy.mjs';
import { readArtifact } from './artifact-io.mjs';
import { logEvent, safeError, trustedActor } from './review-policy.mjs';
import { verifyProtocol } from './protocol-policy.mjs';

const repositoryName = context => `${context.repo.owner}/${context.repo.repo}`;
const workflowPaths = ['.github/workflows/runner-task.yml', '.github/workflows/runner-acceptance.yml'];
const frozenKeys = ['source_sha', 'auto_continue', 'max_continuations', 'budget_minutes', 'root_run_id', 'root_run_attempt', 'git_author_name', 'git_author_email'];
const frozenEqual = (left, right) => frozenKeys.every(key => left[key] === right[key]);
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
export const dispatchKey = (repository, taskId, parent, artifactId, count) => digest(JSON.stringify([repository, taskId, parent.id, parent.run_attempt, artifactId, count]));
export const childRunName = (taskId, key) => `Codex task ${taskId} / ${key || 'manual'}`;
export const manualRunName = (taskId, artifactId, source) => `Codex task ${taskId} / manual-resume-${artifactId}-${source}`;

async function pages(api, path, key) {
  const entries = [];
  for (let page = 1; page <= 100; page++) {
    const data = await api(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
    invariant(Array.isArray(data[key]), 'invalid_github_collection');
    entries.push(...data[key]);
    if (data[key].length < 100) return entries;
  }
  invariant(false, 'github_collection_truncated');
}
function trustedRun(run, repository, paths = workflowPaths) {
  invariant(run.repository?.full_name === repository && run.head_repository?.full_name === repository && run.event === 'workflow_dispatch' &&
    run.head_branch === 'main' && paths.includes(run.path) && shaPattern.test(run.head_sha) && positiveId(run.id) && positiveId(run.run_attempt), 'untrusted_parent_run');
}
async function uniqueRecord(io, artifacts, name, optional = false) {
  const matches = artifacts.filter(artifact => artifact.name === name);
  invariant(matches.length === 1 || optional && matches.length === 0, 'ambiguous_run_record');
  return matches.length ? (await io(matches[0].id, 'record')).value : null;
}
export async function loadVerifiedCheckpoint({ api, io, repository, id, taskId }) {
  try {
    const loaded = await io(id, 'checkpoint');
    const manifest = validateManifest(loaded.value, { repository, taskId, versions: runnerVersions });
    const producer = await api(`/repos/${repository}/actions/runs/${manifest.lineage.run_id}/attempts/${manifest.lineage.run_attempt}`);
    validateProducer(loaded.artifact, producer, manifest, repository);
    invariant(producer.status === 'completed', 'checkpoint_producer_active');
    const workflow = await api(`/repos/${repository}/actions/workflows/${producer.workflow_id}`);
    invariant(workflow.path === producer.path && workflow.state === 'active', 'checkpoint_workflow_mismatch');
    const root = await api(`/repos/${repository}/actions/runs/${manifest.execution.root_run_id}/attempts/${manifest.execution.root_run_attempt}`);
    trustedRun(root, repository);
    const artifacts = await pages(api, `/repos/${repository}/actions/runs/${root.id}/artifacts`, 'artifacts');
    const request = await uniqueRecord(io, artifacts, recordName('run', manifest.task_id, root.id, root.run_attempt));
    validateFrozenRoot(manifest, request, root);
    return { ...loaded, manifest, producer, root, request };
  } catch (error) {
    if (error && typeof error === 'object') error.details = { ...error.details,
      artifact_id: positiveId(id) ? Number(id) : null, task_id: typeof taskId === 'string' && taskPattern.test(taskId) ? taskId : null };
    throw error;
  }
}
function createIO(api, repository, root) {
  const cache = new Map();
  return (id, kind) => {
    const key = `${id}:${kind}`;
    if (!cache.has(key)) cache.set(key, readArtifact({ api, repository, id: Number(id), root, kind }));
    return cache.get(key);
  };
}
async function taskRun(api, repository, id, attempt) {
  const run = await api(`/repos/${repository}/actions/runs/${id}`);
  trustedRun(run, repository);
  invariant(run.status === 'completed' && Number(run.run_attempt) === Number(attempt), 'parent_run_active_or_rerun');
  return run;
}
async function verifiedClaim(api, io, repository, artifactId) {
  const loaded = await io(Number(artifactId), 'record'), claim = loaded.value;
  invariant(claim.schema_version === 2 && claim.repository === repository && typeof claim.task_id === 'string' && taskPattern.test(claim.task_id) && shaPattern.test(claim.source_sha) &&
    positiveId(claim.controller_run_id) && positiveId(claim.controller_run_attempt) && positiveId(claim.parent_run_id) && positiveId(claim.parent_run_attempt) &&
    positiveId(claim.artifact_id) && positiveId(claim.root_run_id) && Number.isSafeInteger(claim.continuation_count) && claim.continuation_count > 0 &&
    claim.dispatch_key === dispatchKey(repository, claim.task_id, { id: Number(claim.parent_run_id), run_attempt: Number(claim.parent_run_attempt) }, claim.artifact_id, claim.continuation_count) &&
    loaded.artifact.name === `codex-claim-${claim.dispatch_key}`, 'invalid_dispatch_claim');
  const controller = await api(`/repos/${repository}/actions/runs/${claim.controller_run_id}/attempts/${claim.controller_run_attempt}`);
  invariant(controller.path === '.github/workflows/runner-continuation.yml' && controller.event === 'workflow_run' && controller.head_branch === 'main' &&
    controller.repository?.full_name === repository && controller.head_repository?.full_name === repository && controller.head_sha === claim.controller_sha &&
    Number(controller.run_attempt) === Number(claim.controller_run_attempt) && loaded.artifact.workflow_run?.id === controller.id, 'untrusted_dispatch_claim');
  return claim;
}
async function inheritedRequest(api, io, repository, parent) {
  const match = /^Codex task ([a-z0-9][a-z0-9-]{0,63}) \/ ([a-f0-9]{64})$/.exec(parent.display_title ?? '');
  const manual = /^Codex task ([a-z0-9][a-z0-9-]{0,63}) \/ manual-resume-([1-9][0-9]*)-([a-f0-9]{40})$/.exec(parent.display_title ?? '');
  if (manual) {
    invariant(parent.actor?.login === trustedActor && parent.triggering_actor?.login === trustedActor && parent.path === '.github/workflows/runner-task.yml', 'untrusted_manual_resume');
    const loaded = await loadVerifiedCheckpoint({ api, io, repository, id: Number(manual[2]), taskId: manual[1] });
    const manifest = loaded.manifest;
    invariant(manual[3] === manifest.execution.source_sha, 'manual_resume_source_mismatch');
    const recovered = await manualResumeState(api, repository, manifest, loaded.producer, String(parent.id), parent.run_attempt);
    return { schema_version: 2, repository, task_id: manifest.task_id, branch: manifest.branch, base_sha: manifest.base_sha, plan_sha256: manifest.plan_sha256,
      authorization: manifest.authorization, skills: manifest.skills, plan_source: manifest.plan_source,
      execution: { ...manifest.execution, continuation_count: recovered.count, parent_run_id: String(loaded.producer.id), parent_run_attempt: String(loaded.producer.run_attempt) },
      lineage: { repository, workflow_sha: parent.head_sha, run_id: String(parent.id), run_attempt: String(parent.run_attempt), actor: parent.actor.login, triggering_actor: parent.triggering_actor.login },
      job_name: 'execute', resume_artifact_id: Number(manual[2]), review_budget: recovered.review_budget, inherited_before_setup: true };
  }
  if (!match) return null;
  invariant(parent.path === '.github/workflows/runner-task.yml' && parent.actor?.login === 'github-actions[bot]' &&
    parent.triggering_actor?.login === 'github-actions[bot]' && parent.run_attempt === 1, 'untrusted_inherited_resume');
  const artifacts = await pages(api, `/repos/${repository}/actions/artifacts?name=codex-claim-${match[2]}`, 'artifacts');
  const matches = artifacts.filter(artifact => artifact.name === `codex-claim-${match[2]}`);
  invariant(matches.length === 1, 'missing_inherited_claim');
  const claim = await verifiedClaim(api, io, repository, matches[0].id);
  invariant(claim.task_id === match[1] && claim.dispatch_key === match[2], 'inherited_claim_mismatch');
  const runs = await pages(api, `/repos/${repository}/actions/workflows/runner-task.yml/runs?event=workflow_dispatch&branch=main`, 'workflow_runs');
  const children = runs.filter(run => run.display_title === parent.display_title);
  invariant(children.length === 1 && children[0].id === parent.id, 'duplicate_child_refused');
  const loaded = await loadVerifiedCheckpoint({ api, io, repository, id: claim.artifact_id, taskId: claim.task_id });
  const manifest = loaded.manifest;
  invariant(claim.source_sha === manifest.execution.source_sha && claim.root_run_id === manifest.execution.root_run_id &&
    claim.continuation_count <= manifest.execution.max_continuations, 'inherited_contract_mismatch');
  const execution = { ...manifest.execution, parent_run_id: claim.parent_run_id, parent_run_attempt: claim.parent_run_attempt, continuation_count: claim.continuation_count };
  executionSettings(execution);
  const reviewBudget = claim.review_budget;
  invariant(reviewBudget === null ? manifest.driver.review_budget === null : reviewBudget?.head_sha === manifest.checkpoint_sha &&
    reviewBudget.active_since === null && Number.isFinite(reviewBudget.remaining_ms) && reviewBudget.remaining_ms >= 0 &&
    reviewBudget.remaining_ms <= manifest.driver.review_budget?.remaining_ms, 'invalid_inherited_review_budget');
  return { schema_version: 2, repository, task_id: claim.task_id, branch: manifest.branch, base_sha: manifest.base_sha, plan_sha256: manifest.plan_sha256,
    authorization: manifest.authorization, skills: manifest.skills, plan_source: manifest.plan_source, execution,
    lineage: { repository, workflow_sha: parent.head_sha, run_id: String(parent.id), run_attempt: String(parent.run_attempt),
      actor: parent.actor.login, triggering_actor: parent.triggering_actor.login }, job_name: 'execute', resume_artifact_id: claim.artifact_id,
    review_budget: reviewBudget, inherited_before_setup: true };
}
async function manualResumeState(api, repository, manifest, producer, excludedRun, excludedAttempt = 1) {
  const artifacts = await pages(api, `/repos/${repository}/actions/artifacts`, 'artifacts');
  const checkpoints = artifacts.filter(artifact => new RegExp(`^codex-${manifest.task_id}-[1-9][0-9]*-r[1-9][0-9]*-a[1-9][0-9]*$`).test(artifact.name));
  invariant(checkpoints.every(artifact => Number(artifact.name.match(/-([0-9]+)-r/)[1]) <= manifest.sequence), 'stale_manual_checkpoint');
  const runs = await pages(api, `/repos/${repository}/actions/workflows/runner-task.yml/runs?event=workflow_dispatch&branch=main`, 'workflow_runs');
  const previous = runs.filter(run => run.display_title?.startsWith(`Codex task ${manifest.task_id} / `) && run.id > Number(manifest.execution.root_run_id) && String(run.id) !== excludedRun);
  for (const run of previous) { trustedRun(run, repository); invariant(run.status === 'completed' && positiveId(run.run_attempt), 'task_run_active'); }
  const root = await api(`/repos/${repository}/actions/runs/${manifest.execution.root_run_id}`);
  invariant(root.status === 'completed' && positiveId(root.run_attempt), 'root_run_active');
  const observed = previous.reduce((count, run) => count + run.run_attempt, 0) + Math.max(0, root.run_attempt - Number(manifest.execution.root_run_attempt)) + Math.max(0, Number(excludedAttempt) - 1);
  const count = Math.max(manifest.execution.continuation_count, observed) + 1;
  invariant(count <= manifest.execution.max_continuations, 'continuation_limit_exceeded', manifest.execution.max_continuations, count);
  const jobs = await pages(api, `/repos/${repository}/actions/runs/${producer.id}/attempts/${producer.run_attempt}/jobs`, 'jobs');
  const job = jobs.find(entry => entry.name === (producer.path.endsWith('runner-acceptance.yml') ? 'acceptance' : 'execute'));
  invariant(job && job.status === 'completed' && Number.isFinite(Date.parse(job.completed_at)), 'missing_parent_job_timing');
  return { count, review_budget: debitReviewBudget(manifest.driver.review_budget, Date.parse(job.completed_at)) };
}
async function validationVeto(io, artifacts, request, manifest, parent) {
  const records = artifacts.filter(artifact => new RegExp(`^codex-validation-[1-9][0-9]*-(started|passed|failed)-${request.task_id}-r${parent.id}-a${parent.run_attempt}$`).test(artifact.name));
  if (!records.length) return null;
  const states = [];
  for (const artifact of records) {
    const value = (await io(artifact.id, 'record')).value;
    invariant(value.schema_version === 2 && value.repository === request.repository && value.task_id === request.task_id &&
      String(value.lineage?.run_id) === String(parent.id) && Number(value.lineage?.run_attempt) === Number(parent.run_attempt) &&
      value.lineage?.workflow_sha === parent.head_sha && Number.isSafeInteger(value.round) && value.round > 0 &&
      ['started', 'passed', 'failed'].includes(value.phase) && /^[a-f0-9]{64}$/.test(value.audit_state_hash) &&
      artifact.name === recordName(`validation-${value.round}-${value.phase}`, request.task_id, parent.id, parent.run_attempt), 'invalid_validation_state');
    states.push(value);
  }
  const latest = Math.max(...states.map(value => value.round)), current = states.filter(value => value.round === latest);
  if (current.some(value => value.phase === 'failed')) return 'required_validation_failed';
  const passed = current.filter(value => value.phase === 'passed');
  return passed.length === 1 && passed[0].audit_state_hash === (manifest.source_state_hash ?? manifest.audit?.state_hash) ? null : 'required_validation_pending';
}
export async function continuationDecision({ api, io, repository, parent }) {
  trustedRun(parent, repository);
  invariant(parent.status === 'completed', 'parent_run_active');
  if (!['success', 'timed_out'].includes(parent.conclusion)) return { eligible: false, reason: `parent_${parent.conclusion}`, parent };
  const artifacts = await pages(api, `/repos/${repository}/actions/runs/${parent.id}/artifacts`, 'artifacts');
  const requests = artifacts.filter(artifact => new RegExp(`^codex-run-[a-z0-9-]+-r${parent.id}-a${parent.run_attempt}$`).test(artifact.name));
  invariant(requests.length <= 1, 'ambiguous_run_request');
  const request = requests.length ? (await io(requests[0].id, 'record')).value : await inheritedRequest(api, io, repository, parent);
  if (!request) return { eligible: false, reason: 'no_durable_run_reference', parent };
  invariant(request.schema_version === 2 && request.repository === repository && typeof request.task_id === 'string' && taskPattern.test(request.task_id) &&
    String(request.lineage?.run_id) === String(parent.id) && Number(request.lineage?.run_attempt) === Number(parent.run_attempt) &&
    request.lineage?.workflow_sha === parent.head_sha && request.lineage?.actor === parent.actor?.login && request.lineage?.triggering_actor === parent.triggering_actor?.login,
    'run_request_identity_mismatch');
  const execution = executionSettings(request.execution);
  const outcome = await uniqueRecord(io, artifacts, recordName('outcome', request.task_id, parent.id, parent.run_attempt), true);
  if (outcome && (outcome.status !== 'continuing' || outcome.reason !== 'action_budget')) return { eligible: false, reason: `outcome_${outcome.status}`, parent, request };
  if (parent.conclusion === 'success' && !outcome) return { eligible: false, reason: 'missing_budget_handoff', parent, request };
  if (!execution.auto_continue || execution.continuation_count >= execution.max_continuations) return { eligible: false, reason: 'continuation_limit', parent, request };
  const candidates = artifacts.filter(artifact => new RegExp(`^codex-${request.task_id}-[1-9][0-9]*-r${parent.id}-a${parent.run_attempt}$`).test(artifact.name));
  candidates.sort((a, b) => Number(b.name.match(/-([0-9]+)-r/)[1]) - Number(a.name.match(/-([0-9]+)-r/)[1]));
  invariant(candidates.length < 2 || candidates[0].name !== candidates[1].name, 'ambiguous_latest_checkpoint');
  const artifactId = candidates[0]?.id ?? request.resume_artifact_id;
  if (!positiveId(artifactId)) return { eligible: false, reason: 'no_durable_checkpoint', parent, request };
  const loaded = await loadVerifiedCheckpoint({ api, io, repository, id: Number(artifactId), taskId: request.task_id });
  const manifest = loaded.manifest;
  const veto = await validationVeto(io, artifacts, request, manifest, parent);
  if (veto) return { eligible: false, reason: veto, parent, request };
  invariant(frozenEqual(execution, manifest.execution) && same(request.authorization, manifest.authorization) &&
    request.plan_sha256 === manifest.plan_sha256 && request.branch === manifest.branch && request.base_sha === manifest.base_sha, 'parent_checkpoint_contract_mismatch');
  invariant(candidates.length ? same(execution, manifest.execution) : Number(request.resume_artifact_id) === Number(artifactId) &&
    execution.continuation_count > manifest.execution.continuation_count, 'inherited_checkpoint_lineage_mismatch');
  if (outcome) invariant(outcome.repository === repository && outcome.task_id === request.task_id &&
    String(outcome.lineage?.run_id) === String(parent.id) && Number(outcome.lineage?.run_attempt) === Number(parent.run_attempt) &&
    outcome.checkpoint?.artifact_id === Number(artifactId) && outcome.checkpoint?.checkpoint_sha === manifest.checkpoint_sha, 'outcome_checkpoint_mismatch');
  const branch = await api(`/repos/${repository}/git/ref/heads/${manifest.branch}`);
  invariant(branch.object?.sha === manifest.checkpoint_sha, 'resume_branch_drift', manifest.checkpoint_sha, branch.object?.sha);
  const jobs = await pages(api, `/repos/${repository}/actions/runs/${parent.id}/attempts/${parent.run_attempt}/jobs`, 'jobs');
  let taskJobs = jobs.filter(job => job.name === request.job_name);
  if (!taskJobs.length && request.inherited_before_setup) taskJobs = jobs.filter(job => job.status === 'completed' && Number.isFinite(Date.parse(job.completed_at))).sort((a, b) => Date.parse(b.completed_at) - Date.parse(a.completed_at)).slice(0, 1);
  invariant(taskJobs.length === 1 && taskJobs[0].status === 'completed' && Number.isFinite(Date.parse(taskJobs[0].completed_at)), 'missing_parent_job_timing');
  const reviewBudget = debitReviewBudget(candidates.length ? manifest.driver.review_budget : request.review_budget, Date.parse(taskJobs[0].completed_at));
  if (reviewBudget && reviewBudget.remaining_ms <= 0) return { eligible: false, reason: 'review_observation_budget', parent, request };
  const count = execution.continuation_count + 1;
  const key = dispatchKey(repository, request.task_id, parent, Number(artifactId), count);
  return { eligible: true, reason: parent.conclusion === 'timed_out' ? 'native_timeout' : 'action_budget', parent, request, manifest,
    artifact_id: Number(artifactId), continuation_count: count, dispatch_key: key, claim_name: `codex-claim-${key}`, parent_job_ended_at: taskJobs[0].completed_at, parent_job_name: taskJobs[0].name,
    review_budget: reviewBudget };
}
async function controllerState({ github, context, env }) {
  invariant(env.GITHUB_REF === 'refs/heads/main' && context.eventName === 'workflow_run' && env.CODEX_RUNNER_PROTOCOL === '2', 'untrusted_controller_context');
  const repository = repositoryName(context), api = async (path, options) => (await github.request(`${options?.method ?? 'GET'} ${path}`, options)).data;
  const trigger = context.payload.workflow_run;
  await verifyProtocol(api, repository);
  invariant(positiveId(trigger?.id) && positiveId(trigger?.run_attempt), 'invalid_parent_event');
  const parent = await taskRun(api, repository, trigger.id, trigger.run_attempt);
  invariant(parent.head_sha === trigger.head_sha && parent.workflow_id === trigger.workflow_id && parent.conclusion === trigger.conclusion, 'parent_event_drift');
  const root = join(env.RUNNER_TEMP, `continuation-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}-${env.CONTINUATION_MODE}`);
  const io = createIO(api, repository, root);
  const decision = await continuationDecision({ api, io, repository, parent });
  return { api, io, repository, root, decision };
}
function decisionFields(decision) {
  return { task_id: decision.request?.task_id, root_run_id: decision.request?.execution?.root_run_id, parent_run_id: decision.parent?.id,
    parent_run_attempt: decision.parent?.run_attempt, artifact_id: decision.artifact_id, continuation_count: decision.continuation_count,
    max_continuations: decision.request?.execution?.max_continuations, budget_minutes: decision.request?.execution?.budget_minutes,
    checkpoint_sha: decision.manifest?.checkpoint_sha, session_id: decision.manifest?.driver?.worker_session,
    reason: decision.reason, eligible: decision.eligible };
}
export async function runController({ github, context, core, env = process.env, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  const started = now();
  const trigger = context.payload.workflow_run;
  let fields = { parent_run_id: positiveId(trigger?.id) ? Number(trigger.id) : null,
    parent_run_attempt: positiveId(trigger?.run_attempt) ? Number(trigger.run_attempt) : null };
  try {
    const { api, io, repository, root, decision } = await controllerState({ github, context, env });
    fields = decisionFields(decision);
    if (!decision.eligible) { logEvent(core, 'continuation.dispatch', 'INFO', { ...fields, outcome: 'stopped', elapsed_ms: now() - started }, env); return { eligible: false }; }
    if (env.CONTINUATION_MODE === 'resolve') return { eligible: true, task_id: decision.request.task_id };
    const existing = await pages(api, `/repos/${repository}/actions/artifacts?name=${decision.claim_name}`, 'artifacts');
    const claims = existing.filter(artifact => artifact.name === decision.claim_name);
    invariant(claims.length <= 1, 'ambiguous_dispatch_claim');
    if (env.CONTINUATION_MODE === 'prepare') {
      const claim = { schema_version: 2, repository, task_id: decision.request.task_id, dispatch_key: decision.dispatch_key,
        parent_run_id: String(decision.parent.id), parent_run_attempt: String(decision.parent.run_attempt), artifact_id: decision.artifact_id,
        continuation_count: decision.continuation_count, source_sha: decision.request.execution.source_sha,
        root_run_id: decision.request.execution.root_run_id, parent_job_ended_at: decision.parent_job_ended_at,
        parent_job_name: decision.parent_job_name, review_budget: decision.review_budget,
        controller_run_id: env.GITHUB_RUN_ID, controller_run_attempt: env.GITHUB_RUN_ATTEMPT, controller_sha: env.GITHUB_WORKFLOW_SHA };
      const claimRoot = join(root, 'claim');
      if (!claims.length) { await mkdir(claimRoot, { recursive: true, mode: 0o700 }); await writeFile(join(claimRoot, 'record.json'), JSON.stringify(claim), { mode: 0o600, flag: 'wx' }); }
      logEvent(core, 'continuation.dispatch', 'INFO', { ...fields, outcome: claims.length ? 'reconcile_existing_claim' : 'claim_prepared', claim_name: decision.claim_name }, env);
      return { eligible: true, upload: !claims.length, claim_name: decision.claim_name, claim_path: join(claimRoot, 'record.json'), existing_claim_id: claims[0]?.id ?? '' };
    }
    invariant(env.CONTINUATION_MODE === 'dispatch' && claims.length === 1 && Number(env.CLAIM_ARTIFACT_ID) === claims[0].id, 'dispatch_claim_missing');
    const claim = await verifiedClaim(api, io, repository, claims[0].id);
    invariant(claim.repository === repository && claim.dispatch_key === decision.dispatch_key && claim.artifact_id === decision.artifact_id &&
      claim.task_id === decision.request.task_id && claim.continuation_count === decision.continuation_count && claim.source_sha === decision.request.execution.source_sha &&
      claim.parent_run_id === String(decision.parent.id) && claim.parent_run_attempt === String(decision.parent.run_attempt), 'dispatch_claim_mismatch');
    const childName = childRunName(claim.task_id, claim.dispatch_key);
    const findChild = async () => {
      const runs = await pages(api, `/repos/${repository}/actions/workflows/runner-task.yml/runs?event=workflow_dispatch&branch=main`, 'workflow_runs');
      const matches = runs.filter(run => run.display_title === childName);
      invariant(matches.length <= 1, 'duplicate_child_runs');
      if (matches.length) { trustedRun(matches[0], repository, ['.github/workflows/runner-task.yml']); invariant(matches[0].actor?.login === 'github-actions[bot]', 'untrusted_child_actor'); }
      return matches[0];
    };
    let child = await findChild(), dispatchError = null;
    const ownsClaim = claim.controller_run_id === env.GITHUB_RUN_ID && claim.controller_run_attempt === env.GITHUB_RUN_ATTEMPT && env.NEW_CLAIM === 'true';
    if (!child && ownsClaim) {
      const request = { task_id: claim.task_id, source_sha: claim.source_sha, resume_artifact_id: claim.artifact_id, claim_artifact_id: claims[0].id,
        dispatch_key: claim.dispatch_key, parent_run_id: claim.parent_run_id, parent_run_attempt: claim.parent_run_attempt, continuation_count: claim.continuation_count };
      try { await api(`/repos/${repository}/actions/workflows/runner-task.yml/dispatches`, { method: 'POST', ref: 'main', inputs: { request: JSON.stringify(request) } }); }
      catch (error) { dispatchError = safeError(error); }
    }
    const deadline = now() + 300000;
    while (!child && now() < deadline) { await sleep(Math.min(10000, deadline - now())); child = await findChild(); }
    invariant(child, ownsClaim ? 'ambiguous_dispatch_registration' : 'claimed_dispatch_unreconciled');
    logEvent(core, 'continuation.dispatch', 'INFO', { ...fields, outcome: 'registered', claim_artifact_id: claims[0].id, child_run_id: child.id,
      child_url: child.html_url, workflow: '.github/workflows/runner-task.yml', ref: 'main', dispatch_error: dispatchError, elapsed_ms: now() - started }, env);
    return { child_run_id: child.id, child_url: child.html_url };
  } catch (error) {
    logEvent(core, 'continuation.dispatch', 'ERROR', { ...fields, outcome: 'blocked',
      ...safeError(error), reason: error.reason ?? safeError(error).reason, ...error.details, elapsed_ms: now() - started,
      corrective_action: 'Inspect the parent, durable artifact and immutable claim; reconcile existing child runs before any explicit recovery.' }, env);
    throw error;
  }
}

export async function prepareTaskRequest(args) {
  const env = args.env ?? process.env, started = Date.now();
  try { return await prepareVerifiedTaskRequest({ ...args, env }); }
  catch (error) {
    let request;
    try { request = JSON.parse(env.TASK_REQUEST); } catch {}
    logEvent(args.core, 'resume.validate', 'ERROR', { outcome: 'task_request_rejected', task_id: typeof request?.task_id === 'string' && taskPattern.test(request.task_id) ? request.task_id : null,
      artifact_id: positiveId(request?.resume_artifact_id) ? Number(request.resume_artifact_id) : null,
      ...safeError(error), reason: error.reason ?? safeError(error).reason, ...error.details, elapsed_ms: Date.now() - started,
      corrective_action: 'Resolve the rejected task, protocol or lineage invariant before requesting execution.' }, env);
    throw error;
  }
}
async function prepareVerifiedTaskRequest({ github, context, core, env }) {
  const repository = repositoryName(context), api = async path => (await github.request(`GET ${path}`)).data;
  invariant(env.GITHUB_REF === 'refs/heads/main' && context.eventName === 'workflow_dispatch' && env.CODEX_RUNNER_PROTOCOL === '2', 'untrusted_task_context');
  const request = JSON.parse(env.TASK_REQUEST);
  invariant(request && typeof request.task_id === 'string' && taskPattern.test(request.task_id) && shaPattern.test(request.source_sha), 'invalid_task_request');
  const commit = await api(`/repos/${repository}/commits/${request.source_sha}`);
  invariant(commit.sha === request.source_sha, 'action_source_mismatch');
  if (!request.resume_artifact_id) await verifyProtocol(api, repository, request.auto_continue !== false);
  const root = join(env.RUNNER_TEMP, `task-request-${env.GITHUB_RUN_ID}-${env.GITHUB_JOB}`), io = createIO(api, repository, root);
  let parameters;
  if (request.resume_artifact_id) {
    invariant(context.actor === trustedActor && env.TRIGGERING_ACTOR === trustedActor || context.actor === 'github-actions[bot]' && env.TRIGGERING_ACTOR === 'github-actions[bot]', 'untrusted_resume_actor');
    const loaded = await loadVerifiedCheckpoint({ api, io, repository, id: request.resume_artifact_id, taskId: request.task_id });
    const manifest = loaded.manifest;
    await verifyProtocol(api, repository, manifest.execution.auto_continue);
    let parent, carriedReview, parentJobName, count = manifest.execution.continuation_count + 1;
    if (context.actor === 'github-actions[bot]') {
      invariant(Number(env.GITHUB_RUN_ATTEMPT) === 1 && positiveId(request.claim_artifact_id), 'automatic_rerun_refused');
      const claim = await verifiedClaim(api, io, repository, request.claim_artifact_id);
      parent = await taskRun(api, repository, request.parent_run_id, request.parent_run_attempt);
      const decision = await continuationDecision({ api, io, repository, parent });
      invariant(decision.eligible && request.dispatch_key === decision.dispatch_key && request.continuation_count === decision.continuation_count &&
        request.resume_artifact_id === decision.artifact_id && claim.dispatch_key === decision.dispatch_key && claim.source_sha === request.source_sha &&
        claim.task_id === request.task_id && claim.artifact_id === request.resume_artifact_id && claim.parent_run_id === String(parent.id) &&
        claim.parent_run_attempt === String(parent.run_attempt) && claim.continuation_count === request.continuation_count, 'invalid_child_claim');
      const runs = await pages(api, `/repos/${repository}/actions/workflows/runner-task.yml/runs?event=workflow_dispatch&branch=main`, 'workflow_runs');
      const siblings = runs.filter(run => run.display_title === childRunName(request.task_id, request.dispatch_key)).sort((a, b) => a.id - b.id);
      invariant(siblings.length === 1 && String(siblings[0].id) === env.GITHUB_RUN_ID, 'duplicate_child_refused');
      count = decision.continuation_count;
      carriedReview = decision.review_budget;
      parentJobName = decision.parent_job_name;
    } else {
      invariant(request.source_sha === manifest.execution.source_sha && !request.dispatch_key && !request.claim_artifact_id, 'manual_resume_source_mismatch');
      parent = loaded.producer;
      const recovered = await manualResumeState(api, repository, manifest, parent, env.GITHUB_RUN_ID, env.GITHUB_RUN_ATTEMPT);
      count = recovered.count; carriedReview = recovered.review_budget;
    }
    const jobs = await pages(api, `/repos/${repository}/actions/runs/${parent.id}/attempts/${parent.run_attempt}/jobs`, 'jobs');
    const job = jobs.find(entry => entry.name === (parentJobName ?? (parent.path.endsWith('runner-acceptance.yml') ? 'acceptance' : 'execute')));
    invariant(job && Number.isFinite(Date.parse(job.completed_at)), 'missing_parent_job_timing');
    if (carriedReview === undefined) carriedReview = debitReviewBudget(manifest.driver.review_budget, Date.parse(job.completed_at));
    const execution = { ...manifest.execution, parent_run_id: String(parent.id), parent_run_attempt: String(parent.run_attempt), continuation_count: count };
    executionSettings(execution);
    parameters = { task_id: manifest.task_id, source_sha: manifest.execution.source_sha, resume_artifact_id: request.resume_artifact_id,
      authorization: JSON.stringify(manifest.authorization), plan: '', issue_url: '', skills: JSON.stringify(manifest.skills.slice(1)),
      git_author_name: execution.git_author_name, git_author_email: execution.git_author_email, execution: JSON.stringify(execution),
      parent_job_ended_at: job.completed_at, parent_job_name: job.name, review_budget: JSON.stringify(carriedReview), claim_artifact_id: request.claim_artifact_id ?? '', dispatch_key: request.dispatch_key ?? '' };
  } else {
    invariant(context.actor === trustedActor && env.TRIGGERING_ACTOR === trustedActor && !request.claim_artifact_id && !request.dispatch_key, 'untrusted_task_actor');
    invariant(Boolean(request.plan?.trim()) !== Boolean(request.issue_url?.trim()), 'exactly_one_plan_source_required');
    let plan = request.plan;
    if (request.issue_url) {
      const prefix = `https://github.com/${repository}/issues/`;
      invariant(request.issue_url.startsWith(prefix) && positiveId(request.issue_url.slice(prefix.length)), 'invalid_issue_url');
      const issue = await api(`/repos/${repository}/issues/${request.issue_url.slice(prefix.length)}`);
      invariant(issue.state === 'open' && !issue.pull_request && typeof issue.body === 'string' && issue.body.trim(), 'invalid_source_issue');
      plan = issue.body;
    }
    const authorization = typeof request.authorization === 'string' ? JSON.parse(request.authorization) : request.authorization;
    invariant(authorization && Object.keys(authorization).sort().join() === 'plan_sha256,repository,request' && authorization.repository === repository &&
      authorization.plan_sha256 === digest(plan) && typeof authorization.request === 'string' && authorization.request.trim(), 'authorization_mismatch');
    const execution = executionSettings({ source_sha: request.source_sha, auto_continue: request.auto_continue ?? true, max_continuations: request.max_continuations ?? 3,
      continuation_count: 0, budget_minutes: request.budget_minutes ?? 300, root_run_id: env.GITHUB_RUN_ID, root_run_attempt: env.GITHUB_RUN_ATTEMPT,
      parent_run_id: null, parent_run_attempt: null, git_author_name: request.git_author_name, git_author_email: request.git_author_email });
    parameters = { task_id: request.task_id, source_sha: request.source_sha, resume_artifact_id: '', authorization: JSON.stringify(authorization),
      plan: request.plan ?? '', issue_url: request.issue_url ?? '', skills: JSON.stringify(request.skills ?? []), git_author_name: execution.git_author_name,
      git_author_email: execution.git_author_email, execution: JSON.stringify(execution), parent_job_ended_at: '', claim_artifact_id: '', dispatch_key: '' };
  }
  logEvent(core, 'resume.validate', 'INFO', { outcome: 'task_request_verified', task_id: parameters.task_id, source_sha: parameters.source_sha,
    artifact_id: parameters.resume_artifact_id || null, actor: context.actor, workflow_sha: env.GITHUB_WORKFLOW_SHA }, env);
  return parameters;
}
