// sidepanel.js — v0.4.0-library: the user-approved two-folder flow.
//
//   STAGE 1 DOWNLOAD: ChatGPT -> LIBRARY FOLDER (visible directory you set in
//   Settings). One thread = one JSON file: <library>/threads/<Title> (<id>).json
//   Auto-runs on panel open. Paced, honors retry-after, self-throttling,
//   resumable.
//
//   STAGE 2 EXPORT: library JSON -> vault folder (markdown with frontmatter)
//   and optional extra output folder (markdown or JSON per setting).
//   Before each export the library JSON is compared against ChatGPT's list —
//   stale ones are refreshed first.
//
//   Row icons: 📄J copies the thread's JSON to the clipboard, 📄M copies
//   freshly-rendered markdown. ⚙ opens the Settings window.

import {
  normalizeConversationSummary,
  normalizeConversation
} from '../lib/vendors/chatgpt.js';
import { buildEnvelope } from '../lib/envelope.js';
import { renderMarkdown } from '../lib/markdown.js';
import {
  getArchiveHandle, writeArchiveFile, archiveStatus,
  getLibraryHandle, libraryStatus,
  getPlainHandle, writePlainFile, plainStatus,
  writeDerivedViews,
} from '../lib/fsaccess.js';
import { buildAllIndexes } from '../lib/indexes.js';
import { buildSearchIndex, searchArchive, parseQuery, makeSnippet, highlightHtml } from '../lib/search.js';
import { formatTimestamp } from '../lib/envelope.js';
import { listConversations, getConversation, onStage, BUILD } from '../lib/transport.js';
import { loadState, saveList, saveDiffMap, setDiffEntry } from '../lib/state.js';
import { digestTurns } from '../lib/summarize.js';

const BATCH = 50;
const $ = (id) => document.getElementById(id);

$('build-label').textContent = BUILD;

const listEl = $('chat-list');
const searchEl = $('search');
const downloadBtn = $('capture-btn'); // primary: Download all
const exportSelBtn = $('export-selected-btn');
const exportAllBtn = $('capture-all-btn'); // Export all + doubles as Stop
const moreBtn = $('more-btn');
const statusEl = $('status');
const folderBtn = $('folder-btn');
const folderLabel = $('folder-label');
const settingsBtn = $('settings-btn');
const libraryHint = $('library-hint');
const reloadBtn = $('reload-btn');
const rebuildBtn = $('rebuild-btn');
const digestBtn = $('digest-btn');
const selAllEl = $('sel-all');
const selCountEl = $('sel-count');
const loadAllBtn = $('load-all-btn');

let conversations = []; // normalized summaries from the live list
let exportedIds = new Set(); // in the vault (badge)
let checkedIds = new Set(); // selected for export
let nextOffset = 0;
let hasMore = false;
let loadingList = false;
let searchState = null; // search index over library threads
let archivedCount = 0;
let bulkRunning = false;
let bulkAbort = false;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isE2e = () => {
  try { return new URLSearchParams(location.search).has('e2e'); } catch { return false; }
};

document.addEventListener('DOMContentLoaded', init);

async function init() {
  onStage((msg) => {
    if (bulkRunning) console.log(`[convo-hist ${BUILD}] ${msg}`);
    else setStatus(msg);
  });
  setStatus(`Ready — build ${BUILD}`);

  downloadBtn.addEventListener('click', downloadAll);
  exportSelBtn.addEventListener('click', exportChecked);
  exportAllBtn.addEventListener('click', exportAllTrigger);
  settingsBtn.addEventListener('click', () => chrome.tabs.create({ url: chrome.runtime.getURL('settings/settings.html') }));
  moreBtn.addEventListener('click', () => loadConversations(nextOffset, true));
  searchEl.addEventListener('input', () => {
    const q = searchEl.value.trim();
    if (!q) { renderList(); return; }
    renderResults(q);
  });
  folderBtn.addEventListener('click', chooseFolder);
  reloadBtn.addEventListener('click', async () => {
    checkedIds.clear();
    updateButtons();
    await loadConversations(0, false);
  });
  rebuildBtn.addEventListener('click', rebuildFromLibrary);
  digestBtn.addEventListener('click', digestMissing);
  selAllEl.addEventListener('change', () => {
    if (selAllEl.checked) for (const c of conversations) checkedIds.add(c.id);
    else checkedIds.clear();
    renderList();
  });
  loadAllBtn.addEventListener('click', loadAll);

  listEl.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-copy]');
    if (btn) {
      e.stopPropagation();
      await copyThread(btn.getAttribute('data-copy'), btn.getAttribute('data-copy') ? btn.dataset.fmt : '');
      return;
    }
    const open = e.target.closest('[data-open]');
    if (open) chrome.tabs.create({ url: `https://chatgpt.com/c/${open.getAttribute('data-open')}` });
  });

  const st = await loadState();
  if (st.list && st.list.length) {
    conversations = st.list;
    renderList();
    setStatus(`${conversations.length} conversations (cached) — refreshing…`, 'warn');
  }

  await refreshFolderStatus();
  await refreshLibraryStatus();
  await refreshSearchIndex();
  await loadConversations(0, false);

  // STAGE 1 auto-starts. e2e pages skip it for deterministic tests.
  if (!isE2e()) downloadAll();
}

function setStatus(text, kind = '') {
  statusEl.textContent = text;
  statusEl.className = 'status ' + kind;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

function authHint(err) {
  if (err && (err.status === 401 || err.status === 403)) {
    return ' — open chatgpt.com and make sure you are logged in, then hit ↻';
  }
  if (err && err.status === 429) return ' — rate limited, pacing automatically';
  return '';
}

async function refreshFolderStatus() {
  const st = await archiveStatus();
  folderLabel.textContent = st.state === 'granted' ? `📁 ${st.name}` :
    (st.state === 'needs-permission' ? `📁 ${st.name} (re-grant)` : 'Vault folder…');
}

async function refreshLibraryStatus() {
  const st = await libraryStatus();
  libraryHint.textContent = st.state === 'granted'
    ? `library: ${st.name}`
    : (st.state === 'needs-permission' ? `library: ${st.name} (re-grant)` : 'library: not set — ⚙ Settings');
}

async function chooseFolder() {
  try {
    const handle = await getArchiveHandle({ interactive: true });
    await refreshFolderStatus();
    if (handle) setStatus(`Vault folder: ${handle.name}`, 'ok');
  } catch (e) {
    if (e && e.name === 'AbortError') return;
    setStatus(`Folder error: ${e.message}`, 'err');
  }
}

async function loadConversations(offset, append) {
  if (loadingList) return true;
  loadingList = true;

  try {
    if (!append) {
      listEl.innerHTML = '<div class="notice">Loading conversations…</div>';
    }
    setStatus('Loading conversations…');

    const data = await listConversations(offset, BATCH);
    const items = (data && data.items) || [];
    const normalized = items.map(normalizeConversationSummary);

    if (append) {
      const seen = new Set(conversations.map((c) => c.id));
      for (const c of normalized) {
        if (!seen.has(c.id)) {
          conversations.push(c);
          seen.add(c.id);
        }
      }
    } else {
      conversations = normalized;
    }

    nextOffset = offset + BATCH;
    const total = data && typeof data.total === 'number' ? data.total : null;
    hasMore = items.length === BATCH && (total === null || nextOffset < total);

    moreBtn.hidden = !hasMore;
    renderList();
    setStatus(`Found ${total ?? conversations.length} · ${conversations.length} listed.`, 'ok');
    saveList(conversations);
    return true;
  } catch (err) {
    listEl.innerHTML =
      `<div class="notice">Could not load conversations.<br>` +
      `<span class="diag">${escapeHtml(err && err.message ? err.message : String(err))}</span><br><br>` +
      `If this persists, right-click the panel → Inspect → Console,<br>and paste the red lines to the console chat.</div>`;
    setStatus(`List failed: ${err && err.message ? err.message : String(err)}`, 'err');
    return false;
  } finally {
    loadingList = false;
  }
}

async function loadAll() {
  if (loadingList || bulkRunning) return;
  loadAllBtn.disabled = true;
  loadAllBtn.textContent = 'Loading…';
  try {
    let guard = 0;
    while (hasMore && guard++ < 100) {
      const ok = await loadConversations(nextOffset, true);
      if (!ok) break;
      if (hasMore) await sleep(300);
    }
    setStatus(`${conversations.length} conversations loaded (all pages).`, 'ok');
  } finally {
    loadAllBtn.disabled = false;
    loadAllBtn.textContent = 'Load all';
    updateButtons();
  }
}

// ---------------------------------------------------------------------------
// STAGE 1 — DOWNLOAD: ChatGPT -> library folder (one JSON per thread).

async function fetchAllSummaries() {
  const all = new Map();
  let offset = 0;
  for (;;) {
    const data = await listConversations(offset, BATCH);
    const items = (data && data.items) || [];
    for (const item of items) {
      const c = normalizeConversationSummary(item);
      if (!all.has(c.id)) all.set(c.id, c);
    }
    if (items.length < BATCH || bulkAbort) break;
    offset += BATCH;
    if (offset > 100 * BATCH) break; // hard safety: 100 pages
    await sleep(300);
  }
  return [...all.values()];
}

async function downloadAll() {
  if (bulkRunning) {
    bulkAbort = true;
    setStatus('Stopping after the current fetch…', 'warn');
    return;
  }

  // The library grant needs a user gesture — this click is one. If it's not
  // granted yet, the picker opens right here.
  const lib = await getLibraryHandle({ interactive: true }).catch(() => null);
  if (!lib) {
    setStatus('No library folder — open ⚙ Settings and choose one.', 'err');
    return;
  }
  await refreshLibraryStatus();

  bulkRunning = true;
  bulkAbort = false;
  exportAllBtn.textContent = 'Stop';
  exportSelBtn.disabled = true;
  moreBtn.hidden = true;
  rebuildBtn.disabled = true;
  digestBtn.disabled = true;
  loadAllBtn.disabled = true;

  try {
    setStatus('Crawling conversation list…');
    const summaries = await fetchAllSummaries();
    if (!summaries.length) {
      setStatus('No conversations found.', 'warn');
      return;
    }
    setStatus(`Found ${summaries.length} · checking what's already in the library…`);

    // Library diff: id -> updated ISO from the JSON files on disk.
    const { envelopes } = await readLibraryEnvelopes();
    const libUpdated = new Map(envelopes.map((e) => [e.id, e.updated || e.created || '']));
    const targets = summaries.filter((c) => {
      const have = libUpdated.get(c.id);
      return !have || !c.updated || c.updated > have;
    });

    let downloaded = 0;
    let unchanged = summaries.length - targets.length;
    let failed = 0;
    let consecutiveFails = 0;
    let pacing = 400;
    let recentFails = 0; // failures within the last 10 items — rate governor
    let recentCount = 0;
    const failures = [];

    for (let i = 0; i < targets.length; i++) {
      if (bulkAbort) break;
      const c = targets[i];
      setStatus(`Downloading ${i + 1}/${targets.length}: ${c.title}`, 'warn');
      downloadBtn.textContent = `⤓ ${i + 1}/${targets.length}`;
      try {
        const raw = await getConversation(c.id);
        const env = buildEnvelope(normalizeConversation(raw));
        const path = await writeLibraryThread(env);
        diffIndexPut(c.id, env.updated || env.created || '');
        downloaded++;
        consecutiveFails = 0;
      } catch (e) {
        if (e && (e.status === 401 || e.status === 403)) {
          console.error(`[convo-hist ${BUILD}] download stopped at "${c.title}" (${c.id}): ${e.message}`);
          setStatus(`Download stopped: ${e.message} — log in on chatgpt.com, then run Download all again.`, 'err');
          return;
        }
        const msg = e && e.message ? e.message : String(e);
        console.warn(`[convo-hist ${BUILD}] download failed: "${c.title}" (${c.id}) — ${msg}`);
        if (failures.length < 3) failures.push(`${c.title}: ${msg}`);
        failed++;
        consecutiveFails++;
        recentFails++;
        // Rate governor: two failures in any 10-item window => slow down hard.
        // Server-provided retry-after (429) is honored exactly.
        if (recentFails >= 2 && pacing < 8000) {
          pacing = Math.min(pacing * 2, 8000);
          console.warn(`[convo-hist ${BUILD}] throttling: pacing raised to ${pacing}ms (rate limiter active)`);
        }
        if (e && e.retryAfterMs) await sleep(e.retryAfterMs);
        if (consecutiveFails >= 3) {
          setStatus(
            `Download paused: 3 in a row failed (last: ${c.title} — ${msg}). ` +
              `Everything downloaded is safe in the library; run Download all again to resume.`,
            'err'
          );
          return;
        }
      }
      recentCount++;
      if (recentCount >= 10) { recentCount = 0; recentFails = 0; }
      if ((i + 1) % 25 === 0) {
        console.log(`[convo-hist ${BUILD}] download progress: ${i + 1}/${targets.length}` +
          ` (new ${downloaded}, failed ${failed}, pacing ${pacing}ms)`);
      }
      await sleep(pacing);
    }

    const stopped = bulkAbort ? ' (stopped early — run Download all again to resume)' : '';
    const reasonNote = failed
      ? ` · first: ${failures[0]}${failed > 1 ? ` (+${failed - 1} more — open the panel console)` : ''}`
      : '';
    setStatus(
      `Download done: ${downloaded} new, ${unchanged} unchanged, ${failed} failed — ` +
        `library holds ${envelopes.length + downloaded} threads${stopped}${reasonNote}.`,
      failed ? 'warn' : 'ok'
    );
    await refreshSearchIndex();
  } catch (e) {
    setStatus(`Download failed: ${e.message}`, 'err');
  } finally {
    bulkRunning = false;
    bulkAbort = false;
    downloadBtn.textContent = 'Download all';
    rebuildBtn.disabled = false;
    updateButtons();
    renderList();
  }
}

// Small in-memory diff-index mirror (persisted via state.js, best-effort).
function diffIndexPut(id, updated) {
  setDiffEntry(id, updated); // fire-and-forget
}

// ---------------------------------------------------------------------------
// STAGE 2 — EXPORT: library JSON -> vault (markdown) + optional plain folder.

function exportAllTrigger() {
  if (bulkRunning) {
    bulkAbort = true;
    setStatus('Stopping after the current export…', 'warn');
    return;
  }
  exportTargets(null);
}

async function exportChecked() {
  if (bulkRunning) return;
  const targets = conversations.filter((c) => checkedIds.has(c.id));
  if (!targets.length) return;
  exportTargets(targets);
}

async function exportTargets(targets) {
  // Grants must happen inside the click gesture.
  const vault = await getArchiveHandle({ interactive: true }).catch(() => null);
  if (!vault) {
    setStatus('No vault folder granted — click 📁 (or ⚙ Settings).', 'err');
    return;
  }
  await refreshFolderStatus();
  const plain = await getPlainHandle({ interactive: true }).catch(() => null); // optional
  const st = await loadState();
  const plainFormat = st.plainFormat || 'md';

  if (!targets) {
    const { envelopes, noLibrary } = await readLibraryEnvelopes();
    if (noLibrary || !envelopes.length) {
      setStatus('Library is empty — run Download all first.', 'warn');
      return;
    }
    targets = envelopes.map((env) => ({ id: env.id, title: env.title, updated: env.updated }));
  }

  bulkRunning = true;
  bulkAbort = false;
  const prevLabel = exportAllBtn.textContent;
  exportAllBtn.textContent = 'Stop';
  downloadBtn.disabled = true;
  exportSelBtn.disabled = true;
  moreBtn.hidden = true;
  rebuildBtn.disabled = true;
  digestBtn.disabled = true;
  loadAllBtn.disabled = true;

  try {
    // Diff-before-export: what's the vault already holding (id -> updated)?
    const { envelopes: vaultEnvs } = await readVaultEnvelopes();
    const vaultUpdated = new Map(vaultEnvs.map((e) => [e.id, e.updated || e.created || '']));
    // And the live list — for the staleness check the user asked for:
    // "before we push it out, compare and see if the JSON we have is up to date".
    const listById = new Map(conversations.map((c) => [c.id, c]));

    let exported = 0;
    let refreshed = 0;
    let unchanged = 0;
    let failed = 0;
    let consecutiveFails = 0;
    const failures = [];

    for (let i = 0; i < targets.length; i++) {
      if (bulkAbort) break;
      const t = targets[i];
      let env = (await readLibraryEnvelopesOne(t.id));

      // Staleness check: the live list is newer than our library JSON?
      const live = listById.get(t.id);
      if (env && live && live.updated && env.updated && live.updated > env.updated) {
        setStatus(`Refreshing ${i + 1}/${targets.length}: ${t.title}`, 'warn');
        try {
          const raw = await getConversation(t.id);
          env = buildEnvelope(normalizeConversation(raw));
          await writeLibraryThread(env);
          diffIndexPut(t.id, env.updated || env.created || '');
          refreshed++;
        } catch (e) {
          // Can't refresh (rate limit etc.) — export what we have rather than
          // blocking the whole batch; the next run will try again.
          console.warn(`[convo-hist ${BUILD}] refresh skipped: "${t.title}" — ${e.message}`);
        }
      }
      if (!env) continue; // not in the library and refresh failed — skip quietly

      if (vaultUpdated.get(t.id) && env.updated && env.updated <= vaultUpdated.get(t.id)) {
        exportedIds.add(t.id);
        checkedIds.delete(t.id);
        unchanged++;
        continue;
      }

      setStatus(`Exporting ${i + 1}/${targets.length}: ${env.title}`, 'warn');
      try {
        const md = renderMarkdown(env);
        await writeArchiveFile(env, md, { includeJson: false });
        if (plain) await writePlainFile(env, md, plainFormat);
        exportedIds.add(t.id);
        checkedIds.delete(t.id);
        exported++;
        consecutiveFails = 0;
      } catch (e) {
        const msg = e && e.message ? e.message : String(e);
        console.warn(`[convo-hist ${BUILD}] export failed: "${env.title}" (${env.id}) — ${msg}`);
        if (failures.length < 3) failures.push(`${env.title}: ${msg}`);
        failed++;
        consecutiveFails++;
        if (consecutiveFails >= 3) {
          setStatus(`Export paused: 3 in a row failed (last: ${msg}). Run Export all again to resume.`, 'err');
          return;
        }
      }
      await sleep(120);
    }

    let indexNote = '';
    try {
      const { envelopes } = await readLibraryEnvelopes();
      await writeDerivedViews(buildAllIndexes(envelopes));
      searchState = buildSearchIndex(envelopes);
      archivedCount = envelopes.length;
      indexNote = ` · indexes + search updated (${envelopes.length})`;
    } catch {
      indexNote = ' · indexes not updated';
    }

    const stopped = bulkAbort ? ' (stopped early — run Export all again to resume)' : '';
    const reasonNote = failed
      ? ` · first: ${failures[0]}${failed > 1 ? ` (+${failed - 1} more — open the panel console)` : ''}`
      : '';
    setStatus(
      `Export done: ${exported} written, ${unchanged} unchanged, ${refreshed} refreshed, ${failed} failed` +
        `${indexNote}${stopped}${reasonNote}.`,
      failed ? 'warn' : 'ok'
    );
  } catch (e) {
    setStatus(`Export failed: ${e.message}`, 'err');
  } finally {
    bulkRunning = false;
    bulkAbort = false;
    exportAllBtn.textContent = prevLabel;
    rebuildBtn.disabled = false;
    updateButtons();
    renderList();
  }
}

// Vault readers (what's already exported).
async function readVaultEnvelopes() {
  try {
    return await readArchiveEnvelopes();
  } catch {
    return { envelopes: [] };
  }
}

// Single library envelope by id (scan once, cache for the batch).
let libCache = null;
async function readLibraryEnvelopesOne(id) {
  if (!libCache) {
    const { envelopes } = await readLibraryEnvelopes();
    libCache = new Map(envelopes.map((e) => [e.id, e]));
  }
  return libCache.get(id) || null;
}
function invalidateLibCache() { libCache = null; }

// ---------------------------------------------------------------------------
// Row actions — 📄J (copy JSON) / 📄M (copy markdown, rendered on the fly).

async function copyThread(chatId, fmt) {
  invalidateLibCache();
  const env = await readLibraryEnvelopesOne(chatId);
  if (!env) {
    setStatus('Thread not in the library yet — run Download all.', 'warn');
    return;
  }
  const text = fmt === 'json' ? JSON.stringify(env, null, 2) : renderMarkdown(env);
  try {
    await navigator.clipboard.writeText(text);
    setStatus(`Copied ${fmt === 'json' ? 'JSON' : 'markdown'}: ${env.title}`, 'ok');
  } catch {
    setStatus('Clipboard blocked by the browser.', 'err');
  }
}

// Single-thread export (double-click a row): refresh-if-stale, then export.
async function capture(chatId) {
  setStatus('Preparing thread…');
  invalidateLibCache();
  let env = await readLibraryEnvelopesOne(chatId);
  const live = conversations.find((c) => c.id === chatId);
  if (!env || (live && live.updated && env.updated && live.updated > env.updated)) {
    try {
      const raw = await getConversation(chatId);
      env = buildEnvelope(normalizeConversation(raw));
      await writeLibraryThread(env);
      diffIndexPut(chatId, env.updated || env.created || '');
      invalidateLibCache();
    } catch (err) {
      setStatus(`Fetch failed: ${err.message}${authHint(err)}`, 'err');
      if (!env) return; // nothing to export
    }
  }

  const vault = await getArchiveHandle({ interactive: true }).catch(() => null);
  if (!vault) {
    setStatus('No vault folder granted — click 📁 first.', 'err');
    return;
  }
  const plain = await getPlainHandle({ interactive: true }).catch(() => null);
  const st = await loadState();
  const plainFormat = st.plainFormat || 'md';

  try {
    const md = renderMarkdown(env);
    await writeArchiveFile(env, md, { includeJson: false });
    if (plain) await writePlainFile(env, md, plainFormat);
    exportedIds.add(chatId);
    renderList();

    let indexNote = '';
    try {
      const { envelopes } = await readLibraryEnvelopes();
      await writeDerivedViews(buildAllIndexes(envelopes));
      searchState = buildSearchIndex(envelopes);
      archivedCount = envelopes.length;
      indexNote = ` · indexes + search updated (${envelopes.length})`;
    } catch {
      indexNote = ' · indexes not updated';
    }
    try {
      await navigator.clipboard.writeText(md);
      setStatus(`Exported ${env.title}${indexNote} · copied to clipboard`, 'ok');
    } catch {
      setStatus(`Exported ${env.title}${indexNote} (clipboard blocked)`, 'ok');
    }
  } catch (e) {
    setStatus(`Export failed: ${e.message}`, 'err');
  }
}

// ---------------------------------------------------------------------------
// M4 digest — summarizes/tags LIBRARY threads in place (JSON is the truth;
// the vault markdown refreshes on the next export).

async function digestMissing() {
  if (bulkRunning) {
    bulkAbort = true;
    setStatus('Stopping after the current digest…', 'warn');
    return;
  }

  const lib = await getLibraryHandle({ interactive: true }).catch(() => null);
  if (!lib) {
    setStatus('No library folder — open ⚙ Settings and choose one.', 'err');
    return;
  }
  const { envelopes } = await readLibraryEnvelopes();
  const targets = envelopes.filter((env) => !env.summary || !(env.tags || []).length);
  if (!targets.length) {
    setStatus(`Nothing to digest — all ${envelopes.length} threads already have summaries.`, 'ok');
    return;
  }

  bulkRunning = true;
  bulkAbort = false;
  exportAllBtn.textContent = 'Stop';
  downloadBtn.disabled = true;
  exportSelBtn.disabled = true;
  moreBtn.hidden = true;
  rebuildBtn.disabled = true;
  digestBtn.disabled = true;
  loadAllBtn.disabled = true;

  let done = 0;
  let failed = 0;
  let backendLabel = '';
  let consecutiveFails = 0;
  const failures = [];

  try {
    for (let i = 0; i < targets.length; i++) {
      if (bulkAbort) break;
      const env = targets[i];
      setStatus(`Digesting ${i + 1}/${targets.length}: ${env.title}`, 'warn');
      try {
        const d = await digestTurns(env);
        env.summary = d.summary;
        env.tags = d.tags;
        backendLabel = d.backend;
        await writeLibraryThread(env);
        invalidateLibCache();
        done++;
        consecutiveFails = 0;
      } catch (e) {
        const msg = e && e.message ? e.message : String(e);
        console.warn(`[convo-hist ${BUILD}] digest failed: "${env.title}" (${env.id}) — ${msg}`);
        if (failures.length < 3) failures.push(`${env.title}: ${msg}`);
        failed++;
        consecutiveFails++;
        if (consecutiveFails >= 3) {
          setStatus(`Digest paused: 3 failures in a row (last: ${msg}).`, 'err');
          return;
        }
      }
      await sleep(300);
    }

    try {
      const { envelopes: fresh } = await readLibraryEnvelopes();
      await writeDerivedViews(buildAllIndexes(fresh));
      searchState = buildSearchIndex(fresh);
      archivedCount = fresh.length;
    } catch { /* indexes refresh on next rebuild */ }

    const stopped = bulkAbort ? ' (stopped early)' : '';
    const reasonNote = failed
      ? ` · first: ${failures[0]}${failed > 1 ? ` (+${failed - 1} more — console)` : ''}`
      : '';
    setStatus(
      `Digest done: ${done} summarized via ${backendLabel || 'fallback'}, ${failed} failed${reasonNote}${stopped}. ` +
        'Run Export all to refresh the vault markdown.',
      failed ? 'warn' : 'ok'
    );
  } catch (e) {
    setStatus(`Digest failed: ${e.message}`, 'err');
  } finally {
    bulkRunning = false;
    bulkAbort = false;
    exportAllBtn.textContent = 'Export all';
    rebuildBtn.disabled = false;
    updateButtons();
    renderList();
  }
}

// Rebuild derived views from the library (the source of truth).
async function rebuildFromLibrary() {
  setStatus('Reading library…');
  try {
    const { envelopes, skipped, noLibrary } = await readLibraryEnvelopes();
    if (noLibrary) {
      setStatus('No library folder — open ⚙ Settings and choose one.', 'err');
      return;
    }
    if (!envelopes.length) {
      setStatus('Library is empty — run Download all first.', 'warn');
      return;
    }
    const { files } = await writeDerivedViews(buildAllIndexes(envelopes));
    searchState = buildSearchIndex(envelopes);
    archivedCount = envelopes.length;
    setStatus(
      `Rebuilt: ${files} index files from ${envelopes.length} threads` +
        (skipped ? ` (${skipped} unreadable skipped)` : ''),
      'ok'
    );
  } catch (e) {
    setStatus(`Rebuild failed: ${e.message}`, 'err');
  }
}

async function refreshSearchIndex() {
  try {
    const { envelopes } = await readLibraryEnvelopes();
    searchState = buildSearchIndex(envelopes);
    archivedCount = envelopes.length;
  } catch (e) {
    console.error('search index build failed:', e);
    searchState = null;
    archivedCount = 0;
  }
}

function updateButtons() {
  const n = checkedIds.size;
  exportSelBtn.textContent = n > 0 ? `Export selected (${n})` : 'Export selected';
  exportSelBtn.disabled = bulkRunning || n === 0;
  selCountEl.textContent = `${n} selected`;
  loadAllBtn.hidden = !hasMore || bulkRunning;
  digestBtn.disabled = bulkRunning;
}

function updateSelAllState(shown) {
  const list = shown || conversations;
  const n = list.filter((c) => checkedIds.has(c.id)).length;
  selAllEl.checked = list.length > 0 && n === list.length;
  selAllEl.indeterminate = n > 0 && n < list.length;
}

function renderList() {
  const q = searchEl.value.trim().toLowerCase();
  listEl.innerHTML = '';

  const shown = q
    ? conversations.filter((c) => c.title.toLowerCase().includes(q))
    : conversations;

  updateSelAllState(shown);
  updateButtons();

  if (!shown.length) {
    listEl.innerHTML = `<div class="notice">${
      q ? 'No matches.' : 'No conversations found.'
    }</div>`;
    return;
  }

  for (const c of shown) {
    const div = document.createElement('div');
    div.className = 'chat-item' + (exportedIds.has(c.id) ? ' captured' : '');
    div.role = 'option';

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = checkedIds.has(c.id);
    cb.title = 'Select for export';
    cb.addEventListener('click', (e) => e.stopPropagation());
    cb.addEventListener('change', () => {
      if (cb.checked) checkedIds.add(c.id);
      else checkedIds.delete(c.id);
      updateButtons();
      updateSelAllState(shown);
    });

    const body = document.createElement('div');
    body.className = 'body';
    const t = document.createElement('span');
    t.className = 't';
    t.textContent = c.title;
    t.title = c.title;
    const m = document.createElement('span');
    m.className = 'm';
    m.textContent = c.updated ? `updated ${c.updated.slice(0, 10)}` : '';
    body.append(t, m);

    const btnJson = document.createElement('button');
    btnJson.className = 'rowbtn';
    btnJson.textContent = '📄J';
    btnJson.title = 'Copy this thread\'s JSON to the clipboard';
    btnJson.setAttribute('data-copy', c.id);
    btnJson.dataset.fmt = 'json';

    const btnMd = document.createElement('button');
    btnMd.className = 'rowbtn';
    btnMd.textContent = '📄M';
    btnMd.title = 'Copy this thread\'s markdown to the clipboard';
    btnMd.setAttribute('data-copy', c.id);
    btnMd.dataset.fmt = 'md';

    div.append(cb, body, btnJson, btnMd);
    div.addEventListener('click', (e) => {
      if (e.target.closest('.rowbtn')) return; // buttons handle themselves
      cb.checked = !cb.checked;
      cb.dispatchEvent(new Event('change'));
    });
    div.addEventListener('dblclick', () => capture(c.id));
    listEl.appendChild(div);
  }
}

// ---------------------------------------------------------------------------
// Results mode — tags-first cards over the library threads.

function renderResults(q) {
  if (!searchState) {
    listEl.innerHTML =
      '<div class="notice">Nothing indexed yet.<br>Run Download all, then Rebuild.</div>';
    return;
  }

  const { tokens } = parseQuery(q);
  const results = searchArchive(searchState, q);

  if (!results.length) {
    listEl.innerHTML = `<div class="notice">No matches in ${archivedCount} archived conversation${archivedCount === 1 ? '' : 's'}.</div>`;
    return;
  }

  listEl.innerHTML = results.map((g) => resultCardHtml(g, tokens)).join('');
}

function resultCardHtml(g, tokens) {
  const chips = g.tags.length
    ? g.tags.map((t) => `<span class="chip">#${escapeHtml(t)}</span>`).join('')
    : '<span class="chip dim">untagged</span>';
  const hits = g.hits
    .slice(0, 3)
    .map((h) => {
      const s = makeSnippet(h.text, tokens);
      return (
        '<div class="r-snippet">' +
        `<span class="r-role">${escapeHtml(h.role.toUpperCase())} — ${escapeHtml(formatTimestamp(h.timestamp))}</span>` +
        `${escapeHtml(s.prefix)}${highlightHtml(s.text, tokens)}${escapeHtml(s.suffix)}` +
        '</div>'
      );
    })
    .join('');

  return (
    '<div class="result-card">' +
    `<div class="chips">${chips}</div>` +
    `<div class="r-title" data-open="${escapeHtml(g.convId)}">${escapeHtml(g.title)}` +
    `<span class="r-meta">${g.hits.length} hit${g.hits.length === 1 ? '' : 's'}</span></div>` +
    (g.summary ? `<div class="r-summary">${escapeHtml(g.summary)}</div>` : '') +
    hits +
    `<button class="r-open ghost" data-open="${escapeHtml(g.convId)}">Open in ChatGPT ↗</button>` +
    '</div>'
  );
}
