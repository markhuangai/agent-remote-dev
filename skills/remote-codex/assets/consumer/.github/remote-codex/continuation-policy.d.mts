export function authorizeActors(api: (path: string, options?: any) => Promise<any>, repository: string, actor: string, triggeringActor: string): Promise<string>;
export function requireActive(api: (path: string, options?: any) => Promise<any>, repository: string, taskId: string, activationRunId: string): Promise<void>;
export function verifyIssuePlan(api: (path: string, options?: any) => Promise<any>, repository: string, url: string): Promise<string>;
export function prepareTaskRequest(args: any): Promise<any>;
