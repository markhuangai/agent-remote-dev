import { query } from "@anthropic-ai/claude-agent-sdk";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { boundedLines, editForPath, summarizeCommand } from "./activity.js";
import { Diagnostics } from "./diagnostics.js";

type Tool = { name: string; input: Record<string, any>; started: number; parent: string | null };

async function main() {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  const log = new Diagnostics({}, { info() {}, warning() {}, error() {}, debug() {} }, { maskSecrets: false });
  for (const secret of request.secrets) log.protect(secret);
  const emit = (value: Record<string, unknown>) => {
    let encoded = JSON.stringify(value);
    if (Buffer.byteLength(encoded) > 64 * 1024) {
      encoded = JSON.stringify({ type: value.type, id: value.id, tool: value.tool, phase: value.phase,
        failed: value.failed, omitted: "event exceeded output limit" });
    }
    process.stdout.write(encoded + "\n");
  };
  const text = (value: unknown) => boundedLines(log.redact(typeof value === "string" ? value : "")).join("\n");
  const settings = JSON.parse(await readFile(join(process.env.CLAUDE_CONFIG_DIR!, "settings.json"), "utf8"));
  const session = process.argv[3] || undefined;
  const tools = new Map<string, Tool>();
  let pending: { id: string; content: string; parent: string | null } | undefined;
  const flushText = (result?: string) => {
    if (pending && pending.content.trim() !== result?.trim()) emit({ type: "text", text: text(pending.content), parent: pending.parent });
    pending = undefined;
  };
  const invocation = query({ prompt: request.prompt, options: {
    cwd: process.cwd(), env: { ...settings.env, ...process.env },
    settings: { ...settings, env: { ...settings.env, ...process.env } },
    settingSources: ["user", "project"], systemPrompt: { type: "preset", preset: "claude_code" },
    tools: { type: "preset", preset: "claude_code" }, permissionMode: "bypassPermissions",
    allowedTools: ["TaskCreate", "TaskList", "TaskGet", "TaskUpdate"],
    allowDangerouslySkipPermissions: true, permissionPrompts: "none", sandbox: { enabled: false },
    persistSession: true, resume: session,
  } });
  try {
    for await (const message of invocation) {
      if (message.type === "assistant" && message.error) emit({ type: "provider_error", reason: message.error });
      if (message.type === "system" && message.subtype === "api_retry") emit({ type: "provider_retry", reason: message.error,
        attempt: message.attempt, max_retries: message.max_retries, retry_delay_ms: message.retry_delay_ms, http_status: message.error_status });
      if (message.type === "system" && message.subtype === "init") emit({ type: "session", session: message.session_id });
      if (message.type === "assistant") for (const block of message.message.content) {
        if (block.type === "text") {
          const parent = message.parent_tool_use_id;
          if (pending && (pending.id !== message.message.id || pending.parent !== parent)) flushText();
          if (!pending) pending = { id: message.message.id, content: "", parent };
          pending.content += block.text;
        } else {
          flushText();
          if (block.type === "thinking") emit({ type: "thinking", text: text(block.thinking), parent: message.parent_tool_use_id });
          if (block.type === "redacted_thinking") emit({ type: "thinking", text: "[redacted thinking]", parent: message.parent_tool_use_id });
          if (block.type === "tool_use") {
            const input = block.input && typeof block.input === "object" ? block.input as Record<string, any> : {};
            tools.set(block.id, { name: block.name, input, started: Date.now(), parent: message.parent_tool_use_id });
            emit({ type: "tool", id: block.id, tool: block.name, phase: "started", parent: message.parent_tool_use_id });
          }
        }
      }
      if (message.type === "user" && Array.isArray(message.message.content)) {
        const blocks = message.message.content.filter(block => block.type === "tool_result");
        for (const block of blocks) {
          if (block.type !== "tool_result") continue;
          const tool = tools.get(block.tool_use_id);
          if (!tool) continue;
          const input = tool.input;
          const inputPath = input.file_path ?? input.notebook_path;
          const result = message.tool_use_result && typeof message.tool_use_result === "object" ? message.tool_use_result as Record<string, any> : {};
          const resultPath = result.filePath ?? result.notebook_path;
          const matching = blocks.length === 1 || typeof resultPath === "string" && resultPath === inputPath;
          const safeResult = matching ? result : {};
          const event: Record<string, unknown> = { type: "tool", id: block.tool_use_id, tool: tool.name, phase: "completed",
            failed: block.is_error === true || safeResult.staged === true, parent: tool.parent, elapsed_ms: Date.now() - tool.started };
          if (tool.name === "Bash" && typeof input.command === "string") {
            event.command = summarizeCommand(input.command, process.cwd());
            const exitCode = safeResult.exit_code ?? safeResult.exitCode;
            if (Number.isInteger(exitCode)) { event.exit_code = exitCode; if (exitCode !== 0) event.failed = true; }
          }
          if (/^Task(?:Create|Update)$/.test(tool.name) && !event.failed) {
            const description = input.subject ?? input.status;
            if (typeof description === "string") event.plan = text(description);
          }
          if (tool.name === "TodoWrite" && Array.isArray(input.todos) && !event.failed) {
            event.plan = text(input.todos.slice(0, 100).map((todo: any) => `${todo.status ?? "pending"}: ${todo.content ?? ""}`).join("\n"));
          }
          if (["Edit", "Write", "NotebookEdit", "MultiEdit"].includes(tool.name) && typeof inputPath === "string") {
            const path = editForPath(inputPath, "update", undefined, process.cwd());
            event.path = path.path;
            event.suppressed = path.suppressed;
            if (!event.failed && !path.suppressed) {
              let diff = "";
              if (Array.isArray(safeResult.structuredPatch) && safeResult.structuredPatch.length) diff = safeResult.structuredPatch.map((hunk: any) =>
                `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@\n${Array.isArray(hunk.lines) ? hunk.lines.join("\n") : ""}`).join("\n");
              else if (tool.name === "NotebookEdit") diff = `- ${safeResult.old_source ?? ""}\n+ ${safeResult.new_source ?? input.new_source ?? ""}`;
              else if (tool.name === "Write") diff = String(input.content ?? "").split("\n").map((line: string) => `+${line}`).join("\n");
              else if (tool.name === "MultiEdit" && Array.isArray(input.edits)) diff = input.edits.map((edit: any) => `-${edit.old_string ?? ""}\n+${edit.new_string ?? ""}`).join("\n");
              else diff = `-${input.old_string ?? ""}\n+${input.new_string ?? ""}`;
              event.diff = text(diff);
            }
          }
          emit(event);
          tools.delete(block.tool_use_id);
        }
      }
      if (message.type === "result") {
        const success = message.subtype === "success" && !message.is_error;
        flushText(success ? message.result : undefined);
        await writeFile(process.argv[2], success ? message.result : "", { mode: 0o600 });
        emit({ type: "result", success, reason: message.subtype });
      }
    }
  } finally { flushText(); }
}
main().catch(error => {
  process.stdout.write(JSON.stringify({ type: "result", success: false, reason: "sdk_failure" }) + "\n");
  process.stderr.write(error instanceof Error ? error.message : "Claude SDK invocation failed.");
  process.exitCode = 1;
});
