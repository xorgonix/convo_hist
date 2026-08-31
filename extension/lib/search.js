// search.js — message-level full-text search over archived envelopes.
// Purpose-built inverted index (no dependencies — the vendor CDNs served
// loader shims, and a personal archive doesn't need Lucene).
// Features: prefix + fuzzy(1-edit) matching, IDF-weighted scoring, query
// filters (user: assistant: code:), conversation grouping, snippets, <mark>.

const TOKEN_RE = /[a-z0-9_+#.-]+/g;

function tokenize(s) {
  return String(s).toLowerCase().match(TOKEN_RE) || [];
}

// True if a and b differ by at most one edit (insert / delete / substitute).
export function editDistanceAtMost1(a, b) {
  if (a === b) return true;
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > 1) return false;

  let i = 0; // index into a
  let j = 0; // index into b
  let edits = 0;
  while (i < la && j < lb) {
    if (a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    if (++edits > 1) return false;
    if (la > lb) i++;        // extra char in a — skip it
    else if (lb > la) j++;   // extra char in b
    else { i++; j++; }       // substitution
  }
  return true; // length diff of 1 is absorbed by the loop
}

// ---------------------------------------------------------------------------
// Index construction

export function buildSearchIndex(envelopes) {
  const docs = new Map();   // docId -> doc (metadata + text)
  const postings = new Map(); // term -> Map(docId -> weighted tf)
  let totalDocs = 0;

  for (const env of envelopes) {
    (env.turns || []).forEach((t, i) => {
      if (!t || !t.text) return;
      const docId = `${env.id}#${i}`;
      const doc = {
        id: docId,
        convId: env.id,
        convTitle: env.title || 'Untitled',
        role: t.role || 'unknown',
        turnIndex: i,
        timestamp: t.timestamp || null,
        hasCode: !!t.has_code,
        tags: env.tags || [],
        summary: env.summary || '',
        text: t.text
      };
      docs.set(docId, doc);
      totalDocs++;

      // Per-field weighted term frequencies for this turn.
      const tf = new Map();
      const addField = (text, weight) => {
        for (const term of tokenize(text)) {
          tf.set(term, (tf.get(term) || 0) + weight);
        }
      };
      addField(doc.convTitle, 3);
      addField(doc.tags.join(' '), 2.5);
      addField(doc.summary, 1.5);
      addField(doc.text, 1);

      for (const [term, w] of tf) {
        let p = postings.get(term);
        if (!p) {
          p = new Map();
          postings.set(term, p);
        }
        p.set(docId, (p.get(docId) || 0) + w);
      }
    });
  }

  return { docs, postings, terms: [...postings.keys()].sort(), totalDocs };
}

// Expand a query token to vocabulary terms: exact, then prefix matches,
// then single-edit fuzzy matches (token must be >= 4 chars for fuzz).
function expandTerm(state, token, { maxPrefix = 40, maxFuzzy = 20 } = {}) {
  const out = [];
  if (state.postings.has(token)) out.push(token);

  const lower = token;
  // prefix range in the sorted vocabulary
  const start = firstIndexGreaterOrEqual(state.terms, lower);
  for (let i = start; i < state.terms.length && out.length < maxPrefix; i++) {
    const term = state.terms[i];
    if (!term.startsWith(lower)) break;
    if (term !== lower) out.push(term);
  }

  if (lower.length >= 4 && out.length < 8) {
    for (const term of state.terms) {
      if (out.length >= maxPrefix) break;
      if (Math.abs(term.length - lower.length) > 1) continue;
      if (editDistanceAtMost1(lower, term) && !out.includes(term)) out.push(term);
    }
  }
  return out;
}

// First index in the sorted array whose string is >= target (lower_bound).
function firstIndexGreaterOrEqual(sorted, target) {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] >= target) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

export function parseQuery(q) {
  const filters = { role: null, code: false };
  const tokens = [];
  for (const raw of String(q || '').split(/\s+/)) {
    const tok = raw.trim();
    if (!tok) continue;
    const lower = tok.toLowerCase();
    if (lower.startsWith('user:')) {
      filters.role = 'user';
      const v = tok.slice(5).trim();
      if (v) tokens.push(v);
      continue;
    }
    if (lower.startsWith('assistant:')) {
      filters.role = 'assistant';
      const v = tok.slice(10).trim();
      if (v) tokens.push(v);
      continue;
    }
    if (lower.startsWith('code:')) {
      filters.code = true;
      const v = tok.slice(5).trim();
      if (v) tokens.push(v);
      continue;
    }
    tokens.push(tok);
  }
  return { text: tokens.join(' '), tokens, filters };
}

function matchFilters(doc, filters) {
  if (!doc) return false;
  if (filters.role && doc.role !== filters.role) return false;
  if (filters.code && !doc.hasCode) return false;
  return true;
}

function groupHits(scored, state, limit) {
  const groups = new Map();
  for (const h of scored) {
    const doc = state.docs.get(h.id);
    if (!doc) continue;
    if (!groups.has(doc.convId)) {
      groups.set(doc.convId, {
        convId: doc.convId,
        title: doc.convTitle,
        tags: doc.tags,
        summary: doc.summary,
        best: 0,
        hits: []
      });
    }
    const g = groups.get(doc.convId);
    if (h.score > g.best) g.best = h.score;
    g.hits.push({
      score: h.score,
      role: doc.role,
      turnIndex: doc.turnIndex,
      timestamp: doc.timestamp,
      hasCode: doc.hasCode,
      text: doc.text
    });
  }
  return [...groups.values()].sort((a, b) => b.best - a.best);
}

// Main entry: query -> conversation-grouped, ranked results.
export function searchArchive(state, query, { limit = 80 } = {}) {
  const { text, tokens, filters } = parseQuery(query);
  const scores = new Map(); // docId -> score

  if (!text.trim()) {
    // filter-only query (e.g. "code:") — scan docs
    const hits = [];
    for (const [id, doc] of state.docs) {
      if (!matchFilters(doc, filters)) continue;
      hits.push({ id, score: 1 });
      if (hits.length >= limit) break;
    }
    return groupHits(hits, state);
  }

  for (const token of tokens) {
    for (const term of expandTerm(state, token)) {
      const p = state.postings.get(term);
      if (!p) continue;
      const idf = Math.log(1 + state.totalDocs / Math.max(1, p.size));
      for (const [docId, w] of p) {
        scores.set(docId, (scores.get(docId) || 0) + w * idf);
      }
    }
  }

  const hits = [...scores.entries()]
    .map(([id, score]) => ({ id, score }))
    .filter((h) => matchFilters(state.docs.get(h.id), filters))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return groupHits(hits, state);
}

// ---------------------------------------------------------------------------
// Snippets + highlighting

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function makeSnippet(text, tokens, radius = 90) {
  const lower = String(text).toLowerCase();
  let pos = -1;
  for (const tok of tokens || []) {
    if (!tok) continue;
    const i = lower.indexOf(String(tok).toLowerCase());
    if (i >= 0 && (pos === -1 || i < pos)) pos = i;
  }
  const start = pos === -1 ? 0 : Math.max(0, pos - radius);
  const end = Math.min(
    text.length,
    pos === -1 ? radius * 2 : Math.max(pos + radius, start + radius * 2)
  );
  return {
    text: text.slice(start, end),
    prefix: start > 0 ? '…' : '',
    suffix: end < text.length ? '…' : ''
  };
}

export function highlightHtml(text, tokens) {
  let html = escapeHtml(text);
  const parts = (tokens || [])
    .filter(Boolean)
    .map(escapeRe)
    .sort((a, b) => b.length - a.length);
  for (const tok of parts) {
    html = html.replace(new RegExp(`(${tok})`, 'gi'), '<mark>$1</mark>');
  }
  return html;
}

export { escapeHtml };
