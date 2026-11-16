#!/bin/bash
# serve.sh — 分离启动 cdproxy Go 二进制（脱离调用方进程组，防会话退出连坐）
# 兜底通道：App 未运行时 plugin 调这里拉起 CLI 形态代理。
# 用法: scripts/serve.sh [--data-dir PATH] [--control-port N] [--ws-port N]
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN="$DIR/var/cdproxy"
if [ ! -x "$BIN" ]; then
  echo "错误: $BIN 不存在。请先构建（go build -o var/cdproxy ./cmd/cdproxy）或启动 cdproxy 桌面 App。" >&2
  exit 1
fi
mkdir -p "$DIR/var"
# 分离启动：setsid 脱离进程组，调用方退出不连坐；日志续写 var/service.log
( setsid "$BIN" serve --data-dir "$DIR/var/plugin-serve" "$@" \
    >>"$DIR/var/service.log" 2>&1 </dev/null & )
echo "cdproxy 已分离启动（日志 var/service.log）"
