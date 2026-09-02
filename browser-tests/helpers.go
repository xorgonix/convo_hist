// helpers.go — the Rod test harness: browser+extension lifecycle, network
// mocking, page helpers, waits, screenshots, console capture, results collector.
package e2e

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-rod/rod"
	"github.com/go-rod/rod/lib/launcher"
	"github.com/go-rod/rod/lib/proto"
)

var _ = http.StatusText // net/http reserved for future response helpers

//go:embed e2efs-polyfill.js
var polyfillJS string

const panelPath = "sidepanel/sidepanel.html"

// buildStamp derives from the extension manifest (R-15: one authoritative
// version source). The runtime BUILD constant is `v` + manifest version, so
// the harness expectation is constructed the same way — no hard-coded
// release string can drift out of coherence again.
var buildStamp = func() string {
	raw, err := os.ReadFile(filepath.Join("..", "extension", "manifest.json"))
	if err != nil {
		panic("e2e harness: cannot read extension/manifest.json: " + err.Error())
	}
	var m struct {
		Version string `json:"version"`
	}
	if err := json.Unmarshal(raw, &m); err != nil || m.Version == "" {
		panic("e2e harness: cannot parse manifest version")
	}
	return "v" + m.Version
}()

var (
	artifactsDir string
	runID        string
	chromeVer    string
	binUsed      string
	verMu        sync.Mutex
)

// collector gathers per-test results for results.json / report.md
type result struct {
	ID         string   `json:"id"`
	Priority   string   `json:"priority"`
	Name       string   `json:"name"`
	Status     string   `json:"status"` // pass|fail|skip
	DurationMS int64    `json:"duration_ms"`
	Error      string   `json:"error,omitempty"`
	Notes      []string `json:"notes,omitempty"`
	Evidence   []string `json:"evidence,omitempty"`
}

var (
	resMu    sync.Mutex
	resList  []result
	startAll = time.Now()
)

func record(r result) {
	resMu.Lock()
	defer resMu.Unlock()
	resList = append(resList, r)
}

func resultsSnapshot() []result {
	resMu.Lock()
	defer resMu.Unlock()
	out := make([]result, len(resList))
	copy(out, resList)
	return out
}

// tb — per-test browser/session. Fresh browser per test = airtight isolation
// (fresh profile → fresh IndexedDB → fresh module state).
type tb struct {
	t       *testing.T
	id      string
	name    string
	prio    string
	state   *mockState
	browser *rod.Browser
	page    *rod.Page
	extID   string
	profile string
	started time.Time

	logMu  sync.Mutex
	logs   []string
	evid   []string
	notes  []string
	recs   []*recording
	failed bool
}

func mustAbs(p string) string {
	a, err := filepath.Abs(p)
	if err != nil {
		panic(err)
	}
	return a
}

func chromeBinCandidates() []string {
	var out []string
	for _, p := range []string{
		// Edge is Chromium-based and keeps --load-extension on stable builds
		`C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`,
		`C:\Program Files\Microsoft\Edge\Application\msedge.exe`,
		os.Getenv("ProgramFiles") + `\Google\Chrome\Application\chrome.exe`,
		os.Getenv("ProgramFiles(x86)") + `\Google\Chrome\Application\chrome.exe`,
		os.Getenv("LocalAppData") + `\Google\Chrome\Application\chrome.exe`,
	} {
		if _, err := os.Stat(p); err == nil {
			out = append(out, p)
		}
	}
	return out
}

type testOpts struct {
	slow           time.Duration
	polyfill       bool
	width, height  int
	total          int
	mobileViewport bool
	headless       bool
}

func withSlow(d time.Duration) func(*testOpts) { return func(o *testOpts) { o.slow = d } }
func withNoPolyfill() func(*testOpts)          { return func(o *testOpts) { o.polyfill = false } }
func withSize(w, h int) func(*testOpts)        { return func(o *testOpts) { o.width, o.height = w, h } }
func withTotal(n int) func(*testOpts)          { return func(o *testOpts) { o.total = n } }
func withHeadless() func(*testOpts)            { return func(o *testOpts) { o.headless = true } }

// startTest launches a fresh headed browser with the unpacked extension loaded,
// installs the mock router, and returns the session. Falls back from installed
// (branded) Chrome — stable builds may ignore --load-extension — to Rod's
// managed Chromium when no extension target appears.
func startTest(t *testing.T, id, name, prio string, opts ...func(*testOpts)) *tb {
	t.Helper()
	// Default: headless=new — deterministic (no OS foreground stealing, which
	// let stray human keystrokes land in the autofocused search box mid-test).
	// TEST_HEADED=1 opts into visible watch mode (spec §3 demo mode).
	o := &testOpts{slow: 0, polyfill: true, width: 1280, height: 800, total: 120,
		headless: os.Getenv("TEST_HEADED") != "1"}
	for _, f := range opts {
		f(o)
	}

	state := newMockState(o.total)
	setMockState(state)
	port := mockPort.Load()
	if port == 0 {
		p, err := startMockServer()
		if err != nil {
			t.Fatalf("mock server: %v", err)
		}
		port = int32(p)
	}
	b, page, extID, profile := launchWithExtension(t, o, state, port)

	verMu.Lock()
	if chromeVer == "" {
		if v, err := (proto.BrowserGetVersion{}).Call(b); err == nil {
			chromeVer = v.Product
		}
	}
	verMu.Unlock()

	s := &tb{
		t: t, id: id, name: name, prio: prio,
		state:   state,
		browser: b, page: page, extID: extID, profile: profile,
		started: time.Now(),
	}
	t.Cleanup(s.finish)
	s.logf("test start %s (%s) slow=%v polyfill=%v bin=%s", id, name, o.slow, o.polyfill, binUsed)

	// Console + JS-exception capture (spec §12)
	go s.page.EachEvent(
		func(e *proto.RuntimeConsoleAPICalled) {
			parts := make([]string, 0, len(e.Args))
			for _, a := range e.Args {
				parts = append(parts, a.Value.Str())
			}
			s.logf("console[%s] %s", e.Type, strings.Join(parts, " "))
		},
		func(e *proto.RuntimeExceptionThrown) {
			d := e.ExceptionDetails
			s.logf("JS-EXCEPTION %s %s", d.Text, d.Exception.Description)
		},
	)()
	return s
}

func launchWithExtension(t *testing.T, o *testOpts, state *mockState, mockPortV int32) (*rod.Browser, *rod.Page, string, string) {
	t.Helper()
	extPath := mustAbs(filepath.Join("..", "extension"))

	try := func(bin string, managed bool) (*rod.Browser, *rod.Page, string, string, bool) {
		profile, err := os.MkdirTemp("", "convo-e2e-profile-*")
		if err != nil {
			t.Fatalf("profile dir: %v", err)
		}
		l := launcher.New().
			Leakless(false). // Defender flags leakless.exe as PUP — run browsers as plain children
			UserDataDir(profile).
			Set("disable-extensions-except", extPath).
			Set("load-extension", extPath).
			Set("no-first-run", "").
			Set("no-default-browser-check", "").
			Set("ignore-certificate-errors", ""). // our self-signed chatgpt.com mock
			Set("host-resolver-rules", fmt.Sprintf("MAP chatgpt.com 127.0.0.1:%d", mockPortV)).
			Set("window-position", "-32000,-32000"). // off-screen: real users can't interfere; CDP still captures everything
			Set("window-size", fmt.Sprintf("%d,%d", o.width, o.height)).
			Headless(o.headless)
		if managed {
			bin = launcher.NewBrowser().MustGet()
		}
		if bin != "" {
			l = l.Bin(bin)
		}
		url, lerr := l.Launch()
		if lerr != nil {
			t.Logf("launcher failed (bin=%q managed=%v): %v", bin, managed, lerr)
			os.RemoveAll(profile)
			return nil, nil, "", profile, false
		}
		b := rod.New().ControlURL(url)
		if cerr := b.Connect(); cerr != nil {
			t.Logf("connect failed: %v", cerr)
			os.RemoveAll(profile)
			return nil, nil, "", profile, false
		}

		// clipboard permission for capture's "copied to clipboard" path
		_ = (proto.BrowserGrantPermissions{Permissions: []proto.BrowserPermissionType{
			proto.BrowserPermissionTypeClipboardReadWrite,
			proto.BrowserPermissionTypeClipboardSanitizedWrite,
		}}).Call(b)

		extID := waitExtensionTarget(b, 12*time.Second)
		if extID == "" {
			t.Logf("no extension target for bin=%q (branded Chrome may ignore --load-extension)", bin)
			b.MustClose()
			os.RemoveAll(profile)
			return nil, nil, "", profile, false
		}
		page, perr := newPanelPage(b, extID, o, o.polyfill, state)
		if perr != nil {
			t.Logf("panel page failed: %v", perr)
			b.MustClose()
			os.RemoveAll(profile)
			return nil, nil, "", profile, false
		}
		return b, page, extID, profile, true
	}

	for _, bin := range chromeBinCandidates() {
		if b, p, id, prof, ok := try(bin, false); ok {
			binUsed = bin
			return b, p, id, prof
		}
	}
	binUsed = "rod-managed chromium"
	if b, p, id, prof, ok := try("", true); ok {
		return b, p, id, prof
	}
	t.Fatal("could not launch any browser with the extension loaded")
	return nil, nil, "", ""
}

func waitExtensionTarget(b *rod.Browser, timeout time.Duration) string {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		res, err := (proto.TargetGetTargets{}).Call(b)
		if err == nil {
			for _, tgt := range res.TargetInfos {
				if strings.HasPrefix(tgt.URL, "chrome-extension://") {
					id := strings.TrimPrefix(tgt.URL, "chrome-extension://")
					return id[:32]
				}
			}
		}
		time.Sleep(300 * time.Millisecond)
	}
	return ""
}

// newPanelPage opens the sidepanel as a tab (polyfill injected before its
// module scripts when requested). All chatgpt.com traffic — panel AND service
// worker — resolves to the local TLS mock server via host-resolver-rules.
func newPanelPage(b *rod.Browser, extID string, o *testOpts, polyfill bool, state *mockState) (*rod.Page, error) {
	page := b.MustPage("about:blank")
	_ = page.SetViewport(&proto.EmulationSetDeviceMetricsOverride{
		Width: o.width, Height: o.height, DeviceScaleFactor: 1, Mobile: o.mobileViewport,
	})
	if polyfill {
		page.MustEvalOnNewDocument(polyfillJS)
	}

	panelURL := fmt.Sprintf("chrome-extension://%s/%s?e2e=1", extID, panelPath)
	if err := page.Navigate(panelURL); err != nil {
		return nil, err
	}
	_ = page.WaitLoad()
	page.WaitStable(300 * time.Millisecond)
	return page, nil
}

func atoiDefault(s string, d int) int {
	if s == "" {
		return d
	}
	n := 0
	for _, c := range s {
		if c < '0' || c > '9' {
			return d
		}
		n = n*10 + int(c-'0')
	}
	return n
}

func respondJSON(ctx *rod.Hijack, code int, body string) {
	fulfill(ctx, code, "application/json", body)
}

func respondHTML(ctx *rod.Hijack, code int, body string) {
	fulfill(ctx, code, "text/html; charset=utf-8", body)
}

func fulfill(ctx *rod.Hijack, code int, ctype, body string) {
	ctx.Response.SetHeader("Content-Type", ctype)
	ctx.Response.Payload().ResponseCode = code
	ctx.Response.SetBody(body)
}

// finish — cleanup hook: failure screenshot, log dump, close browser, record result.
func (s *tb) finish() {
	if s.t.Failed() {
		s.failed = true
		if p := s.shot(fmt.Sprintf("%s-FAILURE.png", s.id)); p != "" {
			s.evid = append(s.evid, p)
		}
	}
	for _, r := range s.recs {
		r.stop()
		s.logf("recording done: %s frames=%d bytes=%d duration=%.2fs probeErr=%q",
			filepath.Base(r.path), r.frames, r.bytes, r.duration, r.probeErr)
	}
	s.flushLogs()
	s.browser.MustClose()
	os.RemoveAll(s.profile)

	status := "pass"
	errStr := ""
	if s.t.Skipped() {
		status = "skip"
	} else if s.failed {
		status = "fail"
		if v, ok := failureMsgs.Load(s.t); ok {
			errStr = v.(string)
		} else {
			errStr = "assertion failed"
		}
	}
	record(result{
		ID: s.id, Priority: s.prio, Name: s.name, Status: status,
		DurationMS: time.Since(s.started).Milliseconds(),
		Error:      errStr, Notes: s.notes, Evidence: s.evid,
	})
}

var failureMsgs sync.Map // *testing.T -> last failure message

// failf marks the test failed and ABORTS it (like t.Fatalf), preserving the
// message for the report. Prevents cascade panics after a failed wait.
func (s *tb) failf(format string, args ...any) {
	msg := fmt.Sprintf(format, args...)
	failureMsgs.Store(s.t, msg)
	s.t.Fatalf("%s", msg)
}

func (s *tb) logf(format string, args ...any) {
	s.logMu.Lock()
	defer s.logMu.Unlock()
	s.logs = append(s.logs, time.Now().Format("15:04:05.000")+" "+fmt.Sprintf(format, args...))
}

func (s *tb) flushLogs() {
	dir := filepath.Join(artifactsDir, "logs")
	os.MkdirAll(dir, 0o755)
	os.WriteFile(filepath.Join(dir, s.id+".log"), []byte(strings.Join(s.logs, "\n")), 0o644)
}

func (s *tb) note(format string, args ...any) {
	s.notes = append(s.notes, fmt.Sprintf(format, args...))
}

func (s *tb) shot(name string) string {
	dir := filepath.Join(artifactsDir, "screenshots")
	os.MkdirAll(dir, 0o755)
	p := filepath.Join(dir, name)
	// cleanup-time screenshots must never panic the suite
	defer func() { _ = recover() }()
	s.page.MustScreenshot(p)
	s.logf("screenshot %s", p)
	return p
}

func (s *tb) evidence(name string) string {
	p := s.shot(name)
	s.evid = append(s.evid, p)
	return p
}

// ---------------------------------------------------------------------------
// page helpers / waits

func (s *tb) text(sel string) string {
	v := s.page.MustEval(`(sel) => { const el = document.querySelector(sel); return el ? el.textContent : null; }`, sel)
	return v.Str()
}

func (s *tb) hasAttr(sel, name string) bool {
	return s.page.MustEval(`(sel, name) => { const el = document.querySelector(sel); return el ? el.hasAttribute(name) : false; }`, sel, name).Bool()
}

func (s *tb) prop(sel, name string) string {
	return s.page.MustEval(`(sel, name) => { const el = document.querySelector(sel); return el ? String(el[name]) : ""; }`, sel, name).Str()
}

func (s *tb) count(sel string) int {
	return int(s.page.MustEval(`(sel) => document.querySelectorAll(sel).length`, sel).Int())
}

func (s *tb) waitStatus(substr, kind string, timeout time.Duration) {
	s.t.Helper()
	deadline := time.Now().Add(timeout)
	last := "\x00"
	for time.Now().Before(deadline) {
		txt := s.text("#status")
		cls := s.prop("#status", "className")
		if txt != last {
			s.logf("status poll: %q (%s)", txt, cls)
			last = txt
		}
		if strings.Contains(txt, substr) && (kind == "" || strings.Contains(cls, kind)) {
			s.logf("status reached: %q (%s)", txt, kind)
			return
		}
		time.Sleep(120 * time.Millisecond)
	}
	s.failf("timeout waiting for status containing %q (kind=%s); last=%q class=%q",
		substr, kind, s.text("#status"), s.prop("#status", "className"))
}

func (s *tb) waitStamp() {
	s.t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if s.text("#build-label") == buildStamp {
			return
		}
		time.Sleep(120 * time.Millisecond)
	}
	s.failf("build stamp not reached: got %q want %q (sidepanel JS may not have run)",
		s.text("#build-label"), buildStamp)
}

func (s *tb) waitItems(n int, timeout time.Duration) {
	s.t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if c := s.count(".chat-item"); c == n {
			return
		}
		time.Sleep(120 * time.Millisecond)
	}
	s.failf("timeout waiting for %d .chat-item elements; got %d (status=%q)",
		n, s.count(".chat-item"), s.text("#status"))
}
func (s *tb) waitBadges(n int, timeout time.Duration) {
	s.t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if c := s.count(".chat-item.captured"); c == n {
			return
		}
		time.Sleep(120 * time.Millisecond)
	}
	s.failf("timeout waiting for %d captured badges; got %d (status=%q)", n,
		s.count(".chat-item.captured"), s.text("#status"))
}

func (s *tb) waitResults(n int, timeout time.Duration) {
	s.t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if c := s.count(".result-card"); c == n {
			return
		}
		time.Sleep(120 * time.Millisecond)
	}
	s.failf("timeout waiting for %d .result-card elements; got %d (status=%q)",
		n, s.count(".result-card"), s.text("#status"))
}

// nth returns the nth matching element (0-based).
func (s *tb) nth(sel string, i int) *rod.Element {
	els := s.page.MustElements(sel)
	if i >= len(els) {
		s.failf("nth(%d): only %d elements match %s", i, len(els), sel)
		return nil
	}
	return els[i]
}

// clickRow toggles the checkbox of the nth conversation row (single click).
func (s *tb) clickRow(i int) {
	s.t.Helper()
	s.nth(".chat-item", i).MustClick()
	s.logf("clicked row %d", i)
}

// dblclickRow triggers the single-capture path for the nth row.
// Selector-based dispatch (not an element handle) so list re-renders can't
// leave us holding a detached node.
func (s *tb) dblclickRow(i int) {
	s.t.Helper()
	ok := s.page.MustEval(`(i) => {
      const el = document.querySelectorAll('.chat-item')[i];
      if (!el) return false;
      el.dispatchEvent(new MouseEvent('dblclick', {bubbles: true}));
      return true;
    }`, i).Bool()
	if !ok {
		s.failf("dblclickRow(%d): row not found", i)
	}
	s.logf("dblclick row %d", i)
}

func (s *tb) typeQuery(q string) {
	s.t.Helper()
	s.page.MustEval(`(v) => {
      const el = document.getElementById('search');
      el.value = v;
      el.dispatchEvent(new Event('input', {bubbles: true}));
    }`, q)
	time.Sleep(200 * time.Millisecond)
}

func (s *tb) clearQuery() {
	s.t.Helper()
	s.typeQuery("")
}

func (s *tb) grantFolder() {
	s.t.Helper()
	s.page.MustElement("#folder-btn").MustClick()
	s.waitStatus("Vault folder: E2E-", "ok", 6*time.Second)
	s.logf("folder granted")
}

// openExtPage navigates the session's page to another extension page (e.g.
// settings/settings.html). The polyfill was injected with EvalOnNewDocument,
// so it stays active across navigations of this page.
func (s *tb) openExtPage(path string) {
	s.t.Helper()
	url := fmt.Sprintf("chrome-extension://%s/%s?e2e=1", s.extID, path)
	if err := s.page.Navigate(url); err != nil {
		s.failf("navigate to %s: %v", path, err)
		return
	}
	_ = s.page.WaitLoad()
	s.page.WaitStable(300 * time.Millisecond)
	s.logf("opened extension page %s", path)
}

// checkpointJSON returns a compact summary of the durable import checkpoint
// (chrome.storage.local — real storage, survives page reloads).
func (s *tb) checkpointJSON() string {
	s.t.Helper()
	return s.page.MustEval(`async () => {
      const m = await import(chrome.runtime.getURL('lib/import-state.js'));
      const cp = await m.loadCheckpoint();
      return JSON.stringify({
        hasJob: !!cp.importJob.jobId,
        state: cp.importJob.state,
        pauseReason: cp.importJob.pauseReason,
        nextOffset: cp.chatgptList.nextOffset,
        complete: cp.chatgptList.complete,
        items: cp.chatgptList.items.length,
        targets: cp.importJob.targetIds.length,
        attempted: cp.importJob.attemptedIds.length,
        saved: cp.importJob.counters.saved,
        failed: cp.importJob.counters.failed,
        unchanged: cp.importJob.counters.unchanged,
        failures: cp.importJob.failures.length,
        nextAllowedAt: cp.importJob.pacing.nextAllowedAt
      });
    }`).Str()
}

// waitCheckpoint polls until the checkpoint summary contains substr.
func (s *tb) waitCheckpoint(substr string, timeout time.Duration) {
	s.t.Helper()
	deadline := time.Now().Add(timeout)
	last := "\x00"
	for time.Now().Before(deadline) {
		cur := s.checkpointJSON()
		if cur != last {
			s.logf("checkpoint poll: %s", cur)
			last = cur
		}
		if strings.Contains(cur, substr) {
			return
		}
		time.Sleep(150 * time.Millisecond)
	}
	s.failf("timeout waiting for checkpoint containing %q; last=%s", substr, s.checkpointJSON())
}

// waitCooldownAtLeast polls until the persisted 429 cooldown has at least
// ms milliseconds remaining — proving the Retry-After value (not just any
// pacing timestamp) survived. Fails the test if the cooldown never reaches
// the floor or expires before the wait completes.
func (s *tb) waitCooldownAtLeast(ms int, timeout time.Duration) {
	s.t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		v := s.page.MustEval(`async () => {
          const m = await import(chrome.runtime.getURL('lib/import-state.js'));
          const cp = await m.loadCheckpoint();
          return cp.importJob.pacing.nextAllowedAt
            ? cp.importJob.pacing.nextAllowedAt - Date.now() : -1;
        }`).Int()
		if v >= ms {
			s.logf("persisted cooldown has %dms remaining (floor %dms)", v, ms)
			return
		}
		time.Sleep(120 * time.Millisecond)
	}
	s.failf("cooldown never reached %dms remaining within %v", ms, timeout)
}

// waitText waits until the element's textContent contains substr.
func (s *tb) waitText(sel, substr string, timeout time.Duration) {
	s.t.Helper()
	deadline := time.Now().Add(timeout)
	last := "\x00"
	for time.Now().Before(deadline) {
		txt := s.text(sel)
		if txt != last {
			s.logf("text poll %s: %q", sel, txt)
			last = txt
		}
		if strings.Contains(txt, substr) {
			return
		}
		time.Sleep(120 * time.Millisecond)
	}
	s.failf("timeout waiting for %s to contain %q; last=%q", sel, substr, s.text(sel))
}

// fsFiles returns the file list across ALL fake roots merged, bare relative
// paths (legacy single-root behavior). Use fsFilesIn(root) to scope to one
// picker-id root for isolation assertions (A-15).
func (s *tb) fsFiles() []string {
	s.t.Helper()
	v := s.page.MustEval(`() => window.__e2eFsSnapshot ? window.__e2eFsSnapshot() : "[]"`)
	var out []string
	if err := json.Unmarshal([]byte(v.Str()), &out); err != nil {
		s.failf("fs snapshot: %v (raw=%q)", err, v.Str())
		return nil
	}
	return out
}

// fsFilesIn returns bare relative paths inside ONE fake root (picker id).
func (s *tb) fsFilesIn(root string) []string {
	s.t.Helper()
	v := s.page.MustEval(`(root) => window.__e2eFsSnapshot(root)`, root)
	var out []string
	if err := json.Unmarshal([]byte(v.Str()), &out); err != nil {
		s.failf("fs snapshot(%s): %v (raw=%q)", root, err, v.Str())
		return nil
	}
	return out
}

// fsRoots lists the fake roots created so far (picker ids).
func (s *tb) fsRoots() []string {
	s.t.Helper()
	v := s.page.MustEval(`() => window.__e2eFsRoots ? window.__e2eFsRoots() : "[]"`)
	var out []string
	if err := json.Unmarshal([]byte(v.Str()), &out); err != nil {
		s.failf("fs roots: %v (raw=%q)", err, v.Str())
		return nil
	}
	return out
}

// fsSetPermission drives the polyfill's per-root permission model
// ('granted' | 'prompt' | 'denied') — foundation for A-13/A-14.
func (s *tb) fsSetPermission(root, state string) {
	s.t.Helper()
	s.page.MustEval(`(root, state) => window.__e2eFsSetPermission(root, state)`, root, state)
	s.logf("fs permission %s -> %s", root, state)
}

func (s *tb) fsCount(suffix string) int {
	n := 0
	for _, f := range s.fsFiles() {
		if strings.HasSuffix(f, suffix) {
			n++
		}
	}
	return n
}

func (s *tb) fsCountIn(prefix, suffix string) int {
	n := 0
	for _, f := range s.fsFiles() {
		if strings.HasPrefix(f, prefix) && strings.HasSuffix(f, suffix) {
			n++
		}
	}
	return n
}

func (s *tb) fsHas(p string) bool {
	for _, f := range s.fsFiles() {
		if f == p {
			return true
		}
	}
	return false
}
