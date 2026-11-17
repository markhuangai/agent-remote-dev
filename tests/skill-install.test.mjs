import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { configure, installSkillSource } from '../.build/setup.js';
import { runCodex } from '../.build/codex.js';
import { fixture, message, provider, repository, root, tool } from './helpers.mjs';

test('the actual Skills CLI installs a standalone Markdown skill discovered by native Codex with real gh available', async t => {
  const f = await fixture(t), r = await repository(f);
  await installSkillSource(f.job, { repository: 'fixture/source', revision: 'a'.repeat(40), names: ['remote-dev'] }, root, 0, f.log);
  const installed = join(f.job.runnerHome, 'skills/remote-dev');
  assert.deepEqual(await readdir(installed), ['SKILL.md']);
  assert.equal(await readFile(join(installed, 'SKILL.md'), 'utf8'), await readFile(join(root, 'skills/remote-dev/SKILL.md'), 'utf8'));
  const api = await provider(t, [[tool('gh --version')], [message('GitHub CLI is available; no workflow dispatched.')]]);
  await configure(f.job, api.config, f.log);
  const result = await runCodex(f.job, r.cwd, 'Use $remote-dev to inspect available tooling without dispatching any workflow.', f.log, 60000, 'installed');
  assert.match(result.result, /GitHub CLI is available/);
  assert.match(JSON.stringify(api.requests), /Hand a task to a repository/);
  for (const [name, value] of Object.entries(f.hostFiles)) assert.equal(await readFile(join(f.host, name), 'utf8'), value);
});
