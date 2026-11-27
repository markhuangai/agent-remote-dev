import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { command } from "./process.js";
import { Job } from "./setup.js";
import { Diagnostics } from "./diagnostics.js";
import type { ProcessControl } from "./process.js";
import { object, RunnerError } from "./contracts.js";
import { parse, stringify, type TomlTable } from "smol-toml";
import { protectConfiguration } from "./credentials.js";
import { readRepositoryMcpFile, type McpConfiguration } from "./mcp-config.js";
import { boundedLines, commandName, editForPath, parseApplyPatch, showEdit, summarizeCommand } from "./activity.js";
import { classifyCodexError, classifyFailure, safeProviderCause } from "./provider-errors.js";

export function codexArgs(job: Job, cwd: string, output: string, session?: string) {
  const overrides = ["-c", 'approval_policy="never"', "-c", "allow_login_shell=false",
    "-c", `sqlite_home=${JSON.stringify(job.runnerHome)}`, "-c", `log_dir=${JSON.stringify(join(job.root, "logs"))}`];
  const base = ["exec", "--dangerously-bypass-approvals-and-sandbox", "--dangerously-bypass-hook-trust", "--trust", "-C", cwd, ...overrides, "--json", "--color", "never", "--output-last-message", output];
  return session ? [...base, "resume", session, "-"] : [...base, "-"];
}
export function logCodexError(log: Diagnostics, event: any, session?: string) {
  const item = event.type === "error" ? event : event.type === "turn.failed" ? event.error : event.item;
  const cause = String(item?.message ?? item?.text ?? "Native provider error");
  const classification = classifyCodexError(cause);
  log.event("runtime.provider", "ERROR", { stage: "codex", session_id: session ?? null,
    ...classification, native_cause: safeProviderCause(classification),
    corrective_action: "Inspect provider status and session diagnostics before resuming." });
}
export function logCodexActivity(log: Diagnostics, event: any, session: string, cwd?: string, started?: Map<string, number>) {
  if (!["item.started", "item.completed"].includes(event?.type) && !(event?.type === "item.updated" && event?.item?.type === "todo_list")) return;
  const item = event.item;
  if (!item || typeof item.id !== "string") return;
  const fields: Record<string, unknown> = { session_id: session, item_id: item.id, item_type: item.type,
    phase: event.type.slice(5), status: item.status };
  switch (item.type) {
    case "command_execution": {
      const command = typeof item.command === "string" ? item.command : "";
      fields.command_name = commandName(command);
      fields.exit_code = item.exit_code;
      if (event.type === "item.started") started?.set(item.id, Date.now());
      if (event.type === "item.completed" && cwd) {
        const elapsed = started?.has(item.id) ? Date.now() - started.get(item.id)! : undefined;
        fields.elapsed_ms = elapsed;
        const patch = parseApplyPatch(command, typeof item.aggregated_output === "string" ? item.aggregated_output : "", cwd);
        if (patch) {
          if (item.exit_code === 0 || item.status === "completed" && item.exit_code == null) for (const edit of patch) showEdit(log, edit);
          else log.line(`[edit] failed (exit ${item.exit_code ?? "unknown"})`);
        } else log.line(`[cmd] ${summarizeCommand(command, cwd)} (exit ${item.exit_code ?? "unknown"}${elapsed === undefined ? "" : `, ${elapsed} ms`})`);
        started?.delete(item.id);
      }
      break;
    }
    case "file_change": {
      const changes = Array.isArray(item.changes) ? item.changes : [];
      if (event.type === "item.completed" && item.status === "completed") {
        fields.changes = changes.slice(0, 100).map((change: any) => ({ path: cwd && typeof change.path === "string" ? editForPath(change.path, change.kind, undefined, cwd).path : change.path, kind: change.kind }));
        fields.omitted_changes = Math.max(0, changes.length - 100);
      }
      if (cwd && event.type === "item.completed") {
        if (item.status === "completed") for (const change of changes.slice(0, 100)) {
          if (typeof change.path === "string") showEdit(log, editForPath(change.path, change.kind ?? "update", typeof change.diff === "string" ? change.diff : undefined, cwd));
        }
        else log.line("[edit] failed");
      }
      break;
    }
    case "mcp_tool_call":
      fields.server = item.server; fields.tool = item.tool;
      if (cwd && event.type === "item.completed") log.line(`[mcp] ${item.server ?? "server"} / ${item.tool ?? "tool"} (${item.status ?? "completed"})`);
      break;
    case "collab_tool_call":
      fields.tool = item.tool;
      fields.receiver_thread_ids = Array.isArray(item.receiver_thread_ids) ? item.receiver_thread_ids.slice(0, 100) : [];
      if (cwd && event.type === "item.completed") log.line(`[subagent] ${item.tool ?? "activity"} (${item.status ?? "completed"})`);
      break;
    case "web_search":
      fields.action = item.action?.type;
      if (cwd && event.type === "item.completed") log.line(`[web] ${item.action?.type ?? "search"}`);
      break;
    case "todo_list":
      if (cwd && Array.isArray(item.items)) log.group("Plan", boundedLines(log.redact(item.items.map((entry: any) => `${entry.completed ? "[x]" : "[ ]"} ${entry.text ?? ""}`).join("\n"))), { untrusted: true });
      return;
    default: return;
  }
  if (item.status === "failed" || typeof item.exit_code === "number" && item.exit_code !== 0) fields.status = "failed";
  log.event("runtime.tool", item.status === "declined" ? "WARN" : "INFO", fields);
}
export async function runCodex(job: Job, cwd: string, prompt: string, log: Diagnostics, timeoutMs: number, ordinal: string, session?: string,
  onSession?: (id: string) => void, onControl?: (control: ProcessControl) => void) {
  log.ensureWorkspace(cwd);
  const output = join(job.root, `result-${ordinal}.txt`);
  let observed: string | undefined, conflictingSession: string | undefined, identityChanged = false, terminal = false, pending: { id: string; text: string } | undefined;
  let lastTurnFailedError: string | undefined, lastStreamError: string | undefined, sawTurnCompleted = false, sawTurnFailed = false;
  let unparsed = 0;
  const started = new Map<string, number>();
  const flushMessage = () => { if (pending) { log.line(`[agent] ${pending.text}`); pending = undefined; } };
  try { await command(join(job.tools, "node_modules/.bin/codex"), codexArgs(job, cwd, output, session), {
    cwd, env: job.env, stage: "codex", onControl, log, timeoutMs, stdin: prompt, collect: false,
    nativeSessionUnfinished: () => Boolean(observed) && !identityChanged && !terminal,
    onLine(line) {
      let value: any;
      try { value = JSON.parse(line); } catch { unparsed = Math.min(unparsed + 1, 1000000); return; }
      if (pending && value.item && value.item.id !== pending.id) flushMessage();
      if (value.type === "turn.started") { terminal = false; sawTurnCompleted = false; sawTurnFailed = false; lastTurnFailedError = undefined; lastStreamError = undefined; }
      if (value.type === "turn.completed") { pending = undefined; sawTurnCompleted = true; sawTurnFailed = false; lastTurnFailedError = undefined; lastStreamError = undefined; }
      if (value.type === "turn.failed") {
        flushMessage(); sawTurnFailed = true;
        lastTurnFailedError = typeof value.error?.message === "string" ? value.error.message : undefined;
        if (lastTurnFailedError === undefined || lastTurnFailedError !== lastStreamError) logCodexError(log, value, observed ?? session);
      }
      if (value?.type === "turn.completed" || value?.type === "turn.failed") terminal = true;
      if (value?.type === "error" || value?.type === "item.completed" && value.item?.type === "error") {
        flushMessage();
        if (value.type === "error" && typeof value.message === "string") lastStreamError = value.message;
        logCodexError(log, value, observed ?? session);
        return;
      }
      if (["item.started", "item.completed"].includes(value.type) && value.item?.type !== "error") lastStreamError = undefined;
      if (value.type === "thread.started" && typeof value.thread_id === "string") {
        if (session && value.thread_id !== session || observed && value.thread_id !== observed) {
          identityChanged = true; conflictingSession ??= value.thread_id; return;
        }
        observed = value.thread_id;
        onSession?.(observed!);
        log.event("runtime.session", "INFO", { session_id: observed, outcome: session ? "resumed" : "created" });
      }
      if (observed && !identityChanged) {
        const item = value.item;
        if (value.type === "item.completed" && item?.type === "agent_message" && typeof item.text === "string") pending = { id: item.id, text: item.text };
        else if (value.type === "item.completed" && item?.type === "reasoning" && typeof item.text === "string")
          log.group("Thinking", boundedLines(log.redact(item.text)), { untrusted: true });
        else logCodexActivity(log, value, observed, cwd, started);
      }
    },
  }); } catch (error) {
    if (error instanceof RunnerError) {
      error.details.unparsed_stdout_lines = unparsed;
      if (identityChanged) Object.assign(error.details, { expected_session: session ?? observed ?? null, observed_session: conflictingSession ?? null });
      if (error.reason === "command_failed") {
        const cause = lastTurnFailedError ?? lastStreamError;
        const classification = classifyFailure(classifyCodexError(cause ?? ""), { observed: Boolean(observed), identityChanged,
          completed: sawTurnCompleted, quiescent: error.details.quiescent === true && error.details.signal === null });
        Object.assign(error.details, classification);
        if (classification.auto_continue_eligible) throw new RunnerError("native_provider_transient", "codex", cause ?? error.nativeCause, error.details);
      }
    }
    throw error;
  } finally {
    flushMessage();
    log.event("runtime.native_stream", "INFO", { stage: "codex", session_id: observed ?? session, unparsed_stdout_lines: unparsed });
  }
  if (identityChanged || !observed || session && observed !== session) throw new RunnerError("conversation_identity_changed", "codex", "Codex did not return the expected conversation identity.",
    { ...classifyFailure(classifyCodexError(lastTurnFailedError ?? lastStreamError ?? ""), { observed: Boolean(observed), identityChanged }),
      expected_session: session ?? observed ?? null, observed_session: conflictingSession ?? observed ?? null, unparsed_stdout_lines: unparsed });
  if (sawTurnFailed && !sawTurnCompleted) {
    const cause = lastTurnFailedError ?? lastStreamError ?? "Codex did not complete the native turn.";
    const classification = classifyFailure(classifyCodexError(cause), { observed: Boolean(observed), identityChanged, completed: sawTurnCompleted });
    throw new RunnerError(classification.auto_continue_eligible ? "native_provider_transient" : "codex_native_failure", "codex", cause,
      { ...classification, exit_code: 0, unparsed_stdout_lines: unparsed });
  }
  return { session: observed, result: await readFile(output, "utf8") };
}

function parseCodexConfig(raw: string, source: "CODEX_CONFIG_TOML" | ".codex/config.toml", log: Diagnostics) {
  let config: TomlTable;
  try { config = parse(raw); }
  catch { throw new RunnerError("invalid_codex_config", "configuration", "Codex TOML could not be parsed; configuration contents withheld.", { source }); }
  const mcpServers = config.mcp_servers ?? {};
  if (!object(mcpServers)) {
    throw new RunnerError("invalid_codex_config", "configuration", "Expected an mcp_servers table.", { source });
  }
  protectConfiguration(config, log, "", source);
  return { config, mcpServers };
}

function stringMap(value: unknown): value is Record<string, string> {
  return object(value) && Object.values(value).every(item => typeof item === "string");
}

function translateMcpServer(name: string, definition: Record<string, unknown>, source: string, log: Diagnostics): TomlTable | undefined {
  const { type = "stdio", command, args, env, url, headers } = definition;
  const invalid = () => new RunnerError("invalid_mcp_server", "configuration", "Check the required fields for this MCP transport.", { source, server: name });
  if (type === "stdio") {
    if (typeof command !== "string" || !command.trim() ||
      (args !== undefined && (!Array.isArray(args) || !args.every(arg => typeof arg === "string"))) ||
      (env !== undefined && !stringMap(env))) throw invalid();
    return { command, ...(args === undefined ? {} : { args }), ...(env === undefined ? {} : { env }) };
  }
  if (type === "http" || type === "streamable-http") {
    if (typeof url !== "string" || !url.trim() || (headers !== undefined && !stringMap(headers))) throw invalid();
    return { url, ...(headers === undefined ? {} : { http_headers: headers }) };
  }
  if (typeof type !== "string") throw invalid();
  log.event("runtime.setup", "WARN", { stage: "configuration", outcome: "skipped", reason: "unsupported_mcp_transport",
    source, server: name, corrective_action: "Use stdio or Streamable HTTP to run this server with Codex." });
}

export async function configureCodex(job: Job, raw: string, log: Diagnostics, mcp: McpConfiguration) {
  const { config, mcpServers } = parseCodexConfig(raw, "CODEX_CONFIG_TOML", log);
  const projectToml = mcp.cwd ? await readRepositoryMcpFile(mcp.cwd, ".codex/config.toml") : undefined;
  const projectNative = projectToml === undefined ? {} : parseCodexConfig(projectToml, ".codex/config.toml", log).mcpServers;
  const servers = new Map(Object.entries(mcpServers));
  // Codex merges native tables field by field, so remove shadowed entries before it loads the project layer.
  for (const name of Object.keys(projectNative)) servers.delete(name);
  for (const [name, definition] of Object.entries({ ...mcp.shared, ...mcp.repository })) {
    if (Object.hasOwn(projectNative, name)) continue;
    servers.delete(name);
    const source = Object.hasOwn(mcp.repository, name) ? ".mcp.json" : "MCP_CONFIG_JSON";
    const translated = translateMcpServer(name, definition, source, log);
    if (translated) servers.set(name, translated);
  }
  if (config.mcp_servers !== undefined || servers.size) config.mcp_servers = Object.fromEntries(servers);
  for (const key of ["sqlite_home", "log_dir", "sandbox_mode", "sandbox_workspace_write", "approval_policy", "default_permissions", "permissions", "skills", "allow_login_shell", "cli_auth_credentials_store", "mcp_oauth_credentials_store"]) delete config[key];
  Object.assign(config, { sqlite_home: job.runnerHome, log_dir: join(job.root, "logs"), allow_login_shell: false,
    cli_auth_credentials_store: "file", mcp_oauth_credentials_store: "file", skills: { bundled: { enabled: false } } });
  await writeFile(join(job.runnerHome, "config.toml"), stringify(config), { mode: 0o600 });
  log.event("runtime.setup", "INFO", { stage: "configuration", outcome: "success",
    mcp_servers: [...servers.keys(), ...Object.keys(projectNative)], paths: { home: job.home, runner_home: job.runnerHome } });
}
