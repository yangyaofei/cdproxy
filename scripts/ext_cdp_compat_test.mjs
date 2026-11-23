#!/usr/bin/env node
// ext_cdp_compat_test.mjs — cdp-ext + proxy 完整 CDP 协议兼容回归套件（19 项）：
//   1-3)  同源/跨源/domcontentloaded 下 page.goBack & goForward（BFCache 往返缓存恢复）
//   4-6)  <a target="_blank"> / window.open('_blank') / 独立 popup 窗口（context page + page popup 事件与 openerId）
//   7-9)  context.cookies / addCookies / clearCookies（已附着 tab 原生 Storage.*Cookies）
//   10)   跨源 OOPIF <iframe> 子会话附着与定位
//   11)   Web Worker 子会话执行（验证子会话不因 waitForDebuggerOnStart 挂死）
//   12)   page.setViewportSize
//   13)   page.route Fetch 拦截（跨源 iframe 之后仍无僵尸子 sessionId 报错）
//   14)   Browser.getVersion / getWindowForTarget / getWindowBounds / setWindowBounds（真实 Chrome 版本号）
//   15)   文件下载全链路：page.waitForEvent('download') + suggestedFilename + path() + saveAs() 字节核验
//   16)   慢速下载取消：download.cancel() + download.failure()
//   17)   站点权限授予与重置：context.grantPermissions(['geolocation', 'notifications']) + clearPermissions()
//   18)   不支持权限诚实报错：context.grantPermissions(['clipboard-read']) 显式拒绝（不假成功）
//   19)   0-tab Cookie 回落：关掉会话全部页面后 context.addCookies / cookies 经 chrome.cookies 仍可用
//
// 前置：extension 模式测试服务运行中（EXT_CONTROL，默认 http://127.0.0.1:9234）+ cdp-ext 已回连。
// 依赖：playwright-core（优先全局解析，回落 var/pwtest/node_modules/playwright-core）。
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require("playwright-core"));
} catch {
  ({ chromium } = require("../var/pwtest/node_modules/playwright-core"));
}

const CONTROL = process.env.EXT_CONTROL || "http://127.0.0.1:9234";
const ALLOC_TOKEN = process.env.ALLOC_TOKEN || "";

const authHeaders = ALLOC_TOKEN ? { Authorization: `Bearer ${ALLOC_TOKEN}` } : {};
let tok = ALLOC_TOKEN;
if (!tok) {
  const st = await fetch(`${CONTROL}/status`).then((r) => r.json()).catch(() => ({}));
  tok = st?.sources?.alloc_token || "";
}

const DOWNLOAD_PAYLOAD = `cdproxy-download-e2e-payload-${Date.now()}\nline2-ok\n`;
const slowStreams = new Set();

const srv1 = http.createServer((req, res) => {
  if (req.url === "/a") {
    res.writeHead(200, { "Content-Type": "text/html", "Set-Cookie": "siteA=hello123; Path=/" });
    res.end(
      `<title>Page A</title>` +
      `<a id="goB" href="/b">go B</a>` +
      `<a id="blank" href="/popup" target="_blank">open blank</a>` +
      `<button id="winopen" onclick="window.open('/popup','_blank')">winopen</button>` +
      `<button id="popwin" onclick="window.open('/popup','pop','width=420,height=320')">popwin</button>` +
      `<a id="dl" href="/download">download file</a>` +
      `<a id="dlSlow" href="/download-slow">download slow</a>`,
    );
    return;
  }
  if (req.url === "/download") {
    res.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": 'attachment; filename="compat-sample.txt"',
      "Content-Length": Buffer.byteLength(DOWNLOAD_PAYLOAD),
    });
    res.end(DOWNLOAD_PAYLOAD);
    return;
  }
  if (req.url === "/download-slow") {
    res.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": 'attachment; filename="compat-slow.bin"',
      "Content-Length": 10 * 1024 * 1024,
    });
    res.write(Buffer.alloc(4096, 65));
    const timer = setInterval(() => {
      if (!res.writableEnded) res.write(Buffer.alloc(1024, 66));
    }, 500);
    const stop = () => {
      clearInterval(timer);
      slowStreams.delete(stop);
      if (!res.writableEnded) res.end();
    };
    slowStreams.add(stop);
    req.on("close", stop);
    res.on("close", stop);
    return;
  }
  if (req.url === "/b") {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end("<title>Page B</title><h1>B</h1>");
    return;
  }
  if (req.url === "/popup") {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end("<title>Popup Page</title><h1>Popup OK</h1>");
    return;
  }
  if (req.url === "/iframe-host") {
    const port2 = srv2.address().port;
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`<title>Iframe Host</title><iframe id="f" src="http://localhost:${port2}/frame"></iframe>`);
    return;
  }
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end("<title>Root</title>");
});
const srv2 = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/html", "Set-Cookie": "siteB=world456; Path=/" });
  res.end('<title>Cross Origin</title><h2 id="cf">cross-origin frame</h2>');
});
await new Promise((r) => srv1.listen(0, "127.0.0.1", r));
await new Promise((r) => srv2.listen(0, "127.0.0.1", r));
const P1 = srv1.address().port;
const P2 = srv2.address().port;

const sessionName = `cdp-compat-${Date.now().toString(36)}`;
const alloc = await fetch(`${CONTROL}/sessions`, {
  method: "POST",
  headers: { "Content-Type": "application/json", ...(tok ? { Authorization: `Bearer ${tok}` } : authHeaders) },
  body: JSON.stringify({ name: sessionName, source: "extension" }),
}).then((r) => r.json());
if (!alloc.cdpUrl) {
  console.error("alloc failed:", alloc);
  srv1.close();
  srv2.close();
  process.exit(1);
}

const results = [];
const run = async (name, fn) => {
  const t0 = Date.now();
  try {
    const detail = await fn();
    results.push({ name, ok: true });
    console.log(`✓ ${name} (${Date.now() - t0}ms)${detail ? " — " + detail : ""}`);
  } catch (err) {
    results.push({ name, ok: false });
    console.log(`✗ ${name} (${Date.now() - t0}ms) — ${err?.message || err}`);
  }
};

const dlSaveDir = path.join(repoRoot, "var", `compat-dl-${Date.now().toString(36)}`);
fs.mkdirSync(dlSaveDir, { recursive: true });

const browser = await chromium.connectOverCDP(alloc.cdpUrl);
try {
  const ctx = browser.contexts()[0];
  const page = ctx.pages()[0] || (await ctx.waitForEvent("page", { timeout: 5000 }));

  await run("1. 同源 goto /a -> /b -> goBack & goForward (BFCache)", async () => {
    await page.goto(`http://127.0.0.1:${P1}/a`);
    await page.goto(`http://127.0.0.1:${P1}/b`);
    await page.goBack({ timeout: 5000 });
    if (!page.url().endsWith("/a")) throw new Error("expected /a, got " + page.url());
    await page.goForward({ timeout: 5000 });
    if (!page.url().endsWith("/b")) throw new Error("expected /b, got " + page.url());
    return `back=/a forward=${page.url()}`;
  });

  await run("2. 跨源 goto localhost -> goBack (BFCache)", async () => {
    await page.goto(`http://127.0.0.1:${P1}/a`);
    await page.goto(`http://localhost:${P2}/c`);
    await page.goBack({ timeout: 5000 });
    if (!page.url().endsWith("/a")) throw new Error("expected /a, got " + page.url());
    return `url=${page.url()}`;
  });

  await run("3. goBack(waitUntil: 'domcontentloaded')", async () => {
    await page.goto(`http://127.0.0.1:${P1}/b`);
    await page.goBack({ timeout: 5000, waitUntil: "domcontentloaded" });
    if (!page.url().endsWith("/a")) throw new Error("expected /a, got " + page.url());
    return `url=${page.url()}`;
  });

  await run("4. 点击 <a target=_blank> -> context 'page' 事件与 pages() 增量", async () => {
    await page.goto(`http://127.0.0.1:${P1}/a`);
    const before = ctx.pages().length;
    const [p] = await Promise.all([
      ctx.waitForEvent("page", { timeout: 5000 }),
      page.click("#blank"),
    ]);
    await p.waitForLoadState("domcontentloaded", { timeout: 5000 });
    const afterOpen = ctx.pages().length;
    const title = await p.title();
    await p.close();
    if (afterOpen !== before + 1 || title !== "Popup Page") {
      throw new Error(`before=${before} afterOpen=${afterOpen} title=${title}`);
    }
    return `before=${before} afterOpen=${afterOpen} title=${title}`;
  });

  await run("5. window.open('_blank') -> page 'popup' 事件 (openerId)", async () => {
    await page.goto(`http://127.0.0.1:${P1}/a`);
    const [p] = await Promise.all([
      page.waitForEvent("popup", { timeout: 5000 }),
      page.click("#winopen"),
    ]);
    await p.waitForLoadState("domcontentloaded", { timeout: 5000 });
    const title = await p.title();
    await p.close();
    if (title !== "Popup Page") throw new Error("unexpected popup title: " + title);
    return `title=${title}`;
  });

  await run("6. window.open 独立 popup 窗口 -> page 'popup' 事件", async () => {
    await page.goto(`http://127.0.0.1:${P1}/a`);
    const [p] = await Promise.all([
      page.waitForEvent("popup", { timeout: 5000 }),
      page.click("#popwin"),
    ]);
    await p.waitForLoadState("domcontentloaded", { timeout: 5000 });
    const title = await p.title();
    await p.close();
    if (title !== "Popup Page") throw new Error("unexpected popup window title: " + title);
    return `title=${title}`;
  });

  await run("7. context.cookies() 读取站点 Cookie", async () => {
    const cs = await ctx.cookies(`http://127.0.0.1:${P1}`);
    const found = cs.find((c) => c.name === "siteA" && c.value === "hello123");
    if (!found) throw new Error("siteA cookie missing: " + JSON.stringify(cs));
    return `count=${cs.length} siteA=${found.value}`;
  });

  await run("8. context.addCookies() 写入并回读", async () => {
    await ctx.addCookies([{ name: "added_by_pw", value: "ok42", url: `http://127.0.0.1:${P1}` }]);
    const cs = await ctx.cookies(`http://127.0.0.1:${P1}`);
    const found = cs.find((c) => c.name === "added_by_pw" && c.value === "ok42");
    if (!found) throw new Error("added cookie missing");
    return `added_by_pw=${found.value}`;
  });

  await run("9. context.clearCookies() 清空并验证", async () => {
    await ctx.clearCookies();
    const cs = await ctx.cookies(`http://127.0.0.1:${P1}`);
    if (cs.length !== 0) throw new Error(`expected 0 cookies after clear, got ${cs.length}`);
    return "cleared=0";
  });

  await run("10. 跨源 OOPIF <iframe> 定位与文本读取", async () => {
    await page.goto(`http://127.0.0.1:${P1}/iframe-host`, { timeout: 8000 });
    const txt = await page.frameLocator("#f").locator("#cf").textContent({ timeout: 5000 });
    if (txt !== "cross-origin frame") throw new Error("unexpected iframe text: " + txt);
    return `text=${txt}`;
  });

  await run("11. Web Worker 子会话执行（不挂死）", async () => {
    await page.goto(`http://127.0.0.1:${P1}/a`);
    const val = await Promise.race([
      page.evaluate(() => new Promise((resolve, reject) => {
        const blob = new Blob(["self.onmessage = e => self.postMessage(e.data * 2);"], { type: "application/javascript" });
        const w = new Worker(URL.createObjectURL(blob));
        w.onmessage = (e) => { w.terminate(); resolve(e.data); };
        w.onerror = (e) => { w.terminate(); reject(new Error(e.message)); };
        w.postMessage(21);
      })),
      new Promise((_, rej) => setTimeout(() => rej(new Error("Web Worker timeout (5s)")), 5000)),
    ]);
    if (val !== 42) throw new Error("expected 42, got " + val);
    return `result=${val}`;
  });

  await run("12. page.setViewportSize", async () => {
    await page.setViewportSize({ width: 1024, height: 700 });
    const dims = await page.evaluate(() => [window.innerWidth, window.innerHeight]);
    if (dims[0] !== 1024 || dims[1] !== 700) throw new Error("unexpected dims: " + dims.join("x"));
    return `dims=${dims.join("x")}`;
  });

  await run("13. page.route Fetch 拦截", async () => {
    await page.route("**/mocked", (route) => route.fulfill({ status: 200, body: "mock-ok" }));
    const text = await page.evaluate(() => fetch("/mocked").then((r) => r.text()));
    await page.unroute("**/mocked");
    if (text !== "mock-ok") throw new Error("unexpected mocked body: " + text);
    return `body=${text}`;
  });

  await run("14. Browser.getVersion + getWindowForTarget / getWindowBounds / setWindowBounds", async () => {
    const cdp = await ctx.newCDPSession(page);
    const ver = await cdp.send("Browser.getVersion");
    if (!/^Chrome\/\d+/.test(ver.product || "")) throw new Error("unexpected product: " + ver.product);
    const wf = await cdp.send("Browser.getWindowForTarget");
    if (typeof wf.windowId !== "number" || !wf.bounds) throw new Error("bad getWindowForTarget: " + JSON.stringify(wf));
    const wb = await cdp.send("Browser.getWindowBounds", { windowId: wf.windowId });
    if (!wb.bounds || typeof wb.bounds.width !== "number") throw new Error("bad getWindowBounds");
    await cdp.send("Browser.setWindowBounds", { windowId: wf.windowId, bounds: { width: 920, height: 720 } });
    return `product=${ver.product} windowId=${wf.windowId} ${wb.bounds.width}x${wb.bounds.height}`;
  });

  await run("15. 下载全链路：waitForEvent('download') + path() + saveAs() 字节核验", async () => {
    await page.goto(`http://127.0.0.1:${P1}/a`);
    const [dl] = await Promise.all([
      page.waitForEvent("download", { timeout: 10000 }),
      page.click("#dl"),
    ]);
    const suggested = dl.suggestedFilename();
    if (suggested !== "compat-sample.txt") throw new Error("unexpected filename: " + suggested);
    const dlPath = await dl.path();
    if (!dlPath || !fs.existsSync(dlPath)) throw new Error("download.path() missing on disk: " + dlPath);
    const saved = path.join(dlSaveDir, "saved-copy.txt");
    await dl.saveAs(saved);
    const content = fs.readFileSync(saved, "utf8");
    if (content !== DOWNLOAD_PAYLOAD) {
      throw new Error(`payload mismatch: got ${JSON.stringify(content)}`);
    }
    return `file=${suggested} bytes=${Buffer.byteLength(content)}`;
  });

  await run("16. 慢速下载取消：download.cancel() + download.failure()", async () => {
    await page.goto(`http://127.0.0.1:${P1}/a`);
    const [dl] = await Promise.all([
      page.waitForEvent("download", { timeout: 10000 }),
      page.click("#dlSlow"),
    ]);
    await dl.cancel();
    const failure = await dl.failure();
    if (!failure) throw new Error("expected non-null failure after cancel()");
    return `failure=${failure}`;
  });

  await run("17. 站点权限：context.grantPermissions + permissions.query + clearPermissions", async () => {
    const origin = `http://127.0.0.1:${P1}`;
    await page.goto(`${origin}/a`);
    await ctx.grantPermissions(["geolocation", "notifications"], { origin });
    const afterGrant = await page.evaluate(async () => {
      const geo = await navigator.permissions.query({ name: "geolocation" });
      const notif = await navigator.permissions.query({ name: "notifications" });
      return { geo: geo.state, notif: notif.state };
    });
    if (afterGrant.geo !== "granted" || afterGrant.notif !== "granted") {
      throw new Error("expected granted after grantPermissions, got " + JSON.stringify(afterGrant));
    }
    await ctx.clearPermissions();
    const afterClear = await page.evaluate(async () => {
      const geo = await navigator.permissions.query({ name: "geolocation" });
      const notif = await navigator.permissions.query({ name: "notifications" });
      return { geo: geo.state, notif: notif.state };
    });
    if (afterClear.geo === "granted" || afterClear.notif === "granted") {
      throw new Error("expected reset after clearPermissions, got " + JSON.stringify(afterClear));
    }
    return `granted=${afterGrant.geo}/${afterGrant.notif} cleared=${afterClear.geo}/${afterClear.notif}`;
  });

  await run("18. 不支持权限诚实报错：grantPermissions(['clipboard-read']) 显式拒绝", async () => {
    const origin = `http://127.0.0.1:${P1}`;
    let errMsg = "";
    try {
      await ctx.grantPermissions(["clipboard-read"], { origin });
    } catch (e) {
      errMsg = e?.message || String(e);
    }
    if (!errMsg || !/不支持|clipboard/i.test(errMsg)) {
      throw new Error("expected explicit unsupported error, got: " + (errMsg || "<no error>"));
    }
    return `rejected=${errMsg.slice(0, 72)}`;
  });

  await run("19. 0-tab Cookie 回落：关掉会话全部页面后 addCookies / cookies 经 chrome.cookies 仍可用", async () => {
    for (const p of [...ctx.pages()]) {
      await p.close();
    }
    await new Promise((r) => setTimeout(r, 200));
    await ctx.addCookies([{ name: "zero_tab_ck", value: "fallback99", url: `http://127.0.0.1:${P1}` }]);
    const cs = await ctx.cookies(`http://127.0.0.1:${P1}`);
    const found = cs.find((c) => c.name === "zero_tab_ck" && c.value === "fallback99");
    if (!found) throw new Error("0-tab cookie missing: " + JSON.stringify(cs));
    return `pages=${ctx.pages().length} zero_tab_ck=${found.value}`;
  });
} finally {
  for (const stop of [...slowStreams]) stop();
  await browser.close().catch(() => {});
  await fetch(`${CONTROL}/sessions/${sessionName}/release`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(tok ? { Authorization: `Bearer ${tok}` } : authHeaders) },
    body: "{}",
  }).catch(() => {});
  srv1.close();
  srv2.close();
  fs.rmSync(dlSaveDir, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${failed.length === 0 ? "CDP 协议兼容回归全部通过 ✅" : `${failed.length} 项失败 ❌`}（${results.length - failed.length}/${results.length}）`);
process.exit(failed.length ? 1 : 0);
