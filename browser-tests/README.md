# browser-tests — Rod-based browser verification for Convo Hist

Per `extension/SPECS/deprecated/APPROACH.md`. 25 tests: P0 smoke (4), P1 core journeys
(11), P2 edges (9), plus a recorded new-user journey that produces the
narrated walkthrough videos.

## Run

```powershell
cd browser-tests
go test -c -o e2e-run.exe .
.\e2e-run.exe -test.v -test.timeout 900s          # full suite + journey
.\e2e-run.exe -test.run TestP0 -test.v            # P0 only
$env:TEST_HEADED = "1"                            # optional visible watch mode
```

Requirements: Go, Chrome or Edge (Edge preferred — branded Chrome stable
ignores `--load-extension`, and Defender flags rod's leakless helper, so the
launcher runs browsers as plain children), ffmpeg + ffprobe for videos.

## How it works

- **One fresh browser per test** (fresh profile → fresh IndexedDB → no state bleed).
- **chatgpt.com is mapped to 127.0.0.1** (`--host-resolver-rules` +
  `--ignore-certificate-errors`) where a local TLS mock server serves every
  endpoint the extension touches — this covers BOTH the panel context and the
  background service worker (CDP hijacking can't intercept service-worker
  fetches). Faults (401, malformed payloads, delays) are set per-test via
  `mockState`.
- **File System Access is polyfilled in-memory** (`e2efs-polyfill.js`,
  injected before page scripts): faithful API surface, object identity across
  the IndexedDB round-trip, and deliberately NO `remove()` on file handles —
  the faithful omission that exposed the orphan-cleanup defect. Assertions
  inspect the fake archive via `window.__e2eFsSnapshot()`.
- **Videos:** CDP screencast frames → ffmpeg image2pipe → mp4; every frame is
  acked (required — Chrome stops sending after ~3 unacked frames); a 1×1 px
  2%-alpha rAF heartbeat keeps frames flowing during static pauses; each file
  is validated with ffprobe and its size/duration recorded.

## Layout

| File | Purpose |
|---|---|
| `main_test.go` | TestMain + all tests + journey + results/report writers |
| `helpers.go` | browser+extension lifecycle, waits, screenshots, console capture |
| `mockserver.go` | local TLS stand-in for chatgpt.com |
| `fixtures.go` | deterministic conversations/lists + fault injection |
| `recording.go` | screencast→ffmpeg recorder + ffprobe validation |
| `e2efs-polyfill.js` | in-memory File System Access + IndexedDB shim |
| `TEST_INVENTORY.md` | the pre-implementation test inventory (spec §1) |
| `USER_GUIDE_DIALOG.md` | narration matching the recorded videos |

## Artifacts

Each run writes `../test-artifacts/run-<id>/`: `results.json`, `report.md`,
`screenshots/`, `videos/`, `logs/` (per-test log incl. page console + JS
exceptions).
