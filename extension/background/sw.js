// sw.js — background service worker: side-panel-on-click behavior + a
// proxy-fetch fallback for when direct fetches from the panel are blocked.

import { proxyFetch, BUILD } from '../lib/transport.js';

console.log(`[convo-hist ${BUILD}] service worker starting`);

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((e) => console.error('sidePanel.setPanelBehavior failed:', e));

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'convo:proxy-fetch') {
    proxyFetch(msg.path).then(sendResponse);
    return true; // async response
  }
  return false;
});
