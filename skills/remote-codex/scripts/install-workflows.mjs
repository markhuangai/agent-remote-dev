import { cp, lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { packageRoot, verifyPackage } from './remote-codex.mjs';

export async function installWorkflows(directory, actors) {
  await verifyPackage();
  if (!Array.isArray(actors) || !actors.length || actors.some(actor => !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(actor))) throw new Error('Explicit trusted operator logins required');
  const root = await realpath(directory), source = join(packageRoot, 'assets/consumer'), paths = [];
  async function inventory(path, prefix = '') {
    for (const name of await readdir(path)) {
      const relative = prefix ? `${prefix}/${name}` : name, stat = await lstat(join(path, name));
      if (stat.isSymbolicLink()) throw new Error('Linked workflow resource rejected');
      if (stat.isDirectory()) await inventory(join(path, name), relative); else if (stat.isFile()) paths.push(relative); else throw new Error('Unsupported workflow resource');
    }
  }
  await inventory(source);
  for (const relative of paths) {
    let parent = root;
    for (const part of relative.split('/').slice(0, -1)) {
      parent = join(parent, part);
      try { const stat = await lstat(parent); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe workflow destination'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    try { await lstat(join(root, relative)); throw new Error(`Existing workflow resource: ${relative}`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  for (const relative of paths) { await mkdir(join(root, relative, '..'), { recursive: true }); await cp(join(source, relative), join(root, relative), { errorOnExist: true, force: false }); }
  await writeFile(join(root, '.github/remote-codex/config.json'), JSON.stringify({ allowed_actors: actors }, null, 2) + '\n');
  const { digest, protocolContract, protocolFiles } = await import('../assets/consumer/.github/remote-codex/checkpoint-policy.mjs');
  const files = {};
  for (const path of protocolFiles) files[path] = digest(await readFile(join(root, path)));
  await writeFile(join(root, '.github/remote-codex/protocol.json'), JSON.stringify({ ...protocolContract, files }, null, 2) + '\n');
  return paths;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2), directory = args[args.indexOf('--directory') + 1], actors = args[args.indexOf('--actors') + 1];
    if (!args.includes('--directory') || !args.includes('--actors')) throw new Error('Use --directory PATH --actors LOGIN[,LOGIN]');
    const files = await installWorkflows(directory, actors.split(','));
    process.stdout.write(JSON.stringify({ event: 'submission.install', outcome: 'created', files, next_action: 'Review and merge this bootstrap through the target repository normal process; provision runtime secrets before dispatch.' }) + '\n');
  } catch (error) { process.stderr.write(JSON.stringify({ event: 'submission.install', level: 'ERROR', reason: error.reason ?? 'installation_failed', message: error.message, ...error.details }) + '\n'); process.exitCode = 1; }
}
