export function authorizeActors(api: (path: string, options?: any) => Promise<any>, repository: string, actor: string, triggeringActor: string): Promise<string>;
export function authorizeActivation(api: (path: string, options?: any) => Promise<any>, repository: string, execution: any): Promise<string>;
export function requireActive(api: (path: string, options?: any) => Promise<any>, repository: string, taskId: string, activationRunId: string, requestId?: string): Promise<void>;
export function prepareTaskRequest(args: any): Promise<any>;
