# CI/CD 与密钥保管

> 模式与 denpa-jack（Tauri 2 项目）对齐：私钥永不入库，本地 `certs/`（gitignored）+ GitHub Secrets（CI 还原）+ tracked-file guard 防误提交。

## 密钥资产清单

| 资产 | 本地位置 | 用途 | GitHub Secret |
|---|---|---|---|
| Ed25519 更新签名私钥（PKCS#8） | `desktop/build/updater.key` | 签 `manifest.json`（updater 信任根） | `UPDATER_SIGNING_KEY`（base64） |
| Ed25519 公钥 | `desktop/build/updater.key.pub`（**入库**，编译期 embed） | 客户端验签 | — |
| 代码签名 p12（AES 封装） | `certs/cdproxy-dev.p12` | 签 `.app`（身份 `Denpa Jack Dev`，与 denpa-jack 共用证书——TCC 身份连续） | `CDPROXY_CERT_P12_BASE64`（base64） |
| p12 密码 | denpa-jack `certs/denpa-jack-dev-10y.pw` | 解 p12 | `CDPROXY_CERT_PASSWORD` |

### 密钥来源（与 denpa-jack 复用同一把钥匙材料）

- 更新私钥：denpa 的 minisign 加密私钥（`denpa-jack-updater.key`）经 go-minisign 解密 → 同一把 Ed25519 转 PKCS#8。**丢了 = 无法向存量客户端推更新**（换公钥需发大版本）。
- 代码签名：denpa 的自签证书 `Denpa Jack Dev`（10 年）AES 重封（Wails 内置签名器拒 RC2）。**身份永不换**——换身份 = 每台机器 TCC 权限重授权。

### Secrets 配置（仓库 Settings → Secrets and variables → Actions）

```bash
# CDPROXY_CERT_P12_BASE64
base64 -i certs/cdproxy-dev.p12 | pbcopy
# UPDATER_SIGNING_KEY
base64 -i desktop/build/updater.key | pbcopy
# CDPROXY_CERT_PASSWORD = denpa-jack-dev-10y.pw 的内容
```

## 流水线

### CI（`.github/workflows/ci.yml`）— push master / PR

1. **Tracked-file guard**：`git ls-files` 匹配 `.p12/.pw/.pem/.key/secrets.env/certs/` 与 `tmp/`——密钥被误跟踪立即红灯。
2. `go vet` + `go test`。

### Release（`.github/workflows/release.yml`）— push tag `v*`

**release job（CLI，goreleaser）**：质量门禁 → 多平台 CLI 产物 → 建 Release。

**desktop job（桌面 App）**，依赖 release job 建 Release 后附加资产：

```
构建（wails3 task package:embedded VERSION=tag，agent-browser 内嵌）
→ p12 签名（embed 之后——签名链覆盖内嵌二进制）
→ 守卫：codesign verify + Authority=Denpa Jack Dev 断言（防 ad-hoc 包流出）
→ ditto zip（updater 更新包格式=zip of .app）
→ wails3 updater manifest（Ed25519 签名清单）
→ 守卫：wails3 updater verify（按客户端逻辑完整复验）
→ SHA256SUMS → gh release upload
```

## 本地验证（发布前可全套演练）

```bash
cd desktop && wails3 task package:embedded VERSION=x.y.z
wails3 tool sign --input bin/cdproxy-desktop.app --certificate ../certs/cdproxy-dev.p12 --password "$(cat <denpa>/denpa-jack-dev-10y.pw)"
ditto -c -k --keepParent bin/cdproxy-desktop.app ../dist/cdproxy-desktop_x.y.z_darwin_arm64.zip
wails3 updater manifest -version x.y.z -key build/updater.key -url-prefix <release-url> ../dist/
wails3 updater verify -manifest ../dist/manifest.json -publickey build/updater.key.pub
```

## 客户端更新链（Wails 官方 pkg/updater）

- endpoint：`releases/latest/download/manifest.json`（静态托管，客户端决策）
- 信任根：编译期 embed 公钥；带签名的 release 无公钥 = fail closed
- 换包：原子 swap + 失败自动回滚 + 新包 `codesign --verify` 复验（过不了 = 拒装回滚）
- 热更新不经 Gatekeeper（Go http 下载无 quarantine 属性）；**首装**经浏览器下载才需手动放行（自签无公证）
- 版本号三处一致：tag `vX.Y.Z` = `main.version`（编译期注入）= `CFBundleShortVersionString`（打包期注入）= manifest `version`
