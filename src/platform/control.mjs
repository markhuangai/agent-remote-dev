import * as core from '@actions/core';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { digest, invariant, registrationKey, repositoryPattern, shaPattern } from './checkpoint-policy.mjs';
import { authorizeActors, cancelTaskRuns, prepareTaskRequest, requestForRun, runController, stopTask } from './continuation-policy.mjs';
import { freezeProjectConfig } from './project-config.mjs';
import { githubAPI } from './submission.mjs';
import { logEvent, safeError } from './runtime-log.mjs';

export async function workflowCommand(mode, { api = githubAPI, env = process.env, sink = core } = {}) {
  const repository = env.GITHUB_REPOSITORY ?? '', [owner, repo] = repository.split('/');
  invariant(repositoryPattern.test(repository), 'invalid_repository');
  const payload = JSON.parse(await readFile(env.GITHUB_EVENT_PATH, 'utf8'));
  const context = { repo: { owner, repo }, actor: env.GITHUB_ACTOR, eventName: env.GITHUB_EVENT_NAME, payload };
  const github = { request: async (route, options) => ({ data: await api(route.replace(/^[A-Z]+ /, ''), options) }) };
  const input = { github, context, core: sink, env };
  if (mode === 'controller') return runController(input);
  if (mode === 'cancel') return cancelTaskRuns({ ...input, taskId: env.TASK_ID });
  if (mode === 'stop') return stopTask(input);
  invariant(['authorize', 'prepare', 'task'].includes(mode), 'invalid_workflow_command');
  invariant(env.GITHUB_EVENT_NAME === 'workflow_dispatch' && env.GITHUB_REF === 'refs/heads/main', 'untrusted_task_context');
  invariant(env.PROVIDER_REPOSITORY === 'markhuangai/agent-remote-dev-codex' && shaPattern.test(env.PROVIDER_SHA), 'unknown_action_source');
  if (mode === 'authorize' && !env.TASK_REQUEST) {
    await authorizeActors(api, repository, context.actor, env.TRIGGERING_ACTOR);
    return { operation: 'execute' };
  }
  let request = env.TASK_REQUEST;
  if (!request && env.TASK_RESUME_RUN_ID) {
    await authorizeActors(api, repository, context.actor, env.TRIGGERING_ACTOR);
    request = JSON.stringify(await requestForRun(api, repository, env.TASK_RESUME_RUN_ID, join(env.RUNNER_TEMP, `resume-request-${mode}`), `${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}`));
  }
  if (!request) {
    invariant(mode === 'prepare' && repositoryPattern.test(env.PROVIDER_REPOSITORY) && shaPattern.test(env.PROVIDER_SHA), 'unknown_action_source');
    await authorizeActors(api, repository, context.actor, env.TRIGGERING_ACTOR);
    invariant(typeof env.TASK_PLAN === 'string' && env.TASK_PLAN.trim() && Buffer.byteLength(env.TASK_PLAN) <= 65535, 'invalid_plan');
    const settings = await freezeProjectConfig(api, repository, env.GITHUB_WORKFLOW_SHA);
    const prepared = { request_id: env.GITHUB_RUN_ID, source_repository: env.PROVIDER_REPOSITORY, source_sha: env.PROVIDER_SHA,
      plan: env.TASK_PLAN, plan_sha256: digest(env.TASK_PLAN), ...settings };
    request = JSON.stringify({ ...prepared, registration_key: registrationKey(prepared) });
  }
  const result = await prepareTaskRequest({ ...input, env: { ...env, RUNNER_TEMP: join(env.RUNNER_TEMP, `workflow-${mode}`), TASK_REQUEST: request } });
  if (result.operation === 'execute') {
    invariant(result.source_repository === env.PROVIDER_REPOSITORY, 'provider_runtime_repository_mismatch', env.PROVIDER_REPOSITORY, result.source_repository);
    if (!result.resume_artifact_id) invariant(result.source_sha === env.PROVIDER_SHA, 'provider_runtime_revision_mismatch');
  }
  return { ...result, request };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = await workflowCommand(process.argv[2]);
    if (result) for (const [name, value] of Object.entries(result)) core.setOutput(name, typeof value === 'object' ? JSON.stringify(value) : value);
  } catch (error) {
    logEvent(core, 'submission.workflow', 'ERROR', { ...safeError(error), ...error.details, outcome: 'blocked' });
    core.setFailed('Provider workflow failed; inspect structured infrastructure diagnostics.');
  }
}
