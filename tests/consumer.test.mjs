import assert from 'node:assert/strict';
import { cp, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { parse } from 'yaml';
import { exec, fixture, root } from './helpers.mjs';
const provider = 'markhuangai/agent-remote-dev', sourceSha = 'b'.repeat(40), revision = 'a'.repeat(40);

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
for (const variant of ['stable', 'prerelease', 'no-references', 'missing', 'sha', 'provider-repository', 'path', 'ref', 'empty-ref', 'run', 'head', 'repository', 'attempt', 'event'])
  test(`reusable workflow source resolution validates ${variant} provider identity`, async () => {
    const workflow = parse(await readFile(join(root, '.github/workflows/remote-dev.yml'), 'utf8'));
    const bootstrap = workflow.jobs.resolve.steps.find(step => step.id === 'source');
    assert.equal(bootstrap.env.REMOTE_DEV_JOB_CONTEXT, '${{ toJSON(job) }}');
    const run = { id: 200, run_attempt: 1, head_sha: revision, repository: { full_name: 'fixture/repo' }, event: 'workflow_dispatch',
      referenced_workflows: [{ path: `${provider}/.github/workflows/remote-dev.yml@refs/tags/v1`, sha: sourceSha },
        { path: `${provider}/.github/workflows/remote-dev.yml@refs/tags/v1-prerelease`, sha: 'c'.repeat(40) }] };
    const selected = run.referenced_workflows[variant === 'prerelease' ? 1 : 0];
    const job = { workflow_repository: provider, workflow_file_path: '.github/workflows/remote-dev.yml',
      workflow_ref: selected.path, workflow_sha: selected.sha };
    const expectedSha = job.workflow_sha;
    if (variant === 'no-references') run.referenced_workflows = [];
    if (variant === 'missing') delete job.workflow_sha;
    if (variant === 'sha') job.workflow_sha = 'invalid';
    if (variant === 'provider-repository') job.workflow_repository = 'other/repo';
    if (variant === 'path') job.workflow_file_path = '.github/workflows/other.yml';
    if (variant === 'ref') job.workflow_ref = `other/repo/.github/workflows/remote-dev.yml@refs/tags/v1`;
    if (variant === 'empty-ref') job.workflow_ref = `${provider}/.github/workflows/remote-dev.yml@`;
    if (variant === 'run') run.id = 201;
    if (variant === 'head') run.head_sha = sourceSha;
    if (variant === 'repository') run.repository.full_name = 'other/repo';
    if (variant === 'attempt') run.run_attempt = 2;
    if (variant === 'event') run.event = 'pull_request';
    const outputs = new Map(), core = { setOutput: (key, value) => outputs.set(key, value) };
    const github = { rest: { actions: { getWorkflowRun: async () => ({ data: run }) } } }, context = { repo: { owner: 'fixture', repo: 'repo' }, runId: 200 };
    const previous = { GITHUB_RUN_ATTEMPT: process.env.GITHUB_RUN_ATTEMPT, GITHUB_WORKFLOW_SHA: process.env.GITHUB_WORKFLOW_SHA,
      REMOTE_DEV_JOB_CONTEXT: process.env.REMOTE_DEV_JOB_CONTEXT };
    Object.assign(process.env, { GITHUB_RUN_ATTEMPT: '1', GITHUB_WORKFLOW_SHA: revision, REMOTE_DEV_JOB_CONTEXT: JSON.stringify(job) });
    try {
      const invoke = () => new (Object.getPrototypeOf(async function () {}).constructor)('github', 'context', 'core', bootstrap.with.script)(github, context, core);
      if (['stable', 'prerelease', 'no-references'].includes(variant)) {
        await invoke(); assert.equal(outputs.get('sha'), expectedSha);
        assert.equal(workflow.jobs.resolve.steps.find(step => step.uses?.startsWith('actions/checkout@')).with.ref, '${{ steps.source.outputs.sha }}');
        for (const name of ['execute', 'recover']) assert.equal(workflow.jobs[name].steps[0].with.ref, '${{ needs.resolve.outputs.provider_sha }}');
      }
      else { await assert.rejects(invoke(), /provider_workflow_identity_unavailable/); assert.equal(outputs.size, 0); }
    } finally { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
  });
test('workflow execution separates native timeout from final upload and exposes only the approved interface', async () => {
  const workflow = parse(await readFile(join(root, '.github/workflows/remote-dev.yml'), 'utf8'));
  assert.deepEqual(Object.keys(workflow.on.workflow_call.inputs).sort(), ['plan', 'resume-run-id', 'runner', 'runs-on', 'timeout-minutes']);
  assert.equal(workflow.jobs.execute['timeout-minutes'], '${{ inputs.timeout-minutes }}');
  assert.equal(workflow.jobs.execute['runs-on'], '${{ fromJSON(inputs.runs-on) }}');
  assert.equal(workflow.on.workflow_call.inputs.runner.default, 'codex');
  for (const secret of ['codex-config', 'codex-api-key', 'claude-settings', 'claude-api-key', 'claude-mcp-config']) assert.equal(workflow.on.workflow_call.secrets[secret].required, false);
  assert.equal(workflow.on.workflow_call.secrets['github-token'].required, true);
  const nativeEnv = workflow.jobs.execute.steps.find(step => step.name === 'Execute agent').env;
  assert.match(nativeEnv.CODEX_API_KEY, /inputs.runner == 'codex'/);
  assert.match(nativeEnv.ANTHROPIC_API_KEY, /inputs.runner == 'claude'/);
  for (const job of Object.values(workflow.jobs)) for (const step of job.steps) {
    assert.equal(step.env?.REMOTE_DEV_RUNS_ON, undefined);
    assert.equal(step.env?.REMOTE_DEV_TIMEOUT_MINUTES, undefined);
  }
  const native = workflow.jobs.execute.steps.findIndex(step => step.name === 'Execute agent');
  assert.equal(workflow.jobs.execute.steps[native + 1].name, 'Save final session');
  assert.ok(workflow.jobs.recover.if.includes('!cancelled()'));
  assert.equal(workflow.jobs.execute.concurrency['cancel-in-progress'], false);
});
test('normal task and consumer example expose only plan/resume with YAML-owned scheduling', async () => {
  const setup = await readFile(join(root, 'docs/setup.md'), 'utf8');
  const example = /```yaml\n(name: Remote development\n[\s\S]*?)\n```/.exec(setup);
  assert.ok(example);
  for (const caller of [parse(await readFile(join(root, '.github/workflows/runner-task.yml'), 'utf8')), parse(example[1])]) {
    assert.deepEqual(Object.keys(caller.on.workflow_dispatch.inputs).sort(), ['plan', 'resume-run-id', 'runner']);
    assert.deepEqual(caller.jobs.run.with, { runner: '${{ inputs.runner }}', plan: '${{ inputs.plan }}', 'resume-run-id': '${{ inputs.resume-run-id }}',
      'runs-on': '["ubuntu-latest"]', 'timeout-minutes': 360 });
  }
});
test('published maintainer test selects exactly one literal stable or prerelease call', async () => {
  const caller = parse(await readFile(join(root, '.github/workflows/runner-published.yml'), 'utf8'));
  assert.deepEqual(Object.keys(caller.on.workflow_dispatch.inputs).sort(), ['channel', 'plan', 'resume-run-id', 'runner', 'runs-on', 'timeout-minutes']);
  assert.equal(caller.on.workflow_dispatch.inputs.channel.type, 'choice');
  assert.equal(caller.on.workflow_dispatch.inputs.channel.default, 'stable');
  assert.deepEqual(caller.on.workflow_dispatch.inputs.channel.options, ['stable', 'prerelease']);
  assert.equal(caller.on.workflow_dispatch.inputs['timeout-minutes'].type, 'number');
  assert.equal(caller.on.workflow_dispatch.inputs['timeout-minutes'].default, 360);
  for (const channel of ['stable', 'prerelease']) {
    const selected = Object.values(caller.jobs).filter(job => new Function('inputs', `return ${job.if}`)({ channel }));
    assert.equal(selected.length, 1);
    assert.equal(selected[0].uses, `${provider}/.github/workflows/remote-dev.yml@v1${channel === 'prerelease' ? '-prerelease' : ''}`);
    assert.deepEqual(selected[0].with, { runner: '${{ inputs.runner }}', plan: '${{ inputs.plan }}', 'resume-run-id': '${{ inputs.resume-run-id }}',
      'runs-on': '${{ inputs.runs-on }}', 'timeout-minutes': '${{ fromJSON(inputs.timeout-minutes) }}' });
    assert.deepEqual(selected[0].secrets, { 'codex-config': '${{ secrets.CODEX_CONFIG_TOML }}',
      'codex-api-key': '${{ secrets.CODEX_API_KEY }}', 'claude-settings': '${{ secrets.CLAUDE_SETTINGS_JSON }}',
      'claude-api-key': '${{ secrets.ANTHROPIC_API_KEY }}', 'claude-mcp-config': '${{ secrets.CLAUDE_MCP_CONFIG_JSON }}',
      'github-token': '${{ secrets.REMOTE_DEV_PAT }}' });
  }
  await assert.rejects(readFile(join(root, '.github/workflows/runner-prerelease.yml')), { code: 'ENOENT' });
});
