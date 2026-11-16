import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rmdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { digest, protocolContract, protocolFiles } from "../src/platform/checkpoint-policy.mjs";

export const root = resolve(import.meta.dirname, "..");
export async function protocolManifest(directory = root) {
  const inventory = {};
  for (const path of protocolFiles) inventory[path] = digest(await readFile(join(directory, path)));
  return { ...protocolContract, files: inventory };
}
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
  for (const [entry, name] of [['control.mjs', 'control'], ['submission.mjs', 'client']]) {
    const temporary = await mkdtemp(join(tmpdir(), 'codex-helper-'));
    try {
      await promisify(execFile)(process.execPath, [join(root, 'node_modules/@vercel/ncc/dist/ncc/cli.js'), 'build', join(root, 'src/platform', entry), '-o', temporary, '--minify', ...(name === 'control' ? ['--license', 'control-licenses.txt'] : [])], { cwd: root });
      await cp(join(temporary, 'index.mjs'), join(destination, `${name}.mjs`));
      if (name === 'control') await cp(join(temporary, 'control-licenses.txt'), join(destination, 'control-licenses.txt'));
    } finally { await clean(temporary); }
  }
  await writeFile(join(destination, 'protocol.json'), JSON.stringify(await protocolManifest(), null, 2) + '\n');
}
export async function buildYaml(destination) {
  await promisify(execFile)(process.execPath, [join(root, 'node_modules/@vercel/ncc/dist/ncc/cli.js'), 'build', 'scripts/yaml-entry.cjs', '-o', destination, '--minify', '--license', 'yaml-licenses.txt'], { cwd: root });
}
export async function buildSkill(destination) {
  await mkdir(destination, { recursive: true });
  const source = join(root, "skills/remote-codex");
  for (const name of ["SKILL.md", "agents", "scripts", "references"]) await cp(join(source, name), join(destination, name), { recursive: true });
  await mkdir(join(destination, 'assets'), { recursive: true });
  await cp(join(source, 'assets/runner-task.yml'), join(destination, 'assets/runner-task.yml'), { recursive: true });
  const runtime = join(destination, 'dist');
  await mkdir(runtime, { recursive: true });
  for (const name of ['client.mjs', 'archive.py', 'yaml.cjs', 'yaml-licenses.txt'])
    await cp(join(root, 'dist', name), join(runtime, name));
  const inventory = {};
  for (const path of (await files(destination)).sort()) inventory[path.slice(destination.length + 1).replaceAll("\\", "/")] = digest(await readFile(path));
  await writeFile(join(destination, "resources.json"), JSON.stringify({ protocol_version: 3, files: inventory }, null, 2) + "\n");
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
    const skill = join(temporary, "skill-package");
    await buildSkill(skill);
    for (const name of ['assets', 'dist']) {
      const destination = join(root, 'skills/remote-codex', name);
      try { await clean(destination); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      await cp(join(skill, name), destination, { recursive: true });
    }
    await cp(join(skill, "resources.json"), join(root, "skills/remote-codex/resources.json"));
    console.log("Built dist from the locked dependencies.");
  } finally { await clean(temporary); }
}
