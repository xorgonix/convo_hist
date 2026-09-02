// sw.js — background service worker: side-panel-on-click behavior + a
// proxy-fetch fallback for when direct fetches from the panel are blocked.

import { proxyFetch, BUILD } from '../lib/transport.js';

console.log(`[convo-hist ${BUILD}] service worker starting`);

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((e) => console.error('sidePanel.setPanelBehavior failed:', e));

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'convo:proxy-fetch') {
    // Request identity carried through for diagnostics; cancellation is
    // enforced on the caller side (apiGet never starts or consumes a proxy
    // round-trip after its signal aborted — R-07).
    console.log(`[convo-hist ${BUILD}] proxy-fetch ${msg.path}${msg.reqId ? ` (${msg.reqId})` : ''}`);
    proxyFetch(msg.path).then(sendResponse);
    return true; // async response
  }
  return false;
});
