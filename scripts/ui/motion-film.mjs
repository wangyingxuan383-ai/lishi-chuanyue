// Animation filmstrips (R29-T007): opening a book from each home design and
// going back, slowed four times and caught every 80 ms of animation time, laid
// out as one contact sheet per sequence. Isolated dev console and fake model.
//   node scripts/ui/motion-film.mjs [scroll|ink] [paper|night]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { launchBrowser } from "./browser.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const origin = "http://127.0.0.1:1421";
const [style = "scroll", theme = "paper"] = process.argv.slice(2);
const out = path.join(root, "output/playwright/motion-film");
fs.mkdirSync(out, { recursive: true });
const marker = await (await fetch(`${origin}/__ui-isolation`)).json();
if (marker.databaseDir !== ".cache/ui-isolated" || marker.loopbackOnly !== true) throw new Error("not the isolated dev console; refusing");

const SLOW = 4, STEP = 80, FRAMES = 14;
const browser = await launchBrowser(chromium);
const context = await browser.newContext({ viewport: { width: 393, height: 852 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
// The flourish waits on timers before navigating: stretch those with the animations.
await context.addInitScript((slow) => {
  const original = window.setTimeout;
  window.setTimeout = (fn, ms, ...rest) => original(fn, [420, 460, 600, 900].includes(ms) ? ms * slow : ms, ...rest);
}, SLOW);
const page = await context.newPage();
page.setDefaultTimeout(60_000);
const cdp = await context.newCDPSession(page);
await cdp.send("Animation.enable");

async function look(home) {
  await page.goto(`${origin}/`, { waitUntil: "domcontentloaded", timeout: 180_000 });
  await page.waitForFunction(() => window.__lishi?.game, null, { timeout: 180_000 });
  await page.evaluate(async ({ style, theme, home }) => {
    const repo = window.__lishi.game.repo;
    await repo.setSetting("reading", { ...(await repo.getSetting("reading", {})), style, theme, motion: "rich", home });
    localStorage.setItem("lishi.style", style); localStorage.setItem("lishi.theme", theme);
  }, { style, theme, home });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator(".world-open:visible, .shelf-book:visible").first().waitFor();
  await page.waitForTimeout(2000);
}

async function film(name, act) {
  const frames = [];
  await cdp.send("Animation.setPlaybackRate", { playbackRate: 1 / SLOW });
  await act();
  const start = Date.now();
  for (let i = 0; i < FRAMES; i++) {
    const file = path.join(out, `${style}-${theme}-${name}-${String(i).padStart(2, "0")}.png`);
    await page.screenshot({ path: file, scale: "css" });
    frames.push(file);
    const next = start + (i + 1) * STEP * SLOW;
    await page.waitForTimeout(Math.max(0, next - Date.now()));
  }
  await cdp.send("Animation.setPlaybackRate", { playbackRate: 1 });
  // One contact sheet: frames side by side, 7 to a row, labelled with their time.
  const sheet = await context.newPage();
  await sheet.setViewportSize({ width: 7 * 200, height: Math.ceil(FRAMES / 7) * 450 });
  await sheet.setContent(`<body style="margin:0;background:#222;display:grid;grid-template-columns:repeat(7,200px);font:12px sans-serif;color:#ddd">${frames.map((f, i) => `<figure style="margin:0;position:relative"><img src="data:image/png;base64,${fs.readFileSync(f).toString("base64")}" style="width:200px;height:434px;object-fit:cover;display:block"><figcaption style="position:absolute;top:4px;left:4px;background:#000a;padding:1px 4px">${i * STEP} ms</figcaption></figure>`).join("")}</body>`);
  await sheet.waitForTimeout(500);
  await sheet.screenshot({ path: path.join(out, `${style}-${theme}-${name}.png`), fullPage: true });
  await sheet.close();
  for (const f of frames) fs.rmSync(f);
  console.log(name);
}

await look("scene");
await film("open-scene", () => page.locator(".home-scene .continue-btn").click());
await page.locator(".play:visible .story .turn[data-node-id]").first().waitFor();
await page.waitForTimeout(1500);
await film("back", () => page.locator(".play:visible .topbar").getByRole("button", { name: "返回", exact: true }).click());
await look("shelf");
await film("open-shelf", () => page.locator(".shelf-book.featured").click());
await browser.close();
console.log("DONE");
