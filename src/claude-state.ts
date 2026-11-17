import { cp, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { requireValue, RunnerError } from "./contracts.js";
import { inspectCredentials } from "./credentials.js";
import { safeTree } from "./setup.js";
import { allowedStatePath, checkpointBytes } from "./platform/checkpoint-policy.mjs";
import type { Job } from "./setup.js";
import type { Diagnostics } from "./diagnostics.js";
import type { CheckpointInput } from "./checkpoint.js";
import type { ProcessControl } from "./process.js";

async function validateState(root: string, files: string[], session: string, log: Diagnostics, limit: number) {
  let bytes = 0, found = false;
  for (const file of files) {
    const path = relative(root, file);
    requireValue(allowedStatePath("claude", `claude/${path}`), "unsafe_checkpoint_path", "checkpoint");
    const data = await readFile(file); bytes += data.length;
    requireValue(bytes <= limit, "checkpoint_size_limit", "checkpoint");
    inspectCredentials(data, log);
    if (file.endsWith(".jsonl")) {
      let rows: any[];
      try { rows = data.toString("utf8").trimEnd().split("\n").map(line => JSON.parse(line)); }
      catch { throw new RunnerError("invalid_session_history", "checkpoint"); }
      inspectCredentials(rows, log);
      if (path.endsWith(`/${session}.jsonl`)) {
        requireValue(rows.some(row => row.sessionId === session), "checkpoint_session_mismatch", "checkpoint");
        found = true;
      }
    } else if (file.endsWith(".json")) {
      let value: unknown;
      try { value = JSON.parse(data.toString("utf8")); } catch { throw new RunnerError("invalid_native_state", "checkpoint"); }
      inspectCredentials(value, log);
    } else if (file.endsWith(".md") || file.endsWith(".txt")) inspectCredentials(data.toString("utf8"), log);
  }
  requireValue(found, "missing_session_history", "checkpoint");
}
export async function captureClaude(job: Job, root: string, input: CheckpointInput, log: Diagnostics, limit: number, control?: ProcessControl) {
  const target = join(root, "claude"); await mkdir(target, { mode: 0o700 });
  const copy = async () => {
    let bytes = 0;
    for (const directory of ["projects", "tasks", "agent-memory"]) {
      const source = join(job.runnerHome, directory);
      try { await lstat(source); } catch (error: any) { if (error.code === "ENOENT") continue; throw error; }
      for (const file of await safeTree(source)) {
        const path = relative(job.runnerHome, file);
        if (!allowedStatePath("claude", `claude/${path}`)) continue;
        bytes += (await lstat(file)).size;
        requireValue(bytes <= limit, "checkpoint_size_limit", "checkpoint");
        const destination = join(target, path); await mkdir(join(destination, ".."), { recursive: true, mode: 0o700 });
        await cp(file, destination);
      }
    }
  };
  if (control) await control.freeze(copy); else await copy();
  const files = await safeTree(target); await validateState(target, files, input.session_id, log, limit);
  return files;
}
export async function restoreClaude(job: Job, root: string, manifest: any, cwd: string, log: Diagnostics) {
  const source = join(root, "claude"), files = await safeTree(source);
  await validateState(source, files, manifest.session_id, log, checkpointBytes);
  for (const file of files) {
    const destination = join(job.runnerHome, relative(source, file));
    await mkdir(join(destination, ".."), { recursive: true, mode: 0o700 });
    await cp(file, destination, { force: false, errorOnExist: true });
    if (/\.(jsonl|json|md|txt)$/.test(file)) {
      const data = await readFile(file, "utf8");
      const relocated = data.replaceAll(manifest.runner_home, job.runnerHome).replaceAll(manifest.workspace, cwd);
      if (relocated !== data) await writeFile(destination, relocated, { mode: 0o600 });
    }
  }
}
