import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { parseProjectConfig } from '../.github/remote-codex/project-config.mjs';
import { actionResources, invocationSource, prepareInvocation } from '../.build/invocation.js';
import { hash } from '../.build/contracts.js';
import { exec, fixture } from './helpers.mjs';

const content = 'allowed-actors: [Z-M-Huang]\nskills: []\n';
function transport() {
  const state = { content, permission: 'write', calls: [] };
  const api = async path => {
    state.calls.push(path);
    if (path.includes('/git/ref/heads/main')) return { object: { sha: 'a'.repeat(40) } };
    if (path.includes('/collaborators/')) return { permission: state.permission };
    if (path.includes('/contents/remote-codex.yml?')) {
      if (state.missing) throw Object.assign(new Error('private-transport-body'), { status: 404 });
      const bytes = Buffer.from(state.content);
      return { type: 'file', encoding: 'base64', size: bytes.length, content: bytes.toString('base64') };
    }
    if (path.includes('/commits/')) return { sha: 'b'.repeat(40) };
    if (path.includes('/actions/runs?')) return { workflow_runs: [] };
    throw new Error(`Unexpected GitHub transport ${path}`);
  };
  return { state, api };
}
test('project YAML supports the exact user-level AGENTS.md key and validated defaults', () => {
  const value = parseProjectConfig(content + 'user-level-agents.md-url: https://example.invalid/AGENTS.md\n');
  assert.equal(value.user_agents_url, 'https://example.invalid/AGENTS.md');
  assert.deepEqual(value.skills, []); assert.deepEqual(value.runner, ['ubuntu-latest']); assert.equal(value.auto_continue, false);
  assert.equal(value.git_author_name, 'github-actions[bot]'); assert.equal(value.budget_minutes, 300);
  for (const invalid of [
    content + 'user-agents-url: https://example.invalid/AGENTS.md\n', content + 'skills: []\n',
    'allowed-actors: &actors [Z-M-Huang]\nskills: *actors\n', 'allowed-actors: !custom [Z-M-Huang]\n',
    content + 'skills: [', content + 'github-token: secret\n', content + 'runner: [windows-latest]\n',
    content + 'git-author: {name: "bad\\nname", email: fixture@example.invalid}\n', content + 'budget-minutes: 1\n',
  ]) assert.throws(() => parseProjectConfig(invalid));
});
test('a standalone action prepares native execution with only a plan and repository settings, without the client kit', async t => {
  const f = await fixture(t), { state, api } = transport();
  const plan = 'Implement https://github.com/fixture/repo/issues/4 using $selected-skill.\n';
  const records = [], core = Object.fromEntries(['info', 'warning', 'error', 'debug'].map(level => [level, line => records.push(JSON.parse(line))]));
  const env = { GITHUB_REPOSITORY: 'fixture/repo', GITHUB_ACTOR: 'Z-M-Huang', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/main',
    GITHUB_RUN_ID: '200', GITHUB_RUN_ATTEMPT: '1', GITHUB_JOB: 'execute', GITHUB_WORKFLOW_SHA: 'a'.repeat(40),
    GITHUB_WORKFLOW_REF: 'fixture/repo/.github/workflows/custom.yml@refs/heads/main', RUNNER_TEMP: f.temporary };
  const call = () => prepareInvocation({ api, plan, source: { repository: 'fixture/action', sha: 'b'.repeat(40) }, core, env });
  const verified = await call(), execution = JSON.parse(verified.execution);
  assert.equal(verified.plan, plan); assert.equal(verified.task_id, '200'); assert.equal(execution.root_run_id, '200');
  assert.equal(execution.project_config.content, content); assert.equal(execution.project_config.sha256, hash(content));
  assert.equal(execution.auto_continue, false); assert.equal(verified.skills, '[]');
  assert.ok(!state.calls.some(path => /issues|graphql|protocol.json|actions\/workflows/.test(path)));
  assert.ok(records.some(record => record.event === 'submission.resolve' && record.outcome === 'verified'));
  assert.ok(!JSON.stringify(records).includes(plan.trim()));
  state.permission = 'read'; await assert.rejects(call(), /operator_write_permission_required/);
  state.permission = 'write'; state.content = content.replace('Z-M-Huang', 'different-operator');
  await assert.rejects(call(), /untrusted_task_actor/);
  state.missing = true; await assert.rejects(call(), /project_config_unavailable/);
});
test('published and local action invocations derive provenance and verify actual executable resource bytes', async t => {
  const f = await fixture(t), root = join(f.temporary, 'action');
  await mkdir(root);
  const git = async args => (await exec('git', args, { cwd: root, env: f.job.env })).stdout;
  await git(['init', '--initial-branch=main']);
  await git(['remote', 'add', 'origin', 'https://github.com/fixture/action.git']);
  const tree = [];
  for (const path of actionResources) {
    const file = join(root, path), bytes = Buffer.from(`Actual fixture resource ${path}\n`);
    await mkdir(join(file, '..'), { recursive: true }); await writeFile(file, bytes);
    tree.push({ type: 'blob', path, sha: createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex') });
  }
  await git(['add', '.']); await git(['commit', '-m', 'Action fixture']);
  const sha = (await git(['rev-parse', 'HEAD'])).trim();
  const api = async path => path.includes('/commits/') ? { sha } : { tree, truncated: false };
  const published = await invocationSource(api, root, { GITHUB_ACTION_REPOSITORY: 'fixture/action', GITHUB_ACTION_REF: 'main' }, git);
  assert.equal(published.sha, sha); assert.equal(published.repository, 'fixture/action'); assert.equal(published.kind, 'published');
  assert.equal((await invocationSource(api, root, {}, git)).kind, 'checkout');
  await assert.rejects(invocationSource(api, root, { GITHUB_ACTION_REPOSITORY: 'fixture/action' }, git), { reason: 'unknown_action_source' });
  await writeFile(join(root, 'dist/index.js'), 'Changed downloaded executable');
  await assert.rejects(invocationSource(api, root, { GITHUB_ACTION_REPOSITORY: 'fixture/action', GITHUB_ACTION_REF: 'main' }, git), error => {
    assert.equal(error.reason, 'action_source_resource_mismatch'); assert.equal(error.details.resource_path, 'dist/index.js');
    assert.equal(error.details.source_sha, sha); assert.notEqual(error.details.expected, error.details.observed); return true;
  });
  assert.equal(await readFile(join(root, 'dist/index.js'), 'utf8'), 'Changed downloaded executable');
  await writeFile(join(root, 'dist/index.js'), 'Actual fixture resource dist/index.js\n');
  await rename(join(root, 'dist/supervise.py'), join(root, 'held-supervise.py'));
  await assert.rejects(invocationSource(api, root, { GITHUB_ACTION_REPOSITORY: 'fixture/action', GITHUB_ACTION_REF: 'main' }, git), error => {
    assert.equal(error.reason, 'action_source_resource_missing'); assert.equal(error.details.resource_path, 'dist/supervise.py'); return true;
  });
});
