import assert from "node:assert/strict";
import { cp, lstat, mkdir, readFile, readdir, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createServer } from "node:http";
import { zstdCompressSync } from "node:zlib";
import test from "node:test";
import { authorize, executionSource, hash, parseTurn, skillSources } from "../.build/contracts.js";
import { configure, installSkillSource, safeTree, removeJob } from "../.build/setup.js";
import { exportCheckpoint, durableCheckpoint } from "../.build/checkpoint.js";
import { isolatedCheckpoint } from "../.build/checkpoint-worker.js";
import { TaskGit } from "../.build/git.js";
import { reviewSurfaces, verifyReviewState, verifyTerminal } from "../.build/delivery.js";
import { selectPlanSource } from "../.build/main.js";
import { command } from "../.build/process.js";
import { exec, fixture, logger, portableSource, repository, root, turn, policy } from "./helpers.mjs";

const plan = "Implement the fixture plan.\n";
const auth = { repository: "fixture/repo", plan_sha256: hash(plan), permission_mode: "full-access", request: "Implement and deliver this plan, with checkpoint pushes." };
const checkpoint = (extra = {}) => ({ task_id: "fixture-task", repository: "fixture/repo", branch: "codex/fixture-task", base_sha: "a".repeat(40), checkpoint_sha: "b".repeat(40),
  plan, plan_source: "inline", authorization: auth, sessions: ["fixture-session"], skills: [executionSource], progress: { completed: ["fixture"] }, lineage: { run_id: "13" }, audit: null, previous: null, ...extra });
async function history(f, content = "completed turn") {
  await mkdir(join(f.job.codexHome, "sessions"));
  const data = JSON.stringify({ type: "session_meta", payload: { id: "fixture-session", session_id: "root-session" } }) + "\n" + JSON.stringify({ type: "response_item", payload: { text: content } }) + "\n";
  await writeFile(join(f.job.codexHome, "sessions/rollout.jsonl"), data);
}
test("plan selection and direct authorization bind exact bytes, repository and permission mode", () => {
  assert.equal(selectPlanSource(plan, "", "fixture/repo").plan, plan);
  assert.equal(selectPlanSource("", "https://github.com/fixture/repo/issues/2", "fixture/repo").issueNumber, "2");
  for (const args of [[plan,"https://github.com/fixture/repo/issues/2"], ["", ""], ["", "https://github.com/other/repo/issues/2"]]) assert.throws(() => selectPlanSource(...args, "fixture/repo"));
  assert.deepEqual(authorize(JSON.stringify(auth), "fixture/repo", plan, "full-access"), auth);
  for (const changed of [{ ...auth, permission_mode: "sandboxed" }, { ...auth, plan_sha256: hash(plan.trim()) }, { ...auth, request: "" }, { ...auth, repository: "other/repo" }]) {
    assert.throws(() => authorize(JSON.stringify(changed), "fixture/repo", plan, "full-access"));
  }
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
test("required checks, marked review coverage and dispositions reject stale or incomplete completion", () => {
  const head = "a".repeat(40), p = { ...policy, marked_review_count: 1 };
  const receipt = { gate:"terminal", phase:"full", head_sha:head, all_checks_nonblocking:true, required_reviewers_satisfied:true,
    required_checks:policy.checks, required_reviewers:[], required_check_problems:[], required_reviewer_problems:[] };
  verifyTerminal(receipt, head, policy);
  for (const change of [{head_sha:"b".repeat(40)},{required_checks:[]},{gate:"review_terminal"},{all_checks_nonblocking:false}]) assert.throws(() => verifyTerminal({...receipt,...change},head,policy));
  const state = {pull_request:{head_sha:head}, codex_thread_actions:{incomplete:0}, ai_pr_reviewer_thread_actions:{incomplete:0}, reviews:[{id:"review-1",commit:{oid:head},body:`<!-- ai-pr-reviewer:v3:${head}:${"c".repeat(64)} -->\nFixture review`}]};
  const ledger=reviewSurfaces(state).map(surface=>({...surface,decision:"not_finding",reason:"Fixture contains no finding",fix_sha:null}));
  verifyReviewState(state,head,p,ledger);
  assert.throws(() => verifyReviewState({...state,reviews:[]},head,p,[]));
  assert.throws(() => verifyReviewState({...state,ai_pr_reviewer_thread_actions:{incomplete:1}},head,p,ledger));
  const finding={...state,reviews:[{...state.reviews[0],body:state.reviews[0].body+"\nP1: Missing authorization validation"}]};
  assert.throws(()=>verifyReviewState(finding,head,p,[]),{reason:"review_surface_coverage_mismatch"});
  assert.throws(()=>verifyReviewState(finding,head,p,ledger),{reason:"unhandled_review_surface"});
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
