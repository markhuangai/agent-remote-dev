import { readFile, realpath, writeFile } from "node:fs/promises";
import { join, sep } from "node:path";
import { Job } from "./setup.js";
import { TaskGit } from "./git.js";
import { command } from "./process.js";
import { Diagnostics } from "./diagnostics.js";
import { hash, object, parseJson, requireValue, RunnerError, shaPattern, ValidationPolicy } from "./contracts.js";

function aggregateCoverage(body: string, profiles: number) {
  const header = "| File | Lines read | Total changes | Coverage | Reviewers read | Total reviewer profiles |";
  const start = body.indexOf(header);
  if (start < 0) return false;
  const lines = body.slice(start).split(/\r?\n/);
  const end = lines.findIndex((line) => !line.trim().startsWith("|"));
  const rows = lines.slice(2, end < 0 ? lines.length : end).map((line) => line.split("|").slice(1, -1).map((cell) => cell.replaceAll("**", "").trim()));
  const files = rows.filter((row) => row[0]?.startsWith("<code>")), totals = rows.filter((row) => row[0] === "Total");
  const number = (value: string) => /^[0-9,]+$/.test(value) ? Number(value.replaceAll(",", "")) : NaN;
  if (!files.length || totals.length !== 1 || rows.length !== files.length + 1) return false;
  if (!files.every((row) => row.length === 6 && Number.isSafeInteger(number(row[1])) && number(row[1]) >= 0 &&
      number(row[1]) === number(row[2]) && row[3] === "100%" && number(row[4]) === profiles && number(row[5]) === profiles)) return false;
  const total = totals[0];
  return total.length === 6 && total[3] === "100%" && number(total[5]) === profiles &&
    number(total[1]) === files.reduce((sum, row) => sum + number(row[1]), 0) &&
    number(total[2]) === files.reduce((sum, row) => sum + number(row[2]), 0);
}

export function reviewSurfaces(state: any) {
  const surfaces: { surface_kind: string; id: string; body_sha256: string; thread?: any }[] = [];
  for (const [kind, records] of [["review", state.reviews ?? []], ["comment", state.conversation_comments ?? []]] as const) {
    for (const record of records) if (typeof record.body === "string" && record.body.trim()) {
      requireValue(typeof record.id === "string", "review_surface_identity_missing", "delivery");
      surfaces.push({ surface_kind: kind, id: record.id, body_sha256: hash(record.body) });
    }
  }
  for (const thread of state.review_threads ?? []) {
    requireValue(typeof thread.id === "string" && Array.isArray(thread.comments), "review_surface_identity_missing", "delivery");
    surfaces.push({ surface_kind: "thread", id: thread.id, body_sha256: hash(JSON.stringify(thread.comments.map((comment: any) => ({ id: comment.id, body: comment.body })))), thread });
  }
  return surfaces;
}
export function verifyDispositions(state: any, dispositions: any) {
  requireValue(Array.isArray(dispositions), "missing_disposition_ledger", "delivery");
  const surfaces = reviewSurfaces(state);
  if (dispositions.length !== surfaces.length) throw new RunnerError("review_surface_coverage_mismatch", "delivery", "Fetched review surfaces are missing disposition evidence.",
    { expected_surface_count: surfaces.length, disposition_count: dispositions.length, surface_ids: surfaces.slice(0, 10).map((surface) => surface.id), omitted_surfaces: Math.max(0, surfaces.length - 10) });
  for (const surface of surfaces) {
    const entries = dispositions.filter((entry: any) => entry.surface_kind === surface.surface_kind && entry.id === surface.id);
    if (entries.length !== 1 || entries[0].body_sha256 !== surface.body_sha256) throw new RunnerError("unhandled_review_surface", "delivery", "Review evidence is missing or stale.",
      { surface_kind: surface.surface_kind, surface_id: surface.id, expected_body_sha256: surface.body_sha256 });
    const entry = entries[0];
    requireValue(["fixed", "non_blocking", "not_actionable", "not_finding"].includes(entry.decision) && typeof entry.reason === "string" && entry.reason.trim(), "invalid_finding_disposition", "delivery");
    requireValue(entry.decision === "fixed" ? typeof entry.fix_sha === "string" && shaPattern.test(entry.fix_sha) : entry.fix_sha === null, "invalid_fix_evidence", "delivery");
    if (surface.thread && !surface.thread.isResolved) {
      const author = surface.thread.comments[0]?.author?.login;
      requireValue(entry.decision === "fixed" && ["coderabbitai", "coderabbitai[bot]"].includes(author), "unresolved_review_thread", "delivery");
    }
  }
}

export async function readJobReceipt(job: Job, path: string) {
  const actual = await realpath(path);
  requireValue(actual.startsWith(job.root + sep), "receipt_outside_job", "delivery");
  return parseJson(await readFile(actual, "utf8"), "delivery_receipt");
}
export function verifyTerminal(value: any, head: string, policy: ValidationPolicy) {
  requireValue(object(value) && value.gate === "terminal" && value.head_sha === head && value.phase === "full" &&
    value.all_checks_nonblocking === true && value.required_reviewers_satisfied === true &&
    Array.isArray(value.required_check_problems) && value.required_check_problems.length === 0 &&
    Array.isArray(value.required_reviewer_problems) && value.required_reviewer_problems.length === 0 &&
    JSON.stringify(value.required_checks) === JSON.stringify(policy.checks) &&
    JSON.stringify(value.required_reviewers) === JSON.stringify(policy.reviewers), "delivery_gate_incomplete", "delivery");
}
export function verifyReviewState(state: any, head: string, policy: ValidationPolicy, dispositions: unknown) {
  if (state?.pull_request?.head_sha !== head || state.codex_thread_actions?.incomplete !== 0 || state.ai_pr_reviewer_thread_actions?.incomplete !== 0) {
    throw new RunnerError("unfinished_review_dispositions", "delivery", "Review state is stale or has unfinished inline dispositions.", { expected_sha: head, observed_sha: state?.pull_request?.head_sha,
      codex_incomplete: state.codex_thread_actions?.incomplete, marked_review_incomplete: state.ai_pr_reviewer_thread_actions?.incomplete });
  }
  const marked = new Map<string, string>();
  for (const review of state.reviews ?? []) {
    const marker = typeof review.body === "string" ? review.body.match(/^<!-- ai-pr-reviewer:v3:([a-f0-9]{40}):([a-f0-9]{64}) -->/) : null;
    if (marker?.[1] === head && review.commit?.oid === head) marked.set(marker[2], review.body);
  }
  if (marked.size < policy.marked_review_count && ![...marked.values()].some((body) => aggregateCoverage(body, policy.marked_review_count))) throw new RunnerError("incomplete_ai_review_coverage", "delivery", "Current-head AI review coverage is incomplete.",
    { expected_sha: head, expected_review_count: policy.marked_review_count, observed_review_count: marked.size });
  verifyDispositions(state, dispositions);
}
export async function verifyDelivery(input: { job: Job; git: TaskGit; log: Diagnostics; repository: string; login: string;
  baseBranch: string; url: string; receiptPath: string; policy: ValidationPolicy; timeoutMs: number; issueNumber?: string | null }) {
  const { job, git, log, repository, login, baseBranch, policy } = input;
  const prefix = `https://github.com/${repository}/pull/`;
  requireValue(input.url.startsWith(prefix) && /^[1-9][0-9]*$/.test(input.url.slice(prefix.length)), "invalid_pr_url", "delivery");
  const number = input.url.slice(prefix.length), head = await git.head();
  const api = () => command("gh", ["api", `repos/${repository}/pulls/${number}`], { cwd: git.cwd, env: job.env, stage: "delivery_pr", log });
  const checkPull = (pull: any) => requireValue(pull.state === "open" && pull.draft === false && pull.user?.login === login &&
    pull.head?.sha === head && pull.head?.ref === git.branch && pull.head?.repo?.full_name === repository &&
    pull.base?.ref === baseBranch && pull.base?.repo?.full_name === repository &&
    (!input.issueNumber || (typeof pull.body === "string" && pull.body.split(/\r?\n/).some((line: string) =>
      /^(?:close[sd]?|fix(?:es|ed)?|resolve[sd]?)\s+#([1-9][0-9]*)$/i.exec(line.trim())?.[1] === input.issueNumber))), "pr_identity_mismatch", "delivery");
  checkPull(parseJson(await api(), "delivery_pr"));
  const receipt = await readJobReceipt(job, input.receiptPath);
  requireValue(receipt.state === "automation_clean" && object(receipt.terminal_receipt), "missing_review_loop_receipt", "delivery");
  verifyTerminal(receipt.terminal_receipt, head, policy);
  const terminalPath = join(job.root, "terminal-verification.json");
  await writeFile(terminalPath, JSON.stringify(receipt.terminal_receipt), { mode: 0o600 });
  const scripts = join(job.codexHome, "skills/pr-review-loop/scripts");
  const flags = ["--repo", repository, "--pr", number, ...policy.checks.flatMap((name) => ["--require-check", name]),
    ...policy.reviewers.flatMap((name) => ["--require-reviewer", name])];
  const current = parseJson(await command("python3", [join(scripts, "wait_for_pr_state.py"), ...flags, "--verify-receipt", terminalPath],
    { cwd: git.cwd, env: job.env, stage: "delivery_gate", log, timeoutMs: input.timeoutMs }), "delivery_gate");
  verifyTerminal(current, head, policy);
  const state = parseJson(await command("python3", [join(scripts, "fetch_pr_review_state.py"), "--repo", repository, "--pr", number,
    ...policy.reviewers.flatMap((name) => ["--reviewer", name])], { cwd: git.cwd, env: job.env, stage: "delivery_review_state", log, timeoutMs: input.timeoutMs }), "delivery_review_state");
  verifyReviewState(state, head, policy, receipt.dispositions);
  for (const fix of new Set<string>(receipt.dispositions.filter((entry: any) => entry.decision === "fixed").map((entry: any) => entry.fix_sha))) {
    await git.run(["merge-base", "--is-ancestor", fix, head]);
  }
  checkPull(parseJson(await api(), "delivery_pr"));
  await git.verify(head);
  const finalGate = parseJson(await command("python3", [join(scripts, "wait_for_pr_state.py"), ...flags, "--verify-receipt", terminalPath],
    { cwd: git.cwd, env: job.env, stage: "delivery_gate", log, timeoutMs: input.timeoutMs }), "delivery_gate");
  verifyTerminal(finalGate, head, policy);
  log.event("runtime.delivery", "INFO", { outcome: "automation_clean", pr_number: number, expected_sha: head, observed_sha: head });
  return { terminal_receipt: finalGate, dispositions: receipt.dispositions };
}
