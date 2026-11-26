import { spawn } from "node:child_process";
import { channel } from "node:diagnostics_channel";
import { openSync, closeSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import type { ClientRequest } from "node:http";
import { join } from "node:path";
import { DefaultArtifactClient } from "@actions/artifact";
import { command, processControl } from "./process.js";
import { requireValue, RunnerError, versions } from "./contracts.js";
import { durableCheckpoint } from "./checkpoint.js";
import { TaskGit } from "./git.js";
import { Diagnostics } from "./diagnostics.js";
import { pruneSnapshots } from "./platform/continuation-policy.mjs";
import { reconcileUpload } from "./platform/artifact-io.mjs";
import { safeError } from "./platform/runtime-log.mjs";
import type { CheckpointInput } from "./checkpoint.js";
import type { Job } from "./setup.js";
import type { SavedRun } from "./main.js";

const uploadAttempted = "remote-dev:artifact-upload-attempted";
export async function checkpointWorker(path: string) {
  const request = JSON.parse(await readFile(path, "utf8"));
  const requests = channel("http.client.request.start");
  let attempted = false;
  // The pinned SDK validates local inputs before issuing CreateArtifact.
  const observe = (message: unknown) => {
    const { request: outgoing } = message as { request: ClientRequest };
    if (!attempted && outgoing.method === "POST" && outgoing.path === "/twirp/github.actions.results.api.v1.ArtifactService/CreateArtifact") {
      attempted = true;
      process.stdout.write(uploadAttempted + "\n");
    }
  };
  if (request.observeUpload) requests.subscribe(observe);
  try {
    const result = await new DefaultArtifactClient().uploadArtifact(request.name, request.files, request.root);
    requireValue(Number.isSafeInteger(result.id) && result.id! > 0, "missing_artifact_receipt", "checkpoint");
    await writeFile(request.result, JSON.stringify({ id: result.id }), { mode: 0o600 });
  } finally {
    if (request.observeUpload) requests.unsubscribe(observe);
  }
}
type FinalUpload = { api: (path: string, options?: any) => Promise<any>; metadata: CheckpointInput; kind: "checkpoint" | "record" };
export async function uploadSnapshot(job: Job, name: string, files: string[], root: string, log: Diagnostics, environment = process.env, final?: FinalUpload): Promise<{ id: number }> {
  const request = join(root, "upload.json"), result = join(root, "receipt.json");
  await writeFile(request, JSON.stringify({ name, files, root, result, observeUpload: Boolean(final) }), { mode: 0o600 });
  let attempted = false;
  try {
    await command(process.execPath, [join(import.meta.dirname, "entry.js"), "--upload", request], {
      cwd: job.root, env: environment, stage: "artifact_upload", log, timeoutMs: Number(environment.REMOTE_DEV_UPLOAD_TIMEOUT_MS ?? 45000), collect: false,
      onLine: final ? line => { if (line === uploadAttempted) attempted = true; } : undefined,
    });
    const receipt = JSON.parse(await readFile(result, "utf8"));
    requireValue(Number.isSafeInteger(receipt?.id) && receipt.id > 0, "missing_artifact_receipt", "artifact_upload");
    return receipt;
  } catch (error) {
    if (!final || !attempted || error instanceof RunnerError && error.reason === "command_cancelled") throw error;

    const started = Date.now(), signal = AbortSignal.timeout(20000);
    const { metadata, kind } = final;
    const fields = { stage: "artifact_upload", artifact_name: name, artifact_kind: kind, lookup_attempt: 1,
      upload_failure_reason: error instanceof RunnerError ? error.reason : "missing_artifact_receipt" };
    try {
      const receipt = await reconcileUpload({ api: path => final.api(path, { request: { signal } }),
        repository: metadata.repository, lineage: metadata.lineage, name, root, kind });
      log.event("artifact.reconcile", "INFO", { ...fields, outcome: "reconciled", reason: "artifact_verified",
        artifact_id: receipt.id, elapsed_ms: Date.now() - started });
      return receipt;
    } catch (failure) {
      log.event("artifact.reconcile", "WARN", { ...fields, ...safeError(failure), outcome: "unconfirmed", elapsed_ms: Date.now() - started });
      throw error;
    }
  }
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
  catch (error) { log.event("checkpoint.retention", "WARN", { ...safeError(error), reason: "snapshot_prune_failed", artifact_id: receipt.artifact_id }); }
  return receipt;
}
export async function watchSnapshots(path: string, options: {
  intervalMs?: number; api?: any; upload?: typeof uploadSnapshot; emit?: (line: string | Error) => void;
} = {}) {
  const initial: SavedRun = JSON.parse(await readFile(path, "utf8"));
  const emit = options.emit ?? ((line: string | Error) => process.stdout.write(String(line) + "\n"));
  const log = new Diagnostics({ repository: initial.metadata.repository, runner: initial.job.runner, runner_version: versions[initial.job.runner], run_id: initial.metadata.lineage.run_id, run_attempt: initial.metadata.lineage.run_attempt, workflow_sha: initial.metadata.lineage.workflow_sha }, { info: emit, warning: emit, error: emit, debug: emit, setSecret() {} }, { maskSecrets: false });
  log.setWorkspace(initial.metadata.workspace, [initial.job.root, initial.job.home, initial.job.runnerHome, process.env.RUNNER_TEMP ?? ""]);
  log.useCompactRecords();
  for (const secret of initial.secrets) log.protect(secret);
  const api = options.api ?? (async (endpoint: string, options: any = {}) => {
    const response = await fetch(`https://api.github.com${endpoint}`, { method: options.method ?? "GET", signal: AbortSignal.timeout(20000),
      headers: { authorization: `Bearer ${process.env.REMOTE_DEV_PLATFORM_TOKEN}`, accept: "application/vnd.github+json" } });
    if (!response.ok) throw Object.assign(new RunnerError("snapshot_retention_api_failed", "checkpoint"), {
      status: response.status, response: { headers: { "x-github-request-id": response.headers.get("x-github-request-id") } },
    });
    return response.status === 204 ? null : response.json();
  });
  const intervalMs = options.intervalMs ?? 60000;
  let next = 0, cycle = 0;
  try {
    for (;;) {
      const saved: SavedRun = JSON.parse(await readFile(path, "utf8"));
      if (saved.metadata.outcome !== "running") break;
      if (saved.control && saved.metadata.session_id && Date.now() >= next) {
        next = Date.now() + intervalMs;
        log.fields.session_id = saved.metadata.session_id;
        log.fields.cycle = ++cycle;
        const started = Date.now();
        let outcome = "completed";
        try { await saveSnapshot(saved, log, api, options.upload); }
        catch (error) {
          outcome = "failed";
          const previous = await latestSnapshot(saved.job);
          if (error instanceof RunnerError && error.reason === "snapshot_pause_deferred") {
            log.event("checkpoint.deferred", "WARN", { stage: error.stage, reason: error.reason, ...error.details,
              last_durable_checkpoint: previous, retry_interval_ms: intervalMs });
          } else log.failure(error, previous);
        } finally { log.event("checkpoint.cycle", "INFO", { cycle, outcome, elapsed_ms: Date.now() - started }); }
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
