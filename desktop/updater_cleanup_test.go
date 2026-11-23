package main

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestBundleTargetInfo(t *testing.T) {
	parent, app := bundleTargetInfo("/Applications/cdproxy.app/Contents/MacOS/cdproxy")
	if runtime.GOOS == "darwin" {
		if parent != "/Applications" || app != "cdproxy.app" {
			t.Fatalf("darwin app bundle mismatch: got (%q, %q)", parent, app)
		}
	} else if parent == "" || app != "cdproxy" {
		t.Fatalf("non-darwin binary mismatch: got (%q, %q)", parent, app)
	}

	parent2, app2 := bundleTargetInfo("/usr/local/bin/cdproxy-dev")
	if parent2 != "/usr/local/bin" || app2 != "cdproxy-dev" {
		t.Fatalf("plain binary mismatch: got (%q, %q)", parent2, app2)
	}
}

func TestCleanupStaleUpdateDirs(t *testing.T) {
	root := t.TempDir()

	// 1. 应删除：含 cdproxy.app 的残留暂存目录
	staleAppDir := filepath.Join(root, "wails-update-111")
	if err := os.MkdirAll(filepath.Join(staleAppDir, "cdproxy.app", "Contents"), 0o755); err != nil {
		t.Fatal(err)
	}

	// 2. 应删除：未解压完但包含 cdproxy_*.zip 的暂存目录
	staleZipDir := filepath.Join(root, "wails-update-222")
	if err := os.MkdirAll(staleZipDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(staleZipDir, "cdproxy_0.12.3_darwin_arm64.zip"), []byte("zip"), 0o644); err != nil {
		t.Fatal(err)
	}

	// 3. 应保留：匹配 keepDir
	keepDir := filepath.Join(root, "wails-update-keep")
	if err := os.MkdirAll(filepath.Join(keepDir, "cdproxy.app"), 0o755); err != nil {
		t.Fatal(err)
	}

	// 4. 应保留：属于其他 Wails 应用或未知 .artifact 的目录
	otherAppDir := filepath.Join(root, "wails-update-other")
	if err := os.MkdirAll(filepath.Join(otherAppDir, "OtherApp.app"), 0o755); err != nil {
		t.Fatal(err)
	}
	unknownArtifactDir := filepath.Join(root, "wails-update-artifact")
	if err := os.MkdirAll(unknownArtifactDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(unknownArtifactDir, ".artifact"), []byte("partial"), 0o644); err != nil {
		t.Fatal(err)
	}

	// 5. 应保留：非 wails-update- 前缀的正常应用目录
	normalDir := filepath.Join(root, "cdproxy.app")
	if err := os.MkdirAll(normalDir, 0o755); err != nil {
		t.Fatal(err)
	}

	removed := cleanupStaleUpdateDirs(root, "cdproxy.app", keepDir)
	if len(removed) != 2 {
		t.Fatalf("expected 2 stale dirs removed, got %d: %v", len(removed), removed)
	}

	for _, gone := range []string{staleAppDir, staleZipDir} {
		if _, err := os.Stat(gone); !os.IsNotExist(err) {
			t.Fatalf("expected %s to be removed, stat err=%v", gone, err)
		}
	}
	for _, kept := range []string{keepDir, otherAppDir, unknownArtifactDir, normalDir} {
		if _, err := os.Stat(kept); err != nil {
			t.Fatalf("expected %s to remain intact, stat err=%v", kept, err)
		}
	}
}

func TestCleanupStagedUpdateDir(t *testing.T) {
	parent := t.TempDir()
	outside := t.TempDir()

	// 直接子目录：parent/wails-update-123/cdproxy.app -> 删 wails-update-123
	staging := filepath.Join(parent, "wails-update-123")
	staged := filepath.Join(staging, "cdproxy.app")
	if err := os.MkdirAll(filepath.Join(staged, "Contents"), 0o755); err != nil {
		t.Fatal(err)
	}
	got, err := cleanupStagedUpdateDir(staged, parent)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if filepath.Clean(got) != filepath.Clean(staging) {
		t.Fatalf("expected removed dir %q, got %q", staging, got)
	}
	if _, err := os.Stat(staging); !os.IsNotExist(err) {
		t.Fatalf("expected staging dir removed, stat err=%v", err)
	}

	// 安全边界：不在 parent 下或无 wails-update- 前缀的目录绝不删除
	outsideStaging := filepath.Join(outside, "wails-update-999")
	outsideStaged := filepath.Join(outsideStaging, "cdproxy.app")
	if err := os.MkdirAll(outsideStaged, 0o755); err != nil {
		t.Fatal(err)
	}
	if got, err := cleanupStagedUpdateDir(outsideStaged, parent); err != nil || got != "" {
		t.Fatalf("must not remove dir outside parentDir, got=%q err=%v", got, err)
	}
	if _, err := os.Stat(outsideStaging); err != nil {
		t.Fatalf("outside dir must remain intact: %v", err)
	}

	nonTemp := filepath.Join(parent, "custom-dir")
	nonTempStaged := filepath.Join(nonTemp, "cdproxy.app")
	if err := os.MkdirAll(nonTempStaged, 0o755); err != nil {
		t.Fatal(err)
	}
	if got, err := cleanupStagedUpdateDir(nonTempStaged, parent); err != nil || got != "" {
		t.Fatalf("must not remove non-wails-update dir, got=%q err=%v", got, err)
	}
	if _, err := os.Stat(nonTemp); err != nil {
		t.Fatalf("non-temp dir must remain intact: %v", err)
	}
}
