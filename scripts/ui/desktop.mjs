// R10-T001: the play screen in a wide desktop window. The character panel
// stays docked beside the story, Enter sends and Shift+Enter starts a new
// line, sheets keep a readable width; a narrow window falls back to the phone
// layout (Enter still sends with a keyboard and mouse). Keyboard shortcuts,
// right-click menus, hover hints and dropping a world file (PLAN_V4 E).
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

// Desktop shortcuts, right click and hover hints (PLAN_V4 direction E).
const sheetOpen = () => page.locator(".sheet").count().then((n) => n > 0);
const closeSheet = async () => {
  await page.keyboard.press("Escape");
  await page.locator(".sheet").waitFor({ state: "detached", timeout: 5000 }).catch(() => {});
};
await page.locator(".story").click({ position: { x: 5, y: 5 } });
await page.keyboard.press("?");
check("? opens the 快捷键 sheet", await page.getByRole("dialog", { name: "快捷键" }).isVisible());
await page.waitForTimeout(400);
await page.screenshot({ path: ".cache/ui/desktop-shortcuts.png" });
await closeSheet();
check("Esc closes the 快捷键 sheet", !(await sheetOpen()));
await box.click();
await page.keyboard.press("Control+/");
check("Ctrl+/ opens it even from the input box", await page.getByRole("dialog", { name: "快捷键" }).isVisible());
await closeSheet();
await page.getByRole("button", { name: "更多" }).click();
check("the ⋯ menu lists 快捷键 and shows the shortcut next to 撤销", (await page.locator(".sheet-menu button", { hasText: /^快捷键$/ }).count()) === 1 && (await page.locator(".sheet-menu button", { hasText: "撤销（Ctrl+Z）" }).count()) === 1);
await page.locator(".sheet-menu button", { hasText: /^快捷键$/ }).click();
check("the ⋯ menu entry opens the 快捷键 sheet", await page.getByRole("dialog", { name: "快捷键" }).isVisible());
await closeSheet();

await page.locator(".story").click({ position: { x: 5, y: 5 } });
await page.keyboard.press("/");
check("/ puts the cursor in the input box", await box.evaluate((el) => el === document.activeElement) && (await box.inputValue()) === "");
await page.locator(".story").click({ position: { x: 5, y: 5 } });
await page.keyboard.press("Control+k");
check("Ctrl+K puts the cursor in the input box", await box.evaluate((el) => el === document.activeElement));
await box.pressSequentially("问路/?");
check("typing / and ? in the box stays typing", (await box.inputValue()) === "问路/?" && !(await sheetOpen()));
await box.fill("");

await page.keyboard.press("Control+f");
check("Ctrl+F opens 查一查, even from the input box", await page.getByRole("dialog", { name: "查一查" }).isVisible());
await closeSheet();

// Ctrl+Z / Ctrl+Y: undo and redo the last turn.
const headId = () => page.evaluate(async () => {
  const { game } = window.__lishi;
  const world = (await game.repo.listWorlds()).find((w) => w.title === "宽屏");
  return (await game.repo.getLine(world.currentLineId)).nodeId;
});
const headBefore = await headId();
await page.locator(".story").click({ position: { x: 5, y: 5 } });
await page.keyboard.press("Control+z");
await page.locator(".toast", { hasText: "已撤销" }).waitFor({ timeout: 5000 }).catch(() => {});
const afterUndo = await headId();
check("Ctrl+Z undoes the last turn", afterUndo !== headBefore && (await page.locator(".toast", { hasText: "已撤销" }).count()) === 1);
await page.keyboard.press("Control+y");
await page.locator(".toast", { hasText: "已重做" }).waitFor({ timeout: 5000 }).catch(() => {});
check("Ctrl+Y redoes it", (await headId()) === headBefore);
await page.keyboard.press("Control+z");
await page.locator(".toast", { hasText: "已撤销" }).waitFor({ timeout: 5000 }).catch(() => {});
await page.keyboard.press("Control+Shift+Z");
await page.waitForFunction(async (id) => {
  const { game } = window.__lishi;
  const world = (await game.repo.listWorlds()).find((w) => w.title === "宽屏");
  return (await game.repo.getLine(world.currentLineId)).nodeId === id;
}, headBefore, { timeout: 5000 }).catch(() => {});
check("Ctrl+Shift+Z redoes too", (await headId()) === headBefore);
await box.click();
await box.pressSequentially("写到一半");
await page.keyboard.press("Control+z");
check("Ctrl+Z inside the input box undoes typing, not the turn", (await headId()) === headBefore);
await box.fill("");

// Ctrl+R: 重说 makes a second version.
await page.locator(".story").click({ position: { x: 5, y: 5 } });
await page.keyboard.press("Control+r");
await page.locator(".turn-tools span", { hasText: "2/2" }).waitFor({ timeout: 30000 }).catch(() => {});
check("Ctrl+R says the passage again (no page reload)", (await page.locator(".turn-tools span", { hasText: "2/2" }).count()) === 1 && !!(await page.evaluate(() => window.__lishi)));
await page.locator(".send-btn.primary").waitFor({ timeout: 30000 });

// Alt+1 picks the first suggested action.
const firstChoice = await page.locator(".choices button").first().textContent();
const turnsBeforeAlt = await page.locator(".turn").count();
await page.locator(".story").click({ position: { x: 5, y: 5 } });
await page.keyboard.press("Alt+1");
await page.waitForFunction((n) => document.querySelectorAll(".turn").length > n, turnsBeforeAlt, { timeout: 30000 }).catch(() => {});
check("Alt+1 picks the first suggested action", (await page.locator(".turn-action").last().textContent()) === firstChoice);
await page.locator(".send-btn.primary").waitFor({ timeout: 30000 });

// Ctrl+Enter sends in 写 mode too.
await page.getByRole("button", { name: /^输入方式：/ }).click();
await page.locator(".sheet .mode-option", { hasText: "写" }).first().click();
const turnsBeforeCtrlEnter = await page.locator(".turn").count();
await box.pressSequentially("雪停了。");
await box.press("Control+Enter");
await page.waitForFunction((n) => document.querySelectorAll(".turn").length > n, turnsBeforeCtrlEnter, { timeout: 30000 }).catch(() => {});
check("Ctrl+Enter sends", (await page.locator(".turn").count()) > turnsBeforeCtrlEnter && (await box.inputValue()) === "");
await page.locator(".send-btn.primary").waitFor({ timeout: 30000 });

// Right click on a passage opens its menu; on a button inside it does not.
await page.locator(".turn").first().click({ button: "right", position: { x: 40, y: 20 } });
check("right click on a passage opens its menu", await page.locator(".sheet .sheet-menu button", { hasText: "加书签" }).isVisible());
await closeSheet();

// Hover hints on icon-only buttons.
const title = (name) => page.getByRole("button", { name, exact: true }).first().getAttribute("title");
check("icon buttons have hover hints", (await title("返回")) === "返回（Esc）" && (await title("更多")) === "更多" && !!(await title("这一段还能做什么")) && (await title("重说"))?.includes("Ctrl+R"));
check("suggested actions show their Alt key", ((await page.locator(".choices button").first().getAttribute("title")) ?? "").startsWith("Alt+1"));

// F1 opens the guide, Ctrl+, the settings; Esc comes back.
await page.locator(".story").click({ position: { x: 5, y: 5 } });
await page.keyboard.press("F1");
check("F1 opens the play guide", await page.getByRole("heading", { name: "游玩指南" }).isVisible());
await page.keyboard.press("Escape");
await page.locator(".inputbar").waitFor({ timeout: 5000 });
await page.keyboard.press("Control+,");
check("Ctrl+, opens the settings", await page.getByRole("heading", { name: "设置" }).isVisible().catch(() => false));
await page.keyboard.press("Escape");
await page.locator(".inputbar").waitFor({ timeout: 5000 });

// Home: right click a world card opens its menu.
await page.getByRole("button", { name: "返回" }).click();
await page.locator(".world-card").first().waitFor();
await page.locator(".world-open").first().click({ button: "right" });
check("right click on a home world card opens its menu", await page.locator(".sheet .sheet-menu button", { hasText: "改名" }).isVisible());
await closeSheet();
await page.keyboard.press("F1");
check("F1 opens the guide from home too", await page.getByRole("heading", { name: "游玩指南" }).isVisible());
await page.keyboard.press("Escape");

// Drop a world file onto the window: it is imported (as a copy, since it is already here).
await page.locator(".world-card").first().waitFor();
const worldsBefore = await page.locator(".world-card").count();
const exported = await page.evaluate(async () => {
  const { game } = window.__lishi;
  const world = (await game.repo.listWorlds()).find((w) => w.title === "宽屏");
  const rows = (sql) => game.platform.sql.query(sql, [world.id]);
  return JSON.stringify({ format: "lishi-world", version: 1, exportedAt: new Date().toISOString(), world: (await rows("SELECT * FROM worlds WHERE id = ?"))[0],
    nodes: await rows("SELECT * FROM nodes WHERE world_id = ? ORDER BY seq"),
    states: await rows("SELECT s.node_id, s.state_json FROM states s JOIN nodes n ON n.id = s.node_id WHERE n.world_id = ?"),
    lines: await rows("SELECT * FROM lines WHERE world_id = ? ORDER BY created_at"),
    pins: await rows("SELECT * FROM pins WHERE world_id = ?"), chapters: await rows("SELECT * FROM chapters WHERE world_id = ?") });
});
const drop = (name, text) => page.evaluate(([name, text]) => {
  const data = new DataTransfer();
  data.items.add(new File([text], name, { type: "application/json" }));
  document.body.dispatchEvent(new DragEvent("dragover", { dataTransfer: data, bubbles: true, cancelable: true }));
  document.body.dispatchEvent(new DragEvent("drop", { dataTransfer: data, bubbles: true, cancelable: true }));
}, [name, text]);
await drop("notes.txt", "hello");
await page.locator(".toast", { hasText: "只能导入" }).waitFor({ timeout: 5000 }).catch(() => {});
check("dropping some other file says what can be dropped", (await page.locator(".toast", { hasText: "只能导入" }).count()) === 1);
await drop("宽屏.lishi.json", exported);
await page.getByRole("alertdialog").getByRole("button", { name: "另存为新的世界" }).click({ timeout: 5000 }).catch(() => {});
await page.locator(".toast", { hasText: "已另存为新的世界" }).waitFor({ timeout: 5000 }).catch(() => {});
await page.waitForFunction((n) => document.querySelectorAll(".world-card").length > n, worldsBefore, { timeout: 5000 }).catch(() => {});
check("dropping a .lishi.json world imports it", (await page.locator(".world-card").count()) === worldsBefore + 1);
await page.locator(".world-card", { hasText: "宽屏" }).first().locator(".world-open").click();
await page.locator(".turn").last().waitFor();

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
