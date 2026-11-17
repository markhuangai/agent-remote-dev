import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rmdir, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, sep } from "node:path";
import { parse, stringify } from "smol-toml";
import { Diagnostics } from "./diagnostics.js";
import { command } from "./process.js";
import { requireValue, RunnerError, SkillSource, UserAgents, versions } from "./contracts.js";
import { instructions } from "./platform/checkpoint-policy.mjs";

export type Job = { root: string; home: string; codexHome: string; tools: string; staging: string; exports: string; env: NodeJS.ProcessEnv };
export async function createJob(temp: string, apiKey: string, token: string, author: string, email: string, inherited: NodeJS.ProcessEnv = process.env): Promise<Job> {
  requireValue(author.trim() && email.trim() && !/[\r\n\0]/.test(author + email), "invalid_git_identity");
  const root = await mkdtemp(join(temp, "codex-task-"));
  const home = join(root, "home"), codexHome = join(root, "codex"), tools = join(root, "tools");
  const staging = join(root, "staging"), exports = join(root, "exports");
  for (const dir of [home, codexHome, tools, staging, exports, join(root, "tmp"), join(root, "gh"), join(root, "npm-cache")]) await mkdir(dir, { mode: 0o700 });
  const askpass = join(root, "git-askpass");
  await writeFile(askpass, '#!/bin/sh\ncase "$1" in *Username*) printf "%s\\n" x-access-token ;; *) printf "%s\\n" "$GH_TOKEN" ;; esac\n', { mode: 0o700 });
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(inherited)) if (/^(PATH|LANG|LC_[A-Z_]+|TZ|GITHUB_(?!TOKEN)[A-Z_]+|RUNNER_[A-Z_]+|CI|HTTPS?_PROXY|NO_PROXY)$/.test(key)) env[key] = value;
  Object.assign(env, { HOME: home, CODEX_HOME: codexHome, CODEX_SQLITE_HOME: codexHome,
    XDG_CONFIG_HOME: join(home, ".config"), XDG_CACHE_HOME: join(home, ".cache"), GH_CONFIG_DIR: join(root, "gh"),
    TMPDIR: join(root, "tmp"), npm_config_cache: join(root, "npm-cache"),
    CODEX_API_KEY: apiKey, OPENAI_API_KEY: apiKey, GH_TOKEN: token, GITHUB_TOKEN: token,
    GIT_ASKPASS: askpass, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: author, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: author, GIT_COMMITTER_EMAIL: email,
    PATH: [dirname(process.execPath), join(tools, "node_modules", ".bin"), inherited.PATH].filter(Boolean).join(":"),
    DISABLE_TELEMETRY: "1", NO_COLOR: "1" });
  return { root, home, codexHome, tools, staging, exports, env };
}
export async function configure(job: Job, raw: string, log: Diagnostics) {
  let config: any;
  try { config = parse(raw); } catch { throw new RunnerError("invalid_codex_config", "configuration", "Codex TOML could not be parsed; configuration contents withheld."); }
  const protect = (value: any, key = "") => {
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
    }
    else if (value && typeof value === "object") for (const [childKey, child] of Object.entries(value)) protect(child, key + "." + childKey);
  };
  protect(config);
  for (const key of ["sqlite_home", "log_dir", "sandbox_mode", "sandbox_workspace_write", "approval_policy", "default_permissions", "permissions", "skills", "allow_login_shell", "cli_auth_credentials_store", "mcp_oauth_credentials_store"]) delete config[key];
  Object.assign(config, { sqlite_home: job.codexHome, log_dir: join(job.root, "logs"), allow_login_shell: false,
    cli_auth_credentials_store: "file", mcp_oauth_credentials_store: "file", skills: { bundled: { enabled: false } } });
  await writeFile(join(job.codexHome, "config.toml"), stringify(config), { mode: 0o600 });
  log.event("runtime.setup", "INFO", { stage: "configuration", outcome: "success", paths: { home: job.home, codex_home: job.codexHome } });
}
export async function installTools(job: Job, providerRoot: string, log: Diagnostics) {
  job.tools = providerRoot;
  job.env.PATH = [dirname(process.execPath), join(providerRoot, "node_modules", ".bin"), job.env.PATH].join(":");
  const actual = (await command(join(providerRoot, "node_modules/.bin/codex"), ["--version"], { cwd: providerRoot, env: job.env, stage: "codex_version", log })).trim();
  requireValue(actual === `codex-cli ${versions.codex}`, "codex_version_mismatch", "setup");
}
export async function installUserAgents(job: Job, value: UserAgents, log: Diagnostics) {
  try { instructions(value); }
  catch (error: any) { throw new RunnerError(error.reason ?? "invalid_user_agents", "instructions", "Frozen user instructions were rejected.", error.details); }
  const attribution = "For every Git commit you create, include this trailer exactly once after a blank line:\n\n" +
    "Assisted-by: remote-agent-dev <https://github.com/markhuangai/agent-remote-dev>\n";
  await writeFile(join(job.codexHome, "AGENTS.md"), attribution + (value ? "\n" + value.content : ""), { mode: 0o600, flag: "wx" });
  log.event("runtime.setup", "INFO", { stage: "user_instructions", configured: value !== null, source_url: value?.url ?? null,
    sha256: value?.sha256 ?? null, bytes: value ? Buffer.byteLength(value.content) : 0, outcome: "success" });
}
export async function safeTree(root: string) {
  requireValue(!(await lstat(root)).isSymbolicLink(), "symlink_not_allowed", "filesystem");
  const base = await realpath(root);
  const files: string[] = [];
  async function visit(path: string) {
    const stat = await lstat(path);
    requireValue(!stat.isSymbolicLink(), "symlink_not_allowed", "filesystem");
    requireValue(path === base || path.startsWith(base + sep), "path_escape", "filesystem");
    if (stat.isDirectory()) for (const name of (await readdir(path)).sort()) await visit(join(path, name));
    else { requireValue(stat.isFile(), "unsupported_file_type", "filesystem"); files.push(path); }
  }
  await visit(base);
  return files;
}
export async function removeJob(root: string) {
  const stat = await lstat(root);
  if (stat.isDirectory() && !stat.isSymbolicLink()) {
    for (const name of await readdir(root)) await removeJob(join(root, name));
    await rmdir(root);
  } else await unlink(root);
}
export async function fetchSkillSource(job: Job, source: SkillSource, index: number, log: Diagnostics) {
  const root = join(job.staging, `source-${index}`);
  await mkdir(root);
  const info = JSON.parse(await command("gh", ["api", `repos/${source.repository}/commits/${source.revision}`], { cwd: root, env: job.env, stage: "skill_source", log }));
  requireValue(info.sha === source.revision, "skill_revision_mismatch", "skills");
  const archive = join(job.staging, `source-${index}.tar.gz`);
  await command("gh", ["api", `repos/${source.repository}/tarball/${source.revision}`], { cwd: root, env: job.env, stage: "skill_download", stdoutFile: archive, log });
  const entries = await command("tar", ["-tzf", archive], { cwd: root, env: job.env, stage: "skill_archive", log });
  requireValue(entries.split("\n").filter(Boolean).every((p) => !p.startsWith("/") && !p.split("/").includes("..")), "unsafe_skill_archive", "skills");
  const types = await command("tar", ["-tvzf", archive], { cwd: root, env: job.env, stage: "skill_archive", log });
  requireValue(types.split("\n").filter(Boolean).every((line) => /^[-d]/.test(line)), "linked_skill_archive", "skills");
  await command("tar", ["-xzf", archive, "--strip-components=1", "--no-same-owner", "--no-same-permissions"], { cwd: root, env: job.env, stage: "skill_extract", log });
  return root;
}
export async function installSkillSource(job: Job, source: SkillSource, sourceRoot: string, index: number, log: Diagnostics,
  installer = join(job.tools, "node_modules/.bin/skills")) {
  const project = join(job.staging, `install-${index}`);
  await mkdir(project);
  await command(installer, ["add", sourceRoot, "--skill", ...source.names, "--agent", "codex", "--copy", "--yes"],
    { cwd: project, env: job.env, stage: "skill_install", log });
  for (const name of source.names) {
    const installed = join(project, ".agents/skills", name);
    const files = await safeTree(installed);
    requireValue(files.some((file) => basename(file) === "SKILL.md" && dirname(file) === installed), "missing_installed_skill", "skills");
    await cp(installed, join(job.codexHome, "skills", name), { recursive: true, errorOnExist: true, force: false });
  }
  log.event("runtime.setup", "INFO", { stage: "skills", repository: source.repository, revision: source.revision, names: source.names, outcome: "success" });
}
