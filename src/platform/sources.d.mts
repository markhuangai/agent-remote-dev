export function resolveSource(api: (path: string, options?: any) => Promise<any>, repository: string, ref: string): Promise<any>;
export function resolveSkills(api: (path: string, options?: any) => Promise<any>, selected: any[]): Promise<any[]>;
export function pages(api: (path: string, options?: any) => Promise<any>, path: string, key: string | null): Promise<any[]>;
