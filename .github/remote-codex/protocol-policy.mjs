import { digest, invariant, protocolContract, protocolFiles, shaPattern } from './checkpoint-policy.mjs';

export async function verifyProtocol(api, repository, enabled = true) {
  if (!enabled) return null;
  const main = await api(`/repos/${repository}/git/ref/heads/main`);
  invariant(shaPattern.test(main.object?.sha), 'invalid_protocol_revision');
  const revision = main.object.sha;
  const content = async path => {
    try {
      const file = await api(`/repos/${repository}/contents/${path}?ref=${revision}`);
      invariant(file.encoding === 'base64' && Number.isSafeInteger(file.size) && file.size > 0 && file.size <= 1024 * 1024 && typeof file.content === 'string', 'invalid_protocol_source');
      const bytes = Buffer.from(file.content, 'base64');
      invariant(bytes.length === file.size, 'protocol_source_size_mismatch');
      return bytes;
    } catch (error) {
      if (error.reason) error.details = { ...error.details, source_path: path, protocol_revision: revision };
      throw error;
    }
  };
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
  for (const name of [protocolContract.task_workflow, protocolContract.controller_workflow]) {
    const workflow = await api(`/repos/${repository}/actions/workflows/${name}`);
    invariant(workflow.path === `.github/workflows/${name}` && workflow.state === 'active', 'continuation_protocol_unavailable');
  }
  return { revision, protocol_version: manifest.protocol_version };
}
