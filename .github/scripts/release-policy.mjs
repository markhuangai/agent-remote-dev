import { digest, frozenExecution, invariant, positiveId, recordName, same, shaPattern } from '../../src/platform/checkpoint-policy.mjs';
import { authorizeActors, loadVerifiedCheckpoint, pages } from '../../src/platform/continuation-policy.mjs';
import { readArtifact } from '../../src/platform/artifact-io.mjs';
import { logEvent, safeError } from '../../src/platform/runtime-log.mjs';

export const qualificationCases = ['fresh', 'cold-resume', 'deadline', 'cancellation', 'failed-push'];
export function releaseVersion(version) {
  const match = /^v1\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-rc\.(0|[1-9][0-9]*))?$/.exec(version);
  invariant(match, 'invalid_release_version');
  invariant(version.length <= 100 && match.slice(1).filter(value => value !== undefined).every(value => Number.isSafeInteger(Number(value))), 'invalid_release_version');
  return { version, prerelease: match[3] !== undefined, alias: match[3] === undefined ? 'v1' : 'v1-prerelease', rank: [Number(match[1]), Number(match[2]), match[3] === undefined ? Number.MAX_SAFE_INTEGER : Number(match[3])] };
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
export function validateQualification(registry, proofs, cleanup, repository, sourceSha, runId, stable = false) {
  invariant(registry.schema_version === 3 && registry.repository === repository && registry.source_sha === sourceSha && String(registry.run_id) === String(runId) &&
    Array.isArray(registry.targets) && registry.targets.some(target => target.labels.length === 1 && ['ubuntu-latest', 'ubuntu-24.04-arm'].includes(target.labels[0])) &&
    registry.targets.some(target => target.labels.includes('self-hosted') && target.labels.some(label => label.toLowerCase() === 'linux')), 'qualification_matrix_incomplete');
  invariant(proofs.length === registry.targets.length && new Set(proofs.map(proof => proof.target)).size === proofs.length, 'qualification_proofs_incomplete');
  for (const target of registry.targets) {
    const proof = proofs.find(proof => proof.target === target.key);
    invariant(proof?.schema_version === 3 && proof.repository === repository && proof.source_sha === sourceSha && String(proof.run_id) === String(runId) && proof.passed === true &&
      Array.isArray(proof.cases) && proof.cases.length === qualificationCases.length && qualificationCases.every(name => proof.cases.filter(entry => entry.scenario === name && entry.passed === true && entry.source_sha === sourceSha &&
        positiveId(entry.root_run_id) && Array.isArray(entry.run_ids) && entry.run_ids.length > 0 && entry.run_ids.every(positiveId)).length === 1), 'qualification_case_incomplete');
    for (const name of ['cold-resume', 'deadline']) {
      const entry = proof.cases.find(entry => entry.scenario === name);
      invariant(entry.session_before && entry.session_before === entry.session_after && entry.branch_before === entry.branch_after && positiveId(entry.initial_artifact_id) && positiveId(entry.final_artifact_id), 'qualification_resume_identity_mismatch');
    }
    invariant(proof.cases.find(entry => entry.scenario === 'cancellation').automatic_restart === false && proof.cases.find(entry => entry.scenario === 'failed-push').false_checkpoint === false, 'qualification_adverse_proof_missing');
    const published = registry.published_tasks?.filter(task => task.target === target.key) ?? [];
    if (registry.action?.release_tag) {
      invariant(published.length === 1 && published[0].scenario === 'cold-resume' && published[0].published_ref === registry.action.requested_ref &&
        same(published[0].labels, target.labels), 'published_smoke_task_missing');
      const smoke = proof.published_smoke;
      invariant(smoke?.passed === true && smoke.task_id === published[0].task_id && smoke.source_sha === sourceSha && smoke.scenario === 'cold-resume' &&
        Array.isArray(smoke.run_ids) && smoke.run_ids.length === 2 && smoke.run_ids.every(positiveId) && smoke.run_ids[0] !== smoke.run_ids[1] &&
        smoke.root_run_id === smoke.run_ids[0] && smoke.session_before && smoke.session_before === smoke.session_after && smoke.branch_before === published[0].branch &&
        smoke.branch_after === published[0].branch && positiveId(smoke.initial_artifact_id) && positiveId(smoke.final_artifact_id), 'published_smoke_incomplete');
      validatePublishedInvocation(smoke.invocation_before, registry.action);
      validatePublishedInvocation(smoke.invocation_after, registry.action);
    } else invariant(published.length === 0 && !proof.published_smoke, 'unexpected_published_smoke');
  }
  const tasks = [...registry.tasks, ...(registry.published_tasks ?? [])];
  invariant(cleanup.schema_version === 3 && cleanup.repository === repository && cleanup.source_sha === sourceSha && String(cleanup.run_id) === String(runId) && cleanup.verified === true &&
    Array.isArray(cleanup.tasks) && cleanup.tasks.length === tasks.length && tasks.every(task => cleanup.tasks.some(entry => entry.task_id === task.task_id && entry.verified === true)), 'qualification_cleanup_unproven');
  invariant(registry.action?.repository === repository && registry.action.sha === sourceSha && (registry.action.release_tag === null || /^v1\.\d+\.\d+(?:-rc\.\d+)?$/.test(registry.action.release_tag)) &&
    (registry.action.release_id === null || positiveId(registry.action.release_id)), 'qualification_action_identity_mismatch');
  if (stable) invariant(registry.action?.requested_ref === 'v1-prerelease' && /^v1\.\d+\.\d+-rc\.\d+$/.test(registry.action.release_tag) && positiveId(registry.action.release_id), 'published_prerelease_smoke_required');
  return { run_id: Number(runId), source_sha: sourceSha, targets: proofs.map(proof => proof.target), cleanup_verified: true,
    published_action: { sha: registry.action?.sha ?? null, release_tag: registry.action?.release_tag ?? null, release_id: registry.action?.release_id ?? null } };
}
function validatePublishedInvocation(invocation, action) {
  invariant(invocation?.kind === 'published' && invocation.repository === action.repository && invocation.sha === action.sha &&
    ['v1', 'v1-prerelease'].includes(invocation.requested_ref) && invocation.requested_ref === action.requested_ref &&
    invocation.release_tag === action.release_tag && invocation.release_id === action.release_id, 'published_invocation_unproven');
}
export async function verifyPublishedSmoke(api, repository, qualificationRun, registry, proof, root) {
  const smoke = proof.published_smoke, task = registry.published_tasks.find(task => task.target === proof.target);
  const cache = new Map(), io = (id, kind) => {
    const key = `${id}:${kind}`;
    if (!cache.has(key)) cache.set(key, readArtifact({ api, repository, id, root, kind }));
    return cache.get(key);
  };
  const records = [], checkpoints = [];
  for (const [index, id] of smoke.run_ids.entries()) {
    const run = await api(`/repos/${repository}/actions/runs/${id}`);
    invariant(run.id === id && run.run_attempt === 1 && run.path === '.github/workflows/runner-published.yml' && run.event === 'workflow_dispatch' &&
      run.head_branch === 'main' && run.head_sha === qualificationRun.head_sha && run.repository?.full_name === repository && run.head_repository?.full_name === repository &&
      run.status === 'completed' && run.conclusion === (index === 0 ? 'failure' : 'success'), 'untrusted_published_smoke_run');
    await authorizeActors(api, repository, run.actor?.login, run.triggering_actor?.login);
    const artifacts = await pages(api, `/repos/${repository}/actions/runs/${id}/artifacts`, 'artifacts');
    const values = {};
    for (const kind of ['run', 'outcome']) {
      const matches = artifacts.filter(artifact => artifact.name === recordName(kind, String(smoke.root_run_id), id, 1));
      invariant(matches.length === 1, 'published_smoke_record_missing');
      const loaded = await io(matches[0].id, 'record'), value = loaded.value;
      invariant(loaded.artifact.workflow_run?.id === id && value.schema_version === 3 && value.repository === repository && value.task_id === String(smoke.root_run_id) &&
        String(value.lineage?.run_id) === String(id) && String(value.lineage.run_attempt) === '1' && value.lineage.workflow_sha === run.head_sha &&
        value.lineage.workflow_ref === `${repository}/${run.path}@refs/heads/main` && value.lineage.actor === run.actor?.login && value.lineage.triggering_actor === run.triggering_actor?.login, 'published_smoke_record_mismatch');
      values[kind] = value;
    }
    validatePublishedInvocation(values.run.invocation, registry.action);
    invariant(same(values.run.invocation, index === 0 ? smoke.invocation_before : smoke.invocation_after) && values.run.execution.request_id === task.task_id &&
      values.run.execution.published_ref === task.published_ref && values.run.execution.auto_continue === false && same(values.run.execution.runner, task.labels) &&
      same(values.run.execution.project_config, registry.project_config) && same(values.run.skills, []) &&
      values.run.execution.source_sha === registry.source_sha && values.run.execution.source_repository === repository && values.run.execution.continuation_count === index &&
      values.run.execution.root_run_id === String(smoke.root_run_id) && values.run.execution.root_run_attempt === '1' &&
      values.run.execution.activation_run_id === String(id) && values.run.execution.activation_run_attempt === '1' &&
      (index === 0 ? values.run.resume_artifact_id === null && values.run.execution.parent_run_id === null :
        values.run.resume_artifact_id === smoke.initial_artifact_id && values.run.execution.parent_run_id === String(smoke.root_run_id) && values.run.execution.parent_run_attempt === '1'), 'published_smoke_lineage_mismatch');
    invariant(values.outcome.status === (index === 0 ? 'incomplete' : 'completed') && values.outcome.native_outcome === (index === 0 ? 'timed_out' : 'succeeded') &&
      values.outcome.reason === (index === 0 ? 'action_budget' : 'native_return'), 'published_smoke_outcome_mismatch');
    const artifactId = index === 0 ? smoke.initial_artifact_id : smoke.final_artifact_id;
    invariant(values.outcome.checkpoint?.artifact_id === artifactId, 'published_smoke_checkpoint_mismatch');
    const loaded = await loadVerifiedCheckpoint({ api, io, repository, id: artifactId, taskId: String(smoke.root_run_id) });
    invariant(loaded.producer.id === id && same(loaded.manifest.execution, values.run.execution) && loaded.manifest.branch === task.branch &&
      loaded.manifest.checkpoint_sha === values.outcome.checkpoint.checkpoint_sha && loaded.manifest.plan_sha256 === values.run.plan_sha256 &&
      same(loaded.manifest.skills, values.run.skills), 'published_smoke_checkpoint_mismatch');
    records.push(values.run); checkpoints.push(loaded.manifest);
  }
  invariant(checkpoints[0].session_id === smoke.session_before && checkpoints[1].session_id === smoke.session_after && checkpoints[0].session_id === checkpoints[1].session_id &&
    same(frozenExecution(records[0].execution), frozenExecution(records[1].execution)) && records[0].plan_sha256 === records[1].plan_sha256 &&
    checkpoints[0].sequence < checkpoints[1].sequence, 'published_smoke_resume_mismatch');
  return { target: proof.target, run_ids: smoke.run_ids, source_sha: registry.source_sha, release_tag: registry.action.release_tag, release_id: registry.action.release_id };
}
export async function qualificationReceipt(api, repository, runId, sourceSha, root, stable) {
  const run = await api(`/repos/${repository}/actions/runs/${runId}`);
  invariant(run.id === Number(runId) && run.run_attempt === 1 && run.path === '.github/workflows/runner-acceptance.yml' && run.head_branch === 'main' && run.event === 'workflow_dispatch' && run.repository?.full_name === repository &&
    run.head_repository?.full_name === repository && run.status === 'completed' && run.conclusion === 'success', 'untrusted_qualification_run');
  const artifacts = await pages(api, `/repos/${repository}/actions/runs/${runId}/artifacts`, 'artifacts');
  async function record(name) {
    const matches = artifacts.filter(artifact => artifact.name === name);
    invariant(matches.length === 1, 'qualification_artifact_missing');
    const loaded = await readArtifact({ api, repository, id: matches[0].id, root, kind: 'record' });
    invariant(loaded.artifact.workflow_run?.id === Number(runId), 'qualification_artifact_producer_mismatch');
    return loaded.value;
  }
  const registry = await record(`linux-qualification-${runId}-registry`), proofs = [];
  invariant(Array.isArray(registry.targets) && registry.targets.length <= 10, 'qualification_matrix_incomplete');
  for (const target of registry.targets) proofs.push(await record(`linux-qualification-${runId}-${target.key}`));
  const cleanup = await record(`linux-qualification-${runId}-cleanup`);
  const receipt = validateQualification(registry, proofs, cleanup, repository, sourceSha, runId, stable);
  if (registry.action.release_tag) {
    receipt.published_smoke = [];
    for (const proof of proofs) receipt.published_smoke.push(await verifyPublishedSmoke(api, repository, run, registry, proof, `${root}/published-${proof.target}`));
  }
  return receipt;
}
export async function prepareRelease({ api, repository, version, sourceSha, qualificationRunId, actor, triggeringActor, root }) {
  const parsed = releaseVersion(version);
  await authorizeActors(api, repository, actor, triggeringActor);
  for (const login of new Set([actor, triggeringActor])) invariant(['maintain', 'admin'].includes((await api(`/repos/${repository}/collaborators/${login}/permission`)).permission), 'release_maintainer_required');
  invariant(shaPattern.test(sourceSha) && positiveId(qualificationRunId) && (await api(`/repos/${repository}/commits/${sourceSha}`)).sha === sourceSha, 'invalid_release_source');
  invariant(['ahead', 'identical'].includes((await api(`/repos/${repository}/compare/${sourceSha}...main`)).status), 'release_source_not_merged');
  invariant(!await optional(api, `/repos/${repository}/git/ref/tags/${version}`) && !await optional(api, `/repos/${repository}/releases/tags/${version}`), 'release_version_exists');
  const alias = await optional(api, `/repos/${repository}/git/ref/tags/${parsed.alias}`);
  if (alias) {
    invariant(alias.object?.type === 'commit' && shaPattern.test(alias.object.sha) && ['ahead', 'identical'].includes((await api(`/repos/${repository}/compare/${alias.object.sha}...${sourceSha}`)).status), 'release_alias_not_forward');
  }
  const releases = await pages(api, `/repos/${repository}/releases`, null);
  for (const prior of releases.filter(release => !release.draft && release.prerelease === parsed.prerelease && /^v1\.\d+\.\d+(?:-rc\.\d+)?$/.test(release.tag_name))) {
    const rank = releaseVersion(prior.tag_name).rank;
    const first = parsed.rank.findIndex((value, index) => value !== rank[index]);
    invariant(first !== -1 && parsed.rank[first] > rank[first], 'release_version_not_increasing');
  }
  const checks = await sourceChecks(api, repository, sourceSha), qualification = await qualificationReceipt(api, repository, qualificationRunId, sourceSha, root, !parsed.prerelease);
  if (!parsed.prerelease) {
    const release = await api(`/repos/${repository}/releases/${qualification.published_action.release_id}`);
    const tag = await api(`/repos/${repository}/git/ref/tags/${qualification.published_action.release_tag}`);
    invariant(!release.draft && release.prerelease === true && release.tag_name === qualification.published_action.release_tag && tag.object?.type === 'commit' && tag.object.sha === sourceSha, 'published_prerelease_source_changed');
  }
  return { ...parsed, repository, source_sha: sourceSha, alias_previous_sha: alias?.object.sha ?? null, checks, qualification };
}
export async function publishRelease({ api, upload, plan, assets }) {
  const names = ['action.tar.gz', 'remote-codex.tar.gz', 'SHA256SUMS', 'release-manifest.json'];
  invariant(Array.isArray(assets) && assets.length === names.length && new Set(assets.map(asset => asset.name)).size === names.length && names.every(name => assets.some(asset => asset.name === name && Buffer.isBuffer(asset.data) && asset.data.length > 0)), 'invalid_release_assets');
  const sums = assets.find(asset => asset.name === 'SHA256SUMS').data.toString('utf8').trim().split('\n');
  invariant(sums.length === 2 && ['action.tar.gz', 'remote-codex.tar.gz'].every(name => sums.includes(`${digest(assets.find(asset => asset.name === name).data)}  ${name}`)), 'release_asset_hash_mismatch');
  let manifest;
  try { manifest = JSON.parse(assets.find(asset => asset.name === 'release-manifest.json').data.toString('utf8')); } catch { invariant(false, 'invalid_release_manifest'); }
  invariant(manifest.version === plan.version && manifest.repository === plan.repository && manifest.source_sha === plan.source_sha && manifest.bundle_verified === true && manifest.protocol_version === 3, 'release_manifest_source_mismatch');
  await api(`/repos/${plan.repository}/git/refs`, { method: 'POST', ref: `refs/tags/${plan.version}`, sha: plan.source_sha });
  const release = await api(`/repos/${plan.repository}/releases`, { method: 'POST', tag_name: plan.version, target_commitish: plan.source_sha, name: plan.version,
    draft: true, prerelease: plan.prerelease, body: `Source: ${plan.source_sha}\nQualified run: ${plan.qualification.run_id}\nProtocol/checkpoint: 3\nSource/bundle and installed package verification passed.` });
  invariant(positiveId(release.id) && release.tag_name === plan.version && release.draft === true, 'release_creation_ambiguous');
  for (const asset of assets) await upload(release.id, asset);
  const published = await api(`/repos/${plan.repository}/releases/${release.id}`, { method: 'PATCH', draft: false, make_latest: plan.prerelease ? 'false' : 'true' });
  invariant(published.draft === false && published.tag_name === plan.version && published.prerelease === plan.prerelease, 'release_publication_ambiguous');
  const current = await optional(api, `/repos/${plan.repository}/git/ref/tags/${plan.alias}`);
  invariant((current?.object.sha ?? null) === plan.alias_previous_sha, 'release_alias_changed');
  if (current) await api(`/repos/${plan.repository}/git/refs/tags/${plan.alias}`, { method: 'PATCH', sha: plan.source_sha, force: false });
  else await api(`/repos/${plan.repository}/git/refs`, { method: 'POST', ref: `refs/tags/${plan.alias}`, sha: plan.source_sha });
  const exact = await api(`/repos/${plan.repository}/git/ref/tags/${plan.version}`), alias = await api(`/repos/${plan.repository}/git/ref/tags/${plan.alias}`);
  invariant(exact.object?.sha === plan.source_sha && alias.object?.sha === plan.source_sha, 'release_ref_verification_failed');
  return { release_id: release.id, version: plan.version, source_sha: plan.source_sha, alias: plan.alias, alias_target: plan.source_sha, bundle_verified: true, qualification_run_id: plan.qualification.run_id };
}
export async function releasePreflight({ github, context, core, env = process.env }) {
  const started = Date.now(), repository = `${context.repo.owner}/${context.repo.repo}`;
  try {
    invariant(env.GITHUB_REF === 'refs/heads/main' && context.eventName === 'workflow_dispatch', 'untrusted_release_context');
    const api = async (path, options) => (await github.request(`${options?.method ?? 'GET'} ${path}`, options)).data;
    const plan = await prepareRelease({ api, repository, version: env.RELEASE_VERSION, sourceSha: env.SOURCE_SHA, qualificationRunId: env.QUALIFICATION_RUN_ID,
      actor: context.actor, triggeringActor: env.TRIGGERING_ACTOR, root: env.RUNNER_TEMP + `/release-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}-${env.GITHUB_JOB}` });
    logEvent(core, 'release.verify', 'INFO', { ...plan, outcome: 'qualified', elapsed_ms: Date.now() - started }, env);
    return plan;
  } catch (error) {
    logEvent(core, 'release.verify', 'ERROR', { version: /^v1\.\d+\.\d+(?:-rc\.\d+)?$/.test(env.RELEASE_VERSION ?? '') ? env.RELEASE_VERSION : null,
      source_sha: shaPattern.test(env.SOURCE_SHA ?? '') ? env.SOURCE_SHA : null, qualification_run_id: positiveId(env.QUALIFICATION_RUN_ID) ? env.QUALIFICATION_RUN_ID : null, ...safeError(error), ...error.details,
      outcome: 'blocked', elapsed_ms: Date.now() - started, corrective_action: 'Resolve the named source, bundle, qualification or alias gate; do not overwrite a version or force-update a reference.' }, env);
    throw new Error(safeError(error).reason);
  }
}
