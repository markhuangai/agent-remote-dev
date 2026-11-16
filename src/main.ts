import * as core from "@actions/core";
import { randomUUID } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { authorize, hash, parseJson, requireValue, RunnerError, shaPattern, skillSources } from "./contracts.js";
import { isolatedCheckpoint, isolatedRecord } from "./checkpoint-worker.js";
import { DurableCheckpoint } from "./checkpoint.js";
import { Diagnostics } from "./diagnostics.js";
import { drive } from "./driver.js";
import { TaskGit } from "./git.js";
import { command } from "./process.js";
import { configure, createJob, fetchSkillSource, installSkillSource, installTools, installUserAgents, removeJob, Job } from "./setup.js";
import { parseExecution, verifyResumeSettings } from "./continuation.js";
import { loadCheckpoint, restoreCheckpoint } from "./resume.js";
import { positiveId, taskPattern } from "../.github/remote-codex/checkpoint-policy.mjs";
import { prepareTaskRequest, requireActive, verifyIssuePlan } from "../.github/remote-codex/continuation-policy.mjs";
import { fetchInstructions } from "../.github/remote-codex/instructions.mjs";

export function selectPlanSource(plan: string, issue: string, repository: string, resume = "") {
  requireValue([plan, issue, resume].filter(value => value.trim()).length === 1, "exactly_one_plan_source_required");
  if (resume) { requireValue(positiveId(resume), "invalid_artifact_id"); return { plan: null, issueNumber: null, resumeArtifactId: Number(resume) }; }
  if (plan.trim()) { requireValue(Buffer.byteLength(plan) <= 1024 * 1024, "plan_size_limit"); return { plan, issueNumber: null }; }
  const prefix = `https://github.com/${repository}/issues/`;
  requireValue(issue.startsWith(prefix) && /^[1-9][0-9]*$/.test(issue.slice(prefix.length)), "invalid_issue_url");
  return { plan: null, issueNumber: issue.slice(prefix.length) };
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
    const source = selectPlanSource(get("plan"), get("issue-url"), repository, get("resume-artifact-id"));
    requireValue(taskPattern.test(get("task-id")), "invalid_task_id");
    log.fields.task_id = get("task-id");
    const execution = parseExecution(get("continuation-context", true), { source_repository: get("action-source-repository") || "markhuangai/agent-remote-dev-codex", source_sha: get("action-source-sha", true),
      runner: parseJson(get("runner-labels") || '["ubuntu-latest"]', "runner"), auto_continue: true, max_continuations: 3, continuation_count: 0, budget_minutes: 300,
      root_run_id: process.env.GITHUB_RUN_ID ?? "", root_run_attempt: process.env.GITHUB_RUN_ATTEMPT ?? "", activation_run_id: process.env.GITHUB_RUN_ID ?? "", parent_run_id: null, parent_run_attempt: null,
      git_author_name: get("git-author-name", true), git_author_email: get("git-author-email", true), user_agents_url: get("user-agents-url") || null, user_agents_sha256: get("user-agents-sha256") || null });
    requireValue(execution.source_sha === get("action-source-sha") && execution.source_repository === get("action-source-repository") && execution.git_author_name === get("git-author-name") &&
      execution.git_author_email === get("git-author-email"), "execution_input_mismatch");
    job = await createJob(process.env.RUNNER_TEMP ?? "/tmp", key, token, execution.git_author_name, execution.git_author_email);
    const currentJob = job;
    job.env.CODEX_TASK_DEADLINE_MS = String(started + execution.budget_minutes * 60000);
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
    const [owner, repo] = repository.split("/");
    const verified = await prepareTaskRequest({ github: { request: async (route: string, options?: any) => ({ data: await api(route.replace(/^[A-Z]+ /, ""), options) }) },
      context: { repo: { owner, repo }, actor: process.env.GITHUB_ACTOR, eventName: process.env.GITHUB_EVENT_NAME }, core,
      env: { ...process.env, RUNNER_TEMP: job.staging, TASK_REQUEST: get("task-request", true) } });
    requireValue(verified.operation === "execute" && verified.execution === JSON.stringify(execution) && verified.task_id === get("task-id") && verified.source_sha === execution.source_sha &&
      verified.authorization === get("authorization") && verified.skills === get("skills") && verified.plan === get("plan") && verified.issue_url === get("issue-url") &&
      String(verified.resume_artifact_id) === get("resume-artifact-id"), "trusted_request_input_mismatch");
    requireValue((await api(`/repos/${execution.source_repository}/commits/${execution.source_sha}`)).sha === execution.source_sha, "action_source_mismatch");
    await configure(job, config, log);
    log.fields = { ...log.fields, platform: process.platform, architecture: process.arch, source_repository: execution.source_repository, action_source_sha: execution.source_sha,
      runner: execution.runner, budget_minutes: execution.budget_minutes, root_run_id: execution.root_run_id, parent_run_id: execution.parent_run_id, continuation_count: execution.continuation_count,
      max_continuations: execution.max_continuations, user_agents_sha256: execution.user_agents_sha256 };
    let selected = skillSources(get("skills") || "[]");
    let restored: Awaited<ReturnType<typeof loadCheckpoint>> | undefined;
    if (source.resumeArtifactId) {
      restored = await loadCheckpoint(job, path => api(path), repository, source.resumeArtifactId, log, get("task-id"));
      verifyResumeSettings(restored.manifest.execution, execution);
      selected = skillSources(JSON.stringify(restored.manifest.skills));
    }
    const plan = restored?.manifest.plan ?? (source.issueNumber ? await verifyIssuePlan(api, repository, get("issue-url")) : source.plan);
    requireValue(typeof plan === "string", "missing_plan");
    const authorization = authorize(get("authorization", true), repository, plan);
    let userAgents = restored?.manifest.user_agents ?? null;
    if (!restored && execution.user_agents_url) {
      try { userAgents = await fetchInstructions(execution.user_agents_url, execution.user_agents_sha256!); }
      catch (error: any) { throw new RunnerError(error.reason ?? "user_agents_download_failed", "instructions", "The approved user instructions could not be provisioned.", error.details); }
    }
    const taskId = restored?.manifest.task_id ?? (get("task-id") || randomUUID());
    requireValue(taskPattern.test(taskId), "invalid_task_id");
    log.fields = { ...log.fields, task_id: taskId, plan_sha256: hash(plan), actor: process.env.GITHUB_ACTOR, skills: selected };
    const git = new TaskGit(cwd, job.env, log);
    requireValue((await git.run(["rev-parse", "--show-toplevel"])).trim() === cwd && await git.changedPaths() === "", "unsafe_worktree");
    const origin = (await git.run(["remote", "get-url", "origin"])).trim();
    requireValue(origin === `https://github.com/${repository}.git` || origin === `https://github.com/${repository}`, "origin_identity_mismatch");
    await command("python3", ["-c", "import sys; assert sys.version_info >= (3,12)"], { cwd, env: job.env, stage: "python_version", log });
    await installTools(job, resolve(import.meta.dirname, ".."), log);
    for (const [index, skill] of selected.entries()) await installSkillSource(job, skill, await fetchSkillSource(job, skill, index, log), index, log);
    await installUserAgents(job, userAgents, log);
    if (restored) { await restoreCheckpoint(job, restored.root, restored.manifest, git, log); latestCheckpoint = restored.receipt; }
    const base = restored?.manifest.base_sha ?? await git.head();
    requireValue(shaPattern.test(base), "invalid_initial_revision");
    const lineage = { repository, workflow_ref: process.env.GITHUB_WORKFLOW_REF, workflow_sha: process.env.GITHUB_WORKFLOW_SHA, run_id: process.env.GITHUB_RUN_ID,
      run_attempt: process.env.GITHUB_RUN_ATTEMPT, actor: process.env.GITHUB_ACTOR, triggering_actor: process.env.TRIGGERING_ACTOR };
    runRecord = { schema_version: 3, repository, task_id: taskId, initial_sha: base, plan_sha256: hash(plan), authorization, execution, lineage, skills: selected,
      plan_source: restored?.manifest.plan_source ?? (source.issueNumber ? get("issue-url") : "inline"), resume_artifact_id: restored?.receipt.artifact_id ?? null };
    await isolatedRecord(job, "run", runRecord, log);
    await requireActive(api, repository, taskId, execution.activation_run_id);
    for (const [name, value] of Object.entries({ "task-id": taskId, "base-sha": base, "root-run-id": execution.root_run_id,
      "parent-run-id": execution.parent_run_id ?? "", "continuation-count": execution.continuation_count })) core.setOutput(name, value);
    const result = await drive({ job, git, log, plan, planSource: runRecord.plan_source, authorization, repository, taskId, base, skills: selected, userAgents,
      budgetMs: execution.budget_minutes * 60000, started, execution, cancelled: () => cancelled, lineage,
      resume: restored ? { session: restored.manifest.session_id, checkpoint: restored.receipt } : undefined,
      checkpoint: async input => {
        await requireActive(api, repository, taskId, execution.activation_run_id);
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
