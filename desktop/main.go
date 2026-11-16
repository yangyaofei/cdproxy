// cdproxy 桌面 App（Wails v3）。
//
// 形态：菜单栏常驻（ActivationPolicyAccessory，无 Dock 图标）+ 托盘菜单
// （状态/打开管理界面/重启引擎/退出）+ 懒创建的管理窗口。引擎
// （internal/core）编译进主进程随 App 启停；管理界面经 EngineService
// .DoRequest 进程内执行 control 路由——外部端口关闭（App 内嵌模式）时
// 界面照常工作。
package main

import (
	"embed"
	"log"
	"net/http"
	"net/url"
	"os"
	"runtime"
	"strings"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
	"github.com/wailsapp/wails/v3/pkg/icons"
)

// version 经 -ldflags -X main.version 注入（与 CLI 二进制同源）。
var version = "dev"

//go:embed all:frontend/dist
var assets embed.FS

var (
	app     *application.App
	engine  *EngineService
	uiShown bool
)

// showUI 懒创建/唤起管理窗口（关窗即隐，App 常驻）。
// 注意：窗口方法（Show/Restore/Focus）内部派发到主线程，可从任意回调调；
// app.Show()（NSApp 激活）非线程安全——曾致第二实例回调 SIGTRAP，禁用。
func showUI() {
	if w, ok := app.Window.GetByName("admin"); ok {
		w.Restore()
		w.Focus()
		return
	}
	uiShown = true
	w := app.Window.NewWithOptions(application.WebviewWindowOptions{
		Name:             "admin",
		Title:            "Agent Browser Proxy",
		Width:            1080,
		Height:           760,
		MinWidth:         720,
		MinHeight:        480,
		BackgroundColour: application.NewRGB(18, 18, 24),
		URL:              "/",
	})
	w.RegisterHook(events.Common.WindowClosing, func(e *application.WindowEvent) {
		// 关窗不退出 App（菜单栏常驻）；仅记隐藏态
		uiShown = false
	})
	w.Show()
	w.Focus()

	// UI 自检（测试通道）：ABP_UI_DUMP 指向目录时开窗后回传 DOM + 绑定探活
	//（结构证据替代截图读图；只在新建窗口路径触发，Restore 路径不重复）。
	if dir := os.Getenv("ABP_UI_DUMP"); dir != "" && dir != "done" {
		_ = dir
		go func() {
			time.Sleep(2 * time.Second)
			if win, ok := app.Window.GetByName("admin"); ok && win != nil {
				win.ExecJS(`(async () => {
				  const probe = {};
				  for (const u of ['/static/app.js?v=0.2.6', '/static/app.js', '/static/vendor/alpine.min.js']) {
				    try { const r = await fetch(u); probe[u] = r.status + ':' + (await r.text()).length } catch (e) { probe[u] = 'ERR:' + String(e) }
				  }
				  try {
				    const r = await window.__cdpWails.doRequest('GET', '/health', '');
				    window.__cdpWails.dumpDOM(JSON.stringify({health: r && r.body, errors: window.__abpErrors, probe, dom: document.documentElement.outerHTML}))
				  } catch (e) {
				    window.__cdpWails.dumpDOM(JSON.stringify({error: String(e), errors: window.__abpErrors, probe, dom: document.documentElement.outerHTML}))
				  }
				})()`)
			}
		}()
	}
}

// buildTray 托盘：模板图标 + 状态/控制菜单。
func buildTray() *application.SystemTray {
	tray := app.SystemTray.New()
	if runtime.GOOS == "darwin" {
		tray.SetTemplateIcon(icons.SystrayMacTemplate)
	}
	tray.SetTooltip("Agent Browser Proxy")
	menu := app.NewMenu()
	menu.Add("打开管理界面").OnClick(func(*application.Context) { showUI() })
	statusItem := menu.Add("引擎：启动中…")
	statusItem.SetEnabled(false)
	engine.onStateChange = func(running bool) {
		label := "引擎：运行中 ✓"
		if !running {
			label = "引擎：已停止"
		}
		statusItem.SetLabel(label)
		tray.SetTooltip("Agent Browser Proxy — " + label)
	}
	menu.AddSeparator()
	menu.Add("重启引擎").OnClick(func(*application.Context) {
		if err := engine.RestartEngine(); err != nil {
			log.Printf("重启引擎失败: %v", err)
		}
	})
	menu.Add("安装内嵌 agent-browser 到 PATH").OnClick(func(*application.Context) {
		res, err := engine.AgentBrowserInstall()
		if err != nil {
			log.Printf("安装 agent-browser 失败: %v", err)
			return
		}
		log.Printf("agent-browser 已安装: %v", res)
	})
	menu.AddSeparator()
	menu.Add("退出").OnClick(func(*application.Context) { app.Quit() })
	tray.SetMenu(menu)
	tray.OnClick(func() { showUI() })
	return tray
}

func main() {
	engine = NewEngineService("", nil)

	app = application.New(application.Options{
		Name:        "Agent Browser Proxy",
		Description: "Chrome CDP 隔离代理（多会话 WS 路由）— 桌面宿主",
		Services: []application.Service{
			application.NewService(engine),
		},
		Assets: application.AssetOptions{
			Handler: application.AssetFileServerFS(assets),
			// 剥离静态资源查询串：admin 页 app.js 带 ?v= 缓存参数，而嵌入
			// FS 按字面路径查文件（?v=0.2.6 → 404 → app.js 不加载，Alpine
			// 组件缺失整页空白——已实测踩坑）。/bindings 走 RPC，不剥。
			Middleware: func(next http.Handler) http.Handler {
				return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					if r.URL.RawQuery != "" && !strings.HasPrefix(r.URL.Path, "/bindings") {
						r2 := *r
						r2.URL = new(url.URL)
						*r2.URL = *r.URL
						r2.URL.RawQuery = ""
						next.ServeHTTP(w, &r2)
						return
					}
					next.ServeHTTP(w, r)
				})
			},
		},
		Mac: application.MacOptions{
			ActivationPolicy: application.ActivationPolicyAccessory,
			// 菜单栏 App：关全部窗口不退出（托盘常驻）
			ApplicationShouldTerminateAfterLastWindowClosed: false,
		},
		Windows: application.WindowsOptions{
			DisableQuitOnLastWindowClosed: true,
		},
		SingleInstance: &application.SingleInstanceOptions{
			UniqueID: "com.yangyaofei.cdproxy.desktop",
			OnSecondInstanceLaunch: func(_ application.SecondInstanceData) {
				showUI()
			},
		},
	})

	buildTray()

	// UI 自检模式（测试通道）：ABP_UI_DUMP 设置时启动即开窗并自 dump——
	// 不依赖二次实例时序（SingleInstance 注册与第二实例启动有竞态，
	// 实测会各自成完整 App 抢端口，dump 反而不触发）。
	if os.Getenv("ABP_UI_DUMP") != "" {
		go func() {
			time.Sleep(3 * time.Second)
			showUI()
		}()
	}

	if err := app.Run(); err != nil {
		log.Fatal(err)
	}
}
