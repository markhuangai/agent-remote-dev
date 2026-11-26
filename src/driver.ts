import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { runnerAdapter } from "./runners.js";
import { RunnerError } from "./contracts.js";
import type { Diagnostics } from "./diagnostics.js";
import type { Job } from "./setup.js";
import type { ProcessControl } from "./process.js";

export async function drive(input: { job: Job; cwd: string; log: Diagnostics; plan: string; session?: string;
  state: (value: { session?: string; outcome: string; control?: ProcessControl }) => Promise<void> }) {
  let session = input.session ?? null, outcome = "completed", reason = "native_return", response = "";
  try {
    const result = await runnerAdapter(input.job.runner).execute(input.job, input.cwd, input.plan, input.log, Infinity, "native", session ?? undefined,
      id => { session = id; void input.state({ session: id, outcome: "running" }); },
      control => { void input.state({ outcome: "running", control }); });
    response = result.result;
  } catch (error) {
    outcome = error instanceof RunnerError && error.reason === "command_cancelled" ? "cancelled" : "failed";
    reason = error instanceof RunnerError ? error.reason : "native_failure";
    input.log.failure(error);
    try { response = await readFile(join(input.job.root, "result-native.txt"), "utf8"); } catch (readError: any) { if (readError.code !== "ENOENT") throw readError; }
  } finally { await input.state({ session: session ?? undefined, outcome }); }
  input.log.event("runtime.outcome", outcome === "completed" ? "INFO" : "WARN", { session_id: session, outcome, reason });
  input.log.line(`[outcome] ${outcome} (${reason})`);
  return { session, outcome, reason, response };
}
