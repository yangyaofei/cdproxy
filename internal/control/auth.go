// 管理面（9224）鉴权闭环：区分进程内可信调用（Wails EngineService.DoRequest）
// 与外部 TCP 请求。
//
// 安全边界：
//   - 进程内调用：经 WithInternalAuth 标记 context（无法从外部 HTTP 头伪造），全路由放行。
//   - 外部 TCP 9224：
//     1. 强制回环 Host 校验（防 DNS Rebinding）。
//     2. GET /health 放行（仅返回 {"status":"ok"}，不含任何敏感信息）。
//     3. GET / 与 /static/* 交由 adminWebGuard（默认关闭 403；开启时仅静态资产，无令牌）。
//     4. 其余全部读写与状态接口（/status、/settings、/sessions*、/sources/*、/endpoints/*、
//        /integrations/*、/keeper/*、/logs/*、/shutdown 等）统一强制校验
//        Authorization: Bearer <sources.alloc_token>，彻底杜绝免鉴权获取令牌或越权操作。
package control

import (
	"context"
	"crypto/subtle"
	"net"
	"net/http"
	"strings"
)

type internalAuthCtxKey struct{}

// WithInternalAuth 标记请求来自进程内可信调用方（如 Wails EngineService.DoRequest）。
func WithInternalAuth(ctx context.Context) context.Context {
	return context.WithValue(ctx, internalAuthCtxKey{}, true)
}

func isInternalAuth(r *http.Request) bool {
	v, _ := r.Context().Value(internalAuthCtxKey{}).(bool)
	return v
}

func isLoopbackHost(rawHost string) bool {
	if rawHost == "" {
		return true
	}
	host := rawHost
	if h, _, err := net.SplitHostPort(rawHost); err == nil {
		host = h
	}
	host = strings.Trim(strings.ToLower(strings.TrimSpace(host)), "[]")
	return host == "127.0.0.1" || host == "localhost" || host == "::1"
}

// InternalHandler 返回进程内可信路由处理器（供桌面 App DoRequest 使用）。
func (c *Control) InternalHandler() http.Handler {
	base := c.Handler()
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		base.ServeHTTP(w, r.WithContext(WithInternalAuth(r.Context())))
	})
}

// externalAuthGuard 保护所有通过外部 TCP 抵达控制面的请求。
func (c *Control) externalAuthGuard(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if isInternalAuth(r) {
			next.ServeHTTP(w, r)
			return
		}
		if !isLoopbackHost(r.Host) {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "拒绝非本机 Host"})
			return
		}
		p := r.URL.Path
		if r.Method == http.MethodGet && p == "/health" {
			next.ServeHTTP(w, r)
			return
		}
		if r.Method == http.MethodGet && (p == "/" || strings.HasPrefix(p, "/static/")) {
			next.ServeHTTP(w, r)
			return
		}
		// 管理页未开放时，拒绝带浏览器 Origin 头的跨站 API 访问
		if r.Header.Get("Origin") != "" && !c.store.Get().AdminWebEnabled {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "拒绝跨站浏览器请求（请使用桌面 App 或开启浏览器管理页）"})
			return
		}
		auth := r.Header.Get("Authorization")
		token := ""
		if len(auth) > 7 && strings.EqualFold(auth[:7], "Bearer ") {
			token = strings.TrimSpace(auth[7:])
		}
		want := c.store.Get().Sources.AllocToken
		if token == "" || subtle.ConstantTimeCompare([]byte(token), []byte(want)) != 1 {
			c.log.Warn("控制面外部访问被拒（缺少或无效令牌）", "method", r.Method, "path", p, "remote", r.RemoteAddr)
			writeJSON(w, http.StatusUnauthorized, map[string]string{
				"error": "缺少或无效的管理令牌（Authorization: Bearer <alloc_token>）",
			})
			return
		}
		next.ServeHTTP(w, r)
	})
}
