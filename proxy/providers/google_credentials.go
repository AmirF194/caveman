package providers

import (
	"errors"
	"net/http"
	"net/url"
	"strings"
)

// ErrGoogleRequestCredentials contains no caller values and is safe to return
// when equivalent Google authentication inputs disagree or are malformed.
var ErrGoogleRequestCredentials = errors.New("Google request credentials are invalid or conflicting")

// GoogleRequestAPIKey resolves the native header and Google's equivalent key
// system parameters. The legacy x-api-key alias remains lower priority than
// the native header; conflicting URL credentials never silently select an account.
func GoogleRequestAPIKey(req *http.Request) (string, error) {
	key := strings.TrimSpace(req.Header.Get("x-goog-api-key"))
	if key == "" {
		key = strings.TrimSpace(req.Header.Get("x-api-key"))
	}
	if strings.ContainsAny(key, "\r\n") {
		return "", ErrGoogleRequestCredentials
	}
	for _, part := range strings.Split(req.URL.RawQuery, "&") {
		name, value, _ := strings.Cut(part, "=")
		name, _ = url.QueryUnescape(name)
		if name != "key" && name != "$key" {
			continue
		}
		value, err := url.QueryUnescape(value)
		if err != nil || strings.ContainsAny(value, "\r\n") {
			return "", ErrGoogleRequestCredentials
		}
		value = strings.TrimSpace(value)
		if value == "" {
			continue
		}
		if key != "" && key != value {
			return "", ErrGoogleRequestCredentials
		}
		key = value
	}
	return key, nil
}

// WithoutGoogleAPIKeyQuery removes only authentication parameters. Other query
// bytes and their order remain unchanged, including repeated parameters.
func WithoutGoogleAPIKeyQuery(rawQuery string) string {
	parts := strings.Split(rawQuery, "&")
	kept := parts[:0]
	for _, part := range parts {
		name, _, _ := strings.Cut(part, "=")
		name, _ = url.QueryUnescape(name)
		if name != "key" && name != "$key" {
			kept = append(kept, part)
		}
	}
	return strings.Join(kept, "&")
}
