import { command } from "./process.js";
import { Diagnostics } from "./diagnostics.js";
import { requireValue, shaPattern } from "./contracts.js";
import { validBranch } from "./platform/checkpoint-policy.mjs";

export class TaskGit {
  constructor(public cwd: string, public env: NodeJS.ProcessEnv, public log: Diagnostics, public branch: string | null = null) {}
  async run(args: string[]) { return command("git", args, { cwd: this.cwd, env: { ...this.env, GIT_OPTIONAL_LOCKS: "0" }, stage: "git", log: this.log }); }
  async head() { return (await this.run(["rev-parse", "HEAD"])).trim(); }
  async currentBranch() {
    const branch = (await this.run(["branch", "--show-current"])).trim() || null;
    requireValue(validBranch(branch), "invalid_branch", "checkpoint"); return branch;
  }
  async changedPaths() { return (await this.run(["status", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=none"])).trim(); }
  async remoteHead() {
    const branch = await this.currentBranch();
    if (!branch) return null;
    return (await this.run(["ls-remote", "--heads", "origin", `refs/heads/${branch}`])).trim().split(/\s+/)[0] || null;
  }
  async snapshot() {
    await this.run(["fetch", "--no-tags", "origin"]);
    const published = new Set((await this.run(["rev-list", "--remotes=origin"])).trim().split("\n"));
    const local = (await this.run(["rev-list", "HEAD"])).trim().split("\n");
    const sha = local.find(value => published.has(value));
    requireValue(sha && shaPattern.test(sha), "published_source_unavailable", "checkpoint");
    this.branch = await this.currentBranch();
    return { branch: this.branch, checkpoint_sha: sha, omitted_work: local[0] !== sha || Boolean(await this.changedPaths()) };
  }
  async restore(branch: string | null, sha: string) {
    requireValue(validBranch(branch) && shaPattern.test(sha), "invalid_checkpoint_git_identity", "resume");
    requireValue(!await this.changedPaths(), "unsafe_worktree", "resume");
    await this.run(["fetch", "--no-tags", "origin", sha]);
    requireValue((await this.run(["rev-parse", "FETCH_HEAD"])).trim() === sha, "resume_fetch_drift", "resume");
    const local = branch ? (await this.run(["branch", "--list", "--format=%(objectname)", branch])).trim() : "";
    if (!branch || local && local !== sha) await this.run(["switch", "--detach", sha]);
    else await this.run(local ? ["switch", branch] : ["switch", "-c", branch, sha]);
    requireValue(await this.head() === sha, "resume_source_mismatch", "resume");
    this.branch = await this.currentBranch();
  }
}
