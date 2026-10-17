// R10-T001: the play screen in a wide desktop window. The character panel
// stays docked beside the story, Enter sends and Shift+Enter starts a new
// line, sheets keep a readable width; a narrow window falls back to the phone
// layout (Enter still sends with a keyboard and mouse).
//   node scripts/fake-llm.mjs & pnpm dev &  node scripts/ui/desktop.mjs
import { connectFake } from "./connect.mjs";
import { mkdirSync } from "node:fs";
import { chromium } from "playwright-core";

let failed = 0;
const check = (name, ok) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
  if (!ok) failed++;
};

mkdirSync(".cache/ui", { recursive: true });
const browser = await chromium.launch({ channel: "msedge" });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
await page.goto((process.env.LISHI_APP ?? "http://127.0.0.1:1420/"));
await page.getByText("连接 AI 服务").waitFor();
await connectFake(page);
await page.waitForFunction(() => !!window.__lishi);
await page.evaluate(async () => {
  const repo = window.__lishi.game.repo;
  const state = { version: 2, time: { start: "天宝七载 冬月十七", elapsedMinutes: 600 }, placeId: null,
    protagonist: { name: "李安", aliases: [], age: 22, gender: "男", identity: "落第举子", origin: "", cheat: "", stats: { money: 300, debt: 0, health: 80, energy: 70, fame: 10 },
      statuses: [{ name: "风寒", detail: "咳嗽", sinceMinute: 0 }], items: [{ name: "旧书箱", quantity: 1, unit: "只", place: null, note: "" }] },
    people: [{ id: "p1", name: "王掌柜", aliases: [], role: "书肆店主", attitude: "友好", alive: true, notes: "答应借住三日", lastSeenMinute: 600 }],
    places: [], cards: [], goals: [{ id: "g1", name: "凑足回乡的盘缠", kind: "主线", progress: "还差两贯", status: "进行中" }], era: { packId: "tang-748" }, deviations: [] };
  const { world, line, node } = await repo.createWorld({ title: "宽屏", eraId: "tang-748", opening: { parentId: null, kind: "opening", narrative: "长安的雪下了一夜。".repeat(20), state } });
  let parent = node.id;
  for (let i = 1; i <= 3; i++) {
    parent = (await repo.appendNode(world.id, line.id, { parentId: parent, kind: "turn", actionMode: "do", actionText: `第${i}步`, narrative: `第${i}段。王掌柜把门板卸下一块。`.repeat(8), state, choices: ["去西市", "回书肆"] })).id;
  }
});
await page.waitForTimeout(1500); // the harness saves one second after the last write
await page.reload();
await page.locator(".card", { hasText: "宽屏" }).click();
await page.locator(".turn").last().waitFor();

const side = page.getByRole("complementary", { name: "角色" });
check("the character panel is open beside the story", await side.isVisible());
check("no separate 我 button on a wide window", (await page.getByRole("button", { name: "角色" }).count()) === 0);
const story = await page.locator(".story").boundingBox();
const panel = await side.boundingBox();
check("story and panel sit side by side", !!story && !!panel && story.x + story.width <= panel.x + 1 && panel.width >= 360);
check("the window does not scroll; story and panel scroll on their own", await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth && document.documentElement.scrollHeight <= window.innerHeight));
const bar = await page.locator(".inputbar").boundingBox();
check("the input bar is on screen without scrolling", !!bar && bar.y + bar.height <= 800);
await side.getByRole("tab", { name: "人物" }).click();
check("panel tabs work while docked", await side.getByText("王掌柜").first().isVisible());
await page.screenshot({ path: ".cache/ui/desktop-wide.png" });

const box = page.locator(".inputbar textarea");
await box.click();
await box.pressSequentially("看看雪");
await box.press("Shift+Enter");
await box.pressSequentially("再走");
check("Shift+Enter starts a new line", (await box.inputValue()) === "看看雪\n再走");
const turns = await page.locator(".turn").count();
await box.press("Enter");
await page.waitForFunction((n) => document.querySelectorAll(".turn").length > n, turns, { timeout: 30000 }).catch(() => {});
check("Enter sends the action", (await page.locator(".turn").count()) > turns && (await box.inputValue()) === "");
check("the input box shrinks back after sending", ((await box.boundingBox())?.height ?? 99) < 50);
await page.locator(".send-btn.primary").waitFor({ timeout: 30000 });
await page.screenshot({ path: ".cache/ui/desktop-after-turn.png" });
// The box keeps focus after Enter; the next choices still show while it is empty (review of 0.8.0).
check("the next choices show after Enter, with the box still focused", await box.evaluate((el) => el === document.activeElement) && (await page.locator(".choices button").count()) > 0);
await box.pressSequentially("想");
check("typing hides the choices", (await page.locator(".choices").count()) === 0);
await box.fill("");

// Editing beside the story while a turn is played: saving keeps what the turn did (review of 0.8.0).
const headState = () => page.evaluate(async () => {
  const { game } = window.__lishi;
  const world = (await game.repo.listWorlds()).find((w) => w.title === "宽屏");
  const line = await game.repo.getLine(world.currentLineId);
  return (await game.repo.getState(line.nodeId)).protagonist.stats;
});
const moneyBefore = (await headState()).money;
await side.getByRole("tab", { name: "我" }).click();
await side.getByRole("button", { name: "修改" }).click();
await side.getByLabel("精力").fill("50");
const turnsBeforeEdit = await page.locator(".turn").count();
await box.click();
await box.pressSequentially("先付三十文");
await box.press("Enter");
await page.waitForFunction((n) => document.querySelectorAll(".turn").length > n, turnsBeforeEdit, { timeout: 30000 }).catch(() => {});
await page.locator(".send-btn.primary").waitFor({ timeout: 30000 });
const paid = (await headState()).money;
await side.getByRole("button", { name: "保存修改" }).click();
await side.getByRole("button", { name: "修改" }).waitFor({ timeout: 5000 }).catch(() => {});
const after = await headState();
check("a turn played while editing pays, and saving the edit keeps it", paid === moneyBefore - 30 && after.money === paid && after.energy === 50);
await page.getByRole("button", { name: "更多" }).click();
const sheet = await page.locator(".sheet").boundingBox();
check("sheets keep a readable width and stay centred", !!sheet && sheet.width <= 600 && Math.abs(sheet.x + sheet.width / 2 - 640) < 2);
await page.screenshot({ path: ".cache/ui/desktop-sheet.png" });
await page.keyboard.press("Escape");
await page.locator(".backdrop").click({ position: { x: 20, y: 20 } }).catch(() => {});
await page.locator(".sheet").waitFor({ state: "detached", timeout: 5000 }).catch(() => {});

await page.setViewportSize({ width: 700, height: 800 });
await page.waitForTimeout(300);
check("a narrow window hides the docked panel", (await side.count()) === 0);
check("a narrow window shows the 我 button again", await page.getByRole("button", { name: "角色" }).isVisible());
await page.getByRole("button", { name: "角色" }).click();
check("the panel opens over the story when narrow", await page.getByRole("dialog", { name: "角色" }).isVisible());
await page.getByRole("button", { name: "关闭" }).click();
const before = await page.locator(".turn").count();
await box.click();
await box.pressSequentially("回书肆");
await box.press("Enter");
await page.waitForFunction((n) => document.querySelectorAll(".turn").length > n, before, { timeout: 30000 }).catch(() => {});
check("Enter still sends in a narrow window with a keyboard", (await page.locator(".turn").count()) > before);
check("no page errors", errors.length === 0);
if (errors.length) console.log(errors.slice(0, 3).join("\n"));
await browser.close();
process.exit(failed ? 1 : 0);
