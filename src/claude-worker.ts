import { query } from "@anthropic-ai/claude-agent-sdk";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const emit = (value: unknown) => process.stdout.write(JSON.stringify(value) + "\n");
async function main() {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  const settings = JSON.parse(await readFile(join(process.env.CLAUDE_CONFIG_DIR!, "settings.json"), "utf8"));
  const session = process.argv[3] || undefined;
  const tools = new Map<string, string>();
  const invocation = query({ prompt: Buffer.concat(chunks).toString("utf8"), options: {
    cwd: process.cwd(), env: { ...settings.env, ...process.env },
    settings: { ...settings, env: { ...settings.env, ...process.env } },
    settingSources: ["user", "project"], systemPrompt: { type: "preset", preset: "claude_code" },
    tools: { type: "preset", preset: "claude_code" }, permissionMode: "bypassPermissions",
    allowedTools: ["TaskCreate", "TaskList", "TaskGet", "TaskUpdate"],
    allowDangerouslySkipPermissions: true, permissionPrompts: "none", sandbox: { enabled: false },
    persistSession: true, resume: session,
  } });
  for await (const message of invocation) {
    if (message.type === "assistant" && message.error) emit({ type: "provider_error", reason: message.error });
    if (message.type === "system" && message.subtype === "api_retry") emit({ type: "provider_retry", reason: message.error,
      attempt: message.attempt, max_retries: message.max_retries, retry_delay_ms: message.retry_delay_ms, http_status: message.error_status });
    if (message.type === "system" && message.subtype === "init") emit({ type: "session", session: message.session_id });
    if (message.type === "assistant") for (const block of message.message.content) {
      if (block.type === "tool_use") { tools.set(block.id, block.name); emit({ type: "tool", id: block.id, tool: block.name, phase: "started" }); }
    }
    if (message.type === "user" && Array.isArray(message.message.content)) for (const block of message.message.content) {
      if (block.type === "tool_result") emit({ type: "tool", id: block.tool_use_id, tool: tools.get(block.tool_use_id), phase: "completed", failed: block.is_error === true });
    }
    if (message.type === "result") {
      const success = message.subtype === "success" && !message.is_error;
      await writeFile(process.argv[2], success ? message.result : "", { mode: 0o600 });
      emit({ type: "result", success, reason: message.subtype });
    }
  }
}
main().catch(error => {
  emit({ type: "result", success: false, reason: "sdk_failure" });
  process.stderr.write(error instanceof Error ? error.message : "Claude SDK invocation failed.");
  process.exitCode = 1;
});
