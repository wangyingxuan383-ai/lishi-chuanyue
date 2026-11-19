// On the phone size: 本局札记 (new, 更新到现在), the passage's
// 参考的札记, 撤销 puts the action back, 整理状况, 速度 and 备用服务 settings.
// Start the isolated dev console and the fake model first (see play-check.mjs),
// with a story already played there (play-check leaves one), then run:
//   LISHI_BROWSER=/usr/bin/chromium node scripts/ui/notes-flow.mjs
// Screenshots and the report go to output/playwright/notes-flow/.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { launchBrowser } from "./browser.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const origin = process.env.LISHI_APP ?? "http://127.0.0.1:1421/";
const out = path.join(root, "output/playwright/notes-flow");
const timeout = Number(process.env.LISHI_UI_TIMEOUT_MS ?? 30000);
fs.mkdirSync(out, { recursive: true });

const results = [];
const errors = [];
const check = (name, ok, detail = "") => { results.push(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`); console.log(results.at(-1)); };
const step = (text) => console.log(`… ${text}`);

const browser = await launchBrowser(chromium, { headless: true });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true, serviceWorkers: "block" });
await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: new URL(origin).origin }).catch(() => {});
const page = await context.newPage();
page.on("pageerror", (e) => errors.push(e.message));
let shots = 0;
const shot = (name) => page.screenshot({ path: path.join(out, `${String(++shots).padStart(2, "0")}-${name}.png`) });
const sheet = () => page.locator(".sheet").last();
const finish = async (code) => {
  fs.writeFileSync(path.join(out, "report.md"), `# 札记与第二步功能（手机尺寸）\n\n${new Date().toISOString()}\n\n${results.map((r) => `- ${r}`).join("\n")}\n`);
  await browser.close();
  process.exit(code);
};

async function openStory() {
  await page.goto(origin, { waitUntil: "domcontentloaded", timeout: 180000 });
  await page.locator(".home-scene, .shelf-book, .strip-card").first().click({ timeout: 120000 });
  await page.locator(".dock").waitFor({ timeout });
  await page.waitForTimeout(600);
}
async function openMore(label) {
  await page.getByRole("button", { name: "更多", exact: true }).click();
  await page.locator(".sheet-menu > button").filter({ hasText: label }).first().click();
}
async function play(action) {
  const before = await page.locator(".turn").count();
  await page.locator(".dock textarea").first().fill(action);
  await page.locator(".dock .send-btn").first().click();
  await page.waitForFunction((n) => document.querySelectorAll(".turn").length > n && !document.querySelector(".writing-turn"), before, { timeout: timeout * 2 });
  await page.waitForTimeout(500);
}

try {
  step("opening the story");
  await openStory();

  // 1. 本局札记: new 主线梗概, written by the (fake) auxiliary model.
  await openMore("札记");
  await sheet().waitFor({ timeout });
  const intro = await sheet().textContent();
  check("札记 opens on 本局, in words about this story", intro.includes("从这局已经写出的故事里整理"), intro.slice(0, 80));
  await shot("notes-empty");
  await sheet().getByRole("button", { name: "新建札记" }).click();
  const kinds = await sheet().locator(".note-kind b").allTextContents();
  check("story note kinds read as this story's", kinds.join("、") === "主线梗概、人物、地点或势力、时间线、问一个问题", kinds.join("、"));
  await shot("notes-new");
  await sheet().getByRole("button", { name: "开始整理" }).click();
  await sheet().getByText(/已整理到/).first().waitFor({ timeout: timeout * 2 });
  const detail = await sheet().textContent();
  check("主线梗概 is written and says how far it reaches", detail.includes("已整理到") && detail.includes("写作时使用"), detail.slice(0, 120));
  await shot("notes-done");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);

  // 2. One more passage: 参考的札记 in its changes; the note can be updated to now.
  step("playing a passage");
  await play("四处看看");
  const changes = page.locator(".turn-changes").last();
  if (await changes.count()) {
    await changes.click();
    await sheet().waitFor({ timeout });
    const text = await sheet().textContent();
    check("the passage's changes list the notes it used", text.includes("写这段时参考的札记") && text.includes("主线梗概"), text.slice(0, 160));
    await shot("changes-notes");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);
  } else check("the passage's changes list the notes it used", false, "no change line");
  await openMore("札记");
  await sheet().locator(".note-row").last().click();
  const update = sheet().getByRole("button", { name: /^更新到现在/ });
  check("a story note behind the story offers 更新到现在", await update.isVisible(), await update.textContent().catch(() => ""));
  await update.click();
  await sheet().getByRole("button", { name: "恢复上一版" }).waitFor({ timeout: timeout * 2 });
  check("after 更新到现在 the previous version can be restored", true);
  await shot("notes-updated");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);

  // 3. 撤销 puts the action back in the box.
  step("undo");
  await page.getByRole("button", { name: /^撤销/ }).first().click().catch(async () => {
    await page.locator(".turn").last().click();
    await page.getByRole("button", { name: /撤销/ }).first().click();
  });
  await page.locator(".toast", { hasText: "已撤销" }).waitFor({ timeout });
  const toast = await page.locator(".toast").last().textContent();
  const box = await page.locator(".dock textarea").first().inputValue();
  check("撤销 puts the action back in the box", box === "四处看看" && toast.includes("放回了输入框"), `${toast} / ${box}`);
  await shot("undo-back");
  await page.locator(".dock textarea").first().fill("");

  // 3b. AI 改写 → 按我的要求改: three ways, the content changes, the 设定集 follows.
  step("AI 改写");
  await play("开始吸收魂环");
  // A touch long press on the latest passage, as play-check does.
  const paragraph = page.locator(".turn[data-node-id]").last().locator(".story-text p").first();
  await paragraph.scrollIntoViewIfNeeded();
  const spot = await paragraph.boundingBox();
  const pointer = { pointerId: 27, pointerType: "touch", isPrimary: true, button: 0, clientX: spot.x + Math.min(spot.width / 2, 30), clientY: spot.y + Math.min(spot.height / 2, 12) };
  await paragraph.dispatchEvent("pointerdown", { ...pointer, buttons: 1, pressure: 0.5 });
  await page.waitForTimeout(700);
  await paragraph.dispatchEvent("pointerup", { ...pointer, buttons: 0, pressure: 0 });
  await sheet().locator(".sheet-menu > button", { hasText: "AI 改写" }).click();
  await sheet().waitFor({ timeout });
  const modes = await sheet().locator(".segmented[aria-label=怎么改] button").allTextContents();
  check("AI 改写 offers 按我的要求改 first", modes[0] === "按我的要求改" && modes.includes("只润色文字"), modes.join("、"));
  check("按我的要求改 is chosen by default", (await sheet().getByRole("button", { name: "按我的要求改" }).getAttribute("aria-pressed")) === "true");
  await sheet().getByLabel("希望怎么改").fill("魂环是紫紫，现在是二环，正在吸收第三环");
  await shot("revise-sheet");
  await sheet().getByRole("button", { name: "生成改稿" }).click();
  await sheet().getByRole("button", { name: "采用改稿" }).waitFor({ timeout: timeout * 2 });
  const revised = await sheet().textContent();
  check("the preview says what changed and that earlier settings follow", revised.includes("魂环改为两个紫环") && revised.includes("之前的设定一起改正"), revised.slice(0, 160));
  await shot("revise-preview");
  await sheet().getByRole("button", { name: "采用改稿" }).click();
  await page.locator(".toast", { hasText: "已按你的要求改好" }).waitFor({ timeout });
  check("采用 keeps the old wording as another version", (await page.locator(".turn").last().textContent()).includes("按要求改过的这段"));
  await shot("revise-adopted");
  await page.getByRole("button", { name: "角色", exact: true }).click();
  await page.locator(".panel").waitFor({ timeout });
  await page.getByRole("tab", { name: "设定" }).click();
  await page.waitForTimeout(400);
  const codex = await page.locator(".panel").textContent();
  check("the 设定集 shows the protagonist's 本事 card from the revision", /的本事/.test(codex) && codex.includes("千年紫环"), codex.slice(0, 160));
  await shot("ability-card");
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await openStory();

  // 4. 整理状况 in the character panel (only when there is a status).
  step("character panel");
  await page.getByRole("button", { name: "角色", exact: true }).click();
  await page.locator(".panel").waitFor({ timeout });
  const tidy = page.getByRole("button", { name: "看看哪些已经好了" });
  if (await tidy.isVisible().catch(() => false)) {
    await tidy.click();
    await sheet().waitFor({ timeout });
    await sheet().getByText(/AI 认为这些可以去掉|看下来都还在|没有给出结果/).first().waitFor({ timeout: timeout * 2 });
    check("整理状况 answers in a sheet", true, (await sheet().textContent()).slice(0, 80));
    await shot("status-tidy");
    await page.keyboard.press("Escape");
  } else check("整理状况 is offered only with a status (none here)", true);
  await page.goto(origin, { waitUntil: "domcontentloaded" });

  // 5. Settings: 速度 under 用量与花费, the 主线梗概 switch, the reminder sound.
  step("settings");
  await page.getByRole("button", { name: /^设置/ }).click();
  await page.getByRole("button", { name: /^用量与花费/ }).first().click();
  await page.getByRole("heading", { name: "速度" }).waitFor({ timeout });
  await page.getByText(/^最近 \d+ 段/).waitFor({ timeout });
  const speed = await page.locator("body").textContent();
  check("速度 sums the recent passages by step", speed.includes("最近") && speed.includes("写作"), speed.slice(speed.indexOf("速度"), speed.indexOf("速度") + 120));
  await page.getByRole("heading", { name: "速度" }).scrollIntoViewIfNeeded();
  await shot("speed");
  await page.goBack().catch(() => {});
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: /^设置/ }).click();
  await page.getByRole("button", { name: /^记忆与整理/ }).first().click();
  check("记忆与整理 has the 本局主线梗概 switch", await page.getByText("本局主线梗概").isVisible());
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: /^设置/ }).click();
  // 通知与提醒 is a phone page; the browser shows it in 开发者模式 only.
  const notify = page.getByRole("button", { name: /^通知与提醒/ }).first();
  if (await notify.isVisible().catch(() => false)) {
    await notify.click();
    check("通知与提醒 has the reminder sound", await page.getByText("提醒的声音").first().isVisible());
    await shot("notify");
  } else check("通知与提醒 is a phone page (hidden in the browser by design)", true);
} catch (error) {
  check("flow finished", false, String(error?.message ?? error).slice(0, 300));
  await shot("error").catch(() => {});
}
check("no page errors", errors.length === 0, errors.join(" | "));
await finish(results.some((r) => r.startsWith("FAIL")) ? 1 : 0);
