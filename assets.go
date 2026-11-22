// Package assets 内嵌随二进制分发的静态资产。
//
// 编译期经 go:embed 打包两类资产，分发单二进制 / 桌面 App 无需携带外部文件：
//   - static/admin/：Admin 管理页（零构建 Alpine + vendored Tabulator；亦为
//     scripts/sync_admin_frontend.py 同步到 desktop/frontend/ 的唯一源）
//   - ext/cdp-ext/：Chrome MV3 反向桥扩展（供控制面一键导出本地目录或下载 ZIP）
package assets

import "embed"

// FS 内嵌 static/（Admin 静态页）与 ext/cdp-ext/（随包浏览器扩展，含 _locales/ 双语目录）。
//
//go:embed static all:ext/cdp-ext
var FS embed.FS
