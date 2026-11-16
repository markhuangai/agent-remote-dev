import { createRequire } from 'node:module';
import { isDeepStrictEqual } from 'node:util';
import { digest, invariant, protocolContract, protocolFiles, shaPattern } from './checkpoint-policy.mjs';
import { resolveSource } from './sources.mjs';

const parseDocument = createRequire(import.meta.url)('./yaml.cjs');
function workflow(bytes) {
  const document = parseDocument(bytes.toString('utf8'), { uniqueKeys: true, strict: true, schema: 'core' });
  invariant(!document.errors.length && !document.warnings.length, 'invalid_consumer_workflow');
  return document.toJS({ maxAliasCount: 0 });
}

export async function verifyProtocol(api, repository, enabled = true) {
  if (!enabled) return null;
  const main = await api(`/repos/${repository}/git/ref/heads/main`);
  invariant(shaPattern.test(main.object?.sha), 'invalid_protocol_revision');
  const revision = main.object.sha;
  const content = async (path, source = repository, ref = revision) => {
    try {
      const file = await api(`/repos/${source}/contents/${path}?ref=${ref}`);
      invariant(file.encoding === 'base64' && Number.isSafeInteger(file.size) && file.size > 0 && file.size <= 1024 * 1024 && typeof file.content === 'string', 'invalid_protocol_source');
      const bytes = Buffer.from(file.content, 'base64');
      invariant(bytes.length === file.size, 'protocol_source_size_mismatch');
      return bytes;
    } catch (error) {
      if (error.reason) error.details = { ...error.details, source_path: path, protocol_revision: revision };
      throw error;
    }
  };
  const caller = workflow(await content('.github/workflows/runner-task.yml'));
  const reference = /^markhuangai\/agent-remote-dev-codex\/\.github\/workflows\/remote-codex\.yml@([^\s]+)$/.exec(caller?.jobs?.remote?.uses ?? '');
  if (reference) {
    const provider = await resolveSource(api, 'markhuangai/agent-remote-dev-codex', reference[1]);
    const template = workflow(await content('skills/remote-codex/assets/runner-task.yml', provider.repository, provider.sha));
    const expectedEvents = { ...template.on, workflow_run: { ...template.on.workflow_run, workflows: [caller.name] } };
    invariant(typeof caller.name === 'string' && caller.name.length > 0 && caller['run-name'] === template['run-name'] &&
      isDeepStrictEqual(caller.on, expectedEvents) && isDeepStrictEqual(caller.permissions, template.permissions) &&
      Object.keys(caller.jobs).join() === 'remote' && isDeepStrictEqual(caller.jobs.remote.with, template.jobs.remote.with) &&
      isDeepStrictEqual(caller.jobs.remote.secrets, template.jobs.remote.secrets), 'incompatible_consumer_workflow');
    const registered = await api(`/repos/${repository}/actions/workflows/runner-task.yml`);
    invariant(registered.path === '.github/workflows/runner-task.yml' && registered.state === 'active', 'continuation_protocol_unavailable');
    return { revision, protocol_version: 3, provider };
  }
  let manifest;
  try { manifest = JSON.parse((await content('.github/remote-codex/protocol.json')).toString('utf8')); }
  catch (error) { invariant(false, error.reason ?? 'invalid_protocol_manifest'); }
  invariant(Object.entries(protocolContract).every(([key, expected]) => manifest[key] === expected), 'incompatible_runner_protocol', protocolContract.protocol_version, manifest.protocol_version);
  invariant(manifest.files && Object.keys(manifest.files).sort().join() === [...protocolFiles].sort().join(), 'incomplete_runner_protocol');
  for (const path of protocolFiles) {
    const bytes = await content(path);
    const observed = digest(bytes), expected = /^[a-f0-9]{64}$/.test(manifest.files[path]) ? manifest.files[path] : null;
    if (expected !== observed) throw Object.assign(new Error('protocol_source_mismatch'), { reason: 'protocol_source_mismatch',
      details: { expected, observed, source_path: path, protocol_revision: revision } });
    if (path.endsWith('.yml')) invariant(bytes.toString('utf8').includes("CODEX_RUNNER_PROTOCOL: '3'"), 'incompatible_workflow_protocol');
  }
  for (const name of [protocolContract.task_workflow, protocolContract.controller_workflow, protocolContract.published_workflow]) {
    const workflow = await api(`/repos/${repository}/actions/workflows/${name}`);
    invariant(workflow.path === `.github/workflows/${name}` && workflow.state === 'active', 'continuation_protocol_unavailable');
  }
  return { revision, protocol_version: manifest.protocol_version };
}
