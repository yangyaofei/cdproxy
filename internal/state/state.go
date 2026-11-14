// Package state 提供代理侧状态：会话、tab 归属、命令关联表。
//
// 所有权模型（与 Python 参考实现 state.py 语义逐条对齐）：
//   - 每个消费 session 分配一个 token（上游 WS 连接凭证）
//   - tab（CDP target）按创建者归属 session；getTargets 只见自己的
//   - 下游 CDP sessionId（attach 产物）按归属 session 路由事件
//   - 命令 id 重映射：下游自增 id ↔ (归属 session, 上游原始 id, 处理标签)
//
// 全部方法在 State.mu 下串行（等价 Python 单事件循环的串行语义）；
// 对连接的写操作由调用方（proxy）用 Session.WriteMu 串行。
package state

import (
	"context"
	"sync"
	"sync/atomic"

	"github.com/coder/websocket"
)

// Session 一个消费 session（对应 agent-browser 的一个 daemon session）。
type Session struct {
	Name  string
	Token string

	writeMu sync.Mutex // 串行化对 WS 的并发写（事件路由/响应回传/拒绝回包）

	mu            sync.Mutex // 守护以下字段
	ownedTargets  map[string]struct{}
	connected     bool
	ws            *websocket.Conn
	autoAttach    bool   // root 级 Target.setAutoAttach(autoAttach=true) 已启用
	downstream    string // 会话绑定的下游形态：chrome | extension（分配时定格）
}

// Downstream 返回会话绑定的下游形态（chrome | extension）。
func (s *Session) Downstream() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.downstream
}

// SetDownstream 设置会话下游形态（仅分配路径调用：新建或未连接复用改绑）。
func (s *Session) SetDownstream(kind string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.downstream = kind
}

// AutoAttach 返回 root 级自动附着标志。
func (s *Session) AutoAttach() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.autoAttach
}

// SetAutoAttach 设置 root 级自动附着标志。
func (s *Session) SetAutoAttach(v bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.autoAttach = v
}

// OwnedTargets 返回名下 target 快照。
func (s *Session) OwnedTargets() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]string, 0, len(s.ownedTargets))
	for tid := range s.ownedTargets {
		out = append(out, tid)
	}
	return out
}

// Connected 返回连接状态。
func (s *Session) Connected() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.connected
}

// WS 返回当前上游连接（无则 nil）。
func (s *Session) WS() *websocket.Conn {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.ws
}

// SetWS 设置/清除连接状态（old 匹配时才清除，防竞态误清）。
func (s *Session) SetWS(conn *websocket.Conn) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.ws = conn
	s.connected = conn != nil
}

// Write 经写锁串行地向当前连接写一帧（ctx 控制超时）。
func (s *Session) Write(ctx context.Context, data []byte) error {
	conn := s.WS()
	if conn == nil {
		return nil
	}
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	return conn.Write(ctx, websocket.MessageText, data)
}

// ClearWSIfCurrent 仅当当前连接仍是 conn 时清除（防顶替后旧读循环误清）。
func (s *Session) ClearWSIfCurrent(conn *websocket.Conn) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.ws == conn {
		s.ws = nil
		s.connected = false
		return true
	}
	return false
}

// PendingEntry 下游命令的关联记录。
type PendingEntry struct {
	Sess    *Session // nil = 服务自管理命令（回收关 tab 等）
	UpID    int64
	HasUpID bool
	Tag     string
	Method  string // 原始 CDP method（响应日志归属用）
	RespCh  chan map[string]any // 非空 = 同步调用（dsCall），响应投递到此
}

// State 全局状态表。
type State struct {
	mu         sync.Mutex
	nextID     atomic.Int64
	sessions   map[string]*Session          // name → session
	byToken    map[string]*Session          // token → session
	targetOwn  map[string]*Session          // targetId → session
	dsSession  map[string]*Session          // 下游 sessionId → session
	pending    map[int64]PendingEntry       // 下游命令 id → 关联
}

// New 构造空状态表。
func New() *State {
	return &State{
		sessions:  map[string]*Session{},
		byToken:   map[string]*Session{},
		targetOwn: map[string]*Session{},
		dsSession: map[string]*Session{},
		pending:   map[int64]PendingEntry{},
	}
}

// Alloc 按名分配 session：同名一律复用（保留原 token 与归属）。
//
// 连接的接管由 WS 层 supersede 完成（新连接顶替旧连接），会话对象与
// token 保持稳定——daemon 重开时会连续多次 launch，replace 语义会制造
// 连接孤儿与 tab 泄漏。downstream 记录会话绑定的下游形态（分配时由
// proxy 按当前设置传入）。返回值 created 表示是否全新创建。
func (st *State) Alloc(name string, token string, downstream string) (*Session, bool) {
	st.mu.Lock()
	defer st.mu.Unlock()
	if existing, ok := st.sessions[name]; ok {
		return existing, false
	}
	sess := &Session{Name: name, Token: token, ownedTargets: map[string]struct{}{}, downstream: downstream}
	st.sessions[name] = sess
	st.byToken[token] = sess
	return sess, true
}

// Release 释放 session，返回 session（不存在则 nil）与其名下 target 列表。
// 调用方负责关 tab 与关闭其上游连接（原生等价：浏览器消亡连接必断，
// 否则 daemon 持僵尸连接继续收发，表现为释放后仍可用）。
func (st *State) Release(name string) (*Session, []string) {
	st.mu.Lock()
	defer st.mu.Unlock()
	sess, ok := st.sessions[name]
	if !ok {
		return nil, nil
	}
	targets := sess.OwnedTargets()
	st.drop(sess)
	return sess, targets
}

// drop 摘除 session 并清理全部关联（调用方持锁）。
func (st *State) drop(sess *Session) {
	delete(st.sessions, sess.Name)
	delete(st.byToken, sess.Token)
	for tid := range sess.ownedTargets {
		delete(st.targetOwn, tid)
	}
	sess.ownedTargets = map[string]struct{}{}
	for sid, s := range st.dsSession {
		if s == sess {
			delete(st.dsSession, sid)
		}
	}
}

// SessionCount 当前会话数（含未连接的，分配即计数）。
func (st *State) SessionCount() int {
	st.mu.Lock()
	defer st.mu.Unlock()
	return len(st.sessions)
}

// FindByToken 按上游连接 token 定位 session。
func (st *State) FindByToken(token string) *Session {
	st.mu.Lock()
	defer st.mu.Unlock()
	return st.byToken[token]
}

// IsCurrent 该 session 是否仍是同名注册者（防旧实例误触发回收）。
func (st *State) IsCurrent(sess *Session) bool {
	st.mu.Lock()
	defer st.mu.Unlock()
	return st.sessions[sess.Name] == sess
}

// ClearOwnershipFor 清空指定形态下游上的全部归属（该下游重建时调用——
// 另一形态的会话不受牵连），并返回清理前快照：
// owned = session → 名下 targetId 列表；bound = session → 绑定的下游
// sessionId 列表。供 proxy 合成 targetDestroyed / detachedFromTarget 通知
// ——原生 Chrome 中 tab 消亡必推送事件，代理保持上游连接存活（自愈价值）
// 就必须补齐等价可见反应，否则 daemon 持陈旧 pin 表现为「成功但无效」。
func (st *State) ClearOwnershipFor(kind string) (owned map[*Session][]string, bound map[*Session][]string) {
	st.mu.Lock()
	defer st.mu.Unlock()
	owned = map[*Session][]string{}
	bound = map[*Session][]string{}
	for tid, sess := range st.targetOwn {
		if sess.Downstream() != kind {
			continue
		}
		owned[sess] = append(owned[sess], tid)
		delete(st.targetOwn, tid)
		delete(sess.ownedTargets, tid)
	}
	for sid, sess := range st.dsSession {
		if sess.Downstream() != kind {
			continue
		}
		bound[sess] = append(bound[sess], sid)
		delete(st.dsSession, sid)
	}
	return owned, bound
}

// DetachSessionTargets 静默清掉单个会话的全部归属与绑定（返回快照，不发
// 合成事件——调用方保证此刻无人监听，如未连接会话的下游改绑）。
func (st *State) DetachSessionTargets(sess *Session) (tids []string, sids []string) {
	st.mu.Lock()
	defer st.mu.Unlock()
	for tid := range sess.ownedTargets {
		tids = append(tids, tid)
		delete(st.targetOwn, tid)
	}
	sess.ownedTargets = map[string]struct{}{}
	for sid, s := range st.dsSession {
		if s == sess {
			sids = append(sids, sid)
			delete(st.dsSession, sid)
		}
	}
	return tids, sids
}

// OwnTarget 登记 tab 归属（创建响应到达时调用）。
func (st *State) OwnTarget(sess *Session, targetID string) {
	st.mu.Lock()
	defer st.mu.Unlock()
	sess.ownedTargets[targetID] = struct{}{}
	st.targetOwn[targetID] = sess
}

// OwnerOf 查询 tab 归属。
func (st *State) OwnerOf(targetID string) *Session {
	st.mu.Lock()
	defer st.mu.Unlock()
	return st.targetOwn[targetID]
}

// DropTarget tab 消亡（targetDestroyed 事件）时解除归属。
func (st *State) DropTarget(targetID string) {
	st.mu.Lock()
	defer st.mu.Unlock()
	if sess, ok := st.targetOwn[targetID]; ok {
		delete(sess.ownedTargets, targetID)
		delete(st.targetOwn, targetID)
	}
}

// BindDsSession 绑定下游 attach sessionId → session（事件路由依据）。
func (st *State) BindDsSession(sess *Session, dsSessionID string) {
	st.mu.Lock()
	defer st.mu.Unlock()
	st.dsSession[dsSessionID] = sess
}

// SessionOfDs 下游 sessionId → session（事件路由查询）。
func (st *State) SessionOfDs(dsSessionID string) *Session {
	st.mu.Lock()
	defer st.mu.Unlock()
	return st.dsSession[dsSessionID]
}

// UnbindDsSession 下游 session 拆除（detachedFromTarget 事件）。
func (st *State) UnbindDsSession(dsSessionID string) {
	st.mu.Lock()
	defer st.mu.Unlock()
	delete(st.dsSession, dsSessionID)
}

// NextDsID 登记一条上游命令，返回重映射后的下游 id。
func (st *State) NextDsID(sess *Session, upID int64, hasUpID bool, tag, method string) int64 {
	dsID := st.nextID.Add(1)
	st.mu.Lock()
	st.pending[dsID] = PendingEntry{Sess: sess, UpID: upID, HasUpID: hasUpID, Tag: tag, Method: method}
	st.mu.Unlock()
	return dsID
}

// NextCallID 分配一个同步调用的下游 id（响应经 RespCh 投递）。
func (st *State) NextCallID(ch chan map[string]any, method string) int64 {
	st.mu.Lock()
	defer st.mu.Unlock()
	id := st.nextID.Add(1)
	st.pending[id] = PendingEntry{Method: method, RespCh: ch}
	return id
}

// NextSessCallID 分配一个「会话署名」的同步调用下游 id：响应先做 tag 处理
// （attach 绑定 / create 归属），再投递 RespCh。用于代理主动发起、需要与
// 上游应答保持时序的命令（setAutoAttach 改写的同步补挂）。
func (st *State) NextSessCallID(sess *Session, tag, method string, ch chan map[string]any) int64 {
	st.mu.Lock()
	defer st.mu.Unlock()
	id := st.nextID.Add(1)
	st.pending[id] = PendingEntry{Sess: sess, Tag: tag, Method: method, RespCh: ch}
	return id
}

// TakePending 响应到达时取回关联（一次性）。
func (st *State) TakePending(dsID int64) (PendingEntry, bool) {
	st.mu.Lock()
	defer st.mu.Unlock()
	entry, ok := st.pending[dsID]
	if ok {
		delete(st.pending, dsID)
	}
	return entry, ok
}

// Snapshot 会话状态快照（status 端点用）。
func (st *State) Snapshot() []map[string]any {
	st.mu.Lock()
	defer st.mu.Unlock()
	out := make([]map[string]any, 0, len(st.sessions))
	for _, sess := range st.sessions {
		out = append(out, map[string]any{
			"name":       sess.Name,
			"connected":  sess.Connected(),
			"targets":    len(sess.ownedTargets),
			"downstream": sess.Downstream(),
		})
	}
	return out
}
