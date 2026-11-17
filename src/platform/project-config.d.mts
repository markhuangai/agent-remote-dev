export const configPath: string;
export function parseProjectConfig(text: string): any;
export function readProjectConfig(api: any, repository: string, revision: string, expected?: string): Promise<any>;
export function currentProjectConfig(api: any, repository: string): Promise<any>;
export function authorizeActors(api: any, repository: string, actor: string, triggeringActor?: string): Promise<any>;
