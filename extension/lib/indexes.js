// indexes.js — DERIVED VIEWS: the "Obsidian Light" navigation layer.
// Frontmatter is the database; these files are its queries. Everything here
// is generated from canonical envelopes and is regenerable at any time.
//
//   indexes/INDEX.md        home: months + tags + stats
//   indexes/<YYYY-MM>.md    one file per month, chronological
//   indexes/timeline.md     flat chronological list
// indexes/tags/<tag>.md   per-tag map-of-content

import { baseName } from './naming.js';

function fmtDate(iso) {
  return iso ? String(iso).slice(0, 10) : '(no date)';
}

function monthOf(env) {
  return (env.updated || env.created || '').slice(0, 7) || '(unknown)';
}

export function slugTag(tag) {
  return (
    String(tag).toLowerCase().trim().replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '') ||
    'untagged'
  );
}

function wikilink(env) {
  const alias = String(env.title || 'Untitled').replace(/[\[\]\|#]/g, ' ').trim();
  return `[[chats/${baseName(env)}|${alias}]]`;
}

function snippet(env, max = 120) {
  if (!env.summary) return '';
  const first = String(env.summary).split('\n')[0].trim();
  return first.length > max ? first.slice(0, max - 1) + '…' : first;
}

export function sortDesc(envelopes) {
  return [...envelopes].sort((a, b) =>
    (b.updated || b.created || '').localeCompare(a.updated || a.created || '')
  );
}

export function collectTags(envelopes) {
  const map = new Map(); // tag -> [env]
  for (const env of envelopes) {
    for (const tag of env.tags || []) {
      if (!map.has(tag)) map.set(tag, []);
      map.get(tag).push(env);
    }
  }
  return map;
}

function entryLine(env) {
  const when = fmtDate(env.updated || env.created);
  const tags = (env.tags || []).length ? ' — ' + env.tags.map((t) => `#${t}`).join(' ') : '';
  const sum = snippet(env);
  const sumPart = sum ? `\n  > ${sum}` : '';
  return `- ${wikilink(env)} — ${when}${tags}${sumPart}`;
}

export function generateTimeline(envelopes) {
  const lines = ['# Timeline', '', `*${envelopes.length} conversations, newest first*`, ''];
  for (const env of sortDesc(envelopes)) lines.push(entryLine(env));
  lines.push('');
  return lines.join('\n');
}

export function generateMonthFiles(envelopes) {
  const byMonth = new Map(); // 'YYYY-MM' -> [env]
  for (const env of sortDesc(envelopes)) {
    const m = monthOf(env);
    if (!byMonth.has(m)) byMonth.set(m, []);
    byMonth.get(m).push(env);
  }
  const months = [...byMonth.entries()].sort((a, b) => b[0].localeCompare(a[0]));
  return months.map(([name, envs]) => {
    const lines = [`# ${name}`, '', `*${envs.length} conversations*`, ''];
    for (const env of envs) lines.push(entryLine(env));
    lines.push('');
    return { name, md: lines.join('\n') };
  });
}

export function generateTagFiles(tagMap) {
  const seenSlugs = new Set();
  const files = [];
  const tags = [...tagMap.keys()].sort((a, b) => tagMap.get(b).length - tagMap.get(a).length);

  for (const tag of tags) {
    let slug = slugTag(tag);
    let n = 2;
    while (seenSlugs.has(slug)) slug = `${slugTag(tag)}-${n++}`;
    seenSlugs.add(slug);

    const envs = sortDesc(tagMap.get(tag));
    const lines = [`# ${tag}`, '', `*${envs.length} conversations*`, ''];
    for (const env of envs) lines.push(entryLine(env));
    lines.push('');
    files.push({ slug, md: lines.join('\n') });
  }
  return files;
}

export function generateHome(envelopes, tagMap) {
  const sorted = sortDesc(envelopes);
  const newest = sorted[0] ? fmtDate(sorted[0].updated || sorted[0].created) : '—';
  const oldest = sorted.length
    ? fmtDate(sorted[sorted.length - 1].updated || sorted[sorted.length - 1].created)
    : '—';

  const lines = [
    '# Convo Hist — Archive Index',
    '',
    `*${envelopes.length} conversations · ${oldest} → ${newest}*`,
    ''
  ];

  const byMonth = new Map();
  for (const env of sorted) {
    const m = monthOf(env);
    byMonth.set(m, (byMonth.get(m) || 0) + 1);
  }
  lines.push('## By month', '');
  for (const [m, n] of [...byMonth.entries()].sort((a, b) => b[0].localeCompare(a[0]))) {
    lines.push(`- [[indexes/${m}|${m}]] (${n})`);
  }

  lines.push('', '## By tag', '');
  const tagFiles = generateTagFiles(tagMap);
  const tagList = [...tagMap.keys()].sort((a, b) => tagMap.get(b).length - tagMap.get(a).length);
  if (!tagList.length) {
    lines.push('*No tags yet — they arrive when summaries are generated.*');
  } else {
    tagFiles.forEach((f, i) => lines.push(`- [[indexes/tags/${f.slug}|${tagList[i]}]] (${tagMap.get(tagList[i]).length})`));
  }

  lines.push('', '## Everything', '', `- [[indexes/timeline|Timeline]] — all conversations, newest first`, '');
  return lines.join('\n');
}

export function buildAllIndexes(envelopes) {
  const tagMap = collectTags(envelopes);
  return {
    home: generateHome(envelopes, tagMap),
    timeline: generateTimeline(envelopes),
    months: generateMonthFiles(envelopes),
    tags: generateTagFiles(tagMap)
  };
}
