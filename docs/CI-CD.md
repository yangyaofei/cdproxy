# CI/CD、签名与发版运维（cdproxy）

> 外部运维唯一文档：只记录无法写在代码注释里的内容（密钥保管、签名身份、GitHub Secrets、CI/CD 流水线、发版与分发操作）。架构与协议契约见各包源码注释与 [AGENTS.md](../AGENTS.md)。

## 1. 密钥与签名身份（本地 `certs/`，永不入库）

与 `denpa-jack` 复用同一把代码签名证书与 Ed25519 更新密钥材料——**身份与公钥绝不轻易更换**（换证书会重置各机器 TCC 授权，换公钥会断开存量客户端热更新）。

| 资产 | 本地位置（gitignored） | 用途 | GitHub Secret |
|---|---|---|---|
| 代码签名证书（AES p12） | `certs/cdproxy-dev.p12` | 签 `.app`（`Authority=Denpa Jack Dev`，Wails 签名器要求 AES 封装） | `CDPROXY_CERT_P12_BASE64`（base64） |
| p12 密码 | `denpa-jack/certs/denpa-jack-dev-10y.pw` | 解 p12 | `CDPROXY_CERT_PASSWORD` |
| Ed25519 更新私钥（PKCS#8） | `certs/updater.key` | 签发 `manifest.json`（Wails `pkg/updater` 信任根） | `UPDATER_SIGNING_KEY`（base64） |
| Ed25519 更新公钥 | `certs/updater.key.pub` | 构建期拷入 `desktop/build/updater.key.pub` 经 `go:embed` 钉进二进制 | `UPDATER_PUBLIC_KEY`（base64） |

> 所有四项必须存为 GitHub **Secrets**（严禁放明文 Variables；转 Public 后 Variables 对所有人可见）。

配置 Secrets 命令：

```bash
base64 -i certs/cdproxy-dev.p12 | gh secret set CDPROXY_CERT_P12_BASE64
gh secret set CDPROXY_CERT_PASSWORD < ../denpa-jack/certs/denpa-jack-dev-10y.pw
base64 -i certs/updater.key     | gh secret set UPDATER_SIGNING_KEY
base64 -i certs/updater.key.pub | gh secret set UPDATER_PUBLIC_KEY
```

## 2. CI / Release 流水线（`.github/workflows/`）

| 工作流 | 触发 | 作业与检查 |
|---|---|---|
| `ci.yml` | push `master` / PR / 手动 | `core`（`ubuntu-latest`）：tracked-file 密钥守卫 → 前端语法/同步/构建 → `go vet`/`go test` → Windows 桌面交叉编译；`desktop-macos`（`macos-15`）：Wails macOS CGO 桌面宿主 vet + 编译 |
| `release.yml` | push `v*` tag / 手动 `workflow_dispatch` | `release`（GoReleaser 全平台 CLI）→ `desktop`（`macos-15`：内嵌 `agent-browser` `.app` + p12 签名 + `Authority` 断言 + `manifest.json` 验签）+ `desktop-windows`（`windows-latest`：`cdproxy-desktop.exe` zip）→ 统一上传 GitHub Release |

## 3. 发版与本地演练

```bash
# 正式发版（推送非 prerelease tag，确保 /releases/latest/ 可被客户端发现）
git tag v0.9.0 && git push origin v0.9.0
```

本地完整演练（打包 → 签名 → 生成并复验更新清单）：

```bash
cd desktop && PATH="$HOME/go/bin:$PATH" wails3 task package:embedded VERSION=0.9.0
wails3 tool sign --input bin/cdproxy-desktop.app --certificate ../certs/cdproxy-dev.p12 --password "$(cat ../../denpa-jack/certs/denpa-jack-dev-10y.pw)"
codesign --verify --deep --strict bin/cdproxy-desktop.app
mkdir -p ../dist
ditto -c -k --keepParent bin/cdproxy-desktop.app ../dist/cdproxy-desktop_0.9.0_darwin_arm64.zip
wails3 updater manifest -version 0.9.0 -key ../certs/updater.key -url-prefix "https://github.com/yangyaofei/agent-browser-proxy/releases/download/v0.9.0" ../dist/
wails3 updater verify -manifest ../dist/manifest.json -publickey build/updater.key.pub
```

## 4. 客户端热更新与跨机分发

- **热更新**：客户端轮询 `releases/latest/download/manifest.json`（Ed25519 强制验签 + 原子替换 + `codesign --verify` 失败回滚）。App 自主下载不带 `com.apple.quarantine`，不经 Gatekeeper 拦截。
- **跨机首装**：自签证书未公证，浏览器/AirDrop 下载首次打开需在「系统设置 → 隐私与安全性 → 仍要打开」放行（或 `xattr -dr com.apple.quarantine /Applications/cdproxy-desktop.app`）。

## 5. Private → Public 开源前检查清单

1. **历史零密钥**：`git log --all --name-only` 确认无 `.p12`/`.pw`/`.pem`/`.key`/`secrets.env`/`certs/`。
2. **源码零私密路径/凭据**：确认无本机 `/Users/...` 硬编码与真实 token。
3. **CI/CD 全绿**：`ci.yml` 与一次完整 `release.yml` 在 GitHub Actions 跑通（含 `CDPROXY_*`/`UPDATER_*` 四个 Secrets）。
4. **开源协议**：根目录补充 `LICENSE` 文件（如 MIT）。
5. **切换可见性**：GitHub Settings → Danger Zone → Change visibility → Public（公开后 `releases/latest/download/manifest.json` 才无需登录态，客户端应用内更新即刻全网可用）。
