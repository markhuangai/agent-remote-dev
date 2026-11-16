import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { digest, invariant, positiveId, runnerLabels, shaPattern, taskPattern } from '../remote-codex/checkpoint-policy.mjs';
import { authorizeActors, pages } from '../remote-codex/continuation-policy.mjs';
import { readArtifact } from '../remote-codex/artifact-io.mjs';
import { dispatchOnce, githubAPI, inspectTask, log, resolveSource } from '../../skills/remote-codex/scripts/submission.mjs';
import { qualificationCases } from './release-policy.mjs';
import { safeError } from '../remote-codex/runtime-log.mjs';
import { readProjectConfig } from '../remote-codex/project-config.mjs';

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
  return { schema_version: 3, repository, run_id: String(runId), source_sha: sourceSha, action, targets, tasks, authorization, author, email };
}
export async function prepareQualification({ github, context, core, env = process.env }) {
  try {
    invariant(env.GITHUB_REF === 'refs/heads/main' && context.eventName === 'workflow_dispatch' && `${context.repo.owner}/${context.repo.repo}` === repository, 'untrusted_qualification_context');
    const api = async (path, options) => (await github.request(`${options?.method ?? 'GET'} ${path}`, options)).data;
    await authorizeActors(api, repository, context.actor, env.TRIGGERING_ACTOR);
    invariant(shaPattern.test(env.SOURCE_SHA) && ['ahead', 'identical'].includes((await api(`/repos/${repository}/compare/${env.SOURCE_SHA}...main`)).status), 'qualification_source_not_merged');
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
function taskRequest(registry, task, artifactId) {
  const context = { ...task, qualification_run_id: registry.run_id };
  const plan = `Use $runner-acceptance for this explicitly authorized smoke case. Follow its workflow; the runner does not implement its phases. Qualification context:\n${JSON.stringify(context)}`;
  return { request_id: task.task_id, source_repository: repository, source_sha: registry.source_sha, plan,
    plan_sha256: digest(plan), project_config: registry.project_config, qualification_artifact_id: artifactId, user_agents_url: null, user_agents_sha256: null, skills: [{ repository, revision: registry.source_sha, names: ['runner-acceptance'] }],
    runner: task.labels, budget_minutes: 5, max_continuations: 3, auto_continue: task.scenario === 'deadline', git_author_name: registry.author, git_author_email: registry.email };
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
    for (const task of registry.tasks.filter(task => task.target === targetKey)) {
      const artifacts = await pages(api, `/repos/${repository}/actions/runs/${registry.run_id}/artifacts`, 'artifacts');
      const matches = artifacts.filter(artifact => artifact.name === `linux-qualification-${registry.run_id}-registry`);
      invariant(matches.length === 1, 'qualification_registry_artifact_missing');
      const request = taskRequest(registry, task, matches[0].id), receipt = await dispatchOnce(api, repository, request, actor);
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
        const resumed = await dispatchOnce(api, repository, { task_id: task.root_run_id, source_repository: repository, source_sha: registry.source_sha, resume_artifact_id: finished.current.checkpoint.artifact_id, activation_key: randomBytes(16).toString('hex') }, actor);
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
      proof.cases.push(entry); await writeFile(output, JSON.stringify(proof));
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
    for (const task of registry.tasks) {
      invariant(taskPattern.test(task.task_id) && task.task_id.startsWith(`qual-${registry.run_id}-`) && task.branch === `qualification/${task.task_id}` && task.marker === `.runner-qualification/${task.task_id}.json`, 'unsafe_qualification_cleanup');
      const runs = await pages(api, `/repos/${repository}/actions/runs?event=workflow_dispatch&branch=main`, 'workflow_runs');
      const roots = runs.filter(run => run.path === '.github/workflows/runner-task.yml' && run.display_title?.startsWith(`Codex request ${task.task_id} / request-`));
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
