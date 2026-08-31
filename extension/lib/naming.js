// naming.js — filesystem naming for archive files.
// Identity lives in frontmatter (chat_id); the FILESYSTEM name is the
// human-readable conversation title. Deterministic: the same conversation
// always maps to the same filename, so re-capture overwrites in place.

const RESERVED = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;

export function sanitizeTitle(title) {
  let t = String(title || '')
    .replace(/[\\/:*?"<>|#^]/g, ' ') // Windows-forbidden + Obsidian-hostile
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100)
    .replace(/[.\s]+$/, ''); // no trailing dots/spaces (Windows)
  if (RESERVED.test(t)) t = '_' + t;
  return t;
}

export function baseName(env) {
  const t = sanitizeTitle(env && env.title) || 'Untitled';
  const id8 =
    String((env && env.id) || '')
      .replace(/[^a-zA-Z0-9]/g, '')
      .slice(0, 8) || 'noslug';
  return `${t} (${id8})`;
}
