import assert from 'node:assert/strict';
import { chmod, cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { configure, installSkillSource, installUserAgents } from '../.build/setup.js';
import { runCodex } from '../.build/codex.js';
import { TaskGit } from '../.build/git.js';
import { drive } from '../.build/driver.js';
import { durableCheckpoint } from '../.build/checkpoint.js';
import { restoreCheckpoint, validateCheckpoint } from '../.build/resume.js';
import { hash } from '../.build/contracts.js';
import { fetchInstructions } from '../.github/remote-codex/instructions.mjs';
import { exec, execution, fixture, lineage, message, provider, repository, tool } from './helpers.mjs';

const plan = 'Execute the selected workflow; its response is opaque to the host.';
const quote = value => "'" + value.replaceAll("'", "'\"'\"'") + "'";
async function driver(f, r, overrides = {}) {
  const git = overrides.git ?? new TaskGit(r.cwd, f.job.env, f.log), exports = [], results = [];
  const result = await drive({ job: f.job, git, log: f.log, plan, planSource: 'inline', authorization: { repository: 'fixture/repo', plan_sha256: hash(plan), request: 'Execute this fixture with its selected workflow and bounded resume.' },
    repository: 'fixture/repo', taskId: 'fixture-task', base: r.base, budgetMs: 180000, started: Date.now(), skills: [], userAgents: null, lineage, execution: execution(),
    checkpoint: input => durableCheckpoint(f.job, input, f.log, sha => git.verify(sha), async (name, files, root) => { exports.push({ name, files, root }); return { id: 40 + exports.length }; }),
    result: async value => { results.push(value); }, ...overrides });
  return { result, git, exports, results };
}
test('real Codex discovers selected user skills, repository skills and both instruction scopes without host state', async t => {
  const f = await fixture(t), r = await repository(f), source = join(f.temporary, 'skills');
  await mkdir(join(source, 'skills/fixture-selected/references'), { recursive: true });
  await writeFile(join(source, 'skills/fixture-selected/SKILL.md'), '---\nname: fixture-selected\ndescription: selected-user-catalog-3719\n---\nRead references/detail.txt when needed.\n');
  await writeFile(join(source, 'skills/fixture-selected/references/detail.txt'), 'Complete installed resource');
  await installSkillSource(f.job, { repository: 'fixture/skills', revision: 'a'.repeat(40), names: ['fixture-selected'] }, source, 0, f.log);
  await mkdir(join(r.cwd, '.agents/skills/repo-native'), { recursive: true });
  await writeFile(join(r.cwd, '.agents/skills/repo-native/SKILL.md'), '---\nname: repo-native\ndescription: repository-catalog-5931\n---\nUse native repository behavior.\n');
  await writeFile(join(r.cwd, 'AGENTS.md'), 'repository-instructions-7751\n');
  const content = 'user-instructions-8654\n';
  await installUserAgents(f.job, { url: 'https://example.invalid/AGENTS.md', sha256: hash(content), content }, f.log);
  const api = await provider(t, [[message('An ordinary native result.')], [message('Still the same conversation.')]]);
  await configure(f.job, api.config, f.log);
  const first = await runCodex(f.job, r.cwd, 'Use $fixture-selected and $repo-native.', f.log, 60000, 'one');
  assert.equal(first.result.trim(), 'An ordinary native result.');
  const second = await runCodex(f.job, r.cwd, 'Continue this native conversation.', f.log, 60000, 'two', first.session);
  assert.equal(second.session, first.session);
  const captured = JSON.stringify(api.requests);
  for (const marker of ['selected-user-catalog-3719', 'repository-catalog-5931', 'repository-instructions-7751', 'user-instructions-8654', 'Use $fixture-selected']) assert.match(captured, new RegExp(marker.replaceAll('$', '\\$')));
  assert.doesNotMatch(captured, /unwanted-host-sentinel-3719|unwanted-host-instructions-3819|host-config-sentinel-6158/);
  assert.equal(await readFile(join(f.job.codexHome, 'skills/fixture-selected/references/detail.txt'), 'utf8'), 'Complete installed resource');
  for (const [name, value] of Object.entries(f.hostFiles)) assert.equal(await readFile(join(f.host, name), 'utf8'), value);
});
test('a native workflow chooses its branch, commits and pushes without supervisor publication or a PR', async t => {
  const f = await fixture(t), r = await repository(f);
  const api = await provider(t, [[tool("git switch -c skill/chosen-branch && printf 'published by skill\\n' > native.txt && git add native.txt && git commit -m 'Skill publishes its work' && git push --set-upstream origin HEAD")], [message('Finished without creating a PR.')]]);
  await configure(f.job, api.config, f.log);
  const observed = await driver(f, r);
  assert.equal(observed.result.status, 'completed'); assert.equal(observed.result.nativeOutcome, 'succeeded');
  assert.equal(await r.git('branch', '--show-current'), 'skill/chosen-branch');
  assert.equal(await r.git('log', '-1', '--format=%s'), 'Skill publishes its work');
  assert.equal(await observed.git.remoteHead(), await observed.git.head());
  assert.equal(observed.results[0].response.trim(), 'Finished without creating a PR.');
  const manifest = JSON.parse(await readFile(join(observed.exports[0].root, 'manifest.json'), 'utf8'));
  assert.equal(manifest.schema_version, 3); assert.equal(manifest.session_id, observed.result.session); assert.deepEqual(manifest.skills, []);
  assert.equal(manifest.branch, 'skill/chosen-branch'); assert.ok(!('driver' in manifest)); assert.ok(!('audit' in manifest));
});
test('unpublished changes and skill-reported blockers stay opaque and never trigger runner Git repairs', async t => {
  const f = await fixture(t), r = await repository(f), response = JSON.stringify({ state: 'blocked', missing: 'human decision', pr: null });
  const api = await provider(t, [[tool("printf 'unpublished skill state\\n' > draft.txt")], [message(response)]]);
  await configure(f.job, api.config, f.log);
  const observed = await driver(f, r);
  assert.equal(observed.result.status, 'completed'); assert.equal(observed.result.nativeOutcome, 'succeeded'); assert.equal(observed.result.checkpoint, null);
  assert.equal(observed.results[0].response.trim(), response); assert.equal(await r.git('rev-parse', 'HEAD'), r.base);
  assert.equal(await r.git('diff', '--cached', '--name-only'), ''); assert.equal(await readFile(join(r.cwd, 'draft.txt'), 'utf8'), 'unpublished skill state\n');
  assert.ok(f.records.some(record => record.event === 'checkpoint.unavailable' && record.reason === 'checkpoint_head_mismatch'));
});
test('a real rejected skill push leaves the native response intact and cannot produce a resumable checkpoint', async t => {
  const f = await fixture(t), r = await repository(f), hook = join(r.remote, 'hooks/pre-receive');
  await writeFile(hook, '#!/bin/sh\nexit 1\n', { mode: 0o700 }); await chmod(hook, 0o700);
  const api = await provider(t, [[tool("git switch -c skill/rejected-push && printf local > local.txt && git add local.txt && git commit -m 'Skill records unpublished work' && git push --set-upstream origin HEAD")], [message('The skill push was rejected; human intervention is required.')]]);
  await configure(f.job, api.config, f.log);
  const observed = await driver(f, r);
  assert.equal(observed.result.status, 'completed'); assert.equal(observed.result.nativeOutcome, 'succeeded'); assert.equal(observed.result.checkpoint, null);
  assert.match(observed.results[0].response, /push was rejected/); assert.equal(observed.exports.length, 0);
  assert.notEqual(await r.git('rev-parse', 'HEAD'), r.base); assert.equal(await r.git('diff', '--cached', '--name-only'), '');
  assert.equal(await r.git('ls-remote', '--heads', 'origin', 'refs/heads/skill/rejected-push'), '');
  assert.ok(f.records.some(record => record.event === 'checkpoint.unavailable' && record.reason === 'checkpoint_head_mismatch' && record.observed_sha === null));
});
test('real native authentication errors retain a causal stage without provider bodies or credentials', async t => {
  const f = await fixture(t), r = await repository(f), api = await provider(t, () => ({ status: 403, body: { error: { message: 'private-provider-body-5741', api_key: f.job.env.CODEX_API_KEY } } }));
  await configure(f.job, api.config, f.log);
  await assert.rejects(runCodex(f.job, r.cwd, 'Fixture request', f.log, 20000, 'auth'), error => { f.log.failure(error); return true; });
  assert.doesNotMatch(JSON.stringify(f.records), /private-provider-body-5741|fixture-api-credential-9374/);
  assert.ok(f.records.some(record => record.event === 'runtime.failed' && record.stage === 'codex'));
});
test('real cold restore preserves the session and frozen user instructions while the skill advances its own branch', async t => {
  const f = await fixture(t), r = await repository(f), content = '\ufefffrozen-user-instructions-6514\n', bytes = Buffer.from(content);
  const userAgents = await fetchInstructions('https://example.invalid/AGENTS.md', hash(bytes), async () => new Response(bytes));
  assert.equal(userAgents.sha256, hash(bytes)); assert.equal(userAgents.content, content);
  const firstProvider = await provider(t, [[tool("printf first > state.txt && git add state.txt && git commit -m 'First skill turn' && git push --set-upstream origin HEAD")], [message('First skill turn done.')]]);
  await configure(f.job, firstProvider.config, f.log); await installUserAgents(f.job, userAgents, f.log);
  assert.deepEqual(await readFile(join(f.job.codexHome, 'AGENTS.md')), bytes);
  const first = await driver(f, r, { userAgents, execution: execution({ user_agents_url: userAgents.url, user_agents_sha256: userAgents.sha256 }) });
  const manifest = validateCheckpoint(JSON.parse(await readFile(join(first.exports[0].root, 'manifest.json'), 'utf8')), 'fixture/repo');
  const fresh = await fixture(t), cwd = join(fresh.temporary, 'relocated-repository');
  await exec('git', ['clone', '--branch', 'main', r.remote, cwd], { env: fresh.job.env });
  const secondProvider = await provider(t, [[tool("printf second > state.txt && git add state.txt && git commit -m 'Second skill turn' && git push origin HEAD")], [message('Resumed skill completed.')]]);
  await configure(fresh.job, secondProvider.config, fresh.log); await installUserAgents(fresh.job, manifest.user_agents, fresh.log);
  assert.equal(manifest.user_agents.sha256, hash(bytes)); assert.deepEqual(await readFile(join(fresh.job.codexHome, 'AGENTS.md')), bytes);
  const git = new TaskGit(cwd, fresh.job.env, fresh.log);
  await restoreCheckpoint(fresh.job, first.exports[0].root, manifest, git, fresh.log);
  const second = await driver(fresh, { cwd, base: r.base }, { git, userAgents: manifest.user_agents, execution: execution({ ...manifest.execution, continuation_count: 1,
    parent_run_id: '13', parent_run_attempt: '1', activation_run_id: '15' }), resume: { session: manifest.session_id, checkpoint: first.result.checkpoint } });
  assert.equal(second.result.session, first.result.session); assert.equal(second.result.status, 'completed');
  assert.equal(await readFile(join(cwd, 'state.txt'), 'utf8'), 'second'); assert.notEqual(second.result.checkpoint.checkpoint_sha, first.result.checkpoint.checkpoint_sha);
  assert.match(JSON.stringify(secondProvider.requests), /First skill turn done|frozen-user-instructions-6514/);
  const db = new DatabaseSync(join(fresh.job.codexHome, 'state_5.sqlite'), { readOnly: true });
  try { const row = db.prepare('SELECT cwd, rollout_path FROM threads WHERE id = ?').get(manifest.session_id); assert.equal(row.cwd, cwd); assert.ok(row.rollout_path.startsWith(fresh.job.codexHome)); }
  finally { db.close(); }
});
for (const interruption of ['budget', 'SIGTERM', 'SIGINT']) test(`native ${interruption} interruption checkpoints only quiescent remotely published source`, async t => {
  const f = await fixture(t), r = await repository(f);
  const api = await provider(t, [[tool("printf saved > saved.txt && git add saved.txt && git commit -m 'Skill saves progress' && git push --set-upstream origin HEAD")], { hang: true }]);
  await configure(f.job, api.config, f.log);
  let timer;
  if (interruption !== 'budget') {
    const send = async () => {
      if (api.requests.length >= 2 && process.listenerCount(interruption) > 0) process.kill(process.pid, interruption);
      else timer = setTimeout(send, 100);
    };
    timer = setTimeout(send, 100);
  }
  t.after(() => clearTimeout(timer));
  const observed = await driver(f, r, { started: interruption === 'budget' ? Date.now() - 50000 : Date.now() });
  assert.equal(observed.result.status, interruption === 'budget' ? 'continuing' : 'cancelled');
  assert.equal(observed.result.nativeOutcome, interruption === 'budget' ? 'timed_out' : 'cancelled');
  assert.ok(observed.result.checkpoint); assert.equal(observed.result.checkpoint.checkpoint_sha, await observed.git.remoteHead());
  const record = f.records.findLast(record => ['runtime.deadline', 'runtime.cancelled'].includes(record.event));
  assert.equal(record.last_durable_checkpoint.artifact_id, observed.result.checkpoint.artifact_id);
  assert.notEqual(record.level, 'DEBUG'); assert.equal(record.stage, 'codex'); assert.equal(record.versions.codex, '0.169.0');
  assert.equal(record.session_id, observed.result.session); assert.equal(record.cause_reason, interruption === 'budget' ? 'command_timeout' : 'command_cancelled');
  assert.ok(Object.hasOwn(record, 'exit_code')); assert.ok(Object.hasOwn(record, 'signal')); assert.equal(typeof record.native_cause, 'string');
  assert.ok(record.native_elapsed_ms > 0); assert.ok(record.timeout_ms > 0); assert.ok(Number.isFinite(record.deadline_ms)); assert.ok(record.action_deadline_ms > record.deadline_ms);
});
