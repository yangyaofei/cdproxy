// Package interlog 提供 per-session CDP 交互日志：结构化记录 + 内存环形 + jsonl 落盘。
//
// 核心语义是「变换链可见」：每个上游命令记录 in（daemon 原始 params）与
// out（代理改写后实际转发给 Chrome 的 params），二者并排即可看到 proxy
// 改了什么（delta 一句话概括）；响应记录 up_id/ds_id 双向 id 与结构化
// result/error。所有载荷经深裁剪（保结构、截长串、限深度/条数/总长）。
//
// 记录三类事件：
//   - up/cmd：上游命令（含守卫决策：forwarded/rewritten/focus-guard/…）
//   - down/resp：下游响应（ok/error + 结构化 result）
//   - down/event：下游事件（路由结果；无主 target 创建归档到 "__unowned__"，
//     即页面发起弹窗等浏览器内部行为的证据点）
//
// 存储策略：
//   - 内存：每 session 环形 500 条（Admin 展示）
//   - 文件：dataDir/logs/<session>.jsonl 追加（release 后保留；>100 文件清最老）
//   - IO 故障静默降级——观测设施不允许影响代理主链路
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
	maxStr      = 120 // 字符串截断长度
	maxArr      = 8   // 数组保留条数
	maxKeys     = 16  // 对象保留键数
	maxDepth    = 5   // 递归深度
	maxJSON     = 2048

	// UnownedKey 无主 target 事件的归档键（页面发起弹窗等浏览器内部行为，
	// 不经过上游 WS，任何 session 都不拥有它们）。
	UnownedKey = "__unowned__"
)

// Entry 单条交互记录（jsonl 一行一个，内存同构）。
type Entry struct {
	TS       int64  `json:"ts"`
	Dir      string `json:"dir"`                // up | down
	Kind     string `json:"kind"`               // cmd | resp | event
	Session  string `json:"session"`
	Method   string `json:"method,omitempty"`
	UpID     any    `json:"up_id,omitempty"`    // 上游命令 id（daemon 视角）
	DSID     any    `json:"ds_id,omitempty"`    // 下游重映射 id（Chrome 视角）
	TargetID string `json:"target_id,omitempty"`
	Status   string `json:"status,omitempty"`   // ok | error（resp）
	Action   string `json:"action,omitempty"`   // forwarded | rewritten | focus-guard | base-guard | scope-guard | alloc | routed | unowned
	In       any    `json:"in,omitempty"`       // 原始 params（改写前快照，深裁剪）
	Out      any    `json:"out,omitempty"`      // 转发 params（仅改写时记录）
	Delta    string `json:"delta,omitempty"`    // 变更/决策说明（一句话）
	Result   any    `json:"result,omitempty"`   // resp 的 result/error（深裁剪）
	Detail   string `json:"detail,omitempty"`   // 杂项（alloc/sid/兜底说明）
}

// Log 全局交互日志（单锁串行）。
type Log struct {
	mu       sync.Mutex
	dir      string              // dataDir/logs（空 = 不落盘）
	rings    map[string][]Entry  // session → 环形
	files    map[string]*os.File // session → 追加句柄
	silentIO bool                // 文件写失败后置位（防刷错误日志）
}

// New 构造。dir 为空则只保留内存环形。
func New(dir string) *Log {
	return &Log{dir: dir, rings: map[string][]Entry{}, files: map[string]*os.File{}}
}

// Append 记录一条。
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

// Drop 清除某会话的内存环形与文件句柄（release 时调用；jsonl 保留在盘上）。
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
		var err error
		path := filepath.Join(l.dir, e.Session+".jsonl")
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

// ── 深裁剪：保结构、截长串、限深度/条数/总长 ────────────────────────

// Safe 深裁剪任意值 → 可安全序列化的结构（超限整体降级为截断字符串）。
func Safe(v any) any {
	if v == nil {
		return nil
	}
	trimmed := trimValue(v, 0)
	data, err := json.Marshal(trimmed)
	if err != nil {
		return fmt.Sprintf("%v", v)
	}
	if len(data) > maxJSON {
		s := string(data)
		return s[:maxJSON] + "…"
	}
	return trimmed
}

func trimValue(v any, depth int) any {
	if depth >= maxDepth {
		return "…"
	}
	switch x := v.(type) {
	case string:
		if len(x) > maxStr {
			return x[:maxStr] + "…"
		}
		return x
	case []any:
		out := make([]any, 0, len(x))
		for i, it := range x {
			if i >= maxArr {
				out = append(out, map[string]any{"__truncated__": len(x) - maxArr})
				break
			}
			out = append(out, trimValue(it, depth+1))
		}
		return out
	case map[string]any:
		out := make(map[string]any, len(x))
		n := 0
		for k, it := range x {
			n++
			if n > maxKeys {
				out["__more_keys__"] = len(x) - maxKeys
				break
			}
			out[k] = trimValue(it, depth+1)
		}
		return out
	default:
		return v
	}
}
