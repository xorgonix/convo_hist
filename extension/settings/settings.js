// settings.js — the settings window. Folders are granted here (File System
// Access pickers need a user gesture — these buttons are it); LLM/algorithm
// choices persist in chrome.storage via lib/state.js.

import { BUILD } from '../lib/transport.js';
import { loadState, saveSettings, getIncludeJson, setIncludeJson } from '../lib/state.js';
import {
  getLibraryHandle, forgetLibraryHandle, libraryStatus,
  getArchiveHandle, forgetArchiveHandle, archiveStatus,
  getPlainHandle, forgetPlainHandle, plainStatus,
} from '../lib/fsaccess.js';

const $ = (id) => document.getElementById(id);
const buildEl = $('build-label');
buildEl.textContent = BUILD;

const statusEl = $('status');
function setStatus(text, kind = '') {
  statusEl.textContent = text;
  statusEl.className = 'status ' + kind;
}

async function paintFolder(btnId, labelId, statusFn, getter, forgetFn, what) {
  $(btnId).addEventListener('click', async () => {
    try {
      await getter({ interactive: true });
      await refresh();
      setStatus(`${what} folder set.`, 'ok');
    } catch (e) {
      if (e && e.name === 'AbortError') return;
      setStatus(`${what} folder error: ${e.message}`, 'err');
    }
  });
}

async function refresh() {
  const lib = await libraryStatus();
  $('library-label').textContent = lib.state === 'granted' ? lib.name :
    (lib.state === 'needs-permission' ? `${lib.name} (re-grant)` : 'not set');
  const vault = await archiveStatus();
  $('vault-label').textContent = vault.state === 'granted' ? vault.name :
    (vault.state === 'needs-permission' ? `${vault.name} (re-grant)` : 'not set');
  const plain = await plainStatus();
  $('plain-label').textContent = plain.state === 'granted' ? plain.name :
    (plain.state === 'needs-permission' ? `${plain.name} (re-grant)` : 'not set');
}

paintFolder('library-btn', 'library-label', libraryStatus, getLibraryHandle, forgetLibraryHandle, 'Library');
paintFolder('vault-btn', 'vault-label', archiveStatus, getArchiveHandle, forgetArchiveHandle, 'Vault');
paintFolder('plain-btn', 'plain-label', plainStatus, getPlainHandle, forgetPlainHandle, 'Output');

$('close-btn').addEventListener('click', () => window.close());

// Restore + wire the plain-format choice and summarizer settings.
(async () => {
  const st = await loadState();
  $('plain-format').value = st.plainFormat || 'md';
  $('summarizer').value = st.summarizer || 'auto';
  $('ollama-url').value = st.ollamaUrl || 'http://localhost:11434';
  $('ollama-model').value = st.ollamaModel || '';
  $('json-toggle').checked = await getIncludeJson();

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
  $('json-toggle').addEventListener('change', async () => {
    await setIncludeJson($('json-toggle').checked);
    setStatus($('json-toggle').checked ? 'JSON backups ON.' : 'JSON backups OFF.', 'ok');
  });

  await refresh();
  setStatus('Settings ready.', 'ok');
})();
