import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, openSync } from "node:fs";
import { mkdtemp, readFile, rmdir, unlink, writeFile } from "node:fs/promises";
import { constants, tmpdir } from "node:os";
import { join } from "node:path";
import { RunnerError } from "./contracts.js";
import { Diagnostics } from "./diagnostics.js";

export type ProcessControl = { directory: string; nonce: string; freeze<T>(copy: () => Promise<T>): Promise<T> };
export type CommandOptions = { cwd: string; env: NodeJS.ProcessEnv; stage: string; log?: Diagnostics; timeoutMs?: number;
  onControl?: (control: ProcessControl) => void; stdin?: string; onLine?: (line: string) => void; stdoutFile?: string; collect?: boolean; diagnosticStdout?: boolean; context?: Record<string, unknown>;
  nativeSessionUnfinished?: () => boolean; rejectStderr?: boolean };
export async function command(executable: string, args: string[], options: CommandOptions) {
  if (options.env.REMOTE_DEV_TASK_CANCELLED === "1") throw new RunnerError("command_cancelled", options.stage, "Task cancellation is latched; no new operation was started.");
  const started = Date.now();
  const timeoutMs = options.timeoutMs ?? 180000;
  if (timeoutMs <= 0) throw new RunnerError("command_timeout", options.stage, "Task budget exhausted before command startup.");
  const control = await mkdtemp(join(options.env.TMPDIR ?? tmpdir(), "remote-dev-process-"));
  const receiptPath = join(control, "quiescent.json"), nonce = randomUUID();
  const fd = options.stdoutFile ? openSync(options.stdoutFile, "wx", 0o600) : undefined;
  const child = spawn("python3", [join(import.meta.dirname, "supervise.py"), receiptPath, nonce, executable, ...args],
    { cwd: options.cwd, env: options.env, detached: true, stdio: ["pipe", fd ?? "pipe", "pipe"] });
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  let stdout = "", stderr = "", pending = "", timeout = false, overflow = false, cancelled = false, lastActivityAt = started;
  const signal = (kind: NodeJS.Signals) => { child.kill(kind); };
  const cancel = () => { cancelled = true; signal("SIGTERM"); };
  process.once("SIGINT", cancel); process.once("SIGTERM", cancel);
  const heartbeat = setInterval(() => {
    const idle = Date.now() - lastActivityAt;
    if (idle >= 60000) options.log?.event("runtime.heartbeat", "INFO", {
      stage: options.stage, ...options.context, elapsed_ms: Date.now() - started, idle_ms: idle, timeout_ms: timeoutMs,
    });
  }, 60000);
  const timer = Number.isFinite(timeoutMs) ? setTimeout(() => { timeout = true; signal("SIGTERM"); }, timeoutMs) : undefined;
  const hardTimer = Number.isFinite(timeoutMs) ? setTimeout(() => signal("SIGKILL"), timeoutMs + 5000) : undefined;
  options.onControl?.(processControl(control, nonce));
  child.stdout?.setEncoding("utf8"); child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    lastActivityAt = Date.now();
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
  child.stderr?.on("data", (chunk: string) => { lastActivityAt = Date.now(); if (stderr.length < 65536) stderr += chunk.slice(0, 65536 - stderr.length); });
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
    if (receipt?.nonce === nonce && receipt.quiescent === false && receipt.pause_recovery_failure) {
      throw new RunnerError("snapshot_resume_failed", options.stage, "The supervisor could not verify that paused processes resumed or exited.",
        { pause_failure: receipt.pause_recovery_failure.pause_failure, resume_failure: receipt.pause_recovery_failure.resume_failure,
          exit_code: code, elapsed_ms: Date.now() - started, quiescent: false, output_closed: drained });
    }
    if (!spawnError && code === 0 && (receipt?.nonce !== nonce || receipt?.quiescent !== true)) throw new RunnerError("worker_not_quiescent", options.stage, "The Linux supervisor did not prove descendant quiescence.");
    const killSignal = constants.signals.SIGKILL;
    if (!spawnError && !cancelled && !timeout && !overflow && drained && code === 128 + killSignal &&
      receipt?.nonce === nonce && receipt.quiescent === true && receipt.exit_code === -killSignal && options.nativeSessionUnfinished?.()) {
      throw new RunnerError("native_worker_sigkill", options.stage, "SIGKILL interrupted the native session after it started. The supervisor confirmed all descendants exited.",
        { worker_exit_code: receipt.exit_code, exit_code: code, signal: "SIGKILL", quiescent: true, output_closed: drained, elapsed_ms: Date.now() - started });
    }
    if (spawnError || code !== 0 || timeout || overflow || cancelled || !drained || options.rejectStderr && stderr.trim()) {
      let cause = spawnError?.message ?? stderr;
      if (options.diagnosticStdout) {
        cause = [cause, stdout].filter(Boolean).join("\n");
        cause = options.log?.sanitize(cause) ?? cause;
        if (cause.length > 8192) cause = cause.slice(0, 8192) + `...[truncated ${cause.length - 8192} characters]`;
      }
      throw new RunnerError(cancelled ? "command_cancelled" : timeout ? "command_timeout" : overflow ? "command_output_limit" : !drained ? "command_output_not_closed" : "command_failed",
        options.stage, cause, { exit_code: code, signal: child.signalCode, executable: executable.split("/").pop(), elapsed_ms: Date.now() - started,
          timeout_ms: timeoutMs, deadline_ms: started + timeoutMs, quiescent: receipt?.quiescent === true });
    }
    options.log?.event("runtime.operation", "INFO", { stage: options.stage, outcome: "success", quiescent: true, elapsed_ms: Date.now() - started });
    return stdout;
  } finally {
    clearInterval(heartbeat); clearTimeout(timer); clearTimeout(hardTimer);
    process.removeListener("SIGINT", cancel); process.removeListener("SIGTERM", cancel);
    if (fd !== undefined) closeSync(fd);
    for (const name of ["quiescent.json", "pause", "paused.json", "paused.tmp"]) {
      try { await unlink(join(control, name)); } catch (error: any) { if (error.code !== "ENOENT") throw error; }
    }
    await rmdir(control);
  }
}

export function processControl(directory: string, nonce: string): ProcessControl {
  return { directory, nonce, async freeze(copy) {
    const request = randomUUID();
    const pausePath = join(directory, "pause");
    const readReply = async () => {
      try {
        const reply = JSON.parse(await readFile(join(directory, "paused.json"), "utf8"));
        if (reply.nonce === nonce && reply.request === request) return reply;
      } catch (error: any) { if (error.code !== "ENOENT") throw error; }
    };
    const start = Date.now();
    await writeFile(pausePath, request, { mode: 0o600 });
    try {
      for (;;) {
        const reply = await readReply();
        if (reply?.problem === null) break;
        if (reply?.problem) {
          const { reason, signal, pid, os_errno } = reply.problem;
          throw new RunnerError("snapshot_pause_deferred", "checkpoint", "The supervisor resumed processes from an incomplete pause.",
            { pause_reason: reason, signal, pid, os_errno, elapsed_ms: Date.now() - start });
        }
        if (Date.now() - start >= 5000) throw new RunnerError("snapshot_pause_failed", "checkpoint");
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      const result = await copy();
      if ((await readReply())?.problem !== null) throw new RunnerError("snapshot_pause_lost", "checkpoint");
      return result;
    } finally { await unlink(pausePath).catch(error => { if (error.code !== "ENOENT") throw error; }); }
  } };
}
