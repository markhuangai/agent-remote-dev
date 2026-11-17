import assert from 'node:assert/strict';
import test from 'node:test';
import { authorizeActors, parseProjectConfig } from '../src/platform/project-config.mjs';

const content = 'allowed-actors: [Z-M-Huang]\nskills: []\n';
test('current project YAML validates selected skills, identity, instructions and continuation defaults', () => {
  const value = parseProjectConfig(content + 'user-level-agents.md-url: https://example.invalid/AGENTS.md\n');
  assert.equal(value.user_agents_url, 'https://example.invalid/AGENTS.md'); assert.deepEqual(value.skills, []);
  assert.equal(value.auto_continue, false); assert.equal(value.max_continuations, 3); assert.equal(value.git_author_name, 'github-actions[bot]');
  for (const invalid of [content + 'skills: []\n', 'allowed-actors: &actors [Z-M-Huang]\nskills: *actors\n',
    'allowed-actors: !custom [Z-M-Huang]\n', content + 'skills: [', content + 'github-token: secret\n', content + 'runner: [ubuntu-latest]\n',
    content + 'budget-minutes: 300\n', content + 'git-author: {name: "bad\\nname", email: fixture@example.invalid}\n', content + 'max-continuations: -1\n']) assert.throws(() => parseProjectConfig(invalid));
});
test('authorization reads the latest configuration on a consumer default branch and checks both actors', async () => {
  let config = content, permission = 'write'; const calls = [];
  const api = async path => {
    calls.push(path);
    if (path === '/repos/fixture/repo') return { default_branch: 'trunk' };
    if (path.endsWith('/commits/trunk')) return { sha: 'b'.repeat(40) };
    if (path.includes('/contents/.remote-codex.yml?')) { const bytes = Buffer.from(config); return { encoding: 'base64', type: 'file', size: bytes.length, content: bytes.toString('base64') }; }
    if (path.includes('/collaborators/')) return { permission };
    throw new Error(`Unexpected request ${path}`);
  };
  const first = await authorizeActors(api, 'fixture/repo', 'Z-M-Huang');
  assert.equal(first.branch, 'trunk'); assert.equal(first.revision, 'b'.repeat(40));
  config = content + 'max-continuations: 1\n'; assert.equal((await authorizeActors(api, 'fixture/repo', 'Z-M-Huang')).settings.max_continuations, 1);
  permission = 'read'; await assert.rejects(authorizeActors(api, 'fixture/repo', 'Z-M-Huang'), /operator_write_permission_required/);
  permission = 'write'; await assert.rejects(authorizeActors(api, 'fixture/repo', 'Z-M-Huang', 'different-operator'), /untrusted_task_actor/);
  assert.ok(calls.some(path => path.includes('/contents/.remote-codex.yml?ref=' + 'b'.repeat(40))));
});
