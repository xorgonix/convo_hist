// state.js — rebuildable browser-side state. Disk envelopes remain the source
// of truth; this cache exists for two jobs only:
//   1. list cache — the panel opens instantly with the last-known summaries
//   2. diff index (id -> updated ISO) — decides which threads need a refresh
//      without parsing every JSON on disk before a batch
// Drift is healed by "Rebuild from disk", which recomputes everything here
// from the actual envelope files.
//
// Note: the stored updates map is only used to SKIP work, never to fabricate
// content — a stale/absent entry can cause at worst an extra fetch.

const KEY = 'panelState';
let cached = null;

function blank() {
  return { list: null, diff: {}, savedAt: null };
}

export async function loadState() {
  if (cached) return cached;
  try {
    const res = await chrome.storage.local.get(KEY);
    cached = res && res[KEY] ? res[KEY] : blank();
  } catch {
    cached = blank(); // storage unavailable — degrade to no-cache behavior
  }
  if (!cached.diff) cached.diff = {};
  return cached;
}

async function persist(st) {
  cached = st;
  try {
    await chrome.storage.local.set({ [KEY]: st });
  } catch {
    /* best-effort: losing the cache costs speed, never data */
  }
}

export async function saveList(summaries) {
  const st = await loadState();
  st.list = summaries;
  st.savedAt = new Date().toISOString();
  await persist(st);
}

export async function saveDiffMap(mapObj) {
  const st = await loadState();
  st.diff = mapObj;
  await persist(st);
}

// Fire-and-forget single-entry update after a successful capture.
export async function setDiffEntry(id, updated) {
  const st = await loadState();
  st.diff[id] = updated;
  await persist(st);
}
