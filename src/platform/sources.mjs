import { invariant, repositoryPattern, shaPattern, sources } from './checkpoint-policy.mjs';

export async function pages(api, path, key) {
  const entries = [];
  for (let page = 1; page <= 100; page++) {
    const data = await api(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
    const batch = key === null ? data : data[key];
    invariant(Array.isArray(batch), 'invalid_github_collection');
    entries.push(...batch);
    if (batch.length < 100) return entries;
  }
  invariant(false, 'github_collection_truncated');
}

function sourceRepository(value) {
  if (typeof value === 'string' && value.startsWith('https://github.com/')) value = value.slice(19).replace(/\/$/, '').replace(/\.git$/, '');
  invariant(repositoryPattern.test(value), 'invalid_skill_repository'); return value;
}
export async function resolveSkills(api, selected) {
  invariant(Array.isArray(selected) && selected.length <= 20, 'invalid_skill_sources');
  const resolved = [];
  for (const source of selected) {
    const repository = sourceRepository(typeof source === 'string' ? source : source.repository), ref = typeof source === 'string' ? undefined : source.ref ?? source.revision;
    const revision = (await api(`/repos/${repository}/commits/${encodeURIComponent(ref ?? (await api(`/repos/${repository}`)).default_branch)}`)).sha;
    invariant(shaPattern.test(revision), 'skill_revision_mismatch');
    const tree = await api(`/repos/${repository}/git/trees/${revision}?recursive=1`);
    invariant(!tree.truncated && Array.isArray(tree.tree), 'skill_inventory_truncated');
    const skills = tree.tree.filter(entry => entry.type === 'blob' && /(?:^|\/)SKILL\.md$/.test(entry.path));
    invariant(skills.length > 0 && skills.length <= 100, 'invalid_skill_inventory');
    const available = [];
    for (const entry of skills) {
      const file = await api(`/repos/${repository}/contents/${entry.path}?ref=${revision}`);
      invariant(file.encoding === 'base64' && file.size <= 1024 * 1024, 'invalid_skill_metadata');
      const text = Buffer.from(file.content, 'base64').toString('utf8');
      const name = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)?.[1].match(/^name:\s*["']?([a-z0-9][a-z0-9_-]{0,99})["']?\s*$/m)?.[1];
      invariant(name && !available.includes(name), 'invalid_skill_metadata'); available.push(name);
    }
    const names = typeof source === 'string' ? available : source.names ?? available;
    invariant(Array.isArray(names) && names.every(name => available.includes(name)), 'missing_selected_skill');
    resolved.push({ repository, revision, names });
  }
  return sources(resolved);
}
