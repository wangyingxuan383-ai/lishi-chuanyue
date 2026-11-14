// Screens in both looks (R28 第二批, D160): 宣纸书卷 and 墨韵, light and dark, at
// phone size, plus a few frames in the middle of animations. Runs against the
// isolated dev console (scripts/ui/dev-isolated.mjs, after play-check has made a
// story there) and the fake model; writes PNGs and one contact sheet per look.
//   node scripts/ui/style-shots.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { launchBrowser } from "./browser.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const origin = "http://127.0.0.1:1421";
const out = path.join(root, "output/playwright/style-shots");
fs.mkdirSync(out, { recursive: true });
const marker = await (await fetch(`${origin}/__ui-isolation`)).json();
if (marker.databaseDir !== ".cache/ui-isolated" || marker.loopbackOnly !== true) throw new Error("not the isolated dev console; refusing");

const browser = await launchBrowser(chromium);
const page = await browser.newPage({ viewport: { width: 393, height: 852 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
page.setDefaultTimeout(Number(process.env.LISHI_UI_TIMEOUT_MS ?? 45_000));
const shots = [];
const shot = async (name) => { const file = path.join(out, `${name}.png`); await page.screenshot({ path: file }); shots.push(file); console.log(name); };
const settle = (ms = 700) => page.waitForTimeout(ms);
const sheet = () => page.locator(".sheet-layer:not(.closing) .sheet:visible").last();
const closeSheets = async () => {
  for (let i = 0; i < 6 && await page.locator(".sheet-layer").count(); i++) {
    await page.keyboard.press("Escape").catch(() => {});
    if (await page.locator(".sheet-layer:not(.closing) .sheet-close").count()) await page.locator(".sheet-layer:not(.closing) .sheet-close").last().click().catch(() => {});
    await settle(400);
  }
};

async function setLook(style, theme, motion = "rich", home = "scene") {
  await page.goto(`${origin}/`, { waitUntil: "domcontentloaded", timeout: 180_000 });
  await page.waitForFunction(() => window.__lishi?.game, null, { timeout: 180_000 });
  await page.evaluate(async ({ style, theme, motion, home }) => {
    const repo = window.__lishi.game.repo;
    const reading = await repo.getSetting("reading", {});
    await repo.setSetting("reading", { ...reading, style, theme, motion });
    localStorage.setItem("lishi.style", style); localStorage.setItem("lishi.theme", theme);
    await repo.setSetting("reading", { ...(await repo.getSetting("reading", {})), home });
  }, { style, theme, motion, home });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator(".world-open:visible, .shelf-book:visible").first().waitFor();
  await settle(900);
}

for (const [style, theme] of [["scroll", "paper"], ["ink", "paper"], ["ink", "night"], ["scroll", "night"]]) {
  const tag = `${style}-${theme}`;
  // R29 (D163): both home designs.
  await setLook(style, theme, "rich", "shelf");
  await shot(`${tag}-01b-home-shelf`);
  await setLook(style, theme);
  await shot(`${tag}-01-home`);
  // Settings and the look picker.
  await page.getByRole("button", { name: /^设置/ }).click();
  await settle(); await shot(`${tag}-02-settings`);
  await page.getByRole("button", { name: /^阅读与外观/ }).click();
  await settle(); await shot(`${tag}-03-reading`);
  await page.getByRole("button", { name: "返回", exact: true }).click(); await settle(300);
  await page.getByRole("button", { name: "返回", exact: true }).click(); await settle();
  // New story's first screen.
  await page.locator(".new-story").click();
  await settle(); await shot(`${tag}-04-newgame`);
  await page.getByRole("button", { name: "返回", exact: true }).click(); await settle();
  // The story, at the bottom: the last passage, its changes and 接下来.
  await page.locator(".world-open:visible").first().click();
  await page.locator(".play:visible .story .turn[data-node-id]").first().waitFor();
  await settle(900);
  await page.locator(".play:visible .story").evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await settle(600); await shot(`${tag}-05-play`);
  await page.locator(".play:visible .story").evaluate((el) => { el.scrollTop = el.scrollHeight - el.clientHeight - 420; });
  await settle(400); await shot(`${tag}-06-play-passage`);
  // ⋯ menu, with its spring rise caught half-way at 华丽.
  await page.locator(".play:visible .topbar").getByRole("button", { name: "更多", exact: true }).click();
  await page.waitForTimeout(140); await shot(`${tag}-07-menu-rising`);
  await settle(); await shot(`${tag}-08-menu`);
  await closeSheets();
  // This passage's changes.
  const changes = page.locator(".play:visible .turn-changes").last();
  if (await changes.count()) { await changes.click(); await settle(); await shot(`${tag}-09-changes`); await closeSheets(); }
  // Typing: the bar with its tools.
  await page.locator(".play:visible .inputbar textarea").click();
  await page.locator(".play:visible .inputbar textarea").fill("我推门出去，看看街上");
  await settle(300); await shot(`${tag}-10-typing`);
  // Sending: the action flies in, the brush waits.
  await page.locator(".play:visible .dock .send-btn").click();
  await page.waitForTimeout(120); await shot(`${tag}-11-sending`);
  await page.locator(".play:visible .story-text.streaming").first().waitFor({ timeout: 30_000 }).catch(() => {});
  await page.waitForTimeout(250); await shot(`${tag}-12-streaming`);
  await page.waitForFunction(() => { const b = document.querySelector(".play .dock .send-btn"); return b && !b.textContent.includes("停止"); }, null, { timeout: 120_000 });
  await page.waitForTimeout(250); await shot(`${tag}-13-done-sweep`);
  await page.locator(".play:visible .topbar").getByRole("button", { name: "返回", exact: true }).click();
  await settle();
}
await browser.close();

// One contact sheet per look, for a quick look over everything.
console.log(`DONE ${shots.length} shots in ${path.relative(root, out)}`);
