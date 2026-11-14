export const trustedActor = "Z-M-Huang";
export const reviewerVersion = "v1-prerelease";
const shaPattern = /^[0-9a-f]{40}$/;
const positiveInteger = (value) => Number.isSafeInteger(value) && value > 0;

export class PolicyError extends Error {}

function requireValue(condition, reason) {
  if (!condition) throw new PolicyError(reason);
}

export function safeError(error) {
  return {
    reason: error instanceof PolicyError ? error.message : "github_api_failed",
    http_status: Number.isInteger(error?.status) ? error.status : null,
    request_id: /^[a-f0-9:]{1,80}$/i.test(error?.response?.headers?.["x-github-request-id"] ?? "")
      ? error.response.headers["x-github-request-id"] : null,
    cause_code: ["ETIMEDOUT", "ECONNRESET", "ENOTFOUND", "EAI_AGAIN", "ABORT_ERR"]
      .includes(error?.cause?.code ?? error?.code) ? (error?.cause?.code ?? error.code) : null,
  };
}

export function logEvent(core, event, level, fields, env = process.env) {
  let truncated = false;
  const message = JSON.stringify({
    schema_version: 1, event, level,
    repository: env.GITHUB_REPOSITORY,
    run_id: env.GITHUB_RUN_ID,
    run_attempt: env.GITHUB_RUN_ATTEMPT,
    workflow_sha: env.GITHUB_WORKFLOW_SHA,
    retention_days: env.GITHUB_RETENTION_DAYS,
    reviewer_version: reviewerVersion, model: "auto", effort: "high",
    ...fields,
  }, (_key, value) => {
    if (typeof value !== "string" || value.length <= 512) return value;
    truncated = true;
    return value.slice(0, 512) + "...[truncated " + (value.length - 512) + " characters]";
  });
  const record = JSON.stringify({ ...JSON.parse(message), truncated });
  const method = { INFO: "info", DEBUG: "debug", WARN: "warning", ERROR: "error" }[level];
  core[method](record);
}

function validHead(head) {
  return shaPattern.test(head?.sha ?? "") && positiveInteger(head?.repo?.id) &&
    typeof head?.ref === "string" && head.ref.length > 0 && head.ref.length <= 255;
}

function sameHead(head, expected) {
  return head.sha === expected.sha && head.ref === expected.ref && head.repo.id === expected.repo.id;
}

function statusContext(number) {
  return "AI PR review / PR #" + number;
}

export async function resolveReview({ github, context, core, env = process.env }) {
  const started = Date.now();
  const fields = {
    event_name: context.eventName, actor: context.actor,
    triggering_actor: env.TRIGGERING_ACTOR,
    repository_id: context.payload.repository?.id,
    pr_number: null, expected_head: null, observed_head: null, route: "none",
  };
  const finish = (reason, outputs = { should_run: false }) => {
    logEvent(core, "review.resolve", "INFO", {
      ...fields, reason, ...outputs, elapsed_ms: Date.now() - started,
    }, env);
    return outputs;
  };
  try {
    requireValue(positiveInteger(fields.repository_id), "invalid_repository_id");
    let number;
    let expected;
    let run;
    if (context.eventName === "pull_request_target") {
      const pull = context.payload.pull_request;
      requireValue(positiveInteger(pull?.number) && validHead(pull.head), "invalid_event_pull_request");
      number = pull.number;
      expected = pull.head;
      Object.assign(fields, { pr_number: number, expected_head: expected.sha,
        head_ref: expected.ref, head_repository_id: expected.repo.id });
      if (pull.user?.login !== trustedActor || context.actor !== trustedActor ||
          env.TRIGGERING_ACTOR !== trustedActor || pull.head.repo.id !== fields.repository_id ||
          pull.base?.repo?.id !== fields.repository_id) {
        fields.route = "codeql";
        return finish("requires_codeql_completion");
      }
      fields.route = "direct";
    } else if (context.eventName === "workflow_run") {
      const trigger = context.payload.workflow_run;
      if (trigger?.event !== "pull_request" || trigger.conclusion !== "success") {
        return finish("codeql_not_successful_pull_request");
      }
      requireValue(positiveInteger(trigger.id), "invalid_codeql_run_id");
      const { data: workflow } = await github.rest.actions.getWorkflow({
        ...context.repo, workflow_id: "codeql.yml",
      });
      const { data: observedRun } = await github.rest.actions.getWorkflowRun({
        ...context.repo, run_id: trigger.id,
      });
      requireValue(workflow.path === ".github/workflows/codeql.yml" &&
        trigger.workflow_id === workflow.id && observedRun.workflow_id === workflow.id &&
        observedRun.repository?.id === fields.repository_id, "untrusted_codeql_workflow");
      run = observedRun;
      fields.codeql_run_id = run.id;
      fields.codeql_run_attempt = run.run_attempt;
      requireValue(run.id === trigger.id && run.head_sha === trigger.head_sha &&
        run.head_branch === trigger.head_branch && run.head_repository?.id === trigger.head_repository?.id,
      "codeql_run_identity_changed");
      if (run.status !== "completed" || run.event !== "pull_request" || run.conclusion !== "success" ||
          run.run_attempt !== trigger.run_attempt) return finish("codeql_run_changed");
      expected = { sha: run.head_sha, ref: run.head_branch, repo: run.head_repository };
      requireValue(validHead(expected), "invalid_codeql_head");
      Object.assign(fields, { expected_head: expected.sha, head_ref: expected.ref,
        head_repository_id: expected.repo.id, route: "codeql" });
      const pulls = await github.paginate(github.rest.pulls.list, {
        ...context.repo, state: "open", base: "main", per_page: 100,
      });
      const matches = pulls.filter((pull) => validHead(pull.head) && sameHead(pull.head, expected));
      fields.match_count = matches.length;
      if (matches.length === 0) return finish("no_current_pull_request");
      requireValue(matches.length === 1, "ambiguous_pull_request");
      number = matches[0].number;
    } else if (context.eventName === "workflow_dispatch") {
      requireValue(env.GITHUB_REF === "refs/heads/main" && context.actor === trustedActor &&
        env.TRIGGERING_ACTOR === trustedActor, "untrusted_manual_dispatch");
      const rawNumber = context.payload.inputs?.["pull-request-number"];
      requireValue(typeof rawNumber === "string" && /^[1-9][0-9]*$/.test(rawNumber),
        "invalid_pull_request_number");
      number = Number(rawNumber);
      fields.route = "manual";
    } else {
      throw new PolicyError("unsupported_event");
    }
    requireValue(positiveInteger(number), "invalid_pull_request_number");
    fields.pr_number = number;
    const { data: pull } = await github.rest.pulls.get({ ...context.repo, pull_number: number });
    requireValue(pull.number === number && pull.base?.repo?.id === fields.repository_id,
      "pull_request_repository_mismatch");
    requireValue(validHead(pull.head), "invalid_live_head");
    fields.observed_head = pull.head.sha;
    if (pull.state !== "open" || pull.draft || pull.base.ref !== "main") {
      return finish("pull_request_not_eligible");
    }
    if (expected && !sameHead(pull.head, expected)) return finish("head_identity_changed");
    if (run && pull.user?.login === trustedActor && pull.head.repo.id === fields.repository_id &&
        run.actor?.login === trustedActor && run.triggering_actor?.login === trustedActor) {
      return finish("uses_direct_review_route");
    }
    fields.expected_head = pull.head.sha;
    const reviewContext = statusContext(number);
    if (context.eventName !== "workflow_dispatch") {
      const statuses = await github.paginate(github.rest.repos.listCommitStatusesForRef, {
        ...context.repo, ref: pull.head.sha, per_page: 100,
      });
      const latest = statuses.filter((status) => status.context === reviewContext)
        .sort((left, right) => right.id - left.id)[0];
      if (latest && ["pending", "success"].includes(latest.state)) {
        fields.existing_state = latest.state;
        return finish("review_already_started");
      }
    }
    return finish("review_selected", {
      should_run: true, pr_number: String(number), head_sha: pull.head.sha,
      head_ref: pull.head.ref, head_repository_id: String(pull.head.repo.id),
      review_status_context: reviewContext, route: fields.route,
    });
  } catch (error) {
    logEvent(core, "review.resolve", "ERROR", {
      ...fields, ...safeError(error), elapsed_ms: Date.now() - started,
      corrective_action: "Check the event identity and GitHub API permissions before retrying.",
    }, env);
    throw new PolicyError("Review resolution failed; inspect review.resolve.");
  }
}

export async function publishReviewStatus({ github, context, core, phase, env = process.env }) {
  const started = Date.now();
  const number = Number(env.PR_NUMBER);
  const fields = {
    pr_number: number, expected_head: env.HEAD_SHA, observed_head: null,
    repository_id: context.payload.repository?.id,
    head_ref: env.HEAD_REF, head_repository_id: Number(env.HEAD_REPOSITORY_ID),
    route: env.REVIEW_ROUTE, reviewer_outcome: env.REVIEW_OUTCOME || "missing",
    status_context: statusContext(number), published_state: "withheld",
  };
  const event = phase === "pending" ? "review.start" : "review.complete";
  try {
    requireValue(["pending", "complete"].includes(phase), "invalid_publication_phase");
    requireValue(positiveInteger(fields.repository_id) && positiveInteger(number) &&
      shaPattern.test(env.HEAD_SHA ?? "") &&
      positiveInteger(fields.head_repository_id), "invalid_review_identity");
    const { data: pull } = await github.rest.pulls.get({ ...context.repo, pull_number: number });
    fields.observed_head = pull.head?.sha;
    requireValue(pull.number === number && pull.base?.repo?.id === context.payload.repository?.id &&
      pull.state === "open" && !pull.draft && pull.base.ref === "main", "pull_request_not_eligible");
    requireValue(validHead(pull.head) && pull.head.sha === env.HEAD_SHA &&
      pull.head.ref === env.HEAD_REF && pull.head.repo.id === fields.head_repository_id,
    "head_identity_changed");
    const state = phase === "pending" ? "pending" : env.REVIEW_OUTCOME === "success" ? "success" : "error";
    await github.rest.repos.createCommitStatus({
      ...context.repo, sha: env.HEAD_SHA, state, context: fields.status_context,
      description: state === "pending" ? "AI pull request review is running."
        : state === "success" ? "AI pull request review completed."
          : "AI review incomplete. Inspect reviewer logs; execution limit: 50 minutes.",
      target_url: context.serverUrl + "/" + context.repo.owner + "/" + context.repo.repo +
        "/actions/runs/" + context.runId,
    });
    fields.published_state = state;
    logEvent(core, event, state === "error" ? "ERROR" : "INFO", {
      ...fields, elapsed_ms: Date.now() - started,
      corrective_action: state === "error" ? "Inspect reviewer diagnostics and recover from trusted main." : null,
    }, env);
    return state;
  } catch (error) {
    logEvent(core, event, "ERROR", {
      ...fields, ...safeError(error), elapsed_ms: Date.now() - started,
      corrective_action: "Use the current PR head; inspect permissions if publication failed.",
    }, env);
    throw new PolicyError("Review status withheld; inspect " + event + ".");
  }
}
