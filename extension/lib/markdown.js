// markdown.js — DERIVED VIEW renderer. Canonical data lives in the envelope
// JSON; this file only knows how to render one. Every message carries its
// absolute timestamp (locked requirement).

import { formatTimestamp } from './envelope.js';

function yamlString(s) {
  if (/[:#\[\]{}&*!|>'"%@`,\n]/.test(s)) return JSON.stringify(s);
  return s;
}

export function renderMarkdown(env) {
  const lines = [];

  lines.push('---');
  lines.push(`source: ${env.vendor}`);
  lines.push(`chat_id: "${env.id}"`);
  lines.push(`title: ${yamlString(env.title)}`);
  lines.push(`created: ${env.created || ''}`);
  lines.push(`updated: ${env.updated || ''}`);
  lines.push(`captured: ${env.captured_at}`);
  if (env.model) lines.push(`model: ${env.model}`);
  lines.push(`tags: [${(env.tags || []).join(', ')}]`);
  lines.push(`summary: ${env.summary ? yamlString(env.summary) : '""'}`);
  lines.push('---');
  lines.push('');
  lines.push(`# ${env.title}`);
  lines.push('');

  for (const t of env.turns) {
    lines.push(`## ${t.role.toUpperCase()} — ${formatTimestamp(t.timestamp)}`);
    lines.push('');
    lines.push(t.text);
    lines.push('');
  }

  return lines.join('\n');
}
