export const configPath: string;
export function parseProjectConfig(text: string): any;
export function readProjectConfig(api: (path: string, options?: any) => Promise<any>, repository: string, revision: string, expected?: string): Promise<any>;
export function freezeProjectConfig(api: (path: string, options?: any) => Promise<any>, repository: string, revision: string): Promise<any>;
