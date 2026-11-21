#!/usr/bin/env bash
# prepare_agent_browser.sh — 构建期准备内嵌 agent-browser 二进制（OpenChamber 模式）。
#
# 流程：pin 版本（desktop/embedded/agent-browser-version.txt，精确 semver）→
# 从 GitHub release 下载平台二进制 → sha256 校验（对 tag 的 release API digest，
# 无独立 checksums 文件）→ 缓存 var/.cache/agent-browser/<版本>/ → staging 到
# desktop/build/agent-browser/agent-browser → 跑 --version 复验。幂等：staged
# 二进制版本已等于 pin 则直接退出（增量构建提速）。
#
# 环境变量：
#   AB_AGENT_BROWSER_VERSION  覆盖 pin（同样必须精确 semver）
#
# 用法：
#   scripts/prepare_agent_browser.sh              # 常规（读 pin）
#   AB_AGENT_BROWSER_VERSION=0.44.0 scripts/...   # 临时覆盖
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PIN_FILE="$REPO_ROOT/desktop/embedded/agent-browser-version.txt"
CACHE_DIR="$REPO_ROOT/var/.cache/agent-browser"
STAGE_DIR="$REPO_ROOT/desktop/build/agent-browser"
STAGE_BIN="$STAGE_DIR/agent-browser"
GITHUB_API="https://api.github.com/repos/vercel-labs/agent-browser/releases/tags"

VERSION="${AB_AGENT_BROWSER_VERSION:-$(cat "$PIN_FILE")}"
VERSION="$(echo "$VERSION" | tr -d '[:space:]')"
if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then
  echo "ERROR: 版本必须是精确 semver，当前: '$VERSION'（pin 文件或环境变量）" >&2
  exit 1
fi

# 平台映射（macOS 起步仅 arm64；加平台时在此扩展）
case "$(uname -s)/$(uname -m)" in
  Darwin/arm64) ASSET="agent-browser-darwin-arm64" ;;
  Darwin/x86_64) ASSET="agent-browser-darwin-x64" ;;
  *) echo "ERROR: 未支持的平台 $(uname -s)/$(uname -m)" >&2; exit 1 ;;
esac

# 幂等短路：staged 已是目标版本
if [[ -x "$STAGE_BIN" ]] && "$STAGE_BIN" --version 2>/dev/null | grep -q " $VERSION$"; then
  echo "已 staged 且版本匹配: $STAGE_BIN ($VERSION)"
  exit 0
fi

ARCHIVE="$CACHE_DIR/$VERSION/$ASSET"
mkdir -p "$CACHE_DIR/$VERSION" "$STAGE_DIR"

if [[ ! -f "$ARCHIVE" ]]; then
  URL="https://github.com/vercel-labs/agent-browser/releases/download/v$VERSION/$ASSET"
  echo "下载 $URL"
  curl -fL --retry 3 -o "$ARCHIVE.part" "$URL"
  mv "$ARCHIVE.part" "$ARCHIVE"
fi

# 校验：release API 的 asset digest（sha256:…）。API 不可达但缓存存在时
# 警告放行（缓存文件此前已验过）；首次下载必须验。CI 中传 GITHUB_TOKEN 防限流。
API_HEADERS=(-H "Accept: application/vnd.github+json")
if [[ -n "${GITHUB_TOKEN:-}" ]]; then
  API_HEADERS+=(-H "Authorization: Bearer $GITHUB_TOKEN")
fi
EXPECT="$(curl -fsSL --retry 3 "${API_HEADERS[@]}" "$GITHUB_API/v$VERSION" | python3 -c "
import json,sys
d=json.load(sys.stdin)
for a in d.get('assets',[]):
    if a['name']=='$ASSET':
        print(a.get('digest','')); break
" || true)"
if [[ "$EXPECT" == sha256:* ]]; then
  ACTUAL="sha256:$(shasum -a 256 "$ARCHIVE" | cut -d' ' -f1)"
  if [[ "$ACTUAL" != "$EXPECT" ]]; then
    echo "ERROR: sha256 不匹配  expect=$EXPECT actual=$ACTUAL" >&2
    rm -f "$ARCHIVE"
    exit 1
  fi
  echo "sha256 校验通过: $EXPECT"
elif [[ -f "$ARCHIVE" ]]; then
  echo "WARN: 无法取得 API digest（离线？），使用已有缓存且跳过校验" >&2
else
  echo "ERROR: 无法取得校验值且无缓存" >&2
  exit 1
fi

# staging：清空（保留 .gitkeep）再拷入
find "$STAGE_DIR" -mindepth 1 -not -name '.gitkeep' -delete
cp "$ARCHIVE" "$STAGE_BIN"
chmod 755 "$STAGE_BIN"

# 复验：能跑且版本匹配
GOT="$("$STAGE_BIN" --version 2>/dev/null || true)"
if [[ "$GOT" != *" $VERSION" ]]; then
  echo "ERROR: staged 二进制版本复验失败: '$GOT' (期望含 $VERSION)" >&2
  exit 1
fi
echo "staged: $STAGE_BIN ($GOT)"
