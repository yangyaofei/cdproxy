# cdp-ext — 反向 CDP 桥扩展（MV3）

装在**用户日常 Chrome** 里的扩展：向 agent-browser-proxy（`--downstream
extension` 模式）反向拨出 WebSocket，把自己伪装成一个「浏览器级 CDP 端点」。
宿主浏览器不需要 `--remote-debugging-port`（Chrome 136 起该开关对默认 profile
已失效），调试走 `chrome.debugger` 官方 API。

```
proxy(9235 /ext?token=…) ◄──反向拨出（SW 发起）── 本扩展 ──chrome.debugger──► 各 tab
```

## 安装

1. `chrome://extensions` → 开发者模式 → 加载已解压的扩展程序 → 选本目录
2. 扩展选项页（或 `chrome.storage.local`）配置：
   - `relayUrl`：默认 `ws://127.0.0.1:9235/ext`（生产指向 `ws://127.0.0.1:9225/ext`）
   - `token`：默认 `dev`（须与服务 `settings.ext_token` 一致）
3. 服务端正常运行即可（`/ext` 常开注册，无需任何启动参数）；
   切新会话到扩展宿主浏览器：Admin 页改「新会话下游」或
   `curl -X PUT http://127.0.0.1:9224/settings -H 'Content-Type: application/json' \
     -d '{"downstream_mode":"extension"}'`

扩展自动重连（指数退避 + 0.5 分钟 alarm 兜底唤醒 MV3 SW）；重连即重建
extension 侧会话状态（proxy 同刻清该侧归属并合成销毁事件，chrome 会话
不受牵连）。

## 仿真的浏览器级命令

| 命令 | 实现 |
|---|---|
| `Target.getTargets` / `getTargetInfo` | `chrome.debugger.getTargets`（无参 getTargetInfo 返回浏览器自身） |
| `Target.createTarget` / `closeTarget` / `activateTarget` | `chrome.tabs.*` |
| `Target.attachToTarget`（flatten）/ `detachFromTarget` / `setAutoAttach` / `attachToBrowserTarget` | 虚拟会话多路复用（一个物理 debugger attach 叠 N 个虚拟会话） |
| `Target.getBrowserContexts` | 恒空（单默认 context，`browserContextId: "cdp-ext-default"`） |
| `Browser.getVersion` | 合成（product 标记 `Chrome/cdp-ext-bridge`） |
| `Browser.setDownloadBehavior` | 假成功（Playwright 连接期无条件发送） |
| `Browser.close` | 拒绝（宿主是用户浏览器，proxy 层另有一道） |
| 页面会话命令 | `chrome.debugger.sendCommand` 全透传（含 flat 子会话：OOPIF/worker） |

## Playwright 兼容的关键细节（改动前先跑测试）

- 响应必须回带 `sessionId`（Playwright 按 sessionId 路由响应到 CRSession）
- `targetInfo` 必须带 `browserContextId`，否则 Playwright 直接 detach 该 target
- `attachedToTarget` 事件先于 `setAutoAttach`/`createTarget` 响应送达
  （proxy 侧同步补挂保证时序）
- `detachedFromTarget` 带上 `targetId`（Playwright Chromium 靠它关页面，
  不监听 targetDestroyed）
- 会话内 attach（`attachToBrowserTarget` 会话上的 `attachToTarget`）事件须
  嵌套（顶层 sessionId=父会话），广播会导致 Playwright "Duplicate target" 断言
- `createTarget` 应答须毫秒级（alloc 预开是 fire-and-forget，慢了归属记录
  输给客户端 getTargets）

回归：`scripts/ext_smoke_test.py`（T0–T7）+ `scripts/ext_playwright_e2e.mjs`
（connectOverCDP 全链路），改 sw.js 后用 `scripts/load_ext_via_cdp.mjs` 重载再测。

## 会话韧性（SW 死亡 / 用户点「取消」）

MV3 的 Service Worker 随时可能被 Chrome 终止（内存压力/生命周期上限），物理
debugger attach 属于扩展不随 SW 死——需要救的只有内存里的虚拟会话表。三层姿态：

| 层 | 机制 |
|---|---|
| 保活 | 20s 心跳 + 0.5min alarm（Chrome 周期下限 30s） |
| 快速复活 | 断线指数退避重连 + alarm 兜底唤醒（SW 死后 ≤30s 必回连） |
| 无感恢复 | 会话表**变更即写透** `chrome.storage.session`（STATE_KEY，串行链防交错）；SW 重启 `loadPersistedState` 原位恢复（sid/tabId 不变）→ `{"abCtl":"restore"}` 通知 proxy 跳过「清归属+合成销毁」→ 同 sid 命令照常 |

两个踩过的坑（此处留碑，勿回头）：

- **不可用防抖写**：MV3 SW 在事件间隙近乎立即挂起，挂起冻结计时器——防抖
  窗口内的写入随 SW 死亡直接丢失（实测 attach 后 1s 状态仍未落盘）。必须
  变更即写。
- **runtime.reload 连 alarms 一起清**：手动刷新扩展后 SW 无唤醒源。兜底：
  工具栏图标点按即重连（`chrome.action.onClicked` → connect）。

用户点横幅「取消」= 软休眠（lazy re-attach，用户提出的语义）：

| 时刻 | 行为 |
|---|---|
| 点「取消」/ DevTools 接管 | 物理 attach 摘除，会话表保留，**不发任何事件**（「取消」=「现在别烦我」，静默） |
| 下一条会话命令 | 自动重挂 → 横幅重现（有活儿在干的正确反馈）→ 命令照常 |
| 休眠中 tab 被关 | 诚实报错 `未知 sessionId`，不复活死 target |
| 重挂失败（DevTools 占用） | 明确报错（关 DevTools 即恢复） |

## 已知边界

- 一 tab 一 debugger：用户开着 DevTools 的 tab attach 诚实报错；attach 后 tab
  顶部有「扩展程序已开始调试此浏览器」横幅（detach 即消；休眠即消、下一条
  命令重现）
- 休眠/重启会杀死该 target 的子会话（OOPIF/worker 随物理 attach 生死，不持久化）
- heap/CPU profiler 等浏览器级域不可用（chrome.debugger 未开放）
- 下载路径解析受限（`page.download()` 事件流动，落盘按宿主默认行为）

## 标签组：组成员 = 会话可见性

会话名下 tab 自动归入 Chrome 原生彩色组 `ab: <会话名>`（proxy 在
createTarget 夹带 `abSession` 私有参数，扩展消费后剥离；响应回带
`abGroup` 字段供测试断言）。

**组 = 唯一真相（对齐后模型）**：proxy 不再维护独立的创建账本——归属表是
组事实的投影。扩展每次回连上报全量组事实（`gstate`），此后组事件驱动增量
sync；组在即领地：组被保留时（mark/keep 策略），同名会话重新 alloc 即整组
认领。冷启动（扩展刷新/浏览器重启）不再制造孤儿——gstate 重建归属。

| 用户操作（原生） | 扩展/proxy 行为 |
|---|---|
| 拖自己的 tab 进组 | sync 投影 → 归属该会话（可见+可操作；组内=会话的，可真关） |
| 拖出组 / 移除出组 | sync 投影 → 收回可见性：合成 detachedFromTarget+targetDestroyed，tab 留在用户手里 |
| 在两个会话组间拖动 | 领地转移：先向原会话收回，再归属新会话 |
| 会话 closeTarget 组内 tab | 真关（拖入即交出） |
| 会话 release | 按**扩展配置**（options 页 releasePolicy）：`close` 全关+删组（默认）/ `mark` 组加墓碑（`· released`+灰色，tab 保留，同名会话回来摘碑复活）/ `keep` 原样保留 |

实现要点（改组语义前必读）：投影是**全量差分**（事件驱动
tabs.onUpdated{groupId}/onMoved/tabGroups.* + 0.5min alarm 兜底，300ms 防抖，
幂等）；入组按会话名串行化（`groupChain`，防 preopen 与 createTarget 并发
建出同名双组）；缓存组已死时清缓存重查（防 release 后死绑定导致永不入组）；
墓碑组（`· released`）不算活领地（gstate 不上报），同名会话回来时
addToGroup 摘碑复活；SW 存活窗口外事件由 alarm 兜底对账自愈。

**代码更新后**：已安装的未打包扩展不会自动重读磁盘——chrome://extensions
里点该扩展的刷新按钮（测试环境用全新 profile + load_ext_via_cdp）。
