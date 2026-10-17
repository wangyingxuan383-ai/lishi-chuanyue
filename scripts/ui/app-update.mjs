// R14 in-app update sheet at phone size (360×800), all states and three themes.
// Isolated: its own Vite server, a fake /__dev bridge, GitHub's release API
// answered locally, every other host blocked. The browser harness only
// simulates the download (src/platform/webUpdate.ts); nothing is installed.
// Run: node scripts/ui/app-update.mjs   (screenshots: output/playwright/app-update/)
import fs from "node:fs";
import path from "node:path";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { chromium } from "playwright-core";

const root = path.resolve(import.meta.dirname, "../..");
const out = path.join(root, "output/playwright/app-update");
fs.mkdirSync(out, { recursive: true });
const port = Number(process.env.LISHI_UPDATE_UI_PORT ?? 1455);
const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
const [major, minor, patch] = version.split(".").map(Number);
let next = `${major}.${minor}.${patch + 1}`;
const checks = [];
const errors = [];
const outside = [];
let variant = "digest";

const notes = [
  "一个装在手机里的 AI 历史穿越互动小说。",
  "",
  "## 这一版新增和改进",
  "",
  "- **应用内更新**：在应用里下载新版本，断了能接着下，下完先校验再安装。",
  "- **剧本与挑战**：开局可以选一段剧本，或给自己定一个挑战。",
  "- 修了[几个问题](https://github.com/wangyingxuan383-ai/lishi-chuanyue/issues)，长故事打开更快。",
].join("\n");

function releases() {
  const apk = { name: `chuanyue-${next}.apk`, size: 23_449_427, state: "uploaded", content_type: "application/vnd.android.package-archive",
    digest: variant === "digest" ? `sha256:${"7".repeat(64)}` : null,
    browser_download_url: `https://github.com/wangyingxuan383-ai/lishi-chuanyue/releases/download/v${next}/chuanyue-${next}.apk` };
  return [{ tag_name: `v${next}`, name: `历史穿越 ${next}`, body: notes, draft: false, prerelease: true,
    html_url: `https://github.com/wangyingxuan383-ai/lishi-chuanyue/releases/tag/v${next}`, published_at: "2026-10-18T04:00:00Z", assets: [apk] }];
}

const fake = {
  name: "update-local-fake",
  configureServer(server) {
    server.middlewares.use("/__dev", async (req, res) => {
      for await (const _ of req) { /* drain */ }
      res.setHeader("Content-Type", "application/json");
      if (req.url.startsWith("/secret/has")) return res.end(JSON.stringify({ configured: false, boundBaseUrl: null }));
      if (req.url.startsWith("/config")) return res.end(JSON.stringify({ baseUrl: null, model: null }));
      res.end("null");
    });
  },
};
// configFile:false keeps the project's disk-backed dev bridge and .env.local out.
const server = await createServer({ root, configFile: false, envDir: false, cacheDir: path.join(root, ".cache/vite-app-update"), plugins: [fake, react()],
  define: { __APP_VERSION__: JSON.stringify(version) },
  server: { host: "127.0.0.1", port, strictPort: true, watch: { ignored: ["**/target/**", "**/src-tauri/**", "**/output/**", "**/.cache/**", "**/.claude/**"] } } });
await server.listen();

let browser;
let page;
const check = (name, ok) => { checks.push({ name, ok: !!ok }); if (!ok) throw new Error(`check failed: ${name}`); };
const shot = async (name) => { await page.waitForTimeout(250); await page.screenshot({ path: path.join(out, `${name}.png`) }); };
const sheet = () => page.locator(".sheet");
const theme = (name) => page.evaluate((t) => { document.documentElement.dataset.theme = t; }, name);
const noSideScroll = async (name) => check(`${name}: no horizontal scroll at 360px`, await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
const tapTargets = async (name) => {
  const small = await page.evaluate(() => [...document.querySelectorAll(".sheet button")]
    .filter((b) => b.offsetParent !== null).map((b) => ({ text: b.textContent?.trim() || b.getAttribute("aria-label"), h: b.getBoundingClientRect().height })).filter((b) => b.h < 44));
  check(`${name}: sheet buttons are at least 44px (${JSON.stringify(small)})`, small.length === 0);
};
// Short copy: each status or hint line in the panel fits one line at 360px.
const oneLine = async (name) => {
  const wrapped = await page.evaluate(() => [...document.querySelectorAll(".update-panel .update-status, .update-panel .update-hint")]
    .filter((e) => !e.querySelector(".update-count"))
    .filter((e) => e.getBoundingClientRect().height > parseFloat(getComputedStyle(e).lineHeight) * 1.5).map((e) => e.textContent));
  check(`${name}: panel lines fit one line (${wrapped.join(" / ")})`, wrapped.length === 0);
};
const sim = (options) => page.evaluate((o) => localStorage.setItem("lishi.devUpdateSim", o), options);
// The harness saves its database to IndexedDB a second after the last change.
const persisted = () => page.waitForTimeout(1600);

try {
  browser = await chromium.launch({ channel: "msedge" });
  const context = await browser.newContext({ viewport: { width: 360, height: 800 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await context.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === "127.0.0.1") return route.continue();
    if (url.href === "https://api.github.com/repos/wangyingxuan383-ai/lishi-chuanyue/releases?per_page=5") {
      return route.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify(releases()) });
    }
    outside.push(url.href);
    return route.abort();
  });
  page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  await page.goto(`http://127.0.0.1:${port}`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForFunction(() => !!window.__lishi?.game);
  await page.evaluate(async (current) => {
    const { game } = window.__lishi;
    await game.repo.setSetting("welcomed", true);
    // Only the update banner on Home, not the "这一版新增" notice.
    await game.repo.setSetting("whatsNewSeen", current);
  }, version);
  await persisted();

  // 1. The Home banner opens the sheet.
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByText(`有新版本 ${next}`).waitFor({ timeout: 20000 });
  await shot("01-home-banner");
  await noSideScroll("home");
  await page.getByRole("button", { name: "去更新" }).click();
  await sheet().waitFor();
  check("sheet title names the version", await sheet().getByRole("heading", { name: `新版本 ${next}` }).isVisible());
  const meta = await sheet().locator(".update-meta").innerText();
  check(`meta shows current version and size (${meta})`, meta.includes(`当前 ${version}`) && meta.includes("安装包 22.4 MB") && meta.includes("预发布"));
  const shown = await sheet().locator(".update-notes").innerText();
  check("notes are plain text", shown.includes("· 应用内更新：在应用里下载新版本") && !shown.includes("**") && !shown.includes("##") && !shown.includes("](") && shown.includes("几个问题"));
  check("idle hint says saves are kept", await sheet().getByText("覆盖安装，存档不会丢").isVisible());
  await shot("02-sheet-idle");
  await oneLine("idle");
  await tapTargets("idle");
  await noSideScroll("idle sheet");

  // 2. Download: progress, a dropped connection, retry (resumes), verify, ready.
  await sim("slow fail permission");
  await sheet().getByRole("button", { name: "下载更新" }).click();
  await sheet().getByText("正在下载").waitFor();
  await page.waitForFunction(() => Number(document.querySelector(".update-bar")?.getAttribute("aria-valuenow")) >= 15);
  await shot("03-downloading");
  await oneLine("downloading");
  await tapTargets("downloading");
  // Closing the sheet does not stop the download; opening it again shows it.
  await sheet().getByRole("button", { name: "关闭" }).click();
  await page.waitForTimeout(400);
  await page.getByRole("button", { name: "去更新" }).click();
  await sheet().waitFor();
  check("reopened sheet still shows the running download", await sheet().getByText(/正在下载|网络断了/).isVisible());
  await sheet().getByText("网络断了").waitFor({ timeout: 20000 });
  const failedAt = Number(await page.locator(".update-bar").getAttribute("aria-valuenow"));
  check(`failure keeps the progress (${failedAt}%)`, failedAt >= 40 && failedAt < 100);
  check("failure offers retry and the browser", await sheet().getByRole("button", { name: "重试" }).isVisible() && await sheet().getByRole("button", { name: "用浏览器下载" }).isVisible());
  await shot("04-failed-network");
  await oneLine("failed");
  await tapTargets("failed");
  await sheet().getByRole("button", { name: "重试" }).click();
  await sheet().getByText("正在下载").waitFor();
  const resumedAt = Number(await page.locator(".update-bar").getAttribute("aria-valuenow"));
  check(`retry resumes instead of starting over (${resumedAt}%)`, resumedAt >= failedAt);
  await sheet().getByText("正在校验安装包").waitFor({ timeout: 30000 });
  await shot("05-verifying");
  await sheet().getByText("安装包已下载，校验无误").waitFor({ timeout: 10000 });
  await shot("06-ready");
  await oneLine("ready");
  await tapTargets("ready");

  // 3. Install: first the 安装未知应用 switch, then the harness says it cannot install.
  await sheet().getByRole("button", { name: "安装" }).click();
  await sheet().getByText("需要允许本应用“安装未知应用”").waitFor();
  check("permission hint is one short line", (await sheet().locator(".update-hint").innerText()).length <= 30);
  await shot("07-permission");
  await oneLine("permission");
  await sheet().getByRole("button", { name: "安装" }).click();
  await page.getByText("开发台只模拟下载，安装请在手机上试").waitFor();
  await shot("08-harness-cannot-install");

  // 4. Three themes on the ready sheet.
  for (const name of ["paper", "day", "night"]) {
    await theme(name);
    await shot(`09-ready-${name}`);
  }
  await theme("night");
  await sheet().getByRole("button", { name: "关闭" }).click();
  await page.waitForTimeout(300);
  await shot("10-home-night");
  await theme("paper");

  // 5. 设置 → 关于与更新: the same sheet, the same state.
  await page.getByRole("button", { name: "设置" }).click();
  await page.getByRole("button", { name: /关于与更新/ }).click();
  await page.getByRole("button", { name: "检查更新" }).click();
  await page.getByText(`有新版本：${next}`).waitFor({ timeout: 20000 });
  const card = await page.locator(".status-card .release-notes").innerText();
  check("about card notes are plain and short", !card.includes("**") && card.split("\n").length <= 4);
  check("network note mentions downloading updates", await page.getByText("检查和下载更新时连 GitHub").isVisible());
  await shot("11-about");
  await noSideScroll("about");
  await page.getByRole("button", { name: "去更新" }).click();
  await sheet().waitFor();
  check("about opens the same, already verified download", await sheet().getByText("安装包已下载，校验无误").isVisible());
  await shot("12-about-sheet");
  await sheet().getByRole("button", { name: "关闭" }).click();

  // 6. A newer release without a published hash (no digest, no SHA256SUMS.txt):
  //    its sheet starts fresh and offers only the browser.
  const recheck = async (shownVersion) => {
    await page.getByRole("button", { name: "检查更新" }).click();
    await page.getByText(`有新版本：${shownVersion}`).waitFor({ timeout: 20000 });
    await page.getByRole("button", { name: "去更新" }).click();
    await sheet().waitFor();
  };
  await page.getByRole("button", { name: "返回" }).click();
  await page.getByRole("button", { name: /关于与更新/ }).click();
  next = `${major}.${minor}.${patch + 2}`;
  variant = "nohash";
  await recheck(next);
  check("another version's sheet starts from the beginning", await sheet().getByRole("button", { name: "下载更新" }).isVisible());
  await sheet().getByRole("button", { name: "下载更新" }).click();
  await sheet().getByText("这一版没有校验信息").waitFor();
  check("without a hash only the browser is offered", await sheet().getByRole("button", { name: "用浏览器下载" }).isVisible() && !(await sheet().getByRole("button", { name: /重试|重新下载/ }).count()));
  await shot("13-nohash");
  await oneLine("nohash");
  await sheet().getByRole("button", { name: "关闭" }).click();

  // 7. A package that fails the check is deleted and offered again from the start.
  next = `${major}.${minor}.${patch + 3}`;
  variant = "digest";
  await sim("corrupt");
  await page.getByRole("button", { name: "返回" }).click();
  await page.getByRole("button", { name: /关于与更新/ }).click();
  await recheck(next);
  await sheet().getByRole("button", { name: "下载更新" }).click();
  await sheet().getByText("下载的文件不完整，已删除").waitFor({ timeout: 20000 });
  check("a corrupt package offers a fresh download", await sheet().getByRole("button", { name: "重新下载" }).isVisible());
  await shot("14-corrupt");
  await oneLine("corrupt");

  check(`no page errors (${errors.join(" | ")})`, errors.length === 0);
  check(`no requests left the machine (${outside.join(", ")})`, outside.length === 0);
} catch (error) {
  checks.push({ name: String(error?.message ?? error), ok: false });
  if (page) await page.screenshot({ path: path.join(out, "failure.png") }).catch(() => {});
} finally {
  await browser?.close();
  await server.close();
  const failed = checks.filter((c) => !c.ok);
  fs.writeFileSync(path.join(out, "checks.json"), JSON.stringify({ checks, errors, outside }, null, 2));
  console.log(`${checks.length - failed.length}/${checks.length} checks passed`);
  for (const c of failed) console.log(`FAILED: ${c.name}`);
  process.exitCode = failed.length ? 1 : 0;
}
