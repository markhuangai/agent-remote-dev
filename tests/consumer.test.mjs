import assert from 'node:assert/strict';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { parse } from 'yaml';
import { exec, fixture, root } from './helpers.mjs';
const provider = 'markhuangai/agent-remote-dev-codex', sourceSha = 'b'.repeat(40), revision = 'a'.repeat(40);
for (const variant of ['valid', 'missing', 'duplicate', 'sha', 'head', 'repository', 'attempt', 'event'])
  test(`actual reusable workflow bootstrap ${variant} publishes only a verified provider revision`, async () => {
    const workflow = parse(await readFile(join(root, '.github/workflows/remote-codex.yml'), 'utf8'));
    const bootstrap = workflow.jobs.resolve.steps.find(step => step.id === 'source');
    const run = { id: 200, run_attempt: 1, head_sha: revision, repository: { full_name: 'fixture/repo' }, event: 'workflow_dispatch', head_branch: 'main',
      referenced_workflows: [{ path: `${provider}/.github/workflows/remote-codex.yml@refs/tags/v1`, sha: sourceSha }] };
    if (variant === 'missing') run.referenced_workflows = [];
    if (variant === 'duplicate') run.referenced_workflows.push({ ...run.referenced_workflows[0] });
    if (variant === 'sha') run.referenced_workflows[0].sha = 'private-invalid-source-body';
    if (variant === 'head') run.head_sha = sourceSha;
    if (variant === 'repository') run.repository.full_name = 'other/repo';
    if (variant === 'attempt') run.run_attempt = 2;
    if (variant === 'event') run.event = 'pull_request';
    const outputs = new Map(), records = [], core = { setOutput: (key, value) => outputs.set(key, value), info: line => records.push(JSON.parse(line)), error: line => records.push(JSON.parse(line)) };
    const github = { rest: { actions: { getWorkflowRun: async input => { assert.deepEqual(input, { owner: 'fixture', repo: 'repo', run_id: 200 }); return { data: run }; } } } };
    const context = { repo: { owner: 'fixture', repo: 'repo' }, runId: 200, eventName: 'workflow_dispatch' };
    const previous = { GITHUB_RUN_ATTEMPT: process.env.GITHUB_RUN_ATTEMPT, GITHUB_WORKFLOW_SHA: process.env.GITHUB_WORKFLOW_SHA };
    Object.assign(process.env, { GITHUB_RUN_ATTEMPT: '1', GITHUB_WORKFLOW_SHA: revision });
    try {
      const invoke = () => new (Object.getPrototypeOf(async function () {}).constructor)('github', 'context', 'core', bootstrap.with.script)(github, context, core);
      if (variant === 'valid') { await invoke(); assert.deepEqual([...outputs], [['repository', provider], ['sha', sourceSha]]); }
      else { await assert.rejects(invoke(), /provider_workflow_identity_unavailable/); assert.equal(outputs.size, 0); }
      assert.equal(records[0].event, 'submission.provider'); assert.equal(records[0].outcome, variant === 'valid' ? 'verified' : 'blocked');
      assert.ok(!JSON.stringify(records).includes('private-invalid-source-body'));
    } finally {
      for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    }
  });

test('the built workflow helper executes outside the source checkout and reports a rejected operator safely', async t => {
  const f = await fixture(t), bundled = join(f.temporary, 'bundle'), bin = join(f.temporary, 'bin'), event = join(f.temporary, 'event.json'), outputs = join(f.temporary, 'outputs');
  await mkdir(bundled); await mkdir(bin); await writeFile(event, '{}'); await writeFile(outputs, '');
  for (const name of ['control.mjs', 'yaml.cjs', 'archive.py']) await cp(join(root, 'dist', name), join(bundled, name));
  await writeFile(join(bin, 'gh'), `#!/usr/bin/env node
const path=process.argv[3];let data;
if(path.endsWith('/git/ref/heads/main'))data={object:{sha:'a'.repeat(40)}};
else if(path.includes('/contents/remote-codex.yml?')){const b=Buffer.from('allowed-actors: [Z-M-Huang]\\nskills: []\\n');data={type:'file',size:b.length,encoding:'base64',content:b.toString('base64')}}
else if(path.includes('/collaborators/'))data={permission:process.env.FIXTURE_PERMISSION};
else process.exit(2);
process.stdout.write(JSON.stringify(data));
`, { mode: 0o700 });
  const env = { ...f.job.env, PATH: `${bin}:${f.job.env.PATH}`, FIXTURE_PERMISSION: 'write', GITHUB_REPOSITORY: 'fixture/repo', GITHUB_ACTOR: 'Z-M-Huang',
    TRIGGERING_ACTOR: 'Z-M-Huang', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_PATH: event, GITHUB_OUTPUT: outputs,
    PROVIDER_REPOSITORY: provider, PROVIDER_SHA: sourceSha };
  await exec(process.execPath, [join(bundled, 'control.mjs'), 'authorize'], { cwd: f.temporary, env });
  assert.match(await readFile(outputs, 'utf8'), /execute/);
  await assert.rejects(exec(process.execPath, [join(bundled, 'control.mjs'), 'authorize'], { cwd: f.temporary, env: { ...env, FIXTURE_PERMISSION: 'read' } }), error => {
    assert.match(error.stdout, /submission.workflow/); assert.match(error.stdout, /operator_write_permission_required/);
    assert.doesNotMatch(error.stdout + error.stderr, /fixture-api-credential|fixture-github-credential/); process.stdout.write(error.stdout); return true;
  });
});
