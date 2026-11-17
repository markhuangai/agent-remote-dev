import assert from 'node:assert/strict';
import test from 'node:test';
import { latestJobs, publishRelease, releaseVersion } from '../.github/scripts/release-policy.mjs';
test('release channels accept immutable versions and major channels and inspect latest child attempts including partial reruns', () => {
  assert.equal(releaseVersion('v1.0.0-rc.0').alias, 'v1-prerelease'); assert.equal(releaseVersion('v1.0.0').alias, 'v1');
  assert.equal(releaseVersion('v2.3.4').alias, 'v2'); assert.equal(releaseVersion('v3.0.0-rc.1').alias, 'v3-prerelease');
  for (const version of ['v1', 'v0.0.0', 'main', 'v1.0.0;echo injected', 'v1.00.0']) assert.throws(() => releaseVersion(version));
  const jobs = [{ id: 1, name: 'Analyze (actions)', run_attempt: 1, status: 'completed', conclusion: 'success' }, { id: 2, name: 'Analyze (javascript-typescript)', run_attempt: 1, status: 'completed', conclusion: 'success' },
    { id: 3, name: 'Analyze (actions)', run_attempt: 2, status: 'completed', conclusion: 'success' }];
  assert.deepEqual(latestJobs(jobs, ['Analyze (actions)', 'Analyze (javascript-typescript)'], 2).map(result => result.job_id), [3, 2]);
  jobs[2].conclusion = 'failure'; assert.throws(() => latestJobs(jobs, ['Analyze (actions)'], 2));
  jobs[2].conclusion = 'success'; jobs.push({ ...jobs[2], id: 4 }); assert.throws(() => latestJobs(jobs, ['Analyze (actions)'], 2));
});
function publication() {
  const source = 'b'.repeat(40), old = 'a'.repeat(40), refs = new Map([['v1', old]]), calls = [];
  const plan = { ...releaseVersion('v1.0.0'), repository: 'fixture/repo', source_sha: source, alias_previous_sha: old };
  const api = async (path, options = {}) => {
    calls.push({ path, ...options });
    if (path.endsWith('/git/refs') && options.method === 'POST') { refs.set(options.ref.slice('refs/tags/'.length), options.sha); return {}; }
    if (path.endsWith('/releases') && options.method === 'POST') return { id: 9, tag_name: plan.version, draft: false, prerelease: false };
    if (path.includes('/git/ref/tags/')) { const tag = path.split('/').at(-1); if (!refs.has(tag)) throw Object.assign(new Error('missing'), { status: 404 }); return { object: { type: 'commit', sha: refs.get(tag) } }; }
    if (path.endsWith('/git/refs/tags/v1') && options.method === 'PATCH') { assert.equal(options.force, false); refs.set('v1', options.sha); return {}; }
    throw new Error(`Unexpected publication transport ${path}`);
  };
  return { source, old, refs, calls, plan, api };
}
test('workflow releases publish immutable source versions and update aliases without force or custom assets', async () => {
  const p = publication(); const receipt = await publishRelease({ api: p.api, plan: p.plan });
  assert.equal(receipt.source_sha, p.source); assert.equal(p.refs.get('v1.0.0'), p.source); assert.equal(p.refs.get('v1'), p.source);
  assert.ok(p.calls.findIndex(call => call.path.endsWith('/releases')) < p.calls.findIndex(call => call.method === 'PATCH'));
  assert.ok(!p.calls.some(call => /assets/.test(call.path)));
});
test('concurrent alias changes preserve the independently published version and refuse the alias mutation', async () => {
  const p = publication(); p.refs.set('v1', 'c'.repeat(40));
  await assert.rejects(publishRelease({ api: p.api, plan: p.plan }), { reason: 'release_alias_changed' });
  assert.equal(p.refs.get('v1'), 'c'.repeat(40)); assert.equal(p.refs.get('v1.0.0'), p.source);
});
