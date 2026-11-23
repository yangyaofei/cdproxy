// Package main（desktop/updater_cleanup.go）管理 Wails 内置更新器暂存目录的生命周期清理。
//
// 背景：Wails v3 pkg/updater 在目标应用同级目录创建 wails-update-* 暂存目录，
// 且仅在 Restart() 替换成功分支清理；若后台下载后未点重启便退出、异常崩溃或
// 替换失败回滚，wails-update-* 会永久残留。本文件在不改动 Wails 内置机制的
// 前提下，通过「归属严格校验」在普通退出与下次启动时自动清理属于 cdproxy 的残留目录。
package main

import (
	"log/slog"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

const wailsUpdateDirPrefix = "wails-update-"

// bundleTargetInfo 解析可执行文件所属的更新目标所在父目录与应用名（用于清理校验）。
// macOS 上沿 .app bundle 向上定位，与其他平台的普通可执行文件对齐。
func bundleTargetInfo(exePath string) (parentDir, appName string) {
	if exePath == "" {
		return "", ""
	}
	clean := filepath.Clean(exePath)
	if runtime.GOOS == "darwin" {
		cur := clean
		for {
			if strings.HasSuffix(cur, ".app") {
				return filepath.Dir(cur), filepath.Base(cur)
			}
			parent := filepath.Dir(cur)
			if parent == cur {
				break
			}
			cur = parent
		}
	}
	return filepath.Dir(clean), filepath.Base(clean)
}

func isOwnedUpdateDir(dirPath, appName string) bool {
	if appName != "" {
		if _, err := os.Stat(filepath.Join(dirPath, appName)); err == nil {
			return true
		}
	}
	entries, err := os.ReadDir(dirPath)
	if err != nil {
		return false
	}
	for _, entry := range entries {
		if strings.HasPrefix(strings.ToLower(entry.Name()), "cdproxy") {
			return true
		}
	}
	return false
}

// cleanupStaleUpdateDirs 扫描 parentDir 下前缀为 wails-update- 的目录，跳过 keepDir，
// 仅当目录内包含 appName 或以 "cdproxy" 开头（不区分大小写）的条目时才删除，避免误删其他应用。
func cleanupStaleUpdateDirs(parentDir, appName, keepDir string) []string {
	if parentDir == "" {
		return nil
	}
	entries, err := os.ReadDir(parentDir)
	if err != nil {
		return nil
	}
	var cleanKeep string
	if keepDir != "" {
		cleanKeep = filepath.Clean(keepDir)
	}
	var removed []string
	for _, entry := range entries {
		if !entry.IsDir() || !strings.HasPrefix(entry.Name(), wailsUpdateDirPrefix) {
			continue
		}
		full := filepath.Join(parentDir, entry.Name())
		if cleanKeep != "" && filepath.Clean(full) == cleanKeep {
			continue
		}
		if !isOwnedUpdateDir(full, appName) {
			continue
		}
		if err := os.RemoveAll(full); err == nil {
			removed = append(removed, full)
		}
	}
	return removed
}

// cleanupStagedUpdateDir 在普通退出时删除本次已暂存但未执行重启替换的 wails-update-* 目录。
// 从 filepath.Dir(stagedPath) 向上最多检查 2 层，且仅允许删除直接位于 parentDir 下的目录。
func cleanupStagedUpdateDir(stagedPath, parentDir string) (string, error) {
	if stagedPath == "" || parentDir == "" {
		return "", nil
	}
	cleanParent := filepath.Clean(parentDir)
	cur := filepath.Clean(filepath.Dir(stagedPath))
	for i := 0; i < 2; i++ {
		base := filepath.Base(cur)
		dirParent := filepath.Dir(cur)
		if strings.HasPrefix(base, wailsUpdateDirPrefix) && filepath.Clean(dirParent) == cleanParent {
			if err := os.RemoveAll(cur); err != nil {
				return "", err
			}
			return cur, nil
		}
		if dirParent == cur {
			break
		}
		cur = dirParent
	}
	return "", nil
}

func resolveSelfParentAndName() (parentDir, appName string) {
	exe, err := os.Executable()
	if err != nil {
		return "", ""
	}
	if resolved, err := filepath.EvalSymlinks(exe); err == nil {
		exe = resolved
	}
	return bundleTargetInfo(exe)
}

func cleanupStaleUpdateDirsForSelf(log *slog.Logger) {
	parentDir, appName := resolveSelfParentAndName()
	if parentDir == "" {
		return
	}
	removed := cleanupStaleUpdateDirs(parentDir, appName, "")
	for _, dir := range removed {
		if log != nil {
			log.Info("已清理残留更新暂存目录", "dir", dir)
		}
	}
}

func cleanupStagedUpdateForSelf(stagedPath string, log *slog.Logger) {
	if stagedPath == "" {
		return
	}
	parentDir, _ := resolveSelfParentAndName()
	if parentDir == "" {
		return
	}
	dir, err := cleanupStagedUpdateDir(stagedPath, parentDir)
	if err != nil {
		if log != nil {
			log.Warn("退出清理未应用的更新暂存目录失败", "staged", stagedPath, "err", err)
		}
		return
	}
	if dir != "" && log != nil {
		log.Info("已清理退出前未应用的更新暂存目录", "dir", dir)
	}
}
