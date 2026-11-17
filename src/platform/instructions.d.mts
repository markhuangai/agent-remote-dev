export function fetchInstructions(url: string, expected?: string, fetcher?: typeof fetch): Promise<{url: string; sha256: string; content: string}>;
