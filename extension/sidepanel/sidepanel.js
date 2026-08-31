// sidepanel.js — search-first UI. M1 scope: list, filter, capture to disk.
// Transport is DIRECT to chatgpt.com via lib/transport.js (host permissions +
// login cookies). No active-tab coupling, no content script needed.

import {
  normalizeConversationSummary,
  normalizeConversation
} from '../lib/vendors/chatgpt.js';
import { buildEnvelope } from '../lib/envelope.js';
import { renderMarkdown } from '../lib/markdown.js';
import { getArchiveHandle, writeArchiveFile, archiveStatus, readArchiveEnvelopes, writeDerivedViews } from '../lib/fsaccess.js';
import { buildAllIndexes } from '../lib/indexes.js';
import { buildSearchIndex, searchArchive, parseQuery, makeSnippet, highlightHtml } from '../lib/search.js';
import { formatTimestamp } from '../lib/envelope.js';
import { listConversations, getConversation, onStage, BUILD } from '../lib/transport.js';
import { loadState, saveList, saveDiffMap, setDiffEntry } from '../lib/state.js';

const BATCH = 50;

const $ = (id) => document.getElementById(id);

// Stamp the build into the header as soon as this module executes.
// If you see "build: loading…" stuck there, this JS never ran (stale panel
// or the module failed to load) — close and reopen the panel.
$('build-label').textContent = BUILD;

const listEl = $('chat-list');
const searchEl = $('search');
const captureBtn = $('capture-btn');
const moreBtn = $('more-btn');
const statusEl = $('status');
const folderBtn = $('folder-btn');
const folderLabel = $('folder-label');
const reloadBtn = $('reload-btn');
const rebuildBtn = $('rebuild-btn');
const captureAllBtn = $('capture-all-btn');
const selAllEl = $('sel-all');
const selCountEl = $('sel-count');
const loadAllBtn = $('load-all-btn');

let conversations = []; // normalized summaries
let capturedIds = new Set(); // already on disk (badge)
let checkedIds = new Set(); // selected for batch capture
let diffIndex = {}; // id -> updated ISO — the browser-side refresh index
let nextOffset = 0;
let hasMore = false;
let loadingList = false; // in-flight guard: one list request at a time
let searchState = null; // search index over archived envelopes
let archivedCount = 0;
let bulkRunning = false; // bulk-capture state
let bulkAbort = false;
// ---------------------------------------------------------------------------
// Bulk capture — "process the whole kit at once". Crawls every page of the
// conversation list, diffs update_time against the disk archive, and fetches
// only new/changed conversations (sequential + paced — unofficial API).
// Click again mid-run to stop after the current fetch.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchAllSummaries() {
  const all = new Map(); // id -> normalized summary
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

async function captureAll() {
  // Click while running = request stop.
  if (bulkRunning) {
    bulkAbort = true;
    setStatus('Stopping after the current fetch…', 'warn');
    return;
  }

  // Grab/re-grant the folder NOW, inside the click gesture.
  const folder = await getArchiveHandle({ interactive: true }).catch(() => null);
  if (!folder) {
    setStatus('No archive folder granted — click the folder button first.', 'err');
    return;
  }

  bulkRunning = true;
  bulkAbort = false;
  captureAllBtn.textContent = 'Stop';
  captureBtn.disabled = true;
  moreBtn.hidden = true;
  rebuildBtn.disabled = true;

  try {
    setStatus('Crawling conversation list…');
    const summaries = await fetchAllSummaries();
    if (!summaries.length) {
      setStatus('No conversations found.', 'warn');
      return;
    }

    // Refresh index: prefer the browser-side diff index; fall back to reading
    // every envelope off disk when it's cold (first run / cache cleared).
    let archivedUpdated;
    if (Object.keys(diffIndex).length) {
      archivedUpdated = new Map(Object.entries(diffIndex));
    } else {
      const { envelopes } = await readArchiveEnvelopes();
      archivedUpdated = new Map(envelopes.map((e) => [e.id, e.updated || e.created || '']));
      diffIndex = Object.fromEntries(archivedUpdated);
      await saveDiffMap(diffIndex);
    }

    let captured = 0;
    let unchanged = 0;
    let failed = 0;
    let consecutiveFails = 0; // circuit breaker: 3 in a row => stop hammering
    const failures = []; // {title, message} — first few surface in the status
    let indexNote = '';

    for (let i = 0; i < summaries.length; i++) {
      if (bulkAbort) break;
      const c = summaries[i];
      const last = archivedUpdated.get(c.id);
      if (last && c.updated && c.updated <= last) {
        capturedIds.add(c.id); // badge only — disk copy is current
        checkedIds.delete(c.id);
        unchanged++;
        continue;
      }

      setStatus(`Capturing ${i + 1}/${summaries.length}: ${c.title}`, 'warn');
      try {
        const raw = await getConversation(c.id);
        const env = buildEnvelope(normalizeConversation(raw));
        await writeArchiveFile(env, renderMarkdown(env));
        capturedIds.add(c.id);
        checkedIds.delete(c.id);
        captured++;
        consecutiveFails = 0;
        diffIndex[c.id] = env.updated || env.created || '';
        setDiffEntry(c.id, diffIndex[c.id]);
      } catch (e) {
        // Auth/Cloudflare failures abort the whole batch — retries won't help.
        if (e && (e.status === 401 || e.status === 403)) {
          console.error(`[convo-hist ${BUILD}] batch stopped at "${c.title}" (${c.id}): ${e.message}`);
          setStatus(`Batch stopped: ${e.message}`, 'err');
          return;
        }
        const msg = e && e.message ? e.message : String(e);
        console.warn(`[convo-hist ${BUILD}] capture failed: "${c.title}" (${c.id}) — ${msg}`);
        if (failures.length < 3) failures.push(`${c.title}: ${msg}`);
        failed++;
        consecutiveFails++;
        if (consecutiveFails >= 3) {
          setStatus(
            `Capture paused: 3 conversations failed in a row (last: ${c.title} — ${msg}). ` +
              'Check the panel console; fix the cause, then run Capture all again to resume.',
            'err'
          );
          return;
        }
      }
      // Rate-limited? back off well beyond normal pacing before the next item.
      const lastErr = failures.length && failures[failures.length - 1];
      await sleep(300 + (/429/.test(lastErr || '') ? 3000 : 0));
    }

    // One index + search rebuild for the whole batch.
    try {
      const { envelopes } = await readArchiveEnvelopes();
      await writeDerivedViews(buildAllIndexes(envelopes));
      searchState = buildSearchIndex(envelopes);
      archivedCount = envelopes.length;
      indexNote = ` · indexes + search updated (${envelopes.length})`;
    } catch {
      indexNote = ' · indexes not updated';
    }

    const stopped = bulkAbort ? ' (stopped early)' : '';
    const reasonNote = failed
      ? ` · first: ${failures[0]}${failed > 1 ? ` (+${failed - 1} more — open the panel console)` : ''}`
      : '';
    setStatus(
      `Bulk capture done: ${captured} captured, ${unchanged} unchanged, ${failed} failed${indexNote}${stopped}${reasonNote}.`,
      failed ? 'warn' : 'ok'
    );
    renderList();
  } catch (e) {
    setStatus(`Bulk capture failed: ${e.message}`, 'err');
  } finally {
    bulkRunning = false;
    bulkAbort = false;
    captureAllBtn.textContent = 'Capture all';
    reloadBtn.disabled = false;
    rebuildBtn.disabled = false;
    updateCaptureButton();
    renderList();
  }
}

document.addEventListener('DOMContentLoaded', init);

async function init() {
  onStage((msg) => setStatus(msg));
  setStatus(`Ready — build ${BUILD}`);

  // Open instantly with the last-known list while the live refresh runs.
  const st = await loadState();
  diffIndex = st.diff || {};
  if (st.list && st.list.length) {
    conversations = st.list;
    renderList();
    setStatus(`${conversations.length} conversations (cached) — refreshing…`, 'warn');
  }

  captureBtn.addEventListener('click', captureChecked);
  moreBtn.addEventListener('click', () => loadConversations(nextOffset, true));
  searchEl.addEventListener('input', () => {
    const q = searchEl.value.trim();
    if (!q) {
      renderList();
      return;
    }
    renderResults(q);
  });
  folderBtn.addEventListener('click', chooseFolder);
  reloadBtn.addEventListener('click', async () => {
    checkedIds.clear();
    updateCaptureButton();
    await loadConversations(0, false);
  });
  rebuildBtn.addEventListener('click', rebuildFromDisk);
  captureAllBtn.addEventListener('click', captureAll);
  selAllEl.addEventListener('change', () => {
    if (selAllEl.checked) for (const c of conversations) checkedIds.add(c.id);
    else checkedIds.clear();
    renderList();
  });
  loadAllBtn.addEventListener('click', loadAll);

  // Deep-link buttons on result cards → open the thread in ChatGPT.
  listEl.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-open]');
    if (btn) chrome.tabs.create({ url: `https://chatgpt.com/c/${btn.getAttribute('data-open')}` });
  });

  await refreshFolderStatus();
  await refreshSearchIndex();
  await loadConversations(0, false);
}

// Build the search index from the canonical files on disk. Browser storage
// plays no part — this works from a wiped cache.
async function refreshSearchIndex() {
  try {
    const { envelopes } = await readArchiveEnvelopes();
    searchState = buildSearchIndex(envelopes);
    archivedCount = envelopes.length;
  } catch (e) {
    console.error('search index build failed:', e);
    searchState = null;
    archivedCount = 0;
  }
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
  if (err && err.status === 429) return ' — rate limited, wait a moment and retry';
  return '';
}

async function refreshFolderStatus() {
  const st = await archiveStatus();
  if (st.state === 'granted') {
    folderLabel.textContent = `📁 ${st.name}`;
  } else if (st.state === 'needs-permission') {
    folderLabel.textContent = `📁 ${st.name} (re-grant)`;
  } else {
    folderLabel.textContent = 'Choose folder…';
  }
}

async function chooseFolder() {
  try {
    const handle = await getArchiveHandle({ interactive: true });
    await refreshFolderStatus();
    if (handle) setStatus(`Archive folder: ${handle.name}`, 'ok');
  } catch (e) {
    if (e && e.name === 'AbortError') return; // user cancelled the picker
    setStatus(`Folder error: ${e.message}`, 'err');
  }
}

async function loadConversations(offset, append) {
  if (loadingList) return;
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
      // De-dup by id — conversations can shift between pages during capture.
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
    setStatus(
      `${conversations.length}${total ? ` of ${total}` : ''} conversations loaded.`,
      'ok'
    );
    saveList(conversations); // list cache for instant next open
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

function renderList() {
  const q = searchEl.value.trim().toLowerCase();
  listEl.innerHTML = '';

  const shown = q
    ? conversations.filter((c) => c.title.toLowerCase().includes(q))
    : conversations;

  updateSelAllState(shown);
  updateCaptureButton();

  if (!shown.length) {
    listEl.innerHTML = `<div class="notice">${
      q ? 'No matches.' : 'No conversations found.'
    }</div>`;
    return;
  }

  for (const c of shown) {
    const div = document.createElement('div');
    div.className = 'chat-item' + (capturedIds.has(c.id) ? ' captured' : '');
    div.role = 'option';

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = checkedIds.has(c.id);
    cb.title = 'Select for batch capture';
    cb.addEventListener('click', (e) => e.stopPropagation());
    cb.addEventListener('change', () => {
      if (cb.checked) checkedIds.add(c.id);
      else checkedIds.delete(c.id);
      updateCaptureButton();
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

    div.append(cb, body);
    // Row click toggles the checkbox; double-click captures just this one.
    div.addEventListener('click', () => {
      cb.checked = !cb.checked;
      cb.dispatchEvent(new Event('change'));
    });
    div.addEventListener('dblclick', () => capture(c.id));
    listEl.appendChild(div);
  }
}

function updateCaptureButton() {
  const n = checkedIds.size;
  captureBtn.textContent = n > 0 ? `Capture selected (${n})` : 'Capture selected';
  captureBtn.disabled = bulkRunning || n === 0;
  selCountEl.textContent = `${n} selected`;
  loadAllBtn.hidden = !hasMore || bulkRunning;
}

function updateSelAllState(shown) {
  const list = shown || conversations;
  const n = list.filter((c) => checkedIds.has(c.id)).length;
  selAllEl.checked = list.length > 0 && n === list.length;
  selAllEl.indeterminate = n > 0 && n < list.length;
}

// Load every remaining page of the conversation list into the panel.
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
    updateCaptureButton();
  }
}

// Batch-capture every checked conversation (diff-skip unchanged, paced,
// Stop via the Capture all button — shared bulk machinery).
async function captureChecked() {
  if (bulkRunning) {
    bulkAbort = true;
    setStatus('Stopping after the current fetch…', 'warn');
    return;
  }
  if (!checkedIds.size) return;

  // Folder grant must happen inside the click gesture.
  const folder = await getArchiveHandle({ interactive: true }).catch(() => null);
  if (!folder) {
    setStatus('No archive folder granted — click the folder button first.', 'err');
    return;
  }

  const targets = conversations.filter((c) => checkedIds.has(c.id));
  if (!targets.length) return;

  bulkRunning = true;
  bulkAbort = false;
  const prevLabel = captureAllBtn.textContent;
  captureAllBtn.textContent = 'Stop';
  captureBtn.disabled = true;
  moreBtn.hidden = true;
  rebuildBtn.disabled = true;
  loadAllBtn.disabled = true;

  try {
    const { envelopes } = await readArchiveEnvelopes();
    const archivedUpdated = new Map(
      envelopes.map((e) => [e.id, e.updated || e.created || ''])
    );

    let captured = 0;
    let unchanged = 0;
    let failed = 0;
    let consecutiveFails = 0; // circuit breaker: 3 in a row => stop hammering
    const failures = []; // {title, message} — first few surface in the status
    let indexNote = '';

    for (let i = 0; i < targets.length; i++) {
      if (bulkAbort) break;
      const c = targets[i];
      const last = archivedUpdated.get(c.id);
      if (last && c.updated && c.updated <= last) {
        capturedIds.add(c.id);
        checkedIds.delete(c.id);
        unchanged++;
        continue;
      }

      setStatus(`Capturing ${i + 1}/${targets.length}: ${c.title}`, 'warn');
      try {
        const raw = await getConversation(c.id);
        const env = buildEnvelope(normalizeConversation(raw));
        await writeArchiveFile(env, renderMarkdown(env));
        capturedIds.add(c.id);
        checkedIds.delete(c.id);
        captured++;
        consecutiveFails = 0;
        diffIndex[c.id] = env.updated || env.created || '';
        setDiffEntry(c.id, diffIndex[c.id]);
      } catch (e) {
        if (e && (e.status === 401 || e.status === 403)) {
          console.error(`[convo-hist ${BUILD}] batch stopped at "${c.title}" (${c.id}): ${e.message}`);
          setStatus(`Batch stopped: ${e.message}`, 'err');
          return;
        }
        const msg = e && e.message ? e.message : String(e);
        console.warn(`[convo-hist ${BUILD}] capture failed: "${c.title}" (${c.id}) — ${msg}`);
        if (failures.length < 3) failures.push(`${c.title}: ${msg}`);
        failed++;
        consecutiveFails++;
        if (consecutiveFails >= 3) {
          setStatus(
            `Capture paused: 3 conversations failed in a row (last: ${c.title} — ${msg}). ` +
              'Check the panel console; fix the cause, then run Capture selected again to resume.',
            'err'
          );
          return;
        }
      }
      const lastErr = failures.length && failures[failures.length - 1];
      await sleep(300 + (/429/.test(lastErr || '') ? 3000 : 0));
      updateCaptureButton();
    }

    try {
      const { envelopes } = await readArchiveEnvelopes();
      await writeDerivedViews(buildAllIndexes(envelopes));
      searchState = buildSearchIndex(envelopes);
      archivedCount = envelopes.length;
      indexNote = ` · indexes + search updated (${envelopes.length})`;
    } catch {
      indexNote = ' · indexes not updated';
    }

    const stopped = bulkAbort ? ' (stopped early)' : '';
    const reasonNote = failed
      ? ` · first: ${failures[0]}${failed > 1 ? ` (+${failed - 1} more — open the panel console)` : ''}`
      : '';
    setStatus(
      `Batch done: ${captured} captured, ${unchanged} unchanged, ${failed} failed${indexNote}${stopped}${reasonNote}.`,
      failed ? 'warn' : 'ok'
    );
  } catch (e) {
    setStatus(`Batch failed: ${e.message}`, 'err');
  } finally {
    bulkRunning = false;
    bulkAbort = false;
    captureAllBtn.textContent = prevLabel;
    rebuildBtn.disabled = false;
    updateCaptureButton();
    renderList();
  }
}

// ---------------------------------------------------------------------------
// Results mode — tags-first cards over the archived (disk) conversations.

function renderResults(q) {
  if (!searchState) {
    listEl.innerHTML =
      '<div class="notice">Archive not indexed yet.<br>Grant the folder, then click “Rebuild from disk”.</div>';
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

// Regenerate indexes/ from the canonical files on disk — the browser-side
// cache plays no part; this works even after "Clear site data".
async function rebuildFromDisk() {
  setStatus('Reading archive from disk…');
  try {
    const { envelopes, skipped, noFolder } = await readArchiveEnvelopes();
    if (noFolder) {
      setStatus('No archive folder granted — click the folder button first.', 'err');
      return;
    }
    if (!envelopes.length) {
      setStatus('Nothing archived yet — capture a conversation first.', 'warn');
      return;
    }
    const indexes = buildAllIndexes(envelopes);
    const { files } = await writeDerivedViews(indexes);
    searchState = buildSearchIndex(envelopes);
    archivedCount = envelopes.length;
    // Resync the browser-side diff index from the authoritative envelopes —
    // this heals drift (hand edits, deletions, another machine's captures).
    diffIndex = {};
    for (const e of envelopes) diffIndex[e.id] = e.updated || e.created || '';
    await saveDiffMap(diffIndex);
    setStatus(
      `Indexes rebuilt: ${files} files from ${envelopes.length} conversations` +
        (skipped ? ` (${skipped} unreadable skipped)` : ''),
      'ok'
    );
  } catch (e) {
    setStatus(`Rebuild failed: ${e.message}`, 'err');
  }
}

async function capture(chatId) {
  setStatus('Fetching conversation…');

  let raw;
  try {
    raw = await getConversation(chatId);
  } catch (err) {
    setStatus(`Fetch failed: ${err.message}${authHint(err)}`, 'err');
    return;
  }

  try {
    const norm = normalizeConversation(raw);
    const env = buildEnvelope(norm);
    const md = renderMarkdown(env);

    // Folder grant needs a user gesture — the capture click is one.
    const folder = await getArchiveHandle({ interactive: true }).catch(() => null);
    if (!folder) {
      setStatus('No archive folder granted — click the folder button first.', 'err');
      return;
    }

    const paths = await writeArchiveFile(env, md);
    capturedIds.add(chatId);
    diffIndex[chatId] = env.updated || env.created || '';
    setDiffEntry(chatId, diffIndex[chatId]);
    renderList();

    // Keep indexes/ and the search index in sync with every capture.
    let indexNote = '';
    try {
      const { envelopes } = await readArchiveEnvelopes();
      const indexes = buildAllIndexes(envelopes);
      await writeDerivedViews(indexes);
      searchState = buildSearchIndex(envelopes);
      archivedCount = envelopes.length;
      indexNote = ` · indexes + search updated (${envelopes.length})`;
    } catch {
      indexNote = ' · indexes not updated';
    }

    try {
      await navigator.clipboard.writeText(md);
      setStatus(`Saved ${paths.mdPath} + .json${indexNote} · copied to clipboard`, 'ok');
    } catch {
      setStatus(`Saved ${paths.mdPath} + .json${indexNote} (clipboard blocked)`, 'ok');
    }
  } catch (e) {
    setStatus(`Capture failed: ${e.message}`, 'err');
  }
}
