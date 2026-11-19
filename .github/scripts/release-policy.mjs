import { invariant, positiveId, shaPattern } from '../../src/platform/checkpoint-policy.mjs';
import { authorizeActors, githubAPI, pages } from '../../src/platform/continuation-policy.mjs';
import { logEvent, safeError } from '../../src/platform/runtime-log.mjs';

const versionPattern = /^v([1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-rc\.(0|[1-9][0-9]*))?$/;
const absentOid = '0'.repeat(40);

export function releaseVersion(version) {
  const match = versionPattern.exec(version);
  invariant(match, 'invalid_release_version');
  invariant(version.length <= 100 && match.slice(1).filter(value => value !== undefined).every(value => Number.isSafeInteger(Number(value))), 'invalid_release_version');
  return { version, prerelease: match[4] !== undefined, alias: `v${match[1]}${match[4] === undefined ? '' : '-prerelease'}`, rank: [Number(match[1]), Number(match[2]), Number(match[3]), match[4] === undefined ? Number.MAX_SAFE_INTEGER : Number(match[4])] };
}
function compareVersions(left, right) {
  const first = left.rank.findIndex((value, index) => value !== right.rank[index]);
  return first === -1 ? 0 : left.rank[first] - right.rank[first];
}
async function optional(api, path) {
  try { return await api(path); } catch (error) { if (error.status === 404) return null; throw error; }
}
function commitTagSha(ref, name) {
  return ref?.ref === `refs/tags/${name}` && ref.object?.type === 'commit' && shaPattern.test(ref.object.sha)
    ? ref.object.sha : null;
}
export function latestJobs(jobs, names, attempt) {
  return names.map(name => {
    const executions = jobs.filter(job => job.name === name);
    invariant(executions.every(job => Number.isSafeInteger(job.run_attempt) && job.run_attempt > 0 && job.run_attempt <= attempt), 'invalid_release_check_attempt');
    const latestAttempt = executions.length ? Math.max(...executions.map(job => job.run_attempt)) : null;
    const latest = executions.filter(job => job.run_attempt === latestAttempt);
    invariant(latest.length === 1 && latest[0].status === 'completed' && latest[0].conclusion === 'success', 'release_source_check_failed');
    return { name, job_id: latest[0].id, run_attempt: latestAttempt };
  });
}
export async function sourceChecks(api, repository, sha) {
  const runs = await pages(api, `/repos/${repository}/actions/runs?head_sha=${sha}&event=push&branch=main`, 'workflow_runs'), receipts = [];
  for (const [path, names] of [['.github/workflows/ci.yml', ['CI', 'Runtime (linux-arm64)']], ['.github/workflows/codeql.yml', ['Analyze (actions)', 'Analyze (javascript-typescript)', 'CodeQL analysis']]]) {
    const matches = runs.filter(run => run.path === path && run.head_sha === sha && run.head_branch === 'main').sort((left, right) => right.id - left.id);
    invariant(matches.length > 0 && matches[0].status === 'completed' && matches[0].conclusion === 'success', 'release_source_workflow_incomplete');
    const run = matches[0], jobs = await pages(api, `/repos/${repository}/actions/runs/${run.id}/jobs?filter=all`, 'jobs');
    receipts.push({ workflow: path, run_id: run.id, run_url: run.html_url, results: latestJobs(jobs, names, run.run_attempt) });
  }
  return receipts;
}
export async function prepareRelease({ api, repository, version, sourceSha, actor, triggeringActor }) {
  const parsed = releaseVersion(version);
  await authorizeActors(api, repository, actor, triggeringActor);
  for (const login of new Set([actor, triggeringActor])) invariant(['maintain', 'admin'].includes((await api(`/repos/${repository}/collaborators/${login}/permission`)).permission), 'release_maintainer_required');
  invariant(shaPattern.test(sourceSha) && (await api(`/repos/${repository}/commits/${sourceSha}`)).sha === sourceSha, 'invalid_release_source');
  invariant(['ahead', 'identical'].includes((await api(`/repos/${repository}/compare/${sourceSha}...main`)).status), 'release_source_not_merged');
  invariant(!await optional(api, `/repos/${repository}/git/ref/tags/${version}`) && !await optional(api, `/repos/${repository}/releases/tags/${version}`), 'release_version_exists');
  const releases = await pages(api, `/repos/${repository}/releases`, null);
  let latestStable = null;
  for (const prior of releases) {
    if (prior.draft || prior.prerelease !== parsed.prerelease) continue;
    const match = versionPattern.exec(prior.tag_name);
    if (!match || (match[4] !== undefined) !== parsed.prerelease) continue;
    const previous = releaseVersion(prior.tag_name);
    if (previous.alias === parsed.alias) invariant(compareVersions(parsed, previous) > 0, 'release_version_not_increasing');
    if (!previous.prerelease && (!latestStable || compareVersions(previous, latestStable) > 0)) latestStable = previous;
  }
  const makeLatest = !parsed.prerelease && (!latestStable || compareVersions(parsed, latestStable) > 0);
  const latestVersion = makeLatest ? version : latestStable?.version ?? null;
  const aliases = [];
  for (const name of makeLatest ? [parsed.alias, 'latest'] : [parsed.alias]) {
    const current = await optional(api, `/repos/${repository}/git/ref/tags/${name}`);
    const previousSha = commitTagSha(current, name);
    const alias = { name, previous_sha: previousSha, expected_sha: sourceSha };
    if (current) {
      const forward = previousSha && ['ahead', 'identical'].includes((await api(`/repos/${repository}/compare/${previousSha}...${sourceSha}`)).status);
      if (!forward) {
        const reason = 'release_alias_not_forward';
        throw Object.assign(new Error(reason), { reason, details: { latest_version: latestVersion, aliases: [...aliases, alias] } });
      }
    }
    aliases.push(alias);
  }
  const checks = await sourceChecks(api, repository, sourceSha);
  return { ...parsed, repository, source_sha: sourceSha, make_latest: makeLatest, latest_version: latestVersion, aliases, checks };
}
export async function publishRelease({ github, plan, core, env = process.env }) {
  const api = githubAPI(github), repositoryPath = `/repos/${plan.repository}`;
  const started = Date.now();
  const aliases = plan.aliases.map(alias => ({ ...alias }));
  const exact = { name: plan.version, previous_sha: null, expected_sha: plan.source_sha };
  const receipt = { version: plan.version, source_sha: plan.source_sha, alias: plan.alias, aliases,
    make_latest: plan.make_latest, latest_version: plan.latest_version, release_id: null };
  const refUpdates = aliases.map(alias => ({
    name: `refs/tags/${alias.name}`, beforeOid: alias.previous_sha ?? absentOid, afterOid: alias.expected_sha, force: false
  }));
  let stage = 'resolve_repository';
  let updateFailure = null;
  try {
    const { node_id: repositoryId } = await api(repositoryPath);
    invariant(typeof repositoryId === 'string' && repositoryId.length > 0, 'invalid_release_repository');
    stage = 'create_version_tag';
    await api(`${repositoryPath}/git/refs`, { method: 'POST', ref: `refs/tags/${plan.version}`, sha: plan.source_sha });
    stage = 'create_release';
    const release = await api(`${repositoryPath}/releases`, { method: 'POST', tag_name: plan.version, target_commitish: plan.source_sha,
      name: plan.version, draft: false, prerelease: plan.prerelease, make_latest: String(plan.make_latest),
      body: `Reusable remote development workflow. Source: ${plan.source_sha}` });
    invariant(positiveId(release.id) && release.tag_name === plan.version && release.draft === false && release.prerelease === plan.prerelease, 'release_publication_ambiguous');
    receipt.release_id = release.id;
    if (aliases.some(alias => alias.previous_sha !== alias.expected_sha)) {
      try {
        await github.graphql(`mutation UpdateReleaseAliases($input: UpdateRefsInput!) {
          updateRefs(input: $input) { clientMutationId }
        }`, { input: { repositoryId, refUpdates } });
      } catch (error) {
        // The update may have applied even if the response was lost.
        updateFailure = safeError(error);
      }
    }
    stage = 'verify_refs';
    for (const ref of [exact, ...aliases]) {
      const observed = await optional(api, `${repositoryPath}/git/ref/tags/${ref.name}`);
      ref.observed_sha = commitTagSha(observed, ref.name);
    }
    if ([exact, ...aliases].some(ref => ref.observed_sha !== ref.expected_sha)) {
      invariant(!(updateFailure && aliases.some(alias => alias.observed_sha !== alias.previous_sha)), 'release_alias_changed');
      invariant(!updateFailure, 'release_alias_update_failed');
      invariant(false, 'release_ref_verification_failed');
    }
    logEvent(core, 'release.aliases', 'INFO', { ...receipt, exact, update_failure: updateFailure,
      outcome: 'verified', elapsed_ms: Date.now() - started }, env);
    return receipt;
  } catch (error) {
    const failure = safeError(error);
    logEvent(core, 'release.aliases', 'ERROR', { ...receipt, exact, ...failure, stage, update_failure: updateFailure,
      outcome: 'blocked', elapsed_ms: Date.now() - started,
      corrective_action: receipt.release_id
        ? 'Verify the published release and ref heads, then repair the aliases with an authorized forward-only update.'
        : 'Inspect the version tag and release record before retrying publication.' }, env);
    throw Object.assign(new Error(failure.reason), { reason: failure.reason });
  }
}
export async function releasePreflight({ github, context, core, env = process.env }) {
  const started = Date.now(), repository = `${context.repo.owner}/${context.repo.repo}`;
  try {
    invariant(env.GITHUB_REF === 'refs/heads/main' && context.eventName === 'workflow_dispatch', 'untrusted_release_context');
    const plan = await prepareRelease({ api: githubAPI(github), repository, version: env.RELEASE_VERSION, sourceSha: env.SOURCE_SHA,
      actor: context.actor, triggeringActor: env.TRIGGERING_ACTOR });
    logEvent(core, 'release.verify', 'INFO', { ...plan, outcome: 'verified', elapsed_ms: Date.now() - started }, env);
    return plan;
  } catch (error) {
    logEvent(core, 'release.verify', 'ERROR', { version: versionPattern.test(env.RELEASE_VERSION ?? '') ? env.RELEASE_VERSION : null,
      source_sha: shaPattern.test(env.SOURCE_SHA ?? '') ? env.SOURCE_SHA : null, ...safeError(error), ...error.details,
      outcome: 'blocked', elapsed_ms: Date.now() - started, corrective_action: 'Resolve the named source, bundle or alias gate; do not overwrite a version or force-update a reference.' }, env);
    throw new Error(safeError(error).reason);
  }
}
