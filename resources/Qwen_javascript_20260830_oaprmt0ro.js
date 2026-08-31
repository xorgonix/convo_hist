let selectedChatId = null;
let currentOffset = 0;
const batchSize = 50;
let hasMoreChats = true;
let masterChatList = []; 
let offlineIndexMap = null; 

document.addEventListener('DOMContentLoaded', () => {
    chrome.tabs.query({active: true, currentWindow: true}, (tabs) => {
        const tab = tabs[0];
        if (tab && (tab.url.includes('chatgpt.com') || tab.url.includes('chat.openai.com'))) {
            fetchChats(0, false);
        } else {
            document.getElementById('chat-list').innerHTML = '<p style="padding:10px; color:red;">Please open chatgpt.com first.</p>';
        }
    });

    document.getElementById('download-btn').addEventListener('click', downloadJson);
    document.getElementById('load-more-btn').addEventListener('click', () => {
        if (hasMoreChats) {
            currentOffset += batchSize;
            fetchChats(currentOffset, true);
        }
    });
    document.getElementById('export-index-btn').addEventListener('click', exportIndex);
    document.getElementById('load-index-btn').addEventListener('click', () => {
        document.getElementById('file-input').click();
    });
    document.getElementById('file-input').addEventListener('change', handleFileUpload);
});

function fetchChats(offset, append) {
    const loadMoreBtn = document.getElementById('load-more-btn');
    if (append) {
        loadMoreBtn.disabled = true;
        loadMoreBtn.textContent = "Loading...";
    }
    chrome.tabs.query({active: true, currentWindow: true}, (tabs) => {
        chrome.tabs.sendMessage(tabs[0].id, {
            action: "getChatList",
            offset: offset,
            limit: batchSize
        }, (response) => {
            if (chrome.runtime.lastError || !response || !response.success) {
                if (!append) document.getElementById('chat-list').innerHTML = '<p style="padding:10px; color:red;">Failed to load.</p>';
            } else {
                if (!append) masterChatList = [];
                masterChatList = masterChatList.concat(response.data);
                renderChatList(response.data, append);
                hasMoreChats = response.hasMore;
                if (hasMoreChats) {
                    loadMoreBtn.style.display = 'block';
                    loadMoreBtn.disabled = false;
                    loadMoreBtn.textContent = "Load More Conversations";
                } else {
                    loadMoreBtn.style.display = 'none';
                }
            }
        });
    });
}

function renderChatList(chats, append = false) {
    const listEl = document.getElementById('chat-list');
    if (!append) listEl.innerHTML = '';
    chats.forEach(chat => {
        const div = document.createElement('div');
        div.className = 'chat-item';
        div.dataset.id = chat.id;
        div.dataset.updateTime = chat.update_time;
        
        let isUpdated = false;
        if (offlineIndexMap && offlineIndexMap[chat.id]) {
            const offlineTime = offlineIndexMap[chat.id];
            if (chat.update_time > offlineTime) isUpdated = true;
        }
        if (isUpdated) div.classList.add('updated');

        const titleSpan = document.createElement('span');
        titleSpan.textContent = chat.title;
        div.appendChild(titleSpan);

        if (isUpdated) {
            const badge = document.createElement('span');
            badge.className = 'badge';
            badge.textContent = 'UPDATED';
            div.appendChild(badge);
        }
        div.addEventListener('click', () => selectChat(div, chat.id));
        div.addEventListener('dblclick', () => {
            selectChat(div, chat.id);
            downloadJson();
        });
        listEl.appendChild(div);
    });
}

function selectChat(element, chatId) {
    document.querySelectorAll('.chat-item').forEach(el => el.classList.remove('selected'));
    element.classList.add('selected');
    selectedChatId = chatId;
    document.getElementById('download-btn').disabled = false;
}

function downloadJson() {
    if (!selectedChatId) return;
    chrome.tabs.query({active: true, currentWindow: true}, (tabs) => {
        chrome.tabs.sendMessage(tabs[0].id, { action: "getChatJson", chatId: selectedChatId }, (response) => {
            if (response && response.success) {
                const jsonStr = JSON.stringify(response.data, null, 2);
                const blob = new Blob([jsonStr], { type: 'application/json' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `chatgpt_${selectedChatId}.json`;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(url);
                const status = document.getElementById('status');
                status.style.display = 'block';
                setTimeout(() => status.style.display = 'none', 2000);
            } else {
                alert('Failed to fetch chat JSON.');
            }
        });
    });
}

function exportIndex() {
    if (masterChatList.length === 0) {
        alert("No chats loaded yet. Click 'Load More' if you need to fetch your full history first.");
        return;
    }
    const indexData = {};
    masterChatList.forEach(chat => {
        indexData[chat.id] = chat.update_time;
    });
    const jsonStr = JSON.stringify(indexData, null, 2);
    const blob = new Blob([jsonStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const dateStr = new Date().toISOString().split('T')[0];
    a.download = `chatgpt_index_${dateStr}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    alert("Index exported! Keep this file safe. Next time, load it to see what changed.");
}

function handleFileUpload(event) {
    const file = event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = function(e) {
        try {
            offlineIndexMap = JSON.parse(e.target.result);
            alert(`Loaded offline index! Found ${Object.keys(offlineIndexMap).length} saved chats. Checking for updates...`);
            renderChatList(masterChatList, false);
        } catch (err) {
            alert("Error reading file. Make sure it's a valid JSON index file.");
        }
    };
    reader.readAsText(file);
    event.target.value = '';
}