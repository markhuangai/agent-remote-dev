import assert from "node:assert/strict";
import { appendFile, chmod, copyFile, cp, lstat, mkdir, readFile, readdir, rename, rmdir, symlink, unlink, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createServer } from "node:http";
import { zstdCompressSync } from "node:zlib";
import test from "node:test";
import { hash, RunnerError, skillSources } from "../.build/contracts.js";
import { configure, fetchSkillSource, installTools, installSkillSource, safeTree, removeJob } from "../.build/setup.js";
import { exportCheckpoint, durableCheckpoint, inspectCredentials } from "../.build/checkpoint.js";
import { saveSnapshot, uploadSnapshot, watchSnapshots } from "../.build/checkpoint-worker.js";
import { TaskGit } from "../.build/git.js";
import { command } from "../.build/process.js";
import { Diagnostics } from "../.build/diagnostics.js";
import { SnapshotLogTailer, recordRecoveryReason, resumedPrompt } from "../.build/main.js";
import { classifyCodexError, classifyClaudeError, classifyFailure, hasLimitPrefix } from "../.build/provider-errors.js";
import { activityPath, boundedLines, parseApplyPatch, summarizeCommand } from "../.build/activity.js";
import { restoreCheckpoint, validateCheckpoint } from "../.build/resume.js";
import { exec, executionSource, checkpoint, sessionId, fixture, logger, portableSource, repository, root, skillTransport, lineage } from "./helpers.mjs";

const plan = "Implement the fixture plan.\n";
test("provider classification gives permanent failures precedence over transient wrappers", () => {
  for (const message of ["HTTP 503 upstream failure", "status 529 overloaded", "HTTP 408 timeout", "HTTP 429 rate limited",
    "stream disconnected before completion: upstream stream closed before a terminal event (last event: response.output_item.added)",
    "stream disconnected before completion: Transport error: network error: error decoding response body",
    "websocket idle timeout", "connection reset by peer"]) assert.equal(classifyCodexError(message).transient, true, message);
  for (const message of ["HTTP 401 unauthorized", "HTTP 403 forbidden", "HTTP 400 invalid request", "HTTP 404 model not found",
    "HTTP 429 insufficient_quota", "stream disconnected before completion: HTTP 503 billing error", "maximum context window exceeded",
    "upstream stream closed before a terminal event: context_length_exceeded", "HTTP 429 usage_limit_error", "HTTP 503 upstream; HTTP 401",
    "stream disconnected before completion:"]) assert.equal(classifyCodexError(message).transient, false, message);
  assert.equal(classifyCodexError("HTTP 503 upstream; HTTP 401").http_status, 401);
  assert.equal(classifyClaudeError({ reason: "server_error" }).transient, true);
  assert.equal(classifyClaudeError({ reason: "overloaded" }).transient, true);
  assert.equal(classifyClaudeError({ reason: "rate_limit" }).transient, false);
  assert.equal(classifyClaudeError({ reason: "rate_limit", retryHint: true }).transient, true);
  assert.equal(classifyClaudeError({ reason: "rate_limit", status: 429, rateLimitRejected: true }).transient, false);
  assert.equal(classifyClaudeError({ reason: "server_error", terminalReason: "budget_exhausted" }).transient, false);
  assert.equal(classifyClaudeError({ reason: "server_error", startupFailure: "proxy_invalid" }).transient, false);
  assert.equal(classifyClaudeError({ reason: "unknown" }).transient, false);
  assert.equal(hasLimitPrefix("You've hit your limit", ["You've hit your"], []), true);
  const transient = classifyCodexError("HTTP 503 unavailable");
  for (const [state, reason] of [[{ observed: false, identityChanged: false }, "session_not_started"],
    [{ observed: true, identityChanged: true }, "conversation_identity_changed"],
    [{ observed: true, identityChanged: false, completed: true }, "turn_already_completed"],
    [{ observed: true, identityChanged: false, writesLost: true }, "session_writes_lost"],
    [{ observed: true, identityChanged: false, quiescent: false }, "non_quiescent_or_signal_exit"]]) {
    assert.equal(classifyFailure(transient, state).auto_continue_rejection_reason, reason);
  }
  assert.equal(classifyFailure(transient, { observed: true, identityChanged: false }).recovery_reason, "native_provider_transient");
});

test("automatic recovery prompt gives static side-effect guidance", () => {
  const prompt = resumedPrompt({ checkpoint_sha: "a".repeat(40), omitted_work: true }, "native_provider_transient", "");
  assert.match(prompt, /Verify published work and any external effects/);
  assert.match(prompt, /Uncommitted or unpushed work/);
  assert.doesNotMatch(prompt, /provider response/i);
});

test("final checkpoint metadata records only eligible failures with a session", () => {
  for (const [outcome, session, reason, skipped, expected] of [
    ["failed", sessionId, "native_provider_transient", false, "native_provider_transient"],
    ["failed", sessionId, "native_worker_sigkill", false, "native_worker_sigkill"],
    ["failed", null, "native_provider_transient", false, undefined],
    ["completed", sessionId, "native_provider_transient", false, undefined],
    ["failed", sessionId, "native_provider_transient", true, undefined],
    ["failed", sessionId, "command_failed", false, undefined],
  ]) {
    const metadata = checkpoint({ recovery_reason: "native_worker_sigkill" });
    recordRecoveryReason(metadata, { outcome, session, reason }, skipped);
    assert.equal(metadata.recovery_reason, expected);
  }
});
async function history(f, content = "completed turn") {
  if (f.job.runner === "claude") {
    const project = join(f.job.runnerHome, "projects", f.job.env.CLAUDE_CODE_PROJECT_DIR_NAME);
    await mkdir(project, { recursive: true });
    await writeFile(join(project, sessionId + ".jsonl"), JSON.stringify({ sessionId, type: "user", message: content }) + "\n");
  } else {
    await mkdir(join(f.job.runnerHome, "sessions"));
    const data = JSON.stringify({ type: "session_meta", payload: { id: sessionId, session_id: sessionId } }) + "\n" + JSON.stringify({ type: "response_item", payload: { text: content } }) + "\n";
    await writeFile(join(f.job.runnerHome, "sessions/rollout.jsonl"), data);
  }
}
test("configuration is isolated, rejects invalid TOML, and prevents permission and storage overrides", async (t) => {
  const f = await fixture(t);
  await configure(f.job, 'model="gpt-5.1"\nsandbox_mode="read-only"\nsqlite_home="/outside"\n[model_providers.fixture]\nenv_key="CODEX_API_KEY"\nhttp_headers={authorization="fixture-config-secret-4631"}', f.log);
  for (const [name, content] of Object.entries(f.hostFiles)) assert.equal(await readFile(join(f.host,name),"utf8"), content);
  assert.notEqual(f.job.env.HOME,f.host);assert.notEqual(f.job.env.CODEX_HOME,join(f.host,".codex"));
  const data = await readFile(join(f.job.runnerHome, "config.toml"), "utf8");
  assert.doesNotMatch(data, /\/outside|sandbox_mode/);
  assert.ok(data.includes(f.job.runnerHome));
  assert.ok(f.log.protectedValues.includes("fixture-config-secret-4631"));
  assert.ok(!f.log.protectedValues.includes("CODEX_API_KEY"));
  await assert.rejects(configure(f.job, "[invalid", f.log), { reason: "invalid_codex_config" });
});
test("shared and repository MCP JSON failures identify the source without configuration contents", async t => {
  for (const runner of ["codex", "claude"]) {
    const f = await fixture(t, runner), r = await repository(f);
    const config = runner === "codex" ? 'model="gpt-5.1"' : "{}";
    const malformed = '{"mcpServers":{"sensitive-mcp-text-5742":';
    const assertFailure = source => error => {
      assert.equal(error.reason, "invalid_mcp_config");
      f.log.failure(error);
      const { event, stage, level, source: observed } = f.records.at(-1);
      assert.deepEqual({ event, stage, level, source: observed }, { event: "runtime.failed", stage: "configuration", level: "ERROR", source });
      assert.doesNotMatch(JSON.stringify(f.records), /sensitive-mcp-text-5742/);
      return true;
    };
    await assert.rejects(configure(f.job, config, f.log, malformed, r.cwd), assertFailure("MCP_CONFIG_JSON"));
    await writeFile(join(r.cwd, ".mcp.json"), malformed);
    await assert.rejects(configure(f.job, config, f.log, "", r.cwd), assertFailure(".mcp.json"));
  }
});
test("actual Skills CLI installs complete pinned portable packages outside project and host skill scope", async (t) => {
  const f = await fixture(t), source = await portableSource(f);
  const before = await readdir(root);
  await installSkillSource(f.job, executionSource, source, 0, f.log);
  for (const name of executionSource.names) {
    const sourceFiles = await safeTree(join(source, "skills", name));
    for (const path of sourceFiles) {
      const target = path.replace(join(source,"skills"), join(f.job.runnerHome,"skills"));
      assert.deepEqual(await readFile(target), await readFile(path));
    }
  }
  assert.deepEqual(await readdir(root), before);
  await assert.rejects(installSkillSource(f.job, { ...executionSource, names:["missing-skill"] }, source, 1, f.log));
});
test("runtime reuses the provider's package-managed Codex without a second installation", async t => {
  const f = await fixture(t);
  await installTools(f.job, root, f.log);
  assert.equal(f.job.tools, root);
  assert.equal(f.records.find(record => record.stage === 'runner_version').outcome, 'success');
});
for(const scenario of ["valid","revision","traversal","symlink"]) test(`actual skill source fetch enforces ${scenario} archive/revision decisions`,async(t)=>{
  const f=await fixture(t),archive=join(f.temporary,"source.tar.gz");
  await exec("python3",["-c",`import io,sys,tarfile
with tarfile.open(sys.argv[1],"w:gz") as archive:
    item=tarfile.TarInfo("root/../escape" if sys.argv[2]=="traversal" else "root/file.txt")
    if sys.argv[2]=="symlink":
        item.type=tarfile.SYMTYPE;item.linkname="../../outside";archive.addfile(item)
    else:
        data=b"fixture source";item.size=len(data);archive.addfile(item,io.BytesIO(data))
`,archive,scenario]);
  await skillTransport(f,scenario==="revision"?"a".repeat(40):executionSource.revision,archive);
  const operation=()=>fetchSkillSource(f.job,executionSource,0,f.log);
  if(scenario==="valid")assert.equal(await readFile(join(await operation(),"file.txt"),"utf8"),"fixture source");
  else await assert.rejects(operation(),{reason:{revision:"skill_revision_mismatch",traversal:"unsafe_skill_archive",symlink:"linked_skill_archive"}[scenario]});
});
test("safe tree and cleanup refuse export symlinks and never follow cleanup links into other files", async (t) => {
  const f = await fixture(t), outside = join(f.temporary, "outside");
  await writeFile(outside, "retain"); await symlink(outside, join(f.job.home, "alias"));
  await assert.rejects(safeTree(f.job.home), { reason: "symlink_not_allowed" });
  await removeJob(f.job.home);
  assert.equal(await readFile(outside, "utf8"), "retain");
});

async function readOnlyCache(home) {
  const module = join(home, "go/pkg/mod/example@v1");
  await mkdir(module, { recursive: true });
  await writeFile(join(module, "README"), "module cache", { mode: 0o444 });
  for (const name of ["go/pkg/mod/example@v1", "go/pkg/mod", "go/pkg", "go"]) await chmod(join(home, name), 0o555);
}

test("job cleanup repairs a read-only module cache and preserves the target of an outside directory link", async t => {
  assert.notEqual(process.geteuid(), 0);
  const f = await fixture(t);
  const outside = join(f.temporary, "outside");
  await mkdir(outside);
  await writeFile(join(outside, "sentinel"), "retain");
  await chmod(outside, 0o555);
  await symlink(outside, join(f.job.home, "alias"));
  await readOnlyCache(f.job.home);
  await removeJob(f.job.home);
  await assert.rejects(lstat(f.job.home), { code: "ENOENT" });
  assert.equal((await lstat(outside)).mode & 0o777, 0o555);
  assert.equal(await readFile(join(outside, "sentinel"), "utf8"), "retain");
});

test("job cleanup can remove an empty read-only foreign-owned directory from a writable parent", async t => {
  const f = await fixture(t);
  const foreign = join(f.job.home, "foreign-owned");
  await exec("sudo", ["-n", "install", "-d", "-o", "root", "-m", "0555", foreign]);
  const stat = await lstat(foreign);
  assert.notEqual(stat.uid, process.geteuid());
  assert.equal(stat.mode & 0o777, 0o555);
  await removeJob(f.job.home);
  await assert.rejects(lstat(f.job.home), { code: "ENOENT" });
});

for (const variant of ["kill", "exit-137", "terminal", "cancel"]) test(`native worker recovery distinguishes ${variant} using the real supervisor`, async t => {
  const f = await fixture(t);
  const processModule = JSON.stringify(new URL("../.build/process.js", import.meta.url).href);
  const script = `
    import { command } from ${processModule};
    const variant = process.argv[1];
    const snippets = {
      kill: 'process.kill(process.pid, "SIGKILL")',
      "exit-137": 'process.exit(137)',
      terminal: 'console.log("terminal"); process.kill(process.pid, "SIGKILL")',
      cancel: 'process.on("SIGTERM", () => {}); console.log("ready"); setInterval(() => {}, 1000)',
    };
    let terminal = false;
    try {
      await command(process.execPath, ["-e", snippets[variant]], {
        cwd: process.cwd(), env: process.env, timeoutMs: 8000, stage: "codex",
        nativeSessionUnfinished: () => !terminal,
        onLine(line) {
          if (line === "terminal") terminal = true;
          if (line === "ready") process.kill(process.pid, "SIGTERM");
        },
      });
    } catch (error) {
      console.log(JSON.stringify({ reason: error.reason, ...error.details }));
    }
  `;
  const { stdout } = await exec(process.execPath, ["--input-type=module", "-e", script, variant], { env: f.job.env });
  const evidence = JSON.parse(stdout);
  assert.equal(evidence.reason, { kill: "native_worker_sigkill", "exit-137": "command_failed",
    terminal: "command_failed", cancel: "command_cancelled" }[variant]);
  if (variant === "kill") {
    assert.equal(evidence.worker_exit_code, -9);
    assert.equal(evidence.quiescent, true);
    assert.equal(evidence.output_closed, true);
  }
});

test("checkpoint exports exact session state and consistent SQLite backups, excluding secrets and caches", async (t) => {
  const f = await fixture(t); await history(f);
  const db = new DatabaseSync(join(f.job.runnerHome, "state_5.sqlite"));
  db.exec("PRAGMA journal_mode=WAL; CREATE TABLE progress (value TEXT); INSERT INTO progress VALUES ('durable'); CREATE TABLE threads (id TEXT, rollout_path TEXT);");
  db.prepare("INSERT INTO threads VALUES (?, ?)").run(sessionId, join(f.job.runnerHome, "sessions/rollout.jsonl"));
  await writeFile(join(f.job.runnerHome, "auth.json"), f.job.env.CODEX_API_KEY);
  await writeFile(join(f.job.runnerHome, "config.toml"), f.job.env.CODEX_API_KEY);
  await mkdir(join(f.job.runnerHome, "cache")); await writeFile(join(f.job.runnerHome, "cache/code.txt"), "excluded source");
  const output = await exportCheckpoint(f.job, checkpoint(), f.log);
  assert.equal(db.prepare("PRAGMA journal_mode").get().journal_mode, "wal");
  assert.equal(db.prepare("SELECT value FROM progress").get().value, "durable");
  db.close();
  const saved = new DatabaseSync(join(output.root, "codex/state_5.sqlite"), { readOnly: true });
  assert.equal(saved.prepare("SELECT value FROM progress").get().value, "durable"); saved.close();
  const manifest = JSON.parse(await readFile(join(output.root, "manifest.json"), "utf8"));
  assert.equal(manifest.runner_version, JSON.parse(await readFile(join(root, 'package.json'))).dependencies['@openai/codex']);
  assert.equal(manifest.session_id, sessionId); assert.ok(!('authorization' in manifest));
  assert.ok(manifest.files.every((entry) => !/auth|config|cache|\.git/.test(entry.path)));
  assert.ok(output.files.every((file) => !/-(wal|shm)$/.test(file)));
});
for (const compressed of [false, true]) test(`credential exclusion scans ${compressed ? "compressed" : "plain"} real conversation content`, async (t) => {
  const f = await fixture(t); await history(f, f.job.env.CODEX_API_KEY);
  if (compressed) {
    const path = join(f.job.runnerHome, "sessions/rollout.jsonl");
    await writeFile(path + ".zst", zstdCompressSync(await readFile(path)));
    const { unlink } = await import("node:fs/promises"); await unlink(path);
  }
  await assert.rejects(exportCheckpoint(f.job, checkpoint(), f.log), { reason: "credential_in_checkpoint" });
});
for (const storage of ["TEXT", "BLOB"]) test("checkpoint rejects a credential reconstructed across real SQLite " + storage + " overflow pages before upload", async (t) => {
  const f = await fixture(t); await history(f);
  const secret = "fixture-sqlite-credential-" + "x".repeat(1500) + "-9371";
  f.log.protect(secret);
  const path = join(f.job.runnerHome, "state_5.sqlite"), db = new DatabaseSync(path);
  db.exec("PRAGMA page_size=512; CREATE TABLE protected_value (value " + storage + ");");
  db.prepare("INSERT INTO protected_value VALUES (?)").run(storage === "TEXT" ? secret : Buffer.from(secret));
  assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
  const stored = db.prepare("SELECT value FROM protected_value").get().value;
  assert.equal(storage === "TEXT" ? stored : Buffer.from(stored).toString(), secret);
  db.close();
  assert.equal((await readFile(path)).includes(Buffer.from(secret)), false);
  const previous = { sequence: 3, artifact_id: 9, checkpoint_sha: "a".repeat(40) };
  let uploaded = false;
  await assert.rejects(durableCheckpoint(f.job, checkpoint({ previous }), f.log, async () => {
    uploaded = true; return { id: 10 };
  }), { reason: "credential_in_checkpoint" });
  assert.equal(uploaded, false); assert.deepEqual(previous, { sequence: 3, artifact_id: 9, checkpoint_sha: "a".repeat(40) });
  assert.ok(!f.records.some((record) => record.event === "checkpoint.complete"));
});
for (const compressed of [false, true]) test("checkpoint decodes escaped credentials in " + (compressed ? "compressed" : "plain") + " JSONL before upload", async (t) => {
  const f = await fixture(t), secret = 'fixture-"escaped\\credential\n9371';
  await configure(f.job, "[mcp_servers.fixture.env]\nPASSWORD=" + JSON.stringify(secret) + "\n", f.log);
  await history(f, secret);
  const path = join(f.job.runnerHome, "sessions/rollout.jsonl"), data = await readFile(path);
  assert.equal(data.includes(Buffer.from(secret)), false);
  if (compressed) { await writeFile(path + ".zst", zstdCompressSync(data)); await unlink(path); }
  const previous = { sequence: 3, artifact_id: 9, checkpoint_sha: "a".repeat(40) };
  let uploaded = false;
  await assert.rejects(durableCheckpoint(f.job, checkpoint({ previous }), f.log, async () => {
    uploaded = true; return { id: 10 };
  }), { reason: "credential_in_checkpoint" });
  assert.equal(uploaded, false); assert.equal(previous.artifact_id, 9);
  assert.ok(!f.records.some((record) => record.event === "checkpoint.complete"));
});
test("checkpoint rejects escaped manifest credentials before upload and retains its preceding receipt", async (t) => {
  const f = await fixture(t), secret = 'fixture-"manifest\\credential\n9371';
  await configure(f.job, "[mcp_servers.fixture.env]\nPASSWORD=" + JSON.stringify(secret) + "\n", f.log); await history(f);
  const previous = { sequence: 3, artifact_id: 9, checkpoint_sha: "a".repeat(40) };
  const input = checkpoint({ previous, operator: secret });
  assert.equal(JSON.stringify(input).includes(secret), false);
  let uploaded = false;
  await assert.rejects(durableCheckpoint(f.job, input, f.log, async () => {
    uploaded = true; return { id: 10 };
  }), { reason: "credential_in_manifest" });
  assert.equal(uploaded, false); assert.equal(previous.artifact_id, 9);
  assert.ok(!f.records.some((record) => record.event === "checkpoint.complete"));
});
for (const [scheme, header, provider, encoding] of [["Bearer", "authorization", false, "utf8"], ["Basic", "Authorization", true, "utf8"], ["Basic", "Proxy-Authorization", false, "latin1"]]) {
  for (const representation of scheme === "Basic" ? ["payload", "pair", "password"] : ["payload"]) for (const storage of ["JSONL", "SQLite"]) test("configured " + scheme + " " + header + " " + representation + " is excluded from real " + storage + " state before upload", async (t) => {
    const f = await fixture(t);
    const password = "fixture-auth-pässword:8721", pair = "fixture-auth-user:" + password;
    const payload = scheme === "Bearer" ? "fixture-mcp-token-8721" : Buffer.from(pair, encoding).toString("base64");
    const content = { payload, pair, password }[representation];
    const value = (scheme === "Bearer" ? "bEaReR" : scheme) + " " + payload;
    const section = provider ? "model_providers.fixture" : "mcp_servers.fixture";
    const config = provider ? 'model="gpt-5.1"\nmodel_provider="fixture"\n[model_providers.fixture]\nname="Fixture provider"\nbase_url="https://example.invalid/v1"\nwire_api="responses"\nenv_key="CODEX_API_KEY"\n' : '[mcp_servers.fixture]\nurl="https://example.invalid/mcp"\n';
    await configure(f.job, config + "[" + section + ".http_headers]\n" + JSON.stringify(header) + "=" + JSON.stringify(value) + "\n", f.log);
    assert.ok(f.log.protectedValues.includes(value));
    await history(f, storage === "JSONL" ? content : "Completed fixture turn");
    if (storage === "SQLite") {
      const db = new DatabaseSync(join(f.job.runnerHome, "state_5.sqlite"));
      try { db.exec("CREATE TABLE tool_error (value TEXT)"); db.prepare("INSERT INTO tool_error VALUES (?)").run(content); }
      finally { db.close(); }
    }
    const previous = { sequence:3, artifact_id:9, checkpoint_sha:"a".repeat(40) };
    let uploaded = false;
    await assert.rejects(durableCheckpoint(f.job, checkpoint({ previous }), f.log, async () => {
      uploaded = true; return { id:10 };
    }), error => { assert.equal(error.reason, "credential_in_checkpoint"); f.log.failure(error, previous); return true; });
    assert.equal(uploaded, false); assert.deepEqual(previous, { sequence:3, artifact_id:9, checkpoint_sha:"a".repeat(40) });
    assert.ok(!f.records.some(record => record.event === "checkpoint.complete"));
    assert.ok(!JSON.stringify(f.records).includes(content));
  });
}
test("non-secret environment flags permit export while configured MCP credentials remain excluded",async(t)=>{
  const f=await fixture(t),secret="fixture-mcp-credential-9371";
  await configure(f.job,`[mcp_servers.fixture.env]\nDEBUG="1"\nMCP_API_TOKEN="${secret}"\n`,f.log);
  assert.ok(!f.log.protectedValues.includes("1"));assert.ok(f.log.protectedValues.includes(secret));
  await history(f,"Ordinary completed turn 1");
  await exportCheckpoint(f.job,checkpoint(),f.log);
  const path=join(f.job.runnerHome,"sessions/rollout.jsonl");
  await writeFile(path,await readFile(path,"utf8")+JSON.stringify({type:"response_item",payload:{text:secret}})+"\n");
  await assert.rejects(exportCheckpoint(f.job,checkpoint({previous:{sequence:1,artifact_id:4,checkpoint_sha:"a".repeat(40)}}),f.log),{reason:"credential_in_checkpoint"});
});
test("undelimited MCP environment credentials are protected without rejecting ordinary settings", async t => {
  const f = await fixture(t), secret = "fixture-postgres-password-6218";
  const mcp = value => JSON.stringify({ mcpServers: { postgres: { command: "node", env: {
    PGPASSWORD: value, MONKEY: "x", TOKENIZERS_PARALLELISM: "false", KEYBOARD: "us",
  } } } });
  await assert.rejects(configure(f.job, 'model="gpt-5.1"', f.log, mcp("x!")), { reason: "invalid_configured_credential" });
  assert.ok(!f.log.protectedValues.includes("x!"));
  await configure(f.job, 'model="gpt-5.1"', f.log, mcp(secret));
  assert.ok(f.log.protectedValues.includes(secret));
  for (const value of ["x", "false", "us"]) assert.ok(!f.log.protectedValues.includes(value));
  f.log.line(`Fixture output: ${secret}`);
  assert.doesNotMatch(f.lines.join("\n"), /fixture-postgres-password-6218/);
  await history(f, secret);
  await assert.rejects(exportCheckpoint(f.job, checkpoint(), f.log), { reason: "credential_in_checkpoint" });
  assert.throws(() => inspectCredentials(secret, f.log, "credential_in_result"), { reason: "credential_in_result" });
});
test("upload failures, missing sessions, drift and size limits never advance the last durable receipt", async (t) => {
  const f = await fixture(t); await history(f);
  await assert.rejects(exportCheckpoint(f.job, checkpoint(), f.log, 1), { reason: "checkpoint_size_limit" });
  await assert.rejects(exportCheckpoint(f.job, checkpoint({ previous: { sequence: 1, artifact_id: 4, checkpoint_sha: "a".repeat(40) }, session_id:"missing" }), f.log), { reason: "missing_session_history" });
  const prior = { artifact_id: 4, sequence: 2, checkpoint_sha: "a".repeat(40) };
  let uploaded = false;
  await assert.rejects(durableCheckpoint(f.job, checkpoint({ previous: prior }), f.log, async () => { uploaded = true; throw new Error("fixture upload failed"); }), error=>{
    f.log.failure(error,prior);assert.equal(error.stage,"checkpoint");assert.equal(error.reason,"artifact_upload_failed");return true;
  });
  assert.equal(uploaded, true); assert.equal(prior.artifact_id, 4);
  assert.ok(!f.records.some((record) => record.event === "checkpoint.complete"));
  const failure=f.records.find(record=>record.reason==="artifact_upload_failed");assert.equal(failure.reason,"artifact_upload_failed");assert.equal(failure.last_durable_checkpoint.artifact_id,4);
});
test("dirty files and rejected pushes preserve the nearest published source without Git repairs", async t => {
  const f = await fixture(t), r = await repository(f), git = new TaskGit(r.cwd, f.job.env, f.log);
  await writeFile(join(r.cwd, 'draft.txt'), 'unfinished');
  let saved = await git.snapshot();
  assert.equal(saved.checkpoint_sha, r.base); assert.equal(saved.omitted_work, true);
  await r.git('add', 'draft.txt'); await r.git('commit', '-m', 'Unpublished');
  const local = await git.head(); saved = await git.snapshot();
  assert.equal(saved.checkpoint_sha, r.base); assert.equal(saved.omitted_work, true); assert.equal(await git.head(), local);
  await r.git('push', 'origin', 'HEAD'); saved = await git.snapshot();
  assert.equal(saved.checkpoint_sha, local); assert.equal(saved.omitted_work, false);
});

test("explicit command diagnostics sanitize stdout while native and API output stay private", async (t) => {
  const f = await fixture(t), args = ["-e", "process.stdout.write('validation-failure-evidence\\n'+process.env.CODEX_API_KEY+'\\n'+JSON.stringify({private_provider:'omit-this-body'})+'\\n'+'x'.repeat(10000));process.exit(1)"];
  await assert.rejects(command(process.execPath, args, { cwd:f.temporary, env:f.job.env, stage:"local_check_0", log:f.log, diagnosticStdout:true }), error => {
    assert.match(error.nativeCause, /validation-failure-evidence/); assert.match(error.nativeCause, /truncated/);
    assert.doesNotMatch(error.nativeCause, /fixture-api-credential-9374|omit-this-body/); assert.ok(error.nativeCause.length < 8300);
    f.log.failure(error); return true;
  });
  const failure = f.records.find(record => record.event === "runtime.failed");
  assert.match(failure.native_cause, /validation-failure-evidence/); assert.equal(failure.truncated, true);
  for (const stage of ["worker", "preflight_api"]) await assert.rejects(command(process.execPath, args, { cwd:f.temporary, env:f.job.env, stage, log:f.log }), error => {
    assert.doesNotMatch(error.nativeCause, /validation-failure-evidence|omit-this-body/); return true;
  });
});
test("real process timeout stops managed descendants and preserves a diagnostic cause", async (t) => {
  const f = await fixture(t);
  await assert.rejects(command("bash", ["-c", "sleep 120 & wait"], { cwd:f.temporary, env:f.job.env, stage:"worker", timeoutMs:150, log:f.log }), (error) => {
    assert.equal(error.reason, "command_timeout"); f.log.failure(error); return true;
  });
  assert.equal(f.records.find((record) => record.event === "runtime.failed").stage, "worker");
});
test("managed descendants in another session stop before a completed command returns",async(t)=>{
  const f=await fixture(t),path=join(f.temporary,"escaped-write");
  await command("bash",["-c",`setsid env -i PATH="$PATH" bash -c 'sleep 1; printf escaped > "${path}"' >/dev/null 2>&1 & sleep 0.1`],{cwd:f.temporary,env:f.job.env,stage:"worker",log:f.log});
  await new Promise(resolve=>setTimeout(resolve,1200));
  await assert.rejects(readFile(path),{code:"ENOENT"});
});
test("a stalled actual artifact SDK upload is bounded and keeps staged session data", async t => {
  const f = await fixture(t); await history(f);
  const exported = await exportCheckpoint(f.job, checkpoint(), f.log);
  let requests = 0;
  const server = createServer(async request => { requests++; for await (const _ of request) {} });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const token = 'e30.' + Buffer.from(JSON.stringify({ scp: 'Actions.Results:11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222' })).toString('base64url') + '.fixture';
  await assert.rejects(uploadSnapshot(f.job, exported.name, exported.files, exported.root, f.log,
    { ...process.env, ACTIONS_RUNTIME_TOKEN: token, ACTIONS_RESULTS_URL: `http://127.0.0.1:${server.address().port}`, NO_PROXY: '127.0.0.1,localhost', GITHUB_WORKSPACE: f.temporary, REMOTE_DEV_UPLOAD_TIMEOUT_MS: '1500' }), { reason: 'command_timeout' });
  assert.ok(requests > 0); assert.ok(await readFile(join(exported.root, 'manifest.json')));
});
for (const variant of ['escaped', 'unicode', 'nested']) test(`result credential checks decode ${variant} JSON before transport`, async t => {
  const f = await fixture(t), secret = 'fixture-"result\\credential\n9371'; f.log.protect(secret);
  const encoded = JSON.stringify({ credential: secret });
  const response = variant === 'nested' ? JSON.stringify({ response: JSON.stringify(encoded) }) : variant === 'unicode' ?
    '{"credential":"' + Array.from(secret, char => '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0')).join('') + '"}' : encoded;
  assert.throws(() => inspectCredentials(response, f.log, 'credential_in_result'), { reason: 'credential_in_result' });
});
test("normal diagnostic output masks credentials and raw provider bodies and marks truncation", () => {
  const { log, records } = logger(); log.protect("fixture-secret-8291");
  log.event("runtime.failed", "ERROR", { native_cause:'HTTP 403 {"message":"private API body"}\nAuthorization: Bearer fixture-secret-8291', detail:"x".repeat(800) });
  const encoded = JSON.stringify(records);
  assert.doesNotMatch(encoded, /fixture-secret-8291|private API body|Authorization: Bearer/);
  assert.equal(records[0].truncated, true); assert.equal(records[0].level, "ERROR");
});

test("the real Actions logger retains required failure evidence after DEBUG filtering",async()=>{
  const diagnosticPath=JSON.stringify(new URL("../.build/diagnostics.js",import.meta.url).href);
  const contractPath=JSON.stringify(new URL("../.build/contracts.js",import.meta.url).href);
  const script=`import {Diagnostics} from ${diagnosticPath};import {RunnerError} from ${contractPath};const log=new Diagnostics({task_id:'actual-log-task',run_id:'13'});log.protect('fixture-secret-3149');log.event('runtime.detail','DEBUG',{detail:'debug-only'});log.failure(new RunnerError('fixture_failure','checkpoint','HTTP 403 {"body":"private provider payload"}',{expected_sha:'a'.repeat(40),observed_sha:'b'.repeat(40)}),{artifact_id:17});`;
  const output=(await exec(process.execPath,["--input-type=module","-e",script])).stdout.split("\n").filter(line=>!line.startsWith("::debug::")&&!line.startsWith("::add-mask::")).join("\n");
  assert.match(output,/::error::/);assert.doesNotMatch(output,/fixture-secret-3149|private provider payload|debug-only/);
  const line=output.split("\n").find(line=>line.includes('"event":"runtime.failed"'));
  const evidence=JSON.parse(line.slice(line.indexOf("{")));
  assert.equal(evidence.stage,"checkpoint");assert.equal(evidence.expected_sha,"a".repeat(40));assert.equal(evidence.observed_sha,"b".repeat(40));assert.equal(evidence.last_durable_checkpoint.artifact_id,17);
});

test("explicit trivial credentials fail during configuration without registering their composite header", async t => {
  const f = await fixture(t);
  const password = "x!", payload = Buffer.from(`fixture-user:${password}`).toString("base64");
  const config = `[mcp_servers.fixture]\nurl="https://example.invalid/mcp"\n[mcp_servers.fixture.http_headers]\nAuthorization="Basic ${payload}"\n`;
  await assert.rejects(configure(f.job, config, f.log), error => {
    assert.equal(error.reason, "invalid_configured_credential");
    assert.equal(error.stage, "configuration");
    assert.equal(error.details.source, "CODEX_CONFIG_TOML");
    assert.equal(error.details.field, "basic_password");
    return true;
  });
  assert.ok(!f.log.protectedValues.includes(password));
  assert.ok(!f.log.protectedValues.includes(payload));
  assert.ok(!f.log.protectedValues.includes(`Basic ${payload}`));
  await assert.rejects(configure(f.job, '[mcp_servers.fixture.env]\nAPI_TOKEN="true"\n', f.log), { reason: "invalid_configured_credential" });
  await assert.rejects(configure(f.job, '[mcp_servers.fixture]\nurl="https://example.invalid/?token=!?"\n', f.log), { reason: "invalid_configured_credential" });
  await assert.rejects(configure(f.job, '[mcp_servers.fixture.http_headers]\nAuthorization="Bearer "\n', f.log), { reason: "invalid_configured_credential" });
  await configure(f.job, '[mcp_servers.fixture.env]\nDEBUG="1"\n[mcp_servers.fixture.http_headers]\naccept="application/json"\n', f.log);
});

test("environment references and benign URL query values remain usable", async t => {
  const f = await fixture(t);
  const config = '[mcp_servers.fixture]\nurl="https://$MY_TOKEN@example.invalid/mcp?format=enabled&token=$MY_TOKEN"\n' +
    'bearer_token_env_var="MY_TOKEN"\n[mcp_servers.fixture.env]\nTOKEN="$TK"\n' +
    '[mcp_servers.fixture.env_http_headers]\nAuthorization="MY_TOKEN"\n';
  await configure(f.job, config, f.log);
  for (const value of ["$MY_TOKEN", "$TK", "MY_TOKEN", "enabled"]) assert.ok(!f.log.protectedValues.includes(value));
  const token = "fixture-userinfo-token-6193";
  await configure(f.job, `[mcp_servers.fixture]\nurl="https://${token}@example.invalid/mcp?format=enabled"\n`, f.log);
  assert.ok(f.log.protectedValues.includes(token));
  assert.ok(!f.log.protectedValues.includes("enabled"));
  for (const reference of ["$MY_TOKEN", "${MY_TOKEN}", "${MY_TOKEN:-fallback}"]) {
    for (const url of [`https://user:${reference}@example.invalid/mcp`, `https://${reference}@example.invalid/mcp`,
      `https://example.invalid/mcp?token=${reference}`]) {
      const mcp = JSON.stringify({ mcpServers: { fixture: { type: "http", url } } });
      await configure(f.job, 'model="fixture"', f.log, mcp);
      assert.ok(!f.log.protectedValues.includes(reference));
    }
  }
});

test("credential headers in MCP command arguments are validated and protected", async t => {
  const f = await fixture(t), secret = "fixture-header-password-7264";
  for (const argument of [value => ["--header", `X-API-Key: ${value}`], value => ["-H", `X-API-Key: ${value}`],
    value => [`--header=X-API-Key: ${value}`], value => [`-HX-API-Key: ${value}`]]) {
    const mcp = value => JSON.stringify({ mcpServers: { fixture: { command: "curl", args: argument(value) } } });
    await assert.rejects(configure(f.job, 'model="fixture"', f.log, mcp("x!")), { reason: "invalid_configured_credential" });
    await configure(f.job, 'model="fixture"', f.log, mcp(secret));
  }
  assert.ok(f.log.protectedValues.includes(secret));
  assert.ok(!f.log.protectedValues.includes("x!"));
  await history(f, secret);
  await assert.rejects(exportCheckpoint(f.job, checkpoint(), f.log), { reason: "credential_in_checkpoint" });
});

test("authorization flags validate and protect every supported scheme payload", async t => {
  const f = await fixture(t), secret = "fixture-scheme-token-8294";
  const ordinary = JSON.stringify({ mcpServers: { fixture: { command: "curl", args: ["--label=Token abc", "--label=Bearer abc"] } } });
  await configure(f.job, 'model="fixture"', f.log, ordinary);
  assert.ok(!f.log.protectedValues.includes("abc"));
  for (const scheme of ["Token", "Digest", "ApiKey"]) {
    for (const args of [value => ["--authorization", `${scheme} ${value}`], value => [`--authorization=${scheme} ${value}`]]) {
      const mcp = value => JSON.stringify({ mcpServers: { fixture: { command: "curl", args: args(value) } } });
      await assert.rejects(configure(f.job, 'model="fixture"', f.log, mcp("abc")), { reason: "invalid_configured_credential" });
      assert.ok(!f.log.protectedValues.includes(`${scheme} abc`));
      await configure(f.job, 'model="fixture"', f.log, mcp(secret));
      assert.ok(f.log.protectedValues.includes(secret)); assert.ok(f.log.protectedValues.includes(`${scheme} ${secret}`));
      assert.throws(() => inspectCredentials(secret, f.log, "credential_in_result"), { reason: "credential_in_result" });
    }
  }
  await history(f, secret);
  await assert.rejects(exportCheckpoint(f.job, checkpoint(), f.log), { reason: "credential_in_checkpoint" });
});

test("decoded Basic passwords resembling environment references are treated as literals", async t => {
  const f = await fixture(t);
  const config = password => JSON.stringify({ mcpServers: { fixture: { type: "http", url: "https://example.invalid/mcp",
    headers: { Authorization: `Basic ${Buffer.from(`user:${password}`).toString("base64")}` } } } });
  const rejected = "$x", rejectedPayload = Buffer.from(`user:${rejected}`).toString("base64");
  await assert.rejects(configure(f.job, 'model="fixture"', f.log, config(rejected)), { reason: "invalid_configured_credential" });
  assert.ok(!f.log.protectedValues.includes(rejected)); assert.ok(!f.log.protectedValues.includes(rejectedPayload));
  for (const password of ["$LocalPassword9284", "${TOKEN}"]) {
    const pair = `user:${password}`, payload = Buffer.from(pair).toString("base64"), header = `Basic ${payload}`;
    await configure(f.job, 'model="fixture"', f.log, config(password));
    for (const value of [password, pair, payload, header]) {
      assert.ok(f.log.protectedValues.includes(value));
      assert.throws(() => inspectCredentials(value, f.log, "credential_in_result"), { reason: "credential_in_result" });
    }
    f.log.line(`Fixture output: ${password}`);
    assert.ok(!f.lines.join("\n").includes(password));
  }
  await history(f, "$LocalPassword9284");
  await assert.rejects(exportCheckpoint(f.job, checkpoint(), f.log), { reason: "credential_in_checkpoint" });
});

test("URL-encoded configured credentials cannot pass checkpoint or result inspection", async t => {
  const f = await fixture(t);
  const mcp = JSON.stringify({ mcpServers: { fixture: { type: "http",
    url: "https://fixture:p%40%73sword@example.invalid/mcp?token=spaced%20%6bey" } } });
  await configure(f.job, 'model="fixture"', f.log, mcp);
  assert.ok(f.log.protectedValues.includes("p@ssword"));
  assert.ok(f.log.protectedValues.includes("spaced key"));
  await history(f, "fixture p%40%73sword");
  await assert.rejects(exportCheckpoint(f.job, checkpoint(), f.log), { reason: "credential_in_checkpoint" });
  assert.throws(() => inspectCredentials("fixture spaced%20%6bey", f.log, "credential_in_result"), { reason: "credential_in_result" });
});

test("encoded URL credential literals that resemble references are validated and protected", async t => {
  const f = await fixture(t);
  const locations = [value => `https://user:${value}@example.invalid/mcp`, value => `https://${value}@example.invalid/mcp`,
    value => `https://example.invalid/mcp?token=${value}`];
  for (const [index, location] of locations.entries()) {
    const mcp = value => JSON.stringify({ mcpServers: { fixture: { type: "http", url: location(value) } } });
    const rejected = "$xy", encodedRejected = encodeURIComponent(rejected);
    await assert.rejects(configure(f.job, 'model="fixture"', f.log, mcp(encodedRejected)), error => {
      assert.equal(error.reason, "invalid_configured_credential"); assert.equal(error.details.field, "url_credential"); return true;
    });
    assert.ok(!f.log.protectedValues.includes(rejected)); assert.ok(!f.log.protectedValues.includes(encodedRejected));
    for (const secret of [`$LocalPassword${index}9284`, "$" + `{TOKEN${index}}`]) {
      const encoded = encodeURIComponent(secret);
      await configure(f.job, 'model="fixture"', f.log, mcp(encoded));
      for (const form of [secret, encoded]) {
        assert.ok(f.log.protectedValues.includes(form));
        assert.throws(() => inspectCredentials(form, f.log, "credential_in_result"), { reason: "credential_in_result" });
      }
      f.log.line(`Fixture output: ${secret}`);
      assert.ok(!f.lines.join("\n").includes(secret));
    }
    await assert.rejects(configure(f.job, 'model="fixture"', f.log, mcp("%61%")), { reason: "invalid_configured_credential" });
    assert.ok(!f.log.protectedValues.includes("a%")); assert.ok(!f.log.protectedValues.includes("%61%"));
    const mixed = `%24LongPassword${index}%ZZ`, decoded = `$LongPassword${index}%ZZ`;
    await configure(f.job, 'model="fixture"', f.log, mcp(mixed));
    assert.ok(f.log.protectedValues.includes(decoded)); assert.ok(f.log.protectedValues.includes(mixed));
    assert.throws(() => inspectCredentials(decoded, f.log, "credential_in_result"), { reason: "credential_in_result" });
  }
  await history(f, "$LocalPassword09284");
  await assert.rejects(exportCheckpoint(f.job, checkpoint(), f.log), { reason: "credential_in_checkpoint" });
});

test("URL userinfo decoding preserves literal plus signs and ampersands", async t => {
  const f = await fixture(t);
  const locations = [value => `https://user:${value}@example.invalid/mcp`, value => `https://${value}@example.invalid/mcp`];
  for (const [index, location] of locations.entries()) {
    const encoded = `long${index}+with&value%61%`, decoded = `long${index}+with&valuea%`, url = location(encoded);
    const mcp = JSON.stringify({ mcpServers: { fixture: { type: "http", url } } });
    await configure(f.job, 'model="fixture"', f.log, mcp);
    assert.ok(f.log.protectedValues.includes(decoded));
    assert.throws(() => inspectCredentials(decoded, f.log, "credential_in_result"), { reason: "credential_in_result" });
  }
});

test("parsed URL authority credentials are protected across accepted authority spellings", async t => {
  const f = await fixture(t);
  const locations = [value => `https://name@realm:${value}@example.invalid/mcp`,
    value => `https:/name:${value}@example.invalid/mcp`, value => `https:name:${value}@example.invalid/mcp`,
    value => `https:\\\\name:${value}@example.invalid/mcp`, value => `custom://name@realm:${value}@example.invalid/mcp`];
  for (const [index, location] of locations.entries()) {
    const mcp = value => JSON.stringify({ mcpServers: { fixture: { type: "http", url: location(value) } } });
    await assert.rejects(configure(f.job, 'model="fixture"', f.log, mcp("abc")), { reason: "invalid_configured_credential" });
    const secret = `fixture-authority-password-${index}-9483`;
    await configure(f.job, 'model="fixture"', f.log, mcp(secret));
    assert.ok(f.log.protectedValues.includes(secret));
    assert.throws(() => inspectCredentials(secret, f.log, "credential_in_result"), { reason: "credential_in_result" });
  }
});

test("real Actions masking filters syntax lines and rejected composite credentials", async () => {
  const diagnostics = JSON.stringify(new URL("../.build/diagnostics.js", import.meta.url).href);
  const credentials = JSON.stringify(new URL("../.build/credentials.js", import.meta.url).href);
  const payload = Buffer.from("user:!?").toString("base64");
  const script = `import {Diagnostics} from ${diagnostics}; import {protectConfiguration} from ${credentials};
    const log = new Diagnostics({run_id:'13'});
    for (const value of ['{}','Bearer','false','{\\n"token":"fixture-multiline-7281"\\n}']) log.protect(value);
    for (const config of [{headers:{Authorization:'Basic ${payload}'}},{url:'https://user:%21%3F@example.invalid/mcp'},
      {url:'https://user:%61%@example.invalid/mcp'}]) {
      try { protectConfiguration(config, log, '', 'MCP_CONFIG_JSON'); } catch (error) { log.failure(error); }
    }`;
  const { stdout } = await exec(process.execPath, ["--input-type=module", "-e", script]);
  const masks = stdout.split("\n").filter(line => line.startsWith("::add-mask::"));
  assert.ok(!masks.some(line => /^::add-mask::(?:\{|\}|Bearer|false)$/.test(line)));
  assert.ok(!stdout.includes(payload));
  assert.ok(!stdout.includes("user:%21%3F"));
  assert.ok(!stdout.includes("user:%61%"));
  assert.equal(stdout.split('"reason":"invalid_configured_credential"').length - 1, 3);
});

test("registered credential forms are masked and excluded from exports", async () => {
  const diagnostics = JSON.stringify(new URL("../.build/diagnostics.js", import.meta.url).href);
  const contracts = JSON.stringify(new URL("../.build/contracts.js", import.meta.url).href);
  const secret = 'fixture "private~! password \\9284';
  const form = new URLSearchParams([["value", secret]]).toString().slice(6);
  const encoded = encodeURIComponent(secret);
  const forms = [secret, encoded, form, form.replaceAll("+", "%20"), encoded.replaceAll("%20", "+")];
  const { log } = logger();
  log.protect(secret);
  for (const form of forms) assert.throws(() => inspectCredentials(form, log), { reason: "credential_in_checkpoint" });
  assert.throws(() => inspectCredentials(JSON.stringify(secret), log), { reason: "credential_in_checkpoint" });
  assert.doesNotThrow(() => inspectCredentials("1 + 2 = 3; a+b; scope=read+write; +line", log));
  log.protect("alpha%20");
  log.protect("alpha b");
  assert.equal(log.redact("alpha%20b"), "[redacted]");
  log.protect("fixture lone surrogate \ud800");
  assert.equal(log.redact("fixture lone surrogate \ud800"), "[redacted]");

  const loggedForms = [...forms, JSON.stringify(secret).slice(1, -1)];
  const script = `import {Diagnostics} from ${diagnostics}; import {RunnerError} from ${contracts};
    const log = new Diagnostics({run_id:'13'});
    log.protect(${JSON.stringify(secret)});
    log.protect('fixture private password 9284');
    for (const form of ${JSON.stringify(loggedForms)}) log.line(form);
    log.line('fixture+private+password+9284 1 + 2 = 3; a+b; scope=read+write; +line');
    log.group('fixture+private+password+9284', ['fixture+private+password+9284']);
    for (const form of ${JSON.stringify(loggedForms)}) log.failure(new RunnerError('fixture_failure', 'runtime', form));
    log.failure(new RunnerError('fixture_failure', 'runtime', '[redacted] {"body":"private-provider-body"}'));`;
  const { stdout } = await exec(process.execPath, ["--input-type=module", "-e", script]);
  assert.ok(stdout.includes("::add-mask::fixture+private+password+9284"));
  const output = stdout.split("\n").filter(line => !line.startsWith("::add-mask::")).join("\n");
  assert.doesNotMatch(output, /fixture(?:\+|%20| )private/);
  for (const form of loggedForms) assert.ok(!output.includes(form));
  assert.ok((output.match(/\[redacted\]/g) ?? []).length >= loggedForms.length + 3);
  const failures = output.split("\n").filter(line => line.includes('"event":"runtime.failed"'))
    .map(line => JSON.parse(line.slice(line.indexOf("{"))));
  assert.equal(failures.length, loggedForms.length + 1);
  for (const failure of failures.slice(0, -1)) assert.equal(failure.native_cause, "[redacted]");
  assert.equal(failures.at(-1).native_cause, "[sensitive diagnostic line omitted]");
  assert.doesNotMatch(output, /private-provider-body/);
  assert.match(output, /1 \+ 2 = 3; a\+b; scope=read\+write; \+line/);
});

test("real Actions logging redacts outside paths while retaining workspace paths and routes", async () => {
  const diagnostics = JSON.stringify(new URL("../.build/diagnostics.js", import.meta.url).href);
  const paths = 'paths: /outside/private.txt, `/outside/noext` -/elsewhere/private; file:///outside/%70rivate.txt.';
  const script = `import {Diagnostics} from ${diagnostics};
    const log = new Diagnostics({run_id:'13'});
    log.setWorkspace('/tmp/fixture-workspace');
    log.line(${JSON.stringify(paths)});
    log.line('/v1/../etc/passwd /v1/.hidden /api/file.txt /~user/private');
    log.line('/tmp/fixture-workspace/src/file.ts /v1/messages /health GET /orders/recent');
    log.line('const pattern = /allowed/g; const endpoint = "/v1/messages"; /dev/null');`;
  const { stdout } = await exec(process.execPath, ["--input-type=module", "-e", script]);
  assert.doesNotMatch(stdout, /outside\/private|outside\/noext|elsewhere\/private|\/etc\/passwd|\.hidden|\/api\/file\.txt|~user/);
  assert.ok((stdout.match(/<outside-workspace>/g) ?? []).length >= 8);
  assert.match(stdout, /src\/file\.ts \/v1\/messages \/health GET \/orders\/recent/);
  assert.match(stdout, /const pattern = \/allowed\/g; const endpoint = "\/v1\/messages"; \/dev\/null/);
  const { log } = logger();
  log.setWorkspace("/tmp/fixture-workspace", ["/v1"]);
  log.ensureWorkspace("/outside/other-workspace");
  assert.equal(log.redact("/v1/messages"), "<outside-workspace>");
  assert.equal(log.redact("/tmp/fixture-workspace/src/file.ts"), "src/file.ts");
});

test("multiline JSON configuration warns through the real Actions logger", async t => {
  const f = await fixture(t), main = JSON.stringify(new URL("../.build/main.js", import.meta.url).href);
  const script = `import {main} from ${main}; await main({github:{}});`;
  const env = { ...process.env, REMOTE_DEV_RUNNER: "claude", REMOTE_DEV_GITHUB_TOKEN: "fixture-github-token-9382",
    ANTHROPIC_API_KEY: "fixture-claude-key-9382", CLAUDE_SETTINGS_JSON: '{\n"model":"fixture"\n}',
    MCP_CONFIG_JSON: '{\n"mcpServers":{}\n}', GITHUB_WORKSPACE: join(f.temporary, "missing"), GITHUB_RUN_ID: "13", GITHUB_RUN_ATTEMPT: "1" };
  await assert.rejects(exec(process.execPath, ["--input-type=module", "-e", script], { env }), error => {
    const warnings = error.stdout.split("\n").filter(line => line.startsWith("::warning::") && line.includes('"reason":"multiline_json_secret_masking_risk"'));
    assert.equal(warnings.length, 2);
    assert.ok(warnings.some(line => line.includes('"source":"CLAUDE_SETTINGS_JSON"')));
    assert.ok(warnings.some(line => line.includes('"source":"MCP_CONFIG_JSON"')));
    return true;
  });
});

test("code-safe redaction preserves routes and removes credential patterns before truncation", () => {
  const { log } = logger();
  log.setWorkspace("/tmp/fixture-workspace");
  const secret = 'fixture-"escaped\\secret-7219';
  log.protect(secret);
  const source = 'const routes = ["/v1/messages", "/health"]; const config = { enabled: true };';
  assert.equal(log.redact(source), source);
  assert.equal(log.redact('Bearer authenticationHeader'), 'Bearer authenticationHeader');
  assert.equal(log.redact('Basic YWJjZGVmZ2hpamtsbW4='), 'Basic [redacted]');
  assert.match(log.redact('https://user:password@example.invalid/mcp?token=fixture'), /^https:\/\/example\.invalid\/mcp$/);
  assert.ok(!log.redact(JSON.stringify(secret)).includes('escaped'));
  assert.ok(!log.redact(encodeURIComponent(secret)).includes('escaped'));
  assert.equal(log.redact('/tmp/fixture-workspace/src/file.ts'), 'src/file.ts');
  assert.equal(log.redact('/tmp/another-root/file.ts'), '<outside-workspace>');
  for (const value of ['sk-ant-abcdefghijklmnop', 'ghp_abcdefghijklmnop', 'eyJabcdefghijk.abcdefghijklmnop.signature']) {
    assert.equal(log.redact(value), '[redacted]');
  }
  const body = 'A'.repeat(64);
  assert.doesNotMatch(log.redact(`-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----`), /AAAA/);
  assert.doesNotMatch(log.redact(`+${body}\n+-----END PRIVATE KEY-----`), /AAAA/);
  const longLine = 'x'.repeat(4090) + secret + 'z'.repeat(100);
  assert.deepEqual(boundedLines(log.redact(longLine)), ['[oversized line omitted]']);
});

test("resume validates the restored repository configuration before importing native state", async t => {
  const f = await fixture(t), repo = await repository(f);
  const bad = JSON.stringify({ mcpServers: { fixture: { type: "http", url: "https://example.invalid/mcp",
    headers: { Authorization: `Basic ${Buffer.from("user:!?").toString("base64")}` } } } });
  await writeFile(join(repo.cwd, ".mcp.json"), bad);
  await repo.git("add", ".mcp.json"); await repo.git("commit", "-m", "Add fixture configuration"); await repo.git("push", "origin", "HEAD");
  await history(f);
  const git = new TaskGit(repo.cwd, f.job.env, f.log);
  const exported = await exportCheckpoint(f.job, checkpoint({ ...await git.snapshot(), workspace: repo.cwd }), f.log);
  const fresh = await fixture(t), cwd = join(fresh.temporary, "restored-checkout");
  await exec("git", ["clone", repo.remote, cwd], { env: fresh.job.env });
  const restored = new TaskGit(cwd, fresh.job.env, fresh.log);
  await assert.rejects(restoreCheckpoint(fresh.job, exported.root, validateCheckpoint(exported.manifest, "fixture/repo"), restored, fresh.log,
    () => configure(fresh.job, 'model="fixture"', fresh.log, "", cwd)), { reason: "invalid_configured_credential" });
  await assert.rejects(lstat(join(fresh.job.runnerHome, "sessions")), { code: "ENOENT" });
  assert.ok(fresh.records.some(record => record.event === "resume.restore" && record.reason === "invalid_configured_credential"));
});

test("real setup reports an invalid primary credential before exposing a state path", async () => {
  const main = JSON.stringify(new URL("../.build/main.js", import.meta.url).href);
  const script = `import {main} from ${main}; await main({github:{}});`;
  const env = { ...process.env, REMOTE_DEV_RUNNER: "codex", REMOTE_DEV_GITHUB_TOKEN: "!?!", CODEX_API_KEY: "fixture-api-key-7242",
    CODEX_CONFIG_TOML: 'model="fixture"', GITHUB_RUN_ID: "13", GITHUB_RUN_ATTEMPT: "2" };
  await assert.rejects(exec(process.execPath, ["--input-type=module", "-e", script], { env }), error => {
    assert.equal(error.code, 1);
    const lines = error.stdout.split("\n");
    const failure = lines.find(line => line.includes('"reason":"invalid_configured_credential"'));
    assert.ok(failure?.startsWith("::error::"));
    const record = JSON.parse(failure.slice(failure.indexOf("{")));
    assert.equal(record.stage, "configuration");
    assert.equal(record.source, "REMOTE_DEV_GITHUB_TOKEN");
    assert.equal(record.run_id, "13");
    assert.equal(record.run_attempt, "2");
    assert.ok(!error.stdout.includes("!?!"));
    assert.ok(!error.stdout.includes("state-path"));
    return true;
  });
});

for (const variant of ["basic", "url"]) test(`real fresh setup rejects ${variant} credentials before launch or export`, async t => {
  const f = await fixture(t), output = join(f.temporary, "fresh-output");
  await writeFile(output, "");
  const payload = Buffer.from("user:!?").toString("base64");
  const mcp = JSON.stringify({ mcpServers: { fixture: variant === "basic" ? { command: "node", env: { DEBUG: "1" },
    headers: { Authorization: `Basic ${payload}` } } : { type: "http", url: "https://user:%24xy@example.invalid/mcp" } } });
  const forbidden = variant === "basic" ? ["user:!?", "user:%21%3F", payload] : ["$xy", "%24xy"];
  const maskForbidden = variant === "basic" ? ["!?", "%21%3F", payload] : forbidden;
  const main = JSON.stringify(new URL("../.build/main.js", import.meta.url).href);
  const script = `import {main} from ${main}; await main({github:{request(){throw new Error('Unexpected API call');}}});`;
  const env = { ...process.env, REMOTE_DEV_RUNNER: "codex", REMOTE_DEV_GITHUB_TOKEN: "fixture-github-token-9382",
    CODEX_API_KEY: "fixture-api-key-7242", CODEX_CONFIG_TOML: 'model="fixture"', MCP_CONFIG_JSON: mcp,
    GITHUB_OUTPUT: output, GITHUB_RUN_ID: "13", GITHUB_RUN_ATTEMPT: "2" };
  await assert.rejects(exec(process.execPath, ["--input-type=module", "-e", script], { env }), error => {
    assert.equal(error.code, 1);
    const failure = error.stdout.split("\n").find(line => line.startsWith("::error::") && line.includes('"event":"runtime.failed"'));
    const record = JSON.parse(failure.slice(failure.indexOf("{")));
    assert.equal(record.reason, "invalid_configured_credential"); assert.equal(record.stage, "configuration");
    assert.equal(record.source, "MCP_CONFIG_JSON"); assert.equal(record.field, variant === "basic" ? "basic_password" : "url_credential");
    assert.equal(record.run_id, "13"); assert.equal(record.run_attempt, "2");
    for (const value of forbidden) assert.ok(!error.stdout.includes(value));
    const masks = error.stdout.split("\n").filter(line => line.startsWith("::add-mask::"));
    assert.ok(masks.every(line => maskForbidden.every(value => !line.includes(value))));
    assert.ok(!error.stdout.includes('"stage":"tools"')); return true;
  });
  assert.equal(await readFile(output, "utf8"), "");
});

for (const variant of ["basic", "url"]) test(`real resumed setup rejects restored ${variant} credentials before launch or export`, async t => {
  const f = await fixture(t), repo = await repository(f);
  const payload = Buffer.from("user:!?").toString("base64");
  const bad = JSON.stringify({ mcpServers: { fixture: variant === "basic" ? { command: "node", env: { DEBUG: "1" },
    headers: { Authorization: `Basic ${payload}` } } : { type: "http", url: "https://user:%24xy@example.invalid/mcp" } } });
  const forbidden = variant === "basic" ? ["user:!?", "user:%21%3F", payload] : ["$xy", "%24xy"];
  const maskForbidden = variant === "basic" ? ["!?", "%21%3F", payload] : forbidden;
  await writeFile(join(repo.cwd, ".mcp.json"), bad);
  await repo.git("add", ".mcp.json"); await repo.git("commit", "-m", "Configure fixture"); await repo.git("push", "origin", "HEAD");
  await history(f);
  const git = new TaskGit(repo.cwd, f.job.env, f.log);
  const exported = await exportCheckpoint(f.job, checkpoint({ ...await git.snapshot(), workspace: repo.cwd }), f.log);
  const archive = join(f.temporary, "setup-checkpoint.zip");
  await exec("python3", ["-c", `import json,sys,zipfile
with zipfile.ZipFile(sys.argv[1],'w',compression=zipfile.ZIP_DEFLATED) as z:
 for name in json.loads(sys.argv[3]): z.write(name,name[len(sys.argv[2])+1:])`, archive, exported.root, JSON.stringify(exported.files)]);
  const workspace = join(f.temporary, "workspace"), target = join(workspace, "target"), bin = join(f.temporary, "fixture-bin");
  await mkdir(workspace); await mkdir(bin);
  await exec("git", ["clone", "--branch", "main", repo.remote, target], { env: f.job.env });
  await exec("git", ["remote", "set-url", "origin", "https://github.com/fixture/repo"], { cwd: target, env: f.job.env });
  await copyFile(process.execPath, join(bin, "node"), constants.COPYFILE_FICLONE);
  await writeFile(join(bin, "git"), `#!/bin/sh\nif [ "$1" = fetch ]; then exec /usr/bin/git -c 'url.file://${repo.remote}.insteadOf=https://github.com/fixture/repo' "$@"; fi\nexec /usr/bin/git "$@"\n`, { mode: 0o700 });
  const output = join(f.temporary, "resume-output"); await writeFile(output, "");
  const info = { full_name: "fixture/repo" };
  const parent = { id: 13, run_attempt: 1, workflow_id: lineage.workflow_id, path: lineage.workflow_path, head_sha: lineage.workflow_sha,
    repository: info, head_repository: info, head_branch: "main", event: "workflow_dispatch", status: "completed", conclusion: "failure" };
  const current = { ...parent, id: 20, status: "in_progress" };
  const bytes = await readFile(archive), artifact = { id: 55, name: `remote-dev-session-r13-a1-${exported.manifest.sequence}`,
    workflow_run: { id: 13 }, size_in_bytes: bytes.length, expired: false, expires_at: "2099-01-01T00:00:00Z" };
  const config = Buffer.from("allowed-actors: [Z-M-Huang]\nskills: []\n");
  const main = JSON.stringify(new URL("../.build/main.js", import.meta.url).href);
  const script = `import {main} from ${main};
    const parent=${JSON.stringify(parent)}, current=${JSON.stringify(current)}, artifact=${JSON.stringify(artifact)};
    const github={request:async route=>{const [method,path]=route.split(' '); if(method!=='GET') throw new Error('Unexpected export');
      if(path.endsWith('/actions/runs/20')) return {data:current}; if(path.endsWith('/actions/runs/13')) return {data:parent};
      if(path.includes('/actions/runs/13/artifacts?')) return {data:{artifacts:[artifact]}};
      if(path.endsWith('/actions/artifacts/55/zip')) return {data:Buffer.from(${JSON.stringify(bytes.toString("base64"))},'base64')};
      if(path.endsWith('/actions/artifacts/55')) return {data:artifact};
      if(path==='/repos/fixture/repo') return {data:{default_branch:'main'}};
      if(path.includes('/commits/main')) return {data:{sha:'a'.repeat(40)}};
      if(path.includes('/collaborators/')) return {data:{permission:'write'}};
      if(path.includes('/contents/.remote-dev.yml?')) return {data:{type:'file',encoding:'base64',size:${config.length},content:${JSON.stringify(config.toString("base64"))}}};
      throw new Error('Unexpected fixture route');}}; await main({github});`;
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, RUNNER_TEMP: f.temporary, GITHUB_WORKSPACE: workspace,
    GITHUB_REPOSITORY: "fixture/repo", GITHUB_RUN_ID: "20", GITHUB_RUN_ATTEMPT: "1", GITHUB_ACTOR: "Z-M-Huang",
    TRIGGERING_ACTOR: "Z-M-Huang", GITHUB_REF: "refs/heads/main", GITHUB_OUTPUT: output,
    REMOTE_DEV_RUNNER: "codex", REMOTE_DEV_GITHUB_TOKEN: "fixture-github-token-9382", CODEX_API_KEY: "fixture-api-key-7242",
    CODEX_CONFIG_TOML: 'model="fixture"', MCP_CONFIG_JSON: "", REMOTE_DEV_RESUME_RUN_ID: "13", REMOTE_DEV_PLAN: "Continue" };
  await assert.rejects(exec(join(bin, "node"), ["--input-type=module", "-e", script], { env, timeout: 60000 }), error => {
    assert.equal(error.code, 1);
    let depth = 0, contexts = 0, failure;
    for (const line of error.stdout.split("\n")) {
      if (line.startsWith("::group::")) depth++;
      if (line.startsWith("::endgroup::")) depth--;
      if (line.includes('"event":"runtime.context"')) { assert.ok(depth > 0); contexts++; }
      if (line.startsWith("::error::") && line.includes('"event":"runtime.failed"')) { assert.equal(depth, 0); failure = JSON.parse(line.slice(line.indexOf("{"))); }
    }
    assert.equal(contexts, 1); assert.equal(failure.reason, "invalid_configured_credential");
    assert.equal(failure.stage, "configuration"); assert.equal(failure.source, ".mcp.json");
    assert.equal(failure.field, variant === "basic" ? "basic_password" : "url_credential");
    assert.equal(failure.run_id, "20"); assert.equal(failure.run_attempt, "1");
    for (const value of forbidden) assert.ok(!error.stdout.includes(value));
    const masks = error.stdout.split("\n").filter(line => line.startsWith("::add-mask::"));
    assert.ok(masks.every(line => maskForbidden.every(value => !line.includes(value))));
    assert.ok(!error.stdout.includes('"stage":"tools"')); return true;
  });
  assert.equal(await readFile(output, "utf8"), "");
  assert.equal(await readFile(join(target, ".mcp.json"), "utf8"), bad);
  assert.equal((await exec("git", ["rev-parse", "HEAD"], { cwd: target })).stdout.trim(), exported.manifest.checkpoint_sha);
});

test("real Actions commands preserve group balance, warning visibility and safe diagnostics", async () => {
  const module = JSON.stringify(new URL("../.build/diagnostics.js", import.meta.url).href);
  const script = `import {Diagnostics} from ${module};
    const log = new Diagnostics({run_id:'13',run_attempt:'2',session_id:'fixture-session'});
    log.protect('fixture-secret-9217');
    log.beginGroup('Setup & environment'); log.emitContext();
    log.event('runtime.setup','WARN',{reason:'unsupported_mcp_transport'});
    log.event('runtime.setup','INFO',{stage:'configuration'}); log.endGroup();
    log.beginBuffering(); log.event('runtime.tool','INFO',{stage:'native',payload:'##[error] injected',items:Array.from({length:105},(_,i)=>i),large:2n});
    log.group('Thinking',['::endgroup::',' ##[error] injected','fixture-secret-9217'],{untrusted:true});
    const circular={}; circular.self=circular; log.event('runtime.bad','INFO',{circular});
    log.event('runtime.failed','ERROR',{stage:'native',reason:'fixture_failure',http_status:403}); log.endBuffering();`;
  const { stdout } = await exec(process.execPath, ["--input-type=module", "-e", script]);
  const lines = stdout.split("\n").filter(line => !line.startsWith("::add-mask::"));
  let depth = 0, disabled = "";
  for (const line of lines) {
    if (disabled) { if (line === `::${disabled}::`) disabled = ""; continue; }
    if (line.startsWith("::stop-commands::")) { disabled = line.slice("::stop-commands::".length); continue; }
    if (line.startsWith("::group::")) { assert.equal(depth, 0); depth++; }
    else if (line === "::endgroup::") { assert.equal(depth, 1); depth--; }
    else if (line.startsWith("::warning::") || line.startsWith("::error::")) assert.equal(depth, 0);
    else assert.ok(!line.startsWith("::endgroup::"));
  }
  assert.equal(depth, 0); assert.equal(disabled, "");
  assert.ok(lines.includes("::group::Setup & environment (continued)"));
  assert.doesNotMatch(lines.join("\n"), /fixture-secret-9217|##\[error\]/);
  const toolLine = lines.find(line => line.includes('"event":"runtime.tool"'));
  const tool = JSON.parse(toolLine.slice(toolLine.indexOf("{")));
  assert.equal(tool.run_id, "13"); assert.equal(tool.run_attempt, "2");
  assert.equal(tool.large, "2"); assert.equal(tool.truncated, true); assert.equal(tool.items.length, 100);
  assert.ok(lines.some(line => line.startsWith("::error::") && line.includes('"event":"runtime.log_error"')));
  const failureLine = lines.find(line => line.includes('"reason":"fixture_failure"'));
  const failure = JSON.parse(failureLine.slice(failureLine.indexOf("{")));
  assert.equal(failure.session_id, "fixture-session"); assert.equal(failure.http_status, 403);
});

test("buffered diagnostics flush at the event and byte limits", () => {
  const byCount = logger();
  byCount.log.beginBuffering();
  for (let index = 0; index < 49; index++) byCount.log.event("runtime.tool", "INFO", { index });
  assert.equal(byCount.records.length, 0);
  byCount.log.event("runtime.tool", "INFO", { index: 49 });
  assert.equal(byCount.records.length, 50);
  byCount.log.endBuffering();
  const byBytes = logger();
  byBytes.log.beginBuffering();
  let index = 0;
  while (!byBytes.records.length && index < 49) {
    byBytes.log.event("runtime.tool", "INFO", { index, a: "a".repeat(512), b: "b".repeat(512), c: "c".repeat(512), d: "d".repeat(512) });
    index++;
  }
  assert.ok(index < 50);
  assert.equal(byBytes.records.length, index);
  byBytes.log.endBuffering();
});

test("plain setup errors preserve safe HTTP causes in real Actions output", async () => {
  const module = JSON.stringify(new URL("../.build/diagnostics.js", import.meta.url).href);
  const script = `import {Diagnostics} from ${module}; const log=new Diagnostics({run_id:'13',run_attempt:'2'});
    const error=Object.assign(new Error('HTTP 403 {"body":"private-response-7831"}'),
      {reason:'skill_lookup_failed',stage:'skills',status:403,response:{headers:{'x-github-request-id':'ABCD:1234'}}});
    log.failure(error);`;
  const { stdout } = await exec(process.execPath, ["--input-type=module", "-e", script]);
  const line = stdout.split("\n").find(item => item.includes('"event":"runtime.failed"'));
  assert.ok(line.startsWith("::error::"));
  const record = JSON.parse(line.slice(line.indexOf("{")));
  assert.equal(record.reason, "skill_lookup_failed"); assert.equal(record.stage, "skills");
  assert.equal(record.http_status, 403); assert.equal(record.request_id, "ABCD:1234");
  assert.doesNotMatch(stdout, /private-response-7831/);
});

test("a silent real process emits a folded heartbeat with idle time", async t => {
  const f = await fixture(t), diagnostics = JSON.stringify(new URL("../.build/diagnostics.js", import.meta.url).href);
  const processModule = JSON.stringify(new URL("../.build/process.js", import.meta.url).href);
  const script = `import {mock} from 'node:test'; import {Diagnostics} from ${diagnostics}; import {command} from ${processModule};
    mock.timers.enable({apis:['Date','setInterval','setTimeout'],now:0});
    const log=new Diagnostics({run_id:'13',run_attempt:'1',session_id:'fixture-session'}); log.beginBuffering();
    log.event('runtime.tool','INFO',{stage:'native',phase:'started'});
    let ready; const started=new Promise(resolve=>{ready=resolve});
    const run=command('/bin/sh',['-c','sleep 1'],{cwd:process.argv[1],env:{...process.env,TMPDIR:process.argv[1]},stage:'native',log,timeoutMs:Infinity,onControl:()=>ready()});
    await started; mock.timers.tick(60000); await run; log.endBuffering(); mock.timers.reset();`;
  const { stdout } = await exec(process.execPath, ["--input-type=module", "-e", script, f.temporary]);
  assert.ok(stdout.includes("::group::Heartbeat"));
  assert.ok(stdout.includes("::group::Runtime diagnostics (1 events)"));
  const line = stdout.split("\n").find(item => item.includes('"event":"runtime.heartbeat"'));
  const record = JSON.parse(line.slice(line.indexOf("{")));
  assert.equal(record.idle_ms, 60000); assert.equal(record.run_id, "13"); assert.equal(record.session_id, "fixture-session");
});

test("snapshot log offsets preserve UTF-8 records, warnings and sanitized worker failures", async t => {
  const f = await fixture(t), path = join(f.job.root, "snapshots.log");
  const commits = [], tailer = new SnapshotLogTailer(f.job.root, f.log, 0, async offset => commits.push(offset), false, 0);
  const first = Buffer.from(JSON.stringify({ schema_version: 1, event: "checkpoint.export", level: "INFO", cycle: 1, marker: "café" }) + "\n");
  const split = first.indexOf(Buffer.from("é")) + 1;
  await writeFile(path, first.subarray(0, split));
  await tailer.flush(true);
  assert.equal(commits.length, 0);
  await appendFile(path, first.subarray(split));
  await appendFile(path, JSON.stringify({ schema_version: 1, event: "checkpoint.cycle", level: "INFO", cycle: 1 }) + "\n");
  await appendFile(path, JSON.stringify({ schema_version: 1, event: "checkpoint.deferred", level: "WARN", cycle: 2, reason: "snapshot_pause_deferred" }) + "\n");
  await appendFile(path, "::add-mask::do-not-forward\nSnapshot worker failed. fixture-api-credential-9374\n");
  await tailer.flush(true, true);
  const size = (await readFile(path)).length;
  assert.equal(commits.at(-1), size);
  assert.equal(Number(await readFile(join(f.job.root, "snapshots.offset"), "utf8")), size);
  assert.ok(f.records.some(record => record.event === "checkpoint.export" && record.marker === "café"));
  assert.ok(f.records.some(record => record.event === "checkpoint.deferred" && record.level === "WARN"));
  assert.ok(f.records.some(record => record.event === "checkpoint.worker_stderr" && record.level === "ERROR"));
  assert.doesNotMatch(f.lines.join("\n"), /do-not-forward|fixture-api-credential-9374/);
  const before = f.records.length;
  const resumed = new SnapshotLogTailer(f.job.root, f.log, size, async () => {}, true);
  await resumed.flush(true, true);
  assert.equal(f.records.length, before);
});

test("real Actions output reconstructs a deferred checkpoint and worker failure", async t => {
  const f = await fixture(t), path = join(f.job.root, "snapshots.log");
  const diagnostic = JSON.stringify(new URL("../.build/diagnostics.js", import.meta.url).href);
  const main = JSON.stringify(new URL("../.build/main.js", import.meta.url).href);
  const deferred = { schema_version: 1, event: "checkpoint.deferred", level: "WARN", run_id: "13", run_attempt: "2",
    session_id: "fixture-session", cycle: 4, reason: "snapshot_pause_deferred", pause_reason: "permission_denied", os_errno: 1, retry_interval_ms: 60000 };
  await writeFile(path, JSON.stringify(deferred) + '\nSnapshot worker failed. fixture-capture-secret-7284\n');
  const script = `import {Diagnostics} from ${diagnostic}; import {SnapshotLogTailer} from ${main};
    const log=new Diagnostics({run_id:'13',run_attempt:'2',session_id:'fixture-session'}); log.protect('fixture-capture-secret-7284');
    const tailer=new SnapshotLogTailer(process.argv[1],log,0,async()=>{}); await tailer.flush(true,true);`;
  const { stdout } = await exec(process.execPath, ["--input-type=module", "-e", script, f.job.root]);
  const lines = stdout.split("\n").filter(line => !line.startsWith("::add-mask::"));
  const warning = lines.find(line => line.startsWith("::warning::") && line.includes('"event":"checkpoint.deferred"'));
  const failure = lines.find(line => line.startsWith("::error::") && line.includes('"event":"checkpoint.worker_stderr"'));
  const evidence = JSON.parse(warning.slice(warning.indexOf("{")));
  assert.equal(evidence.run_id, "13"); assert.equal(evidence.run_attempt, "2"); assert.equal(evidence.session_id, "fixture-session");
  assert.equal(evidence.cycle, 4); assert.equal(evidence.pause_reason, "permission_denied"); assert.equal(evidence.os_errno, 1);
  assert.equal(evidence.retry_interval_ms, 60000); assert.ok(failure);
  assert.doesNotMatch(lines.join("\n"), /fixture-capture-secret-7284/);
});

test("real Actions logger replays a partial UTF-8 checkpoint from its committed offset", async t => {
  const f = await fixture(t), path = join(f.job.root, "snapshots.log");
  const diagnostic = JSON.stringify(new URL("../.build/diagnostics.js", import.meta.url).href);
  const main = JSON.stringify(new URL("../.build/main.js", import.meta.url).href);
  const script = `import assert from 'node:assert/strict'; import {writeFile,appendFile,readFile} from 'node:fs/promises'; import {join} from 'node:path';
    import {Diagnostics} from ${diagnostic}; import {SnapshotLogTailer} from ${main};
    const root=process.argv[1], path=join(root,'snapshots.log'), commits=[];
    const log=new Diagnostics({run_id:'13',run_attempt:'2'}), tailer=new SnapshotLogTailer(root,log,0,async offset=>commits.push(offset));
    const first=Buffer.from(JSON.stringify({schema_version:1,event:'checkpoint.export',level:'INFO',cycle:1,marker:'café'})+'\\n');
    const split=first.indexOf(Buffer.from('é'))+1;
    await writeFile(path,first.subarray(0,split)); await tailer.flush(true); assert.equal(commits.length,0);
    await appendFile(path,first.subarray(split)); await appendFile(path,JSON.stringify({schema_version:1,event:'checkpoint.cycle',level:'INFO',cycle:1})+'\\n');
    await tailer.flush(true,true); const offset=Number(await readFile(join(root,'snapshots.offset'),'utf8'));
    assert.equal(offset,commits.at(-1)); const resumed=new SnapshotLogTailer(root,log,offset,async()=>{},true); await resumed.flush(true,true);`;
  const { stdout } = await exec(process.execPath, ["--input-type=module", "-e", script, f.job.root]);
  const records = stdout.split("\n").filter(line => line.includes('"event":"checkpoint.export"'));
  assert.equal(records.length, 1); assert.equal(JSON.parse(records[0].slice(records[0].indexOf("{"))).marker, "café");
  assert.equal(Number(await readFile(join(f.job.root, "snapshots.offset"), "utf8")), (await readFile(path)).length);
});

test("an incomplete checkpoint cycle flushes when it becomes stale", async t => {
  const f = await fixture(t), path = join(f.job.root, "snapshots.log"), offsets = [];
  const tailer = new SnapshotLogTailer(f.job.root, f.log, 0, async offset => offsets.push(offset), false, 0);
  await writeFile(path, JSON.stringify({ schema_version: 1, event: "checkpoint.export", level: "INFO", cycle: 4, outcome: "started" }) + "\n");
  await tailer.flush();
  assert.ok(f.records.some(record => record.event === "checkpoint.export" && record.cycle === 4));
  assert.ok(f.timeline.some(entry => entry.level === "group" && entry.line === "Checkpoint #4"));
  assert.equal(offsets.at(-1), (await readFile(path)).length);
});

test("checkpoint upload and retention failures retain their diagnostic causes", async t => {
  const f = await fixture(t), repo = await repository(f); await history(f);
  const metadata = checkpoint({ ...await new TaskGit(repo.cwd, f.job.env, f.log).snapshot(), workspace: repo.cwd });
  await assert.rejects(durableCheckpoint(f.job, metadata, f.log, async () => {
    throw new RunnerError("command_failed", "artifact_upload", "fixture transport failure", { elapsed_ms: 241, exit_code: 7 });
  }), error => {
    assert.equal(error.details.cause_elapsed_ms, 241); assert.equal(error.details.cause_exit_code, 7); return true;
  });
  const saved = { job: f.job, metadata, secrets: f.log.protectedValues, response: "", latest: null };
  const api = async () => { throw Object.assign(new Error("fixture retention failure"),
    { status: 500, response: { headers: { "x-github-request-id": "ABCD:5678" } } }); };
  const receipt = await saveSnapshot(saved, f.log, api, async () => ({ id: 75 }));
  assert.equal(receipt.artifact_id, 75);
  const warning = f.records.find(record => record.event === "checkpoint.retention");
  assert.equal(warning.level, "WARN"); assert.equal(warning.http_status, 500); assert.equal(warning.request_id, "ABCD:5678");
});

test("unsafe final state reports an error without exposing temporary paths", async t => {
  const f = await fixture(t), main = JSON.stringify(new URL("../.build/main.js", import.meta.url).href);
  const path = join(f.temporary, "outside-state.json");
  const script = `import {finish} from ${main}; await finish({github:{},statePath:process.argv[1]});`;
  await assert.rejects(exec(process.execPath, ["--input-type=module", "-e", script, path],
    { env: { ...process.env, RUNNER_TEMP: f.temporary, GITHUB_RUN_ID: "13", GITHUB_RUN_ATTEMPT: "1" } }), error => {
    assert.equal(error.code, 1);
    assert.match(error.stdout, /"reason":"unsafe_final_state"/);
    assert.ok(!error.stdout.includes(f.temporary)); assert.ok(!error.stdout.includes(path));
    return true;
  });
});

test("snapshot watcher registers secrets without emitting Actions mask commands", async t => {
  const f = await fixture(t), path = join(f.job.root, "state.json");
  await writeFile(path, JSON.stringify({ job: f.job, metadata: checkpoint({ outcome: "completed" }), secrets: ["fixture-watch-secret-8293"] }));
  const module = JSON.stringify(new URL("../.build/checkpoint-worker.js", import.meta.url).href);
  const script = `import {watchSnapshots} from ${module}; await watchSnapshots(process.argv[1], {intervalMs:10});`;
  const { stdout } = await exec(process.execPath, ["--input-type=module", "-e", script, path]);
  assert.doesNotMatch(stdout, /::add-mask::|fixture-watch-secret-8293/);
});

test("snapshot worker failure diagnostics hide temporary paths", async t => {
  const f = await fixture(t), repo = await repository(f); await history(f);
  const metadata = checkpoint({ ...await new TaskGit(repo.cwd, f.job.env, f.log).snapshot(), workspace: repo.cwd });
  const saved = { job: f.job, metadata, secrets: f.log.protectedValues, response: "", latest: null,
    control: { directory: join(f.temporary, "missing-control"), nonce: "fixture-nonce" } };
  const path = join(f.job.root, "state.json"), lines = [];
  await writeFile(path, JSON.stringify(saved));
  const watching = watchSnapshots(path, { intervalMs: 10000, emit: line => lines.push(String(line)) });
  try {
    const deadline = Date.now() + 10000;
    while (!lines.some(line => line.includes('"event":"runtime.failed"'))) {
      assert.ok(Date.now() < deadline, "Expected the worker failure");
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  } finally {
    saved.metadata.outcome = "completed";
    await writeFile(path, JSON.stringify(saved));
    await watching;
  }
  const failure = lines.map(line => JSON.parse(line)).find(record => record.event === "runtime.failed");
  assert.match(failure.native_cause, /<outside-workspace>/);
  assert.ok(!lines.join("\n").includes(f.temporary));
});

test("patch parsing limits edits to the executable and suppresses sensitive or outside paths", async t => {
  const f = await fixture(t), r = await repository(f);
  const patch = "*** Begin Patch\n*** Update File: README.md\n@@\n-before\n+after\n*** Update File: .env\n@@\n-password\n+secret\n*** End Patch";
  assert.equal(parseApplyPatch("rg apply_patch", "", r.cwd), null);
  assert.equal(parseApplyPatch("cat tests/cli.test.mjs", "", r.cwd), null);
  const fallback = parseApplyPatch('apply_patch <<< "$PATCH"', 'Success. Updated the following files:\nM README.md\n', r.cwd);
  assert.equal(fallback[0].path, "README.md"); assert.equal(fallback[0].kind, "update");
  const edits = parseApplyPatch(`cd . && apply_patch <<'PATCH'\n${patch}\nPATCH`, "", r.cwd);
  assert.equal(edits[0].path, "README.md"); assert.match(edits[0].diff, /\+after/);
  assert.equal(edits[1].suppressed, "sensitive file"); assert.equal(edits[1].diff, undefined);
  assert.equal(activityPath("../outside.key", r.cwd).path, "<outside-workspace>");
  assert.equal(activityPath("src/credentials.ts", r.cwd).sensitive, false);
  assert.equal(summarizeCommand("git commit -m 'private task'", r.cwd), "git commit");
  assert.equal(summarizeCommand("node --test tests/runtime.test.mjs", r.cwd), "node --test tests/runtime.test.mjs");
  const missing = parseApplyPatch("apply_patch <<'PATCH'\n*** Begin Patch\n*** Update File: missing.txt\n@@\n-before\n+after\n*** End Patch\nPATCH", "", r.cwd);
  assert.equal(missing[0].path, "missing.txt"); assert.equal(missing[0].suppressed, "original path unverified");
  assert.equal(parseApplyPatch(`apply_patch <<'PATCH' | cat\n${patch}\nPATCH`, "", r.cwd), null);
  assert.equal(parseApplyPatch(`true # comment; apply_patch <<'PATCH'\n${patch}\nPATCH`, "", r.cwd), null);
});

test("patch detection ignores heredoc data and binds patches to their executable", async t => {
  const f = await fixture(t), r = await repository(f);
  const body = name => `*** Begin Patch\n*** Update File: ${name}\n@@\n-before\n+after\n*** End Patch`;
  const fake = body("fake.txt").replace("*** End Patch", "*** Update File: fake2.txt\n@@\n-before\n+after\n*** End Patch");
  const data = `cat <<'EOF'\napply_patch <<'PATCH'\n${fake}\nPATCH\nEOF`;
  assert.equal(parseApplyPatch(data, "", r.cwd), null);
  const edits = parseApplyPatch(`${data}\napply_patch <<'PATCH'\n${body("real.txt")}\nPATCH`, "", r.cwd);
  assert.equal(edits.length, 1); assert.equal(edits[0].suppressed, "working directory unknown");
});

test("patch parsing suppresses unresolved shell expansion while preserving quoted heredocs", async t => {
  const f = await fixture(t), r = await repository(f);
  await writeFile(join(r.cwd, "$TARGET"), "before\n");
  const patch = '*** Begin Patch\n*** Update File: $TARGET\n@@\n-before\n+after\n*** End Patch';
  const command = marker => `apply_patch <<${marker}\n${patch}\nPATCH`;
  const expanded = parseApplyPatch(command('PATCH'), "", r.cwd);
  assert.equal(expanded[0].path, "<outside-workspace>"); assert.equal(expanded[0].suppressed, "shell expansion unresolved");
  assert.equal(expanded[0].diff, undefined);
  const quoted = parseApplyPatch(command("'PATCH'"), "", r.cwd);
  assert.equal(quoted[0].path, "$TARGET"); assert.match(quoted[0].diff, /\+after/);
  const wrapped = parseApplyPatch(`/bin/bash -c "${command("'PATCH'")}"`, "", r.cwd);
  assert.equal(wrapped[0].suppressed, "shell expansion unresolved"); assert.equal(wrapped[0].diff, undefined);
});

test("patch parsing suppresses diffs when the effective shell directory is outside or uncertain", async t => {
  const f = await fixture(t), r = await repository(f);
  const patch = "*** Begin Patch\n*** Update File: config.txt\n@@\n-before\n+unregistered-sensitive-value\n*** End Patch";
  const command = prefix => `${prefix} && apply_patch <<'PATCH'\n${patch}\nPATCH`;
  const external = parseApplyPatch(command("cd '/tmp/private folder'"), "", r.cwd);
  assert.equal(external[0].path, "<outside-workspace>");
  assert.equal(external[0].suppressed, "outside workspace");
  assert.equal(external[0].diff, undefined);
  for (const prefix of ['cd "$TARGET"', "cd -P", "cd -L", "cd /tmp/private && echo done; true"]) {
    const edits = parseApplyPatch(command(prefix), "", r.cwd);
    assert.equal(edits[0].path, "<outside-workspace>");
    assert.equal(edits[0].suppressed, "working directory unknown");
    assert.equal(edits[0].diff, undefined);
  }
  assert.equal(parseApplyPatch(command("cd /tmp/private && cd /missing || true"), "", r.cwd), null);
  await mkdir(join(r.cwd, "sub directory"));
  await writeFile(join(r.cwd, "sub directory/config.txt"), "before\n");
  const inside = parseApplyPatch(command(`cd '/tmp' && cd '${join(r.cwd, "sub directory")}'`), "", r.cwd);
  assert.equal(inside[0].path, "sub directory/config.txt");
  assert.match(inside[0].diff, /unregistered-sensitive-value/);
  await mkdir(join(r.cwd, "-P"));
  await writeFile(join(r.cwd, "-P/config.txt"), "before\n");
  const explicit = parseApplyPatch(command("cd -- -P"), "", r.cwd);
  assert.equal(explicit[0].path, "-P/config.txt"); assert.match(explicit[0].diff, /unregistered-sensitive-value/);
});

test("patch moves suppress diff bodies when either path is sensitive or outside the workspace", async t => {
  const f = await fixture(t), r = await repository(f);
  const command = (source, destination) => `apply_patch <<'PATCH'\n*** Begin Patch\n*** Update File: ${source}\n*** Move to: ${destination}\n@@\n-before\n+unregistered-sensitive-value\n*** End Patch\nPATCH`;
  for (const [source, destination] of [["config.txt", ".env"], ["config.txt", "../outside.txt"], [".env", "config.txt"]]) {
    const edits = parseApplyPatch(command(source, destination), "", r.cwd);
    assert.equal(edits.length, 1);
    assert.ok(edits[0].suppressed);
    assert.equal(edits[0].diff, undefined);
  }
  const safe = parseApplyPatch(command("config.txt", "renamed.txt"), "", r.cwd);
  assert.equal(safe[0].path, "config.txt -> renamed.txt");
  assert.equal(safe[0].suppressed, "original source path unverified"); assert.equal(safe[0].diff, undefined);
});

test("activity paths protect sensitive symlink names and resolve symlink traversal before checking the workspace", async t => {
  const f = await fixture(t), r = await repository(f);
  await mkdir(join(r.cwd, ".docker"));
  await writeFile(join(r.cwd, ".docker/config.json"), "{}\n");
  await writeFile(join(r.cwd, ".docker/Dockerfile"), "FROM scratch\n");
  await symlink(".docker/config.json", join(r.cwd, "docker-config-alias"));
  assert.equal(activityPath(".docker/config.json", r.cwd).sensitive, true);
  assert.equal(activityPath("docker-config-alias", r.cwd).sensitive, true);
  assert.equal(activityPath(".docker/Dockerfile", r.cwd).sensitive, false);
  await mkdir(join(r.cwd, "config"));
  await writeFile(join(r.cwd, "config/development.env"), "unregistered-sensitive-value\n");
  await symlink("config/development.env", join(r.cwd, ".env"));
  const logical = activityPath(".env", r.cwd);
  assert.equal(logical.path, ".env"); assert.equal(logical.outside, false); assert.equal(logical.sensitive, true);
  const patch = "apply_patch <<'PATCH'\n*** Begin Patch\n*** Update File: .env\n@@\n-before\n+unregistered-sensitive-value\n*** End Patch\nPATCH";
  const edits = parseApplyPatch(patch, "", r.cwd);
  assert.equal(edits[0].suppressed, "sensitive file"); assert.equal(edits[0].diff, undefined);

  await writeFile(join(r.cwd, "config/.env"), "sensitive target\n");
  await symlink("config/.env", join(r.cwd, "settings"));
  assert.equal(activityPath("settings", r.cwd).sensitive, true);
  await symlink("missing.env", join(r.cwd, "broken"));
  assert.equal(activityPath("broken", r.cwd).outside, true);
  assert.equal(activityPath("broken/child", r.cwd).outside, true);
  const outside = join(f.temporary, "outside"), child = join(outside, "child");
  await mkdir(child, { recursive: true });
  await writeFile(join(outside, "external.txt"), "outside\n");
  await symlink(child, join(r.cwd, "link"));
  assert.equal(activityPath("link/../external.txt", r.cwd).outside, true);
  assert.equal(activityPath("link/../missing.txt", r.cwd).outside, true);
});

test("Git summary parses renamed and untracked paths with NUL delimiters", async t => {
  const f = await fixture(t), r = await repository(f), git = new TaskGit(r.cwd, f.job.env, f.log);
  await r.git("mv", "README.md", "renamed & file.md");
  await r.git("commit", "-m", "Rename fixture");
  await writeFile(join(r.cwd, "untracked & file.txt"), "work\n");
  const summary = await git.summary(r.base);
  assert.equal(summary.base, r.base);
  assert.ok(summary.commits.some(commit => commit.subject === "Rename fixture"));
  assert.ok(summary.changes.some(change => change.previous === "README.md" && change.path === "renamed & file.md"));
  assert.ok(summary.untracked.includes("untracked & file.txt"));
  assert.equal(summary.unpushed, 1);
});

test("Git summary handles unavailable or unrelated bases and bounds path results", async t => {
  const f = await fixture(t), r = await repository(f), git = new TaskGit(r.cwd, f.job.env, f.log);
  const unrelated = await r.git("commit-tree", `${r.base}^{tree}`, "-m", "Unrelated fixture");
  assert.equal((await git.summary("f".repeat(40))).base, null);
  assert.equal((await git.summary(unrelated)).base, null);
  await Promise.all(Array.from({ length: 105 }, (_, index) => writeFile(join(r.cwd, `untracked-${index}.txt`), "work\n")));
  const summary = await git.summary(r.base);
  assert.equal(summary.changes.length + summary.untracked.length, 100);
  assert.equal(summary.omitted, 5);
});

async function finalization(t, { host, denyCleanup = false, lost = [], failResult = false, conflicting = null, protectResult = false,
  response = "fixture-result-private-content-8147", checkpointSaved = true, runner = "codex", prepareRepo }) {
  assert.notEqual(process.geteuid(), 0);
  const f = await fixture(t, runner), repo = await repository(f);
  if (prepareRepo) await prepareRepo(f, repo);
  await history(f);
  await readOnlyCache(f.job.home);
  const previous = { artifact_id: 72, sequence: 3, checkpoint_sha: repo.base };
  const payload = response;
  const statePath = join(f.job.root, "state.json");
  if (checkpointSaved) await writeFile(join(f.job.root, "latest.json"), JSON.stringify(previous));
  await writeFile(statePath, JSON.stringify({ job: f.job, metadata: checkpoint({ outcome: "completed", workspace: repo.cwd,
    session_id: checkpointSaved ? sessionId : "" }), secrets: [...f.log.protectedValues, ...(protectResult ? [payload] : [])], response: payload,
    latest: checkpointSaved ? previous : null, initial_git: { sha: repo.base, branch: repo.branch } }), { mode: 0o600 });
  const outputFile = join(f.temporary, "actions-output"), summaryFile = join(f.temporary, "actions-summary");
  await writeFile(outputFile, "");
  await writeFile(summaryFile, "");

  const remote = { full_name: "fixture/repo", id: 9 };
  const run = { id: 13, run_attempt: 1, workflow_id: lineage.workflow_id, head_sha: lineage.workflow_sha,
    head_branch: lineage.branch, path: lineage.workflow_path, event: "workflow_dispatch", repository: remote, head_repository: remote };
  const assets = new Map(), attempts = [], lookups = [];
  let endpoint;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, endpoint);
    const json = (status, body) => response.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    if (url.pathname.endsWith("/CreateArtifact")) {
      const { name } = JSON.parse(body);
      const id = name.startsWith("remote-dev-session-") ? 80 : 81;
      assets.set(id, { name, blocks: [], finalized: false });
      return json(200, { ok: true, signedUploadUrl: endpoint + "/account/container/" + id });
    }
    if (url.pathname.startsWith("/account/container/") && request.method === "PUT") {
      const asset = assets.get(Number(url.pathname.split("/").at(-1)));
      if (url.searchParams.get("comp") === "block") asset.blocks.push(body);
      return response.writeHead(201, { etag: '"fixture-blob"' }).end();
    }
    if (url.pathname.endsWith("/FinalizeArtifact")) {
      const { name } = JSON.parse(body);
      const id = name.startsWith("remote-dev-session-") ? 80 : 81;
      attempts.push(id);
      if (id === 81 && failResult) return json(409, { msg: "fixture upload rejected" });
      assets.get(id).finalized = true;
      if (lost.includes(id)) return response.destroy();
      return json(200, { ok: true, artifactId: String(id) });
    }
    const runPath = "/repos/fixture/repo/actions/runs/13";
    if (url.pathname === runPath) return json(200, run);
    const metadata = ([id, asset]) => ({ id, name: asset.name, size_in_bytes: Buffer.concat(asset.blocks).length,
      expired: false, expires_at: "2099-01-01T00:00:00Z", workflow_run: {
        id: run.id, repository_id: remote.id, head_repository_id: remote.id, head_sha: run.head_sha, head_branch: run.head_branch,
      } });
    if (url.pathname === runPath + "/artifacts") {
      const name = url.searchParams.get("name");
      if (name) lookups.push(name);
      const artifacts = [...assets].filter(([, asset]) => asset.finalized && (!name || asset.name === name)).map(metadata);
      if (name && conflicting === "duplicate" && artifacts.length) artifacts.push({ ...artifacts[0], id: 82 });
      return json(200, { artifacts });
    }
    const artifact = url.pathname.match(/^\/repos\/fixture\/repo\/actions\/artifacts\/(80|81)(\/zip)?$/);
    if (artifact) {
      const id = Number(artifact[1]), asset = assets.get(id);
      if (!asset?.finalized) return json(404, { message: "fixture artifact absent" });
      if (!artifact[2]) return json(200, metadata([id, asset]));
      const bytes = conflicting === "content" && id === 81 ? await readFile(join(f.temporary, "wrong-record.zip")) : Buffer.concat(asset.blocks);
      return response.writeHead(200, { "Content-Type": "application/zip" }).end(bytes);
    }
    return json(404, { message: "unrecognized fixture endpoint" });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  endpoint = "http://127.0.0.1:" + server.address().port;
  if (conflicting === "content") {
    await exec("python3", ["-c", 'import sys, zipfile\nwith zipfile.ZipFile(sys.argv[1], "w") as z: z.writestr("record.json", "{}")',
      join(f.temporary, "wrong-record.zip")]);
  }
  const token = "e30." + Buffer.from(JSON.stringify({ scp: "Actions.Results:11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222" })).toString("base64url") + ".fixture";
  const env = { ...process.env, RUNNER_TEMP: f.temporary, TMPDIR: join(f.job.root, "tmp"), NO_PROXY: "127.0.0.1,localhost",
    GITHUB_OUTPUT: outputFile, GITHUB_STEP_SUMMARY: summaryFile, ACTIONS_RESULTS_URL: endpoint, ACTIONS_RUNTIME_TOKEN: token, REMOTE_DEV_UPLOAD_TIMEOUT_MS: "7000" };
  if (host === undefined) delete env.RUNNER_ENVIRONMENT;
  else env.RUNNER_ENVIRONMENT = host;
  const script = `
    import { finish } from ${JSON.stringify(new URL("../.build/main.js", import.meta.url).href)};
    const [statePath, endpoint] = process.argv.slice(1);
    const github = { request: async (route, options) => {
      const [method, path] = route.split(" ");
      const response = await fetch(endpoint + path, { method, signal: options.request?.signal });
      if (!response.ok) throw Object.assign(new Error("Fixture GitHub request failed"), { status: response.status });
      return { data: path.endsWith("/zip") ? await response.arrayBuffer() : await response.json() };
    } };
    await finish({ github, statePath });
  `;
  let stdout, code = 0;
  if (denyCleanup) await chmod(f.temporary, 0o555);
  try {
    ({ stdout } = await exec(process.execPath, ["--input-type=module", "-e", script, statePath, endpoint], { env, timeout: 35000 }));
  } catch (error) {
    assert.equal(error.code, 1, error.stderr);
    ({ stdout, code } = error);
  } finally {
    if (denyCleanup) await chmod(f.temporary, 0o700);
  }
  const lines = stdout.split("\n").filter(line => !line.startsWith("::debug::") && !line.startsWith("::add-mask::"));
  assert.ok(lines.every(line => !line.includes(f.temporary) && (!payload || !line.includes(payload)) &&
    f.log.protectedValues.every(secret => !line.includes(secret))));
  const records = lines.filter(line => line.includes('"schema_version":1')).map(line => JSON.parse(line.slice(line.indexOf("{"))));
  const cleanup = records.find(record => record.reason === "job_cleanup_failed");
  const exportFailure = records.find(record => record.event === "runtime.failed" && record.stage !== "cleanup");
  const reconciled = records.filter(record => record.event === "artifact.reconcile");
  if (denyCleanup) assert.deepEqual(await readdir(f.job.root), []);
  else await assert.rejects(lstat(f.job.root), { code: "ENOENT" });
  return { code, cleanup, exportFailure, reconciled, attempts, lookups, assets, records, previous, summary: await readFile(summaryFile, "utf8") };
}

test("final cleanup removes the Go cache after successful uploads", async t => {
  const result = await finalization(t, { host: "github-hosted" });
  assert.equal(result.code, 0);
  assert.equal(result.cleanup, undefined);
  assert.deepEqual(result.attempts, [80, 81]);
  assert.deepEqual(result.lookups, []);
  assert.ok(result.summary.startsWith("## Agent’s final reply\n\n<pre>fixture-result-private-content-8147</pre>"));
  assert.match(result.summary, /- \*\*Full result:\*\* \[artifact 81\]\(https:\/\/github\.com\/fixture\/repo\/actions\/runs\/13\/artifacts\/81\)/);
  assert.ok(result.summary.includes(`- **Outcome:** \`completed\``));
  assert.ok(result.summary.includes(`- **Session:** \`${sessionId}\``));
  assert.ok(result.summary.includes(`- **Saved checkpoint:** [artifact 80](https://github.com/fixture/repo/actions/runs/13/artifacts/80)`));
  assert.ok(result.summary.includes(`- **Execution log:** [run 13, attempt 1](https://github.com/fixture/repo/actions/runs/13/attempts/1)`));
  assert.match(result.summary, /## How to resume[\s\S]*- `runner`: `codex`[\s\S]*- `resume-run-id`: `13`[\s\S]*- `plan`: answer the question or add the requested context/);
});

for (const runner of ["codex", "claude"]) test(`final summary shows an ordinary ${runner} completion`, async t => {
  const response = "Implemented the change.\n\nValidation passed.";
  const { code, summary } = await finalization(t, { host: "github-hosted", response, runner });
  assert.equal(code, 0);
  assert.ok(summary.startsWith(`## Agent’s final reply\n\n<pre>${response}</pre>`));
  assert.ok(summary.includes(`- **Runner:** \`${runner}\``));
});

test("final summary preserves a closing question at the start of the result", async t => {
  const response = "The implementation is ready.\n\nWhich branch should receive the follow-up?";
  const { code, summary } = await finalization(t, { host: "github-hosted", response });
  assert.equal(code, 0);
  assert.ok(summary.startsWith("## Agent’s final reply"));
  assert.match(summary, /Which branch should receive the follow-up\?<\/pre>\n\n## Runner outcome/);
});

test("final summary links the execution log when no reply was saved", async t => {
  const { code, summary } = await finalization(t, { host: "github-hosted", response: "" });
  assert.equal(code, 0);
  assert.match(summary, /No final reply was saved\. Inspect the \[execution log\]\(https:\/\/github\.com\/fixture\/repo\/actions\/runs\/13\/attempts\/1\) for details\./);
  assert.doesNotMatch(summary, /<pre><\/pre>/);
});

test("final summary renders reply markup as escaped text", async t => {
  const response = "Completed <script>alert(\"x\")</script> & **markdown**.";
  const { code, summary } = await finalization(t, { host: "github-hosted", response });
  assert.equal(code, 0);
  assert.match(summary, /&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt; &amp; \*\*markdown\*\*\./);
  assert.doesNotMatch(summary, /Completed <script>/);
});

test("final summary truncates an oversized reply while preserving its opening, closing question, and artifact", async t => {
  const response = `Opening context 😀\n${"x".repeat(1024 * 1024)}\nShould the release include the migration?`;
  const { code, summary } = await finalization(t, { host: "github-hosted", response });
  assert.equal(code, 0);
  assert.ok(Buffer.byteLength(summary) < 1024 * 1024);
  assert.match(summary, /<pre>Opening context 😀\n/);
  assert.match(summary, /middle omitted from this summary; open the full result artifact/);
  assert.match(summary, /\nShould the release include the migration\?<\/pre>/);
  assert.match(summary, /\[artifact 81\]\(https:\/\/github\.com\/fixture\/repo\/actions\/runs\/13\/artifacts\/81\)/);
});

test("final summary omits resume instructions when no checkpoint was saved", async t => {
  const { code, summary, records } = await finalization(t, { host: "github-hosted", checkpointSaved: false });
  assert.equal(code, 0);
  assert.match(summary, /- \*\*Saved checkpoint:\*\* unavailable/);
  assert.doesNotMatch(summary, /## How to resume|resume-run-id/);
  const final = records.find(record => record.event === "checkpoint.final");
  assert.equal(final.reason, "session_not_started"); assert.equal(final.session_id, null);
  assert.equal(final.native_outcome, "completed"); assert.equal(final.recovery_reason, null);
});

for (const host of ["github-hosted", "self-hosted", undefined]) test(`final cleanup reports a real denied rmdir on ${host ?? "an unknown runner"}`, async t => {
  const result = await finalization(t, { host, denyCleanup: true, lost: host === "github-hosted" ? [80, 81] : [] });
  const warning = host === "github-hosted";
  assert.equal(result.code, warning ? 0 : 1);
  assert.equal(result.exportFailure, undefined);
  assert.deepEqual(result.attempts, [80, 81]);
  assert.deepEqual(result.reconciled.map(record => [record.outcome, record.artifact_id]), warning ? [["reconciled", 80], ["reconciled", 81]] : []);
  const { cleanup } = result;
  assert.equal(cleanup.level, warning ? "WARN" : "ERROR");
  assert.equal(cleanup.runner_environment, host ?? "unknown");
  assert.equal(cleanup.stage, "cleanup");
  assert.equal(cleanup.syscall, "rmdir");
  assert.equal(cleanup.errno_code, "EACCES");
  assert.equal(cleanup.run_id, "13");
  assert.equal(cleanup.run_attempt, "1");
  assert.equal(cleanup.session_id, sessionId);
  assert.equal(cleanup.last_durable_checkpoint.artifact_id, 80);
  assert.equal(cleanup.result_artifact_id, 81);
  assert.ok(cleanup.elapsed_ms >= 0);
  t.diagnostic(JSON.stringify(cleanup));
});

test("final cleanup preserves a separate failed export and its saved checkpoint", async t => {
  const result = await finalization(t, { host: "github-hosted", denyCleanup: true, failResult: true });
  assert.equal(result.code, 1);
  assert.equal(result.exportFailure.stage, "artifact_upload");
  assert.equal(result.exportFailure.last_durable_checkpoint.artifact_id, 80);
  assert.equal(result.cleanup.level, "ERROR");
  assert.equal(result.cleanup.result_artifact_id, null);
  assert.equal(result.reconciled[0].reason, "artifact_receipt_not_found");
});

for (const [conflicting, reason, id] of [["duplicate", "ambiguous_artifact_receipt", 80], ["content", "artifact_content_mismatch", 81]]) {
  test(`final artifact recovery rejects ${conflicting} evidence without another upload`, async t => {
    const result = await finalization(t, { host: "github-hosted", lost: [id], conflicting });
    assert.equal(result.code, 1);
    assert.equal(result.lookups.length, 1);
    assert.deepEqual(result.attempts, id === 80 ? [80] : [80, 81]);
    assert.equal(result.reconciled[0].reason, reason);
    assert.equal(result.exportFailure.last_durable_checkpoint.artifact_id, id === 80 ? result.previous.artifact_id : 80);
  });
}

test("final credential validation stops before attempting or reconciling the result upload", async t => {
  const result = await finalization(t, { host: "github-hosted", protectResult: true });
  assert.equal(result.code, 1);
  assert.deepEqual(result.attempts, [80]);
  assert.deepEqual(result.lookups, []);
  assert.equal(result.exportFailure.reason, "credential_in_result");
  assert.doesNotMatch(result.summary, /fixture-result-private-content-8147/);
});

test("final edit history escapes Git content and redacts configured secrets", async t => {
  const secret = "fixture-commit-secret-9821";
  const result = await finalization(t, { host: "github-hosted", prepareRepo: async (f, repo) => {
    f.log.protect(secret);
    await writeFile(join(repo.cwd, "notes <sample>.txt"), "work\n");
    await repo.git("add", "notes <sample>.txt");
    await repo.git("commit", "-m", `Change <example> ${secret}`);
    await writeFile(join(repo.cwd, "untracked & work.txt"), "work\n");
  } });
  assert.equal(result.code, 0);
  assert.match(result.summary, /## Runner outcome[\s\S]*## Edit history/);
  assert.match(result.summary, /notes &lt;sample&gt;\.txt/);
  assert.match(result.summary, /untracked &amp; work\.txt/);
  assert.match(result.summary, /Change &lt;example&gt; \[redacted\]/);
  assert.ok(!result.summary.includes(secret));
});

for (const failure of ["status", "merge-base", "cat-file", "object-check-stderr"]) test(`Git summary ${failure} failure remains visible without failing final export`, async t => {
  const result = await finalization(t, { host: "github-hosted", prepareRepo: async f => {
    const bin = join(f.temporary, "git-summary-failure");
    await mkdir(bin);
    const pattern = { status: "*--untracked-files=normal*", "merge-base": "*merge-base*", "cat-file": "*'cat-file -e'*",
      "object-check-stderr": "*--batch-check*" }[failure];
    const action = failure === "object-check-stderr" ? "read -r object; printf '%s missing\\n' \"$object\"; printf 'object access error\\n' >&2; exit 0" : "exit 128";
    await writeFile(join(bin, "git"), `#!/bin/sh\ncase "$*" in ${pattern}) ${action} ;; esac\nexec /usr/bin/git "$@"\n`, { mode: 0o700 });
    f.job.env.PATH = `${bin}:${f.job.env.PATH}`;
  } });
  assert.equal(result.code, 0);
  assert.ok(result.records.some(record => record.event === "runtime.summary_git" && record.level === "INFO" && record.outcome === "unavailable"));
  assert.match(result.summary, /Git edit history unavailable/);
});

test("the post-escape summary credential gate fails before writing the summary", async t => {
  const result = await finalization(t, { host: "github-hosted", prepareRepo: async (f, repo) => {
    f.log.protect("amp;");
    await writeFile(join(repo.cwd, "work & notes.txt"), "work\n");
  } });
  assert.equal(result.code, 1);
  assert.equal(result.exportFailure.reason, "credential_in_summary");
  assert.equal(result.summary, "");
});

test("the pre-escape summary credential gate catches values spanning static and Git text", async t => {
  const result = await finalization(t, { host: "github-hosted", prepareRepo: async (f, repo) => {
    f.log.protect("Untracked <fixture-note");
    await writeFile(join(repo.cwd, "<fixture-note>.txt"), "work\n");
  } });
  assert.equal(result.code, 1);
  assert.equal(result.exportFailure.reason, "credential_in_summary");
  assert.equal(result.summary, "");
});

test("final artifact recovery leaves SDK file validation failed even when the exact artifact already exists", async t => {
  const f = await fixture(t);
  const name = "remote-dev-result-r13-a1";
  await writeFile(join(f.job.exports, "record.json"), "{}");
  const archive = join(f.temporary, "stored-result.zip");
  await exec("python3", ["-c", 'import sys, zipfile\nwith zipfile.ZipFile(sys.argv[1], "w") as z: z.write(sys.argv[2], "record.json")',
    archive, join(f.job.exports, "record.json")]);
  const bytes = await readFile(archive);
  const remote = { full_name: "fixture/repo", id: 9 };
  const artifact = { id: 81, name, size_in_bytes: bytes.length, expired: false, expires_at: "2099-01-01T00:00:00Z",
    workflow_run: { id: 13, repository_id: remote.id, head_repository_id: remote.id, head_sha: lineage.workflow_sha, head_branch: lineage.branch } };
  const calls = [];
  const api = async path => {
    calls.push(path);
    if (path.endsWith("/runs/13")) return { id: 13, run_attempt: 1, repository: remote, head_repository: remote,
      event: "workflow_dispatch", workflow_id: lineage.workflow_id, path: lineage.workflow_path, head_sha: lineage.workflow_sha, head_branch: lineage.branch };
    if (path.includes("/runs/13/artifacts?")) return { artifacts: [artifact] };
    if (path.endsWith("/artifacts/81")) return artifact;
    if (path.endsWith("/artifacts/81/zip")) return bytes;
    throw new Error("Unexpected fixture GitHub request");
  };
  await assert.rejects(uploadSnapshot(f.job, name, [], f.job.exports, f.log, f.job.env,
    { api, metadata: checkpoint({ outcome: "completed" }), kind: "record" }), { reason: "command_failed" });
  assert.deepEqual(calls, []);
  assert.ok(f.records.every(record => record.event !== "artifact.reconcile"));
});

for (const mode of ['direct', 'threaded', 'resume-in-flight']) test(`a managed live SQLite/WAL writer pauses for consistent snapshots and resumes afterward (${mode})`, async t => {
  const f = await fixture(t), marker = join(f.temporary, 'counter'); let control;
  const ready = join(f.temporary, 'resume-ready'), allow = join(f.temporary, 'resume-allow');
  if (mode === 'resume-in-flight') {
    const source = await readFile(join(root, '.build/supervise.py'), 'utf8');
    const line = source.split('\n').findIndex(value => value.includes('reply.unlink(missing_ok=True)')) + 1;
    assert.ok(line > 0);
    await writeFile(join(f.temporary, 'sitecustomize.py'), `import sys,time
from pathlib import Path
held=False
def trace(frame,event,arg):
 global held
 if not held and event=='line' and frame.f_code.co_filename.endswith('/supervise.py') and frame.f_lineno==${line}:
  held=True;Path(${JSON.stringify(ready)}).write_text('ready')
  end=time.monotonic()+2
  while not Path(${JSON.stringify(allow)}).exists() and time.monotonic()<end: time.sleep(0.001)
 return trace
sys.settrace(trace)
`);
    f.job.env.PYTHONPATH = f.temporary;
  }
  const writer = `const fs=require('node:fs'),{DatabaseSync}=require('node:sqlite');
const db=new DatabaseSync(process.env.CODEX_HOME+'/state_5.sqlite');db.exec('PRAGMA journal_mode=WAL; CREATE TABLE progress (value INTEGER); INSERT INTO progress VALUES (0); CREATE TABLE threads (id TEXT, rollout_path TEXT)');db.prepare('INSERT INTO threads VALUES (?, ?)').run(${JSON.stringify(sessionId)},process.env.CODEX_HOME+'/sessions/rollout.jsonl');
fs.mkdirSync(process.env.CODEX_HOME+'/sessions');fs.writeFileSync(process.env.CODEX_HOME+'/sessions/rollout.jsonl',JSON.stringify({type:'session_meta',payload:{id:${JSON.stringify(sessionId)}}})+'\\n');
setInterval(()=>{db.exec('UPDATE progress SET value=value+1');fs.writeFileSync(${JSON.stringify(marker + '.tmp')},String(db.prepare('SELECT value FROM progress').get().value));fs.renameSync(${JSON.stringify(marker + '.tmp')},${JSON.stringify(marker)})},5);`;
  const threaded = `import subprocess,sys,threading
def run():
 subprocess.run(sys.argv[1:],check=True)
worker=threading.Thread(target=run);worker.start();worker.join()`;
  const running = command(mode === 'threaded' ? 'python3' : process.execPath, mode === 'threaded' ? ['-c', threaded, process.execPath, '-e', writer] : ['-e', writer],
    { cwd: f.temporary, env: f.job.env, stage: 'writer', timeoutMs: 3000, onControl: value => { control = value; } }).catch(error => error);
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) { try { if (Number(await readFile(marker)) > 3) break; } catch (error) { if (error.code !== 'ENOENT') throw error; } await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.ok(Number(await readFile(marker)) > 3, 'The real writer started before pausing');
  const unchanged = async () => {
    const before = await readFile(marker, 'utf8'); await new Promise(resolve => setTimeout(resolve, 75)); assert.equal(await readFile(marker, 'utf8'), before);
  };
  await control.freeze(unchanged);
  if (mode === 'resume-in-flight') {
    const deadline = Date.now() + 1000;
    for (;;) {
      try { await readFile(ready); break; } catch (error) { if (error.code !== 'ENOENT') throw error; }
      assert.ok(Date.now() < deadline, 'The supervisor reached the resume boundary');
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    let copying = false;
    const second = control.freeze(async () => { copying = true; await unchanged(); }).catch(error => error);
    try {
      await new Promise(resolve => setTimeout(resolve, 50));
      assert.equal(copying, false, 'A previous acknowledgement cannot authorize this copy');
    } finally {
      await writeFile(allow, 'resume'); const result = await second; if (result instanceof Error) throw result;
    }
  }
  const exported = await exportCheckpoint(f.job, checkpoint(), f.log, undefined, control);
  const db = new DatabaseSync(join(exported.root, 'codex/state_5.sqlite'), { readOnly: true });
  assert.ok(db.prepare('SELECT value FROM progress').get().value > 0); db.close();
  const before = Number(await readFile(marker)), resumed = Date.now() + 750;
  while (Number(await readFile(marker)) <= before && Date.now() < resumed) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(Number(await readFile(marker)) > before);
  const result = await running; assert.equal(result.reason, 'command_timeout'); assert.equal(result.details.quiescent, true);
  const stopped = await readFile(marker, 'utf8'); await new Promise(resolve => setTimeout(resolve, 50)); assert.equal(await readFile(marker, 'utf8'), stopped);
});

async function waitFor(check, message) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail(message);
}

async function readMarker(path) {
  try { return await readFile(path, 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; return ''; }
}

test('the checkpoint watcher recovers from a real cross-user pause denial in the same session', async t => {
  try {
    assert.notEqual(process.getuid(), 0);
    await exec('sudo', ['-n', '--', 'true']);
  } catch (error) {
    if (process.env.GITHUB_ACTIONS === 'true') throw error;
    t.skip('requires a non-root test runner with passwordless sudo for the cross-user helper');
    return;
  }
  const f = await fixture(t), r = await repository(f);
  await history(f);
  const statePath = join(f.job.root, 'state.json'), latestPath = join(f.job.root, 'latest.json');
  const counter = join(f.temporary, 'writer-counter'), helperPid = join(f.temporary, 'helper-pid');
  const release = join(f.temporary, 'release-helper'), finish = join(f.temporary, 'finish-writer');
  const captures = [], records = [];
  const upload = async (_job, _name, _files, directory) => {
    captures.push(JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')));
    if (captures.length > 1) {
      const db = new DatabaseSync(join(directory, 'codex/state_5.sqlite'), { readOnly: true });
      try { assert.ok(db.prepare('SELECT value FROM progress').get().value > 0); }
      finally { db.close(); }
    }
    return { id: captures.length };
  };
  const api = async () => ({ artifacts: [] });
  const saved = { job: f.job, metadata: checkpoint({ workspace: r.cwd }), secrets: f.log.protectedValues };
  const previous = await saveSnapshot(saved, f.log, api, upload);
  const helper = `import os, sys, time
from pathlib import Path
print(os.getpid(), flush=True)
deadline = time.monotonic() + 12
while not Path(sys.argv[1]).exists() and time.monotonic() < deadline:
    time.sleep(0.01)
`;
  const writer = `const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const [counter, helperPid, release, finish, helperCode] = process.argv.slice(1);
const db = new DatabaseSync(process.env.CODEX_HOME + '/state_5.sqlite');
db.exec('PRAGMA journal_mode=WAL; CREATE TABLE progress (value INTEGER); INSERT INTO progress VALUES (0); CREATE TABLE threads (id TEXT, rollout_path TEXT)');
db.prepare('INSERT INTO threads VALUES (?, ?)').run(${JSON.stringify(sessionId)}, process.env.CODEX_HOME + '/sessions/rollout.jsonl');
const helper = spawn('sudo', ['-n', '--', 'python3', '-I', '-c', helperCode, release], { stdio: ['ignore', 'pipe', 'inherit'] });
helper.once('error', error => { throw error; });
helper.stdout.once('data', data => fs.writeFileSync(helperPid, data.toString().trim()));
const timer = setInterval(() => {
  if (fs.existsSync(finish)) { clearInterval(timer); db.close(); return; }
  db.exec('UPDATE progress SET value = value + 1');
  fs.writeFileSync(counter + '.tmp', String(db.prepare('SELECT value FROM progress').get().value));
  fs.renameSync(counter + '.tmp', counter);
}, 10);`;
  const running = command(process.execPath, ['-e', writer, counter, helperPid, release, finish, helper], {
    cwd: r.cwd, env: f.job.env, stage: 'writer', timeoutMs: 15000,
    onControl: value => { saved.control = { directory: value.directory, nonce: value.nonce }; },
  }).catch(error => error);
  let watching;
  let stopPromise;
  const stopWatcher = () => {
    stopPromise ??= (async () => {
      if (!watching) return;
      saved.metadata.outcome = 'completed';
      await writeFile(statePath + '.tmp', JSON.stringify(saved));
      await rename(statePath + '.tmp', statePath);
      await watching;
    })();
    return stopPromise;
  };
  try {
    const pid = await waitFor(async () => Number(await readMarker(helperPid)), 'The root-owned helper did not start');
    assert.throws(() => process.kill(pid, 0), { code: 'EPERM' });
    await writeFile(statePath, JSON.stringify(saved));
    watching = watchSnapshots(statePath, { intervalMs: 250, api, upload, emit: line => records.push(JSON.parse(line)) });
    const deferred = await waitFor(() => records.find(record => record.event === 'checkpoint.deferred'), 'The watcher did not report the deferral');
    assert.equal(deferred.level, 'WARN');
    assert.equal(deferred.session_id, sessionId);
    assert.equal(deferred.pause_reason, 'permission_denied');
    assert.equal(deferred.signal, 'SIGSTOP');
    assert.equal(deferred.os_errno, 1);
    assert.ok(Number.isSafeInteger(deferred.pid) && deferred.pid > 0);
    assert.equal(deferred.retry_interval_ms, 250);
    assert.deepEqual(deferred.last_durable_checkpoint, previous);
    assert.equal(captures.length, 1);
    const stalledAt = Number(await readMarker(counter));
    await waitFor(async () => Number(await readMarker(counter)) > stalledAt, 'The same writer did not resume after the denied pause');
    await writeFile(release, 'exit');
    await waitFor(() => records.find(record => record.event === 'checkpoint.cycle' &&
      record.outcome === 'completed' && record.cycle > deferred.cycle),
      'The next eligible checkpoint did not complete');
    await stopWatcher();
    const latest = JSON.parse(await readFile(latestPath, 'utf8'));
    const completedSnapshots = records.filter(record => record.event === 'checkpoint.complete' && record.cycle > deferred.cycle);
    assert.ok(completedSnapshots.length > 0);
    assert.equal(completedSnapshots.length, captures.length - 1);
    for (const [index, capture] of captures.slice(1).entries()) {
      assert.equal(capture.session_id, sessionId);
      assert.ok(capture.sequence > previous.sequence + 1);
      assert.equal(completedSnapshots[index].sequence, capture.sequence);
    }
    assert.equal(latest.artifact_id, completedSnapshots.at(-1).artifact_id);
    assert.equal(latest.sequence, completedSnapshots.at(-1).sequence);
    assert.equal(latest.sequence, captures.at(-1).sequence);
    assert.equal(records.filter(record => record.event === 'runtime.failed').length, 0);
  } finally {
    await writeFile(release, 'exit');
    try { await stopWatcher(); }
    finally {
      await writeFile(finish, 'exit');
      await running;
    }
  }
  assert.equal(await running, '');
});

test('cancellation during a partial pause stops the worker without allowing a copy', async t => {
  const f = await fixture(t);
  const ready = join(f.temporary, 'partial-pause'), allow = join(f.temporary, 'allow-cancel');
  const pids = join(f.temporary, 'worker-pids');
  const source = await readFile(join(root, '.build/supervise.py'), 'utf8');
  const line = source.split('\n').findIndex(value => value.includes('paused.add((pid, started))')) + 1;
  assert.ok(line > 0);
  await writeFile(join(f.temporary, 'sitecustomize.py'), `import sys, time
from pathlib import Path
def trace(frame, event, arg):
    if event == 'line' and frame.f_code.co_filename.endswith('/supervise.py') and frame.f_lineno == ${line}:
        Path(${JSON.stringify(ready)}).write_text(str(frame.f_locals['pid']))
        deadline = time.monotonic() + 3
        while not Path(${JSON.stringify(allow)}).exists() and time.monotonic() < deadline:
            time.sleep(0.001)
    return trace
sys.settrace(trace)
`);
  const worker = `import os, subprocess, sys
from pathlib import Path
helper = subprocess.Popen(['sleep', '30'])
Path(sys.argv[1]).write_text(f'{os.getpid()} {helper.pid}')
helper.wait()
`;
  let control, copying = false, pausing;
  const running = command('python3', ['-c', worker, pids], {
    cwd: f.temporary, env: { ...f.job.env, PYTHONPATH: f.temporary }, stage: 'writer', timeoutMs: 10000,
    onControl: value => { control = value; },
  }).catch(error => error);
  const state = async pid => (await readMarker(`/proc/${pid}/stat`)).split(') ').at(-1).charAt(0);
  try {
    const [parent, child] = (await waitFor(() => readMarker(pids), 'The worker and helper did not start')).split(' ');
    pausing = control.freeze(async () => { copying = true; }).catch(error => error);
    const stoppedPid = await waitFor(() => readMarker(ready), 'The supervisor did not enter the partial pause');
    assert.equal(stoppedPid, parent);
    await waitFor(async () => await state(parent) === 'T', 'The worker was not stopped');
    await waitFor(async () => await state(child) === 'S', 'The helper was not running independently of the stopped worker');
  } finally {
    process.emit('SIGTERM');
    await writeFile(allow, 'continue');
    await Promise.all([running, pausing]);
  }
  const failure = await running;
  assert.equal(failure.reason, 'command_cancelled');
  assert.equal(failure.details.quiescent, true);
  assert.ok(await pausing instanceof Error);
  assert.equal(copying, false);
});

test('an upload finalized remotely with a lost receipt does not poison later snapshot identities', async t => {
  const f = await fixture(t); await history(f); const names = [];
  await assert.rejects(durableCheckpoint(f.job, checkpoint(), f.log, async name => {
    names.push(name); throw new Error('Remote finalization succeeded but response was lost');
  }), { reason: 'artifact_upload_failed' });
  const receipt = await durableCheckpoint(f.job, checkpoint(), f.log, async name => { names.push(name); return { id: 82 }; });
  assert.notEqual(names[0], names[1]); assert.equal(receipt.sequence, 2); assert.equal(receipt.artifact_id, 82);
});
for (const variant of ['duplicate', 'missing-reference']) test(`staged ${variant} history cannot replace a completed snapshot`, async t => {
  const f = await fixture(t); await history(f); let uploads = 0;
  const previous = await durableCheckpoint(f.job, checkpoint(), f.log, async () => ({ id: ++uploads }));
  if (variant === 'duplicate') await cp(join(f.job.runnerHome, 'sessions/rollout.jsonl'), join(f.job.runnerHome, 'sessions/duplicate.jsonl'));
  else {
    const db = new DatabaseSync(join(f.job.runnerHome, 'state_5.sqlite'));
    db.exec('CREATE TABLE threads (id TEXT, rollout_path TEXT)');
    db.prepare('INSERT INTO threads VALUES (?, ?)').run(sessionId, join(f.job.runnerHome, 'sessions/missing.jsonl')); db.close();
  }
  await assert.rejects(durableCheckpoint(f.job, checkpoint({ previous }), f.log, async () => ({ id: ++uploads })),
    { reason: variant === 'duplicate' ? 'duplicate_session_history' : 'missing_rollout_reference' });
  assert.equal(uploads, 1); assert.equal(previous.artifact_id, 1);
});
