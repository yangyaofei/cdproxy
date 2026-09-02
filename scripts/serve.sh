#!/bin/bash
# serve.sh — 分离启动 agent-browser-proxy（脱离调用方进程组，防会话退出连坐）
# 用法: scripts/serve.sh [--chrome PATH] [--profile PATH] [--cdp-port N] [--control-port N] [--ws-port N]
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mkdir -p "$DIR/var"
python3 - "$DIR" "$@" <<'PYEOF'
import subprocess
import sys
from pathlib import Path

repo = Path(sys.argv[1])
extra = sys.argv[2:]
log = (repo / "var" / "service.log").open("ab")
subprocess.Popen(
    ["uv", "run", "--project", str(repo), "python", "-m", "agent_browser_proxy", "serve", *extra],
    stdout=log,
    stderr=subprocess.STDOUT,
    stdin=subprocess.DEVNULL,
    start_new_session=True,  # 关键：脱离进程组，调用方退出/被清理不连坐
)
print("已分离启动（日志: var/service.log）")
PYEOF
