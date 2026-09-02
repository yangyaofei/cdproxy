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
// 连接孤儿与 tab 泄漏。返回值 created 表示是否全新创建。
func (st *State) Alloc(name string, token string) (*Session, bool) {
	st.mu.Lock()
	defer st.mu.Unlock()
	if existing, ok := st.sessions[name]; ok {
		return existing, false
	}
	sess := &Session{Name: name, Token: token, ownedTargets: map[string]struct{}{}}
	st.sessions[name] = sess
	st.byToken[token] = sess
	return sess, true
}

// Release 释放 session，返回其名下 target 列表（调用方负责关 tab）。
func (st *State) Release(name string) []string {
	st.mu.Lock()
	defer st.mu.Unlock()
	sess, ok := st.sessions[name]
	if !ok {
		return nil
	}
	targets := sess.OwnedTargets()
	st.drop(sess)
	return targets
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

// ClearOwnership 清空全部归属（下游重建时调用）。
func (st *State) ClearOwnership() {
	st.mu.Lock()
	defer st.mu.Unlock()
	for _, sess := range st.sessions {
		sess.ownedTargets = map[string]struct{}{}
	}
	st.targetOwn = map[string]*Session{}
	st.dsSession = map[string]*Session{}
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
func (st *State) NextDsID(sess *Session, upID int64, hasUpID bool, tag string) int64 {
	dsID := st.nextID.Add(1)
	st.mu.Lock()
	st.pending[dsID] = PendingEntry{Sess: sess, UpID: upID, HasUpID: hasUpID, Tag: tag}
	st.mu.Unlock()
	return dsID
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
			"name":      sess.Name,
			"connected": sess.Connected(),
			"targets":   len(sess.ownedTargets),
		})
	}
	return out
}
