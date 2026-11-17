import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { digest, invariant, positiveId, shaPattern } from '../../src/platform/checkpoint-policy.mjs';
import { pages } from '../../src/platform/sources.mjs';
import { logEvent, safeError } from '../../src/platform/runtime-log.mjs';

export async function verifyReleaseArtifact({ api, plan, artifactId, artifactDigest, runId, runAttempt, workflowSha, root, core, env = process.env }) {
  const started = Date.now();
  try {
    invariant(positiveId(artifactId) && positiveId(runId) && positiveId(runAttempt) && shaPattern.test(workflowSha) && /^sha256:[a-f0-9]{64}$/.test(artifactDigest), 'invalid_release_artifact');
    const run = await api(`/repos/${plan.repository}/actions/runs/${runId}`);
    invariant(String(run.id) === String(runId) && String(run.run_attempt) === String(runAttempt) && run.event === 'workflow_dispatch' &&
      run.path === '.github/workflows/release.yml' && run.head_branch === 'main' && run.head_sha === workflowSha &&
      run.repository?.full_name === plan.repository && run.head_repository?.full_name === plan.repository, 'release_artifact_producer_mismatch');
    const jobs = await pages(api, `/repos/${plan.repository}/actions/runs/${runId}/attempts/${runAttempt}/jobs`, 'jobs');
    const builds = jobs.filter(job => job.name === 'Build and verify source');
    invariant(builds.length === 1 && builds[0].status === 'completed' && builds[0].conclusion === 'success' && String(builds[0].run_attempt) === String(runAttempt), 'release_build_unproven');
    const artifact = await api(`/repos/${plan.repository}/actions/artifacts/${artifactId}`);
    invariant(artifact.id === Number(artifactId) && artifact.name === `linux-release-assets-${runId}-${runAttempt}` && artifact.workflow_run?.id === Number(runId) &&
      artifact.workflow_run.head_sha === workflowSha && !artifact.expired && Date.parse(artifact.expires_at) > Date.now() &&
      Date.parse(artifact.created_at) >= Date.parse(builds[0].started_at) && Date.parse(artifact.created_at) <= Date.parse(builds[0].completed_at) &&
      artifact.digest === artifactDigest && artifact.size_in_bytes > 0 && artifact.size_in_bytes <= 64 * 1024 * 1024, 'release_artifact_identity_mismatch');
    const payload = await api(`/repos/${plan.repository}/actions/artifacts/${artifactId}/zip`);
    invariant(Buffer.isBuffer(payload) || payload instanceof ArrayBuffer || ArrayBuffer.isView(payload), 'invalid_release_artifact_transport');
    const bytes = Buffer.from(payload);
    invariant(bytes.length > 0 && bytes.length <= 64 * 1024 * 1024 && `sha256:${digest(bytes)}` === artifactDigest, 'release_artifact_digest_mismatch');
    const tree = await api(`/repos/${plan.repository}/git/trees/${plan.source_sha}?recursive=1`);
    invariant(Array.isArray(tree.tree) && !tree.truncated, 'release_source_inventory_unavailable');
    const expected = { 'action.tar.gz': {}, 'remote-codex.tar.gz': {} };
    for (const entry of tree.tree) {
      const action = ['action.yml', 'package.json', 'package-lock.json'].includes(entry.path) || entry.path.startsWith('dist/');
      const skill = entry.path.startsWith('skills/remote-codex/');
      if ((!action && !skill) || entry.type === 'tree') continue;
      invariant(entry.type === 'blob' && ['100644', '100755'].includes(entry.mode) && shaPattern.test(entry.sha) && Number.isSafeInteger(entry.size) && entry.size >= 0, 'unsupported_release_source_entry');
      expected[action ? 'action.tar.gz' : 'remote-codex.tar.gz'][action ? entry.path : entry.path.slice('skills/'.length)] = { sha: entry.sha, size: entry.size, mode: entry.mode };
    }
    for (const [asset, required] of [['action.tar.gz', ['action.yml', 'package.json', 'package-lock.json', 'dist/index.js', 'dist/package.json', 'dist/archive.py', 'dist/supervise.py']],
      ['remote-codex.tar.gz', ['remote-codex/SKILL.md']]])
      invariant(required.every(path => expected[asset][path]) && Object.keys(expected[asset]).length <= 10000, 'incomplete_release_source');
    await mkdir(root, { recursive: true, mode: 0o700 });
    const archivePath = join(root, 'assets.zip'), expectedPath = join(root, 'expected.json'), output = join(root, 'verified');
    await writeFile(archivePath, bytes, { mode: 0o600, flag: 'wx' });
    await writeFile(expectedPath, JSON.stringify(expected), { mode: 0o600, flag: 'wx' });
    let verification;
    try {
      const result = await promisify(execFile)('python3', [join(import.meta.dirname, 'release-archive.py'), archivePath, expectedPath, output], { timeout: 120000, maxBuffer: 4096 });
      verification = JSON.parse(result.stdout);
    } catch (error) {
      let failure;
      try { failure = JSON.parse(error.stderr); } catch {}
      invariant(false, /^[a-z_]{1,80}$/.test(failure?.reason ?? '') ? failure.reason : 'invalid_release_archive');
    }
    const receipt = { artifact_id: Number(artifactId), artifact_digest: artifactDigest, build_job_id: builds[0].id, run_id: String(runId), run_attempt: String(runAttempt),
      source_sha: plan.source_sha, files: verification.files, sha256: verification.sha256 };
    const assets = await Promise.all(['action.tar.gz', 'remote-codex.tar.gz', 'SHA256SUMS'].map(async name => ({ name, data: await readFile(join(output, name)) })));
    assets.push({ name: 'release-manifest.json', data: Buffer.from(JSON.stringify({ ...plan, bundle_verified: true, protocol_version: 3, artifact: receipt }, null, 2) + '\n') });
    logEvent(core, 'release.artifact', 'INFO', { ...receipt, outcome: 'verified', elapsed_ms: Date.now() - started }, env);
    return assets;
  } catch (error) {
    logEvent(core, 'release.artifact', 'ERROR', { source_sha: plan.source_sha, artifact_id: positiveId(artifactId) ? Number(artifactId) : null,
      expected_digest: /^sha256:[a-f0-9]{64}$/.test(artifactDigest) ? artifactDigest : null, ...safeError(error), ...error.details, outcome: 'blocked', elapsed_ms: Date.now() - started }, env);
    throw error;
  }
}
