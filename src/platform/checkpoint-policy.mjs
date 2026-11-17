import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const dependencies = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).dependencies;
const runnerVersions = { codex: dependencies['@openai/codex'], claude: dependencies['@anthropic-ai/claude-agent-sdk'] };

export const checkpointSchema = 5;
export const checkpointBytes = 256 * 1024 * 1024;
export const instructionBytes = 64 * 1024;
export const databases = ['state_5.sqlite', 'thread_history_1.sqlite', 'goals_1.sqlite', 'queue_1.sqlite', 'memories_1.sqlite', 'memories_v2_1.sqlite'];
export const shaPattern = /^[a-f0-9]{40}$/;
export const hashPattern = /^[a-f0-9]{64}$/;
export const repositoryPattern = /^[\w.-]+\/[\w.-]+$/;
export const positiveId = value => /^[1-9][0-9]*$/.test(String(value)) && Number.isSafeInteger(Number(value));
export const digest = value => createHash('sha256').update(value).digest('hex');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
export function invariant(condition, reason) {
  if (!condition) throw Object.assign(new Error(reason), { reason });
}
export function sources(value) {
  invariant(Array.isArray(value) && value.length <= 20, 'invalid_skill_sources');
  const names = new Set();
  for (const source of value) {
    invariant(object(source) && Object.keys(source).sort().join() === 'names,repository,revision' && repositoryPattern.test(source.repository) && shaPattern.test(source.revision) &&
      Array.isArray(source.names) && source.names.length > 0 && source.names.length <= 100, 'invalid_skill_source');
    for (const name of source.names) {
      invariant(typeof name === 'string' && /^[a-z0-9][a-z0-9_-]{0,99}$/.test(name) && !names.has(name), 'duplicate_or_invalid_skill_name');
      names.add(name);
    }
  }
  return value;
}
export function runnerLabels(value = ['ubuntu-latest']) {
  invariant(Array.isArray(value) && value.length > 0 && value.length <= 10 && new Set(value).size === value.length &&
    value.every(label => typeof label === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(label)), 'invalid_runner_labels');
  invariant(same(value, ['ubuntu-latest']) || same(value, ['ubuntu-24.04-arm']) || value.includes('self-hosted') && value.some(label => label.toLowerCase() === 'linux') &&
    !value.some(label => ['windows', 'macos'].includes(label.toLowerCase())), 'unsupported_runner');
  return value;
}
export function instructionURL(value) {
  let url;
  try { url = new URL(value); } catch { invariant(false, 'invalid_user_instructions_url'); }
  invariant(url.protocol === 'https:' && !url.username && !url.password && !url.hash && url.hostname && value.length <= 2048, 'invalid_user_instructions_url');
  return value;
}
export function instructions(value) {
  if (value === null) return null;
  invariant(object(value) && Object.keys(value).sort().join() === 'content,sha256,url', 'invalid_user_instructions');
  instructionURL(value.url);
  invariant(hashPattern.test(value.sha256) && typeof value.content === 'string' && value.content.trim() && Buffer.byteLength(value.content) <= instructionBytes &&
    !value.content.includes('\0') && digest(value.content) === value.sha256, 'user_instructions_hash_mismatch', value.sha256, typeof value.content === 'string' ? digest(value.content) : null);
  return value;
}
export function validBranch(value) {
  return value === null || typeof value === 'string' && value.length > 0 && value.length <= 255 && value !== '@' &&
    !/[\x00-\x20\x7f~^:?*\[\\]/.test(value) && !value.includes('..') && !value.includes('@{') &&
    value.split('/').every(part => part && !part.startsWith('.') && !part.endsWith('.') && !part.endsWith('.lock')) && !value.startsWith('-');
}
export function checkpointName(value) { return `remote-dev-session-r${value.lineage.run_id}-a${value.lineage.run_attempt}-${value.sequence}`; }
export function allowedStatePath(runner, path) {
  if (typeof path !== 'string' || path.length > 512 || path.includes('\\') || path.includes(':') ||
      path.split('/').some(part => !part || part === '.' || part === '..')) return false;
  if (runner === 'codex') return /^codex\/(?:sessions|archived_sessions)\/.+\.jsonl(?:\.zst)?$/.test(path) || databases.some(name => path === `codex/${name}`);
  if (runner !== 'claude') return false;
  return /^claude\/projects\/[A-Za-z0-9_-]+\/[a-f0-9-]{36}\.jsonl$/.test(path) ||
    /^claude\/projects\/[A-Za-z0-9_-]+\/[a-f0-9-]{36}\/(?:subagents\/agent-[A-Za-z0-9_-]+\.(?:jsonl|meta\.json)|(?:tool-results|mcp-tasks)\/.+)$/.test(path) ||
    /^claude\/projects\/[A-Za-z0-9_-]+\/memory\/.+\.md$/.test(path) ||
    /^claude\/(?:tasks\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\.json|agent-memory\/[A-Za-z0-9_-]+\/.+\.md)$/.test(path);
}
export function validateManifest(value, { repository, runner, runnerVersion } = {}) {
  invariant(value?.schema_version === checkpointSchema, 'unsupported_checkpoint_schema');
  invariant(value.repository === repository && repositoryPattern.test(repository), 'checkpoint_repository_mismatch');
  invariant(validBranch(value.branch) && shaPattern.test(value.checkpoint_sha) && typeof value.omitted_work === 'boolean', 'invalid_checkpoint_git_identity');
  invariant(typeof value.session_id === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value.session_id), 'invalid_session_identity');
  invariant(['codex', 'claude'].includes(value.runner) && (!runner || value.runner === runner), 'checkpoint_runner_mismatch');
  invariant(typeof value.runner_version === 'string' && value.runner_version === (runnerVersion ?? runnerVersions[value.runner]), 'checkpoint_version_mismatch');
  invariant(positiveId(value.root_run_id) && positiveId(value.activation_run_id) && Number.isSafeInteger(value.auto_count) && value.auto_count >= 0 && value.auto_count <= 100 &&
    typeof value.operator === 'string' && /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(value.operator), 'invalid_session_lineage');
  invariant(['running', 'completed', 'failed', 'cancelled'].includes(value.outcome), 'invalid_native_outcome');
  invariant(Number.isSafeInteger(value.sequence) && value.sequence > 0 && Array.isArray(value.files) && value.files.length <= 10000, 'invalid_checkpoint_inventory');
  const paths = new Set(); let bytes = Buffer.byteLength(JSON.stringify(value));
  for (const file of value.files) {
    invariant(!paths.has(file.path) && allowedStatePath(value.runner, file.path), 'unsafe_checkpoint_path');
    invariant(hashPattern.test(file.sha256) && Number.isSafeInteger(file.bytes) && file.bytes >= 0, 'invalid_checkpoint_file');
    paths.add(file.path); bytes += file.bytes;
  }
  invariant(bytes <= checkpointBytes, 'checkpoint_size_limit');
  const lineage = value.lineage;
  invariant(lineage && positiveId(lineage.run_id) && positiveId(lineage.run_attempt) && positiveId(lineage.workflow_id) && shaPattern.test(lineage.workflow_sha) &&
    /^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/.test(lineage.workflow_path) && typeof lineage.branch === 'string', 'untrusted_checkpoint_producer');
  invariant(typeof value.workspace === 'string' && value.workspace.startsWith('/') && typeof value.runner_home === 'string' && value.runner_home.startsWith('/'), 'invalid_checkpoint_locations');
  return value;
}
export function validateProducer(artifact, run, manifest, repository) {
  invariant(artifact && positiveId(artifact.id) && !artifact.expired && Date.parse(artifact.expires_at) > Date.now(), 'checkpoint_artifact_expired');
  invariant(artifact.size_in_bytes > 0 && artifact.size_in_bytes <= checkpointBytes && artifact.name === checkpointName(manifest), 'checkpoint_artifact_identity_mismatch');
  invariant(artifact.workflow_run?.id === run.id && String(run.id) === String(manifest.lineage.run_id) && Number(run.run_attempt) === Number(manifest.lineage.run_attempt) &&
    run.repository?.full_name === repository && run.head_repository?.full_name === repository && run.head_sha === manifest.lineage.workflow_sha && run.event === 'workflow_dispatch' &&
    run.head_branch === manifest.lineage.branch && run.workflow_id === manifest.lineage.workflow_id && run.path === manifest.lineage.workflow_path, 'untrusted_checkpoint_producer');
  return artifact;
}
