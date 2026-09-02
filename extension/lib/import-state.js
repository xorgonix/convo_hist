// import-state.js — durable import checkpoint (R-02/R-03).
//
// An unfinished import is a JOB, not a cache: it has no time-based expiry.
// Closing the panel, stopping, crashing, or restarting the browser leaves
// the checkpoint intact; Resume import continues exactly where it stopped.
//
// Schema (stateVersion 2, spec R-03 minimum shape):
//
//   chatgptList  discovery progress: collected summaries, nextOffset,
//                expectedTotal, completion flag, owning account
//   importJob    job state machine + per-thread progress + failure ledger +
//                pacing/cooldown state (survives panel reopen — R-08)
//
// Data-safety rules (spec §9): the checkpoint is rebuildable metadata —
// the Conversarium JSON files on disk remain canonical. Clearing a job
// deletes only this metadata, never imported threads. No access tokens are
// stored: account scoping uses a one-way accountKey from transport.js.

const KEY = 'importCheckpoint';
export const STATE_VERSION = 2;

let cached = null;

export function blankCheckpoint() {
  return {
    stateVersion: STATE_VERSION,
    chatgptList: {
      items: [],            // [{ id, title, created, updated }]
      expectedTotal: null,
      nextOffset: 0,
      complete: false,
      startedAt: null,
      completedAt: null,
      accountKey: null,     // one-way account identity (no tokens)
    },
    importJob: {
      jobId: null,
      state: 'idle',        // idle|discovering|importing|paused|stopped|completed
      targetIds: [],        // ids needing import (missing or newer on ChatGPT)
      attemptedIds: [],     // ids processed at least once in this job
      failures: [],         // [{ id, title, category, message, attempts }]
      counters: { processed: 0, saved: 0, failed: 0, unchanged: 0 },
      pacing: {
        delayMs: 400,       // current inter-request delay
        nextAllowedAt: null,// persisted cooldown (429 Retry-After) — epoch ms
        consecutiveTransientFailures: 0,
      },
      pauseReason: null,    // null|'auth'|'rate-limit'|'safety-limit'|'account-changed'
      updatedAt: null,
    },
  };
}

export async function loadCheckpoint() {
  if (cached) return cached;
  try {
    const res = await chrome.storage.local.get(KEY);
    cached = res && res[KEY] ? hydrate(res[KEY]) : blankCheckpoint();
  } catch {
    cached = blankCheckpoint(); // storage unavailable — degrade to fresh job
  }
  return cached;
}

// Versioned migration: older/partial checkpoints are healed into the
// current shape rather than discarded (imported JSON is never touched).
function hydrate(raw) {
  const blank = blankCheckpoint();
  const cp = {
    ...blank,
    ...raw,
    chatgptList: { ...blank.chatgptList, ...(raw.chatgptList || {}) },
    importJob: {
      ...blank.importJob,
      ...(raw.importJob || {}),
      counters: { ...blank.importJob.counters, ...((raw.importJob || {}).counters || {}) },
      pacing: { ...blank.importJob.pacing, ...((raw.importJob || {}).pacing || {}) },
      failures: (raw.importJob || {}).failures || [],
      targetIds: (raw.importJob || {}).targetIds || [],
      attemptedIds: (raw.importJob || {}).attemptedIds || [],
    },
  };
  cp.stateVersion = STATE_VERSION;
  return cp;
}

async function persist(cp) {
  cached = cp;
  cp.updatedAt = new Date().toISOString();
  try {
    await chrome.storage.local.set({ [KEY]: cp });
  } catch {
    /* best-effort: losing checkpoint metadata costs progress, never data */
  }
}

// Mutate + persist atomically-enough (single writer: the controller).
export async function mutateCheckpoint(fn) {
  const cp = await loadCheckpoint();
  fn(cp);
  await persist(cp);
  return cp;
}

// Discard the job (metadata only — never Conversarium files).
export async function clearCheckpoint() {
  await persist(blankCheckpoint());
}
