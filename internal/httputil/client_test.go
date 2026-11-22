package httputil

import (
	"context"
	"crypto/x509"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

func TestNewDownloadClient_NoTotalTimeoutAndSetsUA(t *testing.T) {
	var gotUA string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotUA = r.Header.Get("User-Agent")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	}))
	defer srv.Close()

	c := NewDownloadClient(DownloadClientOptions{UserAgent: "cdproxy/0.12.1"})
	if c.Timeout != 0 {
		t.Fatalf("expected Client.Timeout == 0 to avoid mid-download aborts, got %v", c.Timeout)
	}

	resp, err := c.Get(srv.URL)
	if err != nil {
		t.Fatalf("GET failed: %v", err)
	}
	defer resp.Body.Close()
	if gotUA != "cdproxy/0.12.1" {
		t.Fatalf("expected User-Agent cdproxy/0.12.1, got %q", gotUA)
	}
}

func TestNewDownloadClient_Retries429And503ThenSucceeds(t *testing.T) {
	var attempts atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		n := attempts.Add(1)
		switch n {
		case 1:
			w.Header().Set("Retry-After", "0")
			w.WriteHeader(http.StatusTooManyRequests)
		case 2:
			w.WriteHeader(http.StatusServiceUnavailable)
		default:
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte("payload"))
		}
	}))
	defer srv.Close()

	c := NewDownloadClient(DownloadClientOptions{
		MaxRetries:   3,
		BaseBackoff:  5 * time.Millisecond,
		MaxRetryWait: 50 * time.Millisecond,
	})

	resp, err := c.Get(srv.URL)
	if err != nil {
		t.Fatalf("GET failed: %v", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK || string(body) != "payload" {
		t.Fatalf("unexpected response: status=%d body=%q", resp.StatusCode, string(body))
	}
	if got := attempts.Load(); got != 3 {
		t.Fatalf("expected 3 attempts, got %d", got)
	}
}

func TestNewDownloadClient_ReturnsLast429AfterExhaustingRetries(t *testing.T) {
	var attempts atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		attempts.Add(1)
		w.WriteHeader(http.StatusTooManyRequests)
	}))
	defer srv.Close()

	c := NewDownloadClient(DownloadClientOptions{
		MaxRetries:   2,
		BaseBackoff:  5 * time.Millisecond,
		MaxRetryWait: 20 * time.Millisecond,
	})

	resp, err := c.Get(srv.URL)
	if err != nil {
		t.Fatalf("GET returned error instead of 429 response: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusTooManyRequests {
		t.Fatalf("expected 429, got %d", resp.StatusCode)
	}
	if got := attempts.Load(); got != 3 {
		t.Fatalf("expected 1 initial + 2 retries = 3 attempts, got %d", got)
	}
}

func TestNewDownloadClient_DoesNotRetryNonRetryableStatusOrPost(t *testing.T) {
	var attempts atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		attempts.Add(1)
		if r.Method == http.MethodPost {
			w.WriteHeader(http.StatusTooManyRequests)
			return
		}
		w.WriteHeader(http.StatusNotFound)
	}))
	defer srv.Close()

	c := NewDownloadClient(DownloadClientOptions{
		MaxRetries:  3,
		BaseBackoff: 5 * time.Millisecond,
	})

	resp, err := c.Get(srv.URL)
	if err != nil {
		t.Fatalf("GET 404 failed: %v", err)
	}
	resp.Body.Close()
	if attempts.Load() != 1 {
		t.Fatalf("expected no retry on 404, got %d attempts", attempts.Load())
	}

	attempts.Store(0)
	resp, err = c.Post(srv.URL, "application/json", nil)
	if err != nil {
		t.Fatalf("POST failed: %v", err)
	}
	resp.Body.Close()
	if attempts.Load() != 1 {
		t.Fatalf("expected no retry on POST, got %d attempts", attempts.Load())
	}
}

type stubRoundTripper struct {
	fn func(*http.Request) (*http.Response, error)
}

func (s stubRoundTripper) RoundTrip(r *http.Request) (*http.Response, error) { return s.fn(r) }

func TestNewDownloadClient_RetriesTransientEOFAndStopsOnCertErr(t *testing.T) {
	var attempts atomic.Int32
	c := NewDownloadClient(DownloadClientOptions{
		MaxRetries:  2,
		BaseBackoff: 5 * time.Millisecond,
		BaseTransport: stubRoundTripper{fn: func(_ *http.Request) (*http.Response, error) {
			if attempts.Add(1) == 1 {
				return nil, io.ErrUnexpectedEOF
			}
			return &http.Response{
				StatusCode: http.StatusOK,
				Header:     make(http.Header),
				Body:       io.NopCloser(http.NoBody),
			}, nil
		}},
	})
	resp, err := c.Get("https://example.invalid/test")
	if err != nil {
		t.Fatalf("expected recovery after transient EOF, got %v", err)
	}
	resp.Body.Close()
	if attempts.Load() != 2 {
		t.Fatalf("expected 2 attempts, got %d", attempts.Load())
	}

	attempts.Store(0)
	cCert := NewDownloadClient(DownloadClientOptions{
		MaxRetries:  3,
		BaseBackoff: 5 * time.Millisecond,
		BaseTransport: stubRoundTripper{fn: func(_ *http.Request) (*http.Response, error) {
			attempts.Add(1)
			return nil, x509.UnknownAuthorityError{}
		}},
	})
	if _, err := cCert.Get("https://example.invalid/cert"); err == nil {
		t.Fatal("expected cert error")
	}
	if attempts.Load() != 1 {
		t.Fatalf("expected no retry on x509 error, got %d attempts", attempts.Load())
	}
}

func TestNewDownloadClient_RespectsContextCancelDuringBackoff(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Retry-After", "60")
		w.WriteHeader(http.StatusTooManyRequests)
	}))
	defer srv.Close()

	c := NewDownloadClient(DownloadClientOptions{
		MaxRetries:   3,
		BaseBackoff:  5 * time.Second,
		MaxRetryWait: 30 * time.Second,
	})
	ctx, cancel := context.WithTimeout(context.Background(), 40*time.Millisecond)
	defer cancel()

	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, srv.URL, nil)
	start := time.Now()
	_, err := c.Do(req)
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("expected context.DeadlineExceeded, got %v", err)
	}
	if time.Since(start) > time.Second {
		t.Fatalf("context cancel took too long: %v", time.Since(start))
	}
}

func TestParseRetryAfter(t *testing.T) {
	now := time.Date(2026, 11, 22, 18, 0, 0, 0, time.UTC)
	if d, ok := parseRetryAfter("5", now); !ok || d != 5*time.Second {
		t.Fatalf("delta-seconds parse failed: d=%v ok=%v", d, ok)
	}
	if _, ok := parseRetryAfter("0", now); ok {
		t.Fatal("expected 0 seconds to return ok=false")
	}
	future := now.Add(12 * time.Second).Format(http.TimeFormat)
	if d, ok := parseRetryAfter(future, now); !ok || d != 12*time.Second {
		t.Fatalf("http-date parse failed: d=%v ok=%v", d, ok)
	}
	past := now.Add(-5 * time.Second).Format(http.TimeFormat)
	if _, ok := parseRetryAfter(past, now); ok {
		t.Fatal("expected past http-date to return ok=false")
	}
}
