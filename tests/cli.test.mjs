import assert from "node:assert/strict";
import { cp, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { configure, installSkillSource, safeTree } from "../.build/setup.js";
import { runCodex } from "../.build/codex.js";
import { TaskGit } from "../.build/git.js";
import { drive } from "../.build/driver.js";
import { durableCheckpoint } from "../.build/checkpoint.js";
import { verifyDelivery } from "../.build/delivery.js";
import { executionSource, hash, parseTurn } from "../.build/contracts.js";
import { fixture, githubFixture, message, policy, portableSource, provider, repository, tool, turn } from "./helpers.mjs";

const quote = (text) => "'" + text.replaceAll("'", "'\"'\"'") + "'";
test("real Codex YOLO-only turns preserve conversation identity and exclude host user skills", async (t) => {
  const f = await fixture(t), r = await repository(f);
  const api = await provider(t, [[tool("printf '%s\\n' 'console.log(42);' > greeting.js")], [message(turn("accomplishment", { paths:["greeting.js"], commit_message:"Create fixture" }))], [message(turn("blocked"))]]);
  await configure(f.job, api.config, f.log);
  const first = await runCodex(f.job,r.cwd,"Perform the next fixture step.",f.log,60000,"one");
  assert.equal(await readFile(join(r.cwd,"greeting.js"),"utf8"),"console.log(42);\n");
  assert.equal(parseTurn(first.result).kind,"accomplishment");
  const second = await runCodex(f.job,r.cwd,"Continue the SAME fixture conversation.",f.log,60000,"two",first.session);
  assert.equal(second.session,first.session);
  assert.doesNotMatch(JSON.stringify(api.requests),/unwanted-host-sentinel-3719/);
  assert.match(JSON.stringify(api.requests.at(-1)),/Perform the next fixture step/);
  for(const[name,content]of Object.entries(f.hostFiles))assert.equal(await readFile(join(f.host,name),"utf8"),content);
});
test("real CLI authentication errors retain stage and sanitized native cause without raw provider bodies", async (t) => {
  const f = await fixture(t),r=await repository(f);
  const api=await provider(t,()=>({status:403,body:{error:{message:"private-provider-body-5741",api_key:f.job.env.CODEX_API_KEY}}}));
  await configure(f.job,api.config,f.log);
  await assert.rejects(runCodex(f.job,r.cwd,"Fixture request",f.log,20000,"auth"),(error)=>{ f.log.failure(error); return true; });
  const output=JSON.stringify(f.records);
  assert.doesNotMatch(output,/private-provider-body-5741|fixture-api-credential-9374/);
  assert.ok(f.records.some(record=>record.event==="runtime.failed"&&record.stage==="worker"));
});
for (const closeDuringUpload of [false, true]) test(`the real CLI driver audits, publishes and ${closeDuringUpload ? "rejects PR closure during final upload" : "verifies PR delivery"}`, async (t) => {
  const f=await fixture(t),r=await repository(f),source=await portableSource(f);
  await installSkillSource(f.job,executionSource,source,0,f.log);
  await githubFixture(f,r,{body:"Closes #2"});
  const terminal=join(f.job.root,"terminal.json"),receipt=join(f.job.root,"review.json");
  const wait=join(f.job.codexHome,"skills/pr-review-loop/scripts/wait_for_pr_state.py");
  const writeReceipt=`const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(receipt)},JSON.stringify({state:'automation_clean',terminal_receipt:JSON.parse(fs.readFileSync(${JSON.stringify(terminal)},'utf8')),dispositions:[]}));`;
  const deliver=`gh pr create --title 'Fixture PR' --body 'Closes #2' && python3 ${quote(wait)} --repo fixture/repo --pr 9 --require-check CI --quiet-seconds 0 --max-wait-seconds 10 > ${quote(terminal)} && node -e ${quote(writeReceipt)}`;
  const auditResult=(verdict,findings=[])=>({verdict,findings,summary:"Fixture provider conformance result",auditor:{session:"not exposed by CLI",model:"not exposed by CLI"},base_sha:r.base,audited_state:"Complete fixture worktree"});
  const replies=[
    [tool("printf '%s\\n' 'console.log(42);' > greeting.js")],
    [message(turn("accomplishment",{paths:["greeting.js"],commit_message:"Complete fixture file",validation_policy:policy}))],
    [message(turn("audit",{validation_policy:policy}))],
    [message(auditResult("nonconformant",[{plan_item:"Complete fixture",category:"missing_behavior",evidence:"greeting.js:1",gap:"Fixture correction required",required_outcome:"Correct fixture",guidance:"Correct fixture logic"}]))],
    [tool("printf '%s\\n' 'console.log(43);' > greeting.js && rm README.md","correction")],
    [message(turn("audit",{validation_policy:policy}))],
    [message(auditResult("conformant"))],
    [message(turn("accomplishment",{paths:["greeting.js","README.md"],commit_message:"Correct fixture",validation_policy:policy}))],
    [tool(deliver,"delivery-call")],
    [message(turn("complete",{pr_url:"https://github.com/fixture/repo/pull/9",review_receipt:receipt,validation_policy:policy}))],
  ];
  const api=await provider(t,replies);await configure(f.job,api.config,f.log);
  const git=new TaskGit(r.cwd,f.job.env,f.log,r.branch),plan="Complete greeting.js and deliver an audited PR.";
  let artifactId=40;const uploads=[];
  const result=await drive({job:f.job,git,log:f.log,plan,planSource:"inline",issueNumber:"2",authorization:{repository:"fixture/repo",plan_sha256:hash(plan),request:"Implement through PR delivery with accomplishment checkpoints"},repository:"fixture/repo",taskId:"fixture-task",base:r.base,budgetMs:240000,started:Date.now(),skills:[executionSource],lineage:{run_id:"13"},
    checkpoint:(input)=>durableCheckpoint(f.job,input,f.log,sha=>git.verify(sha),async(name,files,root)=>{
      uploads.push({name,files,root});
      if (closeDuringUpload && uploads.length === 3) {
        const path = join(f.job.root, "api-state.json"), state = JSON.parse(await readFile(path, "utf8"));
        await writeFile(path, JSON.stringify({ ...state, closed:true }));
      }
      return {id:++artifactId};
    }),
    complete:(url,receiptPath,validation,timeoutMs)=>verifyDelivery({job:f.job,git,log:f.log,repository:"fixture/repo",login:"fixture-actor",baseBranch:"main",url,receiptPath,policy:validation,timeoutMs,issueNumber:"2"}),
  });
  assert.equal(result.status,closeDuringUpload?"failed":"completed");assert.equal(result.checkpoint.artifact_id,43);assert.equal(uploads.length,3);
  assert.equal(await git.remoteHead(),result.checkpoint.checkpoint_sha);
  assert.equal(await readFile(join(f.job.root,"pr-created"),"utf8"),"yes");
  const manifest=JSON.parse(await readFile(join(uploads.at(-1).root,"manifest.json"),"utf8"));
  assert.equal(new Set(manifest.sessions).size,2);assert.equal(manifest.audit.verdict,"conformant");
  assert.equal(manifest.audit.rounds.length,2);assert.equal(manifest.audit.rounds[0].dispositions[0].disposition,"cleared_by_independent_rescan");
  assert.equal(manifest.audit.rounds[0].receipt.auditor.session,manifest.audit.rounds[1].receipt.auditor.session);
  assert.equal(manifest.audit.validation[0].exit_code,0);
  assert.ok(f.records.some(record=>record.event==="runtime.delivery"&&record.outcome==="automation_clean"));
  const auditRequest=api.requests.find(body=>JSON.stringify(body).includes("RAW AUDIT CONTRACT:"));
  assert.ok(auditRequest);assert.doesNotMatch(JSON.stringify(auditRequest),/Fixture accomplishment/);
  if (closeDuringUpload) {
    const failure = f.records.findLast(record => record.event === "runtime.failed" && record.reason === "pr_identity_mismatch");
    assert.equal(failure.last_durable_checkpoint.artifact_id, 43);
    assert.equal(failure.expected_sha, result.checkpoint.checkpoint_sha); assert.equal(failure.observed_sha, result.checkpoint.checkpoint_sha);
    assert.deepEqual(failure.missing_gates, ["open_pull_request"]);
    assert.equal(failure.expected_pr.state, "open"); assert.equal(failure.observed_pr.state, "closed");
    assert.doesNotMatch(JSON.stringify(failure), /Closes #2/);
    assert.equal(f.records.findLast(record => record.event === "runtime.complete").status, "failed");
    return;
  }
  const verification={job:f.job,git,log:f.log,repository:"fixture/repo",login:"fixture-actor",baseBranch:"main",url:"https://github.com/fixture/repo/pull/9",receiptPath:receipt,policy,timeoutMs:10000};
  await assert.rejects(verifyDelivery({...verification,issueNumber:"3"}), error => {
    f.log.failure(error, result.checkpoint);
    assert.equal(error.reason, "pr_identity_mismatch"); assert.deepEqual(error.details.missing_gates, ["issue_closing_line"]);
    assert.equal(error.details.expected_pr.issue_number, "3"); assert.equal(error.details.observed_pr.has_issue_closing_line, false); return true;
  });
  await writeFile(join(f.job.root,"api-state.json"),JSON.stringify({stale:true}));
  await assert.rejects(verifyDelivery(verification), error => {
    f.log.failure(error, result.checkpoint);
    assert.equal(error.reason, "pr_identity_mismatch"); assert.deepEqual(error.details.missing_gates, ["head_sha"]);
    assert.equal(error.details.expected_sha, result.checkpoint.checkpoint_sha); assert.equal(error.details.observed_sha, "b".repeat(40)); return true;
  });
});
for (const clears of [true, false]) test(`missing real auditor session preserves one reconsideration before ${clears ? "conformance" : "dispute exhaustion"}`, async (t) => {
  const f = await fixture(t), r = await repository(f), source = await portableSource(f);
  await installSkillSource(f.job, executionSource, source, 0, f.log);
  const marker = join(f.job.root, "validation-passed"), validation = { ...policy,
    local_checks:["node -e " + quote(`require('node:fs').writeFileSync(${JSON.stringify(marker)},'passed')`)] };
  const finding = { plan_item:"Fixture criterion", category:"missing_behavior", evidence:"README.md:1",
    gap:"Disputed fixture finding", required_outcome:"Independent reconsideration", guidance:"Inspect the evidence" };
  const audit = (conformant = false) => ({ verdict:conformant ? "conformant" : "nonconformant", findings:conformant ? [] : [finding],
    summary:"Fixture audit", auditor:{session:"not exposed by CLI",model:"not exposed by CLI"},base_sha:r.base,audited_state:"Complete fixture worktree" });
  let missingSession;
  const api = await provider(t, async (_request, ordinal) => {
    if (ordinal === 1) return [message(turn("audit", {validation_policy:validation}))];
    if (ordinal === 2 || ordinal === 4) return [message(audit())];
    if (ordinal === 3) {
      missingSession = JSON.parse(await readFile(join(f.job.root, "audit-receipt.json"), "utf8")).auditor_session;
      let removed = false;
      for (const path of await safeTree(join(f.job.codexHome, "sessions"))) {
        if (!path.endsWith(".jsonl")) continue;
        const first = JSON.parse((await readFile(path, "utf8")).split("\n")[0]);
        if (first.payload?.id !== missingSession) continue;
        await rename(path, join(f.job.root, "unavailable-auditor.jsonl")); removed = true;
      }
      assert.ok(removed);
      const db = new DatabaseSync(join(f.job.codexHome, "state_5.sqlite"));
      try { assert.equal(db.prepare("DELETE FROM threads WHERE id = ?").run(missingSession).changes, 1); }
      finally { db.close(); }
      return [message(turn("audit", {summary:"first-reconsideration-evidence-8512",validation_policy:validation}))];
    }
    if (ordinal === 5) return [message(turn("audit", {summary:"replacement-reconsideration-evidence-9613",validation_policy:validation}))];
    if (ordinal === 6) return [message(audit(clears))];
    if (ordinal === 7) return [message(turn(clears ? "blocked" : "audit", {validation_policy:validation}))];
    throw new Error("Unexpected auditor recovery fixture request " + ordinal);
  });
  await configure(f.job, api.config, f.log);
  const git = new TaskGit(r.cwd, f.job.env, f.log, r.branch), plan = "Obtain independent fixture conformance before validation.";
  const result = await drive({ job:f.job,git,log:f.log,plan,planSource:"inline",
    authorization:{repository:"fixture/repo",plan_sha256:hash(plan),request:"Implement the fixture with independent auditing"},
    repository:"fixture/repo",taskId:"fixture-task",base:r.base,budgetMs:240000,started:Date.now(),skills:[executionSource],lineage:{run_id:"13"},
    checkpoint:async () => { throw new Error("Audit-only fixture must not publish"); },
    complete:async () => { throw new Error("Audit-only fixture must not claim delivery"); },
  });
  const failures = JSON.stringify(f.records.filter(record => record.event === "runtime.failed"));
  assert.equal(result.status, clears ? "blocked" : "failed", failures); assert.equal(api.requests.length, 7, failures);
  const replacement = JSON.stringify(api.requests[3]), reconsideration = JSON.stringify(api.requests[5]);
  assert.match(replacement, /RAW AUDIT CONTRACT/); assert.doesNotMatch(replacement, /Evidence-backed reconsideration|first-reconsideration-evidence-8512/);
  assert.match(reconsideration, /Evidence-backed reconsideration/); assert.match(reconsideration, /replacement-reconsideration-evidence-9613/);
  const rounds = JSON.parse(await readFile(join(f.job.root, "audit-history.json"), "utf8"));
  assert.equal(rounds.length, 3); assert.equal(rounds[0].receipt.auditor_session, missingSession);
  assert.notEqual(rounds[1].receipt.auditor_session, missingSession); assert.equal(rounds[1].receipt.auditor_session, rounds[2].receipt.auditor_session);
  const unavailable = f.records.find(record => record.event === "runtime.audit" && record.reason === "auditor_session_unavailable" && record.previous_session === missingSession);
  assert.ok(unavailable); assert.match(unavailable.native_cause, /no rollout found for thread id/);
  if (clears) { assert.equal(await readFile(marker, "utf8"), "passed"); assert.equal(rounds[2].receipt.verdict, "conformant"); }
  else { await assert.rejects(readFile(marker), {code:"ENOENT"}); assert.ok(f.records.some(record => record.reason === "audit_dispute_unresolved")); }
});
test("a real worker Git commit reports both heads and preserves the preceding published checkpoint", async (t) => {
  const f = await fixture(t), r = await repository(f), source = await portableSource(f);
  await installSkillSource(f.job, executionSource, source, 0, f.log);
  const api = await provider(t, [
    [tool("printf '%s\\n' 'console.log(42);' > greeting.js")],
    [message(turn("accomplishment", { paths:["greeting.js"], commit_message:"Publish fixture increment" }))],
    [tool("git commit --allow-empty -m 'Unexpected worker commit'", "unexpected-history")],
    [message(turn("accomplishment"))],
  ]);
  await configure(f.job, api.config, f.log);
  const git = new TaskGit(r.cwd, f.job.env, f.log, r.branch), plan = "Complete fixture increments with supervisor publication.";
  let uploads = 0;
  const result = await drive({ job:f.job, git, log:f.log, plan, planSource:"inline",
    authorization:{repository:"fixture/repo",plan_sha256:hash(plan),request:"Implement through audited PR delivery with checkpoint pushes"},
    repository:"fixture/repo",taskId:"fixture-task",base:r.base,budgetMs:240000,started:Date.now(),skills:[executionSource],lineage:{run_id:"13"},
    checkpoint:input => durableCheckpoint(f.job, input, f.log, sha => git.verify(sha), async () => { uploads++; return { id:41 }; }),
    complete:async () => { throw new Error("Unexpected delivery in history-drift fixture"); },
  });
  assert.equal(result.status, "failed"); assert.equal(uploads, 1); assert.equal(result.checkpoint.artifact_id, 41);
  const failure = f.records.findLast(record => record.event === "runtime.failed" && record.reason === "worker_changed_git_history");
  assert.equal(failure.expected_sha, result.checkpoint.checkpoint_sha); assert.equal(failure.observed_sha, await git.head());
  assert.notEqual(failure.expected_sha, failure.observed_sha); assert.equal(await git.remoteHead(), failure.expected_sha);
  assert.equal(failure.last_durable_checkpoint.artifact_id, 41); assert.equal(failure.session_id, result.session);
  assert.match(failure.native_cause, /outside supervisor publication/);
});
test("an unsupported completion claim cannot bypass the driver audit and delivery gates", async(t)=>{
  const f=await fixture(t),r=await repository(f),source=await portableSource(f);
  await installSkillSource(f.job,executionSource,source,0,f.log);
  const api=await provider(t,[[message(turn("complete",{pr_url:"https://github.com/fixture/repo/pull/9",review_receipt:join(f.job.root,"forged.json")}))]]);
  await configure(f.job,api.config,f.log);
  const git=new TaskGit(r.cwd,f.job.env,f.log,r.branch);
  let checkpointed=false,verified=false;
  const result=await drive({job:f.job,git,log:f.log,plan:"Fixture",planSource:"inline",authorization:{repository:"fixture/repo",plan_sha256:hash("Fixture"),request:"Implement fixture"},repository:"fixture/repo",taskId:"fixture-task",base:r.base,budgetMs:240000,started:Date.now(),skills:[executionSource],lineage:{},checkpoint:async()=>{checkpointed=true;throw Error("Should not checkpoint");},complete:async()=>{verified=true;}});
  assert.equal(result.status,"failed");assert.equal(checkpointed,false);assert.equal(verified,false);
  const failure=f.records.find(record=>record.reason==="unverified_completion_claim");
  assert.equal(failure.stage,"delivery");
  assert.deepEqual(failure.missing_gates,["validation_policy","conformant_audit","local_validation"]);
});
test("a real worker blocker retains structured causes in normal runtime diagnostics",async(t)=>{
  const f=await fixture(t),r=await repository(f),source=await portableSource(f);
  await installSkillSource(f.job,executionSource,source,0,f.log);
  const blocker={reason:"missing_dependency",missing_inputs:["dependency_issue"],references:["https://github.com/fixture/repo/issues/2"]};
  const api=await provider(t,[[message(turn("blocked",{blocker}))]]);
  await configure(f.job,api.config,f.log);
  const git=new TaskGit(r.cwd,f.job.env,f.log,r.branch);
  const result=await drive({job:f.job,git,log:f.log,plan:"Fixture",planSource:"inline",authorization:{repository:"fixture/repo",plan_sha256:hash("Fixture"),request:"Implement fixture"},repository:"fixture/repo",taskId:"fixture-task",base:r.base,budgetMs:240000,started:Date.now(),skills:[executionSource],lineage:{},checkpoint:async()=>{throw Error("Blocked work cannot checkpoint");},complete:async()=>{throw Error("Blocked work cannot complete");}});
  assert.equal(result.status,"blocked");
  const evidence=f.records.find(record=>record.event==="runtime.blocked");
  assert.equal(evidence.level,"ERROR");assert.equal(evidence.reason,blocker.reason);
  assert.deepEqual(evidence.references,blocker.references);assert.deepEqual(evidence.missing_inputs,blocker.missing_inputs);
});
test("a real piped validation failure cannot become a passing supervisor receipt",async(t)=>{
  const f=await fixture(t),r=await repository(f),source=await portableSource(f);
  await installSkillSource(f.job,executionSource,source,0,f.log);
  const validation={...policy,local_checks:["false | cat"]};
  const audit={verdict:"conformant",findings:[],summary:"Fixture conformance",auditor:{session:"not exposed by CLI",model:"not exposed by CLI"},base_sha:r.base,audited_state:"Complete fixture worktree"};
  const api=await provider(t,[[message(turn("audit",{validation_policy:validation}))],[message(audit)],[message(turn("blocked",{blocker:{reason:"validation_failed",references:[],missing_inputs:[]}}))]]);
  await configure(f.job,api.config,f.log);
  const git=new TaskGit(r.cwd,f.job.env,f.log,r.branch);
  const result=await drive({job:f.job,git,log:f.log,plan:"Fixture",planSource:"inline",authorization:{repository:"fixture/repo",plan_sha256:hash("Fixture"),request:"Implement fixture"},repository:"fixture/repo",taskId:"fixture-task",base:r.base,budgetMs:240000,started:Date.now(),skills:[executionSource],lineage:{},checkpoint:async()=>{throw Error("Failed validation cannot checkpoint");},complete:async()=>{throw Error("Failed validation cannot complete");}});
  assert.equal(result.status,"blocked");
  const failure=f.records.find(record=>record.event==="runtime.failed"&&record.stage==="local_check_0");
  assert.equal(failure.reason,"command_failed");assert.equal(failure.exit_code,1);
  assert.ok(!f.records.some(record=>record.event==="runtime.operation"&&record.stage==="local_check_0"&&record.outcome==="success"));
});
test("a failed real Node check returns sanitized assertion evidence to the resumed worker", async (t) => {
  const f = await fixture(t), r = await repository(f), source = await portableSource(f);
  await installSkillSource(f.job, executionSource, source, 0, f.log);
  const validation = { ...policy, local_checks:["node --test failure.test.mjs"] };
  const code = "import test from 'node:test';import assert from 'node:assert/strict';test('validation evidence',()=>assert.equal(process.env.CODEX_API_KEY,'expected-value','validation-assertion-7351'));\n";
  const audit = { verdict:"conformant", findings:[], summary:"Fixture conformance", auditor:{session:"not exposed by CLI",model:"not exposed by CLI"}, base_sha:r.base, audited_state:"Complete fixture worktree" };
  const api = await provider(t, [[tool(`printf '%s' ${quote(code)} > failure.test.mjs`)], [message(turn("audit", {validation_policy:validation}))], [message(audit)], [message(turn("blocked", {blocker:{reason:"validation_failed",references:[],missing_inputs:[]}}))]]);
  await configure(f.job, api.config, f.log);
  const git = new TaskGit(r.cwd, f.job.env, f.log, r.branch);
  const result = await drive({ job:f.job, git, log:f.log, plan:"Fixture", planSource:"inline", authorization:{repository:"fixture/repo",plan_sha256:hash("Fixture"),request:"Implement fixture"}, repository:"fixture/repo", taskId:"fixture-task", base:r.base, budgetMs:240000, started:Date.now(), skills:[executionSource], lineage:{}, checkpoint:async()=>{throw Error("Failed validation cannot checkpoint");}, complete:async()=>{throw Error("Failed validation cannot complete");} });
  assert.equal(result.status, "blocked");
  const feedback = api.requests.at(-1).input.filter(item => item.role === "user").flatMap(item => item.content ?? []).map(item => item.text ?? "").findLast(text => text.includes("Sanitized cause:"));
  assert.match(feedback, /validation-assertion-7351/); assert.match(feedback, /failure.test.mjs/);
  assert.doesNotMatch(feedback, /fixture-api-credential-9374/);
  const failure = f.records.find(record => record.event === "runtime.failed" && record.stage === "local_check_0");
  assert.match(failure.native_cause, /validation-assertion-7351/); assert.doesNotMatch(JSON.stringify(f.records), /fixture-api-credential-9374/);
});
for(const interruption of ["budget","SIGTERM","SIGINT"]) test(`${interruption} interruption retains the last real pushed and uploaded accomplishment`, async(t)=>{
  const f=await fixture(t),r=await repository(f),source=await portableSource(f);
  await installSkillSource(f.job,executionSource,source,0,f.log);
  const api=await provider(t,[[tool("printf '%s\\n' 'console.log(42);' > greeting.js")],
    [message(turn("accomplishment",{paths:["greeting.js"],commit_message:"Durable fixture progress"}))],{hang:true}]);
  await configure(f.job,api.config,f.log);
  const git=new TaskGit(r.cwd,f.job.env,f.log,r.branch);
  let uploads=0;
  let signalTimer;t.after(()=>clearTimeout(signalTimer));
  const result=await drive({job:f.job,git,log:f.log,plan:"Fixture budget",planSource:"inline",authorization:{repository:"fixture/repo",plan_sha256:hash("Fixture budget"),request:"Implement fixture"},repository:"fixture/repo",taskId:"fixture-task",base:r.base,budgetMs:interruption==="budget"?130000:240000,started:Date.now(),skills:[executionSource],lineage:{},
    checkpoint:async input=>{const receipt=await durableCheckpoint(f.job,input,f.log,sha=>git.verify(sha),async()=>({id:++uploads}));
      if(interruption!=="budget"){const send=()=>{if(process.listenerCount(interruption)>0)process.kill(process.pid,interruption);else signalTimer=setTimeout(send,10);};signalTimer=setTimeout(send,1000);}return receipt;},
    complete:async()=>{throw Error("Interrupted work cannot complete");}});
  assert.equal(result.status,"incomplete");assert.equal(uploads,1);assert.equal(result.checkpoint.artifact_id,1);
  assert.equal(await git.remoteHead(),result.checkpoint.checkpoint_sha);
  assert.equal(f.records.findLast(record=>record.event==="runtime.complete").status,"incomplete");
});
