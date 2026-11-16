import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { packageRoot, verifyPackage } from './remote-codex.mjs';

export async function installWorkflows(directory, actors, ref = 'v1') {
  await verifyPackage();
  if (!Array.isArray(actors) || !actors.length || actors.some(actor => !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(actor))) throw new Error('Explicit trusted operator logins required');
  if (typeof ref !== 'string' || ref.trim() !== ref || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(ref) || ref.includes('..') ||
    !ref.split('/').every(part => part && !part.startsWith('.') && !part.endsWith('.') && !part.endsWith('.lock')))
    throw Object.assign(new Error('Invalid provider reference'), { reason: 'invalid_provider_reference' });
  const root = await realpath(directory), paths = ['.github/workflows/runner-task.yml', 'remote-codex.yml'];
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
  const workflow = (await readFile(join(packageRoot, 'assets/runner-task.yml'), 'utf8')).replace('/remote-codex.yml@v1', `/remote-codex.yml@${ref}`);
  await mkdir(join(root, '.github/workflows'), { recursive: true });
  await writeFile(join(root, paths[0]), workflow, { flag: 'wx' });
  await writeFile(join(root, paths[1]), `allowed-actors: ${JSON.stringify(actors)}\nskills: []\nauto-continue: false\n`, { flag: 'wx' });
  return paths;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2), directory = args[args.indexOf('--directory') + 1], actors = args[args.indexOf('--actors') + 1];
    if (!args.includes('--directory') || !args.includes('--actors')) throw new Error('Use --directory PATH --actors LOGIN[,LOGIN]');
    const ref = args.includes('--ref') ? args[args.indexOf('--ref') + 1] : 'v1';
    if (ref === undefined) throw Object.assign(new Error('Invalid provider reference'), { reason: 'invalid_provider_reference' });
    const files = await installWorkflows(directory, actors.split(','), ref);
    process.stdout.write(JSON.stringify({ event: 'submission.install', outcome: 'created', files, next_action: 'Review and merge this bootstrap through the target repository normal process; provision runtime secrets before dispatch.' }) + '\n');
  } catch (error) { process.stderr.write(JSON.stringify({ event: 'submission.install', level: 'ERROR', reason: error.reason ?? 'installation_failed', message: error.message, ...error.details }) + '\n'); process.exitCode = 1; }
}
