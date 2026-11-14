import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, openSync } from "node:fs";
import { mkdtemp, readFile, rmdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunnerError } from "./contracts.js";
import { Diagnostics } from "./diagnostics.js";

export type CommandOptions = { cwd: string; env: NodeJS.ProcessEnv; stage: string; log?: Diagnostics; timeoutMs?: number;
  stdin?: string; onLine?: (line: string) => void; stdoutFile?: string; collect?: boolean; diagnosticStdout?: boolean; context?: Record<string, unknown> };
export async function command(executable: string, args: string[], options: CommandOptions) {
  const started = Date.now();
  const timeoutMs = Math.min(options.timeoutMs ?? 180000, Number(options.env.CODEX_TASK_DEADLINE_MS ?? Infinity) - started - 11000);
  if (timeoutMs <= 0) throw new RunnerError("command_timeout", options.stage, "Task budget exhausted before command startup.");
  const control = await mkdtemp(join(options.env.TMPDIR ?? tmpdir(), "codex-process-"));
  const receiptPath = join(control, "quiescent.json"), nonce = randomUUID();
  const fd = options.stdoutFile ? openSync(options.stdoutFile, "wx", 0o600) : undefined;
  const child = spawn("python3", [join(import.meta.dirname, "supervise.py"), receiptPath, nonce, executable, ...args],
    { cwd: options.cwd, env: options.env, detached: true, stdio: ["pipe", fd ?? "pipe", "pipe"] });
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  let stdout = "", stderr = "", pending = "", timeout = false, overflow = false, cancelled = false;
  const signal = (kind: NodeJS.Signals) => { child.kill(kind); };
  const cancel = () => { cancelled = true; signal("SIGTERM"); };
  process.once("SIGINT", cancel); process.once("SIGTERM", cancel);
  const heartbeat = setInterval(() => options.log?.event("runtime.heartbeat", "INFO", {
    stage: options.stage, ...options.context, elapsed_ms: Date.now() - started, timeout_ms: timeoutMs,
  }), 60000);
  const timer = setTimeout(() => { timeout = true; signal("SIGTERM"); }, timeoutMs);
  const hardTimer = setTimeout(() => signal("SIGKILL"), timeoutMs + 5000);
  child.stdout?.setEncoding("utf8"); child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    if (options.collect !== false) { if (stdout.length + chunk.length <= 16 * 1024 * 1024) stdout += chunk; else overflow = true; }
    if (options.onLine) {
      pending += chunk;
      for (;;) {
        const at = pending.indexOf("\n"); if (at < 0) break;
        const line = pending.slice(0, at); pending = pending.slice(at + 1);
        if (line.length <= 1024 * 1024) options.onLine(line); else overflow = true;
      }
      if (pending.length > 1024 * 1024) { pending = ""; overflow = true; }
    }
  });
  child.stderr?.on("data", (chunk: string) => { if (stderr.length < 65536) stderr += chunk.slice(0, 65536 - stderr.length); });
  child.stdin?.on("error", () => { /* Early CLI exit is reported by the process result. */ });
  child.stdin?.end(options.stdin);
  let code: number | null = null, spawnError: Error | undefined;
  try {
    await new Promise<void>((resolve) => {
      child.on("error", (error) => { spawnError = error; resolve(); });
      child.on("exit", (status) => { code = status; resolve(); });
    });
    const drained = await Promise.race([closed.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 500))]);
    if (!drained) { child.stdout?.destroy(); child.stderr?.destroy(); }
    if (pending && options.onLine) options.onLine(pending);
    let receipt;
    try { receipt = JSON.parse(await readFile(receiptPath, "utf8")); }
    catch (error: any) { if (error.code !== "ENOENT") throw error; }
    if (!spawnError && code === 0 && (receipt?.nonce !== nonce || receipt?.quiescent !== true)) throw new RunnerError("worker_not_quiescent", options.stage, "The Linux supervisor did not prove descendant quiescence.");
    if (spawnError || code !== 0 || timeout || overflow || cancelled || !drained) {
      let cause = spawnError?.message ?? stderr;
      if (options.diagnosticStdout) {
        cause = [cause, stdout].filter(Boolean).join("\n");
        cause = options.log?.sanitize(cause) ?? cause;
        if (cause.length > 8192) cause = cause.slice(0, 8192) + `...[truncated ${cause.length - 8192} characters]`;
      }
      throw new RunnerError(cancelled ? "command_cancelled" : timeout ? "command_timeout" : overflow ? "command_output_limit" : !drained ? "command_output_not_closed" : "command_failed",
        options.stage, cause, { exit_code: code, executable: executable.split("/").pop(), elapsed_ms: Date.now() - started, quiescent: receipt?.quiescent === true });
    }
    options.log?.event("runtime.operation", "INFO", { stage: options.stage, outcome: "success", quiescent: true, elapsed_ms: Date.now() - started });
    return stdout;
  } finally {
    clearInterval(heartbeat); clearTimeout(timer); clearTimeout(hardTimer);
    process.removeListener("SIGINT", cancel); process.removeListener("SIGTERM", cancel);
    if (fd !== undefined) closeSync(fd);
    try { await unlink(receiptPath); } catch (error: any) { if (error.code !== "ENOENT") throw error; }
    await rmdir(control);
  }
}
