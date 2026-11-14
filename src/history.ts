import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import { Job, safeTree } from "./setup.js";

export async function sessionFacts(job: Job, thread: string) {
  for (const directory of ["sessions", "archived_sessions"]) {
    let files: string[];
    try { files = await safeTree(join(job.codexHome, directory)); }
    catch (error: any) { if (error.code === "ENOENT") continue; throw error; }
    for (const file of files) {
      if (!/\.jsonl(?:\.zst)?$/.test(file)) continue;
      const bytes = await readFile(file);
      const text = (file.endsWith(".zst") ? zstdDecompressSync(bytes, { maxOutputLength: 256 * 1024 * 1024 }) : bytes).toString("utf8");
      const records = text.trim().split("\n").map((line) => JSON.parse(line));
      const meta = records[0]?.payload;
      if (meta?.id !== thread) continue;
      const context = [...records].reverse().find((record) => record.type === "turn_context");
      return { session_id: meta.session_id ?? meta.id, model: typeof context?.payload?.model === "string" ? context.payload.model : "not exposed by CLI" };
    }
  }
  return { session_id: thread, model: "not exposed by CLI" };
}
