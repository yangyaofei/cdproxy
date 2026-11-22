// Package datadir 数据目录定位（bootstrap）：数据目录本身存在哪的答案
// 不能放在数据目录里（自举），故用固定位置的指针文件 ~/.cdproxy/pointer.json。
// 解析链：显式参数 > env CDPROXY_DATA_DIR > 指针文件 > 默认 ~/.cdproxy。
package datadir

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
)

// Path 指针文件固定位置。
func Path() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".cdproxy", "pointer.json")
}

// Resolve 解析链（explicit 非空直接生效——CLI/App 显式传入最高优先）。
// env 两个名字等价：CDPROXY_DATA_DIR（本名）与 ABP_DATA_DIR（历史名，
// app_smoke 等既有脚本在用——不认会静默回落默认目录，测试污染生产）。
func Resolve(explicit string) string {
	if explicit != "" {
		return explicit
	}
	if v := os.Getenv("CDPROXY_DATA_DIR"); v != "" {
		return v
	}
	if v := os.Getenv("ABP_DATA_DIR"); v != "" {
		return v
	}
	if data, err := os.ReadFile(Path()); err == nil {
		var p struct {
			DataDir string `json:"data_dir"`
		}
		if json.Unmarshal(data, &p) == nil && p.DataDir != "" {
			return p.DataDir
		}
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".cdproxy")
}

// WritePointer 写指针（UI「修改数据目录」用；重启生效，数据不自动迁移）。
func WritePointer(dir string) error {
	if dir == "" {
		return errors.New("数据目录不能为空")
	}
	if !filepath.IsAbs(dir) {
		return errors.New("数据目录必须是绝对路径")
	}
	if err := os.MkdirAll(filepath.Dir(Path()), 0o755); err != nil {
		return err
	}
	data, _ := json.MarshalIndent(map[string]string{"data_dir": dir}, "", "  ")
	return os.WriteFile(Path(), data, 0o644)
}
