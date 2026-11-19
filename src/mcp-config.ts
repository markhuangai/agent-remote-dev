import { readFile, realpath, stat } from "node:fs/promises";
import { join, sep } from "node:path";
import { object, RunnerError } from "./contracts.js";
import { protectConfiguration } from "./credentials.js";
import type { Diagnostics } from "./diagnostics.js";

type McpServers = Record<string, Record<string, unknown>>;
export type McpConfiguration = { cwd?: string; shared: McpServers; repository: McpServers };

export async function readRepositoryMcpFile(cwd: string, source: ".mcp.json" | ".codex/config.toml") {
  try {
    const path = await realpath(join(cwd, source));
    if (path.startsWith(cwd + sep) && (await stat(path)).isFile()) return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
  }
  throw new RunnerError("unreadable_mcp_config", "configuration", "Expected a readable file within the checkout.", { source });
}

export function parseMcpServers(raw: string | undefined, source: "MCP_CONFIG_JSON" | ".mcp.json", log: Diagnostics): McpServers {
  if (raw === undefined) return {};
  const invalid = () => new RunnerError("invalid_mcp_config", "configuration", "Expected JSON with an mcpServers object containing server definitions.", { source });
  let config: unknown;
  try { config = JSON.parse(raw); } catch { throw invalid(); }
  if (!object(config) || !object(config.mcpServers) || !Object.values(config.mcpServers).every(object)) throw invalid();
  protectConfiguration({ mcpServers: config.mcpServers }, log);
  return config.mcpServers;
}
