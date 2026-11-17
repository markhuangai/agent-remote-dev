import assert from "node:assert/strict";
import { cp, lstat, mkdir, readFile, readdir, rename, rmdir, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createServer } from "node:http";
import { zstdCompressSync } from "node:zlib";
import test from "node:test";
import { hash, skillSources } from "../.build/contracts.js";
import { configure, fetchSkillSource, installTools, installSkillSource, safeTree, removeJob } from "../.build/setup.js";
import { exportCheckpoint, durableCheckpoint, inspectCredentials } from "../.build/checkpoint.js";
import { uploadSnapshot } from "../.build/checkpoint-worker.js";
import { TaskGit } from "../.build/git.js";
import { command } from "../.build/process.js";
import { exec, executionSource, checkpoint, sessionId, fixture, logger, portableSource, repository, root, skillTransport, lineage } from "./helpers.mjs";

const plan = "Implement the fixture plan.\n";
async function history(f, content = "completed turn") {
  await mkdir(join(f.job.codexHome, "sessions"));
  const data = JSON.stringify({ type: "session_meta", payload: { id: sessionId, session_id: sessionId } }) + "\n" + JSON.stringify({ type: "response_item", payload: { text: content } }) + "\n";
  await writeFile(join(f.job.codexHome, "sessions/rollout.jsonl"), data);
}
test("configuration is isolated, rejects invalid TOML, and prevents permission and storage overrides", async (t) => {
  const f = await fixture(t);
  await configure(f.job, 'model="gpt-5.1"\nsandbox_mode="read-only"\nsqlite_home="/outside"\n[model_providers.fixture]\nenv_key="CODEX_API_KEY"\nhttp_headers={authorization="fixture-config-secret-4631"}', f.log);
  for (const [name, content] of Object.entries(f.hostFiles)) assert.equal(await readFile(join(f.host,name),"utf8"), content);
  assert.notEqual(f.job.env.HOME,f.host);assert.notEqual(f.job.env.CODEX_HOME,join(f.host,".codex"));
  const data = await readFile(join(f.job.codexHome, "config.toml"), "utf8");
  assert.doesNotMatch(data, /\/outside|sandbox_mode/);
  assert.ok(data.includes(f.job.codexHome));
  assert.ok(f.log.protectedValues.includes("fixture-config-secret-4631"));
  assert.ok(!f.log.protectedValues.includes("CODEX_API_KEY"));
  await assert.rejects(configure(f.job, "[invalid", f.log), { reason: "invalid_codex_config" });
});
test("actual Skills CLI installs complete pinned portable packages outside project and host skill scope", async (t) => {
  const f = await fixture(t), source = await portableSource(f);
  const before = await readdir(root);
  await installSkillSource(f.job, executionSource, source, 0, f.log);
  for (const name of executionSource.names) {
    const sourceFiles = await safeTree(join(source, "skills", name));
    for (const path of sourceFiles) {
      const target = path.replace(join(source,"skills"), join(f.job.codexHome,"skills"));
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
  assert.equal(f.records.find(record => record.stage === 'codex_version').outcome, 'success');
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

test("checkpoint exports exact session state and consistent SQLite backups, excluding secrets and caches", async (t) => {
  const f = await fixture(t); await history(f);
  const db = new DatabaseSync(join(f.job.codexHome, "state_5.sqlite"));
  db.exec("PRAGMA journal_mode=WAL; CREATE TABLE progress (value TEXT); INSERT INTO progress VALUES ('durable'); CREATE TABLE threads (id TEXT, rollout_path TEXT);");
  db.prepare("INSERT INTO threads VALUES (?, ?)").run(sessionId, join(f.job.codexHome, "sessions/rollout.jsonl"));
  await writeFile(join(f.job.codexHome, "auth.json"), f.job.env.CODEX_API_KEY);
  await writeFile(join(f.job.codexHome, "config.toml"), f.job.env.CODEX_API_KEY);
  await mkdir(join(f.job.codexHome, "cache")); await writeFile(join(f.job.codexHome, "cache/code.txt"), "excluded source");
  const output = await exportCheckpoint(f.job, checkpoint(), f.log);
  assert.equal(db.prepare("PRAGMA journal_mode").get().journal_mode, "wal");
  assert.equal(db.prepare("SELECT value FROM progress").get().value, "durable");
  db.close();
  const saved = new DatabaseSync(join(output.root, "codex/state_5.sqlite"), { readOnly: true });
  assert.equal(saved.prepare("SELECT value FROM progress").get().value, "durable"); saved.close();
  const manifest = JSON.parse(await readFile(join(output.root, "manifest.json"), "utf8"));
  assert.equal(manifest.codex_version, JSON.parse(await readFile(join(root, 'package.json'))).dependencies['@openai/codex']);
  assert.equal(manifest.session_id, sessionId); assert.ok(!('authorization' in manifest));
  assert.ok(manifest.files.every((entry) => !/auth|config|cache|\.git/.test(entry.path)));
  assert.ok(output.files.every((file) => !/-(wal|shm)$/.test(file)));
});
for (const compressed of [false, true]) test(`credential exclusion scans ${compressed ? "compressed" : "plain"} real conversation content`, async (t) => {
  const f = await fixture(t); await history(f, f.job.env.CODEX_API_KEY);
  if (compressed) {
    const path = join(f.job.codexHome, "sessions/rollout.jsonl");
    await writeFile(path + ".zst", zstdCompressSync(await readFile(path)));
    const { unlink } = await import("node:fs/promises"); await unlink(path);
  }
  await assert.rejects(exportCheckpoint(f.job, checkpoint(), f.log), { reason: "credential_in_checkpoint" });
});
for (const storage of ["TEXT", "BLOB"]) test("checkpoint rejects a credential reconstructed across real SQLite " + storage + " overflow pages before upload", async (t) => {
  const f = await fixture(t); await history(f);
  const secret = "fixture-sqlite-credential-" + "x".repeat(1500) + "-9371";
  f.log.protect(secret);
  const path = join(f.job.codexHome, "state_5.sqlite"), db = new DatabaseSync(path);
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
  const path = join(f.job.codexHome, "sessions/rollout.jsonl"), data = await readFile(path);
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
      const db = new DatabaseSync(join(f.job.codexHome, "state_5.sqlite"));
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
  const path=join(f.job.codexHome,"sessions/rollout.jsonl");
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
    { ...process.env, ACTIONS_RUNTIME_TOKEN: token, ACTIONS_RESULTS_URL: `http://127.0.0.1:${server.address().port}`, NO_PROXY: '127.0.0.1,localhost', GITHUB_WORKSPACE: f.temporary, CODEX_UPLOAD_TIMEOUT_MS: '1500' }), { reason: 'command_timeout' });
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

test('a managed live SQLite/WAL writer pauses for consistent snapshots and resumes afterward', async t => {
  const f = await fixture(t), marker = join(f.temporary, 'counter'); let control;
  const writer = `const fs=require('node:fs'),{DatabaseSync}=require('node:sqlite');
const db=new DatabaseSync(process.env.CODEX_HOME+'/state_5.sqlite');db.exec('PRAGMA journal_mode=WAL; CREATE TABLE progress (value INTEGER); INSERT INTO progress VALUES (0); CREATE TABLE threads (id TEXT, rollout_path TEXT)');db.prepare('INSERT INTO threads VALUES (?, ?)').run(${JSON.stringify(sessionId)},process.env.CODEX_HOME+'/sessions/rollout.jsonl');
fs.mkdirSync(process.env.CODEX_HOME+'/sessions');fs.writeFileSync(process.env.CODEX_HOME+'/sessions/rollout.jsonl',JSON.stringify({type:'session_meta',payload:{id:${JSON.stringify(sessionId)}}})+'\\n');
setInterval(()=>{db.exec('UPDATE progress SET value=value+1');fs.writeFileSync(${JSON.stringify(marker)},String(db.prepare('SELECT value FROM progress').get().value))},5);`;
  const running = command(process.execPath, ['-e', writer], { cwd: f.temporary, env: f.job.env, stage: 'writer', timeoutMs: 1500, onControl: value => { control = value; } }).catch(error => error);
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) { try { if (Number(await readFile(marker)) > 3) break; } catch (error) { if (error.code !== 'ENOENT') throw error; } await new Promise(resolve => setTimeout(resolve, 10)); }
  await control.freeze(async () => {
    const before = await readFile(marker, 'utf8'); await new Promise(resolve => setTimeout(resolve, 75)); assert.equal(await readFile(marker, 'utf8'), before);
  });
  const exported = await exportCheckpoint(f.job, checkpoint(), f.log, undefined, control);
  const db = new DatabaseSync(join(exported.root, 'codex/state_5.sqlite'), { readOnly: true });
  assert.ok(db.prepare('SELECT value FROM progress').get().value > 0); db.close();
  const before = Number(await readFile(marker)); await new Promise(resolve => setTimeout(resolve, 75)); assert.ok(Number(await readFile(marker)) > before);
  const result = await running; assert.equal(result.reason, 'command_timeout'); assert.equal(result.details.quiescent, true);
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
  if (variant === 'duplicate') await cp(join(f.job.codexHome, 'sessions/rollout.jsonl'), join(f.job.codexHome, 'sessions/duplicate.jsonl'));
  else {
    const db = new DatabaseSync(join(f.job.codexHome, 'state_5.sqlite'));
    db.exec('CREATE TABLE threads (id TEXT, rollout_path TEXT)');
    db.prepare('INSERT INTO threads VALUES (?, ?)').run(sessionId, join(f.job.codexHome, 'sessions/missing.jsonl')); db.close();
  }
  await assert.rejects(durableCheckpoint(f.job, checkpoint({ previous }), f.log, async () => ({ id: ++uploads })),
    { reason: variant === 'duplicate' ? 'duplicate_session_history' : 'missing_rollout_reference' });
  assert.equal(uploads, 1); assert.equal(previous.artifact_id, 1);
});
