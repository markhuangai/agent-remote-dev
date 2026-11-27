import type { SDKAssistantMessageError } from "@anthropic-ai/claude-agent-sdk";

export type ProviderErrorClass = "transient_provider_error" | "transient_transport_error" | "permanent_provider_error" | "unclassified_native_failure";
export type AutoContinueRejectionReason = "permanent_provider_error" | "unclassified_native_failure" | "session_not_started" |
  "conversation_identity_changed" | "turn_already_completed" | "session_writes_lost" | "non_quiescent_or_signal_exit";
export type ProviderClassification = { provider_error_class: ProviderErrorClass; transient: boolean; http_status: number | null; cause_code: string | null };

const permanent = /\b(?:unauthori[sz]ed|forbidden|authentication|invalid[_ -]?(?:api[_ -]?)?key|invalid[_ -]?request|model[_ -]?(?:not[_ -]?found|does not exist)|insufficient[_ -]?(?:quota|credits)|billing|quota|usage[_ -]?limit|org(?:ani[sz]ation)?[_ -]?policy|context[_ -]?(?:length|window|limit)|maximum context|prompt[_ -]?too[_ -]?long|max(?:imum)?[_ -]?output[_ -]?tokens|budget[_ -]?exhausted)(?:\b|_)/i;
const transientTransport = /(?:upstream stream closed before a terminal event|stream disconnected before completion:\s*transport error:\s*network error:\s*error decoding response body|unexpected\s+eof|\beof\b.*(?:stream|connection)|(?:stream|connection|socket|websocket|sse).*(?:unexpected(?:ly)?\s+(?:closed|disconnect)|idle\s*timeout|timed?\s*out|reset by peer)|\b(?:ECONNRESET|ETIMEDOUT|EAI_AGAIN|ECONNREFUSED|UND_ERR_SOCKET)\b)/i;
const causeCodes = /\b(ECONNRESET|ETIMEDOUT|EAI_AGAIN|ECONNREFUSED|UND_ERR_SOCKET)\b/i;

function transientStatus(status: number | null) { return status === 408 || status === 429 || status !== null && status >= 500 && status <= 599; }
function permanentStatus(status: number | null) { return status !== null && status >= 400 && status < 500 && status !== 408 && status !== 429; }

export function classifyCodexError(message: string): ProviderClassification {
  const statuses = [...message.matchAll(/\b(?:http(?:\/\d(?:\.\d)?)?(?:\s+error)?|status(?:\s+code)?|response(?:\s+status)?|api\s+error)\s*[:=]?\s*([1-5]\d\d)\b/gi)]
    .map(match => Number(match[1]));
  const status = statuses.find(permanentStatus) ?? statuses.find(transientStatus) ?? statuses[0] ?? null;
  const cause = causeCodes.exec(message)?.[1]?.toUpperCase() ?? null;
  if (permanent.test(message) || permanentStatus(status)) return { provider_error_class: "permanent_provider_error", transient: false, http_status: status, cause_code: cause };
  if (transientStatus(status)) return { provider_error_class: "transient_provider_error", transient: true, http_status: status, cause_code: cause };
  if (transientTransport.test(message)) return { provider_error_class: "transient_transport_error", transient: true, http_status: status, cause_code: cause };
  return { provider_error_class: "unclassified_native_failure", transient: false, http_status: status, cause_code: cause };
}

const claudeClasses: Record<SDKAssistantMessageError, ProviderErrorClass> = {
  authentication_failed: "permanent_provider_error", oauth_org_not_allowed: "permanent_provider_error",
  account_on_hold: "permanent_provider_error", verification_required: "permanent_provider_error", billing_error: "permanent_provider_error",
  rate_limit: "unclassified_native_failure", overloaded: "transient_provider_error", invalid_request: "permanent_provider_error",
  model_not_found: "permanent_provider_error", server_error: "transient_provider_error", unknown: "unclassified_native_failure",
  max_output_tokens: "permanent_provider_error", cloud_credential_error: "permanent_provider_error",
};

export function hasLimitPrefix(text: string, usagePrefixes: readonly string[], orgPrefixes: readonly string[]) {
  return [...usagePrefixes, ...orgPrefixes].some(prefix => text.trimStart().startsWith(prefix));
}

export function classifyClaudeError(input: { reason?: SDKAssistantMessageError; status?: number | null; rateLimitRejected?: boolean;
  usageLimitRejected?: boolean; retryHint?: boolean; transportHint?: boolean; terminalReason?: string | null; startupFailure?: string | null;
  resultReason?: string | null; permanentHint?: boolean; causeCode?: string | null }): ProviderClassification {
  const status = Number.isInteger(input.status) ? input.status! : null;
  const cause = typeof input.causeCode === "string" && /^(?:ECONNRESET|ETIMEDOUT|EAI_AGAIN|ECONNREFUSED|UND_ERR_SOCKET)$/.test(input.causeCode)
    ? input.causeCode : null;
  const base = input.reason && Object.hasOwn(claudeClasses, input.reason) ? claudeClasses[input.reason] : "unclassified_native_failure";
  if (base === "permanent_provider_error" || permanentStatus(status) || input.rateLimitRejected || input.usageLimitRejected || input.permanentHint ||
    input.startupFailure || input.terminalReason && input.terminalReason !== "api_error" ||
    input.resultReason === "error_max_turns" || input.resultReason === "error_max_budget_usd") {
    return { provider_error_class: "permanent_provider_error", transient: false, http_status: status, cause_code: cause };
  }
  if (base === "transient_provider_error" || transientStatus(status) || input.reason === "rate_limit" && input.retryHint) {
    return { provider_error_class: "transient_provider_error", transient: true, http_status: status, cause_code: cause };
  }
  if (input.transportHint && input.retryHint) return { provider_error_class: "transient_transport_error", transient: true, http_status: status, cause_code: cause };
  return { provider_error_class: "unclassified_native_failure", transient: false, http_status: status, cause_code: cause };
}

export function safeProviderCause(classification: ProviderClassification) {
  return [classification.provider_error_class, classification.http_status === null ? null : `HTTP ${classification.http_status}`,
    classification.cause_code].filter(Boolean).join(" ");
}

export function classifyFailure(classification: ProviderClassification, state: { observed: boolean; identityChanged: boolean;
  completed?: boolean; writesLost?: boolean; quiescent?: boolean }) {
  let rejection: AutoContinueRejectionReason | null = null;
  if (state.identityChanged) rejection = "conversation_identity_changed";
  else if (!state.observed) rejection = "session_not_started";
  else if (state.completed) rejection = "turn_already_completed";
  else if (state.writesLost) rejection = "session_writes_lost";
  else if (state.quiescent === false) rejection = "non_quiescent_or_signal_exit";
  else if (!classification.transient) rejection = classification.provider_error_class === "permanent_provider_error"
    ? "permanent_provider_error" : "unclassified_native_failure";
  return { ...classification, recovery_reason: rejection ? null : "native_provider_transient", auto_continue_eligible: rejection === null,
    auto_continue_rejection_reason: rejection };
}
