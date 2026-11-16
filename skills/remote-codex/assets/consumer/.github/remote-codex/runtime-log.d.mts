export function safeError(error: any): { reason: string; http_status: number | null; request_id: string | null; cause_code: string | null };
export function logEvent(core: any, event: string, level: string, fields: Record<string, unknown>, env?: NodeJS.ProcessEnv): void;
