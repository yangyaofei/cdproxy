// agent-browser-proxy 桌面 App（Wails v3）。
//
// 形态：菜单栏常驻（ActivationPolicyAccessory，无 Dock 图标）+ 托盘菜单
// （状态/打开管理界面/重启引擎/退出）+ 懒创建的管理窗口。引擎
//（internal/core）编译进主进程随 App 启停；管理界面经 EngineService
// .DoRequest 进程内执行 control 路由——外部端口关闭（App 内嵌模式）时
// 界面照常工作。
package main

import (
	"embed"
	"log"
	"runtime"

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
			UniqueID: "com.yangyaofei.agent-browser-proxy.desktop",
			OnSecondInstanceLaunch: func(_ application.SecondInstanceData) {
				showUI()
			},
		},
	})

	buildTray()

	if err := app.Run(); err != nil {
		log.Fatal(err)
	}
}
