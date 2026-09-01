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

// "Keep JSON backups in the vault" toggle (default OFF: the vault is
// markdown-first; the library folder holds the raw JSON).
export async function getIncludeJson() {
  const st = await loadState();
  return !!st.includeJson;
}

export async function setIncludeJson(v) {
  const st = await loadState();
  st.includeJson = !!v;
  await persist(st);
}

// First-run coach: shown once per install, never again after dismissal.
export async function getTourDone() {
  const st = await loadState();
  return !!st.tourDone;
}

export async function setTourDone() {
  const st = await loadState();
  st.tourDone = true;
  await persist(st);
}

// ---------------------------------------------------------------------------
// Settings (written by the settings window, read everywhere).

export async function getSettings() {
  const st = await loadState();
  return {
    summarizer: st.summarizer || 'auto',        // auto|gemini|ollama|lmstudio|extractive
    ollamaUrl: st.ollamaUrl || 'http://localhost:11434',
    ollamaModel: st.ollamaModel || '',
    plainFormat: st.plainFormat || 'md',        // md|json
  };
}

export async function saveSettings(patch) {
  const st = await loadState();
  Object.assign(st, patch || {});
  await persist(st);
}
