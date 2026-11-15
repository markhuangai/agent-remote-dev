import * as core from "@actions/core";
import { randomUUID } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { authorize, hash, parseJson, requireValue, RunnerError, shaPattern, skillSources } from "./contracts.js";
import { isolatedCheckpoint, isolatedRecord } from "./checkpoint-worker.js";
import { DurableCheckpoint } from "./checkpoint.js";
import { verifyDelivery } from "./delivery.js";
import { Diagnostics } from "./diagnostics.js";
import { drive } from "./driver.js";
import { TaskGit } from "./git.js";
import { command } from "./process.js";
import { configure, createJob, fetchSkillSource, installSkillSource, installTools, removeJob, Job } from "./setup.js";
import { parseExecution, resumeReviewBudget, verifyResumeSettings } from "./continuation.js";
import { loadCheckpoint, restoreCheckpoint } from "./resume.js";
import { positiveId, taskPattern, validateReviewBudget } from "../.github/scripts/checkpoint-policy.mjs";
import { verifyProtocol } from "../.github/scripts/protocol-policy.mjs";

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
  let job: Job | undefined;
  let deadlineTimer: NodeJS.Timeout | undefined, latestCheckpoint: DurableCheckpoint | null = null;
  let cancelled = false, budgetExpired = false, runRecord: any = null;
  const cancel = () => { cancelled = true; if (job) job.env.CODEX_TASK_CANCELLED = "1"; };
  process.on("SIGINT", cancel); process.on("SIGTERM", cancel);
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
    const source = selectPlanSource(get("plan"), get("issue-url"), repository, get("resume-artifact-id"));
    const execution = parseExecution(get("continuation-context"), { source_sha: get("action-source-sha", true),
      auto_continue: (get("auto-continue") || "true") === "true", max_continuations: Number(get("max-continuations") || "3"), continuation_count: 0,
      budget_minutes: Number(get("budget-minutes") || "300"), root_run_id: process.env.GITHUB_RUN_ID ?? "", root_run_attempt: process.env.GITHUB_RUN_ATTEMPT ?? "",
      parent_run_id: null, parent_run_attempt: null, git_author_name: get("git-author-name", true), git_author_email: get("git-author-email", true) });
    requireValue(execution.source_sha === get("action-source-sha") && execution.git_author_name === get("git-author-name") && execution.git_author_email === get("git-author-email"), "execution_input_mismatch");
    requireValue(!get("auto-continue") || ["true", "false"].includes(get("auto-continue")), "invalid_continuation_setting");
    const budget = execution.budget_minutes;
    requireValue(Number.isFinite(budget) && budget >= 3 && budget <= 300, "invalid_budget");
    deadlineTimer = setTimeout(() => {
      budgetExpired = true;
      log.event("runtime.deadline", "WARN", { reason: "action_budget", stage: activeStage, last_durable_checkpoint: latestCheckpoint,
        corrective_action: "Use only the last durable checkpoint; interrupted active work has not been saved." });
    }, Math.max(1, started + budget * 60000 - Date.now()));
    let sources = skillSources(get("skills") || "[]");
    job = await createJob(process.env.RUNNER_TEMP ?? "/tmp", key, token, execution.git_author_name, execution.git_author_email);
    const currentJob = job;
    job.env.CODEX_TASK_DEADLINE_MS = String(started + budget * 60000);
    await configure(job, config, log);
    log.fields = { ...log.fields, platform: process.platform, architecture: process.arch, job_root: job.root };
    const api = async (endpoint: string) => parseJson(await command("gh", ["api", endpoint], { cwd, env: currentJob.env, stage: "preflight_api", log }), "github_api");
    const login = (await api("user")).login;
    const repo = await api(`repos/${repository}`);
    requireValue(typeof login === "string" && repo.full_name === repository && typeof repo.default_branch === "string", "repository_identity_mismatch");
    requireValue(shaPattern.test(execution.source_sha) && (await api(`repos/${repository}/commits/${execution.source_sha}`)).sha === execution.source_sha, "action_source_mismatch");
    if (execution.auto_continue) {
      try {
        const protocol = await verifyProtocol(path => api(path.replace(/^\//, "")), repository);
        log.event("runtime.setup", "INFO", { stage: "continuation_protocol", outcome: "verified", ...protocol });
      } catch (error: any) { throw new RunnerError(error.reason ?? "continuation_protocol_unavailable", "preflight", "Trusted continuation protocol validation failed.", error.details); }
    }
    if (execution.auto_continue || source.resumeArtifactId) {
      requireValue(["runner-task.yml", "runner-acceptance.yml"].some(name => process.env.GITHUB_WORKFLOW_REF === `${repository}/.github/workflows/${name}@refs/heads/main`), "untrusted_continuation_workflow");
    }
    let restored: Awaited<ReturnType<typeof loadCheckpoint>> | undefined;
    if (source.resumeArtifactId) {
      restored = await loadCheckpoint(job, api, repository, source.resumeArtifactId, log, get("task-id") || undefined);
      verifyResumeSettings(restored.manifest.execution, execution);
      sources = skillSources(JSON.stringify(restored.manifest.skills.slice(1)));
    }
    let plan = restored?.manifest.plan ?? source.plan;
    if (source.issueNumber) {
      const issue = await api(`repos/${repository}/issues/${source.issueNumber}`);
      requireValue(issue.number === Number(source.issueNumber) && !issue.pull_request && issue.state === "open" && typeof issue.body === "string" && issue.body.trim(), "invalid_source_issue");
      const blockers = await api(`repos/${repository}/issues/${source.issueNumber}/dependencies/blocked_by?per_page=100`);
      requireValue(Array.isArray(blockers) && blockers.length < 100 && blockers.every((blocker: any) => blocker.state === "closed"), "source_issue_dependencies_incomplete");
      plan = issue.body;
    }
    requireValue(plan !== null, "missing_plan");
    const authorization = authorize(get("authorization", true), repository, plan);
    if (restored) requireValue(JSON.stringify(Object.entries(authorization).sort()) === JSON.stringify(Object.entries(restored.manifest.authorization).sort()), "resume_authorization_changed", "resume");
    const taskId = restored?.manifest.task_id ?? (get("task-id") || randomUUID()), branch = `codex/task-${taskId}`;
    requireValue(taskPattern.test(taskId), "invalid_task_id");
    log.fields = { ...log.fields, task_id: taskId, branch, plan_sha256: hash(plan), actor: login, root_run_id: execution.root_run_id,
      parent_run_id: execution.parent_run_id, continuation_count: execution.continuation_count, max_continuations: execution.max_continuations, action_source_sha: execution.source_sha };
    const git = new TaskGit(cwd, job.env, log, branch);
    requireValue((await git.run(["rev-parse", "--show-toplevel"])).trim() === cwd && (await git.run(["status", "--porcelain", "--untracked-files=all"])).trim() === "", "unsafe_worktree");
    const origin = (await git.run(["remote", "get-url", "origin"])).trim();
    requireValue(origin === `https://github.com/${repository}.git` || origin === `https://github.com/${repository}`, "origin_identity_mismatch");
    await command("python3", ["-c", "import sys; assert sys.version_info >= (3,12)"], { cwd, env: job.env, stage: "python_version", log });
    await installTools(job, resolve(import.meta.dirname, ".."), log);
    for (const [index, skill] of sources.entries()) await installSkillSource(job, skill, await fetchSkillSource(job, skill, index, log), index, log);
    let base: string;
    if (restored) {
      base = restored.manifest.base_sha;
      await restoreCheckpoint(job, restored.root, restored.manifest, git, log);
      latestCheckpoint = restored.receipt;
      const parent = await api(`repos/${repository}/actions/runs/${execution.parent_run_id}/attempts/${execution.parent_run_attempt}`);
      requireValue(parent.status === "completed" && parent.repository?.full_name === repository && parent.head_repository?.full_name === repository &&
        parent.event === "workflow_dispatch" && parent.head_branch === "main", "invalid_resume_parent", "resume");
      const endedAt = get("parent-job-ended-at");
      const jobs = await api(`repos/${repository}/actions/runs/${parent.id}/attempts/${parent.run_attempt}/jobs?per_page=100`);
      const parentJob = jobs.jobs.filter((entry: any) => entry.name === (get("parent-job-name") || (parent.path.endsWith("runner-acceptance.yml") ? "acceptance" : "execute")));
      requireValue(parentJob.length === 1 && parentJob[0].completed_at === endedAt, "invalid_parent_job_timing", "resume");
      const carried = get("review-budget");
      if (carried) {
        const value = parseJson(carried, "resume");
        if (value !== null) validateReviewBudget(value, restored.manifest.checkpoint_sha);
        requireValue(value === null ? restored.manifest.driver.review_budget === null :
          value.active_since === null && restored.manifest.driver.review_budget !== null && value.remaining_ms <= restored.manifest.driver.review_budget.remaining_ms, "review_budget_increased", "resume");
        restored.manifest.driver.review_budget = value;
      } else restored.manifest.driver.review_budget = resumeReviewBudget(restored.manifest.driver.review_budget, endedAt);
    } else {
      await git.run(["fetch", "origin", repo.default_branch]);
      base = (await git.run(["rev-parse", `refs/remotes/origin/${repo.default_branch}`])).trim();
      requireValue(shaPattern.test(base) && await git.remoteHead() === null, "unsafe_task_branch");
      await git.run(["switch", "-c", branch, base]);
    }
    const lineage = { repository, workflow_ref: process.env.GITHUB_WORKFLOW_REF, workflow_sha: process.env.GITHUB_WORKFLOW_SHA,
      run_id: process.env.GITHUB_RUN_ID, run_attempt: process.env.GITHUB_RUN_ATTEMPT, actor: process.env.GITHUB_ACTOR,
      triggering_actor: process.env.GITHUB_TRIGGERING_ACTOR ?? process.env.GITHUB_ACTOR, credential_owner: login };
    runRecord = { schema_version: 2, repository, task_id: taskId, branch, base_sha: base, plan_sha256: hash(plan), authorization, execution, lineage,
      job_name: process.env.GITHUB_JOB, resume_artifact_id: restored?.receipt.artifact_id ?? null, review_budget: restored?.manifest.driver.review_budget ?? null,
      skills: sources, plan_source: restored?.manifest.plan_source ?? (source.issueNumber ? get("issue-url") : "inline") };
    await isolatedRecord(job, "run", runRecord, log);
    for (const [name, value] of Object.entries({ "task-id": taskId, branch, "base-sha": base, "root-run-id": execution.root_run_id,
      "parent-run-id": execution.parent_run_id ?? "", "continuation-count": execution.continuation_count })) core.setOutput(name, value);
    log.event("runtime.setup", "INFO", { stage: "ready", base_sha: base, outcome: "ready", budget_ms: budget * 60000 });
    activeStage = "driver";
    if (cancelled) throw new RunnerError("command_cancelled", "setup");
    const planSource = restored?.manifest.plan_source ?? (source.issueNumber ? get("issue-url") : "inline");
    const issueNumber = planSource === "inline" ? null : planSource.split("/").at(-1);
    const result = await drive({ job, git, log, plan, planSource, authorization,
      repository, taskId, base, issueNumber, skills: sources, budgetMs: budget * 60000, started, execution, cancelled: () => cancelled, lineage,
      resume: restored ? { state: restored.manifest.driver, checkpoint: restored.receipt, audit: restored.manifest.audit, sessions: restored.manifest.sessions,
        sessionIdentifiers: (restored.manifest as any).session_identifiers } : undefined,
      validation: (round, phase, stateHash) => isolatedRecord(currentJob, `validation-${round}-${phase}`, { ...runRecord, round, phase, audit_state_hash: stateHash }, log),
      checkpoint: async (input) => {
        latestCheckpoint = await isolatedCheckpoint(currentJob, cwd, input, log, (sha) => git.verify(sha));
        core.setOutput("checkpoint-sha", latestCheckpoint.checkpoint_sha); core.setOutput("artifact-id", latestCheckpoint.artifact_id);
        return latestCheckpoint;
      },
      complete: (url, receiptPath, policy, timeoutMs) => verifyDelivery({ job: currentJob, git, log, repository, login, baseBranch: repo.default_branch, url, receiptPath, policy, timeoutMs, issueNumber }),
    });
    if (cancelled) { result.status = "cancelled"; result.reason = "cancellation"; }
    await isolatedRecord(job, "outcome", { ...runRecord, status: result.status, reason: result.reason, checkpoint: result.checkpoint }, log);
    for (const [name, value] of Object.entries({ status: result.status, "session-id": result.session, "checkpoint-sha": result.checkpoint?.checkpoint_sha,
      "artifact-id": result.checkpoint?.artifact_id, "pull-request-url": result.prUrl })) if (value !== null && value !== undefined) core.setOutput(name, value);
    log.event("runtime.outcome", ["completed", "continuing"].includes(result.status) ? "INFO" : result.status === "cancelled" ? "WARN" : "ERROR", { status: result.status,
      reason: result.reason, root_run_id: execution.root_run_id, parent_run_id: execution.parent_run_id, continuation_count: execution.continuation_count,
      max_continuations: execution.max_continuations, last_durable_checkpoint: result.checkpoint });
    if (!["completed", "continuing"].includes(result.status)) core.setFailed(`Plan execution ${result.status}; inspect runtime and checkpoint diagnostics.`);
  } catch (error) {
    const status = cancelled ? "cancelled" : "failed";
    log.failure(error, latestCheckpoint); core.setOutput("status", status);
    if (job && runRecord && !budgetExpired) {
      try { await isolatedRecord(job, "outcome", { ...runRecord, status, reason: cancelled ? "cancellation" : error instanceof RunnerError ? error.reason : "unexpected_failure", checkpoint: latestCheckpoint }, log); }
      catch (recordError) { log.failure(recordError, latestCheckpoint); }
    }
    core.setFailed(`Plan execution ${status}; inspect runtime.failed diagnostics.`);
  } finally {
    activeStage = "cleanup";
    if (job) {
      try { await removeJob(job.root); log.event("runtime.cleanup", "INFO", { outcome: "removed_owned_job_directory", path: job.root }); }
      catch (error) { log.failure(error, latestCheckpoint); core.setOutput("status", "failed"); core.setFailed("Job-owned temporary cleanup failed."); }
    }
    clearTimeout(deadlineTimer);
    process.removeListener("SIGINT", cancel); process.removeListener("SIGTERM", cancel);
  }
}
