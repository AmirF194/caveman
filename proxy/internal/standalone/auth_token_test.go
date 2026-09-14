package standalone

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/JuliusBrussee/caveman/proxy/internal/config"
)

// authToken is a realistic 32-byte operator secret: long enough to pass
// config.validateAuthToken, distinctive enough that any header carrying it
// upstream is unmistakable in the assertions below.
const authToken = "cave_tok_0123456789abcdef012345"

// anthropicStubResponse is the minimum Messages shape the usage parser accepts,
// so these tests fail on headers and status only — never on metering.
const anthropicStubResponse = `{"id":"msg_stub","type":"message","model":"claude-sonnet-4-6","content":[],"usage":{"input_tokens":10,"output_tokens":1}}`

// newTokenGatedServer builds a standalone server whose inbound gate is the shared
// token, pointed at a capturing upstream. A nil sink is deliberate: these tests
// assert on the forwarded request, and the gateway skips recording without one.
func newTokenGatedServer(t *testing.T, token string) (http.Handler, *captureUpstreamTransport) {
	t.Helper()
	upstream := &captureUpstreamTransport{response: anthropicStubResponse}
	cfg := config.Config{
		Mode:      "record",
		AuthToken: token,
		Providers: map[string]config.ProviderConfig{"anthropic": {BaseURL: "https://upstream.test"}},
	}
	srv := New(cfg, nil, Options{HTTPClient: &http.Client{Transport: upstream}})
	return srv.Handler(), upstream
}

func postMessages(t *testing.T, handler http.Handler, headers map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/v1/messages", strings.NewReader(`{"model":"claude-sonnet-4-6","max_tokens":16,"messages":[{"role":"user","content":"hi"}]}`))
	for name, value := range headers {
		req.Header.Set(name, value)
	}
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	return rec
}

// assertUpstreamNeverSawToken is the whole point of the header deletion: the
// operator's shared secret is not a provider credential and must not reach one.
func assertUpstreamNeverSawToken(t *testing.T, upstream *captureUpstreamTransport) {
	t.Helper()
	for name, values := range upstream.headers {
		for _, value := range values {
			if strings.Contains(value, authToken) {
				t.Fatalf("upstream header %s carried the inbound token: %q", name, value)
			}
		}
	}
}

func TestAuthToken_RejectsRequestWithoutToken(t *testing.T) {
	handler, _ := newTokenGatedServer(t, authToken)
	rec := postMessages(t, handler, nil)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401 (body %s)", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "cave_unauthorized") {
		t.Fatalf("body = %s, want cave_unauthorized", rec.Body.String())
	}
}

func TestAuthToken_AcceptsCaveAPIKeyAndStripsIt(t *testing.T) {
	handler, upstream := newTokenGatedServer(t, authToken)
	rec := postMessages(t, handler, map[string]string{"x-cave-api-key": authToken, "x-api-key": "sk-ant-client"})
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body %s)", rec.Code, rec.Body.String())
	}
	if got := upstream.headers.Get("x-cave-api-key"); got != "" {
		t.Fatalf("upstream saw x-cave-api-key = %q, want it consumed at the proxy", got)
	}
	assertUpstreamNeverSawToken(t, upstream)
}

func TestAuthToken_AcceptsBearerAndFallsBackToOperatorKey(t *testing.T) {
	t.Setenv("ANTHROPIC_API_KEY", "sk-ant-env")
	handler, upstream := newTokenGatedServer(t, authToken)
	rec := postMessages(t, handler, map[string]string{"Authorization": "Bearer " + authToken})
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body %s)", rec.Code, rec.Body.String())
	}
	// The bearer held the shared token, so it was consumed; the request reaches
	// the provider on the operator's BYOK key, not on the inbound secret.
	if got := upstream.headers.Get("x-api-key"); got != "sk-ant-env" {
		t.Fatalf("upstream x-api-key = %q, want the BYOK env key", got)
	}
	assertUpstreamNeverSawToken(t, upstream)
}

func TestAuthToken_InboundProviderKeyStillWinsOverBYOK(t *testing.T) {
	t.Setenv("ANTHROPIC_API_KEY", "sk-ant-env")
	handler, upstream := newTokenGatedServer(t, authToken)
	rec := postMessages(t, handler, map[string]string{"Authorization": "Bearer " + authToken, "x-api-key": "sk-ant-client"})
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body %s)", rec.Code, rec.Body.String())
	}
	if got := upstream.headers.Get("x-api-key"); got != "sk-ant-client" {
		t.Fatalf("upstream x-api-key = %q, want the caller's own key", got)
	}
	assertUpstreamNeverSawToken(t, upstream)
}

func TestAuthToken_RejectsWrongTokenInEitherHeader(t *testing.T) {
	for name, headers := range map[string]map[string]string{
		"x-cave-api-key": {"x-cave-api-key": authToken + "-wrong"},
		"bearer":         {"Authorization": "Bearer " + authToken + "-wrong"},
	} {
		t.Run(name, func(t *testing.T) {
			handler, _ := newTokenGatedServer(t, authToken)
			rec := postMessages(t, handler, headers)
			if rec.Code != http.StatusUnauthorized {
				t.Fatalf("status = %d, want 401 (body %s)", rec.Code, rec.Body.String())
			}
			if !strings.Contains(rec.Body.String(), "cave_unauthorized") {
				t.Fatalf("body = %s, want cave_unauthorized", rec.Body.String())
			}
		})
	}
}

// TestAuthToken_HealthStaysUnauthenticated: a load balancer in front of a
// VPC-bound proxy probes readiness without holding the operator's secret.
func TestAuthToken_HealthStaysUnauthenticated(t *testing.T) {
	handler, _ := newTokenGatedServer(t, authToken)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/health/ready", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body %s)", rec.Code, rec.Body.String())
	}
}

func TestAuthToken_EmptyTokenKeepsLoopbackBehavior(t *testing.T) {
	t.Setenv("ANTHROPIC_API_KEY", "sk-ant-env")
	handler, upstream := newTokenGatedServer(t, "")
	rec := postMessages(t, handler, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body %s)", rec.Code, rec.Body.String())
	}
	if got := upstream.headers.Get("x-api-key"); got != "sk-ant-env" {
		t.Fatalf("upstream x-api-key = %q, want the BYOK env key", got)
	}
}

// TestAuthToken_PreservesForeignBearer is the credential-safety case: an
// Authorization header that is NOT the shared token is a real provider OAuth
// credential and must survive the gate untouched.
func TestAuthToken_PreservesForeignBearer(t *testing.T) {
	const oauth = "sk-ant-oat01-operator-oauth-token"
	handler, upstream := newTokenGatedServer(t, authToken)
	rec := postMessages(t, handler, map[string]string{
		"x-cave-api-key": authToken,
		"Authorization":  "Bearer " + oauth,
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body %s)", rec.Code, rec.Body.String())
	}
	if got := upstream.headers.Get("Authorization"); got != "Bearer "+oauth {
		t.Fatalf("upstream Authorization = %q, want the caller's OAuth bearer preserved", got)
	}
	assertUpstreamNeverSawToken(t, upstream)
}

// A client that hedges and sends the token in BOTH headers must still have it
// consumed from Authorization: an early return on the x-cave-api-key match
// left the bearer in place, and every adapter forwards Authorization.
func TestAuthToken_ConsumesTokenFromBothHeaders(t *testing.T) {
	t.Setenv("ANTHROPIC_API_KEY", "sk-ant-env")
	handler, upstream := newTokenGatedServer(t, authToken)
	rec := postMessages(t, handler, map[string]string{"x-cave-api-key": authToken, "Authorization": "Bearer " + authToken})
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body %s)", rec.Code, rec.Body.String())
	}
	if got := upstream.headers.Get("Authorization"); got != "" {
		t.Fatalf("upstream Authorization = %q, want the token-bearing header consumed", got)
	}
	if got := upstream.headers.Get("x-api-key"); got != "sk-ant-env" {
		t.Fatalf("upstream x-api-key = %q, want the operator key once both token headers are consumed", got)
	}
	assertUpstreamNeverSawToken(t, upstream)
}
