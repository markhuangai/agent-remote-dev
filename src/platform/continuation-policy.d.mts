import type { Authorization, SkillSource } from '../contracts.js';
import type { Execution } from '../continuation.js';

export type TaskRequestArgs = {
  github: { request(route: string, options?: any): Promise<{ data: any }> };
  context: { repo: { owner: string; repo: string }; actor: string; eventName?: string };
  core: any;
  env?: NodeJS.ProcessEnv;
};
export type ExecutionRequest = {
  operation: 'execute'; task_id: string; source_repository: string; source_sha: string; resume_artifact_id: number | string;
  published_ref: string; authorization: Authorization; plan: string; skills: SkillSource[]; execution: Execution; runner: string[];
  git_author_name: string; git_author_email: string; user_agents_url: string; user_agents_sha256: string;
};
export type StopRequest = { operation: 'stop'; task_id: string; stop_key: string };
export function resolveTaskRequest(args: TaskRequestArgs): Promise<ExecutionRequest | StopRequest>;
export function authorizeActors(api: (path: string, options?: any) => Promise<any>, repository: string, actor: string, triggeringActor: string): Promise<string>;
export function authorizeActivation(api: (path: string, options?: any) => Promise<any>, repository: string, execution: any): Promise<string>;
export function requireActive(api: (path: string, options?: any) => Promise<any>, repository: string, taskId: string, activationRunId: string, requestId?: string): Promise<void>;
export function prepareTaskRequest(args: TaskRequestArgs): Promise<StopRequest |
  (Omit<ExecutionRequest, 'authorization' | 'skills' | 'execution' | 'runner'> & { authorization: string; skills: string; execution: string; runner: string })>;
