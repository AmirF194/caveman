package main

import (
	"bytes"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/JuliusBrussee/caveman/proxy/internal/runstate"
)

// A config that does not load says nothing about the listener. Reporting the
// state of DefaultListen instead would answer for some other port, and doing it
// silently hides the very error the operator is debugging (a typo'd
// CAVE_UPSTREAM_PROXY is now a load failure).
func TestRunStatus_UnloadableConfigIsUnknownAndLogged(t *testing.T) {
	home := t.TempDir()
	config := filepath.Join(home, "caveman.yaml")
	if err := os.WriteFile(config, []byte("listen: 127.0.0.1:8787\nupstream_proxy: ftp://proxy.corp.example:21\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CAVEMAN_HOME", home)
	t.Setenv("CAVEMAN_CONFIG", config)

	var logs bytes.Buffer
	logger := slog.New(slog.NewTextHandler(&logs, nil))
	out := captureStdout(t, func() { runStatus(logger, nil) })

	var state map[string]any
	if err := json.Unmarshal([]byte(out), &state); err != nil {
		t.Fatalf("status output %q: %v", out, err)
	}
	if state["owner"] != "unknown" {
		t.Fatalf("status = %v, want owner unknown", state)
	}
	if !strings.Contains(logs.String(), "cannot load caveman.yaml") {
		t.Fatalf("config error was swallowed: %q", logs.String())
	}
}

func TestInstanceIdentityIsPublishedOnlyOnHealth(t *testing.T) {
	const token = "local-instance-token"
	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get(runstate.InstanceHeader) != "" {
			t.Error("response identity was injected into the provider request")
		}
		w.WriteHeader(http.StatusOK)
	})
	handler := withInstanceIdentity(next, token)
	for _, tt := range []struct {
		method, path string
		wantIdentity bool
	}{
		{http.MethodGet, "/health/live", true},
		{http.MethodGet, "/health/ready", false},
		{http.MethodPost, "/health/live", false},
		{http.MethodPost, "/v1/messages", false},
		{http.MethodPost, "/w/pi/openai/v1/chat/completions", false},
	} {
		t.Run(tt.method+" "+tt.path, func(t *testing.T) {
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, httptest.NewRequest(tt.method, tt.path, nil))
			want := ""
			if tt.wantIdentity {
				want = token
				if response.Header().Get("Cache-Control") != "no-store" {
					t.Fatal("identity response may be cached across listener generations")
				}
			}
			if got := response.Header().Get(runstate.InstanceHeader); got != want {
				t.Fatalf("identity header = %q, want %q", got, want)
			}
		})
	}
}

func TestRunStatusRequiresThisListenerGeneration(t *testing.T) {
	for _, matching := range []bool{false, true} {
		t.Run(strconv.FormatBool(matching), func(t *testing.T) {
			home := t.TempDir()
			t.Setenv("CAVEMAN_HOME", home)
			const listenerToken = "live-listener-token"
			server := httptest.NewServer(withInstanceIdentity(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(http.StatusOK)
			}), listenerToken))
			defer server.Close()
			state, err := runstate.New(strings.TrimPrefix(server.URL, "http://"), "record", "start", "test")
			if err != nil {
				t.Fatal(err)
			}
			if matching {
				state.InstanceToken = listenerToken
			}
			state.ProviderUpstreams = map[string]string{"openai": "https://api.openai.com"}
			if err := runstate.Write(home, state); err != nil {
				t.Fatal(err)
			}
			// The test process is named caveman-proxy.test, so it passes the real
			// executable/liveness checks. Only the listener token distinguishes
			// this generation from a stale file naming the same live process.
			out := captureStdout(t, func() {
				runStatus(slog.New(slog.NewTextHandler(io.Discard, nil)), []string{"--port", strconv.Itoa(state.Port)})
			})
			var got runstate.PublicState
			if err := json.Unmarshal([]byte(out), &got); err != nil {
				t.Fatal(err)
			}
			if matching {
				if got.Owner != "start" || got.InstanceToken != listenerToken || got.ProviderUpstreams["openai"] != "https://api.openai.com" {
					t.Fatalf("matching listener did not publish its route: %s", out)
				}
			} else if got.Owner != "unknown" || got.InstanceToken != "" || len(got.ProviderUpstreams) != 0 {
				t.Fatalf("stale listener identity authorized routing: %s", out)
			}
		})
	}
}

func captureStdout(t *testing.T, fn func()) string {
	t.Helper()
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	previous := os.Stdout
	os.Stdout = w
	fn()
	os.Stdout = previous
	_ = w.Close()
	out, err := io.ReadAll(r)
	if err != nil {
		t.Fatal(err)
	}
	return string(out)
}
