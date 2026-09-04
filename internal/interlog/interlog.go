// Package interlog 提供 per-session CDP 交互日志：内存环形缓冲 + jsonl 落盘。
//
// 记录三类事件：
//   - up：上游命令（daemon → 代理），带守卫决策标注
//   - resp：下游响应（代理 → daemon 回传），ok/error + 错误详情
//   - event：下游事件（路由结果），只记 method 与去向，不存 payload
//
// 存储策略：
//   - 内存：每 session 环形 500 条（Admin 展示用，O(1) 读取）
//   - 文件：dataDir/logs/<session>.jsonl 追加写（全量流水，release 后保留）
//   - 目录治理：文件数超过 maxLogFiles(100) 时清最老（按 mtime）
//
// 写路径：Append 全局串行（单锁），文件写失败静默降级（日志记录一次）——
// 交互日志是观测设施，不允许它的故障影响代理主链路。
package interlog

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"
)

const (
	ringCap     = 500
	maxLogFiles = 100
	detailCap   = 200
)

// Entry 单条交互记录（jsonl 一行一个，内存同构）。
type Entry struct {
	TS      int64  `json:"ts"`                 // unix 毫秒
	Dir     string `json:"dir"`                // up | down
	Kind    string `json:"kind"`               // cmd | resp | event
	Session string `json:"session"`            // 归属会话（event 为路由结果；未知为 ""）
	Method  string `json:"method,omitempty"`   // CDP method
	ID      any    `json:"id,omitempty"`       // 上游命令 id 或下游响应 id
	Status  string `json:"status,omitempty"`   // ok | error（resp）
	Action  string `json:"action,omitempty"`   // forwarded | focus-guard | scope-guard | rewritten | faked | unrouted
	Detail  string `json:"detail,omitempty"`   // 截断摘要（params / error / 路由说明）
}

// Log 全局交互日志（单锁串行；量级：每命令 2-3 条，无热点路径依赖）。
type Log struct {
	mu       sync.Mutex
	dir      string                // dataDir/logs（空 = 不落盘，仅内存）
	rings    map[string][]Entry    // session → 环形
	files    map[string]*os.File   // session → 追加句柄
	silentIO bool                  // 文件写失败后置位（避免刷错误日志）
}

// New 构造。dir 为空则只保留内存环形。
func New(dir string) *Log {
	return &Log{dir: dir, rings: map[string][]Entry{}, files: map[string]*os.File{}}
}

// Append 记录一条。session 为空时仍落内存不到（无归属事件：session="" 直接丢弃——
// 无法归属的下行事件对排障价值有限，且避免脏 session 键）。
func (l *Log) Append(e Entry) {
	if e.Session == "" {
		return
	}
	if e.TS == 0 {
		e.TS = time.Now().UnixMilli()
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	ring := append(l.rings[e.Session], e)
	if len(ring) > ringCap {
		ring = ring[len(ring)-ringCap:]
	}
	l.rings[e.Session] = ring
	l.writeFile(e)
}

// Ring 返回某会话的内存快照（最新 limit 条，时间升序）。
func (l *Log) Ring(session string, limit int) []Entry {
	l.mu.Lock()
	defer l.mu.Unlock()
	ring := l.rings[session]
	if limit <= 0 || limit > len(ring) {
		limit = len(ring)
	}
	out := make([]Entry, limit)
	copy(out, ring[len(ring)-limit:])
	return out
}

// Sessions 返回有日志的会话名（按最近一条时间降序）。
func (l *Log) Sessions() []string {
	l.mu.Lock()
	defer l.mu.Unlock()
	type pair struct {
		name string
		last int64
	}
	var ps []pair
	for name, ring := range l.rings {
		if len(ring) > 0 {
			ps = append(ps, pair{name, ring[len(ring)-1].TS})
		}
	}
	sort.Slice(ps, func(i, j int) bool { return ps[i].last > ps[j].last })
	out := make([]string, len(ps))
	for i, p := range ps {
		out[i] = p.name
	}
	return out
}

// Drop 清除某会话的内存环形与文件句柄（release 时调用；jsonl 文件保留在盘上）。
func (l *Log) Drop(session string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if f, ok := l.files[session]; ok {
		_ = f.Close()
		delete(l.files, session)
	}
	delete(l.rings, session)
	l.pruneFilesLocked()
}

// pruneFilesLocked jsonl 文件数超限时清最老（调用方持锁）。
func (l *Log) pruneFilesLocked() {
	if l.dir == "" {
		return
	}
	entries, err := os.ReadDir(l.dir)
	if err != nil || len(entries) <= maxLogFiles {
		return
	}
	type pair struct {
		path  string
		mtime time.Time
	}
	var ps []pair
	for _, e := range entries {
		if e.IsDir() || filepath.Ext(e.Name()) != ".jsonl" {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		ps = append(ps, pair{filepath.Join(l.dir, e.Name()), info.ModTime()})
	}
	if len(ps) <= maxLogFiles {
		return
	}
	sort.Slice(ps, func(i, j int) bool { return ps[i].mtime.Before(ps[j].mtime) })
	for _, p := range ps[:len(ps)-maxLogFiles] {
		_ = os.Remove(p.path)
	}
}

// writeFile 追加一行 jsonl（调用方持锁；句柄按 session 复用）。
func (l *Log) writeFile(e Entry) {
	if l.dir == "" || l.silentIO {
		return
	}
	f, ok := l.files[e.Session]
	if !ok {
		if err := os.MkdirAll(l.dir, 0o755); err != nil {
			l.silentIO = true
			return
		}
		path := filepath.Join(l.dir, e.Session+".jsonl")
		var err error
		f, err = os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
		if err != nil {
			l.silentIO = true
			return
		}
		l.files[e.Session] = f
	}
	data, err := json.Marshal(e)
	if err != nil {
		return
	}
	if _, err := f.Write(append(data, '\n')); err != nil {
		_ = f.Close()
		delete(l.files, e.Session)
		l.silentIO = true
	}
}

// Trim 对任意值做截断摘要（JSON 序列化 + 超长截断）。
func Trim(v any) string {
	if v == nil {
		return ""
	}
	data, err := json.Marshal(v)
	if err != nil {
		return fmt.Sprintf("%v", v)
	}
	s := string(data)
	if len(s) > detailCap {
		s = s[:detailCap] + "…"
	}
	return s
}
