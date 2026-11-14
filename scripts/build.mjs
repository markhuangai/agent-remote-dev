import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdtemp, readdir, rmdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

export const root = resolve(import.meta.dirname, "..");
export async function files(path) {
  const output = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) output.push(...await files(child));
    else { assert.ok(entry.isFile(), "Bundle must contain regular files"); output.push(child); }
  }
  return output;
}
export async function clean(path) {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) await clean(child); else await unlink(child);
  }
  await rmdir(path);
}
export async function build(destination) {
  await promisify(execFile)(process.execPath, [join(root, "node_modules/@vercel/ncc/dist/ncc/cli.js"), "build", "src/entry.ts", "-o", destination, "--license", "licenses.txt"], { cwd: root });
  await cp(join(root,"src/supervise.py"),join(destination,"supervise.py"));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const temporary = await mkdtemp(join(tmpdir(), "codex-build-"));
  try {
    await build(temporary);
    const destination = join(root, "dist");
    try { await files(destination); await clean(destination); } catch (error) { if (error.code !== "ENOENT") throw error; }
    await cp(temporary, destination, { recursive: true });
    console.log("Built dist from the locked dependencies.");
  } finally { await clean(temporary); }
}
