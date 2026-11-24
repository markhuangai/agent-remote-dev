import * as core from "@actions/core";
import { lstat, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { requireValue, versions, parseJson, projectStorageKey, RunnerError } from "./contracts.js";
import { uploadSnapshot, startSnapshots, waitSnapshots, saveSnapshot, latestSnapshot } from "./checkpoint-worker.js";
import { inspectCredentials, CheckpointInput, DurableCheckpoint } from "./checkpoint.js";
import { Diagnostics } from "./diagnostics.js";
import { drive } from "./driver.js";
import { TaskGit } from "./git.js";
import { command } from "./process.js";
import { configure, createJob, fetchSkillSource, installSkillSource, installTools, installUserInstructions, removeJob, Job } from "./setup.js";
import { restoreCheckpoint } from "./resume.js";
import { githubAPI, prepareExecution } from "./platform/continuation-policy.mjs";
import { resolveSkills } from "./platform/sources.mjs";
import { fetchInstructions } from "./platform/instructions.mjs";
import { runnerInputs } from "./runners.js";

export type SavedRun = { control?: { directory: string; nonce: string }; watcher_pid?: number; job: Job; metadata: CheckpointInput;
  secrets: string[]; response: string; latest: DurableCheckpoint | null; skip_final_snapshot?: boolean };
export async function main({ github }: { github: any }) {
  let saved: SavedRun | undefined, pendingJob: Job | undefined;
  const log = new Diagnostics({ repository: process.env.GITHUB_REPOSITORY, run_id: process.env.GITHUB_RUN_ID, run_attempt: process.env.GITHUB_RUN_ATTEMPT });
  try {
    requireValue(process.platform === "linux" && ["x64", "arm64"].includes(process.arch) && Number(process.versions.node.split(".")[0]) === 24, "unsupported_platform", "setup");
    const { runner, token, key, config, mcp } = runnerInputs(process.env);
    log.fields = { ...log.fields, runner, runner_version: versions[runner] };
    for (const secret of [token, key, config, mcp, Buffer.from(`x-access-token:${token}`).toString("base64"), process.env.ACTIONS_RUNTIME_TOKEN, process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN]) if (secret) log.protect(secret);
    const workspace = await realpath(process.env.GITHUB_WORKSPACE!), cwd = await realpath(join(workspace, "target"));
    requireValue(cwd.startsWith(workspace + sep), "workspace_escape");
    const job = pendingJob = await createJob(process.env.RUNNER_TEMP!, key, token, "github-actions[bot]", "41898282+github-actions[bot]@users.noreply.github.com", process.env, runner);
    const statePath = join(job.root, "state.json"); core.setOutput("state-path", statePath);
    const api = githubAPI(github), repository = process.env.GITHUB_REPOSITORY!;
    const prepared = await prepareExecution({ api, repository, runId: process.env.GITHUB_RUN_ID, attempt: process.env.GITHUB_RUN_ATTEMPT,
      actor: process.env.GITHUB_ACTOR, triggeringActor: process.env.TRIGGERING_ACTOR, ref: process.env.GITHUB_REF,
      resumeRunId: process.env.REMOTE_DEV_RESUME_RUN_ID ?? '', plan: process.env.REMOTE_DEV_PLAN ?? '', root: job.staging, runner, runnerVersion: versions[runner] });
    if (runner === "claude") job.env.CLAUDE_CODE_PROJECT_DIR_NAME = projectStorageKey(repository, prepared.root_run_id);
    const settings = prepared.settings;
    Object.assign(job.env, { GIT_AUTHOR_NAME: settings.git_author_name, GIT_COMMITTER_NAME: settings.git_author_name,
      GIT_AUTHOR_EMAIL: settings.git_author_email, GIT_COMMITTER_EMAIL: settings.git_author_email });
    const git = new TaskGit(cwd, job.env, log);
    requireValue((await git.run(["rev-parse", "--show-toplevel"])).trim() === cwd && !await git.changedPaths(), "unsafe_worktree");
    const origin = (await git.run(["remote", "get-url", "origin"])).trim();
    requireValue([`https://github.com/${repository}.git`, `https://github.com/${repository}`].includes(origin), "origin_identity_mismatch");
    const restored = prepared.restored;
    const configureCheckout = () => configure(job, config, log, mcp, cwd);
    if (restored) await restoreCheckpoint(job, restored.root, restored.manifest, git, log, configureCheckout);
    else await configureCheckout();
    await installTools(job, resolve(import.meta.dirname, ".."), log);
    const skillAPI = async (path: string) => parseJson(await command("gh", ["api", path.replace(/^\//, '')], { cwd, env: job.env, stage: "skill_source", log }), "skills");
    const skills = await resolveSkills(skillAPI, settings.skills);
    for (const [index, skill] of skills.entries()) await installSkillSource(job, skill, await fetchSkillSource(job, skill, index, log), index, log);
    const userInstructions = settings.user_instructions_url ? await fetchInstructions(settings.user_instructions_url) : null;
    await installUserInstructions(job, userInstructions, log);
    const metadata: CheckpointInput = { repository, ...await git.snapshot(), session_id: restored?.manifest.session_id ?? '',
      root_run_id: prepared.root_run_id, activation_run_id: prepared.activation_run_id, auto_count: prepared.auto_count, operator: prepared.operator, provider_sha: process.env.REMOTE_DEV_PROVIDER_SHA,
      lineage: prepared.lineage, outcome: "running", workspace: cwd };
    saved = { job, metadata, secrets: log.protectedValues, response: '', latest: null };
    const state = saved;
    let writes = Promise.resolve();
    const persist = () => { writes = writes.then(async () => {
      await writeFile(statePath + ".tmp", JSON.stringify(state), { mode: 0o600 }); await rename(statePath + ".tmp", statePath);
    }); return writes; };
    await persist();
    state.watcher_pid = await startSnapshots(statePath, job); await persist();
    let logged = 0;
    const flushLogs = async () => {
      let content;
      try { content = await readFile(join(job.root, "snapshots.log"), "utf8"); } catch (error: any) { if (error.code === 'ENOENT') return; throw error; }
      const end = content.lastIndexOf("\n") + 1;
      for (const line of content.slice(logged, end).split("\n").filter(line => line.startsWith("{"))) core.info(line);
      logged = end;
    };
    const logs = setInterval(() => { void flushLogs(); }, 1000); logs.unref();
    log.fields = { ...log.fields, session_id: metadata.session_id, root_run_id: metadata.root_run_id, continuation_count: metadata.auto_count,
      project_config_sha256: prepared.config_sha256, skills, user_instructions_sha256: userInstructions?.sha256 ?? null };
    let prompt = process.env.REMOTE_DEV_PLAN ?? '';
    if (restored) prompt = `Continue this conversation using the current repository configuration. The checkout is the published revision ${restored.manifest.checkpoint_sha}. ` +
      (prepared.automatic_recovery === "native_worker_sigkill"
        ? "The previous worker was interrupted. Verify published work and any external effects before repeating an operation. " : "") +
      (restored.manifest.omitted_work ? 'Uncommitted or unpushed work from the previous runner was not restored; inspect the checkout and recreate missing work as needed. ' : '') +
      `\n\nAdditional context:\n${prompt || 'Continue the unfinished task.'}`;
    const result = await drive({ job, cwd, log, plan: prompt, session: restored?.manifest.session_id,
      state: async value => {
        if (value.session) { metadata.session_id = value.session; log.fields.session_id = value.session; }
        if (value.control) state.control = { directory: value.control.directory, nonce: value.control.nonce };
        metadata.outcome = value.outcome as CheckpointInput['outcome']; await persist();
      } });
    clearInterval(logs); await flushLogs();
    state.response = result.response;
    state.skip_final_snapshot = result.reason === "snapshot_resume_failed";
    if (result.reason === "native_worker_sigkill") state.metadata.recovery_reason = result.reason;
    await persist();
    core.setOutput("session-id", result.session ?? ''); core.setOutput("status", result.outcome);
    if (result.outcome !== 'completed') core.setFailed(`Native invocation ${result.outcome}; inspect the saved session and diagnostics.`);
  } catch (error) {
    log.failure(error, saved?.latest);
    if (saved) {
      saved.metadata.outcome = "failed";
      delete saved.metadata.recovery_reason;
      await writeFile(join(saved.job.root, "state.json"), JSON.stringify(saved), { mode: 0o600 });
    }
    if (!saved && pendingJob) await removeJob(pendingJob.root);
    core.setFailed("Remote development failed; inspect structured diagnostics.");
  }
}

function filesystemCause(error: unknown) {
  const { code, syscall } = (error instanceof Error ? error : {}) as NodeJS.ErrnoException;
  return { errno_code: typeof code === "string" && /^E[A-Z0-9]{2,25}$/.test(code) ? code : null,
    syscall: syscall && ["chmod", "lstat", "mkdir", "open", "read", "rename", "rmdir", "scandir", "unlink", "write"].includes(syscall) ? syscall : null };
}

export async function finish({ github, statePath }: { github: any; statePath: string }) {
  if (!statePath) return;
  const temporary = await realpath(process.env.RUNNER_TEMP!), path = resolve(statePath);
  requireValue(path.startsWith(temporary + sep) && /\/remote-dev-task-[^/]+\/state\.json$/.test(path) && !(await lstat(path)).isSymbolicLink(), "unsafe_final_state");
  let saved: SavedRun;
  try { saved = JSON.parse(await readFile(path, "utf8")); }
  catch (error: any) { if (error.code === 'ENOENT') return; throw error; }
  const host = process.env.RUNNER_ENVIRONMENT;
  const runnerEnvironment = host === "github-hosted" || host === "self-hosted" ? host : "unknown";
  const { lineage } = saved.metadata;
  const log = new Diagnostics({ repository: saved.metadata.repository, runner: saved.job.runner, runner_version: versions[saved.job.runner],
    run_id: lineage.run_id, run_attempt: lineage.run_attempt, session_id: saved.metadata.session_id, workflow_sha: lineage.workflow_sha,
    root_run_id: saved.metadata.root_run_id, runner_environment: runnerEnvironment });
  for (const secret of saved.secrets) log.protect(secret);
  const api = githubAPI(github), uploadContext = { api, metadata: saved.metadata };
  const exportStarted = Date.now();
  let finalCheckpoint: DurableCheckpoint | null = null, resultArtifactId: number | null = null, exportSucceeded = false;
  try {
    await waitSnapshots(saved);
    saved.latest = await latestSnapshot(saved.job);
    const workerLog = await readFile(join(saved.job.root, "snapshots.log"), "utf8").catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
    for (const line of workerLog.split("\n").filter(line => line.startsWith("{"))) core.info(line);
    if (saved.skip_final_snapshot) {
      log.event("checkpoint.final", "WARN", { outcome: "skipped", reason: "snapshot_resume_failed", last_durable_checkpoint: saved.latest });
    } else if (saved.metadata.session_id) {
      finalCheckpoint = await saveSnapshot(saved, log, api, (job, name, files, root, diagnostics) =>
        uploadSnapshot(job, name, files, root, diagnostics, undefined, { ...uploadContext, kind: "checkpoint" }));
      saved.latest = finalCheckpoint;
    }
    if (saved.latest) core.setOutput("artifact-id", saved.latest.artifact_id);
    inspectCredentials(saved.response, log, "credential_in_result");
    const file = join(saved.job.exports, "record.json"); await writeFile(file, JSON.stringify({ runner: saved.job.runner, runner_version: versions[saved.job.runner], response: saved.response, native_outcome: saved.metadata.outcome, session_id: saved.metadata.session_id }), { mode: 0o600 });
    const result = await uploadSnapshot(saved.job, `remote-dev-result-r${lineage.run_id}-a${lineage.run_attempt}`, [file], saved.job.exports,
      log, undefined, { ...uploadContext, kind: "record" });
    resultArtifactId = result.id;
    await core.summary.addTable([["Outcome", "Session", "Saved artifact"], [saved.metadata.outcome, saved.metadata.session_id || "unavailable", String(saved.latest?.artifact_id ?? "unavailable")]]).write();
    exportSucceeded = true;
  } catch (error) {
    const failure = error instanceof RunnerError ? error : null;
    log.event("runtime.failed", "ERROR", { stage: failure?.stage ?? "final_export", reason: failure?.reason ?? "final_export_failed",
      cause_reason: failure?.details.cause_reason, ...filesystemCause(error), outcome: "failed",
      last_durable_checkpoint: saved.latest, result_artifact_id: resultArtifactId, elapsed_ms: Date.now() - exportStarted,
      corrective_action: "Inspect the export failure and use the last completed snapshot to resume by run ID." });
    core.setFailed("Final session export failed; retain the last completed snapshot.");
  } finally {
    const cleanupStarted = Date.now();
    const fields = { stage: "cleanup", native_outcome: saved.metadata.outcome, export_succeeded: exportSucceeded,
      last_durable_checkpoint: saved.latest, final_checkpoint_artifact_id: finalCheckpoint?.artifact_id ?? null, result_artifact_id: resultArtifactId };
    log.event("runtime.cleanup", "INFO", { ...fields, outcome: "started" });
    try {
      await removeJob(saved.job.root);
    } catch (error) {
      const warning = runnerEnvironment === "github-hosted" && exportSucceeded && finalCheckpoint !== null && resultArtifactId !== null;
      log.event(warning ? "runtime.cleanup" : "runtime.failed", warning ? "WARN" : "ERROR", {
        ...fields, ...filesystemCause(error), reason: "job_cleanup_failed", outcome: "failed", elapsed_ms: Date.now() - cleanupStarted,
        corrective_action: warning ? "The artifacts are available. Inspect directory ownership and permissions if cleanup fails again."
          : "Inspect runner directory ownership and permissions before reusing the runner. Resume by run ID if a completed snapshot is available.",
      });
      if (!warning) core.setFailed("Temporary job cleanup failed; inspect structured diagnostics.");
    }
  }
}
