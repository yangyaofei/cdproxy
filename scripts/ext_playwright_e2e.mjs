// ext_playwright_e2e.mjs — 用 Playwright connectOverCDP 作为「零改动客户端」
// 走完整自动化流，验证 cdp-ext 扩展下游对真实客户端的兼容性。
// 前置：extension 模式服务运行中（9234/9235）+ 扩展已回连。
// 依赖：npm --prefix var/pwtest i playwright-core（回落解析该目录）。
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require("playwright-core"));
} catch {
  ({ chromium } = require("../var/pwtest/node_modules/playwright-core"));
}

const CONTROL = "http://127.0.0.1:9234";
const results = [];
const check = (name, ok, detail = "") => {
  results.push([name, ok, detail]);
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? " — " + detail : ""}`);
};

// 分配令牌：从管理面 /status 自取（POST /sessions 需要 Bearer 准入）
const _st = await fetch(`${CONTROL}/status`).then((r) => r.json());
const allocToken = _st?.sources?.alloc_token || "";

const alloc = await fetch(`${CONTROL}/sessions`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${allocToken}` },
  body: JSON.stringify({ name: `pw-e2e-${Date.now()}` }),
}).then((r) => r.json());

const browser = await chromium.connectOverCDP(alloc.cdpUrl);
try {
  const ctx = browser.contexts()[0];
  check("connectOverCDP 连接成功（经扩展下游）", true);

  const page = ctx.pages()[0] || (await ctx.waitForEvent("page", { timeout: 5000 }).catch(() => null));
  check("默认 context 可见预开 tab", !!page, `pages=${ctx.pages().length}`);

  // 注：goto data: URL 会被 Chrome 自身拒绝（Not allowed to navigate top
  // frame to data URL，Chrome 60+ 安全策略，与桥无关），故用 setContent。
  await page.setContent("<title>pw-ok</title><h1>hello cdp-ext</h1>");
  const title = await page.title();
  check("setContent + title", title === "pw-ok", `title=${title}`);

  const sum = await page.evaluate("6 * 7");
  check("evaluate", sum === 42, `6*7=${sum}`);

  const html = await page.content();
  check("content", html.includes("hello cdp-ext"));

  const shot = await page.screenshot();
  check("screenshot", shot.length > 1000, `${shot.length} bytes`);

  const np = await ctx.newPage();
  await np.setContent("<title>second</title>");
  const t2 = await np.title();
  check("newPage（Target.createTarget 全链路）", t2 === "second");
  await np.close();
  check("page.close（closeTarget 全链路）", true);

  const cdp = await ctx.newCDPSession(page);
  const ua = await cdp.send("Runtime.evaluate", { expression: "navigator.userAgent", returnByValue: true });
  check("newCDPSession + 原生 CDP 命令", typeof ua.result.value === "string" && ua.result.value.length > 10);

  await page.click("h1");
  check("click（Input 合成事件）", true);
} finally {
  await browser.close();
}

const failed = results.filter(([, ok]) => !ok);
console.log(failed.length ? `\n${failed.length} 项失败 ❌` : "\nPlaywright E2E 全部通过 ✅");
process.exit(failed.length ? 1 : 0);
