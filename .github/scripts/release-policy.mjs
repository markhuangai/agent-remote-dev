import { invariant, positiveId, shaPattern } from '../../src/platform/checkpoint-policy.mjs';
import { authorizeActors, pages } from '../../src/platform/continuation-policy.mjs';
import { logEvent, safeError } from '../../src/platform/runtime-log.mjs';

export function releaseVersion(version) {
  const match = /^v([1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-rc\.(0|[1-9][0-9]*))?$/.exec(version);
  invariant(match, 'invalid_release_version');
  invariant(version.length <= 100 && match.slice(1).filter(value => value !== undefined).every(value => Number.isSafeInteger(Number(value))), 'invalid_release_version');
  return { version, prerelease: match[4] !== undefined, alias: `v${match[1]}${match[4] === undefined ? '' : '-prerelease'}`, rank: [Number(match[1]), Number(match[2]), Number(match[3]), match[4] === undefined ? Number.MAX_SAFE_INTEGER : Number(match[4])] };
}
async function optional(api, path) {
  try { return await api(path); } catch (error) { if (error.status === 404) return null; throw error; }
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
  const alias = await optional(api, `/repos/${repository}/git/ref/tags/${parsed.alias}`);
  if (alias) {
    invariant(alias.object?.type === 'commit' && shaPattern.test(alias.object.sha) && ['ahead', 'identical'].includes((await api(`/repos/${repository}/compare/${alias.object.sha}...${sourceSha}`)).status), 'release_alias_not_forward');
  }
  const releases = await pages(api, `/repos/${repository}/releases`, null);
  for (const prior of releases.filter(release => !release.draft && release.prerelease === parsed.prerelease && /^v[1-9]\d*\.\d+\.\d+(?:-rc\.\d+)?$/.test(release.tag_name))) {
    const previous = releaseVersion(prior.tag_name);
    if (previous.alias !== parsed.alias) continue;
    const rank = previous.rank;
    const first = parsed.rank.findIndex((value, index) => value !== rank[index]);
    invariant(first !== -1 && parsed.rank[first] > rank[first], 'release_version_not_increasing');
  }
  const checks = await sourceChecks(api, repository, sourceSha);
  return { ...parsed, repository, source_sha: sourceSha, alias_previous_sha: alias?.object.sha ?? null, checks };
}
export async function publishRelease({ api, plan }) {
  await api(`/repos/${plan.repository}/git/refs`, { method: 'POST', ref: `refs/tags/${plan.version}`, sha: plan.source_sha });
  const release = await api(`/repos/${plan.repository}/releases`, { method: 'POST', tag_name: plan.version, target_commitish: plan.source_sha,
    name: plan.version, draft: false, prerelease: plan.prerelease, make_latest: plan.prerelease ? 'false' : 'true',
    body: `Reusable remote development workflow. Source: ${plan.source_sha}` });
  invariant(positiveId(release.id) && release.tag_name === plan.version && release.draft === false && release.prerelease === plan.prerelease, 'release_publication_ambiguous');
  const current = await optional(api, `/repos/${plan.repository}/git/ref/tags/${plan.alias}`);
  invariant((current?.object.sha ?? null) === plan.alias_previous_sha, 'release_alias_changed');
  if (current) await api(`/repos/${plan.repository}/git/refs/tags/${plan.alias}`, { method: 'PATCH', sha: plan.source_sha, force: false });
  else await api(`/repos/${plan.repository}/git/refs`, { method: 'POST', ref: `refs/tags/${plan.alias}`, sha: plan.source_sha });
  const exact = await api(`/repos/${plan.repository}/git/ref/tags/${plan.version}`), alias = await api(`/repos/${plan.repository}/git/ref/tags/${plan.alias}`);
  invariant(exact.object?.sha === plan.source_sha && alias.object?.sha === plan.source_sha, 'release_ref_verification_failed');
  return { release_id: release.id, version: plan.version, source_sha: plan.source_sha, alias: plan.alias };
}
export async function releasePreflight({ github, context, core, env = process.env }) {
  const started = Date.now(), repository = `${context.repo.owner}/${context.repo.repo}`;
  try {
    invariant(env.GITHUB_REF === 'refs/heads/main' && context.eventName === 'workflow_dispatch', 'untrusted_release_context');
    const api = async (path, options) => (await github.request(`${options?.method ?? 'GET'} ${path}`, options)).data;
    const plan = await prepareRelease({ api, repository, version: env.RELEASE_VERSION, sourceSha: env.SOURCE_SHA,
      actor: context.actor, triggeringActor: env.TRIGGERING_ACTOR });
    logEvent(core, 'release.verify', 'INFO', { ...plan, outcome: 'verified', elapsed_ms: Date.now() - started }, env);
    return plan;
  } catch (error) {
    logEvent(core, 'release.verify', 'ERROR', { version: /^v[1-9]\d*\.\d+\.\d+(?:-rc\.\d+)?$/.test(env.RELEASE_VERSION ?? '') ? env.RELEASE_VERSION : null,
      source_sha: shaPattern.test(env.SOURCE_SHA ?? '') ? env.SOURCE_SHA : null, ...safeError(error), ...error.details,
      outcome: 'blocked', elapsed_ms: Date.now() - started, corrective_action: 'Resolve the named source, bundle or alias gate; do not overwrite a version or force-update a reference.' }, env);
    throw new Error(safeError(error).reason);
  }
}
