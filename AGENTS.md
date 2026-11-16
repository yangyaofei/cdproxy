# AGENTS.md — agent-browser-proxy

> AI 协作入口。先读本文件，再读相关 docstring。

## 1. 项目概述

agent-browser-proxy 是 agent-browser 的**共享 Chrome 基座与 CDP 转发代理**：一个
Python 服务统一管理基座 Chrome 生命周期、按会话隔离的 CDP 协议转发、HTTP 控制面
与 Admin 页面；对外只暴露一个薄 plugin（stdio JSON）供 agent-browser 全局配置接入。

**是什么**：本机浏览器共享基础设施（多 agent/skill 并发用同一个带登录态的 Chrome，
互不见彼此 tab）。
**不是什么**：不做远程浏览器、不做云 provider（browserless/browserbase 等）、
不做 agent 语义层（那是 agent-browser 自己的事）。

src layout：`src/agent_browser_proxy/`（服务六模块：keeper / proxy / state /
control / settings / service）；另根目录 `static/admin/`（Admin 页静态文件，零构建，
定位见 `static/README.md`）+ `plugin/ab-proxy-plugin`（薄壳）+ `scripts/`（serve.sh /
smoke_test.py）+ `tests/unit/`（纯逻辑单测）。

Go 主实现模块（生产二进制；桌面化改造中）：

| 模块 | 职责 | 红线 |
|---|---|---|
| `internal/core` | 引擎编排：settings/interlog/keeper 配置/proxy/control 组装 + 监听生命周期（端口重绑/开关） | CLI 与桌面 App 共用；重绑不得丢会话/令牌状态 |
| `internal/proxy` | CDP 转发核心 + 双源（standalone/extension）链路 + 监听重绑 | 协议语义改动必须过 `scripts/smoke_test.py` 全部六项 |
| `internal/state` | 归属表 / 会话表 / sid 绑定 / pending 组 | 不做 IO |
| `internal/control` | HTTP 控制面 + Admin 静态页；端口类设置变更触发异步重绑回调 | 不写业务，只转发调用 |
| `internal/settings` | 运行时设置（单文件 settings.json，在线生效） | 端口互斥校验；越下限钳制 |
| `internal/keeper` | Chrome 基座探活/冷启动/精确停止 | 绝不允许无差别 killall/pkill |
| `internal/interlog` | per-session CDP 交互日志（落盘 + 内存环形） | — |
| `cmd/agent-browser-proxy` | CLI 入口（serve/status/stop/plugin） | 端口 flags 为启动覆盖，启动后 settings 是事实源 |
| `desktop/` | Wails v3 桌面宿主：菜单栏+托盘+管理窗口；EngineService.DoRequest 进程内执行 control 路由；内嵌 agent-browser（pin+校验+staging+解析链） | App 与 daemon 二选一（同数据目录同端口）；窗口操作勿用 app.Show()（非主线程 SIGTRAP） |

## 2. 架构全景

### 数据流

```
agent-browser daemon（每 session 一个）
  │ stdio JSON（agent-browser.plugin.v1；信封 {type, request:{provider, session, launchOptions}}）
  ▼
plugin/ab-proxy-plugin（薄壳：launch→POST /sessions；服务不在则自动拉起）
  │ HTTP 127.0.0.1:9224
  ▼
control（线程 HTTP）─alloc/release→ CdpProxy（asyncio 主循环，WS 127.0.0.1:9225/cdp/<token>）
  │                                     │ 下游单条浏览器级 WS（断线自愈）
  ▼                                     ▼
Admin 页（GET /）                    keeper：Chrome @127.0.0.1:9222（profile 带登录态）
```

### 术语速查

| 概念 | 说明 |
|------|------|
| 基座（keeper） | 共享 Chrome 实例，`~/agent-browser/profile` 承载登录态 |
| 上游 | agent-browser daemon 到代理的 WS 连接（每 session 一条，token 凭证） |
| 下游/源 | 代理到浏览器的连接，**双源常开并存**：standalone=按需 dial keeper 基座（9222，id 重映射在此发生）；extension=cdp-ext 扩展反向拨入 `GET /ext?token=`（常开待命）。会话在分配时按解析链（显式 source 参数 > 前缀规则 > `settings.routing.default_source`）定格绑定一个源，之后切路由不影响存量会话（平滑切换） |
| 归属（ownership） | tab（targetId）属于创建它的 session；getTargets 只见自己的 |
| 会话组（tab group） | extension 下游：会话名下 tab 自动归入 Chrome 原生组 `ab: <会话名>`；**组 = 唯一真相，成员 = 会话可见性**（proxy 归属表是组事实的投影：拖入=归属、拖出=收回、跨组拖动=领地转移）；组内 tab 可真关（拖入即交出）；release 按扩展配置（close/mark/keep）；组在即领地（墓碑复活/整组认领）；冷启动 gstate 重建无孤儿 |
| 回收（reap） | 断连 60s / 分配后未连接 300s（运行时设置可调）→ 关名下 tab 摘会话 |
| 焦点策略（focus_mode） | background（默认）：createTarget 强制 background + activateTarget/bringToFront 假成功不转发，操作不抢用户焦点；steal=原生 |

### 模块职责表

| 模块 | 职责 | 红线 |
|------|------|------|
| `keeper.py` | Chrome 启动/复用/探活/精确停止（PID 级） | **绝不允许无差别 killall/pkill** |
| `proxy.py` | CDP 转发核心：归属过滤、越权拒绝、事件定向路由、id 双向重映射 | 协议语义改动必须过 `scripts/smoke_test.py` 全部五项 |
| `state.py` | 归属表 / 会话表 / pending 关联（纯逻辑，单事件循环内无锁） | 不做 IO |
| `control.py` | HTTP 控制面 + 静态页（线程桥接 asyncio） | 不写业务，只转发调用 |
| `settings.py` | 运行时设置（**单文件 var/settings.json，无数据库**，在线生效） | 越下限钳制 |
| `service.py` | 装配编排（端口绑定重试 / 信号 / PID 文件） | — |
| `plugin/` | stdio↔HTTP 协议桥（agent-browser 只认 stdio 插件协议，故必须有可执行文件翻译；返回代理 URL 而非 Chrome URL——隔离在 proxy） | 不承载状态，不直接碰 Chrome |

## 3. 如何着手 ★

改任何模块前，先读其模块 docstring；跨模块改动按此顺序读：
`proxy.py`（转发语义）→ `state.py`（数据结构）→ `control.py`（对外契约）→ `service.py`（装配）。

### 场景 walkthrough

- 新增一个运行时设置：`settings.py` 加字段（含 `_MIN_VALUES` 下限）→ Admin 页
  `index.html` 加输入 + `app.js` 加 save 字段 → `tests/unit/test_settings.py` 补用例。
- 基座保护：`Browser.close` 在代理侧拦截（假成功），任何会话杀不掉共享 Chrome
- 调整 CDP 过滤规则：`proxy.py` `_on_upstream_message`（命令守卫）与
  `_on_ds_event`（事件路由）成对改 → smoke_test 五项必须全绿。
- 换 Chrome 路径/profile：`keeper.py::KeeperConfig.defaults()` 或 serve 参数。

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
CGO_ENABLED=0 go build -ldflags="-s -w" -o var/agent-browser-proxy ./cmd/agent-browser-proxy
codesign --force --sign - var/agent-browser-proxy
go vet ./... && go test ./...     # 门禁
var/agent-browser-proxy serve     # 运行（status/stop 同入口）
# 双源常开：standalone 按需拉起；/ext 等扩展回连。
# 新会话源 = 显式 source > routing.rules 前缀 > routing.default_source（Admin 页「源」tab 在线可切）。
```

桌面 App（Wails v3，需 wails3 CLI：`go install github.com/wailsapp/wails/v3/cmd/wails3@latest`）：

```bash
cd desktop && PATH="$HOME/go/bin:$PATH" wails3 build   # 前端同步+bindings+构建一体
codesign --force --sign - desktop/bin/abp-desktop      # 本地运行需 ad-hoc 重签
# Admin 前端单一源检查（改 static/admin 后须重跑 sync）：
python3 scripts/sync_admin_frontend.py --check
```

`codesign` 步骤必需：`-s -w` 剥符号后 Go 写入的 ad-hoc 签名失配，不重签名
的二进制会被 macOS 内核在 exec 时 SIGKILL（CODESIGNING Invalid Signature，
rc=137 且零输出，崩溃报告在 ~/Library/Logs/DiagnosticReports/）。

Python 参考实现（语义基准，行为对齐依据）：

```bash
uv sync --dev                                   # 安装依赖（含 dev）
scripts/serve.sh                                # 分离启动服务（脱离进程组）
uv run python -m agent_browser_proxy status     # 状态（含 keeper/sessions/settings）
uv run python -m agent_browser_proxy stop       # 停服务（基座不受影响）
uv run pytest                                   # 单元测试
uv run python scripts/smoke_test.py             # 端到端五项（需真实 Chrome，服务会自起）
uv run ruff check src/ tests/ scripts/ plugin/  # lint
uv run mypy src/                                # 类型检查
```

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
| 单元 | `tests/unit/`（state / settings 纯逻辑）+ `go test ./...`（含 core 重绑/端口设置） | 无 | 每次改动 |
| 冒烟 | `scripts/smoke_test.py` 六项判定（`ABP_CONTROL` 可换端口） | 服务 + 真实 Chrome | 改 proxy/keeper 后必跑 |
| 事件准入 | `scripts/ext_event_gate_test.mjs`（G1-G5：组外 tab 静默/预开归属就绪/组内事件照常/建关对称/无主日志恒空） | 服务+浏览器 | 改 sw.js 事件路径或 proxy 事件路由后必跑 |
| 接入点冒烟 | `scripts/ext_endpoint_test.mjs`（E0-E8：端点直连双源/错 token 401/Bearer 等价/重置吊销/自定义端点/顶替/无令牌 401；依赖 `npm --prefix var/pwtest i ws`） | 服务 | 改接入点/认证逻辑后必跑 |
| 扩展冒烟 | `scripts/ext_smoke_test.py`（T0–T7：含在线切默认源与平滑切换语义，服务需 /ext 可达 + 浏览器装 cdp-ext；测试实例需 `PUT /settings {"sources":{"token":"dev"}}` 对齐测试扩展默认令牌） | 服务 + 浏览器装 cdp-ext | 改扩展/proxy 转发后必跑 |
| 韧性 E2E | `scripts/ext_restart_test.mjs`（R1–R3：SW target 关闭→持久化+restore 同 sid 续接；模拟点「取消」软休眠→懒重挂；死 sid 诚实报错，16 项） | 同上 + 浏览器带调试端口 | 改 sw.js 会话表/持久化/休眠语义后必跑 |
| 标签组 E2E | `scripts/ext_group_test.mjs`（G1–G8：自动入组/拖入归属/真关/拖出收回/三策略 release/墓碑复活/整组认领；SW eval 模拟用户组操作） | 同上 + 浏览器带调试端口 | 改组/归属/release 语义后必跑 |
| 冷启动孤儿 E2E | `scripts/ext_cold_test.mjs`（C1–C5：清持久化+杀 SW 冷启动 → gstate 重建无孤儿；墓碑复活认领） | 同上 | 改 gstate/冷启动语义后必跑 |
| Playwright E2E | `scripts/ext_playwright_e2e.mjs`（connectOverCDP 零改动客户端全链路） | 同上 | 改会话语义/时序后必跑 |
| 并发压测 | `scripts/concurrency_test.sh`（3 校验流 + 1 churn 流四路并行，零串扰判定） | 服务 + 真实 Chrome | 改转发/焦点/回收语义后必跑 |
| 浏览器级 | agent-browser 实连（`--config examples/agent-browser-config.json`） | 全链路 | 接入相关改动 |

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

- 改代码必须同步：模块 docstring（契约变化）、README（使用变化）、
  AGENTS.md 本文（架构/规范变化）
- 提交信息含：问题/发现过程/实现方案/实现过程/总结
- 变更涉及转发语义 → 冒烟五项 + 真实 agent-browser 双 session 隔离抽查
- 全局配置接线（provider/plugins 四键）属用户决策，Agent 只提供 README 样例
