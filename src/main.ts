import * as core from "@actions/core";
import { lstat, readFile, realpath } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { authorize, hash, parseJson, requireValue, RunnerError, shaPattern, skillSources } from "./contracts.js";
import { isolatedCheckpoint, isolatedRecord } from "./checkpoint-worker.js";
import { DurableCheckpoint } from "./checkpoint.js";
import { Diagnostics } from "./diagnostics.js";
import { drive } from "./driver.js";
import { TaskGit } from "./git.js";
import { command } from "./process.js";
import { configure, createJob, fetchSkillSource, installSkillSource, installTools, installUserAgents, removeJob, Job } from "./setup.js";
import { verifyResumeSettings } from "./continuation.js";
import { loadCheckpoint, restoreCheckpoint } from "./resume.js";
import { positiveId, taskPattern } from "./platform/checkpoint-policy.mjs";
import { authorizeActivation, requireActive } from "./platform/continuation-policy.mjs";
import { fetchInstructions } from "./platform/instructions.mjs";
import { invocationSource, prepareInvocation } from "./invocation.js";

export function selectPlanSource(plan: string, resume = "") {
  requireValue(Boolean(plan.trim()) !== Boolean(resume.trim()), "exactly_one_plan_source_required");
  if (resume) { requireValue(positiveId(resume), "invalid_artifact_id"); return { plan: null, resumeArtifactId: Number(resume) }; }
  requireValue(Buffer.byteLength(plan) <= 1024 * 1024, "plan_size_limit");
  return { plan, resumeArtifactId: undefined };
}
export async function main() {
  const started = Date.now();
  let job: Job | undefined, latestCheckpoint: DurableCheckpoint | null = null, runRecord: any = null, cancelled = false;
  const cancel = () => { cancelled = true; if (job) job.env.CODEX_TASK_CANCELLED = "1"; };
  process.on("SIGINT", cancel); process.on("SIGTERM", cancel);
  const log = new Diagnostics({ repository: process.env.GITHUB_REPOSITORY, run_id: process.env.GITHUB_RUN_ID, run_attempt: process.env.GITHUB_RUN_ATTEMPT,
    workflow_sha: process.env.GITHUB_WORKFLOW_SHA, retention_days: process.env.GITHUB_RETENTION_DAYS });
  const get = (name: string, required = false) => core.getInput(name, { required, trimWhitespace: false });
  try {
    requireValue(process.platform === "linux" && ["x64", "arm64"].includes(process.arch) && Number(process.versions.node.split(".")[0]) === 24, "unsupported_platform", "setup");
    if (get("permission-mode").trim()) throw new RunnerError("unsupported_mode_input", "preflight", "Execution is always YOLO; remove the retired permission-mode input.");
    const repository = process.env.GITHUB_REPOSITORY ?? "";
    requireValue(/^[\w.-]+\/[\w.-]+$/.test(repository) && process.env.GITHUB_SERVER_URL === "https://github.com", "unsupported_repository");
    const token = get("github-token", true), key = get("codex-api-key", true), config = get("codex-config", true);
    for (const secret of [token, key, config, Buffer.from(`x-access-token:${token}`).toString("base64")]) log.protect(secret);
    for (const name of ["ACTIONS_RUNTIME_TOKEN", "ACTIONS_ID_TOKEN_REQUEST_TOKEN"]) if (process.env[name]) log.protect(process.env[name]!);
    requireValue(token.length >= 8 && key.length >= 8, "invalid_credential_input");
    const workspace = await realpath(process.env.GITHUB_WORKSPACE ?? process.cwd()), cwd = await realpath(resolve(workspace, get("working-directory") || "."));
    requireValue(cwd === workspace || cwd.startsWith(workspace + sep), "workspace_escape");
    job = await createJob(process.env.RUNNER_TEMP ?? "/tmp", key, token, "github-actions[bot]", "41898282+github-actions[bot]@users.noreply.github.com");
    const currentJob = job;
    let exchange = 0;
    const api = async (path: string, options?: any): Promise<any> => {
      const endpoint = path.replace(/^\//, ""), args = ["api", endpoint];
      if (options?.method) args.push("--method", options.method);
      const { method, ...body } = options ?? {};
      if (Object.keys(body).length) args.push("--input", "-");
      const zip = endpoint.endsWith("/zip"), file = join(currentJob.staging, `api-${++exchange}.zip`);
      const output = await command("gh", args, { cwd, env: currentJob.env, stage: "preflight_api", log, stdin: Object.keys(body).length ? JSON.stringify(body) : undefined, ...(zip ? { stdoutFile: file } : {}) });
      return zip ? readFile(file) : parseJson(output, "github_api");
    };
    const actionRoot = resolve(import.meta.dirname, "..");
    const installedSource = await invocationSource(api, actionRoot, process.env, args => command("git", args, { cwd: actionRoot, env: currentJob.env, stage: "action_source", log }));
    const verified = await prepareInvocation({ api, source: installedSource, plan: get("plan"), resumeRunId: get("resume-run-id"), core, env: { ...process.env, RUNNER_TEMP: job.staging } });
    const execution = verified.execution;
    const source = selectPlanSource(verified.plan, String(verified.resumeArtifactId));
    const taskId = verified.taskId;
    requireValue(taskPattern.test(taskId), "invalid_task_id");
    Object.assign(job.env, { GIT_AUTHOR_NAME: execution.git_author_name, GIT_COMMITTER_NAME: execution.git_author_name,
      GIT_AUTHOR_EMAIL: execution.git_author_email, GIT_COMMITTER_EMAIL: execution.git_author_email,
      CODEX_TASK_DEADLINE_MS: String(started + execution.budget_minutes * 60000) });
    await configure(job, config, log);
    log.fields = { ...log.fields, platform: process.platform, architecture: process.arch, source_repository: execution.source_repository, action_source_sha: execution.source_sha,
      budget_minutes: execution.budget_minutes, root_run_id: execution.root_run_id, parent_run_id: execution.parent_run_id, continuation_count: execution.continuation_count,
      max_continuations: execution.max_continuations, user_agents_sha256: execution.user_agents_sha256,
      project_config_sha256: execution.project_config?.sha256, project_config_revision: execution.project_config?.revision };
    let selected = skillSources(verified.skills);
    let restored: Awaited<ReturnType<typeof loadCheckpoint>> | undefined;
    if (source.resumeArtifactId) {
      restored = await loadCheckpoint(job, path => api(path), repository, source.resumeArtifactId, log, taskId);
      verifyResumeSettings(restored.manifest.execution, execution);
      selected = skillSources(restored.manifest.skills);
    }
    const plan = restored?.manifest.plan ?? source.plan;
    requireValue(typeof plan === "string", "missing_plan");
    const authorization = authorize(verified.authorization, repository, plan);
    let userAgents = restored?.manifest.user_agents ?? null;
    if (!restored && execution.user_agents_url) {
      try { userAgents = await fetchInstructions(execution.user_agents_url, execution.user_agents_sha256!); }
      catch (error: any) { throw new RunnerError(error.reason ?? "user_agents_download_failed", "instructions", "The approved user instructions could not be provisioned.", error.details); }
    }
    log.fields = { ...log.fields, task_id: taskId, plan_sha256: hash(plan), actor: process.env.GITHUB_ACTOR, skills: selected };
    const git = new TaskGit(cwd, job.env, log);
    requireValue((await git.run(["rev-parse", "--show-toplevel"])).trim() === cwd && await git.changedPaths() === "", "unsafe_worktree");
    const origin = (await git.run(["remote", "get-url", "origin"])).trim();
    requireValue(origin === `https://github.com/${repository}.git` || origin === `https://github.com/${repository}`, "origin_identity_mismatch");
    if (!restored) {
      const path = join(cwd, 'remote-codex.yml'), stat = await lstat(path);
      requireValue(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 65536 && hash(await readFile(path)) === execution.project_config?.sha256, 'checkout_project_config_mismatch');
    }
    await command("python3", ["-c", "import sys; assert sys.version_info >= (3,12)"], { cwd, env: job.env, stage: "python_version", log });
    await installTools(job, resolve(import.meta.dirname, ".."), log);
    for (const [index, skill] of selected.entries()) await installSkillSource(job, skill, await fetchSkillSource(job, skill, index, log), index, log);
    await installUserAgents(job, userAgents, log);
    if (restored) { await restoreCheckpoint(job, restored.root, restored.manifest, git, log); latestCheckpoint = restored.receipt; }
    const base = restored?.manifest.base_sha ?? await git.head();
    requireValue(shaPattern.test(base), "invalid_initial_revision");
    const lineage = { repository, workflow_ref: process.env.GITHUB_WORKFLOW_REF, workflow_sha: process.env.GITHUB_WORKFLOW_SHA, run_id: process.env.GITHUB_RUN_ID,
      run_attempt: process.env.GITHUB_RUN_ATTEMPT, actor: process.env.GITHUB_ACTOR,
      triggering_actor: process.env.TRIGGERING_ACTOR || process.env.GITHUB_TRIGGERING_ACTOR || process.env.GITHUB_ACTOR,
      runner_labels: process.env.CODEX_RUNNER_LABELS ? parseJson(process.env.CODEX_RUNNER_LABELS, "runner_metadata") : null };
    runRecord = { schema_version: 3, repository, task_id: taskId, initial_sha: base, plan_sha256: hash(plan), authorization, execution, lineage, skills: selected, invocation: installedSource, runner_labels: lineage.runner_labels,
      plan_source: restored?.manifest.plan_source ?? "inline", resume_artifact_id: restored?.receipt.artifact_id ?? null };
    await isolatedRecord(job, "run", runRecord, log);
    await requireActive(api, repository, taskId, execution.activation_run_id, execution.request_id);
    await authorizeActivation(api, repository, execution);
    for (const [name, value] of Object.entries({ "base-sha": base, "root-run-id": execution.root_run_id,
      "parent-run-id": execution.parent_run_id ?? "", "continuation-count": execution.continuation_count })) core.setOutput(name, value);
    const result = await drive({ job, git, log, plan, planSource: runRecord.plan_source, authorization, repository, taskId, base, skills: selected, userAgents,
      budgetMs: execution.budget_minutes * 60000, started, execution, cancelled: () => cancelled, lineage,
      resume: restored ? { session: restored.manifest.session_id, checkpoint: restored.receipt } : undefined,
      checkpoint: async input => {
        await requireActive(api, repository, taskId, execution.activation_run_id, execution.request_id);
        const receipt = await isolatedCheckpoint(currentJob, cwd, input, log, sha => git.verify(sha));
        latestCheckpoint = receipt;
        core.setOutput("checkpoint-sha", receipt.checkpoint_sha); core.setOutput("artifact-id", receipt.artifact_id); core.setOutput("branch", input.branch ?? "");
        return receipt;
      },
      result: async value => {
        const receipt = await isolatedRecord(currentJob, "result", { schema_version: 3, repository, task_id: taskId, lineage, ...value }, log);
        core.setOutput("result-artifact-id", receipt.artifact_id);
      },
    });
    core.setOutput("status", result.status); core.setOutput("session-id", result.session ?? "");
    core.setOutput("native-outcome", result.nativeOutcome);
    await isolatedRecord(job, "outcome", { schema_version: 3, repository, task_id: taskId, lineage, status: result.status, reason: result.reason, native_outcome: result.nativeOutcome, checkpoint: result.checkpoint }, log);
    if (!["completed", "continuing"].includes(result.status)) core.setFailed(`Native invocation ${result.status}; inspect infrastructure diagnostics and the selected skill's result.`);
  } catch (error) {
    log.failure(error, latestCheckpoint);
    core.setOutput("status", cancelled ? "cancelled" : "failed");
    core.setFailed("Runner infrastructure failed; inspect structured diagnostics and retain the last durable checkpoint.");
    if (job && runRecord) {
      try { await isolatedRecord(job, "outcome", { schema_version: 3, repository: runRecord.repository, task_id: runRecord.task_id, lineage: runRecord.lineage,
        status: cancelled ? "cancelled" : "failed", reason: error instanceof RunnerError ? error.reason : "infrastructure_failed", checkpoint: latestCheckpoint }, log); }
      catch (recordError) { log.failure(recordError, latestCheckpoint); }
    }
  } finally {
    process.removeListener("SIGINT", cancel); process.removeListener("SIGTERM", cancel);
    if (job) { await removeJob(job.root); log.event("runtime.cleanup", "INFO", { outcome: "removed_job_temporary_files" }); }
  }
}
