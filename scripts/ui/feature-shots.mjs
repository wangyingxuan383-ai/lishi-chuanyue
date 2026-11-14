// Screens of the newer features for review (generation tiers, 原著札记, 每段用量, 让 AI 改, 通知与提醒,
// the two home designs): phone size, against the isolated dev console and the
// fake model, after play-check has made a story there.
//   node scripts/ui/feature-shots.mjs [scroll|ink] [paper|night]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { launchBrowser } from "./browser.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const origin = "http://127.0.0.1:1421";
const [style = "scroll", theme = "paper"] = process.argv.slice(2);
const out = path.join(root, "output/playwright/feature-shots");
fs.mkdirSync(out, { recursive: true });
const marker = await (await fetch(`${origin}/__ui-isolation`)).json();
if (marker.databaseDir !== ".cache/ui-isolated" || marker.loopbackOnly !== true) throw new Error("not the isolated dev console; refusing");

const browser = await launchBrowser(chromium);
const page = await browser.newPage({ viewport: { width: 393, height: 852 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
page.setDefaultTimeout(Number(process.env.LISHI_UI_TIMEOUT_MS ?? 45_000));
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
const tag = `${style}-${theme}`;
const shot = async (name) => { await page.screenshot({ path: path.join(out, `${tag}-${name}.png`) }); console.log(name); };
const settle = (ms = 700) => page.waitForTimeout(ms);
const sheet = () => page.locator(".sheet-layer:not(.closing) .sheet").last();
const closeSheets = async () => {
  for (let i = 0; i < 6 && await page.locator(".sheet-layer:not(.closing)").count(); i++) {
    await page.locator(".sheet-layer:not(.closing) .sheet-close").last().click().catch(() => page.keyboard.press("Escape"));
    await settle(450);
  }
};

async function look(home) {
  await page.goto(`${origin}/`, { waitUntil: "domcontentloaded", timeout: 180_000 });
  await page.waitForFunction(() => window.__lishi?.game, null, { timeout: 180_000 });
  await page.evaluate(async ({ style, theme, home }) => {
    const repo = window.__lishi.game.repo;
    const reading = await repo.getSetting("reading", {});
    await repo.setSetting("reading", { ...reading, style, theme, motion: "rich", home });
    localStorage.setItem("lishi.style", style); localStorage.setItem("lishi.theme", theme);
  }, { style, theme, home });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator(".world-open:visible, .shelf-book:visible").first().waitFor();
  await settle(1400);
}

// A small book bound to the first story, so 札记 and 让 AI 改 have something to read.
const worldId = await (async () => {
  await look("scene");
  return page.evaluate(async () => {
    const game = window.__lishi.game;
    const { saveBook, listBooks } = await import("/src/engine/sources/library.ts");
    const { newBinding } = await import("/src/engine/sources/types.ts");
    const world = (await game.repo.listWorlds())[0];
    let book = (await listBooks(game.repo)).find((b) => b.title === "灯下书");
    if (!book) {
      book = { id: crypto.randomUUID(), title: "灯下书", format: "txt", createdAt: new Date().toISOString(), sections: [
        { title: "第一章 灯", text: "阿青在青石桥经营书铺。她守信，不愿出卖朋友。青铜钥匙藏在灯座下。".repeat(30) },
        { title: "第二章 信", text: "阿青把青铜钥匙交给阿白，二人约定救下阿兰。".repeat(30) },
        { title: "第三章 雪", text: "雪夜里，阿白其实是北地王子。".repeat(30) },
      ] };
      await saveBook(game.repo, book);
    }
    await game.bindSource(world.id, { ...newBinding(book.id, true), position: 1 }).catch(() => {});
    // A few more stories, so the shelf and the strip look like a player's.
    const worlds = await game.repo.listWorlds();
    if (worlds.length < 5) {
      const line = await game.repo.getLine(world.currentLineId);
      const state = await game.repo.getState(line.nodeId);
      for (const [title, hour] of [["长安米价", 18], ["汴京小吏", 22], ["雪夜书铺", 6], ["江湖夜雨", 12]].slice(0, 5 - worlds.length)) {
        await game.repo.createWorld({ title, eraId: world.eraId, settings: world.settings, opening: { parentId: null, kind: "opening", narrative: `${title}的开场。夜色压下来，街上的灯一盏盏亮了。`, state: { ...state, time: { ...state.time, startHour: hour } }, meta: {} } });
      }
    }
    return world.id;
  });
})();

for (const home of ["scene", "shelf"]) {
  await look(home);
  await shot(`home-${home}`);
  await page.evaluate(() => document.querySelector(".screen-body")?.scrollTo(0, 99999));
  await settle(400); await shot(`home-${home}-below`);
}
// The open flourish, caught part-way (both designs).
for (const home of ["scene", "shelf"]) {
  await look(home);
  const target = home === "scene" ? page.locator(".home-scene .continue-btn") : page.locator(".shelf-book.featured");
  await target.click();
  await page.waitForTimeout(home === "scene" ? 240 : 380); await shot(`open-${home}-mid`);
  await page.locator(".play:visible .story .turn[data-node-id]").first().waitFor();
  await settle(900);
}

// In the story: the tier badge, the usage line, the tier sheet.
await page.locator(".play:visible .story").evaluate((el) => { el.scrollTop = el.scrollHeight; });
await settle(600); await shot("play-usage");
await page.locator(".play:visible .depth-btn").click(); await settle(); await shot("depth-sheet");
await closeSheets();
// 原著札记: list, new, running/done.
await page.locator(".play:visible .topbar").getByRole("button", { name: "更多", exact: true }).click(); await settle();
await shot("menu");
await page.getByRole("button", { name: /原著札记/ }).click(); await settle(); await shot("notes-empty");
await sheet().getByRole("button", { name: "新建札记" }).click(); await settle(); await shot("notes-new");
await sheet().getByRole("radio", { name: /人物/ }).click();
await sheet().getByLabel(/人物名字/).fill("阿青"); await settle(1200); await shot("notes-new-person");
await sheet().getByRole("button", { name: "开始整理" }).click();
await page.waitForFunction(() => document.querySelector(".note-text"), null, { timeout: 60_000 }).catch(() => {});
await settle(); await shot("notes-done");
await closeSheets();
// 本局用量.
await page.locator(".play:visible .topbar").getByRole("button", { name: "更多", exact: true }).click(); await settle();
await page.getByRole("button", { name: /本局用量/ }).click(); await settle(); await shot("usage-world");
await closeSheets();
// 让 AI 改: time and currency.
await page.locator(".play:visible .topbar button.title").click(); await settle();
await sheet().getByRole("button", { name: /修改.*货币/ }).click(); await settle();
await sheet().locator("details.ai-revise > summary").click();
await sheet().locator("details.ai-revise textarea").fill("改用斗罗历，货币换成魂币");
await sheet().getByRole("button", { name: "让 AI 改" }).click();
await page.waitForFunction(() => document.querySelector(".ai-revise .field-hint"), null, { timeout: 60_000 }).catch(() => {});
await settle(); await shot("revise-rules");
await sheet().getByRole("button", { name: /^保存$/ }).click().catch(() => {});
await settle(600);
await closeSheets();
// The settings pages: 游玩默认 (tier), 阅读与外观 (home design), 通知与提醒.
await page.locator(".play:visible .topbar").getByRole("button", { name: "返回", exact: true }).click(); await settle();
await page.getByRole("button", { name: /^设置/ }).click(); await settle();
await page.getByRole("button", { name: /^游玩默认/ }).click(); await settle(); await shot("settings-play");
await page.getByRole("button", { name: "返回", exact: true }).click(); await settle(300);
await page.getByRole("button", { name: /^阅读与外观/ }).click(); await settle();
await page.evaluate(() => document.querySelector(".screen-body")?.scrollTo(0, 99999)); await settle(300); await shot("settings-reading");
await browser.close();
console.log(`DONE ${tag} errors=${errors.length}${errors.length ? `\n${errors.join("\n")}` : ""}`);
