import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { command } from "./process.js";
import { Job } from "./setup.js";
import { Diagnostics } from "./diagnostics.js";
import type { ProcessControl } from "./process.js";
import { RunnerError } from "./contracts.js";

// Command arguments can contain unpublished task content even after credential redaction.
const commandNames = new Set(["cat", "head", "tail", "sed", "rg", "ls", "find", "pwd", "git", "gh", "npm", "npx", "node",
  "python", "python3", "apply_patch", "make", "cargo", "go", "cd", "set", "printf", "echo", "test", "sleep", "curl", "wget"]);

export function codexArgs(job: Job, cwd: string, output: string, session?: string) {
  const overrides = ["-c", 'approval_policy="never"', "-c", "allow_login_shell=false",
    "-c", `sqlite_home=${JSON.stringify(job.codexHome)}`, "-c", `log_dir=${JSON.stringify(join(job.root, "logs"))}`];
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
