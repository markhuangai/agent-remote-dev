import assert from "node:assert/strict";
import { Console } from "node:console";
import { readFile } from "node:fs/promises";
import { Writable } from "node:stream";
import test from "node:test";
import { logEvent, publishReviewStatus, resolveReview } from "../.github/scripts/review-policy.mjs";
import { evaluateCodeQLJobs, requireCodeQL } from "../.github/scripts/codeql-policy.mjs";

const head = "a".repeat(40);
const movedHead = "b".repeat(40);
const repository = { id: 17 };
const pull = {
  number: 7, state: "open", draft: false, user: { login: "Z-M-Huang" },
  base: { ref: "main", repo: repository },
  head: { sha: head, ref: "feature", repo: repository },
};
const codeqlRun = {
  id: 41, workflow_id: 23, repository, run_attempt: 1,
  event: "pull_request", status: "completed", conclusion: "success",
  head_sha: head, head_branch: "feature", head_repository: repository,
  actor: { login: "contributor" }, triggering_actor: { login: "contributor" },
};

function fixture(options = {}) {
  let output = "";
  const stream = new Writable({ write(chunk, _encoding, done) { output += chunk; done(); } });
  const logger = new Console({ stdout: stream, stderr: stream });
  const core = {
    info: logger.info.bind(logger), warning: logger.warn.bind(logger),
    error: logger.error.bind(logger), debug() {},
  };
  const livePull = options.livePull ?? structuredClone(pull);
  const publications = [];
  const transport = (data) => async () => ({ data });
  const github = {
    paginate: async (endpoint, parameters) => (await endpoint(parameters)).data,
    rest: {
      pulls: { get: transport(livePull), list: transport(options.pulls ?? [livePull]) },
      actions: {
        getWorkflow: transport(options.workflow ?? { id: 23, path: ".github/workflows/codeql.yml" }),
        getWorkflowRun: transport(options.run ?? structuredClone(codeqlRun)),
        listJobsForWorkflowRun: transport(options.jobs ?? []),
      },
      repos: {
        listCommitStatusesForRef: transport(options.statuses ?? []),
        createCommitStatus: async (request) => { publications.push(request); return { data: request }; },
      },
    },
  };
  const context = {
    eventName: "pull_request_target", actor: "Z-M-Huang",
    repo: { owner: "markhuangai", repo: "agent-remote-dev" },
    serverUrl: "https://github.com", runId: 90,
    payload: { repository, pull_request: structuredClone(pull) },
    ...options.context,
  };
  const env = {
    GITHUB_REPOSITORY: "markhuangai/agent-remote-dev",
    GITHUB_RUN_ID: "90", GITHUB_RUN_ATTEMPT: "1", GITHUB_WORKFLOW_SHA: "c".repeat(40),
    GITHUB_RETENTION_DAYS: "90", GITHUB_REF: "refs/heads/main", TRIGGERING_ACTOR: "Z-M-Huang",
    PR_NUMBER: "7", HEAD_SHA: head, HEAD_REF: "feature", HEAD_REPOSITORY_ID: "17",
    REVIEW_OUTCOME: "success", REVIEW_ROUTE: "direct", SOURCE_SHA: head, ...options.env,
  };
  return {
    github, context, core, env, publications,
    get output() { return output; },
    get records() { return output.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)); },
  };
}

function runFixture(options = {}) {
  return fixture({ context: {
    eventName: "workflow_run", payload: { repository, workflow_run: structuredClone(codeqlRun) },
  }, ...options });
}

test("trusted same-repository PR selects its immutable identity and PR-specific status", async () => {
  const input = fixture();
  assert.deepEqual(await resolveReview(input), {
    should_run: true, pr_number: "7", head_sha: head, head_ref: "feature",
    head_repository_id: "17", review_status_context: "AI PR review / PR #7", route: "direct",
  });
  assert.equal(input.records[0].event, "review.resolve");
  assert.equal(input.records[0].run_id, "90");
});

for (const change of ["author", "actor", "triggering_actor", "fork"]) {
  test("direct route defers " + change + " to CodeQL without publishing", async () => {
    const input = fixture();
    if (change === "author") input.context.payload.pull_request.user.login = "contributor";
    if (change === "actor") input.context.actor = "contributor";
    if (change === "triggering_actor") input.env.TRIGGERING_ACTOR = "contributor";
    if (change === "fork") input.context.payload.pull_request.head.repo = { id: 18 };
    assert.equal((await resolveReview(input)).should_run, false);
    assert.equal(input.records[0].reason, "requires_codeql_completion");
    assert.equal(input.records[0].route, "codeql");
    assert.equal(input.publications.length, 0);
  });
}

test("successful registered CodeQL resolves fork PR by repository, branch, and SHA", async () => {
  const forkPull = structuredClone(pull);
  forkPull.head.repo = { id: 18 };
  forkPull.user.login = "contributor";
  const run = { ...codeqlRun, head_repository: { id: 18 } };
  const input = runFixture({
    livePull: forkPull, run,
    context: { eventName: "workflow_run", payload: { repository, workflow_run: run } },
  });
  assert.equal((await resolveReview(input)).head_repository_id, "18");
  assert.equal(input.records[0].route, "codeql");
});

for (const change of ["workflow", "repository", "sha", "branch"]) {
  test("CodeQL rejects changed " + change + " identity", async () => {
    const input = runFixture();
    const { data: run } = await input.github.rest.actions.getWorkflowRun();
    if (change === "workflow") run.workflow_id = 99;
    if (change === "repository") run.repository = { id: 99 };
    if (change === "sha") run.head_sha = movedHead;
    if (change === "branch") run.head_branch = "other";
    await assert.rejects(resolveReview(input), /Review resolution failed/);
    assert.equal(input.records[0].level, "ERROR");
  });
}

for (const change of ["failed", "push", "rerun"]) {
  test("CodeQL " + change + " completion cannot start review", async () => {
    const input = runFixture();
    if (change === "failed") input.context.payload.workflow_run.conclusion = "failure";
    if (change === "push") input.context.payload.workflow_run.event = "push";
    if (change === "rerun") {
      const { data: run } = await input.github.rest.actions.getWorkflowRun();
      run.run_attempt = 2;
    }
    assert.equal((await resolveReview(input)).should_run, false);
  });
}

test("CodeQL does not duplicate the trusted owner's direct route", async () => {
  const input = runFixture({ run: {
    ...codeqlRun, actor: { login: "Z-M-Huang" }, triggering_actor: { login: "Z-M-Huang" },
  } });
  assert.equal((await resolveReview(input)).should_run, false);
  assert.equal(input.records[0].reason, "uses_direct_review_route");
});

test("ambiguous matching PRs fail closed; absent or wrong branch/repository matches skip", async () => {
  const ambiguous = runFixture({ pulls: [pull, { ...pull, number: 8 }] });
  await assert.rejects(resolveReview(ambiguous));
  assert.equal(ambiguous.records[0].reason, "ambiguous_pull_request");
  for (const candidate of [[], [{ ...pull, head: { ...pull.head, ref: "other" } }],
    [{ ...pull, head: { ...pull.head, repo: { id: 18 } } }]]) {
    assert.equal((await resolveReview(runFixture({ pulls: candidate }))).should_run, false);
  }
});

for (const change of ["sha", "branch", "repository", "closed", "draft", "base"]) {
  test("resolution refuses a live PR with changed " + change, async () => {
    const livePull = structuredClone(pull);
    if (change === "sha") livePull.head.sha = movedHead;
    if (change === "branch") livePull.head.ref = "other";
    if (change === "repository") livePull.head.repo = { id: 18 };
    if (change === "closed") livePull.state = "closed";
    if (change === "draft") livePull.draft = true;
    if (change === "base") livePull.base.ref = "release";
    assert.equal((await resolveReview(fixture({ livePull }))).should_run, false);
  });
}

test("automatic deduplication uses latest status for this PR only", async () => {
  for (const state of ["pending", "success"]) {
    const input = fixture({ statuses: [
      { id: 1, context: "AI PR review / PR #7", state: "error" },
      { id: 2, context: "AI PR review / PR #7", state },
    ] });
    assert.equal((await resolveReview(input)).should_run, false);
  }
  const input = fixture({ statuses: [
    { id: 1, context: "AI PR review / PR #7", state: "success" },
    { id: 2, context: "AI PR review / PR #7", state: "error" },
    { id: 3, context: "AI PR review / PR #8", state: "success" },
  ] });
  assert.equal((await resolveReview(input)).should_run, true);
});

test("manual recovery requires the trusted actor, main ref, and positive safe PR number", async () => {
  const manual = () => fixture({
    context: { eventName: "workflow_dispatch", payload: { repository, inputs: { "pull-request-number": "7" } } },
    statuses: [{ id: 1, context: "AI PR review / PR #7", state: "pending" }],
  });
  assert.equal((await resolveReview(manual())).route, "manual");
  for (const change of ["actor", "trigger", "ref", "number", "unsafe_number"]) {
    const input = manual();
    if (change === "actor") input.context.actor = "contributor";
    if (change === "trigger") input.env.TRIGGERING_ACTOR = "contributor";
    if (change === "ref") input.env.GITHUB_REF = "refs/heads/feature";
    if (change === "number") input.context.payload.inputs["pull-request-number"] = "7; echo unsafe";
    if (change === "unsafe_number") input.context.payload.inputs["pull-request-number"] = "9007199254740993";
    await assert.rejects(resolveReview(input));
  }
});

test("pending and complete publication remain scoped to the fenced head and PR", async () => {
  const input = fixture();
  assert.equal(await publishReviewStatus({ ...input, phase: "pending" }), "pending");
  assert.equal(await publishReviewStatus({ ...input, phase: "complete" }), "success");
  assert.deepEqual(input.publications.map(({ sha, context, state }) => ({ sha, context, state })), [
    { sha: head, context: "AI PR review / PR #7", state: "pending" },
    { sha: head, context: "AI PR review / PR #7", state: "success" },
  ]);
});

for (const outcome of ["failure", "cancelled", "skipped", "timed_out", undefined]) {
  test("incomplete reviewer outcome " + outcome + " publishes blocking error", async () => {
    const input = fixture({ env: { REVIEW_OUTCOME: outcome } });
    assert.equal(await publishReviewStatus({ ...input, phase: "complete" }), "error");
    assert.equal(input.publications[0].state, "error");
    assert.equal(input.records[0].level, "ERROR");
  });
}

test("real stale-head path emits enough normal-level logs to diagnose withheld success", async () => {
  const livePull = structuredClone(pull);
  livePull.head.sha = movedHead;
  const input = fixture({ livePull });
  for (const phase of ["pending", "complete"]) {
    await assert.rejects(publishReviewStatus({ ...input, phase }));
  }
  assert.equal(input.publications.length, 0);
  const evidence = input.records.find((record) => record.event === "review.complete");
  assert.equal(evidence.reason, "head_identity_changed");
  assert.equal(evidence.expected_head, head);
  assert.equal(evidence.observed_head, movedHead);
  assert.equal(evidence.published_state, "withheld");
  assert.equal(evidence.reviewer_outcome, "success");
  assert.equal(evidence.pr_number, 7);
  assert.equal(evidence.route, "direct");
  assert.equal(evidence.workflow_sha, "c".repeat(40));
  assert.equal(evidence.retention_days, "90");
  assert.equal(evidence.level, "ERROR");
  assert.ok(evidence.elapsed_ms >= 0);
  assert.match(evidence.corrective_action, /current PR head/);
});

test("publication also refuses changed repository, branch, base, draft, and closed PRs", async () => {
  for (const change of ["repository", "branch", "base_repository", "base", "draft", "closed"]) {
    const livePull = structuredClone(pull);
    if (change === "repository") livePull.head.repo = { id: 18 };
    if (change === "branch") livePull.head.ref = "other";
    if (change === "base_repository") livePull.base.repo = { id: 18 };
    if (change === "base") livePull.base.ref = "release";
    if (change === "draft") livePull.draft = true;
    if (change === "closed") livePull.state = "closed";
    const input = fixture({ livePull });
    await assert.rejects(publishReviewStatus({ ...input, phase: "complete" }));
    assert.equal(input.publications.length, 0);
  }
});

test("API failures retain safe cause and request identity without credentials or raw errors", async () => {
  const input = fixture();
  input.github.rest.pulls.get = async () => {
    throw Object.assign(new Error("Authorization: Bearer credential-sentinel; raw private body"), {
      status: 403, response: { headers: { "x-github-request-id": "ABCD:1234" } },
      cause: { code: "ECONNRESET" },
    });
  };
  await assert.rejects(resolveReview(input));
  assert.equal(input.records[0].http_status, 403);
  assert.equal(input.records[0].request_id, "ABCD:1234");
  assert.equal(input.records[0].cause_code, "ECONNRESET");
  assert.doesNotMatch(input.output, /credential-sentinel|Authorization|private body/);
});

test("normal logger output is bounded and explicitly marks omitted characters", () => {
  const input = fixture();
  logEvent(input.core, "review.resolve", "INFO", { reason: "x".repeat(600) }, input.env);
  assert.equal(input.records[0].truncated, true);
  assert.match(input.records[0].reason, /\[truncated 88 characters\]/);
  assert.ok(input.output.length < 2048);
});

const job = (language, run_attempt = 1, conclusion = "success", id = run_attempt) => ({
  id, name: "Analyze (" + language + ")", run_attempt, status: "completed", conclusion,
});

test("CodeQL accepts both languages and retained success across a partial rerun", () => {
  assert.equal(evaluateCodeQLJobs([job("actions"), job("javascript-typescript")], 1).passed, true);
  const result = evaluateCodeQLJobs([
    job("actions"), job("javascript-typescript", 1, "failure"), job("javascript-typescript", 2),
  ], 2);
  assert.equal(result.passed, true);
  assert.deepEqual(result.languages.map((language) => language.latest_attempt), [1, 2]);
});

for (const state of ["failure", "cancelled", "skipped", "timed_out", null, "in_progress"]) {
  test("CodeQL historical success cannot hide latest " + state, () => {
    const latest = job("javascript-typescript", 2, state);
    if (state === "in_progress") latest.status = "in_progress";
    const result = evaluateCodeQLJobs([job("actions"), job("javascript-typescript"), latest], 2);
    assert.equal(result.passed, false);
    assert.equal(result.languages[1].latest_attempt, 2);
  });
}

test("CodeQL rejects missing, duplicate, malformed, and future-only executions", () => {
  for (const jobs of [
    [job("actions")],
    [job("actions"), job("javascript-typescript"), job("javascript-typescript", 1, "success", 99)],
    [job("actions"), { ...job("javascript-typescript"), run_attempt: undefined }],
    [job("actions"), job("javascript-typescript", 2)],
  ]) assert.equal(evaluateCodeQLJobs(jobs, 1).passed, false);
  assert.throws(() => evaluateCodeQLJobs([], 0), /invalid_run_attempt/);
});

test("real aggregate failure logs identify the latest failed language and corrective action", async () => {
  const input = fixture({ jobs: [
    job("actions"), job("javascript-typescript"), job("javascript-typescript", 2, "failure", 52),
  ], env: { GITHUB_RUN_ATTEMPT: "2" } });
  await assert.rejects(requireCodeQL(input), /CodeQL aggregate failed/);
  assert.equal(input.records.length, 1);
  const evidence = input.records[0];
  assert.equal(evidence.event, "validation.failed");
  assert.equal(evidence.level, "ERROR");
  assert.equal(evidence.passed, false);
  assert.equal(evidence.source_sha, head);
  assert.equal(evidence.languages[1].language, "javascript-typescript");
  assert.deepEqual(evidence.languages[1].executions, [
    { job_id: 52, run_attempt: 2, status: "completed", conclusion: "failure" },
  ]);
  assert.match(evidence.corrective_action, /latest language job/);
});

test("the aggregate transport path succeeds only with complete language evidence", async () => {
  const input = fixture({ jobs: [job("actions"), job("javascript-typescript")] });
  assert.equal((await requireCodeQL(input)).passed, true);
  assert.equal(input.records[0].event, "validation.complete");
  input.github.paginate = async () => { throw Object.assign(new Error("credential-sentinel"), { status: 403 }); };
  await assert.rejects(requireCodeQL(input));
  assert.equal(input.records.at(-1).http_status, 403);
  assert.doesNotMatch(input.output, /credential-sentinel/);
});

test("secret-bearing workflow uses trusted source and no PR execution steps", async () => {
  const workflow = await readFile(new URL("../.github/workflows/ai-pr-review.yml", import.meta.url), "utf8");
  const checkouts = [...workflow.matchAll(/^\s+ref: (.+)$/gm)].map((match) => match[1].trim());
  assert.equal(checkouts.length, 2);
  assert.ok(checkouts.every((ref) => ref === "${{ github.workflow_sha }}"));
  assert.doesNotMatch(workflow, /\brun:|uses:\s+\.\//);
  assert.match(workflow, /pull-request-url:/);
  assert.match(workflow, /auto-approve: "false"/);
});

test("PR base edits subscribe all validation/review routes to main without admitting other bases", async () => {
  for (const [file, event] of [
    ["ci.yml", "pull_request"], ["codeql.yml", "pull_request"], ["ai-pr-review.yml", "pull_request_target"],
  ]) {
    const workflow = await readFile(new URL("../.github/workflows/" + file, import.meta.url), "utf8");
    const subscription = workflow.match(new RegExp("^  " + event + ":\\n((?:    .+\\n)+)", "m"))?.[1];
    assert.ok(subscription, file + " must declare its PR event");
    const list = (key) => subscription.match(new RegExp(key + ": \\[([^\\]]+)\\]"))[1]
      .split(",").map((value) => value.trim());
    const admits = (base, action) => list("branches").includes(base) && list("types").includes(action);
    for (const action of ["opened", "synchronize", "reopened", "ready_for_review", "edited"]) {
      assert.equal(admits("main", action), true, file + " must validate " + action + " on main");
    }
    assert.equal(admits("release", "edited"), false, file + " must keep its main boundary");
    assert.equal(admits("main", "closed"), false, file + " must not start work for closing a PR");
  }
});
