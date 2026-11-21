import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { configure, installSkillSource, installTools, installUserInstructions, safeTree } from '../.build/setup.js';
import { runClaude } from '../.build/claude.js';
import { runnerInputs } from '../.build/runners.js';
import { hash, versions } from '../.build/contracts.js';
import { exportCheckpoint } from '../.build/checkpoint.js';
import { restoreCheckpoint, validateCheckpoint, unpackArchive } from '../.build/resume.js';
import { drive } from '../.build/driver.js';
import { TaskGit } from '../.build/git.js';
import { watchSnapshots } from '../.build/checkpoint-worker.js';
import { checkpoint, exec, fixture, mcpProvider, repository, root, sessionId } from './helpers.mjs';
import { call, claudeProvider, text } from './claude-provider.mjs';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(probe) {
  const deadline = Date.now() + 60000;
  while (!await probe()) { assert.ok(Date.now() < deadline, 'Expected native state became available'); await pause(50); }
}
test('runner selection requires only the selected native secrets and isolates provider environments', async t => {
  for (const runner of ['codex', 'claude']) {
    const env = { REMOTE_DEV_RUNNER: runner, REMOTE_DEV_GITHUB_TOKEN: 'fixture-github-token',
      ...(runner === 'codex' ? { CODEX_API_KEY: 'fixture-codex-key', CODEX_CONFIG_TOML: 'model="test"' } : { ANTHROPIC_API_KEY: 'fixture-claude-key', CLAUDE_SETTINGS_JSON: '{}' }) };
    assert.equal(runnerInputs(env).runner, runner);
    assert.equal(runnerInputs(env).mcp, '');
    const mcp = JSON.stringify({ mcpServers: {} });
    assert.equal(runnerInputs({ ...env, MCP_CONFIG_JSON: mcp }).mcp, mcp);
    assert.throws(() => runnerInputs({ ...env, ...(runner === 'codex' ? { CODEX_API_KEY: '' } : { ANTHROPIC_API_KEY: '' }) }), /invalid_credential_input/);
    const f = await fixture(t, runner);
    assert.equal(f.job.env[runner === 'codex' ? 'ANTHROPIC_API_KEY' : 'CODEX_API_KEY'], undefined);
  }
  assert.throws(() => runnerInputs({ REMOTE_DEV_RUNNER: 'unknown' }), /invalid_runner/);
});
test('Claude JSON configuration protects secrets and reserves permission, credentials and storage controls', async t => {
  const f = await fixture(t, 'claude');
  const secret = 'private-mcp-password-7861';
  await configure(f.job, JSON.stringify({ permissions: { defaultMode: 'plan' }, sandbox: { enabled: true },
    env: { HOME: '/outside', CLAUDE_CONFIG_DIR: '/outside', ANTHROPIC_API_KEY: 'wrong-key', GH_TOKEN: 'wrong-git', DEBUG: '1' } }), f.log,
  JSON.stringify({ mcpServers: { fixture: { type: 'http', url: 'https://example.invalid/mcp', headers: { Authorization: `Bearer ${secret}` } } } }));
  const settings = JSON.parse(await readFile(join(f.job.runnerHome, 'settings.json')));
  assert.equal(settings.permissions.defaultMode, 'bypassPermissions'); assert.equal(settings.sandbox.enabled, false);
  assert.deepEqual(settings.env, { DEBUG: '1' }); assert.ok(f.log.protectedValues.includes(secret));
  assert.ok(!f.log.protectedValues.includes('1'));
  await assert.rejects(configure(f.job, '[broken', f.log), /invalid_claude_config/);
  await assert.rejects(configure(f.job, '[]', f.log), /invalid_claude_config/);
  await assert.rejects(configure(f.job, '{}', f.log, '{"mcpServers":[]}'), { reason: 'invalid_mcp_config', details: { source: 'MCP_CONFIG_JSON' } });
  await installTools(f.job, root, f.log);
  assert.equal(f.records.find(record => record.stage === 'tools').runner_version, versions.claude);
});
test('real Claude uses native tools to read, edit, commit and push with sanitized activity', async t => {
  const f = await fixture(t, 'claude'), r = await repository(f);
  const api = await claudeProvider(t, [[call('Read', { file_path: join(r.cwd, 'README.md') }, 'read')],
    [call('Edit', { file_path: join(r.cwd, 'README.md'), old_string: 'Fixture repository', new_string: 'private-edited-value-9271' }, 'edit')],
    [call('Bash', { command: "git add README.md && git commit -m 'Native Claude change' && git push origin HEAD", description: 'Publish fixture' }, 'publish')],
    [text('Native Claude completed.')]]);
  await configure(f.job, api.config, f.log);
  const result = await runClaude(f.job, r.cwd, 'private-task-9271', f.log, 90000, 'tools');
  assert.equal(result.result, 'Native Claude completed.');
  assert.match(await readFile(join(r.cwd, 'README.md'), 'utf8'), /private-edited-value-9271/);
  assert.equal(await new TaskGit(r.cwd, f.job.env, f.log).remoteHead(), await r.git('rev-parse', 'HEAD'));
  assert.ok(api.requests.some(request => request.messages.some(message => JSON.stringify(message).includes('Fixture repository'))));
  assert.ok(f.records.some(record => record.event === 'runtime.tool' && record.tool === 'Edit' && record.phase === 'completed'));
  assert.doesNotMatch(JSON.stringify(f.records), /private-task-9271|private-edited-value-9271/);
});
for (const downloaded of [false, true]) test(`real Claude discovers user/repository skills and ${downloaded ? 'downloaded' : 'default'} attribution across resume`, async t => {
  const f = await fixture(t, 'claude'), r = await repository(f);
  await installSkillSource(f.job, { repository: 'fixture/source', revision: 'a'.repeat(40), names: ['remote-dev'] }, root, 0, f.log);
  await mkdir(join(r.cwd, '.claude/skills/repo-native'), { recursive: true });
  await writeFile(join(r.cwd, '.claude/skills/repo-native/SKILL.md'), '---\nname: repo-native\ndescription: repository-catalog-5931\n---\nUse native discovery.\n');
  await writeFile(join(r.cwd, 'AGENTS.md'), 'repository-instructions-7751\n');
  await writeFile(join(r.cwd, 'CLAUDE.md'), '@AGENTS.md\n');
  await installUserInstructions(f.job, downloaded ? { url: 'https://example.invalid/shared.md', sha256: hash('user-instructions-8654\n'), content: 'user-instructions-8654\n' } : null, f.log);
  const api = await claudeProvider(t, [[text('First native reply.')], [text('Resumed native reply.')]]);
  await configure(f.job, api.config, f.log);
  const first = await runClaude(f.job, r.cwd, 'Inspect the available skills.', f.log, 90000, 'one');
  const second = await runClaude(f.job, r.cwd, 'Continue this conversation.', f.log, 90000, 'two', first.session);
  assert.equal(second.session, first.session);
  const captured = JSON.stringify(api.requests);
  for (const marker of ['remote-dev', 'repository-catalog-5931', 'repository-instructions-7751']) assert.ok(captured.includes(marker), marker);
  assert.equal(captured.includes('user-instructions-8654'), downloaded);
  for (const request of api.requests) {
    const context = JSON.stringify(request);
    assert.ok(context.includes('Assisted-by: remote-agent-dev <https://github.com/markhuangai/agent-remote-dev>'));
    assert.match(context, /This section applies only to coding tasks where the user authorizes commits and pushes/);
    assert.match(context, /check the recorded task branch and its remote tip/);
    assert.match(context, /Stop on divergence/);
    assert.match(context, /commit and push each coherent milestone/);
    assert.match(context, /task branch SHA matches local HEAD/);
    assert.match(context, /obtain a conformant plan audit before required pre-PR tests/);
    assert.match(context, /Open the PR after the audit and those tests pass/);
  }
  assert.doesNotMatch(captured, /unwanted-host|host-config-sentinel/);
  for (const [name, value] of Object.entries(f.hostFiles)) assert.equal(await readFile(join(f.host, name), 'utf8'), value);
});
test('real Claude cold resume consumes generated task, subagent, tool and memory state in a new home/workspace', async t => {
  const f = await fixture(t, 'claude'), r = await repository(f);
  const project = join(f.job.runnerHome, 'projects', f.job.env.CLAUDE_CODE_PROJECT_DIR_NAME);
  const steps = [
    [call('TaskCreate', { subject: 'Durable fixture task', description: 'Native task state 7391' }, 'task')],
    [call('Bash', { command: 'python3 -c "print(\'Durable persisted output 8193\'); print(\'x\'*45000)"' }, 'spill')],
    [call('Agent', { description: 'Prove native subagent state', subagent_type: 'general-purpose', prompt: 'Subagent proof prompt 3947. Return the marker.' }, 'agent')],
    [call('Write', { file_path: join(project, 'memory/MEMORY.md'), content: 'Native memory 7391\n' }, 'memory')],
    [text('First history marker 7391.')],
  ];
  const api = await claudeProvider(t, body => {
    const userText = body.messages.filter(message => message.role === 'user').flatMap(message =>
      typeof message.content === 'string' ? [message.content] : message.content.filter(block => block.type === 'text').map(block => block.text));
    if (userText.some(value => value.includes('Subagent proof prompt 3947'))) return [text('Subagent native answer 3947.')];
    return steps.shift();
  });
  const settings = JSON.parse(api.config), outside = join(f.temporary, 'outside-memory');
  settings.autoMemoryEnabled = true;
  settings.autoMemoryDirectory = outside;
  Object.assign(settings.env, { CLAUDE_CODE_REMOTE_MEMORY_DIR: outside, CLAUDE_COWORK_MEMORY_PATH_OVERRIDE: outside });
  await configure(f.job, JSON.stringify(settings), f.log); await installUserInstructions(f.job, null, f.log);
  const first = await runClaude(f.job, r.cwd, 'Create durable native state.', f.log, 90000, 'first');
  const nativeFiles = await safeTree(project);
  const subagent = nativeFiles.find(path => path.includes('/subagents/') && path.endsWith('.jsonl'));
  const toolResult = nativeFiles.find(path => path.includes('/tool-results/'));
  assert.ok(subagent, 'The real Agent tool wrote its transcript');
  assert.ok(toolResult, 'The real Bash tool spilled its large output');
  const freshMemory = 'fresh-restored-memory-2739';
  assert.ok(!JSON.stringify(api.requests).includes(freshMemory));
  await writeFile(join(project, 'memory/MEMORY.md'), 'Native memory 7391\n' + freshMemory + '\n');
  await assert.rejects(readFile(join(outside, 'MEMORY.md')), { code: 'ENOENT' });
  const mcpTask = join(project, first.session, 'mcp-tasks/task.json');
  await mkdir(join(mcpTask, '..'), { recursive: true });
  await writeFile(mcpTask, JSON.stringify({ taskId: 'durable-mcp-task' }));
  const git = new TaskGit(r.cwd, f.job.env, f.log);
  const saved = await exportCheckpoint(f.job, checkpoint({ ...await git.snapshot(), workspace: r.cwd, session_id: first.session }), f.log);
  assert.ok(saved.manifest.files.some(file => file.path.startsWith('claude/tasks/')));
  assert.match(f.job.env.CLAUDE_CODE_PROJECT_DIR_NAME, /^[A-Za-z0-9_-]{1,64}$/);
  const zip = join(f.temporary, 'claude.zip');
  await exec('python3', ['-c', "import sys,zipfile,os\nwith zipfile.ZipFile(sys.argv[1],'w') as z:\n for p in sys.argv[3:]: z.write(p,os.path.relpath(p,sys.argv[2]))", zip, saved.root, ...saved.files]);
  const extracted = join(f.temporary, 'unpacked'); await unpackArchive(f.job, zip, extracted, 'checkpoint', f.log);
  const fresh = await fixture(t, 'claude'), cwd = join(fresh.temporary, 'other-workspace');
  await exec('git', ['clone', r.remote, cwd], { env: fresh.job.env });
  const restoredTool = toolResult.replace(f.job.runnerHome, fresh.job.runnerHome), restoredAgent = subagent.replace(f.job.runnerHome, fresh.job.runnerHome);
  const secondAPI = await claudeProvider(t, [[call('TaskList', {}, 'list')], [call('Read', { file_path: restoredTool, limit: 1 }, 'read-tool')],
    [call('Read', { file_path: restoredAgent, limit: 100 }, 'read-agent')], [text('Cold resume complete.')]]);
  await configure(fresh.job, JSON.stringify({ ...JSON.parse(secondAPI.config), autoMemoryEnabled: true }), fresh.log);
  await installUserInstructions(fresh.job, { url: 'https://example.invalid/new.md', content: 'current-instructions-8271\n', sha256: hash('current-instructions-8271\n') }, fresh.log);
  await restoreCheckpoint(fresh.job, extracted, validateCheckpoint(saved.manifest, 'fixture/repo'), new TaskGit(cwd, fresh.job.env, fresh.log), fresh.log);
  assert.equal(await readFile(mcpTask.replace(f.job.runnerHome, fresh.job.runnerHome), 'utf8'), await readFile(mcpTask, 'utf8'));
  const transcript = await readFile(join(fresh.job.runnerHome, 'projects', fresh.job.env.CLAUDE_CODE_PROJECT_DIR_NAME, first.session + '.jsonl'), 'utf8');
  assert.ok(transcript.includes(restoredTool));
  assert.ok(!transcript.includes(f.job.runnerHome)); assert.ok(!transcript.includes(r.cwd));
  assert.equal(await new TaskGit(cwd, fresh.job.env, fresh.log).head(), saved.manifest.checkpoint_sha);
  const second = await runClaude(fresh.job, cwd, 'Clarification answer 6391.', fresh.log, 90000, 'cold', first.session);
  assert.equal(second.session, first.session);
  const captured = JSON.stringify(secondAPI.requests);
  for (const marker of ['First history marker 7391', 'Clarification answer 6391', 'current-instructions-8271']) assert.ok(captured.includes(marker), marker);
  const results = secondAPI.requests.flatMap(request => request.messages).flatMap(message => Array.isArray(message.content) ? message.content : [])
    .filter(block => block.type === 'tool_result');
  for (const [id, marker] of [['list', 'Durable fixture task'], ['read-tool', 'Durable persisted output 8193'], ['read-agent', 'Subagent native answer 3947']]) {
    const result = results.findLast(block => block.tool_use_id === id);
    assert.ok(result, `Resumed native result ${id}`); assert.notEqual(result.is_error, true);
    assert.ok(JSON.stringify(result.content).includes(marker), `${id} consumed restored state`);
  }
  assert.ok(captured.includes(freshMemory), 'Fresh native context loads memory absent from conversation history');
  assert.ok(!(await safeTree(fresh.job.runnerHome)).some(path => path.endsWith('auth.json')));
});
for (const source of ['shared', 'repository']) test(`real Claude loads MCP when only the ${source} configuration is present`, async t => {
  const f = await fixture(t, 'claude'), r = await repository(f), mcp = await mcpProvider(t);
  const definition = { type: 'http', url: mcp.url + '/' + source };
  const authorization = source === 'shared' ? 'Bearer fixture-shared-claude-token-2745' : undefined;
  if (authorization) definition.headers = { Authorization: authorization };
  const config = JSON.stringify({ mcpServers: { probe: definition } });
  if (source === 'repository') await writeFile(join(r.cwd, '.mcp.json'), config);
  const api = await claudeProvider(t, [[call('mcp__probe__ping', {}, 'standalone-ping')], [text('MCP complete.')]]);
  await configure(f.job, api.config, f.log, source === 'shared' ? config : '', r.cwd);
  await runClaude(f.job, r.cwd, 'Use the configured MCP tool.', f.log, 90000, 'standalone');
  assert.ok(mcp.requests.some(request => request.method === 'tools/call'));
  assert.ok(mcp.requests.every(request => request.path === '/' + source && request.authorization === authorization));
});
test('real Claude uses whole repository MCP entries over private user entries on fresh and resumed runs', async t => {
  const f = await fixture(t, 'claude'), r = await repository(f), mcp = await mcpProvider(t);
  const token = 'private-mcp-token-8194';
  const definition = path => ({ type: 'http', url: mcp.url + path });
  const privateDefinition = path => ({ ...definition(path), headers: { Authorization: 'Bearer ' + token } });
  const secret = JSON.stringify({ mcpServers: { private: privateDefinition('/private'), docs: privateDefinition('/shadowed') } });
  const project = path => JSON.stringify({ mcpServers: { docs: definition(path), repository: definition('/repository') } });
  await writeFile(join(r.cwd, '.mcp.json'), project('/docs'));
  const api = await claudeProvider(t, [[call('mcp__private__ping', {}, 'private-ping')], [call('mcp__docs__ping', {}, 'docs-ping')],
    [call('mcp__repository__ping', {}, 'repo-ping')], [text('MCP complete.')]]);
  await configure(f.job, api.config, f.log, secret, r.cwd);
  const first = await runClaude(f.job, r.cwd, 'Use the configured MCP tools.', f.log, 90000, 'mcp');
  assert.deepEqual(mcp.requests.filter(request => request.method === 'tools/call').map(request => [request.path, request.authorization]),
    [['/private', 'Bearer ' + token], ['/docs', undefined], ['/repository', undefined]]);
  assert.ok(mcp.requests.every(request => request.path !== '/shadowed' && (request.path === '/private' || request.authorization === undefined)));
  const results = api.requests.flatMap(request => request.messages).flatMap(message => Array.isArray(message.content) ? message.content : []);
  for (const id of ['private-ping', 'docs-ping', 'repo-ping']) {
    const result = results.findLast(block => block.type === 'tool_result' && block.tool_use_id === id);
    assert.ok(result); assert.notEqual(result.is_error, true); assert.match(JSON.stringify(result.content), /MCP transport result 8194/);
  }
  await writeFile(join(r.cwd, '.mcp.json'), project('/restored-docs'));
  await r.git('add', '.mcp.json');
  await r.git('commit', '-m', 'Record the updated repository MCP configuration');
  await r.git('push', 'origin', 'HEAD');
  const git = new TaskGit(r.cwd, f.job.env, f.log);
  const saved = await exportCheckpoint(f.job, checkpoint({ ...await git.snapshot(), workspace: r.cwd, session_id: first.session }), f.log);
  assert.ok(!saved.manifest.files.some(file => /\.claude\.json$/.test(file.path)));
  for (const file of saved.files) assert.ok(!(await readFile(file)).includes(token));

  const fresh = await fixture(t, 'claude'), cwd = join(fresh.temporary, 'restored-workspace');
  await exec('git', ['clone', r.remote, cwd], { env: fresh.job.env });
  await assert.rejects(readFile(join(cwd, '.mcp.json')), { code: 'ENOENT' });
  const secondAPI = await claudeProvider(t, [[call('mcp__docs__ping', {}, 'restored-docs-ping')], [text('MCP resumed.')]]);
  const restored = new TaskGit(cwd, fresh.job.env, fresh.log);
  await restoreCheckpoint(fresh.job, saved.root, validateCheckpoint(saved.manifest, 'fixture/repo'), restored, fresh.log,
    () => configure(fresh.job, secondAPI.config, fresh.log, secret, cwd));
  mcp.requests.length = 0;
  const second = await runClaude(fresh.job, cwd, 'Use the repository docs tool again.', fresh.log, 90000, 'restored', first.session);
  assert.equal(second.session, first.session);
  assert.deepEqual(mcp.requests.filter(request => request.method === 'tools/call').map(request => [request.path, request.authorization]),
    [['/restored-docs', undefined]]);
  assert.ok(mcp.requests.every(request => request.path !== '/shadowed' && request.path !== '/docs'));
  assert.ok(!JSON.stringify([...f.records, ...fresh.records]).includes(token));
});
test('real Claude errors preserve an earlier conversation and produce causal sanitized diagnostics', async t => {
  const f = await fixture(t, 'claude'), r = await repository(f);
  const api = await claudeProvider(t, (_body, count) => count === 1 ? [text('Saved before failure.')] :
    { status: 401, body: { type: 'error', error: { type: 'authentication_error', message: 'Fixture authentication rejected.' } } });
  await configure(f.job, api.config, f.log);
  const first = await runClaude(f.job, r.cwd, 'Start.', f.log, 90000, 'first');
  const result = await drive({ job: f.job, cwd: r.cwd, log: f.log, plan: 'Continue.', session: first.session, state: async () => {} });
  assert.equal(result.outcome, 'failed'); assert.equal(result.session, first.session);
  const exported = await exportCheckpoint(f.job, checkpoint({ session_id: first.session }), f.log);
  assert.equal(exported.manifest.runner, 'claude');
  assert.ok(f.records.some(record => record.event === 'runtime.failed' && record.stage === 'claude'));
  assert.ok(f.records.some(record => record.event === 'runtime.provider' && record.native_reason === 'authentication_failed' && record.level === 'ERROR'),
    JSON.stringify(f.records.filter(record => ['runtime.provider', 'runtime.failed'].includes(record.event))));
  assert.doesNotMatch(JSON.stringify(f.records), /fixture-api-credential-9374/);
});
test('native Claude retry diagnostics identify the API status and bounded attempt without response bodies', async t => {
  const f = await fixture(t, 'claude'), r = await repository(f);
  const api = await claudeProvider(t, (_body, count) => count === 1 ?
    { status: 500, body: { type: 'error', error: { type: 'api_error', message: 'private-retry-payload-7251' } } } : [text('Recovered from native retry.')]);
  const settings = JSON.parse(api.config); settings.env.CLAUDE_CODE_MAX_RETRIES = '1';
  await configure(f.job, JSON.stringify(settings), f.log);
  const result = await runClaude(f.job, r.cwd, 'Handle one transient response.', f.log, 30000, 'retry');
  assert.match(result.result, /Recovered from native retry/);
  assert.ok(f.records.some(record => record.event === 'runtime.provider' && record.level === 'WARN' && record.http_status === 500 && record.attempt >= 1));
  assert.doesNotMatch(JSON.stringify(f.records), /private-retry-payload-7251/);
});
test('real Claude is snapshotted repeatedly while a native descendant runs and cancellation stops it', async t => {
  const f = await fixture(t, 'claude'), r = await repository(f), marker = join(f.temporary, 'descendant');
  const api = await claudeProvider(t, [[call('Bash', { command: `while true; do date +%s%N > '${marker}'; sleep 0.1; done`, timeout: 120000 })], { hang: true }]);
  await configure(f.job, api.config, f.log);
  let control, session;
  const invocation = runClaude(f.job, r.cwd, 'Keep working.', f.log, 90000, 'active', undefined, value => { session = value; }, value => { control = value; }).catch(error => error);
  await waitFor(async () => session && await readFile(marker).then(() => true, () => false));
  const statePath = join(f.job.root, 'state.json'), receipts = [];
  const saved = { job: f.job, metadata: checkpoint({ session_id: session, workspace: r.cwd }), secrets: f.log.protectedValues, control: { directory: control.directory, nonce: control.nonce } };
  await writeFile(statePath, JSON.stringify(saved));
  const watching = watchSnapshots(statePath, { intervalMs: 100, api: async () => ({ artifacts: [] }), upload: async (_job, name, files) => {
    receipts.push({ name, files }); return { id: 50 + receipts.length };
  } });
  await waitFor(() => receipts.length >= 2);
  saved.metadata.outcome = 'cancelled'; await writeFile(statePath, JSON.stringify(saved)); await watching;
  process.emit('SIGTERM');
  const failure = await invocation; assert.equal(failure.reason, 'command_cancelled');
  const before = await readFile(marker, 'utf8'); await pause(400); assert.equal(await readFile(marker, 'utf8'), before);
  assert.ok(receipts.every(receipt => receipt.name.startsWith('remote-dev-session-')));
});
test('a real Claude timeout terminates its supervised worker with a bounded failure', async t => {
  const f = await fixture(t, 'claude'), r = await repository(f);
  const api = await claudeProvider(t, () => ({ hang: true })); await configure(f.job, api.config, f.log);
  await assert.rejects(runClaude(f.job, r.cwd, 'Wait for the model.', f.log, 5000, 'timeout'), { reason: 'command_timeout' });
});
for (const location of ['history', 'tool', 'task', 'memory']) test(`Claude checkpoint credential exclusion scans native ${location}`, async t => {
  const f = await fixture(t, 'claude'), project = join(f.job.runnerHome, 'projects/remote-fixture');
  const secret = 'private-claude-state-9271'; f.log.protect(secret);
  await mkdir(project, { recursive: true });
  await writeFile(join(project, sessionId + '.jsonl'), JSON.stringify({ sessionId, type: 'user', message: location === 'history' ? secret : 'safe history' }) + '\n');
  const paths = { tool: join(project, sessionId, 'tool-results/output.txt'), task: join(f.job.runnerHome, 'tasks', sessionId, '1.json'), memory: join(project, 'memory/MEMORY.md') };
  if (location !== 'history') { await mkdir(join(paths[location], '..'), { recursive: true }); await writeFile(paths[location], location === 'task' ? JSON.stringify({ description: secret }) : secret); }
  await assert.rejects(exportCheckpoint(f.job, checkpoint(), f.log), { reason: 'credential_in_checkpoint' });
});
