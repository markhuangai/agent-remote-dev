export function safeError(error) {
  return { reason: /^[a-z][a-z0-9_]{0,79}$/.test(error?.reason ?? '') ? error.reason : 'github_api_failed',
    http_status: Number.isInteger(error?.status) ? error.status : null,
    request_id: /^[a-f0-9:]{1,80}$/i.test(error?.response?.headers?.['x-github-request-id'] ?? '') ? error.response.headers['x-github-request-id'] : null,
    cause_code: ['ETIMEDOUT', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'ABORT_ERR'].includes(error?.cause?.code ?? error?.code) ? error.cause?.code ?? error.code : null };
}
export function logEvent(core, event, level, fields, env = process.env) {
  let truncated = false;
  const record = JSON.parse(JSON.stringify({ schema_version: 1, event, level, repository: env.GITHUB_REPOSITORY, run_id: env.GITHUB_RUN_ID,
    run_attempt: env.GITHUB_RUN_ATTEMPT, workflow_sha: env.GITHUB_WORKFLOW_SHA, retention_days: env.GITHUB_RETENTION_DAYS, ...fields }, (_key, value) => {
    if (Array.isArray(value) && value.length > 100) { truncated = true; return [...value.slice(0, 100), `[omitted ${value.length - 100} entries]`]; }
    if (typeof value !== 'string') return value;
    const safe = value.replace(/https?:\/\/[^\s]+/g, text => { try { const url = new URL(text); return url.origin + url.pathname; } catch { return '[invalid URL]'; } });
    if (safe.length <= 512) return safe;
    truncated = true; return safe.slice(0, 512) + `...[truncated ${safe.length - 512} characters]`;
  }));
  core[{ INFO: 'info', WARN: 'warning', ERROR: 'error', DEBUG: 'debug' }[level]](JSON.stringify({ ...record, truncated }));
}
