// transport.js — DIRECT transport from extension contexts to ChatGPT's
// internal API (host_permissions => cookies + CORS-exempt fetch).
//
// Reliability layers:
//   1. every fetch is time-boxed (never hangs silently)
//   2. every stage is reported via onStage() AND console.log
//   3. direct fetch failure => automatic retry through the background
//      service worker (different execution context, same permissions)
//
// BUILD stamp is logged at import so stale-code confusion dies forever.

export const BUILD = 'v0.1.6-multiselect';

const ORIGIN = 'https://chatgpt.com';
const TOKEN_TTL_MS = 10 * 60 * 1000;
const TIMEOUT_MS = 15000;

let cachedToken = null;
let tokenFetchedAt = 0;
let stageCb = null;

export function onStage(cb) {
  stageCb = cb;
}

function stage(msg) {
  console.log(`[convo-hist ${BUILD}] ${msg}`);
  if (stageCb) {
    try {
      stageCb(msg);
    } catch {
      /* logger must never break transport */
    }
  }
}

function fail(stage_, msg, status) {
  const err = new Error(`[${stage_}] ${msg}`);
  err.stage = stage_;
  err.status = status || null;
  return err;
}

async function fetchWithTimeout(url, options = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } catch (e) {
    if (e && e.name === 'AbortError') {
      throw fail('network', `timed out after ${TIMEOUT_MS / 1000}s`);
    }
    throw fail('network', `network error — ${e.message}`);
  } finally {
    clearTimeout(timer);
  }
}

async function getAuthToken() {
  const now = Date.now();
  if (cachedToken && now - tokenFetchedAt < TOKEN_TTL_MS) return cachedToken;

  stage('GET /api/auth/session …');
  try {
    const res = await fetchWithTimeout(`${ORIGIN}/api/auth/session`, { credentials: 'include' });
    if (res.ok) {
      const data = await res.json();
      if (data && data.accessToken) {
        cachedToken = data.accessToken;
        tokenFetchedAt = now;
        stage('session: got access token');
        return cachedToken;
      }
      stage('session: reachable but logged out (no token)');
      return null;
    }
    stage(`session: HTTP ${res.status}`);
    return null;
  } catch (e) {
    stage(`session: ${e.message} (will try cookie-only)`);
    return null;
  }
}

async function coreFetch(path) {
  const headers = { Accept: 'application/json' };
  const token = await getAuthToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  stage(`GET ${path} …`);
  const res = await fetchWithTimeout(`${ORIGIN}${path}`, { credentials: 'include', headers });
  if (!res.ok) {
    throw fail(
      'api',
      `HTTP ${res.status} ${res.statusText}` +
        (res.status === 401 || res.status === 403
          ? ' (not logged in, or Cloudflare challenged)'
          : ''),
      res.status
    );
  }
  return res.json();
}

async function fetchViaServiceWorker(path) {
  stage('retrying via background service worker …');
  let resp;
  try {
    resp = await chrome.runtime.sendMessage({ type: 'convo:proxy-fetch', path });
  } catch (e) {
    throw fail('sw', `message to service worker failed — ${e.message}`);
  }
  if (!resp) throw fail('sw', 'service worker returned nothing');
  if (!resp.ok) throw fail('sw', resp.error || 'unknown SW error', resp.status || null);
  return resp.data;
}

async function apiGet(path, { allowProxy = true } = {}) {
  try {
    const data = await coreFetch(path);
    stage('← ok (direct)');
    return data;
  } catch (directErr) {
    if (!allowProxy) throw directErr;
    stage(`direct failed — ${directErr.message}`);
    const data = await fetchViaServiceWorker(path);
    stage('← ok (service worker)');
    return data;
  }
}

export async function listConversations(offset = 0, limit = 50) {
  return apiGet(`/backend-api/conversations?offset=${offset}&limit=${limit}`);
}

export async function getConversation(chatId) {
  return apiGet(`/backend-api/conversation/${encodeURIComponent(chatId)}`);
}

// Called by the background service worker (allowProxy=false prevents recursion).
export async function proxyFetch(path) {
  try {
    const data = await coreFetch(path);
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: e.message, status: e.status || null };
  }
}
