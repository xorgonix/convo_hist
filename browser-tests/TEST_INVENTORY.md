# Convo Hist v0.1.6 — Browser Test Inventory

Method: Go + Rod per `SPECS/deprecated/APPROACH.md`. Chrome headed by default, real extension loaded
unpacked, network mocked at the CDP layer (chatgpt.com endpoints), archive filesystem
replaced by a faithful in-memory File System Access polyfill injected before page scripts.

## Application map (inspected, not inferred)

- `sidepanel/sidepanel.html|js` — the entire UI. Module script; builds list from
  `listConversations(offset, 50)`, captures via `getConversation(id)` → envelope → disk,
  search over archived envelopes, derived indexes.
- `lib/transport.js` — `GET /api/auth/session` (Bearer token) → `GET /backend-api/conversations?offset=&limit=`
  and `GET /backend-api/conversation/{id}`. Direct fetch; SW fallback only on direct failure.
- `lib/fsaccess.js` — showDirectoryPicker → handle cached in module var + IndexedDB
  (`convo-hist/kv/archiveHandle`). Writes `chats/<title> (<id8>).json|md`, `indexes/INDEX.md`,
  `indexes/timeline.md`, `indexes/<YYYY-MM>.md`, `indexes/tags/<slug>.md`. Orphan cleanup
  calls `handle.remove()` on file handles — **suspected defect** (API has no such method).
- `background/sw.js` — sidePanel-on-click + `convo:proxy-fetch` fallback. Not exercised
  when direct fetch succeeds (mock always succeeds → documented as untested path).
- `content/content.js` — message listeners for the ChatGPT page origin. Unused by the
  current direct transport (documented as untested).

## Mock endpoints

| Pattern | Response |
|---|---|
| `chatgpt.com/api/auth/session` | `{accessToken:"e2e-token", user:{...}}` |
| `chatgpt.com/backend-api/conversations?offset&limit` | paged `{items, total}` (fixture-controlled total) |
| `chatgpt.com/backend-api/conversation/{id}` | per-id mapping fixture (A/B/C rich, generic bodies), fault injection: 401 / malformed |
| `chatgpt.com/c/*` | minimal "Mock ChatGPT" page (deep-link target) |

Fixture conversations: `conv-a` "Kubernetes Networking Deep Dive" (code: `kubectl`),
`conv-b` "Sourdough Starter Guide" (user asks about "hydration"), `conv-c` "Go Context
Cancellation" (code: `context.TODO`), plus N generated `Test Conversation XXX` (2 turns,
no code). List update_time == conversation update_time → diff-skip works.

## Test list

### P0 — critical smoke (app is broken if these fail)
- **P0-01 First load**: stamp `v0.1.6-multiselect` in header; status Ready; folder label
  "Choose folder…"; capture disabled; Load more/Load all hidden before list.
- **P0-02 List loads (mocked)**: 50 items with titles+dates; status "50 of 120 conversations
  loaded"; Load more visible.
- **P0-03 Single capture (double-click row)**: fetch+write; row gains `captured` badge;
  status `Saved chats/<title> (<id8>).md + .json · indexes + search updated (1)`; fake FS
  contains `chats/*.json`, `chats/*.md`, `indexes/INDEX.md`, `indexes/timeline.md`, month file.
- **P0-04 Search shows results**: query "hydration" → card for conv-b with chips, snippet
  containing marked hit, "N hits" meta.

### P1 — core user journeys
- **P1-01 Load more**: click → 100 of 120; again → 120, Load more hides.
- **P1-02 Load all**: one click → all pages, status "120 conversations loaded (all pages)".
- **P1-03 Checkbox multi-select**: row clicks → "3 selected", button "Capture selected (3)"
  enabled; unchecking decrements.
- **P1-04 Select all semantics**: all checked ↔ checkbox checked; partial → indeterminate;
  row-click after select-all clears one at a time.
- **P1-05 Capture selected (n)**: batch runs paced; status
  "Batch done: 3 captured, 0 unchanged, 0 failed · indexes + search updated (3)."; badges;
  selection cleared; buttons restored.
- **P1-06 Diff-skip on re-capture**: Capture all twice (total=1) → second run
  "0 captured, 1 unchanged".
- **P1-07 Capture all crawl**: with only page 1 loaded, Capture all fetches remaining pages
  (total=8) and captures all 8 in one batch.
- **P1-08 Search filters**: `code:` → exactly the 2 code conversations; `user: hydration` →
  conv-b user turn only; `assistant: networkpolicy` → conv-a assistant; title-weighted
  "sourdough" → conv-b first; fuzzy "kubrnetes" (1 edit) → conv-a.
- **P1-09 Rebuild from disk**: after captures → "Indexes rebuilt: N files from M conversations".
- **P1-10 Open in ChatGPT deep link**: result card button opens tab `chatgpt.com/c/conv-a`
  (mock page), tab closes.
- **P1-11 Orphan cleanup on title change**: capture conv A (title X), change fixture title,
  re-capture → old `<old title>.json/md` gone, only new name remains.
  **Expected to FAIL — `handle.remove()` does not exist on file handles.** Record, fix
  (`removeEntry` on the chats dir), rerun; both results reported.

### P2 — edge cases and robustness
- **P2-01 401 during batch** (fault on 2nd conv): "Batch stopped: [api] HTTP 401…" error
  status, batch halts (not all 3 captured).
- **P2-02 401 on list load**: error notice + diag text in list, error status.
- **P2-03 Empty/no-match search**: "No matches in N archived conversations."; clearing
  query returns to list view.
- **P2-04 Search before folder grant**: "Archive not indexed yet." notice.
- **P2-05 Malformed conversation payload**: mapping {} → batch completes with
  "1 captured, 0 unchanged, 1 failed" (warn), other items captured.
- **P2-06 Stop mid-batch**: delayed fixture → click Stop → final status contains
  "(stopped early)" and fewer than total captured.
- **P2-07 No folder granted**: (page without FS polyfill) capture attempt →
  "No archive folder granted — click the folder button first."; folder button →
  "Folder error: …".
- **P2-08 Reload before grant**: reload → panel re-initializes cleanly (stamp, Ready).
  *Reload-after-grant is not automatable with the in-memory FS (real handles are
  structured-clone-safe; the fake is not) — documented harness limitation, not an app defect.*
- **P2-09 Narrow viewport 390x844**: controls visible/reachable, no horizontal overflow.

### Videos (new-user story, slow-motion, narrated dialog written to match)
1. `01-first-run-and-folder-grant.mp4` — open panel → stamp → list loads → grant folder
2. `02-capture-single.mp4` — first capture, badge, status, clipboard
3. `03-multiselect-batch.mp4` — checkboxes → select all → capture selected (n)
4. `04-capture-all-and-diff-skip.mp4` — capture all, then rerun → unchanged skip
5. `05-search-and-filters.mp4` — queries, filters, chips, deep link

## Known non-goals / harness limits
- Service-worker proxy fallback, content-script message path: unreachable with the happy
  session mock (would require forcing direct-fetch failure — brittle); reported untested.
- Real native folder picker, real disk writes: replaced by in-memory FS. UI-level evidence
  is identical; disk evidence is the fake tree (introspected via `self.__e2eFs`).
- Reload-after-grant: see P2-08 note.
- Headless mode: unsupported for this suite (MV3 extensions + File System Access need
  headed Chrome); APPROACH's headless option intentionally unavailable here.
