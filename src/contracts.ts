import { createHash } from "node:crypto";
import { runnerVersions } from "../.github/scripts/checkpoint-policy.mjs";

export const versions = runnerVersions;
export const shaPattern = /^[a-f0-9]{40}$/;
export const executionMode = "full-access";
export type Status = "completed" | "continuing" | "cancelled" | "incomplete" | "blocked" | "failed";
export type Authorization = { repository: string; plan_sha256: string; request: string };
export type SkillSource = { repository: string; revision: string; names: string[] };
export type ValidationPolicy = { checks: string[]; reviewers: string[]; local_checks: string[]; marked_review_count: number };
export const blockerReasons = ["plan_decision_required", "missing_dependency", "authentication_failed", "permission_denied", "audit_blocked", "validation_failed", "review_unavailable", "out_of_scope"] as const;
export type Blocker = { reason: typeof blockerReasons[number]; references: string[]; missing_inputs: string[] };
export const executionSource: SkillSource = {
  repository: "markhuangai/agent-remote-dev-skills", revision: versions.execution_skills,
  names: ["sdlc-plan-implementation", "plan-audit", "pr-review-loop"],
};
export class RunnerError extends Error {
  constructor(public reason: string, public stage: string, public nativeCause = "", public details: Record<string, unknown> = {}) {
    super(reason);
  }
}
export function requireValue(condition: unknown, reason: string, stage = "preflight"): asserts condition {
  if (!condition) throw new RunnerError(reason, stage);
}
export const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
export function parseJson(value: string, stage: string): any {
  try { return JSON.parse(value); } catch { throw new RunnerError("invalid_json", stage); }
}
export function object(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function authorize(raw: string, repository: string, plan: string): Authorization {
  const value = parseJson(raw, "authorization");
  requireValue(object(value) && Object.keys(value).sort().join() === "plan_sha256,repository,request", "invalid_authorization", "authorization");
  requireValue(value.repository === repository && value.plan_sha256 === hash(plan),
    "authorization_mismatch", "authorization");
  requireValue(typeof value.request === "string" && value.request.trim().length > 0, "missing_direct_request", "authorization");
  return value as Authorization;
}
export function skillSources(raw: string): SkillSource[] {
  const extra = parseJson(raw, "skills");
  requireValue(Array.isArray(extra) && extra.length <= 20, "invalid_skill_sources");
  const names = new Set(executionSource.names);
  for (const source of extra) {
    requireValue(object(source) && Object.keys(source).sort().join() === "names,repository,revision" &&
      /^[\w.-]+\/[\w.-]+$/.test(source.repository) && shaPattern.test(source.revision) &&
      Array.isArray(source.names) && source.names.length > 0, "invalid_skill_source");
    for (const name of source.names) {
      requireValue(typeof name === "string" && /^[a-z0-9][a-z0-9_-]{0,99}$/.test(name) && !names.has(name), "duplicate_or_invalid_skill_name");
      names.add(name);
    }
  }
  return [executionSource, ...extra];
}
export const turnSchema = {
  type: "object", additionalProperties: false,
  properties: {
    kind: { type: "string", enum: ["accomplishment", "audit", "complete", "blocked"] },
    summary: { type: "string" }, paths: { type: "array", items: { type: "string" } },
    commit_message: { type: "string" }, pr_url: { type: ["string", "null"] },
    review_receipt: { type: ["string", "null"] },
    blocker: { type: ["object", "null"], additionalProperties: false, properties: {
      reason: { type: "string", enum: blockerReasons }, references: { type: "array", items: { type: "string" } },
      missing_inputs: { type: "array", items: { type: "string" } },
    }, required: ["reason", "references", "missing_inputs"] },
    validation_policy: { type: ["object", "null"], additionalProperties: false, properties: {
      checks: { type: "array", items: { type: "string" } }, reviewers: { type: "array", items: { type: "string" } },
      local_checks: { type: "array", items: { type: "string" } }, marked_review_count: { type: "integer", minimum: 0 },
    }, required: ["checks", "reviewers", "local_checks", "marked_review_count"] },
  }, required: ["kind", "summary", "paths", "commit_message", "pr_url", "review_receipt", "validation_policy", "blocker"],
};
export type Turn = { kind: "accomplishment" | "audit" | "complete" | "blocked"; summary: string; paths: string[]; commit_message: string; pr_url: string | null; review_receipt: string | null; validation_policy: ValidationPolicy | null; blocker: Blocker | null };
export function parseTurn(raw: string): Turn {
  const value = parseJson(raw, "worker");
  requireValue(object(value) && Object.keys(value).sort().join() === [...turnSchema.required].sort().join() &&
    ["accomplishment", "audit", "complete", "blocked"].includes(value.kind) && typeof value.summary === "string" &&
    Array.isArray(value.paths) && value.paths.every((p: unknown) => typeof p === "string") &&
    typeof value.commit_message === "string" && (value.pr_url === null || typeof value.pr_url === "string") &&
    (value.review_receipt === null || typeof value.review_receipt === "string"), "invalid_turn_result", "worker");
  if (value.validation_policy !== null) {
    const policy = value.validation_policy;
    requireValue(object(policy) && Object.keys(policy).sort().join() === "checks,local_checks,marked_review_count,reviewers" &&
      [policy.checks, policy.reviewers, policy.local_checks].every((list) => Array.isArray(list) && list.every((s: unknown) => typeof s === "string" && s.length > 0)) &&
      policy.checks.length > 0 && Number.isSafeInteger(policy.marked_review_count) && policy.marked_review_count >= 0, "invalid_validation_policy", "worker");
  }
  if (value.blocker !== null) {
    const blocker = value.blocker;
    requireValue(object(blocker) && blockerReasons.includes(blocker.reason) && Array.isArray(blocker.references) &&
      blocker.references.every((url: unknown) => typeof url === "string" && /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/(?:issues|pull|actions\/runs)\/[1-9][0-9]*$/.test(url)) &&
      Array.isArray(blocker.missing_inputs) && blocker.missing_inputs.every((name: unknown) => typeof name === "string" && /^[a-z][a-z0-9_.-]{0,63}$/.test(name)), "invalid_blocker", "worker");
  }
  requireValue(value.kind !== "blocked" || value.blocker !== null, "missing_blocker_reason", "worker");
  return value as Turn;
}
