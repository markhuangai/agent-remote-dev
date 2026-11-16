export function verifyProtocol(api: (path: string) => Promise<any>, repository: string, enabled?: boolean): Promise<null | {revision: string; protocol_version: number}>;
