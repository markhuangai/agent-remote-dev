import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { object, requireValue, RunnerError } from "./contracts.js";
import { protectConfiguration } from "./credentials.js";
import { command } from "./process.js";
import type { ProcessControl } from "./process.js";
import type { Job } from "./setup.js";
import type { Diagnostics } from "./diagnostics.js";
import type { McpConfiguration } from "./mcp-config.js";
import { boundedLines, editForPath, showEdit } from "./activity.js";

export async function configureClaude(job: Job, raw: string, log: Diagnostics, mcp: McpConfiguration) {
  let settings: unknown;
  try { settings = JSON.parse(raw); }
  catch { throw new RunnerError("invalid_claude_config", "configuration", "Claude settings JSON could not be parsed; contents withheld."); }
  requireValue(object(settings), "invalid_claude_config", "configuration");
  protectConfiguration(settings, log, "", "CLAUDE_SETTINGS_JSON");
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
  if (Object.keys(mcp.shared).length) {
    await writeFile(join(job.runnerHome, ".claude.json"), JSON.stringify({ mcpServers: mcp.shared }), { mode: 0o600 });
  }
  log.event("runtime.setup", "INFO", { stage: "configuration", runner: "claude", outcome: "success",
    mcp_servers: Object.keys({ ...mcp.shared, ...mcp.repository }), paths: { home: job.home, runner_home: job.runnerHome } });
}

export async function runClaude(job: Job, cwd: string, prompt: string, log: Diagnostics, timeoutMs: number, ordinal: string, session?: string,
  onSession?: (id: string) => void, onControl?: (control: ProcessControl) => void) {
  log.ensureWorkspace(cwd);
  const output = join(job.root, `result-${ordinal}.txt`);
  let observed: string | undefined, conflictingSession: string | undefined, identityChanged = false, terminal = false, failure: string | undefined;
  let unparsed = 0;
  try { await command(process.execPath, [join(import.meta.dirname, "claude-worker.js"), output, session ?? ""], {
    cwd, env: job.env, stage: "claude", onControl, log, timeoutMs, stdin: JSON.stringify({ prompt, secrets: log.protectedValues }), collect: false,
    nativeSessionUnfinished: () => Boolean(observed) && !identityChanged && !terminal,
    onLine(line) {
      let event: any; try { event = JSON.parse(line); } catch { unparsed = Math.min(unparsed + 1, 1000000); return; }
      if (event.type === "omitted") log.event("runtime.native_stream", "INFO", { stage: "claude", reason: "event_exceeded_output_limit", truncated: true });
      if (event.type === "session" && typeof event.session === "string") {
        if (session && event.session !== session || observed && event.session !== observed) {
          identityChanged = true; conflictingSession ??= event.session; return;
        }
        observed = event.session; onSession?.(observed!);
        log.event("runtime.session", "INFO", { session_id: observed, outcome: session ? "resumed" : "created" });
      }
      if (event.type === "thinking" && typeof event.text === "string") log.group(event.parent ? "Subagent thinking" : "Thinking", boundedLines(log.redact(event.text)), { untrusted: true });
      if (event.type === "text" && typeof event.text === "string") log.line(`${event.parent ? "[subagent]" : "[agent]"} ${event.text}`);
      if (event.type === "tool" && observed && !identityChanged) {
        log.event("runtime.tool", "INFO", { session_id: observed, item_id: event.id, tool: event.tool, phase: event.phase,
          status: event.failed ? "failed" : event.phase, exit_code: event.exit_code, elapsed_ms: event.elapsed_ms, parent_tool_use_id: event.parent });
        if (event.phase === "completed") {
          if (["Edit", "Write", "NotebookEdit", "MultiEdit"].includes(event.tool)) {
            if (event.failed) log.line("[edit] failed");
            else if (typeof event.path === "string") {
              const edit = editForPath(event.path, "update", typeof event.diff === "string" ? event.diff : undefined, cwd);
              if (event.suppressed) { edit.suppressed = event.suppressed; delete edit.diff; }
              showEdit(log, edit);
            }
          } else if (event.tool === "Bash") log.line(`[cmd] ${event.command ?? "shell"} (${event.failed ? "failed" : "completed"}, exit ${event.exit_code ?? "unknown"}, ${event.elapsed_ms ?? 0} ms)`);
          else if (typeof event.plan === "string") log.group("Plan", boundedLines(log.redact(event.plan)), { untrusted: true });
          else if (/^(?:Agent|Task)$/.test(event.tool)) log.line(`[subagent] ${event.failed ? "failed" : "completed"}`);
          else if (/^mcp__/i.test(event.tool)) log.line(`[mcp] ${event.tool} (${event.failed ? "failed" : "completed"})`);
          else if (/^Web(?:Search|Fetch)$/.test(event.tool)) log.line(`[web] ${event.tool} (${event.failed ? "failed" : "completed"})`);
        }
      }
      if (event.type === "provider_error") log.event("runtime.provider", "ERROR", { stage: "claude", session_id: observed ?? session,
        native_reason: event.reason, corrective_action: "Check the selected provider credentials, model and endpoint before resuming." });
      if (event.type === "provider_retry") log.event("runtime.provider", "WARN", { stage: "claude", session_id: observed ?? session,
        native_reason: event.reason, attempt: event.attempt, max_retries: event.max_retries, retry_delay_ms: event.retry_delay_ms, http_status: event.http_status });
      if (event.type === "result") { terminal = true; if (!event.success) failure = event.reason; }
    },
  }); } catch (error) {
    if (error instanceof RunnerError) {
      error.details.unparsed_stdout_lines = unparsed;
      if (identityChanged) Object.assign(error.details, { expected_session: session ?? observed ?? null, observed_session: conflictingSession ?? null });
    }
    throw error;
  } finally {
    log.event("runtime.native_stream", "INFO", { stage: "claude", session_id: observed ?? session, unparsed_stdout_lines: unparsed });
  }
  if (identityChanged || !observed || session && observed !== session) throw new RunnerError("conversation_identity_changed", "claude", "Claude did not return the expected conversation identity.", {
    expected_session: session ?? observed ?? null, observed_session: conflictingSession ?? observed ?? null, unparsed_stdout_lines: unparsed,
  });
  if (!terminal || failure) throw new RunnerError("claude_native_failure", "claude", "Claude did not return a successful native result.", { native_reason: failure ?? "missing_result", unparsed_stdout_lines: unparsed });
  return { session: observed, result: await readFile(output, "utf8") };
}
