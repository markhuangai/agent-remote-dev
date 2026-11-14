import assert from "node:assert/strict";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { configure, installSkillSource } from "../.build/setup.js";
import { runCodex } from "../.build/codex.js";
import { TaskGit } from "../.build/git.js";
import { drive } from "../.build/driver.js";
import { durableCheckpoint } from "../.build/checkpoint.js";
import { verifyDelivery } from "../.build/delivery.js";
import { executionSource, hash, parseTurn } from "../.build/contracts.js";
import { fixture, githubFixture, message, policy, portableSource, provider, repository, tool, turn } from "./helpers.mjs";

const quote = (text) => "'" + text.replaceAll("'", "'\"'\"'") + "'";
test("real Codex full-access turns preserve conversation identity and exclude host user skills", async (t) => {
  const f = await fixture(t), r = await repository(f);
  const api = await provider(t, [[tool("printf '%s\\n' 'console.log(42);' > greeting.js")], [message(turn("accomplishment", { paths:["greeting.js"], commit_message:"Create fixture" }))], [message(turn("blocked"))]]);
  await configure(f.job, api.config, f.log);
  const first = await runCodex(f.job,r.cwd,"full-access","Perform the next fixture step.",f.log,60000,"one");
  assert.equal(await readFile(join(r.cwd,"greeting.js"),"utf8"),"console.log(42);\n");
  assert.equal(parseTurn(first.result).kind,"accomplishment");
  const second = await runCodex(f.job,r.cwd,"full-access","Continue the SAME fixture conversation.",f.log,60000,"two",first.session);
  assert.equal(second.session,first.session);
  assert.doesNotMatch(JSON.stringify(api.requests),/unwanted-host-sentinel-3719/);
  assert.match(JSON.stringify(api.requests.at(-1)),/Perform the next fixture step/);
  for(const[name,content]of Object.entries(f.hostFiles))assert.equal(await readFile(join(f.host,name),"utf8"),content);
});
test("sandboxed mode performs a real write or diagnoses native namespace denial without escalation", async (t) => {
  const f = await fixture(t), r = await repository(f);
  const api = await provider(t, [[tool("printf sandboxed > sandbox-result.txt")], [message(turn("accomplishment", {paths:["sandbox-result.txt"],commit_message:"Sandbox fixture"}))]]);
  await configure(f.job,api.config,f.log);
  let failure;
  try { await runCodex(f.job,r.cwd,"sandboxed","Execute the sandbox fixture.",f.log,60000,"sandbox"); }
  catch(error) { failure=error; f.log.failure(error); }
  if(failure) {
    assert.equal(failure.reason,"sandbox_startup_failed");
    assert.match(failure.nativeCause,/bwrap: No permissions to create (?:a )?new namespace/);
    assert.equal(f.records.find(record=>record.event==="runtime.failed").stage,"worker");
    assert.notEqual(process.env.REQUIRE_SANDBOX_SUCCESS,"1","CI must prove successful sandbox execution; native denial is not a CI pass");
    t.diagnostic("Native sandbox denial verified locally; CI requires the successful write scenario.");
  } else {
    const outputs=api.requests.flatMap(request=>request.input??[]).filter(item=>item.type==="function_call_output").map(item=>String(item.output)).join("\n");
    const cause=f.log.sanitize(outputs.split("\n").filter(line=>/bwrap:|sandbox|permitted|denied|error|exit code|Process exited|failed/i.test(line)).join("\n")).slice(0,512);
    let content;
    try { content=await readFile(join(r.cwd,"sandbox-result.txt"),"utf8"); }
    catch { assert.fail(`Real sandbox tool did not produce the required file. Native evidence: ${cause||"No native diagnostic exposed"}`); }
    assert.equal(content,"sandboxed");
  }
});
test("real CLI authentication errors retain stage and sanitized native cause without raw provider bodies", async (t) => {
  const f = await fixture(t),r=await repository(f);
  const api=await provider(t,()=>({status:403,body:{error:{message:"private-provider-body-5741",api_key:f.job.env.CODEX_API_KEY}}}));
  await configure(f.job,api.config,f.log);
  await assert.rejects(runCodex(f.job,r.cwd,"full-access","Fixture request",f.log,20000,"auth"),(error)=>{ f.log.failure(error); return true; });
  const output=JSON.stringify(f.records);
  assert.doesNotMatch(output,/private-provider-body-5741|fixture-api-credential-9374/);
  assert.ok(f.records.some(record=>record.event==="runtime.failed"&&record.stage==="worker"));
});
test("the real CLI driver audits independently, checks production files, publishes checkpoints and verifies PR delivery", async (t) => {
  const f=await fixture(t),r=await repository(f),source=await portableSource(f);
  await installSkillSource(f.job,executionSource,source,0,f.log);
  await githubFixture(f,r);
  const terminal=join(f.job.root,"terminal.json"),receipt=join(f.job.root,"review.json");
  const wait=join(f.job.codexHome,"skills/pr-review-loop/scripts/wait_for_pr_state.py");
  const writeReceipt=`const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(receipt)},JSON.stringify({state:'automation_clean',terminal_receipt:JSON.parse(fs.readFileSync(${JSON.stringify(terminal)},'utf8')),dispositions:[]}));`;
  const deliver=`gh pr create --title 'Fixture PR' --body 'Fixture delivery' && python3 ${quote(wait)} --repo fixture/repo --pr 9 --require-check CI --quiet-seconds 0 --max-wait-seconds 10 > ${quote(terminal)} && node -e ${quote(writeReceipt)}`;
  const auditResult=(verdict,findings=[])=>({verdict,findings,summary:"Fixture provider conformance result",auditor:{session:"not exposed by CLI",model:"not exposed by CLI"},base_sha:r.base,audited_state:"Complete fixture worktree"});
  const replies=[
    [tool("printf '%s\\n' 'console.log(42);' > greeting.js")],
    [message(turn("accomplishment",{paths:["greeting.js"],commit_message:"Complete fixture file",validation_policy:policy}))],
    [message(turn("audit",{validation_policy:policy}))],
    [message(auditResult("nonconformant",[{plan_item:"Complete fixture",category:"missing_behavior",evidence:"greeting.js:1",gap:"Fixture correction required",required_outcome:"Correct fixture",guidance:"Correct fixture logic"}]))],
    [tool("printf '%s\\n' 'console.log(43);' > greeting.js","correction")],
    [message(turn("audit",{validation_policy:policy}))],
    [message(auditResult("conformant"))],
    [message(turn("accomplishment",{paths:["greeting.js"],commit_message:"Correct fixture",validation_policy:policy}))],
    [tool(deliver,"delivery-call")],
    [message(turn("complete",{pr_url:"https://github.com/fixture/repo/pull/9",review_receipt:receipt,validation_policy:policy}))],
  ];
  const api=await provider(t,replies);await configure(f.job,api.config,f.log);
  const git=new TaskGit(r.cwd,f.job.env,f.log,r.branch),plan="Complete greeting.js and deliver an audited PR.";
  let artifactId=40;const uploads=[];
  const result=await drive({job:f.job,git,log:f.log,plan,planSource:"inline",authorization:{repository:"fixture/repo",plan_sha256:hash(plan),permission_mode:"full-access",request:"Implement through PR delivery with accomplishment checkpoints"},repository:"fixture/repo",taskId:"fixture-task",base:r.base,budgetMs:240000,started:Date.now(),skills:[executionSource],lineage:{run_id:"13"},
    checkpoint:(input)=>durableCheckpoint(f.job,input,f.log,sha=>git.verify(sha),async(name,files,root)=>{uploads.push({name,files,root});return{id:++artifactId};}),
    complete:(url,receiptPath,validation,timeoutMs)=>verifyDelivery({job:f.job,git,log:f.log,repository:"fixture/repo",login:"fixture-actor",baseBranch:"main",url,receiptPath,policy:validation,timeoutMs}),
  });
  assert.equal(result.status,"completed");assert.equal(result.checkpoint.artifact_id,43);assert.equal(uploads.length,3);
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
  const verification={job:f.job,git,log:f.log,repository:"fixture/repo",login:"fixture-actor",baseBranch:"main",url:"https://github.com/fixture/repo/pull/9",receiptPath:receipt,policy,timeoutMs:10000};
  await assert.rejects(verifyDelivery({...verification,issueNumber:"2"}),{reason:"pr_identity_mismatch"});
  await writeFile(join(f.job.root,"api-state.json"),JSON.stringify({stale:true}));
  await assert.rejects(verifyDelivery(verification),{reason:"pr_identity_mismatch"});
});
test("an unsupported completion claim cannot bypass the driver audit and delivery gates", async(t)=>{
  const f=await fixture(t),r=await repository(f),source=await portableSource(f);
  await installSkillSource(f.job,executionSource,source,0,f.log);
  const api=await provider(t,[[message(turn("complete",{pr_url:"https://github.com/fixture/repo/pull/9",review_receipt:join(f.job.root,"forged.json")}))]]);
  await configure(f.job,api.config,f.log);
  const git=new TaskGit(r.cwd,f.job.env,f.log,r.branch);
  let checkpointed=false,verified=false;
  const result=await drive({job:f.job,git,log:f.log,plan:"Fixture",planSource:"inline",authorization:{repository:"fixture/repo",plan_sha256:hash("Fixture"),permission_mode:"full-access",request:"Implement fixture"},repository:"fixture/repo",taskId:"fixture-task",base:r.base,budgetMs:240000,started:Date.now(),skills:[executionSource],lineage:{},checkpoint:async()=>{checkpointed=true;throw Error("Should not checkpoint");},complete:async()=>{verified=true;}});
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
  const result=await drive({job:f.job,git,log:f.log,plan:"Fixture",planSource:"inline",authorization:{repository:"fixture/repo",plan_sha256:hash("Fixture"),permission_mode:"full-access",request:"Implement fixture"},repository:"fixture/repo",taskId:"fixture-task",base:r.base,budgetMs:240000,started:Date.now(),skills:[executionSource],lineage:{},checkpoint:async()=>{throw Error("Blocked work cannot checkpoint");},complete:async()=>{throw Error("Blocked work cannot complete");}});
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
  const result=await drive({job:f.job,git,log:f.log,plan:"Fixture",planSource:"inline",authorization:{repository:"fixture/repo",plan_sha256:hash("Fixture"),permission_mode:"full-access",request:"Implement fixture"},repository:"fixture/repo",taskId:"fixture-task",base:r.base,budgetMs:240000,started:Date.now(),skills:[executionSource],lineage:{},checkpoint:async()=>{throw Error("Failed validation cannot checkpoint");},complete:async()=>{throw Error("Failed validation cannot complete");}});
  assert.equal(result.status,"blocked");
  const failure=f.records.find(record=>record.event==="runtime.failed"&&record.stage==="local_check_0");
  assert.equal(failure.reason,"command_failed");assert.equal(failure.exit_code,1);
  assert.ok(!f.records.some(record=>record.event==="runtime.operation"&&record.stage==="local_check_0"&&record.outcome==="success"));
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
  const result=await drive({job:f.job,git,log:f.log,plan:"Fixture budget",planSource:"inline",authorization:{repository:"fixture/repo",plan_sha256:hash("Fixture budget"),permission_mode:"full-access",request:"Implement fixture"},repository:"fixture/repo",taskId:"fixture-task",base:r.base,budgetMs:interruption==="budget"?130000:240000,started:Date.now(),skills:[executionSource],lineage:{},
    checkpoint:async input=>{const receipt=await durableCheckpoint(f.job,input,f.log,sha=>git.verify(sha),async()=>({id:++uploads}));
      if(interruption!=="budget"){const send=()=>{if(process.listenerCount(interruption)>0)process.kill(process.pid,interruption);else signalTimer=setTimeout(send,10);};signalTimer=setTimeout(send,1000);}return receipt;},
    complete:async()=>{throw Error("Interrupted work cannot complete");}});
  assert.equal(result.status,"incomplete");assert.equal(uploads,1);assert.equal(result.checkpoint.artifact_id,1);
  assert.equal(await git.remoteHead(),result.checkpoint.checkpoint_sha);
  assert.equal(f.records.findLast(record=>record.event==="runtime.complete").status,"incomplete");
});
