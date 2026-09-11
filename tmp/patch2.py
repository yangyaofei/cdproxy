from pathlib import Path

# ── keeper.go：WriteConfig 带 idleTimeout（内容变了才重写）+ EnsureRunning 收超时参数 ──
p = Path("internal/keeper/keeper.go"); t = p.read_text()
t = t.replace('''// WriteConfig 生成会话专用最小配置（存在则不动，尊重手工修改）。
// 绝不含 provider/plugins——ab-keeper 的 daemon 若继承 provider 配置，
// 会经插件再拉起自己（无限递归）。idleTimeout=0：消费方的活动走的是
// 直连基座的裸 CDP，ab-keeper 会话本身看不到——空闲关闭由 proxy 的
// 策略（看得到全貌）负责，绝不能让 daemon 的空闲计时误杀在用基座。
func (c Config) WriteConfig() error {
	if c.ConfigPath == "" {
		return fmt.Errorf("keeper 配置路径未设置")
	}
	if _, err := os.Stat(c.ConfigPath); err == nil {
		return nil
	}
	body := fmt.Sprintf(`{
  "headed": %t,
  "profile": %q,
  "idleTimeout": "0"
}
`, c.Headed, c.ProfileDir)
	if err := os.MkdirAll(filepath.Dir(c.ConfigPath), 0o755); err != nil {
		return err
	}
	return os.WriteFile(c.ConfigPath, []byte(body), 0o644)
}''',
'''// WriteConfig 生成会话专用最小配置（内容变化才重写）。
// 绝不含 provider/plugins——ab-keeper 的 daemon 若继承 provider 配置，
// 会经插件再拉起自己（无限递归）。
// idleTimeout 即基座空闲策略，由 agent-browser 原生执行（"0"=禁用）：
// 消费者活动经 proxy 心跳（get cdp-url）重置计时；裸 CDP 活动期间
// daemon 的空闲计时被心跳喂住，不会误杀在用基座。
// 修改阈值在基座下次冷启动生效。
func (c Config) WriteConfig(idleTimeout string) error {
	if c.ConfigPath == "" {
		return fmt.Errorf("keeper 配置路径未设置")
	}
	body := fmt.Sprintf(`{
  "headed": %t,
  "profile": %q,
  "idleTimeout": %q
}
`, c.Headed, c.ProfileDir, idleTimeout)
	if old, err := os.ReadFile(c.ConfigPath); err == nil && string(old) == body {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(c.ConfigPath), 0o755); err != nil {
		return err
	}
	return os.WriteFile(c.ConfigPath, []byte(body), 0o644)
}

// IdleTimeoutString 把秒数转成 agent-browser 的 idle-timeout 形式（"0"=禁用）。
func IdleTimeoutString(seconds float64) string {
	if seconds <= 0 {
		return "0"
	}
	minutes := int(seconds/60 + 0.9999)
	if minutes < 1 {
		minutes = 1
	}
	return fmt.Sprintf("%dm", minutes)
}''')
t = t.replace('''// EnsureRunning 确保基座活着，返回浏览器级 WS 地址。
// get cdp-url 在会话/浏览器不存在时由 agent-browser 自动拉起（冷启动数秒）。
func (c Config) EnsureRunning() (string, error) {
	if err := c.WriteConfig(); err != nil {
		return "", fmt.Errorf("生成 keeper 配置失败: %w", err)
	}
	out, err := c.runKeeper([]string{"get", "cdp-url"}, 60*time.Second)''',
'''// EnsureRunning 确保基座活着，返回浏览器级 WS 地址。
// get cdp-url 在会话/浏览器不存在时由 agent-browser 自动拉起（冷启动数秒）。
func (c Config) EnsureRunning(idleTimeout string) (string, error) {
	if err := c.WriteConfig(idleTimeout); err != nil {
		return "", fmt.Errorf("生成 keeper 配置失败: %w", err)
	}
	out, err := c.runKeeper([]string{"get", "cdp-url"}, 60*time.Second)''')
p.write_text(t); print("keeper ✓")

# ── state.go：PeekOwnedTargets ──
p = Path("internal/state/state.go"); t = p.read_text()
t = t.replace('''// Release 释放 session，返回 session（不存在则 nil）与其名下 target 列表。''',
'''// PeekOwnedTargets 只读查看名下 target（不摘除）——释放流程先关 tab 再摘表，
// 保证最后一个会话释放时下游仍可用（关 tab 需要 ds 连接）。
func (st *State) PeekOwnedTargets(name string) []string {
	st.mu.Lock()
	defer st.mu.Unlock()
	sess, ok := st.sessions[name]
	if !ok {
		return nil
	}
	return sess.OwnedTargets()
}

// Release 释放 session，返回 session（不存在则 nil）与其名下 target 列表。''')
p.write_text(t); print("state ✓")

# ── proxy.go：删 reaper/idleDown → 心跳；ensureDownstream 按活动守卫；Release 先关 tab ──
p = Path("internal/proxy/proxy.go"); t = p.read_text()

t = t.replace('''	server *http.Server

	idleDown atomic.Bool // 基座被空闲策略有意关闭：抑制自愈重启，等下次分配唤醒
}''', '''	server *http.Server
}''')

t = t.replace('''// startIdleReaper 空闲巡检：连续（阈值内每个周期都满足）无会话且无人工页面
// 达到 keeper_idle_shutdown_seconds 后，验证式关闭基座。登录态在磁盘 profile
// 零损失；下次 AllocSession 冷启动唤醒（首次打开多 2~5s 启动延迟）。
// 人工在基座里打开的页面（无主 tab）计入活动——不会在用户看着时杀掉浏览器。
func (p *Proxy) startIdleReaper() {
	go func() {
		idleSince := time.Time{}
		for {
			time.Sleep(idleCheckInterval)
			threshold := p.store.Get().KeeperIdleShutdownSeconds
			if threshold <= 0 {
				idleSince = time.Time{}
				continue
			}
			if p.st.SessionCount() > 0 {
				idleSince = time.Time{}
				continue
			}
			unowned, err := p.unownedPageCount()
			if err != nil {
				// 基座本来就没跑：已经是空闲态，记起点即可
				if idleSince.IsZero() {
					idleSince = time.Now()
				}
				continue
			}
			if unowned > 0 {
				idleSince = time.Time{}
				continue
			}
			if idleSince.IsZero() {
				idleSince = time.Now()
				continue
			}
			if time.Since(idleSince) < time.Duration(threshold*float64(time.Second)) {
				continue
			}
			p.mu.Lock()
			old := p.baseWS
			p.mu.Unlock()
			if err := p.cfg.Stop(old); err != nil {
				// 关不掉（agent-browser 关闭失败/基座未死）：如实记录，下轮再试
				p.log.Error("基座空闲关闭失败", "err", err)
				idleSince = time.Time{}
				continue
			}
			p.idleDown.Store(true)
			p.mu.Lock()
			ds := p.ds
			p.ds = nil
			p.mu.Unlock()
			if ds != nil {
				_ = ds.Close(websocket.StatusGoingAway, "keeper idle shutdown")
			}
			idleSince = time.Time{}
			p.log.Info("基座已空闲关闭（无会话且无人工页面）",
				"threshold_seconds", threshold, "wake", "下次 AllocSession 冷启动")
		}
	}()
}''',
'''// startBaseKeepAlive 基座保活心跳：有活动（会话在或人工页面在）时周期性执行
// get cdp-url——重置 agent-browser 侧基座会话的空闲计时（基座空闲关闭由
// agent-browser 原生 idle-timeout 执行，proxy 不关基座），顺带在基座意外死亡
// 且仍有会话时经自动拉起完成自愈。无活动时不跳：让原生空闲计时走到关闭。
func (p *Proxy) startBaseKeepAlive() {
	go func() {
		for {
			time.Sleep(idleCheckInterval)
			threshold := p.store.Get().KeeperIdleShutdownSeconds
			if threshold <= 0 {
				continue // idleTimeout=0：基座永久驻留，无需心跳
			}
			active := p.st.SessionCount() > 0
			if !active && p.dsConnected() {
				if n, err := p.unownedPageCount(); err == nil && n > 0 {
					active = true // 人工页面在场（用户正在看）
				}
			}
			if !active {
				continue // 无活动：不喂计时，agent-browser 原生空闲关闭
			}
			if _, err := p.cfg.EnsureRunning(IdleTimeoutString(threshold)); err != nil {
				p.log.Error("基座保活心跳失败", "err", err)
			}
		}
	}()
}

// dsConnected 下游是否连着（心跳活动判定用，不触发连接）。
func (p *Proxy) dsConnected() bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.ds != nil
}''')

t = t.replace('''	p.log.Info("代理 WS 服务已启动", "addr", addr)
	p.startIdleReaper()
	return nil''', '''	p.log.Info("代理 WS 服务已启动", "addr", addr)
	p.startBaseKeepAlive()
	return nil''')

# AllocSession 唤醒段删除（idleDown 没了）
t = t.replace('''func (p *Proxy) AllocSession(name string) (string, error) {
	if p.idleDown.Load() {
		p.idleDown.Store(false)
		p.log.Info("基座从空闲关闭中唤醒（冷启动）", "session", name)
	}
	if err := p.ensureDownstream(); err != nil {
		return "", err
	}''', '''func (p *Proxy) AllocSession(name string) (string, error) {
	// st.Alloc 先建会话（计数+1），随后 ensureDownstream 的活动守卫自然放行
	if err := p.ensureDownstream(); err != nil {
		return "", err
	}''')

# ensureDownstream 守卫：按活动
t = t.replace('''	if p.idleDown.Load() && p.st.SessionCount() == 0 {
		return fmt.Errorf("基座已空闲关闭，等待下次分配唤醒")
	}''', '''	if p.st.SessionCount() == 0 {
		return fmt.Errorf("基座未运行且无活动会话（等待分配唤醒）")
	}''')

# onDownstreamDead：按活动解释
t = t.replace('''	if err := p.ensureDownstream(); err != nil {
		// 含"基座已空闲关闭"的预期路径——不算故障
		if !p.idleDown.Load() {
			p.log.Error("下游重建失败", "err", err)
		}
	}
}''', '''	if err := p.ensureDownstream(); err != nil {
		// 无会话时基座死亡（原生空闲关闭/人工退出）= 预期路径，保持关闭
		if p.st.SessionCount() > 0 {
			p.log.Error("下游重建失败", "err", err)
		} else {
			p.log.Info("基座已退出且无活动会话，保持关闭（下次分配唤醒）")
		}
	}
}''')

# RestartKeeper：去 idleDown
t = t.replace('''func (p *Proxy) RestartKeeper() error {
	p.idleDown.Store(false)
	p.mu.Lock()''', '''func (p *Proxy) RestartKeeper() error {
	p.mu.Lock()''')

# ReleaseSession：先关 tab（会话还在表内）再摘表
t = t.replace('''func (p *Proxy) ReleaseSession(name string) {
	defer p.ilog.DetachFile(name)
	sess, targets := p.st.Release(name)
	if sess == nil {
		return
	}
	closed := 0
	for _, tid := range targets {
		if err := p.dsRaw("Target.closeTarget", map[string]any{"targetId": tid}); err != nil {
			p.log.Error("关 tab 失败", "target", tid, "err", err)
		} else {
			closed++
		}
	}
	if len(targets) > 0 {
		p.log.Info("会话已释放", "session", name, "tabs_total", len(targets), "tabs_closed", closed)
	}''',
'''func (p *Proxy) ReleaseSession(name string) {
	defer p.ilog.DetachFile(name)
	// 先关 tab 再摘表：最后一个会话释放时若先摘表（计数归零），
	// ensureDownstream 的活动守卫会拒绝连接，tab 永远关不掉
	targets := p.st.PeekOwnedTargets(name)
	closed := 0
	for _, tid := range targets {
		if err := p.dsRaw("Target.closeTarget", map[string]any{"targetId": tid}); err != nil {
			p.log.Error("关 tab 失败", "target", tid, "err", err)
		} else {
			closed++
		}
	}
	sess := p.st.Release(name)
	if sess == nil {
		return
	}
	if len(targets) > 0 {
		p.log.Info("会话已释放", "session", name, "tabs_total", len(targets), "tabs_closed", closed)
	}''')

# import atomic 可能不再用——检查
p.write_text(t); print("proxy ✓")
