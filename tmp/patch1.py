from pathlib import Path

p = Path("cmd/agent-browser-proxy/main.go"); t = p.read_text()
assert "kcfg.Headless = opts.headless" in t, "main pattern missing"
t = t.replace("kcfg.Headless = opts.headless", "kcfg.Headed = !opts.headless")
p.write_text(t)

p = Path("internal/control/control.go"); t = p.read_text()
old = '''		snapshot["keeper"] = map[string]any{
			"base_session": c.keeper.Session,'''
new = '''		alive := false
		if down, ok := snapshot["downstream"].(map[string]any); ok {
			alive, _ = down["connected"].(bool)
		}
		snapshot["keeper"] = map[string]any{
			"alive":        alive,
			"base_session": c.keeper.Session,'''
assert old in t, "control pattern missing"
t = t.replace(old, new)
p.write_text(t)

p = Path("static/admin/index.html"); t = p.read_text()
q = chr(39)
old1 = 'status.keeper.chrome ? ' + q + 'ok' + q + ' : ' + q + 'bad' + q
new1 = 'status.keeper.alive ? ' + q + 'ok' + q + ' : ' + q + 'bad' + q
old2 = 'status.keeper.chrome ? ' + q + '存活' + q + ' : ' + q + '未运行' + q
new2 = 'status.keeper.alive ? ' + q + '存活' + q + ' : ' + q + '未运行' + q
assert old1 in t and old2 in t, "index pattern missing"
t = t.replace(old1, new1).replace(old2, new2)
old3 = '<tr><td>Chrome</td><td><code x-text="status.keeper.chrome_path"></code></td></tr>'
new3 = '<tr><td>空闲关闭</td><td><code x-text="status.settings.keeper_idle_shutdown_seconds === 0 ? ' + q + '禁用' + q + ' : status.settings.keeper_idle_shutdown_seconds + ' + q + 's' + q + '"></code></td></tr>'
assert old3 in t, "chrome_path row missing"
t = t.replace(old3, new3)
p.write_text(t)
print("all patched")
