// Paste the raw JSON data into the 'rawData' variable below:
const rawData = PASTE_YOUR_JSON_HERE;
const flattened = [];

for (const key in rawData.mapping) {
    const node = rawData.mapping[key];
    if (node.message && node.message.content && node.message.content.parts) {
        const role = node.message.author.role;
        const unixTime = node.message.create_time;
        const text = node.message.content.parts.join('\n');
        const readableDate = new Date(unixTime * 1000).toLocaleString();
        
        flattened.push({
            time: unixTime, 
            readable_time: readableDate,
            role: role,
            text: text
        });
    }
}

flattened.sort((a, b) => a.time - b.time);

let output = `Conversation: ${rawData.title}\nExported: ${new Date().toLocaleString()}\n\n`;
flattened.forEach(msg => {
    output += `[${msg.readable_time}] ${msg.role.toUpperCase()}:\n${msg.text}\n\n---\n\n`;
});

const blob = new Blob([output], { type: 'text/plain' });
const url = URL.createObjectURL(blob);
const a = document.createElement('a');
a.href = url;
a.download = `${rawData.title.replace(/[^a-z0-9]/gi, '_')}_with_timestamps.txt`;
a.click();