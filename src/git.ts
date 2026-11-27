import { command } from "./process.js";
import { Diagnostics } from "./diagnostics.js";
import { requireValue, RunnerError, shaPattern } from "./contracts.js";
import { validBranch } from "./platform/checkpoint-policy.mjs";

export type GitSummary = { branch: string | null; head: string; base: string | null; unpushed: number;
  commits: { sha: string; subject: string }[]; changes: { path: string; previous?: string; status: string; added?: string; deleted?: string }[];
  untracked: string[]; omitted: number };

export class TaskGit {
  constructor(public cwd: string, public env: NodeJS.ProcessEnv, public log: Diagnostics, public branch: string | null = null) {}
  async run(args: string[], options: { stdin?: string; rejectStderr?: boolean } = {}) {
    return command("git", args, { cwd: this.cwd, env: { ...this.env, GIT_OPTIONAL_LOCKS: "0" }, stage: "git", log: this.log, ...options });
  }
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
  async summary(baseSha?: string): Promise<GitSummary> {
    const git = (args: string[], options?: { stdin?: string; rejectStderr?: boolean }) => this.run(["-c", "core.quotepath=false", ...args], options);
    const succeeds = async (args: string[]) => {
      try { await git(args); return true; }
      catch (error) {
        if (error instanceof RunnerError && error.reason === "command_failed" && Number(error.details.exit_code) === 1) return false;
        throw error;
      }
    };
    const head = await this.head(), branch = await this.currentBranch();
    let validBase = false;
    if (baseSha && shaPattern.test(baseSha)) {
      const object = `${baseSha}^{commit}`;
      const checked = (await git(["cat-file", "--batch-check=%(objectname) %(objecttype)"], { stdin: object + "\n", rejectStderr: true })).trim();
      if (checked !== `${object} missing`) {
        requireValue(checked === `${baseSha} commit`, "invalid_git_summary", "summary");
        validBase = await succeeds(["cat-file", "-e", object]) && await succeeds(["merge-base", "--is-ancestor", baseSha, head]);
      }
    }
    const base = validBase ? baseSha! : null;
    const range = base ? [`${base}..${head}`] : [head, "--not", "--remotes=origin"];
    const count = Number((await git(["rev-list", "--count", "HEAD", "--not", "--remotes=origin"])).trim());
    requireValue(Number.isSafeInteger(count) && count >= 0, "invalid_git_summary", "summary");
    const entries = (await git(["log", "--max-count=50", "--format=%H%x00%s%x00", ...range])).split("\0");
    const commits: GitSummary["commits"] = [];
    for (let index = 0; index + 1 < entries.length; index += 2) {
      const sha = entries[index].trim();
      if (shaPattern.test(sha)) commits.push({ sha, subject: entries[index + 1] });
    }
    const comparison = base ?? "HEAD";
    const diff = ["diff", "--no-ext-diff", "--no-textconv", "-M", "-z"];
    const names = (await git([...diff, "--name-status", comparison, "--"])).split("\0");
    const changes: GitSummary["changes"] = [];
    for (let index = 0; index < names.length && names[index];) {
      const status = names[index++], first = names[index++];
      if (!first) break;
      const renamed = /^[RC]/.test(status);
      const path = renamed ? names[index++] : first;
      if (!path) break;
      changes.push({ status, path, ...(renamed ? { previous: first } : {}) });
    }
    const stats = (await git([...diff, "--numstat", comparison, "--"])).split("\0");
    const counts = new Map<string, { added: string; deleted: string }>();
    for (let index = 0; index < stats.length && stats[index];) {
      const match = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(stats[index++]);
      if (!match) continue;
      let path = match[3];
      if (!path) { index++; path = stats[index++] ?? ""; }
      counts.set(path, { added: match[1], deleted: match[2] });
    }
    for (const change of changes) Object.assign(change, counts.get(change.path));
    const status = (await git(["status", "--porcelain=v1", "-z", "--untracked-files=normal"])).split("\0");
    const untracked: string[] = [];
    for (let index = 0; index < status.length; index++) {
      const entry = status[index];
      if (entry.startsWith("?? ")) untracked.push(entry.slice(3));
      else if (/^[RC]|^.[RC]/.test(entry)) index++;
    }
    const omitted = Math.max(0, changes.length + untracked.length - 100);
    return { branch, head, base, unpushed: count, commits, changes: changes.slice(0, 100),
      untracked: untracked.slice(0, Math.max(0, 100 - changes.length)), omitted };
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
