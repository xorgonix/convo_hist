(() => {
    const messages = [];
    const turns = document.querySelectorAll('[data-message-id]');
    turns.forEach(turn => {
        const roleElement = turn.querySelector('.font-semibold');
        const role = roleElement ? roleElement.textContent.trim().toLowerCase() : 'unknown';
        const contentElement = turn.querySelector('.markdown.prose');
        const content = contentElement ? contentElement.innerText.trim() : '';
        if (role !== 'unknown' && content) {
            messages.push({ role: role, content: content });
        }
    });
    const jsonOutput = JSON.stringify(messages, null, 2);
    console.log(jsonOutput);
    copy(jsonOutput);
    alert("Chat JSON copied to clipboard!");
})();