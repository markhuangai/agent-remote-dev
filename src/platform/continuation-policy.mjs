import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { authorization, checkpointName, digest, executionSettings, frozenExecution, invariant, positiveId, recordName, repositoryPattern,
  registrationKey, runnerLabels, runnerVersions, same, shaPattern, sources, taskPattern, validateManifest, validateProducer, validateFrozenRoot } from './checkpoint-policy.mjs';
import { readArtifact } from './artifact-io.mjs';
import { logEvent, safeError } from './runtime-log.mjs';
import { verifyProtocol } from './protocol-policy.mjs';
import { readProjectConfig } from './project-config.mjs';
import { pages } from './sources.mjs';
export { pages } from './sources.mjs';

const taskPath = '.github/workflows/runner-task.yml', controllerPath = '.github/workflows/runner-continuation.yml';
const publishedPath = '.github/workflows/runner-published.yml', taskPaths = [taskPath, publishedPath];
const repositoryName = context => `${context.repo.owner}/${context.repo.repo}`;
export const dispatchKey = (repository, taskId, parent, artifactId, count) => digest(JSON.stringify([repository, taskId, parent.id, parent.run_attempt, artifactId, count]));
export const childRunName = (taskId, key) => `Codex task ${taskId} / ${key || 'manual'}`;
export const manualRunName = (taskId, artifactId, source, key) => `Codex task ${taskId} / manual-resume-${artifactId}-${source}-${key}`;
export const submissionRunName = (requestId, key) => `Codex request ${requestId} / request-${key}`;
async function operators(api, repository, revision) {
  return (await readProjectConfig(api, repository, revision)).settings.allowed_actors;
}
export async function authorizeActors(api, repository, actor, triggeringActor) {
  const main = await api(`/repos/${repository}/git/ref/heads/main`);
  invariant(shaPattern.test(main.object?.sha), 'invalid_protocol_revision');
  const allowed = await operators(api, repository, main.object.sha);
  invariant(allowed.includes(actor) && allowed.includes(triggeringActor), 'untrusted_task_actor');
  for (const login of new Set([actor, triggeringActor])) {
    const access = await api(`/repos/${repository}/collaborators/${login}/permission`);
    invariant(['write', 'maintain', 'admin'].includes(access.permission), 'operator_write_permission_required');
  }
  return main.object.sha;
}
function trustedRun(run, repository, paths = null) {
  invariant(run.repository?.full_name === repository && run.head_repository?.full_name === repository && run.event === 'workflow_dispatch' &&
    run.head_branch === 'main' && (paths ? paths.includes(run.path) : /^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/.test(run.path)) && shaPattern.test(run.head_sha) && positiveId(run.id) && positiveId(run.run_attempt), 'untrusted_parent_run');
}
export async function authorizeActivation(api, repository, execution) {
  let activation;
  try {
    const current = await api(`/repos/${repository}/actions/runs/${execution.activation_run_id}`);
    invariant(String(current.id) === execution.activation_run_id && String(current.run_attempt) === execution.activation_run_attempt,
      'activation_attempt_changed', execution.activation_run_attempt, current.run_attempt);
    activation = await api(`/repos/${repository}/actions/runs/${execution.activation_run_id}/attempts/${execution.activation_run_attempt}`);
    trustedRun(activation, repository);
    invariant(String(activation.id) === execution.activation_run_id && String(activation.run_attempt) === execution.activation_run_attempt &&
      activation.head_sha === current.head_sha && activation.actor?.login === current.actor?.login && activation.triggering_actor?.login === current.triggering_actor?.login &&
      activation.actor?.login !== 'github-actions[bot]' && activation.triggering_actor?.login !== 'github-actions[bot]', 'untrusted_activation');
    return await authorizeActors(api, repository, activation.actor?.login, activation.triggering_actor?.login);
  } catch (error) {
    error.details = { ...error.details, activation_run_id: execution.activation_run_id, activation_run_attempt: execution.activation_run_attempt,
      activation_actor: /^[\w-]{1,39}$/.test(activation?.actor?.login ?? '') ? activation.actor.login : null,
      activation_triggering_actor: /^[\w-]{1,39}$/.test(activation?.triggering_actor?.login ?? '') ? activation.triggering_actor.login : null };
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
async function uniqueRecord(io, artifacts, name, optional = false) {
  const matches = artifacts.filter(artifact => artifact.name === name);
  invariant(matches.length === 1 || optional && matches.length === 0, 'ambiguous_run_record');
  return matches.length ? (await io(matches[0].id, 'record')).value : null;
}
export async function latestStop(api, repository, taskId) {
  const runs = await pages(api, `/repos/${repository}/actions/runs?event=workflow_dispatch&branch=main`, 'workflow_runs');
  let latest = 0;
  for (const run of runs.filter(run => run.display_title?.startsWith(`Codex stop ${taskId} / `))) {
    trustedRun(run, repository, [taskPath]);
    const allowed = await operators(api, repository, run.head_sha);
    if (allowed.includes(run.actor?.login) && allowed.includes(run.triggering_actor?.login)) latest = Math.max(latest, run.id);
  }
  return latest;
}
async function stoppedTask(api, repository, taskId, activationRunId, requestId) {
  const stop = await latestStop(api, repository, taskId), requestStop = requestId ? await latestStop(api, repository, requestId) : 0;
  return { stopped: stop >= Number(activationRunId) || requestStop >= Number(activationRunId) || String(activationRunId) === taskId && requestStop > 0,
    stop: Math.max(stop, requestStop) };
}
export async function requireActive(api, repository, taskId, activationRunId, requestId) {
  const state = await stoppedTask(api, repository, taskId, activationRunId, requestId);
  invariant(!state.stopped, 'task_stopped', Number(activationRunId), state.stop);
}
async function verifiedTaskRoot(api, io, repository, taskId) {
  const current = await api(`/repos/${repository}/actions/runs/${taskId}`);
  const root = current.run_attempt === 1 ? current : await api(`/repos/${repository}/actions/runs/${taskId}/attempts/1`);
  trustedRun(root, repository);
  const allowed = await operators(api, repository, root.head_sha);
  invariant(allowed.includes(root.actor?.login) && allowed.includes(root.triggering_actor?.login), 'untrusted_task_root');
  if (taskPaths.includes(root.path) && /^Codex request [a-z0-9][a-z0-9-]{0,63} \/ request-[a-f0-9]{64}$/.test(root.display_title ?? '')) return root;
  const artifacts = await pages(api, `/repos/${repository}/actions/runs/${root.id}/artifacts`, 'artifacts');
  const matches = artifacts.filter(artifact => artifact.name === recordName('run', taskId, root.id, 1));
  invariant(matches.length === 1, 'unproven_task_root');
  const loaded = await io(matches[0].id, 'record'), record = loaded.value;
  invariant(loaded.artifact.workflow_run?.id === root.id && record.schema_version === 3 && record.repository === repository && record.task_id === taskId &&
    record.execution?.root_run_id === taskId && record.execution.root_run_attempt === '1' && record.execution.continuation_count === 0 &&
    record.lineage?.workflow_ref === `${repository}/${root.path}@refs/heads/main` && record.lineage.workflow_sha === root.head_sha &&
    String(record.lineage.run_id) === taskId && Number(record.lineage.run_attempt) === 1 && record.lineage.actor === root.actor?.login &&
    record.lineage.triggering_actor === root.triggering_actor?.login, 'unproven_task_root');
  executionSettings(record.execution);
  return root;
}
export async function loadVerifiedCheckpoint({ api, io, repository, id, taskId }) {
  try {
    const loaded = await io(id, 'checkpoint'), manifest = validateManifest(loaded.value, { repository, taskId, versions: runnerVersions });
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
    error.details = { ...error.details, artifact_id: positiveId(id) ? Number(id) : null, task_id: typeof taskId === 'string' && taskPattern.test(taskId) ? taskId : null };
    throw error;
  }
}
async function taskRun(api, repository, id, attempt) {
  const run = await api(`/repos/${repository}/actions/runs/${id}`);
  trustedRun(run, repository);
  invariant(run.status === 'completed' && Number(run.run_attempt) === Number(attempt), 'parent_run_active_or_rerun');
  return run;
}
async function verifiedClaim(api, io, repository, artifactId) {
  const loaded = await io(Number(artifactId), 'record'), claim = loaded.value;
  invariant(claim.schema_version === 3 && claim.repository === repository && taskPattern.test(claim.task_id) && shaPattern.test(claim.source_sha) && repositoryPattern.test(claim.source_repository) &&
    positiveId(claim.controller_run_id) && positiveId(claim.controller_run_attempt) && positiveId(claim.parent_run_id) && positiveId(claim.parent_run_attempt) && positiveId(claim.artifact_id) &&
    positiveId(claim.activation_run_id) && positiveId(claim.activation_run_attempt) &&
    claim.dispatch_key === dispatchKey(repository, claim.task_id, { id: Number(claim.parent_run_id), run_attempt: Number(claim.parent_run_attempt) }, claim.artifact_id, claim.continuation_count) && loaded.artifact.name === `codex-claim-${claim.dispatch_key}`, 'invalid_dispatch_claim');
  const controller = await api(`/repos/${repository}/actions/runs/${claim.controller_run_id}/attempts/${claim.controller_run_attempt}`);
  invariant([controllerPath, taskPath].includes(controller.path) && controller.event === 'workflow_run' && controller.head_branch === 'main' && controller.repository?.full_name === repository &&
    controller.head_repository?.full_name === repository && controller.head_sha === claim.controller_sha && Number(controller.run_attempt) === Number(claim.controller_run_attempt) && loaded.artifact.workflow_run?.id === controller.id, 'untrusted_dispatch_claim');
  return claim;
}
async function manualCount(api, repository, manifest, excludedRun, excludedAttempt = 1) {
  const artifacts = await pages(api, `/repos/${repository}/actions/artifacts`, 'artifacts');
  const checkpoints = artifacts.filter(artifact => new RegExp(`^codex-${manifest.task_id}-[1-9][0-9]*-r[1-9][0-9]*-a[1-9][0-9]*$`).test(artifact.name));
  invariant(checkpoints.every(artifact => Number(artifact.name.match(/-([0-9]+)-r/)[1]) <= manifest.sequence), 'stale_manual_checkpoint');
  const runs = await pages(api, `/repos/${repository}/actions/runs?event=workflow_dispatch&branch=main`, 'workflow_runs');
  const previous = runs.filter(run => run.display_title?.startsWith(`Codex task ${manifest.task_id} / `) && run.id > Number(manifest.execution.root_run_id) && String(run.id) !== excludedRun);
  for (const run of previous) { trustedRun(run, repository, taskPaths); invariant(run.status === 'completed', 'task_run_active'); }
  const root = await api(`/repos/${repository}/actions/runs/${manifest.execution.root_run_id}`);
  invariant(root.status === 'completed', 'root_run_active');
  const consumed = previous.reduce((count, run) => count + run.run_attempt, 0) + Math.max(0, root.run_attempt - Number(manifest.execution.root_run_attempt)) + Math.max(0, excludedAttempt - 1);
  const count = Math.max(manifest.execution.continuation_count, consumed) + 1;
  invariant(count <= manifest.execution.max_continuations, 'continuation_limit_exceeded', manifest.execution.max_continuations, count);
  return count;
}
async function inheritedRequest(api, io, repository, parent) {
  const manual = /^Codex task ([a-z0-9][a-z0-9-]{0,63}) \/ manual-resume-([1-9][0-9]*)-([a-f0-9]{40})-([a-f0-9]{64})$/.exec(parent.display_title ?? '');
  const automatic = /^Codex task ([a-z0-9][a-z0-9-]{0,63}) \/ ([a-f0-9]{64})$/.exec(parent.display_title ?? '');
  let loaded, execution;
  if (manual) {
    await authorizeActors(api, repository, parent.actor?.login, parent.triggering_actor?.login);
    loaded = await loadVerifiedCheckpoint({ api, io, repository, id: Number(manual[2]), taskId: manual[1] });
    invariant(manual[3] === loaded.manifest.execution.source_sha, 'manual_resume_source_mismatch');
    execution = { ...loaded.manifest.execution, continuation_count: await manualCount(api, repository, loaded.manifest, String(parent.id), parent.run_attempt),
      activation_run_id: String(parent.id), activation_run_attempt: String(parent.run_attempt), parent_run_id: String(loaded.producer.id), parent_run_attempt: String(loaded.producer.run_attempt) };
  } else if (automatic) {
    invariant(parent.actor?.login === 'github-actions[bot]' && parent.triggering_actor?.login === 'github-actions[bot]' && parent.run_attempt === 1, 'untrusted_inherited_resume');
    const artifacts = await pages(api, `/repos/${repository}/actions/artifacts?name=codex-claim-${automatic[2]}`, 'artifacts');
    const matches = artifacts.filter(artifact => artifact.name === `codex-claim-${automatic[2]}`);
    invariant(matches.length === 1, 'missing_inherited_claim');
    const claim = await verifiedClaim(api, io, repository, matches[0].id);
    invariant(claim.task_id === automatic[1] && claim.dispatch_key === automatic[2], 'inherited_claim_mismatch');
    loaded = await loadVerifiedCheckpoint({ api, io, repository, id: claim.artifact_id, taskId: claim.task_id });
    execution = { ...loaded.manifest.execution, continuation_count: claim.continuation_count, activation_run_id: claim.activation_run_id, activation_run_attempt: claim.activation_run_attempt,
      parent_run_id: claim.parent_run_id, parent_run_attempt: claim.parent_run_attempt };
  } else return null;
  executionSettings(execution);
  const manifest = loaded.manifest;
  return { schema_version: 3, repository, task_id: manifest.task_id, plan_sha256: manifest.plan_sha256, authorization: manifest.authorization, skills: manifest.skills,
    plan_source: manifest.plan_source, execution, lineage: { repository, workflow_sha: parent.head_sha, run_id: String(parent.id), run_attempt: String(parent.run_attempt) },
    resume_artifact_id: Number(manual?.[2] ?? loaded.artifact.id) };
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
  invariant(request.schema_version === 3 && request.repository === repository && taskPattern.test(request.task_id) && String(request.lineage?.run_id) === String(parent.id) &&
    Number(request.lineage?.run_attempt) === Number(parent.run_attempt) && request.lineage?.workflow_sha === parent.head_sha, 'run_request_identity_mismatch');
  const execution = executionSettings(request.execution);
  if ((await stoppedTask(api, repository, request.task_id, execution.activation_run_id, execution.request_id)).stopped) return { eligible: false, reason: 'task_stopped', parent, request };
  await authorizeActivation(api, repository, execution);
  const outcome = await uniqueRecord(io, artifacts, recordName('outcome', request.task_id, parent.id, parent.run_attempt), true);
  if (outcome && (outcome.status !== 'continuing' || outcome.reason !== 'action_budget')) return { eligible: false, reason: `outcome_${outcome.status}`, parent, request };
  if (parent.conclusion === 'success' && !outcome) return { eligible: false, reason: 'missing_budget_handoff', parent, request };
  if (!execution.auto_continue || execution.continuation_count >= execution.max_continuations) return { eligible: false, reason: 'continuation_limit', parent, request };
  const candidates = artifacts.filter(artifact => new RegExp(`^codex-${request.task_id}-[1-9][0-9]*-r${parent.id}-a${parent.run_attempt}$`).test(artifact.name));
  candidates.sort((left, right) => Number(right.name.match(/-([0-9]+)-r/)[1]) - Number(left.name.match(/-([0-9]+)-r/)[1]));
  invariant(candidates.length < 2 || candidates[0].name !== candidates[1].name, 'ambiguous_latest_checkpoint');
  const artifactId = candidates[0]?.id ?? request.resume_artifact_id;
  if (!positiveId(artifactId)) return { eligible: false, reason: 'no_durable_checkpoint', parent, request };
  const loaded = await loadVerifiedCheckpoint({ api, io, repository, id: artifactId, taskId: request.task_id }), manifest = loaded.manifest;
  invariant(same(frozenExecution(execution), frozenExecution(manifest.execution)) && same(request.authorization, manifest.authorization) && same(request.skills, manifest.skills) &&
    request.plan_sha256 === manifest.plan_sha256, 'parent_checkpoint_contract_mismatch');
  invariant(candidates.length ? same(execution, manifest.execution) : Number(request.resume_artifact_id) === Number(artifactId) && execution.continuation_count > manifest.execution.continuation_count, 'inherited_checkpoint_lineage_mismatch');
  if (outcome) invariant(outcome.repository === repository && outcome.task_id === request.task_id && String(outcome.lineage?.run_id) === String(parent.id) &&
    Number(outcome.lineage?.run_attempt) === Number(parent.run_attempt) && outcome.checkpoint?.artifact_id === Number(artifactId) && outcome.checkpoint?.checkpoint_sha === manifest.checkpoint_sha, 'outcome_checkpoint_mismatch');
  if (manifest.branch !== null) {
    const branch = await api(`/repos/${repository}/git/ref/heads/${manifest.branch}`);
    invariant(branch.object?.sha === manifest.checkpoint_sha, 'resume_branch_drift', manifest.checkpoint_sha, branch.object?.sha);
  } else invariant((await api(`/repos/${repository}/commits/${manifest.checkpoint_sha}`)).sha === manifest.checkpoint_sha, 'resume_source_missing');
  const count = execution.continuation_count + 1, key = dispatchKey(repository, request.task_id, parent, Number(artifactId), count);
  return { eligible: true, reason: parent.conclusion === 'timed_out' ? 'native_timeout' : 'action_budget', parent, request, manifest,
    artifact_id: Number(artifactId), continuation_count: count, dispatch_key: key, claim_name: `codex-claim-${key}` };
}
function fields(decision) {
  return { task_id: decision.request?.task_id, root_run_id: decision.request?.execution?.root_run_id, parent_run_id: decision.parent?.id,
    activation_run_id: decision.request?.execution?.activation_run_id, activation_run_attempt: decision.request?.execution?.activation_run_attempt,
    parent_run_attempt: decision.parent?.run_attempt, artifact_id: decision.artifact_id, continuation_count: decision.continuation_count,
    max_continuations: decision.request?.execution?.max_continuations, budget_minutes: decision.request?.execution?.budget_minutes,
    runner: decision.request?.execution?.runner, checkpoint_sha: decision.manifest?.checkpoint_sha, session_id: decision.manifest?.session_id, reason: decision.reason, eligible: decision.eligible };
}
export async function runController({ github, context, core, env = process.env, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  const started = now(), repository = repositoryName(context), api = async (path, options) => (await github.request(`${options?.method ?? 'GET'} ${path}`, options)).data;
  let diagnostic = { parent_run_id: context.payload.workflow_run?.id ?? null };
  try {
    invariant(env.GITHUB_REF === 'refs/heads/main' && context.eventName === 'workflow_run' && env.CODEX_RUNNER_PROTOCOL === '3', 'untrusted_controller_context');
    await verifyProtocol(api, repository);
    const trigger = context.payload.workflow_run;
    const parent = await taskRun(api, repository, trigger.id, trigger.run_attempt);
    invariant(parent.head_sha === trigger.head_sha && parent.workflow_id === trigger.workflow_id && parent.conclusion === trigger.conclusion, 'parent_event_drift');
    const root = join(env.RUNNER_TEMP, `continuation-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}-${env.CONTINUATION_MODE}`), io = createIO(api, repository, root);
    const decision = await continuationDecision({ api, io, repository, parent });
    diagnostic = fields(decision);
    if (!decision.eligible) { logEvent(core, 'continuation.dispatch', 'INFO', { ...diagnostic, outcome: 'stopped', elapsed_ms: now() - started }, env); return { eligible: false }; }
    if (env.CONTINUATION_MODE === 'resolve') return { eligible: true, task_id: decision.request.task_id };
    const existing = await pages(api, `/repos/${repository}/actions/artifacts?name=${decision.claim_name}`, 'artifacts'), claims = existing.filter(artifact => artifact.name === decision.claim_name);
    invariant(claims.length <= 1, 'ambiguous_dispatch_claim');
    if (env.CONTINUATION_MODE === 'prepare') {
      const claim = { schema_version: 3, repository, task_id: decision.request.task_id, dispatch_key: decision.dispatch_key, parent_run_id: String(parent.id), parent_run_attempt: String(parent.run_attempt),
        artifact_id: decision.artifact_id, continuation_count: decision.continuation_count, source_repository: decision.request.execution.source_repository, source_sha: decision.request.execution.source_sha,
        activation_run_id: decision.request.execution.activation_run_id, activation_run_attempt: decision.request.execution.activation_run_attempt,
        controller_run_id: env.GITHUB_RUN_ID, controller_run_attempt: env.GITHUB_RUN_ATTEMPT, controller_sha: env.GITHUB_WORKFLOW_SHA };
      const claimRoot = join(root, 'claim');
      if (!claims.length) { await mkdir(claimRoot, { recursive: true, mode: 0o700 }); await writeFile(join(claimRoot, 'record.json'), JSON.stringify(claim), { mode: 0o600, flag: 'wx' }); }
      logEvent(core, 'continuation.dispatch', 'INFO', { ...diagnostic, outcome: claims.length ? 'reconcile_existing_claim' : 'claim_prepared' }, env);
      return { eligible: true, upload: !claims.length, claim_name: decision.claim_name, claim_path: join(claimRoot, 'record.json'), existing_claim_id: claims[0]?.id ?? '' };
    }
    invariant(env.CONTINUATION_MODE === 'dispatch' && claims.length === 1 && Number(env.CLAIM_ARTIFACT_ID) === claims[0].id, 'dispatch_claim_missing');
    const claim = await verifiedClaim(api, io, repository, claims[0].id);
    invariant(claim.task_id === decision.request.task_id && claim.dispatch_key === decision.dispatch_key && claim.artifact_id === decision.artifact_id && claim.continuation_count === decision.continuation_count &&
      claim.source_sha === decision.request.execution.source_sha && claim.source_repository === decision.request.execution.source_repository && claim.activation_run_id === decision.request.execution.activation_run_id &&
      claim.activation_run_attempt === decision.request.execution.activation_run_attempt, 'dispatch_claim_mismatch');
    const findChild = async () => {
      const runs = await pages(api, `/repos/${repository}/actions/workflows/runner-task.yml/runs?event=workflow_dispatch&branch=main`, 'workflow_runs');
      const matches = runs.filter(run => run.display_title === childRunName(claim.task_id, claim.dispatch_key));
      invariant(matches.length <= 1, 'duplicate_child_runs');
      if (matches.length) { trustedRun(matches[0], repository, [taskPath]); invariant(matches[0].actor?.login === 'github-actions[bot]', 'untrusted_child_actor'); }
      return matches[0];
    };
    let child = await findChild(), dispatchError = null;
    const ownsClaim = claim.controller_run_id === env.GITHUB_RUN_ID && claim.controller_run_attempt === env.GITHUB_RUN_ATTEMPT && env.NEW_CLAIM === 'true';
    if (!child && ownsClaim) {
      await requireActive(api, repository, claim.task_id, claim.activation_run_id, decision.request.execution.request_id);
      await authorizeActivation(api, repository, decision.request.execution);
      const request = { task_id: claim.task_id, source_repository: claim.source_repository, source_sha: claim.source_sha, resume_artifact_id: claim.artifact_id,
        claim_artifact_id: claims[0].id, dispatch_key: claim.dispatch_key, parent_run_id: claim.parent_run_id, parent_run_attempt: claim.parent_run_attempt, continuation_count: claim.continuation_count };
      try { await api(`/repos/${repository}/actions/workflows/runner-task.yml/dispatches`, { method: 'POST', ref: 'main', inputs: { request: JSON.stringify(request) } }); }
      catch (error) { dispatchError = safeError(error); }
    }
    const deadline = now() + 300000;
    while (!child && now() < deadline) { await sleep(Math.min(10000, deadline - now())); child = await findChild(); }
    invariant(child, ownsClaim ? 'ambiguous_dispatch_registration' : 'claimed_dispatch_unreconciled');
    logEvent(core, 'continuation.dispatch', 'INFO', { ...diagnostic, outcome: 'registered', claim_artifact_id: claims[0].id, child_run_id: child.id, child_url: child.html_url,
      workflow: taskPath, ref: 'main', dispatch_error: dispatchError, elapsed_ms: now() - started }, env);
    return { child_run_id: child.id, child_url: child.html_url };
  } catch (error) {
    logEvent(core, 'continuation.dispatch', 'ERROR', { ...diagnostic, outcome: 'blocked', ...safeError(error), ...error.details, elapsed_ms: now() - started,
      corrective_action: 'Inspect parent, checkpoint, stop and claim identities; reconcile existing child runs before recovery.' }, env);
    throw new Error(safeError(error).reason);
  }
}
export async function resolveTaskRequest({ github, context, core, env = process.env }) {
  const started = Date.now(), repository = repositoryName(context), api = async (path, options) => (await github.request(`${options?.method ?? 'GET'} ${path}`, options)).data;
  let request;
  try {
    invariant(env.GITHUB_REF === 'refs/heads/main' && context.eventName === 'workflow_dispatch' && env.CODEX_RUNNER_PROTOCOL === '3', 'untrusted_task_context');
    invariant(typeof env.TASK_REQUEST === 'string' && Buffer.byteLength(env.TASK_REQUEST) <= 65535, 'workflow_input_size_limit');
    try { request = JSON.parse(env.TASK_REQUEST); } catch { invariant(false, 'invalid_task_request'); }
    invariant(request && taskPattern.test(request.resume_artifact_id || request.operation ? request.task_id : request.request_id), 'invalid_task_request');
    if (!request.dispatch_key) invariant(request.registration_key === registrationKey(request), 'request_registration_mismatch', registrationKey(request), request.registration_key);
    const root = join(env.RUNNER_TEMP, `task-request-${env.GITHUB_RUN_ID}-${env.GITHUB_JOB}`), io = createIO(api, repository, root);
    let parameters;
    if (request.operation === 'stop') {
      await authorizeActors(api, repository, context.actor, env.TRIGGERING_ACTOR);
      invariant(Number(env.GITHUB_RUN_ATTEMPT) === 1, 'stop_rerun_requires_new_request');
      invariant(typeof request.stop_key === 'string' && /^[a-f0-9]{32}$/.test(request.stop_key), 'invalid_stop_request');
      if (positiveId(request.task_id)) await verifiedTaskRoot(api, io, repository, request.task_id);
      parameters = { operation: 'stop', task_id: request.task_id, stop_key: request.stop_key };
    } else if (request.resume_artifact_id) {
      invariant(Object.keys(request).every(key => ['task_id', 'source_repository', 'source_sha', 'published_ref', 'resume_artifact_id', 'claim_artifact_id', 'dispatch_key', 'parent_run_id', 'parent_run_attempt', 'continuation_count', 'activation_key', 'registration_key'].includes(key)), 'resume_settings_changed');
      const bot = context.actor === 'github-actions[bot]' && env.TRIGGERING_ACTOR === 'github-actions[bot]';
      if (!bot) await authorizeActors(api, repository, context.actor, env.TRIGGERING_ACTOR);
      const loaded = await loadVerifiedCheckpoint({ api, io, repository, id: request.resume_artifact_id, taskId: request.task_id }), manifest = loaded.manifest;
      invariant(request.source_sha === manifest.execution.source_sha && request.source_repository === manifest.execution.source_repository, 'manual_resume_source_mismatch');
      invariant((request.published_ref ?? null) === manifest.execution.published_ref, 'published_resume_reference_changed');
      invariant(!request.published_ref || env.GITHUB_WORKFLOW_REF === `${repository}/${publishedPath}@refs/heads/main`, 'published_workflow_required');
      await verifyProtocol(api, repository, manifest.execution.auto_continue);
      let execution;
      if (bot) {
        invariant(Number(env.GITHUB_RUN_ATTEMPT) === 1 && positiveId(request.claim_artifact_id), 'automatic_rerun_refused');
        const claim = await verifiedClaim(api, io, repository, request.claim_artifact_id), parent = await taskRun(api, repository, request.parent_run_id, request.parent_run_attempt);
        const decision = await continuationDecision({ api, io, repository, parent });
        invariant(decision.eligible && request.dispatch_key === decision.dispatch_key && request.continuation_count === decision.continuation_count && request.resume_artifact_id === decision.artifact_id &&
          claim.dispatch_key === decision.dispatch_key && claim.task_id === manifest.task_id && claim.source_sha === request.source_sha && claim.artifact_id === request.resume_artifact_id &&
          claim.activation_run_id === decision.request.execution.activation_run_id && claim.activation_run_attempt === decision.request.execution.activation_run_attempt, 'invalid_child_claim');
        const runs = await pages(api, `/repos/${repository}/actions/workflows/runner-task.yml/runs?event=workflow_dispatch&branch=main`, 'workflow_runs');
        const siblings = runs.filter(run => run.display_title === childRunName(request.task_id, request.dispatch_key));
        invariant(siblings.length === 1 && String(siblings[0].id) === env.GITHUB_RUN_ID, 'duplicate_child_refused');
        execution = { ...manifest.execution, continuation_count: decision.continuation_count, activation_run_id: decision.request.execution.activation_run_id,
          activation_run_attempt: decision.request.execution.activation_run_attempt, parent_run_id: String(parent.id), parent_run_attempt: String(parent.run_attempt) };
      } else {
        invariant(!request.dispatch_key && !request.claim_artifact_id, 'untrusted_child_claim');
        invariant(typeof request.activation_key === 'string' && /^[a-f0-9]{32}$/.test(request.activation_key), 'invalid_resume_activation');
        execution = { ...manifest.execution, continuation_count: await manualCount(api, repository, manifest, env.GITHUB_RUN_ID, Number(env.GITHUB_RUN_ATTEMPT)), activation_run_id: env.GITHUB_RUN_ID, activation_run_attempt: env.GITHUB_RUN_ATTEMPT,
          parent_run_id: String(loaded.producer.id), parent_run_attempt: String(loaded.producer.run_attempt) };
      }
      executionSettings(execution);
      await requireActive(api, repository, manifest.task_id, execution.activation_run_id, execution.request_id);
      parameters = { operation: 'execute', task_id: manifest.task_id, source_repository: execution.source_repository, source_sha: execution.source_sha, resume_artifact_id: request.resume_artifact_id,
        published_ref: execution.published_ref ?? '',
        authorization: manifest.authorization, plan: '', skills: manifest.skills, execution, runner: execution.runner,
        git_author_name: execution.git_author_name, git_author_email: execution.git_author_email, user_agents_url: execution.user_agents_url ?? '', user_agents_sha256: execution.user_agents_sha256 ?? '' };
    } else {
      await authorizeActors(api, repository, context.actor, env.TRIGGERING_ACTOR);
      invariant(Number(env.GITHUB_RUN_ATTEMPT) === 1, 'initial_rerun_requires_explicit_resume');
      invariant(Object.keys(request).every(key => ['request_id', 'source_repository', 'source_sha', 'plan', 'plan_sha256', 'skills', 'runner', 'git_author_name', 'git_author_email',
        'budget_minutes', 'max_continuations', 'auto_continue', 'user_agents_url', 'user_agents_sha256', 'project_config', 'qualification_artifact_id', 'published_ref', 'registration_key'].includes(key)), 'unsupported_task_input');
      const prior = await pages(api, `/repos/${repository}/actions/runs?event=workflow_dispatch&branch=main`, 'workflow_runs');
      invariant(!prior.some(run => String(run.id) !== env.GITHUB_RUN_ID && run.display_title?.startsWith(`Codex request ${request.request_id} / `)), 'request_already_registered');
      invariant(await latestStop(api, repository, request.request_id) === 0, 'request_stopped');
      invariant(!request.operation && repositoryPattern.test(request.source_repository) && shaPattern.test(request.source_sha), 'invalid_task_request');
      invariant((await api(`/repos/${request.source_repository}/commits/${request.source_sha}`)).sha === request.source_sha, 'action_source_mismatch');
      invariant(typeof request.plan === 'string' && request.plan.trim() && Buffer.byteLength(request.plan) <= 1024 * 1024 && digest(request.plan) === request.plan_sha256,
        'plan_hash_mismatch', request.plan_sha256, typeof request.plan === 'string' ? digest(request.plan) : null);
      invariant(request.project_config && shaPattern.test(request.project_config.revision), 'missing_project_config');
      const config = await readProjectConfig(api, repository, env.GITHUB_WORKFLOW_SHA, request.project_config.sha256);
      invariant(config.snapshot.content === request.project_config.content, 'project_config_hash_mismatch');
      const settings = config.settings, selected = sources(request.skills ?? []);
      if (request.qualification_artifact_id) {
        const registry = await io(request.qualification_artifact_id, 'record');
        const run = await api(`/repos/${repository}/actions/runs/${registry.artifact.workflow_run.id}`);
        trustedRun(run, repository, ['.github/workflows/runner-acceptance.yml']);
        const allowed = await operators(api, repository, run.head_sha);
        invariant(registry.value.repository === repository && String(run.id) === registry.value.run_id && run.head_sha === request.project_config.revision &&
          registry.artifact.name === `linux-qualification-${run.id}-registry` && registry.value.source_sha === request.source_sha &&
          allowed.includes(run.actor?.login) && allowed.includes(run.triggering_actor?.login), 'untrusted_qualification_request');
        const task = [...(registry.value.tasks ?? []), ...(registry.value.published_tasks ?? [])].find(task => task.task_id === request.request_id);
        invariant(task && same(request.runner, task.labels) && request.budget_minutes === 5 && request.max_continuations === 3 &&
          (request.published_ref ?? null) === (task.published_ref ?? null) && (!request.published_ref || ['v1-prerelease', 'v1'].includes(request.published_ref) &&
            request.source_repository === repository && registry.value.action?.requested_ref === request.published_ref && registry.value.action?.sha === request.source_sha &&
            positiveId(registry.value.action?.release_id) && env.GITHUB_WORKFLOW_REF === `${repository}/${publishedPath}@refs/heads/main`) &&
          request.auto_continue === (task.scenario === 'deadline') && request.git_author_name === registry.value.author && request.git_author_email === registry.value.email &&
          selected.length === 0 && request.user_agents_url === null, 'qualification_settings_mismatch');
      } else {
        invariant(!request.published_ref, 'published_qualification_required');
        for (const key of ['runner', 'budget_minutes', 'max_continuations', 'auto_continue', 'git_author_name', 'git_author_email', 'user_agents_url'])
          invariant(same(request[key], settings[key]), 'project_settings_mismatch');
        invariant(selected.length === settings.skills.length && selected.every((source, index) => {
          const configured = settings.skills[index], original = typeof configured === 'string' ? configured : configured.repository;
          const name = original.replace(/^https:\/\/github\.com\//, '').replace(/\/$/, '').replace(/\.git$/, '');
          return source.repository === name && (typeof configured === 'string' ||
            (!configured.names || same(source.names, configured.names)) && (!shaPattern.test(configured.ref) || configured.ref === source.revision));
        }), 'project_skills_mismatch');
      }
      await verifyProtocol(api, repository, request.auto_continue);
      invariant(!request.auto_continue || env.GITHUB_WORKFLOW_REF === `${repository}/${taskPath}@refs/heads/main`, 'continuation_workflow_required');
      const taskId = env.GITHUB_RUN_ID;
      invariant(positiveId(taskId), 'invalid_task_identity');
      const auth = authorization({ repository, plan_sha256: request.plan_sha256, request: request.plan }, repository, request.plan);
      const execution = executionSettings({ source_repository: request.source_repository, source_sha: request.source_sha, runner: runnerLabels(request.runner), auto_continue: request.auto_continue,
        max_continuations: request.max_continuations, continuation_count: 0, budget_minutes: request.budget_minutes, root_run_id: taskId, root_run_attempt: env.GITHUB_RUN_ATTEMPT,
        activation_run_id: taskId, activation_run_attempt: env.GITHUB_RUN_ATTEMPT, parent_run_id: null, parent_run_attempt: null, git_author_name: request.git_author_name, git_author_email: request.git_author_email,
        user_agents_url: request.user_agents_url, user_agents_sha256: request.user_agents_sha256, project_config: request.project_config, request_id: request.request_id, published_ref: request.published_ref ?? null });
      await requireActive(api, repository, taskId, execution.activation_run_id, execution.request_id);
      parameters = { operation: 'execute', task_id: taskId, source_repository: request.source_repository, source_sha: request.source_sha, resume_artifact_id: '', authorization: auth,
        published_ref: execution.published_ref ?? '',
        plan: request.plan, skills: selected, execution, runner: execution.runner,
        git_author_name: execution.git_author_name, git_author_email: execution.git_author_email, user_agents_url: execution.user_agents_url ?? '', user_agents_sha256: execution.user_agents_sha256 ?? '' };
    }
    invariant(env.GITHUB_WORKFLOW_REF !== `${repository}/${publishedPath}@refs/heads/main` || parameters.published_ref, 'published_qualification_required');
    logEvent(core, 'submission.resolve', 'INFO', { outcome: 'verified', operation: parameters.operation, task_id: parameters.task_id, source_sha: parameters.source_sha,
      source_repository: parameters.source_repository, artifact_id: parameters.resume_artifact_id || null, actor: context.actor, runner: parameters.runner ?? null, elapsed_ms: Date.now() - started }, env);
    return parameters;
  } catch (error) {
    logEvent(core, 'submission.resolve', 'ERROR', { outcome: 'rejected',
      task_id: typeof request?.task_id === 'string' && taskPattern.test(request.task_id) ? request.task_id : positiveId(env.GITHUB_RUN_ID) ? env.GITHUB_RUN_ID : null,
      submission_id: typeof request?.request_id === 'string' && taskPattern.test(request.request_id) ? request.request_id : null,
      artifact_id: positiveId(request?.resume_artifact_id) ? Number(request.resume_artifact_id) : null, ...safeError(error), ...error.details, elapsed_ms: Date.now() - started,
      corrective_action: 'Resolve the rejected actor, frozen input, protocol or lineage invariant before execution.' }, env);
    throw new Error(safeError(error).reason);
  }
}
export async function prepareTaskRequest(args) {
  const resolved = await resolveTaskRequest(args);
  if (resolved.operation === 'stop') return resolved;
  return { ...resolved, authorization: JSON.stringify(resolved.authorization), skills: JSON.stringify(resolved.skills),
    execution: JSON.stringify(resolved.execution), runner: JSON.stringify(resolved.runner) };
}
export async function stopTask({ github, context, core, env = process.env }) {
  const repository = repositoryName(context), api = async (path, options) => (await github.request(`${options?.method ?? 'GET'} ${path}`, options)).data;
  const request = await resolveTaskRequest({ github, context, core, env });
  invariant(request.operation === 'stop', 'invalid_stop_request');
  const root = join(env.RUNNER_TEMP, `stop-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}`), file = join(root, 'record.json');
  await mkdir(root, { mode: 0o700 });
  await writeFile(file, JSON.stringify({ schema_version: 3, repository, task_id: request.task_id, actor: context.actor, run_id: env.GITHUB_RUN_ID, run_attempt: env.GITHUB_RUN_ATTEMPT,
    workflow_sha: env.GITHUB_WORKFLOW_SHA, stop_key: request.stop_key }), { mode: 0o600, flag: 'wx' });
  return { task_id: request.task_id, name: recordName('stop', request.task_id, env.GITHUB_RUN_ID, env.GITHUB_RUN_ATTEMPT), file };
}
export async function cancelTaskRuns({ github, context, core, taskId, env = process.env }) {
  const repository = repositoryName(context), api = async (path, options) => (await github.request(`${options?.method ?? 'GET'} ${path}`, options)).data;
  try {
    await authorizeActors(api, repository, context.actor, env.TRIGGERING_ACTOR);
    invariant(taskPattern.test(taskId), 'invalid_task_id');
    const io = createIO(api, repository, join(env.RUNNER_TEMP, `cancel-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}`));
    if (positiveId(taskId)) await verifiedTaskRoot(api, io, repository, taskId);
    const runs = await pages(api, `/repos/${repository}/actions/runs`, 'workflow_runs');
    const identities = new Set([taskId]);
    for (const run of runs.filter(run => taskPaths.includes(run.path) && run.display_title?.startsWith(`Codex request ${taskId} / `))) {
      await verifiedTaskRoot(api, io, repository, String(run.id)); identities.add(String(run.id));
    }
    const belongs = run => identities.has(String(run.id)) || taskPaths.includes(run.path) && [...identities].some(id =>
      run.display_title?.startsWith(`Codex task ${id} / `) || run.display_title?.startsWith(`Codex request ${id} / `));
    const parents = new Set(runs.filter(belongs).map(run => String(run.id)));
    const matched = runs.filter(run => run.status !== 'completed' && (identities.has(String(run.id)) || [...taskPaths, controllerPath].includes(run.path)) && run.head_branch === 'main' &&
      (belongs(run) || parents.has(/^Codex continuation \/ ([0-9]+)$/.exec(run.display_title ?? '')?.[1])));
    for (const run of matched) {
      try { await api(`/repos/${repository}/actions/runs/${run.id}/cancel`, { method: 'POST' }); }
      catch (error) { const current = await api(`/repos/${repository}/actions/runs/${run.id}`); if (current.status !== 'completed') throw error; }
    }
    logEvent(core, 'submission.stop', 'INFO', { task_id: taskId, stop_run_id: env.GITHUB_RUN_ID, cancelled_run_ids: matched.map(run => run.id),
      outcome: 'cancellation_requested', corrective_action: 'Automatic children are fenced by the stop request; only a new explicit manual resume can reactivate this task.' }, env);
    return matched.map(run => run.id);
  } catch (error) {
    logEvent(core, 'submission.stop', 'ERROR', { task_id: taskPattern.test(taskId) ? taskId : null, stop_run_id: env.GITHUB_RUN_ID,
      outcome: 'cancellation_failed', ...safeError(error), corrective_action: 'Inspect run permissions and retry cancellation; the stop request continues to fence automatic dispatch.' }, env);
    throw new Error(safeError(error).reason);
  }
}
