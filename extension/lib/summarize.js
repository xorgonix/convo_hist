// summarize.js — M4 digest engine: produces {summary, tags} for a conversation.
//
// Backend chain (first available wins):
//   1. Gemini Nano — Chrome's built-in on-device model via the LanguageModel API
//   2. Ollama      — localhost:11434 (model auto-picked from /api/tags)
//   3. LM Studio   — localhost:1234 (OpenAI-compatible /v1/chat/completions)
//   4. Extractive fallback — TextRank-lite in pure JS: no model, no download,
//      deterministic. Not as fluent as an LLM, but the archive always gets a
//      summary and tags.
//
// Output contract: {summary: string, tags: string[], backend: string}

import { formatTimestamp } from './envelope.js';
import { getSettings } from './state.js';

const PROMPT_MAX_CHARS = 6000;
const BACKEND_TIMEOUT_MS = 25000;

// ---------------------------------------------------------------------------
// Backend detection (honors the settings window's choice)

export async function detectBackend() {
  const cfg = await getSettings().catch(() => ({}));
  const forced = cfg.summarizer || 'auto';

  // Test-hook (documented, APPROACH.md §6): e2e pages force the extractive
  // backend so digests are deterministic regardless of LLMs on the host.
  try {
    if (new URLSearchParams(location.search).has('e2e')) {
      return { kind: 'extractive', label: 'extractive fallback (e2e mode)' };
    }
  } catch { /* not a document context */ }

  if (forced === 'extractive') {
    return { kind: 'extractive', label: 'extractive (set in settings)' };
  }

  // 1. Gemini Nano (Prompt API for extensions)
  if (forced === 'auto' || forced === 'gemini') {
    try {
      if (typeof LanguageModel !== 'undefined' && LanguageModel.availability) {
        const av = await LanguageModel.availability();
        if (av === 'available' || av === 'downloadable') {
          return { kind: 'gemini', label: 'gemini-nano (on-device)' };
        }
      }
    } catch { /* API absent or gated — try the next backend */ }
  }

  // 2. Ollama — pick whatever model is installed (or the configured one)
  if (forced === 'auto' || forced === 'ollama') {
    try {
      const base = (cfg.ollamaUrl || 'http://localhost:11434').replace(/\/+$/, '');
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 1500);
      const res = await fetch(`${base}/api/tags`, { signal: ctrl.signal });
      clearTimeout(t);
      if (res.ok) {
        const data = await res.json();
        const model = (cfg.ollamaModel && String(cfg.ollamaModel).trim()) ||
          (data && data.models && data.models[0] && data.models[0].name);
        if (model) return { kind: 'ollama', model, base, label: `ollama/${model}` };
      }
    } catch { /* not running */ }
  }

  // 3. LM Studio
  if (forced === 'auto' || forced === 'lmstudio') {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 1500);
      const res = await fetch('http://localhost:1234/v1/models', { signal: ctrl.signal });
      clearTimeout(t);
      if (res.ok) return { kind: 'lmstudio', label: 'lmstudio (local)' };
    } catch { /* not running */ }
  }

  // 4. Always available
  return { kind: 'extractive', label: 'extractive fallback (no LLM found)' };
}

// ---------------------------------------------------------------------------
// Public entry: envelope turns -> {summary, tags, backend}

export async function digestTurns(env) {
  const backend = await detectBackend();
  const thread = renderThread(env);

  let out = null;
  try {
    if (backend.kind === 'extractive') {
      out = extractive(thread);
    } else {
      const raw = await llmComplete(backend, buildPrompt(thread));
      out = parseLlmJson(raw);
    }
  } catch (e) {
    // LLM path failed (model refused, timeout, bad JSON) — degrade, don't fail.
    console.warn(`[convo-hist] digest via ${backend.label} failed — using fallback: ${e && e.message}`);
    out = extractive(thread);
    backend.kind = 'extractive';
    backend.label += ' (fallback)';
  }

  return {
    summary: clamp(out.summary || '', 400),
    tags: normalizeTags(out.tags || []),
    backend: backend.label,
  };
}

// ---------------------------------------------------------------------------
// Prompt + parsing

function buildPrompt(thread) {
  return (
    'You are an archivist. Summarize the conversation in 2-3 plain sentences, ' +
    'and list 3-7 lowercase topical tags (single words or hyphenated, no spaces, no #). ' +
    'Reply with JSON only — no prose, no code fences — shaped like ' +
    '{"summary": "...", "tags": ["...", "..."]}.\n\n' +
    'CONVERSATION:\n' + thread
  );
}

function parseLlmJson(raw) {
  if (!raw) throw new Error('empty model response');
  let text = String(raw).trim();
  text = text.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  // First {...} block wins (models love to add chatter around the JSON).
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('no JSON in model response');
  const obj = JSON.parse(text.slice(start, end + 1));
  if (!obj || typeof obj.summary !== 'string') throw new Error('model JSON missing summary');
  return { summary: obj.summary, tags: Array.isArray(obj.tags) ? obj.tags : [] };
}

// ---------------------------------------------------------------------------
// LLM backends

async function llmComplete(backend, prompt) {
  switch (backend.kind) {
    case 'gemini': return geminiPrompt(prompt);
    case 'ollama': return ollamaGenerate(backend, prompt);
    case 'lmstudio': return lmStudioChat(prompt);
    default: throw new Error('no llm backend');
  }
}

async function withTimeout(promise, ms, what) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`${what} timed out`)), ms); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function geminiPrompt(prompt) {
  const session = await withTimeout(LanguageModel.create({
    temperature: 0.2,
    monitor(m) { m.addEventListener('downloadprogress', () => {}); },
  }), BACKEND_TIMEOUT_MS, 'gemini session');
  try {
    return await withTimeout(session.prompt(prompt), BACKEND_TIMEOUT_MS, 'gemini prompt');
  } finally {
    try { session.destroy(); } catch { /* already gone */ }
  }
}

async function ollamaGenerate(backend, prompt) {
  const base = (backend.base || 'http://localhost:11434').replace(/\/+$/, '');
  const res = await withTimeout(fetch(`${base}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: backend.model, prompt, stream: false, format: 'json' }),
  }), BACKEND_TIMEOUT_MS, 'ollama');
  if (!res.ok) throw new Error(`ollama HTTP ${res.status}`);
  const data = await res.json();
  return data && data.response;
}

async function lmStudioChat(prompt) {
  const res = await withTimeout(fetch('http://localhost:1234/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.2,
      max_tokens: 500,
    }),
  }), BACKEND_TIMEOUT_MS, 'lmstudio');
  if (!res.ok) throw new Error(`lmstudio HTTP ${res.status}`);
  const data = await res.json();
  return data && data.choices && data.choices[0] && data.choices[0].message &&
    data.choices[0].message.content;
}

// ---------------------------------------------------------------------------
// Extractive fallback — TextRank-lite: no model, pure scoring.

const STOPWORDS = new Set(('a,an,and,are,as,at,be,but,by,can,could,did,do,does,for,from,has,' +
  'have,how,i,in,is,it,its,just,like,me,my,not,of,on,or,our,so,some,than,that,the,their,them,' +
  'then,there,these,they,this,to,too,up,use,used,using,was,we,were,what,when,which,who,why,' +
  'will,with,would,you,your,about,after,also,any,because,been,before,being,between,both,did,' +
  'each,even,ever,first,get,got,here,him,how,into,let,make,many,more,much,need,now,only,over,' +
  'said,same,see,should,since,still,such,take,than,thats,thing,things,think,through,under,' +
  'very,want,way,well,went,whats,work,yeah,yes').split(','));

function terms(text) {
  return String(text).toLowerCase().match(/[a-z][a-z0-9+#.-]{2,}/g) || [];
}

function sentenceSplit(text) {
  return String(text)
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"'])/)
    .map((s) => s.trim())
    .filter((s) => s.length > 40 && s.length < 400);
}

function extractive(thread) {
  // Term weights: frequency over the whole thread, stopwords removed.
  const all = terms(thread).filter((t) => !STOPWORDS.has(t));
  const freq = new Map();
  for (const t of all) freq.set(t, (freq.get(t) || 0) + 1);

  // Summary: highest-scoring sentences, kept in original order.
  const paragraphs = thread.split('\n').filter(Boolean);
  const scored = [];
  paragraphs.forEach((line, idx) => {
    for (const s of sentenceSplit(line)) {
      const ts = terms(s).filter((t) => !STOPWORDS.has(t));
      if (!ts.length) continue;
      let score = 0;
      for (const t of ts) score += freq.get(t) || 0;
      score = score / Math.sqrt(ts.length); // length-normalized
      scored.push({ s, score, idx });
    }
  });
  scored.sort((a, b) => b.score - a.score);
  const summary = scored.slice(0, 2)
    .sort((a, b) => a.idx - b.idx)
    .map((x) => x.s)
    .join(' ') || 'Extractive digest unavailable for this conversation.';

  // Tags: top non-stopword terms, singularized crudely, title case left off.
  const tags = [...freq.entries()]
    .filter(([t]) => t.length >= 4 && !/^\d+$/.test(t))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([t]) => t.replace(/(ies)$/, 'y').replace(/(sses)$/, 'ss').replace(/s$/, ''))
    .filter((t, i, arr) => t.length >= 3 && arr.indexOf(t) === i)
    .slice(0, 4);

  return { summary, tags };
}

// ---------------------------------------------------------------------------
// Thread rendering + normalization

function renderThread(env) {
  const lines = [`TITLE: ${env.title}`];
  if (env.model) lines.push(`MODEL: ${env.model}`);
  lines.push('');
  let budget = PROMPT_MAX_CHARS;
  for (const t of env.turns || []) {
    if (budget <= 0) break;
    const text = t.text.length > 1200
      ? t.text.slice(0, 1200) + '…'
      : t.text;
    const line = `${t.role.toUpperCase()} — ${formatTimestamp(t.timestamp)}: ${text}`;
    lines.push(line);
    budget -= line.length;
  }
  return lines.join('\n').slice(0, PROMPT_MAX_CHARS);
}

function normalizeTags(tags) {
  const seen = new Set();
  const out = [];
  for (const raw of tags) {
    const t = String(raw).toLowerCase().trim()
      .replace(/^[#\s]+/, '')
      .replace(/[^\w-]+/g, '-')
      .replace(/^-+|-+$/g, '');
    if (t && t.length >= 2 && t.length <= 30 && !seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
    if (out.length >= 7) break;
  }
  return out;
}

function clamp(s, max) {
  const t = String(s).trim();
  return t.length > max ? t.slice(0, max - 1).trimEnd() + '…' : t;
}
