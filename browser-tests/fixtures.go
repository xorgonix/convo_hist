// fixtures.go — deterministic mock payloads for the ChatGPT backend API.
// Conversation/list fixtures are built in Go so tests can mutate titles,
// update times and inject faults at runtime via mockState.
package e2e

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"
)

// mockState is mutated by tests between/within runs; the hijack router reads it.
type mockState struct {
	mu           sync.Mutex
	Total        int               // total conversations reported by the list endpoint
	titles       map[string]string // per-id title overrides (title-change test)
	updateTime   map[string]int64  // per-id update_time overrides (diff tests)
	convDelay    map[string]time.Duration // per-id server-side delay (stop-mid-batch test)
	fail401For   string            // conversation id that returns 401
	malformedFor string            // conversation id that returns mapping:{} payload
	listStatus   int               // non-zero => list endpoint returns this status
	reqCounts    map[string]int    // pattern label -> hit count
}

func newMockState(total int) *mockState {
	return &mockState{
		Total:      total,
		titles:     map[string]string{},
		updateTime: map[string]int64{},
		convDelay:  map[string]time.Duration{},
		reqCounts:  map[string]int{},
	}
}

func (s *mockState) setTitle(id, title string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.titles[id] = title
}

func (s *mockState) bumpUpdate(id string, delta int64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.updateTime[id] += delta
}

func (s *mockState) count(label string) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.reqCounts[label]
}

// totalHits sums every recorded request — the A-01 "zero ChatGPT requests"
// assertion uses this so no endpoint can slip through unlabeled.
func (s *mockState) totalHits() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	n := 0
	for _, v := range s.reqCounts {
		n += v
	}
	return n
}

func (s *mockState) hit(label string) {
	s.mu.Lock()
	s.reqCounts[label]++
	s.mu.Unlock()
}

// Fixed epochs (UTC, 2026-08) — consistent between list and detail fixtures so
// the diff-skip logic sees identical timestamps on re-capture.
const (
	baseA = int64(1787184000) // 2026-08-20T00:00:00Z
	baseB = int64(1787356800) // 2026-08-22T00:00:00Z
	baseC = int64(1787529600) // 2026-08-24T00:00:00Z
	baseG = int64(1787616000) // 2026-08-25T00:00:00Z
)

// rich conversation ids (also the first three list entries)
var richIDs = []string{"conv-a", "conv-b", "conv-c"}

func richTitle(id string) string {
	switch id {
	case "conv-a":
		return "Kubernetes Networking Deep Dive"
	case "conv-b":
		return "Sourdough Starter Guide"
	case "conv-c":
		return "Go Context Cancellation"
	}
	return ""
}

func richUpdate(id string) int64 {
	switch id {
	case "conv-a":
		return baseA + 36000 // 2026-08-20T10:00:00Z
	case "conv-b":
		return baseB + 64800 // 2026-08-22T18:00:00Z
	case "conv-c":
		return baseC + 43200 // 2026-08-24T12:00:00Z
	}
	return 0
}

// listID returns the conversation id for position i in the fixture universe.
func listID(i int, total int) string {
	if i < len(richIDs) {
		return richIDs[i]
	}
	n := i - len(richIDs) + 1
	if n > total {
		n = total
	}
	return fmt.Sprintf("gen-%03d", n)
}

func genTitle(n int) string {
	return fmt.Sprintf("Test Conversation %03d", n)
}

func (s *mockState) titleFor(id string) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	if t, ok := s.titles[id]; ok {
		return t
	}
	if t := richTitle(id); t != "" {
		return t
	}
	var n int
	fmt.Sscanf(id, "gen-%d", &n)
	return genTitle(n)
}

func (s *mockState) updateTimeFor(id string) int64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	if v, ok := s.updateTime[id]; ok {
		return v
	}
	if v := richUpdate(id); v != 0 {
		return v
	}
	var n int
	fmt.Sscanf(id, "gen-%d", &n)
	return baseG + int64(n)*3600
}

func (s *mockState) createFor(id string) int64 {
	switch id {
	case "conv-a":
		return baseA
	case "conv-b":
		return baseB
	case "conv-c":
		return baseC
	}
	var n int
	fmt.Sscanf(id, "gen-%d", &n)
	return baseG + int64(n)*3600 - 60
}

func (s *mockState) respondList(offset, limit int) string {
	s.hit("list")
	s.mu.Lock()
	status := s.listStatus
	s.mu.Unlock()
	if status != 0 {
		return fmt.Sprintf(`{"status":%d,"detail":"mock fault"}`, status)
	}

	s.mu.Lock()
	total := s.Total
	s.mu.Unlock()

	end := offset + limit
	if end > total {
		end = total
	}
	items := make([]map[string]any, 0, end-offset)
	for i := offset; i < end; i++ {
		id := listID(i, total)
		items = append(items, map[string]any{
			"id":          id,
			"title":       s.titleFor(id),
			"create_time": s.createFor(id),
			"update_time": s.updateTimeFor(id),
		})
	}
	out, _ := json.Marshal(map[string]any{
		"items": items,
		"total": total,
	})
	return string(out)
}

// respondConversation builds the full mapping payload for one conversation.
func (s *mockState) respondConversation(id string) (int, string) {
	s.hit("conv:" + id)

	// fault/delay config under lock; the per-id lookups lock themselves
	// (never call locking helpers while holding the mutex).
	s.mu.Lock()
	fault401 := s.fail401For == id
	malformed := s.malformedFor == id
	delay := s.convDelay[id]
	s.mu.Unlock()

	title := s.titleFor(id)
	create := s.createFor(id)
	update := s.updateTimeFor(id)

	if delay > 0 {
		time.Sleep(delay)
	}
	if fault401 {
		return http.StatusUnauthorized, `{"detail":"Unauthorized"}`
	}

	if malformed {
		return http.StatusOK, fmt.Sprintf(
			`{"conversation_id":%q,"id":%q,"title":%q,"create_time":%d,"update_time":%d,"current_node":"","mapping":{}}`,
			id, id, title, create, update)
	}

	var body string
	switch id {
	case "conv-a":
		body = richConv(id, title, create, update, []turn{
			{"n1", "", "user", "How do CNI plugins route pod traffic inside a cluster?", create},
			{"n2", "n1", "assistant", "Each pod gets a virtual ethernet pair, and a CNI plugin (Calico, Cilium, flannel) programs the node's routing tables so pod IPs are routable cluster-wide. NetworkPolicy then filters that traffic per namespace. Inspect it with:\n\n```bash\nkubectl get pods -o wide\nkubectl describe node | grep -i network\n```", create + 60},
			{"n3", "n2", "user", "Thanks — and how does NetworkPolicy fit in?", update},
		})
	case "conv-b":
		body = richConv(id, title, create, update, []turn{
			{"n1", "", "user", "How do I keep my sourdough starter healthy? I think my hydration ratio is off.", create},
			{"n2", "n1", "assistant", "A healthy starter doubles within 4-8 hours of feeding. Aim for a 100% hydration ratio — equal weights of flour and water. If it smells like acetone, feed it more often.", create + 120},
		})
	case "conv-c":
		body = richConv(id, title, create, update, []turn{
			{"n1", "", "user", "Show me how to cancel a long-running goroutine cleanly.", create},
			{"n2", "n1", "assistant", "Use context cancellation:\n\n```go\nctx, cancel := context.WithCancel(context.Background())\ndefer cancel()\n```\n\nThe goroutine watches ctx.Done() and returns promptly.", create + 90},
		})
	default:
		var n int
		fmt.Sscanf(id, "gen-%d", &n)
		body = richConv(id, title, create, update, []turn{
			{"n1", "", "user", fmt.Sprintf("Question number %d about testing the archiver.", n), create},
			{"n2", "n1", "assistant", fmt.Sprintf("Answer number %d. This reply exists so the envelope has two mainline turns.", n), create + 30},
		})
	}
	return http.StatusOK, body
}

type turn struct {
	id     string
	parent string // "" for the root turn
	role   string
	text   string
	when   int64
}

// richConv renders the ChatGPT mapping tree shape normalizeConversation() walks.
func richConv(id, title string, create, update int64, turns []turn) string {
	mapping := map[string]any{}
	var last string
	for i, t := range turns {
		node := map[string]any{
			"id":     t.id,
			"parent": t.parent,
			"message": map[string]any{
				"id":     fmt.Sprintf("m%d", i+1),
				"author": map[string]string{"role": t.role},
				"create_time": t.when,
				"content": map[string]any{"content_type": "text", "parts": []string{t.text}},
				"metadata": map[string]any{},
			},
		}
		if i == 1 { // stamp a model slug on the first assistant turn
			node["message"].(map[string]any)["metadata"] = map[string]any{"model_slug": "gpt-5.3"}
		}
		mapping[t.id] = node
		last = t.id
	}
	out, _ := json.Marshal(map[string]any{
		"conversation_id": id,
		"id":              id,
		"title":           title,
		"create_time":     create,
		"update_time":     update,
		"current_node":    last,
		"mapping":         mapping,
	})
	return string(out)
}

const sessionJSON = `{"accessToken":"e2e-token","expires":"2026-12-31T00:00:00.000Z","user":{"id":"e2e-user","name":"E2E Tester","email":"e2e@test.local","picture":"data:image/gif;base64,R0lGODlhAQABAAAAACw="}}`

func deepLinkHTML(id, title string) string {
	return "<!doctype html><html><head><title>" + title + " — Mock ChatGPT</title></head>" +
		"<body style='font-family:sans-serif;padding:40px'><h1>Mock ChatGPT thread</h1>" +
		"<p>conversation id: <code>" + id + "</code></p>" +
		"<p>If you can read this, the deep link opened the right thread.</p></body></html>"
}

func jsonHeader() map[string][]string {
	return map[string][]string{"Content-Type": {"application/json"}}
}

var _ = strings.TrimSpace // keep import if unused after edits
