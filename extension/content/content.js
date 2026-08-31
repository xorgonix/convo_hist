// content.js — TRANSPORT ONLY. Runs in the ChatGPT page origin so internal
// API calls ride the user's auth cookies. All normalization/processing
// happens in the sidepanel/lib layer. Never add business logic here.

let cachedToken = null;

async function getAuthToken() {
  if (cachedToken) return cachedToken;
  try {
    const res = await fetch('/api/auth/session', { credentials: 'include' });
    if (res.ok) {
      const data = await res.json();
      if (data && data.accessToken) {
        cachedToken = data.accessToken;
        return cachedToken;
      }
    }
  } catch (e) {
    // fall through — cookie-only requests may still work
  }
  return null;
}

async function apiGet(path) {
  const headers = { Accept: 'application/json' };
  const token = await getAuthToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(path, { credentials: 'include', headers });
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status} ${res.statusText} on ${path}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'ping') {
    sendResponse({ success: true });
    return false;
  }

  if (request.action === 'listConversations') {
    const offset = request.offset || 0;
    const limit = request.limit || 50;
    apiGet(`/backend-api/conversations?offset=${offset}&limit=${limit}`)
      .then((data) => sendResponse({ success: true, data }))
      .catch((err) =>
        sendResponse({ success: false, error: err.message, status: err.status })
      );
    return true; // async response
  }

  if (request.action === 'getConversation') {
    apiGet(`/backend-api/conversation/${request.chatId}`)
      .then((data) => sendResponse({ success: true, data }))
      .catch((err) =>
        sendResponse({ success: false, error: err.message, status: err.status })
      );
    return true; // async response
  }

  return false;
});
