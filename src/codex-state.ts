import { backup, DatabaseSync } from "node:sqlite";
import { cp, lstat, mkdir, readFile, readdir } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import { hash, requireValue, RunnerError } from "./contracts.js";
import { safeTree } from "./setup.js";
import type { Job } from "./setup.js";
import type { Diagnostics } from "./diagnostics.js";
import { inspectCredentials } from "./credentials.js";
import { checkpointBytes, databases } from "./platform/checkpoint-policy.mjs";
import type { CheckpointInput } from "./checkpoint.js";
import type { ProcessControl } from "./process.js";

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
export async function captureCodex(job: Job, root: string, input: CheckpointInput, log: Diagnostics, limit: number, control?: ProcessControl) {
  const raw = join(root,"raw"), codex = join(root,"codex");
  await mkdir(raw, {mode:0o700}); await mkdir(codex, {mode:0o700});
  let copied = 0;
  const copy = async () => {
    for (const name of await readdir(job.runnerHome)) {
      if (name.endsWith(".sqlite") && !name.startsWith("logs_")) requireValue(databases.includes(name), "unsupported_sqlite_layout", "checkpoint");
    }
    for (const directory of ["sessions", "archived_sessions"]) {
      const source = join(job.runnerHome, directory);
      try { await lstat(source); } catch (error: any) { if (error.code === "ENOENT") continue; throw error; }
      for (const file of await safeTree(source)) {
        requireValue(/\.jsonl(?:\.zst)?$/.test(file), "unexpected_session_file", "checkpoint");
        copied += (await lstat(file)).size; requireValue(copied <= limit, "checkpoint_size_limit", "checkpoint");
        const target = join(codex, relative(job.runnerHome, file));
        await mkdir(join(target, ".."), { recursive: true, mode: 0o700 }); await cp(file, target);
      }
    }
    for (const name of databases) for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      const source = join(job.runnerHome, name + suffix);
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
  if (files.includes(statePath)) validateSessionReferences(statePath, job.runnerHome, inventory, sessions);
  return files;
}

export async function restoreCodex(job: Job, root: string, manifest: any, cwd: string, log: Diagnostics) {
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
          requireValue(typeof row.rollout_path === "string" && row.rollout_path.startsWith(manifest.runner_home + sep), "unsafe_rollout_reference", "resume");
          const relative = row.rollout_path.slice(manifest.runner_home.length + 1);
          requireValue(manifest.files.some((file: any) => file.path === `codex/${relative}`), "missing_rollout_reference", "resume");
          requireValue(resolve(job.runnerHome, relative).startsWith(job.runnerHome + sep), "unsafe_rollout_reference", "resume");
          const restoredCwd = typeof row.cwd === "string" && (row.cwd === manifest.workspace || row.cwd.startsWith(manifest.workspace + sep)) ? cwd + row.cwd.slice(manifest.workspace.length) : row.cwd;
          update.run(join(job.runnerHome, relative), restoredCwd, row.id);
        }
      }
    } finally { db.close(); }
  }
  for (const file of files) {
    const relative = file.slice(source.length + 1), target = join(job.runnerHome, relative);
    try { await lstat(target); throw new RunnerError("restore_target_exists", "resume"); }
    catch (error: any) { if (error.code !== "ENOENT") throw error; }
    await mkdir(join(target, ".."), { recursive: true, mode: 0o700 });
    await cp(file, target, { force: false, errorOnExist: true });
  }
}

export function validateSessionReferences(path: string, runnerHome: string, inventory: { path: string }[], sessions: Set<string>) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec("PRAGMA trusted_schema=OFF");
    for (const row of db.prepare("SELECT id, rollout_path FROM threads").all()) {
      requireValue(typeof row.id === "string" && sessions.has(row.id), "missing_session_history", "checkpoint");
      requireValue(typeof row.rollout_path === "string" && row.rollout_path.startsWith(runnerHome + "/"), "unsafe_rollout_reference", "checkpoint");
      const relative = row.rollout_path.slice(runnerHome.length + 1);
      requireValue(inventory.some(file => file.path === `codex/${relative}`), "missing_rollout_reference", "checkpoint");
    }
  } finally { db.close(); }
}
