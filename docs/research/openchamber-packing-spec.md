# OpenChamber 内嵌 opencode CLI 打包模式（源码级调研，Phase C 设计输入）

> 来源：subagent 源码分析（github.com/openchamber/openchamber @ d1f6410，2026-11-16）。
> 用途：agent-browser 内嵌进 Wails v3 App 的照抄规格。本文件是设计输入，不是已实现文档。

## 模式骨架

**构建期**：package.json 专用字段 `opencodeCli.version` pin 精确版本（正则强制 exact semver）；
`prepare-opencode-cli.mjs` 从 npm registry 下载 `@opencode/cli-<os>-<arch>` tgz（与官方安装器同源，
完整性由 registry + 包内 package.json version 背书，无 checksum）；缓存 `.cache/opencode-cli/<version>/<platform>-<arch>/`；
解包取二进制 staging 到 `resources/opencode-cli/`（gitignore，只留 .gitkeep）；能跑就跑 `--version` 校验
（跨架构改验包内 package.json version）；electron-builder `extraResources` 放进
`.app/Contents/Resources/opencode-cli/`；**不做 universal**（arch matrix 各出各包）；CI 打包后
`verify:opencode-cli:packaged` 复验。失败不重试（单次 fetch，fail 即 exit 1），重试交给 CI 缓存
（cache key 含版本号）。

**运行期解析链**（优先级）：policy pin（企业策略，覆盖一切且失效不回落）→ settings.opencodeBinary
（空串哨兵=清除该级覆盖）→ env（OPENCODE_BINARY 等）→ **bundled**（process.resourcesPath/opencode-cli；
dev 模式经 OPENCHAMBER_BUNDLED_OPENCODE_CLI_DIR 交接，dev 必须跑 release 同款二进制）→ PATH →
家目录 + well-known 硄编码清单（/opt/homebrew/bin 等）→ **login shell 探测**
（`zsh -lic 'echo __MARKER__; env -0'`，5s 超时放弃，marker 剥 rc banner，只补缺失键，PATH shell 优先合并
——Finder/Dock 启动的 GUI app 没有 shell PATH，homebrew CLI 会找不到，这是最易漏的坑）。
每级命中记 source（policy/settings/env/bundled/path/fallback）。desktop 命中 bundled 不回写 env
（防 AppImage 更新后旧挂载点被当显式覆盖）。

**spawn**：端口 `net.listen(0)` 抢临时端口再关掉交给子进程；`serve --hostname 127.0.0.1 --port N`；
Unix `detached`（自成进程组，负 pid 可杀整组）；stdio pipe；stdout 轮询就绪行（超时 30s，
exit-before-ready 带输出拒绝）；stderr 32KB 有界尾巴；启动重试 2 次退避 750ms×attempt
（二进制本身不行不重试）；运行中 15s 健康轮询，进程死=立即重启，不健康=连续 20 次才重启
（有活跃 session 缓 2 分钟再强启）。

**托管登记**（最值得抄）：`~/.config/openchamber/managed-opencode/<pid>.json`，一 pid 一文件
（多运行时并发零写竞争），spawn 即写（所有权从 spawn 起算，含 never-ready 的），
临时文件+rename 原子写，best-effort 不阻断。字段 `{pid, ownerPid, port, binary, runtime, startedAt}`。
启动 reaper（先于任何 spawn）：三重安全判定——① 只碰本产品登记的 pid；② `ps -p <pid> -o ppid=,command=`
复验身份（command 须含 opencode+serve+已知端口，防 pid 回收栽赃）；③ 孤儿判定 ppid==1 或 ownerPid 死。
kill：SIGTERM(进程组)→1.5s 轮询→SIGKILL。优雅停机确认子进程真退出后才删登记。

**升级联动**：`upgrade-capability.js`——bundled → `{supported:false, reason:'bundled'}`，**内嵌二进制
从不原地升级**，随 app 更新整体换 Resources（结构性联动，无专门代码）。用户自装二进制才委托
`opencode upgrade`，错误永不回传安装器输出（含凭据），stdin.end() 代替交互等待。

**签名**：macOS 无单独重签脚本——electron-builder 签名 pass 递归覆盖 bundle 内所有 Mach-O
（hardened runtime + entitlements），公证 + stapler；CI 验证闭环 `codesign -vv --deep --strict` +
runtime flag 检查 + stapler validate（重试 5 次，Apple 侧偶发断连）。entitlements 关键项：
`com.apple.security.cs.disable-library-validation`（允许加载非同证书库，内嵌 CLI 在 hardened
runtime 下能跑的关键）。afterPack 给主程序打自定义 LC_UUID（Local Network 隐私按 UUID 识别 app）。
Windows：SignPath 签，无证书显式 CSC_IDENTITY_AUTO_DISCOVERY=false 免签。

## 照抄到 agent-browser（Wails v3，macOS 起步）清单

### A 构建脚本
- pin：`embedded/agentbrowser/version.txt` 精确 semver 正则校验；env `APP_AGENT_BROWSER_VERSION` 覆盖（同样过正则）
- 产物映射：写死 darwin/arm64（+可选 x64）；agent-browser 无 -baseline 变体则无那层复杂度
- 下载源：npm 平台包（registry + 包内 version 背书，免 checksum）或 GitHub release（**必须校验 checksums.txt sha256**）
- 缓存 `./.cache/agent-browser/<version>/<os>-<arch>/`；CI actions/cache key 含版本
- staging `build/agent-browser/agent-browser`：清空（保留 .gitkeep）再拷入 + chmod 755；.gitignore
- 校验：staged 二进制 `--version` 含 pin 版本；幂等短路（已 staged 且版本匹配直接返回）；无重试
- 打包后独立复验：从 .app/Contents/Resources/agent-browser/ 找二进制再跑 --version

### B 打包
- Wails 无 extraResources 等价物 → 构建后处理：wails3 build 出 .app 后脚本拷 staging 进
  `Contents/Resources/agent-browser/`，再签名。（备选 go:embed 首启解包——不推荐：多解包对账逻辑、
  包体翻倍、失结构性升级）
- 不做 universal，per-arch 出包

### C 运行时解析（resolve.go）
settings.agentBrowserBinary（空=清除）→ env AGENT_BROWSER_BINARY → bundled
（os.Executable() → ../Resources/agent-browser/agent-browser；dev 用 APP_AGENT_BROWSER_BUNDLED_DIR
指构建 staging）→ PATH（登录 shell 的）→ well-known（/opt/homebrew/bin、/usr/local/bin）→
login shell 探测（zsh -lic env -0，5s 超时，marker 剥 banner，只补缺失键）。记 source。

### D spawn 与登记（lifecycle.go + registry.go）
- 端口 net.Listen 127.0.0.1:0 抢占再关；Setpgid: true；stdio pipe + stderr 32KB 尾巴
- 就绪轮询 30s；重试 2 次 750ms 退避；15s 健康轮询，死=立即拉起，不健康=20 次阈值
- 登记：`~/Library/Application Support/<App>/managed-agent-browser/<pid>.json` 一 pid 一文件，
  原子写 best-effort；启动 reaper 三重判定；kill SIGTERM(组)→1.5s→SIGKILL；确认退出才删登记
- macOS 无需 Windows stdin lease（--stdio 租约）整套

### E 升级与签名
- 内嵌=随 app 更换 Resources，无原地升级代码；未来用户自装二进制才委托其 upgrade 且不回传输出
- 签名：拷入 Resources 后 `codesign --force --deep --options runtime --entitlements ... --sign`；
  entitlements 含 disable-library-validation；notarytool submit --wait + stapler；
  CI 验证 codesign -vv --deep --strict + stapler validate + verify --packaged 三连

### macOS 单平台可简化
砍：Windows PE 头校验/跨架构包内校验/stdin lease/taskkill/PowerShell 探测/-baseline/universal/
enterprise policy pin/electron-updater（换 Wails 生态 sparkle 等）。
保留：一 pid 一文件登记格式（零成本）、login shell 探测（zsh 分支）——GUI app 最易漏的坑。
