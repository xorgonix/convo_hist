# Convo Hist — Video Walkthrough Script (User Guide Dialog)

This document is the narration/dialog for the six recorded videos. Each scene
matches one video file 1:1, so you can read along while watching — or use it
standalone as a step-by-step manual. Every instruction is something a new user
actually does.

---

## Video 1 — `01-first-run-and-folder-grant.mp4` (~9s)
**Scene: installing your attention — first launch + choosing the archive folder**

> NARRATOR: Welcome to Convo Hist — a local-first archive for your ChatGPT
> conversations. Everything you capture lives in a folder you own.
>
> Step 1. Click the Convo Hist icon — the side panel opens. In the top-left you
> can always see the build stamp (`v0.1.6-multiselect`). If it says
> "build: loading…", the panel is stale — close and reopen it.
>
> Step 2. Notice the conversation list filling in — the panel reads your
> ChatGPT conversation list directly (50 at a time). The status bar at the
> bottom reports progress: "50 of 120 conversations loaded."
>
> Step 3. Now the one-time setup: click **Choose folder…** in the top-right.
> Your browser asks which folder on disk may hold your archive — pick (or
> create) something like `D:\Vault\ChatGPT Archive`. This grant is remembered
> for next time. The button now shows your folder's name.
>
> That's the whole setup. From here, everything is one click.

---

## Video 2 — `02-capture-single.mp4` (~5s)
**Scene: your first capture — one conversation, saved forever**

> NARRATOR: To archive a single conversation, find it in the list and
> **double-click its row**.
>
> What happens: the panel fetches the full thread, converts it into a canonical
> JSON envelope plus a readable Markdown file, and writes both into your
> folder under `chats/<conversation title>.md/.json`. Indexes and the search
> index are refreshed in the same pass. The row gets a green **captured** badge
> so you can see at a glance what's already safe on disk.
>
> The status bar confirms it — "Saved chats/<title>.md + .json · indexes +
> search updated (1) · copied to clipboard." The Markdown copy is on your
> clipboard too, ready to paste anywhere.

---

## Video 3 — `03-multiselect-batch.mp4` (~15s)
**Scene: selecting many — checkboxes, Select all, Capture selected (n)**

> NARRATOR: When you want several at once, click a row once — that toggles its
> checkbox instead of capturing. The counter at the top says "2 selected", and
> the primary button becomes **Capture selected (2)**.
>
> Want everything that's loaded? Click **Select all**. The counter jumps and
> every row is checked. (If you've only loaded the first page, the
> **Load all** button next to it fetches every remaining page first.)
>
> Now click **Capture selected (n)**. The batch runs politely — one fetch at a
> time, with brief pauses — and anything already on disk with no changes is
> skipped automatically. Watch the status: "Batch done: 7 captured, 1
> unchanged, 0 failed · indexes + search updated (8)." In this video the
> Kubernetes thread was already captured, so the diff saved us the refetch.
>
> Selected checkboxes clear as items complete, and the buttons return to
> normal. Mid-batch, the right-hand button temporarily becomes **Stop** — click
> it once and the batch halts after the current fetch.

---

## Video 4 — `04-capture-all-and-diff-skip.mp4` (~5s)
**Scene: the one-button archive — Capture all, and why a second run is nearly free**

> NARRATOR: **Capture all** is the "just make everything safe" button. It
> crawls *every page* of your conversation list — not just what's loaded —
> then captures only what's new or changed since your last run.
>
> Here's the payoff: we click it a second time immediately. The archive on disk
> is already current, so the run reports "0 captured, 8 unchanged, 0 failed."
> Nothing was refetched. That's the diff-then-capture design: your archive is
> self-maintaining, and steady-state runs cost almost nothing.

---

## Video 5 — `05-search-and-filters.mp4` (~11s)
**Scene: finding things again — message-level search with filters and deep links**

> NARRATOR: The search box isn't a title filter — it searches **inside your
> captured messages**, with ranking, fuzzy matching, and highlighting.
>
> Try `hydration` — one result card: the Sourdough thread, with the exact
> message snippet and the hit highlighted. Cards show their tags as chips.
>
> Filters narrow by speaker and format: `code:` returns only conversations
> containing code blocks. `user: hydration` searches only your own messages;
> `assistant:` searches only replies. Combining works too.
>
> Misspelled queries still find things — try `kubrnetes`; one-edit fuzzy
> matching finds the Kubernetes thread.
>
> Every card has **Open in ChatGPT ↗** — one click returns you to the original
> thread. The archive never traps you; it's a doorway, not a copy-paste jail.

---

## Video 6 — `06-defect-orphan-cleanup.mp4` (~5s)
**Scene: when a conversation changes its name — the vault stays clean**

> NARRATOR: A note from testing: if a conversation is renamed on ChatGPT and
> you re-capture it, the archive should remove the old-named files so your
> folder never shows duplicates. During our browser-level verification we found
> that cleanup had silently stopped working, fixed it, and re-verified — this
> clip shows a title change re-capture leaving exactly one clean pair of files.
> This is why the suite exists: the software's promises get checked by a
> browser, not by hope.

---

## Quick reference card

| You want to… | Do this |
|---|---|
| Open the panel | Click the Convo Hist toolbar icon |
| Choose archive folder | Top-right **Choose folder…** (one-time grant) |
| See more conversations | **Load more** / **Load all** / **↻** to refresh |
| Capture one thread | Double-click its row |
| Capture a subset | Click rows to check them → **Capture selected (n)** |
| Capture everything | **Capture all** (crawls all pages; skips unchanged) |
| Stop a batch mid-run | The right-hand button says **Stop** while running |
| Search your archive | Type in the search box (try `code:`, `user:`, `assistant:`) |
| Open a thread on ChatGPT | **Open in ChatGPT ↗** on any result card |
| Regenerate indexes after manual edits | **Rebuild from disk** |

## Troubleshooting (what the status bar is telling you)

- **"List failed: HTTP 401/403 …"** → Your ChatGPT login expired. Open
  chatgpt.com, make sure you're logged in, then hit **↻** in the panel.
- **"No archive folder granted — click the folder button first."** → Grant the
  folder (top-right) before capturing.
- **"(clipboard blocked)"** → The Markdown copy still saved; only the
  clipboard step was denied. Re-run the single capture later if you want it.
- **"build: loading…" stuck in the header** → Stale panel; close and reopen it.
- **Rate-limited ("429")** → Wait a moment and retry; the archiver paces itself
  politely, but the upstream API can still throttle bursts.
