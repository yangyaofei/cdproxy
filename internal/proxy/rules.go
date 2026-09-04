// rules.go — 上游命令改写规则引擎（纯函数，可单测）。
//
// 规则来源 settings.Rewrites（默认=「不抢焦点」+ 基座保护，Admin 可编辑）。
// 顺序执行：rewrite 累积修改 params；fake 停止转发并假成功应答。
package proxy

import (
	"strings"

	"github.com/yangyaofei/agent-browser-proxy/internal/settings"
)

// ruleOutcome 规则链的执行结果。
type ruleOutcome struct {
	Stop   bool   // true = 停止转发（fake 假成功）
	Action string // 日志 action：forwarded | rewritten | focus-guard | base-guard
	Delta  string // 变更/决策说明（分号连接）
}

// matchRule 方法名匹配：精确或尾部 * 前缀通配。
func matchRule(pattern, method string) bool {
	if strings.HasSuffix(pattern, "*") {
		return strings.HasPrefix(method, strings.TrimSuffix(pattern, "*"))
	}
	return pattern == method
}

// setNested 按 点路径 设置嵌套 map 键（中间层缺失则创建）。
func setNested(m map[string]any, path string, v any) {
	parts := strings.Split(path, ".")
	cur := m
	for i, k := range parts[:len(parts)-1] {
		next, ok := cur[k].(map[string]any)
		if !ok {
			next = map[string]any{}
			cur[k] = next
		}
		cur = next
		_ = i
	}
	cur[parts[len(parts)-1]] = v
}

// removeNested 按 点路径 删除嵌套 map 键（路径不存在则忽略）。
func removeNested(m map[string]any, path string) {
	parts := strings.Split(path, ".")
	cur := m
	for _, k := range parts[:len(parts)-1] {
		next, ok := cur[k].(map[string]any)
		if !ok {
			return
		}
		cur = next
	}
	delete(cur, parts[len(parts)-1])
}

// applyUpstreamRules 对 (method, params) 顺序应用规则集。
// params 会被 in-place 修改（调用方保证它来自 JSON 解码、无共享）。
// 返回结果含日志 action 与 delta；fake 时 params 不应再转发。
func applyUpstreamRules(rules []settings.RewriteRule, method string, params map[string]any) ruleOutcome {
	out := ruleOutcome{Action: "forwarded"}
	var deltas []string
	for _, r := range rules {
		if !matchRule(r.Match, method) {
			continue
		}
		switch r.Action {
		case "fake":
			out.Stop = true
			out.Action = "focus-guard"
			if r.Group == "base" {
				out.Action = "base-guard"
			}
			deltas = append(deltas, "faked（"+r.Note+"）")
			out.Delta = strings.Join(deltas, "; ")
			return out
		case "rewrite":
			changed := false
			for k, v := range r.Set {
				if params == nil {
					params = map[string]any{}
				}
				params[k] = v
				changed = true
				deltas = append(deltas, "+"+k)
			}
			for _, path := range r.Remove {
				removeNested(params, path)
				changed = true
				deltas = append(deltas, "-"+path)
			}
			if changed {
				out.Action = "rewritten"
			}
			if r.Note != "" && len(r.Set) == 0 && len(r.Remove) == 0 {
				// 纯观察规则（如焦点仿真透传）
				deltas = append(deltas, r.Note)
			}
		}
	}
	out.Delta = strings.Join(deltas, "; ")
	return out
}
