// transport.js — DIRECT transport from extension contexts to ChatGPT's
// internal API (host_permissions => cookies + CORS-exempt fetch).
//
// Reliability layers (v0.6.0):
//   1. every fetch is time-boxed AND cancellable — callers pass an
//      AbortSignal (R-07/R-08); caller abort and request timeout compose
//      into one signal; an intentional abort is classified as 'aborted',
//      never as a failure
//   2. errors are classified by category: auth (401/403), rate-limit (429),
//      transient (5xx/network/timeout), not-found (404) — the import
//      controller keys its retry/pause policy off err.category
//   3. Retry-After is parsed in BOTH legal forms (delta-seconds and
//      HTTP-date) and surfaced as err.retryAfterMs
//   4. direct fetch failure => automatic retry through the background
//      service worker — but never after cancellation: a second request is
//      not started once the caller has aborted (R-07)
//   5. session identity: getAccountKey() returns a one-way hash of the
//      access token so checkpoints can be scoped per account WITHOUT
//      storing the token (R-03)
//
// BUILD stamp is logged at import so stale-code confusion dies forever.
// Single authoritative version source: the manifest (R-15).

export const BUILD = `v${chrome.runtime.getManifest().version}`;

const ORIGIN = 'https://chatgpt.com';
const TOKEN_TTL_MS = 10 * 60 * 1000;
const TIMEOUT_MS = 15000;
const MAX_RETRY_AFTER_MS = 60000;

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
  err.category = classifyStatus(status);
  return err;
}

function classifyStatus(status) {
  if (status === 401 || status === 403) return 'auth';
  if (status === 404) return 'not-found';
  if (status === 429) return 'rate-limit';
  if (status && status >= 500) return 'transient';
  return status ? 'transient' : 'transient';
}

// Retry-After: delta-seconds ("2") or HTTP-date ("Wed, 02 Sep 2026 …").
// Returns milliseconds to wait, or null when absent/unparseable.
export function parseRetryAfterMs(value) {
  if (!value) return null;
  const v = String(value).trim();
  if (!v) return null;
  const secs = Number(v);
  if (Number.isFinite(secs) && v === String(secs)) {
    return Math.min(Math.max(secs * 1000, 0), MAX_RETRY_AFTER_MS);
  }
  const date = Date.parse(v);
  if (!Number.isNaN(date)) {
    return Math.min(Math.max(date - Date.now(), 0), MAX_RETRY_AFTER_MS);
  }
  return null;
}

function abortedError() {
  const err = fail('network', 'aborted by user');
  err.category = 'aborted';
  return err;
}

// Compose the caller's signal (if any) with the request timeout.
function compositeSignal(signal) {
  const signals = [AbortSignal.timeout(TIMEOUT_MS)];
  if (signal) signals.push(signal);
  return signals.length > 1 ? AbortSignal.any(signals) : signals[0];
}

async function fetchJson(url, { credentials = 'include', headers = {}, signal } = {}) {
  const composite = compositeSignal(signal);
  try {
    return await fetch(url, { credentials, headers, signal: composite });
  } catch (e) {
    if (signal && signal.aborted) throw abortedError();
    // timeout fired (TimeoutError on modern Chromium, AbortError otherwise)
    throw fail('network', `timed out after ${TIMEOUT_MS / 1000}s`);
  }
}

async function getAuthToken(signal) {
  const now = Date.now();
  if (cachedToken && now - tokenFetchedAt < TOKEN_TTL_MS) return cachedToken;

  stage('GET /api/auth/session …');
  try {
    const res = await fetchJson(`${ORIGIN}/api/auth/session`, { signal });
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
    if (e.category === 'aborted') throw e;
    stage(`session: ${e.message} (will try cookie-only)`);
    return null;
  }
}

// One-way account identity for checkpoint scoping (R-03): a hash of the
// access token — the token itself is never stored in the checkpoint.
export async function getAccountKey() {
  const token = await getAuthToken();
  if (!token) return null;
  let h = 0x811c9dc5; // FNV-1a 32-bit
  for (let i = 0; i < token.length; i++) {
    h ^= token.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `acct-${h.toString(16).padStart(8, '0')}`;
}

async function coreFetch(path, signal) {
  const headers = { Accept: 'application/json' };
  const token = await getAuthToken(signal);
  if (token) headers.Authorization = `Bearer ${token}`;

  stage(`GET ${path} …`);
  const res = await fetchJson(`${ORIGIN}${path}`, { headers, signal });
  if (!res.ok) {
    const err = fail(
      'api',
      `HTTP ${res.status} ${res.statusText}` +
        (res.status === 401 || res.status === 403
          ? ' (not logged in, or Cloudflare challenged)'
          : ''),
      res.status
    );
    if (res.status === 429) {
      const ms = parseRetryAfterMs(res.headers.get('retry-after'));
      if (ms != null) err.retryAfterMs = ms;
    }
    throw err;
  }
  try {
    return await res.json();
  } catch (e) {
    const err = fail('api', `malformed JSON payload — ${e.message}`, res.status);
    err.category = 'malformed';
    throw err;
  }
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

async function apiGet(path, { signal, allowProxy = true } = {}) {
  try {
    const data = await coreFetch(path, signal);
    stage('← ok (direct)');
    return data;
  } catch (directErr) {
    if (!allowProxy) throw directErr;
    if (directErr.category === 'aborted') throw directErr;
    if (signal && signal.aborted) throw abortedError();
    // A 4xx WITH a status is an authoritative answer (auth, forbidden, not
    // found) — the SW would repeat the identical request and get the same
    // result. Only fall back for network-level failures and 5xx. Never
    // start a second request once the caller has aborted (R-07).
    if (directErr.status && directErr.status < 500) throw directErr;
    stage(`direct failed — ${directErr.message}`);
    const data = await fetchViaServiceWorker(path);
    if (signal && signal.aborted) throw abortedError(); // discard late results
    stage('← ok (service worker)');
    return data;
  }
}

export async function listConversations(offset = 0, limit = 50, { signal } = {}) {
  return apiGet(`/backend-api/conversations?offset=${offset}&limit=${limit}`, { signal });
}

export async function getConversation(chatId, { signal } = {}) {
  return apiGet(`/backend-api/conversation/${encodeURIComponent(chatId)}`, { signal });
}

// Called by the background service worker (allowProxy=false prevents recursion).
export async function proxyFetch(path) {
  try {
    const data = await coreFetch(path);
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: e.message, status: e.status || null, category: e.category || null };
  }
}
