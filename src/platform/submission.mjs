import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, lstat, rmdir, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { authorization, digest, executionSettings, invariant, positiveId, registrationKey, repositoryPattern, runnerLabels, shaPattern, sources, taskPattern } from './checkpoint-policy.mjs';
import { authorizeActors, loadVerifiedCheckpoint, manualRunName, pages, submissionRunName } from './continuation-policy.mjs';
import { verifyProtocol } from './protocol-policy.mjs';
import { fetchInstructions } from './instructions.mjs';
import { readArtifact } from './artifact-io.mjs';
import { logEvent, safeError } from './runtime-log.mjs';
import { freezeProjectConfig, readProjectConfig } from './project-config.mjs';
import { resolveSource, resolveSkills } from './sources.mjs';
export { resolveSource, resolveSkills } from './sources.mjs';

const sink = Object.fromEntries(['info', 'warning', 'error', 'debug'].map(level => [level, line => { if (level !== 'debug') process.stderr.write(line + '\n'); }]));
export const log = (event, level, fields) => logEvent(sink, event, level, fields);
export function githubAPI(path, options = {}) {
  return new Promise((resolve, reject) => {
    const args = ['api', path.replace(/^\//, ''), '--method', options.method ?? 'GET'];
    const { method, ...body } = options;
    if (Object.keys(body).length) args.push('--input', '-');
    const child = spawn('gh', args, { stdio: ['pipe', 'pipe', 'pipe'], signal: AbortSignal.timeout(30000) });
    const chunks = []; let bytes = 0, stderr = '', stdinError;
    child.stdout.on('data', chunk => { bytes += chunk.length; if (bytes <= 256 * 1024 * 1024) chunks.push(chunk); else child.kill('SIGTERM'); });
    child.stderr.on('data', chunk => { if (stderr.length < 65536) stderr += chunk.toString().slice(0, 65536 - stderr.length); });
    child.on('error', error => reject(Object.assign(new Error(error.code === 'ABORT_ERR' ? 'github_api_timeout' : 'github_cli_unavailable'), { reason: error.code === 'ABORT_ERR' ? 'github_api_timeout' : 'github_cli_unavailable', code: error.code })));
    child.on('close', code => {
      if (code !== 0 || stdinError || bytes > 256 * 1024 * 1024) { reject(Object.assign(new Error('github_api_failed'), { reason: 'github_api_failed', status: Number(/HTTP (\d{3})/.exec(stderr)?.[1]) || undefined })); return; }
      const data = Buffer.concat(chunks);
      if (path.endsWith('/zip')) { resolve(data); return; }
      try { resolve(data.length ? JSON.parse(data.toString('utf8')) : null); }
      catch { reject(Object.assign(new Error('invalid_github_response'), { reason: 'invalid_github_response' })); }
    });
    child.stdin.on('error', error => { stdinError = error; });
    child.stdin.end(Object.keys(body).length ? JSON.stringify(body) : undefined);
  });
}
export async function removeTemporary(path) {
  const stat = await lstat(path);
  if (stat.isDirectory() && !stat.isSymbolicLink()) { for (const name of await readdir(path)) await removeTemporary(join(path, name)); await rmdir(path); }
  else await unlink(path);
}
export async function prepareQueue(api, options) {
  const repository = options.repo;
  invariant(repositoryPattern.test(repository), 'invalid_repository');
  const actor = (await api('/user')).login;
  const revision = await authorizeActors(api, repository, actor, actor);
  const protocol = await verifyProtocol(api, repository);
  const action = protocol.provider ?? await resolveSource(api, options.source_repository ?? 'markhuangai/agent-remote-dev-codex', options.source_ref ?? 'v1');
  if (protocol.provider && (options.source_repository || options.source_ref)) {
    const requested = await resolveSource(api, options.source_repository ?? action.repository, options.source_ref ?? action.sha);
    invariant(requested.repository === action.repository && requested.sha === action.sha, 'provider_runtime_source_changed');
  }
  const plan = options.plan;
  invariant(typeof plan === 'string' && plan.trim() && Buffer.byteLength(plan) <= 1024 * 1024, 'invalid_plan');
  const settings = await freezeProjectConfig(api, repository, revision);
  const request = { request_id: options.request_id ?? randomUUID(), source_repository: action.repository, source_sha: action.sha,
    plan, plan_sha256: digest(plan), ...settings };
  invariant(taskPattern.test(request.request_id), 'invalid_request_identity');
  invariant(Buffer.byteLength(JSON.stringify({ ...request, registration_key: registrationKey(request) })) <= 65535, 'workflow_input_size_limit');
  log('submission.prepare', 'INFO', { repository, request_id: request.request_id, plan_sha256: request.plan_sha256, action, skills: request.skills, runner: request.runner,
    project_config_sha256: request.project_config.sha256, user_agents_sha256: request.user_agents_sha256, actor, outcome: 'frozen' });
  return { protocol_version: 3, repository, actor, action, request, request_sha256: digest(JSON.stringify(request)) };
}
export async function dispatchOnce(api, repository, request, actor, { now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  invariant(!request.dispatch_key, 'automatic_dispatch_requires_claim');
  invariant(!request.published_ref || ['v1-prerelease', 'v1'].includes(request.published_ref) && request.operation !== 'stop', 'invalid_published_reference');
  const workflow = request.published_ref ? 'runner-published.yml' : 'runner-task.yml';
  if (request.resume_artifact_id) invariant(typeof request.activation_key === 'string' && /^[a-f0-9]{32}$/.test(request.activation_key), 'invalid_resume_activation');
  const key = registrationKey(request), payload = { ...request, registration_key: key };
  invariant(!request.registration_key || request.registration_key === key, 'request_registration_mismatch');
  invariant(Buffer.byteLength(JSON.stringify(payload)) <= 65535, 'workflow_input_size_limit');
  const title = request.operation === 'stop' ? `Codex stop ${request.task_id} / ${request.stop_key}` : request.resume_artifact_id ? manualRunName(request.task_id, request.resume_artifact_id, request.source_sha, key) : submissionRunName(request.request_id, key);
  const find = async () => {
    const runs = await pages(api, `/repos/${repository}/actions/runs?event=workflow_dispatch&branch=main`, 'workflow_runs');
    const matches = runs.filter(run => run.display_title === title);
    invariant(matches.length <= 1, 'ambiguous_task_registration');
    if (!matches.length && !request.resume_artifact_id && request.operation !== 'stop') {
      const collision = runs.find(run => run.display_title?.startsWith(`Codex request ${request.request_id} / `));
      invariant(!collision, 'task_registration_request_mismatch', key, /\/ request-([a-f0-9]{64})$/.exec(collision?.display_title ?? '')?.[1] ?? null);
    }
    if (matches.length) invariant(matches[0].actor?.login === actor && matches[0].path === `.github/workflows/${workflow}` && matches[0].head_branch === 'main' && matches[0].repository?.full_name === repository, 'task_registration_identity_mismatch');
    return matches[0];
  };
  let run = await find(), apiError = null;
  if (!run) {
    log('submission.dispatch', 'INFO', { repository, request_id: request.request_id ?? null, task_id: request.task_id ?? null, workflow, published_ref: request.published_ref ?? null, ref: 'main', actor, request_sha256: key, activation_key: request.activation_key ?? null, outcome: 'requesting' });
    try { await api(`/repos/${repository}/actions/workflows/${workflow}/dispatches`, { method: 'POST', ref: 'main', inputs: { request: JSON.stringify(payload) } }); }
    catch (error) { apiError = safeError(error); }
  }
  const deadline = now() + 300000;
  while (!run && now() < deadline) { await sleep(Math.min(10000, deadline - now())); run = await find(); }
  invariant(run, 'ambiguous_dispatch_registration');
  const receipt = { repository, task_id: request.task_id ?? String(run.id), root_run_id: request.task_id ?? String(run.id), request_id: request.request_id ?? null, actor, run_id: run.id, run_url: run.html_url, workflow, ref: 'main', workflow_sha: run.head_sha,
    source_repository: request.source_repository ?? null, source_sha: request.source_sha ?? null, plan_sha256: request.plan_sha256 ?? null, request_sha256: key, activation_key: request.activation_key ?? null };
  log('submission.dispatch', 'INFO', { ...receipt, api_error: apiError, outcome: 'registered' });
  return receipt;
}
export async function queuePrepared(api, prepared, timing) {
  invariant(prepared.protocol_version === 3 && repositoryPattern.test(prepared.repository) && prepared.request_sha256 === digest(JSON.stringify(prepared.request)), 'prepared_request_changed');
  const actor = (await api('/user')).login;
  invariant(actor === prepared.actor, 'authenticated_actor_changed');
  const revision = await authorizeActors(api, prepared.repository, actor, actor);
  const protocol = await verifyProtocol(api, prepared.repository);
  if (protocol.provider) invariant(protocol.provider.repository === prepared.request.source_repository && protocol.provider.sha === prepared.request.source_sha,
    'provider_runtime_source_changed', prepared.request.source_sha, protocol.provider.sha);
  await readProjectConfig(api, prepared.repository, revision, prepared.request.project_config?.sha256);
  invariant(typeof prepared.request.plan === 'string' && digest(prepared.request.plan) === prepared.request.plan_sha256, 'plan_hash_mismatch');
  sources(prepared.request.skills); runnerLabels(prepared.request.runner);
  invariant((await api(`/repos/${prepared.request.source_repository}/commits/${prepared.request.source_sha}`)).sha === prepared.request.source_sha, 'action_source_mismatch');
  if (prepared.request.user_agents_url) await fetchInstructions(prepared.request.user_agents_url, prepared.request.user_agents_sha256);
  return { ...await dispatchOnce(api, prepared.repository, prepared.request, actor, timing), action: prepared.action };
}
export async function inspectTask(api, repository, taskId, root, showResult = false) {
  invariant(repositoryPattern.test(repository) && taskPattern.test(taskId), 'invalid_task_identity');
  const runs = await pages(api, `/repos/${repository}/actions/runs?event=workflow_dispatch&branch=main`, 'workflow_runs');
  const taskRuns = runs.filter(run => String(run.id) === taskId || run.display_title?.startsWith(`Codex task ${taskId} / `) || run.display_title?.startsWith(`Codex request ${taskId} / `));
  const summaries = [];
  for (const run of taskRuns) {
    const artifacts = await pages(api, `/repos/${repository}/actions/runs/${run.id}/artifacts`, 'artifacts');
    const summary = { run_id: run.id, attempt: run.run_attempt, run_url: run.html_url, status: run.status, conclusion: run.conclusion, workflow_sha: run.head_sha,
      artifacts: artifacts.map(artifact => ({ id: artifact.id, name: artifact.name, expired: artifact.expired })) };
    for (const kind of ['run', 'outcome', ...(showResult ? ['result'] : [])]) {
      const matches = artifacts.filter(artifact => artifact.name === `codex-${kind}-${taskId}-r${run.id}-a${run.run_attempt}`);
      invariant(matches.length <= 1, 'ambiguous_run_record');
      if (!matches.length || matches[0].expired) continue;
      const loaded = await readArtifact({ api, repository, id: matches[0].id, root: join(root, `${run.id}-${kind}`) }), value = loaded.value;
      invariant(value.schema_version === 3 && value.repository === repository && value.task_id === taskId && String(value.lineage?.run_id) === String(run.id) &&
        Number(value.lineage?.run_attempt) === Number(run.run_attempt) && value.lineage?.workflow_sha === run.head_sha && loaded.artifact.workflow_run?.id === run.id, 'run_record_identity_mismatch');
      if (kind === 'run') Object.assign(summary, { plan_sha256: value.plan_sha256, source_repository: value.execution.source_repository, source_sha: value.execution.source_sha, parent_run_id: value.execution.parent_run_id,
        root_run_id: value.execution.root_run_id, continuation_count: value.execution.continuation_count, runner: value.execution.runner, invocation: value.invocation, execution: value.execution });
      else if (kind === 'outcome') Object.assign(summary, { infrastructure_status: value.status, native_outcome: value.native_outcome, reason: value.reason, checkpoint: value.checkpoint });
      else summary.native_response = value.response;
    }
    summaries.push(summary);
  }
  const all = await pages(api, `/repos/${repository}/actions/runs?event=workflow_run&branch=main`, 'workflow_runs');
  const parents = new Set(taskRuns.map(run => String(run.id)));
  return { repository, task_id: taskId, runs: summaries, controllers: all.filter(run => parents.has(/^Codex continuation \/ ([0-9]+)$/.exec(run.display_title ?? '')?.[1])).map(run => ({ run_id: run.id, run_url: run.html_url, status: run.status, conclusion: run.conclusion })),
    stops: runs.filter(run => run.display_title?.startsWith(`Codex stop ${taskId} / `)).map(run => ({ run_id: run.id, run_url: run.html_url, status: run.status, conclusion: run.conclusion })) };
}
export async function waitForStop(api, repository, taskId, receipt, { now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  const started = now(), deadline = started + 900000;
  for (;;) {
    const control = await api(`/repos/${repository}/actions/runs/${receipt.run_id}`);
    invariant(control.status !== 'completed' || control.conclusion === 'success', 'stop_control_failed');
    const runs = await pages(api, `/repos/${repository}/actions/runs?event=workflow_dispatch&branch=main`, 'workflow_runs');
    const tasks = runs.filter(run => String(run.id) === taskId || run.display_title?.startsWith(`Codex task ${taskId} / `) || run.display_title?.startsWith(`Codex request ${taskId} / `)), parents = new Set(tasks.map(run => String(run.id)));
    const controllers = await pages(api, `/repos/${repository}/actions/runs?event=workflow_run&branch=main`, 'workflow_runs');
    const pending = [...tasks, ...controllers.filter(run => parents.has(/^Codex continuation \/ ([0-9]+)$/.exec(run.display_title ?? '')?.[1]))].filter(run => run.status !== 'completed');
    if (control.status === 'completed' && pending.length === 0) return { ...receipt, infrastructure_status: 'stopped', cancelled_run_ids: tasks.map(run => run.id) };
    invariant(now() < deadline, 'stop_cancellation_timeout');
    log('submission.stop', 'INFO', { task_id: taskId, stop_run_id: receipt.run_id, pending_run_ids: pending.map(run => run.id), elapsed_ms: now() - started, timeout_ms: 900000, outcome: 'waiting_for_cancellation' });
    await sleep(Math.min(10000, deadline - now()));
  }
}
function argumentsFor(argv) {
  const [command, ...args] = argv, options = {};
  for (let index = 0; index < args.length; index++) {
    invariant(args[index].startsWith('--'), 'invalid_argument');
    const key = args[index].slice(2).replaceAll('-', '_');
    if (['dry_run', 'show_result'].includes(key)) options[key] = true;
    else { invariant(index + 1 < args.length && !args[index + 1].startsWith('--'), 'missing_argument_value'); options[key] = args[++index]; }
  }
  const allowed = { queue: ['repo', 'plan', 'plan_file', 'source_repository', 'source_ref', 'request_id', 'prepared', 'dry_run'],
    status: ['repo', 'run_id', 'show_result'], resume: ['repo', 'run_id', 'artifact_id', 'activation_key'], stop: ['repo', 'run_id', 'stop_key'] };
  invariant(allowed[command] && Object.keys(options).every(key => allowed[command].includes(key)), 'unsupported_argument');
  return { command, options };
}
export async function cli(argv, api = githubAPI) {
  if (!argv.length || ['--help', 'help'].includes(argv[0])) { process.stdout.write('remote-codex queue|status|resume|stop --repo OWNER/REPO (see bundled references/usage.md)\n'); return; }
  const { command, options } = argumentsFor(argv), temporary = await mkdtemp(join(tmpdir(), 'remote-codex-'));
  let diagnostic = { repository: repositoryPattern.test(options.repo ?? '') ? options.repo : null, task_id: taskPattern.test(options.run_id ?? '') ? options.run_id : null };
  try {
    let result;
    if (command === 'queue') {
      const prepared = options.prepared ? JSON.parse(await readFile(options.prepared, 'utf8')) : await prepareQueue(api, { ...options,
        plan: options.plan_file ? await readFile(options.plan_file, 'utf8') : options.plan });
      diagnostic = { repository: prepared.repository, task_id: prepared.request?.request_id };
      result = options.dry_run ? prepared : await queuePrepared(api, prepared);
    } else {
      invariant(repositoryPattern.test(options.repo) && positiveId(options.run_id), 'invalid_task_identity');
      if (command === 'status') result = await inspectTask(api, options.repo, options.run_id, temporary, options.show_result);
      else {
        const actor = (await api('/user')).login;
        await authorizeActors(api, options.repo, actor, actor); await verifyProtocol(api, options.repo);
        if (command === 'stop') {
          const receipt = await dispatchOnce(api, options.repo, { operation: 'stop', task_id: options.run_id, stop_key: options.stop_key ?? randomBytes(16).toString('hex') }, actor);
          result = await waitForStop(api, options.repo, options.run_id, receipt);
        }
        else {
          invariant(command === 'resume' && positiveId(options.artifact_id), 'invalid_command_or_artifact');
          const loaded = await loadVerifiedCheckpoint({ api, repository: options.repo, id: Number(options.artifact_id), taskId: options.run_id,
            io: (id, kind) => readArtifact({ api, repository: options.repo, id, root: temporary, kind }) });
          result = await dispatchOnce(api, options.repo, { task_id: options.run_id, source_repository: loaded.manifest.execution.source_repository,
            source_sha: loaded.manifest.execution.source_sha, ...(loaded.manifest.execution.published_ref ? { published_ref: loaded.manifest.execution.published_ref } : {}),
            resume_artifact_id: Number(options.artifact_id), activation_key: options.activation_key ?? randomBytes(16).toString('hex') }, actor);
        }
      }
    }
    process.stdout.write(JSON.stringify(result, null, 2) + '\n'); return result;
  } catch (error) { log('submission.failed', 'ERROR', { ...diagnostic, ...safeError(error), ...error.details, command, outcome: 'blocked' }); throw error; }
  finally { await removeTemporary(temporary); }
}
