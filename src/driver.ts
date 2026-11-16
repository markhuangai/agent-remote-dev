import { runCodex } from "./codex.js";
import { CheckpointInput, DurableCheckpoint } from "./checkpoint.js";
import { Authorization, RunnerError, SkillSource, Status, UserAgents } from "./contracts.js";
import { Diagnostics } from "./diagnostics.js";
import { TaskGit } from "./git.js";
import { Job } from "./setup.js";
import { Execution } from "./continuation.js";

export type DriverInput = { job: Job; git: TaskGit; log: Diagnostics; plan: string; planSource: string; authorization: Authorization;
  repository: string; taskId: string; base: string; budgetMs: number; started: number; skills: SkillSource[]; userAgents: UserAgents;
  lineage: Record<string, unknown>; execution: Execution; cancelled?: () => boolean;
  resume?: { session: string; checkpoint: DurableCheckpoint };
  checkpoint: (input: CheckpointInput) => Promise<DurableCheckpoint>;
  result: (value: { session_id: string | null; response: string; native_outcome: string }) => Promise<unknown> };
export type DriverResult = { status: Status; checkpoint: DurableCheckpoint | null; session: string | null; reason: string; nativeOutcome: string };
export async function drive(input: DriverInput): Promise<DriverResult> {
  const { job, git, log, execution } = input;
  let session = input.resume?.session ?? null, last = input.resume?.checkpoint ?? null, response = "", nativeOutcome = "failed", reason = "native_failure";
  let status: Status = "failed", quiescent = false;
  let nativeDetails: Record<string, unknown> = {};
  const nativeDeadline = input.started + input.budgetMs - 120000;
  const prompt = `DIRECT USER REQUEST (scope authority):\n${input.authorization.request}\n\nFROZEN TASK CONTENT:\n${input.plan}\n\nExecution context: ${JSON.stringify({ task_id: input.taskId,
    deadline: new Date(input.started + input.budgetMs - 120000).toISOString(), resumed: Boolean(input.resume), source_sha: execution.source_sha })}\nFollow the selected skills and applicable instructions. The host manages process lifetime and session transport only. It does not publish source or decide workflow phases. Progress needed on another runner must be published by your workflow; uncommitted files and arbitrary temporary files are not exported.`;
  try {
    const result = await runCodex(job, git.cwd, prompt, log, Math.max(1, input.started + input.budgetMs - Date.now() - 120000), "native", session ?? undefined,
      id => { session = id; log.fields.session_id = id; });
    response = result.result; session = result.session; nativeOutcome = "succeeded"; reason = "native_return"; quiescent = true; status = "completed";
  } catch (error) {
    const native = error instanceof RunnerError ? error : new RunnerError("unexpected_failure", "codex", error instanceof Error ? error.message : "Native execution failed");
    nativeDetails = { stage: native.stage, cause_reason: native.reason, native_cause: native.nativeCause, ...native.details, native_elapsed_ms: native.details.elapsed_ms };
    quiescent = native.details.quiescent === true;
    if (input.cancelled?.() || native.reason === "command_cancelled") { nativeOutcome = "cancelled"; status = "cancelled"; reason = "cancellation"; }
    else if (native.reason === "command_timeout") { nativeOutcome = "timed_out"; status = "incomplete"; reason = "action_budget"; }
    else log.failure(native, last);
  }
  if (session && quiescent && nativeOutcome !== "failed") {
    try {
      const source = await git.snapshot();
      last = await input.checkpoint({ task_id: input.taskId, repository: input.repository, branch: source.branch, base_sha: input.base, checkpoint_sha: source.sha,
        session_id: session, sessions: [session], plan: input.plan, plan_source: input.planSource, authorization: input.authorization,
        skills: input.skills, user_agents: input.userAgents, lineage: input.lineage, previous: last, execution, workspace: git.cwd });
    } catch (error) {
      const native = error instanceof RunnerError ? error : new RunnerError("checkpoint_unavailable", "checkpoint", error instanceof Error ? error.message : "Checkpoint unavailable");
      log.event("checkpoint.unavailable", "WARN", { reason: native.reason, ...native.details, native_cause: native.nativeCause, last_durable_checkpoint: last,
        corrective_action: "The selected workflow must publish a clean remote revision for resume; no source was staged or pushed by the runner." });
    }
  }
  if (status === "incomplete" && quiescent && last && execution.auto_continue && execution.continuation_count < execution.max_continuations) {
    try { git.branch = (await git.snapshot()).branch; await git.verify(last.checkpoint_sha); status = "continuing"; }
    catch (error) {
      reason = "durable_source_unavailable";
      log.event("checkpoint.unavailable", "WARN", { reason, cause_reason: error instanceof RunnerError ? error.reason : "source_verification_failed",
        ...(error instanceof RunnerError ? error.details : {}), last_durable_checkpoint: last });
    }
  }
  await input.result({ session_id: session, response, native_outcome: nativeOutcome });
  log.event(nativeOutcome === "timed_out" ? "runtime.deadline" : nativeOutcome === "cancelled" ? "runtime.cancelled" : "runtime.outcome",
    status === "failed" ? "ERROR" : ["completed", "continuing"].includes(status) ? "INFO" : "WARN",
    { ...nativeDetails, status, native_outcome: nativeOutcome, reason, session_id: session, last_durable_checkpoint: last, elapsed_ms: Date.now() - input.started,
      deadline_ms: nativeDeadline, action_deadline_ms: input.started + input.budgetMs,
      continuation_count: execution.continuation_count, max_continuations: execution.max_continuations });
  return { status, checkpoint: last, session, reason, nativeOutcome };
}
