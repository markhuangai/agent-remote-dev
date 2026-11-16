import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { command } from "./process.js";
import { Job } from "./setup.js";
import { Diagnostics } from "./diagnostics.js";
import { RunnerError } from "./contracts.js";

export function codexArgs(job: Job, cwd: string, output: string, session?: string) {
  const overrides = ["-c", 'approval_policy="never"', "-c", "allow_login_shell=false",
    "-c", `sqlite_home=${JSON.stringify(job.codexHome)}`, "-c", `log_dir=${JSON.stringify(join(job.root, "logs"))}`];
  const base = ["exec", "--dangerously-bypass-approvals-and-sandbox", "-C", cwd, ...overrides, "--json", "--color", "never", "--output-last-message", output];
  return session ? [...base, "resume", session, "-"] : [...base, "-"];
}
export async function runCodex(job: Job, cwd: string, prompt: string, log: Diagnostics, timeoutMs: number, ordinal: string, session?: string,
  onSession?: (id: string) => void) {
  const output = join(job.root, `result-${ordinal}.txt`);
  let observed: string | undefined, identityChanged = false;
  await command(join(job.tools, "node_modules/.bin/codex"), codexArgs(job, cwd, output, session), {
    cwd, env: job.env, stage: "codex", log, timeoutMs, stdin: prompt, collect: false,
    onLine(line) {
      let value: any;
      try { value = JSON.parse(line); } catch { return; }
      if (value.type === "thread.started" && typeof value.thread_id === "string") {
        if (session && value.thread_id !== session || observed && value.thread_id !== observed) { identityChanged = true; return; }
        observed = value.thread_id;
        onSession?.(observed!);
        log.event("runtime.session", "INFO", { session_id: observed, outcome: session ? "resumed" : "created" });
      }
    },
  });
  if (identityChanged || !observed || session && observed !== session) throw new RunnerError("conversation_identity_changed", "codex", "Codex did not return the expected conversation identity.",
    { expected_session: session ?? null, observed_session: observed ?? null });
  return { session: observed, result: await readFile(output, "utf8") };
}
