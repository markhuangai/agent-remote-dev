import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { parseProjectConfig } from '../src/platform/project-config.mjs';
import { invocationSource, prepareInvocation } from '../.build/invocation.js';
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
  assert.deepEqual(value.skills, []); assert.equal(value.auto_continue, false);
  assert.equal(value.git_author_name, 'github-actions[bot]'); assert.equal(value.budget_minutes, 300);
  for (const invalid of [
    content + 'user-agents-url: https://example.invalid/AGENTS.md\n', content + 'skills: []\n',
    'allowed-actors: &actors [Z-M-Huang]\nskills: *actors\n', 'allowed-actors: !custom [Z-M-Huang]\n',
    content + 'skills: [', content + 'github-token: secret\n', content + 'runner: [windows-latest]\n', content + 'runner: [ubuntu-latest]\n',
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
  const verified = await call(), execution = verified.execution;
  assert.equal(verified.plan, plan); assert.equal(verified.taskId, '200'); assert.equal(execution.root_run_id, '200');
  assert.equal(execution.project_config.content, content); assert.equal(execution.project_config.sha256, hash(content));
  assert.equal(execution.auto_continue, false); assert.deepEqual(verified.skills, []);
  assert.deepEqual(verified.authorization, { repository: 'fixture/repo', plan_sha256: hash(plan), request: plan });
  assert.equal(verified.resumeArtifactId, '');
  assert.ok(!state.calls.some(path => /issues|graphql|protocol.json|actions\/workflows/.test(path)));
  assert.ok(records.some(record => record.event === 'submission.resolve' && record.outcome === 'verified'));
  assert.ok(!JSON.stringify(records).includes(plan.trim()));
  state.permission = 'read'; await assert.rejects(call(), /operator_write_permission_required/);
  state.permission = 'write'; state.content = content.replace('Z-M-Huang', 'different-operator');
  await assert.rejects(call(), /untrusted_task_actor/);
  state.missing = true; await assert.rejects(call(), /project_config_unavailable/);
});
test('action source metadata does not download or reverify the installed package inventory', async t => {
  const f = await fixture(t), root = join(f.temporary, 'action');
  await mkdir(root);
  const git = async args => (await exec('git', args, { cwd: root, env: f.job.env })).stdout;
  await git(['init', '--initial-branch=main']);
  await git(['remote', 'add', 'origin', 'https://github.com/fixture/action.git']);
  await writeFile(join(root, 'README.md'), 'Fixture source');
  await git(['add', '.']); await git(['commit', '-m', 'Action fixture']);
  const sha = (await git(['rev-parse', 'HEAD'])).trim(), calls = [];
  const api = async path => { calls.push(path); assert.ok(path.includes('/commits/')); return { sha }; };
  const published = await invocationSource(api, root, { GITHUB_ACTION_REPOSITORY: 'fixture/action', GITHUB_ACTION_REF: 'main' }, git);
  assert.equal(published.sha, sha); assert.equal(published.kind, 'published');
  assert.equal((await invocationSource(api, root, {}, git)).kind, 'checkout');
  assert.equal(calls.length, 2);
});
