import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { parse } from 'yaml';
import { actionResources } from '../scripts/build.mjs';
import { digest } from '../src/platform/checkpoint-policy.mjs';
import { verifyReleaseArtifact } from '../.github/scripts/release-artifact.mjs';
import { publishRelease, releaseVersion } from '../.github/scripts/release-policy.mjs';
import { exec, fixture, root } from './helpers.mjs';

async function archiveFixture(t, variant = 'valid') {
  const f = await fixture(t), source = join(f.temporary, 'source'), assets = join(f.temporary, 'assets');
  await mkdir(source); await mkdir(assets);
  for (const path of actionResources) {
    await mkdir(join(source, path, '..'), { recursive: true }); await cp(join(root, path), join(source, path));
  }
  await cp(join(root, 'skills/remote-codex'), join(source, 'skills/remote-codex'), { recursive: true });
  const git = async args => (await exec('git', args, { cwd: source, env: f.job.env })).stdout.trim();
  await git(['init', '--initial-branch=main']); await git(['add', '.']); await git(['commit', '-m', 'Exact release source']);
  const sourceSha = await git(['rev-parse', 'HEAD']);
  const tree = (await git(['ls-tree', '-rl', 'HEAD'])).split('\n').map(line => {
    const [, mode, sha, size, path] = /^(\d+) blob ([a-f0-9]+)\s+(\d+)\t(.+)$/.exec(line);
    return { type: 'blob', mode, sha, size: Number(size), path };
  });
  for (const [name, args] of [['action', ['action.yml', 'dist', 'package.json', 'package-lock.json']], ['remote-codex', ['-C', 'skills', 'remote-codex']]]) {
    await exec('tar', ['--sort=name', '--mtime=@0', '--owner=0', '--group=0', '--numeric-owner', '-cf', join(assets, `${name}.tar`), ...args], { cwd: source });
    await exec('gzip', ['-n', join(assets, `${name}.tar`)]);
  }
  if (['content', 'extra', 'traversal', 'link', 'duplicate', 'missing'].includes(variant)) {
    await exec('python3', ['-c', `import io,sys,tarfile
p=sys.argv[1];variant=sys.argv[2]
with tarfile.open(p,'r:gz') as original:
 entries=[(e, original.extractfile(e).read() if e.isfile() else None) for e in original]
with tarfile.open(p,'w:gz',format=tarfile.GNU_FORMAT) as target:
 for entry,data in entries:
  if variant=='missing' and entry.name=='dist/index.js':continue
  if variant=='content' and entry.name=='dist/index.js':data=b'tampered';entry.size=len(data)
  target.addfile(entry,io.BytesIO(data) if data is not None else None)
 if variant in ('extra','traversal','link','duplicate'):
  entry=tarfile.TarInfo({'extra':'unexpected','traversal':'../trusted/policy.mjs','link':'dist/link','duplicate':'action.yml'}[variant])
  if variant=='link':entry.type=tarfile.SYMTYPE;entry.linkname='../trusted/policy.mjs'
  else:entry.size=4
  target.addfile(entry,io.BytesIO(b'evil') if entry.isfile() else None)`, join(assets, 'action.tar.gz'), variant]);
  }
  const sums = [];
  for (const name of ['action.tar.gz', 'remote-codex.tar.gz']) sums.push(`${digest(await readFile(join(assets, name)))}  ${name}\n`);
  await writeFile(join(assets, 'SHA256SUMS'), sums.join(''));
  const zip = join(f.temporary, 'assets.zip');
  await exec('python3', ['-c', `import pathlib,stat,sys,zipfile
with zipfile.ZipFile(sys.argv[1],'w',compression=zipfile.ZIP_DEFLATED) as z:
 for p in pathlib.Path(sys.argv[2]).iterdir():
  if sys.argv[3]=='outer_link' and p.name=='SHA256SUMS':
   e=zipfile.ZipInfo(p.name);e.external_attr=(stat.S_IFLNK|0o777)<<16;z.writestr(e,'../trusted/policy.mjs')
  else:z.write(p,p.name)
 if sys.argv[3]=='outer_path':z.writestr('../trusted/policy.mjs','evil')
`, zip, assets, variant]);
  let payload = await readFile(zip);
  const records = [], core = Object.fromEntries(['info', 'warning', 'error', 'debug'].map(level => [level, line => records.push(JSON.parse(line))]));
  const plan = { ...releaseVersion('v1.0.0-rc.0'), repository: 'fixture/repo', source_sha: sourceSha };
  const workflowSha = 'a'.repeat(40), artifactDigest = `sha256:${digest(payload)}`, calls = [];
  const artifact = { id: 15, name: 'linux-release-assets-99-2', digest: artifactDigest, size_in_bytes: payload.length, expired: false,
    expires_at: new Date(Date.now() + 86400000).toISOString(), created_at: '2026-01-01T00:01:00Z', workflow_run: { id: 99, head_sha: workflowSha } };
  if (variant === 'producer') artifact.workflow_run.id = 100;
  if (variant === 'digest') payload = Buffer.concat([payload, Buffer.from('changed')]);
  if (variant === 'source') tree.find(entry => entry.path === 'dist/index.js').sha = createHash('sha1').update('different source').digest('hex');
  const api = async (path, options = {}) => {
    calls.push({ path, ...options });
    assert.equal(options.method ?? 'GET', 'GET', 'Failed verification must never mutate releases or tags');
    if (path.endsWith('/actions/runs/99')) return { id: 99, run_attempt: 2, event: 'workflow_dispatch', path: '.github/workflows/release.yml', head_branch: 'main', head_sha: workflowSha,
      repository: { full_name: plan.repository }, head_repository: { full_name: plan.repository } };
    if (path.includes('/attempts/2/jobs?')) return { jobs: [{ id: 7, name: 'Build and verify source', run_attempt: variant === 'attempt' ? 1 : 2, status: 'completed', conclusion: 'success', started_at: '2026-01-01T00:00:00Z', completed_at: '2026-01-01T00:02:00Z' }] };
    if (path.endsWith('/actions/artifacts/15')) return artifact;
    if (path.endsWith('/actions/artifacts/15/zip')) return payload;
    if (path === `/repos/${plan.repository}/git/trees/${sourceSha}?recursive=1`) return { tree, truncated: false };
    throw new Error(`Unexpected release transport ${path}`);
  };
  return { ...f, core, records, calls, plan, sourceFiles: tree.length, options: { api, plan, core, artifactId: 15, artifactDigest, runId: '99', runAttempt: '2', workflowSha, root: join(f.temporary, 'publisher') } };
}

test('trusted publisher verifies actual GNU release archives against an exact Git source tree', async t => {
  const f = await archiveFixture(t), assets = await verifyReleaseArtifact(f.options);
  const manifest = JSON.parse(assets.find(asset => asset.name === 'release-manifest.json').data);
  assert.equal(manifest.source_sha, f.plan.source_sha); assert.equal(manifest.artifact.artifact_id, 15); assert.equal(manifest.artifact.files, f.sourceFiles);
  assert.ok(f.records.some(record => record.event === 'release.artifact' && record.level === 'INFO' && record.outcome === 'verified'));
});

for (const variant of ['content', 'extra', 'traversal', 'link', 'duplicate', 'missing', 'outer_path', 'outer_link', 'producer', 'attempt', 'digest', 'source'])
  test(`release archive ${variant} fails before any publishing mutation`, async t => {
    const f = await archiveFixture(t, variant);
    await assert.rejects(async () => {
      const assets = await verifyReleaseArtifact(f.options);
      await publishRelease({ api: f.options.api, upload: async () => assert.fail('unverified upload'), plan: f.plan, assets });
    });
    assert.ok(!f.calls.some(call => call.method && call.method !== 'GET'));
    assert.ok(f.records.some(record => record.event === 'release.artifact' && record.level === 'ERROR' && record.outcome === 'blocked' && record.source_sha === f.plan.source_sha));
    await assert.rejects(readFile(join(f.options.root, 'verified', 'action.tar.gz')), { code: 'ENOENT' });
  });

test('release publisher executes trusted policy only and receives source build output as data', async () => {
  const workflow = parse(await readFile(join(root, '.github/workflows/release.yml'), 'utf8'));
  assert.equal(workflow.jobs.build.permissions.contents, 'read');
  assert.equal(workflow.jobs.publish.permissions.contents, 'write');
  for (const step of workflow.jobs.publish.steps) {
    assert.equal(step.run, undefined);
    if (step.uses.startsWith('actions/checkout@')) assert.equal(step.with.ref, '${{ github.workflow_sha }}');
    else assert.match(step.uses, /^actions\/(?:setup-node|github-script)@[a-f0-9]{40}$/);
  }
  const script = workflow.jobs.publish.steps.find(step => step.with?.script).with.script;
  assert.ok(script.indexOf('await verifyReleaseArtifact(') < script.indexOf('await publishRelease('));
  assert.doesNotMatch(script, /npm|execFile|spawn|downloadArtifact|unzip|tar /);
});
