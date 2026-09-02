# Thread-O-matic v0.6.0 — Browser Extension Change Specification

Status: implementation specification  
Target: the browser-extension source represented by the supplied v0.5.x source dump  
Product name: **Thread-O-matic**  
Local JSON collection: **the Conversarium**

## 1. Purpose

This change turns the current v0.5.x build into a coherent, user-controlled, genuinely resumable importer.

The central workflow must be understandable without knowing the implementation:

1. **Import** reads conversation metadata and conversation bodies from ChatGPT and writes one JSON file per thread into the Conversarium.
2. **Browse/Search** reads the JSON files that actually exist in the Conversarium.
3. **Digest** adds local summaries and tags to those JSON files.
4. **Export** converts Conversarium JSON into Markdown or JSON in user-selected output folders. Export is local and makes no ChatGPT requests.

The product is expected to grow beyond this release. The implementation must therefore separate source discovery, resumable import, local collection management, processing, and export instead of continuing to place all workflow state in `sidepanel.js`.

## 2. Evidence reviewed

This specification was derived from:

- the full user/coding-agent discussion in `Pasted text(20260902-053326).txt`;
- the concatenated source and browser-test dump in `6d78adde-8fa8-4944-b5f3-0aad3cc69174.txt`;
- the v0.5.0 user guide in `1785894b-08b1-4ab0-ac65-561e6b5f4fa5.md`.

The actual repository must also be checked before editing. The supplied guide refers to `extension/SPECS/APPROACH.md` and `browser-tests/README.md`, but neither appears as a file section in the supplied source dump. If they exist in the repository, update them to agree with this specification.

## 3. Current-state findings

### 3.1 Release contents are internally inconsistent

The supplied snapshot contains several generations of the product at once:

| Area | Version/behaviour found |
| --- | --- |
| Manifest | `0.5.3`, product name “Convo Hist” |
| Runtime build stamp | `v0.5.3-coach` |
| Side-panel comments and user guide | v0.5.0 library-first workflow |
| Browser-test header/report | v0.1.6 capture/index workflow |
| Test helper expected build | `v0.4.0-library` |
| Tests | Expect ChatGPT-list rows, Capture buttons, `chats/*.json`, generated indexes, and controls absent from the current panel |

The existing test report cannot be taken as evidence that the supplied v0.5.3 extension works. Much of the suite describes an older product.

### 3.2 Confirmed causes of the reported behaviour

| Reported issue | Source-level cause |
| --- | --- |
| Progress bar and numeric label disagree | Bar width uses processed items (`i + 1`); label uses successful writes (`downloaded`). |
| No titles appear in the panel during import | Successful writes do not update `libraryEnvs`; the entire folder is reread only after the loop ends. Early returns on auth or three failures skip that final reread. |
| Stop is confusing/unavailable | Import and Digest relabel the **Export** button as `Stop`; cancellation is not represented by a dedicated, consistently located control. Network requests also do not receive the job cancellation signal. |
| Restart is slow and repeats list work | Every call to `downloadAll()` invokes `fetchAllSummaries()` from offset zero. `saveList()` exists but is not called, cached list state is not loaded into the workflow, and no import checkpoint exists. |
| Folder cannot be changed reliably | Each `get*Handle({interactive:true})` returns its cached or stored handle before invoking `showDirectoryPicker()`. The Settings “Choose folder” button therefore commonly returns the existing folder instead of choosing another. `forget*Handle()` functions exist but are not wired to the UI. |
| “(re-grant)” is cryptic and not actionable | Permission state is rendered as text; the label itself has no reconnect handler. |
| Empty/search state is misleading | Several empty conditions share generic messages, and view rendering is split between title-only `renderList()` and message-level `renderResults()`. |
| Export freshness promise is unreliable | Export compares against the in-memory `conversations` array, but that array is empty until a scan occurs in the same panel lifetime; the stored list cache is ignored. |
| “Export is local” contradicts docs/code | The docs call Export a pure local operation while also promising ChatGPT refreshes; the source may fetch stale conversations during Export. Both cannot be true. |

### 3.3 Architectural debris that must be reconciled

- `lib/store.js` describes browser storage as the raw-thread archive of record, contradicting the newer rule that disk JSON is the source of truth. It appears unused by the current panel.
- `lib/indexes.js`, `readArchiveEnvelopes()`, `writeDerivedViews()`, and several `fsaccess.js` comments describe the older combined archive/index design.
- `content/content.js` is injected by the manifest but is not used by the current direct transport. The browser-test report explicitly calls this path unexercised.
- The current filesystem test double returns the same fake directory for every picker, so it cannot prove that Conversarium, Vault, and secondary-output files remain isolated.
- The guide says Vault Markdown is written directly under the chosen Vault folder, while `writeArchiveFile()` writes under a `chats/` subdirectory. This must be resolved and documented before release.

## 4. Product and terminology decisions

These decisions are part of the v0.6.0 target and are not optional copy edits.

| Concept | Required user-facing term |
| --- | --- |
| Product | Thread-O-matic |
| Folder containing canonical thread JSON | Conversarium |
| ChatGPT → Conversarium | Import |
| Conversarium → Vault/other output | Export |
| Re-read local JSON files | Reload Conversarium |
| Restore access to a previously chosen folder | Reconnect |
| Select a different folder | Change folder |
| Remove the saved handle without deleting files | Forget folder |

Do not use “Download” for the primary workflow. Do not use “Library” as the proper name for the JSON collection in user-facing text. It may remain as an internal programming term where renaming would risk data compatibility.

### Compatibility names that must not be casually renamed

The following are storage/protocol identifiers, not branding:

- IndexedDB database name `convo-hist`;
- existing handle keys such as `libraryHandle` and `archiveHandle`;
- envelope schema identifier `convo-hist-envelope/1`;
- existing JSON files and user-selected directory names.

Keep them for backward compatibility unless a tested migration is explicitly added. Branding changes must not make existing handles or Conversarium files disappear.

## 5. Required behavioural changes

### R-01 — No surprise network work

Opening the side panel must:

- read the selected Conversarium from disk;
- rebuild the in-memory search view;
- display any unfinished import checkpoint;
- make **zero** ChatGPT API calls until the user presses **Import** or **Resume import**.

Remove the unconditional `downloadAll()` call from initialization. An opt-in automatic-import setting may be added in a later release, but it is out of scope for v0.6.0.

### R-02 — Use a durable import job, not a cache-age guess

A paused or interrupted import must resume the same job. It must not start discovery again at offset zero merely because the panel closed, the browser restarted, or several hours elapsed.

There is no six-hour or 24-hour expiry for an unfinished job. Time-based freshness and resumability are separate concerns:

- **Resume import** continues the unfinished checkpoint.
- **Start new import** creates a new discovery run after the previous job completed or was explicitly discarded.

### R-03 — Checkpoint both discovery and thread import

Persist a checkpoint after every successfully received list page and after every completed thread attempt.

Minimum persisted shape (names may vary, semantics may not):

```js
{
  stateVersion: 2,
  chatgptList: {
    items: [{ id, title, created, updated }],
    expectedTotal: 2535,
    nextOffset: 150,
    complete: false,
    startedAt: "...",
    completedAt: null,
    accountKey: "opaque-account-key"
  },
  importJob: {
    jobId: "...",
    state: "discovering", // discovering|importing|paused|stopped|completed
    targetIds: [],
    attemptedIds: [],
    failures: [{ id, title, category, message, attempts }],
    counters: { processed: 0, saved: 0, failed: 0, unchanged: 0 },
    pacing: { delayMs: 400, nextAllowedAt: null, consecutiveTransientFailures: 0 },
    pauseReason: null,
    updatedAt: "..."
  }
}
```

Requirements:

- If stopped during list discovery, Resume continues at `nextOffset` and preserves already collected summaries.
- If stopped during detail import, Resume uses the completed list snapshot and does not call the list endpoint again.
- Before resuming detail work, compare target IDs with files on disk. A file written immediately before a crash must be recognized and not fetched again.
- Failed or never-attempted targets remain eligible on Resume.
- A completed import checkpoint may be retained for diagnostics, but the main action returns to **Import**.
- Cache/checkpoint state must be scoped to the currently authenticated ChatGPT account. If the account changes, do not apply the old list/diff to the new account; ask the user whether to discard the old unfinished job.
- Do not store access tokens in the checkpoint.

### R-04 — Define a fresh import precisely

When no unfinished job exists and the user presses **Import**:

1. Confirm Conversarium access.
2. Create and persist a new job in `discovering` state.
3. Read ChatGPT’s conversation list from offset zero, one page at a time.
4. Persist each complete page and its next offset.
5. Finish discovery when the API’s total has been collected or a short/empty page proves completion.
6. Diff the completed summary set against the on-disk Conversarium by conversation ID and updated timestamp.
7. Import only missing or newer threads.
8. Finish with a full local reconciliation and a clear result summary.

The current silent `100 * BATCH` truncation is unacceptable. A safety limit may exist, but reaching it must pause with an explicit diagnostic rather than reporting a complete scan.

### R-05 — Live Conversarium updates

After `writeLibraryThread(env)` succeeds:

- upsert that envelope into the in-memory collection by ID;
- keep the collection sorted by updated/created time;
- update the visible count;
- make the title appear in the panel without waiting for the whole import;
- update the search index on a throttled schedule and once definitively at job end.

For large imports, batch DOM rendering (for example, no more than four renders per second). Do not reread and reparse thousands of files after every item.

Any exit path—completed, manually stopped, authentication failure, circuit-breaker pause, unexpected exception—must perform a final in-memory/disk reconciliation before returning the UI to idle.

### R-06 — One progress model everywhere

The determinate bar, its label, button text, status line, and final summary must use the same counters.

For detail import:

```text
Importing from ChatGPT
Processed 36 of 2,535 · Saved 34 · Failed 2
Current: <thread title>
```

Rules:

- `processed = saved + failed` for attempted targets in the current job;
- the bar width is `processed / targets`;
- skipped/unchanged is reported separately and is not silently mixed into the target denominator;
- the main Conversarium count means files successfully read from disk, not API rows found;
- discovery uses its own wording, such as `Reading ChatGPT thread list · 150 of 2,535 found`;
- never label a list-page scan merely “crawling conversation list.”

### R-07 — Dedicated, immediate cancellation

Add one dedicated **Stop** control for long-running Import, Export, or Digest jobs.

- It becomes visible and enabled immediately when the job state is set, before the first list/detail request.
- It identifies the operation: `Stop import`, `Stop export`, or `Stop digest` through visible text or an adjacent operation label.
- Do not relabel the Export button to stop an Import or Digest.
- Pass a shared `AbortSignal` through `listConversations()`, `getConversation()`, transport fetches, retry waits, and pacing waits.
- An intentional abort is not a failure and must not increment circuit-breaker counters.
- On stop, preserve the checkpoint and show `Import stopped — 34 saved, 2 failed, 2,499 remaining. Resume import when ready.`
- A stopped job performs no additional API request after the in-flight abort settles.

### R-08 — Error classification and polite pacing

Keep request concurrency at one for ChatGPT’s internal endpoints.

Handle errors by category:

| Category | Required behaviour |
| --- | --- |
| 401/403 | Stop and retain checkpoint; instruct user to log in and Resume. |
| 429 | Honor `Retry-After`, back off with bounded jitter, persist `delayMs` and `nextAllowedAt`, and do not reset to 400 ms merely because the panel reopened. |
| 5xx/network/timeout | Retry a bounded number of times with backoff, then retain the item as failed. |
| 404/deleted thread | Mark as unavailable for this run; continue without treating it as a rate-limit event. |
| malformed payload | Record the thread ID/title and reason; continue; include it in the final failure summary. |
| intentional abort | Stop cleanly; do not count as failure. |

Parse `Retry-After` in both delta-seconds and HTTP-date forms. Do not hide all operational failures behind bare `catch` blocks. Expected cleanup errors may remain best-effort, but unexpected exceptions must be logged with operation and thread ID.

### R-09 — Export is local and predictable

For v0.6.0, Export must read only from the Conversarium and write only to the chosen output folders. It must make no ChatGPT request and must not silently refresh source JSON.

This resolves the current contradiction between “diff-before-export” and “pure local writes.” The freshness rule becomes:

> Import updates the Conversarium. Export renders exactly what is currently in the Conversarium.

If users want the newest ChatGPT content, the UI/help tells them to run Import first. A future combined “Import then Export” command may orchestrate both explicit stages, but it is not part of v0.6.0.

Double-clicking a Conversarium row must export that local thread only. It must not fetch ChatGPT.

### R-10 — Folder selection, reconnection, and replacement

Replace the overloaded `get*Handle({interactive})` design with separate operations:

- `getCurrent*Handle()` — return a currently usable stored handle without opening UI;
- `reconnect*Handle()` — request permission on the stored handle from a user gesture;
- `choose*Handle()` — always open `showDirectoryPicker()` to select a folder, even when one is already configured;
- `forget*Handle()` — remove only the saved handle; never delete folder contents.

The picker contract:

- Use a stable, distinct picker `id` for Conversarium, Vault, and secondary output.
- When supported, pass the existing handle as `startIn` when changing a folder.
- Persist the new handle only after the user successfully selects it.
- Cancelling a picker preserves the prior configuration.

Settings must give each folder row these actions:

- **Choose folder** when unset, otherwise **Change folder**;
- **Reconnect** only when permission is needed;
- **Verify** to write a branded marker file;
- **Forget** to clear the handle without touching files.

Replace `(re-grant)` with plain language, for example:

```text
Conversarium: chatgpt_threads — access needed
[Reconnect]
```

The browser deliberately does not expose a full filesystem path. Do not present an editable fake path field. Explain this beside the folder controls, not only in Help.

### R-11 — Distinct empty and permission states

Render these states separately:

| Condition | Required message/action |
| --- | --- |
| No Conversarium selected | `Choose a Conversarium folder to begin.` + Settings/Choose action |
| Saved handle needs permission | `Reconnect “<name>” to read your Conversarium.` + Reconnect action |
| Accessible but empty | `The Conversarium is empty. Press Import to bring in ChatGPT threads.` |
| Import running, none written yet | `Import is running. Threads will appear here as they are saved.` |
| Search query has no hits | `No Conversarium threads match “<query>”.` |
| Files were unreadable | Show readable count plus `N files could not be read`; expose details without requiring DevTools. |

Do not say “No matches” when no search is active.

### R-12 — Preserve the active view correctly

Create a single `renderCurrentView()` decision point:

- empty query → Conversarium list;
- non-empty query → message-level search results;
- folder/permission/empty conditions → their explicit state panels.

Selection changes, live imports, and job completion must call `renderCurrentView()`, not fall back to the title-only filter in `renderList()`. This prevents the current split behaviour where some rerenders can replace message-level results with a title-only list.

### R-13 — Tooltips and accessible names

Every icon-only or abbreviated control must have:

- an `aria-label`;
- a useful `title` tooltip;
- an unambiguous label in Help.

Minimum tooltip meanings:

| Control | Tooltip meaning |
| --- | --- |
| Import | Read ChatGPT and save new or changed threads as JSON in the Conversarium. |
| Export | Convert selected Conversarium threads—or all if none are selected—to the configured output folders. No ChatGPT access. |
| Digest | Add a local summary and tags to Conversarium threads that do not have them. Export afterwards to refresh derived files. |
| Reload Conversarium | Re-read the local Conversarium folder. This does not contact ChatGPT. |
| JSON copy | Copy this Conversarium thread’s canonical JSON. |
| Markdown copy | Render this Conversarium thread as Markdown and copy it. |
| Settings | Choose folders and configure local digest backends. |
| Help | Explain Import, Conversarium, Digest, Export, permissions, and recovery. |

Native `title` bubbles are acceptable for v0.6.0, but essential meaning must not exist only in hover text.

### R-14 — Brand sweep with migration safety

Change user-facing text in:

- `manifest.json` name, description, and action title;
- side-panel title, header, coach, buttons, statuses, empty states, and tooltips;
- Settings and Help page titles/content;
- verification-marker filename/content;
- user guide, architecture slides, test names/reports, and developer docs.

Recommended marker: `_thread_o_matic_here.txt`, with contents that name the configured role (Conversarium, Vault, or secondary output). Do not delete the old `_convo_hist_here.txt` marker automatically.

### R-15 — Version coherence

Use one authoritative runtime version source. Prefer `chrome.runtime.getManifest().version` for the release number, optionally combined with a generated commit/build identifier.

For the v0.6.0 release, all of the following must agree:

- manifest version;
- visible build stamp;
- Help and User Guide version;
- browser-test expectations and generated report title;
- architecture slides if shipped.

No release may combine v0.1.6 tests, v0.5.0 docs, and a v0.5.3 runtime stamp as the supplied snapshot does.

## 6. Recommended internal structure

The exact filenames may vary, but responsibilities must be separated.

```text
sidepanel/sidepanel.js       UI wiring and view rendering only
lib/import-controller.js    job state machine, discovery, diff, resume, counters
lib/import-state.js         checkpoint schema, migration, persistence
lib/transport.js            cancellable ChatGPT requests and classified errors
lib/fsaccess.js             folder handles and atomic file operations
lib/conversarium.js         disk scan, ID/update map, in-memory upsert/reconciliation
lib/export.js               local-only rendering/writes
lib/summarize.js            digest operation
```

Use an explicit operation state machine instead of the single `bulkRunning`/`bulkAbort` pair:

```text
idle
  ├─ importing.discovering
  ├─ importing.details
  ├─ exporting
  └─ digesting

any running state ──Stop──> stopping ──checkpoint/reconcile──> paused or idle
```

Only one long-running operation may run at a time. The UI derives enabled/disabled controls from the state; individual functions must not independently relabel unrelated buttons.

## 7. File-by-file implementation map

### `extension/manifest.json`

- Rename user-facing product fields to Thread-O-matic.
- Set version to 0.6.0 at release.
- Reassess and remove unused permissions/hosts only after dependency tests.
- If the unused content-script transport is removed, remove its manifest registration too.
- Do not remove localhost permissions still required by configured Digest backends.

### `extension/sidepanel/sidepanel.html`

- Rename brand and controls.
- Add a dedicated Stop control and an operation/phase label.
- Keep stable element IDs or update all current tests in the same commit.
- Add accessible labels and local-vs-network wording.

### `extension/sidepanel/sidepanel.css`

- Style distinct empty/error/permission/job states.
- Ensure the action row remains usable at 390 px width.
- Ensure long titles/statuses wrap or truncate without hiding Stop.

### `extension/sidepanel/sidepanel.js`

- Remove import auto-start.
- Move import orchestration into an import controller.
- Replace `bulkRunning`/`bulkAbort` button mutation with the operation state machine.
- Live-upsert successful imports and throttle renders.
- Use `renderCurrentView()`.
- Make Export and row double-click local-only.
- Render exact counters and all exit states.

### `extension/lib/state.js`

- Add a versioned state migration.
- Persist list discovery and import checkpoints.
- Persist pacing/cooldown state.
- Remove or replace unused `saveList`, `saveDiffMap`, and `setDiffEntry` APIs so there is one state model.
- Keep browser state rebuildable; canonical conversation content remains on disk.

### `extension/lib/transport.js`

- Accept an `AbortSignal` in list/detail calls.
- Compose caller cancellation with request timeout.
- Classify status/network errors.
- Parse both legal forms of `Retry-After`.
- Return enough session identity to scope a checkpoint without storing the token.
- Ensure service-worker fallback does not turn cancellation into a second request.

### `extension/background/sw.js`

- Carry cancellation/request identity through proxy fetch if the fallback remains.
- Update logs/brand where user-visible diagnostics depend on them.

### `extension/lib/fsaccess.js`

- Split get/reconnect/choose/forget operations.
- Add distinct picker IDs and safe `startIn` behaviour.
- Preserve the prior handle on picker cancel.
- Keep write-then-remove-old-name order for title changes.
- Return unreadable-file details from scans rather than only a count.
- Resolve the Vault-root versus `chats/` output decision described in Section 10.
- Remove stale comments that claim browser storage is the raw source of truth.

### `extension/settings/settings.html` and `settings.js`

- Add Change, Reconnect, Verify, and Forget actions for each folder.
- Show `access needed` rather than `(re-grant)`.
- Explain why only the folder name—not its full path—is visible.
- Ensure clicking Change always opens the native folder picker.

### `extension/help/*`, User Guide, and slides

- Apply the terminology table.
- Remove import auto-run claims.
- Explain checkpointed Resume.
- State that Reload Conversarium and Export are local.
- Remove the contradictory diff-before-export promise.
- Accurately disclose optional localhost Digest connections.

### Dead or legacy code

Run a dependency/import scan. If unreferenced:

- remove `lib/store.js` from the packaged source because it contradicts the current data-ownership model;
- remove or relocate the old index-generation module and unused archive-rebuild functions;
- remove the unused content script and its manifest registration.

Preserve history in version control; do not retain misleading dead modules merely as undocumented future placeholders.

## 8. Test-suite replacement requirements

The current Go/Rod suite is not a valid regression suite for the supplied v0.5.3 UI. Rewrite its expectations around the Conversarium-first workflow.

### Test harness changes

- Model three distinct fake directory roots keyed by picker ID.
- Model folder permission states: `granted`, `prompt`, and `denied`.
- Preserve fake IndexedDB and extension local storage across a simulated panel reload.
- Record every API request with endpoint, offset/thread ID, timestamp, response, and cancellation.
- Support delayed list pages and detail calls.
- Support 401, 403, 404, 429 with both Retry-After forms, 5xx, timeout, and malformed payloads.
- Make expected product version derive from the manifest rather than a hard-coded v0.4.0 string.

### Required automated acceptance cases

| ID  | Acceptance case |
| --- | --- |
| A-01 | Panel opens, reads Conversarium, and makes zero ChatGPT requests. |
| A-02 | Brand reads Thread-O-matic and canonical JSON folder is called Conversarium everywhere visible. |
| A-03 | Initial Import discovers all pages, imports missing threads, and writes only Conversarium JSON. |
| A-04 | The first saved title appears before the import completes. |
| A-05 | At every sampled point, bar width and processed counter represent the same numerator/denominator. |
| A-06 | Stop is usable during the first delayed list request and no later request starts. |
| A-07 | Resume during discovery starts at the saved next offset; earlier pages are not rerequested. |
| A-08 | Resume during detail import makes no list request and does not refetch files already written. |
| A-09 | A crash after disk write but before checkpoint update is healed by the disk diff. |
| A-10 | 429 pacing/cooldown survives panel reload; Resume does not reset immediately to 400 ms. |
| A-11 | 401/403 pauses with login guidance and preserves the job. |
| A-12 | Malformed/404 items are reported specifically and do not erase successful work. |
| A-13 | Clicking Change folder opens the picker despite an existing cached handle; cancel preserves the old handle. |
| A-14 | Reconnect restores access; Forget removes only the handle and deletes no files. |
| A-15 | Conversarium, Vault, and secondary-output writes land in distinct fake roots. |
| A-16 | Export makes zero ChatGPT requests and renders exactly the local JSON version. |
| A-17 | Double-click export makes zero ChatGPT requests. |
| A-18 | Reload Conversarium makes zero ChatGPT requests and discovers manually added local JSON. |
| A-19 | Empty, permission-needed, importing-empty, and no-search-hit states show distinct messages. |
| A-20 | Message-level search remains active while new imports arrive or selections change. |
| A-21 | Digest updates Conversarium JSON; subsequent Export emits updated summary/tags. |
| A-22 | A title change writes the new JSON and removes the old same-ID filename without touching unrelated files. |
| A-23 | At 390×844 all primary actions, Stop, progress, and status remain reachable without horizontal overflow. |
| A-24 | Manifest, build stamp, Help, guide, and generated test report agree on v0.6.0. |

### Manual acceptance cases

These require real Chromium/Windows behaviour and must be recorded separately from mocked E2E results:

1. Choose, change, reconnect, verify, and forget each real folder type.
2. Confirm cancellation leaves prior folder configuration intact.
3. Import a small controlled ChatGPT account/set and confirm real disk JSON validity.
4. Stop and resume both list discovery and detail import.
5. Restart Chrome between pause and Resume and confirm no full recrawl.
6. Confirm a Vault in Obsidian renders the chosen output layout correctly.
7. Confirm optional Ollama and LM Studio Digest connections and explain their localhost traffic accurately.

The release report must distinguish automated mock coverage from real-account/manual coverage. It must not state “nothing prevents release” solely because the old capture/index suite passes.

## 9. Migration and data-safety rules

- Never delete or rewrite an existing Conversarium merely because the brand changed.
- Preserve existing folder handles and settings through a state migration.
- New checkpoints are rebuildable metadata; JSON files remain canonical.
- An import overwrites a thread only after a complete payload is normalized successfully.
- On title change, write the new file successfully before deleting the old same-ID file.
- Forgetting a folder handle never deletes that folder or any file.
- Discarding an unfinished import deletes only checkpoint/cache metadata, not imported JSON.
- If a stored JSON is unreadable, report it and leave it untouched.
- Do not claim a thread is safely imported until the writable stream closes successfully.

## 10. One repository decision to resolve before coding Export layout

The supplied sources disagree on Vault placement:

- User Guide: `<Vault>/<Title> (<id>).md`
- Current `writeArchiveFile()`: `<Vault>/chats/<Title> (<id>).md`
- Help/tests: largely expect the older `chats/` layout

Recommended v0.6.0 decision: **preserve the current `chats/` subdirectory for existing users**, document it truthfully, and postpone any layout migration until it can be offered as an explicit setting with a preview. Silently moving hundreds or thousands of existing Markdown files is outside this change.

The coding agent must confirm the real repository’s latest intended layout before implementation. If the intended target is Vault root, add a migration/compatibility plan and tests; do not simply change the path.

## 11. Explicitly deferred work

The following ideas are compatible with the architecture but are not part of v0.6.0:

- incremental “newest pages only” discovery;
- periodic full reconciliation and deletion detection;
- scheduled/background imports;
- automatic Digest during Import;
- the local Go service / localhost:8080;
- SurrealDB, vector search, semantic graphs, related-thread discovery, and Obsidian plugins;
- multi-vendor imports;
- share/send-to-friends destinations;
- a custom filesystem browser (Chromium does not expose full paths, and the native picker remains authoritative).

Do not implement these while fixing the reliability/UI foundation. Leave clear extension points rather than placeholder controls.

## 12. Delivery sequence

### Phase 0 — Baseline coherence

1. Inspect the real repository and recover missing `APPROACH.md`/test README if present.
2. Identify dead modules and actual import graph.
3. Replace hard-coded version expectations.
4. Update the fake filesystem to separate folder roots and permissions.

Exit criterion: the test suite demonstrably targets the current Conversarium-first UI, even if new acceptance tests initially fail.

### Phase 1 — Filesystem and terminology

1. Implement choose/reconnect/change/forget semantics.
2. Apply Thread-O-matic/Conversarium user-facing names.
3. Add distinct empty and permission states.
4. Remove automatic import on panel open.

Exit criterion: A-01, A-02, A-13 through A-15, A-19, and A-24 pass.

### Phase 2 — Import controller and resume

1. Add cancellable transport.
2. Add versioned checkpoint schema and migration.
3. Implement discovery checkpoint/resume.
4. Implement target diff and detail checkpoint/resume.
5. Persist pacing and classified failures.

Exit criterion: A-03 and A-06 through A-12 pass.

### Phase 3 — Live UI and progress

1. Add live in-memory upsert and throttled rendering.
2. Unify progress counters.
3. Add dedicated operation Stop control.
4. Centralize view rendering and tooltips.

Exit criterion: A-04, A-05, A-20, and A-23 pass.

### Phase 4 — Local-only Export and regression closure

1. Remove network refreshes from Export and row double-click.
2. Confirm Digest-to-Export flow.
3. Reverify title-change cleanup and data safety.
4. Update Help, User Guide, slides, and release report.
5. Run automated suite and the manual real-browser checklist.

Exit criterion: A-16 through A-18, A-21, A-22, all P0/P1 tests, and required manual cases pass.

## 13. Definition of done

v0.6.0 is done only when all of the following are true:

- The panel never contacts ChatGPT merely because it opened.
- An interrupted import resumes without rereading completed list pages or refetching successfully written threads.
- Stop is visible immediately, cancels the active operation, and never masquerades as Export.
- Titles appear as files land in the Conversarium.
- Progress counters cannot disagree by construction.
- A user can change, reconnect, verify, and forget every configured folder.
- User-facing copy consistently says Thread-O-matic, Conversarium, Import, Digest, and Export.
- Export and Reload Conversarium are provably local-only.
- Existing JSON, folder handles, and schema identity survive the upgrade.
- The actual test suite, docs, manifest, and build stamp all describe the same release and behaviour.
- The delivery includes a concise change log, list of touched files, automated test results, manual-test results, and any known limitations.

## 14. Coding-agent handoff instruction

Implement this as a reliability release, not a string-replacement patch. Begin by reporting:

1. the actual repository files and versions found;
2. any conflict between this specification and newer repository documentation;
3. the proposed file-by-file edit list;
4. the state-migration approach;
5. the tests that will be made to fail first and then pass.

Do not start feature work beyond Section 11’s deferrals. Do not declare completion from the legacy test report. Completion requires the v0.6.0 acceptance cases and the real-folder/manual checks above.