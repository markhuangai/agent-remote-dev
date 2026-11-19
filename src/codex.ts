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

// Command arguments can contain unpublished task content even after credential redaction.
const commandNames = new Set(["cat", "head", "tail", "sed", "rg", "ls", "find", "pwd", "git", "gh", "npm", "npx", "node",
  "python", "python3", "apply_patch", "make", "cargo", "go", "cd", "set", "printf", "echo", "test", "sleep", "curl", "wget"]);

export function codexArgs(job: Job, cwd: string, output: string, session?: string) {
  const overrides = ["-c", 'approval_policy="never"', "-c", "allow_login_shell=false",
    "-c", `sqlite_home=${JSON.stringify(job.runnerHome)}`, "-c", `log_dir=${JSON.stringify(join(job.root, "logs"))}`];
  const base = ["exec", "--dangerously-bypass-approvals-and-sandbox", "--dangerously-bypass-hook-trust", "--trust", "-C", cwd, ...overrides, "--json", "--color", "never", "--output-last-message", output];
  return session ? [...base, "resume", session, "-"] : [...base, "-"];
}
export function logCodexActivity(log: Diagnostics, event: any, session: string) {
  if (!["item.started", "item.completed"].includes(event?.type)) return;
  const item = event.item;
  if (!item || typeof item.id !== "string") return;
  const fields: Record<string, unknown> = { session_id: session, item_id: item.id, item_type: item.type,
    phase: event.type.slice(5), status: item.status };
  switch (item.type) {
    case "command_execution": {
      const name = typeof item.command === "string"
        ? /^(?:\/(?:usr\/)?bin\/(?:bash|sh|zsh) -[a-z]*c ['"]?)?([a-z_][a-z0-9_-]*)(?=[\s'";]|$)/.exec(item.command)?.[1] : undefined;
      fields.command_name = name && commandNames.has(name) ? name : "shell";
      fields.exit_code = item.exit_code;
      break;
    }
    case "file_change": {
      const changes = Array.isArray(item.changes) ? item.changes : [];
      fields.changes = changes.slice(0, 100).map((change: any) => ({ path: change.path, kind: change.kind }));
      fields.omitted_changes = Math.max(0, changes.length - 100);
      break;
    }
    case "mcp_tool_call":
      fields.server = item.server; fields.tool = item.tool;
      break;
    case "collab_tool_call":
      fields.tool = item.tool;
      fields.receiver_thread_ids = Array.isArray(item.receiver_thread_ids) ? item.receiver_thread_ids.slice(0, 100) : [];
      break;
    case "web_search":
      fields.action = item.action?.type;
      break;
    default: return;
  }
  log.event("runtime.tool", item.status === "failed" || item.status === "declined" || typeof item.exit_code === "number" && item.exit_code !== 0 ? "WARN" : "INFO", fields);
}
export async function runCodex(job: Job, cwd: string, prompt: string, log: Diagnostics, timeoutMs: number, ordinal: string, session?: string,
  onSession?: (id: string) => void, onControl?: (control: ProcessControl) => void) {
  const output = join(job.root, `result-${ordinal}.txt`);
  let observed: string | undefined, identityChanged = false;
  await command(join(job.tools, "node_modules/.bin/codex"), codexArgs(job, cwd, output, session), {
    cwd, env: job.env, stage: "codex", onControl, log, timeoutMs, stdin: prompt, collect: false,
    onLine(line) {
      let value: any;
      try { value = JSON.parse(line); } catch { return; }
      if (value.type === "thread.started" && typeof value.thread_id === "string") {
        if (session && value.thread_id !== session || observed && value.thread_id !== observed) { identityChanged = true; return; }
        observed = value.thread_id;
        onSession?.(observed!);
        log.event("runtime.session", "INFO", { session_id: observed, outcome: session ? "resumed" : "created" });
      }
      if (observed && !identityChanged) logCodexActivity(log, value, observed);
    },
  });
  if (identityChanged || !observed || session && observed !== session) throw new RunnerError("conversation_identity_changed", "codex", "Codex did not return the expected conversation identity.",
    { expected_session: session ?? null, observed_session: observed ?? null });
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
  protectConfiguration(config, log);
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
