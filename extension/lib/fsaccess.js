// fsaccess.js — the disk side of "files are the source of truth".
//
// Three independent folder grants (File System Access API), each with its
// own stable picker id and its own handle stored in IndexedDB (a handle is
// not data — data lives on disk):
//
//   Conversarium (library)  <library>/threads/<Title> (<id8>).json
//   Vault (archive)         <vault>/chats/<Title> (<id8>).md   (+ optional .json)
//   Secondary output        <plain>/<Title> (<id8>).md|.json
//
// The vault writes under a chats/ subdirectory — preserved for existing
// users (spec §10 decision); the User Guide claiming vault-root layout is
// superseded by this file.
//
// Handle operations are split per R-10 (the old overloaded
// get*Handle({interactive}) returned its cached/stored handle BEFORE ever
// opening the picker, which made "change folder" impossible):
//
//   getCurrent*Handle()  usable stored handle, no UI, no prompts
//   reconnect*Handle()   requestPermission on the stored handle (user gesture)
//   choose*Handle()      ALWAYS opens showDirectoryPicker, even when a
//                        folder is already configured; startIn opens the
//                        picker at the current folder when supported;
//                        cancel preserves the prior configuration
//   forget*Handle()      removes ONLY the saved handle — never folder files

import { idbGet, idbSet, idbDel } from './idb.js';
import { baseName } from './naming.js';

const HANDLE_KEY = 'archiveHandle';     // the vault/Obsidian folder
const LIBRARY_KEY = 'libraryHandle';    // the Conversarium (thread JSON)
const PLAIN_KEY = 'plainHandle';        // optional secondary output folder

// ---------------------------------------------------------------------------
// Folder operations factory (R-10). One instance per folder role.

function folderOps(handleKey, pickerId) {
  let cache = null;

  async function usable(stored) {
    const perm = await stored.queryPermission({ mode: 'readwrite' });
    return perm === 'granted';
  }

  return {
    async getCurrent() {
      if (cache) return (await usable(cache)) ? cache : null;
      const stored = await idbGet(handleKey);
      if (!stored) return null;
      if (await usable(stored)) {
        cache = stored;
        return cache;
      }
      return null;
    },

    async reconnect() {
      let stored = cache || (await idbGet(handleKey));
      if (!stored) return null;
      const p = await stored.requestPermission({ mode: 'readwrite' });
      if (p === 'granted') {
        cache = stored;
        return cache;
      }
      return null;
    },

    async choose() {
      const prior = cache || (await idbGet(handleKey));
      const opts = { mode: 'readwrite', id: pickerId };
      if (prior) opts.startIn = prior; // supported by Chromium; ignored elsewhere
      const handle = await showDirectoryPicker(opts);
      cache = handle;
      await idbSet(handleKey, handle); // persist only after successful selection
      return handle;
    },

    async forget() {
      cache = null;
      await idbDel(handleKey);
    },

    async status() {
      let stored = cache || (await idbGet(handleKey));
      if (!stored) return { state: 'none' };
      if (await usable(stored)) {
        cache = stored;
        return { state: 'granted', name: stored.name };
      }
      return { state: 'needs-permission', name: stored.name };
    },
  };
}

const libraryOps = folderOps(LIBRARY_KEY, 'convo-library');
const archiveOps = folderOps(HANDLE_KEY, 'convo-archive');
const plainOps = folderOps(PLAIN_KEY, 'convo-plain');

// Conversarium — where downloaded thread JSONs live (one thread = one file).
export const getCurrentLibraryHandle = () => libraryOps.getCurrent();
export const reconnectLibraryHandle = () => libraryOps.reconnect();
export const chooseLibraryHandle = () => libraryOps.choose();
export const forgetLibraryHandle = () => libraryOps.forget();
export const libraryStatus = () => libraryOps.status();

// Vault — markdown exports for Obsidian (never JSON unless includeJson).
export const getCurrentArchiveHandle = () => archiveOps.getCurrent();
export const reconnectArchiveHandle = () => archiveOps.reconnect();
export const chooseArchiveHandle = () => archiveOps.choose();
export const forgetArchiveHandle = () => archiveOps.forget();
export const archiveStatus = () => archiveOps.status();

// Secondary output — exports copy here too (md or json per setting).
export const getCurrentPlainHandle = () => plainOps.getCurrent();
export const reconnectPlainHandle = () => plainOps.reconnect();
export const choosePlainHandle = () => plainOps.choose();
export const forgetPlainHandle = () => plainOps.forget();
export const plainStatus = () => plainOps.status();

// ---------------------------------------------------------------------------
// Conversarium file operations.

// One thread = one file: threads/<Title> (<id8>).json
export async function writeLibraryThread(env) {
  const root = await getCurrentLibraryHandle();
  if (!root) throw Object.assign(new Error('No Conversarium folder granted'), { code: 'NO_LIBRARY' });
  const dir = await root.getDirectoryHandle('threads', { create: true });
  const base = baseName(env);
  const fh = await dir.getFileHandle(`${base}.json`, { create: true });
  const w = await fh.createWritable();
  await w.write(JSON.stringify(env, null, 2));
  await w.close();

  // Title changed? Remove the old-named file for the same thread id —
  // write-new-first, then delete-old (spec §9: never the reverse).
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

// Scan the Conversarium: every downloaded thread, parsed. Unreadable files
// are reported with names so the panel can show details without DevTools.
export async function readLibraryEnvelopes() {
  const root = await getCurrentLibraryHandle();
  if (!root) return { envelopes: [], skipped: 0, unreadable: [], noLibrary: true };
  let dir;
  try {
    dir = await root.getDirectoryHandle('threads');
  } catch {
    return { envelopes: [], skipped: 0, unreadable: [], noLibrary: false };
  }
  const envelopes = [];
  let skipped = 0;
  const unreadable = [];
  for await (const entry of dir.values()) {
    if (entry.kind !== 'file' || !entry.name.endsWith('.json')) continue;
    try {
      const env = JSON.parse(await (await entry.getFile()).text());
      if (env && env.id) envelopes.push(env);
      else {
        skipped++;
        unreadable.push({ name: entry.name, reason: 'no envelope id' });
      }
    } catch (e) {
      skipped++;
      unreadable.push({ name: entry.name, reason: e && e.message ? e.message : 'unreadable' });
    }
  }
  return { envelopes, skipped, unreadable, noLibrary: false };
}

// ---------------------------------------------------------------------------
// Secondary output file operations.

export async function writePlainFile(env, md, format /* 'md' | 'json' */) {
  const root = await getCurrentPlainHandle();
  if (!root) return null;
  const base = baseName(env);
  const fh = await root.getFileHandle(`${base}.${format}`, { create: true });
  const w = await fh.createWritable();
  await w.write(format === 'json' ? JSON.stringify(env, null, 2) : md);
  await w.close();
  return `${base}.${format}`;
}

// Verify-location probe: writes a BRANDED marker file so the user can
// confirm in Explorer exactly which folder this handle points at (the File
// System Access API cannot reveal full paths — this is the trustworthy
// alternative). Marker names the folder's configured role (R-14).
export async function writeVerifyProbe(handle, role) {
  const fh = await handle.getFileHandle('_thread_o_matic_here.txt', { create: true });
  const w = await fh.createWritable();
  await w.write(
    `Thread-O-matic writes files into this folder.\n` +
    `Configured role: ${role || 'unspecified'}.\n` +
    'Delete this file whenever you like.\n'
  );
  await w.close();
  return handle.name;
}

// ---------------------------------------------------------------------------
// Vault file operations.

async function dirChain(root, segments) {
  let dir = root;
  for (const seg of segments) {
    dir = await dir.getDirectoryHandle(seg, { create: true });
  }
  return dir;
}

async function writeText(root, segments, filename, text) {
  const dir = await dirChain(root, segments);
  const fh = await dir.getFileHandle(filename, { create: true });
  const w = await fh.createWritable();
  await w.write(text);
  await w.close();
}

export async function writeArchiveFile(env, md, { includeJson = false } = {}) {
  const root = await getCurrentArchiveHandle();
  if (!root) throw Object.assign(new Error('No vault folder granted'), { code: 'NO_FOLDER' });

  const base = baseName(env);
  if (includeJson) {
    await writeText(root, ['chats'], `${base}.json`, JSON.stringify(env, null, 2));
  }
  await writeText(root, ['chats'], `${base}.md`, md);

  // Title changed? Remove the old-named files for the same thread id.
  let doomed = [];
  try {
    const chats = await root.getDirectoryHandle('chats');
    for await (const entry of chats.values()) {
      if (entry.kind !== 'file') continue;
      const isJson = entry.name.endsWith('.json');
      const isMd = entry.name.endsWith('.md');
      if (!isJson && !isMd) continue;
      const nameBase = entry.name.slice(0, isJson ? -5 : -3);
      if (nameBase === base) continue;
      if (!isJson) continue; // only .json files carry the envelope id
      try {
        const parsed = JSON.parse(await (await entry.getFile()).text());
        if (parsed && parsed.id === env.id) doomed.push(nameBase);
      } catch { /* unreadable — leave it */ }
    }
    for (const old of doomed) {
      try { await chats.removeEntry(`${old}.json`); } catch { /* gone */ }
      try { await chats.removeEntry(`${old}.md`); } catch { /* gone */ }
    }
  } catch { /* best-effort cleanup: no chats dir yet, etc. */ }

  return {
    jsonPath: includeJson ? `chats/${base}.json` : null,
    mdPath: `chats/${base}.md`
  };
}
