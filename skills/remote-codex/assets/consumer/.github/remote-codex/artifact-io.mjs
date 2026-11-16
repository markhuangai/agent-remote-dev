import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { checkpointBytes, invariant, positiveId } from './checkpoint-policy.mjs';

export async function readArtifact({ api, repository, id, root, kind = 'record' }) {
  invariant(positiveId(id), 'invalid_artifact_id');
  const artifact = await api(`/repos/${repository}/actions/artifacts/${id}`);
  const limit = kind === 'checkpoint' ? checkpointBytes : 2 * 1024 * 1024;
  invariant(artifact.id === Number(id) && !artifact.expired && Date.parse(artifact.expires_at) > Date.now(), 'checkpoint_artifact_expired');
  invariant(Number.isSafeInteger(artifact.size_in_bytes) && artifact.size_in_bytes > 0 && artifact.size_in_bytes <= limit, 'checkpoint_size_limit');
  const payload = await api(`/repos/${repository}/actions/artifacts/${id}/zip`);
  invariant(Buffer.isBuffer(payload) || payload instanceof ArrayBuffer || ArrayBuffer.isView(payload), 'invalid_artifact_transport');
  const bytes = Buffer.from(payload);
  invariant(bytes.length <= limit, 'archive_size_limit');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const archive = join(root, `${id}.zip`), destination = join(root, `${id}-${kind}`);
  await writeFile(archive, bytes, { mode: 0o600, flag: 'wx' });
  try {
    await promisify(execFile)('python3', [join(import.meta.dirname, 'archive.py'), archive, destination, kind], { timeout: 120000, maxBuffer: 4096 });
  } catch (error) {
    let failure;
    try { failure = JSON.parse(error.stderr); } catch {}
    const reason = /^[a-z_]{1,80}$/.test(failure?.reason ?? '') ? failure.reason : 'unsafe_checkpoint_archive';
    invariant(false, reason, reason === 'unsupported_checkpoint_schema' ? 3 : null,
      reason === 'unsupported_checkpoint_schema' && Number.isSafeInteger(failure.observed) ? failure.observed : null);
  }
  const value = JSON.parse(await readFile(join(destination, kind === 'checkpoint' ? 'manifest.json' : 'record.json'), 'utf8'));
  return { artifact, value, root: destination };
}
