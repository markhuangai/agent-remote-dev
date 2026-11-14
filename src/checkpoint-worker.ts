import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { durableCheckpoint, CheckpointInput, DurableCheckpoint } from "./checkpoint.js";
import { Diagnostics } from "./diagnostics.js";
import { RunnerError, requireValue, versions } from "./contracts.js";
import { TaskGit } from "./git.js";
import { command } from "./process.js";
import { Job } from "./setup.js";

export async function checkpointWorker(requestPath: string) {
  const request = JSON.parse(await readFile(requestPath, "utf8"));
  const emit = (line: string | Error) => { process.stdout.write(String(line) + "\n"); };
  const log = new Diagnostics(request.fields, { info: emit, warning: emit, error: emit, debug: emit });
  for (const secret of request.secrets) log.protect(secret);
  try {
    const git = new TaskGit(request.cwd, request.job.env, log, request.input.branch);
    const artifactRoot = join(request.job.tools, "node_modules", "@actions", "artifact");
    const metadata = JSON.parse(await readFile(join(artifactRoot, "package.json"), "utf8"));
    requireValue(metadata.name === "@actions/artifact" && metadata.version === versions.artifact_sdk, "artifact_sdk_version_mismatch", "checkpoint");
    const { DefaultArtifactClient } = await import(/* webpackIgnore: true */ pathToFileURL(join(artifactRoot, "lib", "artifact.js")).href);
    const artifacts = new DefaultArtifactClient();
    const receipt = await durableCheckpoint(request.job, request.input, log, (sha) => git.verify(sha),
      (name, files, root) => artifacts.uploadArtifact(name, files, root));
    await writeFile(request.resultPath, JSON.stringify(receipt), { mode: 0o600 });
  } catch (error) { log.failure(error, request.input.previous); process.exitCode = 1; }
}
export async function isolatedCheckpoint(job: Job, cwd: string, input: CheckpointInput, log: Diagnostics, verify: (sha: string) => Promise<void>,
  environment: NodeJS.ProcessEnv = process.env, entry = process.argv[1]): Promise<DurableCheckpoint> {
  const sequence = (input.previous?.sequence ?? 0) + 1;
  const requestPath = join(job.root, `checkpoint-request-${sequence}.json`), resultPath = join(job.root, `checkpoint-result-${sequence}.json`);
  const fields = { ...log.fields, artifact_name: `codex-${input.task_id}-${sequence}`, intended_sha: input.checkpoint_sha,
    observed_sha: input.checkpoint_sha, last_durable_checkpoint: input.previous };
  await verify(input.checkpoint_sha);
  await writeFile(requestPath, JSON.stringify({ job, cwd, input, fields, resultPath, secrets: log.protectedValues }), { mode: 0o600 });
  try {
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
    log.event("checkpoint.failed", "ERROR", { ...fields, reason: timeout ? "checkpoint_interrupted" : "checkpoint_operation_failed", native_cause: error instanceof RunnerError ? error.nativeCause : "Checkpoint worker did not return a verified receipt",
      corrective_action: "Retain the previous durable artifact; inspect the checkpoint stage and deadline before retrying." });
    throw new RunnerError(timeout ? (error as RunnerError).reason : "checkpoint_operation_failed", "checkpoint", error instanceof Error ? error.message : "Checkpoint worker failed", fields);
  }
}
