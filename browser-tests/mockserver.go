// mockserver.go — a local TLS server standing in for chatgpt.com.
//
// Why a server instead of rod's hijack router: the page context's fetches are
// interceptable via CDP, but the BACKGROUND SERVICE WORKER's fetches are NOT
// (CDP Fetch domain does not cover service-worker targets). transport.js falls
// back to the SW whenever a direct fetch fails, so fault-injection tests (401/
// 403) were nondeterministic — the SW hit the real chatgpt.com. Solution:
// point the browser's DNS at 127.0.0.1 (host-resolver-rules) and serve HTTPS
// with a self-signed cert (ignore-certificate-errors). Now BOTH the panel and
// the SW talk to the same deterministic fixture source.
package e2e

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"fmt"
	"math/big"
	"net"
	"net/http"
	"strings"
	"sync/atomic"
	"time"
)

var (
	mockPort    atomic.Int32
	serverState atomic.Pointer[mockState]
	started     atomic.Bool
)

func setMockState(s *mockState) { serverState.Store(s) }

func currentState() *mockState {
	if s := serverState.Load(); s != nil {
		return s
	}
	return newMockState(0)
}

// startMockServer binds 127.0.0.1:443 (fallback 8443) with a self-signed cert.
func startMockServer() (int, error) {
	cert, err := selfSignedCert()
	if err != nil {
		return 0, err
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/api/auth/session", func(w http.ResponseWriter, r *http.Request) {
		currentState().hit("session")
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, sessionJSON)
	})
	mux.HandleFunc("/backend-api/conversations", func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		state := currentState()
		state.hit("list") // counted once per request (A-01/A-06/A-07 assertions)
		code, retryAfter, body := state.respondList(atoiDefault(q.Get("offset"), 0), atoiDefault(q.Get("limit"), 50))
		w.Header().Set("Content-Type", "application/json")
		if retryAfter != "" {
			w.Header().Set("Retry-After", retryAfter)
		}
		w.WriteHeader(code)
		fmt.Fprint(w, body)
	})
	mux.HandleFunc("/backend-api/conversation/", func(w http.ResponseWriter, r *http.Request) {
		id := r.URL.Path[strings.LastIndex(r.URL.Path, "/")+1:]
		state := currentState()
		code, body := state.respondConversation(id)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(code)
		fmt.Fprint(w, body)
	})
	mux.HandleFunc("/c/", func(w http.ResponseWriter, r *http.Request) {
		id := strings.TrimRight(r.URL.Path, "/")
		id = id[strings.LastIndex(id, "/")+1:]
		state := currentState()
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		fmt.Fprint(w, deepLinkHTML(id, state.titleFor(id)))
	})
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(404)
		fmt.Fprintf(w, `{"detail":"mock: no route for %s"}`, r.URL.Path)
	})

	srv := &http.Server{
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
		TLSConfig:         &tls.Config{Certificates: []tls.Certificate{*cert}},
	}

	for _, port := range []int{443, 8443, 9443} {
		ln, err := net.Listen("tcp", net.JoinHostPort("127.0.0.1", fmt.Sprint(port)))
		if err != nil {
			continue
		}
		mockPort.Store(int32(port))
		go func(l net.Listener, s *http.Server) {
			for {
				conn, err := l.Accept()
				if err != nil {
					return
				}
				tlsConn := tls.Server(conn, s.TLSConfig)
				go s.Serve(&singleConnListener{conn: tlsConn})
			}
		}(ln, srv)
		started.Store(true)
		return port, nil
	}
	return 0, fmt.Errorf("could not bind any mock port")
}

// singleConnListener feeds one accepted (already-TLS) connection to http.Server.
type singleConnListener struct {
	conn net.Conn
	done atomic.Bool
}

func (l *singleConnListener) Accept() (net.Conn, error) {
	if l.done.Swap(true) {
		return nil, net.ErrClosed
	}
	return l.conn, nil
}

func (l *singleConnListener) Close() error   { return nil }
func (l *singleConnListener) Addr() net.Addr { return l.conn.LocalAddr() }

func selfSignedCert() (*tls.Certificate, error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, err
	}
	tmpl := x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{CommonName: "chatgpt.com"},
		DNSNames:              []string{"chatgpt.com", "localhost"},
		NotBefore:             time.Now().Add(-24 * time.Hour),
		NotAfter:              time.Now().Add(24 * time.Hour),
		KeyUsage:              x509.KeyUsageKeyEncipherment | x509.KeyUsageDigitalSignature | x509.KeyUsageCertSign,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		BasicConstraintsValid: true,
		IsCA:                  true,
	}
	der, err := x509.CreateCertificate(rand.Reader, &tmpl, &tmpl, &key.PublicKey, key)
	if err != nil {
		return nil, err
	}
	return &tls.Certificate{
		Certificate: [][]byte{der},
		PrivateKey:  key,
	}, nil
}
