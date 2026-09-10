package keeper

import (
	"os/exec"
	"testing"
	"time"
)

// spawnFakeChrome 造带 marker 的假进程（sleep，cmdline 含 user-data-dir 标记），
// 用于验证 chromePIDs 定位与 stopPIDs 升级链——绝不触碰真基座。
func spawnFakeChrome(t *testing.T, cfg Config, n int) []int {
	t.Helper()
	var pids []int
	var cmds []*exec.Cmd
	for i := 0; i < n; i++ {
		// 双命令脚本防 bash exec 优化（优化后 argv[0] 消失、ps 只剩 sleep 60）；
		// argv[0] 同时带 Chrome 束路径与 marker（匹配 chromePIDs 的双校验）
		cmd := exec.Command("sh", "-c", "sleep 60; exit 0",
			cfg.ChromePath+" --user-data-dir="+cfg.ProfileDir)
		if err := cmd.Start(); err != nil {
			t.Fatalf("启动假进程失败: %v", err)
		}
		pids = append(pids, cmd.Process.Pid)
		cmds = append(cmds, cmd)
	}
	t.Cleanup(func() {
		// Wait 回收僵尸（父进程不 Wait，进程会以 Z 态挂在进程表）
		for _, cmd := range cmds {
			_ = cmd.Process.Kill()
			_ = cmd.Wait()
		}
	})
	time.Sleep(100 * time.Millisecond) // 等 ps 可见
	return pids
}

func TestChromePIDsFindsAllMarkerProcesses(t *testing.T) {
	cfg := Defaults()
	fakes := spawnFakeChrome(t, cfg, 2)
	found := map[int]bool{}
	for _, pid := range cfg.chromePIDs() {
		found[pid] = true
	}
	for _, pid := range fakes {
		if !found[pid] {
			t.Fatalf("chromePIDs 应找到假进程 %d（marker 全量匹配）", pid)
		}
	}
}

func TestStopPIDsTerminatesAllAndReportsNoneAlive(t *testing.T) {
	cfg := Defaults()
	fakes := spawnFakeChrome(t, cfg, 3)
	alive := cfg.stopPIDs(fakes)
	if len(alive) != 0 {
		t.Fatalf("stopPIDs 后不应有存活，实际 %v", alive)
	}
	for _, pid := range fakes {
		if processAlive(pid) {
			t.Fatalf("假进程 %d 应已终止", pid)
		}
	}
}

func TestStopNoChromeRunningIsNil(t *testing.T) {
	// 不启动任何假进程：若无真基座在跑，Stop 应返回 nil（无人可停）；
	// 若真基座恰好在跑，Stop 会真停它——本测试只在无真基座时运行。
	cfg := Defaults()
	if len(cfg.chromePIDs()) != 0 {
		t.Skip("真基座在跑，跳过（Stop 会真停它）")
	}
	if err := cfg.Stop(); err != nil {
		t.Fatalf("无进程时 Stop 应为 nil，实际 %v", err)
	}
}
