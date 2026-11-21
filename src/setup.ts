import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rmdir, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, sep } from "node:path";
import { Diagnostics } from "./diagnostics.js";
import { command } from "./process.js";
import { requireValue, RunnerError, SkillSource, UserInstructions, RunnerKind, versions } from "./contracts.js";
import { runnerAdapter } from "./runners.js";
import { instructions } from "./platform/checkpoint-policy.mjs";
import { parseMcpServers, readRepositoryMcpFile } from "./mcp-config.js";

export type Job = { runner: RunnerKind; root: string; home: string; runnerHome: string; tools: string; staging: string; exports: string; env: NodeJS.ProcessEnv };
export async function createJob(temp: string, apiKey: string, token: string, author: string, email: string, inherited: NodeJS.ProcessEnv = process.env, runner: RunnerKind = "codex"): Promise<Job> {
  requireValue(author.trim() && email.trim() && !/[\r\n\0]/.test(author + email), "invalid_git_identity");
  const root = await mkdtemp(join(temp, "remote-dev-task-"));
  const home = join(root, "home"), runnerHome = join(root, runner), tools = join(root, "tools");
  const staging = join(root, "staging"), exports = join(root, "exports");
  for (const dir of [home, runnerHome, tools, staging, exports, join(root, "tmp"), join(root, "gh"), join(root, "npm-cache")]) await mkdir(dir, { mode: 0o700 });
  const askpass = join(root, "git-askpass");
  await writeFile(askpass, '#!/bin/sh\ncase "$1" in *Username*) printf "%s\\n" x-access-token ;; *) printf "%s\\n" "$GH_TOKEN" ;; esac\n', { mode: 0o700 });
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(inherited)) if (/^(PATH|LANG|LC_[A-Z_]+|TZ|GITHUB_(?!TOKEN)[A-Z_]+|RUNNER_[A-Z_]+|CI|HTTPS?_PROXY|NO_PROXY)$/.test(key)) env[key] = value;
  Object.assign(env, { HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"), XDG_CACHE_HOME: join(home, ".cache"), GH_CONFIG_DIR: join(root, "gh"),
    TMPDIR: join(root, "tmp"), npm_config_cache: join(root, "npm-cache"),
    GH_TOKEN: token, GITHUB_TOKEN: token,
    GIT_ASKPASS: askpass, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: author, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: author, GIT_COMMITTER_EMAIL: email,
    PATH: [dirname(process.execPath), join(tools, "node_modules", ".bin"), inherited.PATH].filter(Boolean).join(":"),
    DISABLE_TELEMETRY: "1", NO_COLOR: "1" });
  if (runner === "codex") Object.assign(env, { CODEX_HOME: runnerHome, CODEX_SQLITE_HOME: runnerHome, CODEX_API_KEY: apiKey, OPENAI_API_KEY: apiKey });
  else Object.assign(env, { CLAUDE_CONFIG_DIR: runnerHome, ANTHROPIC_API_KEY: apiKey, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    CLAUDE_CODE_REMOTE_MEMORY_DIR: "", CLAUDE_COWORK_MEMORY_PATH_OVERRIDE: "", CLAUDE_CODE_SKIP_PROMPT_HISTORY: "", CLAUDE_CODE_TASK_LIST_ID: "" });
  return { runner, root, home, runnerHome, tools, staging, exports, env };
}
export async function configure(job: Job, raw: string, log: Diagnostics, mcp = "", cwd?: string) {
  const shared = parseMcpServers(mcp || undefined, "MCP_CONFIG_JSON", log);
  const repository = parseMcpServers(cwd ? await readRepositoryMcpFile(cwd, ".mcp.json") : undefined, ".mcp.json", log);
  await runnerAdapter(job.runner).prepare(job, raw, log, { cwd, shared, repository });
}
export async function installTools(job: Job, providerRoot: string, log: Diagnostics) {
  job.tools = providerRoot;
  job.env.PATH = [dirname(process.execPath), join(providerRoot, "node_modules", ".bin"), job.env.PATH].join(":");
  if (job.runner === "codex") {
    const actual = (await command(join(providerRoot, "node_modules/.bin/codex"), ["--version"], { cwd: providerRoot, env: job.env, stage: "runner_version", log })).trim();
    requireValue(actual === `codex-cli ${versions.codex}`, "runner_version_mismatch", "setup");
  } else {
    const installed = JSON.parse(await readFile(join(providerRoot, "node_modules/@anthropic-ai/claude-agent-sdk/package.json"), "utf8"));
    requireValue(installed.version === versions.claude, "runner_version_mismatch", "setup");
  }
  log.event("runtime.setup", "INFO", { stage: "tools", runner: job.runner, runner_version: versions[job.runner], outcome: "success" });
}
export async function installUserInstructions(job: Job, value: UserInstructions, log: Diagnostics) {
  try { instructions(value); }
  catch (error: any) { throw new RunnerError(error.reason ?? "invalid_user_instructions", "instructions", "Frozen user instructions were rejected.", error.details); }
  const attribution = "For every Git commit you create, include this trailer exactly once after a blank line:\n\n" +
    "Assisted-by: remote-agent-dev <https://github.com/markhuangai/agent-remote-dev>\n";
  const progress = `## Save progress on the task branch

This section applies only to coding tasks where the user authorizes commits and pushes.
Follow the task and repository's publication limits.

After read-only preflight, verify the base revision and create the task branch before
editing. On resume, check the recorded task branch and its remote tip before editing.
Use the recorded checkpoint commit as the source on resume. If a remote tip exists and
differs, advance only when the current resume request explicitly approves the exact
SHA and confirms that an authorized task participant pushed it. Verify that the
approved SHA is still the remote tip and descends from the checkpoint before
fast-forwarding. For any other mismatch, stop before editing, report both SHAs,
and ask the user to verify the push and approve the expected SHA in a new resume.

For tasks covered by this authorization, commit and push each coherent milestone,
including before a long audit or test run. Stage only intended task paths and inspect
the staged diff for unrelated files and credentials. Push normally to the task branch
and set its upstream on the first push.

Before handing off work on the verified task branch, including incomplete work,
inspect staged and unstaged changes, untracked files, and unpushed commits. Within the
same authorization, commit remaining task changes and push outstanding task commits.
Verify that the exact remote task branch SHA matches local HEAD and report the branch
and SHA. If a push fails, report the cause, what remains local, and the last verified
remote SHA, if available.

For audited PR delivery, obtain a conformant plan audit before required pre-PR tests.
Open the PR after the audit and those tests pass.
`;
  await writeFile(join(job.runnerHome, runnerAdapter(job.runner).instructionFile), `${attribution}\n${progress}${value ? "\n" + value.content : ""}`, { mode: 0o600, flag: "wx" });
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
  const adapter = runnerAdapter(job.runner);
  await command(installer, ["add", sourceRoot, "--skill", ...source.names, "--agent", adapter.skillAgent, "--copy", "--yes"],
    { cwd: project, env: job.env, stage: "skill_install", log });
  for (const name of source.names) {
    const installed = join(project, adapter.skillDirectory, name);
    const files = await safeTree(installed);
    requireValue(files.some((file) => basename(file) === "SKILL.md" && dirname(file) === installed), "missing_installed_skill", "skills");
    await cp(installed, join(job.runnerHome, "skills", name), { recursive: true, errorOnExist: true, force: false });
  }
  log.event("runtime.setup", "INFO", { stage: "skills", repository: source.repository, revision: source.revision, names: source.names, outcome: "success" });
}
