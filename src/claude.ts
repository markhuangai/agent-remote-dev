import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { object, requireValue, RunnerError } from "./contracts.js";
import { protectConfiguration } from "./credentials.js";
import { command } from "./process.js";
import type { ProcessControl } from "./process.js";
import type { Job } from "./setup.js";
import type { Diagnostics } from "./diagnostics.js";

export async function configureClaude(job: Job, raw: string, log: Diagnostics, rawMcp = "") {
  let settings: any, mcp: any;
  try { settings = JSON.parse(raw); mcp = rawMcp ? JSON.parse(rawMcp) : { mcpServers: {} }; }
  catch { throw new RunnerError("invalid_claude_config", "configuration", "Claude settings or MCP JSON could not be parsed; contents withheld."); }
  requireValue(object(settings) && object(mcp) && object(mcp.mcpServers) && Object.keys(mcp).every(key => key === "mcpServers"), "invalid_claude_config", "configuration");
  protectConfiguration(settings, log); protectConfiguration(mcp, log);
  requireValue(settings.env === undefined || object(settings.env) && Object.values(settings.env).every(value => typeof value === "string"), "invalid_claude_environment", "configuration");
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(settings.env ?? {})) {
    if (!/^(HOME|PATH|TMPDIR|XDG_.*|GIT_.*|GH_.*|GITHUB_.*|RUNNER_.*|REMOTE_DEV_.*|CODEX_.*|CLAUDE_CONFIG_DIR|CLAUDE_CODE_(PROJECT_DIR_NAME|SKIP_PROMPT_HISTORY|REMOTE_MEMORY_DIR|TASK_LIST_ID)|CLAUDE_COWORK_MEMORY_PATH_OVERRIDE|CLAUDE_INTERNAL_SESSION_TASK_LIST_ID|ANTHROPIC_(API_KEY|AUTH_TOKEN)|NODE_OPTIONS|LD_.*)$/.test(key)) environment[key] = value as string;
  }
  for (const key of ["permissions", "sandbox", "apiKeyHelper", "cleanupPeriodDays", "autoMemoryDirectory"]) delete settings[key];
  requireValue(/^[A-Za-z0-9_-]{1,64}$/.test(job.env.CLAUDE_CODE_PROJECT_DIR_NAME ?? ""), "invalid_project_storage_key", "configuration");
  Object.assign(settings, { env: environment, permissions: { defaultMode: "bypassPermissions" }, sandbox: { enabled: false }, cleanupPeriodDays: 3650,
    enableAllProjectMcpServers: true,
    autoMemoryDirectory: join(job.runnerHome, "projects", job.env.CLAUDE_CODE_PROJECT_DIR_NAME!, "memory") });
  await writeFile(join(job.runnerHome, "settings.json"), JSON.stringify(settings), { mode: 0o600 });
  await writeFile(join(job.runnerHome, "mcp.json"), JSON.stringify(mcp), { mode: 0o600 });
  log.event("runtime.setup", "INFO", { stage: "configuration", runner: "claude", outcome: "success", mcp_servers: Object.keys(mcp.mcpServers), paths: { home: job.home, runner_home: job.runnerHome } });
}

export async function runClaude(job: Job, cwd: string, prompt: string, log: Diagnostics, timeoutMs: number, ordinal: string, session?: string,
  onSession?: (id: string) => void, onControl?: (control: ProcessControl) => void) {
  const output = join(job.root, `result-${ordinal}.txt`);
  let observed: string | undefined, identityChanged = false, terminal = false, failure: string | undefined;
  await command(process.execPath, [join(import.meta.dirname, "claude-worker.js"), output, session ?? ""], {
    cwd, env: job.env, stage: "claude", onControl, log, timeoutMs, stdin: prompt, collect: false,
    onLine(line) {
      let event: any; try { event = JSON.parse(line); } catch { return; }
      if (event.type === "session" && typeof event.session === "string") {
        if (session && event.session !== session || observed && event.session !== observed) { identityChanged = true; return; }
        observed = event.session; onSession?.(observed!);
        log.event("runtime.session", "INFO", { session_id: observed, outcome: session ? "resumed" : "created" });
      }
      if (event.type === "tool" && observed && !identityChanged) log.event("runtime.tool", event.failed ? "WARN" : "INFO", {
        session_id: observed, item_id: event.id, tool: event.tool, phase: event.phase, status: event.failed ? "failed" : event.phase,
      });
      if (event.type === "provider_error") log.event("runtime.provider", "ERROR", { stage: "claude", session_id: observed ?? session,
        native_reason: event.reason, corrective_action: "Check the selected provider credentials, model and endpoint before resuming." });
      if (event.type === "provider_retry") log.event("runtime.provider", "WARN", { stage: "claude", session_id: observed ?? session,
        native_reason: event.reason, attempt: event.attempt, max_retries: event.max_retries, retry_delay_ms: event.retry_delay_ms, http_status: event.http_status });
      if (event.type === "result") { terminal = true; if (!event.success) failure = event.reason; }
    },
  });
  requireValue(!identityChanged && observed && (!session || observed === session), "conversation_identity_changed", "claude");
  if (!terminal || failure) throw new RunnerError("claude_native_failure", "claude", "Claude did not return a successful native result.", { native_reason: failure ?? "missing_result" });
  return { session: observed, result: await readFile(output, "utf8") };
}
