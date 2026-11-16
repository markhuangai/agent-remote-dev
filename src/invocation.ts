import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { digest, registrationKey } from './platform/checkpoint-policy.mjs';
import { authorizeActors, resolveTaskRequest } from './platform/continuation-policy.mjs';
import { freezeProjectConfig } from './platform/project-config.mjs';
import { resolveSource } from './platform/sources.mjs';
import { safeError } from './platform/runtime-log.mjs';
import { requireValue, RunnerError } from './contracts.js';

export const actionResources = ['action.yml', 'package.json', 'package-lock.json', 'dist/index.js', 'dist/package.json', 'dist/supervise.py', 'dist/archive.py', 'dist/yaml.cjs', 'dist/yaml-licenses.txt',
  'dist/control.mjs', 'dist/control-licenses.txt', 'dist/client.mjs', 'dist/protocol.json'];
export async function invocationSource(api: (path: string, options?: any) => Promise<any>, root: string, env: NodeJS.ProcessEnv,
  git: (args: string[]) => Promise<string>) {
  let repository = env.GITHUB_ACTION_REPOSITORY, ref = env.GITHUB_ACTION_REF;
  const kind = repository || ref ? 'published' : 'checkout';
  if (kind === 'checkout') {
    requireValue((await git(['rev-parse', '--show-toplevel'])).trim() === root, 'unknown_action_source');
    const origin = (await git(['remote', 'get-url', 'origin'])).trim();
    repository = /^(?:https:\/\/github\.com\/|git@github\.com:)([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(origin)?.[1];
    ref = (await git(['rev-parse', 'HEAD'])).trim();
  }
  requireValue(repository && ref, 'unknown_action_source');
  const source = await resolveSource(api, repository, ref);
  const tree = await api(`/repos/${source.repository}/git/trees/${source.sha}?recursive=1`);
  requireValue(!tree.truncated && Array.isArray(tree.tree), 'action_source_inventory_unavailable');
  for (const path of actionResources) {
    let bytes;
    try { bytes = await readFile(join(root, path)); }
    catch { throw new RunnerError('action_source_resource_missing', 'action_source', 'Installed action is incomplete.', { resource_path: path, source_sha: source.sha }); }
    const observed = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    const entry = tree.tree.find((item: any) => item.path === path);
    if (entry?.type !== 'blob' || entry.sha !== observed) throw new RunnerError('action_source_resource_mismatch', 'action_source', 'Installed action differs from its resolved source.',
      { resource_path: path, source_sha: source.sha, expected: entry?.sha ?? null, observed });
  }
  return { ...source, kind };
}
export async function prepareInvocation({ api, plan, source, core, env = process.env }: {
  api: (path: string, options?: any) => Promise<any>; plan: string; source: any; core: any; env?: NodeJS.ProcessEnv;
}) {
  const repository = env.GITHUB_REPOSITORY ?? '', [owner, repo] = repository.split('/');
  const actor = env.GITHUB_ACTOR ?? '', triggering = env.TRIGGERING_ACTOR || env.GITHUB_TRIGGERING_ACTOR || actor;
  requireValue(env.GITHUB_EVENT_NAME === 'workflow_dispatch' && env.GITHUB_REF === 'refs/heads/main', 'untrusted_task_context');
  let request: any;
  if (env.CODEX_TASK_REQUEST) {
    requireValue(Buffer.byteLength(env.CODEX_TASK_REQUEST) <= 65535, 'workflow_input_size_limit');
    try { request = JSON.parse(env.CODEX_TASK_REQUEST); }
    catch { throw new RunnerError('invalid_task_request', 'preflight', 'Task envelope could not be decoded; contents withheld.'); }
    if (!request?.resume_artifact_id) requireValue(request?.plan === plan, 'plan_hash_mismatch');
  } else if (env.GITHUB_EVENT_PATH && ['runner-task.yml', 'runner-published.yml'].some(name => env.GITHUB_WORKFLOW_REF === `${repository}/.github/workflows/${name}@refs/heads/main`)) {
    try {
      const event = JSON.parse(await readFile(env.GITHUB_EVENT_PATH, 'utf8'));
      if (event.inputs?.request) request = JSON.parse(event.inputs.request);
    } catch { throw new RunnerError('invalid_task_request', 'preflight', 'Task envelope could not be decoded; contents withheld.'); }
  }
  if (!request) {
    try {
      await authorizeActors(api, repository, actor, triggering);
      requireValue(typeof plan === 'string' && plan.trim() && Buffer.byteLength(plan) <= 1024 * 1024, 'invalid_plan');
      const settings = await freezeProjectConfig(api, repository, env.GITHUB_WORKFLOW_SHA ?? '');
      request = { request_id: env.GITHUB_RUN_ID, source_repository: source.repository, source_sha: source.sha, plan, plan_sha256: digest(plan), ...settings };
      request.registration_key = registrationKey(request);
    } catch (error: any) {
      throw new RunnerError(error.reason ?? 'project_setup_failed', 'preflight', 'Repository configuration or actor validation failed.',
        { ...safeError(error), ...error.details, task_id: env.GITHUB_RUN_ID });
    }
  }
  requireValue(request.source_repository === source.repository && request.source_sha === source.sha, 'action_source_mismatch');
  if (request.published_ref) requireValue(source.kind === 'published' && source.requested_ref === request.published_ref && source.release_tag && source.release_id, 'published_invocation_required');
  const verified = await resolveTaskRequest({ github: { request: async (route: string, options?: any) => ({ data: await api(route.replace(/^[A-Z]+ /, ''), options) }) },
    context: { repo: { owner, repo }, actor, eventName: env.GITHUB_EVENT_NAME }, core,
    env: { ...env, CODEX_RUNNER_PROTOCOL: '3', TRIGGERING_ACTOR: triggering, TASK_REQUEST: JSON.stringify(request) } });
  requireValue(verified.operation === 'execute', 'invalid_execution_request');
  return { taskId: verified.task_id, plan: verified.plan, resumeArtifactId: verified.resume_artifact_id,
    authorization: verified.authorization, skills: verified.skills, execution: verified.execution };
}
