# AGENTS.md — cdproxy

> AI / 贡献者协作入口。先读本文件，再读对应模块的顶部注释。外部只保留 [README.md](README.md) / [README.zh.md](README.zh.md)（双语用户入口）、本文（协作契约）与 [docs/CI-CD.md](docs/CI-CD.md)（密钥/签名/CI/发版运维）。

## 1. 项目概述

`cdproxy`（仓库 `yangyaofei/cdproxy`）是面向 AI Agent（`agent-browser` / Playwright / Puppeteer 等）的**共享 Chrome 基座与会话级隔离 CDP 转发代理**：
Go 服务统一管理基座 Chrome 生命周期、按会话隔离的 CDP 协议转发、HTTP 控制面与 Admin 页面；
桌面端以 Wails v3 打包为 `cdproxy.app` / `cdproxy.exe`（macOS / Windows 跨平台），对外亦可走 CLI 或隐式 stdio `plugin` 模式接入。

**是什么**：本机浏览器共享基础设施（多 agent/skill 并发用同一个带登录态的 Chrome，
互不见彼此 tab）。
**不是什么**：不做远程浏览器、不做云 provider（browserless/browserbase 等）、
不做 agent 语义层（那是 agent-browser 自己的事）。

Go 主实现模块（生产 CLI 与桌面 App 共用内核；旧 Python `src/` 已退出跟踪）：

| 模块 | 职责 | 红线 |
|---|---|---|
| `internal/core` | 引擎编排：settings/interlog/keeper 配置/proxy/control 组装 + 监听生命周期（端口重绑/开关） | CLI 与桌面 App 共用；重绑不得丢会话/令牌状态 |
| `internal/proxy` | 标准 CDP HTTP 发现（`/json/version`、`/json/list`）与 WS 网关（`cdp_gateway.go`：`[/{standalone\|extension}][/session/{id}][/{token}]`，Token 反向识别 + 前缀严格交叉校验 + `Host`/`Origin` 原生防线 + 匿名 1 WS = 1 会话）+ 双源链路 | 协议语义改动必须过 `scripts/smoke_test.py` 全部六项 |
| `internal/state` | 归属表 / 会话表 / sid 绑定 / pending 组 | 不做 IO |
| `internal/control` | HTTP 控制面（`auth.go`：Wails 进程内 `InternalHandler` 信任直通，外部 TCP `9224` 除 `/health` 外统一强校验 `alloc_token`）+ Admin 静态页 + `/versions` + `/integrations/agent-browser`；端口变更异步重绑 | 不写业务，只转发调用；外部 TCP 不得裸奔暴露令牌；改写 `~/.agent-browser/config.json` 前必须自动备份 |
| `internal/plugin` | `agent-browser.plugin.v1` stdio provider 协议实现（CLI 与桌面 App 共用；读本地 `0600` `settings.json` 取端口与 `alloc_token`，服务未起时后台自启） | 不得弹出桌面窗口 |
| `internal/settings` | 运行时设置（单文件 `0600` `settings.json`，内置 `default`/`standalone`/`extension` 三条标准入口与固定会话令牌，在线生效） | 端口互斥校验；越下限钳制；不得在日志打印明文令牌 |
| `internal/keeper` | Chrome 基座探活/冷启动/精确停止 + `agent-browser` 唯一解析链 | 绝不允许无差别 killall/pkill |
| `internal/httputil` | 下载与版本检查共享 HTTP 客户端（拆分阶段超时、无整包死限、显式 UA、429/5xx 退避重试） | `Client.Timeout` 恒为 0，由调用方 context 控制总时长 |
| `internal/interlog` | per-session CDP 交互日志（落盘 + 内存环形） | — |
| `cmd/cdproxy` | CLI 入口（serve/status/stop/plugin，无子命令+管道隐式进 plugin） | 端口 flags 为启动覆盖，启动后 settings 是事实源 |
| `desktop/` | Wails v3 桌面宿主（`cdproxy.app` / `cdproxy.exe`）：`plugin` 子命令前置分流不启 GUI；Dock/托盘+管理窗口；EngineService.DoRequest 进程内执行 control 路由；内嵌 agent-browser（pin+校验+staging+解析链） | App 与 daemon 二选一（同数据目录同端口）；窗口操作勿用 app.Show()（非主线程 SIGTRAP） |
| `static/admin/` | Admin 前端单一源（零构建 Alpine + vendored Tabulator + `i18n.js` 中/英双语）；`scripts/sync_admin_frontend.py` 同步到 `desktop/frontend/` | 改完必须跑 `--check` 验证一致 |
| `ext/cdp-ext/` | Chrome MV3 扩展 **Cdproxy Connector**（反向回连 `/ext` + 标签组归属映射 + Popup/Options 内置实时 `中 / EN` 切换与 `_locales/{en,zh_CN}` 双语），`assets.go` 经 `all:ext/cdp-ext` 编译期嵌入二进制 | 同步更新 `manifest.json` 版本号 |

## 2. 架构全景

### 数据流

```
agent-browser daemon（每 session 一个）
  │ stdio JSON（agent-browser.plugin.v1；信封 {type, request:{provider, session, launchOptions}}）
  ▼
cdproxy（无子命令 + stdin 管道隐式进 plugin 模式：launch→POST /sessions；服务不在则自动拉起）
  │ HTTP 127.0.0.1:9224
  ▼
control（HTTP 控制面）─alloc/release→ proxy（WS 127.0.0.1:9225/cdp/<token>）
  │                                     │ 下游双源（standalone 基座 / extension 回连）
  ▼                                     ▼
Admin 页 / Wails 桌面 UI             keeper：Chrome @127.0.0.1:9222（profile 带登录态）
```

### 术语速查

| 概念 | 说明 |
|------|------|
| 基座（keeper） | 共享 Chrome 实例，`~/.cdproxy/browser-profile` 承载登录态 |
| 上游 | agent-browser daemon 到代理的 WS 连接（每 session 一条，token 凭证） |
| 下游/源 | 代理到浏览器的连接，**双源常开并存**：standalone=按需 dial keeper 基座（9222，id 重映射在此发生）；extension=cdp-ext 扩展反向拨入 `GET /ext?token=`（常开待命）。会话在分配时按解析链（显式 source 参数 > 前缀规则 > `settings.routing.default_source`）定格绑定一个源，之后切路由不影响存量会话（平滑切换） |
| 归属（ownership） | tab（targetId）属于创建它的 session；getTargets 只见自己的 |
| 会话组（tab group） | extension 下游：会话名下 tab 自动归入 Chrome 原生组 `<prefix> <会话名>`（默认 `cdproxy: <会话名>`，可在线配置）；**组 = 唯一真相，成员 = 会话可见性**（proxy 归属表是组事实的投影：拖入=归属、拖出=收回、跨组拖动=领地转移）；组内 tab 可真关（拖入即交出）；release 按扩展配置（close/mark/keep）；组在即领地（墓碑复活/整组认领）；冷启动 gstate 重建无孤儿 |
| 回收（reap） | 断连 60s / 分配后未连接 300s（运行时设置可调）→ 关名下 tab 摘会话 |
| 焦点策略（focus_mode） | background（默认）：createTarget 强制 background + activateTarget/bringToFront 假成功不转发，操作不抢用户焦点；steal=原生 |

## 3. 如何着手 ★

改任何模块前，先读其包注释；跨模块改动按此顺序读：
`internal/proxy`（转发语义）→ `internal/state`（数据结构）→ `internal/control`（对外契约）→ `internal/core`（装配编排）。

### 场景 walkthrough

- 新增一个运行时设置：`internal/settings/settings.go` 加字段与校验 → Admin 页
  `static/admin/index.html` 加输入 + `app.js` 加字段 → `scripts/sync_admin_frontend.py` 同步 → `internal/settings/*_test.go` 补用例。
- 基座保护：`Browser.close` 在代理侧拦截（假成功），任何会话杀不掉共享 Chrome。
- 调整 CDP 过滤规则：`internal/proxy/proxy.go` 与 `rules.go` 成对改 → `scripts/smoke_test.py` 六项必须全绿。
- 换 Chrome 路径/profile：`internal/keeper/keeper.go` 或 `serve` 参数。

## 4. 环境约束

- macOS + uv（Python ≥3.12）；Chrome 默认 `/Applications/Google Chrome.app/.../Google Chrome`
- 端口约定：9222（Chrome）/ 9224（控制面）/ 9225（代理 WS），均可 CLI 覆盖
- 运行数据（日志/settings/pid）一律在仓库 `var/`（已 gitignore）；**禁用系统 /tmp**
- agent-browser 版本基线（实测）：
  - 0.36.0：close 不回调 provider（回收靠断连触发）、plugin 信封 session
    在嵌套 `request` 层
  - 0.41.1（2026-11 实测）：`get cdp-url` 变纯查询，浏览器不在时报
    `Browser not launched` 不再自动拉起；页面命令（open 等）仍全冷自愈
    （CLI 自动拉 daemon，daemon 自动拉浏览器）。keeper.EnsureRunning 已改
    探测-冷启动两段式适配

## 5. 开发命令

Go 主实现（cd 仓库根）：

```bash
CGO_ENABLED=0 go build -ldflags="-s -w" -o var/cdproxy ./cmd/cdproxy
codesign --force --sign - var/cdproxy
go vet ./... && go test ./...     # 门禁
var/cdproxy serve                 # 运行（status/stop 同入口）
# 双源常开：standalone 按需拉起；/ext 等扩展回连。
# 新会话源 = 显式 source > routing.rules 前缀 > routing.default_source（Admin 页「源」tab 在线可切）。
```

桌面 App（Wails v3，需 wails3 CLI：`go install github.com/wailsapp/wails/v3/cmd/wails3@latest`）：

```bash
cd desktop && PATH="$HOME/go/bin:$PATH" wails3 task package:embedded   # 同步+bindings+内嵌 agent-browser+.app 打包一体
# 或纯二进制构建：
cd desktop && PATH="$HOME/go/bin:$PATH" wails3 build
codesign --force --sign - desktop/bin/cdproxy                          # 本地运行需 ad-hoc 重签
# Admin 前端单一源检查（改 static/admin 后须重跑 sync）：
python3 scripts/sync_admin_frontend.py --check
```

`codesign` 步骤必需：`-s -w` 剥符号后 Go 写入的 ad-hoc 签名失配，不重签名
的二进制会被 macOS 内核在 exec 时 SIGKILL（CODESIGNING Invalid Signature，
rc=137 且零输出，崩溃报告在 ~/Library/Logs/DiagnosticReports/）。


Admin 页：服务起来后开 `http://127.0.0.1:9224/`（状态/会话释放/设置/日志尾巴/停机）。

## 6. 编码规范

- docstring 全中文、模块级自包含（不引用 issue/MR，闭包自足）
- 全量类型注解；import 一律文件头（含函数内禁 import）
- 禁 `# noqa` / `# type: ignore`（除非用户许可 + ADR）
- 禁裸 except；控制面边界向调用方回因（`{type(exc).__name__}: {exc}`）
- 命名 snake_case；端口/时限等魔数进 `KeeperConfig` / `RuntimeSettings` / 模块常量

## 7. 测试体系

| 层 | 位置 | 依赖 | 何时跑 |
|----|------|------|--------|
| 单元 | `go test -count=1 ./...`（含 core 重绑/端口设置/版本升级接口） | 无 | 每次改动 |
| 冒烟 | `scripts/smoke_test.py` 六项判定（`ABP_CONTROL` 可换端口） | 服务 + 真实 Chrome | 改 proxy/keeper 后必跑 |
| 事件准入 | `scripts/ext_event_gate_test.mjs`（G1-G5：组外 tab 静默/预开归属就绪/组内事件照常/建关对称/无主日志恒空） | 服务+浏览器 | 改 sw.js 事件路径或 proxy 事件路由后必跑 |
| 接入点冒烟 | `scripts/ext_endpoint_test.mjs`（E0-E8：端点直连双源/错 token 401/Bearer 等价/重置吊销/自定义端点/顶替/无令牌 401；依赖 `npm --prefix var/pwtest i ws`） | 服务 | 改接入点/认证逻辑后必跑 |
| 扩展冒烟 | `scripts/ext_smoke_test.py`（T0–T7：含在线切默认源与平滑切换语义，服务需 /ext 可达 + 浏览器装 cdp-ext；测试实例需 `PUT /settings {"sources":{"token":"dev"}}` 对齐测试扩展默认令牌） | 服务 + 浏览器装 cdp-ext | 改扩展/proxy 转发后必跑 |
| 韧性 E2E | `scripts/ext_restart_test.mjs`（R1–R3：SW target 关闭→持久化+restore 同 sid 续接；模拟点「取消」软休眠→懒重挂；死 sid 诚实报错，16 项） | 同上 + 浏览器带调试端口 | 改 sw.js 会话表/持久化/休眠语义后必跑 |
| 标签组 E2E | `scripts/ext_group_test.mjs`（G1–G8：自动入组/拖入归属/真关/拖出收回/三策略 release/墓碑复活/整组认领；SW eval 模拟用户组操作） | 同上 + 浏览器带调试端口 | 改组/归属/release 语义后必跑 |
| 冷启动孤儿 E2E | `scripts/ext_cold_test.mjs`（C1–C5：清持久化+杀 SW 冷启动 → gstate 重建无孤儿；墓碑复活认领） | 同上 | 改 gstate/冷启动语义后必跑 |
| Playwright E2E | `scripts/ext_playwright_e2e.mjs`（connectOverCDP 零改动客户端全链路） | 同上 | 改会话语义/时序后必跑 |
| CDP 协议兼容 | `scripts/ext_cdp_compat_test.mjs`（14 项：BFCache goBack/goForward、`_blank`/window.open/popup、Storage Cookies、跨源 OOPIF、Web Worker、Fetch 拦截、Browser 窗口与版本号） | 同上 | 改扩展/proxy 协议转发后必跑 |
| 并发压测 | `scripts/concurrency_test.sh`（3 校验流 + 1 churn 流四路并行，零串扰判定） | 服务 + 真实 Chrome | 改转发/焦点/回收语义后必跑 |
| 浏览器级 | agent-browser 实连（指向 `cdproxy` 二进制的 plugin 配置） | 全链路 | 接入相关改动 |

冒烟六项：预开 tab 隔离 / createTarget 归属 / attach+eval 路由 / 越权拒绝 /
release 回收 / Browser.close 基座保护。**任何转发语义改动，chrome 与 extension
两套冒烟不全绿不得提交。**

测试用浏览器加载扩展：`node scripts/load_ext_via_cdp.mjs <cdp-http-url> <扩展目录>`
（浏览器需带 `--enable-unsafe-extension-debugging`，Chrome 159 起 `--load-extension`
失效）；SW 内调试：`node scripts/sw_eval.mjs <cdp-http-url> sw.js <表达式>`。

## 8. 禁止项

- killall / pkill / kill -9 等无差别杀进程（Chrome 停止只走 `keeper.stop` 的精确 PID）
- 写系统 `/tmp`（临时文件用仓库 `var/` 或项目相对 `./tmp`）
- 截断测试/命令输出（`| tail` 看失败详情、`>/dev/null` 吞错）
- 未经用户批准改 `~/.agent-browser/config.json`（全局接线是用户决策）
- `agent-browser` 并发多 session 时混用 default session 名（会撞归属）

## 9. 工作流

- 改代码必须同步：模块 docstring（契约变化）、双语 [README.md](README.md) / [README.zh.md](README.zh.md)（使用变化）、AGENTS.md 本文（架构/规范变化）
- 提交信息含：问题/发现过程/实现方案/实现过程/总结
- 变更涉及转发语义 → 冒烟六项 + 真实 agent-browser 双 session 隔离抽查
- 全局配置接线（provider/plugins 四键）属用户决策，Agent 只提供 README 样例
