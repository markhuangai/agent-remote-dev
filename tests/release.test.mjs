import assert from 'node:assert/strict';
import test from 'node:test';
import { latestJobs, publishRelease, releaseVersion } from '../.github/scripts/release-policy.mjs';
import { registryFor, qualificationCases } from '../.github/scripts/qualification.mjs';
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
test('qualification still covers both Linux families, all native scenarios and published workflow resume', () => {
  const value = registryFor({ runId: '100', sourceSha: 'a'.repeat(40), selfHosted: ['self-hosted', 'Linux', 'ARM64'],
    authorization: 'Run and clean these owned smoke tasks.', actionRef: 'v1-prerelease', nonce: '12345678' });
  assert.equal(value.targets.length, 2); assert.equal(value.tasks.length, 12);
  for (const target of value.targets) assert.deepEqual(value.tasks.filter(task => task.target === target.key).map(task => task.scenario), [...qualificationCases, 'published-resume']);
  assert.equal(value.tasks.find(task => task.scenario === 'published-resume').workflow, 'runner-prerelease.yml');
  assert.throws(() => registryFor({ runId: '100', sourceSha: 'a'.repeat(40), selfHosted: ['windows-latest'], authorization: 'authorized' }));
});

test('live qualification rejects false publication, missing phase advancement and invented push rejection', async () => {
  const { verifyPublication, verifyRejectedPush } = await import('../.github/scripts/qualification.mjs');
  const task = { id: 'qual-100-hosted-fresh-abcd', branch: 'qualification/qual-100-hosted-fresh-abcd', marker: '.runner-qualification/qual-100-hosted-fresh-abcd.json', scenario: 'fresh' };
  const marker = { task_id: task.id, qualification_run_id: '100', scenario: 'fresh', phase: 1, pr_url: 'https://github.com/markhuangai/agent-remote-dev-codex/pull/12' };
  const pull = { head: { ref: task.branch, repo: { full_name: 'markhuangai/agent-remote-dev-codex' } }, draft: true, state: 'open', merged_at: null, body: `qualification:100:${task.id}` };
  const api = async path => path.includes('/contents/') ? { encoding: 'base64', content: Buffer.from(JSON.stringify(marker)).toString('base64') } : pull;
  await verifyPublication(api, { run_id: '100' }, task, 1);
  await assert.rejects(verifyPublication(api, { run_id: '100' }, task, 2), /qualification_marker_identity_mismatch/);
  pull.draft = false; await assert.rejects(verifyPublication(api, { run_id: '100' }, task, 1), /qualification_pull_identity_mismatch/);
  const response = { push_rejected: true, cause: 'non-fast-forward', local_sha: 'a'.repeat(40), remote_sha: 'b'.repeat(40) };
  const manifest = { omitted_work: true, checkpoint_sha: 'c'.repeat(40) }, remote = { object: { sha: response.remote_sha } };
  verifyRejectedPush(response, manifest, remote);
  assert.throws(() => verifyRejectedPush({ ...response, push_rejected: false }, manifest, remote));
  assert.throws(() => verifyRejectedPush(response, { ...manifest, checkpoint_sha: response.local_sha }, remote));
  assert.throws(() => verifyRejectedPush(response, manifest, { object: { sha: 'd'.repeat(40) } }));
});
