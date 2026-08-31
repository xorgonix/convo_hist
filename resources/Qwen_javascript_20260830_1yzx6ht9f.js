chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "getChatList") {
        const offset = request.offset || 0;
        const limit = request.limit || 50;
        fetch(`/backend-api/conversations?offset=${offset}&limit=${limit}`, { credentials: 'include' })
        .then(res => res.json())
        .then(data => {
            const chats = data.items.map(item => ({
                id: item.id,
                title: item.title || "Untitled",
                update_time: item.update_time
            }));
            const hasMore = data.items.length === limit;
            sendResponse({ success: true, data: chats, hasMore: hasMore });
        })
        .catch(err => sendResponse({ success: false, error: err.message }));
        return true;
    }
    if (request.action === "getChatJson") {
        const chatId = request.chatId;
        fetch(`/backend-api/conversation/${chatId}`, { credentials: 'include' })
        .then(res => res.json())
        .then(data => {
            sendResponse({ success: true, data: data });
        })
        .catch(err => sendResponse({ success: false, error: err.message }));
        return true;
    }
});