import { logEvent, PolicyError, safeError } from "./review-policy.mjs";

export const requiredLanguages = ["actions", "javascript-typescript"];

export function evaluateCodeQLJobs(jobs, runAttempt) {
  if (!Number.isSafeInteger(runAttempt) || runAttempt < 1) {
    throw new PolicyError("invalid_run_attempt");
  }
  const languages = requiredLanguages.map((language) => {
    const executions = jobs.filter((job) => job.name === "Analyze (" + language + ")");
    const malformed = executions.some((job) => !Number.isSafeInteger(job.run_attempt) || job.run_attempt < 1);
    const eligible = executions.filter((job) => job.run_attempt <= runAttempt);
    const latestAttempt = eligible.length ? Math.max(...eligible.map((job) => job.run_attempt)) : null;
    const latest = eligible.filter((job) => job.run_attempt === latestAttempt);
    const passed = !malformed && latest.length === 1 &&
      latest[0].status === "completed" && latest[0].conclusion === "success";
    return {
      language, expected: "one completed successful latest execution", passed,
      latest_attempt: latestAttempt, execution_count: latest.length,
      executions: latest.slice(0, 5).map(({ id, run_attempt, status, conclusion }) => ({
        job_id: id, run_attempt, status, conclusion,
      })),
      omitted_executions: Math.max(0, latest.length - 5),
      reason: malformed ? "invalid_execution_attempt" : latest.length !== 1 ? "missing_or_ambiguous_execution"
        : passed ? "success" : "latest_execution_not_successful",
    };
  });
  return { passed: languages.every((language) => language.passed), languages };
}

export async function requireCodeQL({ github, context, core, env = process.env }) {
  const started = Date.now();
  const fields = { source_sha: env.SOURCE_SHA, expected_run_attempt: Number(env.GITHUB_RUN_ATTEMPT) };
  try {
    const jobs = await github.paginate(github.rest.actions.listJobsForWorkflowRun, {
      ...context.repo, run_id: context.runId, filter: "all", per_page: 100,
    });
    const result = evaluateCodeQLJobs(jobs, fields.expected_run_attempt);
    logEvent(core, result.passed ? "validation.complete" : "validation.failed",
      result.passed ? "INFO" : "ERROR", {
        ...fields, ...result, elapsed_ms: Date.now() - started,
        corrective_action: result.passed ? null : "Inspect the named latest language job before rerunning validation.",
      }, env);
    if (!result.passed) throw new PolicyError("codeql_languages_incomplete");
    return result;
  } catch (error) {
    if (!(error instanceof PolicyError && error.message === "codeql_languages_incomplete")) {
      logEvent(core, "validation.failed", "ERROR", {
        ...fields, ...safeError(error), elapsed_ms: Date.now() - started,
        corrective_action: "Check the run identity and Actions read permission; no language result was assumed.",
      }, env);
    }
    throw new PolicyError("CodeQL aggregate failed; inspect validation.failed.");
  }
}
