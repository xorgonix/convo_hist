// settings.js — the settings window. Folders are granted here (File System
// Access pickers need a user gesture — these buttons are it).
//
// Per-folder actions (spec R-10):
//   Choose folder… / Change folder…  — ALWAYS opens the native picker, even
//                                      when a folder is already configured.
//                                      Cancelling preserves the prior grant.
//   Reconnect                        — restores access when the browser has
//                                      dropped permission for a saved folder.
//   Verify                           — writes a branded marker file
//                                      (_thread_o_matic_here.txt) naming the
//                                      folder's role, so the user can confirm
//                                      the real location in Explorer.
//   Forget                           — removes ONLY the saved handle. No file
//                                      is ever deleted.
//
// The browser never exposes full filesystem paths — the note in the folder
// card explains this beside the controls (R-10), not only in Help.

import { BUILD } from '../lib/transport.js';
import { loadState, saveSettings } from '../lib/state.js';
import {
  chooseLibraryHandle, reconnectLibraryHandle, getCurrentLibraryHandle,
  forgetLibraryHandle, libraryStatus, writeVerifyProbe,
  chooseArchiveHandle, reconnectArchiveHandle, getCurrentArchiveHandle,
  forgetArchiveHandle, archiveStatus,
  choosePlainHandle, reconnectPlainHandle, getCurrentPlainHandle,
  forgetPlainHandle, plainStatus,
  readLibraryEnvelopes, writeLibraryThread,
} from '../lib/fsaccess.js';
import { normalizeConversation } from '../lib/vendors/chatgpt.js';
import { buildEnvelope } from '../lib/envelope.js';

const $ = (id) => document.getElementById(id);
$('build-label').textContent = BUILD;

const statusEl = $('status');
function setStatus(text, kind = '') {
  statusEl.textContent = text;
  statusEl.className = 'status ' + kind;
}

function wireFolder(prefix, statusFn, ops, role, what) {
  $(`${prefix}-btn`).addEventListener('click', async () => {
    try {
      await ops.choose(); // always opens the picker (R-10: change must be possible)
      await refresh();
      setStatus(`${what} folder set.`, 'ok');
    } catch (e) {
      if (e && e.name === 'AbortError') return; // cancelled — prior grant preserved
      setStatus(`${what} folder error: ${e.message}`, 'err');
    }
  });

  $(`${prefix}-reconnect`).addEventListener('click', async () => {
    try {
      const h = await ops.reconnect();
      await refresh();
      if (h) setStatus(`${what} access restored.`, 'ok');
      else setStatus(`${what} access was not granted. Click Reconnect to try again.`, 'warn');
    } catch (e) {
      if (e && e.name === 'AbortError') return;
      setStatus(`${what} reconnect error: ${e.message}`, 'err');
    }
  });

  $(`${prefix}-verify`).addEventListener('click', async () => {
    try {
      let handle = await ops.getCurrent();
      if (!handle) handle = await ops.reconnect(); // Verify click is a user gesture
      if (!handle) {
        setStatus(`${what} folder not usable yet — choose it (or reconnect) first.`, 'warn');
        return;
      }
      const name = await writeVerifyProbe(handle, role);
      setStatus(`Wrote _thread_o_matic_here.txt into "${name}" — check it in Explorer.`, 'ok');
    } catch (e) {
      if (e && e.name === 'AbortError') return;
      setStatus(`Verify failed: ${e.message}`, 'err');
    }
  });

  $(`${prefix}-forget`).addEventListener('click', async () => {
    await ops.forget(); // removes only the saved handle — files untouched
    await refresh();
    setStatus(`${what} folder forgotten (no files were deleted).`, 'ok');
  });
}

wireFolder('library', libraryStatus,
  { choose: chooseLibraryHandle, reconnect: reconnectLibraryHandle, getCurrent: getCurrentLibraryHandle, forget: forgetLibraryHandle },
  'Conversarium', 'Conversarium');
wireFolder('vault', archiveStatus,
  { choose: chooseArchiveHandle, reconnect: reconnectArchiveHandle, getCurrent: getCurrentArchiveHandle, forget: forgetArchiveHandle },
  'Vault', 'Vault');
wireFolder('plain', plainStatus,
  { choose: choosePlainHandle, reconnect: reconnectPlainHandle, getCurrent: getCurrentPlainHandle, forget: forgetPlainHandle },
  'Secondary output', 'Output');

$('close-btn').addEventListener('click', () => window.close());

async function refresh() {
  const rows = [
    ['library', libraryStatus],
    ['vault', archiveStatus],
    ['plain', plainStatus],
  ];
  for (const [prefix, statusFn] of rows) {
    const st = await statusFn();
    const label = $(`${prefix}-label`);
    label.textContent =
      st.state === 'granted' ? st.name :
      st.state === 'needs-permission' ? `${st.name} — access needed` :
      'not set';
    $(`${prefix}-btn`).textContent = st.state === 'none' ? 'Choose folder…' : 'Change folder…';
    $(`${prefix}-reconnect`).hidden = st.state !== 'needs-permission';
    $(`${prefix}-forget`).hidden = st.state === 'none';
  }
}

// ---------------------------------------------------------------------------
// Seed from a ChatGPT "Export data" file (conversations.json). Purely local:
// parses the file the user picks and writes new/updated threads into the
// Conversarium — zero ChatGPT requests, so no pacing and no rate limits.
// Threads already on disk are skipped unless the export copy is NEWER
// (same rule as the import diff: compare `updated` timestamps).

$('export-import-btn').addEventListener('click', async () => {
  const input = $('export-file');
  const note = $('export-progress');
  if (!input.files || !input.files.length) {
    setStatus('Pick the conversations.json from your ChatGPT export zip first.', 'warn');
    return;
  }
  if (!(await getCurrentLibraryHandle())) {
    setStatus('Choose the Conversarium folder first (row above).', 'err');
    return;
  }
  const btn = $('export-import-btn');
  btn.disabled = true;
  setStatus('Reading the export file…', 'warn');
  try {
    const text = await input.files[0].text();
    const list = JSON.parse(text);
    if (!Array.isArray(list)) throw new Error('expected an array of conversations');

    const { envelopes } = await readLibraryEnvelopes();
    const have = new Map(envelopes.map((e) => [e.id, e.updated || e.created || '']));

    let written = 0, skipped = 0, bad = 0;
    const badSamples = [];
    for (let i = 0; i < list.length; i++) {
      const raw = list[i];
      const id = raw.conversation_id || raw.id || '';
      const updated = raw.update_time
        ? new Date(raw.update_time * 1000).toISOString()
        : '';
      if (id && have.has(id) && (!updated || have.get(id) >= updated)) {
        skipped++;
        continue;
      }
      try {
        const env = buildEnvelope(normalizeConversation(raw));
        await writeLibraryThread(env);
        have.set(env.id, env.updated || env.created || '');
        written++;
      } catch (e) {
        bad++;
        if (badSamples.length < 3) badSamples.push(`${raw.title || id || '?'}: ${e.message}`);
      }
      if (i % 20 === 0) note.textContent = `${i + 1}/${list.length} — ${written} written, ${skipped} skipped, ${bad} unreadable`;
      if (i % 50 === 0) await new Promise((r) => setTimeout(r)); // keep the page alive
    }
    const badNote = bad ? ` · ${bad} unreadable (${badSamples.join('; ')})` : '';
    note.textContent = '';
    setStatus(`Export import done: ${written} written, ${skipped} already current, ${bad} unreadable${badNote}.`, bad ? 'warn' : 'ok');
  } catch (e) {
    note.textContent = '';
    setStatus(`Export import failed: ${e.message}`, 'err');
  } finally {
    btn.disabled = false;
  }
});

(async () => {
  const st = await loadState();
  $('plain-format').value = st.plainFormat || 'md';
  $('summarizer').value = st.summarizer || 'auto';
  $('ollama-url').value = st.ollamaUrl || 'http://localhost:11434';
  $('ollama-model').value = st.ollamaModel || '';

  const persist = () => saveSettings({
    plainFormat: $('plain-format').value,
    summarizer: $('summarizer').value,
    ollamaUrl: $('ollama-url').value.trim(),
    ollamaModel: $('ollama-model').value.trim(),
  });
  for (const id of ['plain-format', 'summarizer', 'ollama-url', 'ollama-model']) {
    $(id).addEventListener('change', async () => {
      await persist();
      setStatus('Settings saved.', 'ok');
    });
  }

  await refresh();
  setStatus('Settings ready.', 'ok');
})();
