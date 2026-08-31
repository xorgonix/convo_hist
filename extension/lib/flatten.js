// flatten.js — generic conversation-tree primitives shared by vendor adapters.
// Vendor adapters own their specific tree shapes; these are the reusable parts.

export function extractText(content) {
  if (!content) return '';
  if (Array.isArray(content.parts)) {
    if (content.content_type === 'multimodal_text') {
      return content.parts
        .map((p) => (typeof p === 'string' ? p : (p && p.text) || ''))
        .join('\n')
        .trim();
    }
    return content.parts
      .filter((p) => typeof p === 'string' && p.length)
      .join('\n\n');
  }
  if (typeof content.text === 'string') return content.text;
  return '';
}

// Walk from the current leaf up to the root via parent links, then reverse:
// yields the mainline (the branch currently displayed) in chronological order.
export function mainlineFromMapping(mapping, currentNodeId) {
  const chain = [];
  const seen = new Set();
  let cur = currentNodeId;
  while (cur && mapping[cur] && !seen.has(cur)) {
    seen.add(cur);
    chain.push(mapping[cur]);
    cur = mapping[cur].parent;
  }
  return chain.reverse();
}

// Fallback when current_node is absent: latest-dated node carrying a message.
export function lastNodeWithMessage(mapping) {
  let best = null;
  let bestTime = -Infinity;
  for (const node of Object.values(mapping)) {
    if (!node || !node.message) continue;
    const t = node.message.create_time || 0;
    if (t >= bestTime) {
      bestTime = t;
      best = node;
    }
  }
  return best ? best.id : null;
}
