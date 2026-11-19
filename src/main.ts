import * as core from "@actions/core";
import { lstat, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { requireValue, versions, parseJson, projectStorageKey } from "./contracts.js";
import { uploadSnapshot, startSnapshots, waitSnapshots, saveSnapshot, latestSnapshot } from "./checkpoint-worker.js";
import { durableCheckpoint, inspectCredentials, CheckpointInput, DurableCheckpoint } from "./checkpoint.js";
import { Diagnostics } from "./diagnostics.js";
import { drive } from "./driver.js";
import { TaskGit } from "./git.js";
import { command } from "./process.js";
import { configure, createJob, fetchSkillSource, installSkillSource, installTools, installUserInstructions, removeJob, Job } from "./setup.js";
import { restoreCheckpoint } from "./resume.js";
import { githubAPI, prepareExecution, pruneSnapshots } from "./platform/continuation-policy.mjs";
import { resolveSkills } from "./platform/sources.mjs";
import { fetchInstructions } from "./platform/instructions.mjs";
import { runnerInputs } from "./runners.js";

export type SavedRun = { control?: { directory: string; nonce: string }; watcher_pid?: number; job: Job; metadata: CheckpointInput; secrets: string[]; response: string; latest: DurableCheckpoint | null };
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
      (restored.manifest.omitted_work ? 'Uncommitted or unpushed work from the previous runner was not restored; inspect the checkout and recreate missing work as needed. ' : '') +
      `\n\nAdditional context:\n${prompt || 'Continue the unfinished task.'}`;
    const result = await drive({ job, cwd, log, plan: prompt, session: restored?.manifest.session_id,
      state: async value => {
        if (value.session) { metadata.session_id = value.session; log.fields.session_id = value.session; }
        if (value.control) state.control = { directory: value.control.directory, nonce: value.control.nonce };
        metadata.outcome = value.outcome as CheckpointInput['outcome']; await persist();
      } });
    clearInterval(logs); await flushLogs();
    state.response = result.response; await persist();
    core.setOutput("session-id", result.session ?? ''); core.setOutput("status", result.outcome);
    if (result.outcome !== 'completed') core.setFailed(`Native invocation ${result.outcome}; inspect the saved session and diagnostics.`);
  } catch (error) {
    log.failure(error, saved?.latest);
    if (saved) { saved.metadata.outcome = "failed"; await writeFile(join(saved.job.root, "state.json"), JSON.stringify(saved), { mode: 0o600 }); }
    if (!saved && pendingJob) await removeJob(pendingJob.root);
    core.setFailed("Remote development failed; inspect structured diagnostics.");
  }
}
export async function finish({ github, statePath }: { github: any; statePath: string }) {
  if (!statePath) return;
  const temporary = await realpath(process.env.RUNNER_TEMP!), path = resolve(statePath);
  requireValue(path.startsWith(temporary + sep) && /\/remote-dev-task-[^/]+\/state\.json$/.test(path) && !(await lstat(path)).isSymbolicLink(), "unsafe_final_state");
  let saved: SavedRun;
  try { saved = JSON.parse(await readFile(path, "utf8")); }
  catch (error: any) { if (error.code === 'ENOENT') return; throw error; }
  const log = new Diagnostics({ repository: saved.metadata.repository, runner: saved.job.runner, runner_version: versions[saved.job.runner], run_id: saved.metadata.lineage.run_id, session_id: saved.metadata.session_id });
  for (const secret of saved.secrets) log.protect(secret);
  try {
    await waitSnapshots(saved);
    saved.latest = await latestSnapshot(saved.job);
    const workerLog = await readFile(join(saved.job.root, "snapshots.log"), "utf8").catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
    for (const line of workerLog.split("\n").filter(line => line.startsWith("{"))) core.info(line);
    if (saved.metadata.session_id) {
      const receipt = await saveSnapshot(saved, log, githubAPI(github));
      saved.latest = receipt; core.setOutput("artifact-id", receipt.artifact_id);
    }
    inspectCredentials(saved.response, log, "credential_in_result");
    const file = join(saved.job.exports, "record.json"); await writeFile(file, JSON.stringify({ runner: saved.job.runner, runner_version: versions[saved.job.runner], response: saved.response, native_outcome: saved.metadata.outcome, session_id: saved.metadata.session_id }), { mode: 0o600 });
    await uploadSnapshot(saved.job, `remote-dev-result-r${saved.metadata.lineage.run_id}-a${saved.metadata.lineage.run_attempt}`, [file], saved.job.exports, log);
    await core.summary.addTable([["Outcome", "Session", "Saved artifact"], [saved.metadata.outcome, saved.metadata.session_id || "unavailable", String(saved.latest?.artifact_id ?? "unavailable")]]).write();
  } catch (error) { log.failure(error, saved.latest); core.setFailed("Final session export failed; retain the last completed snapshot."); }
  finally { await removeJob(saved.job.root); }
}
