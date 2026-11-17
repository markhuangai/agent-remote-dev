import assert from 'node:assert/strict';
import { cp, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { parse } from 'yaml';
import { exec, fixture, root } from './helpers.mjs';
const provider = 'markhuangai/agent-remote-dev-codex', sourceSha = 'b'.repeat(40), revision = 'a'.repeat(40);

test('a clean provider checkout installs locked dependencies and compiles without a distribution bundle', async t => {
  const f = await fixture(t), checkout = join(f.temporary, 'provider'); await mkdir(checkout);
  for (const name of ['package.json', 'package-lock.json', 'tsconfig.json', 'src', 'scripts']) await cp(join(root, name), join(checkout, name), { recursive: true });
  await exec('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: checkout, env: f.job.env, timeout: 120000 });
  await exec('npm', ['run', 'build'], { cwd: checkout, env: f.job.env });
  const script = `await import(${JSON.stringify(pathToFileURL(join(checkout, '.build/main.js')).href)}); await import(${JSON.stringify(pathToFileURL(join(checkout, 'src/platform/control.mjs')).href)});`;
  await exec(process.execPath, ['--input-type=module', '-e', script], { cwd: checkout, env: f.job.env });
  assert.equal((await exec(join(checkout, 'node_modules/.bin/codex'), ['--version'], { env: f.job.env })).stdout.trim(), 'codex-cli ' + JSON.parse(await readFile(join(checkout, 'package.json'))).dependencies['@openai/codex']);
  await assert.rejects(readFile(join(checkout, 'dist/index.js')), { code: 'ENOENT' });
});
for (const variant of ['valid', 'missing', 'duplicate', 'sha', 'head', 'repository', 'attempt', 'event'])
  test(`reusable workflow source resolution validates ${variant} provider identity`, async () => {
    const workflow = parse(await readFile(join(root, '.github/workflows/remote-codex.yml'), 'utf8'));
    const bootstrap = workflow.jobs.resolve.steps.find(step => step.id === 'source');
    const run = { id: 200, run_attempt: 1, head_sha: revision, repository: { full_name: 'fixture/repo' }, event: 'workflow_dispatch',
      referenced_workflows: [{ path: `${provider}/.github/workflows/remote-codex.yml@refs/tags/v1`, sha: sourceSha }] };
    if (variant === 'missing') run.referenced_workflows = [];
    if (variant === 'duplicate') run.referenced_workflows.push({ ...run.referenced_workflows[0] });
    if (variant === 'sha') run.referenced_workflows[0].sha = 'invalid';
    if (variant === 'head') run.head_sha = sourceSha;
    if (variant === 'repository') run.repository.full_name = 'other/repo';
    if (variant === 'attempt') run.run_attempt = 2;
    if (variant === 'event') run.event = 'pull_request';
    const outputs = new Map(), core = { setOutput: (key, value) => outputs.set(key, value) };
    const github = { rest: { actions: { getWorkflowRun: async () => ({ data: run }) } } }, context = { repo: { owner: 'fixture', repo: 'repo' }, runId: 200 };
    const previous = { GITHUB_RUN_ATTEMPT: process.env.GITHUB_RUN_ATTEMPT, GITHUB_WORKFLOW_SHA: process.env.GITHUB_WORKFLOW_SHA };
    Object.assign(process.env, { GITHUB_RUN_ATTEMPT: '1', GITHUB_WORKFLOW_SHA: revision });
    try {
      const invoke = () => new (Object.getPrototypeOf(async function () {}).constructor)('github', 'context', 'core', bootstrap.with.script)(github, context, core);
      if (variant === 'valid') { await invoke(); assert.equal(outputs.get('sha'), sourceSha); }
      else { await assert.rejects(invoke(), /provider_workflow_identity_unavailable/); assert.equal(outputs.size, 0); }
    } finally { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
  });
test('workflow execution separates native timeout from final upload and exposes only the approved interface', async () => {
  const workflow = parse(await readFile(join(root, '.github/workflows/remote-codex.yml'), 'utf8'));
  assert.deepEqual(Object.keys(workflow.on.workflow_call.inputs).sort(), ['plan', 'resume-run-id', 'runs-on', 'timeout-minutes']);
  assert.equal(workflow.jobs.execute['timeout-minutes'], '${{ inputs.timeout-minutes }}');
  const native = workflow.jobs.execute.steps.findIndex(step => step.name === 'Execute Codex');
  assert.equal(workflow.jobs.execute.steps[native + 1].name, 'Save final session');
  assert.ok(workflow.jobs.recover.if.includes('!cancelled()'));
  for (const name of ['runner-published', 'runner-prerelease']) {
    const caller = parse(await readFile(join(root, `.github/workflows/${name}.yml`), 'utf8'));
    assert.match(caller.jobs.run.uses, /\.github\/workflows\/remote-codex.yml@v1(?:-prerelease)?$/);
  }
});
