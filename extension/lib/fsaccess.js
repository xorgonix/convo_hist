// fsaccess.js — the disk side of "files are the source of truth".
// User grants the archive folder once (File System Access API); the handle
// persists in IndexedDB (it is a handle, not data — data lives on disk).
//
//   <archive>/
//     chats/<id>.json   canonical envelope (source of truth)
//     chats/<id>.md     derived view (regenerable)
//     indexes/          derived views: INDEX, months, timeline, tag MOCs

import { idbGet, idbSet, idbDel } from './idb.js';
import { baseName } from './naming.js';

const HANDLE_KEY = 'archiveHandle';
let cachedHandle = null;

export async function getArchiveHandle({ interactive = false } = {}) {
  if (cachedHandle) return cachedHandle;

  const stored = await idbGet(HANDLE_KEY);
  if (stored) {
    const perm = await stored.queryPermission({ mode: 'readwrite' });
    if (perm === 'granted') {
      cachedHandle = stored;
      return cachedHandle;
    }
    if (!interactive) return null;
    // requestPermission() must be called from a user gesture — callers
    // should only pass interactive:true from a click handler.
    const p = await stored.requestPermission({ mode: 'readwrite' });
    if (p === 'granted') {
      cachedHandle = stored;
      return cachedHandle;
    }
    return null;
  }

  if (!interactive) return null;
  cachedHandle = await showDirectoryPicker({ mode: 'readwrite' });
  await idbSet(HANDLE_KEY, cachedHandle);
  return cachedHandle;
}

export async function forgetArchiveHandle() {
  cachedHandle = null;
  await idbDel(HANDLE_KEY);
}

async function dirChain(root, segments) {
  let dir = root;
  for (const seg of segments) {
    dir = await dir.getDirectoryHandle(seg, { create: true });
  }
  return dir;
}

async function writeText(root, segments, filename, text) {
  const dir = await dirChain(root, segments);
  const fileHandle = await dir.getFileHandle(filename, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(text);
  await writable.close();
}

// Writes the canonical envelope + derived markdown. Overwrites in place —
// update-in-place on re-capture is a feature, not a bug. Filenames are the
// sanitized conversation title + short id (see naming.js); any older files
// for the same chat_id under a different name (e.g. previous title, or the
// original uuid-named files) are removed so the vault never shows dupes.
export async function writeArchiveFile(env, md) {
  const root = await getArchiveHandle({ interactive: false });
  if (!root) throw Object.assign(new Error('No archive folder granted'), {
    code: 'NO_FOLDER'
  });

  const base = baseName(env);
  await writeText(root, ['chats'], `${base}.json`, JSON.stringify(env, null, 2));
  await writeText(root, ['chats'], `${base}.md`, md);
  await removeOrphans(root, env, base);

  return {
    jsonPath: `chats/${base}.json`,
    mdPath: `chats/${base}.md`
  };
}

// Delete any other chats/<*>.json whose envelope id matches this one but
// whose filename differs (title changed, or legacy uuid-named files).
async function removeOrphans(root, env, currentBase) {
  let chats;
  try {
    chats = await root.getDirectoryHandle('chats');
  } catch {
    return 0;
  }

  const doomed = [];
  for await (const entry of chats.values()) {
    if (entry.kind !== 'file' || !entry.name.endsWith('.json')) continue;
    const nameBase = entry.name.slice(0, -5);
    if (nameBase === currentBase) continue;
    try {
      const parsed = JSON.parse(await (await entry.getFile()).text());
      if (parsed && parsed.id === env.id) doomed.push(nameBase);
    } catch {
      /* unreadable file — leave it alone */
    }
  }

  for (const base of doomed) {
    for (const ext of ['.json', '.md']) {
      try {
        // removeEntry() lives on the DIRECTORY handle — FileSystemFileHandle
        // has no remove(). (Previously this called handle.remove(), which
        // threw TypeError and silently no-oped: title-renamed chats never
        // cleaned their old files.)
        await chats.removeEntry(`${base}${ext}`);
      } catch {
        /* already gone */
      }
    }
  }
  return doomed.length;
}

export async function archiveStatus() {
  const stored = await idbGet(HANDLE_KEY);
  if (!stored) return { state: 'none' };
  const perm = await stored.queryPermission({ mode: 'readwrite' });
  if (perm === 'granted') {
    cachedHandle = stored;
    return { state: 'granted', name: stored.name };
  }
  return { state: 'needs-permission', name: stored.name };
}

// ---------------------------------------------------------------------------
// Rebuild-from-disk: the proof that disk is the source of truth. Reads every
// canonical envelope back out of chats/ — the browser cache could be wiped
// entirely and this would still reconstruct the archive's metadata.

export async function readArchiveEnvelopes() {
  const root = await getArchiveHandle({ interactive: false });
  if (!root) return { envelopes: [], skipped: 0, noFolder: true };

  let chats;
  try {
    chats = await root.getDirectoryHandle('chats');
  } catch {
    return { envelopes: [], skipped: 0, noFolder: false }; // no captures yet
  }

  const envelopes = [];
  let skipped = 0;
  for await (const entry of chats.values()) {
    if (entry.kind !== 'file' || !entry.name.endsWith('.json')) continue;
    try {
      const file = await entry.getFile();
      const env = JSON.parse(await file.text());
      if (env && env.id) envelopes.push(env);
      else skipped++;
    } catch {
      skipped++;
    }
  }
  return { envelopes, skipped, noFolder: false };
}

// Writes the generated index set produced by lib/indexes.js buildAllIndexes().
export async function writeDerivedViews(indexes) {
  const root = await getArchiveHandle({ interactive: false });
  if (!root) {
    throw Object.assign(new Error('No archive folder granted'), { code: 'NO_FOLDER' });
  }

  await writeText(root, ['indexes'], 'INDEX.md', indexes.home);
  await writeText(root, ['indexes'], 'timeline.md', indexes.timeline);
  for (const m of indexes.months) {
    await writeText(root, ['indexes'], `${m.name}.md`, m.md);
  }
  for (const t of indexes.tags) {
    await writeText(root, ['indexes', 'tags'], `${t.slug}.md`, t.md);
  }
  return {
    files: 2 + indexes.months.length + indexes.tags.length
  };
}
