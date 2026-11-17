import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rmdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

export const actionResources = ['action.yml', 'package.json', 'package-lock.json', 'dist/index.js', 'dist/package.json', 'dist/supervise.py', 'dist/archive.py', 'dist/yaml.cjs', 'dist/yaml-licenses.txt', 'dist/control.mjs', 'dist/control-licenses.txt'];
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
  await promisify(execFile)(process.execPath, [join(root, "node_modules/@vercel/ncc/dist/ncc/cli.js"), "build", "src/entry.ts", "-o", destination, "--minify", "--license", "licenses.txt"], { cwd: root });
  await cp(join(root,"src/supervise.py"),join(destination,"supervise.py"));
  await cp(join(root,"src/platform/archive.py"),join(destination,"archive.py"));
  for (const name of ['yaml.cjs', 'yaml-licenses.txt']) await cp(join(root, 'src/platform', name), join(destination, name));
  for (const [entry, name] of [['control.mjs', 'control']]) {
    const temporary = await mkdtemp(join(tmpdir(), 'codex-helper-'));
    try {
      await promisify(execFile)(process.execPath, [join(root, 'node_modules/@vercel/ncc/dist/ncc/cli.js'), 'build', join(root, 'src/platform', entry), '-o', temporary, '--minify', ...(name === 'control' ? ['--license', 'control-licenses.txt'] : [])], { cwd: root });
      await cp(join(temporary, 'index.mjs'), join(destination, `${name}.mjs`));
      if (name === 'control') await cp(join(temporary, 'control-licenses.txt'), join(destination, 'control-licenses.txt'));
    } finally { await clean(temporary); }
  }
}
export async function buildYaml(destination) {
  await promisify(execFile)(process.execPath, [join(root, 'node_modules/@vercel/ncc/dist/ncc/cli.js'), 'build', 'scripts/yaml-entry.cjs', '-o', destination, '--minify', '--license', 'yaml-licenses.txt'], { cwd: root });
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const temporary = await mkdtemp(join(tmpdir(), "codex-build-"));
  try {
    const yaml = join(temporary, 'yaml');
    await buildYaml(yaml);
    await cp(join(yaml, 'index.cjs'), join(root, 'src/platform/yaml.cjs'));
    await cp(join(yaml, 'yaml-licenses.txt'), join(root, 'src/platform/yaml-licenses.txt'));
    await clean(yaml);
    await build(temporary);
    const destination = join(root, "dist");
    try { await files(destination); await clean(destination); } catch (error) { if (error.code !== "ENOENT") throw error; }
    await cp(temporary, destination, { recursive: true });
    console.log("Built dist from the locked dependencies.");
  } finally { await clean(temporary); }
}
