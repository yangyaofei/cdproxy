// Package assets 内嵌随二进制分发的静态资产。
//
// Admin 页（static/admin，零构建 Alpine）编译进二进制——分发不需要携带
// 任何外部文件；资产源文件仍在仓库根 static/admin（与 Python 参考实现
// 共用同一份源）。
package assets

import "embed"

// FS 内嵌整个 static/ 子树（含 admin/ 与 README）。
//
//go:embed static
var FS embed.FS
