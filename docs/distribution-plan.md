# 分发方案调研与路线（2026-09-02）

> 状态：调研完成待立项。本文是决策依据 + 实施蓝图，未动手。

## 结论

| 通道 | 定位 |
|---|---|
| **Go 重写 + GoReleaser** | 主通道（推荐，spike 已实证关键假设，见下） |
| PyInstaller | 备用（不重写的最快二进制路径，体积 3 倍、无交叉编译） |
| Docker | 二期（服务器端/无头浏览器农场场景；本地有头+登录态场景架构错位） |
| Skill 改造 | 待分发落地后执行（计划见文末，先记录） |

## Spike 实证（var/spike-go/，go1.27 darwin/arm64）

| 假设 | 结果 |
|---|---|
| `go:embed` 内嵌 Admin 静态页 | ✓ 单二进制内含资产，curl 可达 |
| 交叉编译 linux/amd64 + linux/arm64（CGO_ENABLED=0） | ✓ 零额外配置，一条命令 |
| coder/websocket v1.8.15 | ✓ 与 python websockets 客户端互通（现有测试工具链直接复用） |
| 单二进制体积（`-s -w`） | 5.6MB（darwin）/ 5.9MB（linux-amd64）/ 5.5MB（linux-arm64） |
| Linux 静态产物真实可执行 | ✓ alpine 容器内直接跑通 |

## Go vs Rust

| 维度 | Go | Rust |
|---|---|---|
| 并发模型贴合度 | goroutine ↔ 每连接一协程，与现架构 1:1 | tokio 可行，Arc/Mutex 仪式更重 |
| 标准库覆盖 | net/http + encoding/json + os/exec 覆盖约七成 | 需 tokio 全家桶 |
| 交叉编译 | 一条命令（已实证） | cross-rs / musl 多 target 配置（未 spike） |
| 发布工具 | GoReleaser：多平台产物 + SHA256 + Homebrew tap 自动维护 + 签名 | cargo-dist（axo）/ release-plz，生态较新（未 spike） |
| 迭代与维护 | 秒级构建，可读性平实 | 学习曲线 + 共享状态路由代码的生命周期成本 |

判断：本项目价值 = 分发友好 + 稳定小工具。Go 的优势全部命中、劣势全部不命中。
Rust 的类型安全与性能在此负载（本地 stdio + localhost WS）无收益。

## 架构映射（Python → Go）

```
cmd/agent-browser-proxy/main.go   # 子命令 serve / status / stop / plugin（stdlib flag）
internal/keeper/                  # exec.Command + SysProcAttr{Setsid: true}（对应 start_new_session）
internal/state/                   # sync.RWMutex 守护归属表/pending（语义逐条对齐 state.py）
internal/proxy/                   # 上游 WS 服务 + 下游客户端 + 消息路由（核心约 400 行）
internal/control/                 # net/http JSON API + go:embed static/admin
internal/settings/                # settings.json 原子写（临时文件 + rename）
```

迁移红利：
- control→proxy 的 `run_coroutine_threadsafe` 桥接消失（Go 无线程/事件循环分裂，直接方法调用）
- Admin 页编译进二进制（无 PyInstaller `--add-data` 之类的打包步骤）
- `_schedule_reap` → `time.AfterFunc`；`asyncio.Event` 停机 → `signal.NotifyContext`
- **现有黑盒测试（smoke_test.py / concurrency_test.sh / agent-browser 实连）语言无关，
  直接作为移植验收契约**：五项冒烟 + 并发零串扰全绿 = 功能对等

## 发布管线（GoReleaser）

```yaml
# .goreleaser.yaml 要点
builds:
  - env: [CGO_ENABLED=0]
    goos: [darwin, linux]
    goarch: [amd64, arm64]
    ldflags: ["-s -w -X main.version={{.Version}}"]
```

- 已实施（88e738c 后续 commit）：.goreleaser.yaml + .github/workflows/release.yml（push tag v* → 门禁 → 四平台产物 + checksums.txt 落 Release）；快照本地验证通过（10s 全流程）
- 可选：Homebrew tap（GoReleaser 自动维护 Formula）→
  `brew install yangyaofei/tap/agent-browser-proxy`
- 用户接入：`~/.agent-browser/config.json` 的
  `plugins[0] = {name, command: <二进制路径>, args: ["plugin"], capabilities: [browser.provider]}`
  （**args 字段待实测**；若无 args，备选：二进制在无子命令且 stdin 为管道时自动进 plugin 模式）

## PyInstaller 备用要点（已调研未实施）

- onefile 约 12-18MB；macOS 上只能打 macOS 包（无交叉编译，Linux/Windows 需 CI matrix）
- 需 `--add-data static/admin`；运行数据目录须从仓库 var/ 迁 `~/.agent-browser/`
- 自用免签名；对外分发需 codesign + notarize

## Skill 改造计划（记录待办）

- 定位：机制研究/规则 → **安装 + 使用手册**；建议更名
  `agent-browser-keeper` → `agent-browser-proxy`
- 新 SKILL.md 大纲：
  安装（二进制/brew 落位 → config 四键 → 三步验证：health / agent-browser open / Admin 页）
  使用（具名 session 禁 default / 焦点模式 / Admin 页 / B 类自管隔离）
  排障（服务自启链路 / keeper 死 → status / 端口冲突 / tab 泄漏 → release）
  红线（killall 禁令 / 并发 default 撞归属）
- references/（mechanism.md 410 行研究史 + compat-inventory.md 存量扫描）保留为历史依据
- 时机：oh-my-agents PR #1 review 合并后

## 决策点

1. ~~Go 重写立项？~~ 已完成（2026-09-02）：功能对等达成，黑盒验收全绿（冒烟五项 / agent-browser e2e 隔离+tab 全功能+焦点 / 并发 190 操作 0 失败 / plugin 三模式 / Admin 内嵌 / 自启动链路）
2. Homebrew tap 暂缓——仓库 PRIVATE，brew install 拉不到私有仓库；公开后加 goreleaser brew 段即可
3. Python 版处置：归档保留为参考实现，还是重写验收后删除
