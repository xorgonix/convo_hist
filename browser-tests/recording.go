// recording.go — video capture via CDP screencast frames piped into ffmpeg,
// plus validation of the produced file with ffprobe (spec §10: recording must
// not silently fail).
package e2e

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"sync/atomic"
	"time"

	"github.com/go-rod/rod"
	"github.com/go-rod/rod/lib/proto"
)

type recording struct {
	path    string
	page    *rod.Page
	cmd     *exec.Cmd
	stdin   io.WriteCloser
	started time.Time

	active  atomic.Bool
	frames  int32
	stopped bool

	// filled on stop
	bytes    int64
	duration float64
	probeErr string
}

// startRecording begins screencasting the test's page into an mp4.
func (s *tb) startRecording(name string) *recording {
	dir := filepath.Join(artifactsDir, "videos")
	os.MkdirAll(dir, 0o755)
	path := filepath.Join(dir, name)

	cmd := exec.Command("ffmpeg",
		"-hide_banner", "-loglevel", "error", "-y",
		"-f", "image2pipe", "-framerate", "12", "-i", "-",
		"-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
		"-movflags", "+faststart", path)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		s.note("recording %s: ffmpeg stdin pipe failed: %v", name, err)
		return &recording{path: path, probeErr: "pipe failed: " + err.Error()}
	}
	if err := cmd.Start(); err != nil {
		s.note("recording %s: ffmpeg start failed: %v", name, err)
		return &recording{path: path, probeErr: "start failed: " + err.Error()}
	}

	r := &recording{path: path, page: s.page, cmd: cmd, stdin: stdin, started: time.Now()}
	r.active.Store(true)
	s.recs = append(s.recs, r)

	// Subscribe to screencast frames. Each frame MUST be acknowledged with
	// Page.screencastFrameAck — without acks Chrome stops sending after the
	// first few frames. The active flag makes stale subscriptions harmless.
	wait := s.page.EachEvent(func(e *proto.PageScreencastFrame) {
		ack := (proto.PageScreencastFrameAck{SessionID: e.SessionID})
		_ = ack.Call(s.page)
		if !r.active.Load() {
			return
		}
		if _, err := r.stdin.Write(e.Data); err != nil {
			return
		}
		atomic.AddInt32(&r.frames, 1)
	})
	go func() { wait() }()

	q := 70
	mw, mh := 1280, 800
	nth := 1
	sc := (proto.PageStartScreencast{
		Format:        proto.PageStartScreencastFormatJpeg,
		Quality:       &q,
		MaxWidth:      &mw,
		MaxHeight:     &mh,
		EveryNthFrame: &nth,
	})
	if err := sc.Call(s.page); err != nil {
		r.probeErr = "screencast start failed: " + err.Error()
		r.active.Store(false)
		stdin.Close()
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		s.note("recording %s: %s", name, r.probeErr)
		return r
	}

	s.logf("recording started: %s", path)

	// Repaint heartbeat: screencast only emits frames on paint, so a static
	// panel yields a near-empty video. A 1x1 px, 2%-alpha pixel flips color on
	// every requestAnimationFrame — imperceptible to users, but a real paint
	// for the compositor so frames keep flowing.
	s.page.MustEval(`() => {
      window.__e2eHbOn = true;
      let d = document.getElementById('e2e-hb');
      if (!d) {
        d = document.createElement('div');
        d.id = 'e2e-hb';
        d.style.cssText = 'position:fixed;right:0;bottom:0;width:1px;height:1px;opacity:0.02;z-index:99999;pointer-events:none';
        document.body.appendChild(d);
      }
      (function loop() {
        if (!window.__e2eHbOn) return;
        d.style.background = (d.style.background === 'rgb(0, 0, 1)') ? 'rgb(0, 0, 0)' : 'rgb(0, 0, 1)';
        requestAnimationFrame(loop);
      })();
      return 1;
    }`)
	return r
}

// stop finalizes the mp4 and validates it with ffprobe.
func (r *recording) stop() {
	if r.stopped {
		return
	}
	r.stopped = true
	r.active.Store(false)

	if r.cmd == nil {
		return
	}
	time.Sleep(400 * time.Millisecond) // let in-flight frames drain

	r.page.MustEval(`() => { window.__e2eHbOn = false; }`)

	if err := (proto.PageStopScreencast{}).Call(r.page); err != nil {
		r.probeErr = "screencast stop: " + err.Error()
	}
	_ = r.stdin.Close()
	_ = r.cmd.Wait()

	// Validate: file exists, non-zero, probeable (spec §10).
	st, err := os.Stat(r.path)
	if err != nil {
		r.probeErr = "output missing: " + err.Error()
	} else {
		r.bytes = st.Size()
		if st.Size() < 1024 {
			r.probeErr = fmt.Sprintf("suspiciously small (%d bytes)", st.Size())
		}
	}
	out, err := exec.Command("ffprobe", "-v", "error", "-show_entries",
		"format=duration", "-of", "json", r.path).Output()
	if err != nil {
		r.probeErr += " ffprobe failed: " + err.Error()
	} else {
		var probe struct {
			Format struct {
				Duration string `json:"duration"`
			} `json:"format"`
		}
		if json.Unmarshal(out, &probe) == nil {
			if d, err := strconv.ParseFloat(probe.Format.Duration, 64); err == nil {
				r.duration = d
			}
		}
	}
}
