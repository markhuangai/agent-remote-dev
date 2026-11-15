import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { build, clean, files, protocolManifest } from "./build.mjs";

const root = resolve(import.meta.dirname, "..");
assert.deepEqual(JSON.parse(await readFile(join(root, ".github/runner-protocol.json"), "utf8")), await protocolManifest(), "Stale trusted runner protocol manifest");
const temporary = await mkdtemp(join(tmpdir(), "codex-bundle-"));
try {
  await build(temporary);
  const generated = (await files(temporary)).map((file) => relative(temporary, file)).sort();
  const committed = (await files(join(root, "dist"))).map((file) => relative(join(root, "dist"), file)).sort();
  assert.deepEqual(generated, committed, "Committed bundle resources differ from a fresh build");
  for (const file of generated) assert.deepEqual(await readFile(join(temporary, file)), await readFile(join(root, "dist", file)), `Stale bundled resource: ${file}`);
  console.log("Committed bundle matches a fresh build.");
} finally { await clean(temporary); }
