import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export async function verifyPackage(root = packageRoot) {
  let manifest;
  try { manifest = JSON.parse(await readFile(join(root, 'resources.json'), 'utf8')); }
  catch { throw Object.assign(new Error('incomplete_skill_package'), { reason: 'incomplete_skill_package', details: { resource_path: 'resources.json', protocol_version: 3 } }); }
  if (manifest.protocol_version !== 3 || !manifest.files || Object.keys(manifest.files).length === 0) throw Object.assign(new Error('incompatible_skill_package'), { reason: 'incompatible_skill_package' });
  for (const [name, expected] of Object.entries(manifest.files)) {
    if (!name || name.startsWith('/') || name.includes('\\') || name.split('/').some(part => !part || part === '.' || part === '..')) throw Object.assign(new Error('unsafe_package_resource'), { reason: 'unsafe_package_resource' });
    let data;
    try {
      let parent = root;
      if ((await lstat(parent)).isSymbolicLink()) throw new Error();
      for (const part of name.split('/').slice(0, -1)) { parent = join(parent, part); const stat = await lstat(parent); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(); }
      if (!(await lstat(join(root, name))).isFile()) throw new Error(); data = await readFile(join(root, name));
    }
    catch { throw Object.assign(new Error('incomplete_skill_package'), { reason: 'incomplete_skill_package', details: { resource_path: name, protocol_version: 3 } }); }
    const observed = createHash('sha256').update(data).digest('hex');
    if (observed !== expected) throw Object.assign(new Error('skill_resource_hash_mismatch'), { reason: 'skill_resource_hash_mismatch', details: { resource_path: name, protocol_version: 3, expected, observed } });
  }
  return manifest;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    await verifyPackage();
    const { cli } = await import('../dist/client.mjs');
    await cli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(JSON.stringify({ event: 'submission.failed', level: 'ERROR', reason: error.reason ?? 'helper_failed', ...error.details }) + '\n');
    process.exitCode = 1;
  }
}
