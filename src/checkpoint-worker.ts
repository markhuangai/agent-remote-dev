import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { durableCheckpoint, CheckpointInput, DurableCheckpoint } from "./checkpoint.js";
import { Diagnostics } from "./diagnostics.js";
import { RunnerError, requireValue, versions } from "./contracts.js";
import { TaskGit } from "./git.js";
import { command } from "./process.js";
import { Job } from "./setup.js";
import { recordName } from "./platform/checkpoint-policy.mjs";

export async function checkpointWorker(requestPath: string) {
  const request = JSON.parse(await readFile(requestPath, "utf8"));
  const emit = (line: string | Error) => { process.stdout.write(String(line) + "\n"); };
  const log = new Diagnostics(request.fields, { info: emit, warning: emit, error: emit, debug: emit });
  for (const secret of request.secrets) log.protect(secret);
  try {
    const artifactRoot = join(request.job.tools, "node_modules", "@actions", "artifact");
    const metadata = JSON.parse(await readFile(join(artifactRoot, "package.json"), "utf8"));
    requireValue(metadata.name === "@actions/artifact" && metadata.version === versions.artifact_sdk, "artifact_sdk_version_mismatch", "checkpoint");
    const { DefaultArtifactClient } = await import(/* webpackIgnore: true */ pathToFileURL(join(artifactRoot, "lib", "artifact.js")).href);
    const artifacts = new DefaultArtifactClient();
    if (request.kind === "record") {
      const receipt = await artifacts.uploadArtifact(request.name, [request.file], request.root);
      requireValue(Number.isSafeInteger(receipt.id) && receipt.id > 0, "missing_artifact_receipt", "continuation");
      await writeFile(request.resultPath, JSON.stringify({ artifact_id: receipt.id }), { mode: 0o600 });
      return;
    }
    const git = new TaskGit(request.cwd, request.job.env, log, request.input.branch);
    const receipt = await durableCheckpoint(request.job, request.input, log, (sha) => git.verify(sha),
      (name, files, root) => artifacts.uploadArtifact(name, files, root));
    await writeFile(request.resultPath, JSON.stringify(receipt), { mode: 0o600 });
  } catch (error) { log.failure(error, request.input?.previous ?? null); process.exitCode = 1; }
}
export async function isolatedRecord(job: Job, kind: "run" | "outcome" | "result", value: any, log: Diagnostics,
  environment: NodeJS.ProcessEnv = process.env, entry = process.argv[1]) {
  const name = recordName(kind, value.task_id, String(value.lineage.run_id), String(value.lineage.run_attempt));
  const root = join(job.exports, name), file = join(root, "record.json"), resultPath = join(job.root, `${kind}-receipt.json`);
  const inspect = (data: unknown): void => {
    if (typeof data === "string") {
      for (const secret of log.protectedValues) requireValue(!data.includes(secret), "credential_in_manifest", "continuation");
      if (/^[\s]*[\[{"]/.test(data)) {
        let decoded: unknown;
        try { decoded = JSON.parse(data); } catch { return; }
        inspect(decoded);
      }
    } else if (data && typeof data === "object") for (const [key, child] of Object.entries(data)) { inspect(key); inspect(child); }
  };
  inspect(value);
  const encoded = JSON.stringify(value);
  requireValue(Buffer.byteLength(encoded) <= 2 * 1024 * 1024, "continuation_record_size_limit", "continuation");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(root, { mode: 0o700 });
  await writeFile(file, encoded, { mode: 0o600 });
  const requestPath = join(job.root, `${kind}-request.json`);
  await writeFile(requestPath, JSON.stringify({ kind: "record", job, name, file, root, resultPath, fields: log.fields, secrets: log.protectedValues }), { mode: 0o600 });
  await command(process.execPath, [entry, "--checkpoint-worker", requestPath], { cwd: job.root,
    env: { ...environment, CODEX_TASK_DEADLINE_MS: job.env.CODEX_TASK_DEADLINE_MS }, stage: "continuation_record", log, collect: false });
  const receipt = JSON.parse(await readFile(resultPath, "utf8"));
  requireValue(Number.isSafeInteger(receipt.artifact_id) && receipt.artifact_id > 0, "invalid_record_receipt", "continuation");
  log.event("continuation.record", "INFO", { kind, artifact_id: receipt.artifact_id, artifact_name: name, outcome: "durable" });
  return receipt;
}
export async function isolatedCheckpoint(job: Job, cwd: string, input: CheckpointInput, log: Diagnostics, verify: (sha: string) => Promise<void>,
  environment: NodeJS.ProcessEnv = process.env, entry = process.argv[1]): Promise<DurableCheckpoint> {
  const sequence = (input.previous?.sequence ?? 0) + 1;
  const requestPath = join(job.root, `checkpoint-request-${sequence}.json`), resultPath = join(job.root, `checkpoint-result-${sequence}.json`);
  const fields = { ...log.fields, artifact_name: `codex-${input.task_id}-${sequence}`, intended_sha: input.checkpoint_sha,
    last_durable_checkpoint: input.previous };
  let verifiedSha: string | null = null;
  try {
    await verify(input.checkpoint_sha);
    verifiedSha = input.checkpoint_sha;
    await writeFile(requestPath, JSON.stringify({ job, cwd, input, fields, resultPath, secrets: log.protectedValues }), { mode: 0o600 });
    await command(process.execPath, [entry, "--checkpoint-worker", requestPath], {
      cwd, env: { ...environment, CODEX_TASK_DEADLINE_MS: job.env.CODEX_TASK_DEADLINE_MS }, stage: "checkpoint", log, context: fields, collect: false,
      timeoutMs: Math.max(1, Number(job.env.CODEX_TASK_DEADLINE_MS ?? Date.now() + 180000) - Date.now() - 11000),
      onLine(line) {
        let record;
        try { record = JSON.parse(line); } catch { return; }
        if (typeof record.event === "string" && (record.event.startsWith("checkpoint.") || record.event === "runtime.failed") && ["INFO", "WARN", "ERROR", "DEBUG"].includes(record.level)) {
          log.event(record.event, record.level, record);
        }
      },
    });
    const receipt = JSON.parse(await readFile(resultPath, "utf8"));
    requireValue(Number.isSafeInteger(receipt.artifact_id) && receipt.checkpoint_sha === input.checkpoint_sha && receipt.sequence === sequence, "invalid_checkpoint_worker_receipt", "checkpoint");
    await verify(input.checkpoint_sha);
    return receipt;
  } catch (error) {
    const timeout = error instanceof RunnerError && ["command_timeout", "command_cancelled"].includes(error.reason);
    const details = error instanceof RunnerError ? error.details : {};
    const failed = { ...fields, ...details, last_verified_sha: verifiedSha, observed_sha: details.observed_sha ?? null };
    const cause = error instanceof RunnerError ? error.nativeCause : error instanceof Error ? error.message : "Checkpoint worker did not return a verified receipt";
    log.event("checkpoint.failed", "ERROR", { ...failed, reason: timeout ? "checkpoint_interrupted" : "checkpoint_operation_failed", cause_reason: error instanceof RunnerError ? error.reason : "unexpected_failure", native_cause: cause,
      corrective_action: "Retain the previous durable artifact; inspect the checkpoint stage and deadline before retrying." });
    throw new RunnerError(timeout ? (error as RunnerError).reason : "checkpoint_operation_failed", "checkpoint", cause, failed);
  }
}
