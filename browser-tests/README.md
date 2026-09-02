# browser-tests — browser verification for Thread-O-matic

Automatic acceptance suite for the v0.6.0 change specification
(`extension/SPECS/Thread-O-matic-v0.6.0-Extension-Change-Specification.md`,
spec §8). 24 acceptance tests (A-01–A-24); each gets a fresh browser with
the real extension loaded and a mocked ChatGPT API.

## Run

```powershell
cd browser-tests
go test -c -o e2e-run.exe .
.\e2e-run.exe -test.v -test.timeout 900s          # full suite
.\e2e-run.exe -test.run TestA16 -test.v           # one acceptance case
$env:TEST_HEADED = "1"                            # optional visible watch mode
```

Requirements: Go, Chrome or Edge (Edge preferred — branded Chrome stable
ignores `--load-extension`, and Defender flags rod's leakless helper, so the
launcher runs browsers as plain children), ffmpeg + ffprobe for videos.

## How it works

- **One fresh browser per test** (fresh profile → fresh IndexedDB → no
  state bleed).
- **chatgpt.com is mapped to 127.0.0.1** (`--host-resolver-rules` +
  `--ignore-certificate-errors`) where a local TLS mock server serves every
  endpoint the extension touches — this covers BOTH the panel context and
  the background service worker (CDP hijacking can't intercept
  service-worker fetches). Faults (401/403/404/429, malformed payloads,
  delays) are set per-test via `mockState`.
- **File System Access is polyfilled in-memory** (`e2efs-polyfill.js`,
  injected before page scripts): three distinct fake roots keyed by picker
  id (`convo-library` / `convo-archive` / `convo-plain`), per-root
  permission states (`granted`/`prompt`/`denied`), picker invocation log,
  and object identity across the IndexedDB round-trip. Assertions inspect
  the fake trees via `window.__e2eFsSnapshot(root)`.
- **Expected version derives from the manifest** — no hard-coded release
  strings anywhere in the harness (R-15, A-24).

## Layout

| File | Purpose |
|---|---|
| `main_test.go` | TestMain + all 24 acceptance tests + results/report writers |
| `helpers.go` | browser+extension lifecycle, waits, screenshots, console capture |
| `mockserver.go` | local TLS stand-in for chatgpt.com |
| `fixtures.go` | deterministic conversations/lists + fault injection |
| `recording.go` | screencast→ffmpeg recorder + ffprobe validation |
| `e2efs-polyfill.js` | in-memory File System Access (3 roots) + IndexedDB shim |
| `TEST_INVENTORY.md` | the acceptance-case inventory with pass criteria |
| `USER_GUIDE_DIALOG.md` | narration matching the recorded videos |

## Artifacts

Each run writes `../test-artifacts/run-<id>/`: `results.json`, `report.md`,
`screenshots/`, `videos/`, `logs/` (per-test log incl. page console + JS
exceptions).
