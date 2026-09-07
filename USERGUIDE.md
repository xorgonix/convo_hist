# Thread-O-matic — User Guide

A local-first ChatGPT conversation archiver. The **Conversarium** — a folder
of one JSON file per thread — is the source of truth. Every file lives in
**your own folders**, readable by any tool. No accounts, no servers, no
telemetry.

This guide covers **v0.6.0** (panel stamp `v0.6.0`).

---

## What you get

- **One JSON file per thread** in your Conversarium — the full, lossless
  source of truth
- **One Markdown file per thread** in your Vault folder (under `chats/`) —
  with YAML frontmatter, ready for Obsidian
- An optional **second output folder** (markdown or JSON) for backups
- **Search** across all Conversarium threads, with `user:` / `assistant:` /
  `code:` filters, fuzzy matching, and tag chips
- **Digest** — local summaries and tags written into the Conversarium JSON
  (on-device Gemini Nano, local Ollama / LM Studio, or the built-in
  extractive fallback)
- **Checkpointed, resumable Import** — a stopped or interrupted run continues
  exactly where it left off; already-saved threads are never refetched

---

## Install

1. Copy the `extension/` folder somewhere permanent.
2. Open `chrome://extensions` (or `edge://extensions`), enable **Developer
   mode**, click **Load unpacked**, and select the `extension/` folder.
3. Pin the "Thread-O-matic" icon and click it — the side panel opens.
4. Confirm the header shows `build: v0.6.0`. If it says "loading…", close
   and reopen the panel.

---

## First-time setup

Open **⚙ Settings** in the panel header. Set your folders:

| Folder | What lands there |
|---|---|
| **Conversarium** | One JSON file per thread: `threads/<Title> (<id>).json`. This is the source of truth. |
| **Vault** | Markdown exports: `chats/<Title> (<id>).md` — markdown only, never JSON. |
| **Second output (optional)** | Exports also copy here, as markdown or JSON — your choice. |

Use **Verify** next to each folder: it writes a small
`_thread_o_matic_here.txt` marker naming the folder's role, so you can
confirm in Explorer *exactly* which folder the extension is using. The
browser deliberately never reveals a folder's full path — this marker is the
trustworthy alternative. Delete the marker whenever you like.

Each folder row also has **Change folder** (always opens the picker, even
when a folder is set), **Reconnect** (restores access after the browser
drops it), and **Forget** (removes only the saved handle — it never deletes
the folder or any file in it).

---

## The workflow

```
IMPORT                        EXPORT (local only)
ChatGPT ──► Conversarium      Conversarium ──► Vault (markdown)
              JSON files                     (+ optional second folder)
```

- **Import** reads ChatGPT's thread list page by page and writes new or
  changed threads as JSON. The list reads only the Conversarium as it
  exists on disk.
- **Export** renders exactly what is in the Conversarium right now. It
  makes **no ChatGPT requests and never refreshes thread JSON**. Want the
  newest content? Run **Import first**, then Export.

---

## Daily use

### Import
- Nothing runs until you press **Import**. Opening the panel never contacts
  ChatGPT.
- **Bulk first-time seed (optional, network-free):** if you have ChatGPT's
  own "Export data" archive in Downloads, extract the zip and pick the
  enclosed `conversations.json` in **⚙ Settings → Seed from a ChatGPT
  export**. Every thread it contains is written straight into the
  Conversarium without a single ChatGPT request — no pacing, no rate
  limits. Afterwards, Import only fetches what changed since the export.
  Threads already in the Conversarium are skipped unless the export copy
  is newer.
- Import discovers the thread list page by page, then fetches only missing
  or newer threads, pacing itself politely.
- **Stop import** appears the moment an import starts and cancels
  immediately. The checkpoint is preserved:
  **Resume import** continues from the saved list page and skips every
  thread already written to disk — even after the panel closed, the browser
  restarted, or hours passed.
- If you see **Resume import**, an unfinished job exists. **Start new
  import** discards the checkpoint (never the imported files) and re-scans
  from scratch.

### The list is the Conversarium
- **A line in the panel means the JSON file exists in your Conversarium
  folder.** Nothing else is listed.
- **Click** a row: select it for Export. **Select all**: the checkbox at
  the top. **Double-click** a row: export just that thread (local only).
- **📄J** copies that thread's canonical JSON to the clipboard; **📄M**
  copies freshly-rendered markdown. Both read the local file only.
- **↻ Reload Conversarium** re-reads the folder from disk, so JSON files
  you added or moved by hand appear in the list. It never contacts ChatGPT.

### Export
- Click **Export**: exports *selected* threads, or *everything* in the
  Conversarium if nothing is selected.
- Markdown files land in `<Vault>\chats\` with frontmatter built from the
  thread's JSON:

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

- If the second output folder is configured, the same thread is copied
  there too, as markdown or JSON (Settings → format).

### Digest
- Click **Digest**: fills in a 2–3 sentence **summary** and 3–7 **tags**
  for every Conversarium thread that lacks them, written back into the
  thread's JSON.
- Backends, in order: **Gemini Nano** (built into Chrome) → **Ollama**
  (localhost:11434) → **LM Studio** (localhost:1234) → **extractive
  fallback** (built-in, no model needed). Configure the choice, Ollama URL
  and model in ⚙ Settings. The optional backends are contacted on
  **localhost only**, and only when configured/enabled.
- After digesting, run **Export** to refresh the vault markdown — then tag
  chips appear in search results too.

### Search
Type in the search box to search **inside** Conversarium threads:

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
<Conversarium>\              ← imported JSONs (source of truth)
    threads\<Title> (<id>).json

<Vault>\                     ← exports (markdown only, never JSON)
    chats\<Title> (<id>).md

<Browser>\                   ← tiny metadata only: settings + the import
                                checkpoint. No thread content is stored
                                in the browser, and the checkpoint never
                                contains access tokens.
```

Re-import is always possible while threads still exist in your ChatGPT
account — deleting the Conversarium is recoverable; deleting a ChatGPT
thread is not.

---

## Troubleshooting (what the status bar means)

| Message | What to do |
|---|---|
| `Import paused: 3 failures in a row` | ChatGPT rate-limited you. Press **Resume import**; pacing self-adjusts and honors the server's retry-after. |
| `Import paused — HTTP 401/403` | Session expired. Log in at chatgpt.com, then press **Resume import**. |
| `Conversarium: not set` | Choose a Conversarium folder — ⚙ Settings, or the button in the panel. |
| `… — access needed` | The browser dropped folder access. Click **Reconnect** (Settings, or the folder label in the panel). No files are affected. |
| `No vault folder granted` | Click 📁 in the panel header (or set it in Settings). |
| `This thread is not in the Conversarium` | Run **Import** first — Export and double-click only render local files. |
| `N files could not be read` | Those JSONs are damaged; details are listed in the panel. The files are left untouched — restore or delete them by hand. |
| `build: loading…` stuck | Stale panel — close and reopen it. |

---

## Privacy & data flow

- **Import** is the only operation that contacts ChatGPT, using your own
  logged-in session.
- **Export**, **Reload Conversarium**, and the row copy actions are local:
  no network requests at all.
- **Digest** never leaves your machine: it uses an on-device model or a
  localhost service you configured (Ollama / LM Studio), or a fully
  built-in extractive engine.
- No analytics, no accounts, no remote code, no uploads.

---

## For developers

- **Verification suite:** `browser-tests/` — Go/Rod end-to-end tests
  against a mocked ChatGPT API (24 acceptance cases, A-01–A-24). See
  `browser-tests/README.md` and `browser-tests/TEST_INVENTORY.md`.
- **Change specification:** `extension/SPECS/Thread-O-matic-v0.6.0-Extension-Change-Specification.md`.
- **Slides:** `slides/index.html` — reveal.js architecture walkthrough
  (open in a browser).
