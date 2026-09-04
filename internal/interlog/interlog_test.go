package interlog

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRingCapAndOrder(t *testing.T) {
	l := New("")
	for i := 0; i < ringCap + 50; i++ {
		l.Append(Entry{Session: "s1", Dir: "up", Kind: "cmd", Method: "M", Detail: "d"})
	}
	r := l.Ring("s1", 0)
	if len(r) != ringCap {
		t.Fatalf("环形容量 %d != %d", len(r), ringCap)
	}
	// 最新 50 条被保留（最老的被挤掉）
	if r[0].Detail != "d" || len(r) != ringCap {
		t.Fatalf("环形顺序异常")
	}
	// limit 截取
	if got := l.Ring("s1", 10); len(got) != 10 {
		t.Fatalf("limit 截取失败: %d", len(got))
	}
	if got := l.Sessions(); len(got) != 1 || got[0] != "s1" {
		t.Fatalf("Sessions 异常: %v", got)
	}
}

func TestUnownedDropped(t *testing.T) {
	l := New("")
	l.Append(Entry{Session: "", Dir: "down", Kind: "event", Method: "Target.targetCreated"})
	if got := l.Sessions(); len(got) != 0 {
		t.Fatalf("空 session 应丢弃: %v", got)
	}
}

func TestFilePersistAndDrop(t *testing.T) {
	dir := t.TempDir()
	l := New(dir)
	l.Append(Entry{Session: "s1", Dir: "up", Kind: "cmd", Method: "Page.navigate", Action: "forwarded"})
	l.Append(Entry{Session: "s1", Dir: "down", Kind: "resp", Status: "error", Detail: "boom"})
	l.Drop("s1")
	data, err := os.ReadFile(filepath.Join(dir, "s1.jsonl"))
	if err != nil {
		t.Fatalf("jsonl 未落盘: %v", err)
	}
	lines := strings.Split(strings.TrimRight(string(data), "\n"), "\n")
	if len(lines) != 2 {
		t.Fatalf("行数 %d != 2", len(lines))
	}
	var e Entry
	if err := json.Unmarshal([]byte(lines[1]), &e); err != nil || e.Status != "error" {
		t.Fatalf("jsonl 解析异常: %v %v", err, e)
	}
	// Drop 后内存清空、文件仍在
	if got := l.Ring("s1", 0); len(got) != 0 {
		t.Fatalf("Drop 后环形应清空")
	}
}

func TestTrim(t *testing.T) {
	long := strings.Repeat("x", 500)
	got := Trim(map[string]any{"k": long})
	if len(got) > detailCap+3 {
		t.Fatalf("Trim 未截断: %d", len(got))
	}
	if !strings.HasSuffix(got, "…") {
		t.Fatalf("截断应带省略号")
	}
	if Trim(nil) != "" {
		t.Fatalf("nil 应为空")
	}
}
