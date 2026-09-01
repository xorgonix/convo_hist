// sidepanel.js — v0.5.0: library-first, minimal buttons.
//
//   THE PANEL LIST IS THE LIBRARY. A line item means the JSON file exists
//   in the library folder. Nothing else is listed.
//
//   DOWNLOAD: crawl ChatGPT's list -> write new/changed threads into
//   <library>/threads/<Title> (<id>).json. Paced, honors retry-after,
//   self-throttling, resumable.
//
//   EXPORT: selected threads (or all if none selected) -> vault folder as
//   markdown (frontmatter built from the envelope) and, if configured, a
//   second output folder as markdown or JSON. Before writing, each thread
//   is compared against the live ChatGPT list and refreshed if stale.
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
  getArchiveHandle, writeArchiveFile, archiveStatus,
  getLibraryHandle, libraryStatus,
  getPlainHandle, writePlainFile, plainStatus,
  readLibraryEnvelopes, writeLibraryThread,
} from '../lib/fsaccess.js';
import { buildSearchIndex, searchArchive, parseQuery, makeSnippet, highlightHtml } from '../lib/search.js';
import { formatTimestamp } from '../lib/envelope.js';
import { listConversations, getConversation, onStage, BUILD } from '../lib/transport.js';
import { digestTurns } from '../lib/summarize.js';

const BATCH = 50;
const $ = (id) => document.getElementById(id);

$('build-label').textContent = BUILD;

const listEl = $('chat-list');
const searchEl = $('search');
const downloadBtn = $('capture-btn');    // primary: Download
const exportBtn = $('capture-all-btn');  // Export (selected, or all)
const moreBtn = $('more-btn');
const statusEl = $('status');
const folderBtn = $('folder-btn');
const folderLabel = $('folder-label');
const settingsBtn = $('settings-btn');
const libraryHint = $('library-hint');
const reloadBtn = $('reload-btn');
const digestBtn = $('digest-btn');
const selAllEl = $('sel-all');
const selCountEl = $('sel-count');
const loadAllBtn = $('load-all-btn');

let libraryEnvs = [];      // the library: every downloaded thread (the list)
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
  exportBtn.addEventListener('click', exportTrigger);
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
    await loadLibrary(); // re-read the library folder
  });
  digestBtn.addEventListener('click', digestMissing);
  selAllEl.addEventListener('change', () => {
    if (selAllEl.checked) for (const env of libraryEnvs) checkedIds.add(env.id);
    else checkedIds.clear();
    renderList();
  });
  loadAllBtn.addEventListener('click', loadAll);

  listEl.addEventListener('click', async (e) => {
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

  // Download auto-starts. e2e pages skip it for deterministic tests.
  if (!isE2e()) downloadAll();
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

// THE LIST IS THE LIBRARY. Read every downloaded JSON and render it.
async function loadLibrary() {
  const { envelopes, noLibrary } = await readLibraryEnvelopes();
  libraryEnvs = envelopes.sort((a, b) =>
    (b.updated || b.created || '').localeCompare(a.updated || a.created || ''));
  searchState = buildSearchIndex(libraryEnvs);
  archivedCount = libraryEnvs.length;
  renderList();
  setStatus(`${libraryEnvs.length} threads in the library.`, 'ok');
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
// DOWNLOAD: ChatGPT -> library folder.

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

  const lib = await getLibraryHandle({ interactive: true }).catch(() => null);
  if (!lib) {
    setStatus('No library folder — open ⚙ Settings and choose one.', 'err');
    return;
  }
  await refreshLibraryStatus();

  bulkRunning = true;
  bulkAbort = false;
  exportBtn.textContent = 'Stop';
  moreBtn.hidden = true;
  digestBtn.disabled = true;
  loadAllBtn.disabled = true;

  try {
    setStatus('Crawling conversation list…');
    progressSpin('crawling');
    const summaries = await fetchAllSummaries();
    if (!summaries.length) {
      setStatus('No conversations found.', 'warn');
      return;
    }
    setStatus(`Found ${summaries.length} · checking the library…`);

    const libUpdated = new Map(libraryEnvs.map((e) => [e.id, e.updated || e.created || '']));
    const targets = summaries.filter((c) => {
      const have = libUpdated.get(c.id);
      return !have || !c.updated || c.updated > have;
    });
    progressUpdate(0, targets.length, `0/${targets.length}`);

    let downloaded = 0;
    let unchanged = summaries.length - targets.length;
    let failed = 0;
    let consecutiveFails = 0;
    let pacing = 400;
    let recentFails = 0;
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
        await writeLibraryThread(env);
        downloaded++;
        consecutiveFails = 0;
      } catch (e) {
        if (e && (e.status === 401 || e.status === 403)) {
          console.error(`[convo-hist ${BUILD}] download stopped at "${c.title}" (${c.id}): ${e.message}`);
          setStatus(`Download stopped: ${e.message} — log in on chatgpt.com, then run Download again.`, 'err');
          return;
        }
        const msg = e && e.message ? e.message : String(e);
        console.warn(`[convo-hist ${BUILD}] download failed: "${c.title}" (${c.id}) — ${msg}`);
        if (failures.length < 3) failures.push(`${c.title}: ${msg}`);
        failed++;
        consecutiveFails++;
        recentFails++;
        if (recentFails >= 2 && pacing < 8000) {
          pacing = Math.min(pacing * 2, 8000);
          console.warn(`[convo-hist ${BUILD}] throttling: pacing raised to ${pacing}ms (rate limiter active)`);
        }
        if (e && e.retryAfterMs) await sleep(e.retryAfterMs);
        if (consecutiveFails >= 3) {
          setStatus(
            `Download paused: 3 in a row failed (last: ${c.title} — ${msg}). ` +
              `Downloaded threads are safe in the library; run Download again to resume.`,
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
      progressUpdate(i + 1, targets.length, `${downloaded}/${targets.length}`);
      await sleep(pacing);
    }

    await loadLibrary(); // the list IS the library — refresh it

    const stopped = bulkAbort ? ' (stopped early — run Download again to resume)' : '';
    const reasonNote = failed
      ? ` · first: ${failures[0]}${failed > 1 ? ` (+${failed - 1} more — open the panel console)` : ''}`
      : '';
    setStatus(
      `Download done: ${downloaded} new, ${unchanged} unchanged, ${failed} failed — ` +
        `library holds ${libraryEnvs.length} threads${stopped}${reasonNote}.`,
      failed ? 'warn' : 'ok'
    );
  } catch (e) {
    setStatus(`Download failed: ${e.message}`, 'err');
  } finally {
    progressHide();
    bulkRunning = false;
    bulkAbort = false;
    downloadBtn.textContent = 'Download';
    updateButtons();
  }
}

// ---------------------------------------------------------------------------
// EXPORT: library -> vault markdown (+ optional second output folder).

function exportTrigger() {
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
  const vault = await getArchiveHandle({ interactive: true }).catch(() => null);
  if (!vault) {
    setStatus('No vault folder granted — click 📁 (or ⚙ Settings).', 'err');
    return;
  }
  await refreshFolderStatus();
  const plain = await getPlainHandle({ interactive: true }).catch(() => null);
  const st = await loadState();
  const plainFormat = st.plainFormat || 'md';

  if (!targets.length) {
    setStatus('Library is empty — run Download first.', 'warn');
    return;
  }

  bulkRunning = true;
  bulkAbort = false;
  const prevLabel = exportBtn.textContent;
  exportBtn.textContent = 'Stop';
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
    exportBtn.textContent = prevLabel;
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
    setStatus('Thread not in the library.', 'warn');
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
  const targets = libraryEnvs.filter((env) => !env.summary || !(env.tags || []).length);
  if (!targets.length) {
    setStatus(`Nothing to digest — all ${libraryEnvs.length} threads already have summaries.`, 'ok');
    return;
  }

  bulkRunning = true;
  bulkAbort = false;
  exportBtn.textContent = 'Stop';
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
    exportBtn.textContent = 'Export';
    updateButtons();
    renderList();
  }
}

function updateButtons() {
  const n = checkedIds.size;
  selCountEl.textContent = `${n} selected`;
  loadAllBtn.hidden = !hasMore || bulkRunning;
  digestBtn.disabled = bulkRunning;
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

  if (!shown.length) {
    listEl.innerHTML = `<div class="notice">${
      q ? 'No matches in the library.' : 'Library is empty — run Download.'
    }</div>`;
    return;
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
      '<div class="notice">Nothing indexed yet.<br>Run Download first.</div>';
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
