import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { installSkillSource } from '../.build/setup.js';
import { exec, fixture, repository, root } from './helpers.mjs';

test('actual Skills CLI installation runs its bundled client and installs only a caller workflow and configuration', async t => {
  const f = await fixture(t), consumer = await repository(f);
  await installSkillSource(f.job, { repository: 'fixture/source', revision: 'a'.repeat(40), names: ['remote-codex'] }, root, 0, f.log);
  const installed = join(f.job.codexHome, 'skills/remote-codex'), helper = join(installed, 'scripts/remote-codex.mjs');
  const result = await exec(process.execPath, [join(installed, 'scripts/install-workflows.mjs'), '--directory', consumer.cwd, '--actors', 'Z-M-Huang', '--ref', 'a'.repeat(40)], { cwd: f.temporary, env: f.job.env });
  assert.equal(JSON.parse(result.stdout).outcome, 'created');
  assert.deepEqual((await exec('git', ['ls-files', '--others', '--exclude-standard'], { cwd: consumer.cwd })).stdout.trim().split('\n').sort(), ['.github/workflows/runner-task.yml', 'remote-codex.yml']);
  const before = await readFile(join(consumer.cwd, '.github/workflows/runner-task.yml'));
  await assert.rejects(exec(process.execPath, [join(installed, 'scripts/install-workflows.mjs'), '--directory', consumer.cwd, '--actors', 'Z-M-Huang'], { cwd: f.temporary, env: f.job.env }));
  assert.deepEqual(await readFile(join(consumer.cwd, '.github/workflows/runner-task.yml')), before);
  const invalidTarget = join(f.temporary, 'invalid-target'); await mkdir(invalidTarget);
  for (const ref of ['../main', 'v1\ninvalid', 'v1\n', 'main/', 'main.lock', '']) await assert.rejects(exec(process.execPath,
    [join(installed, 'scripts/install-workflows.mjs'), '--directory', invalidTarget, '--actors', 'Z-M-Huang', '--ref', ref], { cwd: f.temporary, env: f.job.env }), error => {
    assert.match(error.stderr, /invalid_provider_reference/); return true;
  });
  await assert.rejects(exec(process.execPath, [join(installed, 'scripts/install-workflows.mjs'), '--directory', invalidTarget, '--actors', 'Z-M-Huang', '--ref'],
    { cwd: f.temporary, env: f.job.env }), /invalid_provider_reference/);
  assert.deepEqual(await readdir(invalidTarget), []);
  const bin = join(f.temporary, 'github-transport'), state = join(f.temporary, 'dispatch-state.json');
  await mkdir(bin); await writeFile(state, JSON.stringify({ dispatches: [] }));
  await writeFile(join(bin, 'gh'), `#!/usr/bin/env node
(async()=>{
const fs=require('node:fs');const path=require('node:path');const args=process.argv.slice(2);const endpoint=args[1];const method=args[args.indexOf('--method')+1];
const statePath=${JSON.stringify(state)}, root=${JSON.stringify(consumer.cwd)};let input='';for await(const chunk of process.stdin)input+=chunk;
const state=JSON.parse(fs.readFileSync(statePath));let result;
if(endpoint==='user')result={login:'Z-M-Huang'};
else if(endpoint.includes('/collaborators/'))result={permission:'write'};
else if(endpoint.endsWith('/git/ref/heads/main'))result={object:{sha:'a'.repeat(40)}};
else if(endpoint.includes('/contents/')){const name=endpoint.split('/contents/')[1].split('?')[0];const file=name==='skills/remote-codex/assets/runner-task.yml'?${JSON.stringify(join(installed, 'assets/runner-task.yml'))}:path.join(root,name);const bytes=fs.readFileSync(file);result={size:bytes.length,encoding:'base64',content:bytes.toString('base64')};}
else if(endpoint.includes('/commits/'))result={sha:'a'.repeat(40)};
else if(method==='POST'&&endpoint.endsWith('/dispatches')){const request=JSON.parse(JSON.parse(input).inputs.request);state.dispatches.push(request);fs.writeFileSync(statePath,JSON.stringify(state));result=null;}
else if(endpoint.includes('/actions/runs?'))result={workflow_runs:state.dispatches.length?[{id:15,display_title:'Codex request '+state.dispatches[0].request_id+' / request-'+state.dispatches[0].registration_key,actor:{login:'Z-M-Huang'},path:'.github/workflows/runner-task.yml',head_branch:'main',head_sha:'a'.repeat(40),repository:{full_name:'fixture/repo'},html_url:'https://github.com/fixture/repo/actions/runs/15'}]:[]};
else if(endpoint.includes('/actions/workflows/'))result={path:'.github/workflows/'+endpoint.split('/').pop(),state:'active'};
else{process.stderr.write('Unexpected fixture route');process.exit(1);}
process.stdout.write(JSON.stringify(result));
})();
`, { mode: 0o700 });
  const env = { ...f.job.env, PATH: `${bin}:${f.job.env.PATH}` }, prompt = join(f.temporary, 'prompt.txt'), prepared = join(f.temporary, 'prepared.json');
  await writeFile(prompt, 'An authorized arbitrary workflow prompt.\n');
  const dry = await exec(process.execPath, [helper, 'queue', '--repo', 'fixture/repo', '--plan-file', prompt, '--dry-run'], { cwd: f.temporary, env });
  const frozen = JSON.parse(dry.stdout); await writeFile(prepared, JSON.stringify(frozen));
  assert.deepEqual(frozen.request.skills, []); assert.equal(frozen.request.source_repository, 'markhuangai/agent-remote-dev-codex');
  const queued = JSON.parse((await exec(process.execPath, [helper, 'queue', '--prepared', prepared], { cwd: f.temporary, env })).stdout);
  assert.equal(queued.run_id, 15); assert.equal(queued.root_run_id, '15'); assert.equal(frozen.request.task_id, undefined);
  const repeated = JSON.parse((await exec(process.execPath, [helper, 'queue', '--prepared', prepared], { cwd: f.temporary, env })).stdout);
  assert.equal(repeated.run_id, 15); assert.equal(JSON.parse(await readFile(state, 'utf8')).dispatches.length, 1);
  assert.doesNotMatch(dry.stdout + dry.stderr, /unwanted-host|fixture-api-credential|fixture-github-credential/);
  const asset = join(installed, 'assets/runner-task.yml'), originalAsset = await readFile(asset);
  await writeFile(asset, Buffer.concat([originalAsset, Buffer.from('\n# changed installed resource\n')]));
  await assert.rejects(exec(process.execPath, [helper, 'queue', '--prepared', prepared], { cwd: f.temporary, env }), error => {
    assert.match(error.stderr, /skill_resource_hash_mismatch/); assert.match(error.stderr, /runner-task.yml/);
    assert.match(error.stderr, /expected/); assert.match(error.stderr, /observed/);
    assert.doesNotMatch(error.stderr, /fixture-api-credential|fixture-github-credential/); process.stdout.write(error.stderr); return true;
  });
  assert.equal(JSON.parse(await readFile(state, 'utf8')).dispatches.length, 1); await writeFile(asset, originalAsset);
  await rename(join(installed, 'dist/archive.py'), join(f.temporary, 'removed-resource.py'));
  await assert.rejects(exec(process.execPath, [helper, '--help'], { cwd: f.temporary, env }), error => {
    assert.match(error.stderr, /incomplete_skill_package/); assert.match(error.stderr, /archive\.py/); assert.match(error.stderr, /protocol_version":3/); return true;
  });
  for (const [name, value] of Object.entries(f.hostFiles)) assert.equal(await readFile(join(f.host, name), 'utf8'), value);
});
