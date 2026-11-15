import { debitReviewBudget, executionSettings } from "../.github/scripts/checkpoint-policy.mjs";
import { requireValue, RunnerError, shaPattern, Status, ValidationPolicy } from "./contracts.js";

export type Execution = { source_sha: string; auto_continue: boolean; max_continuations: number; continuation_count: number;
  budget_minutes: number; root_run_id: string; root_run_attempt: string; parent_run_id: string | null; parent_run_attempt: string | null;
  git_author_name: string; git_author_email: string };
export type ReviewBudget = { head_sha: string; remaining_ms: number; active_since: number | null };
export type DriverState = { worker_session: string; auditor_session: string | null; turn: number; pr_url: string | null;
  validation_policy: ValidationPolicy | null; audit_rounds: any[]; reconsidered: string[]; review_budget: ReviewBudget | null; historical_audits?: unknown[] };
export function parseExecution(raw: string, defaults: Execution): Execution {
  try { return executionSettings(raw ? JSON.parse(raw) : defaults); }
  catch (error: any) { throw new RunnerError(error.reason ?? "invalid_execution_settings", "preflight", "Execution settings are invalid.", error.details); }
}
export function resumeReviewBudget(budget: ReviewBudget | null, endedAt: string) {
  try { return debitReviewBudget(budget, Date.parse(endedAt)) as ReviewBudget | null; }
  catch (error: any) { throw new RunnerError(error.reason ?? "invalid_review_budget", "resume", "Native parent timing cannot account for review observation.", error.details); }
}
export function budgetOutcome(execution: Execution | undefined, durable: unknown): Status {
  return execution?.auto_continue && durable && execution.continuation_count < execution.max_continuations ? "continuing" : "incomplete";
}
export function verifyResumeSettings(recorded: Execution, supplied: Execution) {
  const inherited = { ...supplied, continuation_count: recorded.continuation_count, parent_run_id: recorded.parent_run_id, parent_run_attempt: recorded.parent_run_attempt };
  requireValue(JSON.stringify(Object.entries(recorded).sort()) === JSON.stringify(Object.entries(inherited).sort()), "resume_settings_changed", "resume");
  requireValue(supplied.continuation_count > recorded.continuation_count && supplied.parent_run_id !== null && supplied.parent_run_attempt !== null &&
    shaPattern.test(supplied.source_sha), "invalid_resume_lineage", "resume");
}
