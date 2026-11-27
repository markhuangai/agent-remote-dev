import * as core from "@actions/core";
import { randomBytes } from "node:crypto";
import { readdirSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { executionMode, RunnerError, versions } from "./contracts.js";
import { safeError } from "./platform/runtime-log.mjs";

export type LoggerCore = Pick<typeof core, "info" | "warning" | "error" | "debug"> &
  Partial<Pick<typeof core, "startGroup" | "endGroup" | "setSecret">>;
type Level = "INFO" | "WARN" | "ERROR" | "DEBUG";

export function trivialCredential(value: string) {
  const trimmed = value.trim();
  return trimmed.length < 4 || /^[^\p{L}\p{N}]+$/u.test(trimmed) || /^(?:true|false|null)$/i.test(trimmed);
}

export function credentialForms(secret: string, includeJson = false) {
  const form = new URLSearchParams([["value", secret]]).toString().slice(6);
  const forms = [secret, form, form.replaceAll("+", "%20")];
  if (includeJson) forms.push(JSON.stringify(secret).slice(1, -1));
  try {
    const uri = encodeURIComponent(secret);
    forms.push(uri, uri.replaceAll("%20", "+"));
  } catch (error) {
    if (!(error instanceof URIError)) throw error;
  }
  return [...new Set(forms.filter(Boolean))];
}

export function actionsText(value: string) {
  return value.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u202a-\u202e\u2066-\u2069]/g, "")
    .replace(/\r\n?|[\u0085\u2028\u2029]/g, "\n")
    .replace(/##\[/g, "# #[");
}

export class Diagnostics {
  private secrets: string[] = [];
  private redactionForms: string[] = [];
  private activeGroup: string | null = null;
  private reopenGroupTitle: string | null = null;
  private buffering = false;
  private buffer: string[] = [];
  private bufferBytes = 0;
  private bufferTimer: ReturnType<typeof setTimeout> | undefined;
  private bufferTitle: string | undefined;
  private compact = false;
  private workspace: string | undefined;
  private externalRoots: string[] = [];

  constructor(public fields: Record<string, unknown> = {}, private sink: LoggerCore = core,
    private options: { maskSecrets?: boolean } = {}) {}

  protect(value: string) {
    if (trivialCredential(value) || this.secrets.includes(value)) return;
    this.secrets.push(value);
    const forms = credentialForms(value, true);
    this.redactionForms = [...new Set([...this.redactionForms, ...forms])].sort((a, b) => b.length - a.length);
    if (this.options.maskSecrets === false) return;
    const setSecret = this.sink.setSecret ?? core.setSecret;
    for (const line of new Set(forms.flatMap(form => form.split(/\r\n|\r|\n/)))) {
      if (line.length >= 6 && /[A-Za-z0-9]/.test(line) && !/^(?:Bearer|Basic|application\/json)$/i.test(line.trim())) setSecret(line);
    }
  }

  get protectedValues() { return [...this.secrets]; }

  setWorkspace(path: string, externalRoots: string[] = []) {
    this.workspace = resolve(path);
    this.externalRoots = ["/tmp", "/home", "/var", "/root", "/Users", "/etc", "/opt", "/usr", "/proc", "/srv", "/mnt", "/runner",
      resolve("/", this.workspace.split(sep).filter(Boolean)[0] ?? ""),
      ...externalRoots.filter(Boolean).map(root => resolve(root)),
      ...readdirSync("/").map(root => resolve("/", root))];
  }

  ensureWorkspace(path: string) {
    if (!this.workspace) this.setWorkspace(path);
  }

  private redactPath(path: string, context: string, filesystem = false) {
    const resolved = resolve(path);
    const name = relative(this.workspace!, resolved);
    if (name !== ".." && !name.startsWith(".." + sep)) return name || ".";
    if (resolved === "/dev/null") return path;
    const segments = path.split("/").filter(Boolean);
    const filesystemSignal = filesystem || segments.some(segment => segment.startsWith(".") || segment.startsWith("~") || /\.[^.]/.test(segment)) ||
      this.externalRoots.some(root => resolved === root || resolved.startsWith(root + sep));
    if (filesystemSignal) return "<outside-workspace>";
    if (segments.length < 2 || /^\/(?:v\d+|api|graphql|health|metrics|rest|oauth|auth|openapi|swagger)(?:\/|$)/i.test(path) ||
      /\b(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+$/i.test(context) ||
      /(?:[=(:,[]|\breturn)\s*$/.test(context) && /^\/[^/]+\/[dgimsuvy]*$/.test(path)) return path;
    return "<outside-workspace>";
  }

  redact(value: string) {
    let result = value;
    for (const form of this.redactionForms) result = result.split(form).join("[redacted]");
    result = result.replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, "[private key omitted]");
    result = result.replace(/(?:^|\n)(?:[ +\-]?[A-Za-z0-9+/=]{48,}\n)+[ +\-]?-----END [A-Z ]*PRIVATE KEY-----/g, "\n[private key omitted]");
    result = result.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"']+/gi, url => {
      try {
        const parsed = new URL(url);
        return parsed.username || parsed.password || parsed.search ? `${parsed.protocol}//${parsed.host}${parsed.pathname}` : url;
      } catch { return "[url omitted]"; }
    });
    result = result.replace(/\b((?:proxy-)?authorization\s*[:=]\s*)[^\r\n]+/gi, "$1[redacted]");
    result = result.replace(/\b(Bearer|Basic)\s+([A-Za-z0-9._+/=-]{16,})(?![A-Za-z0-9._+/=-])/gi,
      (match, scheme: string, token: string) => /[0-9._+/=-]/.test(token) ? `${scheme} [redacted]` : match);
    result = result.replace(/\b(?:sk-ant-[A-Za-z0-9_-]+|sk-(?:proj-|svcacct-)?[A-Za-z0-9]{16,}|(?:sk|rk)_(?:live|test)_[A-Za-z0-9]+|gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|xox[baprs]-[A-Za-z0-9-]+|(?:AKIA|ASIA)[A-Z0-9]{16}|AIza[A-Za-z0-9_-]{20,}|glpat-[A-Za-z0-9_-]+|npm_[A-Za-z0-9]+|pypi-[A-Za-z0-9_-]+|hf_[A-Za-z0-9]+|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/g, "[redacted]");
    if (this.workspace) {
      result = result.replace(/\bfile:\/\/[^\s<>"'`]+/gi, url => {
        const suffix = /[.,;:]+$/.exec(url)?.[0] ?? "";
        try { return this.redactPath(fileURLToPath(url.slice(0, url.length - suffix.length)), "", true) + suffix; }
        catch { return "<outside-workspace>" + suffix; }
      });
      result = result.replace(/(^|[\s"'`=(\[{+,:;\-])((?:\/[A-Za-z0-9_~.%+@-]+)+\/?)/g,
        (match, prefix: string, path: string, offset: number, input: string) => {
          const suffix = /(?:^|\/)\.{1,2}$/.test(path) ? "" : /\.+$/.exec(path)?.[0] ?? "";
          const candidate = suffix ? path.slice(0, -suffix.length) : path;
          return prefix + this.redactPath(candidate, input.slice(0, offset + prefix.length)) + (candidate === path ? "" : suffix);
        });
    }
    return actionsText(result);
  }

  sanitize(value: string) {
    return this.redact(value).replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"']+/gi, url => {
      try { const parsed = new URL(url); return `${parsed.protocol}//${parsed.host}${parsed.pathname}`; }
      catch { return "[url omitted]"; }
    }).split("\n").map(line => {
      if (/authorization\s*:|bearer\s|^\s*[\[{]|api[_-]?key\s*[:=]/i.test(line)) return "[sensitive diagnostic line omitted]";
      return line.replace(/(\b(?:(?:unexpected\s+)?status|HTTP)\s+\d{3}(?:\s+[A-Za-z][A-Za-z ]*)?)\s*:\s*.*?(?=,\s*url\s*:|$)/gi,
        "$1: [provider response omitted]").replace(/\{.*$/, "[structured provider diagnostic omitted]");
    }).join("\n");
  }

  line(value: string) {
    let bytes = 0;
    for (const line of this.redact(value).split("\n")) {
      const safe = Buffer.byteLength(line) > 4096 ? "[oversized line omitted]" : line;
      if (bytes + Buffer.byteLength(safe) > 12000) { this.sink.info("[remaining lines omitted]"); break; }
      this.sink.info(safe.replace(/^(\s*)::/, "$1: :"));
      bytes += Buffer.byteLength(safe) + 1;
    }
  }

  beginGroup(title: string) {
    if (this.activeGroup) this.endGroup();
    this.reopenGroupTitle = null;
    this.activeGroup = title;
    this.sink.startGroup?.(this.redact(title).replace(/\n/g, " "));
  }

  ensureGroup(title: string) { if (!this.activeGroup) this.beginGroup(title); }

  endGroup() {
    if (this.activeGroup) this.sink.endGroup?.();
    this.activeGroup = null;
    this.reopenGroupTitle = null;
  }

  group(title: string, lines: string[], options: { untrusted?: boolean } = {}) {
    if (!lines.length) return;
    if (this.activeGroup) throw new Error("Cannot open a nested Actions log group.");
    this.sink.startGroup?.(this.redact(title).replace(/\n/g, " "));
    const nonce = options.untrusted && this.sink.startGroup ? randomBytes(16).toString("hex") : null;
    if (nonce) this.sink.info(`::stop-commands::${nonce}`);
    for (const entry of lines) {
      const safe = this.redact(entry);
      for (const line of safe.split("\n")) this.sink.info(`│ ${nonce ? line.replaceAll(nonce, "[nonce omitted]") : line}`);
    }
    if (nonce) this.sink.info(`::${nonce}::`);
    this.sink.endGroup?.();
  }

  emitContext(fields: Record<string, unknown> = {}) {
    this.event("runtime.context", "INFO", fields);
    this.compact = true;
  }

  useCompactRecords() { this.compact = true; }

  beginBuffering(title?: string) { this.buffering = true; this.bufferTitle = title; }

  flushBuffer(title?: string) {
    if (this.bufferTimer) clearTimeout(this.bufferTimer);
    this.bufferTimer = undefined;
    if (!this.buffer.length) return;
    const records = this.buffer;
    this.buffer = [];
    this.bufferBytes = 0;
    this.group(title ?? this.bufferTitle ?? `Runtime diagnostics (${records.length} events)`, records);
  }

  endBuffering(title?: string) {
    this.buffering = false;
    this.flushBuffer(title);
    this.bufferTitle = undefined;
  }

  event(event: string, level: Level, fields: Record<string, unknown> = {}) {
    try {
      if (level !== "INFO" || event === "runtime.outcome") this.flushBuffer();
      if (level === "WARN" || level === "ERROR") {
        const title = this.activeGroup;
        if (title) this.sink.endGroup?.();
        this.activeGroup = null;
        this.reopenGroupTitle = level === "WARN" ? title ?? this.reopenGroupTitle : null;
      } else if (level === "INFO" && this.reopenGroupTitle) {
        this.activeGroup = this.reopenGroupTitle;
        this.sink.startGroup?.(`${this.redact(this.reopenGroupTitle)} (continued)`);
        this.reopenGroupTitle = null;
      }
      let truncated = fields.truncated === true;
      const { truncated: _previousTruncation, ...eventFields } = fields;
      const correlation = this.compact && level === "INFO" && event !== "runtime.context"
        ? { run_id: this.fields.run_id, run_attempt: this.fields.run_attempt, session_id: this.fields.session_id,
          stage: this.fields.stage, sequence: this.fields.sequence, cycle: this.fields.cycle }
        : this.fields;
      const compactEvent = this.compact && level === "INFO" && event !== "runtime.context";
      const json = JSON.stringify({ schema_version: 1, event, level, versions: compactEvent ? undefined : versions,
        ...correlation, ...eventFields, permission_mode: compactEvent ? undefined : executionMode }, (_key, value) => {
        if (Array.isArray(value) && value.length > 100) {
          truncated = true;
          return [...value.slice(0, 99), `[omitted ${value.length - 99} entries]`];
        }
        if (typeof value === "bigint") return value.toString();
        if (typeof value !== "string") return value;
        const safe = this.sanitize(value);
        if (safe.length <= 512) return safe;
        truncated = true;
        return safe.slice(0, 512) + `...[truncated ${safe.length - 512} characters]`;
      });
      const record = actionsText(json.slice(0, -1) + `,"truncated":${truncated}}`);
      if (this.buffering && level === "INFO" && event === "runtime.outcome") {
        this.group("Outcome diagnostics", [record]);
      } else if (this.buffering && level === "INFO" && event === "runtime.heartbeat") {
        this.flushBuffer();
        this.group("Heartbeat", [record]);
      } else if (this.buffering && level === "INFO" && event !== "runtime.outcome") {
        this.buffer.push(record);
        this.bufferBytes += Buffer.byteLength(record);
        if (!this.bufferTimer) {
          this.bufferTimer = setTimeout(() => this.flushBuffer(), 60000);
          this.bufferTimer.unref();
        }
        if (this.buffer.length >= 50 || this.bufferBytes >= 32 * 1024) this.flushBuffer();
      } else {
        const method = { INFO: "info", WARN: "warning", ERROR: "error", DEBUG: "debug" }[level] as "info" | "warning" | "error" | "debug";
        this.sink[method](record);
      }
    } catch {
      this.flushBuffer();
      if (this.activeGroup) this.sink.endGroup?.();
      this.activeGroup = null;
      this.reopenGroupTitle = null;
      this.sink.error(JSON.stringify({ schema_version: 1, event: "runtime.log_error", level: "ERROR", reason: "diagnostic_serialization_failed" }));
    }
  }

  failure(error: unknown, lastCheckpoint: unknown = null) {
    const candidate = error && typeof error === "object" ? error as Partial<RunnerError> : {};
    const reason = typeof candidate.reason === "string" && /^[a-z][a-z0-9_]{0,79}$/.test(candidate.reason) ? candidate.reason : "unexpected_failure";
    const stage = typeof candidate.stage === "string" && /^[a-z][a-z0-9_]{0,79}$/.test(candidate.stage) ? candidate.stage : "runtime";
    const details = candidate.details && typeof candidate.details === "object" ? candidate.details : {};
    const cause = error instanceof RunnerError ? error.nativeCause : error instanceof Error ? error.message : "Unknown native failure";
    const apiCause = safeError(error);
    this.event("runtime.failed", "ERROR", { stage, native_cause: cause, ...apiCause, ...details, reason,
      last_durable_checkpoint: lastCheckpoint,
      corrective_action: reason === "invalid_configured_credential" ? "Replace the indicated configured credential with a non-trivial value."
        : "Inspect the named stage and native cause; preserve the last durable checkpoint and resolve the cause before retrying." });
  }
}
