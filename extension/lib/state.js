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
const STATE_VERSION = 2;
let cached = null;

function blank() {
  return { stateVersion: STATE_VERSION };
}

// Versioned migration (spec §7): pre-0.6.0 panelState carried list/diff
// caches that Phase 2 replaced with the import checkpoint (import-state.js).
// Obsolete fields are dropped once; settings and the coach flag survive.
function migrate(st) {
  if (st.stateVersion !== STATE_VERSION) {
    delete st.list;
    delete st.diff;
    delete st.savedAt;
    st.stateVersion = STATE_VERSION;
  }
  return st;
}

// Last-known thread names, so the panel paints the list before the disk scan
// finishes (the scan is authoritative and overwrites this). Lightweight
// {id, title, updated} only — never message content.
export async function saveListCache(envs) {
  const st = await loadState();
  st.listCache = (envs || [])
    .slice(0, 5000)
    .map((e) => ({ id: e.id, title: e.title, updated: e.updated || e.created || '' }));
  await persist(st);
}

export async function loadListCache() {
  const st = await loadState();
  return Array.isArray(st.listCache) ? st.listCache : [];
}

export async function loadState() {
  if (cached) return cached;
  try {
    const res = await chrome.storage.local.get(KEY);
    cached = res && res[KEY] ? migrate(res[KEY]) : blank();
  } catch {
    cached = blank(); // storage unavailable — degrade to no-cache behavior
  }
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

// Phase 2 replaces the old list/diff cache APIs (saveList/saveDiffMap/
// setDiffEntry — removed as unused) with the versioned import-checkpoint
// model in lib/import-state.js.

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
