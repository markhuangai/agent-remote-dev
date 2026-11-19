import { configureCodex, runCodex } from "./codex.js";
import { configureClaude, runClaude } from "./claude.js";
import { captureCodex, restoreCodex } from "./codex-state.js";
import { captureClaude, restoreClaude } from "./claude-state.js";
import { runnerKind, requireValue, versions } from "./contracts.js";

const adapters = {
  codex: { version: versions.codex, instructionFile: "AGENTS.md", skillAgent: "codex", skillDirectory: ".agents/skills",
    prepare: configureCodex, execute: runCodex, capture: captureCodex, restore: restoreCodex },
  claude: { version: versions.claude, instructionFile: "CLAUDE.md", skillAgent: "claude-code", skillDirectory: ".claude/skills",
    prepare: configureClaude, execute: runClaude, capture: captureClaude, restore: restoreClaude },
};
export const runnerAdapter = (kind: unknown) => adapters[runnerKind(kind)];
export function runnerInputs(env: NodeJS.ProcessEnv) {
  const runner = runnerKind(env.REMOTE_DEV_RUNNER ?? "codex"), token = env.REMOTE_DEV_GITHUB_TOKEN!;
  const key = (runner === "codex" ? env.CODEX_API_KEY : env.ANTHROPIC_API_KEY)!,
    config = (runner === "codex" ? env.CODEX_CONFIG_TOML : env.CLAUDE_SETTINGS_JSON)!;
  requireValue(token?.length >= 8 && key?.length >= 8 && config, "invalid_credential_input");
  return { runner, token, key, config, mcp: env.MCP_CONFIG_JSON ?? "" };
}
