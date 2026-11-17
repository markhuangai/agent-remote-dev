import { createHash } from "node:crypto";
import { sources } from "./platform/checkpoint-policy.mjs";

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
const dependencies = JSON.parse(readFileSync(resolve(import.meta.dirname, "../package.json"), "utf8")).dependencies;
export const versions = { codex: dependencies["@openai/codex"], claude: dependencies["@anthropic-ai/claude-agent-sdk"], skills_cli: dependencies.skills };
export type RunnerKind = "codex" | "claude";
export function runnerKind(value: unknown = "codex"): RunnerKind {
  requireValue(value === "codex" || value === "claude", "invalid_runner");
  return value;
}
export const shaPattern = /^[a-f0-9]{40}$/;
export const executionMode = "full-access";
export type SkillSource = { repository: string; revision: string; names: string[] };
export type UserInstructions = { url: string; sha256: string; content: string } | null;
export class RunnerError extends Error {
  constructor(public reason: string, public stage: string, public nativeCause = "", public details: Record<string, unknown> = {}) { super(reason); }
}
export function requireValue(condition: unknown, reason: string, stage = "preflight"): asserts condition {
  if (!condition) throw new RunnerError(reason, stage);
}
export const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
export const projectStorageKey = (repository: string, rootRunId: string) => "remote-" + hash(repository + ":" + rootRunId).slice(0, 56);
export function parseJson(value: string, stage: string): any {
  try { return JSON.parse(value); } catch { throw new RunnerError("invalid_json", stage); }
}
export function object(value: unknown): value is Record<string, any> { return value !== null && typeof value === "object" && !Array.isArray(value); }
export function skillSources(value: unknown): SkillSource[] {
  try { return sources(value); }
  catch (error: any) { throw new RunnerError(error.reason ?? "invalid_skill_sources", "skills", "Selected skill sources are invalid.", error.details); }
}
