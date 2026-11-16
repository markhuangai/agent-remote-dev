import { createHash } from "node:crypto";
import { runnerVersions, sources, authorization } from "./platform/checkpoint-policy.mjs";

export const versions = runnerVersions;
export const shaPattern = /^[a-f0-9]{40}$/;
export const executionMode = "full-access";
export type Status = "completed" | "continuing" | "cancelled" | "incomplete" | "failed";
export type Authorization = { repository: string; plan_sha256: string; request: string };
export type SkillSource = { repository: string; revision: string; names: string[] };
export type UserAgents = { url: string; sha256: string; content: string } | null;
export class RunnerError extends Error {
  constructor(public reason: string, public stage: string, public nativeCause = "", public details: Record<string, unknown> = {}) { super(reason); }
}
export function requireValue(condition: unknown, reason: string, stage = "preflight"): asserts condition {
  if (!condition) throw new RunnerError(reason, stage);
}
export const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
export function parseJson(value: string, stage: string): any {
  try { return JSON.parse(value); } catch { throw new RunnerError("invalid_json", stage); }
}
export function object(value: unknown): value is Record<string, any> { return value !== null && typeof value === "object" && !Array.isArray(value); }
export function authorize(value: unknown, repository: string, plan: string): Authorization {
  try { return authorization(value, repository, plan); }
  catch (error: any) { throw new RunnerError(error.reason ?? "invalid_authorization", "authorization", "Direct request does not bind these plan bytes and repository.", error.details); }
}
export function skillSources(value: unknown): SkillSource[] {
  try { return sources(value); }
  catch (error: any) { throw new RunnerError(error.reason ?? "invalid_skill_sources", "skills", "Selected skill sources are invalid.", error.details); }
}
