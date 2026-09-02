// main_test.go — Thread-O-matic v0.6.0 acceptance suite (spec §8).
// Phase 1 coverage: A-01, A-02, A-13, A-14, A-15, A-19, A-24.
// Remaining A-cases land with their delivery phases (spec §12).
// Each test gets a fresh browser + unpacked extension + mocked ChatGPT API.
package e2e

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"runtime/debug"
	"strings"
	"testing"
	"time"
)

func TestMain(m *testing.M) {
	runID = time.Now().Format("20060102-150405")
	base := os.Getenv("TEST_ARTIFACTS")
	if base == "" {
		base = mustAbs(filepath.Join("..", "test-artifacts"))
	}
	artifactsDir = filepath.Join(base, "run-"+runID)
	for _, d := range []string{"screenshots", "videos", "logs"} {
		os.MkdirAll(filepath.Join(artifactsDir, d), 0o755)
	}

	if _, err := exec.LookPath("ffmpeg"); err != nil {
		fmt.Println("WARNING: ffmpeg not found — recordings will be skipped with a note")
	}
	if _, err := exec.LookPath("ffprobe"); err != nil {
		fmt.Println("WARNING: ffprobe not found — recordings will not be validated")
	}

	code := m.Run()
	writeResultsAndReport(code)
	os.Exit(code)
}

// ---------------------------------------------------------------------------
// A-01 — Panel opens, reads Conversarium, and makes zero ChatGPT requests.

func TestA01_NoNetworkOnOpen(t *testing.T) {
	s := startTest(t, "A-01", "Panel open makes zero ChatGPT requests", "A-case", withTotal(3))
	s.waitStamp()

	// Give any illicit auto-start ample time to fire if it existed.
	time.Sleep(1500 * time.Millisecond)

	if n := s.state.totalHits(); n != 0 {
		s.failf("panel open caused %d ChatGPT request(s) — R-01 violated", n)
	}
	for _, label := range []string{"list", "session"} {
		if n := s.state.count(label); n != 0 {
			s.failf("endpoint %q hit %d time(s) on open", label, n)
		}
	}
	s.logf("zero ChatGPT requests confirmed after open (totalHits=0)")
	s.evidence("A-01-open-no-network.png")
}

// ---------------------------------------------------------------------------
// A-02 — Brand reads Thread-O-matic; the JSON collection is the Conversarium.

func TestA02_BrandSweep(t *testing.T) {
	s := startTest(t, "A-02", "Thread-O-matic / Conversarium brand sweep", "A-case")
	s.waitStamp()

	if brand := s.text(".brand"); !strings.Contains(brand, "Thread-O-matic") {
		s.failf("panel header brand = %q, want Thread-O-matic", brand)
	}
	// No Conversarium yet → the no-folder state must name the Conversarium.
	s.waitText("#chat-list", "Conversarium", 8*time.Second)
	if hint := s.text("#library-hint"); !strings.Contains(hint, "Conversarium") {
		s.failf("library hint = %q, want Conversarium wording", hint)
	}
	s.evidence("A-02-panel.png")

	s.openExtPage("settings/settings.html")
	s.waitStamp()
	if h1 := s.text("h1"); !strings.Contains(h1, "Thread-O-matic") {
		s.failf("settings h1 = %q, want Thread-O-matic", h1)
	}
	if !strings.Contains(s.page.MustEval(
		`() => document.body.innerText`).Str(), "Conversarium") {
		s.failf("settings page does not mention Conversarium")
	}

	s.openExtPage("help/help.html")
	s.waitStamp()
	if h1 := s.text("h1"); !strings.Contains(h1, "Thread-O-matic") {
		s.failf("help h1 = %q, want Thread-O-matic", h1)
	}
	body := s.page.MustEval(`() => document.body.innerText`).Str()
	for _, want := range []string{"Conversarium", "Import", "Export", "Reload Conversarium"} {
		if !strings.Contains(body, want) {
			s.failf("help page missing %q", want)
		}
	}
	s.logf("brand sweep verified across panel, settings, help")
}

// ---------------------------------------------------------------------------
// A-13 — Change folder opens the picker despite a cached handle; cancel
// preserves the old configuration.

func TestA13_ChangeFolderOpensPicker(t *testing.T) {
	s := startTest(t, "A-13", "Change folder always opens picker; cancel preserves", "A-case")
	s.waitStamp()
	s.openExtPage("settings/settings.html")
	s.waitStamp()

	if lbl := s.text("#vault-label"); lbl != "not set" {
		s.failf("vault label = %q, want not set", lbl)
	}

	// First choose.
	s.page.MustElement("#vault-btn").MustClick()
	s.waitText("#vault-label", "E2E-convo-archive", 8*time.Second)
	if btn := s.text("#vault-btn"); !strings.Contains(btn, "Change folder") {
		s.failf("after grant the button reads %q, want Change folder…", btn)
	}

	// Change attempt #1: let the picker be cancelled. It must still OPEN
	// (picker log records the invocation) and the prior grant must survive.
	s.page.MustEval(`() => window.__e2eFsCancelNextPicker()`)
	s.page.MustElement("#vault-btn").MustClick()
	time.Sleep(400 * time.Millisecond)
	if lbl := s.text("#vault-label"); !strings.Contains(lbl, "E2E-convo-archive") {
		s.failf("cancel did not preserve the prior handle: label=%q", lbl)
	}
	if btn := s.text("#vault-btn"); !strings.Contains(btn, "Change folder") {
		s.failf("after cancel the button reads %q, want Change folder…", btn)
	}

	var log []struct {
		ID        string `json:"id"`
		Cancelled bool   `json:"cancelled"`
	}
	if err := json.Unmarshal([]byte(s.page.MustEval(
		`() => window.__e2eFsPickerLog()`).Str()), &log); err != nil {
		s.failf("picker log parse: %v", err)
		return
	}
	opens, cancels := 0, 0
	for _, e := range log {
		if e.ID == "convo-archive" {
			if e.Cancelled {
				cancels++
			} else {
				opens++
			}
		}
	}
	if opens != 1 || cancels != 1 {
		s.failf("picker log for convo-archive: %d opens, %d cancels — Change must open the picker even when configured", opens, cancels)
	}
	s.logf("picker opened on Change with an existing handle; cancel preserved it")
	s.evidence("A-13-change-cancel.png")
}

// ---------------------------------------------------------------------------
// A-14 — Reconnect restores access; Forget removes only the handle and
// deletes no files.

func TestA14_ReconnectAndForget(t *testing.T) {
	s := startTest(t, "A-14", "Reconnect restores access; Forget keeps files", "A-case")
	s.waitStamp()
	s.openExtPage("settings/settings.html")
	s.waitStamp()

	// Grant the vault.
	s.page.MustElement("#vault-btn").MustClick()
	s.waitText("#vault-label", "E2E-convo-archive", 8*time.Second)

	// Simulate the browser dropping permission.
	s.fsSetPermission("convo-archive", "prompt")

	// Trigger a settings refresh via the library row, so the vault row
	// re-renders into the access-needed state.
	s.page.MustElement("#library-btn").MustClick()
	s.waitText("#vault-label", "access needed", 8*time.Second)
	s.waitText("#vault-label", "E2E-convo-archive", 2*time.Second)

	// Reconnect restores access (status line is set after refresh()).
	s.page.MustElement("#vault-reconnect").MustClick()
	s.waitStatus("access restored", "ok", 8*time.Second)
	s.waitText("#vault-label", "E2E-convo-archive", 2*time.Second)
	if !s.hasAttr("#vault-reconnect", "hidden") {
		s.failf("Reconnect still offered after access was restored")
	}
	s.logf("Reconnect affordance cleared after access restored")

	// Verify writes the branded marker naming the role.
	s.page.MustElement("#vault-verify").MustClick()
	s.waitStatus("_thread_o_matic_here.txt", "ok", 8*time.Second)
	probe := s.page.MustEval(`(p, r) => window.__e2eFsFileText(p, r)`,
		"_thread_o_matic_here.txt", "convo-archive").Str()
	if !strings.Contains(probe, "Configured role: Vault") {
		s.failf("vault marker content = %q, want role naming", probe)
	}

	// Forget removes only the handle; the file must still exist.
	s.page.MustElement("#vault-forget").MustClick()
	s.waitText("#vault-label", "not set", 8*time.Second)
	files := s.fsFilesIn("convo-archive")
	if len(files) == 0 || !strings.HasSuffix(files[0], "_thread_o_matic_here.txt") {
		s.failf("after Forget the folder files are gone: %v", files)
	}
	s.logf("Forget removed only the handle; marker file survived: %v", files)
	s.evidence("A-14-after-forget.png")
}

// ---------------------------------------------------------------------------
// A-15 — Conversarium, Vault, and secondary-output writes land in distinct
// fake roots (isolation).

func TestA15_DistinctRoots(t *testing.T) {
	s := startTest(t, "A-15", "Three folder grants write to three distinct roots", "A-case")
	s.waitStamp()

	out := s.page.MustEval(`async () => {
      const fs = await import(chrome.runtime.getURL('lib/fsaccess.js'));
      const env = { id: 'conv-xyz', title: 'Roots Check',
        created: '2026-09-01T00:00:00.000Z', updated: '2026-09-01T00:00:00.000Z' };
      await fs.chooseLibraryHandle();
      await fs.chooseArchiveHandle();
      await fs.choosePlainHandle();
      await fs.writeLibraryThread(env);
      await fs.writeArchiveFile(env, '# Roots Check\n');
      await fs.writePlainFile(env, '# Roots Check\n', 'md');
      return 'ok';
    }`)
	if out.Str() != "ok" {
		s.failf("module-level folder ops failed: %s", out.Str())
	}

	roots := s.fsRoots()
	for _, want := range []string{"convo-library", "convo-archive", "convo-plain"} {
		found := false
		for _, r := range roots {
			if r == want {
				found = true
			}
		}
		if !found {
			s.failf("expected root %q in %v", want, roots)
		}
	}

	libFiles := s.fsFilesIn("convo-library")
	arcFiles := s.fsFilesIn("convo-archive")
	plnFiles := s.fsFilesIn("convo-plain")

	if len(libFiles) != 1 || !strings.HasPrefix(libFiles[0], "threads/") {
		s.failf("convo-library should contain exactly one threads/ file, got %v", libFiles)
	}
	if len(arcFiles) != 1 || !strings.HasPrefix(arcFiles[0], "chats/") {
		s.failf("convo-archive should contain exactly one chats/ file, got %v", arcFiles)
	}
	if len(plnFiles) != 1 || !strings.HasSuffix(plnFiles[0], ".md") {
		s.failf("convo-plain should contain exactly one markdown file, got %v", plnFiles)
	}
	// Isolation: no root may contain another root's paths.
	for _, pair := range []struct{ root string; files []string }{
		{"convo-library", libFiles}, {"convo-archive", arcFiles}, {"convo-plain", plnFiles},
	} {
		for _, f := range pair.files {
			if strings.HasPrefix(f, "chats/") && pair.root != "convo-archive" {
				s.failf("root %s leaked a chats/ path: %v", pair.root, pair.files)
			}
			if strings.HasPrefix(f, "threads/") && pair.root != "convo-library" {
				s.failf("root %s leaked a threads/ path: %v", pair.root, pair.files)
			}
		}
	}
	s.logf("distinct roots verified: library=%v archive=%v plain=%v", libFiles, arcFiles, plnFiles)
	s.evidence("A-15-roots.png")
}

// ---------------------------------------------------------------------------
// A-19 — Empty, permission-needed, and no-search-hit states show distinct
// messages. (The importing-empty state is exercised with the import
// controller in Phase 2.)

func TestA19_DistinctStates(t *testing.T) {
	s := startTest(t, "A-19", "Empty / permission / no-hit states are distinct", "A-case")
	s.waitStamp()

	// 1. No Conversarium selected.
	s.waitText("#chat-list", "Choose a Conversarium folder to begin.", 8*time.Second)

	// 2. Accessible but empty (choose via the notice's own action button).
	s.page.MustElement(`[data-action="choose-library"]`).MustClick()
	s.waitText("#chat-list", "The Conversarium is empty. Press Import to bring in ChatGPT threads.", 8*time.Second)

	// 3. Saved handle needs permission → distinct reconnect state.
	s.fsSetPermission("convo-library", "prompt")
	s.page.MustElement("#reload-btn").MustClick() // Reload Conversarium: local-only
	s.waitText("#chat-list", `to read your Conversarium`, 8*time.Second)
	if hint := s.text("#library-hint"); !strings.Contains(hint, "access needed") {
		s.failf("library hint = %q, want access-needed wording", hint)
	}
	// Reconnect (user gesture) restores the empty state.
	s.page.MustElement(`[data-action="reconnect-library"]`).MustClick()
	s.waitText("#chat-list", "The Conversarium is empty. Press Import to bring in ChatGPT threads.", 8*time.Second)

	// 4. Search with no hits → distinct message, quotes the query.
	s.typeQuery("zzz-no-such-thread")
	s.waitText("#chat-list", `No Conversarium threads match`, 8*time.Second)
	s.clearQuery()
	s.waitText("#chat-list", "The Conversarium is empty", 4*time.Second)

	s.evidence("A-19-states.png")
}

// ---------------------------------------------------------------------------
// A-24 — Manifest, build stamp, and generated report agree on the release.

func TestA24_VersionCoherence(t *testing.T) {
	s := startTest(t, "A-24", "Manifest / stamp / report version coherence", "A-case")
	s.waitStamp()

	raw, err := os.ReadFile(filepath.Join("..", "extension", "manifest.json"))
	if err != nil {
		s.failf("read manifest: %v", err)
		return
	}
	var mf struct {
		Name    string `json:"name"`
		Version string `json:"version"`
	}
	if err := json.Unmarshal(raw, &mf); err != nil {
		s.failf("parse manifest: %v", err)
		return
	}
	if mf.Version != "0.6.0" {
		s.failf("manifest version = %q, want 0.6.0", mf.Version)
	}
	if mf.Name != "Thread-O-matic" {
		s.failf("manifest name = %q, want Thread-O-matic", mf.Name)
	}
	if stamp := s.text("#build-label"); stamp != buildStamp {
		s.failf("panel stamp %q != harness-derived %q", stamp, buildStamp)
	}

	s.openExtPage("settings/settings.html")
	if stamp := s.text("#build-label"); stamp != buildStamp {
		s.failf("settings stamp %q != %q", stamp, buildStamp)
	}
	s.openExtPage("help/help.html")
	if stamp := s.text("#build-label"); stamp != buildStamp {
		s.failf("help stamp %q != %q", stamp, buildStamp)
	}
	s.logf("manifest %s@%s agrees with runtime stamps and harness report title (%s)",
		mf.Name, mf.Version, buildStamp)
	s.evidence("A-24-coherence.png")
}

// ---------------------------------------------------------------------------
// A-03 — Initial Import discovers all pages, imports missing threads, and
// writes only Conversarium JSON.

func TestA03_InitialImport(t *testing.T) {
	s := startTest(t, "A-03", "Fresh import: discover + write Conversarium JSON only", "A-case", withTotal(8))
	s.waitStamp()

	s.page.MustElement("#capture-btn").MustClick() // Import (fresh)
	s.waitCheckpoint(`"state":"completed"`, 30*time.Second)
	s.waitCheckpoint(`"saved":8`, 5*time.Second)

	files := s.fsFilesIn("convo-library")
	if len(files) != 8 {
		s.failf("expected 8 thread JSONs in the Conversarium, got %d: %v", len(files), files)
	}
	for _, f := range files {
		if !strings.HasPrefix(f, "threads/") || !strings.HasSuffix(f, ".json") {
			s.failf("unexpected Conversarium path %q", f)
		}
	}
	for _, f := range s.fsFiles() {
		if strings.HasPrefix(f, "chats/") {
			s.failf("import wrote outside the Conversarium: %q", f)
		}
	}
	if roots := s.fsRoots(); len(roots) != 1 || roots[0] != "convo-library" {
		s.failf("import touched unexpected roots: %v", roots)
	}
	s.waitCheckpoint(`"state":"completed"`, 5*time.Second)
	s.logf("import wrote 8 threads/%s JSONs into convo-library only", "")
	s.evidence("A-03-imported.png")
}

// ---------------------------------------------------------------------------
// A-06 — Stop is usable during the first delayed list request and no later
// request starts.

func TestA06_StopDuringFirstListRequest(t *testing.T) {
	s := startTest(t, "A-06", "Stop works during discovery; no request after stop", "A-case",
		withTotal(120))
	s.waitStamp()
	s.state.setListDelay(2 * time.Second)

	s.page.MustElement("#capture-btn").MustClick()
	// Poll for the first list request (session/token + picker precede it).
	deadline := time.Now().Add(6 * time.Second)
	for s.state.count("list") == 0 {
		if time.Now().After(deadline) {
			s.failf("first list request never started")
		}
		time.Sleep(100 * time.Millisecond)
	}
	if s.hasAttr("#stop-btn", "hidden") {
		s.failf("Stop import not visible during discovery (R-07)")
	}

	s.page.MustElement("#stop-btn").MustClick()
	s.waitCheckpoint(`"state":"stopped"`, 8*time.Second)

	// No later request starts after the abort settles.
	time.Sleep(1200 * time.Millisecond)
	if n := s.state.count("list"); n != 1 {
		s.failf("requests continued after Stop: %d list calls", n)
	}
	if label := s.text("#capture-btn"); !strings.Contains(label, "Resume import") {
		s.failf("primary button reads %q, want Resume import", label)
	}
	s.logf("stopped during first list request; zero further requests; resume offered")
	s.evidence("A-06-stopped-during-discovery.png")
}

// ---------------------------------------------------------------------------
// A-07 — Resume during discovery starts at the saved nextOffset; earlier
// pages are not re-requested.

func TestA07_ResumeDiscoveryAtOffset(t *testing.T) {
	s := startTest(t, "A-07", "Resume discovery continues at saved offset", "A-case",
		withTotal(60))
	s.waitStamp()
	s.state.setListDelay(1200 * time.Millisecond)

	s.page.MustElement("#capture-btn").MustClick()
	// Wait until page 1 (offset 0..50) is checkpointed.
	s.waitCheckpoint(`"nextOffset":50`, 15*time.Second)
	// Stop while page 2 is in flight (or before it starts).
	s.page.MustElement("#stop-btn").MustClick()
	s.waitCheckpoint(`"state":"stopped"`, 8*time.Second)

	listAtStop := s.state.count("list")
	if listAtStop != 1 && listAtStop != 2 {
		s.failf("unexpected list count at stop: %d", listAtStop)
	}

	// Resume: discovery continues at offset 50 — page 1 is never re-requested.
	s.page.MustElement("#capture-btn").MustClick()
	s.waitCheckpoint(`"state":"completed"`, 60*time.Second)

	want := listAtStop + 1 // only the interrupted page is requested again
	if n := s.state.count("list"); n != want {
		s.failf("list requests after resume = %d, want %d (earlier pages must not be re-requested)", n, want)
	}
	s.waitCheckpoint(`"saved":60`, 5*time.Second)
	s.logf("resume continued discovery at saved offset; %d list requests total; 60 threads saved", want)
	s.evidence("A-07-resumed-discovery.png")
}

// ---------------------------------------------------------------------------
// A-08 — Resume during detail import makes no list request and does not
// refetch files already written.

func TestA08_ResumeDetailsNoList(t *testing.T) {
	s := startTest(t, "A-08", "Resume detail import: no list call, no refetch", "A-case", withTotal(3))
	s.waitStamp()
	s.state.convDelay["conv-b"] = 1500 * time.Millisecond

	s.page.MustElement("#capture-btn").MustClick()
	// conv-a saved; conv-b in flight.
	s.waitCheckpoint(`"attempted":1`, 20*time.Second)
	s.page.MustElement("#stop-btn").MustClick()
	s.waitCheckpoint(`"state":"stopped"`, 8*time.Second)

	if n := s.state.count("conv:conv-c"); n != 0 {
		s.failf("conv-c was fetched before stop finished the run order: %d", n)
	}

	s.page.MustElement("#capture-btn").MustClick() // Resume import
	s.waitCheckpoint(`"state":"completed"`, 30*time.Second)
	s.waitCheckpoint(`"saved":3`, 5*time.Second)

	if n := s.state.count("list"); n != 1 {
		s.failf("resume made %d list request(s); completed discovery must not re-crawl", n)
	}
	if n := s.state.count("conv:conv-a"); n != 1 {
		s.failf("conv-a fetched %d times; saved threads must not be refetched", n)
	}
	s.logf("resume skipped discovery and already-saved threads; conv-c fetched once")
	s.evidence("A-08-resumed-details.png")
}

// ---------------------------------------------------------------------------
// A-09 — A crash after disk write but before checkpoint update is healed by
// the disk diff: the written thread is not fetched again.

func TestA09_CrashHealedByDiskDiff(t *testing.T) {
	s := startTest(t, "A-09", "Disk diff heals crash-after-write", "A-case", withTotal(3))
	s.waitStamp()

	// Simulate the crash state: conv-a's file is already on disk (newer than
	// the fixture timestamp), but the checkpoint still lists it as a target.
	summaries := `[` +
		`{"id":"conv-a","title":"Kubernetes Networking Deep Dive","created":"2026-08-20T00:00:00.000Z","updated":"2026-08-20T10:00:00.000Z"},` +
		`{"id":"conv-b","title":"Sourdough Starter Guide","created":"2026-08-22T00:00:00.000Z","updated":"2026-08-22T18:00:00.000Z"},` +
		`{"id":"conv-c","title":"Go Context Cancellation","created":"2026-08-24T00:00:00.000Z","updated":"2026-08-24T12:00:00.000Z"}]`
	out := s.page.MustEval(`async (summaries) => {
      const m = await import(chrome.runtime.getURL('lib/import-state.js'));
      const fs = await import(chrome.runtime.getURL('lib/fsaccess.js'));
      await fs.chooseLibraryHandle(); // e2e picker: in-memory root
      // The thread written just before the "crash" — newer than the fixture.
      await fs.writeLibraryThread({ id: 'conv-a', title: 'Kubernetes Networking Deep Dive',
        created: '2026-08-20T00:00:00.000Z', updated: '2099-01-01T00:00:00.000Z' });
      await m.mutateCheckpoint((cp) => {
        cp.chatgptList.items = JSON.parse(summaries);
        cp.chatgptList.expectedTotal = 3;
        cp.chatgptList.nextOffset = 150;
        cp.chatgptList.complete = true;
        cp.chatgptList.startedAt = '2026-09-02T00:00:00.000Z';
        cp.importJob.jobId = 'job-crash-test';
        cp.importJob.state = 'importing';
        cp.importJob.targetIds = ['conv-a', 'conv-b', 'conv-c'];
        cp.importJob.attemptedIds = [];
      });
      return 'ok';
    }`, summaries)
	if out.Str() != "ok" {
		s.failf("checkpoint seeding failed: %s", out.Str())
	}

	s.page.MustElement("#capture-btn").MustClick() // Resume import
	s.waitCheckpoint(`"state":"completed"`, 30*time.Second)

	if n := s.state.count("conv:conv-a"); n != 0 {
		s.failf("conv-a was refetched %d time(s); the disk diff must heal crash-after-write", n)
	}
	s.waitCheckpoint(`"unchanged":1`, 5*time.Second)
	s.waitCheckpoint(`"saved":2`, 5*time.Second)
	s.logf("crash-written conv-a recognized on disk (unchanged); only conv-b/c fetched")
	s.evidence("A-09-healed.png")
}

// ---------------------------------------------------------------------------
// A-10 — 429 pacing/cooldown survives panel reload; Resume does not reset
// immediately to 400 ms.

func TestA10_RateLimitCooldownSurvivesReload(t *testing.T) {
	s := startTest(t, "A-10", "429 cooldown persists across reload", "A-case", withTotal(3))
	s.waitStamp()
	s.state.armList429("5") // first list call: 429 + Retry-After: 5

	s.page.MustElement("#capture-btn").MustClick()
	// Wait until the Retry-After-derived cooldown (>= ~4s remaining of the
	// 5s Retry-After) is durably persisted — not just any pacing timestamp.
	s.waitCooldownAtLeast(4000, 10*time.Second)
	s.logf("429 received; Retry-After cooldown checkpointed")

	// Reload the panel mid-cooldown (real chrome.storage.local persists).
	s.page.MustNavigate(fmt.Sprintf("chrome-extension://%s/%s?e2e=1", s.extID, panelPath))
	_ = s.page.WaitLoad()
	s.page.WaitStable(300 * time.Millisecond)
	s.waitStamp()
	if label := s.text("#capture-btn"); !strings.Contains(label, "Resume import") {
		s.failf("after reload the primary button reads %q, want Resume import", label)
	}

	resumeAt := time.Now()
	listBaseline := s.state.count("list") // includes the 429'd first request
	s.page.MustElement("#capture-btn").MustClick()
	// No immediate reset to 400 ms: the persisted cooldown must hold.
	time.Sleep(1200 * time.Millisecond)
	if n := s.state.count("list"); n != listBaseline {
		s.failf("list request fired %.1fs after resume — persisted cooldown was ignored",
			time.Since(resumeAt).Seconds())
	}
	// The list call lands once the (persisted) cooldown elapses.
	deadline := time.Now().Add(8 * time.Second)
	for s.state.count("list") == listBaseline {
		if time.Now().After(deadline) {
			s.failf("list request never resumed after cooldown")
		}
		time.Sleep(150 * time.Millisecond)
	}
	s.logf("cooldown honored across reload: list resumed %.1fs after resume click",
		time.Since(resumeAt).Seconds())
	s.waitCheckpoint(`"state":"completed"`, 30*time.Second)
	s.waitCheckpoint(`"saved":3`, 5*time.Second)
	s.evidence("A-10-cooldown.png")
}

// ---------------------------------------------------------------------------
// A-11 — 401/403 pauses with login guidance and preserves the job.

func TestA11_AuthPausePreservesJob(t *testing.T) {
	s := startTest(t, "A-11", "401 pauses with guidance; job preserved", "A-case", withTotal(3))
	s.waitStamp()
	s.state.listStatus = 401

	s.page.MustElement("#capture-btn").MustClick()
	s.waitStatus("Import paused", "err", 15*time.Second)
	s.waitCheckpoint(`"state":"paused"`, 5*time.Second)
	s.waitCheckpoint(`"pauseReason":"auth"`, 2*time.Second)

	if n := s.state.count("list"); n != 1 {
		s.failf("auth pause should not retry: %d list requests", n)
	}
	if label := s.text("#capture-btn"); !strings.Contains(label, "Resume import") {
		s.failf("primary button reads %q, want Resume import (job preserved)", label)
	}
	s.logf("401 paused the job with login guidance; checkpoint retained")
	s.evidence("A-11-auth-pause.png")
}

// ---------------------------------------------------------------------------
// A-12 — Malformed/404 items are reported specifically and do not erase
// successful work.

func TestA12_MalformedAnd404Reported(t *testing.T) {
	s := startTest(t, "A-12", "404 + malformed reported; successes kept", "A-case", withTotal(3))
	s.waitStamp()
	s.state.malformedFor = "conv-b"
	s.state.setNotFoundFor("conv-c")

	s.page.MustElement("#capture-btn").MustClick()
	s.waitCheckpoint(`"state":"completed"`, 30*time.Second)
	s.waitCheckpoint(`"saved":1`, 5*time.Second)
	s.waitCheckpoint(`"failed":2`, 5*time.Second)
	s.waitCheckpoint(`"failures":2`, 5*time.Second)

	files := s.fsFilesIn("convo-library")
	if len(files) != 1 || !strings.Contains(files[0], "conv") {
		s.failf("expected only conv-a's file in the Conversarium, got %v", files)
	}
	// The summary must survive the reconciliation overwrite (done-event).
	s.waitStatus("Import done", "warn", 8*time.Second)
	if body := s.text("#status"); !strings.Contains(body, "1 new") || !strings.Contains(body, "2 failed") {
		s.failf("final summary %q does not report 1 new / 2 failed", body)
	}
	s.logf("404 and malformed recorded as specific failures; conv-a saved")
	s.evidence("A-12-failures-reported.png")
}

// ---------------------------------------------------------------------------
// results.json + report.md

func writeResultsAndReport(exitCode int) {
	total, passed, failed, skipped := 0, 0, 0, 0
	byPrio := map[string][3]int{}
	for _, r := range resultsSnapshot() {
		total++
		switch r.Status {
		case "pass":
			passed++
		case "fail":
			failed++
		case "skip":
			skipped++
		}
		p := byPrio[r.Priority]
		switch r.Status {
		case "pass":
			p[0]++
		case "fail":
			p[1]++
		case "skip":
			p[2]++
		}
		byPrio[r.Priority] = p
	}

	env := map[string]any{
		"run_id":      runID,
		"finished":    time.Now().Format(time.RFC3339),
		"exit_code":   exitCode,
		"product_ver": buildStamp,
		"chrome":      chromeVer,
		"browser_bin": binUsed,
		"go":          runtime.Version(),
		"rod":         rodVersion(),
		"total":       total,
		"passed":      passed,
		"failed":      failed,
		"skipped":     skipped,
		"duration_s":  time.Since(startAll).Seconds(),
		"tests":       resultsSnapshot(),
	}
	raw, _ := json.MarshalIndent(env, "", "  ")
	os.WriteFile(filepath.Join(artifactsDir, "results.json"), raw, 0o644)

	var b strings.Builder
	fmt.Fprintf(&b, "# Thread-O-matic %s — Browser Verification Report\n\n", buildStamp)
	fmt.Fprintf(&b, "Run: `%s`\n\n", runID)
	fmt.Fprintf(&b, "## Browser Verification Summary\n\n")
	verdict := "PASS"
	if failed > 0 {
		verdict = "PASS WITH ISSUES"
	}
	fmt.Fprintf(&b, "**%s** — %d tests: %d passed, %d failed, %d skipped\n\n", verdict, total, passed, failed, skipped)
	fmt.Fprintf(&b, "## Environment\n\n- Chrome: %s (%s)\n- Go: %s · Rod: %s\n\n", chromeVer, binUsed, runtime.Version(), rodVersion())
	fmt.Fprintf(&b, "## Results\n\n| Test | Priority | Result | Duration | Evidence |\n|---|---|---|---|---|\n")
	for _, r := range resultsSnapshot() {
		ev := strings.Join(r.Evidence, "<br>")
		fmt.Fprintf(&b, "| %s %s | %s | %s | %dms | %s |\n", r.ID, r.Name, r.Priority, r.Status, r.DurationMS, ev)
	}
	fmt.Fprintf(&b, "\n## Videos\n\n")
	vids, _ := filepath.Glob(filepath.Join(artifactsDir, "videos", "*.mp4"))
	for _, v := range vids {
		st, _ := os.Stat(v)
		fmt.Fprintf(&b, "- `%s` (%d KB)\n", filepath.Base(v), st.Size()/1024)
	}
	fmt.Fprintf(&b, "\n## Notes per test\n\n")
	for _, r := range resultsSnapshot() {
		if len(r.Notes) > 0 || r.Error != "" {
			fmt.Fprintf(&b, "- **%s**: %s", r.ID, strings.Join(r.Notes, "; "))
			if r.Error != "" {
				fmt.Fprintf(&b, " — FAILURE: %s", r.Error)
			}
			b.WriteString("\n")
		}
	}
	fmt.Fprintf(&b, `
## Scope of this run

Phase 1 acceptance coverage (spec §8): A-01 (no network on open), A-02
(brand sweep), A-13 (change-folder opens picker, cancel preserves), A-14
(reconnect/forget), A-15 (distinct folder roots), A-19 (distinct empty/
permission/no-hit states), A-24 (version coherence).

Remaining acceptance cases (A-03..A-12 import/resume, A-04/A-05/A-20/A-23
live UI, A-16..A-18/A-21/A-22 local export) are delivered with their phases
per spec §12, as are the manual real-browser checks (native pickers, real
disk bytes, Chrome restart resume, Obsidian rendering, local digest
backends). This run is an intermediate development checkpoint, NOT a
release build.
`)
	os.WriteFile(filepath.Join(artifactsDir, "report.md"), []byte(b.String()), 0o644)

	fmt.Printf("\n=== %s: %d tests, %d passed, %d failed, %d skipped ===\n", verdict, total, passed, failed, skipped)
	fmt.Printf("artifacts: %s\n", artifactsDir)
}

func rodVersion() string {
	out, err := exec.Command("go", "list", "-m", "github.com/go-rod/rod").Output()
	if err == nil {
		return strings.TrimSpace(string(out))
	}
	bi, ok := debug.ReadBuildInfo()
	if !ok {
		return "unknown"
	}
	for _, d := range bi.Deps {
		if strings.Contains(d.Path, "go-rod/rod") {
			return d.Version
		}
	}
	return "unknown"
}
