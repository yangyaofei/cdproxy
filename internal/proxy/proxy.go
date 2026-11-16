// Package proxy 是代理核心：上游 per-session WS 服务 + 下游浏览器级
// WS 复用 + 消息路由。
//
// 与 Python 参考实现 proxy.py 语义逐条对齐：
//   - 隔离：getTargets 按归属过滤；attach/closeTarget 越权拒绝
//   - 路由：响应回原 session；事件按下游 sessionId / tab 归属定向
//   - 重映射：下游自增 id ↔ (session, 上游原始 id, tag)
//   - 焦点：background 模式下 createTarget 强制后台、activate/bringToFront 假成功
//   - 回收：断连宽限（容忍 daemon 重启）+ 分配未连兜底
//   - 生命线：chrome 下游断开时什么都不做（不自愈）——基座生命周期归
//     ab-keeper（agent-browser 原生 idle-timeout/close/restart），
//     （重）连基座的唯一入口是 provider 分配路径与 Admin 重启
//
// 双下游并存（运行时可切，settings.downstream_mode 决定新会话默认绑定）：
//   - chrome：dial keeper 管理的基座 Chrome 浏览器级 WS（保活/冷启动/重启）
//   - extension：ext/cdp-ext 扩展反向拨入 GET /ext（常开注册，token 校验）
//     ——扩展用 chrome.debugger + chrome.tabs 把用户自己的 Chrome 仿真成
//     浏览器级 CDP 端点（flatten-only）。扩展下游无 keeper：不保活、不冷
//     启动、不重启浏览器——宿主浏览器属于用户，生命周期一概不碰；断开
//     就是等扩展自行重连（每次回连视为该下游更换：其上归属全清 + 合成
//     销毁事件，另一形态的会话不受牵连）。
//
// 会话在分配时定格绑定一种形态（Session.Downstream），此后所有命令/事件
// 按绑定路由；切换设置只影响之后的新分配，存量会话继续用原下游直到自然
// 结束（平滑语义）。两链路的 targetId/sessionId 理论可撞车，路由处一律
// 校验事件来源形态 == 归属会话的绑定形态。
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

	"github.com/yangyaofei/cdproxy/internal/interlog"
	"github.com/yangyaofei/cdproxy/internal/keeper"
	"github.com/yangyaofei/cdproxy/internal/settings"
	"github.com/yangyaofei/cdproxy/internal/state"
)

// writeTimeout 单帧写超时（防慢消费方拖死路由）。
const writeTimeout = 30 * time.Second

// downstreamKind 值域。
const (
	dsChrome    = "chrome"
	dsExtension = "extension"
)

// dsLink 一条下游链路（连接 + 串行写锁 + 身份标识）。
// chrome 链路的 ident 是基座浏览器级 WS URL（重启变化即归属失效依据）；
// extension 链路的 ident 是每次采纳新生成的 extension://<nonce>。
type dsLink struct {
	kind    string
	ident   string
	conn    *websocket.Conn
	writeMu sync.Mutex
}

// Options 保留给未来扩展的下游选项（当前双下游常开，无启动项）。
type Options struct{}

// Proxy 代理服务。
type Proxy struct {
	cfg    keeper.Config
	wsPort int
	store  *settings.Store
	st     *state.State
	ilog   *interlog.Log
	log    *slog.Logger
	marker string // 日志定位用

	mu       sync.Mutex // 双下游链路生命周期
	chrome   *dsLink    // keeper 基座链路（按需建立）
	ext      *dsLink    // cdp-ext 扩展链路（回连采纳，常开待命）
	// extAdoptGen 扩展采纳代次：每次采纳 +1；gstate/restore 到达也 +1（作废
	// 待定的兜底计时器）。采纳后兜底计时器以自己看到的代次为凭，代次已变则放弃。
	// extGstateSeen 本次采纳周期内是否收到过组事实（gstate）。
	extAdoptGen  uint64
	extGstateSeen bool

	server *http.Server
}

// idleCheckInterval 空闲巡检周期。
const idleCheckInterval = 30 * time.Second

// startBaseKeepAlive 基座保活心跳：有活动（会话在或人工页面在）时周期性执行
// get cdp-url——重置 agent-browser 侧基座会话的空闲计时（基座空闲关闭由
// agent-browser 原生 idle-timeout 执行，proxy 不关基座），顺带在基座意外死亡
// 且仍有会话时经自动拉起完成自愈。无活动时不跳：让原生空闲计时走到关闭。
// 仅作用于 chrome 链路（extension 宿主属用户，无保活概念）。
func (p *Proxy) startBaseKeepAlive() {
	go func() {
		for {
			time.Sleep(idleCheckInterval)
			threshold := p.store.Get().KeeperIdleShutdownSeconds
			if threshold <= 0 {
				continue // idleTimeout=0：基座永久驻留，无需心跳
			}
			active := false
			for _, sess := range p.st.Snapshot() {
				if sess["downstream"] == dsChrome {
					active = true
					break
				}
			}
			if !active && p.linkConnected(dsChrome) {
				if n, err := p.unownedPageCount(); err == nil && n > 0 {
					active = true // 人工页面在场（用户正在看）
				}
			}
			if !active {
				continue // 无活动：不喂计时，agent-browser 原生空闲关闭
			}
			// 只喂活着的基座（探活拨号，绝不拉起——拉起是 provider 的职责）
			ws := p.linkIdent(dsChrome)
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

// link 返回指定形态的链路（nil = 未连接）。
func (p *Proxy) link(kind string) *dsLink {
	p.mu.Lock()
	defer p.mu.Unlock()
	if kind == dsExtension {
		return p.ext
	}
	return p.chrome
}

// linkConnected 链路是否在场（不触发连接）。
func (p *Proxy) linkConnected(kind string) bool {
	return p.link(kind) != nil
}

// linkIdent 链路身份标识（chrome=基座 WS URL；extension=nonce）。
func (p *Proxy) linkIdent(kind string) string {
	l := p.link(kind)
	if l == nil {
		return ""
	}
	return l.ident
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

// New 构造代理。双下游常开：chrome 链路按需建立，extension 链路等回连。
func New(cfg keeper.Config, wsPort int, store *settings.Store, ilog *interlog.Log, log *slog.Logger) *Proxy {
	return &Proxy{
		cfg: cfg, wsPort: wsPort, store: store,
		st: state.New(), ilog: ilog, log: log,
	}
}

// Start 启动上游 WS 服务（127.0.0.1:wsPort，路径 /cdp/<token>）；
// /ext 反向入口常开注册（扩展拨入即成为 extension 下游，与 chrome 下游
// 并存——谁在装谁的浏览器，互不干扰）。
func (p *Proxy) Start() error {
	if err := p.listenWS(p.wsPort); err != nil {
		return err
	}
	p.startBaseKeepAlive()
	return nil
}

// listenWS 绑定上游 WS 监听（先关旧监听，幂等）。只动监听器与既有上游
// 连接，不触碰下游链路（扩展/基座连接与端口重绑解耦——重绑端口不该
// 把健康的下游也折腾一遍）。
func (p *Proxy) listenWS(port int) error {
	if p.server != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		_ = p.server.Shutdown(ctx)
		cancel()
		p.server = nil
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /cdp/{token}", p.handleUpstream)
	mux.HandleFunc("GET /ext", p.handleExtension)
	addr := fmt.Sprintf("127.0.0.1:%d", port)
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return fmt.Errorf("上游端口绑定失败 %s: %w", addr, err)
	}
	p.server = &http.Server{Handler: mux}
	// 局部捕获：goroutine 与 StopListener/listenWS 并发时 p.server 可能被置换
	srv := p.server
	go func() {
		if err := srv.Serve(ln); err != nil && err != http.ErrServerClosed {
			p.log.Error("上游服务退出", "err", err)
		}
	}()
	p.mu.Lock()
	p.wsPort = port
	p.mu.Unlock()
	p.log.Info("代理 WS 服务已启动", "addr", addr,
		"default_downstream", p.store.Get().DownstreamMode, "/ext", "常开")
	return nil
}

// RestartListener 以新端口重建上游监听（会话/令牌状态保留；存量上游
// 连接随旧监听关闭而断开，由 daemon/扩展自动重连）。
func (p *Proxy) RestartListener(port int) error {
	return p.listenWS(port)
}

// StopListener 关闭上游监听（ports_enabled=false 的 App 内嵌模式）。
// 下游链路不动；扩展侧连接随监听关闭而断开，其退避重连在端口重开后
// 自动恢复。
func (p *Proxy) StopListener() {
	if p.server == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	_ = p.server.Shutdown(ctx)
	cancel()
	p.mu.Lock()
	p.server = nil
	p.mu.Unlock()
	p.log.Info("代理 WS 监听已关闭（外部端口停用）")
}

// Stop 停止上游服务并断开全部连接。
func (p *Proxy) Stop() {
	if p.server != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		_ = p.server.Shutdown(ctx)
		cancel()
	}
	p.mu.Lock()
	links := []*dsLink{p.chrome, p.ext}
	p.chrome, p.ext = nil, nil
	p.mu.Unlock()
	for _, l := range links {
		if l != nil {
			_ = l.conn.Close(websocket.StatusGoingAway, "proxy stopping")
		}
	}
}

// AllocSession 分配会话：按当前设置选定下游形态、登记、预开一个后台空白
// tab（getTargets 非空 + 与基座 UI 隔离）、排程未连兜底回收。返回上游连接
// 地址。会话的下游形态在此定格（Session.Downstream）；此后切设置不影响
// 本会话（平滑切换语义：只管新分配）。
//
// 注意 URL 必须用 session 实际注册的 token：同名未连接复用时 Alloc 返回
// 旧 session（旧 token），若返回新生成的 token，daemon 拿来连接会命中
// 4401 unknown session（close 后立即重开必现）。
func (p *Proxy) AllocSession(name string) (string, error) {
	// 先建会话再连基座：活动守卫按会话计数放行，顺序反了会把
	// provider 分配路径整个拒绝（插件报 exited unsuccessfully）
	mode := p.store.Get().DownstreamMode
	token := randomToken()
	sess, created := p.st.Alloc(name, token, mode)
	// 未连接复用 + 形态已切：旧 tab 在另一浏览器上不可达，静默改绑并
	// 重新预开（连接中的会话不动——平滑语义，老会话继续用原下游）
	preopen := created
	if !created && !sess.Connected() && sess.Downstream() != mode {
		old := sess.Downstream()
		tids, sids := p.st.DetachSessionTargets(sess)
		sess.SetDownstream(mode)
		preopen = true
		p.log.Info("复用会话改绑下游（未连接，旧归属静默清除）",
			"session", name, "from", old, "to", mode,
			"targets", len(tids), "ds_sessions", len(sids))
	}
	p.log.Info("alloc 会话", "session", name, "token_prefix", sess.Token[:min(8, len(sess.Token))],
		"reused", !created, "downstream", mode)
	p.ilog.Append(interlog.Entry{Dir: "up", Kind: "cmd", Session: name, Method: "AllocSession",
		Action: "alloc", Detail: fmt.Sprintf("created=%v downstream=%s token_prefix=%s",
			created, mode, sess.Token[:min(8, len(sess.Token))])})
	if mode == dsExtension {
		// extension：下游只能等扩展回连（宿主浏览器是用户的，绝不拉起）。
		// 回连时刻已做归属清理；此处只校验在场。
		if !p.linkConnected(dsExtension) {
			if created {
				p.st.Release(name)
			}
			return "", fmt.Errorf("扩展未回连（宿主 Chrome 未运行或未装 cdp-ext，无法分配会话）")
		}
	} else {
		wsURL, err := p.cfg.EnsureRunning(keeper.IdleTimeoutString(p.store.Get().KeeperIdleShutdownSeconds))
		if err != nil {
			if created {
				p.st.Release(name)
			}
			return "", err
		}
		// 基座 WS 变化（Chrome 被重启/重拉）= chrome 侧归属全部失效：清归属
		// 并合成原生等价的销毁事件；URL 未变（瞬断重连）则归属仍有效。
		// 只清 chrome 形态——extension 会话的归属挂在另一条链路上。
		if wsURL != p.linkIdent(dsChrome) {
			owned, bound := p.st.ClearOwnershipFor(dsChrome)
			p.notifyOwnershipCleared(owned, bound)
		}
		if err := p.connectDownstream(wsURL); err != nil {
			if created {
				p.st.Release(name)
			}
			return "", err
		}
	}
	if preopen {
		// 组在即领地：认领同名旧组的成员（扩展保留策略下 release 未删组，
		// 或组事实先于会话到达）。认领到成员则无需再预开 tab。
		if mode == dsExtension {
			if tids := p.st.PendingGroupClaim(name); len(tids) > 0 {
				for _, tid := range tids {
					p.st.OwnTarget(sess, tid)
				}
				preopen = false
				p.log.Info("认领既有会话组（组在即领地）", "session", name, "targets", len(tids))
				p.ilog.Append(interlog.Entry{Dir: "down", Kind: "event", Session: name,
					Method: "AllocSession", Action: "group-claim", Detail: fmt.Sprintf("targets=%d", len(tids))})
			}
		}
	}
	if preopen {
		// 仅全新（或改绑）会话预开后台 tab；复用路径沿用既有 tab（避免每次 launch 泄漏一个）
		preopenParams := map[string]any{"url": "about:blank", "background": true}
		if mode == dsExtension {
			preopenParams["abSession"] = name // 扩展据此归组
		}
		if err := p.dsCommand(sess, 0, false, "Target.createTarget", preopenParams, "create"); err != nil {
			p.log.Error("预开 tab 失败（会话仍可用，首个命令会开新 tab）", "session", name, "err", err)
		}
		p.scheduleReap(sess, p.store.Get().AllocReapSeconds)
	}
	return fmt.Sprintf("ws://127.0.0.1:%d/cdp/%s", p.wsPort, sess.Token), nil
}

// ReleaseSession 释放会话：非借用 tab 尽力关闭（fire-and-forget，按会话
// 绑定的下游发送）；借用的归还（保持打开，通知扩展移出会话组）。会话身份
// 终点：同时关闭其上游连接——原生等价反应（浏览器消亡连接必断），daemon
// 立即感知 session 已过期，而不是持有僵尸连接继续「成功」收发。
func (p *Proxy) ReleaseSession(name string) {
	defer p.ilog.DetachFile(name)
	sess, targets := p.st.Release(name)
	if sess == nil {
		return
	}
	kind := sess.Downstream()
	if kind == dsExtension {
		// 组模型：tab 处置归扩展的 release 策略（配置在扩展上：全关+删组 /
		// 保留+标记 / 保留）。proxy 只通知会话结束——组在即领地在，保留
		// 策略下的旧组会在下次同名 alloc 时经 gstate 认领。
		p.sendExtControl(map[string]any{"abCtl": "release", "session": name})
		p.log.Info("会话已释放（处置交扩展策略）", "session", name, "targets", len(targets))
	} else {
		closed := 0
		for _, tid := range targets {
			if err := p.dsRaw(kind, "Target.closeTarget", map[string]any{"targetId": tid}); err != nil {
				p.log.Error("关 tab 失败", "target", tid, "err", err)
			} else {
				closed++
			}
		}
		p.log.Info("会话已释放", "session", name, "tabs_total", len(targets), "tabs_closed", closed)
	}
	if conn := sess.WS(); conn != nil {
		_ = conn.Close(4401, "session released")
		p.log.Info("已关闭释放会话的上游连接", "session", name)
	}
}

// RestartKeeper 重启基座 Chrome 并重建 chrome 下游（chrome 侧归属全清——
// 重启后 targetId 全失效；extension 会话不受牵连）。必须验证旧基座真正
// 死亡才返回成功——杀不死（不可中断内核态，信号无效）时如实报错，绝不
// 宣称"已重建"。chrome 基座未运行而 extension 在场时，语义降级为「断开
// 扩展连接」：宿主浏览器属于用户绝不重启，扩展自行退避重连，回连即完成
// extension 侧重建（归属清理由回连路径完成）。
func (p *Proxy) RestartKeeper() error {
	chromeLink := p.link(dsChrome)
	extLink := p.link(dsExtension)
	if chromeLink != nil {
		old := chromeLink.ident
		_ = chromeLink.conn.Close(websocket.StatusGoingAway, "keeper restart")
		// 链路槽位由其 recvLoop 的 onDownstreamDead 清理；此处继续重建
		if err := p.cfg.Stop(old); err != nil {
			// 基座未真死：如实报错（此刻 chrome 下游已断，行为等同断开——什么都不做）
			return err
		}
		owned, bound := p.st.ClearOwnershipFor(dsChrome)
		p.notifyOwnershipCleared(owned, bound)
		// 重启的后半段"重新打开"走 agent-browser 原生 get cdp-url（线 1）
		wsURL, err := p.cfg.EnsureRunning(keeper.IdleTimeoutString(p.store.Get().KeeperIdleShutdownSeconds))
		if err != nil {
			return err
		}
		if err := p.connectDownstream(wsURL); err != nil {
			return err
		}
		p.log.Info("基座与 chrome 下游已重建")
		return nil
	}
	if extLink != nil {
		// 无基座可重启：把扩展链路断开作为「下游复位」逃生口
		_ = extLink.conn.Close(websocket.StatusGoingAway, "downstream reset")
		p.log.Info("无基座可重启：已断开扩展连接（等待扩展自行回连，回连即重建 extension 下游）")
		return nil
	}
	return fmt.Errorf("无下游在运行（基座未运行、扩展未回连）")
}

// Status 运行状态快照。
func (p *Proxy) Status() map[string]any {
	return map[string]any{
		"downstream": map[string]any{
			"default_mode": p.store.Get().DownstreamMode,
			"chrome": map[string]any{
				"connected":    p.linkConnected(dsChrome),
				"base_session": p.cfg.Session,
			},
			"extension": map[string]any{
				"connected": p.linkConnected(dsExtension),
				"manager":   "cdp-ext 扩展（用户宿主浏览器）",
			},
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

	kind := sess.Downstream()
	// 下游已死：立即回 CDP 错误（不让 daemon 挂等），消费者据此走 provider
	// 重新分配——自愈不在命令路径上发生
	if !p.linkConnected(kind) {
		reason := "基座未连接（基座未运行，请重新分配会话）"
		if kind == dsExtension {
			reason = "扩展下游未回连（宿主 Chrome 掉线，等待扩展重连）"
		}
		p.ilog.Append(interlog.Entry{Dir: "up", Kind: "cmd", Session: sess.Name, Method: method,
			UpID: msg2UpID(upIDf, hasID), Action: "no-downstream", In: inSnap,
			Delta: "rejected（下游未连接，等待 provider 分配唤醒）"})
		p.reject(sess, upIDf, hasID, reason)
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

	// setAutoAttach 拦截改写：不透传下游。真浏览器端点会 attach 全部 target
	// （含他人名下与用户自己的 tab——extension 模式会给用户日常浏览器所有
	// tab 挂上调试横幅，chrome 模式则破坏多会话隔离）。归属是 proxy 的知识，
	// 由 proxy 改写为「只对该会话名下 target 逐个 attach」：语义等价于真
	// autoAttach（该会话可见的世界 = 名下 target），后续 createTarget 的
	// attach 补挂见 onDsResponse tag=create。
	if method == "Target.setAutoAttach" {
		if sid, _ := msg["sessionId"].(string); sid == "" {
			autoOn, _ := params["autoAttach"].(bool)
			sess.SetAutoAttach(autoOn)
			p.ilog.Append(interlog.Entry{Dir: "up", Kind: "cmd", Session: sess.Name, Method: method,
				UpID: msg2UpID(upIDf, hasID), Action: "rewritten", In: inSnap,
				Delta: fmt.Sprintf("拦截改写：autoAttach=%v，仅 attach 名下 target", autoOn)})
			if autoOn {
				// 同步补挂：全部 attachedToTarget 事件先于本命令应答送达上游
				// （对齐真 Chrome 时序），单个失败不阻塞其余。
				for _, tid := range sess.OwnedTargets() {
					p.proxyAttachSync(sess, tid, 3*time.Second)
				}
			}
			p.fakeSuccess(sess, upIDf, hasID, method)
			return
		}
	}

	// setDiscoverTargets：记录发现开关（合成 targetCreated 的门控——真
	// Chrome 仅在发现开启后才推送 target 生命周期事件），透传下游。
	if method == "Target.setDiscoverTargets" {
		if sid, _ := msg["sessionId"].(string); sid == "" {
			if v, ok := params["discover"].(bool); ok {
				sess.SetDiscoverTargets(v)
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

	// 扩展下游：createTarget 夹带会话名（私有参数，扩展据此把新 tab 归入
	// "ab: <会话>" 标签组后剥离，不进 chrome.tabs API）。chrome 下游不带
	// ——真 Chrome 忽略未知字段，但基座浏览器无需分组（无用户混用场景）。
	if kind == dsExtension && method == "Target.createTarget" {
		params["abSession"] = sess.Name
	}

	// 处理标签（响应到达时做归属/绑定/过滤）
	var tag string
	switch method {
	case "Target.createTarget":
		tag = "create"
	case "Target.attachToTarget", "Target.attachToBrowserTarget":
		// attachToBrowserTarget 的响应同样携带 sessionId（浏览器 target 会话），
		// 绑定后其嵌套事件（顶层 sessionId=该会话）才能路由回上游会话
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
	if err := p.dsSend(kind, out); err != nil {
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

// handleExtension 扩展反向入口（常开注册，GET /ext?token=...）：
// ext/cdp-ext 扩展拨入即被采纳为 extension 下游（顶替旧扩展连接）。
// 采纳后延迟 2s 清账：SW 世代延续的扩展会在窗口内发 restore 续接（会话表
// 经 chrome.storage.session 持久化，sid 不变，proxy 侧归属/绑定从未失效，
// 无需重绑）；超时未收到才是冷启动（浏览器重启/新装），清 extension 归属
// 并合成销毁，双方状态一致。chrome 侧归属不受牵连。令牌不匹配回 401，
// 扩展侧按退避重试。令牌取自 settings.ext_token。
func (p *Proxy) handleExtension(w http.ResponseWriter, r *http.Request) {
	token := p.store.Get().ExtToken
	if token != "" && r.URL.Query().Get("token") != token {
		p.log.Warn("拒绝令牌不匹配的扩展连接", "remote", r.RemoteAddr)
		http.Error(w, "invalid extension token", http.StatusUnauthorized)
		return
	}
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		// 浏览器 WebSocket 必带 Origin（chrome-extension://…），默认跨源校验
		// 会 403——反向入口的准入凭据是 token（外加仅回环监听），不走 origin。
		OriginPatterns: []string{"*"},
	})
	if err != nil {
		return
	}
	conn.SetReadLimit(64 << 20)
	link := &dsLink{kind: dsExtension, ident: "extension://" + randomToken(), conn: conn}
	p.mu.Lock()
	old := p.ext
	p.ext = link
	p.mu.Unlock()
	if old != nil {
		_ = old.conn.Close(websocket.StatusGoingAway, "superseded by new extension connection")
	}
	// 采纳后不立即清账：新协议下扩展回连必先上报全量组事实（gstate），proxy
	// 据此重建归属投影（组在即领地，冷启动不再制造孤儿）。给 2s 窗口——
	// 窗口内收到 gstate 则作废计时器；超时未到视为旧版扩展（无 gstate 协议），
	// 回退旧语义：清 extension 归属并合成销毁，双方状态一致。
	p.mu.Lock()
	p.extAdoptGen++
	p.extGstateSeen = false
	gen := p.extAdoptGen
	p.mu.Unlock()
	time.AfterFunc(2*time.Second, func() {
		p.mu.Lock()
		stale := p.extAdoptGen != gen
		seen := p.extGstateSeen
		p.mu.Unlock()
		if stale || seen {
			return // gstate 已重建，或已被更新的采纳取代
		}
		owned, bound := p.st.ClearOwnershipFor(dsExtension)
		p.notifyOwnershipCleared(owned, bound)
		p.log.Info("扩展无 gstate 上报（旧版扩展），回退清归属")
	})
	go p.pingLoop(r.Context(), conn, 20*time.Second)
	p.log.Info("扩展已回连（成为 extension 下游）")
	go p.dsRecvLoop(link)
}

// connectDownstream 建立到基座 WS 的 chrome 下游连接。
// 仅 AllocSession 与 Admin 重启允许调用——这是全系统唯二触碰基座连接的地方。
func (p *Proxy) connectDownstream(wsURL string) error {
	p.mu.Lock()
	cur := p.chrome
	if cur != nil && cur.ident == wsURL {
		p.mu.Unlock()
		return nil // 已连着同一基座
	}
	p.chrome = nil
	p.mu.Unlock()
	if cur != nil {
		_ = cur.conn.Close(websocket.StatusGoingAway, "reconnect")
	}
	conn, _, err := websocket.Dial(context.Background(), wsURL, nil)
	if err != nil {
		return fmt.Errorf("chrome 下游连接失败: %w", err)
	}
	conn.SetReadLimit(64 << 20)
	link := &dsLink{kind: dsChrome, ident: wsURL, conn: conn}
	p.mu.Lock()
	p.chrome = link
	p.mu.Unlock()
	go p.pingLoop(context.Background(), conn, 20*time.Second)
	go p.dsRecvLoop(link)
	p.log.Info("chrome 下游已连接", "ws", wsURL)
	return nil
}

// dsRecvLoop 下游读循环：断开时清掉对应链路槽位（另一形态不受影响）。
func (p *Proxy) dsRecvLoop(link *dsLink) {
	for {
		_, data, err := link.conn.Read(context.Background())
		if err != nil {
			p.onDownstreamDead(link, err)
			return
		}
		p.onDownstreamMessage(data, link.kind)
	}
}

func (p *Proxy) onDownstreamDead(link *dsLink, reason error) {
	p.mu.Lock()
	same := p.chrome == link || p.ext == link
	if p.chrome == link {
		p.chrome = nil
	}
	if p.ext == link {
		p.ext = nil
	}
	p.mu.Unlock()
	if !same {
		return // 已被主动替换（如重启/顶替），无需处理
	}
	switch link.kind {
	case dsChrome:
		// CDP 断开 = 什么都不做：不自愈、不重启、不清归属、不拉基座。
		// 归属清理与合成通知由下一条 provider 分配路径按"基座 WS 是否变化"
		// 决定；全系统仅有的（重）连接入口是 AllocSession 与 Admin 重启。
		p.log.Info("chrome 下游断开（保持现状，等待 provider 分配唤醒）", "err", reason)
	case dsExtension:
		// 扩展断开同理：等扩展自行退避重连（回连即重建 extension 侧状态）
		p.log.Info("extension 下游断开（等待扩展自行回连）", "err", reason)
	}
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

// dsSend 写指定形态的下游（每链路独立写锁串行）。
func (p *Proxy) dsSend(kind string, data []byte) error {
	l := p.link(kind)
	if l == nil {
		if kind == dsExtension {
			return fmt.Errorf("扩展下游未回连（宿主 Chrome 掉线，等待扩展重连）")
		}
		return fmt.Errorf("chrome 下游未连接（基座未运行，等待分配唤醒）")
	}
	l.writeMu.Lock()
	defer l.writeMu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), writeTimeout)
	defer cancel()
	return l.conn.Write(ctx, websocket.MessageText, data)
}

// dsCall 同步请求基座（chrome 自管理命令的应答版）：登记 pending + 等响应。
func (p *Proxy) dsCall(method string, params map[string]any, timeout time.Duration) (map[string]any, error) {
	return p.dsCallOn(dsChrome, method, params, timeout)
}

// dsCallOn 对指定下游形态发同步命令（响应经 onDsResponse 原样投递——无
// tag，不做归属过滤）。
func (p *Proxy) dsCallOn(kind string, method string, params map[string]any, timeout time.Duration) (map[string]any, error) {
	ch := make(chan map[string]any, 1)
	id := p.st.NextCallID(ch, method)
	if err := p.sendDownstreamCommand(kind, id, method, params); err != nil {
		p.st.TakePending(id)
		return nil, err
	}
	select {
	case msg := <-ch:
		if e, ok := msg["error"].(map[string]any); ok {
			return msg, fmt.Errorf("下游拒绝 %s: %v", method, e)
		}
		return msg, nil
	case <-time.After(timeout):
		p.st.TakePending(id)
		return nil, fmt.Errorf("下游应答超时: %s", method)
	}
}

// DsRawForControl 管理面直发基座命令（如人工开页面）；不经上游会话与规则。
// 固定 chrome 形态——人工开页面是基座（keeper）概念。
func (p *Proxy) DsRawForControl(method string, params map[string]any) error {
	return p.dsRaw(dsChrome, method, params)
}

// dsRaw 服务自管理命令（无上游关联，如回收关 tab），按形态路由。
func (p *Proxy) dsRaw(kind string, method string, params map[string]any) error {
	id := p.st.NextDsID(nil, 0, false, "", method)
	return p.sendDownstreamCommand(kind, id, method, params)
}

// dsCommand 会话命令登记（含 tag）。
// proxyAttach 代理主动挂接：以会话名义对名下 target 发 Target.attachToTarget
// （flatten）。用于 setAutoAttach 改写与 createTarget 补挂——响应仍走
// tag=attach 链路（绑定 dsSession 归属），attachedToTarget 事件按 target
// 归属路由回该会话。
func (p *Proxy) proxyAttach(sess *state.Session, targetID string) {
	params := map[string]any{"targetId": targetID, "flatten": true}
	err := p.dsCommand(sess, 0, false, "Target.attachToTarget", params, "attach")
	p.ilog.Append(interlog.Entry{Dir: "up", Kind: "cmd", Session: sess.Name,
		Method: "Target.attachToTarget", Action: "proxy-attach", TargetID: targetID,
		Delta: "代理补挂（autoAttach 改写/createTarget 补挂）",
		Status: boolStatus(err == nil)})
	if err != nil {
		p.log.Error("代理补挂失败", "session", sess.Name, "targetId", targetID, "err", err)
	}
}

// proxyAttachSync 同步版补挂：阻塞至下游 attach 应答（或超时）。
// setAutoAttach 改写用它在应答上游前把名下 target 的 attachedToTarget
// 事件全部送达——真 Chrome 的时序是事件先于 setAutoAttach 响应，
// Playwright 连接一返回就枚举页面，事件迟到即视为无页面。
func (p *Proxy) proxyAttachSync(sess *state.Session, targetID string, timeout time.Duration) bool {
	ch := make(chan map[string]any, 1)
	id := p.st.NextSessCallID(sess, "attach", "Target.attachToTarget", ch)
	out, err := json.Marshal(map[string]any{
		"id": id, "method": "Target.attachToTarget",
		"params": map[string]any{"targetId": targetID, "flatten": true},
	})
	if err != nil {
		return false
	}
	if err := p.dsSend(sess.Downstream(), out); err != nil {
		p.log.Error("代理补挂发送失败", "session", sess.Name, "targetId", targetID, "err", err)
		return false
	}
	select {
	case resp := <-ch:
		if _, isErr := resp["error"]; isErr {
			return false
		}
		return true
	case <-time.After(timeout):
		p.log.Warn("代理补挂超时", "session", sess.Name, "targetId", targetID)
		return false
	}
}

// boolStatus 简易状态字符串。
func boolStatus(ok bool) string {
	if ok {
		return "ok"
	}
	return "error"
}

func (p *Proxy) dsCommand(sess *state.Session, upID int64, hasUpID bool, method string, params map[string]any, tag string) error {
	id := p.st.NextDsID(sess, upID, hasUpID, tag, method)
	return p.sendDownstreamCommand(sess.Downstream(), id, method, params)
}

func (p *Proxy) sendDownstreamCommand(kind string, id int64, method string, params map[string]any) error {
	msg := map[string]any{"id": id, "method": method, "params": params}
	data, err := json.Marshal(msg)
	if err != nil {
		return err
	}
	return p.dsSend(kind, data)
}

// ── 下游消息分发 ─────────────────────────────────────────────────

func (p *Proxy) onDownstreamMessage(data []byte, kind string) {
	var msg map[string]any
	if err := json.Unmarshal(data, &msg); err != nil || msg == nil {
		return
	}
	if kind == dsExtension {
		if _, ok := msg["abCtl"]; ok {
			p.onExtControl(msg)
			return
		}
	}
	if _, ok := msg["id"]; ok {
		p.onDsResponse(msg)
	} else if _, ok := msg["method"]; ok {
		p.onDsEvent(msg, kind)
	}
}

// ── 扩展控制通道（标签组 adopt / revoke）─────────────────────────
//
// 用户交互面是 Chrome 原生标签组：扩展把会话名下的 tab 归入 "ab: <会话>"
// 组；用户把 tab 拖进组 = adopt（交给该会话），拖出组 = revoke（收回）。
// 扩展监听组成员变化，经 /ext WS 发控制消息到这里；代理保持归属表为唯一
// 路由事实，组只是用户侧的编辑表面。

// sendExtControl 向扩展下游发一条控制消息（非 CDP 帧，abCtl 键区分）。
func (p *Proxy) sendExtControl(v map[string]any) {
	data, err := json.Marshal(v)
	if err != nil {
		return
	}
	if err := p.dsSend(dsExtension, data); err != nil {
		p.log.Warn("扩展控制消息发送失败", "ctl", v["abCtl"], "err", err)
	}
}

// onExtControl 扩展发来的控制消息分发。
func (p *Proxy) onExtControl(msg map[string]any) {
	ctl, _ := msg["abCtl"].(string)
	switch ctl {
	case "sync":
		p.onExtSync(msg)
	case "gstate":
		p.onExtGstate(msg)
	case "restore":
		p.onExtRestore(msg)
	default:
		p.log.Warn("未知扩展控制消息", "abCtl", ctl)
	}
}

// onExtRestore SW 世代延续续接：扩展经 chrome.storage.session 持久化恢复了
// 会话表（sid 不变）后回连上报。proxy 侧归属与 sid 绑定在整个 SW 重启期间
// 从未失效——无需重绑，只需作废采纳时挂起的延迟清账计时器即可；命令流对
// SW 重启完全无感。上报的 sessions 仅作日志核对（与本地绑定数不一致时警告，
// 组对账与回收路径会自行收敛差异）。
func (p *Proxy) onExtRestore(msg map[string]any) {
	p.mu.Lock()
	p.extAdoptGen++ // 作废待定的延迟清账
	p.mu.Unlock()
	n := 0
	if items, ok := msg["sessions"].([]any); ok {
		n = len(items)
	}
	p.log.Info("扩展 restore 续接（跳过清归属，sid 绑定原样有效）", "sessions", n)
}

// onExtSync 单会话组事实更新（扩展事件驱动/定期上报：组成员表 + targetInfo
// 全量随行）。组是浏览器里的唯一真相，proxy 的归属表只是它的投影：组内多出
// 的 target → 记归属（可见）并向客户端合成 targetCreated（页面列表靠事件流
// 维护——真 Chrome 里 tab 出现必然伴随该事件，投影变化必须等价）；少了的
// → 收回可见性（合成销毁事件，tab 留在浏览器里）；已属其他会话的 → 先向
// 原会话收回再归属本会话（用户把 tab 从 A 组拖到 B 组 = 领地转移）。
// 会话不存在时暂存领地（alloc 认领）。幂等。
func (p *Proxy) onExtSync(msg map[string]any) {
	name, _ := msg["session"].(string)
	tids := asStringSlice(msg["targetIds"])
	sess := p.st.FindByName(name)
	if sess == nil || sess.Downstream() != dsExtension {
		p.st.SetPendingGroup(name, tids) // 组在即领地：等待同名 alloc 认领
		return
	}
	p.projectGroup(sess, tids, infosOf(msg))
}

// infosOf 提取随行 targetInfo（targetId → info）。
func infosOf(msg map[string]any) map[string]map[string]any {
	out := map[string]map[string]any{}
	if items, ok := msg["infos"].([]any); ok {
		for _, item := range items {
			if im, ok := item.(map[string]any); ok {
				if tid, _ := im["targetId"].(string); tid != "" {
					out[tid] = im
				}
			}
		}
	}
	return out
}

// projectGroup 把「会话的组成员表」投影为归属：差分 + 转移 + 收回 + 事件。
func (p *Proxy) projectGroup(sess *state.Session, tids []string, infos map[string]map[string]any) {
	desired := map[string]struct{}{}
	for _, tid := range tids {
		desired[tid] = struct{}{}
	}
	// 1) 组内少了（拖出/组解散）→ 收回
	for _, tid := range sess.OwnedTargets() {
		if _, in := desired[tid]; !in {
			p.revokeTarget(sess, tid, "用户移出会话组")
		}
	}
	// 2) 组内多出 → 归属本会话（他属的先收回——领地转移）
	gainedSet := map[string]struct{}{}
	var missing []string
	for tid := range desired {
		if owner := p.st.OwnerOf(tid); owner == sess {
			continue
		} else if owner != nil {
			p.revokeTarget(owner, tid, "用户移出原会话组（领地转移）")
		}
		p.st.OwnTarget(sess, tid)
		gainedSet[tid] = struct{}{}
		if _, ok := infos[tid]; !ok {
			missing = append(missing, tid)
		}
	}
	// 信息兜底：sync/gstate 未随行 targetInfo 的（旧版扩展/异常路径），
	// 现场向扩展拉一次 getTargets 补齐——合成事件不依赖上报格式。
	if len(missing) > 0 {
		if resp, err := p.dsCallOn(dsExtension, "Target.getTargets", map[string]any{}, 3*time.Second); err == nil {
			if result, ok := resp["result"].(map[string]any); ok {
				if items, ok := result["targetInfos"].([]any); ok {
					for _, item := range items {
						if im, ok := item.(map[string]any); ok {
							if tid, _ := im["targetId"].(string); tid != "" {
								infos[tid] = im
							}
						}
					}
				}
			}
		}
	}
	// 合成 targetCreated：客户端页面列表靠事件流维护（等价真 Chrome 的
	// tab 出现）；门控=会话已开启 target 发现或 autoAttach（真 Chrome 仅
	// 在二者之一开启后才推送生命周期事件）；会话已开 autoAttach 则同步
	// 补挂（可见即可连）。仅对本次新增的发放。
	if sess.Connected() && (sess.DiscoverTargets() || sess.AutoAttach()) {
		for tid := range gainedSet {
			info, ok := infos[tid]
			if !ok {
				continue
			}
			p.ilog.Append(interlog.Entry{Dir: "down", Kind: "event", Session: sess.Name,
				Method: "Target.targetCreated", Action: "synthetic", TargetID: tid})
			p.sendTo(sess, map[string]any{
				"method": "Target.targetCreated",
				"params": map[string]any{"targetInfo": info},
			})
			if sess.AutoAttach() {
				p.proxyAttachSync(sess, tid, 3*time.Second)
			}
		}
	}
	if len(gainedSet) > 0 {
		p.ilog.Append(interlog.Entry{Dir: "down", Kind: "event", Session: sess.Name,
			Method: "abCtl.sync", Action: "group-diff", Detail: fmt.Sprintf("gained=%d", len(gainedSet))})
	}
}

// onExtGstate 全量组事实（扩展每次回连后上报：所有 "ab: " 组的成员表）。
// 以此重建 extension 形态的整个归属投影——proxy 不再维护独立的创建账本：
// 组在即领地在，组没了归属就没了。重建即对账：漂移在每条连接上被纠正。
func (p *Proxy) onExtGstate(msg map[string]any) {
	p.mu.Lock()
	p.extAdoptGen++       // 证明扩展活着：作废冷启动兜底计时器
	p.extGstateSeen = true
	p.mu.Unlock()
	groups, _ := msg["groups"].([]any)
	type groupFact struct {
		tids  []string
		infos map[string]map[string]any
	}
	fact := map[string]*groupFact{}
	for _, g := range groups {
		gm, ok := g.(map[string]any)
		if !ok {
			continue
		}
		name, _ := gm["session"].(string)
		if name == "" {
			continue
		}
		agg := &groupFact{tids: asStringSlice(gm["targetIds"]), infos: infosOf(gm)}
		fact[name] = agg
	}
	// 1) 现有 extension 归属里不在任何组事实中的 → 收回（组被解散/tab 被拖走）
	inFact := map[string]struct{}{}
	for _, agg := range fact {
		for _, tid := range agg.tids {
			inFact[tid] = struct{}{}
		}
	}
	for _, sess := range p.st.SessionsByDownstream(dsExtension) {
		for _, tid := range sess.OwnedTargets() {
			if _, in := inFact[tid]; !in {
				p.revokeTarget(sess, tid, "组事实重建：不在任何会话组")
			}
		}
	}
	// 2) 组事实投影到归属（会话存在的直接归属，不存在的暂存领地）
	claimed := 0
	for name, agg := range fact {
		tids := agg.tids
		sess := p.st.FindByName(name)
		if sess == nil || sess.Downstream() != dsExtension {
			p.st.SetPendingGroup(name, tids)
			continue
		}
		p.projectGroup(sess, tids, agg.infos)
		claimed++
	}
	p.log.Info("扩展组事实重建", "groups", len(fact), "claimed_sessions", claimed)
	p.ilog.Append(interlog.Entry{Dir: "down", Kind: "event", Method: "abCtl.gstate",
		Action: "gstate-rebuild", Detail: fmt.Sprintf("groups=%d", len(fact))})
}

// revokeTarget 收回一个 target 的可见性：向持有会话合成原生等价事件
// （detachedFromTarget×其名下全部下游会话 + targetDestroyed），解除归属。
// tab 本身不动（已回到用户手里）。
func (p *Proxy) revokeTarget(sess *state.Session, targetID string, reason string) {
	for _, sid := range p.st.SidsOfTarget(targetID) {
		p.ilog.Append(interlog.Entry{Dir: "down", Kind: "event", Session: sess.Name,
			Method: "Target.detachedFromTarget", Action: "synthetic",
			Detail: reason, TargetID: targetID})
		p.sendTo(sess, map[string]any{
			"method": "Target.detachedFromTarget",
			"params": map[string]any{"sessionId": sid, "targetId": targetID},
		})
	}
	p.ilog.Append(interlog.Entry{Dir: "down", Kind: "event", Session: sess.Name,
		Method: "Target.targetDestroyed", Action: "synthetic",
		TargetID: targetID, Detail: reason})
	p.sendTo(sess, map[string]any{
		"method": "Target.targetDestroyed",
		"params": map[string]any{"targetId": targetID},
	})
	p.st.DropTarget(targetID)
}

// asStringSlice JSON any → []string。
func asStringSlice(v any) []string {
	list, ok := v.([]any)
	if !ok {
		return nil
	}
	out := make([]string, 0, len(list))
	for _, item := range list {
		if s, ok := item.(string); ok {
			out = append(out, s)
		}
	}
	return out
}

// onDsResponse 响应：取回 pending → tag 加工 → 回传原 session 原始 id。
// RespCh 条目（同步调用）同样先做 tag 加工（attach 绑定 / create 归属），
// 再投递通道——保证同步调用方醒来时绑定已就位。
func (p *Proxy) onDsResponse(msg map[string]any) {
	dsIDf, _ := msg["id"].(float64)
	entry, ok := p.st.TakePending(int64(dsIDf))
	if !ok {
		return
	}
	if entry.Sess == nil && entry.RespCh == nil {
		return // 自管理命令（无应答方）
	}
	result, _ := msg["result"].(map[string]any)
	switch entry.Tag {
	case "create":
		if tid, _ := result["targetId"].(string); tid != "" {
			p.st.OwnTarget(entry.Sess, tid)
			// 会话已开 autoAttach：新 target 立即补挂，且 create 响应必须等
			// attachedToTarget 事件送达上游后才转发——真 Chrome 的事件先于
			// 响应，Playwright 在 create 响应返回后立即查页面注册表。
			// 等待放 goroutine：此处已在 dsRecvLoop，同步等 attach 响应会死锁。
			if entry.Sess.AutoAttach() {
				go func() {
					p.proxyAttachSync(entry.Sess, tid, 3*time.Second)
					p.finishDsResponse(entry, msg, dsIDf, result)
				}()
				return
			}
		}
	case "attach":
		if sid, _ := result["sessionId"].(string); sid != "" {
			p.st.BindDsSession(entry.Sess, sid, "")
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
	if entry.RespCh != nil {
		select {
		case entry.RespCh <- msg:
		default:
		}
		return
	}
	p.finishDsResponse(entry, msg, dsIDf, result)
}

// finishDsResponse 回传上游：重写 id → 原始上游 id，附日志。
func (p *Proxy) finishDsResponse(entry state.PendingEntry, msg map[string]any, dsIDf float64, result map[string]any) {
	if !entry.HasUpID {
		return
	}
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

// onDsEvent 事件：sessionId 路由 / tab 归属定向。kind 是事件来源链路形态：
// 双下游并存时两浏览器的 targetId/sessionId 理论可撞车，路由一律校验
// 事件来源 == 归属会话的绑定形态。
func (p *Proxy) onDsEvent(msg map[string]any, kind string) {
	method, _ := msg["method"].(string)
	params, _ := msg["params"].(map[string]any)

	// 带 sessionId 的事件 → 路由到绑定的 session
	if sid, ok := msg["sessionId"].(string); ok && sid != "" {
		if sess := p.st.SessionOfDs(sid); sess != nil && sess.Downstream() == kind {
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
		if owner := p.st.OwnerOf(tid); owner != nil && owner.Downstream() == kind && sid != "" {
			p.st.BindDsSession(owner, sid, tid)
			p.ilog.Append(interlog.Entry{Dir: "down", Kind: "event", Session: owner.Name,
				Method: method, Action: "routed", TargetID: tid, In: interlog.Safe(ti)})
			p.sendTo(owner, msg)
		}
	case "Target.detachedFromTarget":
		if sid, _ := params["sessionId"].(string); sid != "" {
			// 先回传再解绑：Playwright(Chromium) 浏览器级不监听 targetDestroyed，
			// 页面关闭完全依赖 detachedFromTarget → didClose()；只解绑不转发
			// 会让 page.close() 永远挂起。
			if sess := p.st.SessionOfDs(sid); sess != nil && sess.Downstream() == kind {
				p.ilog.Append(interlog.Entry{Dir: "down", Kind: "event", Session: sess.Name,
					Method: method, Action: "routed"})
				p.sendTo(sess, msg)
			}
			p.st.UnbindDsSession(sid)
		}
	case "Target.targetCreated", "Target.targetInfoChanged":
		ti, _ := params["targetInfo"].(map[string]any)
		tid, _ := ti["targetId"].(string)
		if owner := p.st.OwnerOf(tid); owner != nil && owner.Downstream() == kind {
			p.ilog.Append(interlog.Entry{Dir: "down", Kind: "event", Session: owner.Name,
				Method: method, Action: "routed", TargetID: tid, In: interlog.Safe(ti)})
			p.sendTo(owner, msg)
		} else if method == "Target.targetCreated" {
			// 非自有 target 创建（用户手动开 tab / 页面 window.open / 浏览器内部
			// 行为）只记录，不采取任何动作——proxy 是单向阀门：命令向可守卫改写，
			// 事件向只过滤转发，**永不因浏览器侧事件对浏览器回写**。
			// （历史上的 popup-close 策略违反此原则：extension 模式下用户手动开
			// tab 也会带 openerTabId，被误判为"会话弹窗"秒关——生产事故实证。）
			p.ilog.Append(interlog.Entry{Dir: "down", Kind: "event", Session: interlog.UnownedKey,
				Method: method, Action: "unowned", TargetID: tid, In: interlog.Safe(ti)})
		}
	case "Target.targetDestroyed":
		tid, _ := params["targetId"].(string)
		owner := p.st.OwnerOf(tid)
		p.st.DropTarget(tid)
		if owner != nil && owner.Downstream() == kind {
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
