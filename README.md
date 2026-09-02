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

## 快速开始

```bash
# 启动服务（分离式，脱离调用方进程组）
scripts/serve.sh

# 状态 / 停止
uv run python -m agent_browser_proxy status
uv run python -m agent_browser_proxy stop

# 冒烟测试（五项判定：隔离/归属/路由/越权拒绝/回收）
uv run python scripts/smoke_test.py
```

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

不碰全局配置的试用方式：`agent-browser --config var/prov-test-config.json --session <名> open <url>`
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

## 已验证（真实 agent-browser 0.36.0）

- 双 session 并发：URL/eval/tab list 完全隔离，互不可见
- attach + Runtime.evaluate（带 sessionId）定向路由正确
- 越权 closeTarget 被 CDP error 拒绝，受害方 tab 完好
- close 后 60s 自动回收名下 tab，基座存活
- plugin 自启动：服务未跑时首个 launch 拉起服务并就绪

## 已知限制（v0.1.0）

- 单下游连接上的 setAutoAttach 由多 session 先后设置时会互相覆盖（agent-browser
  常规路径用显式 attach，不触发；如遇依赖 auto-attach 的工具需升级为多下游连接）
- release 的 tab 关闭为 fire-and-forget（失败有日志，不重试）
