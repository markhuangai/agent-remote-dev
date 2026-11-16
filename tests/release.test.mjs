import assert from 'node:assert/strict';
import test from 'node:test';
import { registryFor } from '../.github/scripts/qualification.mjs';
import { latestJobs, publishRelease, qualificationCases, releaseVersion, validateQualification } from '../.github/scripts/release-policy.mjs';
import { digest } from '../.github/remote-codex/checkpoint-policy.mjs';

function qualification() {
  const repository = 'markhuangai/agent-remote-dev-codex', sourceSha = 'a'.repeat(40), runId = '100';
  const registry = registryFor({ runId, sourceSha, selfHosted: ['self-hosted', 'Linux', 'X64'], authorization: 'Qualify the owned smoke tasks and clean their temporary resources.', author: 'Fixture', email: 'fixture@example.invalid',
    action: { sha: sourceSha, release_tag: 'v1.0.0-rc.0', release_id: 9 }, nonce: '12345678' });
  const proofs = registry.targets.map(target => ({ schema_version: 3, repository, source_sha: sourceSha, run_id: runId, target: target.key, passed: true,
    cases: qualificationCases.map((scenario, index) => ({ scenario, source_sha: sourceSha, passed: true, root_run_id: index + 1, run_ids: [index + 1], session_before: 'same-session', session_after: 'same-session',
      branch_before: 'qualification/owned', branch_after: 'qualification/owned', initial_artifact_id: 10, final_artifact_id: 11, automatic_restart: false, false_checkpoint: false })) }));
  const cleanup = { schema_version: 3, repository, source_sha: sourceSha, run_id: runId, verified: true, tasks: registry.tasks.map(task => ({ task_id: task.task_id, verified: true })) };
  return { registry, proofs, cleanup, repository, sourceSha, runId };
}
test('qualification requires both Linux runner families, all scenarios, matching resumes and proven cleanup', () => {
  const q = qualification(), validate = () => validateQualification(q.registry, q.proofs, q.cleanup, q.repository, q.sourceSha, q.runId, true);
  assert.equal(validate().cleanup_verified, true);
  for (const change of [
    value => { value.registry.source_sha = 'b'.repeat(40); },
    value => { value.registry.targets = value.registry.targets.slice(0, 1); },
    value => { value.proofs[0].cases.pop(); },
    value => { value.proofs[0].cases.find(entry => entry.scenario === 'cold-resume').session_after = 'changed'; },
    value => { value.proofs[1].cases.find(entry => entry.scenario === 'cancellation').automatic_restart = true; },
    value => { value.proofs[1].cases.find(entry => entry.scenario === 'failed-push').false_checkpoint = true; },
    value => { value.cleanup.tasks[0].verified = false; },
    value => { value.registry.action.release_tag = null; },
  ]) {
    const bad = structuredClone(q); change(bad);
    assert.throws(() => validateQualification(bad.registry, bad.proofs, bad.cleanup, bad.repository, bad.sourceSha, bad.runId, true));
  }
});
test('release channels accept immutable v1 versions and inspect latest child attempts including partial reruns', () => {
  assert.equal(releaseVersion('v1.0.0-rc.0').alias, 'v1-prerelease'); assert.equal(releaseVersion('v1.0.0').alias, 'v1');
  for (const version of ['v1', 'v2.0.0', 'main', 'v1.0.0;echo injected', 'v1.00.0']) assert.throws(() => releaseVersion(version));
  const jobs = [{ id: 1, name: 'Analyze (actions)', run_attempt: 1, status: 'completed', conclusion: 'success' }, { id: 2, name: 'Analyze (javascript-typescript)', run_attempt: 1, status: 'completed', conclusion: 'success' },
    { id: 3, name: 'Analyze (actions)', run_attempt: 2, status: 'completed', conclusion: 'success' }];
  assert.deepEqual(latestJobs(jobs, ['Analyze (actions)', 'Analyze (javascript-typescript)'], 2).map(result => result.job_id), [3, 2]);
  jobs[2].conclusion = 'failure'; assert.throws(() => latestJobs(jobs, ['Analyze (actions)'], 2));
  jobs[2].conclusion = 'success'; jobs.push({ ...jobs[2], id: 4 }); assert.throws(() => latestJobs(jobs, ['Analyze (actions)'], 2));
});
function publication() {
  const source = 'b'.repeat(40), old = 'a'.repeat(40), refs = new Map([['v1', old]]), calls = [], uploads = [];
  const plan = { ...releaseVersion('v1.0.0'), repository: 'fixture/repo', source_sha: source, alias_previous_sha: old, qualification: { run_id: 100 } };
  const api = async (path, options = {}) => {
    calls.push({ path, ...options });
    if (path.endsWith('/git/refs') && options.method === 'POST') { refs.set(options.ref.slice('refs/tags/'.length), options.sha); return {}; }
    if (path.endsWith('/releases') && options.method === 'POST') return { id: 9, tag_name: plan.version, draft: true };
    if (path.endsWith('/releases/9') && options.method === 'PATCH') return { id: 9, tag_name: plan.version, draft: false, prerelease: false };
    if (path.includes('/git/ref/tags/')) { const tag = path.split('/').at(-1); if (!refs.has(tag)) throw Object.assign(new Error('missing'), { status: 404 }); return { object: { type: 'commit', sha: refs.get(tag) } }; }
    if (path.endsWith('/git/refs/tags/v1') && options.method === 'PATCH') { assert.equal(options.force, false); refs.set('v1', options.sha); return {}; }
    throw new Error(`Unexpected publication transport ${path}`);
  };
  return { source, old, refs, calls, uploads, plan, api };
}
function assetsFor(plan) {
  const assets = [{ name: 'action.tar.gz', data: Buffer.from('fixture action') }, { name: 'remote-codex.tar.gz', data: Buffer.from('fixture skill') }];
  assets.push({ name: 'SHA256SUMS', data: Buffer.from(assets.map(asset => `${digest(asset.data)}  ${asset.name}`).join('\n') + '\n') });
  assets.push({ name: 'release-manifest.json', data: Buffer.from(JSON.stringify({ ...plan, bundle_verified: true, protocol_version: 3 })) });
  return assets;
}
test('release publication uploads complete assets before publishing and updates aliases without force', async () => {
  const p = publication(), assets = assetsFor(p.plan);
  const receipt = await publishRelease({ api: p.api, upload: async (id, asset) => { assert.equal(id, 9); p.uploads.push(asset.name); }, plan: p.plan, assets });
  assert.equal(receipt.alias_target, p.source); assert.equal(p.refs.get('v1.0.0'), p.source); assert.equal(p.refs.get('v1'), p.source); assert.deepEqual(p.uploads, assets.map(asset => asset.name));
  assert.equal(p.calls.filter(call => call.path.endsWith('/git/refs/tags/v1'))[0].force, false);
});
test('failed asset upload or concurrent alias changes never publish an alias to an incomplete release', async () => {
  const p = publication();
  await assert.rejects(publishRelease({ api: p.api, upload: async () => { throw new Error('upload transport failed'); }, plan: p.plan, assets: assetsFor(p.plan) }));
  assert.equal(p.refs.get('v1'), p.old); assert.ok(!p.calls.some(call => call.path.endsWith('/releases/9') && call.method === 'PATCH'));
  const changed = publication(); changed.refs.set('v1', 'c'.repeat(40));
  await assert.rejects(publishRelease({ api: changed.api, upload: async () => {}, plan: changed.plan, assets: assetsFor(changed.plan) }), { reason: 'release_alias_changed' });
  assert.equal(changed.refs.get('v1'), 'c'.repeat(40));
});
test('mismatched bundles and incomplete release assets fail before creating any immutable tag', async () => {
  const p = publication(), assets = assetsFor(p.plan);
  assets[0].data = Buffer.from('changed bundle');
  await assert.rejects(publishRelease({ api: p.api, upload: async () => {}, plan: p.plan, assets }), { reason: 'release_asset_hash_mismatch' });
  assert.equal(p.calls.length, 0);
  await assert.rejects(publishRelease({ api: p.api, upload: async () => {}, plan: p.plan, assets: assets.slice(0, 2) }), { reason: 'invalid_release_assets' });
  assert.equal(p.calls.length, 0);
});
