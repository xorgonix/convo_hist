# Thread-O-matic v0.6.0 — Browser Test Inventory

Acceptance cases from the change specification §8 ("Required automated
acceptance cases"). Method: Go + Rod; fresh headed/headless browser per
test, extension loaded unpacked, chatgpt.com served by a local TLS mock
(panel AND service worker reach it), File System Access polyfilled
in-memory with three isolated roots.

(Supersedes the v0.1.6 capture/index inventory — the old suite described a
legacy product and could not validate the v0.5.x/0.6.0 panel.)

## Application map

- `sidepanel/sidepanel.html|js` — the UI. Renders the Conversarium (files
  on disk = the list), drives the import controller, export, digest.
- `lib/import-controller.js` — discovery → diff → detail import state
  machine, checkpointed after every page and every thread attempt.
- `lib/import-state.js` — versioned checkpoint schema (`stateVersion 2`),
  chrome.storage.local persistence.
- `lib/transport.js` — `GET /api/auth/session` (Bearer) →
  paged `GET /backend-api/conversations` and `GET /backend-api/conversation/{id}`;
  AbortSignal through everything; classified errors; Retry-After in both
  forms; service-worker fallback on direct-fetch failure.
- `lib/fsaccess.js` — split folder ops (get/reconnect/choose/forget)→
  Conversarium `threads/<Title> (<id8>).json`, Vault
  `chats/<Title> (<id8>).md`, secondary output; write-then-remove-old-name
  on title change; unreadable-file details on scans.
- `background/sw.js` — sidePanel-on-click + `convo:proxy-fetch` fallback
  (exercised only when direct fetch fails).

## Mock endpoints

| Pattern | Response |
|---|---|
| `chatgpt.com/api/auth/session` | `{accessToken:"e2e-token", user:{...}}` |
| `chatgpt.com/backend-api/conversations?offset&limit` | paged `{items, total}`; per-test faults: status code, 429 + `Retry-After`, page delay |
| `chatgpt.com/backend-api/conversation/{id}` | per-id mapping fixture; faults: 401, 404, malformed (`mapping:{}`), per-id delay; per-id title/update_time overrides |
| `chatgpt.com/c/*` | minimal "Mock ChatGPT" page (deep-link target) |

Fixture conversations: `conv-a` "Kubernetes Networking Deep Dive",
`conv-b` "Sourdough Starter Guide" (user asks about "hydration"),
`conv-c` "Go Context Cancellation", plus N generated `Test Conversation
XXX`. List update_time == conversation update_time so the disk diff is
deterministic.

## Test list — all 24 acceptance cases

| ID | Focus |
|---|---|
| A-01 | Panel open makes zero ChatGPT requests |
| A-02 | Thread-O-matic / Conversarium brand across panel, Settings, Help |
| A-03 | Fresh import discovers all pages, writes only Conversarium JSON |
| A-04 | First saved title appears before the import completes |
| A-05 | Progress bar and processed counter share one metric, every sample |
| A-06 | Stop usable during the first delayed list request; nothing starts after |
| A-07 | Resume discovery continues at the saved offset |
| A-08 | Resume detail import: no list call, no refetch of saved threads |
| A-09 | Crash after disk write healed by the disk diff |
| A-10 | 429 cooldown persists across panel reload |
| A-11 | 401 pauses with login guidance; job preserved |
| A-12 | 404 + malformed reported specifically; successes kept |
| A-13 | Change folder opens the picker despite a cached handle; cancel preserves |
| A-14 | Reconnect restores access; Forget removes only the handle |
| A-15 | Conversarium / Vault / secondary writes land in distinct roots |
| A-16 | Export: zero ChatGPT requests, renders exactly the local JSON |
| A-17 | Double-click export: zero ChatGPT requests |
| A-18 | Reload Conversarium: local-only, discovers manually added JSON |
| A-19 | Distinct empty / permission-needed / importing / no-hit states |
| A-20 | Message-level search survives imports, selection, reload |
| A-21 | Digest updates Conversarium JSON; Export emits summary/tags |
| A-22 | Title change: new JSON written, old same-name removed, others intact |
| A-23 | 390×844: actions, Stop, progress, status reachable, no overflow |
| A-24 | Manifest, build stamp, Help, report agree on v0.6.0 |

## Manual real-browser checks (not covered by the mocked suite)

Per spec §8 — recorded separately from this run:

1. Choose, change, reconnect, verify, and forget each real folder type.
2. Confirm cancellation leaves the prior folder configuration intact.
3. Import a small controlled ChatGPT account/set and confirm real disk JSON validity.
4. Stop and resume both list discovery and detail import.
5. Restart Chrome between pause and Resume and confirm no full recrawl.
6. Confirm a Vault in Obsidian renders the chosen output layout correctly.
7. Confirm optional Ollama and LM Studio Digest connections and explain
   their localhost traffic accurately.

## Known harness limits

- Native folder pickers and real disk bytes are out of reach for CDP; the
  polyfill + fake roots stand in (structure-enumerated, content-readable).
- Reload-after-grant uses real chrome.storage.local (survives), and the
  polyfilled IndexedDB shim (keeps handle identity within a page
  lifetime); a full browser-restart handle round-trip is manual case 5.
