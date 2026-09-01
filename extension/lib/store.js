// store.js — the browser-side thread store (STAGE 1 of the flow).
// Every downloaded conversation lives here as its own storage key t:<id>,
// plus a compact index (id -> {updated, title}) used for diff decisions.
//
// Why per-key: rewriting one giant blob on every download would be O(archive)
// per item; per-key writes are incremental, resumable, and survive panel
// closes mid-download.
//
// This store IS the working archive of record for raw JSON (recoverable from
// ChatGPT by re-download; the vault holds the markdown export). The vault can
// optionally mirror JSON via the "keep JSON backups" toggle.

const PREFIX = 't:';
const IDX_KEY = 'threadIndex';

let idxCache = null; // { id: {updated, title} }

export async function loadIndex() {
  if (idxCache) return idxCache;
  try {
    const res = await chrome.storage.local.get(IDX_KEY);
    idxCache = (res && res[IDX_KEY]) || {};
  } catch {
    idxCache = {};
  }
  return idxCache;
}

async function saveIndex() {
  try {
    await chrome.storage.local.set({ [IDX_KEY]: idxCache });
  } catch { /* best-effort */ }
}

export async function putThread(env) {
  try {
    await chrome.storage.local.set({ [PREFIX + env.id]: env });
  } catch (e) {
    throw new Error(`browser store write failed — ${e && e.message}`);
  }
  const idx = await loadIndex();
  idx[env.id] = { updated: env.updated || env.created || '', title: env.title || 'Untitled' };
  await saveIndex();
}

export async function getThread(id) {
  try {
    const res = await chrome.storage.local.get(PREFIX + id);
    return res ? res[PREFIX + id] : null;
  } catch {
    return null;
  }
}

// Load every stored envelope (used for search/index rebuild + digest).
// Returns [] on any storage error — callers degrade gracefully.
export async function allThreads() {
  try {
    const all = await chrome.storage.local.get(null);
    const out = [];
    for (const [key, value] of Object.entries(all || {})) {
      if (key.startsWith(PREFIX) && value && value.id) out.push(value);
    }
    return out;
  } catch {
    return [];
  }
}

export async function threadCount() {
  const idx = await loadIndex();
  return Object.keys(idx).length;
}

// Bulk import (migration from old vaults): write many envelopes at once,
// skipping any whose stored copy is already as new.
export async function importThreads(envelopes) {
  const idx = await loadIndex();
  let added = 0;
  for (const env of envelopes || []) {
    const have = idx[env.id];
    if (have && env.updated && env.updated <= have.updated) continue;
    await putThread(env);
    added++;
  }
  return added;
}
