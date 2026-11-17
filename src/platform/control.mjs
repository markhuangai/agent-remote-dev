import { join } from 'node:path';
import { githubAPI, prepareExecution, recoverExecution } from './continuation-policy.mjs';
import { safeError, logEvent } from './runtime-log.mjs';

export async function workflowCommand(mode, { github, core, env = process.env }) {
  const api = githubAPI(github), repository = env.GITHUB_REPOSITORY;
  try {
    const common = { api, repository, runId: env.GITHUB_RUN_ID, attempt: env.GITHUB_RUN_ATTEMPT,
      root: join(env.RUNNER_TEMP, `codex-${mode}-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}`) };
    if (mode === 'recover') return await recoverExecution({ ...common, core,
      inputs: { 'runs-on': env.CODEX_RUNS_ON, 'timeout-minutes': env.CODEX_TIMEOUT_MINUTES } });
    const prepared = await prepareExecution({ ...common, actor: env.GITHUB_ACTOR, triggeringActor: env.TRIGGERING_ACTOR, ref: env.GITHUB_REF,
      resumeRunId: env.CODEX_RESUME_RUN_ID ?? '', plan: env.CODEX_PLAN ?? '' });
    for (const [name, value] of Object.entries({ root_run_id: prepared.root_run_id, source_sha: prepared.source_sha })) core.setOutput(name, value);
    logEvent(core, 'submission.resolve', 'INFO', { root_run_id: prepared.root_run_id, config_sha256: prepared.config_sha256, outcome: 'authorized' }, env);
    return prepared;
  } catch (error) {
    logEvent(core, 'submission.workflow', 'ERROR', { ...safeError(error), outcome: 'blocked' }, env);
    core.setFailed('Remote Codex preparation failed; inspect structured diagnostics.');
    return null;
  }
}
