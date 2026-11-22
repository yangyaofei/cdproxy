// cdproxy 桌面 App（Wails v3）。
//
// 形态：常规桌面应用（ActivationPolicyRegular，Dock 图标 + 系统菜单栏 +
// 常驻托盘菜单）+ 懒创建的管理窗口（macOS HiddenInset 透明标题栏）。
// 引擎（internal/core）编译进主进程随 App 启停；管理界面经 EngineService
// .DoRequest 进程内执行 control 路由——外部端口关闭（App 内嵌模式）时
// 界面照常工作。
package main

import (
	"embed"
	_ "embed"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
	"github.com/wailsapp/wails/v3/pkg/updater"
	"github.com/wailsapp/wails/v3/pkg/updater/providers/endpoint"
	"github.com/yangyaofei/cdproxy/internal/httputil"
	"github.com/yangyaofei/cdproxy/internal/plugin"
)

// version 经 -ldflags -X main.version 注入（与 CLI 二进制同源）。
var version = "dev"

// updater 公钥（信任根，编译期钉进二进制）：与 denpa-jack 共用同一把
// Ed25519 密钥材料（minisign 封装转 PKCS#8）。密钥材料不入库——本地经
// certs/updater.key.pub、CI 经 UPDATER_PUBLIC_KEY Secret 在构建期就位
//（Taskfile ensure:updater-pub）。
//
//go:embed build/updater.key.pub
var updaterPubKey []byte

//go:embed all:frontend/dist
var assets embed.FS

//go:embed tray_mac.png
var trayMacPNG []byte

//go:embed tray_win.png
var trayWinPNG []byte

var (
	app            *application.App
	engine         *EngineService
	uiShown        bool
	updaterInitErr string
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
		Title:            "cdproxy",
		Width:            1260,
		Height:           820,
		MinWidth:         780,
		MinHeight:        560,
		InitialPosition:  application.WindowCentered,
		Frameless:        runtime.GOOS == "windows",
		BackgroundColour: application.NewRGB(17, 17, 19),
		URL:              "/",
		Mac: application.MacWindow{
			TitleBar: application.MacTitleBarHiddenInset,
		},
		Windows: application.WindowsWindow{
			Theme: application.Dark,
		},
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

// initUpdater 自动更新接线：endpoint provider（GitHub Releases 静态
// manifest.json）+ 拆分阶段超时/退避重试 HTTP 客户端 + 6h 静默检查 + 托盘触发。
// 检查/下载进度经事件总线通知（wails:updater:*），UpdateReady 后亮「重启并更新」。
func initUpdater() error {
	dlClient := httputil.NewDownloadClient(httputil.DownloadClientOptions{
		UserAgent: "cdproxy/" + version,
	})
	ep, err := endpoint.New(endpoint.Config{
		URL:        "https://github.com/yangyaofei/cdproxy/releases/latest/download/manifest.json",
		HTTPClient: dlClient,
	})
	if err != nil {
		return fmt.Errorf("endpoint provider: %w", err)
	}
	if err := app.Updater.Init(updater.Config{
		CurrentVersion: version,
		Providers:      []updater.Provider{ep},
		PublicKey:      updaterPubKey,
		CheckInterval:  6 * time.Hour,
		Window:         updater.WindowNone,
	}); err != nil {
		return fmt.Errorf("updater init: %w", err)
	}
	return nil
}

// checkForUpdate 托盘「检查更新」动作：复用 EngineService.CheckForUpdate 统一
// 执行检查+下载+验签闭环（WindowNone 下不弹框架窗，结果经事件总线回托盘与界面）。
func checkForUpdate() {
	go func() {
		if err := engine.CheckForUpdate(); err != nil {
			log.Printf("检查或下载更新失败: %v", err)
		}
	}()
}

type trayStrings struct {
	open           string
	statusStarting string
	statusRunning  string
	statusStopped  string
	restartEngine  string
	checkUpdate    string
	restartUpdate  string
	quit           string
}

func getTrayStrings(lang string) trayStrings {
	if strings.HasPrefix(strings.ToLower(strings.TrimSpace(lang)), "zh") {
		return trayStrings{
			open:           "打开管理界面",
			statusStarting: "引擎：启动中…",
			statusRunning:  "引擎：运行中 ✓",
			statusStopped:  "引擎：已停止",
			restartEngine:  "重启引擎",
			checkUpdate:    "检查更新…",
			restartUpdate:  "重启并更新",
			quit:           "退出",
		}
	}
	return trayStrings{
		open:           "Open Dashboard",
		statusStarting: "Engine: Starting…",
		statusRunning:  "Engine: Running ✓",
		statusStopped:  "Engine: Stopped",
		restartEngine:  "Restart Engine",
		checkUpdate:    "Check for Updates…",
		restartUpdate:  "Restart & Update",
		quit:           "Quit",
	}
}

// detectSystemLang 启动期推断系统语言（前端 WebView 加载后会按用户
// localStorage / navigator.language 调 SetLanguage 精确覆写托盘文案）。
func detectSystemLang() string {
	for _, key := range []string{"LC_ALL", "LC_MESSAGES", "LANG"} {
		if v := strings.TrimSpace(os.Getenv(key)); v != "" {
			if strings.HasPrefix(strings.ToLower(v), "zh") {
				return "zh"
			}
			return "en"
		}
	}
	if runtime.GOOS == "darwin" {
		if out, err := exec.Command("defaults", "read", "-g", "AppleLocale").Output(); err == nil {
			if strings.HasPrefix(strings.ToLower(strings.TrimSpace(string(out))), "zh") {
				return "zh"
			}
		}
	}
	return "en"
}

func buildTray() *application.SystemTray {
	tray := app.SystemTray.New()
	if runtime.GOOS == "darwin" {
		tray.SetTemplateIcon(trayMacPNG)
	} else {
		tray.SetIcon(trayWinPNG)
	}
	tray.SetTooltip("cdproxy")

	var mu sync.Mutex
	curLang := detectSystemLang()
	curState := "starting"
	s := getTrayStrings(curLang)

	menu := app.NewMenu()
	openItem := menu.Add(s.open)
	openItem.OnClick(func(*application.Context) { showUI() })
	statusItem := menu.Add(s.statusStarting)
	statusItem.SetEnabled(false)
	menu.AddSeparator()
	restartItem := menu.Add(s.restartEngine)
	restartItem.OnClick(func(*application.Context) {
		if err := engine.RestartEngine(); err != nil {
			log.Printf("重启引擎失败: %v", err)
		}
	})
	menu.AddSeparator()
	checkUpdateItem := menu.Add(s.checkUpdate)
	checkUpdateItem.OnClick(func(*application.Context) { checkForUpdate() })
	restartUpdateItem := menu.Add(s.restartUpdate)
	restartUpdateItem.SetHidden(true)
	restartUpdateItem.OnClick(func(*application.Context) { engine.RestartForUpdate() })
	app.Event.On(updater.EventUpdateReady, func(_ *application.CustomEvent) {
		restartUpdateItem.SetHidden(false)
		menu.Update()
	})
	menu.AddSeparator()
	quitItem := menu.Add(s.quit)
	quitItem.OnClick(func(*application.Context) { app.Quit() })

	applyLabels := func() {
		mu.Lock()
		tr := getTrayStrings(curLang)
		st := curState
		mu.Unlock()
		statusLabel := tr.statusStarting
		if st == "running" {
			statusLabel = tr.statusRunning
		} else if st == "stopped" {
			statusLabel = tr.statusStopped
		}
		openItem.SetLabel(tr.open)
		statusItem.SetLabel(statusLabel)
		restartItem.SetLabel(tr.restartEngine)
		checkUpdateItem.SetLabel(tr.checkUpdate)
		restartUpdateItem.SetLabel(tr.restartUpdate)
		quitItem.SetLabel(tr.quit)
		tray.SetTooltip("cdproxy — " + statusLabel)
		menu.Update()
	}

	engine.onStateChange = func(running bool) {
		mu.Lock()
		if running {
			curState = "running"
		} else {
			curState = "stopped"
		}
		mu.Unlock()
		applyLabels()
		// 引擎启停对 UI 是最重的状态变化。运行→随行完整状态；停止→专用
		// 离线信号（复用 engine.emitState/emitOffline，保持单一出口）
		if running {
			go engine.emitState()
		} else {
			go engine.EmitEngineOffline()
		}
	}

	engine.onLangChange = func(lang string) {
		mu.Lock()
		curLang = lang
		mu.Unlock()
		applyLabels()
	}

	tray.SetMenu(menu)
	tray.OnClick(func() { showUI() })
	return tray
}

func main() {
	if len(os.Args) > 1 && os.Args[1] == "--version" {
		fmt.Println(version)
		return
	}
	if len(os.Args) > 1 && os.Args[1] == "plugin" {
		os.Exit(plugin.Run(plugin.Options{DesktopApp: true}))
	}
	engine = NewEngineService("", nil)

	app = application.New(application.Options{
		Name:        "cdproxy",
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
			// 常规桌面应用形态：Dock 图标 + 系统菜单栏（cdproxy/文件/编辑/
			// 显示/窗口/帮助——Wails DefaultApplicationMenu）+ 启动即主窗口；
			// 托盘图标保留作状态快捷入口。关全部窗口不退出（服务常驻）。
			ActivationPolicy: application.ActivationPolicyRegular,
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

	// 自动更新：官方 pkg/updater（v3.1.0 内建）。endpoint provider 读
	// GitHub Releases 静态 manifest.json（Ed25519ph 签名，公钥编译期钉死）；
	// 菜单栏形态不弹框架窗口（WindowNone），检查结果走托盘菜单+事件。
	if err := initUpdater(); err != nil {
		updaterInitErr = err.Error()
		log.Printf("updater 初始化失败（更新功能停用）: %v", err)
	}

	buildTray()

	if runtime.GOOS == "darwin" {
		// 关窗后点击 Dock 图标重新唤起管理窗口（WindowClosing 销毁实例后兜底）。
		app.Event.OnApplicationEvent(events.Mac.ApplicationShouldHandleReopen, func(e *application.ApplicationEvent) {
			if !e.Context().HasVisibleWindows() {
				showUI()
			}
		})
	}

	// 常规应用形态：启动即显示主窗口（ABP_UI_DUMP 测试通道的自 dump 在
	// showUI 新建窗口路径里触发，不依赖二次实例时序）。
	showUI()

	if err := app.Run(); err != nil {
		log.Fatal(err)
	}
}
