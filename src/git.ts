import { command } from "./process.js";
import { Diagnostics } from "./diagnostics.js";
import { requireValue, RunnerError, shaPattern } from "./contracts.js";
import { validBranch } from "./platform/checkpoint-policy.mjs";

export class TaskGit {
  constructor(public cwd: string, public env: NodeJS.ProcessEnv, public log: Diagnostics, public branch: string | null = null) {}
  async run(args: string[]) { return command("git", args, { cwd: this.cwd, env: this.env, stage: "git", log: this.log }); }
  async head() { return (await this.run(["rev-parse", "HEAD"])).trim(); }
  async currentBranch() {
    const branch = (await this.run(["branch", "--show-current"])).trim() || null;
    requireValue(validBranch(branch), "invalid_branch", "checkpoint");
    return branch;
  }
  async remoteHead(detachedSha?: string) {
    if (this.branch === null) {
      const sha = detachedSha ?? await this.head();
      await this.run(["fetch", "--no-tags", "origin", sha]);
      const observed = (await this.run(["rev-parse", "FETCH_HEAD"])).trim();
      return observed === sha ? observed : null;
    }
    const lines = (await this.run(["ls-remote", "--heads", "origin", `refs/heads/${this.branch}`])).trim().split("\n").filter(Boolean);
    requireValue(lines.length <= 1, "ambiguous_remote_branch", "checkpoint");
    if (!lines.length) return null;
    const [sha, ref] = lines[0].split(/\s+/);
    requireValue(shaPattern.test(sha) && ref === `refs/heads/${this.branch}`, "invalid_remote_identity", "checkpoint");
    return sha;
  }
  async changedPaths() {
    return (await this.run(["status", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=none"])).trim();
  }
  async verify(expected: string) {
    requireValue(shaPattern.test(expected), "invalid_checkpoint_revision", "checkpoint");
    const local = await this.head(), actual = await this.remoteHead(expected), branch = await this.currentBranch();
    if (actual !== expected || local !== expected || branch !== this.branch) throw new RunnerError("checkpoint_head_mismatch", "checkpoint", "The source does not match a remote revision.",
      { expected_sha: expected, observed_sha: actual, local_sha: local, branch: this.branch, observed_branch: branch });
    const changes = await this.changedPaths();
    if (changes) throw new RunnerError("unpublished_changes", "checkpoint", "The checkout contains source that has not been published.",
      { expected_sha: expected, local_sha: local, observed_sha: actual, branch, unpublished_entries: changes.split("\n").length });
    this.log.event("checkpoint.source", "INFO", { outcome: "verified", branch, expected_sha: expected, observed_sha: actual });
  }
  async snapshot() {
    this.branch = await this.currentBranch();
    const sha = await this.head();
    await this.verify(sha);
    return { branch: this.branch, sha };
  }
}
