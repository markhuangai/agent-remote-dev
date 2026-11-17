import { same } from "./platform/checkpoint-policy.mjs";
import { requireValue } from "./contracts.js";

export type Execution = { source_repository: string; source_sha: string; auto_continue: boolean; max_continuations: number; continuation_count: number;
  budget_minutes: number; root_run_id: string; root_run_attempt: string; activation_run_id: string; activation_run_attempt: string; parent_run_id: string | null; parent_run_attempt: string | null;
  git_author_name: string; git_author_email: string; user_agents_url: string | null; user_agents_sha256: string | null;
  request_id: string; published_ref: string | null; project_config: { revision: string; sha256: string; content: string } };
export function verifyResumeSettings(recorded: Execution, supplied: Execution) {
  const inherited = { ...supplied, continuation_count: recorded.continuation_count, parent_run_id: recorded.parent_run_id, parent_run_attempt: recorded.parent_run_attempt,
    activation_run_id: recorded.activation_run_id, activation_run_attempt: recorded.activation_run_attempt };
  requireValue(same(recorded, inherited), "resume_settings_changed", "resume");
  requireValue(supplied.continuation_count > recorded.continuation_count && supplied.parent_run_id !== null && supplied.parent_run_attempt !== null, "invalid_resume_lineage", "resume");
}
