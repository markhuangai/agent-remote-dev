import { requireValue, RunnerError } from "./contracts.js";
import { trivialCredential } from "./diagnostics.js";
import type { Diagnostics } from "./diagnostics.js";

const credentialKey = /(?:^|[_-])(?:api[_-]?key|key|token|secret|password|passwd|auth|authorization|credential|signature)(?:$|[_-])/i;
const environmentCredentialSuffix = /(?:api[_-]?key|token|secret|password|passwd|authorization|credential|signature)$/i;
const authorizationScheme = /^\s*(?:Bearer|Basic|Token|Digest|ApiKey)(?:\s|$)/i;
const publicHeaders = /^(?:accept|accept-encoding|accept-language|content-type|user-agent|host|connection|cache-control|pragma|referer|origin)$/i;

function isCredentialKey(value: string) {
  return credentialKey.test(value.replace(/([a-z0-9])([A-Z])/g, "$1_$2"));
}

function isEnvironmentReference(value: string) {
  return /^\$(?:[A-Za-z_][A-Za-z0-9_]*|\{[A-Za-z_][A-Za-z0-9_]*(?::-[^}]*)?\})$/.test(value.trim());
}

function looksLikeCredential(value: string) {
  return /^(?:sk-(?:ant-|proj-|svcacct-)?[A-Za-z0-9_-]{12,}|(?:sk|rk)_(?:live|test)_[A-Za-z0-9]+|gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|xox[baprs]-[A-Za-z0-9-]+|(?:AKIA|ASIA)[A-Z0-9]{16}|AIza[A-Za-z0-9_-]{20,}|glpat-[A-Za-z0-9_-]+|npm_[A-Za-z0-9]+|pypi-[A-Za-z0-9_-]+|hf_[A-Za-z0-9]+|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.test(value);
}

export function registerCredential(value: string, log: Diagnostics, source: string, field: string, allowReference = true) {
  if (allowReference && isEnvironmentReference(value)) return;
  if (trivialCredential(value)) throw new RunnerError("invalid_configured_credential", "configuration", "Replace the indicated configured credential.", { source, field });
  log.protect(value);
}

function protectAuthorization(value: string, log: Diagnostics, source: string) {
  if (/^\s*(?:Bearer|Basic|Token|Digest|ApiKey)\s*$/i.test(value)) {
    throw new RunnerError("invalid_configured_credential", "configuration", "Replace the indicated configured credential.", { source, field: "authorization" });
  }
  if (isEnvironmentReference(value)) return;
  const match = /^\s*(\S+)\s+(.+?)\s*$/.exec(value);
  if (!match) {
    registerCredential(value, log, source, "authorization");
    return;
  }
  const [, scheme, payload] = match;
  if (isEnvironmentReference(payload)) return;
  const components = [payload];
  if (scheme.toLowerCase() === "basic") {
    const bytes = Buffer.from(payload, "base64");
    for (const encoding of ["utf8", "latin1"] as const) {
      const pair = bytes.toString(encoding), separator = pair.indexOf(":");
      if (separator >= 0) {
        components.push(pair);
        const password = pair.slice(separator + 1);
        if (trivialCredential(password)) throw new RunnerError("invalid_configured_credential", "configuration", "Replace the indicated configured credential.", { source, field: "basic_password" });
        components.push(password);
      }
    }
  }
  if (trivialCredential(payload)) throw new RunnerError("invalid_configured_credential", "configuration", "Replace the indicated configured credential.", { source, field: "authorization" });
  for (const component of components) log.protect(component);
  log.protect(value);
}

function protectUrl(value: string, log: Diagnostics, source: string) {
  let url: URL;
  try { url = new URL(value); } catch { return; }
  const credentials: { decoded: string; encoded: string }[] = [], composite: string[] = [];
  const userinfo = /^[a-z][a-z0-9+.-]*:\/\/([^/@]*)@/i.exec(value)?.[1];
  if (userinfo?.includes(":")) {
    let password = url.password, combined = userinfo;
    try { password = decodeURIComponent(password); combined = decodeURIComponent(userinfo); } catch {}
    if (!isEnvironmentReference(password)) { credentials.push({ decoded: password, encoded: userinfo.slice(userinfo.indexOf(":") + 1) }); composite.push(combined); }
  } else if (userinfo) {
    let token = userinfo;
    try { token = decodeURIComponent(userinfo); } catch {}
    if (!isEnvironmentReference(token)) credentials.push({ decoded: token, encoded: userinfo });
  }
  for (const part of url.search.slice(1).split("&")) {
    if (!part) continue;
    const entry = new URLSearchParams(part).entries().next().value;
    if (!entry) continue;
    const [key, item] = entry, separator = part.indexOf("=");
    if (!isEnvironmentReference(item) && (isCredentialKey(key) || looksLikeCredential(item)))
      credentials.push({ decoded: item, encoded: separator < 0 ? "" : part.slice(separator + 1) });
  }
  for (const { decoded } of credentials) {
    if (trivialCredential(decoded)) throw new RunnerError("invalid_configured_credential", "configuration", "Replace the indicated configured credential.", { source, field: "url_credential" });
  }
  for (const { decoded, encoded } of credentials) { log.protect(decoded); log.protect(encoded); }
  for (const item of composite) log.protect(item);
}

export function protectConfiguration(value: unknown, log: Diagnostics, key = "", source = "configuration") {
  const name = key.split(".").at(-1) ?? "";
  const normalized = name.replace(/([a-z0-9])([A-Z])/g, "$1_$2");
  if (/^(?:env_key|env_vars|api_key_helper|bearer_token_env_var|env_http_headers)$/i.test(normalized)) return;
  if (Array.isArray(value)) {
    let credentialArgument = false, headerArgument = false;
    for (const item of value) {
      if (typeof item !== "string") { protectConfiguration(item, log, key, source); continue; }
      protectUrl(item, log, source);
      const headerValue = headerArgument ? item : /^(?:--header=|-H=?)(.+)$/i.exec(item)?.[1];
      const namedHeader = headerValue && /^\s*([^\s:]+)\s*:\s*(.*)$/.exec(headerValue);
      if (namedHeader && /^(?:proxy-)?authorization$/i.test(namedHeader[1])) protectAuthorization(namedHeader[2], log, source);
      else if (namedHeader && !publicHeaders.test(namedHeader[1]) && isCredentialKey(namedHeader[1]))
        registerCredential(namedHeader[2], log, source, "header");
      if (credentialArgument && authorizationScheme.test(item)) protectAuthorization(item, log, source);
      else if (credentialArgument) registerCredential(item, log, source, "argument");
      credentialArgument = /^--?[\w-]+$/.test(item) && isCredentialKey(item.replace(/^-+/, ""));
      headerArgument = /^(?:--header|-H)$/i.test(item);
      const assignment = /^--?([\w-]+)=(.*)$/.exec(item);
      if (assignment) protectUrl(assignment[2], log, source);
      if (assignment && isCredentialKey(assignment[1]) && authorizationScheme.test(assignment[2])) protectAuthorization(assignment[2], log, source);
      else if (assignment && isCredentialKey(assignment[1])) registerCredential(assignment[2], log, source, "argument");
      const header = /^(?:--header|-H)=(?:proxy-)?authorization\s*:\s*(.*)$/i.exec(item);
      if (header) protectAuthorization(header[1], log, source);
      if (/^(?:proxy-)?authorization\s*:/i.test(item)) protectAuthorization(item.slice(item.indexOf(":") + 1), log, source);
      if (/^\s*(?:Bearer|Basic)\s+/i.test(item)) protectAuthorization(item, log, source);
    }
    return;
  }
  if (typeof value === "string") {
    const header = /\.(?:http_headers|headers)\./i.test(key);
    if (header && publicHeaders.test(name)) return;
    protectUrl(value, log, source);
    if (header && /^(?:proxy-)?authorization$/i.test(name) || /^\s*(?:Bearer|Basic)\s+/i.test(value) ||
      isCredentialKey(name) && authorizationScheme.test(value)) protectAuthorization(value, log, source);
    else if (isCredentialKey(name) || /\.env\./i.test(key) && environmentCredentialSuffix.test(name))
      registerCredential(value, log, source, header ? "header" : "credential");
    else if (header && !trivialCredential(value)) log.protect(value);
    return;
  }
  if (value && typeof value === "object") {
    for (const [childKey, child] of Object.entries(value)) protectConfiguration(child, log, key + "." + childKey, source);
  }
}

export function hasStandaloneJsonSyntaxLines(value: string) {
  return value.split(/\r?\n/).some(line => /^[{}[\],]+$/.test(line.trim()));
}
export function inspectCredentials(value: unknown, log: Diagnostics, reason = "credential_in_checkpoint"): void {
  if (typeof value === "string" || value instanceof Uint8Array) {
    const data = Buffer.from(value);
    for (const secret of log.protectedValues) {
      const forms = [secret, encodeURIComponent(secret), new URLSearchParams([["value", secret]]).toString().slice(6)];
      for (const form of forms) requireValue(!data.includes(Buffer.from(form)), reason, "checkpoint");
    }
    if (typeof value === "string" && /^[\s]*[\[{"]/.test(value)) {
      let decoded: unknown;
      try { decoded = JSON.parse(value); } catch { return; }
      inspectCredentials(decoded, log, reason);
    }
  } else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) { inspectCredentials(key, log, reason); inspectCredentials(child, log, reason); }
  }
}
