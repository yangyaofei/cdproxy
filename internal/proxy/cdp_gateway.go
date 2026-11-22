// 标准 CDP HTTP 发现与 WebSocket 统一网关。
//
// 纯路径语法（支持 http:// 发现与 ws:// 直连，零 query 依赖）：
//
//	[ /standalone | /extension ] [ /session/<id> ] [ /<token> ] [ /json/version[/] | /json/list[/] | /json[/] ]
//
// 鉴权与路由规则：
//   - Token 支持 Authorization: Bearer <token> 或 URL 末尾 /<token>（两者等价；同时出现须一致）。
//   - Token 反向映射到唯一 Endpoint（default / standalone / extension / 自定义固定会话）。
//   - 若 URL 含源前缀（/standalone 或 /extension），必须与 Token 归属源严格匹配（越权 403）。
//   - 若 Token 绑定了固定会话（自定义入口或显式配置了 session），则只允许访问该会话（越权 403）。
//   - 内置入口未指定 /session/<id> 时，每条连接自动分配唯一会话（1 WS = 1 独立虚拟 Chrome）。
//   - HTTP /json/version 无状态返回对应 webSocketDebuggerUrl（Header 鉴权不回显 token，URL 鉴权附带 token）。
//   - 遵循 Chrome 原生安全防线：仅放行本机回环 Host（防 DNS Rebinding）并拒绝带 Origin 头的网页跨站请求。
package proxy

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"strings"

	"github.com/coder/websocket"
	"github.com/yangyaofei/cdproxy/internal/settings"
)

const (
	cdpKindWS      = "ws"
	cdpKindVersion = "version"
	cdpKindList    = "list"
)

// cdpRoute 解析后的标准 CDP 请求结构。
type cdpRoute struct {
	Kind            string   // ws | version | list
	PathSrc         string   // "" | standalone | extension
	ExplicitDefault bool     // URL 显式写了 /default 前缀
	Session         string   // URL /session/<id> 指定的会话名
	Tail            []string // 剩余尾部段（0~2 段：无 / token 或旧自定义路径 / 旧自定义路径+token）
}

// cdpAuthResult 鉴权与作用域校验通过后的决议。
type cdpAuthResult struct {
	Endpoint       settings.Endpoint
	Token          string
	ViaHeader      bool
	ExplicitSource string // "" = 跟随 routing.rules > default_source；否则为 standalone|extension
	Session        string // "" = 动态分配新会话；非空 = 绑定/复用指定会话
}

// parseCDPPath 将纯路径解析为 cdpRoute。
func parseCDPPath(rawPath string) (cdpRoute, int, string) {
	var route cdpRoute
	p := strings.TrimRight(rawPath, "/")
	switch {
	case p == "/json/version" || strings.HasSuffix(p, "/json/version"):
		route.Kind = cdpKindVersion
		p = strings.TrimSuffix(p, "/json/version")
	case p == "/json/list" || strings.HasSuffix(p, "/json/list"):
		route.Kind = cdpKindList
		p = strings.TrimSuffix(p, "/json/list")
	case p == "/json" || strings.HasSuffix(p, "/json"):
		route.Kind = cdpKindList
		p = strings.TrimSuffix(p, "/json")
	default:
		route.Kind = cdpKindWS
	}

	var segs []string
	for _, s := range strings.Split(p, "/") {
		if s != "" {
			segs = append(segs, s)
		}
	}

	i := 0
	if i < len(segs) {
		switch segs[i] {
		case settings.SourceStandalone, settings.SourceExtension:
			route.PathSrc = segs[i]
			i++
		case "default":
			route.ExplicitDefault = true
			i++
		}
	}
	if i < len(segs) && segs[i] == "session" {
		if i+1 >= len(segs) {
			return cdpRoute{}, http.StatusBadRequest, "路径缺少会话名（/session/<id>）"
		}
		route.Session = segs[i+1]
		i += 2
	}

	rem := segs[i:]
	switch len(rem) {
	case 0, 1:
		route.Tail = rem
	case 2:
		// 向后兼容旧自定义接入点：/{customPath}/{token}
		if route.PathSrc == "" && !route.ExplicitDefault && route.Session == "" {
			route.Tail = rem
		} else {
			return cdpRoute{}, http.StatusNotFound, "无效的 CDP 路径"
		}
	default:
		return cdpRoute{}, http.StatusNotFound, "无效的 CDP 路径"
	}
	return route, 0, ""
}

// isLoopbackHost 判断 Host 头是否为本机回环地址（防 DNS Rebinding）。
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

// checkLocalHostOrigin Chrome 原生安全防线：校验回环 Host + 拒绝浏览器网页 Origin。
func checkLocalHostOrigin(w http.ResponseWriter, r *http.Request) bool {
	if !isLoopbackHost(r.Host) {
		writeJSONError(w, http.StatusForbidden, "拒绝非本机 Host（防 DNS Rebinding）")
		return false
	}
	if r.Header.Get("Origin") != "" {
		writeJSONError(w, http.StatusForbidden, "拒绝带 Origin 头的浏览器跨站请求")
		return false
	}
	return true
}

// authenticateCDPRoute 执行令牌识别、反向归属解析与前缀/会话严格交叉校验。
func authenticateCDPRoute(r *http.Request, route cdpRoute, endpoints []settings.Endpoint) (cdpAuthResult, int, string) {
	hdrTok := bearerToken(r)
	var (
		tok        string
		viaHeader  bool
		customPath string
	)
	switch len(route.Tail) {
	case 0:
		if hdrTok == "" {
			return cdpAuthResult{}, http.StatusUnauthorized, "缺少访问令牌（请通过 Authorization: Bearer <token> 或 URL 路径携带）"
		}
		tok = hdrTok
		viaHeader = true
	case 1:
		seg := route.Tail[0]
		if hdrTok != "" {
			viaHeader = true
			tok = hdrTok
			if !tokenEqual(seg, hdrTok) {
				if route.PathSrc == "" && !route.ExplicitDefault && route.Session == "" {
					customPath = seg
				} else {
					return cdpAuthResult{}, http.StatusUnauthorized, "URL 令牌与 Authorization 头不一致"
				}
			}
		} else {
			tok = seg
			viaHeader = false
		}
	case 2:
		customPath = route.Tail[0]
		urlTok := route.Tail[1]
		if hdrTok != "" {
			if !tokenEqual(hdrTok, urlTok) {
				return cdpAuthResult{}, http.StatusUnauthorized, "URL 令牌与 Authorization 头不一致"
			}
			tok = hdrTok
			viaHeader = true
		} else {
			tok = urlTok
			viaHeader = false
		}
	}

	var matched *settings.Endpoint
	for i := range endpoints {
		if endpoints[i].Token != "" && tokenEqual(endpoints[i].Token, tok) {
			matched = &endpoints[i]
			break
		}
	}
	if matched == nil {
		return cdpAuthResult{}, http.StatusUnauthorized, "访问令牌无效"
	}

	// 严格作用域交叉校验（越权返回 403）
	if customPath != "" && matched.Path != customPath {
		return cdpAuthResult{}, http.StatusForbidden, "令牌与接入点路径不匹配"
	}
	if route.ExplicitDefault && matched.Source != "" {
		return cdpAuthResult{}, http.StatusForbidden, "令牌权限与默认源路径不匹配"
	}
	if route.PathSrc != "" && matched.Source != route.PathSrc {
		return cdpAuthResult{}, http.StatusForbidden, "令牌权限与请求的浏览器源不匹配"
	}

	pinnedSession := matched.EffectiveSession()
	if route.Session != "" {
		if err := settings.ValidSessionName(route.Session); err != nil {
			return cdpAuthResult{}, http.StatusBadRequest, err.Error()
		}
		if pinnedSession != "" && route.Session != pinnedSession {
			return cdpAuthResult{}, http.StatusForbidden, "令牌已限定于固定会话，不能访问其他会话"
		}
	}

	session := pinnedSession
	if session == "" {
		session = route.Session
	}
	return cdpAuthResult{
		Endpoint:       *matched,
		Token:          tok,
		ViaHeader:      viaHeader,
		ExplicitSource: matched.Source,
		Session:        session,
	}, 0, ""
}

// newAutoSessionID 生成匿名连接的独立会话名（前缀 cdp- 不与 ext-/sa- 路由规则冲突）。
func newAutoSessionID() string {
	b := make([]byte, 4)
	if _, err := rand.Read(b); err != nil {
		return "cdp-auto"
	}
	return "cdp-" + hex.EncodeToString(b)
}

// handleCDPGateway 统一处理标准 CDP HTTP 发现（/json/version, /json/list）与 WS 升级。
func (p *Proxy) handleCDPGateway(w http.ResponseWriter, r *http.Request) {
	if !checkLocalHostOrigin(w, r) {
		p.log.Warn("拒绝非本机或跨站 CDP 请求", "host", r.Host, "origin", r.Header.Get("Origin"), "path", r.URL.Path)
		return
	}
	route, code, msg := parseCDPPath(r.URL.Path)
	if code != 0 {
		writeJSONError(w, code, msg)
		return
	}
	cfg := p.store.Get()
	auth, code, msg := authenticateCDPRoute(r, route, cfg.Endpoints)
	if code != 0 {
		p.log.Warn("CDP 鉴权失败", "path", r.URL.Path, "code", code, "reason", msg, "via_header", bearerToken(r) != "")
		writeJSONError(w, code, msg)
		return
	}

	switch route.Kind {
	case cdpKindVersion:
		p.handleCDPVersion(w, r, auth)
	case cdpKindList:
		p.handleCDPList(w, auth)
	default:
		p.handleCDPWS(w, r, auth)
	}
}

// handleCDPVersion 响应标准 GET .../json/version[/]，无状态返回 webSocketDebuggerUrl。
func (p *Proxy) handleCDPVersion(w http.ResponseWriter, r *http.Request, auth cdpAuthResult) {
	sessionID := auth.Session
	if sessionID == "" {
		sessionID = newAutoSessionID()
	}
	host := r.Host
	if host == "" {
		host = fmt.Sprintf("127.0.0.1:%d", p.actualWSPort())
	}
	srcPrefix := ""
	if auth.ExplicitSource != "" {
		srcPrefix = "/" + auth.ExplicitSource
	}
	var wsURL string
	if auth.ViaHeader {
		wsURL = fmt.Sprintf("ws://%s%s/session/%s", host, srcPrefix, sessionID)
	} else {
		wsURL = fmt.Sprintf("ws://%s%s/session/%s/%s", host, srcPrefix, sessionID, auth.Token)
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(w).Encode(map[string]string{
		"Browser":              "Chrome/cdproxy",
		"Protocol-Version":     "1.3",
		"User-Agent":           "cdproxy",
		"V8-Version":           "",
		"WebKit-Version":       "",
		"webSocketDebuggerUrl": wsURL,
	})
}

// handleCDPList 响应标准 GET .../json/list[/] 与 /json[/]，严格隔离只返回当前会话可见页面。
func (p *Proxy) handleCDPList(w http.ResponseWriter, auth cdpAuthResult) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	out := make([]map[string]any, 0)
	if auth.Session != "" {
		if tabs, err := p.SessionTabs(auth.Session); err == nil {
			for _, tab := range tabs {
				tid, _ := tab["targetId"].(string)
				title, _ := tab["title"].(string)
				u, _ := tab["url"].(string)
				out = append(out, map[string]any{
					"id":          tid,
					"type":        "page",
					"title":       title,
					"url":         u,
					"description": "",
				})
			}
		}
	}
	_ = json.NewEncoder(w).Encode(out)
}

// handleCDPWS 受理浏览器级 CDP WebSocket 连接（1 WS = 1 隔离会话，或复用指定会话）。
func (p *Proxy) handleCDPWS(w http.ResponseWriter, r *http.Request, auth cdpAuthResult) {
	sessionID := auth.Session
	if sessionID == "" {
		sessionID = newAutoSessionID()
	}
	if _, err := p.AllocSession(sessionID, auth.ExplicitSource); err != nil {
		writeJSONError(w, http.StatusConflict, err.Error())
		return
	}
	sess := p.st.FindByName(sessionID)
	if sess == nil {
		w.WriteHeader(http.StatusInternalServerError)
		return
	}
	sess.SetOrigin("endpoint:" + auth.Endpoint.Path)
	p.log.Info("CDP 接入连接", "endpoint", auth.Endpoint.Path, "session", sess.Name, "source", sess.Downstream(), "via_header", auth.ViaHeader)
	// 不放开 OriginPatterns：由 checkLocalHostOrigin 与库默认同源策略双层守卫
	conn, err := websocket.Accept(w, r, nil)
	if err != nil {
		return
	}
	p.attachUpstream(sess, conn, r)
}

func writeJSONError(w http.ResponseWriter, code int, msg string) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": msg})
}
