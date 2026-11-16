# agent-browser-proxy

agent-browser 共享 Chrome 的 CDP 转发代理：**一个进程**管全部——基座 Chrome 生命周期、
CDP 协议转发（会话级 tab 归属隔离）、控制面；外面只留一个薄 plugin。

## 架构

```
agent-browser daemon（多个 session，每人独立 daemon）
      │  stdio JSON（agent-browser.plugin.v1）
      ▼
plugin/ab-proxy-plugin（薄壳：launch/close → HTTP 控制面）
      │  POST /sessions {"name": <session>} → {"cdpUrl": ws://…}
      ▼
agent-browser-proxy 服务
  ├─ control（HTTP 127.0.0.1:9224）分配/释放/状态
  ├─ CdpProxy（WS 127.0.0.1:9225/cdp/<token>）
  │    ├─ 每个消费 session 一条上游连接
  │    ├─ 下游单条浏览器级 WS 长连复用（断线自愈）
  │    └─ 改写规则：getTargets 按归属过滤 / createTarget 登记归属 /
  │        attach·closeTarget 越权拒绝 / 事件定向路由 / id 双向重映射
  └─ keeper（Chrome @127.0.0.1:9222，profile 带共享登录态）
```

隔离语义：每个 session 只能看到、操作自己名下的 tab；基座 Chrome 与登录态全体共享，
一个 session 的 close 不影响他人。

## 快速开始（Go 主实现）

```bash
# 构建（单二进制，含内嵌 Admin 页）
CGO_ENABLED=0 go build -ldflags="-s -w" -o var/agent-browser-proxy ./cmd/agent-browser-proxy

var/agent-browser-proxy serve                    # 前台运行（keeper/代理/管理面）
var/agent-browser-proxy status                   # 状态 / 停止（stop）
open http://127.0.0.1:9224/                      # Admin 页（状态/释放/设置/日志/停机）

# 交叉编译（示例：Linux amd64）
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o var/agent-browser-proxy-linux ./cmd/agent-browser-proxy

# 质量门禁 + 测试
go vet ./...
go test ./...                                    # 单元测试
uv run --project scripts python scripts/smoke_test.py  # 端到端（需真实 Chrome，语言无关）
./scripts/concurrency_test.sh 20                  # 并发压测（自动构建二进制，四路并行零串扰）
```

插件配置无需 `args` 字段——二进制在「无子命令 + stdin 为管道」时自动进入 plugin 模式
（`{"command": "<二进制绝对路径>"}` 即可）。

数据目录默认 `~/.agent-browser/proxy/`（settings.json / service.log / pid），
`--data-dir` 可覆盖。

## 工程结构

```
├── AGENTS.md                 # AI 协作入口（架构/规范/工作流）
├── go.mod / assets.go        # Go 模块 + 静态资产内嵌（package assets 在仓库根）
├── cmd/agent-browser-proxy/  # CLI 入口（serve/status/stop/plugin + 隐式 plugin）
├── internal/
│   ├── core/                 # 引擎编排（CLI 与桌面 App 共用；端口重绑/开关）
│   ├── keeper/               # Chrome 基座生命周期
│   ├── proxy/                # CDP 转发核心（归属/路由/重映射/焦点/回收）
│   ├── state/                # 会话与关联表
│   ├── control/              # 管理面 HTTP + 内嵌 Admin 页
│   └── settings/             # 运行时设置
├── desktop/                  # 桌面 App（Wails v3，菜单栏常驻 + 管理窗口）
├── static/admin/             # Admin 页（Alpine 无构建 + vendored，go:embed 内嵌；App 前端同源生成）
├── plugin/ab-proxy-plugin    # agent-browser 插件壳（兜底拉起服务；Go 二进制自带 plugin 模式）
├── scripts/                  # smoke_test.py / sync_admin_frontend.py / concurrency_test.sh
├── internal/*/​*_test.go      # Go 单元测试
└── var/                      # 运行数据（gitignore；Go 版数据目录默认 ~/agent-browser/proxy）
```

## 内嵌 agent-browser（架构约束）

- **唯一解析链**：`settings.agent_browser_binary`（显式外部覆盖）> `.app/Contents/Resources/agent-browser/`（内嵌）> PATH（CLI 部署兜底）。UI 检测显示、keeper 实际拉起、版本探活三处共用 `keeper.ResolveAgentBrowser`——界面显示的就是实际运行的那个二进制。
- **内嵌版永不离开 bundle**：不存在「安装到 PATH」功能；只从 Resources 内部路径运行。
- **HOME 沙箱归仓**：keeper 拉起的 agent-browser 进程链 HOME 指向 `<数据目录>/ab-home`——agent-browser 状态根硬拼 `HOME/.agent-browser`（源码无 env 可重定向），会话文件/auth/加密钥/tmp 与基座 Chrome 副产物经此全部归数据目录，不污染用户主目录。socket 目录用 `AGENT_BROWSER_SOCKET_DIR` 解耦到 `<数据目录>/ab-sockets`（Unix socket 104 字节上限，不随 HOME 深度超限）。
- 用户手动执行的外部 agent-browser（brew/PATH 版）数据在用户 HOME，不属 proxy 管辖。

## 桌面 App

App 内 UI 为事件驱动（Wails 官方形态）：引擎状态变化点 → `Event.Emit("cdp:state", 完整状态JSON)` → 前端回调直达写入响应式变量——无请求、无防抖；在线时零轮询（仅引擎停机后 800ms 快探恢复感知 + 窗口 focus 对账兜底）。浏览器版 Admin 网页无事件通道，维持 5s 轮询（`admin_web_enabled` 控制，默认关）。（desktop/，Wails v3）

CLI daemon 的桌面宿主：同一引擎（internal/core）编译进主进程，菜单栏常驻
（无 Dock 图标）+ 托盘菜单（状态/打开管理界面/重启引擎/退出）+ 单实例
（再启动唤起已有窗口）。构建：

```bash
cd desktop && wails3 build        # 产出 desktop/bin/abp-desktop（前端同步 + bindings + go build 一体）
```

- **Admin 界面单一源**：`static/admin` 是唯一事实源，`scripts/sync_admin_frontend.py`
  生成 desktop 前端（Web 版走 fetch，App 版注入 `window.__abpWails` 走
  `EngineService.DoRequest` 进程内绑定——与 REST 同一套 control 路由，
  **外部端口关闭时界面照常工作**）
- **内嵌 agent-browser**（OpenChamber 模式）：`desktop/embedded/agent-browser-version.txt`
  pin 精确版本；`scripts/prepare_agent_browser.sh` 下载平台二进制（GitHub release）
  + sha256 校验（release API digest）+ 缓存 + staging + `--version` 复验（幂等）；
  `wails3 task package:embedded` 出带内嵌件的 .app（Resources/agent-browser/
  + 深度重签 + 包内复验）。运行时解析链：settings.agent_browser_binary →
  bundled（.app Resources 或 dev staging，env AB_AGENT_BROWSER_BUNDLED_DIR 可
  交接）→ PATH；托盘「安装内嵌 agent-browser 到 PATH」写符号链接
  （/usr/local/bin → ~/bin 按可写探测）
- 数据目录与 CLI 生产相同（`~/agent-browser/proxy`：同一份 settings/日志）；
  **App 与 daemon 二选一运行**（同端口，双开会绑定失败）
- App 存活时 plugin 直接使用 9224（不拉起 daemon）；App 退出后端口释放，
  下次 agent-browser 调用会经 serve.sh 拉起 daemon 兜底

## 发布（GoReleaser）

```bash
git tag v0.2.0 && git push origin v0.2.0   # 打 tag 即触发
```

CI（`.github/workflows/release.yml`）：质量门禁（vet+test）→ GoReleaser 四平台构建
（darwin/linux × amd64/arm64）→ tar.gz + SHA256SUMS 落 GitHub Release 页。
本地不发布验证：`goreleaser release --snapshot --clean`。

## 运行时设置

| 参数 | 默认 | 说明 |
|---|---|---|
| `disconnect_reap_seconds` | 60 | 上游断连后的回收宽限（容忍 daemon 重启） |
| `alloc_reap_seconds` | 300 | 分配后从未连接的回收时限（防泄漏） |
| `keeper_idle_shutdown_seconds` | 600 | 基座空闲自动关闭阈值（0 = 不启用） |
| `rewrites` | 不抢焦点+基座保护 | 上游命令改写规则（命令向守卫） |
| `sources` | 双源启用 + 自动令牌 | `standalone_enabled` / `extension_enabled`（两源至少留一）/ `token`（`/ext` 准入令牌）/ `alloc_token`（`POST /sessions` 准入）。令牌首启自动生成强随机（旧默认 dev 已废除）；子对象为合并语义（只传 token 不动开关）；重置走专用动作（吊销语义） |
| `routing` | standalone + `ext-`→extension | 会话名→源路由：`default_source` + `rules[]{prefix,source}`（先中先用）。解析链=显式 source 参数 > 前缀规则 > 默认源；只影响新分配 |
| `endpoints` | 内置 standalone/extension 两条 | 常驻 CDP 接入点 `{path, source, token, session}`：连接 `ws://…/<path>/<token>` 即以 session 名（默认=path）分配/复用会话。PUT 整表替换（token 按path 保留，新条目自动生成）；重置走 `POST /endpoints/{path}/reset-token`（吊销） |
| `control_port` | 9224 | 管理面（REST/Admin 页）端口。变更经进程内重绑生效（会话/令牌状态保留） |
| `ws_port` | 9225 | 上游 WS（`/cdp/<token>` 与 `/ext`）端口。重绑语义同上；存量连接由客户端自动重连 |
| `ports_enabled` | true | 外部端口总开关。false = 控制面与 WS 监听全部关闭（桌面 App 内嵌模式，仅 App 绑定可用） |

> 端口类设置变更后监听在进程内重建（旧监听先关、约 300ms 后绑新值）——
> 无需换进程；`--control-port`/`--ws-port` flags 降级为**启动覆盖**（兼容
> 旧脚本），启动后 settings 是运行时唯一事实源。

> 原则：proxy 是单向阀门——命令向（agent→浏览器）可守卫改写，事件向
> （浏览器→agent）只过滤转发、**永不回写**。曾有的 `popup_policy`（监听
> 浏览器侧 targetCreated 关"弹窗"）因违反此原则已移除：extension 模式下
> 用户手动开 tab 同样带 openerTabId，会被误杀（生产事故实证）。

修改渠道：Admin 页（即改即生效）或 `PUT /settings`；持久化到 `var/settings.json`。
**单文件设置，无数据库**。

## 接入 agent-browser（全局配置）

`~/.agent-browser/config.json`：

```json
{
  "headed": true,
  "idleTimeout": "15m",
  "provider": "ab-proxy",
  "plugins": [
    {
      "name": "ab-proxy",
      "command": "<本仓库绝对路径>/plugin/ab-proxy-plugin",
      "capabilities": ["browser.provider"]
    }
  ]
}
```

- `profile` 不放全局——登录态由 keeper 侧管理（默认 `~/agent-browser/profile`）
- 自管 skill（twitter-daily 等）不受影响：它们经 `AGENT_BROWSER_CONFIG` 指向自己的干净配置

不碰全局配置的试用方式：`agent-browser --config examples/agent-browser-config.json --session <名> open <url>`
（该文件即上述四键的样例）。

## 生命周期语义

| 事件 | 行为 |
|---|---|
| session 分配 | 预开一个归属 tab（保证 getTargets 非空 + 与基座 UI 隔离） |
| 上游断连（daemon close/idle） | 60s 宽限后自动回收（容忍 daemon 重启），关名下 tab |
| 分配后从未连接 | 300s 后回收（防泄漏） |
| 同名再分配（未连接态） | 复用会话与 tab（重连语义）；连接中则顶掉 |
| plugin browser.close | 释放会话（agent-browser 0.36.0 的 close 不回调 provider，实际靠断连回收兜底） |
| 基座 Chrome 挂死 | 下游断线自愈重连 + keeper 重启（清 stale SingletonLock） |

## 端口约定

| 端口 | 用途 |
|---|---|
| 9222 | Chrome 调试端口（keeper 固定） |
| 9224 | 控制面 HTTP |
| 9225 | 代理 WS（上游 cdpUrl） |
| 9234 / 9235 | 测试实例常用端口（控制面 / WS） |

## 扩展下游（cdp-ext）

双源**常开并存**：`/ext` 反向入口永远注册，装了 cdp-ext 的用户日常浏览器
随时回连待命；standalone（基座 Chrome）链路照常按需拉起。新会话走哪个源由
`settings.routing` 决定（显式 source 参数 > 会话名前缀规则 > 默认源——
Admin 页「源」tab 在线改，只影响新分配，存量会话继续用原源直到自然结束，
平滑无感）。适用于"没有可被调试的 Chrome"的场景——
Chrome 136 起 `--remote-debugging-port` 对默认 profile 失效，扩展走
`chrome.debugger` 官方通道，无命令行开关要求。

```
agent-browser daemon ──WS 9225/cdp/<token>──► proxy ─┬─ 按需 dial ──► keeper 基座 Chrome（standalone 会话）
                                                     └─ 常开待命 ◄── 反向拨出 WS /ext?token= ── cdp-ext(SW)
                                                                          │ chrome.debugger（26 个 CDP 域）
                                                                          ▼
                                                             用户日常 Chrome 的各 tab
```

用户侧一次性安装：Chrome 加载 `ext/cdp-ext/`（开发者模式→加载已解压），
扩展 options 页把 relay 指到 `ws://127.0.0.1:9225/ext`、token 与
`settings.sources.token` 一致。路由示例：

```bash
# 默认源切到 extension（存量会话不动；子对象合并语义，rules 不受影响）
curl -X PUT http://127.0.0.1:9224/settings \
  -H 'Content-Type: application/json' -d '{"routing":{"default_source":"extension"}}'
# 默认路由规则已含 ext- 前缀 → extension：ext- 开头的会话名自动走扩展源
```

双源语义与单源完全一致（归属隔离/越权拒绝/焦点策略/基座保护/断连
回收），差异只有三点：

- `Browser.close` 由扩展层拒绝（宿主是用户自己的浏览器，双保险）
- 浏览器级命令面为仿真（Target.* + Browser.getVersion/setDownloadBehavior），
  未知命令诚实报错；页面会话命令全部透传
- 一 tab 一 debugger：用户正开着 DevTools 的 tab 无法 attach（诚实报错）

两链路隔离规则：会话在分配时定格绑定一种形态；扩展回连只清 extension 侧
归属（standalone 会话不受牵连），基座重建只清 standalone 侧；事件路由校验
"来源链路 == 会话绑定"（双浏览器 targetId 撞车防护）。`/keeper/restart`
只动 chrome 基座；无基座时退化为复位扩展连接（扩展自行重连）。

扩展内建**虚拟会话多路复用**：一个物理 `chrome.debugger` attach 上可叠加多个
虚拟 CDP 会话（对齐真浏览器端点每连接独立会话），代理侧以
`Target.setAutoAttach` 拦截改写保证只 attach 会话名下 target（不给用户其他
tab 挂调试横幅）。响应回带 sessionId、attachedToTarget/detachedFromTarget
事件带 browserContextId/targetId、事件先于 setAutoAttach/createTarget 响应
送达——这些时序/字段细节是 Playwright connectOverCDP 的硬要求，均有测试锁定。

### 标签组：组 = 唯一真相，成员 = 会话可见性

扩展把每个会话的 tab 自动归入 Chrome 原生彩色标签组 `ab: <会话名>`（颜色按
会话名散列）。对齐后模型：**浏览器是唯一真相**——proxy 不再维护独立的创建
账本，归属表是组事实的投影（扩展回连即上报全量组事实 `gstate`，此后事件驱
动增量 sync）。用户与 agent 的边界是**可见的物理边界**：

| 用户操作（Chrome 原生） | 语义 |
|---|---|
| 把自己的 tab 拖进会话组 | 归属该会话（可见、可操作；组内=会话的，可真关） |
| 把 tab 拖出组 / 从组中移除 | 收回：会话立即失去可见性（合成销毁事件），tab 留在用户手里 |
| 在两个会话组间拖动 | 领地转移：向原会话收回、归属新会话 |
| 折叠/展开组 | 纯视觉，无协议语义 |

配套规则：

- **组在即领地**：release 按**扩展配置**处置（options 页 `releasePolicy`）——
  `close` 全关+删组（默认）/ `mark` 墓碑标记（`· released`+灰色，tab 保留，
  同名会话回来摘碑复活、整组认领）/ `keep` 原样保留
- **冷启动无孤儿**：扩展刷新/浏览器重启后 gstate 重建归属，组还在的 tab
  永不孤儿化（同名 alloc 直接认领既有组）
- **投影自愈**：组成员变化经防抖 sync 全量差分（事件驱动 + alarm 兜底），
  幂等，漏事件可自愈
- 组绑定按标题重建（SW 重启恢复）；入组按会话名串行化（防并发双组）；
  缓存组已死时清缓存重查

## 已验证（真实 agent-browser 0.36.0）

- 双 session 并发：URL/eval/tab list 完全隔离，互不可见
- attach + Runtime.evaluate（带 sessionId）定向路由正确
- 越权 closeTarget 被 CDP error 拒绝，受害方 tab 完好
- close 后 60s 自动回收名下 tab，基座存活
- plugin 自启动：服务未跑时首个 launch 拉起服务并就绪

已验证（扩展下游，Playwright connectOverCDP 零改动接入）：连接/页面发现/
setContent/evaluate/content/screenshot/newPage/page.close/newCDPSession/click
全链路通过；下游重启后扩展自动重连、会话自愈；routing 在线切换
（`scripts/ext_smoke_test.py` T0–T7 + `scripts/ext_playwright_e2e.mjs`）；
双源同时在线（standalone 会话与 extension 会话并存，互不牵连）。

## 已知限制（v0.1.0）

- release 的 tab 关闭为 fire-and-forget（失败有日志，不重试）
- 扩展下游：`page.download()` 的落盘路径解析受限（Browser.setDownloadBehavior
  为假成功，下载按宿主默认行为；精确控制需 chrome.downloads，不在 CDP 层补偿）
- 扩展下游：heap/CPU profiler 等浏览器级域不可用（chrome.debugger 未开放，
  诚实报错）；agent/Playwright 常规自动化面 ≈95% 覆盖
- 扩展下游：SW 被 Chrome 回收后 ≤30s 内自动回连续接（会话表持久化 + restore，
  同 sid 无感）；手动刷新扩展会连 alarms 一起清掉——点一下工具栏图标立即重连
- 扩展下游：用户点调试横幅「取消」后会话软休眠（无事件、无报错），下一条
  命令自动重挂（横幅重现）；休眠中 tab 被关则诚实报错
- v2 设计方向（未实施）：会话句柄层（E 编号 ↔ target 映射）从 SW 迁到 proxy
  （sid 编码 targetId），扩展退化为无状态适配器，持久化垫片可整体移除
