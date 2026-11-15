import { DatabaseSync } from "node:sqlite";
import { cp, lstat, mkdir, readFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { checkpointBytes, databases, positiveId, recordName, validateFrozenRoot, validateManifest, validateProducer } from "../.github/scripts/checkpoint-policy.mjs";
import { authorize, executionSource, parseJson, requireValue, RunnerError, skillSources, versions } from "./contracts.js";
import { Diagnostics } from "./diagnostics.js";
import { command } from "./process.js";
import { Job, safeTree } from "./setup.js";
import { TaskGit } from "./git.js";
import { zstdDecompressSync } from "node:zlib";
import { CheckpointInput, DurableCheckpoint } from "./checkpoint.js";
import { DriverState, Execution } from "./continuation.js";

export type Manifest = CheckpointInput & { schema_version: 2; execution: Execution; driver: DriverState; workspace: string; codex_home: string;
  sequence: number; files: { path: string; sha256: string; bytes: number }[]; plan_sha256: string };
export async function unpackArchive(job: Job, archive: string, destination: string, kind: "checkpoint" | "record", log: Diagnostics) {
  try { await command("python3", [join(import.meta.dirname, "archive.py"), archive, destination, kind], { cwd: job.root, env: job.env, stage: "resume_archive", log }); }
  catch (error) {
    let failure: any;
    try { failure = JSON.parse(error instanceof RunnerError ? error.nativeCause : "null"); } catch {}
    const allowed = ["archive_size_limit", "archive_entry_limit", "unsafe_archive_path", "duplicate_archive_entry", "encrypted_archive", "linked_archive_entry",
      "archive_expansion_limit", "missing_archive_manifest", "invalid_archive_manifest", "unsupported_checkpoint_schema", "invalid_checkpoint_inventory",
      "invalid_checkpoint_file", "unexpected_checkpoint_file", "archive_inventory_mismatch", "checkpoint_file_hash_mismatch", "restore_destination_exists", "archive_read_failed"];
    const reason = allowed.includes(failure?.reason) ? failure.reason : "unsafe_checkpoint_archive";
    throw new RunnerError(reason, "resume", "Archive validation rejected the requested checkpoint.", reason === "unsupported_checkpoint_schema" ?
      { expected: 2, observed: Number.isSafeInteger(failure.observed) ? failure.observed : null } : {});
  }
}
export function validateCheckpoint(value: unknown, repository: string, taskId?: string): Manifest {
  try {
    const manifest = validateManifest(value, { repository, taskId, versions });
    authorize(JSON.stringify(manifest.authorization), repository, manifest.plan);
    const sources = skillSources(JSON.stringify(manifest.skills.slice(1)));
    requireValue(JSON.stringify(sources) === JSON.stringify(manifest.skills) && JSON.stringify(manifest.skills[0]) === JSON.stringify(executionSource), "checkpoint_skill_revision_mismatch", "resume");
    return manifest as Manifest;
  } catch (error: any) {
    if (error instanceof RunnerError) throw error;
    throw new RunnerError(error.reason ?? "invalid_checkpoint_manifest", "resume", "Checkpoint invariant rejected.", error.details);
  }
}
export async function downloadArtifact(job: Job, api: (endpoint: string) => Promise<any>, repository: string, id: number,
  kind: "checkpoint" | "record", log: Diagnostics) {
  requireValue(positiveId(id), "invalid_artifact_id", "resume");
  const artifact = await api(`repos/${repository}/actions/artifacts/${id}`);
  if (artifact.id !== id || artifact.expired || !(Date.parse(artifact.expires_at) > Date.now())) throw new RunnerError("checkpoint_artifact_expired", "resume", "The requested artifact is missing, expired or has a different identity.", { artifact_id: id });
  requireValue(Number.isSafeInteger(artifact.size_in_bytes) && artifact.size_in_bytes > 0 && artifact.size_in_bytes <= (kind === "checkpoint" ? checkpointBytes : 2 * 1024 * 1024), "checkpoint_size_limit", "resume");
  const archive = join(job.staging, `artifact-${id}.zip`), root = join(job.staging, `artifact-${id}`);
  await command("gh", ["api", `repos/${repository}/actions/artifacts/${id}/zip`], { cwd: job.root, env: job.env, stage: "resume_download", stdoutFile: archive, log });
  await unpackArchive(job, archive, root, kind, log);
  return { artifact, root, value: parseJson(await readFile(join(root, kind === "checkpoint" ? "manifest.json" : "record.json"), "utf8"), "resume") };
}
export async function loadCheckpoint(job: Job, api: (endpoint: string) => Promise<any>, repository: string, id: number, log: Diagnostics, taskId?: string) {
  const started = Date.now();
  log.event("resume.validate", "INFO", { artifact_id: id, outcome: "started" });
  try {
    const loaded = await downloadArtifact(job, api, repository, id, "checkpoint", log);
    const manifest = validateCheckpoint(loaded.value, repository, taskId);
    const runId = String(manifest.lineage.run_id), attempt = String(manifest.lineage.run_attempt);
    const run = await api(`repos/${repository}/actions/runs/${runId}/attempts/${attempt}`);
    try { validateProducer(loaded.artifact, run, manifest, repository); }
    catch (error: any) { throw new RunnerError(error.reason, "resume", "Artifact producer does not match the checkpoint.", error.details); }
    requireValue(run.status === "completed", "checkpoint_producer_active", "resume");
    const workflow = await api(`repos/${repository}/actions/workflows/${run.workflow_id}`);
    requireValue(workflow.path === run.path && workflow.state === "active", "checkpoint_workflow_mismatch", "resume");
    const rootRun = await api(`repos/${repository}/actions/runs/${manifest.execution.root_run_id}/attempts/${manifest.execution.root_run_attempt}`);
    const artifacts: any[] = [];
    for (let page = 1; ; page++) {
      requireValue(page <= 100, "artifact_collection_truncated", "resume");
      const batch = await api(`repos/${repository}/actions/runs/${rootRun.id}/artifacts?per_page=100&page=${page}`);
      requireValue(Array.isArray(batch.artifacts), "invalid_artifact_collection", "resume");
      artifacts.push(...batch.artifacts);
      if (batch.artifacts.length < 100) break;
    }
    const matches = artifacts.filter(artifact => artifact.name === recordName("run", manifest.task_id, String(rootRun.id), String(rootRun.run_attempt)));
    requireValue(matches.length === 1, "missing_or_ambiguous_root_record", "resume");
    const rootRecord = await downloadArtifact(job, api, repository, matches[0].id, "record", log);
    requireValue(rootRecord.artifact.workflow_run?.id === rootRun.id, "root_record_producer_mismatch", "resume");
    try { validateFrozenRoot(manifest, rootRecord.value, rootRun); }
    catch (error: any) { throw new RunnerError(error.reason, "resume", "The checkpoint differs from its frozen root execution contract.", error.details); }
    log.event("resume.validate", "INFO", { artifact_id: id, producer_run_id: runId, producer_attempt: attempt, task_id: manifest.task_id,
      checkpoint_sha: manifest.checkpoint_sha, session_id: manifest.driver.worker_session, outcome: "verified", elapsed_ms: Date.now() - started });
    return { ...loaded, manifest, run, receipt: { artifact_id: id, checkpoint_sha: manifest.checkpoint_sha, sequence: manifest.sequence } as DurableCheckpoint };
  } catch (error: any) {
    log.event("resume.validate", "ERROR", { artifact_id: id, outcome: "rejected", reason: error.reason ?? "artifact_transport_failed", ...error.details,
      elapsed_ms: Date.now() - started, corrective_action: "Use an unexpired schema-2 checkpoint from the trusted task workflow and resolve the rejected invariant before resuming." });
    throw error;
  }
}
export async function restoreCheckpoint(job: Job, root: string, manifest: Manifest, git: TaskGit, log: Diagnostics) {
  try { await restoreVerifiedCheckpoint(job, root, manifest, git, log); }
  catch (error: any) {
    log.event("resume.restore", "ERROR", { outcome: "rejected", task_id: manifest.task_id, session_id: manifest.driver.worker_session,
      reason: error.reason ?? "restore_failed", ...error.details, corrective_action: "Resolve branch or state drift before restoring; the recorded checkpoint remains authoritative." });
    throw error;
  }
}
async function restoreVerifiedCheckpoint(job: Job, root: string, manifest: Manifest, git: TaskGit, log: Diagnostics) {
  const started = Date.now();
  const files = await safeTree(join(root, "codex"));
  let decodedBytes = 0;
  const identifiers: string[] = [];
  for (const file of files.filter(path => /\.jsonl(?:\.zst)?$/.test(path))) {
    const bytes = await readFile(file), decoded = file.endsWith(".zst") ? zstdDecompressSync(bytes, { maxOutputLength: checkpointBytes }) : bytes;
    decodedBytes += decoded.length;
    requireValue(decodedBytes <= checkpointBytes, "checkpoint_expansion_limit", "resume");
    let rows: any[];
    try { rows = decoded.toString("utf8").trimEnd().split("\n").map(line => JSON.parse(line)); }
    catch { throw new RunnerError("invalid_session_history", "resume"); }
    const inspect = (value: any): void => {
      if (typeof value === "string") for (const secret of log.protectedValues) requireValue(!value.includes(secret), "credential_in_checkpoint", "resume");
      else if (value && typeof value === "object") for (const child of Object.values(value)) inspect(child);
    };
    inspect(rows);
    const meta = rows[0];
    requireValue(meta?.type === "session_meta" && Array.isArray((manifest as any).session_identifiers) &&
      (manifest as any).session_identifiers.some((entry: any) => entry.thread_id === meta.payload?.id && entry.session_id === (meta.payload?.session_id ?? meta.payload?.id)), "checkpoint_session_mismatch", "resume");
    requireValue(!identifiers.includes(meta.payload.id), "duplicate_session_history", "resume");
    identifiers.push(meta.payload.id);
  }
  requireValue(manifest.sessions.every(id => identifiers.includes(id)), "missing_session_history", "resume");
  const observed = await git.remoteHead();
  if (observed !== manifest.checkpoint_sha) throw new RunnerError("resume_branch_drift", "resume", "The task branch no longer matches its durable checkpoint.",
    { expected_sha: manifest.checkpoint_sha, observed_sha: observed, artifact_sequence: manifest.sequence });
  requireValue((await git.run(["status", "--porcelain", "--untracked-files=all"])).trim() === "", "unsafe_worktree", "resume");
  await git.run(["fetch", "origin", `refs/heads/${manifest.branch}`]);
  requireValue((await git.run(["rev-parse", "FETCH_HEAD"])).trim() === manifest.checkpoint_sha, "resume_fetch_drift", "resume");
  await git.run(["switch", "-c", manifest.branch, manifest.checkpoint_sha]);
  await git.verify(manifest.checkpoint_sha);
  await git.run(["merge-base", "--is-ancestor", manifest.base_sha, manifest.checkpoint_sha]);
  const source = join(root, "codex");
  for (const name of databases) {
    const database = join(source, name);
    if (!files.includes(database)) continue;
    const db = new DatabaseSync(database);
    try {
      db.exec("PRAGMA trusted_schema=OFF");
      requireValue(db.prepare("PRAGMA integrity_check").all().every(row => Object.values(row)[0] === "ok"), "resume_sqlite_integrity_failed", "resume");
      if (name === "state_5.sqlite") {
        const rows = db.prepare("SELECT id, rollout_path, cwd FROM threads").all();
        const update = db.prepare("UPDATE threads SET rollout_path = ?, cwd = ? WHERE id = ?");
        for (const row of rows) {
          requireValue(typeof row.rollout_path === "string" && row.rollout_path.startsWith(manifest.codex_home + sep), "unsafe_rollout_reference", "resume");
          const relative = row.rollout_path.slice(manifest.codex_home.length + 1);
          requireValue(manifest.files.some(file => file.path === `codex/${relative}`), "missing_rollout_reference", "resume");
          requireValue(resolve(job.codexHome, relative).startsWith(job.codexHome + sep), "unsafe_rollout_reference", "resume");
          update.run(join(job.codexHome, relative), row.cwd === manifest.workspace ? git.cwd : row.cwd, row.id);
        }
      }
    } finally { db.close(); }
  }
  for (const file of files) {
    const relative = file.slice(source.length + 1), target = join(job.codexHome, relative);
    try { await lstat(target); throw new RunnerError("restore_target_exists", "resume"); }
    catch (error: any) { if (error.code !== "ENOENT") throw error; }
    await mkdir(join(target, ".."), { recursive: true, mode: 0o700 });
    await cp(file, target, { force: false, errorOnExist: true });
  }
  log.event("resume.restore", "INFO", { outcome: "complete", task_id: manifest.task_id, session_id: manifest.driver.worker_session,
    auditor_session_id: manifest.driver.auditor_session, old_workspace: manifest.workspace, workspace: git.cwd, old_codex_home: manifest.codex_home,
    codex_home: job.codexHome, file_count: files.length, sqlite_integrity: "verified", expected_sha: manifest.checkpoint_sha, observed_sha: await git.head(),
    credentials: "reprovisioned", elapsed_ms: Date.now() - started });
}
