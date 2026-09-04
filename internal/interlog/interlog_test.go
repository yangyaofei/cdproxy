package interlog

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRingCapAndOrder(t *testing.T) {
	l := New("")
	for i := 0; i < ringCap+50; i++ {
		l.Append(Entry{Session: "s1", Dir: "up", Kind: "cmd", Method: "M", Detail: "d"})
	}
	r := l.Ring("s1", 0)
	if len(r) != ringCap {
		t.Fatalf("环形容量 %d != %d", len(r), ringCap)
	}
	if got := l.Ring("s1", 10); len(got) != 10 {
		t.Fatalf("limit 截取失败: %d", len(got))
	}
	if got := l.Sessions(); len(got) != 1 || got[0] != "s1" {
		t.Fatalf("Sessions 异常: %v", got)
	}
}

func TestUnownedKeyKept(t *testing.T) {
	l := New("")
	l.Append(Entry{Session: UnownedKey, Dir: "down", Kind: "event", Action: "unowned"})
	if got := l.Sessions(); len(got) != 1 || got[0] != UnownedKey {
		t.Fatalf("unowned 应保留: %v", got)
	}
	l.Append(Entry{Session: "", Dir: "down", Kind: "event"})
	if got := l.Sessions(); len(got) != 1 {
		t.Fatalf("空 session 应丢弃")
	}
}

func TestFilePersistAndDrop(t *testing.T) {
	dir := t.TempDir()
	l := New(dir)
	l.Append(Entry{Session: "s1", Dir: "up", Kind: "cmd", Method: "Page.navigate",
		UpID: int64(7), DSID: int64(42), Action: "forwarded", In: map[string]any{"url": "https://x.com"}})
	l.Append(Entry{Session: "s1", Dir: "down", Kind: "resp", Status: "error",
		Method: "Page.navigate", UpID: int64(7), Result: map[string]any{"message": "boom"}})
	l.DetachFile("s1")
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
	var c Entry
	_ = json.Unmarshal([]byte(lines[0]), &c)
	// JSON 反序列化后数字为 float64
	if c.UpID.(float64) != 7 || c.DSID.(float64) != 42 {
		t.Fatalf("up/ds id 序列化异常: %+v", c)
	}
	// DetachFile 后环形保留（断开会话日志可查）、文件仍在盘上
	if got := l.Ring("s1", 0); len(got) != 2 {
		t.Fatalf("DetachFile 后环形应保留: %d", len(got))
	}
}

func TestRecentAndEviction(t *testing.T) {
	l := New("")
	for i := 0; i < maxRings+20; i++ {
		l.Append(Entry{Session: fmt.Sprintf("s%03d", i), Dir: "up", Kind: "cmd", Method: "M"})
	}
	rec := l.Recent(0)
	if len(rec) != maxRings {
		t.Fatalf("环形数应淘汰到 %d: %d", maxRings, len(rec))
	}
	if rec[0]["name"] != fmt.Sprintf("s%03d", maxRings+19) {
		t.Fatalf("Recent 排序异常: %v", rec[0])
	}
	for _, r := range rec {
		if r["name"] == "s000" {
			t.Fatalf("最老会话应被淘汰")
		}
	}
}

func jsonMust(v any) []byte {
	data, _ := json.Marshal(v)
	return data
}

func makeArr(n int) []any {
	out := make([]any, n)
	for i := range out {
		out[i] = i
	}
	return out
}

func TestSafeDeepTrim(t *testing.T) {
	long := strings.Repeat("x", 500)
	big := map[string]any{
		"s":     long,
		"arr":   makeArr(50),
		"deep":  map[string]any{"a": map[string]any{"b": map[string]any{"c": map[string]any{"d": map[string]any{"e": "too deep"}}}}},
	}
	got := Safe(big)
	m, ok := got.(map[string]any)
	if !ok {
		t.Fatalf("应保持结构")
	}
	if s, _ := m["s"].(string); !strings.HasSuffix(s, "…") || len(s) != maxStr+3 {
		t.Fatalf("长串应截断: %d", len(s))
	}
	if arr, _ := m["arr"].([]any); len(arr) != maxArr+1 {
		t.Fatalf("数组应截断到 %d+标记: %d", maxArr, len(arr))
	}
	deep, _ := m["deep"].(map[string]any)
	a, _ := deep["a"].(map[string]any)
	b, _ := a["b"].(map[string]any)
	c, _ := b["c"].(map[string]any)
	d, _ := c["d"]
	if d != "…" {
		t.Fatalf("超深应截断为省略号: %v", d)
	}
	// 超总长整体降级字符串：深裁剪上限内仍可超过 maxJSON（16 键 × 120 字符）
	huge := map[string]any{}
	for i := 0; i < maxKeys+1; i++ {
		huge[string(rune('a'+i%26))+string(rune('a'+i/26))] = strings.Repeat("y", maxStr)
	}
	if v := Safe(huge); true {
		s, isStr := v.(string)
		if !isStr || len(s) > maxJSON+3 {
			t.Fatalf("超总长应降级截断字符串: %T len=%d", v, len(jsonMust(v)))
		}
	}
	if Safe(nil) != nil {
		t.Fatalf("nil 应为 nil")
	}
}
