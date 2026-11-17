import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { invariant, positiveId, runnerLabels, shaPattern } from '../../src/platform/checkpoint-policy.mjs';
import { authorizeActors, loadRunCheckpoint, pages } from '../../src/platform/continuation-policy.mjs';
import { readArtifact } from '../../src/platform/artifact-io.mjs';
import { logEvent, safeError } from '../../src/platform/runtime-log.mjs';
export const qualificationCases = ['fresh', 'cold-resume', 'deadline', 'cancellation', 'failed-push'];
const repository = 'markhuangai/agent-remote-dev-codex';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const sink = Object.fromEntries(['info', 'warning', 'error', 'debug'].map(key => [key, text => process.stderr.write(text + '\n')]));
export async function api(path, options = {}) {
  const { method = 'GET', ...data } = options, args = ['api', path.replace(/^\//, ''), '--method', method];
  for (const [key, value] of Object.entries(data)) args.push('-f', `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`);
  if (path.endsWith('/zip')) {
    const result = await promisify(execFile)('gh', args, { encoding: 'buffer', timeout: 30000, maxBuffer: 256 * 1024 * 1024 }); return result.stdout;
  }
  if (Object.keys(data).length) {
    const { spawn } = await import('node:child_process');
    return new Promise((resolveResult, reject) => {
      const child = spawn('gh', ['api', path.replace(/^\//, ''), '--method', method, '--input', '-'], { stdio: ['pipe', 'pipe', 'pipe'], signal: AbortSignal.timeout(30000) });
      let output = '';
      child.stdout.on('data', chunk => { output += chunk; }); let stderr = ''; child.stderr.on('data', chunk => { if (stderr.length < 4096) stderr += chunk; });
      child.on('error', () => reject(Object.assign(new Error('github_api_failed'), { reason: 'github_api_failed' })));
      child.on('close', code => { if (code) reject(Object.assign(new Error('github_api_failed'), { reason: 'github_api_failed', status: Number(/HTTP (\d{3})/.exec(stderr)?.[1]) || undefined })); else resolveResult(output ? JSON.parse(output) : null); });
      child.stdin.end(JSON.stringify(data));
    });
  }
  try { const result = await promisify(execFile)('gh', args, { timeout: 30000, maxBuffer: 4 * 1024 * 1024 }); return result.stdout ? JSON.parse(result.stdout) : null; }
  catch (error) { throw Object.assign(new Error('github_api_failed'), { reason: 'github_api_failed', status: Number(/HTTP (\d{3})/.exec(error.stderr ?? '')?.[1]) || undefined }); }
}
export function registryFor({ runId, sourceSha, selfHosted, authorization, actionRef = '', nonce = randomBytes(4).toString('hex') }) {
  invariant(positiveId(runId) && shaPattern.test(sourceSha) && authorization?.trim(), 'invalid_qualification_request');
  const labels = runnerLabels(selfHosted); invariant(labels.includes('self-hosted'), 'self_hosted_linux_required');
  invariant(['', 'v1', 'v1-prerelease'].includes(actionRef), 'invalid_qualification_channel');
  const targets = [{ key: 'hosted', labels: ['ubuntu-latest'] }, { key: 'self-hosted', labels }];
  const tasks = targets.flatMap(target => [...qualificationCases, ...(actionRef ? ['published-resume'] : [])].map(scenario => {
    const id = `qual-${runId}-${target.key}-${scenario}-${nonce}`;
    return { id, scenario, target: target.key, labels: target.labels, branch: `qualification/${id}`, marker: `.runner-qualification/${id}.json`,
      workflow: scenario === 'published-resume' ? actionRef === 'v1' ? 'runner-published.yml' : 'runner-prerelease.yml' : 'runner-task.yml' };
  }));
  return { schema_version: 4, repository, run_id: String(runId), source_sha: sourceSha, authorization, action_ref: actionRef, targets, tasks };
}
export async function prepareQualification({ github, context, core, env = process.env }) {
  const githubAPI = async (path, options = {}) => { const { method = 'GET', ...data } = options; return (await github.request(`${method} ${path}`, data)).data; };
  invariant(env.GITHUB_REF === 'refs/heads/main' && context.eventName === 'workflow_dispatch' && `${context.repo.owner}/${context.repo.repo}` === repository && env.GITHUB_RUN_ATTEMPT === '1', 'untrusted_qualification_context');
  const config = await authorizeActors(githubAPI, repository, context.actor, env.TRIGGERING_ACTOR);
  invariant(env.SOURCE_SHA === env.GITHUB_WORKFLOW_SHA && config.revision === env.SOURCE_SHA, 'qualification_requires_current_merged_source');
  invariant(config.settings.auto_continue && config.settings.max_continuations >= 1, 'qualification_requires_enabled_continuation');
  const registry = registryFor({ runId: env.GITHUB_RUN_ID, sourceSha: env.SOURCE_SHA, selfHosted: JSON.parse(env.SELF_HOSTED_LABELS), authorization: env.QUALIFICATION_AUTHORIZATION, actionRef: env.ACTION_REF });
  const root = join(env.RUNNER_TEMP, 'qualification-registry'); await mkdir(root, { mode: 0o700 });
  const path = join(root, 'record.json'); await writeFile(path, JSON.stringify(registry), { mode: 0o600, flag: 'wx' });
  core.info(JSON.stringify({ event: 'runtime.qualification', outcome: 'authorized', source_sha: env.SOURCE_SHA, targets: registry.targets }));
  return { path, targets: registry.targets };
}
async function runs(transport, workflow) { return pages(transport, `/repos/${repository}/actions/workflows/${workflow}/runs?event=workflow_dispatch`, 'workflow_runs'); }
async function waitRun(transport, id) {
  const deadline = Date.now() + 1800000;
  for (;;) {
    const run = await transport(`/repos/${repository}/actions/runs/${id}`);
    if (run.status === 'completed') return run;
    invariant(Date.now() < deadline, 'qualification_run_timeout'); await sleep(10000);
  }
}
async function dispatch(transport, task, inputs, title) {
  await transport(`/repos/${repository}/actions/workflows/${task.workflow}/dispatches`, { method: 'POST', ref: 'main', inputs });
  const deadline = Date.now() + 300000;
  for (;;) {
    const matches = (await runs(transport, task.workflow)).filter(run => run.display_title === title);
    invariant(matches.length <= 1, 'qualification_duplicate_dispatch');
    if (matches.length) return matches[0].id;
    invariant(Date.now() < deadline, 'qualification_dispatch_unavailable'); await sleep(10000);
  }
}
async function snapshot(transport, id, root) { return loadRunCheckpoint(transport, repository, String(id), join(root, `snapshot-${id}-${randomBytes(4).toString('hex')}`)); }
export async function verifyPublication(transport, registry, task, phase) {
  const file = await transport(`/repos/${repository}/contents/${task.marker}?ref=${encodeURIComponent(task.branch)}`);
  invariant(file.encoding === 'base64', 'qualification_marker_missing');
  const marker = JSON.parse(Buffer.from(file.content, 'base64').toString('utf8'));
  const scenario = task.scenario === 'published-resume' ? 'cold-resume' : task.scenario;
  invariant(marker.task_id === task.id && String(marker.qualification_run_id) === registry.run_id && marker.scenario === scenario && marker.phase === phase &&
    /^https:\/\/github\.com\/markhuangai\/agent-remote-dev-codex\/pull\/[1-9][0-9]*$/.test(marker.pr_url), 'qualification_marker_identity_mismatch');
  const pull = await transport(`/repos/${repository}/pulls/${marker.pr_url.split('/').at(-1)}`);
  invariant(pull.head?.ref === task.branch && pull.head.repo?.full_name === repository && pull.draft && !pull.merged_at && pull.state === 'open' &&
    pull.body?.includes(`qualification:${registry.run_id}:${task.id}`), 'qualification_pull_identity_mismatch');
  return marker;
}
async function resultFor(transport, runId, root) {
  const run = await transport(`/repos/${repository}/actions/runs/${runId}`);
  const artifacts = await pages(transport, `/repos/${repository}/actions/runs/${runId}/artifacts`, 'artifacts');
  const matches = artifacts.filter(artifact => artifact.name === `codex-result-r${runId}-a${run.run_attempt}`);
  invariant(matches.length === 1 && matches[0].workflow_run?.id === runId, 'qualification_result_missing');
  const loaded = await readArtifact({ api: transport, repository, id: matches[0].id, root, kind: 'record' });
  invariant(loaded.value.native_outcome === 'completed', 'qualification_native_failed');
  return JSON.parse(loaded.value.response);
}
export function verifyRejectedPush(response, manifest, remote) {
  invariant(response.push_rejected === true && response.cause === 'non-fast-forward' && shaPattern.test(response.local_sha) && shaPattern.test(response.remote_sha) &&
    response.local_sha !== response.remote_sha && remote.object?.sha === response.remote_sha && manifest.omitted_work && manifest.checkpoint_sha !== response.local_sha,
    'qualification_rejected_push_unproven');
}
export async function runTarget(transport, registry, targetKey, root, output) {
  const proof = { schema_version: 4, repository, source_sha: registry.source_sha, run_id: registry.run_id, target: targetKey, passed: false, cases: [] };
  await writeFile(output, JSON.stringify(proof), { mode: 0o600 });
  try {
    const instructions = await readFile(new URL('../../tests/fixtures/qualification.md', import.meta.url), 'utf8');
    for (const task of registry.tasks.filter(task => task.target === targetKey)) {
      const scenario = task.scenario === 'published-resume' ? 'cold-resume' : task.scenario;
      const prompt = `${instructions}\n\nDirect authorization: ${registry.authorization}\n\nQualification context:\n${JSON.stringify({ ...task, task_id: task.id, scenario, qualification_run_id: registry.run_id })}`;
      const inputs = { plan: prompt, 'qualification-id': task.id, 'runs-on': JSON.stringify(task.labels), 'timeout-minutes': 8 };
      const first = await dispatch(transport, task, inputs, `Codex qualification ${task.id}`); let last = first;
      if (scenario === 'cancellation') {
        const deadline = Date.now() + 360000;
        for (;;) {
          let ready = false;
          try {
            await verifyPublication(transport, registry, task, 1);
            const saved = await snapshot(transport, first, root);
            const remote = await transport(`/repos/${repository}/git/ref/heads/${task.branch}`);
            ready = saved.manifest.branch === task.branch && saved.manifest.checkpoint_sha === remote.object?.sha;
          } catch (error) {
            if (error.status !== 404 && !['run_checkpoint_unavailable', 'qualification_marker_identity_mismatch'].includes(error.reason)) throw error;
          }
          if (ready) break;
          invariant(Date.now() < deadline, 'qualification_cancellation_setup_missing'); await sleep(10000);
        }
        await transport(`/repos/${repository}/actions/runs/${first}/cancel`, { method: 'POST' });
      }
      const initialRun = await waitRun(transport, first);
      const initial = await snapshot(transport, first, root);
      invariant(initial.manifest.provider_sha === registry.source_sha, 'qualification_provider_mismatch');
      if (scenario === 'cold-resume') {
        await verifyPublication(transport, registry, task, 1);
        last = await dispatch(transport, task, { ...inputs, plan: 'Continue the saved qualification task: publish phase 2 and finish.', 'resume-run-id': String(first) }, `Codex resume ${first}`);
        invariant((await waitRun(transport, last)).conclusion === 'success', 'qualification_resume_failed');
      } else if (scenario === 'deadline') {
        const deadline = Date.now() + 300000;
        for (;;) {
          const children = (await runs(transport, task.workflow)).filter(run => run.display_title === `Codex resume ${first}`);
          invariant(children.length <= 1, 'qualification_duplicate_child');
          if (children.length) { last = children[0].id; break; }
          invariant(Date.now() < deadline, 'qualification_child_missing'); await sleep(10000);
        }
        invariant((await waitRun(transport, last)).conclusion === 'success', 'qualification_continuation_failed');
      } else if (scenario === 'cancellation') {
        invariant(initialRun.conclusion === 'cancelled', 'qualification_cancellation_failed');
        const observationEnd = Date.now() + 300000;
        do {
          invariant(!(await runs(transport, task.workflow)).some(run => run.display_title === `Codex resume ${first}`), 'qualification_cancelled_task_restarted');
          await sleep(Math.min(30000, observationEnd - Date.now()));
        } while (Date.now() < observationEnd);
      } else invariant(initialRun.conclusion === 'success', 'qualification_native_failed');
      const final = last === first ? initial : await snapshot(transport, last, root);
      invariant(final.manifest.session_id === initial.manifest.session_id && final.manifest.branch === task.branch, 'qualification_resume_identity_mismatch');
      await verifyPublication(transport, registry, task, ['cold-resume', 'deadline'].includes(scenario) ? 2 : 1);
      invariant(final.manifest.provider_sha === registry.source_sha, 'qualification_provider_mismatch');
      if (scenario !== 'cancellation') {
        const response = await resultFor(transport, last, join(root, `result-${last}`));
        invariant(response.task_id === task.id && response.scenario === scenario && response.branch === task.branch, 'qualification_response_mismatch');
        if (scenario === 'failed-push') verifyRejectedPush(response, final.manifest, await transport(`/repos/${repository}/git/ref/heads/${task.branch}`));
      }
      if (scenario === 'cold-resume' || scenario === 'deadline') invariant(last !== first, 'qualification_resume_missing');
      proof.cases.push({ scenario: task.scenario, task_id: task.id, run_ids: first === last ? [first] : [first, last],
        session_id: final.manifest.session_id, artifact_id: final.artifact.id, passed: true });
      await writeFile(output, JSON.stringify(proof));
    }
    proof.passed = true; return proof;
  } finally { await writeFile(output, JSON.stringify(proof), { mode: 0o600 }); }
}
export async function cleanupRegistry(transport, registry, root, output) {
  const receipt = { schema_version: 4, repository, run_id: registry.run_id, verified: false, tasks: [] };
  try {
    for (const task of registry.tasks) {
      invariant(task.id.startsWith(`qual-${registry.run_id}-`) && /^[a-z0-9-]+$/.test(task.id) && task.branch === `qualification/${task.id}` && task.marker === `.runner-qualification/${task.id}.json`, 'unsafe_qualification_cleanup');
      const ownedRuns = (await runs(transport, task.workflow)).filter(run => run.display_title === `Codex qualification ${task.id}`);
      const pending = [...ownedRuns];
      for (const run of pending) pending.push(...(await runs(transport, task.workflow)).filter(child => child.display_title === `Codex resume ${run.id}` && !pending.some(item => item.id === child.id)));
      for (const run of pending) if (run.status !== 'completed') { await transport(`/repos/${repository}/actions/runs/${run.id}/cancel`, { method: 'POST' }); await waitRun(transport, run.id); }
      const pulls = await pages(transport, `/repos/${repository}/pulls?state=all&head=markhuangai:${encodeURIComponent(task.branch)}`, null);
      for (const pull of pulls) {
        invariant(!pull.merged_at && pull.head?.ref === task.branch && pull.head.repo?.full_name === repository && pull.body?.includes(`qualification:${registry.run_id}:${task.id}`), 'qualification_cleanup_pull_not_owned');
        if (pull.state !== 'closed') await transport(`/repos/${repository}/pulls/${pull.number}`, { method: 'PATCH', state: 'closed' });
        invariant((await transport(`/repos/${repository}/pulls/${pull.number}`)).state === 'closed', 'qualification_cleanup_pull_unverified');
      }
      let marker;
      try { marker = await transport(`/repos/${repository}/contents/${task.marker}?ref=${encodeURIComponent(task.branch)}`); }
      catch (error) { if (error.status !== 404) throw error; }
      if (marker) {
        const value = JSON.parse(Buffer.from(marker.content, 'base64').toString());
        invariant(value.task_id === task.id && String(value.qualification_run_id) === registry.run_id, 'qualification_cleanup_marker_mismatch');
        await transport(`/repos/${repository}/git/refs/heads/${task.branch}`, { method: 'DELETE' });
      }
      receipt.tasks.push({ task_id: task.id, run_ids: pending.map(run => run.id), verified: true });
    }
    receipt.verified = true;
  } finally { await writeFile(output, JSON.stringify(receipt), { mode: 0o600 }); }
  return receipt;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const registry = JSON.parse(await readFile(process.env.QUALIFICATION_REGISTRY, 'utf8'));
    const root = join(process.env.RUNNER_TEMP, `qualification-${process.env.GITHUB_JOB}`); await mkdir(root, { mode: 0o700 });
    if (process.argv[2] === 'cleanup') await cleanupRegistry(api, registry, root, process.env.QUALIFICATION_OUTPUT);
    else await runTarget(api, registry, process.env.QUALIFICATION_TARGET, root, process.env.QUALIFICATION_OUTPUT);
  } catch (error) { logEvent(sink, 'runtime.qualification', 'ERROR', { ...safeError(error), outcome: 'blocked' }); process.exitCode = 1; }
}
