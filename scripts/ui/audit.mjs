// Every screen and sheet it can reach, at phone size, in four looks (default,
// large text, night, 墨韵): a screenshot each plus objective checks — no sideways
// scrolling, no clipped button text, no engineering words or raw values in what the
// player reads. For reviewing by eye afterwards; the report lists what tripped.
// Start the isolated dev console and the fake model (see play-check.mjs) with a
// story already played there (play-check leaves one), then run:
//   LISHI_BROWSER=/usr/bin/chromium node scripts/ui/audit.mjs [--looks default,large,night,ink]
// Output: output/playwright/audit/<look>/NN-name.png and report.md.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { launchBrowser } from "./browser.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const origin = process.env.LISHI_APP ?? "http://127.0.0.1:1421/";
const originUrl = new URL(origin);
if (originUrl.hostname !== "127.0.0.1") throw new Error("走查只连接本机隔离开发台");
const marker = await (await fetch(new URL("/__ui-isolation", originUrl))).json();
if (!marker.loopbackOnly || !marker.databaseDir?.startsWith(".cache/") || marker.secretsFile !== marker.databaseDir + "/fake-secrets.json") {
  throw new Error("隔离标记不匹配；走查不会写入这个存档");
}
const out = path.join(root, "output/playwright/audit");
const timeout = Number(process.env.LISHI_UI_TIMEOUT_MS ?? 30000);
const lookArg = process.argv.includes("--looks") ? process.argv[process.argv.indexOf("--looks") + 1] : "default,large,night,ink";
const LOOKS = {
  default: {},
  large: { size: 22 },
  night: { theme: "night" },
  ink: { style: "ink" },
};
// Words a player should not have to read (engineering, raw values, internal numbers).
// “token” is left out: with the player's own key it is the unit the cost pages count in.
const JARGON = [/\bJSON\b/, /\bprompt\b/i, /\bundefined\b/, /\bnull\b/, /\bNaN\b/, /\[object /, /\bAPI\b(?! Key)/, /\b[RDM]\d{2,3}(?:-T\d{3})?\b/, /\bpayload\b/i, /\bschema\b/i, /\bstack\b/i, /\bfetch\b/i, /\bErr(?:or)?:/, /writing-canon|fact-sync|upkeep-\d|codex-\d|turn-\d/];

const browser = await launchBrowser(chromium, { headless: true });
const results = [];
const flag = (look, screen, problem) => { results.push(`- [${look}] ${screen}：${problem}`); console.log(`FLAG [${look}] ${screen}: ${problem}`); };

async function inspect(page, look, screen) {
  const found = await page.evaluate((patterns) => {
    const problems = [];
    if (document.documentElement.scrollWidth > window.innerWidth + 1) problems.push(`页面能横向滚动（宽 ${document.documentElement.scrollWidth}）`);
    for (const el of document.querySelectorAll("button, .tag, .chip, label, h1, h2, h3, .sheet-title")) {
      const style = getComputedStyle(el);
      if (style.visibility === "hidden" || style.display === "none" || !el.offsetParent) continue;
      if (el.scrollWidth > el.clientWidth + 2 && style.overflow !== "visible" && style.textOverflow !== "ellipsis" && el.textContent.trim()) problems.push(`文字被截断：“${el.textContent.trim().slice(0, 24)}”`);
      const box = el.getBoundingClientRect();
      const tabs = el.closest('[role="tablist"]');
      const scrolls = tabs && tabs.scrollWidth > tabs.clientWidth && /^(auto|scroll)$/.test(getComputedStyle(tabs).overflowX);
      if (!scrolls && box.right > window.innerWidth + 1 && box.width < window.innerWidth) problems.push(`超出屏幕右边：“${el.textContent.trim().slice(0, 24)}”`);
    }
    const text = document.body.innerText;
    for (const source of patterns) { const m = text.match(new RegExp(source[0], source[1])); if (m) problems.push(`玩家看得到工程用语：“${m[0]}”`); }
    return [...new Set(problems)].slice(0, 8);
  }, JARGON.map((r) => [r.source, r.flags]));
  for (const problem of found) flag(look, screen, problem);
}

async function run(look) {
  const dir = path.join(out, look);
  fs.mkdirSync(dir, { recursive: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true, serviceWorkers: "block" });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  let n = 0;
  const shot = async (name) => {
    await page.waitForTimeout(350);
    await page.screenshot({ path: path.join(dir, `${String(++n).padStart(2, "0")}-${name}.png`) });
    await inspect(page, look, name);
  };
  const sheet = () => page.locator(".sheet").last();
  const closeSheets = async () => { for (let i = 0; i < 4 && await page.locator(".sheet").count(); i++) { await page.keyboard.press("Escape"); await page.waitForTimeout(300); } };
  const home = async () => {
    await page.goto(origin, { waitUntil: "domcontentloaded", timeout: 180000 });
    await page.waitForFunction(() => !!window.__lishi?.game, null, { timeout: 120000 });
    await page.locator(".home-scene, .shelf-book, .strip-card").first().waitFor({ timeout: 120000 });
  };
  const story = async () => { await home(); await page.locator(".home-scene, .shelf-book, .strip-card").first().click(); await page.locator(".dock").waitFor({ timeout }); await page.waitForTimeout(500); };

  // The look for this pass.
  await home();
  await page.evaluate(async (patch) => {
    const { game } = window.__lishi;
    const reading = await game.repo.getSetting("reading", {});
    await game.repo.setSetting("reading", { ...reading, theme: "paper", style: "scroll", size: 18, ...patch });
    await window.__lishiFlush?.();
  }, LOOKS[look]);
  await home();
  await shot("home");

  // New story.
  try {
    await page.getByRole("button", { name: /开始新的故事|新的故事/ }).first().click();
    await page.waitForTimeout(600);
    await shot("new-story");
    await page.mouse.wheel(0, 1600); await shot("new-story-lower");
  } catch (e) { flag(look, "new-story", `打不开：${String(e.message).slice(0, 80)}`); }

  // Settings and each page.
  try {
    await home();
    await page.getByRole("button", { name: /^设置/ }).first().click();
    await page.waitForTimeout(500);
    await shot("settings");
    const entries = await page.locator(".settings-entry").evaluateAll((els) => els.map((el) => el.querySelector("b")?.textContent?.trim() || el.textContent.trim()).filter(Boolean));
    for (const [i, label] of entries.entries()) {
      try {
        await home();
        await page.getByRole("button", { name: /^设置/ }).first().click();
        await page.locator(".settings-entry").filter({ hasText: label }).first().click();
        await page.waitForTimeout(600);
        await shot(`settings-${i}-${label.slice(0, 6)}`);
      } catch (e) { flag(look, `设置·${label}`, `打不开：${String(e.message).slice(0, 80)}`); }
    }
  } catch (e) { flag(look, "settings", `打不开：${String(e.message).slice(0, 80)}`); }

  // The play screen, the 更多 menu and each of its sheets.
  try {
    await story();
    await shot("play");
    await page.getByRole("button", { name: "更多", exact: true }).click();
    await page.waitForTimeout(400);
    await shot("more-menu");
    const items = await sheet().locator(".sheet-menu > button").evaluateAll((els) => els.map((el) => el.textContent.trim()).filter(Boolean));
    await closeSheets();
    for (const [i, label] of items.entries()) {
      // Things that change the story or leave it are not part of a look-around.
      if (/返回书架|导出|删除|撤销|重做/.test(label)) continue;
      try {
        await story();
        await page.getByRole("button", { name: "更多", exact: true }).click();
        await sheet().locator(".sheet-menu > button").filter({ hasText: label }).first().click();
        // Some items open a page with a transition; let it finish before the picture.
        await page.waitForTimeout(1300);
        await shot(`more-${i}-${label.slice(0, 6)}`);
        await closeSheets();
      } catch (e) { flag(look, `更多·${label}`, `打不开：${String(e.message).slice(0, 80)}`); }
    }
  } catch (e) { flag(look, "play", `打不开：${String(e.message).slice(0, 80)}`); }

  // The character panel and its tabs.
  try {
    await story();
    await page.getByRole("button", { name: "角色", exact: true }).click();
    await page.locator(".panel").waitFor({ timeout });
    const tabs = await page.getByRole("tab").allTextContents();
    for (const [i, tab] of tabs.entries()) {
      await page.getByRole("tab", { name: tab.trim() }).click();
      await page.waitForTimeout(400);
      await shot(`panel-${i}-${tab.trim().slice(0, 4)}`);
    }
  } catch (e) { flag(look, "panel", `打不开：${String(e.message).slice(0, 80)}`); }

  // A passage's long-press menu, AI 改写 in its three ways, and the 资料范围 page.
  try {
    await story();
    const paragraph = page.locator(".turn[data-node-id]").last().locator(".story-text p").first();
    await paragraph.scrollIntoViewIfNeeded();
    const spot = await paragraph.boundingBox();
    const pointer = { pointerId: 41, pointerType: "touch", isPrimary: true, button: 0, clientX: spot.x + 30, clientY: spot.y + 12 };
    await paragraph.dispatchEvent("pointerdown", { ...pointer, buttons: 1, pressure: 0.5 });
    await page.waitForTimeout(700);
    await paragraph.dispatchEvent("pointerup", { ...pointer, buttons: 0, pressure: 0 });
    await shot("long-press");
    await sheet().locator(".sheet-menu > button", { hasText: "AI 改写" }).click();
    await page.waitForTimeout(500);
    await shot("rewrite-revise");
    await sheet().getByRole("button", { name: "只润色文字" }).click(); await shot("rewrite-polish");
    const canon = sheet().getByRole("button", { name: "按原著纠错" });
    if (await canon.count()) {
      await canon.click(); await shot("rewrite-canon");
      const row = sheet().getByRole("button", { name: /^资料范围/ });
      if (await row.count()) { await row.click(); await page.waitForTimeout(500); await shot("scope-page"); }
    }
  } catch (e) { flag(look, "long-press", `打不开：${String(e.message).slice(0, 80)}`); }

  // Guide and what is new.
  try {
    await home();
    await page.getByRole("button", { name: /^设置/ }).first().click();
    const guide = page.locator(".settings-entry").filter({ hasText: /指南|怎么玩/ }).first();
    if (await guide.count()) { await guide.click(); await page.waitForTimeout(500); await shot("guide"); }
  } catch (e) { flag(look, "guide", `打不开：${String(e.message).slice(0, 80)}`); }

  for (const message of errors) flag(look, "page", `页面出错：${message.slice(0, 120)}`);
  await context.close();
  return n;
}

const counts = {};
for (const look of lookArg.split(",")) counts[look] = await run(look);
// Back to the default look for whoever uses the store next.
{
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  await page.goto(origin, { waitUntil: "domcontentloaded", timeout: 180000 });
  await page.waitForFunction(() => !!window.__lishi, null, { timeout: 120000 });
  await page.evaluate(async () => { const { game } = window.__lishi; const reading = await game.repo.getSetting("reading", {}); await game.repo.setSetting("reading", { ...reading, theme: "paper", style: "scroll", size: 18 }); await window.__lishiFlush?.(); });
  await context.close();
}
fs.writeFileSync(path.join(out, "report.md"), `# 逐界面走查（手机尺寸）\n\n${new Date().toISOString()}\n\n截图：${Object.entries(counts).map(([k, v]) => `${k} ${v} 张`).join("，")}\n\n## 自动检查发现\n\n${results.length ? results.join("\n") : "无"}\n`);
console.log(`DONE ${JSON.stringify(counts)} flags=${results.length}`);
await browser.close();
