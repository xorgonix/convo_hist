import json
import os
from openai import OpenAI

# Initialize client (Use local Ollama or OpenAI API)
# client = OpenAI(base_url="http://localhost:11434/v1", api_key="ollama") # For local
client = OpenAI(api_key="YOUR_API_KEY_HERE") # For OpenAI

def extract_skeleton(raw_text, chat_title):
    prompt = f"""
You are an ontological normalization engine.
Analyze the following raw conversation excerpt. The user may have typos, rambling, or stream-of-consciousness phrasing.
Chat Title: "{chat_title}"
Raw Text:
{raw_text}

Your task:
1. SEMANTIC SKELETON: Distill the core meaning into 1-2 clean, canonical sentences. Remove conversational filler.
2. ONTOLOGY MAPPING: Assign this to a hierarchical path (e.g., Technology > Databases > Performance > Connection Pooling). Invent the path if needed, but keep it logical.
3. PROVENCE GUESS: Based on the text, state if this is a [User Hypothesis], [AI Suggestion], [Validated Fact], or [Unresolved Question].

Output strictly as JSON with keys: "skeleton", "ontology_path", "epistemic_status".
"""
    response = client.chat.completions.create(
        model="gpt-4o-mini", 
        messages=[{"role": "user", "content": prompt}],
        response_format={ "type": "json_object" }
    )
    return json.loads(response.choices[0].message.content)

def process_chat_file(filepath):
    with open(filepath, 'r', encoding='utf-8') as f:
        data = json.load(f)
    
    chat_title = data.get('title', 'Untitled Chat')
    messages = []
    
    mapping = data.get('mapping', {})
    for node_id, node_data in mapping.items():
        if 'message' in node_data and 'content' in node_data['message']:
            role = node_data['message']['author']['role']
            parts = node_data['message']['content'].get('parts', [])
            text = " ".join(parts).strip()
            create_time = node_data['message'].get('create_time', 0)
            
            if text and role in ['user', 'assistant']:
                messages.append({
                    'time': create_time,
                    'role': role,
                    'text': text
                })
                
    messages.sort(key=lambda x: x['time'])
    
    chunks = []
    for i in range(0, len(messages), 4):
        chunk_msgs = messages[i:i+4]
        chunk_text = "\n".join([f"[{m['role'].upper()}]: {m['text']}" for m in chunk_msgs])
        chunks.append(chunk_text)
        
    print(f"Processing '{chat_title}'... Found {len(chunks)} chunks.")
    
    results = []
    for i, chunk in enumerate(chunks):
        print(f"  Analyzing chunk {i+1}/{len(chunks)}...")
        try:
            skeleton_data = extract_skeleton(chunk, chat_title)
            results.append({
                "chunk_index": i,
                "raw_excerpt": chunk[:200] + "...", 
                "skeleton": skeleton_data.get("skeleton"),
                "ontology": skeleton_data.get("ontology_path"),
                "status": skeleton_data.get("epistemic_status")
            })
        except Exception as e:
            print(f"  Error on chunk {i}: {e}")
            
    return results

if __name__ == "__main__":
    target_file = "chatgpt_example.json"
    if os.path.exists(target_file):
        output = process_chat_file(target_file)
        with open("skeleton_output.json", "w", encoding="utf-8") as f:
            json.dump(output, f, indent=2)
        print("\nDone! Check 'skeleton_output.json' to see what the AI got wrong.")
    else:
        print(f"Please place a downloaded chat JSON file named '{target_file}' in this directory.")