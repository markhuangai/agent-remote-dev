import * as core from "@actions/core";
import { executionMode, RunnerError, versions } from "./contracts.js";

export type LoggerCore = Pick<typeof core, "info" | "warning" | "error" | "debug">;
export class Diagnostics {
  private secrets: string[] = [];
  constructor(public fields: Record<string, unknown> = {}, private sink: LoggerCore = core) {}
  protect(value: string) {
    if (value.length > 0 && !this.secrets.includes(value)) {
      this.secrets.push(value);
      core.setSecret(value);
    }
  }
  get protectedValues() { return [...this.secrets]; }
  sanitize(value: string) {
    let result = value;
    for (const secret of [...this.secrets].sort((a, b) => b.length - a.length)) result = result.split(secret).join("[redacted]");
    return result.replace(/(?:https?:\/\/)[^\s]+/g, (url) => {
      try { const parsed = new URL(url); return parsed.origin + parsed.pathname; } catch { return "[url omitted]"; }
    }).split("\n").map((line) => /authorization\s*:|bearer\s|^\s*[\[{]|api[_-]?key\s*[:=]/i.test(line)
      ? "[sensitive diagnostic line omitted]" : line.replace(/\{.*$/, "[structured provider diagnostic omitted]")).join("\n");
  }
  event(event: string, level: "INFO" | "WARN" | "ERROR" | "DEBUG", fields: Record<string, unknown> = {}) {
    let truncated = false;
    const record = JSON.parse(JSON.stringify({ schema_version: 1, event, level, versions, ...this.fields, ...fields, permission_mode: executionMode }, (_key, value) => {
      if (typeof value !== "string") return value;
      const safe = this.sanitize(value);
      if (safe.length <= 512) return safe;
      truncated = true;
      return safe.slice(0, 512) + `...[truncated ${safe.length - 512} characters]`;
    }));
    const method = { INFO: "info", WARN: "warning", ERROR: "error", DEBUG: "debug" }[level] as keyof LoggerCore;
    this.sink[method](JSON.stringify({ ...record, truncated }));
  }
  failure(error: unknown, lastCheckpoint: unknown = null) {
    const failure = error instanceof RunnerError ? error : new RunnerError("unexpected_failure", "runtime",
      error instanceof Error ? error.message : "Unknown native failure");
    this.event("runtime.failed", "ERROR", { stage: failure.stage, reason: failure.reason, native_cause: failure.nativeCause,
      ...failure.details, last_durable_checkpoint: lastCheckpoint,
      corrective_action: "Inspect the named stage and native cause; preserve the last durable checkpoint and resolve the cause before retrying." });
  }
}
