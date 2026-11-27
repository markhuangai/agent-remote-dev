import * as core from "@actions/core";
import { lstat, open, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { requireValue, versions, parseJson, projectStorageKey, RunnerError } from "./contracts.js";
import { uploadSnapshot, startSnapshots, waitSnapshots, saveSnapshot, latestSnapshot } from "./checkpoint-worker.js";
import { inspectCredentials, CheckpointInput, DurableCheckpoint } from "./checkpoint.js";
import { Diagnostics } from "./diagnostics.js";
import { drive } from "./driver.js";
import { TaskGit } from "./git.js";
import { command } from "./process.js";
import { configure, createJob, fetchSkillSource, installSkillSource, installTools, installUserInstructions, removeJob, Job } from "./setup.js";
import { restoreCheckpoint } from "./resume.js";
import { githubAPI, prepareExecution } from "./platform/continuation-policy.mjs";
import { recoveryReasons } from "./platform/checkpoint-policy.mjs";
import { resolveSkills } from "./platform/sources.mjs";
import { fetchInstructions } from "./platform/instructions.mjs";
import { runnerInputs } from "./runners.js";
import { hasStandaloneJsonSyntaxLines, protectConfiguration, registerCredential } from "./credentials.js";
import { parse as parseToml } from "smol-toml";
import type { GitSummary } from "./git.js";

export type SavedRun = { control?: { directory: string; nonce: string }; watcher_pid?: number; job: Job; metadata: CheckpointInput;
  secrets: string[]; response: string; latest: DurableCheckpoint | null; skip_final_snapshot?: boolean;
  initial_git?: { sha: string; branch: string | null }; snapshots_log_offset?: number };
const summaryReplyBytes = 900 * 1024;
const summaryByteLimit = 1024 * 1024;
const omittedReplyMarker = "\n\n[... middle omitted from this summary; open the full result artifact for the complete reply ...]\n\n";

export function resumedPrompt(manifest: { checkpoint_sha: string; omitted_work?: boolean }, recovery: string | undefined, prompt: string) {
  return `Continue this conversation using the current repository configuration. The checkout is the published revision ${manifest.checkpoint_sha}. ` +
    (recovery && recoveryReasons.includes(recovery)
      ? "The previous worker was interrupted. Verify published work and any external effects before repeating an operation. " : "") +
    (manifest.omitted_work ? 'Uncommitted or unpushed work from the previous runner was not restored; inspect the checkout and recreate missing work as needed. ' : '') +
    `\n\nAdditional context:\n${prompt || 'Continue the unfinished task.'}`;
}

export function recordRecoveryReason(metadata: CheckpointInput, result: { outcome: string; session: string | null; reason: string }, skipFinalSnapshot: boolean) {
  delete metadata.recovery_reason;
  if (result.outcome === "failed" && result.session && !skipFinalSnapshot && recoveryReasons.includes(result.reason))
    metadata.recovery_reason = result.reason as CheckpointInput["recovery_reason"];
}

export class SnapshotLogTailer {
  private position: number;
  private pendingStart: number;
  private pending = Buffer.alloc(0);
  private records: { line: string; record: Record<string, any>; end: number }[] = [];
  private oldest = 0;
  private cycle: unknown;
  private flight = Promise.resolve();

  constructor(private root: string, private log: Diagnostics, offset: number,
    private commit: (offset: number) => Promise<void>, private finalizing = false, private partialFlushMs = 15000) {
    requireValue(Number.isSafeInteger(offset) && offset >= 0, "invalid_snapshot_log_offset", "checkpoint");
    this.position = offset;
    this.pendingStart = offset;
  }

  flush(force = false, stopped = false) {
    const next = this.flight.then(() => this.read(force, stopped));
    this.flight = next.catch(() => {});
    return next;
  }

  private async commitOffset(offset: number) {
    const path = join(this.root, "snapshots.offset");
    await writeFile(path + ".tmp", String(offset), { mode: 0o600 });
    await rename(path + ".tmp", path);
    await this.commit(offset);
  }

  private async flushRecords() {
    if (!this.records.length) return;
    const records = this.records;
    this.records = [];
    this.oldest = 0;
    this.cycle = undefined;
    this.log.flushBuffer();
    if (this.finalizing) {
      for (const entry of records) this.replay(entry.record);
    } else {
      const number = records[0].record.cycle;
      this.log.group(Number.isSafeInteger(number) ? `Checkpoint #${number}` : "Checkpoint diagnostics", records.map(entry => entry.line));
    }
    await this.commitOffset(records.at(-1)!.end);
  }

  private replay(record: Record<string, any>) {
    const { event, level, schema_version: _schema, versions: _versions, ...fields } = record;
    if (typeof event !== "string" || !["INFO", "WARN", "ERROR", "DEBUG"].includes(level)) throw new RunnerError("invalid_snapshot_log_record", "checkpoint");
    this.log.event(event, level, fields);
  }

  private async line(line: string, end: number) {
    if (line.startsWith("::add-mask::")) { await this.flushRecords(); await this.commitOffset(end); return; }
    let record: Record<string, any>;
    try { record = JSON.parse(line); }
    catch {
      await this.flushRecords();
      this.log.event("checkpoint.worker_stderr", "ERROR", { stage: "checkpoint", native_cause: this.log.sanitize(line) });
      await this.commitOffset(end);
      return;
    }
    if (!record || typeof record !== "object" || typeof record.event !== "string" || !["INFO", "WARN", "ERROR", "DEBUG"].includes(record.level)) {
      await this.flushRecords();
      this.log.event("checkpoint.worker_stderr", "ERROR", { stage: "checkpoint", native_cause: "Invalid snapshot worker record." });
      await this.commitOffset(end);
      return;
    }
    if (record.level === "WARN" || record.level === "ERROR") {
      await this.flushRecords();
      this.replay(record);
      await this.commitOffset(end);
      return;
    }
    if (this.records.length && this.cycle !== record.cycle) await this.flushRecords();
    if (!this.records.length) { this.oldest = Date.now(); this.cycle = record.cycle; }
    this.records.push({ line, record, end });
    if (record.event === "checkpoint.cycle") await this.flushRecords();
  }

  private async read(force: boolean, stopped: boolean) {
    let file;
    try { file = await open(join(this.root, "snapshots.log"), "r"); }
    catch (error: any) { if (error.code === "ENOENT" && this.position === 0) return; throw error; }
    try {
      const size = (await file.stat()).size;
      requireValue(this.position <= size, "invalid_snapshot_log_offset", "checkpoint");
      while (this.position < size) {
        const buffer = Buffer.alloc(Math.min(64 * 1024, size - this.position));
        const { bytesRead } = await file.read(buffer, 0, buffer.length, this.position);
        if (!bytesRead) break;
        this.position += bytesRead;
        this.pending = Buffer.concat([this.pending, buffer.subarray(0, bytesRead)]);
        for (;;) {
          const newline = this.pending.indexOf(10);
          if (newline < 0) break;
          const line = this.pending.subarray(0, newline).toString("utf8").replace(/\r$/, "");
          this.pending = this.pending.subarray(newline + 1);
          this.pendingStart += newline + 1;
          if (line) await this.line(line, this.pendingStart);
          else { await this.flushRecords(); await this.commitOffset(this.pendingStart); }
        }
      }
      if (stopped && this.pending.length) {
        this.pendingStart += this.pending.length;
        const line = this.pending.toString("utf8");
        this.pending = Buffer.alloc(0);
        await this.line(line, this.pendingStart);
      }
      if (force || this.oldest && Date.now() - this.oldest >= this.partialFlushMs) await this.flushRecords();
    } finally { await file.close(); }
  }
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, character => {
    switch (character) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case '"': return "&quot;";
      default: return "&#39;";
    }
  });
}

function escapedByteLength(value: string) {
  let bytes = 0;
  for (let index = 0; index < value.length;) {
    const codePoint = value.codePointAt(index)!;
    bytes += codePoint === 0x26 ? 5 : codePoint === 0x3c || codePoint === 0x3e ? 4 : codePoint === 0x22 ? 6 : codePoint === 0x27 ? 5 :
      codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
    index += codePoint > 0xffff ? 2 : 1;
  }
  return bytes;
}

function replyPreview(reply: string) {
  if (escapedByteLength(reply) <= summaryReplyBytes) return escapeHtml(reply);
  const sourceWindow = Math.floor(summaryReplyBytes / 12);
  let prefixEnd = Math.min(sourceWindow, reply.length);
  if (prefixEnd < reply.length && /[\uD800-\uDBFF]/.test(reply[prefixEnd - 1]) && /[\uDC00-\uDFFF]/.test(reply[prefixEnd])) prefixEnd--;
  let suffixStart = Math.max(0, reply.length - sourceWindow);
  if (suffixStart > 0 && /[\uDC00-\uDFFF]/.test(reply[suffixStart]) && /[\uD800-\uDBFF]/.test(reply[suffixStart - 1])) suffixStart++;
  return escapeHtml(reply.slice(0, prefixEnd)) + omittedReplyMarker + escapeHtml(reply.slice(suffixStart));
}

function editHistory(summary: GitSummary | null, log: Diagnostics) {
  const safe = (value: string) => log.redact(value).replace(/[\r\n]+/g, " ");
  const lines = summary ? [
    `Branch: ${safe(summary.branch ?? "detached")}`,
    `Head: ${safe(summary.head)}`,
    `Initial revision: ${safe(summary.base ?? "unavailable")}`,
    `Unpushed commits: ${summary.unpushed}`,
    ...summary.commits.map(commit => `Commit ${safe(commit.sha)} ${safe(commit.subject)}`),
    ...summary.changes.map(change => `${safe(change.status)} ${change.previous ? `${safe(change.previous)} -> ` : ""}${safe(change.path)}` +
      (change.added === undefined ? "" : ` (+${safe(change.added)} -${safe(change.deleted ?? "0")})`)),
    ...summary.untracked.map(path => `Untracked ${safe(path)}`),
    ...(summary.omitted ? [`[${summary.omitted} additional paths omitted]`] : []),
  ] : ["Git edit history unavailable."];
  const included: string[] = [];
  let bytes = Buffer.byteLength("## Edit history\n\n<pre></pre>\n\n");
  for (const line of lines) {
    const safeLine = Buffer.byteLength(line) > 4096 ? "[oversized entry omitted]" : line;
    const size = Buffer.byteLength(escapeHtml(safeLine)) + 1;
    if (bytes + size > 32 * 1024 - 64) { included.push("[additional entries omitted]"); break; }
    included.push(safeLine); bytes += size;
  }
  const raw = included.join("\n");
  inspectCredentials(raw, log, "credential_in_summary");
  return `## Edit history\n\n<pre>${escapeHtml(raw)}</pre>\n\n`;
}

function actionsSummary(saved: SavedRun, resultArtifactId: number, history: string) {
  const { repository, lineage, session_id } = saved.metadata;
  const executionURL = `https://github.com/${repository}/actions/runs/${lineage.run_id}/attempts/${lineage.run_attempt}`;
  const artifactURL = `https://github.com/${repository}/actions/runs/${lineage.run_id}/artifacts/${resultArtifactId}`;
  const checkpoint = saved.latest;
  const reply = saved.response ? `<pre>${replyPreview(saved.response)}</pre>` : `No final reply was saved. Inspect the [execution log](${executionURL}) for details.`;
  const checkpointLine = checkpoint ? `[artifact ${checkpoint.artifact_id}](https://github.com/${repository}/actions/runs/${lineage.run_id}/artifacts/${checkpoint.artifact_id})` : "unavailable";
  const resume = checkpoint ? `## How to resume\n\nOpen **Run workflow** and select:\n\n- \`runner\`: \`${saved.job.runner}\`\n- \`resume-run-id\`: \`${lineage.run_id}\`\n- \`plan\`: answer the question or add the requested context\n` : "";
  return `## Agent’s final reply\n\n${reply}\n\n## Runner outcome\n\n- **Runner:** \`${saved.job.runner}\`\n- **Outcome:** \`${saved.metadata.outcome}\`\n- **Session:** \`${session_id || "unavailable"}\`\n- **Saved checkpoint:** ${checkpointLine}\n- **Full result:** [artifact ${resultArtifactId}](${artifactURL})\n- **Execution log:** [run ${lineage.run_id}, attempt ${lineage.run_attempt}](${executionURL})\n\n${history}${resume}`;
}

export async function main({ github }: { github: any }) {
  let saved: SavedRun | undefined, pendingJob: Job | undefined;
  let contextEmitted = false;
  const log = new Diagnostics({ repository: process.env.GITHUB_REPOSITORY, run_id: process.env.GITHUB_RUN_ID, run_attempt: process.env.GITHUB_RUN_ATTEMPT });
  log.beginGroup("Setup & environment");
  log.useCompactRecords();
  try {
    requireValue(process.platform === "linux" && ["x64", "arm64"].includes(process.arch) && Number(process.versions.node.split(".")[0]) === 24, "unsupported_platform", "setup");
    const selected = process.env.REMOTE_DEV_RUNNER ?? "codex";
    if (selected === "codex" || selected === "claude") log.fields = { ...log.fields, runner: selected, runner_version: versions[selected] };
    const primary = selected === "claude" ? "ANTHROPIC_API_KEY" : "CODEX_API_KEY";
    for (const name of ["REMOTE_DEV_GITHUB_TOKEN", primary, "REMOTE_DEV_PLATFORM_TOKEN", "ACTIONS_RUNTIME_TOKEN", "ACTIONS_ID_TOKEN_REQUEST_TOKEN"]) {
      const value = process.env[name];
      if (value) registerCredential(value, log, name, "credential", false);
    }
    const { runner, token, key, config, mcp } = runnerInputs(process.env);
    log.fields = { ...log.fields, runner, runner_version: versions[runner] };
    log.protect(Buffer.from(`x-access-token:${token}`).toString("base64"));
    let parsedConfig: unknown;
    try { parsedConfig = runner === "codex" ? parseToml(config) : JSON.parse(config); } catch { parsedConfig = undefined; }
    if (parsedConfig) protectConfiguration(parsedConfig, log, "", runner === "codex" ? "CODEX_CONFIG_TOML" : "CLAUDE_SETTINGS_JSON");
    let parsedMcp: unknown;
    try { parsedMcp = mcp ? JSON.parse(mcp) : undefined; } catch { parsedMcp = undefined; }
    if (parsedMcp) protectConfiguration(parsedMcp, log, "", "MCP_CONFIG_JSON");
    for (const [name, raw] of [["CLAUDE_SETTINGS_JSON", runner === "claude" ? config : ""], ["MCP_CONFIG_JSON", mcp]]) {
      if (raw && hasStandaloneJsonSyntaxLines(raw)) log.event("runtime.setup", "WARN", { stage: "configuration", reason: "multiline_json_secret_masking_risk", source: name,
        corrective_action: "Store compact JSON for this Actions secret, for example with jq -c." });
    }
    const workspace = await realpath(process.env.GITHUB_WORKSPACE!), cwd = await realpath(join(workspace, "target"));
    requireValue(cwd.startsWith(workspace + sep), "workspace_escape");
    log.setWorkspace(cwd, [process.env.RUNNER_TEMP ?? ""]);
    const job = pendingJob = await createJob(process.env.RUNNER_TEMP!, key, token, "github-actions[bot]", "41898282+github-actions[bot]@users.noreply.github.com", process.env, runner);
    log.setWorkspace(cwd, [job.root, job.home, job.runnerHome, process.env.RUNNER_TEMP ?? ""]);
    const statePath = join(job.root, "state.json");
    const api = githubAPI(github), repository = process.env.GITHUB_REPOSITORY!;
    const prepared = await prepareExecution({ api, repository, runId: process.env.GITHUB_RUN_ID, attempt: process.env.GITHUB_RUN_ATTEMPT,
      actor: process.env.GITHUB_ACTOR, triggeringActor: process.env.TRIGGERING_ACTOR, ref: process.env.GITHUB_REF,
      resumeRunId: process.env.REMOTE_DEV_RESUME_RUN_ID ?? '', plan: process.env.REMOTE_DEV_PLAN ?? '', root: job.staging, runner, runnerVersion: versions[runner] });
    if (runner === "claude") job.env.CLAUDE_CODE_PROJECT_DIR_NAME = projectStorageKey(repository, prepared.root_run_id);
    const settings = prepared.settings;
    Object.assign(job.env, { GIT_AUTHOR_NAME: settings.git_author_name, GIT_COMMITTER_NAME: settings.git_author_name,
      GIT_AUTHOR_EMAIL: settings.git_author_email, GIT_COMMITTER_EMAIL: settings.git_author_email });
    const git = new TaskGit(cwd, job.env, log);
    requireValue((await git.run(["rev-parse", "--show-toplevel"])).trim() === cwd && !await git.changedPaths(), "unsafe_worktree");
    const origin = (await git.run(["remote", "get-url", "origin"])).trim();
    requireValue([`https://github.com/${repository}.git`, `https://github.com/${repository}`].includes(origin), "origin_identity_mismatch");
    const restored = prepared.restored;
    const configureCheckout = () => configure(job, config, log, mcp, cwd);
    if (restored) await restoreCheckpoint(job, restored.root, restored.manifest, git, log, configureCheckout);
    else await configureCheckout();
    await installTools(job, resolve(import.meta.dirname, ".."), log);
    const skillAPI = async (path: string) => parseJson(await command("gh", ["api", path.replace(/^\//, '')], { cwd, env: job.env, stage: "skill_source", log }), "skills");
    const skills = await resolveSkills(skillAPI, settings.skills);
    for (const [index, skill] of skills.entries()) await installSkillSource(job, skill, await fetchSkillSource(job, skill, index, log), index, log);
    const userInstructions = settings.user_instructions_url ? await fetchInstructions(settings.user_instructions_url) : null;
    await installUserInstructions(job, userInstructions, log);
    const metadata: CheckpointInput = { repository, ...await git.snapshot(), session_id: restored?.manifest.session_id ?? '',
      root_run_id: prepared.root_run_id, activation_run_id: prepared.activation_run_id, auto_count: prepared.auto_count, operator: prepared.operator, provider_sha: process.env.REMOTE_DEV_PROVIDER_SHA,
      lineage: prepared.lineage, outcome: "running", workspace: cwd };
    let initialGit: SavedRun["initial_git"];
    try { initialGit = { sha: await git.head(), branch: await git.currentBranch() }; }
    catch { log.event("runtime.summary_git", "INFO", { stage: "setup", outcome: "unavailable" }); }
    saved = { job, metadata, secrets: log.protectedValues, response: '', latest: null, initial_git: initialGit };
    const state = saved;
    let writes = Promise.resolve();
    const persist = () => { writes = writes.then(async () => {
      await writeFile(statePath + ".tmp", JSON.stringify(state), { mode: 0o600 }); await rename(statePath + ".tmp", statePath);
    }); return writes; };
    await persist(); core.setOutput("state-path", statePath);
    state.watcher_pid = await startSnapshots(statePath, job); await persist();
    const tailer = new SnapshotLogTailer(job.root, log, 0, async offset => { state.snapshots_log_offset = offset; await persist(); });
    let tailError: unknown;
    const logs = setInterval(() => {
      if (!tailError) void tailer.flush().catch(error => { tailError ??= error; });
    }, 1000); logs.unref();
    log.fields = { ...log.fields, session_id: metadata.session_id || null, root_run_id: metadata.root_run_id, continuation_count: metadata.auto_count,
      project_config_sha256: prepared.config_sha256, skills, user_instructions_sha256: userInstructions?.sha256 ?? null };
    log.emitContext(); contextEmitted = true;
    let prompt = process.env.REMOTE_DEV_PLAN ?? '';
    if (restored) prompt = resumedPrompt(restored.manifest, prepared.automatic_recovery, prompt);
    log.endGroup();
    log.beginBuffering();
    let result;
    try {
      result = await drive({ job, cwd, log, plan: prompt, session: restored?.manifest.session_id,
        state: async value => {
          if (value.session) { metadata.session_id = value.session; log.fields.session_id = value.session; }
          if (value.control) state.control = { directory: value.control.directory, nonce: value.control.nonce };
          metadata.outcome = value.outcome as CheckpointInput['outcome']; await persist();
        } });
    } finally {
      clearInterval(logs);
      try { if (!tailError) await tailer.flush(true); }
      finally { log.endBuffering(); }
      if (tailError) throw tailError;
    }
    state.response = result.response;
    state.skip_final_snapshot = result.reason === "snapshot_resume_failed";
    recordRecoveryReason(state.metadata, result, state.skip_final_snapshot);
    await persist();
    core.setOutput("session-id", result.session ?? ''); core.setOutput("status", result.outcome);
    if (result.outcome !== 'completed') core.setFailed(`Native invocation ${result.outcome}; inspect the saved session and diagnostics.`);
  } catch (error) {
    if (!contextEmitted) { log.ensureGroup("Setup & environment (continued)"); log.emitContext(); }
    log.failure(error, saved?.latest);
    if (saved) {
      saved.metadata.outcome = "failed";
      delete saved.metadata.recovery_reason;
      const statePath = join(saved.job.root, "state.json");
      await writeFile(statePath + ".tmp", JSON.stringify(saved), { mode: 0o600 });
      await rename(statePath + ".tmp", statePath);
    }
    if (!saved && pendingJob) await removeJob(pendingJob.root);
    core.setFailed("Remote development failed; inspect structured diagnostics.");
  } finally {
    log.endGroup();
  }
}

function filesystemCause(error: unknown) {
  const { code, syscall } = (error instanceof Error ? error : {}) as NodeJS.ErrnoException;
  return { errno_code: typeof code === "string" && /^E[A-Z0-9]{2,25}$/.test(code) ? code : null,
    syscall: syscall && ["chmod", "lstat", "mkdir", "open", "read", "rename", "rmdir", "scandir", "unlink", "write"].includes(syscall) ? syscall : null };
}

export async function finish({ github, statePath }: { github: any; statePath: string }) {
  if (!statePath) return;
  const log = new Diagnostics({ repository: process.env.GITHUB_REPOSITORY, run_id: process.env.GITHUB_RUN_ID, run_attempt: process.env.GITHUB_RUN_ATTEMPT });
  let path: string;
  try {
    const temporary = await realpath(process.env.RUNNER_TEMP!);
    path = resolve(statePath);
    if (!path.startsWith(temporary + sep) || !/\/remote-dev-task-[^/]+\/state\.json$/.test(path) || (await lstat(path)).isSymbolicLink()) {
      throw new RunnerError("unsafe_final_state", "final_export");
    }
  } catch (error: any) {
    if (error.code === "ENOENT") return;
    log.failure(new RunnerError("unsafe_final_state", "final_export"));
    core.setFailed("Final session state was rejected; inspect structured diagnostics.");
    return;
  }
  let saved: SavedRun;
  try { saved = JSON.parse(await readFile(path, "utf8")); }
  catch (error: any) { if (error.code === 'ENOENT') return; throw error; }
  const host = process.env.RUNNER_ENVIRONMENT;
  const runnerEnvironment = host === "github-hosted" || host === "self-hosted" ? host : "unknown";
  const { lineage } = saved.metadata;
  log.fields = { repository: saved.metadata.repository, runner: saved.job.runner, runner_version: versions[saved.job.runner],
    run_id: lineage.run_id, run_attempt: lineage.run_attempt, session_id: saved.metadata.session_id || null, workflow_sha: lineage.workflow_sha,
    root_run_id: saved.metadata.root_run_id, runner_environment: runnerEnvironment };
  log.setWorkspace(saved.metadata.workspace, [saved.job.root, saved.job.home, saved.job.runnerHome, process.env.RUNNER_TEMP ?? ""]);
  for (const secret of saved.secrets) log.protect(secret);
  log.beginGroup("Final session diagnostics");
  log.emitContext();
  const api = githubAPI(github), uploadContext = { api, metadata: saved.metadata };
  const exportStarted = Date.now();
  let finalCheckpoint: DurableCheckpoint | null = null, resultArtifactId: number | null = null, exportSucceeded = false;
  try {
    let stopped = false;
    try { await waitSnapshots(saved); stopped = true; }
    finally {
      let offset = saved.snapshots_log_offset ?? 0;
      try {
        const stored = (await readFile(join(saved.job.root, "snapshots.offset"), "utf8")).trim();
        requireValue(/^\d+$/.test(stored) && Number.isSafeInteger(Number(stored)), "invalid_snapshot_log_offset", "checkpoint");
        offset = Math.max(offset, Number(stored));
      } catch (error: any) { if (error.code !== "ENOENT") throw error; }
      const tailer = new SnapshotLogTailer(saved.job.root, log, offset, async value => { saved.snapshots_log_offset = value; }, true);
      await tailer.flush(true, stopped);
    }
    saved.latest = await latestSnapshot(saved.job);
    if (saved.skip_final_snapshot) {
      log.event("checkpoint.final", "WARN", { outcome: "skipped", reason: "snapshot_resume_failed", last_durable_checkpoint: saved.latest,
        native_outcome: saved.metadata.outcome, recovery_reason: null });
    } else if (saved.metadata.session_id) {
      finalCheckpoint = await saveSnapshot(saved, log, api, (job, name, files, root, diagnostics) =>
        uploadSnapshot(job, name, files, root, diagnostics, undefined, { ...uploadContext, kind: "checkpoint" }));
      saved.latest = finalCheckpoint;
    } else {
      log.event("checkpoint.final", "INFO", { outcome: "skipped", reason: "session_not_started", last_durable_checkpoint: saved.latest,
        native_outcome: saved.metadata.outcome, recovery_reason: null });
    }
    if (saved.latest) core.setOutput("artifact-id", saved.latest.artifact_id);
    inspectCredentials(saved.response, log, "credential_in_result");
    const file = join(saved.job.exports, "record.json"); await writeFile(file, JSON.stringify({ runner: saved.job.runner, runner_version: versions[saved.job.runner], response: saved.response, native_outcome: saved.metadata.outcome, session_id: saved.metadata.session_id }), { mode: 0o600 });
    const result = await uploadSnapshot(saved.job, `remote-dev-result-r${lineage.run_id}-a${lineage.run_attempt}`, [file], saved.job.exports,
      log, undefined, { ...uploadContext, kind: "record" });
    resultArtifactId = result.id;
    let gitSummary: GitSummary | null = null;
    try { gitSummary = await new TaskGit(saved.metadata.workspace, saved.job.env, log).summary(saved.initial_git?.sha); }
    catch (error) { log.event("runtime.summary_git", "INFO", { stage: "final_export", outcome: "unavailable",
      reason: error instanceof RunnerError ? error.reason : "git_summary_failed" }); }
    const summary = actionsSummary(saved, resultArtifactId, editHistory(gitSummary, log));
    inspectCredentials(summary, log, "credential_in_summary");
    requireValue(Buffer.byteLength(summary) < summaryByteLimit, "summary_size_limit", "final_export");
    await core.summary.addRaw(summary).write();
    exportSucceeded = true;
  } catch (error) {
    const failure = error instanceof RunnerError ? error : null;
    log.event("runtime.failed", "ERROR", { stage: failure?.stage ?? "final_export", reason: failure?.reason ?? "final_export_failed",
      cause_reason: failure?.details.cause_reason, ...filesystemCause(error), outcome: "failed",
      last_durable_checkpoint: saved.latest, result_artifact_id: resultArtifactId, elapsed_ms: Date.now() - exportStarted,
      corrective_action: "Inspect the export failure and use the last completed snapshot to resume by run ID." });
    core.setFailed("Final session export failed; retain the last completed snapshot.");
  } finally {
    const cleanupStarted = Date.now();
    const fields = { stage: "cleanup", native_outcome: saved.metadata.outcome, export_succeeded: exportSucceeded,
      last_durable_checkpoint: saved.latest, final_checkpoint_artifact_id: finalCheckpoint?.artifact_id ?? null, result_artifact_id: resultArtifactId };
    if (!exportSucceeded) log.beginBuffering("Cleanup diagnostics");
    log.event("runtime.cleanup", "INFO", { ...fields, outcome: "started" });
    try {
      await removeJob(saved.job.root);
      log.event("runtime.cleanup", "INFO", { ...fields, outcome: "completed", elapsed_ms: Date.now() - cleanupStarted });
    } catch (error) {
      const warning = runnerEnvironment === "github-hosted" && exportSucceeded && finalCheckpoint !== null && resultArtifactId !== null;
      log.event(warning ? "runtime.cleanup" : "runtime.failed", warning ? "WARN" : "ERROR", {
        ...fields, ...filesystemCause(error), reason: "job_cleanup_failed", outcome: "failed", elapsed_ms: Date.now() - cleanupStarted,
        corrective_action: warning ? "The artifacts are available. Inspect directory ownership and permissions if cleanup fails again."
          : "Inspect runner directory ownership and permissions before reusing the runner. Resume by run ID if a completed snapshot is available.",
      });
      if (!warning) core.setFailed("Temporary job cleanup failed; inspect structured diagnostics.");
    } finally {
      if (!exportSucceeded) log.endBuffering("Cleanup diagnostics");
      log.endGroup();
    }
  }
}
