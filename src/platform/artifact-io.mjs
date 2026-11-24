import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { checkpointBytes, invariant, positiveId, validateManifest, validateProducer } from './checkpoint-policy.mjs';
import { pages } from './sources.mjs';

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
    invariant(false, reason, reason === 'unsupported_checkpoint_schema' ? 5 : null,
      reason === 'unsupported_checkpoint_schema' && Number.isSafeInteger(failure.observed) ? failure.observed : null);
  }
  const value = JSON.parse(await readFile(join(destination, kind === 'checkpoint' ? 'manifest.json' : 'record.json'), 'utf8'));
  return { artifact, value, root: destination };
}

export async function reconcileUpload({ api, repository, lineage, name, root, kind }) {
  const path = `/repos/${repository}/actions/runs/${lineage.run_id}`;
  const run = await api(path);
  invariant(String(run.id) === lineage.run_id && String(run.run_attempt) === lineage.run_attempt &&
    run.event === 'workflow_dispatch' && run.repository?.full_name === repository && run.head_repository?.full_name === repository &&
    positiveId(run.repository.id) && run.head_repository.id === run.repository.id && run.workflow_id === lineage.workflow_id &&
    run.head_sha === lineage.workflow_sha && run.head_branch === lineage.branch && run.path === lineage.workflow_path, 'untrusted_artifact_producer');
  const artifacts = await pages(api, `${path}/artifacts?name=${encodeURIComponent(name)}`, 'artifacts');
  const matches = artifacts.filter(item => item.name === name && item.expired === false && Date.parse(item.expires_at) > Date.now());
  invariant(matches.length === 1, matches.length ? 'ambiguous_artifact_receipt' : 'artifact_receipt_not_found');
  const downloaded = await readArtifact({ api, repository, id: matches[0].id, root: join(root, 'reconciliation'), kind });
  const { artifact } = downloaded;
  const producer = artifact.workflow_run;
  invariant(artifact.name === name && producer?.id === run.id && producer.repository_id === run.repository.id &&
    producer.head_repository_id === run.head_repository.id && producer.head_sha === run.head_sha &&
    producer.head_branch === run.head_branch, 'untrusted_artifact_producer');
  if (kind === 'checkpoint') validateProducer(artifact, run, validateManifest(downloaded.value, { repository }), repository);

  const file = kind === 'checkpoint' ? 'manifest.json' : 'record.json';
  const expected = await readFile(join(root, file));
  const actual = await readFile(join(downloaded.root, file));
  invariant(expected.equals(actual), 'artifact_content_mismatch');
  return { id: artifact.id };
}
