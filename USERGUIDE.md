# Convo Hist — User Guide

A local-first ChatGPT conversation archiver. Every thread you download lives
in **your own folders**, as plain files you can open, edit, back up, and read
with any tool. No accounts, no servers, no telemetry — the only network the
extension touches is chatgpt.com, using your own logged-in browser session.

This guide covers **v0.5.0** (panel stamp `v0.5.0-clean`).

---

## What you get

- **One JSON file per thread** in your Library folder — the full, lossless
  source of truth (including the raw API payload)
- **One Markdown file per thread** in your Vault folder — with YAML
  frontmatter, ready for Obsidian
- An optional **second output folder** (markdown or JSON) for backups
- **Search** across all downloaded threads, with `user:` / `assistant:` /
  `code:` filters, fuzzy matching, and tag chips
- **Digest** — automatic summaries and tags via a local LLM (or a built-in
  extractive fallback that needs no model at all)

---

## Install

1. Download/copy the `extension/` folder somewhere permanent.
2. Open `chrome://extensions` (or `edge://extensions`), enable **Developer
   mode**, click **Load unpacked**, and select the `extension/` folder.
3. Pin the "Convo Hist" icon and click it — the side panel opens.
4. Confirm the header shows the current build stamp
   (`build: v0.5.0-clean`). If it says "loading…", close and reopen the panel.

---

## First-time setup (two folders)

Open **⚙ Settings** in the panel header. Set two folders:

| Folder | What lands there |
|---|---|
| **Library — downloaded thread JSON** | One file per thread: `threads/<Title> (<id>).json`. This is the source of truth. |
| **Vault / Obsidian (markdown only)** | One markdown file per thread on export, plus nothing else — never JSON. |
| **Second output folder (optional)** | Exports also copy here, as markdown or JSON — your choice. Useful for backups or non-Obsidian pipelines. |

**Use the "Test" button** next to each folder. It writes a small
`_convo_hist_here.txt` into that folder so you can open Explorer and confirm
*exactly* which folder the extension is using. (The browser's folder-picker
API cannot display full paths — this probe is the reliable way to know.)
Delete the marker file whenever you like.

Click **Done** to close Settings.

---

## The two-stage flow

```
STAGE 1 — DOWNLOAD (one button, runs automatically when the panel opens)
  ChatGPT ──► Library folder
  One thread = one JSON file. Only NEW and CHANGED threads are fetched;
  unchanged ones are skipped. Paced (0.4s), self-throttling when ChatGPT
  rate-limits (up to 8s), honors server "retry-after", resumable.

STAGE 2 — EXPORT (one button)
  Library ──► Vault (markdown) + optional second folder (md/json)
  Before writing, each thread is compared with ChatGPT's live list —
  stale ones are refreshed first. Pure local file writes, no network.
```

---

## Daily use

### Download
- Opens with the panel; you can also click **Download** anytime.
- While it runs: a progress bar shows `new/total`, and the status line names
  each thread. The button reads `⤓ i/N`.
- Big first run (thousands of threads) takes a while — pacing exists to keep
  ChatGPT happy. If it pauses (3 failures in a row), just press **Download**
  again to resume; everything already downloaded is safe.

### The list = the library
- **A line in the panel means the JSON file exists in your Library folder.**
  Nothing else is listed.
- **Click** a row: select it for export. **Select all**: the checkbox at the
  top. **Double-click** a row: export just that thread.
- **📄J** copies that thread's JSON to your clipboard; **📄M** copies
  freshly-rendered markdown. Both read the library file — nothing is fetched.
- **↻** re-reads the library folder (picks up files you moved in manually).

### Export
- Click **Export**: exports *selected* threads, or *everything* in the
  library if nothing is selected.
- Markdown files land in the Vault with frontmatter built from the JSON:

```yaml
---
source: chatgpt
chat_id: "6a113fa5-52b4-83ea-9453-6e3d1c6c7ac9"
title: Dialogue and Requirements Discovery
created: 2026-08-30T14:22:05.000Z
updated: 2026-08-31T09:12:44.000Z
captured: 2026-08-31T15:03:11.000Z
model: gpt-5.3
tags: [requirements, dialogue]
summary: "..."
---
```

- If the second output folder is configured, the same thread is copied there
  too, as markdown or JSON (Settings → format).

### Digest
- Click **Digest**: fills in a 2–3 sentence **summary** and 3–7 **tags** for
  every thread that lacks them, written into the library JSON.
- Backends, in order: **Gemini Nano** (built into Chrome) → **Ollama** →
  **LM Studio** → **extractive fallback** (built-in, no model needed).
  Configure the choice, Ollama URL and model in ⚙ Settings.
- After digesting, run **Export** to refresh the vault markdown — then tag
  chips appear in search results.

### Search
Type in the search box to search **inside** downloaded threads:

| Query | Meaning |
|---|---|
| `hydration` | any message containing it (fuzzy + prefix matching) |
| `code:` | only threads containing code blocks |
| `user: hydration` | only your own messages |
| `assistant: networkpolicy` | only assistant replies |

Result cards show tag chips (after Digest), snippets with the hit
highlighted, and an **Open in ChatGPT ↗** deep link back to the original
thread.

---

## What lives where

```
<Library folder>\            ← downloaded JSONs (source of truth)
    threads\<Title> (<id>).json

<Vault folder>\              ← exports (markdown only, never JSON)
    <Title> (<id>).md

<Browser>\                   ← tiny metadata only (cached list, settings)
                                No thread JSON is ever stored in the browser.
```

Re-download is always possible while the threads still exist in your ChatGPT
account — deleting the library is recoverable; deleting a ChatGPT thread is
not.

---

## Troubleshooting (what the status bar means)

| Message | What to do |
|---|---|
| `Download paused: 3 in a row failed` | ChatGPT rate-limited you. Press **Download** again to resume; pacing self-adjusts. |
| `Download stopped: HTTP 401/403` | Session expired. Log in at chatgpt.com, then **↻** and **Download**. |
| `library: not set — ⚙ Settings` | Pick the library folder in Settings. |
| `No vault folder granted` | Click 📁 in the panel header (or set it in Settings). |
| `build: loading…` stuck | Stale panel — close and reopen it. |
| Threads listed but files missing | Hit **↻** to re-read the library; re-**Download** to refetch. |

---

## Privacy & data flow

- Reads only chatgpt.com (your session), writes only the folders you granted.
- No analytics, no remote code, no accounts.
- The raw JSON stays on your disk; nothing is uploaded anywhere.

---

## For developers

- **Verification suite:** `browser-tests/` — Rod/Go end-to-end tests against
  a mocked ChatGPT API. See `browser-tests/README.md`.
- **Slides:** `slides/index.html` — reveal.js presentation covering the
  architecture (open in a browser).
- **Specs:** `extension/SPECS/APPROACH.md`.
