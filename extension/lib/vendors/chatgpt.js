// vendors/chatgpt.js — the first vendor adapter.
// Contract: normalizeConversationSummary(listItem) -> {id,title,created,updated}
//           normalizeConversation(raw)       -> normalized conversation
// Normalized shape feeds buildEnvelope(); every turn carries its timestamp.

import { extractText, mainlineFromMapping, lastNodeWithMessage } from '../flatten.js';
import { toIso } from '../envelope.js';

export const VENDOR_ID = 'chatgpt';

export function matchesUrl(url) {
  return /https:\/\/(chat\.openai\.com|chatgpt\.com)\//.test(url || '');
}

export function normalizeConversationSummary(item) {
  return {
    id: item.id,
    title: item.title || 'Untitled',
    created: toIso(item.create_time),
    updated: toIso(item.update_time)
  };
}

function findModel(mapping) {
  for (const node of Object.values(mapping)) {
    const slug = node && node.message && node.message.metadata && node.message.metadata.model_slug;
    if (slug) return slug;
  }
  return null;
}

export function normalizeConversation(raw) {
  const mapping = raw.mapping || {};
  if (!Object.keys(mapping).length) {
    throw new Error('Conversation has no mapping (empty or unsupported payload)');
  }

  const leafId = raw.current_node || lastNodeWithMessage(mapping);
  const nodes = mainlineFromMapping(mapping, leafId);

  const turns = [];
  for (const node of nodes) {
    const msg = node && node.message;
    if (!msg) continue;
    const role = msg.author && msg.author.role;
    if (role !== 'user' && role !== 'assistant') continue;
    const text = extractText(msg.content).trim();
    if (!text) continue;
    turns.push({
      role,
      timestamp: toIso(msg.create_time),
      epoch: msg.create_time || null,
      text,
      has_code: /```/.test(text)
    });
  }

  if (!turns.length) {
    throw new Error('No user/assistant messages found in mainline walk');
  }

  return {
    vendor: VENDOR_ID,
    id: raw.conversation_id || raw.id || '',
    title: raw.title || 'Untitled',
    created: toIso(raw.create_time),
    updated: toIso(raw.update_time),
    model: findModel(mapping),
    turns,
    raw // untouched API response — preserved verbatim as the immutable source
  };
}
