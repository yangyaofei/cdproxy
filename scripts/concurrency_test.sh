#!/bin/bash
# concurrency_test.sh — 并发压力验证：多 session × 多 tab 同时操作零串扰
#
# 判定：
#   C1 四路并行（3 校验流 + 1 churn 流）下，每次 eval 的 document.title
#      必须精确等于当前所属 tab 的标记（零串扰）
#   C2 结束后各 session 的 tab list 恰为自己的 tab 集合（隔离不破）
#   C3 churn 流的 tab new/eval/close 循环全程正确
# 用法: scripts/concurrency_test.sh [迭代数，默认 20]
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CFG="$DIR/var/full-config.json"
BIN="$DIR/var/agent-browser-proxy"
# 自含：Go 二进制缺失则构建；config 缺失则按 examples 样例生成（指向本仓库二进制）
if [ ! -x "$BIN" ]; then
  echo "构建 Go 二进制…"
  (cd "$DIR" && CGO_ENABLED=0 go build -ldflags="-s -w" -o "$BIN" ./cmd/agent-browser-proxy) || exit 1
fi
if [ ! -f "$CFG" ]; then
  mkdir -p "$DIR/var"
  sed "s|/Users/yangyaofei/workspace/agent-browser-proxy/var/agent-browser-proxy|$BIN|" \
    "$DIR/examples/agent-browser-config.json" > "$CFG"
fi
OUT="$DIR/var/conc-results"
ITER="${1:-20}"
rm -rf "$OUT"; mkdir -p "$OUT"

AB() { agent-browser --config "$CFG" "$@"; }

# ── setup：3 个 session 各开 home + 3 个标记 tab ──
setup_session() {
  local s=$1
  AB --session "$s" open "data:text/html,<title>${s}-home</title>" >/dev/null 2>&1
  for n in 1 2 3; do
    AB --session "$s" tab new --label "$s-t$n" \
       "data:text/html,<title>${s}-T$n</title>" >/dev/null 2>&1
  done
}

# ── 校验流：轮询切换自己的 3 个 tab，验证 title ──
verify_worker() {
  local s=$1
  for _ in $(seq 1 "$ITER"); do
    for n in 1 2 3; do
      AB --session "$s" tab "$s-t$n" >/dev/null 2>&1
      got=$(AB --session "$s" eval "document.title" 2>/dev/null | tail -1)
      want="\"${s}-T$n\""
      if [ "$got" = "$want" ]; then
        echo ok >> "$OUT/$s.ok"
      else
        echo "t$n want=$want got=$got" >> "$OUT/$s.fail"
      fi
    done
  done
}

# ── churn 流：tab 开→验→关 循环 ──
churn_worker() {
  local s=conc-churn
  AB --session "$s" open "data:text/html,<title>churn-home</title>" >/dev/null 2>&1
  for i in $(seq 1 10); do
    AB --session "$s" tab new --label "churn-$i" \
       "data:text/html,<title>CHURN-$i</title>" >/dev/null 2>&1
    got=$(AB --session "$s" eval "document.title" 2>/dev/null | tail -1)
    if [ "$got" = "\"CHURN-$i\"" ]; then
      echo ok >> "$OUT/churn.ok"
    else
      echo "churn$i got=$got" >> "$OUT/churn.fail"
    fi
    AB --session "$s" tab close "churn-$i" >/dev/null 2>&1
  done
}

echo "[setup] 4 个 session 各自就位…"
for s in conc-a conc-b conc-c; do setup_session "$s"; done

echo "[run] 4 workers parallel (iter=$ITER)..."
T0=$(date +%s)
verify_worker conc-a & W1=$!
verify_worker conc-b & W2=$!
verify_worker conc-c & W3=$!
churn_worker & W4=$!
wait $W1 $W2 $W3 $W4
T1=$(date +%s)
echo "[done] 耗时 $((T1 - T0))s"

# ── C2：隔离检查 ──
echo ""
echo "── C2 tab list 隔离 ──"
for s in conc-a conc-b conc-c; do
  labels=$(AB --session "$s" tab list --json 2>/dev/null | python3 -c "
import sys, json
d = json.load(sys.stdin)
tabs = d.get('data', {}).get('tabs') or d.get('tabs') or []
print(','.join(sorted(t.get('label') or '' for t in tabs)))
")
  want=",${s}-t1,${s}-t2,${s}-t3"  # open 不设 label，home 的 label 为空串
  if [ "$labels" = "$want" ]; then
    echo "$s: ✓ ($labels)"
  else
    echo "$s: ✗ 期望[$want] 实际[$labels]" | tee -a "$OUT/isolation.fail"
  fi
done

# ── 汇总 ──
echo ""
echo "── 汇总 ──"
python3 - "$OUT" <<'PYEOF'
import sys
from pathlib import Path

out = Path(sys.argv[1])
ok = sum(len(f.read_text().splitlines()) for f in out.glob("*.ok"))
fails = {f.name: f.read_text().splitlines() for f in out.glob("*.fail")}
total_fail = sum(len(v) for v in fails.values())
print(f"成功操作: {ok}  失败: {total_fail}")
for name, lines in fails.items():
    print(f"  ✗ {name}: {len(lines)} 例，前 3 例: {lines[:3]}")
if total_fail == 0 and not list(out.glob("isolation.fail")):
    print("\n并发压测全部通过 ✅（C1 零串扰 / C2 隔离不破 / C3 churn 正确）")
    sys.exit(0)
sys.exit(1)
PYEOF
RC=$?

# ── 清理：关 session（基座不动）──
for s in conc-a conc-b conc-c conc-churn; do
  AB --session "$s" close >/dev/null 2>&1
done
exit $RC
