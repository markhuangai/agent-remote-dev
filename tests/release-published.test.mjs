import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import test from 'node:test';
import { parse } from 'yaml';
import { exportCheckpoint } from '../.build/checkpoint.js';
import { checkpointName, digest, recordName } from '../.github/remote-codex/checkpoint-policy.mjs';
import { registryFor } from '../.github/scripts/qualification.mjs';
import { qualificationCases, qualificationReceipt } from '../.github/scripts/release-policy.mjs';
import { exec, execution, fixture, projectConfig, root } from './helpers.mjs';

async function publishedFixture(t) {
  const f = await fixture(t), repository = 'markhuangai/agent-remote-dev-codex', sourceSha = 'a'.repeat(40), workflowSha = 'b'.repeat(40);
  const registry = registryFor({ runId: '100', sourceSha, selfHosted: ['self-hosted', 'Linux'], author: 'Fixture', email: 'fixture@example.invalid', authorization: 'Qualify the owned tasks.',
    action: { repository, sha: sourceSha, requested_ref: 'v1-prerelease', release_tag: 'v1.0.0-rc.0', release_id: 9 }, nonce: '12345678' });
  registry.project_config = { ...projectConfig, revision: workflowSha };
  const qualificationRun = { id: 100, run_attempt: 1, status: 'completed', conclusion: 'success', path: '.github/workflows/runner-acceptance.yml', event: 'workflow_dispatch', head_branch: 'main', head_sha: workflowSha,
    repository: { full_name: repository }, head_repository: { full_name: repository }, actor: { login: 'Z-M-Huang' }, triggering_actor: { login: 'Z-M-Huang' } };
  const artifacts = new Map(), payloads = new Map(), records = new Map(), manifests = new Map(), runs = new Map([[100, qualificationRun]]), calls = [];
  let serial = 1000;
  async function zipDirectory(directory) {
    const path = join(f.temporary, `archive-${serial++}.zip`);
    await exec('python3', ['-c', `import pathlib,sys,zipfile
with zipfile.ZipFile(sys.argv[1],'w',compression=zipfile.ZIP_DEFLATED) as z:
 for p in pathlib.Path(sys.argv[2]).rglob('*'):
  if p.is_file():z.write(p,str(p.relative_to(sys.argv[2])))`, path, directory]);
    return readFile(path);
  }
  function add(id, name, data, producer) {
    artifacts.set(id, { id, name, size_in_bytes: data.length, expired: false, expires_at: new Date(Date.now() + 86400000).toISOString(), workflow_run: { id: producer } });
    payloads.set(id, data);
  }
  async function record(id, name, value, producer) {
    const directory = join(f.temporary, `record-${serial++}`); await mkdir(directory); await writeFile(join(directory, 'record.json'), JSON.stringify(value));
    records.set(id, value); add(id, name, await zipDirectory(directory), producer);
  }
  const proofs = [];
  for (const [targetIndex, target] of registry.targets.entries()) {
    const job = await fixture(t), task = registry.published_tasks.find(task => task.target === target.key), initialId = 201 + targetIndex * 100, finalId = initialId + 1;
    const session = randomUUID(), plan = `Use $runner-acceptance.\n${JSON.stringify(task)}`;
    await mkdir(join(job.job.codexHome, 'sessions')); await writeFile(join(job.job.codexHome, 'sessions', 'rollout.jsonl'), JSON.stringify({ type: 'session_meta', payload: { id: session } }) + '\n');
    const proof = { schema_version: 3, repository, source_sha: sourceSha, run_id: '100', target: target.key, passed: true,
      cases: qualificationCases.map((scenario, index) => ({ scenario, source_sha: sourceSha, passed: true, root_run_id: 50 + index, run_ids: [50 + index], session_before: session, session_after: session,
        branch_before: 'qualification/owned', branch_after: 'qualification/owned', initial_artifact_id: 10, final_artifact_id: 11, automatic_restart: false, false_checkpoint: false })) };
    const smoke = { scenario: 'cold-resume', task_id: task.task_id, passed: true, source_sha: sourceSha, root_run_id: initialId, run_ids: [initialId, finalId],
      session_before: session, session_after: session, branch_before: task.branch, branch_after: task.branch, initial_artifact_id: initialId + 300, final_artifact_id: finalId + 300,
      invocation_before: { ...registry.action, kind: 'published' }, invocation_after: { ...registry.action, kind: 'published' } };
    proof.published_smoke = smoke;
    let previous = null;
    for (const [index, id] of [initialId, finalId].entries()) {
      const run = { ...qualificationRun, id, workflow_id: 7, path: '.github/workflows/runner-published.yml', conclusion: index === 0 ? 'failure' : 'success' };
      runs.set(id, run);
      const lineage = { repository, workflow_ref: `${repository}/${run.path}@refs/heads/main`, workflow_sha: workflowSha, run_id: String(id), run_attempt: '1', actor: 'Z-M-Huang', triggering_actor: 'Z-M-Huang' };
      const settings = execution({ request_id: task.task_id, project_config: registry.project_config, source_repository: repository, source_sha: sourceSha, runner: target.labels, auto_continue: false,
        root_run_id: String(initialId), activation_run_id: String(id), continuation_count: index, parent_run_id: index === 0 ? null : String(initialId), parent_run_attempt: index === 0 ? null : '1', published_ref: 'v1-prerelease' });
      const request = { schema_version: 3, repository, task_id: String(initialId), plan_sha256: digest(plan), authorization: { repository, plan_sha256: digest(plan), request: plan },
        execution: settings, lineage, plan_source: 'inline', skills: [{ repository, revision: sourceSha, names: ['runner-acceptance'] }], invocation: { ...registry.action, kind: 'published' }, resume_artifact_id: previous?.artifact_id ?? null };
      await record(id + 1000, recordName('run', String(initialId), id, 1), request, id);
      const input = { repository, task_id: String(initialId), branch: task.branch, base_sha: workflowSha, checkpoint_sha: (index === 0 ? 'c' : 'd').repeat(40), plan, plan_source: 'inline', authorization: request.authorization,
        session_id: session, sessions: [session], skills: request.skills, user_agents: null, lineage, execution: settings, previous };
      const exported = await exportCheckpoint(job.job, input, job.log), manifest = JSON.parse(await readFile(join(exported.root, 'manifest.json'), 'utf8'));
      manifests.set(id + 300, { manifest, directory: exported.root });
      add(id + 300, checkpointName(manifest), await zipDirectory(exported.root), id);
      previous = { artifact_id: id + 300, checkpoint_sha: input.checkpoint_sha, sequence: index + 1 };
      await record(id + 2000, recordName('outcome', String(initialId), id, 1), { schema_version: 3, repository, task_id: String(initialId), lineage, checkpoint: previous,
        status: index === 0 ? 'incomplete' : 'completed', native_outcome: index === 0 ? 'timed_out' : 'succeeded', reason: index === 0 ? 'action_budget' : 'native_return' }, id);
    }
    proofs.push(proof);
  }
  const cleanup = { schema_version: 3, repository, source_sha: sourceSha, run_id: '100', verified: true,
    tasks: [...registry.tasks, ...registry.published_tasks].map(task => ({ task_id: task.task_id, verified: true })) };
  await record(1, 'linux-qualification-100-registry', registry, 100);
  await record(2, 'linux-qualification-100-hosted', proofs[0], 100); await record(3, 'linux-qualification-100-self-hosted', proofs[1], 100);
  await record(4, 'linux-qualification-100-cleanup', cleanup, 100);
  const api = async (path, options = {}) => {
    calls.push({ path, ...options }); assert.equal(options.method ?? 'GET', 'GET');
    if (path.endsWith('/git/ref/heads/main')) return { object: { sha: workflowSha } };
    if (path.includes('/contents/remote-codex.yml?')) { const data = Buffer.from(projectConfig.content); return { type: 'file', size: data.length, encoding: 'base64', content: data.toString('base64') }; }
    if (path.includes('/collaborators/')) return { permission: 'write' };
    if (/\/actions\/runs\/\d+(?:\/attempts\/\d+)?$/.test(path)) return runs.get(Number(path.match(/\/runs\/(\d+)/)[1]));
    if (/\/actions\/runs\/\d+\/artifacts\?/.test(path)) return { artifacts: [...artifacts.values()].filter(artifact => artifact.workflow_run.id === Number(path.match(/\/runs\/(\d+)/)[1])) };
    if (/\/actions\/artifacts\/\d+$/.test(path)) return artifacts.get(Number(path.split('/').at(-1)));
    if (/\/actions\/artifacts\/\d+\/zip$/.test(path)) return payloads.get(Number(path.split('/').at(-2)));
    if (path.endsWith('/actions/workflows/7')) return { path: '.github/workflows/runner-published.yml', state: 'active' };
    throw new Error(`Unexpected published proof transport ${path}`);
  };
  const replaceRecord = async id => record(id, artifacts.get(id).name, records.get(id), artifacts.get(id).workflow_run.id);
  const replaceManifest = async id => {
    const { manifest, directory } = manifests.get(id); await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest));
    payloads.set(id, await zipDirectory(directory)); artifacts.get(id).size_in_bytes = payloads.get(id).length;
  };
  return { ...f, api, calls, repository, sourceSha, registry, proofs, artifacts, records, manifests, runs, replaceRecord, replaceManifest,
    verify: () => qualificationReceipt(api, repository, 100, sourceSha, join(f.temporary, 'verification'), true) };
}

test('promotion verifies actual published fresh/resume runs, record producers and native checkpoints for both runner families', async t => {
  const f = await publishedFixture(t), receipt = await f.verify();
  assert.equal(receipt.published_smoke.length, 2); assert.deepEqual(receipt.published_smoke[0].run_ids, [201, 202]);
  assert.ok(f.calls.some(call => call.path.endsWith('/actions/runs/202/attempts/1')));
});

for (const variant of ['registry_only', 'checkout', 'release', 'outcome', 'producer', 'attempt', 'workflow', 'parent', 'config', 'session'])
  test(`published promotion rejects ${variant} evidence from actual runs and archives`, async t => {
    const f = await publishedFixture(t);
    if (variant === 'registry_only') { delete f.records.get(2).published_smoke; await f.replaceRecord(2); }
    if (variant === 'checkout') { f.records.get(1201).invocation.kind = 'checkout'; await f.replaceRecord(1201); }
    if (variant === 'release') { f.records.get(1202).invocation.release_id = 99; await f.replaceRecord(1202); }
    if (variant === 'outcome') { f.records.get(2201).status = 'completed'; await f.replaceRecord(2201); }
    if (variant === 'producer') f.artifacts.get(502).workflow_run.id = 201;
    if (variant === 'attempt') f.runs.get(202).run_attempt = 2;
    if (variant === 'workflow') f.runs.get(201).path = '.github/workflows/runner-task.yml';
    if (variant === 'parent') { f.records.get(1202).execution.parent_run_id = '99'; await f.replaceRecord(1202); }
    if (variant === 'config') { f.records.get(1202).execution.project_config.sha256 = 'f'.repeat(64); await f.replaceRecord(1202); }
    if (variant === 'session') { f.manifests.get(502).manifest.session_id = randomUUID(); await f.replaceManifest(502); }
    await assert.rejects(f.verify());
    assert.ok(!f.calls.some(call => call.method && call.method !== 'GET'));
  });

test('published aliases are invoked by separate gated jobs without a source-checkout fallback', async () => {
  const workflow = parse(await readFile(join(root, '.github/workflows/runner-published.yml'), 'utf8'));
  for (const [job, channel] of [['prerelease', 'v1-prerelease'], ['stable', 'v1']]) {
    const execution = workflow.jobs[job];
    assert.ok(execution.if.includes(`needs.resolve.outputs.published_ref == '${channel}'`));
    const native = execution.steps.filter(step => step.id === 'native');
    assert.equal(native.length, 1); assert.equal(native[0].uses, `markhuangai/agent-remote-dev-codex@${channel}`);
    assert.ok(!execution.steps.some(step => step.uses?.startsWith('./') || step.with?.path === 'action-source'));
  }
});

for (const variant of ['qualified', 'actor', 'maintainer', 'unmerged', 'source_mismatch', 'qualification_mismatch',
  'missing_workflow', 'workflow_failed', 'workflow_running', 'missing_job', 'job_failed', 'job_running'])
  test(`actual release authorization script ${variant} emits only a qualified build source`, async t => {
    const f = await publishedFixture(t), workflow = parse(await readFile(join(root, '.github/workflows/release.yml'), 'utf8'));
    const gate = workflow.jobs.authorize.steps.find(step => step.id === 'gate');
    assert.equal(workflow.jobs.authorize.outputs.qualified_source, '${{ steps.gate.outputs.source }}');
    assert.equal(workflow.jobs.build.needs, 'authorize');
    assert.equal(workflow.jobs.build.steps.find(step => step.name === 'Checkout exact qualified source').with.ref, '${{ needs.authorize.outputs.qualified_source }}');
    assert.equal(workflow.jobs.build.env.SOURCE_SHA, '${{ needs.authorize.outputs.qualified_source }}');
    if (variant === 'qualification_mismatch') { f.registry.source_sha = 'e'.repeat(40); await f.replaceRecord(1); }
    const sourceRuns = [
      { id: 801, path: '.github/workflows/ci.yml', names: ['CI', 'Runtime (linux-arm64)'] },
      { id: 802, path: '.github/workflows/codeql.yml', names: ['Analyze (actions)', 'Analyze (javascript-typescript)', 'CodeQL analysis'] },
    ].map(run => ({ ...run, head_sha: f.sourceSha, head_branch: 'main', status: 'completed', conclusion: 'success', run_attempt: 1 }));
    if (variant === 'missing_workflow') sourceRuns.pop();
    if (['workflow_failed', 'workflow_running'].includes(variant)) {
      sourceRuns.unshift({ ...sourceRuns[1], id: 800 });
      Object.assign(sourceRuns.at(-1), { status: variant === 'workflow_running' ? 'in_progress' : 'completed', conclusion: variant === 'workflow_running' ? null : 'failure' });
    }
    const api = async (path, options = {}) => {
      assert.equal(options.method ?? 'GET', 'GET', 'Authorization must never mutate release state');
      if (path.includes('/collaborators/')) return { permission: variant === 'maintainer' ? 'write' : 'admin' };
      if (path.endsWith(`/commits/${f.sourceSha}`)) return { sha: variant === 'source_mismatch' ? 'e'.repeat(40) : f.sourceSha };
      if (path.includes('/compare/')) return { status: variant === 'unmerged' ? 'diverged' : 'ahead' };
      if (path.endsWith('/git/ref/tags/v1') || path.endsWith('/git/ref/tags/v1.0.0') || path.endsWith('/releases/tags/v1.0.0')) throw Object.assign(new Error('not found'), { status: 404 });
      const release = { id: 9, tag_name: 'v1.0.0-rc.0', draft: false, prerelease: true, published_at: '2026-01-01T00:00:00Z' };
      if (path.includes('/releases?')) return [release];
      if (path.endsWith('/releases/9')) return release;
      if (path.endsWith('/git/ref/tags/v1.0.0-rc.0')) return { object: { type: 'commit', sha: f.sourceSha } };
      if (path.includes('/actions/runs?head_sha=')) return { workflow_runs: sourceRuns };
      const matched = /\/actions\/runs\/(801|802)\/jobs\?/.exec(path);
      if (matched) {
        const run = sourceRuns.find(run => run.id === Number(matched[1]));
        let jobs = run.names.map((name, index) => ({ id: run.id * 10 + index, name, run_attempt: 1, status: 'completed', conclusion: 'success' }));
        if (run.id === 802 && variant === 'missing_job') jobs.pop();
        if (run.id === 802 && ['job_failed', 'job_running'].includes(variant)) Object.assign(jobs[0], { status: variant === 'job_running' ? 'in_progress' : 'completed', conclusion: variant === 'job_running' ? null : 'failure' });
        return { jobs };
      }
      return f.api(path, options);
    };
    const outputs = new Map(), records = [], core = { setOutput: (name, value) => outputs.set(name, value),
      ...Object.fromEntries(['info', 'warning', 'error', 'debug'].map(level => [level, line => records.push(JSON.parse(line))])) };
    const env = { GITHUB_WORKSPACE: root, GITHUB_REF: 'refs/heads/main', GITHUB_RUN_ID: '999', GITHUB_RUN_ATTEMPT: '1', GITHUB_JOB: 'authorize',
      RUNNER_TEMP: f.temporary, TRIGGERING_ACTOR: 'Z-M-Huang', SOURCE_SHA: f.sourceSha, RELEASE_VERSION: 'v1.0.0', QUALIFICATION_RUN_ID: '100' };
    const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
    Object.assign(process.env, env);
    try {
      const context = { repo: { owner: 'markhuangai', repo: 'agent-remote-dev-codex' }, eventName: 'workflow_dispatch', actor: variant === 'actor' ? 'Outside-Operator' : 'Z-M-Huang' };
      const github = { request: async (route, options) => ({ data: await api(route.replace(/^[A-Z]+ /, ''), options) }) };
      const invoke = () => new (Object.getPrototypeOf(async function () {}).constructor)('require', 'github', 'context', 'core', gate.with.script)(createRequire(import.meta.url), github, context, core);
      if (variant === 'qualified') {
        await invoke(); assert.deepEqual([...outputs], [['source', f.sourceSha]]);
        assert.ok(records.some(record => record.event === 'release.verify' && record.outcome === 'qualified' && record.source_sha === f.sourceSha));
      } else {
        const reason = ({ actor: 'untrusted_task_actor', maintainer: 'release_maintainer_required', unmerged: 'release_source_not_merged', source_mismatch: 'invalid_release_source',
          qualification_mismatch: 'qualification_matrix_incomplete' })[variant] ?? (variant.startsWith('job_') || variant === 'missing_job' ? 'release_source_check_failed' : 'release_source_workflow_incomplete');
        await assert.rejects(invoke(), new RegExp(reason)); assert.equal(outputs.size, 0);
        assert.ok(records.some(record => record.event === 'release.verify' && record.level === 'ERROR' && record.reason === reason && record.outcome === 'blocked'));
      }
    } finally {
      for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    }
  });
