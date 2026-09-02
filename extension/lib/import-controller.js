// import-controller.js — the import job state machine (R-02/R-03/R-04/R-08).
//
//   idle ──Import──▶ discovering ──▶ importing ──▶ completed
//                      │               │
//                      └── Stop/pause ─┴──▶ paused | stopped
//                                 Resume continues the SAME job.
//
// Durability (R-02): the checkpoint has NO time-based expiry. Resume never
// restarts discovery at offset zero merely because the panel closed.
//
// Checkpointing (R-03): after every received list page and after every
// completed thread attempt, the checkpoint is persisted. On resume, target
// ids are diffed against the files on disk first — a thread written just
// before a crash is recognized and not fetched again (A-09).
//
// Pacing (R-08): one request at a time; 429 honors Retry-After (both
// forms) with persisted cooldown; 401/403 pauses with login guidance;
// 404/malformed are recorded and skipped without counting as rate-limit
// events; intentional abort is never a failure.

import { listConversations, getConversation, getAccountKey, BUILD } from './transport.js';
import { normalizeConversationSummary, normalizeConversation } from './vendors/chatgpt.js';
import { buildEnvelope } from './envelope.js';
import { readLibraryEnvelopes, writeLibraryThread } from './fsaccess.js';
import { loadCheckpoint, mutateCheckpoint, clearCheckpoint } from './import-state.js';

const BATCH = 50;
const MAX_PAGES = 200;              // R-04: safety limit pauses with a diagnostic
// Base spacing between requests. Raised from 400ms after real-account runs
// showed repeated 429s at that cadence — a second+ here keeps ChatGPT calm.
// (The e2e panel runs use a short delay so the suite stays fast; the mock
// server never rate-limits anyway.)
const BASE_DELAY_MS =
  (typeof location !== 'undefined' && new URLSearchParams(location.search).has('e2e'))
    ? 50 : 1400;
const MAX_DELAY_MS = 12000;
const MAX_CONSECUTIVE_429 = 5;      // pause after this many back-to-back 429s
const MAX_TRANSIENT_ATTEMPTS = 3;   // bounded retries per item (R-08)

// Auto-resume after a rate-limit pause (requested behavior): the pause exists
// only to let the 429 window pass, so waiting politely and retrying ourselves
// is the expected continuation. Escalating delay, capped attempts; auth
// pauses, safety-limit pauses and user stops never auto-resume.
// Panel-session-only: if the panel closes, the timer dies and Resume import
// remains the path (checkpoint is intact either way).
const AUTO_RESUME_MAX = 5;
const AUTO_RESUME_BASE_MS = 60_000;
const AUTO_RESUME_MAX_MS = 10 * 60_000;
let autoResumeAttempts = 0;
let autoResumeTimer = null;

function scheduleAutoResume() {
  if (autoResumeAttempts >= AUTO_RESUME_MAX) {
    status(
      'Import paused: repeated rate limiting, and the auto-resume budget is used up. ' +
        'Wait a while, then press Resume import.',
      'err');
    return;
  }
  const delayMs = Math.min(AUTO_RESUME_BASE_MS * 2 ** autoResumeAttempts, AUTO_RESUME_MAX_MS);
  autoResumeAttempts++;
  status(
    `Import paused: rate limited — auto-resuming in ~${Math.max(1, Math.round(delayMs / 60000))} min ` +
      '(press Resume import to go immediately).',
    'warn');
  clearTimeout(autoResumeTimer);
  autoResumeTimer = setTimeout(() => {
    if (!running) resumeImport();
  }, delayMs);
}

let running = false;
let abortCtrl = null;
let emit = () => {};

export function isRunning() {
  return running;
}

export function setEmitter(cb) {
  emit = cb || (() => {});
}

function status(text, kind = '') {
  emit({ type: 'status', text, kind });
}
function progress(done, total, label) {
  emit({ type: 'progress', done, total, label });
}
function spin(label) {
  emit({ type: 'spin', label });
}
function hideProgress() {
  emit({ type: 'progress-hide' });
}
function jobChanged() {
  emit({ type: 'job-changed' });
}

export async function hasResumable() {
  const cp = await loadCheckpoint();
  return !!cp.importJob.jobId && cp.importJob.state !== 'completed';
}

class PausedError extends Error {
  constructor(reason) {
    super(`import paused: ${reason}`);
    this.reason = reason;
  }
}

// ---------------------------------------------------------------------------
// pacing helpers

function abortableSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortErr());
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(t);
      reject(abortErr());
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function abortErr() {
  const e = new Error('aborted');
  e.category = 'aborted';
  return e;
}

// Persisted cooldown + delay, abortable (R-08: pacing survives reopen).
async function pace(cp, signal) {
  const now = Date.now();
  const waitUntil = Math.max(cp.importJob.pacing.nextAllowedAt || 0, now + cp.importJob.pacing.delayMs);
  cp.importJob.pacing.nextAllowedAt = waitUntil > now ? waitUntil : null;
  await mutateCheckpoint((st) => {
    st.importJob.pacing = cp.importJob.pacing;
  });
  const ms = waitUntil - now;
  if (ms > 0) await abortableSleep(ms, signal);
  if (cp.importJob.pacing.nextAllowedAt && cp.importJob.pacing.nextAllowedAt <= waitUntil) {
    cp.importJob.pacing.nextAllowedAt = null;
  }
}

async function applyRateLimitBackoff(cp, retryAfterMs) {
  const p = cp.importJob.pacing;
  p.delayMs = Math.min(Math.max(p.delayMs * 2, BASE_DELAY_MS), MAX_DELAY_MS);
  const waitMs = Math.max(retryAfterMs || 0, p.delayMs);
  p.nextAllowedAt = Date.now() + waitMs;
  p.consecutiveTransientFailures++;
  await mutateCheckpoint((st) => {
    st.importJob.pacing = p;
  });
  status(
    `Rate limited — waiting ${Math.round(waitMs / 1000)}s (safe to close the panel; ` +
      'Resume import continues).',
    'warn'
  );
}

// ---------------------------------------------------------------------------
// discovery (R-03/R-04): resume at saved nextOffset; page-at-a-time
// checkpointing; explicit pause at the safety limit.

async function ensureDiscovery(cp, signal) {
  const list = cp.chatgptList;
  if (list.complete) {
    status(`ChatGPT thread list already read (${list.items.length} threads).`);
    return;
  }

  spin('Reading ChatGPT thread list');
  status('Reading ChatGPT thread list…');

  for (;;) {
    if (signal.aborted) throw abortErr();

    // Pacing precedes EVERY request — including the first one after a
    // resume — so a persisted 429 cooldown is honored across reopen (R-08).
    await pace(cp, signal);

    let data;
    try {
      data = await listConversations(list.nextOffset, BATCH, { signal });
    } catch (e) {
      if (e.category === 'aborted') throw e;
      if (e.category === 'rate-limit') {
        if (cp.importJob.pacing.consecutiveTransientFailures >= MAX_CONSECUTIVE_429) {
          await pauseJob(cp, 'rate-limit',
            'Import paused: repeated rate limiting. Wait a little, then press Resume import.');
          throw new PausedError('rate-limit');
        }
        await applyRateLimitBackoff(cp, e.retryAfterMs);
        await pace(cp, signal); // sleeps until the cooldown elapses
        continue;               // retry the SAME page — no offset advance
      }
      if (e.category === 'auth') {
        await pauseJob(cp, 'auth',
          'Import paused: not logged in to ChatGPT. Log in on chatgpt.com, then press Resume import.');
        throw new PausedError('auth');
      }
      // transient (network/5xx/timeout): bounded retries, then pause
      cp.importJob.pacing.consecutiveTransientFailures++;
      await mutateCheckpoint((st) => { st.importJob.pacing = cp.importJob.pacing; });
      if (cp.importJob.pacing.consecutiveTransientFailures >= MAX_TRANSIENT_ATTEMPTS) {
        await pauseJob(cp, 'transient',
          `Import paused: the thread list could not be read (${e.message}). Check your connection, then press Resume import.`);
        throw new PausedError('transient');
      }
      await abortableSleep(1000 * cp.importJob.pacing.consecutiveTransientFailures, signal);
      continue;
    }

    const items = (data && data.items) || [];
    for (const item of items) {
      const c = normalizeConversationSummary(item);
      if (!list.items.some((x) => x.id === c.id)) list.items.push(c);
    }
    list.nextOffset += items.length;
    if (data && typeof data.total === 'number') list.expectedTotal = data.total;

    const shortPage = items.length < BATCH;
    if (shortPage || items.length === 0) {
      list.complete = true;
      list.completedAt = new Date().toISOString();
      cp.importJob.pacing.consecutiveTransientFailures = 0;
    }
    await mutateCheckpoint((st) => {
      st.chatgptList = cp.chatgptList;
      st.importJob.pacing = cp.importJob.pacing;
    });

    const found = list.items.length;
    const ofTotal = list.expectedTotal ? ` of ${list.expectedTotal}` : '';
    status(`Reading ChatGPT thread list · ${found}${ofTotal} found`);
    if (list.expectedTotal) progress(found, list.expectedTotal, `${found}/${list.expectedTotal} found`);

    if (list.complete) break;

    if (list.nextOffset / BATCH >= MAX_PAGES) {
      // R-04: reaching the safety limit must pause with a diagnostic —
      // never report a truncated scan as complete.
      await pauseJob(cp, 'safety-limit',
        `Import paused: the ChatGPT thread list passed ${MAX_PAGES} pages (${found} found). ` +
          'This is a safety limit, not a completed scan. Press Resume import to keep reading pages.');
      throw new PausedError('safety-limit');
    }
  }
}

// ---------------------------------------------------------------------------
// diff (R-04 step 6): completed summary set vs the on-disk Conversarium.

async function computeTargets(cp) {
  const { envelopes } = await readLibraryEnvelopes();
  const have = new Map(envelopes.map((e) => [e.id, e.updated || e.created || '']));
  const targets = cp.chatgptList.items
    .filter((c) => {
      const h = have.get(c.id);
      return !h || !c.updated || h < c.updated;
    })
    .map((c) => c.id);
  cp.importJob.targetIds = targets;
  // Unchanged = items already current on disk that this job did not save
  // (resume re-diffs must not double-count already-saved threads).
  cp.importJob.counters.unchanged = Math.max(
    0, cp.chatgptList.items.length - targets.length - cp.importJob.counters.saved);
  await mutateCheckpoint((st) => {
    st.importJob.targetIds = cp.importJob.targetIds;
    st.importJob.counters.unchanged = cp.importJob.counters.unchanged;
  });
  return targets;
}

// ---------------------------------------------------------------------------
// detail import (R-03): checkpoint after every attempt; disk-diff healing;
// classified error handling (R-08).

async function importDetails(cp, signal) {
  const { envelopes } = await readLibraryEnvelopes();
  const disk = new Map(envelopes.map((e) => [e.id, e.updated || e.created || '']));
  const byId = new Map(cp.chatgptList.items.map((c) => [c.id, c]));
  const attempted = new Set(cp.importJob.attemptedIds);
  const work = cp.importJob.targetIds.filter((id) => !attempted.has(id));
  const total = cp.importJob.targetIds.length;

  spin('Importing from ChatGPT');
  const paintProgress = () => {
    const c = cp.importJob.counters;
    const done = c.saved + c.failed;
    // R-06: one progress model — bar width AND label use processed/targets;
    // saved/failed are reported separately.
    const label = `Processed ${done} of ${total} · Saved ${c.saved} · Failed ${c.failed}`;
    progress(done, total, label);
  };
  paintProgress();

  for (const id of work) {
    if (signal.aborted) break;
    const c = byId.get(id) || { id, title: id, updated: null };

    // Pacing precedes every request — the persisted cooldown holds across
    // reopen and resume (R-08).
    await pace(cp, signal);
    if (signal.aborted) break;

    // A-09 healing: a file written immediately before a crash is already
    // current on disk — recognize it and do NOT fetch it again.
    const have = disk.get(id);
    if (have && (!c.updated || have >= c.updated)) {
      cp.importJob.attemptedIds.push(id);
      cp.importJob.counters.saved++;
      cp.importJob.counters.processed = cp.importJob.counters.saved + cp.importJob.counters.failed;
      await mutateCheckpoint((st) => {
        st.importJob.attemptedIds = cp.importJob.attemptedIds;
        st.importJob.counters = cp.importJob.counters;
      });
      paintProgress();
      continue;
    }

    status(`Importing ${cp.importJob.counters.processed + 1}/${total}: ${c.title}`, 'warn');

    let outcome = null; // 'saved' | handled internally
    for (let attempt = 1; attempt <= MAX_TRANSIENT_ATTEMPTS + 1 && !signal.aborted; attempt++) {
      try {
        const raw = await getConversation(id, { signal });
        const env = buildEnvelope(normalizeConversation(raw));
        await writeLibraryThread(env);
        disk.set(id, env.updated || have || '');
        // R-05: live upsert — the panel shows the title before the import
        // finishes (A-04), without re-reading the whole folder.
        emit({ type: 'thread-saved', env });
        cp.importJob.attemptedIds.push(id);
        cp.importJob.counters.saved++;
        // Success cools pacing down SLOWLY (AIMD-style decay): the old
        // "reset to base on first success" slammed back to full speed after
        // every 429 and immediately invited the next one. 15% decay per
        // success converges to base only after ~20 smooth fetches.
        cp.importJob.pacing.delayMs = Math.max(BASE_DELAY_MS, Math.round(cp.importJob.pacing.delayMs * 0.85));
        cp.importJob.pacing.consecutiveTransientFailures = 0;
        cp.importJob.pacing.nextAllowedAt = null;
        outcome = 'saved';
        break;
      } catch (e) {
        if (e.category === 'aborted') throw e;
        if (e.category === 'auth') {
          await pauseJob(cp, 'auth',
            'Import paused: not logged in to ChatGPT. Log in on chatgpt.com, then press Resume import.');
          throw new PausedError('auth');
        }
        if (e.category === 'rate-limit') {
          if (cp.importJob.pacing.consecutiveTransientFailures >= MAX_CONSECUTIVE_429) {
            await pauseJob(cp, 'rate-limit',
              'Import paused: repeated rate limiting. Wait a little, then press Resume import.');
            throw new PausedError('rate-limit');
          }
          await applyRateLimitBackoff(cp, e.retryAfterMs);
          await pace(cp, signal);
          continue; // retry same id — attempt budget only counts real attempts
        }
        if (e.category === 'not-found' || e.category === 'malformed') {
          // Record specifically; continue; never a rate-limit event (R-08).
          // Deliberately NOT marked attempted: failed targets remain
          // eligible on Resume (R-03) until they succeed.
          recordFailure(cp, id, c.title, e.category === 'not-found' ? 'unavailable' : 'malformed', e.message);
          outcome = 'failed';
          break;
        }
        // transient: bounded retries, then retain as failed (and eligible
        // for Resume — still not marked attempted)
        if (attempt > MAX_TRANSIENT_ATTEMPTS) {
          recordFailure(cp, id, c.title, 'transient', e.message);
          outcome = 'failed';
          break;
        }
        await abortableSleep(1000 * attempt, signal);
      }
    }
    if (signal.aborted) break;

    if (outcome === 'failed') cp.importJob.counters.failed++;
    cp.importJob.counters.processed = cp.importJob.counters.saved + cp.importJob.counters.failed;
    await mutateCheckpoint((st) => {
      st.importJob.attemptedIds = cp.importJob.attemptedIds;
      st.importJob.counters = cp.importJob.counters;
      st.importJob.failures = cp.importJob.failures;
      st.importJob.pacing = cp.importJob.pacing;
    });
    paintProgress();
  }
}

function recordFailure(cp, id, title, category, message) {
  const existing = cp.importJob.failures.find((f) => f.id === id);
  const entry = { id, title, category, message, attempts: 1 };
  if (existing) {
    existing.attempts++;
    existing.category = category;
    existing.message = message;
  } else {
    cp.importJob.failures.push(entry);
  }
  console.warn(`[convo-hist ${BUILD}] import failure (${category}): "${title}" (${id}) — ${message}`);
}

async function pauseJob(cp, reason, message) {
  cp.importJob.state = 'paused';
  cp.importJob.pauseReason = reason;
  await mutateCheckpoint((st) => {
    st.importJob.state = 'paused';
    st.importJob.pauseReason = reason;
  });
  status(message, 'err');
}

// ---------------------------------------------------------------------------
// public API

function remainingCount(cp) {
  const attempted = new Set(cp.importJob.attemptedIds);
  return cp.importJob.targetIds.filter((id) => !attempted.has(id)).length;
}

// A brand-new import: fresh discovery from offset zero (R-04). The caller
// has already ensured Conversarium access (user gesture).
export async function startNewImport() {
  if (running) return;
  await runJob({ fresh: true });
}

// Continue the unfinished checkpoint (R-02): discovery resumes at the
// saved offset; detail work never re-crawls the list. Returns without
// effect when no unfinished job exists.
export async function resumeImport() {
  if (running) return;
  const cp = await loadCheckpoint();
  if (!cp.importJob.jobId || cp.importJob.state === 'completed') return;

  // Account scoping (R-03): never apply the old job's list/diff to a
  // different account. The UI's "Start new import" is the explicit ask.
  const accountKey = await getAccountKey();
  if (cp.chatgptList.accountKey && accountKey && cp.chatgptList.accountKey !== accountKey) {
    await pauseJob(cp, 'account-changed',
      'The ChatGPT account changed since this import started. ' +
        'Press "Start new import" to discard the old job and scan the new account (imported threads are kept).');
    emit({ type: 'account-changed' });
    return;
  }
  await runJob({ fresh: false });
}

// Explicitly discard an unfinished job (metadata only) — the "Start new
// import" action. Returns the discarded summary for the UI.
export async function discardJob() {
  const cp = await loadCheckpoint();
  const had = !!cp.importJob.jobId && cp.importJob.state !== 'completed';
  await clearCheckpoint();
  jobChanged();
  return had;
}

// Dedicated cancellation (R-07): aborts the active run. The in-flight
// request settles; no further request starts.
export function stop() {
  if (abortCtrl) abortCtrl.abort();
}

async function runJob({ fresh }) {
  running = true;
  abortCtrl = new AbortController();
  const signal = abortCtrl.signal;
  jobChanged();
  hideProgress();

  let stoppedCleanly = false;
  try {
    let cp;
    if (fresh) {
      const accountKey = await getAccountKey();
      await clearCheckpoint();
      cp = await mutateCheckpoint((st) => {
        st.chatgptList.startedAt = new Date().toISOString();
        st.chatgptList.accountKey = accountKey;
        st.importJob.jobId = `job-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        st.importJob.state = 'discovering';
        st.importJob.pacing.delayMs = BASE_DELAY_MS;
        st.importJob.pacing.nextAllowedAt = null;
        st.importJob.pacing.consecutiveTransientFailures = 0;
      });
    } else {
      cp = await loadCheckpoint();
      cp.importJob.state = cp.chatgptList.complete ? 'importing' : 'discovering';
      await mutateCheckpoint((st) => {
        st.importJob.state = cp.importJob.state;
      });
    }

    await ensureDiscovery(cp, signal);
    await computeTargets(cp);

    cp.importJob.state = 'importing';
    await mutateCheckpoint((st) => {
      st.importJob.state = 'importing';
    });
    await importDetails(cp, signal);

    if (signal.aborted) throw abortErr();

    // Completed (R-03): checkpoint retained for diagnostics; main action
    // returns to Import.
    cp.importJob.state = 'completed';
    cp.importJob.pauseReason = null;
    await mutateCheckpoint((st) => {
      st.importJob.state = 'completed';
      st.importJob.pauseReason = null;
    });
    const { envelopes } = await readLibraryEnvelopes();
    const c = cp.importJob.counters;
    const summary = {
      text: `Import done: ${c.saved} new, ${c.unchanged} unchanged, ${c.failed} failed — ` +
        `the Conversarium holds ${envelopes.length} threads.` +
        (c.failed ? ' Open the panel console for failure details.' : ''),
      kind: c.failed ? 'warn' : 'ok',
    };
    status(summary.text, summary.kind);
    emit({ type: 'done', summary });
    // Full completion: the account is calm again — clear the auto-resume debt.
    autoResumeAttempts = 0;
  } catch (e) {
    if (e.category === 'aborted' || signal.aborted) {
      stoppedCleanly = true;
      const cp = await loadCheckpoint();
      await mutateCheckpoint((st) => {
        if (st.importJob.state === 'discovering' || st.importJob.state === 'importing') {
          st.importJob.state = 'stopped';
        }
      });
      const c = cp.importJob.counters;
      const remaining = remainingCount(cp);
      const summary = {
        text: `Import stopped — ${c.saved} saved, ${c.failed} failed, ` +
          `${remaining} remaining. Resume import when ready.`,
        kind: 'warn',
      };
      status(summary.text, summary.kind);
      emit({ type: 'done', summary });
    } else if (e instanceof PausedError) {
      // Rate-limit pauses auto-resume (escalating backoff); everything else
      // (auth, safety limit, account change) waits for the user on purpose.
      if (e.reason === 'rate-limit') scheduleAutoResume();
    } else {
      // Unexpected exception: preserve the checkpoint and reconcile (R-05).
      const cp = await loadCheckpoint();
      await mutateCheckpoint((st) => {
        if (st.importJob.state === 'discovering' || st.importJob.state === 'importing') {
          st.importJob.state = 'paused';
          st.importJob.pauseReason = 'unexpected';
        }
      });
      console.error(`[convo-hist ${BUILD}] import failed unexpectedly:`, e);
      const summary = {
        text: `Import failed unexpectedly: ${e.message}. The checkpoint was preserved — press Resume import.`,
        kind: 'err',
      };
      status(summary.text, summary.kind);
      emit({ type: 'done', summary });
    }
  } finally {
    running = false;
    abortCtrl = null;
    hideProgress();
    jobChanged();
  }
}
