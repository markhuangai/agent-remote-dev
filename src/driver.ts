import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { runnerAdapter } from "./runners.js";
import { RunnerError } from "./contracts.js";
import type { Diagnostics } from "./diagnostics.js";
import type { Job } from "./setup.js";
import type { ProcessControl } from "./process.js";
import { recoveryReasons } from "./platform/checkpoint-policy.mjs";
import { safeProviderCause } from "./provider-errors.js";

export async function drive(input: { job: Job; cwd: string; log: Diagnostics; plan: string; session?: string;
  state: (value: { session?: string; outcome: string; control?: ProcessControl }) => Promise<void> }) {
  let session = input.session ?? null, outcome = "completed", reason = "native_return", response = "";
  let diagnostics: Record<string, unknown> = {};
  try {
    const result = await runnerAdapter(input.job.runner).execute(input.job, input.cwd, input.plan, input.log, Infinity, "native", session ?? undefined,
      id => { session = id; void input.state({ session: id, outcome: "running" }); },
      control => { void input.state({ outcome: "running", control }); });
    response = result.result;
  } catch (error) {
    outcome = error instanceof RunnerError && error.reason === "command_cancelled" ? "cancelled" : "failed";
    reason = error instanceof RunnerError ? error.reason : "native_failure";
    if (error instanceof RunnerError) {
      const recoveryReason = recoveryReasons.includes(reason) ? reason : null;
      diagnostics = { recovery_reason: recoveryReason, auto_continue_eligible: recoveryReason !== null,
        provider_error_class: error.details.provider_error_class ?? null, transient: error.details.transient ?? false,
        auto_continue_rejection_reason: error.details.auto_continue_rejection_reason ?? (recoveryReason ? null : "unclassified_native_failure"),
        http_status: error.details.http_status ?? null, cause_code: error.details.cause_code ?? null,
        exit_code: error.details.exit_code ?? null, native_cause: error.details.provider_error_class
          ? safeProviderCause({ provider_error_class: error.details.provider_error_class as any, transient: error.details.transient === true,
            http_status: error.details.http_status as number | null ?? null, cause_code: error.details.cause_code as string | null ?? null })
          : error.nativeCause,
        corrective_action: recoveryReason ? "Inspect the final checkpoint and configured automatic continuation policy."
          : "Inspect the failure and resolve its cause before manually resuming." };
      Object.assign(error.details, diagnostics);
    }
    input.log.failure(error);
    try { response = await readFile(join(input.job.root, "result-native.txt"), "utf8"); } catch (readError: any) { if (readError.code !== "ENOENT") throw readError; }
  } finally { await input.state({ session: session ?? undefined, outcome }); }
  input.log.event("runtime.outcome", outcome === "completed" ? "INFO" : "WARN", { session_id: session, outcome, reason, ...diagnostics });
  input.log.line(`[outcome] ${outcome} (${reason})`);
  return { session, outcome, reason, response };
}
