import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { Diagnostics } from "../.build/diagnostics.js";
import { createJob, removeJob } from "../.build/setup.js";
import { hash, versions, projectStorageKey } from "../.build/contracts.js";

export const root = resolve(import.meta.dirname, "..");
export const exec = promisify(execFile);
export function logger() {
  const records = [];
  const sink = Object.fromEntries(["info", "warning", "error", "debug"].map((key) => [key, (line) => records.push(JSON.parse(line))]));
  return { log: new Diagnostics({ task_id: "fixture-task", run_id: "13", run_attempt: "1" }, sink), records };
}
export async function fixture(t, runner = "codex") {
  const temporary = await mkdtemp(join(tmpdir(), "codex-runtime-test-"));
  t.after(() => removeJob(temporary));
  const host = join(temporary, "inherited-host");
  await mkdir(join(host, ".codex"), { recursive: true });
  await mkdir(join(host, ".claude"), { recursive: true });
  await mkdir(join(host, ".agents/skills/unwanted"), { recursive: true });
  const hostFiles = {
    ".codex/AGENTS.md": "unwanted-host-instructions-3819\n",
    ".codex/config.toml": 'model="host-config-sentinel-6158"\n',
    ".codex/auth.json": '{"OPENAI_API_KEY":"host-auth-sentinel-9482"}\n',
    ".claude/CLAUDE.md": "unwanted-host-instructions-3819\n",
    ".claude/settings.json": '{"model":"host-config-sentinel-6158"}\n',
    ".agents/skills/unwanted/SKILL.md": "---\nname: unwanted-host-sentinel-3719\ndescription: Host sentinel\n---\nNever load this host skill.\n",
  };
  for (const [name, content] of Object.entries(hostFiles)) await writeFile(join(host, name), content);
  const { log, records } = logger();
  const job = await createJob(temporary, "fixture-api-credential-9374", "fixture-github-credential-6241", "Fixture Author", "fixture@example.invalid",
    { ...process.env, HOME: host, CODEX_HOME: join(host, ".codex"), CLAUDE_CONFIG_DIR: join(host, ".claude") }, runner);
  if (runner === "claude") job.env.CLAUDE_CODE_PROJECT_DIR_NAME = projectStorageKey('fixture/repo', '13');
  job.env.NO_PROXY = "127.0.0.1,localhost";
  log.protect(job.env.CODEX_API_KEY ?? job.env.ANTHROPIC_API_KEY); log.protect(job.env.GH_TOKEN);
  await mkdir(join(job.tools, "node_modules/.bin"), { recursive: true });
  for (const binary of ["codex", "skills"]) {
    await writeFile(join(job.tools, "node_modules/.bin", binary), `#!/bin/sh\nexec '${join(root, "node_modules/.bin", binary)}' "$@"\n`, { mode: 0o700 });
  }
  return { temporary, job, log, records, host, hostFiles };
}
export async function repository(f) {
  const cwd = join(f.temporary, "repo"), remote = join(f.temporary, "remote.git");
  await mkdir(cwd);
  const git = async (...args) => (await exec("git", args, { cwd, env: f.job.env })).stdout.trim();
  await git("init", "--initial-branch=main");
  await writeFile(join(cwd, "README.md"), "Fixture repository\n");
  await git("add", "README.md"); await git("commit", "-m", "Initial fixture");
  const base = await git("rev-parse", "HEAD");
  await git("init", "--bare", remote);
  await git("remote", "add", "origin", remote);
  await git("push", "origin", "main");
  await git("switch", "-c", "codex/fixture-task");
  return { cwd, remote, git, base, branch: "codex/fixture-task" };
}
export const turn = (kind, extra = {}) => ({ kind, summary: "Fixture accomplishment", paths: [], commit_message: "", pr_url: null,
  review_receipt: null, validation_policy: null, blocker: kind === "blocked" ? {reason:"plan_decision_required",references:[],missing_inputs:[]} : null, ...extra });
export const policy = { checks: ["CI"], reviewers: [], local_checks: ["node --check greeting.js"], marked_review_count: 0 };
export function message(text, id = "m1") {
  return { type: "response.output_item.done", item: { type: "message", role: "assistant", id, content: [{ type: "output_text", text: typeof text === "string" ? text : JSON.stringify(text) }] } };
}
export function tool(cmd, id = "call1") {
  return { type: "response.output_item.done", item: { type: "function_call", call_id: id, name: "exec_command", arguments: JSON.stringify({ cmd, login: false, yield_time_ms: 1000, max_output_tokens: 1000 }) } };
}
export async function provider(t, replies) {
  const requests = [];
  const server = createServer(async (request, response) => {
    if (request.method !== "POST" || !request.url.endsWith("/responses")) { response.writeHead(404); response.end(); return; }
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()); requests.push(body);
    const next = typeof replies === "function" ? await replies(body, requests.length, request.headers) : replies.shift();
    if (!next) { response.writeHead(400); response.end('{"error":{"message":"Unexpected fixture request"}}'); return; }
    if (next.hang) return;
    if (next.status) { response.writeHead(next.status, { "content-type": "application/json" }); response.end(JSON.stringify(next.body)); return; }
    response.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
    const id = `resp-${requests.length}`;
    const events = [{ type: "response.created", response: { id } }, ...next, { type: "response.completed", response: { id,
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, input_tokens_details: null, output_tokens_details: null } } }];
    for (const event of events) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    response.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const url = `http://127.0.0.1:${server.address().port}/v1`;
  return { url, requests, config: `model = "gpt-5.1"\nmodel_provider = "fixture"\n[model_providers.fixture]\nname = "Fixture transport"\nbase_url = "${url}"\nwire_api = "responses"\nenv_key = "CODEX_API_KEY"\n` };
}
let portable;
export async function portableSource(f) {
  if (!portable) {
    portable = (async () => {
      const response = await fetch(`https://codeload.github.com/markhuangai/agent-remote-dev-skills/tar.gz/${"224a5be4ddf40c6cf0a50b97885cb353e8522e2e"}`);
      assert.equal(response.status, 200);
      return Buffer.from(await response.arrayBuffer());
    })();
  }
  const archive = join(f.temporary, "portable.tar.gz"), directory = join(f.temporary, "portable");
  await writeFile(archive, await portable); await mkdir(directory);
  await exec("tar", ["-xzf", archive, "--strip-components=1", "-C", directory]);
  return directory;
}
export async function skillTransport(f, revision, archive) {
  const bin=join(f.job.root,"skill-api-bin");await mkdir(bin);
  await writeFile(join(bin,"gh"),`#!/usr/bin/env node
const fs=require('node:fs');
const endpoint=process.argv[3]||'';
if(endpoint.includes('/commits/'))process.stdout.write(JSON.stringify({sha:${JSON.stringify(revision)}}));
else if(endpoint.includes('/tarball/'))process.stdout.write(fs.readFileSync(${JSON.stringify(archive)}));
else{process.stderr.write('Unexpected skill transport endpoint');process.exitCode=1;}
`,{mode:0o700});
  f.job.env.PATH=`${bin}:${f.job.env.PATH}`;
}

export const executionSource = { repository: 'markhuangai/agent-remote-dev-skills', revision: '224a5be4ddf40c6cf0a50b97885cb353e8522e2e', names: ['sdlc-plan-implementation', 'plan-audit', 'pr-review-loop'] };
export const sessionId = '11111111-1111-4111-8111-111111111111';
export const lineage = { run_id: '13', run_attempt: '1', workflow_id: 7, workflow_path: '.github/workflows/custom.yml', workflow_sha: 'a'.repeat(40), branch: 'main' };
export const checkpoint = (extra = {}) => ({ repository: 'fixture/repo', branch: 'codex/fixture-task', checkpoint_sha: 'a'.repeat(40), omitted_work: false,
  session_id: sessionId, root_run_id: '13', activation_run_id: '13', operator: 'Z-M-Huang', auto_count: 0, lineage,
  outcome: 'running', workspace: '/fixture/workspace', previous: null, ...extra });
