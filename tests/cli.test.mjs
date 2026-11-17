import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { configure, installSkillSource, installUserAgents } from '../.build/setup.js';
import { logCodexActivity, runCodex } from '../.build/codex.js';
import { TaskGit } from '../.build/git.js';
import { drive } from '../.build/driver.js';
import { durableCheckpoint } from '../.build/checkpoint.js';
import { restoreCheckpoint, validateCheckpoint } from '../.build/resume.js';
import { exec, checkpoint, fixture, logger, message, provider, repository, tool } from './helpers.mjs';

const plan = 'Implement the supplied plan autonomously. Ask only when clarification is indispensable.';
test('real Codex streams reads, edits and command failures without logging their output', async t => {
  const f = await fixture(t), r = await repository(f);
  await writeFile(join(r.cwd, 'private-output.txt'), 'private-tool-output-9158\n');
  const patch = '*** Begin Patch\n*** Update File: README.md\n@@\n-Fixture repository\n+private-patch-content-7281\n*** End Patch';
  const api = await provider(t, [[tool('cat README.md', 'read')],
    [tool(`apply_patch <<'PATCH'\n${patch}\nPATCH`, 'edit')],
    [tool("printf '%s' 'fixture-api-credential-9374'; cat private-output.txt; exit 7", 'failure')],
    [message('private-agent-message-1682')]]);
  await configure(f.job, api.config, f.log);
  const result = await runCodex(f.job, r.cwd, 'private-task-prompt-4197', f.log, 60000, 'activity');
  assert.equal(await readFile(join(r.cwd, 'README.md'), 'utf8'), 'private-patch-content-7281\n');
  const records = f.records.filter(record => record.event === 'runtime.tool');
  const commands = records.filter(record => record.item_type === 'command_execution');
  assert.deepEqual(commands.map(record => record.phase), ['started', 'completed', 'started', 'completed']);
  assert.equal(commands[0].item_id, commands[1].item_id);
  assert.equal(commands[2].item_id, commands[3].item_id);
  assert.match(commands[0].command, /cat README\.md/);
  assert.equal(commands[1].exit_code, 0);
  assert.equal(commands[3].exit_code, 7); assert.equal(commands[3].level, 'WARN');
  const edits = records.filter(record => record.item_type === 'file_change');
  assert.deepEqual(edits.map(record => record.phase), ['started', 'completed']);
  assert.equal(edits[0].item_id, edits[1].item_id);
  const edit = edits[1]; assert.equal(edit.status, 'completed');
  assert.equal(edit.changes.length, 1); assert.ok(edit.changes[0].path.endsWith('README.md'));
  assert.equal(edit.changes[0].kind, 'update');
  for (const record of records) {
    assert.equal(record.session_id, result.session);
    assert.equal(record.run_id, '13'); assert.equal(record.run_attempt, '1');
  }
  const logged = JSON.stringify(records);
  assert.match(logged, /\[redacted\]/);
  assert.doesNotMatch(logged, /Fixture repository|private-tool-output-9158|private-patch-content-7281|private-agent-message-1682|private-task-prompt-4197|fixture-api-credential-9374/);
});
test('native activity logs allowlisted metadata with bounded changes and no argument bodies', () => {
  const { log, records } = logger();
  const item = (type, fields = {}) => ({ type: 'item.completed', item: { id: 'item-1', type, ...fields } });
  for (const event of [
    item('mcp_tool_call', { server: 'github', tool: 'get_issue', status: 'failed', arguments: { private: 'private-arguments' }, result: { text: 'private-result' }, error: { message: 'private-error' } }),
    item('collab_tool_call', { tool: 'spawn_agent', receiver_thread_ids: ['child-session'], status: 'completed', prompt: 'private-delegation', agents_states: { child: { message: 'private-agent-result' } } }),
    item('web_search', { query: 'private-query', action: { type: 'search' }, results: ['private-search-result'] }),
    item('command_execution', { command: 'cat README.md\nprivate-command-body', aggregated_output: 'private-command-output', exit_code: 0, status: 'completed' }),
    item('command_execution', { command: 'x'.repeat(1000), exit_code: 0, status: 'completed' }),
    item('file_change', { changes: Array.from({ length: 105 }, (_, index) => ({ path: `file-${index}`, kind: 'update', diff: 'private-diff' })), status: 'completed' }),
  ]) logCodexActivity(log, event, 'session-1');
  assert.equal(records.length, 6); assert.equal(records[0].level, 'WARN');
  assert.equal(records[0].server, 'github'); assert.equal(records[0].tool, 'get_issue');
  assert.deepEqual(records[1].receiver_thread_ids, ['child-session']); assert.equal(records[1].tool, 'spawn_agent');
  assert.equal(records[2].action, 'search'); assert.equal(records[3].command, 'cat README.md');
  assert.equal(records[4].truncated, true); assert.match(records[4].command, /truncated/);
  assert.equal(records[5].changes.length, 100); assert.equal(records[5].omitted_changes, 5);
  for (const type of ['agent_message', 'reasoning', 'todo_list', 'error', 'unknown']) logCodexActivity(log, item(type, { text: 'private-text' }), 'session-1');
  logCodexActivity(log, { type: 'item.updated', item: { id: 'item-1', type: 'command_execution', command: 'private-update' } }, 'session-1');
  assert.equal(records.length, 6); assert.doesNotMatch(JSON.stringify(records), /private-/);
});
async function driver(f, r, overrides = {}) {
  const git = new TaskGit(r.cwd, f.job.env, f.log), exports = []; let last = null, state;
  const save = async (session, control, outcome = 'running') => {
    const input = checkpoint({ ...await git.snapshot(), session_id: session, workspace: r.cwd, outcome, previous: last });
    last = await durableCheckpoint(f.job, input, f.log, async (name, files, root) => {
      const directory = await mkdtemp(join(f.temporary, 'artifact-'));
      for (const file of files) { const target = join(directory, relative(root, file)); await mkdir(join(target, '..'), { recursive: true }); await cp(file, target); }
      exports.push({ name, root: directory }); return { id: 40 + exports.length };
    }, control);
    return last;
  };
  const result = await drive({ job: f.job, cwd: r.cwd, log: f.log, plan,
    state: async value => { state = { ...state, ...value }; }, ...overrides });
  if (state.session) await save(state.session, undefined, state.outcome);
  return { result: { ...result, checkpoint: last }, git, exports };
}
test('real Codex discovers selected user skills, repository skills and both instruction scopes', async t => {
  const f = await fixture(t), r = await repository(f), source = join(f.temporary, 'skills');
  await mkdir(join(source, 'skills/fixture-selected/references'), { recursive: true });
  await writeFile(join(source, 'skills/fixture-selected/SKILL.md'), '---\nname: fixture-selected\ndescription: selected-user-catalog-3719\n---\nRead references/detail.txt when needed.\n');
  await writeFile(join(source, 'skills/fixture-selected/references/detail.txt'), 'Complete installed resource');
  await installSkillSource(f.job, { repository: 'fixture/skills', revision: 'a'.repeat(40), names: ['fixture-selected'] }, source, 0, f.log);
  await mkdir(join(r.cwd, '.agents/skills/repo-native'), { recursive: true });
  await writeFile(join(r.cwd, '.agents/skills/repo-native/SKILL.md'), '---\nname: repo-native\ndescription: repository-catalog-5931\n---\nUse native repository behavior.\n');
  await writeFile(join(r.cwd, 'AGENTS.md'), 'repository-instructions-7751\n');
  await installUserAgents(f.job, { url: 'https://example.invalid/AGENTS.md', sha256: (await import('../.build/contracts.js')).hash('user-instructions-8654\n'), content: 'user-instructions-8654\n' }, f.log);
  const api = await provider(t, [[message('An ordinary native result.')], [message('Still the same conversation.')]]);
  await configure(f.job, api.config, f.log);
  const first = await runCodex(f.job, r.cwd, 'Use $fixture-selected and $repo-native.', f.log, 60000, 'one');
  const second = await runCodex(f.job, r.cwd, 'Continue this native conversation.', f.log, 60000, 'two', first.session);
  assert.equal(second.session, first.session);
  const captured = JSON.stringify(api.requests);
  for (const marker of ['selected-user-catalog-3719', 'repository-catalog-5931', 'repository-instructions-7751', 'user-instructions-8654']) assert.ok(captured.includes(marker));
  assert.doesNotMatch(captured, /unwanted-host-sentinel|unwanted-host-instructions|host-config-sentinel/);
  for (const [name, value] of Object.entries(f.hostFiles)) assert.equal(await readFile(join(f.host, name), 'utf8'), value);
});
test('native Codex chooses its branch, commits and pushes without runner publication', async t => {
  const f = await fixture(t), r = await repository(f);
  const api = await provider(t, [[(await import('./helpers.mjs')).tool("git switch -c skill/chosen && printf published > native.txt && git add native.txt && git commit -m 'Skill publishes' && git push --set-upstream origin HEAD")], [message('Finished without requiring a PR.')]]);
  await configure(f.job, api.config, f.log);
  const observed = await driver(f, r);
  assert.equal(observed.result.outcome, 'completed'); assert.equal(await r.git('branch', '--show-current'), 'skill/chosen');
  assert.equal(await observed.git.remoteHead(), await observed.git.head());
  assert.ok(api.requests[0].input.some(item => item.role === 'user' && item.content?.some(part => part.text === plan)));
  const manifest = validateCheckpoint(JSON.parse(await readFile(join(observed.exports.at(-1).root, 'manifest.json'))), 'fixture/repo');
  assert.equal(manifest.session_id, observed.result.session); assert.equal(manifest.omitted_work, false);
});
for (const rejected of [false, true]) test(`native conversation is saved with ${rejected ? 'a rejected push' : 'unfinished files'}`, async t => {
  const f = await fixture(t), r = await repository(f);
  if (rejected) await writeFile(join(r.remote, 'hooks/pre-receive'), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
  const command = rejected ? "printf local > draft.txt && git add draft.txt && git commit -m 'Unpublished' && git push origin HEAD" : "printf local > draft.txt";
  const api = await provider(t, [[(await import('./helpers.mjs')).tool(command)], [message('Clarification is required before continuing.')]]);
  await configure(f.job, api.config, f.log);
  const observed = await driver(f, r), manifest = JSON.parse(await readFile(join(observed.exports.at(-1).root, 'manifest.json')));
  assert.equal(observed.result.outcome, 'completed'); assert.ok(observed.result.checkpoint);
  assert.equal(manifest.omitted_work, true); assert.equal(manifest.checkpoint_sha, r.base);
  assert.equal(await readFile(join(r.cwd, 'draft.txt'), 'utf8'), 'local');
  if (rejected) assert.notEqual(await observed.git.head(), r.base);
});
test('real cold resume preserves SQLite goals and session identity, adds context, and excludes newer main', async t => {
  const f = await fixture(t), r = await repository(f);
  const firstProvider = await provider(t, [[message('First conversation marker 7391.')]]);
  await configure(f.job, firstProvider.config, f.log);
  const first = await driver(f, r), root = first.exports.at(-1).root;
  const db = new DatabaseSync(join(f.job.codexHome, 'goals_1.sqlite'));
  db.exec("CREATE TABLE fixture_goals (value TEXT); INSERT INTO fixture_goals VALUES ('native-goal-7891')"); db.close();
  const exported = await (await import('../.build/checkpoint.js')).exportCheckpoint(f.job, checkpoint({ ...await first.git.snapshot(), session_id: first.result.session, workspace: r.cwd }), f.log);
  const manifest = validateCheckpoint(exported.manifest, 'fixture/repo');
  const other = join(f.temporary, 'other'); await exec('git', ['clone', '--branch', 'main', r.remote, other], { env: f.job.env });
  await writeFile(join(other, 'new-main.txt'), 'Must not enter resumed source');
  await exec('git', ['add', '.'], { cwd: other, env: f.job.env }); await exec('git', ['commit', '-m', 'Advance main'], { cwd: other, env: f.job.env }); await exec('git', ['push', 'origin', 'main'], { cwd: other, env: f.job.env });
  const fresh = await fixture(t), cwd = join(fresh.temporary, 'new-workspace');
  await exec('git', ['clone', r.remote, cwd], { env: fresh.job.env });
  const current = new TaskGit(cwd, fresh.job.env, fresh.log);
  await restoreCheckpoint(fresh.job, exported.root, manifest, current, fresh.log);
  assert.equal(await current.head(), r.base); await assert.rejects(readFile(join(cwd, 'new-main.txt')), { code: 'ENOENT' });
  const goal = new DatabaseSync(join(fresh.job.codexHome, 'goals_1.sqlite'), { readOnly: true });
  assert.equal(goal.prepare('SELECT value FROM fixture_goals').get().value, 'native-goal-7891'); goal.close();
  const secondProvider = await provider(t, [[message('Resumed with clarification.')]]);
  await configure(fresh.job, secondProvider.config, fresh.log);
  await installUserAgents(fresh.job, { url: 'https://example.invalid/current.md', content: 'current-instructions-8271', sha256: (await import('../.build/contracts.js')).hash('current-instructions-8271') }, fresh.log);
  const second = await runCodex(fresh.job, cwd, 'New clarification answer 6391: continue.', fresh.log, 60000, 'resumed', manifest.session_id);
  assert.equal(second.session, first.result.session);
  const captured = JSON.stringify(secondProvider.requests);
  assert.match(captured, /First conversation marker 7391/); assert.match(captured, /New clarification answer 6391/); assert.match(captured, /current-instructions-8271/);
  const state = new DatabaseSync(join(fresh.job.codexHome, 'state_5.sqlite'), { readOnly: true });
  const row = state.prepare('SELECT cwd, rollout_path FROM threads WHERE id = ?').get(manifest.session_id);
  assert.equal(row.cwd, cwd); assert.ok(row.rollout_path.startsWith(fresh.job.codexHome)); state.close();
});
test('native errors retain the conversation after an earlier completed invocation', async t => {
  const f = await fixture(t), r = await repository(f);
  const api = await provider(t, [[(await import('./helpers.mjs')).tool('sleep 1')], [message('First turn before native failure.')]]);
  await configure(f.job, api.config, f.log);
  const observed = await driver(f, r);
  assert.ok(observed.exports.length > 0); assert.equal(observed.result.outcome, 'completed');
  const manifest = JSON.parse(await readFile(join(observed.exports.at(-1).root, 'manifest.json')));
  const failureProvider = await provider(t, () => ({ status: 403, body: { error: { message: 'private-provider-body-5741' } } }));
  await configure(f.job, failureProvider.config, f.log);
  const failed = await driver(f, r, { session: manifest.session_id });
  assert.equal(failed.result.outcome, 'failed'); assert.ok(failed.result.checkpoint);
  assert.doesNotMatch(JSON.stringify(f.records), /private-provider-body-5741|fixture-api-credential-9374/);
});
test('native hooks retain repository-owned commit and push policy', async t => {
  const f = await fixture(t), r = await repository(f);
  const api = await provider(t, [[(await import('./helpers.mjs')).tool('printf progress > hook-progress.txt')], [message('Hook-managed progress saved.')]]);
  const hook = "git add -- hook-progress.txt && git commit -m 'Save progress through native hook' && git push origin HEAD";
  await configure(f.job, api.config + '\n[[hooks.PostToolUse]]\nmatcher = "Bash"\n[[hooks.PostToolUse.hooks]]\ntype = "command"\ncommand = ' + JSON.stringify(hook) + '\ntimeout = 30\n', f.log);
  const observed = await driver(f, r);
  assert.equal(await r.git('log', '-1', '--format=%s'), 'Save progress through native hook');
  assert.equal(await observed.git.remoteHead(), await observed.git.head());
});

test('native terminal completion does not await a stalled periodic upload', async t => {
  const { createServer } = await import('node:http');
  const { rename } = await import('node:fs/promises');
  const { startSnapshots, waitSnapshots } = await import('../.build/checkpoint-worker.js');
  const f = await fixture(t), r = await repository(f); let requests = 0;
  const server = createServer(async request => { requests++; for await (const _ of request) {} });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const token = 'e30.' + Buffer.from(JSON.stringify({ scp: 'Actions.Results:11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222' })).toString('base64url') + '.fixture';
  const keys = ['ACTIONS_RUNTIME_TOKEN', 'ACTIONS_RESULTS_URL', 'CODEX_UPLOAD_TIMEOUT_MS', 'NO_PROXY'];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  Object.assign(process.env, { ACTIONS_RUNTIME_TOKEN: token, ACTIONS_RESULTS_URL: `http://127.0.0.1:${server.address().port}`, CODEX_UPLOAD_TIMEOUT_MS: '5000', NO_PROXY: '127.0.0.1,localhost' });
  const api = await provider(t, [[(await import('./helpers.mjs')).tool('sleep 2')], [message('Clarification needed; do not automatically continue.')]]);
  await configure(f.job, api.config, f.log);
  const saved = { job: f.job, metadata: checkpoint({ workspace: r.cwd, session_id: '' }), secrets: f.log.protectedValues, response: '', latest: null };
  const statePath = join(f.job.root, 'state.json'); let writes = Promise.resolve();
  const persist = () => writes = writes.then(async () => { await writeFile(statePath + '.tmp', JSON.stringify(saved)); await rename(statePath + '.tmp', statePath); });
  try {
    await persist(); saved.watcher_pid = await startSnapshots(statePath, f.job); await persist();
    const result = await drive({ job: f.job, cwd: r.cwd, log: f.log, plan,
      state: async value => { if (value.session) saved.metadata.session_id = value.session; if (value.control) saved.control = value.control; saved.metadata.outcome = value.outcome; await persist(); } });
    assert.equal(result.outcome, 'completed'); assert.ok(requests > 0, 'The actual artifact SDK began the stalled upload');
    assert.equal(JSON.parse(await readFile(statePath)).metadata.outcome, 'completed');
    await assert.rejects(readFile(join(f.job.root, 'snapshots-done')), { code: 'ENOENT' });
    await waitSnapshots(saved);
  } finally { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
});

test('the actual snapshot loop repeatedly captures a running native conversation', async t => {
  const { watchSnapshots } = await import('../.build/checkpoint-worker.js');
  const { rename } = await import('node:fs/promises');
  const f = await fixture(t), r = await repository(f);
  const api = await provider(t, [[(await import('./helpers.mjs')).tool('sleep 2')], [message('Completed after periodic persistence.')]]);
  await configure(f.job, api.config, f.log);
  const saved = { job: f.job, metadata: checkpoint({ workspace: r.cwd, session_id: '' }), secrets: f.log.protectedValues, response: '', latest: null };
  const path = join(f.job.root, 'state.json'); let writes = Promise.resolve(); const captures = [];
  const persist = () => writes = writes.then(async () => { await writeFile(path + '.tmp', JSON.stringify(saved)); await rename(path + '.tmp', path); });
  await persist();
  const watcher = watchSnapshots(path, { intervalMs: 50, api: async () => ({ artifacts: [] }), upload: async (job, name, files, root) => {
    captures.push(JSON.parse(await readFile(join(root, 'manifest.json')))); return { id: captures.length };
  } });
  await drive({ job: f.job, cwd: r.cwd, log: f.log, plan, state: async value => {
    if (value.session) saved.metadata.session_id = value.session; if (value.control) saved.control = value.control;
    saved.metadata.outcome = value.outcome; await persist();
  } });
  await watcher; assert.ok(captures.length >= 2);
  assert.ok(captures.every(value => value.outcome === 'running' && value.session_id === saved.metadata.session_id));
  assert.ok(captures.at(-1).sequence > captures[0].sequence);
});
