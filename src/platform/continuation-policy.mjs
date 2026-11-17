import { join } from 'node:path';
import { checkpointBytes, invariant, positiveId, validateManifest, validateProducer } from './checkpoint-policy.mjs';
import { readArtifact } from './artifact-io.mjs';
import { pages } from './sources.mjs';
import { authorizeActors } from './project-config.mjs';
import { logEvent } from './runtime-log.mjs';
export { authorizeActors } from './project-config.mjs';
export { pages } from './sources.mjs';

export const githubAPI = github => async (path, options = {}) => {
  const { method = 'GET', ...data } = options;
  return (await github.request(`${method} ${path}`, data)).data;
};
export async function executionJob(api, repository, run) {
  const jobs = await pages(api, `/repos/${repository}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs`, 'jobs');
  const matches = jobs.filter(job => job.steps?.some(step => step.name === 'Execute agent'));
  invariant(matches.length === 1, 'execution_job_unavailable');
  return matches[0];
}
export function nativeTimedOut(job) {
  const native = job.steps?.find(step => step.name === 'Execute agent');
  const laterStepRan = job.steps?.some(step => step.number > native?.number && step.started_at && step.conclusion !== 'skipped');
  return job.status === 'completed' && job.conclusion === 'timed_out' && Boolean(native?.started_at) &&
    (['timed_out', 'cancelled'].includes(native.conclusion) || native.conclusion === 'failure' && !laterStepRan);
}
export async function loadRunCheckpoint(api, repository, runId, root, runnerVersion, runner) {
  invariant(positiveId(runId), 'invalid_resume_run_id');
  const run = await api(`/repos/${repository}/actions/runs/${runId}`);
  invariant(String(run.id) === String(runId) && run.repository?.full_name === repository && run.head_repository?.full_name === repository &&
    run.event === 'workflow_dispatch', 'untrusted_parent_run');
  const artifacts = await pages(api, `/repos/${repository}/actions/runs/${runId}/artifacts`, 'artifacts');
  const pattern = new RegExp(`^remote-dev-session-r${runId}-a${run.run_attempt}-([1-9][0-9]*)$`);
  const candidates = artifacts.filter(artifact => pattern.test(artifact.name)).sort((a, b) => Number(b.name.match(pattern)[1]) - Number(a.name.match(pattern)[1]));
  invariant(candidates.length || !artifacts.some(artifact => /^codex-session-/.test(artifact.name)), 'legacy_checkpoint_unsupported');
  invariant(candidates.length > 0, 'run_checkpoint_unavailable');
  invariant(candidates.length < 2 || candidates[0].name !== candidates[1].name, 'ambiguous_latest_checkpoint');
  const loaded = await readArtifact({ api, repository, id: candidates[0].id, root, kind: 'checkpoint' });
  const manifest = validateManifest(loaded.value, { repository, runner, runnerVersion });
  validateProducer(loaded.artifact, run, manifest, repository);
  return { ...loaded, manifest, run };
}
export async function pruneSnapshots(api, repository, runId, attempt, keep = 2) {
  const artifacts = await pages(api, `/repos/${repository}/actions/runs/${runId}/artifacts`, 'artifacts');
  const pattern = new RegExp(`^remote-dev-session-r${runId}-a${attempt}-([1-9][0-9]*)$`);
  const owned = artifacts.filter(artifact => pattern.test(artifact.name)).sort((a, b) => Number(b.name.match(pattern)[1]) - Number(a.name.match(pattern)[1]));
  for (const artifact of owned.slice(keep)) await api(`/repos/${repository}/actions/artifacts/${artifact.id}`, { method: 'DELETE' });
}
export async function prepareExecution({ api, repository, runId, attempt, actor, triggeringActor = actor, ref, resumeRunId = '', plan = '', root, runner = 'codex', runnerVersion }) {
  invariant(['codex', 'claude'].includes(runner), 'invalid_runner');
  const run = await api(`/repos/${repository}/actions/runs/${runId}`);
  invariant(run.event === 'workflow_dispatch' && run.repository?.full_name === repository && Number(run.run_attempt) === Number(attempt), 'untrusted_task_context');
  let restored, operator = actor, autoCount = 0;
  if (resumeRunId) restored = await loadRunCheckpoint(api, repository, resumeRunId, root, runnerVersion, runner);
  if (actor === 'github-actions[bot]') {
    invariant(triggeringActor === actor && Number(attempt) === 1 && restored && restored.run.workflow_id === run.workflow_id &&
      Number(restored.run.run_attempt) === 1 && nativeTimedOut(await executionJob(api, repository, restored.run)), 'untrusted_automatic_resume');
    invariant(['running', 'cancelled'].includes(restored.manifest.outcome), 'native_already_finished');
    operator = restored.manifest.operator;
    autoCount = restored.manifest.auto_count + 1;
  }
  const config = await authorizeActors(api, repository, operator, actor === 'github-actions[bot]' ? operator : triggeringActor);
  invariant(ref === `refs/heads/${config.branch}` && run.head_branch === config.branch, 'untrusted_task_context');
  invariant(typeof plan === 'string' && Buffer.byteLength(plan) <= 65535 && (resumeRunId || plan.trim()), 'invalid_plan');
  if (restored) {
    invariant(restored.run.head_branch === config.branch && restored.run.workflow_id === run.workflow_id, 'resume_workflow_mismatch');
    if (actor === 'github-actions[bot]') invariant(config.settings.auto_continue && autoCount <= config.settings.max_continuations, 'continuation_limit_exceeded');
    else invariant(restored.run.status === 'completed', 'checkpoint_producer_active');
  }
  return { settings: config.settings, source_sha: config.revision, config_sha256: config.snapshot.sha256,
    root_run_id: restored?.manifest.root_run_id ?? String(runId), activation_run_id: actor === 'github-actions[bot]' ? restored.manifest.activation_run_id : String(runId),
    auto_count: autoCount, operator, lineage: { run_id: String(runId), run_attempt: String(attempt), workflow_id: run.workflow_id,
      workflow_path: run.path, workflow_sha: run.head_sha, branch: config.branch }, restored };
}
export async function recoverExecution({ api, repository, runId, attempt, root, core }) {
  const stop = reason => { logEvent(core, 'continuation.dispatch', 'INFO', { reason, outcome: 'stopped' }); return { dispatched: false, reason }; };
  if (Number(attempt) !== 1) return stop('automatic_rerun_refused');
  const run = await api(`/repos/${repository}/actions/runs/${runId}`);
  const job = await executionJob(api, repository, run);
  if (!nativeTimedOut(job)) return stop('native_not_timed_out');
  const loaded = await loadRunCheckpoint(api, repository, runId, root);
  const { manifest } = loaded;
  if (!['running', 'cancelled'].includes(manifest.outcome)) return stop('native_already_finished');
  const config = await authorizeActors(api, repository, manifest.operator);
  invariant(run.head_branch === config.branch, 'untrusted_parent_run');
  if (!config.settings.auto_continue) return stop('automatic_continuation_disabled');
  if (manifest.auto_count >= config.settings.max_continuations) return stop('continuation_limit_exceeded');
  const latestJob = await executionJob(api, repository, await api(`/repos/${repository}/actions/runs/${runId}`));
  invariant(nativeTimedOut(latestJob) && latestJob.id === job.id, 'parent_execution_changed');
  // Dispatch once per parent attempt; an uncertain response is never retried automatically.
  await api(`/repos/${repository}/actions/workflows/${run.workflow_id}/dispatches`, { method: 'POST', ref: config.branch,
    inputs: { runner: manifest.runner, 'resume-run-id': String(runId), plan: '' } });
  logEvent(core, 'continuation.dispatch', 'INFO', { parent_run_id: runId, parent_attempt: attempt, workflow_id: run.workflow_id,
    artifact_id: loaded.artifact.id, continuation_count: manifest.auto_count + 1, outcome: 'requested' });
  return { dispatched: true };
}
