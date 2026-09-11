// Package proxy 是代理核心：上游 per-session WS 服务 + 下游单条浏览器级
// WS 复用 + 消息路由。
//
// 与 Python 参考实现 proxy.py 语义逐条对齐：
//   - 隔离：getTargets 按归属过滤；attach/closeTarget 越权拒绝
//   - 路由：响应回原 session；事件按下游 sessionId / tab 归属定向
//   - 重映射：下游自增 id ↔ (session, 上游原始 id, tag)
//   - 焦点：background 模式下 createTarget 强制后台、activate/bringToFront 假成功
//   - 回收：断连宽限（容忍 daemon 重启）+ 分配未连兜底
//   - 生命线：下游 CDP 断开时什么都不做（不自愈）——基座生命周期归
//     ab-keeper（agent-browser 原生 idle-timeout/close/restart），
//     （重）连基座的唯一入口是 provider 分配路径与 Admin 重启
package proxy

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log/slog"
	"net"
	"strings"
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
	baseWS    string        // 当前基座浏览器级 WS（Stop 验证死亡用）
	dsWriteMu sync.Mutex    // 下游写串行

	server *http.Server
}

// idleCheckInterval 空闲巡检周期。
const idleCheckInterval = 30 * time.Second

// startBaseKeepAlive 基座保活心跳：有活动（会话在或人工页面在）时周期性执行
// get cdp-url——重置 agent-browser 侧基座会话的空闲计时（基座空闲关闭由
// agent-browser 原生 idle-timeout 执行，proxy 不关基座），顺带在基座意外死亡
// 且仍有会话时经自动拉起完成自愈。无活动时不跳：让原生空闲计时走到关闭。
func (p *Proxy) startBaseKeepAlive() {
	go func() {
		for {
			time.Sleep(idleCheckInterval)
			threshold := p.store.Get().KeeperIdleShutdownSeconds
			if threshold <= 0 {
				continue // idleTimeout=0：基座永久驻留，无需心跳
			}
			active := p.st.SessionCount() > 0
			if !active && p.dsConnected() {
				if n, err := p.unownedPageCount(); err == nil && n > 0 {
					active = true // 人工页面在场（用户正在看）
				}
			}
			if !active {
				continue // 无活动：不喂计时，agent-browser 原生空闲关闭
			}
			// 只喂活着的基座（探活拨号，绝不拉起——拉起是 provider 的职责）
			p.mu.Lock()
			ws := p.baseWS
			p.mu.Unlock()
			if !p.wsAlive(ws) {
				continue
			}
			if _, err := p.cfg.EnsureRunning(keeper.IdleTimeoutString(threshold)); err != nil {
				p.log.Error("基座保活心跳失败", "err", err)
			}
		}
	}()
}

// wsAlive 探测基座 WS 是否可连接（只读探活，绝不触发启动）。
func (p *Proxy) wsAlive(wsURL string) bool {
	if wsURL == "" {
		return false
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, wsURL, nil)
	if err != nil {
		return false
	}
	_ = conn.Close(websocket.StatusNormalClosure, "probe")
	return true
}

// dsConnected 下游是否连着（心跳活动判定用，不触发连接）。
func (p *Proxy) dsConnected() bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.ds != nil
}

// unownedPageCount 统计基座里不属于任何会话的 page 型 target（人工使用信号）。
// 经下游 CDP Target.getTargets 查询（agent-browser 启动的基座调试端口随机，
// HTTP /json/list 端点不可依赖）。
func (p *Proxy) unownedPageCount() (int, error) {
	msg, err := p.dsCall("Target.getTargets", map[string]any{}, 5*time.Second)
	if err != nil {
		return 0, err
	}
	result, _ := msg["result"].(map[string]any)
	infos, _ := result["targetInfos"].([]any)
	count := 0
	for _, item := range infos {
		ti, ok := item.(map[string]any)
		if !ok {
			continue
		}
		typ, _ := ti["type"].(string)
		if typ != "page" {
			continue
		}
		// 人工活动 = 有真实内容的页面（http/https）。about:blank / data: /
		// chrome:// 新标签页与测试残留不算——否则一个空白 tab 永久阻止空闲关闭
		u, _ := ti["url"].(string)
		if !strings.HasPrefix(u, "http://") && !strings.HasPrefix(u, "https://") {
			continue
		}
		tid, _ := ti["targetId"].(string)
		if p.st.OwnerOf(tid) == nil {
			count++
		}
	}
	return count, nil
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
	p.startBaseKeepAlive()
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
	// 先建会话再连基座：活动守卫按会话计数放行，顺序反了会把
	// provider 分配路径整个拒绝（插件报 exited unsuccessfully）
	token := randomToken()
	sess, created := p.st.Alloc(name, token)
	p.log.Info("alloc 会话", "session", name, "token_prefix", sess.Token[:min(8, len(sess.Token))], "reused", !created)
	p.ilog.Append(interlog.Entry{Dir: "up", Kind: "cmd", Session: name, Method: "AllocSession",
		Action: "alloc", Detail: fmt.Sprintf("created=%v token_prefix=%s", created, sess.Token[:min(8, len(sess.Token))])})
	wsURL, err := p.cfg.EnsureRunning(keeper.IdleTimeoutString(p.store.Get().KeeperIdleShutdownSeconds))
	if err != nil {
		if created {
			p.st.Release(name)
		}
		return "", err
	}
	// 基座 WS 变化（Chrome 被重启/重拉）= 旧归属全部失效：清归属并合成
	// 原生等价的销毁事件；URL 未变（瞬断重连）则归属仍然有效，不惊动会话
	if wsURL != p.baseWS {
		owned, bound := p.st.ClearOwnership()
		p.notifyOwnershipCleared(owned, bound)
	}
	if err := p.connectDownstream(wsURL); err != nil {
		if created {
			p.st.Release(name)
		}
		return "", err
	}
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
// 会话身份终点：同时关闭其上游连接——原生等价反应（浏览器消亡连接必断），
// daemon 立即感知 session 已过期，而不是持有僵尸连接继续「成功」收发。
func (p *Proxy) ReleaseSession(name string) {
	defer p.ilog.DetachFile(name)
	sess, targets := p.st.Release(name)
	if sess == nil {
		return
	}
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
	if conn := sess.WS(); conn != nil {
		_ = conn.Close(4401, "session released")
		p.log.Info("已关闭释放会话的上游连接", "session", name)
	}
}

// RestartKeeper 重启基座 Chrome 并重建下游（归属全清——重启后 targetId 全失效）。
// RestartKeeper 重启基座 Chrome 并重建下游（归属全清——重启后 targetId 全失效）。
// 必须验证旧基座真正死亡才返回成功——杀不死（不可中断内核态，信号无效）
// 时如实报错，绝不宣称"已重建"。
func (p *Proxy) RestartKeeper() error {
	p.mu.Lock()
	ds := p.ds
	old := p.baseWS
	p.ds = nil
	p.mu.Unlock()
	if ds != nil {
		_ = ds.Close(websocket.StatusGoingAway, "keeper restart")
	}
	if err := p.cfg.Stop(old); err != nil {
		// 基座未真死：如实报错（此刻下游已断，行为等同断开——什么都不做）
		return err
	}
	owned, bound := p.st.ClearOwnership()
	p.notifyOwnershipCleared(owned, bound)
	// 重启的后半段"重新打开"走 agent-browser 原生 get cdp-url（线 1）
	wsURL, err := p.cfg.EnsureRunning(keeper.IdleTimeoutString(p.store.Get().KeeperIdleShutdownSeconds))
	if err != nil {
		return err
	}
	if err := p.connectDownstream(wsURL); err != nil {
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
			"connected":    dsAlive,
			"base_session": p.cfg.Session,
			"manager":      "agent-browser",
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
	// in 快照：规则改写前的原始 params（Safe 重建结构，不受后续 in-place 改写影响）
	inSnap := interlog.Safe(params)

	// 下游已死：立即回 CDP 错误（不让 daemon 挂等），消费者据此走 provider
	// 重新分配——自愈不在命令路径上发生
	if !p.dsConnected() {
		p.ilog.Append(interlog.Entry{Dir: "up", Kind: "cmd", Session: sess.Name, Method: method,
			UpID: msg2UpID(upIDf, hasID), Action: "no-downstream", In: inSnap,
			Delta: "rejected（下游未连接，等待 provider 分配唤醒）"})
		p.reject(sess, upIDf, hasID, "基座未连接（基座未运行，请重新分配会话）")
		return
	}

	// 越权守卫：attach/close 只允许操作自己名下 target（多租户完整性，结构化不可配）
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

	// 可配置改写规则（settings.rewrites，默认=「不抢焦点」+ 基座保护）
	outcome := applyUpstreamRules(p.store.Get().Rewrites, method, params)
	if outcome.Stop {
		p.ilog.Append(interlog.Entry{Dir: "up", Kind: "cmd", Session: sess.Name, Method: method,
			UpID: msg["id"], Action: outcome.Action, In: inSnap, Delta: outcome.Delta})
		p.fakeSuccess(sess, upIDf, hasID, method)
		if outcome.Action == "base-guard" {
			p.log.Warn("已拦截 Browser.close（基座保护）", "session", sess.Name)
		}
		return
	}
	delta := outcome.Delta
	action := outcome.Action

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
	msg["params"] = params
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
// connectDownstream 连接到给定基座 WS。
// 仅 AllocSession 与 Admin 重启允许调用——这是全系统唯二触碰基座连接的地方。
func (p *Proxy) connectDownstream(wsURL string) error {
	p.mu.Lock()
	if p.ds != nil && p.baseWS == wsURL {
		p.mu.Unlock()
		return nil // 已连着同一基座
	}
	old := p.ds
	p.ds = nil
	p.mu.Unlock()
	if old != nil {
		_ = old.Close(websocket.StatusGoingAway, "reconnect")
	}
	conn, _, err := websocket.Dial(context.Background(), wsURL, nil)
	if err != nil {
		return fmt.Errorf("下游连接失败: %w", err)
	}
	conn.SetReadLimit(64 << 20)
	p.mu.Lock()
	p.ds = conn
	p.baseWS = wsURL
	p.mu.Unlock()
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
	// CDP 断开 = 什么都不做：不自愈、不重启、不清归属、不拉基座。
	// 归属清理与合成通知由下一条 provider 分配路径按"基座 WS 是否变化"决定；
	// 全系统仅有的（重）连接入口是 AllocSession 与 Admin 重启。
	p.log.Info("下游 CDP 断开（保持现状，等待 provider 分配唤醒）", "err", reason)
}

// notifyOwnershipCleared 下游重建导致归属全清后，向受影响会话合成原生等价
// 事件：每个曾绑定的下游会话推 Target.detachedFromTarget，每个曾归属的
// target 推 Target.targetDestroyed。原生 Chrome 中 tab 消亡必推送这些事件；
// 代理选择保持上游连接存活（自愈价值），就必须补齐等价可见反应——否则
// daemon 持有陈旧 pin/绑定，后续命令表现为「成功但无效」的静默错乱。
func (p *Proxy) notifyOwnershipCleared(owned, bound map[*state.Session][]string) {
	for sess, sids := range bound {
		for _, sid := range sids {
			p.ilog.Append(interlog.Entry{Dir: "down", Kind: "event", Session: sess.Name,
				Method: "Target.detachedFromTarget", Action: "synthetic",
				Detail: sid[:min(12, len(sid))] + "（下游重建）"})
			p.sendTo(sess, map[string]any{
				"method": "Target.detachedFromTarget",
				"params": map[string]any{"sessionId": sid},
			})
		}
	}
	for sess, tids := range owned {
		for _, tid := range tids {
			p.ilog.Append(interlog.Entry{Dir: "down", Kind: "event", Session: sess.Name,
				Method: "Target.targetDestroyed", Action: "synthetic", TargetID: tid,
				Detail: "下游重建"})
			p.sendTo(sess, map[string]any{
				"method": "Target.targetDestroyed",
				"params": map[string]any{"targetId": tid},
			})
		}
	}
	if len(owned) > 0 || len(bound) > 0 {
		p.log.Warn("下游重建：已向受影响会话合成 targetDestroyed/detachedFromTarget",
			"sessions", len(owned)+len(bound))
	}
}

// dsSend 写下游（写锁串行）。
func (p *Proxy) dsSend(data []byte) error {
	p.mu.Lock()
	conn := p.ds
	p.mu.Unlock()
	if conn == nil {
		return fmt.Errorf("下游未连接（基座未运行，等待分配唤醒）")
	}
	p.dsWriteMu.Lock()
	defer p.dsWriteMu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), writeTimeout)
	defer cancel()
	return conn.Write(ctx, websocket.MessageText, data)
}

// dsCall 同步请求基座（自管理命令的应答版）：登记 pending + 等响应。
func (p *Proxy) dsCall(method string, params map[string]any, timeout time.Duration) (map[string]any, error) {
	ch := make(chan map[string]any, 1)
	id := p.st.NextCallID(ch, method)
	if err := p.sendDownstreamCommand(id, method, params); err != nil {
		p.st.TakePending(id)
		return nil, err
	}
	select {
	case msg := <-ch:
		if e, ok := msg["error"].(map[string]any); ok {
			return msg, fmt.Errorf("基座拒绝 %s: %v", method, e)
		}
		return msg, nil
	case <-time.After(timeout):
		p.st.TakePending(id)
		return nil, fmt.Errorf("基座应答超时: %s", method)
	}
}

// DsRawForControl 管理面直发基座命令（如人工开页面）；不经上游会话与规则。
func (p *Proxy) DsRawForControl(method string, params map[string]any) error {
	return p.dsRaw(method, params)
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
	if !ok {
		return
	}
	if entry.RespCh != nil {
		select {
		case entry.RespCh <- msg:
		default:
		}
		return
	}
	if entry.Sess == nil {
		return // 自管理命令（无应答方）
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
			// 只记结构类事件（Target 生命周期/对话框/弹窗），网络与帧噪声跳过——
			// 它们会淹没命令流水
			if strings.HasPrefix(method, "Target.") || method == "Page.javascriptDialogOpening" || method == "Page.windowOpen" {
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
