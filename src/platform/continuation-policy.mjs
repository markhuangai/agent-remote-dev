import { invariant, positiveId, validateManifest, validateProducer } from './checkpoint-policy.mjs';
import { readArtifact } from './artifact-io.mjs';
import { pages } from './sources.mjs';
import { authorizeActors } from './project-config.mjs';
import { logEvent, safeError } from './runtime-log.mjs';
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

function recoveryTrigger(run, job) {
  if (run.conclusion === 'cancelled') return null;
  if (nativeTimedOut(job)) return 'native_timeout';
  if (job.status !== 'completed' || job.conclusion !== 'failure') return null;

  const native = job.steps?.filter(step => step.name === 'Execute agent') ?? [];
  const final = job.steps?.filter(step => step.name === 'Save final session') ?? [];
  if (native.length === 1 && final.length === 1 &&
    native[0].status === 'completed' && native[0].started_at && native[0].conclusion === 'failure' &&
    final[0].status === 'completed' && final[0].started_at && final[0].conclusion === 'success' && final[0].number > native[0].number) {
    return 'native_worker_sigkill';
  }
  return null;
}

function checkpointCanContinue(trigger, manifest) {
  if (trigger === 'native_timeout') return ['running', 'cancelled'].includes(manifest.outcome);
  return trigger === 'native_worker_sigkill' && manifest.outcome === 'failed' && manifest.recovery_reason === trigger;
}

async function latestCheckpoint(api, repository, run) {
  const artifacts = await pages(api, `/repos/${repository}/actions/runs/${run.id}/artifacts`, 'artifacts');
  const pattern = new RegExp(`^remote-dev-session-r${run.id}-a${run.run_attempt}-([1-9][0-9]*)$`);
  const candidates = artifacts.filter(artifact => pattern.test(artifact.name)).sort((a, b) => Number(b.name.match(pattern)[1]) - Number(a.name.match(pattern)[1]));
  invariant(candidates.length || !artifacts.some(artifact => /^codex-session-/.test(artifact.name)), 'legacy_checkpoint_unsupported');
  invariant(candidates.length > 0, 'run_checkpoint_unavailable');
  invariant(candidates.length < 2 || candidates[0].name !== candidates[1].name, 'ambiguous_latest_checkpoint');
  return candidates[0];
}

export async function loadRunCheckpoint(api, repository, runId, root, runnerVersion, runner) {
  invariant(positiveId(runId), 'invalid_resume_run_id');
  const run = await api(`/repos/${repository}/actions/runs/${runId}`);
  invariant(String(run.id) === String(runId) && run.repository?.full_name === repository && run.head_repository?.full_name === repository &&
    run.event === 'workflow_dispatch', 'untrusted_parent_run');
  const candidate = await latestCheckpoint(api, repository, run);
  const loaded = await readArtifact({ api, repository, id: candidate.id, root, kind: 'checkpoint' });
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
  let restored, automaticRecovery, operator = actor, autoCount = 0;
  if (resumeRunId) restored = await loadRunCheckpoint(api, repository, resumeRunId, root, runnerVersion, runner);
  if (actor === 'github-actions[bot]') {
    invariant(triggeringActor === actor && Number(attempt) === 1 && restored && restored.run.workflow_id === run.workflow_id &&
      Number(restored.run.run_attempt) === 1, 'untrusted_automatic_resume');
    automaticRecovery = recoveryTrigger(restored.run, await executionJob(api, repository, restored.run));
    invariant(automaticRecovery, 'untrusted_automatic_resume');
    invariant(checkpointCanContinue(automaticRecovery, restored.manifest), 'checkpoint_not_automatically_resumable');
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
    auto_count: autoCount, automatic_recovery: automaticRecovery, operator, lineage: { run_id: String(runId), run_attempt: String(attempt), workflow_id: run.workflow_id,
      workflow_path: run.path, workflow_sha: run.head_sha, branch: config.branch }, restored };
}
export async function recoverExecution({ api, repository, runId, attempt, root, core, env = process.env }) {
  const started = Date.now();
  const evidence = { stage: 'continuation', repository, run_id: runId, run_attempt: attempt, parent_run_id: runId, parent_attempt: attempt };
  const report = (level, fields) => logEvent(core, 'continuation.dispatch', level, { ...evidence, ...fields, elapsed_ms: Date.now() - started }, env);
  const stop = reason => { report('INFO', { reason, outcome: 'stopped' }); return { dispatched: false, reason }; };
  let dispatchAttempted = false;
  try {
    if (Number(attempt) !== 1) return stop('automatic_rerun_refused');
    const runPath = `/repos/${repository}/actions/runs/${runId}`;
    const run = await api(runPath);
    if (String(run.id) !== String(runId) || Number(run.run_attempt) !== Number(attempt)) return stop('parent_attempt_changed');
    const job = await executionJob(api, repository, run);
    const trigger = recoveryTrigger(run, job);
    Object.assign(evidence, { workflow_id: run.workflow_id, parent_job_id: job.id, job_conclusion: job.conclusion,
      native_conclusion: job.steps.find(step => step.name === 'Execute agent')?.conclusion,
      final_save_conclusion: job.steps.find(step => step.name === 'Save final session')?.conclusion, trigger });
    if (!trigger) return stop('native_not_recoverable');

    const loaded = await loadRunCheckpoint(api, repository, runId, root);
    invariant(loaded.run.run_attempt === run.run_attempt && loaded.run.head_sha === run.head_sha, 'parent_execution_changed');
    const { manifest } = loaded;
    Object.assign(evidence, { artifact_id: loaded.artifact.id, checkpoint_sha: manifest.checkpoint_sha,
      session_id: manifest.session_id, runner: manifest.runner, runner_version: manifest.runner_version,
      native_outcome: manifest.outcome, recovery_reason: manifest.recovery_reason, continuation_count: manifest.auto_count });
    if (!checkpointCanContinue(trigger, manifest)) return stop(trigger === 'native_timeout' ? 'native_already_finished' : 'native_interruption_unconfirmed');
    const config = await authorizeActors(api, repository, manifest.operator);
    invariant(run.head_branch === config.branch, 'untrusted_parent_run');
    const { auto_continue, max_continuations } = config.settings;
    Object.assign(evidence, { operator: manifest.operator, auto_continue, max_continuations });
    if (!auto_continue) return stop('automatic_continuation_disabled');
    if (manifest.auto_count >= max_continuations) return stop('continuation_limit_exceeded');

    const latestRun = await api(runPath);
    invariant(latestRun.id === run.id && latestRun.run_attempt === run.run_attempt && latestRun.head_sha === run.head_sha, 'parent_execution_changed');
    const latestJob = await executionJob(api, repository, latestRun);
    invariant(latestJob.id === job.id && recoveryTrigger(latestRun, latestJob) === trigger, 'parent_execution_changed');
    if (trigger === 'native_worker_sigkill') {
      const candidate = await latestCheckpoint(api, repository, latestRun);
      invariant(candidate.id === loaded.artifact.id && candidate.name === loaded.artifact.name &&
        !candidate.expired && Date.parse(candidate.expires_at) > Date.now(), 'recovery_checkpoint_changed');
    }

    // An uncertain dispatch response is never retried automatically.
    dispatchAttempted = true;
    await api(`/repos/${repository}/actions/workflows/${run.workflow_id}/dispatches`, { method: 'POST', ref: config.branch,
      inputs: { runner: manifest.runner, 'resume-run-id': String(runId), plan: '' } });
    report('INFO', { reason: trigger, continuation_count: manifest.auto_count + 1, outcome: 'requested' });
    return { dispatched: true };
  } catch (error) {
    report('ERROR', { ...safeError(error), dispatch_attempted: dispatchAttempted, outcome: dispatchAttempted ? 'unconfirmed' : 'blocked' });
    throw error;
  }
}
