import { DatabaseSync } from "node:sqlite";
import { cp, lstat, mkdir, readFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import { checkpointBytes, databases, validateManifest } from "./platform/checkpoint-policy.mjs";
import { requireValue, RunnerError, versions } from "./contracts.js";
import { Diagnostics } from "./diagnostics.js";
import { command } from "./process.js";
import { inspectCredentials, validateDatabase } from "./checkpoint.js";
import { Job, safeTree } from "./setup.js";
import { TaskGit } from "./git.js";

export function validateCheckpoint(value: unknown, repository: string) {
  return validateManifest(value, { repository, codexVersion: versions.codex });
}
export async function unpackArchive(job: Job, archive: string, destination: string, kind: "checkpoint" | "record", log: Diagnostics) {
  try { await command("python3", [join(import.meta.dirname, "platform/archive.py"), archive, destination, kind], { cwd: job.root, env: job.env, stage: "resume_archive", log }); }
  catch (error) {
    let failure: any;
    try { failure = JSON.parse(error instanceof RunnerError ? error.nativeCause : "null"); } catch {}
    const allowed = ["archive_size_limit", "archive_entry_limit", "unsafe_archive_path", "duplicate_archive_entry", "encrypted_archive", "linked_archive_entry",
      "archive_expansion_limit", "missing_archive_manifest", "invalid_archive_manifest", "unsupported_checkpoint_schema", "invalid_checkpoint_inventory",
      "invalid_checkpoint_file", "unexpected_checkpoint_file", "archive_inventory_mismatch", "checkpoint_file_hash_mismatch", "restore_destination_exists", "archive_read_failed"];
    const reason = allowed.includes(failure?.reason) ? failure.reason : "unsafe_checkpoint_archive";
    throw new RunnerError(reason, "resume", "Archive validation rejected the requested checkpoint.", reason === "unsupported_checkpoint_schema" ?
      { expected: 4, observed: Number.isSafeInteger(failure.observed) ? failure.observed : null } : {});
  }
}
export async function restoreCheckpoint(job: Job, root: string, manifest: any, git: TaskGit, log: Diagnostics) {
  try { await restoreVerifiedCheckpoint(job, root, manifest, git, log); }
  catch (error: any) {
    log.event("resume.restore", "ERROR", { outcome: "rejected", task_id: manifest.task_id, session_id: manifest.session_id,
      reason: error.reason ?? "restore_failed", ...error.details, corrective_action: "Resolve branch or state drift before restoring; the recorded checkpoint remains authoritative." });
    throw error;
  }
}
async function restoreVerifiedCheckpoint(job: Job, root: string, manifest: any, git: TaskGit, log: Diagnostics) {
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
    inspectCredentials(rows, log);
    const meta = rows[0];
    requireValue(meta?.type === "session_meta" && typeof meta.payload?.id === "string", "checkpoint_session_mismatch", "resume");
    requireValue(!identifiers.includes(meta.payload.id), "duplicate_session_history", "resume");
    identifiers.push(meta.payload.id);
  }
  requireValue(identifiers.includes(manifest.session_id), "missing_session_history", "resume");
  await git.restore(manifest.branch, manifest.checkpoint_sha);
  const source = join(root, "codex");
  for (const name of databases) {
    const database = join(source, name);
    if (!files.includes(database)) continue;
    validateDatabase(database, log);
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
          requireValue(manifest.files.some((file: any) => file.path === `codex/${relative}`), "missing_rollout_reference", "resume");
          requireValue(resolve(job.codexHome, relative).startsWith(job.codexHome + sep), "unsafe_rollout_reference", "resume");
          const cwd = typeof row.cwd === "string" && (row.cwd === manifest.workspace || row.cwd.startsWith(manifest.workspace + sep)) ? git.cwd + row.cwd.slice(manifest.workspace.length) : row.cwd;
          update.run(join(job.codexHome, relative), cwd, row.id);
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
  log.event("resume.restore", "INFO", { outcome: "complete", task_id: manifest.task_id, session_id: manifest.session_id,
    old_workspace: manifest.workspace, workspace: git.cwd, old_codex_home: manifest.codex_home,
    codex_home: job.codexHome, file_count: files.length, sqlite_integrity: "verified", expected_sha: manifest.checkpoint_sha, observed_sha: await git.head(),
    credentials: "reprovisioned", elapsed_ms: Date.now() - started });
}
