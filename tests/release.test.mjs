import assert from 'node:assert/strict';
import test from 'node:test';
import { latestJobs, publishRelease, releasePreflight, releaseVersion } from '../.github/scripts/release-policy.mjs';
test('release channels accept immutable versions and major channels and inspect latest child attempts including partial reruns', () => {
  assert.equal(releaseVersion('v1.0.0-rc.0').alias, 'v1-prerelease'); assert.equal(releaseVersion('v1.0.0').alias, 'v1');
  assert.equal(releaseVersion('v2.3.4').alias, 'v2'); assert.equal(releaseVersion('v3.0.0-rc.1').alias, 'v3-prerelease');
  assert.equal(releaseVersion(' 1.2.3 ').version, 'v1.2.3');
  assert.equal(releaseVersion(' 1.2.3-rc.4 ').version, 'v1.2.3-rc.4');
  for (const version of ['v1', 'v0.0.0', 'main', 'v1.0.0;echo injected', 'v1.00.0', 'v1.0.0-beta.1',
    'v1.0.0-rc.9007199254740992', 'v' + '9'.repeat(100) + '.0.0']) assert.throws(() => releaseVersion(version));
  const jobs = [{ id: 1, name: 'Analyze (actions)', run_attempt: 1, status: 'completed', conclusion: 'success' }, { id: 2, name: 'Analyze (javascript-typescript)', run_attempt: 1, status: 'completed', conclusion: 'success' },
    { id: 3, name: 'Analyze (actions)', run_attempt: 2, status: 'completed', conclusion: 'success' }];
  assert.deepEqual(latestJobs(jobs, ['Analyze (actions)', 'Analyze (javascript-typescript)'], 2).map(result => result.job_id), [3, 2]);
  jobs[2].conclusion = 'failure'; assert.throws(() => latestJobs(jobs, ['Analyze (actions)'], 2));
  jobs[2].conclusion = 'success'; jobs.push({ ...jobs[2], id: 4 }); assert.throws(() => latestJobs(jobs, ['Analyze (actions)'], 2));
});

const source = 'b'.repeat(40);
const old = 'a'.repeat(40);
const other = 'c'.repeat(40);
const diverged = 'd'.repeat(40);
const absentOid = '0'.repeat(40);
const published = (tag_name, flags = {}) => ({ tag_name, draft: false, prerelease: false, ...flags });

function publication(version, { releases = [], tags = {} } = {}) {
  const repository = 'fixture/repo', repositoryPath = `/repos/${repository}`, actor = 'release-maintainer';
  const config = Buffer.from(`allowed-actors: [${actor}]\n`);
  const refs = new Map(Object.entries(tags)), calls = [], output = [];
  const checks = [
    { id: 11, workflow: 'ci', names: ['CI', 'Runtime (linux-arm64)'] },
    { id: 12, workflow: 'codeql', names: ['Analyze (actions)', 'Analyze (javascript-typescript)', 'CodeQL analysis'] }
  ];
  const missing = () => Object.assign(new Error('missing'), { status: 404 });
  const github = {
    async request(route, options) {
      const [method, path] = route.split(' ');
      assert.ok(path.startsWith(repositoryPath));
      const endpoint = path.slice(repositoryPath.length);
      calls.push({ method, endpoint, ...options });
      if (method === 'POST' && endpoint === '/git/refs') {
        const name = options.ref.slice('refs/tags/'.length);
        assert.ok(!refs.has(name));
        refs.set(name, options.sha);
        return { data: {} };
      }
      if (method === 'POST' && endpoint === '/releases') {
        const { tag_name, draft, prerelease } = options;
        return { data: { id: 9, tag_name, draft, prerelease } };
      }
      assert.equal(method, 'GET');
      if (!endpoint) return { data: { default_branch: 'main', node_id: 'fixture-node' } };
      if (endpoint.startsWith('/commits/')) return { data: { sha: source } };
      if (endpoint.startsWith('/compare/')) {
        const [base, head] = endpoint.slice('/compare/'.length).split('...');
        assert.ok(head === 'main' || head === source);
        if (base === source) return { data: { status: 'identical' } };
        return { data: { status: [old, other].includes(base) ? 'ahead' : 'diverged' } };
      }
      if (endpoint === `/collaborators/${actor}/permission`) return { data: { permission: 'maintain' } };
      if (endpoint === `/contents/.remote-dev.yml?ref=${source}`) {
        return { data: { type: 'file', encoding: 'base64', size: config.length, content: config.toString('base64') } };
      }
      if (endpoint.startsWith('/git/ref/tags/')) {
        const name = endpoint.slice('/git/ref/tags/'.length);
        if (!refs.has(name)) throw missing();
        return { data: { ref: `refs/tags/${name}`, object: { type: 'commit', sha: refs.get(name) } } };
      }
      if (endpoint.startsWith('/releases/tags/')) throw missing();
      if (endpoint === '/releases?per_page=100&page=1') return { data: releases };
      if (endpoint.startsWith('/actions/runs?')) {
        return { data: { workflow_runs: checks.map(({ id, workflow }) => ({ id, path: `.github/workflows/${workflow}.yml`,
          head_sha: source, head_branch: 'main', status: 'completed', conclusion: 'success', run_attempt: 1 })) } };
      }
      const run = checks.find(check => endpoint.startsWith(`/actions/runs/${check.id}/jobs?`));
      if (run) return { data: { jobs: run.names.map((name, index) => ({ name, id: index + 1,
        status: 'completed', conclusion: 'success', run_attempt: 1 })) } };
      throw new Error(`Unexpected publication transport ${route}`);
    },
    async graphql(query, { input }) {
      assert.match(query, /updateRefs\(input: \$input\)/);
      assert.equal(input.repositoryId, 'fixture-node');
      calls.push({ method: 'updateRefs', ...input });
      const tagName = update => update.name.slice('refs/tags/'.length);
      if (input.refUpdates.some(update => (refs.get(tagName(update)) ?? absentOid) !== update.beforeOid)) {
        throw Object.assign(new Error('credential-sentinel'), { status: 422,
          response: { headers: { 'x-github-request-id': 'A11:B22' }, data: { message: 'credential-sentinel' } } });
      }
      for (const update of input.refUpdates) refs.set(tagName(update), update.afterOid);
      return { updateRefs: { clientMutationId: null } };
    }
  };
  const core = { info: line => output.push(line), error: line => output.push(line) };
  const env = { GITHUB_REF: 'refs/heads/main', GITHUB_REPOSITORY: repository, GITHUB_RUN_ID: '42', GITHUB_RUN_ATTEMPT: '2', GITHUB_WORKFLOW_SHA: source,
    SOURCE_SHA: source, TRIGGERING_ACTOR: actor, RELEASE_VERSION: version };
  const context = { repo: { owner: 'fixture', repo: 'repo' }, eventName: 'workflow_dispatch', actor };
  return { refs, calls, output, preflight: () => releasePreflight({ github, core, env, context }),
    publish: plan => publishRelease({ github, core, env, plan }) };
}

for (const [description, version, releases, tags, aliasNames, latestVersion] of [
  ['the first stable release creates both tags', 'v1.0.0', [], {}, ['v1', 'latest'], 'v1.0.0'],
  ['a higher numeric minor advances both tags', 'v1.10.0', [published('v1.9.0')],
    { v1: old, latest: old }, ['v1', 'latest'], 'v1.10.0'],
  ['v2 promotion ignores drafts and release candidates', 'v2.0.0',
    [published('v1.10.0'), published('v9.0.0', { draft: true }), published('v10.0.0-rc.9007199254740992', { prerelease: true })],
    { v1: old, latest: old }, ['v2', 'latest'], 'v2.0.0'],
  ['a release candidate advances only its prerelease tag', 'v2.1.0-rc.1',
    [published('v2.0.0'), published('v2.1.0-rc.0', { prerelease: true })],
    { v2: old, latest: old, 'v2-prerelease': other }, ['v2-prerelease'], 'v2.0.0'],
  ['an alias already at the target is checked in the same update', 'v2.0.0', [published('v1.10.0')],
    { v1: source, latest: source }, ['v2', 'latest'], 'v2.0.0']
]) {
  test(description, async () => {
    const fixture = publication(version, { releases, tags });
    const plan = await fixture.preflight();
    const receipt = await fixture.publish(plan);
    const writes = fixture.calls.filter(call => call.method !== 'GET');
    assert.deepEqual(writes.map(call => call.method), ['POST', 'POST', 'updateRefs']);
    assert.equal(writes[0].ref, `refs/tags/${version}`);
    assert.equal(writes[1].endpoint, '/releases');
    assert.equal(writes[1].make_latest, String(version === latestVersion));
    assert.deepEqual(writes[2].refUpdates, aliasNames.map(name => ({
      name: `refs/tags/${name}`, beforeOid: tags[name] ?? absentOid, afterOid: source, force: false
    })));
    assert.deepEqual(Object.fromEntries(fixture.refs), { ...tags, [version]: source,
      ...Object.fromEntries(aliasNames.map(name => [name, source])) });
    assert.equal(receipt.latest_version, latestVersion);
    assert.ok(receipt.aliases.every(alias => alias.observed_sha === source));
    assert.equal(JSON.parse(fixture.output.at(-1)).outcome, 'verified');
  });
}

test('release input is canonical for existence checks and publication', async () => {
  const existing = publication(' 1.1.0 ', { tags: { 'v1.1.0': old } });
  await assert.rejects(existing.preflight(), /release_version_exists/);
  assert.ok(existing.calls.some(call => call.endpoint === '/git/ref/tags/v1.1.0'));
  assert.ok(existing.calls.every(call => call.method === 'GET'));
  const fixture = publication(' 1.1.0 ', { releases: [published('v1.0.0')], tags: { v1: old, latest: old } });
  const plan = await fixture.preflight();
  assert.equal(plan.version, 'v1.1.0');
  assert.equal(plan.latest_version, 'v1.1.0');
  await fixture.publish(plan);
  assert.equal(fixture.calls.find(call => call.method === 'POST' && call.endpoint === '/git/refs').ref, 'refs/tags/v1.1.0');
  assert.equal(fixture.calls.find(call => call.method === 'POST' && call.endpoint === '/releases').tag_name, 'v1.1.0');
});

test('release preflight reports actionable version ordering failures without writes', async t => {
  for (const [version, releases, reason, latestVersion, previousVersion] of [
    ['private invalid version', [], 'invalid_release_version', undefined, undefined],
    ['1.1.1', [published('v1.1.0'), published('v2.0.0')], 'release_version_not_after_latest_stable', 'v2.0.0', undefined],
    ['1.0.0-rc.0', [published('v1.0.4')], 'release_version_not_after_latest_stable', 'v1.0.4', undefined],
    ['2.1.0-rc.1', [published('v2.0.0'), published('v2.1.0-rc.2', { prerelease: true }),
      published('v9.0.0-rc.9007199254740992', { prerelease: true })], 'release_version_not_increasing', 'v2.0.0', 'v2.1.0-rc.2']
  ]) {
    const fixture = publication(version, { releases });
    await assert.rejects(fixture.preflight(), new RegExp(reason));
    assert.ok(fixture.calls.every(call => call.method === 'GET'));
    const record = JSON.parse(fixture.output.at(-1));
    assert.equal(record.event, 'release.verify');
    assert.equal(record.level, 'ERROR');
    assert.equal(record.repository, 'fixture/repo');
    assert.equal(record.run_id, '42');
    assert.equal(record.run_attempt, '2');
    assert.equal(record.workflow_sha, source);
    assert.equal(record.source_sha, source);
    assert.equal(record.version, reason === 'invalid_release_version' ? null : `v${version}`);
    assert.equal(record.reason, reason);
    assert.equal(record.latest_version, latestVersion);
    assert.equal(record.previous_version, previousVersion);
    assert.equal(record.outcome, 'blocked');
    assert.equal(record.truncated, false);
    assert.ok(Number.isInteger(record.elapsed_ms));
    assert.match(record.corrective_action, /version|release candidate/i);
    assert.doesNotMatch(fixture.output.at(-1), /private invalid version/);
    t.diagnostic(fixture.output.at(-1));
  }
});

test('preflight refuses a diverged major or latest tag before publication', async () => {
  for (const tag of ['v1', 'latest']) {
    const fixture = publication('v1.1.0', { releases: [published('v1.0.0')],
      tags: { v1: old, latest: old, [tag]: diverged } });
    await assert.rejects(fixture.preflight(), /release_alias_not_forward/);
    assert.ok(fixture.calls.every(call => call.method === 'GET'));
  }
});

test('concurrent alias changes preserve the published version and log the atomic update failure', async t => {
  const fixture = publication('v1.1.0', { releases: [published('v1.0.0')], tags: { v1: old, latest: old } });
  const plan = await fixture.preflight();
  fixture.refs.set('latest', other);
  await assert.rejects(fixture.publish(plan), { reason: 'release_alias_changed' });
  assert.equal(fixture.calls.filter(call => call.method === 'updateRefs').length, 1);
  assert.deepEqual(Object.fromEntries(fixture.refs), { v1: old, latest: other, 'v1.1.0': source });
  const line = fixture.output.at(-1);
  const record = JSON.parse(line);
  assert.equal(record.event, 'release.aliases');
  assert.equal(record.level, 'ERROR');
  assert.equal(record.run_id, '42');
  assert.equal(record.run_attempt, '2');
  assert.equal(record.outcome, 'blocked');
  assert.equal(record.latest_version, 'v1.1.0');
  assert.equal(record.release_id, 9);
  assert.equal(record.exact.observed_sha, source);
  assert.deepEqual(record.aliases, [
    { name: 'v1', previous_sha: old, expected_sha: source, observed_sha: old },
    { name: 'latest', previous_sha: old, expected_sha: source, observed_sha: other }
  ]);
  assert.equal(record.update_failure.http_status, 422);
  assert.equal(record.update_failure.request_id, 'A11:B22');
  assert.match(record.corrective_action, /repair the aliases/);
  assert.doesNotMatch(line, /credential-sentinel/);
  t.diagnostic(line);
});
