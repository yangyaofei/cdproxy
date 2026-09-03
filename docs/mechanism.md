> **历史研究档案**（问题演进、插件协议、v1→v7 演进史、CDP 代理设计（T1-T5））。结论已固化为 agent-browser-proxy 产品（见 SKILL.md 与仓库 README），日常使用不读本文；追溯设计依据时再查。

# agent-browser 并发 Keeper 机制完整梳理

> 本文档是 agent-browser 多 agent 并发共享登录态方案的完整机制记录：问题演进、
> agent-browser 核心机制、插件协议、插件 v1→v5 演进史（每个失败方案的根因）、
> 最终架构（**v6 cdp 模式，见 §9 修订**）、生命周期、测试矩阵、部署物清单。
> 目标：读者可据此从头重建。

> **当前生效方案是 §9 的 v6 cdp 模式**（config 的 `cdp:"9222"` + `pinTab:true` +
> `~/agent-browser/keeper.sh`）。§1-§8 记录 directPage(v5) 方案——它已被 v6
> 取代，但演进过程与全部教训仍然有效，且 provider 文件已归档（legacy/）。

## 1. 问题演进

| 阶段 | 问题 | 结论 |
|---|---|---|
| 起点 | 多 agent 并发使用 agent-browser，第二个 session 撞 Chrome SingletonLock 起不来（共享全局 profile） | 需要 keeper/降级机制 |
| 调研 | restore/namespace/state/CDP 共享逐一评估 | 各有坑（见 §3） |
| 方案 1 | launch.mutate plugin 自动降级 | **结构性死**（§4.1） |
| 方案 2 | provider plugin 自管 Chrome（v1→v3） | 能跑但 pin 缺陷 + 自管 Chrome 维护成本 |
| 方案 3 | provider plugin + CDP 页面级 WS（v5 directPage） | **最终态**：协议层隔离，零 Chrome 代码 |

## 2. agent-browser 核心机制（0.36.0）

- **CLI → daemon**：`agent-browser` 命令（node wrapper）→ 按连接/启动 `agent-browser-darwin`
  daemon；**每 session 一个 daemon**（socket 隔离），daemon 持有该 session 的
  `DaemonState`（单 browser、单 pin 状态）。
- **Chrome 启动**：daemon auto-launch——`--user-data-dir` 默认临时 uuid 目录
  （`/var/folders/.../agent-browser-chrome-<uuid>`），`--profile` 可指定持久目录（登录态）；
  调试端口 `--remote-debugging-port=0`（随机），写 `<dir>/DevToolsActivePort`。
- **`--cdp <port|url>`**：附加已有 Chrome。**每条命令都要带**（官方文档明示）；
  不带则 daemon 当新命令决策（换自己的 Chrome）。
- **`--pin-tab`**：按 CDP target id 严格绑定 tab。无 pin = legacy「导航共享活跃 tab」
  （多 session 串扰是设计行为）；pin 后：他人 tab 抢不走、绑定 tab 被关报
  `tab_gone`（可 `tab new` 恢复）、**sticky 只需第一条命令传**、跨 daemon 重启持久
  （binding 文件）。**注意：pin 绑定只在 --cdp attach 路径建立；provider/launch 路径
  从不建立（0.36.0 缺陷，连显式 flag 都不生效，无 binding 文件产生）。**
- **restore 体系**：`--restore`/`--state` 保存/恢复 cookies+localStorage；
  `--state` 与 `--profile` 互斥；并发后 close 的覆盖先 close 的。
- **config.json**（`~/.agent-browser/config.json`，键 camelCase）：
  `headed/profile/idleTimeout/provider/pinTab/plugins/restore...` 等约 30 键。
  **env 优先于 config**（`AGENT_BROWSER_*` → `flags.rs:581` 等）。
- **命令超时**：命令默认 30s；plugin 无响应 → daemon 放弃并回退（静默）。

## 3. 被否决的替代方案（含理由）

| 方案 | 否决理由 |
|---|---|
| browserless（远程浏览器服务） | 模型错位（多浏览器单客户端、断开即杀）vs 我们要单浏览器多客户端共享登录态；同 user-data-dir 不能跨并发浏览器；SSPL 双许可 |
| CDP 共享（--cdp 9222 直连） | 可行（多 agent 官方模式）但每条命令带 --cdp + --pin-tab；且 keeper 端口随机时 agent 拿不到固定值 |
| restore/state 共享 | 并发写回覆盖无解；--state 与 --profile 互斥 |
| credential.read 自动重登 | 用户明确不做 |
| launch.mutate 降级 | 结构性死（见下） |

## 4. 插件协议（agent-browser.plugin.v1）

- **stdio JSON**：stdin 收一个请求（JSON 一行）→ stdout 回一个响应（协议必须独占
  stdout，任何 print 污染 = invalid JSON）；**stderr 被 daemon 压制**（plugin 报错
  用户只看到 `✗ Plugin 'X' returned success=false` / `exited unsuccessfully`）。
- **四种 capability**：`credential.read`（登录凭据注入）、`launch.mutate`（每次本地
  启动前 append args）、`browser.provider`（托管 Chrome 生命周期：browser.launch →
  返回 `{cdpUrl, directPage, cleanup}`，daemon close 时回传 cleanup）、`command.run`。
- **注册**：config.json `plugins: [{name, command, capabilities}]`。
- **请求结构**：`{"type":"browser.launch","request":{"session":"<id>","launchOptions":{...}}}`；
  launchOptions **不含** profile/user-data-dir 信息（plugin 无法感知本次启动目录）。
- **调试手段**：`set -x`（xtrace 落 plugin-stderr.log）是唯一能看到 plugin 内部
  执行路径的手段。

## 5. 插件演进史（v1→v5，每个失败的根因）

### 5.1 launch.mutate 路线（结构性死）
- 设想：plugin 在 daemon 启动 Chrome 前 append `--user-data-dir=<temp>` 实现降级。
- **死因**：daemon 自己启 Chrome 并**在它认为的目录**（config profile）等
  DevToolsActivePort；Chrome 对重复 --user-data-dir last-wins → daemon 永远等不到
  → open 卡死（两次复现）。且 plugin 失败时 daemon 静默回退 own-launch，无提示。

### 5.2 provider v1：shell 直接启动 Chrome
- `nohup & disown`：daemon 调 plugin 是进程组 kill（kill_on_drop）→ Chrome 陪葬。
- `open -na`：两次背靠背启动 → Mach bootstrap 冲突
  （`bootstrap_check_in com.google.Chrome.apps.<hash>: Permission denied (1100)`）。
- bash 3.2 `set -u` 三坑：空数组 `${EXTRA[@]}` unbound（改字符串拼接）；
  python `print(p.pid)` 污染 stdout → invalid JSON（改 `print(..., file=sys.stderr)`）；
  SHARE 分支 `URL` 未初始化 `[ -z "$URL" ]` unbound。
- **最终启动方式**：`python3 subprocess.Popen(..., start_new_session=True)`（setsid 脱离）——稳定。

### 5.3 provider v3：keeper + share + refcount
- 语义：pgrep 发现活 keeper（同 profile dir）→ 收养共享；死 → 清锁启动；
  state 文件（`provider-state/<session>.json`）计引用，close 归零才 kill。
- 教训：
  - **stale SingletonLock 无条件清**（能走到 launch 说明 pgrep 无活 Chrome，锁必 stale；
    BSD sed/readlink 的条件判断不可靠）。
  - **stale DevToolsActivePort 清理 + `/json/version` 验证**（不轻信 nc——端口文件可能
    残留指向死端口）。
  - **profile keeper 是基础设施，close 永不杀**（只杀 temp 目录）。
- v3 的两个未解问题：
  1. profile 启动慢/偶发失败 → 降级 temp（登录态丢失）。
  2. **pin 在 provider launch 路径不生效**（0.36.0 缺陷）→ 多 session 共享 Chrome 串扰。

### 5.4 v4：agent-browser 原生 keeper（不碰 Chrome 代码）
- Chrome 生命周期全部委托 agent-browser：内部 `ab-keeper` session（独立
  keeper-config）`tab new about:blank` 启动 → `get cdp-url` 取浏览器级 WS 交出去；
  引用归零 → `agent-browser --session ab-keeper close`。
- 新坑（都靠 xtrace 定位）：
  - **递归级联**（曾表现为每条命令 30s 静默卡死）：外层 daemon 调 plugin 时注入
    `AGENT_BROWSER_PROVIDER` 等 env，**env 优先于 config**（flags.rs:581）→ 内层
    ab-keeper daemon 也走 provider → 无限递归。**修复：keeper() 用 `env -i` 斩断继承。**
  - keeper 的 profile 必须写进 keeper-config（`get cdp-url` 会自动启动 Chrome，
    不继承 CLI --profile）。
  - 内层 agent-browser 调用必须完全脱离 plugin stdio（`</dev/null >tmpfile`），
    防 daemon 孙进程持有 stdout 管道（防患，实测递归才是当时真因——stdin EOF 正常）。
  - BSD sed 不支持 `t` 无标签分支（`undefined label`）→ 端口提取改 `grep -o | cut`。

### 5.5 v5：directPage —— 最终态
**思路转变**：不用实现 pin——CDP 原生支持页面级 WebSocket
（`ws://127.0.0.1:<port>/devtools/page/<targetId>`），每个连接就是一个 tab。
provider 契约的 `directPage: true` 字段即为此设计（"WebSocket IS the page session"）。

- **launch**：清 24h 前残留引用 → **复用对账**（本 session state 文件里的 targetId
  经 `GET /json/list` 确认还活 → 直接返回原页面级 WS，不开新 tab；已死则清 state）
  → keeper 端口（取不到则 `tab new` 拉活自愈）→ `PUT /json/new?about:blank`
  新建专属 tab → state 文件 `{targetId, port}` → 返回
  `{cdpUrl: <页面级 WS>, directPage: true}`。
- **close**：`PUT /json/close/<targetId>` 关本 session 的 tab → rm state →
  引用归零 → `keeper close`（agent-browser 关整个 Chrome）。
- **隔离原理**：每 session 的 WS 就是自己的 tab，**其他 session 在协议层够不到
  这个 tab**——串扰构造性不可能，不依赖 agent-browser 的 pin 实现。

## 6. 最终架构

```
~/.agent-browser/config.json          全局：{"headed":true,"idleTimeout":"15m",
                                       "provider":"pm","pinTab":true,
                                       "plugins":[{"name":"pm","command":..., 
                                        "capabilities":["browser.provider"]}]}
~/agent-browser/plugins/
  provider-manager.sh                 plugin v5（directPage）
  keeper-config.json                  {"headed":true,"idleTimeout":"8h","pinTab":true,
                                       "profile":"/Users/yangyaofei/agent-browser/profile"}
  provider-state/<session>.json       引用登记 {targetId, port}（24h 自动清）
  invoke.log                          plugin 调用日志（INVOKE/LAUNCH/REUSE/CLOSE）
  plugin-stderr.log                   xtrace（set -x 落盘，排障唯一手段）
内部：agent-browser --config keeper-config --session ab-keeper   keeper daemon
```

```
agent-browser --session X open <url>     ← agent 唯一要传的东西
  └─ 外层 daemon（session X）→ browser.launch → plugin
       ├─ 对账：X 已有活 tab → REUSE 原页面级 WS
       ├─ keeper 活性：ab-keeper get cdp-url（死则 tab new 拉活）
       └─ PUT /json/new → 专属 tab → 返回页面级 WS + directPage
            └─ daemon 直连该 tab（协议层隔离）
生命周期：
  close 命令 / idle 超时 → browser.close → 关自己 tab → 引用归零 → keeper 关闭
  daemon 被 kill -9      → tab 留存 → 下次 launch REUSE 对账
  keeper Chrome 被杀     → 下次 launch 自愈（新 keeper + 新 tab）
```

## 7. 测试矩阵（全过）

| # | 场景 | 结果 |
|---|---|---|
| T1 | 单 session config-only | ✓ |
| T2/T3 | 双/三 session 并发交错 eval | ✓ 完美隔离 |
| T4 | kill -9 daemon 后重 open | ✓ REUSE 同一 tab |
| T5 | kill -9 keeper Chrome 后重 open | ✓ 自愈新 keeper + 新 tab |
| T6 | 依次 close | ✓ 最后引用关 keeper |
| T7 | --idle-timeout 5s | ✓ 自动 browser.close 清 tab |

## 8. 使用方式

### Agent 侧（唯一用法）
```bash
agent-browser --session <id> open|eval|snapshot|click ...   # 什么都不用配
```
- 并发多 agent：各用各的 session id，天然隔离（一 session 一 tab）。
- 需要「第二个 tab」= 开第二个 session（directPage 模式无浏览器级通道，
  `tab new`/`tab list` 不可用）。
- 登录态共享：keeper 用全局 profile，所有 tab 共享 cookies。

### 排障
| 症状 | 查 | 依据 |
|---|---|---|
| `✗ Plugin 'pm' returned success=false` | `plugin-stderr.log` 尾部 xtrace | 卡点逐行可见 |
| 命令 30s 静默卡死 | invoke.log 有 INVOKE 无 LAUNCH | plugin 内部卡住（历史上是递归） |
| tab/Chrome 泄漏 | provider-state/ + `ps aux | grep user-data-dir` | state 有登记但 Chrome 死 = 自愈即可；Chrome 活但 state 无 = 手动清 |
| 登录态丢失 | keeper-config.json 的 profile 是否存在 | keeper 自动启动路径只读 config |

### 已知边界
- directPage 模式无 Target/Browser 级通道：tab 管理、allowed-domains 过滤不可用。
- `get cdp-url` 会自动启动 daemon+Chrome（非只读操作）。
- plugin 的 stderr 被压制：降级/失败提示只能靠 invoke.log 或响应字段。
- agent-browser 0.36.0 的 pin 在 provider/launch 路径不生效（本方案绕开，不受影响）；
  若上游修复，pinTab 与 directPage 可共存。

## 9. 最终态修订：v6 cdp 模式（当前生效）

### 9.1 为什么从 directPage(v5) 回退

v5 上线后做既有 skill 兼容性盘点，发现**致命不兼容**：twitter-daily 的核心
工作流是多 tab 循环（`tab new → eval → tab close` 的 enrich 队列、`tab list`
定位 x.com tab、`tab <ref>` 切换——scroll-collect-tweets.sh / fetch-blog.sh /
page-pdf.sh 全部依赖），而 directPage 模式没有浏览器级通道，tab 管理全部不可用。

回退到浏览器级连接 + pin 隔离，但**不用 provider 路径**（其 pin 缺陷是 v3 的
未解问题）——改用 **--cdp attach 路径**：pin 在该路径已被实测有效（doc-a/doc-b）。

### 9.2 关键源码事实（v6 的地基）

- **`--cdp` 与 `--provider` 互斥**（`main.rs:161`，"Cannot use --cdp and
  -p/--provider together"）→ config 二选一。
- **`cdp` 是 config 合法键**（`flags.rs` Config struct `pub cdp: Option<String>`）
  → config 写 `"cdp": "9222"` 即全局 attach，agent 仍 config-only。
- **`pinTab` 是 config 合法键**（`flags.rs:598` env||config；`main.rs:108`
  `if flags.pin_tab` 随每条命令进信封）→ attach 路径 pin 全程生效。
- **cdp attach 的 `close` / idle 超时不杀 keeper**（实测两次 close 后 9222 存活）
  → keeper 常驻语义成立，无需引用计数。
- `--headless` 不是 CLI flag（"Unknown command"）；headed 由 config 的
  `headed` 键控制（keeper 启动参数决定）。

### 9.3 v6 架构与部署物

```
~/.agent-browser/config.json   {"headed":true,"idleTimeout":"15m","cdp":"9222","pinTab":true}
~/agent-browser/keeper.sh      keeper 幂等启动脚本（固定 9222 + 全局 profile，
                               DevToolsActivePort/SingletonLock 清理 + /json/version 就绪轮询）
~/agent-browser/profile/       keeper 持久登录态（全局共享）
```

```
agent-browser --session X <cmd>     ← agent 唯一要传的
  └─ config.cdp=9222 → attach keeper Chrome（浏览器级连接，tab 全功能）
       └─ config.pinTab=true → 按 target id 严格绑定（sticky，跨重启持久）
生命周期：
  close / idle 超时 → 只断开自己的连接，keeper 常驻（实测）
  keeper 崩溃 → agent 跑 ~/agent-browser/keeper.sh（幂等 ~2s）→ 重试
  需要隔离 cookies → --config <独立config>（官方 opt-out，绕开 cdp，自管 Chrome）
```

### 9.4 v6 测试矩阵（全过）

| # | 场景 | 结果 |
|---|---|---|
| T1' | config-only 双 session open/eval | ✓ 隔离正确 |
| T3' | tab new / tab list / 切换后 eval | ✓ 全功能（twitter-daily 兼容核心） |
| T-pin | B eval 不受 A 的 tab 操作影响 | ✓ pin 生效 |
| T-close | 两个 session 依次 close | ✓ keeper 两次均存活 |
| T-optout | `--config` 独立 config 自管 Chrome | ✓ 绕开 cdp，临时目录 own-Chrome |
| T-reuse | keeper.sh 幂等重跑 | ✓ 已活即跳过 |

### 9.5 v6 与 v5 的取舍记录

| 维度 | v5 directPage | v6 cdp（生效） |
|---|---|---|
| 并发隔离 | 协议层构造性（更强） | pin 绑定（实测有效） |
| session 内多 tab | ✗ 不可用 | ✓ 全功能 |
| close/引用管理 | plugin 引用计数 | 无需（keeper 常驻） |
| keeper 保活 | plugin 自动（launch 自愈） | keeper.sh 手动/写进 skill 规则 |
| 既有 skill 兼容 | ✗ twitter-daily 系全灭 | ✓ 全兼容 |
| config-only | ✓ | ✓（cdp+pinTab 进 config） |

结论：隔离强度上 v5 略优，但 tab 能力是既有工作流的硬需求，v6 是唯一同时满足
「config-only + tab 全功能 + 共享登录态 + 零 agent-browser 改动」的方案。

## 10. v7 基座：生命周期交还 agent-browser（当前生效）

### 10.1 用户定调（本轮三条硬规矩）

1. **研究优先**：说「做」之前只研究不动手；探索兼容性不是二选一回退。
2. **全局 config 最小化**：`~/.agent-browser/config.json` 只留 `{"headed": true}`。
   实验内容（cdp/pinTab/provider/plugins）一律不进全局配置——测试期污染全局是
   事故根源。v6 的 `cdp` 键已移除。
3. **三模式 tab 语义矩阵**（回答「同一 session 多 tab 能否切换」）：

| 模式 | 自己多 tab 切换 | 看到别的 session 的 tab |
|---|---|---|
| session 自管（默认） | ✓（整个 Chrome 是自己的） | ✗ |
| cdp attach + pin | ✓（tab 全功能） | ✓ 看得到（浏览器级视图），默认操作 pin 固定自己，显式 `tab <ref>` 切别人技术可行靠约定 |
| directPage（v5 归档） | ✗（一 session 一 tab） | ✗ |

两种机制可同时共存（每 session 独立 daemon 各选各的）；互斥只在单条命令内
（`--cdp` 与 `--provider` 不能同传，main.rs:161）。

### 10.2 CDP 代理设计（合题，未实施）

v5（硬隔离无多 tab）与 v6（全 tab 软隔离）的合题：**代理层控制协议可见性**。

```
agent-browser daemon ──browser级WS──▶ CDP 代理（我们实现，T1-T5）
                                          │ 按 session 过滤 Target 域
                                          ▼
                                    keeper Chrome（共享登录态）
```

- 过滤点：Target.getTargets（tab list 滤掉别人的）、createTarget（记归属）、
  targetCreated/targetDestroyed 事件流（只转发自己 tab 的）——agent-browser 的
  tab 管理全走 Target 域，过滤即得「每人只看到自己的 tab + 自己多 tab 全功能」。
- **状态机 T1-T5**：T1 归属表（targetId→session）；T2 会话表（session→连接+
  tab 集+active）；T3 命令关联（CDP id 双向重映射，每条上游连接 id 命名空间
  独立）；T4 attach 映射（上游连接×downstream sessionId→targetId）；T5 生命
  周期（last_activity/宽限/orphan）。
- **close 语义（实测）**：上游 WS 断开是唯一可靠主信号（正常 close/崩溃/idle
  都走它）；provider 形态另有 browser.close 回调做权威补充；daemon **不发**
  Browser.close（keeper 实测存活）；**session 的 tab 全部残留**（实测 9→9）→
  orphan GC 是代理职责。代理收到 Browser.close 命令时改译为「关自己 tabs +
  清归属条目」，单 session 永远杀不死 keeper。
- **keeper 关闭策略**：引用计数（会话表空）→ 30s 宽限 → 关；TTL 兜底；
  Browser.close 拦截改译。
- **焦点策略（CDP 在手的加料面）**：`Target.createTarget(background:true)` 开
  tab 不抢焦点（实测 ✓；HTTP /json/new 无此参数必激活——v3/v5 时代每次开 tab
  闪焦点的根因）；eval/screenshot 本就不需要焦点；`Page.bringToFront` 可按
  策略吞掉；「人要看」= 按需 Target.activateTarget。选项放我们自己的 keeper
  侧配置（focus: steal|background|ondemand / orphan_policy / idle_ttl），
  **不进 agent-browser 全局 config**。

### 10.3 ab-keeper 基座（替代 v6 keeper.sh）

用户架构：agent-browser 自带 profile/session/idle-timeout 全套生命周期管理，
只需「暴露 CDP」——这就是现成的 `get cdp-url`（等效第四个参数；own-launch 端口
随机，ps 实证 `--remote-debugging-port=0`，URL 现查即得，固定端口才需改上游）。

```
上层消费者（CDP 代理 / 外部工具）
        ▲ ws://127.0.0.1:<随机端口>/devtools/browser/<uuid>（ab-keeper.sh url 现查）
agent-browser 托管（--session ab-keeper --profile ~/agent-browser/profile --idle-timeout 60m）
        │ launch / idle 回收 / 崩溃自愈重拉
        ▼
    Chrome（headed，登录态持久在 profile）
```

实测记录：
- 外部 python websockets 直连 browser WS ✓（Target.getTargets/createTarget/
  closeTarget 全通）
- `createTarget(background:true)` ✓（新 tab attached=False 不激活）
- **URL 翻转事件**：旧 keeper pkill 后 profile 状态未落干净 → 新 Chrome A 启动
  即崩 → daemon 自动重拉 B（targetId 证据链确认 B 从 m04695 起存活）→ 自愈正常。
  设计含义：`url` 每次现查 + 消费方断开后重查重连（T5 下游重连语义）。
- keeper Chrome 由 daemon 托管后：idle 60m 无命令自动回收（关闭便宜，登录态
  在 profile）；任意子命令重置计时器（status 可做保活 ping）。

### 10.4 部署物现状

- `~/.agent-browser/config.json` = `{"headed": true}`（最小，用户指令）
- `~/agent-browser/ab-keeper.sh`：`start|stop|url|status` 四子命令
- `~/agent-browser/plugins/legacy/`：v3-v6 全部历史实现归档
  （provider-manager/directPage/keeper-config/旧 keeper.sh setsid 版）
- 代理：未实施（§10.2 设计完备，等指令）

### 10.5 三 skill 兼容研究

twitter-daily / reading-list-update / tech-fetch 的用法清单、冲突点、逐项建议：
独立成文 [compat-inventory.md](compat-inventory.md)。

### 10.6 provider-in-config 的覆盖机制研究（结论：不成立）

用户命题：config 只写 provider，消费方用自己的 flag（--cdp/--profile）覆盖 → 不成立。

源码依据（v0.36.0）：
- `flags.rs:557/581`：cdp/provider 均为 env > config 逐字段解析
- `flags.rs:150-175` `Flags::merge`：逐字段 `other.X.or(self.X)` 取或合并——
  CLI flag 出现**不会**清掉 config 提供的 provider
- `main.rs:160/1650`：互斥校验跑在**合并后**的 flags 上

实测（--config 临时文件，未碰全局）：
- config `{"provider":"stub"}` + CLI `--cdp <url>` → `✗ Cannot use --cdp and
  -p/--provider together` 硬报错（消费方无法用自己的 CDP 覆盖）
- config provider + CLI `--profile <dir>` → provider 照样接管（报 Unknown
  provider 'stub'，证明走了 provider 解析；--profile 的自管意图被静默吞掉）
- provider 无法感知消费方 flags（launch 请求 launchOptions 无 flag 信息，§4 实测）
- 唯一干净 opt-out：`--config <干净配置文件>` 整体换 config

可行方向（未实施）：
- A. provider 不进全局 config：默认自管（官方默认、存量 skill 零冲突），需要
  keeper 的消费方按命令显式 `--provider <name>`（且每条命令都要带，v3 教训）
- B. provider 进全局 config：默认共享，隔离用 `--config` 干净文件 opt-out
  （笨重，且 --cdp 直连会撞互斥报错）
- C. fork/上游 PR：merge 时 CLI 显式 flag 清掉 config 来源的互斥字段
  （--cdp 出现 → provider 置 None）——机制最优雅，需维护 fork
- D. env 空串/AGENT_BROWSER_CDP：合并后仍双 Some，同样报错——不通

### 10.7 provider 作为路由器（多后端分配）——可行性确认

命题：provider 后端维护多个浏览器，按连接方身份分配（twitter-daily→带登录的
专用后端；一般→默认；指定→连我们自己的浏览器）。**结论：完全可行。**

证据链（源码 + dump-provider 实测）：
- `native/providers.rs:222-227`：browser.launch 请求体 =
  `{"provider": <名>, "session": <AGENT_BROWSER_SESSION 或 "default">,
    "launchOptions": {headed/engine/userAgent/colorScheme(env 来源) + 命令选项}}`
- 实测（dump-provider 经 --config 临时注册）：CLI `--session route-test-xyz` →
  请求体 `"session":"route-test-xyz"`；env `AGENT_BROWSER_SESSION=env-route-abc`
  → `"session":"env-route-abc"`。**两种会话地址方式都到达 provider**
- provider 响应的 cdpUrl 任意——路由决策完全在我们手里

路由器架构（设计，未实施）：
```
消费方(--session twitter-daily --provider router)
   └─ browser.launch{session:"twitter-daily"} ──▶ router plugin（我们）
        │ 查路由表（我们自己的 config，如 ~/agent-browser/router.json）
        │   "twitter*"  → keeper-twitter（ab-keeper + x.com 登录 profile）
        │   "rl-*"/默认 → keeper-default（通用 profile）
        │   特定条目    → 任意外部 CDP（含自己的浏览器）
        └─ 返回对应后端 cdpUrl（经各 keeper 的 get cdp-url 现查）
生命周期：browser.close 回调 → 按后端引用计数回收（同 §10.2 keeper 策略）
```

注意点：
- launch 一次/session（daemon 缓存连接）→ 路由在 session 建立时定型，稳定
- session 名即路由键 → 命名纪律仍是前提（"default" 歧义：不命名的消费方共享
  默认后端的 tab 空间；compat-inventory B2/B3 的具名约定仍然成立）
- plugins[] 注册进全局 config 是惰性的（不引用不激活），与 config 最小化不冲突；
  provider 键是否进全局 config 仍是 §10.6 的 A/B/C 问题（router 不改变外层结论）
