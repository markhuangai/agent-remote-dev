import { backup, DatabaseSync } from "node:sqlite";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import { hash, requireValue, RunnerError, versions } from "./contracts.js";
import { safeTree, removeJob, Job } from "./setup.js";
import { Diagnostics } from "./diagnostics.js";
import { checkpointBytes, checkpointName, databases, validateManifest } from "./platform/checkpoint-policy.mjs";
import type { ProcessControl } from "./process.js";

export const checkpointLimit = checkpointBytes;
export type DurableCheckpoint = { artifact_id: number; checkpoint_sha: string; sequence: number };
export type CheckpointInput = { repository: string; branch: string | null; checkpoint_sha: string; omitted_work: boolean;
  session_id: string; root_run_id: string; activation_run_id: string; operator: string; auto_count: number;
  provider_sha?: string; sequence?: number; lineage: any; outcome: "running" | "completed" | "failed" | "cancelled"; workspace: string; previous?: DurableCheckpoint | null };
export function inspectCredentials(value: unknown, log: Diagnostics, reason = "credential_in_checkpoint"): void {
  if (typeof value === "string" || value instanceof Uint8Array) {
    for (const secret of log.protectedValues) requireValue(!Buffer.from(value).includes(Buffer.from(secret)), reason, "checkpoint");
    if (typeof value === "string" && /^[\s]*[\[{"]/.test(value)) {
      let decoded: unknown;
      try { decoded = JSON.parse(value); } catch { return; }
      inspectCredentials(decoded, log, reason);
    }
  } else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) { inspectCredentials(key, log, reason); inspectCredentials(child, log, reason); }
  }
}
export function validateDatabase(path: string, log: Diagnostics) {
  const db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA trusted_schema=OFF");
    requireValue(db.prepare("PRAGMA integrity_check").all().every(row => Object.values(row)[0] === "ok"), "sqlite_integrity_failed", "checkpoint");
    const schema = db.prepare("SELECT * FROM sqlite_schema").all();
    inspectCredentials(schema, log);
    for (const table of schema.filter(entry => entry.type === "table")) {
      const statement = db.prepare(`SELECT * FROM "${String(table.name).replaceAll('"', '""')}"`);
      statement.setReadBigInts(true);
      for (const row of statement.iterate()) inspectCredentials(row, log);
    }
  } finally { db.close(); }
}
export async function exportCheckpoint(job: Job, input: CheckpointInput, log: Diagnostics, limit = checkpointLimit,
  control?: ProcessControl) {
  const sequence = input.sequence ?? (input.previous?.sequence ?? 0) + 1;
  const root = await mkdtemp(join(job.exports, `snapshot-${sequence}-`)), raw = join(root, "raw"), codex = join(root, "codex");
  await mkdir(raw, { mode: 0o700 }); await mkdir(codex, { mode: 0o700 });
  try {
    let copied = 0;
    const copy = async () => {
      for (const name of await readdir(job.codexHome)) {
        if (name.endsWith(".sqlite") && !name.startsWith("logs_")) requireValue(databases.includes(name), "unsupported_sqlite_layout", "checkpoint");
      }
      for (const directory of ["sessions", "archived_sessions"]) {
        const source = join(job.codexHome, directory);
        try { await lstat(source); } catch (error: any) { if (error.code === "ENOENT") continue; throw error; }
        for (const file of await safeTree(source)) {
          requireValue(/\.jsonl(?:\.zst)?$/.test(file), "unexpected_session_file", "checkpoint");
          copied += (await lstat(file)).size; requireValue(copied <= limit, "checkpoint_size_limit", "checkpoint");
          const target = join(codex, relative(job.codexHome, file));
          await mkdir(join(target, ".."), { recursive: true, mode: 0o700 }); await cp(file, target);
        }
      }
      for (const name of databases) for (const suffix of ["", "-wal", "-shm", "-journal"]) {
        const source = join(job.codexHome, name + suffix);
        let stat;
        try { stat = await lstat(source); } catch (error: any) { if (error.code === "ENOENT") continue; throw error; }
        requireValue(stat.isFile() && !stat.isSymbolicLink(), "unsafe_sqlite_path", "checkpoint");
        copied += stat.size; requireValue(copied <= limit, "checkpoint_size_limit", "checkpoint");
        await cp(source, join(raw, name + suffix));
      }
    };
    if (control) await control.freeze(copy); else await copy();
    for (const name of databases) {
      const source = join(raw, name);
      try { await lstat(source); } catch (error: any) { if (error.code === "ENOENT") continue; throw error; }
      const db = new DatabaseSync(source);
      try { await backup(db, join(codex, name)); } finally { db.close(); }
      const saved = new DatabaseSync(join(codex, name));
      try { requireValue(saved.prepare("PRAGMA journal_mode=DELETE").get()?.journal_mode === "delete", "sqlite_snapshot_journal_failed", "checkpoint"); }
      finally { saved.close(); }
      validateDatabase(join(codex, name), log);
    }
    const inventory = [], sessions = new Set<string>(); let bytes = 0, decodedBytes = 0;
    const files = await safeTree(codex);
    for (const file of files) {
      const data = await readFile(file); bytes += data.length;
      requireValue(bytes <= limit, "checkpoint_size_limit", "checkpoint");
      inspectCredentials(data, log);
      if (/\.jsonl(?:\.zst)?$/.test(file)) {
        const decoded = file.endsWith(".zst") ? zstdDecompressSync(data, { maxOutputLength: limit }) : data;
        decodedBytes += decoded.length; requireValue(decodedBytes <= limit, "checkpoint_expansion_limit", "checkpoint");
        let rows: any[];
        try { rows = decoded.toString("utf8").trimEnd().split("\n").map(line => JSON.parse(line)); }
        catch { throw new RunnerError("invalid_session_history", "checkpoint"); }
        inspectCredentials(rows, log);
        requireValue(rows[0]?.type === "session_meta" && typeof rows[0].payload?.id === "string", "invalid_session_metadata", "checkpoint");
        requireValue(!sessions.has(rows[0].payload.id), "duplicate_session_history", "checkpoint");
        sessions.add(rows[0].payload.id);
      }
      inventory.push({ path: relative(root, file), sha256: hash(data), bytes: data.length });
    }
    requireValue(sessions.has(input.session_id), "missing_session_history", "checkpoint");
    const statePath = join(codex, "state_5.sqlite");
    if (files.includes(statePath)) validateSessionReferences(statePath, job.codexHome, inventory, sessions);
    const { previous, ...metadata } = input;
    const manifest = { schema_version: 4, ...metadata, codex_version: versions.codex, codex_home: job.codexHome, sequence, files: inventory };
    inspectCredentials(manifest, log, "credential_in_manifest");
    const encoded = JSON.stringify(manifest);
    requireValue(bytes + Buffer.byteLength(encoded) <= limit, "checkpoint_size_limit", "checkpoint");
    validateManifest(manifest, { repository: input.repository, codexVersion: versions.codex });
    await writeFile(join(root, "manifest.json"), encoded, { mode: 0o600 });
    log.event("checkpoint.export", "INFO", { sequence, file_count: files.length, bytes, checkpoint_sha: input.checkpoint_sha, omitted_work: input.omitted_work, outcome: "validated" });
    return { root, files: [...files, join(root, "manifest.json")], sequence, manifest, name: checkpointName(manifest) };
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
      { cause_reason: error instanceof RunnerError ? error.reason : "artifact_transport_failed" }); }
    requireValue(Number.isSafeInteger(result.id) && result.id! > 0, "missing_artifact_receipt", "checkpoint");
    const receipt = { artifact_id: result.id!, checkpoint_sha: input.checkpoint_sha, sequence: exported.sequence };
    log.event("checkpoint.complete", "INFO", receipt);
    return receipt;
  } finally { await removeJob(exported.root); }
}

export function validateSessionReferences(path: string, codexHome: string, inventory: { path: string }[], sessions: Set<string>) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec("PRAGMA trusted_schema=OFF");
    for (const row of db.prepare("SELECT id, rollout_path FROM threads").all()) {
      requireValue(typeof row.id === "string" && sessions.has(row.id), "missing_session_history", "checkpoint");
      requireValue(typeof row.rollout_path === "string" && row.rollout_path.startsWith(codexHome + "/"), "unsafe_rollout_reference", "checkpoint");
      const relative = row.rollout_path.slice(codexHome.length + 1);
      requireValue(inventory.some(file => file.path === `codex/${relative}`), "missing_rollout_reference", "checkpoint");
    }
  } finally { db.close(); }
}
