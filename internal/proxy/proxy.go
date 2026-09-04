// Package proxy 是代理核心：上游 per-session WS 服务 + 下游单条浏览器级
// WS 复用 + 消息路由。
//
// 与 Python 参考实现 proxy.py 语义逐条对齐：
//   - 隔离：getTargets 按归属过滤；attach/closeTarget 越权拒绝
//   - 路由：响应回原 session；事件按下游 sessionId / tab 归属定向
//   - 重映射：下游自增 id ↔ (session, 上游原始 id, tag)
//   - 焦点：background 模式下 createTarget 强制后台、activate/bringToFront 假成功
//   - 回收：断连宽限（容忍 daemon 重启）+ 分配未连兜底
//   - 自愈：下游断开重建 + 归属全清（Chrome 重启后 targetId 全部失效）
package proxy

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"sync"
	"time"

	"github.com/coder/websocket"

	"github.com/yangyaofei/agent-browser-proxy/internal/interlog"
	"github.com/yangyaofei/agent-browser-proxy/internal/keeper"
	"github.com/yangyaofei/agent-browser-proxy/internal/settings"
	"github.com/yangyaofei/agent-browser-proxy/internal/state"
)

// writeTimeout 单帧写超时（防慢消费方拖死路由）。
const writeTimeout = 30 * time.Second

// Proxy 代理服务。
type Proxy struct {
	cfg     keeper.Config
	wsPort  int
	store   *settings.Store
	st      *state.State
	ilog    *interlog.Log
	log     *slog.Logger
	marker  string // 日志定位用

	mu        sync.Mutex    // 下游生命周期
	ds        *websocket.Conn
	dsWriteMu sync.Mutex    // 下游写串行

	server *http.Server
}

// New 构造代理。
func New(cfg keeper.Config, wsPort int, store *settings.Store, ilog *interlog.Log, log *slog.Logger) *Proxy {
	return &Proxy{
		cfg: cfg, wsPort: wsPort, store: store,
		st: state.New(), ilog: ilog, log: log,
	}
}

// Start 启动上游 WS 服务（127.0.0.1:wsPort，路径 /cdp/<token>）。
func (p *Proxy) Start() error {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /cdp/{token}", p.handleUpstream)
	addr := fmt.Sprintf("127.0.0.1:%d", p.wsPort)
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return fmt.Errorf("上游端口绑定失败 %s: %w", addr, err)
	}
	p.server = &http.Server{Handler: mux}
	go func() {
		if err := p.server.Serve(ln); err != nil && err != http.ErrServerClosed {
			p.log.Error("上游服务退出", "err", err)
		}
	}()
	p.log.Info("代理 WS 服务已启动", "addr", addr)
	return nil
}

// Stop 停止上游服务并断开全部连接。
func (p *Proxy) Stop() {
	if p.server != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		_ = p.server.Shutdown(ctx)
		cancel()
	}
	p.mu.Lock()
	ds := p.ds
	p.ds = nil
	p.mu.Unlock()
	if ds != nil {
		_ = ds.Close(websocket.StatusGoingAway, "proxy stopping")
	}
}

// AllocSession 分配会话：确保下游、登记、预开一个后台空白 tab（getTargets
// 非空 + 与基座 UI 隔离）、排程未连兜底回收。返回上游连接地址。
//
// 注意 URL 必须用 session 实际注册的 token：同名未连接复用时 Alloc 返回
// 旧 session（旧 token），若返回新生成的 token，daemon 拿来连接会命中
// 4401 unknown session（close 后立即重开必现）。
func (p *Proxy) AllocSession(name string) (string, error) {
	if err := p.ensureDownstream(); err != nil {
		return "", err
	}
	token := randomToken()
	sess, created := p.st.Alloc(name, token)
	p.log.Info("alloc 会话", "session", name, "token_prefix", sess.Token[:min(8, len(sess.Token))], "reused", !created)
	p.ilog.Append(interlog.Entry{Dir: "up", Kind: "cmd", Session: name, Method: "AllocSession",
		Action: "alloc", Detail: fmt.Sprintf("created=%v token_prefix=%s", created, sess.Token[:min(8, len(sess.Token))])})
	if created {
		// 仅全新会话预开后台 tab；复用路径沿用既有 tab（避免每次 launch 泄漏一个）
		if err := p.dsCommand(sess, 0, false, "Target.createTarget",
			map[string]any{"url": "about:blank", "background": true}, "create"); err != nil {
			p.log.Error("预开 tab 失败（会话仍可用，首个命令会开新 tab）", "session", name, "err", err)
		}
		p.scheduleReap(sess, p.store.Get().AllocReapSeconds)
	}
	return fmt.Sprintf("ws://127.0.0.1:%d/cdp/%s", p.wsPort, sess.Token), nil
}

// ReleaseSession 释放会话并尽力关闭其名下 tab（fire-and-forget）。
func (p *Proxy) ReleaseSession(name string) {
	defer p.ilog.DetachFile(name)
	targets := p.st.Release(name)
	closed := 0
	for _, tid := range targets {
		if err := p.dsRaw("Target.closeTarget", map[string]any{"targetId": tid}); err != nil {
			p.log.Error("关 tab 失败", "target", tid, "err", err)
		} else {
			closed++
		}
	}
	if len(targets) > 0 {
		p.log.Info("会话已释放", "session", name, "tabs_total", len(targets), "tabs_closed", closed)
	}
}

// RestartKeeper 重启基座 Chrome 并重建下游（归属全清——重启后 targetId 全失效）。
func (p *Proxy) RestartKeeper() error {
	p.mu.Lock()
	ds := p.ds
	p.ds = nil
	p.mu.Unlock()
	if ds != nil {
		_ = ds.Close(websocket.StatusGoingAway, "keeper restart")
	}
	p.cfg.Stop()
	p.st.ClearOwnership()
	if err := p.ensureDownstream(); err != nil {
		return err
	}
	p.log.Info("基座与下游已重建")
	return nil
}

// Status 运行状态快照。
func (p *Proxy) Status() map[string]any {
	p.mu.Lock()
	dsAlive := p.ds != nil
	p.mu.Unlock()
	return map[string]any{
		"downstream": map[string]any{
			"connected": dsAlive,
			"cdp_port":  p.cfg.CDPPort,
		},
		"sessions": p.st.Snapshot(),
	}
}

// ── 上游（session 连接）───────────────────────────────────────────

func (p *Proxy) handleUpstream(w http.ResponseWriter, r *http.Request) {
	token := r.PathValue("token")
	sess := p.st.FindByToken(token)
	conn, err := websocket.Accept(w, r, nil)
	if err != nil {
		return
	}
	if sess == nil {
		// 拒绝必须留痕：4401 是「token 未注册」的唯一观测点（排查连接凭证问题）
		p.log.Warn("拒绝未知 token 的上游连接", "token_prefix", token[:min(8, len(token))])
		_ = conn.Close(4401, "unknown session")
		return
	}
	conn.SetReadLimit(64 << 20)
	// 顶替：旧连接存在则关闭（其读循环因 WS 不再匹配而不会误清状态）
	if old := sess.WS(); old != nil && sess.Connected() {
		p.log.Warn("顶替同会话旧连接", "session", sess.Name, "token_prefix", token[:min(8, len(token))])
		_ = old.Close(4400, "superseded")
	}
	replaced := sess.WS() != nil && sess.Connected()
	sess.SetWS(conn)
	p.log.Info("会话已连接", "session", sess.Name, "token_prefix", token[:min(8, len(token))], "superseded", replaced)
	go p.pingLoop(r.Context(), conn, 20*time.Second)
	defer func() {
		if sess.ClearWSIfCurrent(conn) {
			p.log.Info("会话已断开", "session", sess.Name)
			p.scheduleReap(sess, p.store.Get().DisconnectReapSeconds)
		}
	}()
	for {
		_, data, err := conn.Read(r.Context())
		if err != nil {
			return
		}
		p.onUpstreamMessage(sess, data)
	}
}

// onUpstreamMessage 上游命令处理（顺序：越权守卫 → 基座保护 → 焦点拦截 → tag → id 重映射 → 转发）。
func (p *Proxy) onUpstreamMessage(sess *state.Session, data []byte) {
	var msg map[string]any
	if err := json.Unmarshal(data, &msg); err != nil || msg == nil {
		return
	}
	method, _ := msg["method"].(string)
	params, hasParams := msg["params"].(map[string]any)
	if !hasParams {
		params = map[string]any{}
	}
	upIDf, hasID := msg["id"].(float64)
	// in 快照：守卫改写前的原始 params（TrimValue 重建结构，不受后续 in-place 改写影响）
	inSnap := interlog.Safe(params)
	delta := ""
	action := "forwarded"

	// 越权守卫：attach/close 只允许操作自己名下 target
	if method == "Target.attachToTarget" || method == "Target.closeTarget" {
		if tid, _ := params["targetId"].(string); tid != "" {
			if owner := p.st.OwnerOf(tid); owner != nil && owner != sess {
				p.ilog.Append(interlog.Entry{Dir: "up", Kind: "cmd", Session: sess.Name, Method: method,
					UpID: msg["id"], Action: "scope-guard", In: inSnap,
					Delta: "rejected（target 属于其他 session）", TargetID: tid})
				p.reject(sess, upIDf, hasID, fmt.Sprintf("target %s 属于其他 session，禁止操作", tid))
				return
			}
		}
	}

	// 基座保护：Browser.close 会杀死共享 Chrome——全体会话共用的基础设施。
	// 任何会话都无权终止它（close --all / daemon 异常路径一律拦下），假成功应答。
	if method == "Browser.close" {
		p.ilog.Append(interlog.Entry{Dir: "up", Kind: "cmd", Session: sess.Name, Method: method,
			UpID: msg["id"], Action: "base-guard", In: inSnap, Delta: "faked（不转发）"})
		p.fakeSuccess(sess, upIDf, hasID, method)
		p.log.Warn("已拦截 Browser.close（基座保护）", "session", sess.Name)
		return
	}

	// 焦点拦截：不抢用户焦点
	if p.store.Get().FocusMode == "background" {
		switch method {
		case "Target.createTarget":
			params["background"] = true
			msg["params"] = params
			action = "rewritten"
			delta = "+background:true"
		case "Target.activateTarget", "Page.bringToFront":
			p.ilog.Append(interlog.Entry{Dir: "up", Kind: "cmd", Session: sess.Name, Method: method,
				UpID: msg["id"], Action: "focus-guard", In: inSnap, Delta: "faked（不转发）"})
			p.fakeSuccess(sess, upIDf, hasID, method)
			return
		case "Browser.setWindowBounds":
			if b, ok := params["bounds"].(map[string]any); ok {
				if _, hasFocused := b["focused"]; hasFocused {
					delete(b, "focused")
					params["bounds"] = b
					msg["params"] = params
					action = "rewritten"
					delta = "-focused"
				}
			}
		case "Emulation.setFocusEmulationEnabled":
			delta = "焦点仿真透传（页内 hasFocus 失真来源）"
		}
	}

	// 处理标签（响应到达时做归属/绑定/过滤）
	var tag string
	switch method {
	case "Target.createTarget":
		tag = "create"
	case "Target.attachToTarget":
		tag = "attach"
	case "Target.getTargets":
		tag = "gettargets"
	}

	var dsID any
	if hasID {
		dsID = p.st.NextDsID(sess, int64(upIDf), true, tag, method)
		msg["id"] = dsID
	}
	entry := interlog.Entry{Dir: "up", Kind: "cmd", Session: sess.Name, Method: method,
		UpID: msg2UpID(upIDf, hasID), DSID: dsID, Action: action, In: inSnap, Delta: delta}
	if action == "rewritten" {
		entry.Out = interlog.Safe(params)
	}
	p.ilog.Append(entry)
	out, err := json.Marshal(msg)
	if err != nil {
		return
	}
	if err := p.dsSend(out); err != nil {
		p.log.Error("下游转发失败", "session", sess.Name, "method", method, "err", err)
	}
}

// msg2UpID 归一化上游 id（无 id 命令返回 nil）。
func msg2UpID(upIDf float64, hasID bool) any {
	if !hasID {
		return nil
	}
	return int64(upIDf)
}

// reject 越权拒绝（CDP 错误语义）。
func (p *Proxy) reject(sess *state.Session, upID float64, hasID bool, message string) {
	if !hasID {
		return
	}
	p.sendTo(sess, map[string]any{
		"id":    int64(upID),
		"error": map[string]any{"code": -32000, "message": message},
	})
}

// fakeSuccess 焦点类命令的假成功应答（不转发到 Chrome）。
func (p *Proxy) fakeSuccess(sess *state.Session, upID float64, hasID bool, method string) {
	if !hasID {
		return
	}
	p.sendTo(sess, map[string]any{"id": int64(upID), "result": map[string]any{}})
	p.log.Debug("焦点命令已拦截", "session", sess.Name, "method", method)
}

// sendTo 回传消息到会话当前连接。
func (p *Proxy) sendTo(sess *state.Session, msg map[string]any) {
	data, err := json.Marshal(msg)
	if err != nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), writeTimeout)
	defer cancel()
	if err := sess.Write(ctx, data); err != nil {
		p.log.Error("回传失败", "session", sess.Name, "err", err)
	}
}

// ── 下游（Chrome 浏览器级连接）────────────────────────────────────

// ensureDownstream 确保下游连接存在（含 Chrome 基座就绪）。
func (p *Proxy) ensureDownstream() error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.ds != nil {
		return nil
	}
	wsURL, err := p.cfg.EnsureRunning()
	if err != nil {
		return fmt.Errorf("Chrome 基座不可用: %w", err)
	}
	conn, _, err := websocket.Dial(context.Background(), wsURL, nil)
	if err != nil {
		return fmt.Errorf("下游连接失败: %w", err)
	}
	conn.SetReadLimit(64 << 20)
	p.ds = conn
	go p.pingLoop(context.Background(), conn, 20*time.Second)
	go p.dsRecvLoop(conn)
	p.log.Info("下游已连接", "ws", wsURL)
	return nil
}

// dsRecvLoop 下游读循环：断开时清理归属并自愈重建。
func (p *Proxy) dsRecvLoop(conn *websocket.Conn) {
	for {
		_, data, err := conn.Read(context.Background())
		if err != nil {
			p.onDownstreamDead(conn, err)
			return
		}
		p.onDownstreamMessage(data)
	}
}

func (p *Proxy) onDownstreamDead(conn *websocket.Conn, reason error) {
	p.mu.Lock()
	same := p.ds == conn
	if same {
		p.ds = nil
	}
	p.mu.Unlock()
	if !same {
		return // 已被主动替换（如 RestartKeeper），无需处理
	}
	p.log.Error("下游断开，清空归属并重建", "err", reason)
	p.st.ClearOwnership()
	if err := p.ensureDownstream(); err != nil {
		p.log.Error("下游重建失败", "err", err)
	}
}

// dsSend 写下游（写锁串行）。
func (p *Proxy) dsSend(data []byte) error {
	if err := p.ensureDownstream(); err != nil {
		return err
	}
	p.mu.Lock()
	conn := p.ds
	p.mu.Unlock()
	if conn == nil {
		return fmt.Errorf("下游不可用")
	}
	p.dsWriteMu.Lock()
	defer p.dsWriteMu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), writeTimeout)
	defer cancel()
	return conn.Write(ctx, websocket.MessageText, data)
}

// dsRaw 服务自管理命令（无上游关联，如回收关 tab）。
func (p *Proxy) dsRaw(method string, params map[string]any) error {
	id := p.st.NextDsID(nil, 0, false, "", method)
	return p.sendDownstreamCommand(id, method, params)
}

// dsCommand 会话命令登记（含 tag）。
func (p *Proxy) dsCommand(sess *state.Session, upID int64, hasUpID bool, method string, params map[string]any, tag string) error {
	id := p.st.NextDsID(sess, upID, hasUpID, tag, method)
	return p.sendDownstreamCommand(id, method, params)
}

func (p *Proxy) sendDownstreamCommand(id int64, method string, params map[string]any) error {
	msg := map[string]any{"id": id, "method": method, "params": params}
	data, err := json.Marshal(msg)
	if err != nil {
		return err
	}
	return p.dsSend(data)
}

// ── 下游消息分发 ─────────────────────────────────────────────────

func (p *Proxy) onDownstreamMessage(data []byte) {
	var msg map[string]any
	if err := json.Unmarshal(data, &msg); err != nil || msg == nil {
		return
	}
	if _, ok := msg["id"]; ok {
		p.onDsResponse(msg)
	} else if _, ok := msg["method"]; ok {
		p.onDsEvent(msg)
	}
}

// onDsResponse 响应：取回 pending → tag 加工 → 回传原 session 原始 id。
func (p *Proxy) onDsResponse(msg map[string]any) {
	dsIDf, _ := msg["id"].(float64)
	entry, ok := p.st.TakePending(int64(dsIDf))
	if !ok || entry.Sess == nil {
		return // 未知或自管理命令
	}
	result, _ := msg["result"].(map[string]any)
	switch entry.Tag {
	case "create":
		if tid, _ := result["targetId"].(string); tid != "" {
			p.st.OwnTarget(entry.Sess, tid)
		}
	case "attach":
		if sid, _ := result["sessionId"].(string); sid != "" {
			p.st.BindDsSession(entry.Sess, sid)
		}
	case "gettargets":
		if infos, ok := result["targetInfos"].([]any); ok {
			owned := make([]any, 0, len(infos))
			for _, item := range infos {
				if ti, ok := item.(map[string]any); ok {
					if tid, _ := ti["targetId"].(string); tid != "" && p.st.OwnerOf(tid) == entry.Sess {
						owned = append(owned, item)
					}
				}
			}
			result["targetInfos"] = owned
			msg["result"] = result
		}
	}
	if entry.HasUpID {
		msg["id"] = entry.UpID
		if errMsg, ok := msg["error"].(map[string]any); ok {
			p.ilog.Append(interlog.Entry{Dir: "down", Kind: "resp", Session: entry.Sess.Name,
				Method: entry.Method, UpID: entry.UpID, DSID: int64(dsIDf),
				Status: "error", Result: interlog.Safe(errMsg)})
		} else if entry.Tag == "create" || entry.Tag == "attach" || entry.Tag == "gettargets" {
			p.ilog.Append(interlog.Entry{Dir: "down", Kind: "resp", Session: entry.Sess.Name,
				Method: entry.Method, UpID: entry.UpID, DSID: int64(dsIDf),
				Status: "ok", Result: interlog.Safe(result)})
		}
		p.sendTo(entry.Sess, msg)
	}
}

// onDsEvent 事件：sessionId 路由 / tab 归属定向。
func (p *Proxy) onDsEvent(msg map[string]any) {
	method, _ := msg["method"].(string)
	params, _ := msg["params"].(map[string]any)

	// 带 sessionId 的事件 → 路由到绑定的 session
	if sid, ok := msg["sessionId"].(string); ok && sid != "" {
		if sess := p.st.SessionOfDs(sid); sess != nil {
			if method != "Runtime.consoleAPICalled" && method != "Log.entryAdded" &&
				method != "Page.frameStartedLoading" && method != "Page.frameNavigated" &&
				method != "Page.frameStartedReceiving" && method != "Page.navigatedWithinDocument" {
				p.ilog.Append(interlog.Entry{Dir: "down", Kind: "event", Session: sess.Name,
					Method: method, Action: "routed", Detail: sid[:min(12, len(sid))]})
			}
			p.sendTo(sess, msg)
		}
		return
	}

	switch method {
	case "Target.attachedToTarget":
		ti, _ := params["targetInfo"].(map[string]any)
		tid, _ := ti["targetId"].(string)
		sid, _ := params["sessionId"].(string)
		if owner := p.st.OwnerOf(tid); owner != nil && sid != "" {
			p.st.BindDsSession(owner, sid)
			p.ilog.Append(interlog.Entry{Dir: "down", Kind: "event", Session: owner.Name,
				Method: method, Action: "routed", TargetID: tid, In: interlog.Safe(ti)})
			p.sendTo(owner, msg)
		}
	case "Target.detachedFromTarget":
		if sid, _ := params["sessionId"].(string); sid != "" {
			p.st.UnbindDsSession(sid)
		}
	case "Target.targetCreated", "Target.targetInfoChanged":
		ti, _ := params["targetInfo"].(map[string]any)
		tid, _ := ti["targetId"].(string)
		if owner := p.st.OwnerOf(tid); owner != nil {
			p.ilog.Append(interlog.Entry{Dir: "down", Kind: "event", Session: owner.Name,
				Method: method, Action: "routed", TargetID: tid, In: interlog.Safe(ti)})
			p.sendTo(owner, msg)
		} else if method == "Target.targetCreated" {
			// 非自有 target 创建 = 页面发起弹窗等浏览器内部行为（上游守卫够不着：
			// 不走上游 WS，且会劫持共享窗口的活动 tab）。openerId 是弹窗判别依据
			// （启动重放的既有 tab 无此字段）。session 无法操作无主弹窗（被
			// getTargets 过滤），close 策略下立即回收。
			typ, _ := ti["type"].(string)
			opener, _ := ti["openerId"].(string)
			if typ == "page" && opener != "" && p.store.Get().PopupPolicy == "close" {
				p.ilog.Append(interlog.Entry{Dir: "down", Kind: "event", Session: interlog.UnownedKey,
					Method: method, Action: "popup-close", TargetID: tid, In: interlog.Safe(ti),
					Delta: "opener=" + opener[:min(12, len(opener))]})
				if err := p.dsRaw("Target.closeTarget", map[string]any{"targetId": tid}); err != nil {
					p.log.Error("弹窗关闭失败", "target", tid, "err", err)
				}
				return
			}
			p.ilog.Append(interlog.Entry{Dir: "down", Kind: "event", Session: interlog.UnownedKey,
				Method: method, Action: "unowned", TargetID: tid, In: interlog.Safe(ti)})
		}
	case "Target.targetDestroyed":
		tid, _ := params["targetId"].(string)
		owner := p.st.OwnerOf(tid)
		p.st.DropTarget(tid)
		if owner != nil {
			p.sendTo(owner, msg)
		}
	}
}

// ── 回收与保活 ───────────────────────────────────────────────────

// scheduleReap 排程回收：到期时仍未连回且仍是注册者才释放。
func (p *Proxy) scheduleReap(sess *state.Session, delaySeconds float64) {
	time.AfterFunc(time.Duration(delaySeconds*float64(time.Second)), func() {
		if !sess.Connected() && p.st.IsCurrent(sess) {
			p.log.Info("回收未连回的会话", "session", sess.Name)
			p.ReleaseSession(sess.Name)
		}
	})
}

// pingLoop 周期保活（连接关闭/ctx 取消时退出）。
func (p *Proxy) pingLoop(ctx context.Context, conn *websocket.Conn, interval time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			pctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			err := conn.Ping(pctx)
			cancel()
			if err != nil {
				return
			}
		}
	}
}

// randomToken 生成上游连接凭证。
func randomToken() string {
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		// crypto/rand 失败极罕见；退化为时间戳兜底
		return fmt.Sprintf("t%d", time.Now().UnixNano())
	}
	return hex.EncodeToString(buf)
}
