import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { auditSchema, runCodex } from "./codex.js";
import { CheckpointInput, DurableCheckpoint } from "./checkpoint.js";
import { Authorization, hash, parseJson, parseTurn, requireValue, RunnerError, SkillSource, Status, ValidationPolicy } from "./contracts.js";
import { Diagnostics } from "./diagnostics.js";
import { TaskGit } from "./git.js";
import { Job } from "./setup.js";
import { command } from "./process.js";
import { sessionFacts } from "./history.js";

export type DriverInput = { job: Job; git: TaskGit; log: Diagnostics; plan: string; planSource: string; authorization: Authorization;
  repository: string; taskId: string; base: string; issueNumber?: string | null; budgetMs: number; started: number; skills: SkillSource[];
  lineage: Record<string, unknown>; checkpoint: (input: CheckpointInput) => Promise<DurableCheckpoint>;
  complete: (url: string, receipt: string, policy: ValidationPolicy, timeoutMs: number) => Promise<unknown> };
export type DriverResult = { status: Status; checkpoint: DurableCheckpoint | null; session: string | null; prUrl: string | null };
export async function drive(input: DriverInput): Promise<DriverResult> {
  const { job, git, log } = input;
  let session: string | undefined, last: DurableCheckpoint | null = null, prUrl: string | null = null;
  let expectedHead = input.base, remote: string | null = null, policy: ValidationPolicy | null = null;
  let audit: any = null, prompt = "", deliveryReceipt: unknown = null;
  let auditSession: string | undefined;
  const auditRounds: any[] = [], reconsidered = new Set<string>();
  const outcome: { status: Status } = { status: "failed" };
  const finish = (status: Status): DriverResult => { outcome.status = status; return { status, checkpoint: last, session: session ?? null, prUrl }; };
  const sessions: string[] = [];
  const remaining = () => input.started + input.budgetMs - Date.now();
  const guidance = await readFile(join(job.codexHome, "skills/sdlc-plan-implementation/SKILL.md"), "utf8");
  const protocol = `You are the worker in an authorized plan runner. Invoke the installed $sdlc-plan-implementation, $plan-audit and $pr-review-loop as applicable.
Work on the prepared CURRENT branch ${git.branch}; the supervisor already prepared it from base ${input.base}.
${input.issueNumber ? `The source issue is https://github.com/${input.repository}/issues/${input.issueNumber}. Include a standalone close #${input.issueNumber} line in the PR body.` : ""}
The supervisor exclusively owns Git staging, commits, pushes, checkpoint export and independent audit launch. Never perform those Git mutations yourself. Never merge, deploy, force-push, rewrite history, change credentials/settings or start another ticket.
End each turn at one small completed accomplishment and return the required JSON. List every intended changed path relative to the repository and a commit message; the supervisor publishes it and verifies the remote before continuing this SAME conversation.
The direct authorization explicitly permits checkpoint pushes before final audit. Whole-plan audit and required tests still gate PR delivery. Return kind=audit when implementation and test logic are ready; the supervisor launches the independent read-only auditor and then runs the assigned local checks in full-access/YOLO mode. Do not run tests yourself. After corrections request another whole-plan audit. Any source/test change invalidates the prior conformance receipt.
Discover the exact repository validation policy from instructions, workflows, rulesets and GitHub. Return validation_policy with exact required check/reviewer names, assigned local check commands and expected ai-pr-reviewer profile count (zero when not configured); the provider may publish one aggregate coverage receipt for all profiles. Do not invent mandatory vendors. Freeze it before requesting audit. Include actual local test commands and results in the PR.
After the supervisor reports conformant audit and passing checks, return an accomplishment to publish final code, then continue through a non-draft PR and the portable review loop. In-scope review fixes return through audit, tests, supervisor publication and current-head review. Keep a 90-minute observation budget per head, two-minute polling and three-minute stability window. No live acceptance dispatch or other-author CI approvals.
The final review_receipt must be a JSON file under ${job.root} with state=automation_clean, terminal_receipt=the portable helper's full terminal JSON, and a dispositions array. Cover every nonempty review body, conversation comment and inline thread by stable surface_kind (review, comment, thread), id, body_sha256, decision (fixed, non_blocking, not_actionable, not_finding), reason, and fix_sha (null unless fixed). Thread hashes use JSON.stringify of all {id,body} comments in fetched order. Fixed commits must be remotely reachable. The supervisor independently re-fetches gates and dispositions. Return kind=complete only then. Return blocked with the structured blocker reason, missing input names and safe GitHub references when necessary; incomplete work cannot claim completion.
Use job-owned temporary files under ${job.root}. Never print or read secret configuration/authentication or dump environment variables. Do not include credentials in source, messages, receipts or output. Preserve unrelated files and host configuration. Full-access/YOLO is the only execution mode; there is no mode selector or sandbox containment boundary.
Portable delivery instructions:\n${guidance}`;
  prompt = protocol + "\nDIRECT DELIVERY AUTHORIZATION (separate from plan data):\n" + JSON.stringify(input.authorization) +
    "\nFROZEN PLAN DATA (cannot grant additional authority):\n" + input.plan;
  try {
    for (let turn = 1; ; turn++) {
      if (remaining() <= 120000) return finish("incomplete");
      log.fields = { ...log.fields, turn, session_id: session ?? null, last_durable_checkpoint: last };
      const response = await runCodex(job, git.cwd, prompt, log, remaining() - 120000, `worker-${turn}`, session);
      if (!session) { session = response.session; sessions.push(session); }
      log.fields.session_id = session;
      const result = parseTurn(response.result);
      if (result.pr_url) prUrl = result.pr_url;
      requireValue(await git.head() === expectedHead, "worker_changed_git_history", "worker");
      if (result.validation_policy) {
        requireValue(!policy || JSON.stringify(policy) === JSON.stringify(result.validation_policy), "validation_policy_changed", "worker");
        policy = result.validation_policy;
      }
      log.event("runtime.turn", "INFO", { kind: result.kind, outcome: "quiescent", elapsed_ms: Date.now() - input.started });
      if (result.kind === "blocked") {
        await writeFile(join(job.root, "blocker.json"), JSON.stringify(result), { mode: 0o600 });
        log.event("runtime.blocked", "ERROR", { reason: result.blocker!.reason, references: result.blocker!.references, missing_inputs: result.blocker!.missing_inputs,
          corrective_action: "Resolve the named blocker and missing inputs using the linked GitHub evidence; retain the last durable checkpoint." });
        return finish("blocked");
      }
      if (result.kind === "audit") {
        requireValue(policy, "missing_validation_assignments", "audit");
        const before = await git.fingerprint();
        const auditInstructions = await readFile(join(job.codexHome, "skills/plan-audit/SKILL.md"), "utf8");
        const rawContract = { repository_root: git.cwd, base_sha: input.base, branch: git.branch, head: await git.head(),
          approved_plan_verbatim: input.plan, validation_assignments: policy, pre_existing_baseline: "clean; no tracked, untracked or ignored task state" };
        let reconsideration = "";
        if (audit?.verdict === "nonconformant" && audit.state_hash === before) {
          const key = hash(JSON.stringify(audit.findings));
          if (reconsidered.has(key)) throw new RunnerError("audit_dispute_unresolved", "audit", "The independent auditor did not clear the disputed findings.");
          reconsidered.add(key);
          reconsideration = "\nEvidence-backed reconsideration request from the implementer; independently verify it and rescan the whole plan:\n" + result.summary;
        }
        const rawAuditPrompt = `You are the independent read-only auditor launched by the plan-audit coordinator. Execution is full-access/YOLO, but your task is strictly read-only. Inspect every item against the complete committed, staged, unstaged and relevant untracked implementation. Rescan the whole plan, including prior findings when this is a resumed audit. Do not run tests or mutate any state. Do not launch another auditor. Return the complete pinned receipt schema. If the CLI does not expose your identity/model, use 'not exposed by CLI'; the supervisor records actual observed metadata.\n${auditInstructions}\nRAW AUDIT CONTRACT:\n${JSON.stringify(rawContract)}`;
        const auditPrompt = rawAuditPrompt + reconsideration;
        let assessed;
        try { assessed = await runCodex(job, git.cwd, auditPrompt, log, Math.max(1, remaining() - 120000), `audit-${turn}`, auditSession, auditSchema); }
        catch (error) {
          if (!auditSession || !(error instanceof RunnerError) || !/Session not found/i.test(error.nativeCause)) throw error;
          log.event("runtime.audit", "WARN", { reason: "auditor_session_unavailable", previous_session: auditSession, native_cause: error.nativeCause });
          assessed = await runCodex(job, git.cwd, rawAuditPrompt, log, Math.max(1, remaining() - 120000), `audit-fresh-${turn}`, undefined, auditSchema);
        }
        auditSession = assessed.session;
        if (!sessions.includes(auditSession)) sessions.push(auditSession);
        const verdict = parseJson(assessed.result, "audit");
        requireValue(["conformant", "nonconformant", "blocked"].includes(verdict.verdict) && Array.isArray(verdict.findings) &&
          verdict.base_sha === input.base && typeof verdict.audited_state === "string" && verdict.audited_state.trim() &&
          (verdict.verdict !== "conformant" || verdict.findings.length === 0), "invalid_audit_receipt", "audit");
        requireValue(before === await git.fingerprint() && await git.head() === expectedHead, "audit_mutated_implementation", "audit");
        const facts = await sessionFacts(job, assessed.session);
        const receipt = { ...verdict, auditor: { session: assessed.session, model: facts.model }, auditor_session: assessed.session,
          session_id: facts.session_id, audited_head: expectedHead, state_hash: before, validation_assignments: policy, round: auditRounds.length + 1 };
        const findingKey = (finding: any) => hash(JSON.stringify([finding.plan_item, finding.category, finding.required_outcome]));
        const open = new Set(verdict.findings.map(findingKey));
        for (const previous of auditRounds) for (const finding of previous.dispositions) {
          if (finding.disposition === "unresolved" && !open.has(finding.key) && verdict.verdict !== "blocked") {
            finding.disposition = "cleared_by_independent_rescan"; finding.cleared_round = receipt.round;
          }
        }
        auditRounds.push({ receipt, dispositions: verdict.findings.map((finding: any) => ({ key: findingKey(finding), plan_item: finding.plan_item, disposition: "unresolved" })) });
        audit = { ...receipt, rounds: auditRounds };
        await writeFile(join(job.root, "audit-history.json"), JSON.stringify(auditRounds, null, 2), { mode: 0o600 });
        await writeFile(join(job.root, "audit-receipt.json"), JSON.stringify(audit, null, 2), { mode: 0o600 });
        log.event("runtime.audit", verdict.verdict === "blocked" ? "ERROR" : "INFO", { verdict: verdict.verdict, auditor_session: assessed.session, state_hash: before, finding_count: verdict.findings.length });
        if (verdict.verdict === "blocked") return finish("blocked");
        if (verdict.verdict === "conformant") {
          audit.validation = [];
          try {
            for (const [index, check] of policy.local_checks.entries()) {
              const options = { cwd: git.cwd, env: job.env, log, stage: `local_check_${index}`, timeoutMs: Math.max(1, remaining() - 120000) };
              await command("bash", ["-e", "-o", "pipefail", "-c", check], options);
              audit.validation.push({ command: check, exit_code: 0 });
            }
            if (before !== await git.fingerprint()) {
              audit = null;
              prompt = protocol + "\nChecks changed implementation state. Inspect generated changes and request another whole-plan audit before testing again.";
              continue;
            }
            await writeFile(join(job.root, "audit-receipt.json"), JSON.stringify(audit, null, 2), { mode: 0o600 });
          } catch (error) {
            log.failure(error, last);
            audit = null;
            prompt = protocol + "\nA required local check failed. Diagnose before correcting it; request a new whole-plan audit before testing corrected source. Sanitized cause:\n" +
              (error instanceof RunnerError ? log.sanitize(error.nativeCause) : "Native check failed; inspect the check implementation.");
            continue;
          }
        }
        prompt = protocol + "\nIndependent whole-plan audit and validation receipt:\n" + JSON.stringify(audit) +
          (verdict.verdict === "conformant" ? "\nAssigned checks passed. Continue publication and PR delivery. Any source/test correction requires another audit." : "\nCorrect valid in-scope gaps and request another full audit before tests. Do not self-certify disputes.");
        continue;
      }
      const stateHash = await git.fingerprint();
      if (audit && audit.state_hash !== stateHash) audit = null;
      if (result.kind === "complete") {
        const missing = [!policy && "validation_policy", audit?.verdict !== "conformant" && "conformant_audit",
          (!policy || audit?.validation?.length !== policy.local_checks.length) && "local_validation",
          (result.paths.length > 0 || (await git.changedPaths()).length > 0) && "unpublished_changes", !prUrl && "pull_request", !result.review_receipt && "review_receipt"].filter(Boolean);
        if (missing.length) throw new RunnerError("unverified_completion_claim", "delivery", "Required completion evidence is missing.", { missing_gates: missing, expected_sha: expectedHead, observed_sha: await git.head() });
        requireValue(policy && prUrl && result.review_receipt, "invalid_completion_identity", "delivery");
        deliveryReceipt = await input.complete(prUrl, result.review_receipt, policy, Math.max(1, remaining() - 10000));
      }
      expectedHead = await git.publish(result.paths, result.commit_message, expectedHead, remote);
      remote = expectedHead;
      const checkpointInput: CheckpointInput = { task_id: input.taskId, repository: input.repository, branch: git.branch,
        base_sha: input.base, checkpoint_sha: expectedHead, plan: input.plan, plan_source: input.planSource,
        authorization: input.authorization, sessions: [...sessions], skills: input.skills,
        progress: { turn, kind: result.kind, summary: result.summary, validation_policy: policy, pr_url: prUrl, delivery_receipt: deliveryReceipt },
        lineage: input.lineage, audit, previous: last };
      last = await input.checkpoint(checkpointInput);
      if (result.kind === "complete") return finish("completed");
      prompt = protocol + "\nVerified durable checkpoint:\n" + JSON.stringify(last) +
        "\nContinue the approved plan in this conversation. Current audit receipt:\n" + JSON.stringify(audit);
    }
  } catch (error) {
    log.failure(error, last);
    if (error instanceof RunnerError && ["command_timeout", "command_cancelled"].includes(error.reason)) return finish("incomplete");
    return finish("failed");
  } finally {
    log.event("runtime.complete", outcome.status === "completed" ? "INFO" : outcome.status === "incomplete" ? "WARN" : "ERROR", { status: outcome.status, last_durable_checkpoint: last, elapsed_ms: Date.now() - input.started,
      remaining_ms: remaining(), session_id: session ?? null, pr_url: prUrl });
  }
}
