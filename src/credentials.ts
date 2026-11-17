import { requireValue } from "./contracts.js";
import type { Diagnostics } from "./diagnostics.js";

export function protectConfiguration(value: unknown, log: Diagnostics, key = "") {
  if (/\.(env_key|env_vars)$/.test(key)) return;
  if (typeof value === "string" && (/key|token|secret|password|auth|credential|signature/i.test(key.split(".").at(-1)!) || /\.(?:http_headers|headers)\./i.test(key))) {
    log.protect(value);
    if (/\.(?:http_headers|headers)\.(?:proxy-)?authorization$/i.test(key)) {
      const credentials = /^\s*(Bearer|Basic)\s+(\S+)\s*$/i.exec(value);
      if (credentials) {
        log.protect(credentials[2]);
        if (credentials[1].toLowerCase() === "basic") {
          const bytes = Buffer.from(credentials[2], "base64");
          for (const encoding of ["utf8", "latin1"] as const) {
            const pair = bytes.toString(encoding), separator = pair.indexOf(":");
            if (separator >= 0) { log.protect(pair); log.protect(pair.slice(separator + 1)); }
          }
        }
      }
    }
  } else if (value && typeof value === "object") {
    for (const [childKey, child] of Object.entries(value)) protectConfiguration(child, log, key + "." + childKey);
  }
}
export function inspectCredentials(value: unknown, log: Diagnostics, reason = "credential_in_checkpoint"): void {
  if (typeof value === "string" || value instanceof Uint8Array) {
    for (const secret of log.protectedValues) requireValue(!Buffer.from(value).includes(Buffer.from(secret)), reason, "checkpoint");
    if (typeof value === "string" && /^[\s]*[\[{"]/.test(value)) {
      let decoded: unknown;
      try { decoded = JSON.parse(value); } catch { return; }
      inspectCredentials(decoded, log, reason);
    }
  } else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) { inspectCredentials(key, log, reason); inspectCredentials(child, log, reason); }
  }
}
