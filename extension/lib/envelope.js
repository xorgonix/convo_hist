// envelope.js — the canonical, vendor-neutral conversation envelope.
// JSON on disk is the SOURCE OF TRUTH; markdown is a derived view.

export const SCHEMA_VERSION = 'convo-hist-envelope/1';

// Accepts anything the API feels like sending: epoch seconds (number or
// numeric string), ISO strings, or garbage. Never throws — returns null
// for anything unusable. Absolute-first rendering happens in formatTimestamp.
export function toIso(value) {
  if (value === null || value === undefined || value === '') return null;

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    const ms = Math.abs(value) > 1e12 ? value : value * 1000; // epoch s vs ms
    const d = new Date(ms);
    return isNaN(d.getTime()) ? null : d.toISOString();
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const n = Number(trimmed);
    if (Number.isFinite(n)) {
      const ms = Math.abs(n) > 1e12 ? n : n * 1000;
      const d = new Date(ms);
      if (!isNaN(d.getTime())) return d.toISOString();
    }
    const d = new Date(trimmed); // ISO-ish strings
    return isNaN(d.getTime()) ? null : d.toISOString();
  }

  if (value instanceof Date) {
    return isNaN(value.getTime()) ? null : value.toISOString();
  }

  return null;
}

// Absolute-first timestamps (locked decision): "2026-08-30 14:32"
export function formatTimestamp(iso) {
  if (!iso) return '(no timestamp)';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '(bad timestamp)';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function hasCode(text) {
  return /```/.test(text || '');
}

export function buildEnvelope(norm) {
  if (!norm || !norm.vendor || !norm.id) {
    throw new Error('normalizeConversation() result missing vendor/id');
  }
  return {
    schema: SCHEMA_VERSION,
    vendor: norm.vendor,
    id: norm.id,
    title: norm.title || 'Untitled',
    created: norm.created || null,
    updated: norm.updated || null,
    captured_at: new Date().toISOString(),
    model: norm.model || null,
    summary: null,
    tags: [],
    turns: (norm.turns || []).map((t, i) => ({
      index: i,
      role: t.role,
      timestamp: t.timestamp || null,
      epoch: t.epoch || null,
      text: t.text,
      has_code: hasCode(t.text)
    })),
    // Immutable vendor payload (branches, metadata, everything) — the
    // envelope's normalized fields above are derivable from this.
    raw: norm.raw || null
  };
}
