import { executionSettings, same } from "../.github/remote-codex/checkpoint-policy.mjs";
import { requireValue, RunnerError } from "./contracts.js";

export type Execution = { source_repository: string; source_sha: string; runner: string[]; auto_continue: boolean; max_continuations: number; continuation_count: number;
  budget_minutes: number; root_run_id: string; root_run_attempt: string; activation_run_id: string; parent_run_id: string | null; parent_run_attempt: string | null;
  git_author_name: string; git_author_email: string; user_agents_url: string | null; user_agents_sha256: string | null;
  request_id: string; project_config: { revision: string; sha256: string; content: string } };
export function parseExecution(raw: string, defaults: Execution): Execution {
  try { return executionSettings(raw ? JSON.parse(raw) : defaults); }
  catch (error: any) { throw new RunnerError(error.reason ?? "invalid_execution_settings", "preflight", "Execution settings are invalid.", error.details); }
}
export function verifyResumeSettings(recorded: Execution, supplied: Execution) {
  const inherited = { ...supplied, continuation_count: recorded.continuation_count, parent_run_id: recorded.parent_run_id, parent_run_attempt: recorded.parent_run_attempt, activation_run_id: recorded.activation_run_id };
  requireValue(same(recorded, inherited), "resume_settings_changed", "resume");
  requireValue(supplied.continuation_count > recorded.continuation_count && supplied.parent_run_id !== null && supplied.parent_run_attempt !== null, "invalid_resume_lineage", "resume");
}
