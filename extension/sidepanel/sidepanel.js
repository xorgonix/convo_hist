// sidepanel.js — v0.6.0 Phase 0 baseline. The v0.5.x workflow is intact;
// v0.6.0 phases (spec: extension/SPECS/Thread-O-matic-v0.6.0-Extension-Change-Specification.md) restructure it:
//
//   THE PANEL LIST IS THE LIBRARY. A line item means the JSON file exists
//   in the library folder. Nothing else is listed.
//
//   DOWNLOAD: crawl ChatGPT's list -> write new/changed threads into
//   <library>/threads/<Title> (<id>).json. Paced, honors retry-after,
//   self-throttling, resumable. (Phase 2 replaces this with the import
//   controller: durable checkpoint, no auto-start, AbortSignal Stop.)
//
//   EXPORT: selected threads (or all if none selected) -> vault folder as
//   markdown (frontmatter built from the envelope) and, if configured, a
//   second output folder as markdown or JSON. (Phase 4 makes this
//   strictly local-only: no ChatGPT refresh during Export.)
//
//   DIGEST: fills summary + tags on library threads in place.
//
//   No index files. No JSON in the vault. No extra buttons.

import {
  normalizeConversationSummary,
  normalizeConversation
} from '../lib/vendors/chatgpt.js';
import { buildEnvelope } from '../lib/envelope.js';
import { renderMarkdown } from '../lib/markdown.js';
import {
  getCurrentArchiveHandle, reconnectArchiveHandle, chooseArchiveHandle,
  writeArchiveFile, archiveStatus,
  getCurrentLibraryHandle, reconnectLibraryHandle, chooseLibraryHandle, libraryStatus,
  getCurrentPlainHandle, writePlainFile, plainStatus,
  readLibraryEnvelopes, writeLibraryThread,
} from '../lib/fsaccess.js';
import { buildSearchIndex, searchArchive, parseQuery, makeSnippet, highlightHtml } from '../lib/search.js';
import { formatTimestamp } from '../lib/envelope.js';
import { listConversations, getConversation, onStage, BUILD } from '../lib/transport.js';
import { loadState, getTourDone, setTourDone } from '../lib/state.js';
import {
  startNewImport, resumeImport, discardJob, stop as stopImport,
  isRunning as importRunning, hasResumable as importResumable, setEmitter,
} from '../lib/import-controller.js';
import { digestTurns } from '../lib/summarize.js';

const BATCH = 50;
const $ = (id) => document.getElementById(id);

$('build-label').textContent = BUILD;

const listEl = $('chat-list');
const searchEl = $('search');
const downloadBtn = $('capture-btn');    // primary: Import
const exportBtn = $('capture-all-btn');  // Export (selected, or all)
const moreBtn = $('more-btn');
const statusEl = $('status');
const folderBtn = $('folder-btn');
const folderLabel = $('folder-label');
const settingsBtn = $('settings-btn');
const libraryHint = $('library-hint');
const reloadBtn = $('reload-btn');
const digestBtn = $('digest-btn');
const stopBtn = $('stop-btn');
const newImportBtn = $('new-import-btn');
const selAllEl = $('sel-all');
const selCountEl = $('sel-count');
const loadAllBtn = $('load-all-btn');

let libraryEnvs = [];      // the Conversarium: every downloaded thread (the list)
let exportedIds = new Set(); // in the vault (badge)
let checkedIds = new Set();  // selected for export
let conversations = [];      // last crawled ChatGPT summaries (staleness checks)
let hasMore = false;
let nextOffset = 0;
let loadingList = false;
let searchState = null;
let archivedCount = 0;
let bulkRunning = false;
let bulkAbort = false;
let libState = { state: 'none', name: '' }; // last known Conversarium grant state (R-11 views)
let lastUnreadable = [];  // files that failed to parse during the last scan (R-11)

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
  setEmitter(onControllerEvent);
  setStatus(`Ready — build ${BUILD}`);

  downloadBtn.addEventListener('click', importClicked);
  stopBtn.addEventListener('click', () => stopImport());
  newImportBtn.addEventListener('click', async () => {
    if (importRunning()) return;
    if (!confirm('Discard the unfinished import checkpoint and start a fresh scan? Imported threads are kept.')) return;
    await discardJob();
    setStatus('Previous import discarded (no files deleted).');
    importClicked();
  });
  exportBtn.addEventListener('click', exportTrigger);
  settingsBtn.addEventListener('click', () => chrome.tabs.create({ url: chrome.runtime.getURL('settings/settings.html') }));
  $('help-btn').addEventListener('click', () => chrome.tabs.create({ url: chrome.runtime.getURL('help/help.html') }));
  moreBtn.addEventListener('click', () => loadConversations(nextOffset, true));
  searchEl.addEventListener('input', () => {
    const q = searchEl.value.trim();
    if (!q) { renderList(); return; }
    renderResults(q);
  });
  folderBtn.addEventListener('click', chooseFolder);
  // Conversarium label: click to reconnect when the browser dropped access (R-10/R-11).
  libraryHint.addEventListener('click', ensureLibraryFromClick);
  reloadBtn.addEventListener('click', async () => {
    checkedIds.clear();
    updateButtons();
    await refreshLibraryStatus(); // local-only: re-reads folder state, never ChatGPT
    await loadLibrary();
  });
  digestBtn.addEventListener('click', digestMissing);
  selAllEl.addEventListener('change', () => {
    if (selAllEl.checked) for (const env of libraryEnvs) checkedIds.add(env.id);
    else checkedIds.clear();
    renderList();
  });
  loadAllBtn.addEventListener('click', loadAll);

  listEl.addEventListener('click', async (e) => {
    const action = e.target.closest('[data-action]');
    if (action) {
      e.stopPropagation();
      if (action.getAttribute('data-action') === 'choose-library') {
        try {
          const h = await chooseLibraryHandle();
          if (h) { await refreshLibraryStatus(); await loadLibrary(); }
        } catch (err) { if (err && err.name !== 'AbortError') setStatus(`Folder error: ${err.message}`, 'err'); }
      } else if (action.getAttribute('data-action') === 'reconnect-library') {
        try {
          const h = await reconnectLibraryHandle();
          if (h) { await refreshLibraryStatus(); await loadLibrary(); }
          else setStatus('Access was not granted. Click Reconnect to try again.', 'warn');
        } catch (err) { if (err && err.name !== 'AbortError') setStatus(`Folder error: ${err.message}`, 'err'); }
      }
      return;
    }
    const btn = e.target.closest('[data-copy]');
    if (btn) {
      e.stopPropagation();
      await copyThread(btn.getAttribute('data-copy'), btn.dataset.fmt);
      return;
    }
    const open = e.target.closest('[data-open]');
    if (open) chrome.tabs.create({ url: `https://chatgpt.com/c/${open.getAttribute('data-open')}` });
  });

  await refreshFolderStatus();
  await refreshLibraryStatus();
  await loadLibrary();
  await refreshImportButtons();

  // First-run coach: shown once, skippable, never again.
  if (!isE2e() && !(await getTourDone())) showCoach();

  // R-01: the panel NEVER contacts ChatGPT on open. Import runs only when
  // the user presses Import (or Resume import, once Phase 2 lands).
}

// ---------------------------------------------------------------------------
// IMPORT — the controller owns the job; the panel renders its events.

function onControllerEvent(evt) {
  switch (evt.type) {
    case 'status':
      setStatus(evt.text, evt.kind);
      break;
    case 'spin':
      progressSpin(evt.label);
      break;
    case 'progress':
      progressUpdate(evt.done, evt.total, evt.label);
      break;
    case 'progress-hide':
      progressHide();
      break;
    case 'job-changed':
      refreshImportButtons();
      break;
    case 'done':
      // Final local reconciliation on every exit path (R-05), then
      // re-assert the job summary (loadLibrary's count line must not
      // bury the result the user needs to see).
      refreshImportButtons();
      loadLibrary().then(() => {
        if (evt.summary) setStatus(evt.summary.text, evt.summary.kind);
      });
      break;
    default:
      break;
  }
}

async function refreshImportButtons() {
  const running = importRunning();
  const resumable = running ? false : await importResumable();
  downloadBtn.textContent = running ? '⤓ …' : (resumable ? 'Resume import' : 'Import');
  downloadBtn.disabled = running;
  stopBtn.hidden = !running;
  newImportBtn.hidden = !(resumable && !running);
  if (running) {
    moreBtn.hidden = true;
    digestBtn.disabled = true;
  }
}

async function importClicked() {
  if (importRunning() || bulkRunning) return;
  if (bulkRunning) return;

  // Conversarium access is confirmed from a user gesture before any
  // ChatGPT call (R-04 step 1).
  let lib;
  try {
    lib = await ensureLibrary();
  } catch (e) {
    if (e && e.name === 'AbortError') return; // picker cancelled
    throw e;
  }
  if (!lib) return;

  const resumable = await importResumable();
  if (resumable) {
    await resumeImport();
  } else {
    await startNewImport();
  }
}

// ---------------------------------------------------------------------------
// First-run coach — one-time, skippable 3-step orientation.

const COACH_STEPS = [
  {
    title: 'Welcome to Thread-O-matic',
    body: '<b>Import</b> pulls your ChatGPT threads into the Conversarium — a folder on disk with one JSON file per thread. Press Import to start; it resumes if interrupted. Nothing runs until you press it.',
  },
  {
    title: 'Export to your vault',
    body: '<b>Export</b> writes markdown into your vault folder (Obsidian-ready, with frontmatter). Select specific threads, or export everything. No JSON ever goes to the vault.',
  },
  {
    title: '⚙ and ? live up here',
    body: '<b>Settings</b> holds your folders and the summarizer config. <b>Help</b> explains every button and status message — any time.',
  },
];

function showCoach() {
  const overlay = $('coach');
  const title = $('coach-title');
  const body = $('coach-body');
  const stepEl = $('coach-step');
  const next = $('coach-next');
  let i = 0;

  const paint = () => {
    title.textContent = COACH_STEPS[i].title;
    body.innerHTML = COACH_STEPS[i].body;
    stepEl.textContent = `${i + 1} / ${COACH_STEPS.length}`;
    next.textContent = i === COACH_STEPS.length - 1 ? 'Got it' : 'Next';
  };
  const close = async () => {
    overlay.hidden = true;
    await setTourDone();
  };

  $('coach-skip').addEventListener('click', close);
  $('coach-next').addEventListener('click', () => {
    if (++i >= COACH_STEPS.length) close(); else paint();
  });

  paint();
  overlay.hidden = false;
}

function setStatus(text, kind = '') {
  statusEl.textContent = text;
  statusEl.className = 'status ' + kind;
}

// Progress indicator: spinner for unknown-length phases, bar for i/N.
const progressEl = $('progress');
const progressFlower = $('progress-flower');
const barFill = $('bar-fill');
const progressLabel = $('progress-label');

function progressSpin(label) {
  progressEl.hidden = false;
  progressFlower.hidden = false;
  barFill.style.width = '0%';
  progressLabel.textContent = label || '';
}
function progressUpdate(done, total, label) {
  progressEl.hidden = false;
  progressFlower.hidden = true;
  const pct = total > 0 ? Math.min(1, done / total) : 0;
  barFill.style.width = `${Math.round(pct * 100)}%`;
  progressLabel.textContent = label || `${done}/${total}`;
}
function progressHide() {
  progressEl.hidden = true;
  progressFlower.hidden = true;
  barFill.style.width = '0%';
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
  folderLabel.textContent =
    st.state === 'granted' ? `📁 ${st.name}` :
    st.state === 'needs-permission' ? `📁 ${st.name} — access needed` :
    'Vault folder…';
}

async function refreshLibraryStatus() {
  const st = await libraryStatus();
  libState = st;
  libraryHint.textContent =
    st.state === 'granted' ? `Conversarium: ${st.name}` :
    st.state === 'needs-permission' ? `Conversarium: ${st.name} — access needed · click to reconnect` :
    'Conversarium: not set — choose a folder';
  libraryHint.style.cursor = st.state === 'needs-permission' ? 'pointer' : '';
}

async function ensureLibraryFromClick() {
  const st = await libraryStatus();
  if (st.state === 'granted') return; // nothing to fix
  try {
    const h = st.state === 'needs-permission' ? await reconnectLibraryHandle() : await chooseLibraryHandle();
    if (h) {
      await refreshLibraryStatus();
      setStatus(`Conversarium folder: ${h.name}`, 'ok');
    }
  } catch (e) {
    if (e && e.name === 'AbortError') return;
    setStatus(`Folder error: ${e.message}`, 'err');
  }
}

async function chooseFolder() {
  const st = await archiveStatus();
  try {
    if (st.state === 'needs-permission') {
      const h = await reconnectArchiveHandle();
      if (h) {
        await refreshFolderStatus();
        setStatus(`Vault folder: ${h.name}`, 'ok');
      } else {
        setStatus(`Access to "${st.name}" was not granted. Click the folder button to try again.`, 'warn');
      }
      return;
    }
    // 'granted' or 'none': always open the picker (R-10: Change folder
    // must be possible even when a folder is already configured).
    const handle = await chooseArchiveHandle();
    await refreshFolderStatus();
    if (handle) setStatus(`Vault folder: ${handle.name}`, 'ok');
  } catch (e) {
    if (e && e.name === 'AbortError') return; // cancelled — prior config preserved
    setStatus(`Folder error: ${e.message}`, 'err');
  }
}

// Get a usable Conversarium handle without surprising the user: current
// grant wins; otherwise reconnect (permission prompt) or, on first use,
// open the picker. Callers must be inside a user gesture when interactive.
async function ensureLibrary() {
  const current = await getCurrentLibraryHandle();
  if (current) return current;
  const st = await libraryStatus();
  if (st.state === 'needs-permission') {
    const h = await reconnectLibraryHandle();
    if (h) {
      await refreshLibraryStatus();
      return h;
    }
    setStatus(`Access to "${st.name}" is needed. Click the Conversarium label to reconnect.`, 'warn');
    return null;
  }
  const h = await chooseLibraryHandle();
  if (h) await refreshLibraryStatus();
  return h;
}

// THE LIST IS THE CONVERSARIUM. Read every downloaded JSON and render it.
async function loadLibrary() {
  const { envelopes, unreadable } = await readLibraryEnvelopes();
  libraryEnvs = envelopes.sort((a, b) =>
    (b.updated || b.created || '').localeCompare(a.updated || a.created || ''));
  lastUnreadable = unreadable || [];
  searchState = buildSearchIndex(libraryEnvs);
  archivedCount = libraryEnvs.length;
  renderList();
  setStatus(`${libraryEnvs.length} threads in the Conversarium.`, 'ok');
}

// ChatGPT list pages — used by the download crawl and staleness checks only.
async function loadConversations(offset, append) {
  if (loadingList) return true;
  loadingList = true;
  try {
    const data = await listConversations(offset, BATCH);
    const items = (data && data.items) || [];
    const normalized = items.map(normalizeConversationSummary);
    if (append) {
      const seen = new Set(conversations.map((c) => c.id));
      for (const c of normalized) {
        if (!seen.has(c.id)) { conversations.push(c); seen.add(c.id); }
      }
    } else {
      conversations = normalized;
    }
    nextOffset = offset + BATCH;
    hasMore = items.length === BATCH;
    return true;
  } catch (err) {
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
    setStatus(`${conversations.length} conversations found (all pages).`, 'ok');
  } finally {
    loadAllBtn.disabled = false;
    loadAllBtn.textContent = 'Load all';
    updateButtons();
  }
}

// ---------------------------------------------------------------------------
// EXPORT: library -> vault markdown (+ optional second output folder).

function exportTrigger() {
  if (importRunning()) {
    setStatus('An import is running — stop it first (Stop import).', 'warn');
    return;
  }
  if (bulkRunning) {
    bulkAbort = true;
    setStatus('Stopping after the current export…', 'warn');
    return;
  }
  // Selected threads win; otherwise everything in the library.
  const selected = libraryEnvs.filter((env) => checkedIds.has(env.id));
  exportTargets(selected.length ? selected : libraryEnvs);
}

async function exportTargets(targets) {
  let vault = await getCurrentArchiveHandle();
  if (!vault) {
    const st = await archiveStatus();
    if (st.state === 'needs-permission') vault = await reconnectArchiveHandle();
    if (!vault) {
      setStatus(st.state === 'needs-permission'
        ? `Access to "${st.name}" is needed — click 📁 to reconnect.`
        : 'No vault folder — click 📁 (or ⚙ Settings) to choose one.', 'err');
      return;
    }
  }
  await refreshFolderStatus();
  const plain = await getCurrentPlainHandle(); // optional; silently skipped when unset
  const st = await loadState();
  const plainFormat = st.plainFormat || 'md';

  if (!targets.length) {
    setStatus('The Conversarium is empty. Press Import to bring in ChatGPT threads.', 'warn');
    return;
  }

  bulkRunning = true;
  bulkAbort = false;
  downloadBtn.disabled = true;
  moreBtn.hidden = true;
  digestBtn.disabled = true;
  loadAllBtn.disabled = true;

  try {
    // Staleness check against the live ChatGPT list, when we have one.
    const listById = new Map(conversations.map((c) => [c.id, c]));

    let exported = 0;
    let refreshed = 0;
    let failed = 0;
    let consecutiveFails = 0;
    const failures = [];
    progressUpdate(0, targets.length, `0/${targets.length}`);

    for (let i = 0; i < targets.length; i++) {
      if (bulkAbort) break;
      const env = targets[i];

      // Before writing: compare against the current ChatGPT version.
      const live = listById.get(env.id);
      if (live && live.updated && env.updated && live.updated > env.updated) {
        setStatus(`Refreshing ${i + 1}/${targets.length}: ${env.title}`, 'warn');
        try {
          const raw = await getConversation(env.id);
          const fresh = buildEnvelope(normalizeConversation(raw));
          await writeLibraryThread(fresh);
          Object.assign(env, fresh); // export the refreshed copy
          refreshed++;
        } catch (e) {
          console.warn(`[convo-hist ${BUILD}] refresh skipped: "${env.title}" — ${e.message}`);
          // Export what we have; the next run will refresh again.
        }
      }

      setStatus(`Exporting ${i + 1}/${targets.length}: ${env.title}`, 'warn');
      try {
        const md = renderMarkdown(env);
        await writeArchiveFile(env, md);
        if (plain) await writePlainFile(env, md, plainFormat);
        exportedIds.add(env.id);
        checkedIds.delete(env.id);
        exported++;
        consecutiveFails = 0;
      } catch (e) {
        const msg = e && e.message ? e.message : String(e);
        console.warn(`[convo-hist ${BUILD}] export failed: "${env.title}" (${env.id}) — ${msg}`);
        if (failures.length < 3) failures.push(`${env.title}: ${msg}`);
        failed++;
        consecutiveFails++;
        if (consecutiveFails >= 3) {
          setStatus(`Export paused: 3 in a row failed (last: ${msg}). Run Export again to resume.`, 'err');
          return;
        }
      }
      await sleep(120);
      progressUpdate(i + 1, targets.length, `${exported}/${targets.length}`);
    }

    const stopped = bulkAbort ? ' (stopped early — run Export again to resume)' : '';
    const reasonNote = failed
      ? ` · first: ${failures[0]}${failed > 1 ? ` (+${failed - 1} more — open the panel console)` : ''}`
      : '';
    setStatus(
      `Export done: ${exported} written, ${refreshed} refreshed, ${failed} failed${stopped}${reasonNote}.`,
      failed ? 'warn' : 'ok'
    );
  } catch (e) {
    setStatus(`Export failed: ${e.message}`, 'err');
  } finally {
    progressHide();
    bulkRunning = false;
    bulkAbort = false;
    updateButtons();
    renderList();
  }
}

// Single-thread export (double-click a row).
async function capture(chatId) {
  setStatus('Preparing thread…');
  let env = libraryEnvs.find((x) => x.id === chatId);
  const live = conversations.find((c) => c.id === chatId);
  if (!env || (live && live.updated && env.updated && live.updated > env.updated)) {
    try {
      const raw = await getConversation(chatId);
      env = buildEnvelope(normalizeConversation(raw));
      await writeLibraryThread(env);
      const i = libraryEnvs.findIndex((x) => x.id === chatId);
      if (i >= 0) libraryEnvs[i] = env; else libraryEnvs.push(env);
    } catch (err) {
      setStatus(`Fetch failed: ${err.message}${authHint(err)}`, 'err');
      if (!env) return;
    }
  }

  const vault = await getCurrentArchiveHandle();
  if (!vault) {
    const ast = await archiveStatus();
    if (ast.state === 'needs-permission') {
      try {
        const h = await reconnectArchiveHandle();
        if (h) { await refreshFolderStatus(); setStatus(`Vault folder: ${h.name}`, 'ok'); }
      } catch (e) {
        if (e && e.name !== 'AbortError') setStatus(`Folder error: ${e.message}`, 'err');
        return;
      }
    }
    if (!(await getCurrentArchiveHandle())) {
      setStatus(ast.state === 'needs-permission'
        ? 'Vault access is needed — click 📁 to reconnect.'
        : 'No vault folder — click 📁 first.', 'err');
      return;
    }
  }
  const plain = await getCurrentPlainHandle();
  const st = await loadState();
  const plainFormat = st.plainFormat || 'md';

  try {
    const md = renderMarkdown(env);
    await writeArchiveFile(env, md);
    if (plain) await writePlainFile(env, md, plainFormat);
    exportedIds.add(chatId);
    renderList();
    try {
      await navigator.clipboard.writeText(md);
      setStatus(`Exported ${env.title} · copied to clipboard`, 'ok');
    } catch {
      setStatus(`Exported ${env.title} (clipboard blocked)`, 'ok');
    }
  } catch (e) {
    setStatus(`Export failed: ${e.message}`, 'err');
  }
}

// ---------------------------------------------------------------------------
// Row actions — 📄J copies the library JSON, 📄M renders markdown on the fly.

async function copyThread(chatId, fmt) {
  const env = libraryEnvs.find((x) => x.id === chatId);
  if (!env) {
    setStatus('Thread not in the Conversarium.', 'warn');
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

// ---------------------------------------------------------------------------
// DIGEST: summary + tags on library threads, written back in place.

async function digestMissing() {
  if (importRunning()) {
    setStatus('An import is running — stop it first (Stop import).', 'warn');
    return;
  }
  if (bulkRunning) {
    bulkAbort = true;
    setStatus('Stopping after the current digest…', 'warn');
    return;
  }

  let lib;
  try {
    lib = await ensureLibrary();
  } catch (e) {
    if (e && e.name === 'AbortError') return; // picker cancelled
    throw e;
  }
  if (!lib) return;
  const targets = libraryEnvs.filter((env) => !env.summary || !(env.tags || []).length);
  if (!targets.length) {
    setStatus(`Nothing to digest — all ${libraryEnvs.length} threads already have summaries.`, 'ok');
    return;
  }

  bulkRunning = true;
  bulkAbort = false;
  downloadBtn.disabled = true;
  moreBtn.hidden = true;
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
      progressUpdate(i + 1, targets.length, `${done}/${targets.length}`);
    }

    const stopped = bulkAbort ? ' (stopped early)' : '';
    const reasonNote = failed
      ? ` · first: ${failures[0]}${failed > 1 ? ` (+${failed - 1} more — console)` : ''}`
      : '';
    setStatus(
      `Digest done: ${done} summarized via ${backendLabel || 'fallback'}, ${failed} failed${reasonNote}${stopped}. ` +
        'Run Export to refresh the vault markdown.',
      failed ? 'warn' : 'ok'
    );
  } catch (e) {
    setStatus(`Digest failed: ${e.message}`, 'err');
  } finally {
    progressHide();
    bulkRunning = false;
    bulkAbort = false;
    updateButtons();
    renderList();
  }
}

function updateButtons() {
  const n = checkedIds.size;
  selCountEl.textContent = `${n} selected`;
  loadAllBtn.hidden = !hasMore || bulkRunning;
  digestBtn.disabled = bulkRunning || importRunning();
}

function updateSelAllState() {
  const n = libraryEnvs.filter((env) => checkedIds.has(env.id)).length;
  selAllEl.checked = libraryEnvs.length > 0 && n === libraryEnvs.length;
  selAllEl.indeterminate = n > 0 && n < libraryEnvs.length;
}

function renderList() {
  const q = searchEl.value.trim().toLowerCase();
  listEl.innerHTML = '';

  const shown = q
    ? libraryEnvs.filter((env) => env.title.toLowerCase().includes(q))
    : libraryEnvs;

  updateSelAllState();
  updateButtons();

  // R-11: folder/permission/empty conditions render their own state panels.
  if (!shown.length) {
    if (libState.state === 'none') {
      listEl.innerHTML =
        '<div class="notice">Choose a Conversarium folder to begin.' +
        '<br><button class="ghost" data-action="choose-library">Choose folder…</button></div>';
      return;
    }
    if (libState.state === 'needs-permission') {
      listEl.innerHTML =
        `<div class="notice">Reconnect "${escapeHtml(libState.name)}" to read your Conversarium.` +
        '<br><button class="ghost" data-action="reconnect-library">Reconnect</button></div>';
      return;
    }
    if (!q && !libraryEnvs.length) {
      listEl.innerHTML = (bulkRunning || importRunning())
        ? '<div class="notice">Import is running. Threads will appear here as they are saved.</div>'
        : '<div class="notice">The Conversarium is empty. Press Import to bring in ChatGPT threads.</div>';
      return;
    }
    listEl.innerHTML = `<div class="notice">No Conversarium threads match "${escapeHtml(q)}".</div>`;
    return;
  }

  if (lastUnreadable.length) {
    const details = lastUnreadable
      .slice(0, 5)
      .map((u) => `<div class="dim">${escapeHtml(u.name)} — ${escapeHtml(u.reason)}</div>`)
      .join('');
    listEl.innerHTML =
      `<div class="notice">${lastUnreadable.length} file${lastUnreadable.length === 1 ? '' : 's'} could not be read${details ? ':' + details : '.'}</div>`;
  }

  for (const env of shown) {
    const div = document.createElement('div');
    div.className = 'chat-item' + (exportedIds.has(env.id) ? ' captured' : '');
    div.role = 'option';

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = checkedIds.has(env.id);
    cb.title = 'Select for export';
    cb.addEventListener('click', (e) => e.stopPropagation());
    cb.addEventListener('change', () => {
      if (cb.checked) checkedIds.add(env.id);
      else checkedIds.delete(env.id);
      updateButtons();
      updateSelAllState();
    });

    const body = document.createElement('div');
    body.className = 'body';
    const t = document.createElement('span');
    t.className = 't';
    t.textContent = env.title;
    t.title = env.title;
    const m = document.createElement('span');
    m.className = 'm';
    m.textContent = env.updated ? `updated ${env.updated.slice(0, 10)}` : '';
    body.append(t, m);

    const btnJson = document.createElement('button');
    btnJson.className = 'rowbtn';
    btnJson.textContent = '📄J';
    btnJson.title = 'Copy this thread\'s JSON to the clipboard';
    btnJson.setAttribute('data-copy', env.id);
    btnJson.dataset.fmt = 'json';

    const btnMd = document.createElement('button');
    btnMd.className = 'rowbtn';
    btnMd.textContent = '📄M';
    btnMd.title = 'Copy this thread\'s markdown to the clipboard';
    btnMd.setAttribute('data-copy', env.id);
    btnMd.dataset.fmt = 'md';

    div.append(cb, body, btnJson, btnMd);
    div.addEventListener('click', (e) => {
      if (e.target.closest('.rowbtn')) return;
      cb.checked = !cb.checked;
      cb.dispatchEvent(new Event('change'));
    });
    div.addEventListener('dblclick', () => capture(env.id));
    listEl.appendChild(div);
  }
}

// ---------------------------------------------------------------------------
// Results mode — search over the library threads.

function renderResults(q) {
  if (!searchState) {
    listEl.innerHTML =
      '<div class="notice">Nothing indexed yet.<br>Press Import to bring in ChatGPT threads.</div>';
    return;
  }

  const { tokens } = parseQuery(q);
  const results = searchArchive(searchState, q);

  if (!results.length) {
    listEl.innerHTML = `<div class="notice">No Conversarium threads match "${escapeHtml(q)}".</div>`;
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