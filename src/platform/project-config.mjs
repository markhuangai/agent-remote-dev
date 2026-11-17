import { createRequire } from 'node:module';
import { digest, instructionURL, invariant, shaPattern } from './checkpoint-policy.mjs';
import { fetchInstructions } from './instructions.mjs';
import { resolveSkills } from './sources.mjs';

const parseDocument = createRequire(import.meta.url)('./yaml.cjs');

export const configPath = 'remote-codex.yml';
export function parseProjectConfig(text) {
  invariant(typeof text === 'string' && Buffer.byteLength(text) <= 65536, 'project_config_size_limit');
  let value;
  try {
    const document = parseDocument(text, { uniqueKeys: true, strict: true, schema: 'core' });
    invariant(!document.errors.length && !document.warnings.length, 'invalid_project_config');
    value = document.toJS({ maxAliasCount: 0 });
  } catch { invariant(false, 'invalid_project_config'); }
  const object = input => input && typeof input === 'object' && !Array.isArray(input);
  invariant(object(value) && Object.keys(value).every(key => ['allowed-actors', 'skills', 'user-level-agents.md-url', 'git-author', 'budget-minutes',
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
  const url = value['user-level-agents.md-url'] ?? null;
  if (url !== null) { invariant(typeof url === 'string', 'invalid_user_level_agents_md_url'); instructionURL(url); }
  const budget = value['budget-minutes'] ?? 300, limit = value['max-continuations'] ?? 3, automatic = value['auto-continue'] ?? false;
  invariant(Number.isFinite(budget) && budget >= 3 && budget <= 300 && Number.isSafeInteger(limit) && limit >= 0 && limit <= 100 && typeof automatic === 'boolean', 'invalid_execution_settings');
  return { allowed_actors: value['allowed-actors'], skills, user_agents_url: url, git_author_name: author.name, git_author_email: author.email,
    budget_minutes: budget, max_continuations: limit, auto_continue: automatic };
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
export async function freezeProjectConfig(api, repository, revision) {
  const { settings, snapshot } = await readProjectConfig(api, repository, revision);
  const user = settings.user_agents_url ? await fetchInstructions(settings.user_agents_url) : null;
  const { allowed_actors, ...execution } = settings;
  return { ...execution, project_config: snapshot, skills: await resolveSkills(api, settings.skills), user_agents_sha256: user?.sha256 ?? null };
}
