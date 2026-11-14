import { lstat, readFile, readlink } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { command } from "./process.js";
import { Diagnostics } from "./diagnostics.js";
import { requireValue, RunnerError, shaPattern } from "./contracts.js";

export class TaskGit {
  constructor(public cwd: string, public env: NodeJS.ProcessEnv, public log: Diagnostics, public branch: string) {}
  async run(args: string[]) { return command("git", args, { cwd: this.cwd, env: this.env, stage: "git", log: this.log }); }
  async head() { return (await this.run(["rev-parse", "HEAD"])).trim(); }
  async remoteHead() {
    const lines = (await this.run(["ls-remote", "--heads", "origin", `refs/heads/${this.branch}`])).trim().split("\n").filter(Boolean);
    requireValue(lines.length <= 1, "ambiguous_remote_branch", "publication");
    if (!lines.length) return null;
    const [sha, ref] = lines[0].split(/\s+/);
    requireValue(shaPattern.test(sha) && ref === `refs/heads/${this.branch}`, "invalid_remote_identity", "publication");
    return sha;
  }
  async verify(expected: string) {
    const actual = await this.remoteHead();
    const local = await this.head();
    if (actual !== expected || local !== expected) throw new RunnerError("checkpoint_head_mismatch", "publication", "The local or remote task head changed.",
      { expected_sha: expected, observed_sha: actual, local_sha: local });
    this.log.event("runtime.publish", "INFO", { outcome: "verified", expected_sha: expected, observed_sha: actual });
  }
  async changedPaths() {
    const changed = await this.run(["ls-files", "-m", "-d", "-o", "--exclude-standard", "-z"]);
    const staged = await this.run(["diff", "--cached", "--name-only", "-z"]);
    return [...new Set((changed + staged).split("\0").filter(Boolean))].sort();
  }
  async fingerprint() {
    const digest = createHash("sha256");
    const paths = [...new Set((await this.run(["ls-files", "--cached", "--others", "--exclude-standard", "-z"])).split("\0").filter(Boolean))].sort();
    for (const path of paths) {
      digest.update(path + "\0");
      try {
        const stat = await lstat(join(this.cwd, path));
        digest.update(stat.isSymbolicLink() ? "symlink" : String(stat.mode & 0o777));
        digest.update(stat.isSymbolicLink() ? await readlink(join(this.cwd, path)) : await readFile(join(this.cwd, path)));
      } catch (error: any) { if (error.code === "ENOENT") digest.update("deleted"); else throw error; }
      digest.update("\0");
    }
    return digest.digest("hex");
  }
  async publish(paths: string[], message: string, expectedHead: string, previousRemote: string | null) {
    requireValue((await this.run(["branch", "--show-current"])).trim() === this.branch && this.branch !== "main", "task_branch_changed", "publication");
    requireValue(await this.head() === expectedHead, "worker_changed_git_history", "publication");
    const observed = await this.remoteHead();
    if (observed !== previousRemote) throw new RunnerError("remote_branch_drift", "publication", "Normal publication refused divergent remote state.",
      { expected_sha: previousRemote, observed_sha: observed, intended_sha: expectedHead });
    requireValue(paths.every((path) => path.length > 0 && !path.startsWith("/") && !path.split("/").some((part) => ["..", ".git"].includes(part)) && !path.includes("\0")), "unsafe_commit_path", "publication");
    requireValue(JSON.stringify([...new Set(paths)].sort()) === JSON.stringify(await this.changedPaths()), "unlisted_worktree_changes", "publication");
    requireValue(!message.includes("\0") && message.length <= 512, "invalid_commit_message", "publication");
    for (const path of paths) {
      let bytes: Buffer;
      try {
        const stat = await lstat(join(this.cwd, path));
        bytes = stat.isSymbolicLink() ? Buffer.from(await readlink(join(this.cwd, path))) : await readFile(join(this.cwd, path));
      } catch (error: any) { if (error.code === "ENOENT") continue; throw error; }
      for (const secret of this.log.protectedValues) requireValue(!bytes.includes(Buffer.from(secret)), "credential_in_commit", "publication");
    }
    for (const secret of this.log.protectedValues) requireValue(!message.includes(secret), "credential_in_commit_message", "publication");
    if (paths.length) {
      requireValue(message.trim().length > 0, "missing_commit_message", "publication");
      const unstaged = (await this.run(["ls-files", "-m", "-d", "-o", "--exclude-standard", "-z"])).split("\0").filter(Boolean);
      const staging = paths.filter((path) => unstaged.includes(path));
      if (staging.length) await this.run(["add", "--all", "--", ...staging]);
      await this.run(["commit", "-m", message]);
    }
    const intended = await this.head();
    try { await this.run(["push", "--set-upstream", "origin", `HEAD:refs/heads/${this.branch}`]); }
    catch (error) {
      const observedAfter = await this.remoteHead();
      throw new RunnerError("push_failed", "publication", error instanceof RunnerError ? error.nativeCause : "Git push failed",
        { intended_sha: intended, observed_sha: observedAfter, last_published_sha: previousRemote });
    }
    await this.verify(intended);
    requireValue((await this.run(["rev-parse", "--abbrev-ref", "@{upstream}"])).trim() === `origin/${this.branch}` &&
      (await this.run(["rev-list", "--left-right", "--count", "HEAD...@{upstream}"])).trim().replace(/\s+/g, " ") === "0 0", "upstream_mismatch", "publication");
    return intended;
  }
}
