import assert from "node:assert/strict";
import { cp, lstat, mkdir, readFile, readdir, rename, rmdir, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createServer } from "node:http";
import { zstdCompressSync } from "node:zlib";
import test from "node:test";
import { authorize, executionSource, hash, parseTurn, skillSources } from "../.build/contracts.js";
import { configure, fetchSkillSource, installTools, installSkillSource, safeTree, removeJob } from "../.build/setup.js";
import { exportCheckpoint, durableCheckpoint } from "../.build/checkpoint.js";
import { isolatedCheckpoint } from "../.build/checkpoint-worker.js";
import { TaskGit } from "../.build/git.js";
import { reviewSurfaces, verifyReviewState, verifyTerminal } from "../.build/delivery.js";
import { selectPlanSource } from "../.build/main.js";
import { command } from "../.build/process.js";
import { exec, fixture, logger, portableSource, repository, root, skillTransport, turn, policy } from "./helpers.mjs";

const plan = "Implement the fixture plan.\n";
const auth = { repository: "fixture/repo", plan_sha256: hash(plan), request: "Implement and deliver this plan, with checkpoint pushes." };
const checkpoint = (extra = {}) => ({ task_id: "fixture-task", repository: "fixture/repo", branch: "codex/fixture-task", base_sha: "a".repeat(40), checkpoint_sha: "b".repeat(40),
  plan, plan_source: "inline", authorization: auth, sessions: ["fixture-session"], skills: [executionSource], progress: { completed: ["fixture"] }, lineage: { run_id: "13" }, audit: null, previous: null, ...extra });
async function history(f, content = "completed turn") {
  await mkdir(join(f.job.codexHome, "sessions"));
  const data = JSON.stringify({ type: "session_meta", payload: { id: "fixture-session", session_id: "root-session" } }) + "\n" + JSON.stringify({ type: "response_item", payload: { text: content } }) + "\n";
  await writeFile(join(f.job.codexHome, "sessions/rollout.jsonl"), data);
}
test("plan selection and direct authorization bind exact bytes and repository without a mode selector", () => {
  assert.equal(selectPlanSource(plan, "", "fixture/repo").plan, plan);
  assert.equal(selectPlanSource("", "https://github.com/fixture/repo/issues/2", "fixture/repo").issueNumber, "2");
  for (const args of [[plan,"https://github.com/fixture/repo/issues/2"], ["", ""], ["", "https://github.com/other/repo/issues/2"]]) assert.throws(() => selectPlanSource(...args, "fixture/repo"));
  assert.deepEqual(authorize(JSON.stringify(auth), "fixture/repo", plan), auth);
  for (const changed of [{ ...auth, permission_mode: "sandboxed" }, { ...auth, permission_mode: "full-access" }, { ...auth, plan_sha256: hash(plan.trim()) }, { ...auth, request: "" }, { ...auth, repository: "other/repo" }]) {
    assert.throws(() => authorize(JSON.stringify(changed), "fixture/repo", plan));
  }
});
test("the actual bundled entry rejects retired mode inputs before configuration or execution",async()=>{
  for(const mode of ["sandboxed","full-access"]) await assert.rejects(exec(process.execPath,[join(root,"dist/index.js")],{
    env:{...process.env,"INPUT_PERMISSION-MODE":mode,GITHUB_REPOSITORY:"fixture/repo",GITHUB_SERVER_URL:"https://github.com"},
  }),error=>{assert.equal(error.code,1);assert.match(error.stdout,/unsupported_mode_input/);assert.doesNotMatch(error.stdout,/runtime\.setup|runtime\.operation/);return true;});
});
test("skill sources preserve the three immutable defaults and refuse collisions and mutable refs", () => {
  assert.deepEqual(skillSources("[]"), [executionSource]);
  assert.throws(() => skillSources(JSON.stringify([{ repository: "fixture/skills", revision: "main", names: ["test"] }])));
  assert.throws(() => skillSources(JSON.stringify([{ repository: "fixture/skills", revision: "a".repeat(40), names: ["plan-audit"] }])));
  assert.throws(() => parseTurn(JSON.stringify({ ...turn("complete"), injected: true })));
});
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
test("real locked tool installation rejects a mismatched installed Skills CLI version",async(t)=>{
  const f=await fixture(t),action=join(f.temporary,"action-source");await mkdir(action);
  await writeFile(join(action,"package.json"),JSON.stringify({name:"fixture-tools",private:true,version:"0.0.0",dependencies:{"@openai/codex":"0.169.0",skills:"1.8.0"}}));
  await exec("npm",["install","--package-lock-only","--ignore-scripts","--no-audit","--no-fund"],{cwd:action,env:f.job.env,maxBuffer:1024*1024});
  await assert.rejects(installTools(f.job,action,f.log),error=>{
    assert.equal(error.reason,"skills_version_mismatch");assert.equal(error.details.expected_version,"1.8.1");assert.equal(error.details.observed_version,"1.8.0");
    f.log.failure(error);return true;
  });
  assert.ok(f.records.some(record=>record.event==="runtime.operation"&&record.stage==="codex_version"&&record.outcome==="success"));
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
test("actual Git publication verifies pushed commits, upstream, deletions and remote drift", async (t) => {
  const f = await fixture(t), r = await repository(f), git = new TaskGit(r.cwd, f.job.env, f.log, r.branch);
  await writeFile(join(r.cwd, "greeting.js"), "console.log('fixture');\n");
  const sha = await git.publish(["greeting.js"], "Fixture accomplishment", r.base, null);
  assert.equal(await git.remoteHead(), sha);
  await assert.rejects(git.verify(r.base),error=>{f.log.failure(error);assert.equal(error.details.expected_sha,r.base);assert.equal(error.details.observed_sha,sha);return true;});
  assert.equal(await r.git("rev-list", "--left-right", "--count", "HEAD...@{upstream}"), "0\t0");
  await assert.rejects(git.publish([], "", sha, r.base), { reason: "remote_branch_drift" });
  await r.git("rm", "README.md");
  const next = await git.publish(["README.md"], "Remove fixture file", sha, sha);
  assert.notEqual(next, sha);
  await unlink(join(r.cwd, "greeting.js"));
  const removed = await git.publish(["greeting.js"], "Remove unstaged fixture file", next, next);
  assert.equal(await git.remoteHead(), removed);
});
for (const change of ["deletion", "rename"]) test(`audited ${change} fingerprints survive staging and real publication`, async (t) => {
  const f = await fixture(t), r = await repository(f), git = new TaskGit(r.cwd, f.job.env, f.log, r.branch);
  const original = await git.fingerprint();
  if (change === "deletion") await unlink(join(r.cwd, "README.md"));
  else await rename(join(r.cwd, "README.md"), join(r.cwd, "renamed.md"));
  const audited = await git.fingerprint(), paths = await git.changedPaths();
  assert.notEqual(audited, original);
  await r.git("add", "--all"); assert.equal(await git.fingerprint(), audited);
  const sha = await git.publish(paths, `Publish fixture ${change}`, r.base, null);
  assert.equal(await git.fingerprint(), audited); assert.equal(await git.remoteHead(), sha);
  await writeFile(join(r.cwd, "renamed.md"), "Later implementation change\n");
  assert.notEqual(await git.fingerprint(), audited);
});
for (const replacement of ["file-to-directory", "directory-to-file", "directory-to-symlink"]) for (const staged of [false, true]) {
  test("real " + replacement + " preserves audit identity and publication with " + (staged ? "staged" : "unstaged") + " changes", async (t) => {
    const f = await fixture(t), r = await repository(f), git = new TaskGit(r.cwd, f.job.env, f.log, r.branch);
    const initial = replacement === "file-to-directory" ? "shape" : "shape/old.ts";
    await mkdir(join(r.cwd, initial, ".."), { recursive: true });
    await writeFile(join(r.cwd, initial), "Original fixture\n");
    await r.git("add", "shape"); await r.git("commit", "-m", "Prepare replacement fixture");
    const base = await git.head(), original = await git.fingerprint();
    await unlink(join(r.cwd, initial));
    if (replacement !== "file-to-directory") await rmdir(join(r.cwd, "shape"));
    const current = replacement === "file-to-directory" ? "shape/new.ts" : "shape";
    const outside = join(f.temporary, "outside");
    if (replacement === "directory-to-symlink") {
      await mkdir(outside); await writeFile(join(outside, "old.ts"), f.job.env.CODEX_API_KEY);
      await symlink(outside, join(r.cwd, current));
    } else {
      await mkdir(join(r.cwd, current, ".."), { recursive: true });
      await writeFile(join(r.cwd, current), "Replacement fixture\n");
    }
    const audited = await git.fingerprint(), paths = await git.changedPaths();
    assert.notEqual(audited, original);
    if (staged) { await r.git("add", "--all"); assert.equal(await git.fingerprint(), audited); }
    if (replacement !== "directory-to-symlink") {
      await writeFile(join(r.cwd, current), f.job.env.CODEX_API_KEY);
      await assert.rejects(git.publish(paths, "Reject contaminated replacement", base, null), { reason: "credential_in_commit" });
      assert.equal(await git.head(), base); assert.equal(await git.remoteHead(), null);
      await writeFile(join(r.cwd, current), "Replacement fixture\n");
      assert.equal(await git.fingerprint(), audited);
    }
    const sha = await git.publish(paths, "Publish " + replacement, base, null);
    assert.equal(await git.remoteHead(), sha); assert.equal(await git.fingerprint(), audited);
    assert.equal(await r.git("status", "--porcelain"), "");
    const published = await exec("git", ["--git-dir", r.remote, "show", sha + ":" + current], { env: f.job.env });
    assert.equal(published.stdout, replacement === "directory-to-symlink" ? outside : "Replacement fixture\n");
  });
}
test("real submodule fingerprints and publication preserve clean references and reject unpublished child work",async(t)=>{
  const f=await fixture(t),r=await repository(f),source=join(f.temporary,"module-source");
  await mkdir(source);
  const moduleGit=async(...args)=>exec("git",args,{cwd:source,env:f.job.env});
  await moduleGit("init","--initial-branch=main");await writeFile(join(source,"value.txt"),"original\n");
  await moduleGit("add","value.txt");await moduleGit("commit","-m","Initial module fixture");
  const originalModuleHead = (await moduleGit("rev-parse", "HEAD")).stdout.trim();
  await exec("git",["submodule","add",source,"module"],{cwd:r.cwd,env:{...f.job.env,GIT_ALLOW_PROTOCOL:"file"}});
  await r.git("commit","-am","Add fixture submodule");assert.equal(await r.git("status","--porcelain"),"");
  const git=new TaskGit(r.cwd,f.job.env,f.log,r.branch),clean=await git.fingerprint();
  assert.equal(await git.fingerprint(),clean);
  await writeFile(join(r.cwd,"module/value.txt"),"changed\n");assert.notEqual(await git.fingerprint(),clean);
  await writeFile(join(r.cwd,"module/value.txt"),"original\n");assert.equal(await git.fingerprint(),clean);
  await writeFile(join(r.cwd,"module/untracked.txt"),"one");const untracked=await git.fingerprint();
  await writeFile(join(r.cwd,"module/untracked.txt"),"two");assert.notEqual(await git.fingerprint(),untracked);
  await unlink(join(r.cwd,"module/untracked.txt"));
  const parent=await git.publish([],"",await git.head(),null);
  await writeFile(join(source,"value.txt"),"published update\n");await moduleGit("commit","-am","Update module fixture");
  const moduleHead=(await moduleGit("rev-parse","HEAD")).stdout.trim();
  await exec("git",["-C",join(r.cwd,"module"),"fetch","origin"],{env:f.job.env});
  await exec("git",["-C",join(r.cwd,"module"),"checkout","--detach",moduleHead],{env:f.job.env});
  const audited = await git.fingerprint(); assert.notEqual(audited, clean);
  await r.git("add", "module"); assert.equal(await git.fingerprint(), audited);
  const published=await git.publish(["module"],"Publish module reference",parent,parent);
  assert.equal(await git.fingerprint(), audited);
  assert.equal(await git.remoteHead(),published);assert.match(await r.git("ls-tree","HEAD","module"),new RegExp(moduleHead));
  await writeFile(join(r.cwd,"module/value.txt"),"unpublished work\n");
  await assert.rejects(git.publish(["module"],"Invalid child work",published,published),{reason:"dirty_submodule"});
  assert.equal(await git.head(),published);assert.equal(await git.remoteHead(),published);
  await writeFile(join(r.cwd,"module/value.txt"), "published update\n");
  await r.git("submodule", "deinit", "--force", "module");
  const uninitialized = await git.fingerprint();
  await r.git("update-index", "--cacheinfo", `160000,${originalModuleHead},module`);
  assert.notEqual(await git.fingerprint(), uninitialized);
});
test("publication rejects a staged credential without advancing local or remote history",async(t)=>{
  const f=await fixture(t),r=await repository(f),git=new TaskGit(r.cwd,f.job.env,f.log,r.branch);
  await writeFile(join(r.cwd,"credential.txt"),f.job.env.CODEX_API_KEY);await r.git("add","credential.txt");
  await assert.rejects(git.publish(["credential.txt"],"Rejected fixture",r.base,null),{reason:"credential_in_commit"});
  assert.equal(await git.head(),r.base);assert.equal(await git.remoteHead(),null);
  assert.equal(await r.git("diff","--cached","--name-only"),"credential.txt");
});
test("real rejected push records intended/observed SHA and never pretends it is durable", async (t) => {
  const f = await fixture(t), r = await repository(f), git = new TaskGit(r.cwd, f.job.env, f.log, r.branch);
  await writeFile(join(r.remote, "hooks/pre-receive"), "#!/bin/sh\nexit 1\n", { mode: 0o700 });
  await writeFile(join(r.cwd, "greeting.js"), "console.log('fixture');\n");
  await assert.rejects(git.publish(["greeting.js"], "Fixture rejected push", r.base, null), (error) => {
    f.log.failure(error, { artifact_id: 7 });
    assert.equal(error.reason, "push_failed"); assert.equal(error.details.observed_sha, null); assert.match(error.details.intended_sha, /^[a-f0-9]{40}$/); return true;
  });
  const evidence = f.records.find((record) => record.event === "runtime.failed");
  assert.equal(evidence.stage, "publication"); assert.equal(evidence.last_durable_checkpoint.artifact_id, 7);
});
test("checkpoint exports exact session state and consistent SQLite backups, excluding secrets and caches", async (t) => {
  const f = await fixture(t); await history(f);
  const db = new DatabaseSync(join(f.job.codexHome, "state_5.sqlite"));
  db.exec("PRAGMA journal_mode=WAL; CREATE TABLE progress (value TEXT); INSERT INTO progress VALUES ('durable');");
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
  assert.equal(manifest.permission_mode,"full-access");assert.ok(!Object.hasOwn(manifest.authorization,"permission_mode"));
  assert.equal(manifest.plan_sha256, hash(plan)); assert.equal(manifest.session_identifiers[0].session_id, "root-session");
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
  await assert.rejects(durableCheckpoint(f.job, checkpoint({ previous }), f.log, async () => {}, async () => {
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
  await assert.rejects(durableCheckpoint(f.job, checkpoint({ previous }), f.log, async () => {}, async () => {
    uploaded = true; return { id: 10 };
  }), { reason: "credential_in_checkpoint" });
  assert.equal(uploaded, false); assert.equal(previous.artifact_id, 9);
  assert.ok(!f.records.some((record) => record.event === "checkpoint.complete"));
});
test("checkpoint rejects escaped manifest credentials before upload and retains its preceding receipt", async (t) => {
  const f = await fixture(t), secret = 'fixture-"manifest\\credential\n9371';
  await configure(f.job, "[mcp_servers.fixture.env]\nPASSWORD=" + JSON.stringify(secret) + "\n", f.log); await history(f);
  const previous = { sequence: 3, artifact_id: 9, checkpoint_sha: "a".repeat(40) };
  const input = checkpoint({ previous, progress: { detail: secret } });
  assert.equal(JSON.stringify(input).includes(secret), false);
  let uploaded = false;
  await assert.rejects(durableCheckpoint(f.job, input, f.log, async () => {}, async () => {
    uploaded = true; return { id: 10 };
  }), { reason: "credential_in_manifest" });
  assert.equal(uploaded, false); assert.equal(previous.artifact_id, 9);
  assert.ok(!f.records.some((record) => record.event === "checkpoint.complete"));
});
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
  await assert.rejects(exportCheckpoint(f.job, checkpoint({ previous: { sequence: 1, artifact_id: 4, checkpoint_sha: "a".repeat(40) }, sessions:["missing"] }), f.log), { reason: "missing_session_history" });
  const prior = { artifact_id: 4, sequence: 2, checkpoint_sha: "a".repeat(40) };
  let uploaded = false;
  await assert.rejects(durableCheckpoint(f.job, checkpoint({ previous: prior }), f.log, async () => {}, async () => { uploaded = true; throw new Error("fixture upload failed"); }), error=>{
    f.log.failure(error,prior);assert.equal(error.stage,"checkpoint");assert.equal(error.reason,"artifact_upload_failed");return true;
  });
  assert.equal(uploaded, true); assert.equal(prior.artifact_id, 4);
  assert.ok(!f.records.some((record) => record.event === "checkpoint.complete"));
  const failure=f.records.find(record=>record.reason==="artifact_upload_failed");assert.equal(failure.intended_sha,"b".repeat(40));assert.equal(failure.last_durable_checkpoint.artifact_id,4);
});
test("checkpoint failure diagnostics preserve real Git observations and the preceding durable receipt", async (t) => {
  const f = await fixture(t), r = await repository(f), git = new TaskGit(r.cwd, f.job.env, f.log, r.branch);
  await writeFile(join(r.cwd, "new.txt"), "Published change\n");
  const observed = await git.publish(["new.txt"], "Publish fixture", r.base, null);
  const previous = { sequence: 0, artifact_id: 7, checkpoint_sha: r.base };
  await assert.rejects(isolatedCheckpoint(f.job, r.cwd, checkpoint({ base_sha:r.base, checkpoint_sha:r.base, previous }), f.log, sha => git.verify(sha)), error => {
    assert.equal(error.reason, "checkpoint_operation_failed"); assert.equal(error.details.expected_sha, r.base);
    assert.equal(error.details.observed_sha, observed); assert.equal(error.details.last_durable_checkpoint.artifact_id, 7); return true;
  });
  const failure = f.records.find(record => record.event === "checkpoint.failed");
  assert.equal(failure.cause_reason, "checkpoint_head_mismatch"); assert.equal(failure.intended_sha, r.base);
  assert.equal(failure.expected_sha, r.base); assert.equal(failure.observed_sha, observed);
  assert.equal(failure.last_verified_sha, null); assert.equal(failure.last_durable_checkpoint.artifact_id, 7);
});
test("required checks, marked review coverage and dispositions reject stale or incomplete completion", () => {
  const head = "a".repeat(40), p = { ...policy, marked_review_count: 1 };
  const receipt = { gate:"terminal", phase:"full", head_sha:head, all_checks_nonblocking:true, required_reviewers_satisfied:true,
    required_checks:policy.checks, required_reviewers:[], required_check_problems:[], required_reviewer_problems:[] };
  verifyTerminal(receipt, head, policy);
  for (const change of [{head_sha:"b".repeat(40)},{required_checks:[]},{gate:"review_terminal"},{all_checks_nonblocking:false}]) assert.throws(() => verifyTerminal({...receipt,...change},head,policy));
  const state = {pull_request:{head_sha:head}, codex_thread_actions:{incomplete:0}, ai_pr_reviewer_thread_actions:{incomplete:0}, reviews:[{id:"review-1",commit:{oid:head},body:`<!-- ai-pr-reviewer:v3:${head}:${"c".repeat(64)} -->
| File | Lines read | Total changes | Coverage | Reviewers read | Total reviewer profiles |
|:--|--:|--:|--:|--:|--:|
| <code>src/main.ts</code> | 5 | 5 | 100% | 1 | 1 |
| **Total** | **5** | **5** | **100%** | — | **1** |`}]};
  const ledger=reviewSurfaces(state).map(surface=>({...surface,decision:"not_finding",reason:"Fixture contains no finding",fix_sha:null}));
  verifyReviewState(state,head,p,ledger);
  assert.throws(() => verifyReviewState({...state,reviews:[]},head,p,[]));
  assert.throws(() => verifyReviewState({...state,ai_pr_reviewer_thread_actions:{incomplete:1}},head,p,ledger));
  const finding={...state,reviews:[{...state.reviews[0],body:state.reviews[0].body+"\nP1: Missing authorization validation"}]};
  assert.throws(()=>verifyReviewState(finding,head,p,[]),{reason:"review_surface_coverage_mismatch"});
  assert.throws(()=>verifyReviewState(finding,head,p,ledger),{reason:"unhandled_review_surface"});
  for (const body of ["Fixture review without coverage", state.reviews[0].body.replace("5 | 5 | 100%", "1 | 5 | 20%")]) {
    const partial = { ...state, reviews:[{ ...state.reviews[0], body }] };
    const dispositions = reviewSurfaces(partial).map(surface => ({ ...surface, decision:"not_finding", reason:"Fixture only", fix_sha:null }));
    assert.throws(() => verifyReviewState(partial, head, p, dispositions), { reason:"incomplete_ai_review_coverage" });
  }
});
test("the actual v3 aggregate coverage format proves all profiles and rejects partial or inconsistent receipts",()=>{
  const head="a".repeat(40),validation={...policy,marked_review_count:6};
  const body=`<!-- ai-pr-reviewer:v3:${head}:${"c".repeat(64)} -->
## AI review
| File | Lines read | Total changes | Coverage | Reviewers read | Total reviewer profiles |
|:--|--:|--:|--:|--:|--:|
| <code>src/entry.ts</code> | 5 | 5 | 100% | 6 | 6 |
| <code>src/main.ts</code> | 113 | 113 | 100% | 6 | 6 |
| **Total** | **118** | **118** | **100%** | — | **6** |

Coverage does not measure review quality or completion.`;
  const state={pull_request:{head_sha:head},codex_thread_actions:{incomplete:0},ai_pr_reviewer_thread_actions:{incomplete:0},reviews:[{id:"aggregate",commit:{oid:head},body}]};
  const verify=value=>verifyReviewState(value,head,validation,reviewSurfaces(value).map(surface=>({...surface,decision:"not_finding",reason:"Fixture coverage only",fix_sha:null})));
  verify(state);
  for(const changed of [body.replace("100% | 6 | 6","80% | 6 | 6"),body.replace("100% | 6 | 6","100% | 5 | 6"),body.replace("**118** | **118**","**119** | **118**"),body.replace(head,"b".repeat(40))]) {
    assert.throws(()=>verify({...state,reviews:[{...state.reviews[0],body:changed}]}),{reason:"incomplete_ai_review_coverage"});
    const reviews = Array.from({ length:6 }, (_, index) => ({ ...state.reviews[0], id:`profile-${index}`, body:changed.replace("c".repeat(64), String(index + 1).repeat(64)) }));
    assert.throws(() => verify({ ...state, reviews }), { reason:"incomplete_ai_review_coverage" });
  }
});
test("failed validation retains bounded sanitized stdout while worker and API stdout stay private", async (t) => {
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
test("a stalled real artifact transport is terminated within the checkpoint action budget",async(t)=>{
  const f=await fixture(t),r=await repository(f),git=new TaskGit(r.cwd,f.job.env,f.log,r.branch);await history(f);
  await mkdir(join(f.job.tools,"node_modules/@actions"));
  await symlink(join(root,"node_modules/@actions/artifact"),join(f.job.tools,"node_modules/@actions/artifact"),"dir");
  const sha=await git.publish([],"",r.base,null);
  let requests=0;const server=createServer(async(request,response)=>{requests++;for await(const _ of request){};});
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  const token="e30."+Buffer.from(JSON.stringify({scp:"Actions.Results:11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222"})).toString("base64url")+".fixture";
  f.job.env.CODEX_TASK_DEADLINE_MS=String(Date.now()+18000);
  const previous={sequence:0,artifact_id:8,checkpoint_sha:sha};
  await assert.rejects(isolatedCheckpoint(f.job,r.cwd,checkpoint({base_sha:r.base,checkpoint_sha:sha,previous}),f.log,expected=>git.verify(expected),
    {...process.env,ACTIONS_RUNTIME_TOKEN:token,ACTIONS_RESULTS_URL:`http://127.0.0.1:${server.address().port}`,GITHUB_WORKSPACE:r.cwd,NO_PROXY:"127.0.0.1,localhost"},join(root,"dist/index.js")),{reason:"command_timeout"});
  assert.ok(requests>0,"The actual artifact SDK reached the stalled transport");
  const evidence=f.records.find(record=>record.event==="checkpoint.failed");
  assert.equal(evidence.last_durable_checkpoint.artifact_id,8);assert.equal(evidence.intended_sha,sha);
  assert.equal(evidence.observed_sha,null);assert.equal(evidence.last_verified_sha,sha);
  assert.ok(Date.now()<Number(f.job.env.CODEX_TASK_DEADLINE_MS));
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
