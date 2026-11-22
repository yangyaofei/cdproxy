// Package httputil 提供面向下载与版本检查的共享 HTTP 客户端。
//
// 核心契约：
//   - 绝不在 http.Client.Timeout 上设置整包传输总超时（Timeout 恒为 0），避免大文件
//     下载在中途被强杀；改为在 Transport 上拆设建连、TLS 握手、响应头阶段超时，由调用方
//     context 控制整体生命周期。
//   - 统一注入显式 User-Agent，避免匿名请求暴露默认 Go-http-client 指纹。
//   - 对 GET/HEAD 请求遇到的瞬时限流与网关故障（HTTP 429/502/503/504 及可恢复网络抖动）
//     自动按 Retry-After 或指数退避重试；重试耗尽后原样返回最后一次响应或错误，便于上层
//     向用户透出准确原因。
package httputil

import (
	"context"
	"crypto/x509"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

const (
	// DefaultUserAgent 未显式指定 User-Agent 时的默认值。
	DefaultUserAgent = "cdproxy"
	// DefaultMaxRetries 默认最大重试次数（不含首次请求）。
	DefaultMaxRetries = 3
	// DefaultBaseBackoff 指数退避基准间隔（1s → 2s → 4s）。
	DefaultBaseBackoff = 1 * time.Second
	// DefaultMaxRetryWait 单次重试等待上限，防止异常 Retry-After 长时间阻塞。
	DefaultMaxRetryWait = 30 * time.Second
	// DefaultDialTimeout 默认 TCP 建连超时。
	DefaultDialTimeout = 15 * time.Second
	// DefaultTLSHandshakeTimeout 默认 TLS 握手超时。
	DefaultTLSHandshakeTimeout = 15 * time.Second
	// DefaultResponseHeaderTimeout 默认等待响应头超时。
	DefaultResponseHeaderTimeout = 30 * time.Second

	maxDrainBytes = 64 * 1024
)

// DownloadClientOptions 下载与检查用 HTTP 客户端构造参数。
type DownloadClientOptions struct {
	UserAgent             string
	MaxRetries            int // 0 使用 DefaultMaxRetries；<0 禁用重试
	BaseBackoff           time.Duration
	MaxRetryWait          time.Duration
	DialTimeout           time.Duration
	TLSHandshakeTimeout   time.Duration
	ResponseHeaderTimeout time.Duration
	BaseTransport         http.RoundTripper
	CheckRedirect         func(req *http.Request, via []*http.Request) error
}

// NewDownloadClient 构造拆分阶段超时、带退避重试与显式 UA 的 *http.Client。
// 返回的 Client.Timeout 始终为 0，整次下载时长由请求 context 控制。
func NewDownloadClient(opts DownloadClientOptions) *http.Client {
	ua := strings.TrimSpace(opts.UserAgent)
	if ua == "" {
		ua = DefaultUserAgent
	}
	maxRetries := opts.MaxRetries
	if maxRetries == 0 {
		maxRetries = DefaultMaxRetries
	} else if maxRetries < 0 {
		maxRetries = 0
	}
	baseBackoff := opts.BaseBackoff
	if baseBackoff <= 0 {
		baseBackoff = DefaultBaseBackoff
	}
	maxRetryWait := opts.MaxRetryWait
	if maxRetryWait <= 0 {
		maxRetryWait = DefaultMaxRetryWait
	}
	dialTimeout := opts.DialTimeout
	if dialTimeout <= 0 {
		dialTimeout = DefaultDialTimeout
	}
	tlsTimeout := opts.TLSHandshakeTimeout
	if tlsTimeout <= 0 {
		tlsTimeout = DefaultTLSHandshakeTimeout
	}
	hdrTimeout := opts.ResponseHeaderTimeout
	if hdrTimeout <= 0 {
		hdrTimeout = DefaultResponseHeaderTimeout
	}

	base := opts.BaseTransport
	if base == nil {
		base = &http.Transport{
			Proxy: http.ProxyFromEnvironment,
			DialContext: (&net.Dialer{
				Timeout:   dialTimeout,
				KeepAlive: 30 * time.Second,
			}).DialContext,
			ForceAttemptHTTP2:     true,
			MaxIdleConns:          16,
			IdleConnTimeout:       90 * time.Second,
			TLSHandshakeTimeout:   tlsTimeout,
			ResponseHeaderTimeout: hdrTimeout,
			ExpectContinueTimeout: 1 * time.Second,
		}
	}

	return &http.Client{
		Transport: &retryRoundTripper{
			base:         base,
			userAgent:    ua,
			maxRetries:   maxRetries,
			baseBackoff:  baseBackoff,
			maxRetryWait: maxRetryWait,
			now:          time.Now,
		},
		Timeout:       0,
		CheckRedirect: opts.CheckRedirect,
	}
}

type retryRoundTripper struct {
	base         http.RoundTripper
	userAgent    string
	maxRetries   int
	baseBackoff  time.Duration
	maxRetryWait time.Duration
	now          func() time.Time
}

func (rt *retryRoundTripper) RoundTrip(req *http.Request) (*http.Response, error) {
	canRetry := (req.Method == http.MethodGet || req.Method == http.MethodHead) &&
		(req.Body == nil || req.GetBody != nil)

	for attempt := 0; ; attempt++ {
		cloned := req.Clone(req.Context())
		if cloned.Header.Get("User-Agent") == "" {
			cloned.Header.Set("User-Agent", rt.userAgent)
		}
		if attempt > 0 && req.GetBody != nil {
			body, err := req.GetBody()
			if err != nil {
				return nil, err
			}
			cloned.Body = body
		}

		resp, err := rt.base.RoundTrip(cloned)
		if err != nil {
			if !canRetry || attempt >= rt.maxRetries || req.Context().Err() != nil || !isRetryableErr(err) {
				return nil, err
			}
			if waitErr := sleepWithContext(req.Context(), rt.backoff(attempt, "")); waitErr != nil {
				return nil, waitErr
			}
			continue
		}

		if !isRetryableStatus(resp.StatusCode) || !canRetry || attempt >= rt.maxRetries {
			return resp, nil
		}

		retryAfter := resp.Header.Get("Retry-After")
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, maxDrainBytes))
		_ = resp.Body.Close()

		if waitErr := sleepWithContext(req.Context(), rt.backoff(attempt, retryAfter)); waitErr != nil {
			return nil, waitErr
		}
	}
}

func (rt *retryRoundTripper) backoff(attempt int, retryAfter string) time.Duration {
	if d, ok := parseRetryAfter(retryAfter, rt.now()); ok {
		if d > rt.maxRetryWait {
			return rt.maxRetryWait
		}
		return d
	}
	wait := rt.baseBackoff << attempt
	if wait <= 0 || wait > rt.maxRetryWait {
		return rt.maxRetryWait
	}
	return wait
}

func isRetryableStatus(code int) bool {
	switch code {
	case http.StatusTooManyRequests,
		http.StatusBadGateway,
		http.StatusServiceUnavailable,
		http.StatusGatewayTimeout:
		return true
	default:
		return false
	}
}

func isRetryableErr(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return false
	}
	var unknownAuth x509.UnknownAuthorityError
	var hostErr x509.HostnameError
	var certInvalid x509.CertificateInvalidError
	if errors.As(err, &unknownAuth) || errors.As(err, &hostErr) || errors.As(err, &certInvalid) {
		return false
	}
	if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) {
		return true
	}
	var netErr net.Error
	if errors.As(err, &netErr) {
		return true
	}
	var urlErr *url.Error
	if errors.As(err, &urlErr) {
		return isRetryableErr(urlErr.Err)
	}
	return false
}

func parseRetryAfter(val string, now time.Time) (time.Duration, bool) {
	v := strings.TrimSpace(val)
	if v == "" {
		return 0, false
	}
	if secs, err := strconv.Atoi(v); err == nil {
		if secs <= 0 {
			return 0, false
		}
		return time.Duration(secs) * time.Second, true
	}
	if t, err := http.ParseTime(v); err == nil {
		d := t.Sub(now)
		if d <= 0 {
			return 0, false
		}
		return d, true
	}
	return 0, false
}

func sleepWithContext(ctx context.Context, d time.Duration) error {
	if d <= 0 {
		return ctx.Err()
	}
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}
