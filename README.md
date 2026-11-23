# cdproxy

[English](README.md) | [中文](README.zh.md)

**A desktop Chrome DevTools Protocol (CDP) proxy app for AI agents and browser automation tools.**

When AI assistants or automation scripts browse the web for you, they typically connect to Chrome over CDP (Chrome's built-in remote control protocol). Connecting directly to Chrome causes immediate everyday friction: Chrome keeps popping to the foreground and stealing your focus, concurrent tasks interfere with or close each other's tabs, and connecting to your everyday logged-in Chrome runs into debugging restrictions and repetitive confirmation prompts.

`cdproxy` sits quietly between your tools and Chrome as a desktop proxy app for **macOS** and **Windows** — everything is controlled through a clean UI with built-in **English / 中文** switching and **Dark / Light** themes.

<p align="center">
  <img src="docs/assets/overview-dark-en.png" alt="cdproxy Desktop App Overview (Dark)" width="960" />
</p>

## What It Proxies & Why Not Connect Directly?

`cdproxy` proxies **two kinds of Chrome browsers** side by side — use either one or keep both ready at once:

1. **Your everyday logged-in Chrome (via the bundled `Cdproxy Connector` extension)**  
   Turns the Chrome window you are already using — with all your existing logins — into a clean CDP endpoint, without restarting Chrome or tinkering with startup flags.
2. **A separate, dedicated Chrome managed by the app**  
   Launches a normal Chrome instance completely isolated from your personal browser so multiple tasks can share it cleanly, and automatically shuts it down when idle to save memory.

Putting `cdproxy` in the middle solves three things direct CDP connections cannot:

| Problem when connecting directly | How `cdproxy` handles it |
|---|---|
| Opening pages or switching tabs keeps bringing Chrome to the front and interrupting your work | **Silent background mode by default**: built-in rewrite rules (editable in the app) force new tabs into the background and neutralize focus-stealing commands |
| One script finishing calls "close browser" and wipes out your entire Chrome window | **Browser close protection**: intercepts full-browser close requests so each task only closes its own pages while Chrome stays alive |
| Recent Chrome versions block remote debugging on everyday profiles, or nag with repetitive connection prompts | **Direct connection to your daily Chrome**: install `Cdproxy Connector` once to reuse your logged-in browser without repetitive prompts |
| Multiple AI tools sharing one browser see, click, or close each other's tabs — or touch your personal tabs | **Per-session isolation & Tab Groups**: every session can only see and touch its own tabs, and leftover tabs are automatically cleaned up after disconnect |

## Sharing Your Everyday Chrome with Native Tab Groups

When multiple AI sessions share your everyday Chrome, `cdproxy` and `Cdproxy Connector` use **Chrome's native color-coded Tab Groups** to draw a clear visual boundary — **each session gets its own colored group** (default prefix `cdproxy:`, such as `cdproxy: research` or `cdproxy: docs`, customizable in the app or extension popup).

<p align="center">
  <img src="docs/assets/tab-groups-en.png" alt="Chrome Native Tab Groups as Visual Isolation Boundaries" width="960" />
</p>

The Tab Groups you see in Chrome are the live permission boundary — no commands needed:

| Action in Chrome | Live effect |
|---|---|
| **Tabs outside any group** (your personal tabs, email, docs) | Completely hidden from all AI sessions by default |
| **Drag a tab into** a `cdproxy: <session>` group | Immediately grants that AI session access to the page |
| **Drag a tab out of** a group | Immediately revokes the AI's access while keeping the page open for you |
| **Drag a tab between** two session groups | Cleanly hands the page over from one AI session to the other |
| **Collapse / expand** a group | Purely visual — the AI keeps working normally in the background |

Click the `cdproxy` icon in Chrome's toolbar anytime to open its status & settings popup — inspect live connection status, customize the group prefix, or pick what happens when a session ends:
- **Close** *(default)* — close the session's tabs and remove the group;
- **Mark** — grey-mark the group as `· released` and keep the tabs open (if the same session returns later, it automatically reclaims the whole group);
- **Keep** — detach the session and leave the group and tabs untouched.

## Live Demos

### Desktop App Walkthrough

Inspect both browser sources, active sessions, step-by-step action traces, background focus rules, and direct connection URLs — with live **中 / EN** language and **Dark / Light** theme switching:

<p align="center">
  <img src="docs/assets/walkthrough-en.gif" alt="cdproxy Desktop App Walkthrough" width="900" />
</p>

### Multi-Session Isolation in Action

Multiple AI sessions run concurrently through `cdproxy`, operating quietly in the background inside their own isolated boundaries and cleaning up only their own tabs when finished:

<p align="center">
  <img src="docs/assets/session-lifecycle-en.gif" alt="Multi-Session Isolation Lifecycle" width="900" />
</p>

<details>
<summary>More screenshots (Sessions &amp; Action Trace · Light Theme Sources &amp; Endpoints)</summary>

<p align="center">
  <img src="docs/assets/sessions-dark-en.png" alt="Sessions and Per-Session Action Trace" width="900" />
</p>

<p align="center">
  <img src="docs/assets/sources-light-en.png" alt="Browser Modes, Routing Rules, and Direct Endpoints (Light)" width="900" />
</p>

</details>

## Installation

### macOS (Single-Command Homebrew Install — Recommended)

Run one command — Homebrew automatically adds the tap and installs the app in a single step:

```bash
brew install --cask yangyaofei/tap/cdproxy
```

> **macOS first-launch note**: `cdproxy.app` is signed with a stable self-signed certificate (not Apple-notarized). If Gatekeeper warns on first launch, allow it in *System Settings → Privacy & Security → Open Anyway* or run:
> ```bash
> xattr -dr com.apple.quarantine "/Applications/cdproxy.app"
> ```
> You only need to do this once. Future upgrades via the app's built-in **Update** button are signature-verified and carry no quarantine prompt.

### Direct Download (macOS & Windows)

Download the prebuilt package from [GitHub Releases](https://github.com/yangyaofei/cdproxy/releases):
- **macOS (Apple Silicon)**: `cdproxy_<version>_darwin_arm64.zip` (unzip and drag into `/Applications`)
- **Windows (64-bit)**: `cdproxy_<version>_windows_amd64.zip` (unzip and launch; supports in-app updates as well)

## Quickstart in 3 Steps

### 1. Launch `cdproxy`

Open the app and the proxy is ready immediately. Closing the window leaves it running quietly in your menu bar / system tray — click the tray icon anytime to reopen the window, restart the managed browser, or quit.

### 2. Choose Your Browser Mode

Both modes can stay enabled side by side, and you can switch the default mode anytime from **Overview** or **Sources & Endpoints**:

- **Option A — Dedicated browser (zero setup)**  
  Ready out of the box. The first time a tool connects, `cdproxy` launches an isolated Chrome automatically and shuts it down after idle time to save memory.
- **Option B — Bridge your everyday Chrome (one-time drag-and-drop install, zero manual typing)**
  1. On launch, `cdproxy` detects your local Chrome extension status automatically and prepares `~/.cdproxy/extension/cdp-ext` pre-configured with your current port and token. Follow the steps right under **Overview → Set up** or **Sources & Endpoints → extension**.
  2. Click **Copy URL & Open Chrome**, paste `chrome://extensions` into Chrome's address bar, and turn on **Developer mode** (top-right).
  3. Click **Open Extension Folder** and drag `cdp-ext` directly onto Chrome's Extensions page — it auto-connects within ~1s. Click the `cdproxy` toolbar icon anytime to inspect status or paste a one-click pairing URL.

### 3. Copy the Connection URL into Your Tool

In **Overview** or **Sources & Endpoints**, click **Copy URL** (or **Header**) to grab a standard CDP address and paste it into any AI agent or automation tool (works with both `http://` and `ws://`, and with either URL tokens or `Authorization: Bearer` headers):

- **Default entry** (`http://127.0.0.1:9225/<token>`): follows the active default browser mode in the app — switch modes anytime without editing client configs;
- **Direct source** (`/standalone/<token>` or `/extension/<token>`): explicitly targets either the dedicated Chrome or your everyday Chrome;
- **Automatic per-connection isolation**: multiple AI windows or scripts sharing the same URL each get their own isolated session and Tab Group; append `/session/<name>` whenever you want to claim or resume a specific group.

For example, in Playwright:

```js
import { chromium } from "playwright-core";

// URL token (follows the default browser mode selected in the app)
const browser = await chromium.connectOverCDP("http://127.0.0.1:9225/<token-copied-from-app>");
const page = await browser.newPage();
await page.goto("https://example.com");
```

Or pass the token via `Authorization: Bearer` against the root CDP URL — `cdproxy` automatically routes to the browser source or pinned session bound to that token:

```js
const browser = await puppeteer.connect({
  browserURL: "http://127.0.0.1:9225",
  headers: { Authorization: "Bearer <token-copied-from-app>" },
});
```

## What You Can Configure in the App

Every common setting is editable directly from the sidebar and takes effect immediately without restarting:

- **Overview**: Check the live status of both browser modes, switch the default mode, restart the dedicated Chrome, or copy connection URLs in one click.
- **Sessions**: See every active AI session, the tabs it owns, and its step-by-step action log; release any session with one click.
- **Rewrite Rules**: Inspect or customize background / anti-interruption rules (background tab creation, focus-steal suppression, and browser-close protection are enabled by default).
- **Sources & Endpoints**: Manage both browser modes, set session-name prefix routing (for example, `ext-` sessions automatically go to your everyday Chrome), detect/back up/wire `agent-browser` global config in one click, and copy or reset access tokens.
- **Settings**: Adjust listening ports, idle cleanup timeouts (60s after disconnect, 10m idle shutdown for the dedicated browser), and data directory.

## `Cdproxy Connector` Extension Permissions

When bridging your everyday Chrome, `Cdproxy Connector` talks exclusively to your local `cdproxy` instance and sends nothing off-machine. Each requested Chrome permission maps directly to specific capabilities:

| Chrome Permission | Capabilities Enabled | Behavior Without This Permission |
|---|---|---|
| `debugger` *(core)* | Forwards page-level CDP commands & events via `chrome.debugger` (DOM, JS, network, screenshots, OOPIF, Web Workers, download events, and cookies when a tab is open) | Extension cannot control pages |
| `tabs`, `tabGroups` *(core)* | Per-session tab lifecycle, Tab Group isolation boundaries, window bounds read/write, and auto-adoption of `target="_blank"` tabs & popups | No Tab Group isolation boundary or derived popup ownership |
| `storage`, `alarms` *(core)* | Persists connection config and virtual session tables across MV3 Service Worker restarts, with periodic keep-alive & reconnect | Active sessions drop whenever Chrome suspends the Service Worker |
| `downloads` | Full Playwright/CDP download pipeline: `download.path()`, `download.saveAs()` (copies the finished file into the session's download directory without deleting the original), `download.cancel()`, and `behavior: 'deny'` | Download start/progress events still fire, but disk path lookup (`path()`/`saveAs()`) and `cancel()`/`deny` are unavailable |
| `contentSettings` | Site permissions via `context.grantPermissions()`, `Browser.setPermission`, and `clearPermissions()` (geolocation, notifications, camera, microphone, automatic downloads, popups, etc.); `clearPermissions()` clears only this extension's own layer and never touches your manual Chrome site settings | Calls to grant or modify site permissions return an error |
| `cookies` + `<all_urls>` | Zero-tab fallback for `context.cookies()`, `addCookies()`, and `clearCookies()` when a session has no open tabs | Cookie commands still work via `debugger` whenever the session has at least one open tab; only 0-tab calls fail |

> **Chrome MV3 Platform Boundaries** (Chrome extension architecture limits, not missing permissions):
> - **Isolated browser contexts (`createBrowserContext`)**, **ignoring self-signed certificates (`Security.setIgnoreCertificateErrors`)**, and permission types not exposed by `chrome.contentSettings` (such as `clipboard`, `midi`, `sensors`) are rejected honestly by the extension — switch to the built-in **`standalone` dedicated Chrome** source when you need them.
> - **Single debugger per tab**: opening DevTools on a controlled tab or clicking *Cancel* on Chrome's debugging banner puts the session into silent soft-hibernation; the next CDP command lazily re-attaches automatically.

---

<details>
<summary>Developer &amp; Advanced Reference (Dynamic Session API, Ports, Build from Source)</summary>

### Architecture Overview

```
AI Agent / Playwright / Puppeteer / Any CDP Client
      │  Direct endpoint ws://127.0.0.1:9225/<path>/<token>  OR  dynamic HTTP session allocation
      ▼
cdproxy Desktop App (embedded Go engine + UI)
  ├─ Control plane  HTTP 127.0.0.1:9224   session alloc/release, live settings, version checks
  ├─ CDP proxy      WS   127.0.0.1:9225   session isolation, command rewrites, event filtering
  │    ├─ standalone ──► managed Chrome @127.0.0.1:9222 (on-demand launch + idle shutdown)
  │    └─ extension  ◄── reverse WS /ext ── cdp-ext (MV3) ──► Chrome native Tab Groups
  └─ Action trace                         per-session CDP interaction log (memory + disk)
```

### Dynamic Named Sessions via HTTP API

To spin up named, isolated sessions programmatically (each gets its own `cdproxy: <name>` Tab Group in everyday Chrome), copy the allocation token from **Sources & Endpoints**:

```bash
# Allocate a named session (returns its dedicated WebSocket URL)
curl -X POST http://127.0.0.1:9224/sessions \
  -H "Authorization: Bearer <alloc_token>" \
  -H "Content-Type: application/json" \
  -d '{"name": "research"}'

# Release when done (or let the disconnect timer clean it up automatically)
curl -X POST http://127.0.0.1:9224/sessions/research/release
```

### Default Ports & Data Directory

- Default data directory: `~/.cdproxy/` (holds `settings.json`, `extension/cdp-ext/`, `browser-profile/`, `logs/`, and `runtime/` — inspect & open any path under **Settings → Data Directory**).
- Default ports: control plane `127.0.0.1:9224`, CDP WebSocket `127.0.0.1:9225`, dedicated Chrome `127.0.0.1:9222` (rebound live in-process without dropping active sessions).

### Build & Test from Source

```bash
# Run Go unit tests and Admin UI single-source check
go vet ./cmd/... ./internal/... ./desktop
go test -count=1 ./cmd/... ./internal/...
python3 scripts/sync_admin_frontend.py --check

# Package macOS Desktop App (requires Wails v3 CLI)
cd desktop && PATH="$HOME/go/bin:$PATH" wails3 task package:embedded VERSION=0.10.0
```

Further contributor and release references:
- [AGENTS.md](AGENTS.md) — module map, development & test commands, engineering rules
- [docs/CI-CD.md](docs/CI-CD.md) — signing certificates, release pipelines, Homebrew & in-app updater ops

</details>

## License

[MIT](LICENSE) © 2026 yangyaofei
