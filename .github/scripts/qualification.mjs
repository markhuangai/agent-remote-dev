import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { digest, frozenExecution, invariant, positiveId, recordName, runnerLabels, same, shaPattern, taskPattern } from '../../src/platform/checkpoint-policy.mjs';
import { authorizeActors, loadVerifiedCheckpoint, pages } from '../../src/platform/continuation-policy.mjs';
import { readArtifact } from '../../src/platform/artifact-io.mjs';
import { dispatchOnce, githubAPI, inspectTask, log, resolveSource } from '../../src/platform/submission.mjs';
export const qualificationCases = ['fresh', 'cold-resume', 'deadline', 'cancellation', 'failed-push'];
import { safeError } from '../../src/platform/runtime-log.mjs';
import { readProjectConfig } from '../../src/platform/project-config.mjs';

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
      values.run.execution.published_ref === task.published_ref && values.run.execution.auto_continue === false &&
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
const repository = 'markhuangai/agent-remote-dev-codex';
export function registryFor({ runId, sourceSha, action, selfHosted, authorization, author, email, nonce = randomBytes(4).toString('hex') }) {
  invariant(positiveId(runId) && shaPattern.test(sourceSha) && typeof authorization === 'string' && authorization.trim() && author?.trim() && email?.trim(), 'invalid_qualification_request');
  const labels = runnerLabels(selfHosted);
  invariant(labels.includes('self-hosted') && labels.some(label => label.toLowerCase() === 'linux'), 'self_hosted_linux_required');
  const targets = [{ key: 'hosted', labels: ['ubuntu-latest'] }, { key: 'self-hosted', labels }];
  const tasks = targets.flatMap(target => qualificationCases.map(scenario => {
    const task_id = `qual-${runId}-${target.key}-${scenario}-${nonce}`;
    invariant(taskPattern.test(task_id), 'invalid_qualification_task');
    return { target: target.key, scenario, task_id, branch: `qualification/${task_id}`, marker: `.runner-qualification/${task_id}.json`, labels: target.labels };
  }));
  const published_tasks = ['v1-prerelease', 'v1'].includes(action?.requested_ref) ? targets.map(target => {
    const task_id = `qual-${runId}-${target.key}-published-${nonce}`;
    return { target: target.key, scenario: 'cold-resume', task_id, branch: `qualification/${task_id}`, marker: `.runner-qualification/${task_id}.json`, labels: target.labels, published_ref: action.requested_ref };
  }) : [];
  return { schema_version: 3, repository, run_id: String(runId), source_sha: sourceSha, action, targets, tasks, published_tasks, authorization, author, email };
}
export async function prepareQualification({ github, context, core, env = process.env }) {
  try {
    invariant(env.GITHUB_REF === 'refs/heads/main' && context.eventName === 'workflow_dispatch' && `${context.repo.owner}/${context.repo.repo}` === repository, 'untrusted_qualification_context');
    invariant(env.GITHUB_RUN_ATTEMPT === '1', 'qualification_rerun_requires_new_run');
    const api = async (path, options) => (await github.request(`${options?.method ?? 'GET'} ${path}`, options)).data;
    await authorizeActors(api, repository, context.actor, env.TRIGGERING_ACTOR);
    invariant(shaPattern.test(env.SOURCE_SHA) && ['ahead', 'identical'].includes((await api(`/repos/${repository}/compare/${env.SOURCE_SHA}...main`)).status), 'qualification_source_not_merged');
    invariant(!env.ACTION_REF || ['v1-prerelease', 'v1'].includes(env.ACTION_REF), 'invalid_qualification_channel');
    const action = await resolveSource(api, repository, env.ACTION_REF || env.SOURCE_SHA);
    invariant(action.sha === env.SOURCE_SHA, 'qualification_alias_source_mismatch');
    const registry = registryFor({ runId: env.GITHUB_RUN_ID, sourceSha: env.SOURCE_SHA, action, selfHosted: JSON.parse(env.SELF_HOSTED_LABELS), authorization: env.QUALIFICATION_AUTHORIZATION,
      author: env.GIT_AUTHOR_NAME, email: env.GIT_AUTHOR_EMAIL });
    registry.project_config = (await readProjectConfig(api, repository, env.GITHUB_WORKFLOW_SHA)).snapshot;
    const root = join(env.RUNNER_TEMP, 'qualification-registry');
    await mkdir(root, { mode: 0o700 }); await writeFile(join(root, 'record.json'), JSON.stringify(registry), { mode: 0o600, flag: 'wx' });
    core.info(JSON.stringify({ event: 'runtime.qualification', level: 'INFO', outcome: 'authorized', source_sha: registry.source_sha, run_id: registry.run_id, targets: registry.targets,
      actor: context.actor, action: registry.action }));
    return { path: join(root, 'record.json'), targets: registry.targets, registry };
  } catch (error) {
    core.error(JSON.stringify({ event: 'runtime.qualification', level: 'ERROR', outcome: 'rejected', run_id: env.GITHUB_RUN_ID,
      source_sha: shaPattern.test(env.SOURCE_SHA) ? env.SOURCE_SHA : null, ...safeError(error) }));
    throw new Error(safeError(error).reason);
  }
}
async function optional(api, path) { try { return await api(path); } catch (error) { if (error.status === 404) return null; throw error; } }
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitRun(api, id, timeout = 1800000) {
  const started = Date.now(); let lastLog = 0;
  for (;;) {
    const run = await api(`/repos/${repository}/actions/runs/${id}`);
    if (run.status === 'completed') return run;
    invariant(Date.now() - started < timeout, 'qualification_run_timeout');
    if (Date.now() - lastLog >= 60000) { log('runtime.qualification', 'INFO', { run_id: id, status: run.status, elapsed_ms: Date.now() - started, timeout_ms: timeout }); lastLog = Date.now(); }
    await pause(10000);
  }
}
async function state(api, task, root) { return inspectTask(api, repository, task.root_run_id ?? task.task_id, join(root, `observation-${randomBytes(6).toString('hex')}`), true); }
async function follow(api, task, root, initialId) {
  const ids = [], started = Date.now(); let id = initialId;
  for (;;) {
    await waitRun(api, id, Math.max(1, 1800000 - (Date.now() - started))); ids.push(id);
    let observed = await state(api, task, root), current = observed.runs.find(run => run.run_id === id);
    invariant(current, 'qualification_run_missing');
    if (current.infrastructure_status !== 'continuing') return { observed, current, ids };
    const deadline = Date.now() + 300000;
    let next;
    while (!next && Date.now() < deadline) {
      observed = await state(api, task, root);
      const matches = observed.runs.filter(run => run.run_id > id);
      invariant(matches.length <= 1, 'qualification_duplicate_child'); next = matches[0];
      if (!next) await pause(10000);
    }
    invariant(next, 'qualification_child_missing'); id = next.run_id;
  }
}
export async function taskRequest(registry, task, artifactId) {
  const context = { ...task, qualification_run_id: registry.run_id, authorization: registry.authorization };
  const instructions = await readFile(new URL('../../tests/fixtures/qualification.md', import.meta.url), 'utf8');
  const plan = `${instructions}\n\nQualification context:\n${JSON.stringify(context)}`;
  return { request_id: task.task_id, source_repository: repository, source_sha: registry.source_sha, plan,
    ...(task.published_ref ? { published_ref: task.published_ref } : {}),
    plan_sha256: digest(plan), project_config: registry.project_config, qualification_artifact_id: artifactId, user_agents_url: null, user_agents_sha256: null, skills: [],
    budget_minutes: 5, max_continuations: 3, auto_continue: task.scenario === 'deadline', git_author_name: registry.author, git_author_email: registry.email };
}
async function checkpoint(api, id, root) {
  const loaded = await readArtifact({ api, repository, id, root, kind: 'checkpoint' });
  invariant(loaded.value.schema_version === 3, 'qualification_checkpoint_schema_mismatch'); return loaded.value;
}
async function verifyPublishedMarker(api, task, runId) {
  const file = await api(`/repos/${repository}/contents/${task.marker}?ref=${encodeURIComponent(task.branch)}`);
  invariant(file.encoding === 'base64', 'qualification_marker_missing');
  const marker = JSON.parse(Buffer.from(file.content, 'base64').toString('utf8'));
  invariant(marker.task_id === task.task_id && String(marker.qualification_run_id) === String(runId) && marker.scenario === task.scenario, 'qualification_marker_identity_mismatch');
  return marker;
}
export async function runTarget(api, registry, targetKey, root, output) {
  invariant(registry.repository === repository && shaPattern.test(registry.source_sha), 'invalid_qualification_registry');
  const actor = (await api('/user')).login;
  await authorizeActors(api, repository, actor, actor);
  const proof = { schema_version: 3, repository, source_sha: registry.source_sha, run_id: registry.run_id, target: targetKey, passed: false, cases: [] };
  await writeFile(output, JSON.stringify(proof), { mode: 0o600 });
  try {
    for (const task of [...registry.tasks, ...(registry.published_tasks ?? [])].filter(task => task.target === targetKey)) {
      const artifacts = await pages(api, `/repos/${repository}/actions/runs/${registry.run_id}/artifacts`, 'artifacts');
      const matches = artifacts.filter(artifact => artifact.name === `linux-qualification-${registry.run_id}-registry`);
      invariant(matches.length === 1, 'qualification_registry_artifact_missing');
      const request = await taskRequest(registry, task, matches[0].id), receipt = await dispatchOnce(api, repository, request, actor, { runner: task.labels });
      task.root_run_id = String(receipt.run_id);
      log('runtime.qualification', 'INFO', { task_id: task.task_id, scenario: task.scenario, runner: task.labels, source_sha: registry.source_sha, root_run_id: receipt.run_id, outcome: 'started' });
      let finished;
      if (task.scenario === 'cancellation') {
        const deadline = Date.now() + 240000; let marker;
        while (!marker && Date.now() < deadline) {
          const file = await optional(api, `/repos/${repository}/contents/${task.marker}?ref=${encodeURIComponent(task.branch)}`);
          if (file?.encoding === 'base64') { const value = JSON.parse(Buffer.from(file.content, 'base64').toString('utf8')); if (value.pr_url) marker = value; }
          if (!marker) await pause(10000);
        }
        invariant(marker, 'qualification_cancellation_setup_missing');
        const stop = await dispatchOnce(api, repository, { operation: 'stop', task_id: task.root_run_id ?? task.task_id, stop_key: randomBytes(16).toString('hex') }, actor);
        invariant((await waitRun(api, stop.run_id)).conclusion === 'success', 'qualification_stop_incomplete');
        const native = await waitRun(api, receipt.run_id);
        invariant(native.conclusion === 'cancelled', 'qualification_cancellation_failed');
        const observationEnd = Date.now() + 300000;
        while (Date.now() < observationEnd) {
          const snapshot = await state(api, task, root);
          invariant(snapshot.runs.length === 1, 'qualification_cancelled_task_restarted');
          log('runtime.qualification', 'INFO', { task_id: task.task_id, scenario: task.scenario, outcome: 'observing_stop_fence', remaining_ms: observationEnd - Date.now() });
          await pause(Math.min(30000, observationEnd - Date.now()));
        }
        const observed = await state(api, task, root);
        invariant(observed.runs.length === 1 && observed.runs.every(run => run.status === 'completed'), 'qualification_cancelled_task_restarted');
        await verifyPublishedMarker(api, task, registry.run_id);
        proof.cases.push({ scenario: task.scenario, task_id: task.task_id, passed: true, source_sha: registry.source_sha, root_run_id: receipt.run_id, run_ids: [receipt.run_id], automatic_restart: false });
        await writeFile(output, JSON.stringify(proof)); continue;
      }
      finished = await follow(api, task, root, receipt.run_id);
      let initial;
      if (task.scenario === 'cold-resume') {
        invariant(finished.current.infrastructure_status === 'incomplete' && positiveId(finished.current.checkpoint?.artifact_id), 'qualification_manual_checkpoint_missing');
        initial = await checkpoint(api, finished.current.checkpoint.artifact_id, join(root, 'cold-initial'));
        const resumed = await dispatchOnce(api, repository, { task_id: task.root_run_id, source_repository: repository, source_sha: registry.source_sha,
          ...(task.published_ref ? { published_ref: task.published_ref } : {}), resume_artifact_id: finished.current.checkpoint.artifact_id, activation_key: randomBytes(16).toString('hex') }, actor, { runner: task.labels });
        const second = await follow(api, task, root, resumed.run_id);
        finished = { ...second, ids: [...finished.ids, ...second.ids] };
      }
      invariant(finished.current.infrastructure_status === 'completed' && finished.current.native_outcome === 'succeeded', 'qualification_invocation_incomplete');
      let response;
      try { response = JSON.parse(finished.current.native_response); } catch { invariant(false, 'qualification_skill_response_invalid'); }
      invariant(response.task_id === task.task_id && response.scenario === task.scenario && response.branch === task.branch && /^https:\/\/github\.com\/markhuangai\/agent-remote-dev-codex\/pull\/[1-9][0-9]*$/.test(response.pr_url), 'qualification_skill_response_mismatch');
      const pull = await api(`/repos/${repository}/pulls/${response.pr_url.split('/').at(-1)}`);
      invariant(pull.head?.ref === task.branch && pull.head.repo?.full_name === repository && pull.draft && !pull.merged_at && pull.body?.includes(`qualification:${registry.run_id}:${task.task_id}`), 'qualification_pull_identity_mismatch');
      const entry = { scenario: task.scenario, task_id: task.task_id, passed: true, source_sha: registry.source_sha, root_run_id: receipt.run_id, run_ids: finished.ids, pr_url: response.pr_url };
      if (task.scenario === 'failed-push') {
        invariant(response.push_rejected === true && response.cause === 'non-fast-forward' && shaPattern.test(response.local_sha) && shaPattern.test(response.remote_sha) && response.local_sha !== response.remote_sha &&
          finished.observed.runs.every(run => !run.checkpoint), 'qualification_false_push_checkpoint');
        invariant((await api(`/repos/${repository}/git/ref/heads/${task.branch}`)).object?.sha === response.remote_sha, 'qualification_failed_push_remote_mismatch');
        entry.false_checkpoint = false;
      } else {
        const final = await checkpoint(api, finished.current.checkpoint.artifact_id, join(root, `${task.scenario}-final`));
        invariant(final.branch === task.branch && final.execution.source_sha === registry.source_sha, 'qualification_checkpoint_source_mismatch');
        await verifyPublishedMarker(api, task, registry.run_id);
        if (task.scenario === 'deadline') {
          invariant(finished.ids.length >= 2, 'qualification_deadline_continuation_missing');
          const first = finished.observed.runs.find(run => run.run_id === receipt.run_id);
          invariant(positiveId(first?.checkpoint?.artifact_id), 'qualification_deadline_checkpoint_missing');
          initial = await checkpoint(api, first.checkpoint.artifact_id, join(root, 'deadline-initial'));
        }
        if (initial) Object.assign(entry, { session_before: initial.session_id, session_after: final.session_id, branch_before: initial.branch, branch_after: final.branch,
          initial_artifact_id: finished.observed.runs.find(run => run.run_id === receipt.run_id).checkpoint.artifact_id, final_artifact_id: finished.current.checkpoint.artifact_id });
        if (initial) invariant(initial.session_id === final.session_id && initial.branch === final.branch, 'qualification_resume_identity_mismatch');
      }
      if (task.published_ref) {
        invariant(finished.ids.length === 2, 'published_smoke_lineage_mismatch');
        Object.assign(entry, { invocation_before: finished.observed.runs.find(run => run.run_id === receipt.run_id)?.invocation, invocation_after: finished.current.invocation });
        proof.published_smoke = entry;
      } else proof.cases.push(entry);
      await writeFile(output, JSON.stringify(proof));
      log('runtime.qualification', 'INFO', { task_id: task.task_id, scenario: task.scenario, outcome: 'passed', run_ids: entry.run_ids });
    }
    invariant(proof.cases.length === qualificationCases.length, 'qualification_cases_missing'); proof.passed = true;
  } finally { await writeFile(output, JSON.stringify(proof), { mode: 0o600 }); }
  return proof;
}
export async function cleanupRegistry(api, registry, root, output) {
  invariant(registry.repository === repository && positiveId(registry.run_id) && Array.isArray(registry.tasks) && registry.tasks.length <= 50, 'invalid_cleanup_registry');
  const actor = (await api('/user')).login; await authorizeActors(api, repository, actor, actor);
  const receipt = { schema_version: 3, repository, run_id: registry.run_id, source_sha: registry.source_sha, verified: false, tasks: [] };
  try {
    for (const task of [...registry.tasks, ...(registry.published_tasks ?? [])]) {
      invariant(taskPattern.test(task.task_id) && task.task_id.startsWith(`qual-${registry.run_id}-`) && task.branch === `qualification/${task.task_id}` && task.marker === `.runner-qualification/${task.task_id}.json`, 'unsafe_qualification_cleanup');
      const runs = await pages(api, `/repos/${repository}/actions/runs?event=workflow_dispatch&branch=main`, 'workflow_runs');
      const roots = runs.filter(run => ['.github/workflows/runner-task.yml', '.github/workflows/runner-published.yml'].includes(run.path) && run.display_title?.startsWith(`Codex request ${task.task_id} / request-`));
      invariant(roots.length <= 1, 'qualification_duplicate_root');
      if (roots.length) task.root_run_id = String(roots[0].id);
      const stop = await dispatchOnce(api, repository, { operation: 'stop', task_id: task.root_run_id ?? task.task_id, stop_key: randomBytes(16).toString('hex') }, actor);
      invariant((await waitRun(api, stop.run_id, 600000)).conclusion === 'success', 'qualification_stop_incomplete');
      const deadline = Date.now() + 300000; let observed;
      do { observed = await state(api, task, root); if (observed.runs.every(run => run.status === 'completed') && observed.controllers.every(run => run.status === 'completed')) break; await pause(10000); } while (Date.now() < deadline);
      invariant(observed.runs.every(run => run.status === 'completed') && observed.controllers.every(run => run.status === 'completed'), 'qualification_cleanup_active_run');
      const branch = await optional(api, `/repos/${repository}/git/ref/heads/${task.branch}`);
      const pulls = await pages(api, `/repos/${repository}/pulls?state=all&head=markhuangai:${encodeURIComponent(task.branch)}`, null);
      const owned = pulls.filter(pull => pull.head?.ref === task.branch && pull.head.repo?.full_name === repository);
      for (const pull of owned) {
        invariant(!pull.merged_at && pull.body?.includes(`qualification:${registry.run_id}:${task.task_id}`), 'qualification_cleanup_pull_not_owned');
        if (pull.state !== 'closed') await api(`/repos/${repository}/pulls/${pull.number}`, { method: 'PATCH', state: 'closed' });
        invariant((await api(`/repos/${repository}/pulls/${pull.number}`)).state === 'closed', 'qualification_cleanup_pull_unverified');
      }
      if (branch) { await verifyPublishedMarker(api, task, registry.run_id); await api(`/repos/${repository}/git/refs/heads/${task.branch}`, { method: 'DELETE' }); }
      invariant(!await optional(api, `/repos/${repository}/git/ref/heads/${task.branch}`), 'qualification_cleanup_branch_unverified');
      receipt.tasks.push({ task_id: task.task_id, verified: true, closed_pr_urls: owned.map(pull => pull.html_url), removed_branch: branch ? task.branch : null, stop_run_id: stop.run_id });
    }
    receipt.verified = true;
  } finally { await writeFile(output, JSON.stringify(receipt), { mode: 0o600 }); }
  return receipt;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const registry = JSON.parse(await readFile(process.env.QUALIFICATION_REGISTRY, 'utf8'));
    const root = join(process.env.RUNNER_TEMP, `qualification-${process.env.GITHUB_JOB}`); await mkdir(root, { mode: 0o700 });
    if (process.argv[2] === 'cleanup') await cleanupRegistry(githubAPI, registry, root, process.env.QUALIFICATION_OUTPUT);
    else await runTarget(githubAPI, registry, process.env.QUALIFICATION_TARGET, root, process.env.QUALIFICATION_OUTPUT);
  } catch (error) { log('runtime.qualification', 'ERROR', { ...safeError(error), ...error.details, source_sha: process.env.SOURCE_SHA, target: process.env.QUALIFICATION_TARGET, outcome: 'blocked' }); process.exitCode = 1; }
}
