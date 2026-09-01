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

// Test-hook (documented, APPROACH.md §6): e2e pages grant all three folders
// non-interactively — the polyfilled showDirectoryPicker needs no gesture,
// and this keeps tests deterministic without UI-specific clicking.
const IS_E2E = (() => {
  try { return new URLSearchParams(location.search).has('e2e'); } catch { return false; }
})();

const HANDLE_KEY = 'archiveHandle';     // the vault/Obsidian folder
const LIBRARY_KEY = 'libraryHandle';    // the downloaded-JSON folder
const PLAIN_KEY = 'plainHandle';        // optional plain output folder
let cachedHandle = null;
let cachedLibrary = null;
let cachedPlain = null;

// ---------------------------------------------------------------------------
// Library folder — where downloaded thread JSONs live (one thread = one file).

export async function getLibraryHandle({ interactive = false } = {}) {
  if (cachedLibrary) return cachedLibrary;
  const stored = await idbGet(LIBRARY_KEY);
  if (stored) {
    const perm = await stored.queryPermission({ mode: 'readwrite' });
    if (perm === 'granted') {
      cachedLibrary = stored;
      return cachedLibrary;
    }
    if (!interactive) return null;
    const p = await stored.requestPermission({ mode: 'readwrite' });
    if (p === 'granted') {
      cachedLibrary = stored;
      return cachedLibrary;
    }
    return null;
  }
  if (!interactive) return null;
  cachedLibrary = await showDirectoryPicker({ mode: 'readwrite', id: 'convo-library' });
  await idbSet(LIBRARY_KEY, cachedLibrary);
  return cachedLibrary;
}

export async function forgetLibraryHandle() {
  cachedLibrary = null;
  await idbDel(LIBRARY_KEY);
}

export async function libraryStatus() {
  const stored = await idbGet(LIBRARY_KEY);
  if (!stored) return { state: 'none' };
  const perm = await stored.queryPermission({ mode: 'readwrite' });
  if (perm === 'granted') {
    cachedLibrary = stored;
    return { state: 'granted', name: stored.name };
  }
  return { state: 'needs-permission', name: stored.name };
}

// One thread = one file: <library>/threads/<Title> (<id8>).json
export async function writeLibraryThread(env) {
  const root = await getLibraryHandle({ interactive: false });
  if (!root) throw Object.assign(new Error('No library folder granted'), { code: 'NO_LIBRARY' });
  const dir = await root.getDirectoryHandle('threads', { create: true });
  const base = baseName(env);
  const fh = await dir.getFileHandle(`${base}.json`, { create: true });
  const w = await fh.createWritable();
  await w.write(JSON.stringify(env, null, 2));
  await w.close();

  // Title changed? Remove the old-named file for the same thread id.
  let doomed = [];
  try {
    for await (const entry of dir.values()) {
      if (entry.kind !== 'file' || !entry.name.endsWith('.json')) continue;
      const nameBase = entry.name.slice(0, -5);
      if (nameBase === base) continue;
      try {
        const parsed = JSON.parse(await (await entry.getFile()).text());
        if (parsed && parsed.id === env.id) doomed.push(nameBase);
      } catch { /* unreadable — leave it */ }
    }
    for (const old of doomed) {
      try { await dir.removeEntry(`${old}.json`); } catch { /* gone */ }
    }
  } catch { /* best-effort cleanup */ }

  return `threads/${base}.json`;
}

// Scan the library: every downloaded thread, parsed.
export async function readLibraryEnvelopes() {
  const root = await getLibraryHandle({ interactive: false });
  if (!root) return { envelopes: [], skipped: 0, noLibrary: true };
  let dir;
  try {
    dir = await root.getDirectoryHandle('threads');
  } catch {
    return { envelopes: [], skipped: 0, noLibrary: false };
  }
  const envelopes = [];
  let skipped = 0;
  for await (const entry of dir.values()) {
    if (entry.kind !== 'file' || !entry.name.endsWith('.json')) continue;
    try {
      const env = JSON.parse(await (await entry.getFile()).text());
      if (env && env.id) envelopes.push(env);
      else skipped++;
    } catch {
      skipped++;
    }
  }
  return { envelopes, skipped, noLibrary: false };
}

// ---------------------------------------------------------------------------
// Optional plain-output folder — exports as markdown or JSON per setting.

export async function getPlainHandle({ interactive = false } = {}) {
  if (cachedPlain) return cachedPlain;
  const stored = await idbGet(PLAIN_KEY);
  if (stored) {
    const perm = await stored.queryPermission({ mode: 'readwrite' });
    if (perm === 'granted') {
      cachedPlain = stored;
      return cachedPlain;
    }
    if (!interactive) return null;
    const p = await stored.requestPermission({ mode: 'readwrite' });
    if (p === 'granted') {
      cachedPlain = stored;
      return cachedPlain;
    }
    return null;
  }
  if (!interactive) return null;
  cachedPlain = await showDirectoryPicker({ mode: 'readwrite', id: 'convo-plain' });
  await idbSet(PLAIN_KEY, cachedPlain);
  return cachedPlain;
}

export async function forgetPlainHandle() {
  cachedPlain = null;
  await idbDel(PLAIN_KEY);
}

export async function plainStatus() {
  const stored = await idbGet(PLAIN_KEY);
  if (!stored) return { state: 'none' };
  const perm = await stored.queryPermission({ mode: 'readwrite' });
  if (perm === 'granted') {
    cachedPlain = stored;
    return { state: 'granted', name: stored.name };
  }
  return { state: 'needs-permission', name: stored.name };
}

export async function writePlainFile(env, md, format /* 'md' | 'json' */) {
  const root = await getPlainHandle({ interactive: false });
  if (!root) return null;
  const base = baseName(env);
  const fh = await root.getFileHandle(`${base}.${format}`, { create: true });
  const w = await fh.createWritable();
  await w.write(format === 'json' ? JSON.stringify(env, null, 2) : md);
  await w.close();
  return `${base}.${format}`;
}

// Verify-location probe: writes a marker file so the user can confirm in
// Explorer exactly which folder this handle points at (the File System Access
// API cannot reveal full paths — this is the trustworthy alternative).
export async function writeVerifyProbe(handle) {
  const fh = await handle.getFileHandle('_convo_hist_here.txt', { create: true });
  const w = await fh.createWritable();
  await w.write('Convo Hist writes files into this folder.\nDelete this file whenever you like.\n');
  await w.close();
  return handle.name;
}

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

// Writes the archive pair for one conversation. The vault is markdown-first:
// the .md always lands; the .json copy only when `includeJson` is set (the
// "keep JSON backups" toggle — raw data's home is the browser store, and it
// stays recoverable from ChatGPT by re-download). Overwrites in place —
// update-in-place on re-export is a feature, not a bug. Filenames are the
// sanitized conversation title + short id (see naming.js); any older files
// for the same chat_id under a different name are removed so the vault never
// shows dupes.
export async function writeArchiveFile(env, md, { includeJson = false } = {}) {
  const root = await getArchiveHandle({ interactive: false });
  if (!root) throw Object.assign(new Error('No archive folder granted'), {
    code: 'NO_FOLDER'
  });

  const base = baseName(env);
  if (includeJson) {
    await writeText(root, ['chats'], `${base}.json`, JSON.stringify(env, null, 2));
  }
  await writeText(root, ['chats'], `${base}.md`, md);
  await removeOrphans(root, env, base);

  return {
    jsonPath: includeJson ? `chats/${base}.json` : null,
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
