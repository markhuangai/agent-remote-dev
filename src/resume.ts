import { join } from "node:path";
import { checkpointSchema, validateManifest } from "./platform/checkpoint-policy.mjs";
import { requireValue, RunnerError, versions } from "./contracts.js";
import { Diagnostics } from "./diagnostics.js";
import { command } from "./process.js";
import type { Job } from "./setup.js";
import { runnerAdapter } from "./runners.js";
import { TaskGit } from "./git.js";

export function validateCheckpoint(value: any, repository: string, runner = value?.runner) {
  return validateManifest(value, { repository, runner, runnerVersion: runnerAdapter(runner).version });
}
export async function unpackArchive(job: Job, archive: string, destination: string, kind: "checkpoint" | "record", log: Diagnostics) {
  try { await command("python3", [join(import.meta.dirname, "platform/archive.py"), archive, destination, kind], { cwd: job.root, env: job.env, stage: "resume_archive", log }); }
  catch (error) {
    let failure: any;
    try { failure = JSON.parse(error instanceof RunnerError ? error.nativeCause : "null"); } catch {}
    const allowed = ["archive_size_limit", "archive_entry_limit", "unsafe_archive_path", "duplicate_archive_entry", "encrypted_archive", "linked_archive_entry",
      "archive_expansion_limit", "missing_archive_manifest", "invalid_archive_manifest", "unsupported_checkpoint_schema", "invalid_checkpoint_inventory",
      "invalid_checkpoint_file", "unexpected_checkpoint_file", "archive_inventory_mismatch", "checkpoint_file_hash_mismatch", "restore_destination_exists", "archive_read_failed"];
    const reason = allowed.includes(failure?.reason) ? failure.reason : "unsafe_checkpoint_archive";
    throw new RunnerError(reason, "resume", "Archive validation rejected the requested checkpoint.", reason === "unsupported_checkpoint_schema" ?
      { expected: checkpointSchema, observed: Number.isSafeInteger(failure.observed) ? failure.observed : null } : {});
  }
}
export async function restoreCheckpoint(job: Job, root: string, manifest: any, git: TaskGit, log: Diagnostics) {
  try {
    const started = Date.now();
    validateCheckpoint(manifest, manifest.repository, job.runner);
    await git.restore(manifest.branch, manifest.checkpoint_sha);
    await runnerAdapter(job.runner).restore(job, root, manifest, git.cwd, log);
    log.event("resume.restore", "INFO", { runner: job.runner, runner_version: versions[job.runner], session_id: manifest.session_id,
      old_workspace: manifest.workspace, workspace: git.cwd, old_runner_home: manifest.runner_home, runner_home: job.runnerHome,
      expected_sha: manifest.checkpoint_sha, observed_sha: await git.head(), credentials: "reprovisioned", outcome: "complete", elapsed_ms: Date.now()-started });
  }
  catch (error: any) {
    log.event("resume.restore", "ERROR", { outcome: "rejected", task_id: manifest.task_id, session_id: manifest.session_id,
      reason: error.reason ?? "restore_failed", ...error.details, corrective_action: "Resolve branch or state drift before restoring; the recorded checkpoint remains authoritative." });
    throw error;
  }
}
