import { parseDocument } from 'yaml';
import { digest, instructionURL, invariant, shaPattern } from './checkpoint-policy.mjs';

export const configPath = '.remote-dev.yml';
export function parseProjectConfig(text) {
  invariant(typeof text === 'string' && Buffer.byteLength(text) <= 65536, 'project_config_size_limit');
  let value;
  try {
    const document = parseDocument(text, { uniqueKeys: true, strict: true, schema: 'core' });
    invariant(!document.errors.length && !document.warnings.length, 'invalid_project_config');
    value = document.toJS({ maxAliasCount: 0 });
  } catch { invariant(false, 'invalid_project_config'); }
  const object = input => input && typeof input === 'object' && !Array.isArray(input);
  invariant(object(value) && Object.keys(value).every(key => ['allowed-actors', 'skills', 'user-level-md-url', 'git-author',
    'auto-continue', 'max-continuations'].includes(key)), 'unknown_project_config_key');
  invariant(Array.isArray(value['allowed-actors']) && value['allowed-actors'].length > 0 && value['allowed-actors'].length <= 100 &&
    value['allowed-actors'].every(actor => typeof actor === 'string' && /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(actor)), 'invalid_operator_configuration');
  const author = value['git-author'] ?? { name: 'github-actions[bot]', email: '41898282+github-actions[bot]@users.noreply.github.com' };
  invariant(object(author) && Object.keys(author).sort().join() === 'email,name' && typeof author.name === 'string' && author.name.trim() &&
    typeof author.email === 'string' && author.email.trim() && !/[\r\n\0]/.test(author.name + author.email), 'invalid_git_identity');
  const skills = value.skills ?? [];
  invariant(Array.isArray(skills) && skills.length <= 20 && skills.every(source => typeof source === 'string' || object(source) &&
    Object.keys(source).every(key => ['repository', 'ref', 'names'].includes(key)) && typeof source.repository === 'string' &&
    (source.ref === undefined || typeof source.ref === 'string' && source.ref.trim()) &&
    (source.names === undefined || Array.isArray(source.names) && source.names.length > 0 && source.names.every(name => typeof name === 'string'))), 'invalid_skill_sources');
  const url = value['user-level-md-url'] ?? null;
  if (url !== null) { invariant(typeof url === 'string', 'invalid_user_level_md_url'); instructionURL(url); }
  const limit = value['max-continuations'] ?? 3, automatic = value['auto-continue'] ?? false;
  invariant(Number.isSafeInteger(limit) && limit >= 0 && limit <= 100 && typeof automatic === 'boolean', 'invalid_execution_settings');
  return { allowed_actors: value['allowed-actors'], skills, user_instructions_url: url, git_author_name: author.name, git_author_email: author.email,
    max_continuations: limit, auto_continue: automatic };
}
export async function readProjectConfig(api, repository, revision, expected) {
  invariant(shaPattern.test(revision), 'invalid_project_config_revision');
  let file;
  try { file = await api(`/repos/${repository}/contents/${configPath}?ref=${revision}`); }
  catch (error) { throw Object.assign(new Error('project_config_unavailable'), { reason: 'project_config_unavailable', status: error.status,
    details: { resource_path: configPath, source_sha: revision } }); }
  invariant(file && file.encoding === 'base64' && Number.isSafeInteger(file.size) && file.size > 0 && file.size <= 65536 && typeof file.content === 'string' &&
    (file.type === undefined || file.type === 'file'), 'invalid_project_config_source');
  const bytes = Buffer.from(file.content, 'base64');
  invariant(bytes.length === file.size, 'project_config_size_mismatch');
  let content;
  try { content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { invariant(false, 'invalid_project_config_encoding'); }
  const sha256 = digest(bytes);
  invariant(expected === undefined || expected === sha256, 'project_config_hash_mismatch', expected, sha256);
  return { settings: parseProjectConfig(content), snapshot: { revision, sha256, content } };
}
export async function currentProjectConfig(api, repository) {
  const info = await api(`/repos/${repository}`);
  invariant(typeof info.default_branch === 'string' && info.default_branch.length > 0, 'invalid_default_branch');
  const revision = (await api(`/repos/${repository}/commits/${encodeURIComponent(info.default_branch)}`)).sha;
  const config = await readProjectConfig(api, repository, revision);
  return { ...config, branch: info.default_branch, revision };
}
export async function authorizeActors(api, repository, actor, triggeringActor = actor) {
  const config = await currentProjectConfig(api, repository);
  for (const login of new Set([actor, triggeringActor])) {
    invariant(config.settings.allowed_actors.includes(login), 'untrusted_task_actor');
    const access = await api(`/repos/${repository}/collaborators/${login}/permission`);
    invariant(['write', 'maintain', 'admin'].includes(access.permission), 'operator_write_permission_required');
  }
  return config;
}
