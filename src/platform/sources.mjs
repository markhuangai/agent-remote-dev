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

async function commitForTag(api, repository, tag) {
  let object = (await api(`/repos/${repository}/git/ref/tags/${encodeURIComponent(tag)}`)).object;
  for (let count = 0; object?.type === 'tag' && count < 5; count++) object = (await api(`/repos/${repository}/git/tags/${object.sha}`)).object;
  invariant(object?.type === 'commit' && shaPattern.test(object.sha), 'invalid_release_target');
  return object.sha;
}
export async function resolveSource(api, repository, ref) {
  invariant(repositoryPattern.test(repository) && typeof ref === 'string' && ref.length > 0 && ref.length <= 200, 'invalid_action_source');
  if (/^v[1-9][0-9]*(?:-prerelease)?$/.test(ref)) {
    const sha = await commitForTag(api, repository, ref), releases = await pages(api, `/repos/${repository}/releases`, null);
    const matching = [];
    for (const release of releases.filter(release => !release.draft && release.published_at && release.prerelease === ref.endsWith('-prerelease') && new RegExp(`^${ref.replace('-prerelease', '')}\\.\\d+\\.\\d+(?:-rc\\.\\d+)?$`).test(release.tag_name))) {
      if (await commitForTag(api, repository, release.tag_name) === sha) matching.push(release);
    }
    invariant(matching.length > 0, 'alias_release_missing');
    matching.sort((left, right) => Date.parse(right.published_at) - Date.parse(left.published_at));
    return { repository, sha, requested_ref: ref, release_tag: matching[0].tag_name, release_id: matching[0].id };
  }
  const sha = (await api(`/repos/${repository}/commits/${encodeURIComponent(ref)}`)).sha;
  invariant(shaPattern.test(sha), 'action_source_mismatch');
  if (/^v\d+\./.test(ref)) {
    const release = await api(`/repos/${repository}/releases/tags/${encodeURIComponent(ref)}`);
    invariant(!release.draft && release.published_at && await commitForTag(api, repository, ref) === sha, 'invalid_release_target');
    return { repository, sha, requested_ref: ref, release_tag: ref, release_id: release.id };
  }
  return { repository, sha, requested_ref: ref, release_tag: null, release_id: null };
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
