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

## 已知边界

- 一 tab 一 debugger：用户开着 DevTools 的 tab attach 诚实报错；attach 后 tab
  顶部有「扩展程序已开始调试此浏览器」横幅（detach 即消）
- heap/CPU profiler 等浏览器级域不可用（chrome.debugger 未开放）
- 下载路径解析受限（`page.download()` 事件流动，落盘按宿主默认行为）
