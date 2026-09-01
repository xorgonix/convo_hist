// settings.js — the settings window. Folders are granted here (File System
// Access pickers need a user gesture — these buttons are it); the "Test"
// button writes a marker file so the user can confirm exactly which folder
// each grant points at (the API cannot reveal full paths).

import { BUILD } from '../lib/transport.js';
import { loadState, saveSettings } from '../lib/state.js';
import {
  getLibraryHandle, libraryStatus, writeVerifyProbe,
  getArchiveHandle, archiveStatus,
  getPlainHandle, plainStatus,
} from '../lib/fsaccess.js';

const $ = (id) => document.getElementById(id);
$('build-label').textContent = BUILD;

const statusEl = $('status');
function setStatus(text, kind = '') {
  statusEl.textContent = text;
  statusEl.className = 'status ' + kind;
}

function wireFolder(btnId, verifyId, labelId, statusFn, getter, what) {
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
  $(verifyId).addEventListener('click', async () => {
    try {
      const handle = await getter({ interactive: true });
      if (!handle) {
        setStatus(`${what} folder not set yet — click Choose folder first.`, 'warn');
        return;
      }
      const name = await writeVerifyProbe(handle);
      setStatus(`Wrote _convo_hist_here.txt into "${name}" — check it in Explorer.`, 'ok');
    } catch (e) {
      if (e && e.name === 'AbortError') return;
      setStatus(`Verify failed: ${e.message}`, 'err');
    }
  });
}

wireFolder('library-btn', 'library-verify', 'library-label', libraryStatus, getLibraryHandle, 'Library');
wireFolder('vault-btn', 'vault-verify', 'vault-label', archiveStatus, getArchiveHandle, 'Vault');
wireFolder('plain-btn', 'plain-verify', 'plain-label', plainStatus, getPlainHandle, 'Output');

$('close-btn').addEventListener('click', () => window.close());

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
