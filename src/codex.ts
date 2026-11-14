import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { command } from "./process.js";
import { Job } from "./setup.js";
import { Diagnostics } from "./diagnostics.js";
import { PermissionMode, requireValue, RunnerError, turnSchema } from "./contracts.js";

export function codexArgs(job: Job, cwd: string, mode: PermissionMode | "read-only", schemaPath: string, output: string, session?: string) {
  const sandbox = mode === "full-access" ? ["--dangerously-bypass-approvals-and-sandbox"] : ["-s", mode === "read-only" ? "read-only" : "workspace-write"];
  const overrides = ["-c", 'approval_policy="never"', "-c", "allow_login_shell=false",
    "-c", `sqlite_home=${JSON.stringify(job.codexHome)}`, "-c", `log_dir=${JSON.stringify(join(job.root, "logs"))}`];
  if (mode === "sandboxed") overrides.push("-c", "sandbox_workspace_write.network_access=true", "-c",
    `sandbox_workspace_write.writable_roots=${JSON.stringify([join(cwd, ".git"), job.root])}`);
  const base = ["exec", ...sandbox, "-C", cwd, ...overrides, "--json", "--color", "never", "--output-schema", schemaPath, "--output-last-message", output];
  return session ? [...base, "resume", session, "-"] : [...base, "-"];
}
export async function runCodex(job: Job, cwd: string, mode: PermissionMode | "read-only", prompt: string, log: Diagnostics,
  timeoutMs: number, ordinal: string, session?: string, schema: unknown = turnSchema) {
  const schemaPath = join(job.root, `schema-${ordinal}.json`), output = join(job.root, `result-${ordinal}.json`);
  await writeFile(schemaPath, JSON.stringify(schema), { mode: 0o600 });
  let observed: string | undefined;
  let sandboxCause: string | undefined;
  await command(join(job.tools, "node_modules/.bin/codex"), codexArgs(job, cwd, mode, schemaPath, output, session), {
    cwd, env: job.env, stage: ordinal.startsWith("audit-") ? "audit" : "worker", log, timeoutMs, stdin: prompt, collect: false,
    onLine(line) {
      let value: any;
      try { value = JSON.parse(line); } catch { return; }
      if (value.type === "thread.started" && typeof value.thread_id === "string") observed = value.thread_id;
      const output = value.item?.aggregated_output ?? value.item?.message;
      if (mode !== "full-access" && typeof output === "string" && /bwrap: No permissions to create (?:a )?new namespace/.test(output)) {
        sandboxCause = output.split("\n").find((line: string) => line.includes("bwrap: No permissions"));
      }
    },
  });
  if (sandboxCause) throw new RunnerError("sandbox_startup_failed", "worker", sandboxCause);
  requireValue(observed && (!session || observed === session), "conversation_identity_changed", "worker");
  return { session: observed, result: await readFile(output, "utf8") };
}
export const auditSchema = { type: "object", additionalProperties: false, properties: {
  auditor: { type: "object", additionalProperties: false, properties: { session: { type: "string" }, model: { type: "string" } }, required: ["session", "model"] },
  base_sha: { type: "string" }, audited_state: { type: "string" },
  verdict: { type: "string", enum: ["conformant", "nonconformant", "blocked"] },
  findings: { type: "array", items: { type: "object", additionalProperties: false, properties: {
    plan_item: { type: "string" }, category: { type: "string", enum: ["missing_behavior", "contradiction", "unapproved_scope", "planned_test_gap"] },
    evidence: { type: "string" }, gap: { type: "string" }, required_outcome: { type: "string" }, guidance: { type: "string" },
  }, required: ["plan_item", "category", "evidence", "gap", "required_outcome", "guidance"] } },
  summary: { type: "string" },
}, required: ["verdict", "auditor", "base_sha", "audited_state", "findings", "summary"] };
