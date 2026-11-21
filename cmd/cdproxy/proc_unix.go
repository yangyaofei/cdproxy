//go:build !windows

// Unix 平台停机信号集：监听 SIGINT 与 SIGTERM，触发 serve 优雅停机。
package main

import (
	"os"
	"syscall"
)

func shutdownSignals() []os.Signal {
	return []os.Signal{os.Interrupt, syscall.SIGTERM}
}

func terminatePID(pid int) error {
	return syscall.Kill(pid, syscall.SIGTERM)
}

func detachedSysProcAttr() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{Setsid: true}
}
