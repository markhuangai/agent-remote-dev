import * as core from "@actions/core";
import { randomUUID } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { authorize, hash, parseJson, requireValue, RunnerError, shaPattern, skillSources } from "./contracts.js";
import { isolatedCheckpoint } from "./checkpoint-worker.js";
import { DurableCheckpoint } from "./checkpoint.js";
import { verifyDelivery } from "./delivery.js";
import { Diagnostics } from "./diagnostics.js";
import { drive } from "./driver.js";
import { TaskGit } from "./git.js";
import { command } from "./process.js";
import { configure, createJob, fetchSkillSource, installSkillSource, installTools, removeJob, Job } from "./setup.js";

export function selectPlanSource(plan: string, issue: string, repository: string) {
  requireValue(Boolean(plan.trim()) !== Boolean(issue.trim()), "exactly_one_plan_source_required");
  if (plan.trim()) { requireValue(Buffer.byteLength(plan) <= 1024 * 1024, "plan_size_limit"); return { plan, issueNumber: null }; }
  const prefix = `https://github.com/${repository}/issues/`;
  requireValue(issue.startsWith(prefix) && /^[1-9][0-9]*$/.test(issue.slice(prefix.length)), "invalid_issue_url");
  return { plan: null, issueNumber: issue.slice(prefix.length) };
}
export async function main() {
  const started = Date.now();
  let job: Job | undefined;
  let deadlineTimer: NodeJS.Timeout | undefined, latestCheckpoint: DurableCheckpoint | null = null;
  let activeStage = "setup";
  const log = new Diagnostics({ repository: process.env.GITHUB_REPOSITORY, run_id: process.env.GITHUB_RUN_ID,
    run_attempt: process.env.GITHUB_RUN_ATTEMPT, workflow_sha: process.env.GITHUB_WORKFLOW_SHA,
    retention_days: process.env.GITHUB_RETENTION_DAYS });
  const get = (name: string, required = false) => core.getInput(name, { required, trimWhitespace: false });
  try {
    requireValue(process.platform === "linux" && ["x64", "arm64"].includes(process.arch) && Number(process.versions.node.split(".")[0]) === 24,
      "unsupported_platform", "setup");
    if (get("permission-mode").trim()) throw new RunnerError("unsupported_mode_input", "preflight",
      "This action always runs in full-access/YOLO mode. Remove the retired permission-mode input.");
    const repository = process.env.GITHUB_REPOSITORY ?? "";
    requireValue(/^[\w.-]+\/[\w.-]+$/.test(repository) && process.env.GITHUB_SERVER_URL === "https://github.com", "unsupported_repository");
    const token = get("github-token", true), key = get("codex-api-key", true), config = get("codex-config", true);
    for (const secret of [token, key, config, Buffer.from(`x-access-token:${token}`).toString("base64")]) log.protect(secret);
    for (const name of ["ACTIONS_RUNTIME_TOKEN", "ACTIONS_ID_TOKEN_REQUEST_TOKEN"]) if (process.env[name]) log.protect(process.env[name]!);
    requireValue(token.length >= 8 && key.length >= 8, "invalid_credential_input");
    const workspace = await realpath(process.env.GITHUB_WORKSPACE ?? process.cwd());
    const cwd = await realpath(resolve(workspace, get("working-directory") || "."));
    requireValue(cwd === workspace || cwd.startsWith(workspace + sep), "workspace_escape");
    const source = selectPlanSource(get("plan"), get("issue-url"), repository);
    const budget = Number(get("budget-minutes") || "300");
    requireValue(Number.isFinite(budget) && budget >= 3 && budget <= 300, "invalid_budget");
    deadlineTimer = setTimeout(() => {
      log.event("runtime.failed", "ERROR", { reason: "action_deadline", stage: activeStage, last_durable_checkpoint: latestCheckpoint,
        corrective_action: "Retain the last durable artifact; this run did not complete within its configured budget." });
      core.setOutput("status", "incomplete"); core.setFailed("Action budget exhausted."); process.exit(1);
    }, Math.max(1, started + budget * 60000 - Date.now()));
    const sources = skillSources(get("skills") || "[]");
    job = await createJob(process.env.RUNNER_TEMP ?? "/tmp", key, token, get("git-author-name", true), get("git-author-email", true));
    const currentJob = job;
    job.env.CODEX_TASK_DEADLINE_MS = String(started + budget * 60000);
    await configure(job, config, log);
    log.fields = { ...log.fields, platform: process.platform, architecture: process.arch, job_root: job.root };
    const api = async (endpoint: string) => parseJson(await command("gh", ["api", endpoint], { cwd, env: currentJob.env, stage: "preflight_api", log }), "github_api");
    const login = (await api("user")).login;
    const repo = await api(`repos/${repository}`);
    requireValue(typeof login === "string" && repo.full_name === repository && typeof repo.default_branch === "string", "repository_identity_mismatch");
    let plan = source.plan;
    if (source.issueNumber) {
      const issue = await api(`repos/${repository}/issues/${source.issueNumber}`);
      requireValue(issue.number === Number(source.issueNumber) && !issue.pull_request && issue.state === "open" && typeof issue.body === "string" && issue.body.trim(), "invalid_source_issue");
      const blockers = await api(`repos/${repository}/issues/${source.issueNumber}/dependencies/blocked_by?per_page=100`);
      requireValue(Array.isArray(blockers) && blockers.length < 100 && blockers.every((blocker: any) => blocker.state === "closed"), "source_issue_dependencies_incomplete");
      plan = issue.body;
    }
    requireValue(plan !== null, "missing_plan");
    const authorization = authorize(get("authorization", true), repository, plan);
    const taskId = randomUUID(), branch = `codex/task-${taskId}`;
    log.fields = { ...log.fields, task_id: taskId, branch, plan_sha256: hash(plan), actor: login };
    const git = new TaskGit(cwd, job.env, log, branch);
    requireValue((await git.run(["rev-parse", "--show-toplevel"])).trim() === cwd && (await git.run(["status", "--porcelain", "--untracked-files=all"])).trim() === "", "unsafe_worktree");
    const origin = (await git.run(["remote", "get-url", "origin"])).trim();
    requireValue(origin === `https://github.com/${repository}.git` || origin === `https://github.com/${repository}`, "origin_identity_mismatch");
    await command("python3", ["-c", "import sys; assert sys.version_info >= (3,12)"], { cwd, env: job.env, stage: "python_version", log });
    await installTools(job, resolve(import.meta.dirname, ".."), log);
    for (const [index, skill] of sources.entries()) await installSkillSource(job, skill, await fetchSkillSource(job, skill, index, log), index, log);
    await git.run(["fetch", "origin", repo.default_branch]);
    const base = (await git.run(["rev-parse", `refs/remotes/origin/${repo.default_branch}`])).trim();
    requireValue(shaPattern.test(base) && await git.remoteHead() === null, "unsafe_task_branch");
    await git.run(["switch", "-c", branch, base]);
    for (const [name, value] of Object.entries({ "task-id": taskId, branch, "base-sha": base })) core.setOutput(name, value);
    log.event("runtime.setup", "INFO", { stage: "ready", base_sha: base, outcome: "ready", budget_ms: budget * 60000 });
    activeStage = "driver";
    const result = await drive({ job, git, log, plan, planSource: source.issueNumber ? get("issue-url") : "inline", authorization,
      repository, taskId, base, issueNumber: source.issueNumber, skills: sources, budgetMs: budget * 60000, started,
      lineage: { repository, workflow_ref: process.env.GITHUB_WORKFLOW_REF, workflow_sha: process.env.GITHUB_WORKFLOW_SHA,
        run_id: process.env.GITHUB_RUN_ID, run_attempt: process.env.GITHUB_RUN_ATTEMPT, actor: login },
      checkpoint: async (input) => {
        latestCheckpoint = await isolatedCheckpoint(currentJob, cwd, input, log, (sha) => git.verify(sha));
        core.setOutput("checkpoint-sha", latestCheckpoint.checkpoint_sha); core.setOutput("artifact-id", latestCheckpoint.artifact_id);
        return latestCheckpoint;
      },
      complete: (url, receiptPath, policy, timeoutMs) => verifyDelivery({ job: currentJob, git, log, repository, login, baseBranch: repo.default_branch, url, receiptPath, policy, timeoutMs, issueNumber: source.issueNumber }),
    });
    for (const [name, value] of Object.entries({ status: result.status, "session-id": result.session, "checkpoint-sha": result.checkpoint?.checkpoint_sha,
      "artifact-id": result.checkpoint?.artifact_id, "pull-request-url": result.prUrl })) if (value !== null && value !== undefined) core.setOutput(name, value);
    log.event("runtime.outcome", result.status === "completed" ? "INFO" : "ERROR", { status: result.status, last_durable_checkpoint: result.checkpoint });
    if (result.status !== "completed") core.setFailed(`Plan execution ${result.status}; inspect runtime and checkpoint diagnostics.`);
  } catch (error) {
    log.failure(error); core.setOutput("status", "failed"); core.setFailed("Plan execution failed; inspect runtime.failed diagnostics.");
  } finally {
    activeStage = "cleanup";
    if (job) {
      try { await removeJob(job.root); log.event("runtime.cleanup", "INFO", { outcome: "removed_owned_job_directory", path: job.root }); }
      catch (error) { log.failure(error); core.setOutput("status", "failed"); core.setFailed("Job-owned temporary cleanup failed."); }
    }
    clearTimeout(deadlineTimer);
  }
}
