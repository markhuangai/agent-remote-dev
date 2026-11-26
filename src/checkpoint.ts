import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { hash, requireValue, RunnerError, versions } from "./contracts.js";
import { removeJob } from "./setup.js";
import type { Job } from "./setup.js";
import type { Diagnostics } from "./diagnostics.js";
import { checkpointBytes, checkpointName, checkpointSchema, validateManifest } from "./platform/checkpoint-policy.mjs";
import type { ProcessControl } from "./process.js";
import { runnerAdapter } from "./runners.js";
import { inspectCredentials } from "./credentials.js";
export { inspectCredentials } from "./credentials.js";
export { validateDatabase } from "./codex-state.js";

export const checkpointLimit = checkpointBytes;
export type DurableCheckpoint = { artifact_id: number; checkpoint_sha: string; sequence: number };
export type CheckpointInput = { repository: string; branch: string | null; checkpoint_sha: string; omitted_work: boolean;
  session_id: string; root_run_id: string; activation_run_id: string; operator: string; auto_count: number;
  provider_sha?: string; sequence?: number; lineage: any; outcome: "running" | "completed" | "failed" | "cancelled";
  recovery_reason?: "native_worker_sigkill"; workspace: string; previous?: DurableCheckpoint | null };
export async function exportCheckpoint(job: Job, input: CheckpointInput, log: Diagnostics, limit = checkpointLimit, control?: ProcessControl) {
  const sequence = input.sequence ?? (input.previous?.sequence ?? 0) + 1;
  const root = await mkdtemp(join(job.exports, `snapshot-${sequence}-`));
  try {
    const adapter = runnerAdapter(job.runner);
    const files = await adapter.capture(job, root, input, log, limit, control);
    const inventory = []; let bytes = 0;
    for (const file of files) {
      const data = await readFile(file); bytes += data.length;
      requireValue(bytes <= limit, "checkpoint_size_limit", "checkpoint");
      inspectCredentials(data, log);
      inventory.push({ path: relative(root, file), sha256: hash(data), bytes: data.length });
    }
    const { previous, ...metadata } = input;
    const manifest = { schema_version: checkpointSchema, ...metadata, runner: job.runner,
      runner_version: versions[job.runner], runner_home: job.runnerHome, sequence, files: inventory };
    inspectCredentials(manifest, log, "credential_in_manifest");
    const encoded = JSON.stringify(manifest);
    requireValue(bytes + Buffer.byteLength(encoded) <= limit, "checkpoint_size_limit", "checkpoint");
    validateManifest(manifest, { repository: input.repository, runner: job.runner, runnerVersion: adapter.version });
    await writeFile(join(root, "manifest.json"), encoded, {mode:0o600});
    log.event("checkpoint.export", "INFO", { runner: job.runner, runner_version: adapter.version, sequence,
      file_count: files.length, bytes, checkpoint_sha: input.checkpoint_sha, omitted_work: input.omitted_work, outcome: "validated" });
    return { root, files: [...files, join(root,"manifest.json")], sequence, manifest, name: checkpointName(manifest) };
  } catch (error) { await removeJob(root); throw error; }
}
export async function durableCheckpoint(job: Job, input: CheckpointInput, log: Diagnostics,
  upload: (name: string, files: string[], root: string) => Promise<{ id?: number }>, control?: ProcessControl) {
  const counterPath = join(job.exports, "sequence.json");
  let previous = 0;
  try { previous = JSON.parse(await readFile(counterPath, "utf8")); } catch (error: any) { if (error.code !== "ENOENT") throw error; }
  const sequence = Math.max(previous, input.previous?.sequence ?? 0) + 1;
  await writeFile(counterPath, JSON.stringify(sequence), { mode: 0o600 });
  const exported = await exportCheckpoint(job, { ...input, sequence }, log, checkpointLimit, control);
  try {
    let result;
    try { result = await upload(exported.name, exported.files, exported.root); }
    catch (error) { throw new RunnerError("artifact_upload_failed", "checkpoint", "Snapshot upload failed; the previous artifact remains available.",
      { cause_reason: error instanceof RunnerError ? error.reason : "artifact_transport_failed",
        cause_elapsed_ms: error instanceof RunnerError ? error.details.elapsed_ms : undefined,
        cause_exit_code: error instanceof RunnerError ? error.details.exit_code : undefined }); }
    requireValue(Number.isSafeInteger(result.id) && result.id! > 0, "missing_artifact_receipt", "checkpoint");
    const receipt = { artifact_id: result.id!, checkpoint_sha: input.checkpoint_sha, sequence: exported.sequence };
    log.event("checkpoint.complete", "INFO", receipt);
    return receipt;
  } finally { await removeJob(exported.root); }
}
