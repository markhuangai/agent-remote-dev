import assert from "node:assert/strict";
import { chmod, cp, lstat, mkdir, readFile, readdir, rename, rmdir, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createServer } from "node:http";
import { zstdCompressSync } from "node:zlib";
import test from "node:test";
import { hash, skillSources } from "../.build/contracts.js";
import { configure, fetchSkillSource, installTools, installSkillSource, safeTree, removeJob } from "../.build/setup.js";
import { exportCheckpoint, durableCheckpoint, inspectCredentials } from "../.build/checkpoint.js";
import { saveSnapshot, uploadSnapshot, watchSnapshots } from "../.build/checkpoint-worker.js";
import { TaskGit } from "../.build/git.js";
import { command } from "../.build/process.js";
import { exec, executionSource, checkpoint, sessionId, fixture, logger, portableSource, repository, root, skillTransport, lineage } from "./helpers.mjs";

const plan = "Implement the fixture plan.\n";
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

async function finalization(t, { host, denyCleanup = false, lost = [], failResult = false, conflicting = null, protectResult = false,
  response = "fixture-result-private-content-8147", checkpointSaved = true, runner = "codex" }) {
  assert.notEqual(process.geteuid(), 0);
  const f = await fixture(t, runner), repo = await repository(f);
  await history(f);
  await readOnlyCache(f.job.home);
  const previous = { artifact_id: 72, sequence: 3, checkpoint_sha: repo.base };
  const payload = response;
  const statePath = join(f.job.root, "state.json");
  if (checkpointSaved) await writeFile(join(f.job.root, "latest.json"), JSON.stringify(previous));
  await writeFile(statePath, JSON.stringify({ job: f.job, metadata: checkpoint({ outcome: "completed", workspace: repo.cwd,
    session_id: checkpointSaved ? sessionId : "" }), secrets: [...f.log.protectedValues, ...(protectResult ? [payload] : [])], response: payload,
    latest: checkpointSaved ? previous : null }), { mode: 0o600 });
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
  const { code, summary } = await finalization(t, { host: "github-hosted", checkpointSaved: false });
  assert.equal(code, 0);
  assert.match(summary, /- \*\*Saved checkpoint:\*\* unavailable/);
  assert.doesNotMatch(summary, /## How to resume|resume-run-id/);
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
    assert.deepEqual(JSON.parse(await readFile(latestPath, 'utf8')), previous);
    const stalledAt = Number(await readMarker(counter));
    await waitFor(async () => Number(await readMarker(counter)) > stalledAt, 'The same writer did not resume after the denied pause');
    await writeFile(release, 'exit');
    await waitFor(async () => JSON.parse(await readFile(latestPath, 'utf8')).artifact_id > previous.artifact_id,
      'The next eligible checkpoint did not complete');
    assert.equal(captures[1].session_id, sessionId);
    assert.ok(captures[1].sequence > previous.sequence + 1);
  } finally {
    saved.metadata.outcome = 'completed';
    await writeFile(statePath + '.tmp', JSON.stringify(saved));
    await rename(statePath + '.tmp', statePath);
    await writeFile(release, 'exit');
    await writeFile(finish, 'exit');
    await Promise.all([watching, running]);
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
