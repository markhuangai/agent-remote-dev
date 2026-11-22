import { spawn } from "node:child_process";
import { openSync, closeSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DefaultArtifactClient } from "@actions/artifact";
import { command, processControl } from "./process.js";
import { requireValue, RunnerError } from "./contracts.js";
import { durableCheckpoint } from "./checkpoint.js";
import { TaskGit } from "./git.js";
import { Diagnostics } from "./diagnostics.js";
import { pruneSnapshots } from "./platform/continuation-policy.mjs";
import type { Job } from "./setup.js";
import type { SavedRun } from "./main.js";

export async function checkpointWorker(path: string) {
  const request = JSON.parse(await readFile(path, "utf8"));
  const result = await new DefaultArtifactClient().uploadArtifact(request.name, request.files, request.root);
  requireValue(Number.isSafeInteger(result.id) && result.id! > 0, "missing_artifact_receipt", "checkpoint");
  await writeFile(request.result, JSON.stringify({ id: result.id }), { mode: 0o600 });
}
export async function uploadSnapshot(job: Job, name: string, files: string[], root: string, log: Diagnostics, environment = process.env) {
  const request = join(root, "upload.json"), result = join(root, "receipt.json");
  await writeFile(request, JSON.stringify({ name, files, root, result }), { mode: 0o600 });
  await command(process.execPath, [join(import.meta.dirname, "entry.js"), "--upload", request], {
    cwd: job.root, env: environment, stage: "artifact_upload", log, timeoutMs: Number(environment.REMOTE_DEV_UPLOAD_TIMEOUT_MS ?? 45000), collect: false,
  });
  return JSON.parse(await readFile(result, "utf8"));
}
export async function startSnapshots(path: string, job: Job) {
  const fd = openSync(join(job.root, "snapshots.log"), "a", 0o600);
  try {
    const worker = spawn(process.execPath, [join(import.meta.dirname, "entry.js"), "--watch", path], {
      cwd: job.root, env: process.env, detached: true, stdio: ["ignore", fd, fd],
    });
    await new Promise<void>((resolve, reject) => { worker.once("spawn", resolve); worker.once("error", reject); });
    worker.unref(); return worker.pid;
  } finally { closeSync(fd); }
}
export async function latestSnapshot(job: Job) {
  try { return JSON.parse(await readFile(join(job.root, "latest.json"), "utf8")); }
  catch (error: any) { if (error.code !== "ENOENT") throw error; return null; }
}
export async function saveSnapshot(saved: SavedRun, log: Diagnostics, api: any, upload = uploadSnapshot) {
  const git = new TaskGit(saved.metadata.workspace, saved.job.env, log);
  const receipt = await durableCheckpoint(saved.job, { ...saved.metadata, ...await git.snapshot(), previous: await latestSnapshot(saved.job) }, log,
    (name, files, root) => upload(saved.job, name, files, root, log),
    saved.metadata.outcome === "running" && saved.control ? processControl(saved.control.directory, saved.control.nonce) : undefined);
  await writeFile(join(saved.job.root, "latest.json"), JSON.stringify(receipt), { mode: 0o600 });
  try { await pruneSnapshots(api, saved.metadata.repository, saved.metadata.lineage.run_id, saved.metadata.lineage.run_attempt); }
  catch { log.event("checkpoint.retention", "WARN", { reason: "snapshot_prune_failed", artifact_id: receipt.artifact_id }); }
  return receipt;
}
export async function watchSnapshots(path: string, options: {
  intervalMs?: number; api?: any; upload?: typeof uploadSnapshot; emit?: (line: string | Error) => void;
} = {}) {
  const initial: SavedRun = JSON.parse(await readFile(path, "utf8"));
  const emit = options.emit ?? ((line: string | Error) => process.stdout.write(String(line) + "\n"));
  const log = new Diagnostics({ repository: initial.metadata.repository, runner: initial.job.runner, run_id: initial.metadata.lineage.run_id, run_attempt: initial.metadata.lineage.run_attempt, workflow_sha: initial.metadata.lineage.workflow_sha }, { info: emit, warning: emit, error: emit, debug: emit });
  for (const secret of initial.secrets) log.protect(secret);
  const api = options.api ?? (async (endpoint: string, options: any = {}) => {
    const response = await fetch(`https://api.github.com${endpoint}`, { method: options.method ?? "GET", signal: AbortSignal.timeout(20000),
      headers: { authorization: `Bearer ${process.env.REMOTE_DEV_PLATFORM_TOKEN}`, accept: "application/vnd.github+json" } });
    requireValue(response.ok, "snapshot_retention_api_failed", "checkpoint");
    return response.status === 204 ? null : response.json();
  });
  const intervalMs = options.intervalMs ?? 60000;
  let next = 0;
  try {
    for (;;) {
      const saved: SavedRun = JSON.parse(await readFile(path, "utf8"));
      if (saved.metadata.outcome !== "running") break;
      if (saved.control && saved.metadata.session_id && Date.now() >= next) {
        next = Date.now() + intervalMs;
        log.fields.session_id = saved.metadata.session_id;
        try { await saveSnapshot(saved, log, api, options.upload); }
        catch (error) {
          const previous = await latestSnapshot(saved.job);
          if (error instanceof RunnerError && error.reason === "snapshot_pause_deferred") {
            log.event("checkpoint.deferred", "WARN", { stage: error.stage, reason: error.reason, ...error.details,
              last_durable_checkpoint: previous, retry_interval_ms: intervalMs });
          } else log.failure(error, previous);
        }
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  } finally { await writeFile(join(initial.job.root, "snapshots-done"), "done", { mode: 0o600 }); }
}
export async function waitSnapshots(saved: SavedRun) {
  const deadline = Date.now() + 90000;
  while (saved.watcher_pid) {
    try { await readFile(join(saved.job.root, "snapshots-done")); return; }
    catch (error: any) { if (error.code !== "ENOENT") throw error; }
    try { process.kill(saved.watcher_pid, 0); } catch (error: any) { if (error.code === "ESRCH") return; throw error; }
    requireValue(Date.now() < deadline, "snapshot_worker_stop_timeout", "checkpoint");
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}
