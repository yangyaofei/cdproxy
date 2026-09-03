> **历史研究档案**（存量 skill（twitter-daily 等）用法扫描与兼容策略）。结论已固化为 agent-browser-proxy 产品（见 SKILL.md 与仓库 README），日常使用不读本文；追溯设计依据时再查。

# 全量 skill 扫描：agent-browser 用法矩阵与改造建议

> 2026-09-01 全量扫描（四个 skill 根目录）。基线：两方式模型——默认走 router /
> 自备 config 走自己的。本文是清单与分析，不含已实施的改动。

## 一、消费者全景（9 个 + 1 文档源）

### B 类：自管 + --state 登录态（sibling 模式，改造重点）

**1. twitter-daily**（enrich-browser.sh / enrich-single-tweet.sh / enrich-auth-export.sh / scroll-collect.sh）
- `AGENT_BROWSER_SESSION=<名>`（默认 twitter-daily）+ `--state <auth.json>` own-launch
- 自管生命周期：lock 文件（4h 过期）+ 存活探测（`tab list --json` + `eval 1+1`）+ close
- tab 标签寻址（`tab new --label` / `tab "<label>"` / `tab close "<label>"`）+ eval 导航/滚动/提取/保活
- auth 来源：`twitter-daily/auth/twitter-auth*.json`（`state save` 导出）
- 另有 `--mode cdp` 分支（Linux 环境用，macOS 无端点）

**2. twitter-follow**（_browser.sh / import-following.sh）
- 与 twitter-daily 同款模式（BF_SESSION 变量 + lock + 探测 + close）
- **复用 twitter-daily 导出的 auth state**（探测 twitter-daily/auth/twitter-auth*.json）
- import-following.sh 内是裸 `agent-browser` 调用（靠调用方 env）

### C 类：裸调用共享脚本（context 依赖，被 B 类上层调用）

**3. oh-my-agents/skills/scripts/**（scroll-collect-tweets.sh / fetch-blog.sh / page-pdf.sh）
- 全部裸 `agent-browser`（无 session env、无 flag）→ 继承调用方 `AGENT_BROWSER_SESSION`；独立跑 = default session
- 用法面：`tab "<label>"` / `tab list --json` / `tab new --label` / `eval --stdin` / `wait`
- **page-pdf.sh 特殊（深水区）**：绕过 CLI，`socat UNIX-CONNECT:$SOCKET` 直连 daemon
  Unix socket 发原始协议（`{"action":"pdf",...}`）；SOCKET 默认
  `~/.agent-browser/default.sock`，`--socket` 可覆盖。router 世界不受影响
  （router 只换 daemon 的浏览器连接，daemon 协议层不动），但依赖目标 session
  daemon 已活着（:84 socket 不存在直接报错）。

### A 类：指引层 / ad hoc（零改造或一行级）

| skill | 形态 |
|---|---|
| reading-list-update | `AGENT_BROWSER_SESSION=default` + tab close by id + SubAgent 降级 |
| tech-fetch | SKILL.md prose：agent-browser 第一公民 + SubAgent 手动降级，无约定 |
| research | 一行提及（curl 拿不到才切 agent-browser） |
| session-explorer | 一行提及（tools 列表） |
| gcx-loki-logs | 一行提及（Grafana UI 辅助） |
| 官方 agent-browser skill（~/.agents/skills） | 文档源，非消费者 |

## 二、本轮两个机制发现

1. **`AGENT_BROWSER_CONFIG` env**（flags.rs:335-339，load_config）：
   `--config` flag > `AGENT_BROWSER_CONFIG` env > 全局 config。设了 explicit
   （flag 或 env）就**只读该文件、不 merge 全局**——正是「干净 config」语义。
   B 类改造的最小侵入路径：脚本头部一行 `export AGENT_BROWSER_CONFIG=<path>`，
   所有子调用（含 C 类共享脚本）全部继承，零调用点修改。
2. **page-pdf.sh 的 daemon socket 直连**：见 C-3。router 不破坏它，但记录在案
   （任何动 daemon socket 布局的未来设计都要过一遍这个依赖）。

## 三、改造建议（已实施 ✅ 2026-09-02）

| 类 | 对象 | 建议 | 状态 |
|---|---|---|---|
| B | twitter-daily / twitter-follow | 脚本头部 `export AGENT_BROWSER_CONFIG=<skill>/scripts/agent-browser.json`（内容 `{"headed":true}`）+ 删光 CDP 模式 | ✅ 已完成 |
| C | scripts/*.sh | 不动（跟随调用方 env；B 类改造后自动隔离） | ✅ 无需改 |
| A | reading-list / tech-fetch 等 | 落默认 router 零改造；后续把 default session 指引改具名（每 skill 一行） | 待做（router 落地时） |
| — | page-pdf socket 依赖 | 不动；归档记录 | ✅ 已记录 |

已实施明细（6 脚本 + 2 配置 + 3 文档）：
- enrich-single-tweet.sh / enrich-browser.sh / scroll-collect.sh：删 `--cdp`/`--mode`/RUN_MODE/cdp 分支/ensure_tab（cdp 专用）；头部加 AGENT_BROWSER_CONFIG export
- _browser.sh / export-following.sh / import-following.sh：删 BF_MODE/cdp 分支/--mode 解析校验；_browser.sh 加 AGENT_BROWSER_CONFIG export（source 时生效，覆盖两个主脚本）
- 新增 `twitter-daily/scripts/agent-browser.json`、`twitter-follow/scripts/agent-browser.json` = `{"headed": true}`
- twitter-daily/SKILL.md（5 处 --cdp 用法删 + 隔离说明）、twitter-follow/SKILL.md（参数表/策略段/脚本表）、CHANGELOG.md 新条目
- 验证：bash -n ×6 ✓、cdp 残留清零 ✓、--start/--close 全链路实测 ✓（dummy state，lock 生命周期正常）

结论：全部存量用法在两方式模型下都有明确落点；B 类两个 skill 已改造完成，C 类跟随继承，A 类天然落默认。
