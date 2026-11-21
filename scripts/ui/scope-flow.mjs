// On the phone size: 改后同步 after a hand edit, and the 资料范围 page in
// AI 改写 (按原著纠错 / 按我的要求改), 查一查 and the 设定集.
// Start the isolated dev console and the fake model first (see play-check.mjs),
// with a story already played there (play-check leaves one), then run:
//   LISHI_BROWSER=/usr/bin/chromium node scripts/ui/scope-flow.mjs
// Screenshots and the report go to output/playwright/scope-flow/.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { launchBrowser } from "./browser.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const origin = process.env.LISHI_APP ?? "http://127.0.0.1:1421/";
const out = path.join(root, "output/playwright/scope-flow");
const timeout = Number(process.env.LISHI_UI_TIMEOUT_MS ?? 30000);
fs.mkdirSync(out, { recursive: true });

const results = [];
const errors = [];
const check = (name, ok, detail = "") => { results.push(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`); console.log(results.at(-1)); };
const step = (text) => console.log(`… ${text}`);

const browser = await launchBrowser(chromium, { headless: true });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true, serviceWorkers: "block" });
const page = await context.newPage();
page.on("pageerror", (e) => errors.push(e.message));
let shots = 0;
const shot = (name) => page.screenshot({ path: path.join(out, `${String(++shots).padStart(2, "0")}-${name}.png`) });
const sheet = () => page.locator(".sheet").last();
const finish = async (code) => {
  fs.writeFileSync(path.join(out, "report.md"), `# 改后同步与资料范围（手机尺寸）\n\n${new Date().toISOString()}\n\n${results.map((r) => `- ${r}`).join("\n")}\n`);
  await browser.close();
  process.exit(code);
};

async function openStory() {
  await page.goto(origin, { waitUntil: "domcontentloaded", timeout: 180000 });
  await page.locator(".home-scene, .shelf-book, .strip-card").first().click({ timeout: 120000 });
  await page.locator(".dock").waitFor({ timeout });
  await page.waitForTimeout(600);
}
async function longPressLatest() {
  const paragraph = page.locator(".turn[data-node-id]").last().locator(".story-text p").first();
  await paragraph.scrollIntoViewIfNeeded();
  const spot = await paragraph.boundingBox();
  const pointer = { pointerId: 31, pointerType: "touch", isPrimary: true, button: 0, clientX: spot.x + Math.min(spot.width / 2, 30), clientY: spot.y + Math.min(spot.height / 2, 12) };
  await paragraph.dispatchEvent("pointerdown", { ...pointer, buttons: 1, pressure: 0.5 });
  await page.waitForTimeout(700);
  await paragraph.dispatchEvent("pointerup", { ...pointer, buttons: 0, pressure: 0 });
}

try {
  step("opening the story");
  await openStory();

  // A book for this story and two notes, set up directly (the import screens have their own check).
  const ids = await page.evaluate(async () => {
    const { game } = window.__lishi;
    const { saveBook } = await import("/src/engine/sources/library.ts");
    const { newBinding } = await import("/src/engine/sources/types.ts");
    const { newNote, newStoryNote, saveNote } = await import("/src/engine/sources/notes.ts");
    const { cursor } = await import("/src/engine/tree.ts");
    const world = (await game.repo.listWorlds())[0];
    const bookId = crypto.randomUUID();
    await saveBook(game.repo, { id: bookId, title: "范围试读", format: "txt", createdAt: new Date().toISOString(),
      sections: Array.from({ length: 12 }, (_, i) => ({ title: `第${i + 1}章 渡口`, text: `第${i + 1}章：渡口的船夫说起青铜钥匙。`.repeat(i === 5 ? 3000 : 20) })) });
    await game.bindSource(world.id, { ...newBinding(bookId, true), position: 2 });
    const book = { ...newNote(bookId, "person", { subject: "船夫" }, "人物：船夫"), status: "done", content: "船夫守着渡口，知道钥匙的来历。", refs: [2, 3] };
    const story = { ...newStoryNote(world.id, "plot", { from: 0, to: 1 }, "主线梗概"), status: "done", content: "主角来到城里谋生。" };
    await saveNote(game.repo, book); await saveNote(game.repo, story);
    await window.__lishiFlush?.();
    return { worldId: world.id, head: (await cursor(game.repo, world.id)).head.id };
  });
  check("setup: a book is bound and two notes exist", !!ids.worldId);
  await openStory();

  // 1. 资料范围 in 按原著纠错.
  step("资料范围 in AI 改写");
  await longPressLatest();
  await sheet().locator(".sheet-menu > button", { hasText: "AI 改写" }).click();
  await sheet().getByRole("button", { name: "按原著纠错" }).click();
  const row = sheet().getByRole("button", { name: /^资料范围：自动/ });
  check("按原著纠错 shows 资料范围：自动", await row.isVisible());
  await shot("canon-row");
  await row.click();
  const page2 = sheet();
  await page2.getByRole("radio", { name: /自动（推荐）/ }).waitFor({ timeout });
  const radios = await page2.getByRole("radio").allTextContents();
  check("the page offers 自动, 只用指定札记, 原著指定章节", radios.length === 3 && radios[1].startsWith("只用指定札记") && radios[2].startsWith("原著指定章节"), radios.join(" | "));
  check("the page says it is for this time only", (await page2.textContent()).includes("只对这一次有效"));
  await page2.getByRole("radio", { name: /^只用指定札记/ }).click();
  await page2.getByText("人物：船夫").waitFor({ timeout });
  const listed = await page2.locator(".scope-notes legend").allTextContents();
  check("notes are grouped as 原著札记 and 本局札记", listed.join("、") === "原著札记、本局札记", listed.join("、"));
  check("用这个范围 waits until a note is ticked", await page2.getByRole("button", { name: "用这个范围" }).isDisabled());
  await page2.getByRole("checkbox").first().check();
  await shot("scope-notes");
  await page2.getByRole("radio", { name: /^原著指定章节/ }).click();
  await page2.getByLabel(/^从/).fill("3"); await page2.getByLabel(/^到/).fill("4");
  const small = await page2.locator("[aria-live=polite]").textContent();
  check("a short range is read whole", small.includes("第 3～4 章") && small.includes("会整段交给 AI"), small);
  await shot("scope-chapters-whole");
  await page2.getByLabel(/^到/).fill("6");
  const big = await page2.locator("[aria-live=polite]").textContent();
  check("a long range is searched, with the way to read it whole", big.includes("一次放不下") && big.includes("整理成一份札记"), big);
  await shot("scope-chapters-search");
  await page2.getByLabel(/^到/).fill("4");
  await page2.getByRole("button", { name: "用这个范围" }).click();
  check("the row shows the chosen chapters", await sheet().getByRole("button", { name: /^资料范围：第 3～4 章/ }).isVisible());
  await shot("canon-row-chosen");
  await sheet().locator(".sheet-close").click();
  await page.waitForTimeout(500);

  // 2. Opened again: 自动.
  await longPressLatest();
  await sheet().locator(".sheet-menu > button", { hasText: "AI 改写" }).click();
  await sheet().getByRole("button", { name: "按原著纠错" }).click();
  check("opened again, the scope is 自动", await sheet().getByRole("button", { name: /^资料范围：自动/ }).isVisible());
  // 按我的要求改 with a book offers it too; 只润色文字 does not.
  await sheet().getByRole("button", { name: "按我的要求改" }).click();
  check("按我的要求改 offers 资料范围 when a book is bound", await sheet().getByRole("button", { name: /^资料范围/ }).isVisible());
  await sheet().getByRole("button", { name: "只润色文字" }).click();
  check("只润色文字 has no 资料范围", !(await sheet().getByRole("button", { name: /^资料范围/ }).isVisible().catch(() => false)));
  await sheet().locator(".sheet-close").click();
  await page.waitForTimeout(500);

  // 3. 查一查.
  step("查一查");
  await page.getByRole("button", { name: "更多", exact: true }).click();
  await page.locator(".sheet-menu > button").filter({ hasText: "查一查" }).first().click();
  check("查一查 offers 资料范围", await sheet().getByRole("button", { name: /^资料范围：自动/ }).isVisible());
  await shot("ask-row");
  await sheet().locator(".sheet-close").click();
  await page.waitForTimeout(400);

  // 4. 改后同步: a hand edit asks whether the facts change too.
  step("改后同步");
  await longPressLatest();
  await sheet().locator(".sheet-menu > button", { hasText: "更多" }).click();
  await sheet().locator(".sheet-menu > button", { hasText: "自己改写这段文字" }).click();
  const box = sheet().locator("textarea").first();
  const before = await box.inputValue();
  await box.fill(`${before}\n你把腰间的匕首换成了短剑。`);
  await sheet().getByRole("button", { name: /^保存/ }).click();
  await page.getByText("这段的事实也要一起改吗？").waitFor({ timeout });
  const ask = await sheet().textContent();
  check("saving an edit asks whether the facts change too", ask.includes("只改文字") && ask.includes("事实也一起改") && ask.includes("取消，不保存"), ask.slice(0, 120));
  await shot("fact-ask");
  await sheet().getByRole("button", { name: "事实也一起改" }).click();
  await sheet().getByRole("button", { name: "采用" }).waitFor({ timeout: timeout * 2 });
  const preview = await sheet().textContent();
  check("the sync preview says what changed and where it lands", preview.includes("匕首改为短剑") && preview.includes("另一个版本"), preview.slice(0, 200));
  await shot("fact-preview");
  await sheet().getByRole("button", { name: "采用" }).click();
  await page.waitForTimeout(800);
  // The route ends on the player's own edit made again (the book bound after the passage).
  const latest = await page.locator(".turn .story-text").last().textContent();
  check("the edited text is kept exactly", latest.includes("你把腰间的匕首换成了短剑。"), latest.slice(-40));
  await page.getByRole("button", { name: "角色", exact: true }).click();
  await page.locator(".panel").waitFor({ timeout });
  await page.getByRole("tab", { name: "设定" }).click();
  await page.waitForTimeout(400);
  const codex = await page.locator(".panel").textContent();
  check("the 设定集 follows the edit", codex.includes("短剑一把"), codex.slice(0, 120));
  // 5. 资料范围 next to the 设定集's AI tools.
  check("设定集 AI 整理 offers 资料范围 when 参考原著 is on", await page.locator(".panel").getByRole("button", { name: /^资料范围/ }).first().isVisible());
  await shot("codex-row");
} catch (error) {
  check("flow finished", false, String(error?.message ?? error).slice(0, 300));
  await shot("error").catch(() => {});
}
check("no page errors", errors.length === 0, errors.join(" | "));
await finish(results.some((r) => r.startsWith("FAIL")) ? 1 : 0);
