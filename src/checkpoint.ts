import { backup, DatabaseSync } from "node:sqlite";
import { cp, lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import { Authorization, executionMode, hash, requireValue, RunnerError, SkillSource, UserAgents, versions } from "./contracts.js";
import { safeTree, Job } from "./setup.js";
import { Diagnostics } from "./diagnostics.js";
import { checkpointName } from "../.github/remote-codex/checkpoint-policy.mjs";
import type { Execution } from "./continuation.js";

export const checkpointLimit = 256 * 1024 * 1024;
const databases = ["state_5.sqlite", "thread_history_1.sqlite", "goals_1.sqlite", "queue_1.sqlite", "memories_1.sqlite", "memories_v2_1.sqlite"];
export type DurableCheckpoint = { artifact_id: number; checkpoint_sha: string; sequence: number };
export type CheckpointInput = { task_id: string; repository: string; branch: string | null; base_sha: string; checkpoint_sha: string;
  plan: string; plan_source: string; authorization: Authorization; session_id: string; sessions: string[]; skills: SkillSource[]; user_agents: UserAgents;
  lineage: Record<string, unknown>; previous: DurableCheckpoint | null; execution: Execution; workspace?: string };
export async function exportCheckpoint(job: Job, input: CheckpointInput, log: Diagnostics, limit = checkpointLimit) {
  const checkDeadline = () => { if (Date.now() >= Number(job.env.CODEX_TASK_DEADLINE_MS ?? Infinity)) throw new RunnerError("command_timeout", "checkpoint", "Checkpoint export reached the action deadline."); };
  const inspect = (value: unknown, reason: string): void => {
    checkDeadline();
    if (typeof value === "string" || value instanceof Uint8Array) {
      const bytes = Buffer.from(value);
      for (const secret of log.protectedValues) requireValue(!bytes.includes(Buffer.from(secret)), reason, "checkpoint");
      if (typeof value === "string" && /^[\s]*[\[{"]/.test(value)) {
        let decoded: unknown;
        try { decoded = JSON.parse(value); } catch { return; }
        inspect(decoded, reason);
      }
    } else if (value && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) { inspect(key, reason); inspect(child, reason); }
    }
  };
  checkDeadline();
  const sequence = (input.previous?.sequence ?? 0) + 1;
  log.event("checkpoint.export", "INFO", { stage: "export", outcome: "started", sequence, intended_sha: input.checkpoint_sha, last_durable_checkpoint: input.previous });
  const root = join(job.exports, `checkpoint-${sequence}`);
  await mkdir(root, { mode: 0o700 });
  for (const directory of ["sessions", "archived_sessions"]) {
    const source = join(job.codexHome, directory);
    try { await lstat(source); } catch (error: any) { if (error.code === "ENOENT") continue; throw error; }
    for (const file of await safeTree(source)) {
      checkDeadline();
      requireValue(/\.jsonl(?:\.zst)?$/.test(file), "unexpected_session_file", "checkpoint");
      const target = join(root, "codex", relative(job.codexHome, file));
      await mkdir(join(target, ".."), { recursive: true });
      await cp(file, target, { errorOnExist: true, force: false });
    }
  }
  for (const name of await readdir(job.codexHome)) {
    if (name.endsWith(".sqlite") && !name.startsWith("logs_")) requireValue(databases.includes(name), "unsupported_sqlite_layout", "checkpoint");
  }
  for (const name of databases) {
    checkDeadline();
    const source = join(job.codexHome, name);
    try { requireValue((await lstat(source)).isFile(), "unsafe_sqlite_path", "checkpoint"); }
    catch (error: any) { if (error.code === "ENOENT") continue; throw error; }
    await mkdir(join(root, "codex"), { recursive: true });
    const db = new DatabaseSync(source, { readOnly: true });
    try { await backup(db, join(root, "codex", name)); } finally { db.close(); }
    requireValue((await lstat(join(root, "codex", name))).size <= limit, "checkpoint_size_limit", "checkpoint");
    const saved = new DatabaseSync(join(root, "codex", name));
    try {
      requireValue(saved.prepare("PRAGMA journal_mode=DELETE").get()?.journal_mode === "delete", "sqlite_snapshot_journal_failed", "checkpoint");
      requireValue(saved.prepare("PRAGMA integrity_check").all().every((row) => Object.values(row)[0] === "ok"), "sqlite_integrity_failed", "checkpoint");
      const schema = saved.prepare("SELECT * FROM sqlite_schema").all();
      inspect(schema, "credential_in_checkpoint");
      for (const table of schema.filter((entry) => entry.type === "table")) {
        const statement = saved.prepare(`SELECT * FROM "${String(table.name).replaceAll('"', '""')}"`);
        statement.setReadBigInts(true);
        for (const row of statement.iterate()) inspect(row, "credential_in_checkpoint");
      }
    }
    finally { saved.close(); }
  }
  const files = await safeTree(root);
  const inventory: { path: string; sha256: string; bytes: number }[] = [];
  const identifiers: { thread_id: string; session_id: string }[] = [];
  let bytes = 0;
  for (const file of files) {
    checkDeadline();
    const data = await readFile(file);
    bytes += data.length;
    requireValue(bytes <= limit, "checkpoint_size_limit", "checkpoint");
    const decoded = file.endsWith(".zst") ? zstdDecompressSync(data, { maxOutputLength: limit }) : data;
    inspect(data, "credential_in_checkpoint"); inspect(decoded, "credential_in_checkpoint");
    if (/\.jsonl(?:\.zst)?$/.test(file)) {
      const lines = decoded.toString("utf8").trimEnd().split("\n");
      let meta: any;
      for (const [index, line] of lines.entries()) {
        checkDeadline();
        let record;
        try { record = JSON.parse(line); }
        catch { throw new RunnerError("invalid_session_history", "checkpoint", "Session history contains malformed JSON."); }
        inspect(record, "credential_in_checkpoint");
        if (index === 0) meta = record;
      }
      requireValue(meta.type === "session_meta" && typeof meta.payload?.id === "string", "invalid_session_metadata", "checkpoint");
      identifiers.push({ thread_id: meta.payload.id, session_id: meta.payload.session_id ?? meta.payload.id });
    }
    inventory.push({ path: relative(root, file), sha256: hash(data), bytes: data.length });
  }
  requireValue(input.sessions.every((id) => identifiers.some((entry) => entry.thread_id === id)), "missing_session_history", "checkpoint");
  const manifest = { schema_version: 3, ...input, runtime: { platform: process.platform, architecture: process.arch }, sessions: identifiers.map(entry => entry.thread_id), workspace: input.workspace ?? process.cwd(), codex_home: job.codexHome,
    permission_mode: executionMode, session_identifiers: identifiers, plan_sha256: hash(input.plan), versions, sequence, files: inventory,
    limits: { max_bytes: limit }, created_at: new Date().toISOString() };
  const encoded = JSON.stringify(manifest, null, 2) + "\n";
  inspect(manifest, "credential_in_manifest"); inspect(encoded, "credential_in_manifest");
  requireValue(bytes + Buffer.byteLength(encoded) <= limit, "checkpoint_size_limit", "checkpoint");
  await writeFile(join(root, "manifest.json"), encoded, { mode: 0o600 });
  log.event("checkpoint.export", "INFO", { stage: "export", outcome: "complete", sequence, checkpoint_sha: input.checkpoint_sha, file_count: files.length + 1, bytes: bytes + Buffer.byteLength(encoded) });
  return { root, files: [...files, join(root, "manifest.json")], sequence };
}
export async function durableCheckpoint(job: Job, input: CheckpointInput, log: Diagnostics,
  verify: (sha: string) => Promise<void>, upload: (name: string, files: string[], root: string) => Promise<{ id?: number }>) {
  await verify(input.checkpoint_sha);
  const exported = await exportCheckpoint(job, input, log);
  await verify(input.checkpoint_sha);
  const name = checkpointName({ ...input, sequence: exported.sequence });
  log.event("checkpoint.upload", "INFO", { stage: "upload", artifact_name: name, intended_sha: input.checkpoint_sha, observed_sha: input.checkpoint_sha, last_durable_checkpoint: input.previous, outcome: "started" });
  let result;
  try { result = await upload(name, exported.files, exported.root); }
  catch (error) {
    throw new RunnerError("artifact_upload_failed", "checkpoint", error instanceof Error ? error.message : "Artifact transport failed",
      { artifact_name: name, intended_sha: input.checkpoint_sha, observed_sha: input.checkpoint_sha, last_durable_checkpoint: input.previous });
  }
  requireValue(Number.isSafeInteger(result.id) && result.id! > 0, "missing_artifact_receipt", "checkpoint");
  await verify(input.checkpoint_sha);
  const receipt = { artifact_id: result.id!, checkpoint_sha: input.checkpoint_sha, sequence: exported.sequence };
  log.event("checkpoint.complete", "INFO", receipt);
  return receipt;
}
