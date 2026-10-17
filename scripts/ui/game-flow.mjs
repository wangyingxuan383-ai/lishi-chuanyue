// R02 game flow at phone size in the browser dev harness, against fake-llm.
//   node scripts/fake-llm.mjs & pnpm dev &  node scripts/ui/game-flow.mjs
// Uses a fresh browser profile; screenshots go to .cache/ui/game-*.png.
import { connectFake } from "./connect.mjs";
import fs from "node:fs";
import { chromium } from "playwright-core";

const out = ".cache/ui";
fs.mkdirSync(out, { recursive: true });
const results = [];
const check = (name, ok, detail = "") => results.push(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
const browser = await chromium.launch({ channel: "msedge" });
const context = await browser.newContext({ viewport: { width: 393, height: 852 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: new URL(process.env.LISHI_APP ?? "http://127.0.0.1:1420/").origin });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
const shot = (name) => page.screenshot({ path: `${out}/game-${name}.png` });
// A step that throws still reports the checks so far, the page errors and a screenshot.
process.on("uncaughtException", async (error) => {
  await page.screenshot({ path: `${out}/game-failure.png` }).catch(() => {});
  const first = String(error.message ?? error).split("\n").slice(0, 4).join(" ¦ ");
  console.log([...results, `FAIL crashed — ${first}`, ...errors.map((e) => `page error: ${e}`)].join("\n"));
  await browser.close().catch(() => {});
  process.exit(1);
});

await page.goto((process.env.LISHI_APP ?? "http://127.0.0.1:1420/"));

// First launch → AI service setup.
await page.getByText("连接 AI 服务").waitFor();
check("first launch says what the game is and how to get a key", (await page.locator(".welcome").textContent()).includes("另一个时代") && (await page.getByRole("button", { name: "我还没有 Key，怎么办？" }).count()) === 1);
await shot("01-setup");
await connectFake(page, { check });

// New game: templates fill fields, gender locks when the identity implies it.
await page.getByRole("button", { name: /随便穿/ }).waitFor();
await shot("02-newgame");
check("the first step offers 随便穿, a line for AI and inspirations, not a form", (await page.locator(".random-card").count()) === 1 && (await page.getByLabel("名字", { exact: true }).count()) === 0);
check("inspiration cards say what the story is about", (await page.locator(".template-card .hook").count()) >= 6);
await page.getByRole("button", { name: /查看全部/ }).click();
check("all templates listed", (await page.locator(".template-card").count()) >= 18);
const groups = page.getByRole("group", { name: "灵感分类" });
await groups.getByRole("button", { name: "明", exact: true }).click();
const mingCards = await page.locator(".template-card").allTextContents();
check("dynasty filter shows only that dynasty", mingCards.length >= 4 && mingCards.every((t) => t.includes("明 ·")), `${mingCards.length} cards`);
await groups.getByRole("button", { name: "全部", exact: true }).click();
await page.locator(".template-card", { hasText: "相府庶女" }).click();
check("template fills premise and identity", (await page.getByLabel(/故事设定/).inputValue()).includes("平康坊") && (await page.getByLabel("身份与处境").inputValue()).includes("庶女"));
check("gender locked by identity", (await page.textContent("body")).includes("由身份决定"));
const setupScreens = await page.evaluate(() => document.documentElement.scrollHeight / innerHeight);
check("the setup fits in about two screens, the rest folded to summaries", setupScreens <= 2.2 && (await page.locator(".fold").count()) >= 4, `${setupScreens.toFixed(1)} 屏`);
await shot("02a-setup");
await page.getByRole("button", { name: "返回" }).click();
// The full list stays open when coming back.
if (await page.getByRole("button", { name: /查看全部/ }).count()) await page.getByRole("button", { name: /查看全部/ }).click();
await page.locator(".template-card", { hasText: "留洋归来" }).click();
check("neutral identity offers a gender choice", (await page.getByRole("button", { name: "男", exact: true }).count()) === 1);

// AI assist fills only empty fields.
await page.getByLabel(/故事设定/).fill("");
await page.getByRole("button", { name: "返回" }).click();
await page.getByLabel("一句话想法").fill("靖康之变前，我是汴京小吏");
await page.getByRole("button", { name: "补全设定" }).click();
await page.getByText(/已补全空着的部分/).waitFor({ timeout: 15000 });
check("assist fills the empty premise", (await page.getByLabel(/故事设定/).inputValue()).includes("宣和七年"));
check("assist keeps the filled identity", (await page.getByLabel("身份与处境").inputValue()).includes("留学归来"));
// An empty name: the start button says what is missing and takes you there.
const keptName = await page.getByLabel("名字", { exact: true }).inputValue();
await page.getByLabel("名字", { exact: true }).fill("");
check("the start button says what is still missing", (await page.locator(".sticky-bar .primary").textContent()) === "还差名字");
await page.locator(".sticky-bar .primary").click();
check("tapping it goes to the missing field", await page.getByLabel("名字", { exact: true }).evaluate((el) => el === document.activeElement));
await page.getByLabel("名字", { exact: true }).fill(keptName || "沈默");

// Opening setups can be pasted in and copied out for sharing.
await page.getByRole("button", { name: "开局菜单" }).click();
await page.getByRole("button", { name: "导入开局设定" }).click();
await page.getByLabel("分享文字").fill(`朋友发来的：\n<<<LISHI-OPENING\n${JSON.stringify({ v: 1, title: "赤壁小吏", premise: "建安十三年冬，江东。曹军压境。", name: "周平", gender: "男", age: "24", identity: "你是柴桑城里的一个小吏。", arrival: "不穿越" })}\nLISHI-OPENING>>>`);
await page.getByRole("button", { name: "导入", exact: true }).click();
await page.getByText("已导入「赤壁小吏」").waitFor();
check("pasted setup imported", (await page.getByLabel(/故事设定/).inputValue()).includes("建安十三年") && (await page.locator(".fold", { hasText: "穿越" }).first().textContent()).includes("不穿越"));
await page.getByRole("button", { name: "开局菜单" }).click();
await page.getByRole("button", { name: "复制开局设定（发给朋友）" }).click();
await page.getByText("已复制开局设定，可以发给朋友").waitFor();
const copied = await page.evaluate(() => navigator.clipboard.readText());
check("setup copied as shareable text", copied.startsWith("【历史穿越 · 开局设定】赤壁小吏") && copied.includes("<<<LISHI-OPENING"));

// A player-written opening on a fresh template.
await page.getByRole("button", { name: "返回" }).click();
await page.locator(".template-card", { hasText: "落第举子" }).click();
await page.locator(".fold-head", { hasText: "开场" }).click();
await page.getByRole("button", { name: "我自己写" }).click();
await page.getByLabel("开场正文").fill("雨夜，破庙。你缩在神像后面，听见外面有脚步声。");
await page.getByRole("button", { name: "开始", exact: true }).click();
await page.locator(".dock .choice").first().waitFor({ timeout: 20000 });
check("player-written opening kept verbatim", (await page.textContent(".story")).includes("雨夜，破庙。你缩在神像后面"));
check("opening state extracted", (await page.locator(".choice").first().textContent()) === "生火取暖");
// The extract gave no usable date, so the era pack's start date applies; the hour comes from the opening.
check("top bar shows the era date", (await page.textContent(".topbar .subtitle")) === "天宝七载 冬月十七 · 戌时");
await page.getByRole("button", { name: "此时此地" }).click();
await page.getByText("公元 748 年 · 戊子年").waitFor();
check("time sheet shows CE year, season and age", (await page.textContent(".sheet")).includes("仲冬 · 冬至之月") && (await page.textContent(".sheet")).includes("岁（虚岁"));
await page.waitForTimeout(400);
await shot("02b-time");
await page.keyboard.press("Escape");
await page.getByText("公元 748 年 · 戊子年").waitFor({ state: "detached" });
await page.getByRole("button", { name: "返回" }).click();

// An AI-written opening via one-tap random start.
await page.getByRole("button", { name: /^(开始穿越|开始新的故事)$/ }).click();
await page.getByRole("button", { name: /随便穿/ }).click();
await page.locator(".dock .choice").first().waitFor({ timeout: 20000 });
await shot("03-opening");
check("opening streamed and choices shown", (await page.locator(".choice").count()) === 3);
check("record not visible", !(await page.textContent("body")).includes("<record"));

// "写" mode: the player writes narrative directly.
await page.locator(".mode-btn").click();
check("the mode picker shows all four ways with what they do", (await page.locator(".mode-option").count()) >= 4 && (await page.textContent(".sheet")).includes("亲手写一段剧情"));
await shot("02c-mode-picker");
await page.locator(".mode-option", { hasText: "亲手写" }).click();
check("third mode is 写", (await page.locator(".mode-btn").textContent()) === "写");
await page.locator(".inputbar textarea").fill("一阵风吹开了窗，烛火摇晃。");
await page.locator(".send-btn").click();
await page.getByRole("button", { name: "重说" }).waitFor({ timeout: 20000 });
check("written passage shown as narrative", (await page.locator(".turn-written").count()) === 1);

// Story settings editable mid-game.
await page.getByRole("button", { name: "更多" }).click();
await page.getByRole("button", { name: "故事设定与要点" }).click();
await page.getByRole("textbox", { name: /要点/ }).fill("王掌柜其实是主角的舅舅");
await page.getByRole("button", { name: "保存" }).click();
await page.getByText("已保存，从下一段开始生效").waitFor();
check("story settings saved", true);

// Free action with streaming.
await page.locator(".mode-btn").click(); // back to 做
await page.locator(".mode-option", { hasText: "写你要做的事" }).click();
await page.locator(".inputbar textarea").fill("推开门出去看看");
check("send button says 发送", (await page.locator(".send-btn").textContent()) === "发送");
await page.locator(".send-btn").click();
await page.getByRole("button", { name: "停止" }).waitFor();
await page.getByRole("button", { name: "重说" }).waitFor({ timeout: 20000 });
await shot("04-turn");
check("turn appended with player action", (await page.textContent("body")).includes("推开门出去看看"));

// The scripted fake replies rotate: this turn paid 30 coins.
check("money chip after paying", (await page.locator(".chip", { hasText: /钱 −30/ }).count()) === 1);
check("fortune chip shows what the roll was used for", (await page.locator(".chip", { hasText: /^签·(大顺|顺|平|不顺|大不顺) · 求掌柜宽限余款 · 成了一半$/ }).count()) === 1);

// Choice tap → the next scripted turn introduces a person.
await page.locator(".choice").first().click();
await page.locator(".chip", { hasText: "结识 货栈管事" }).waitFor({ timeout: 20000 });
check("choice submits and shows a new-person chip", true);

// Continue (empty input).
check("send button says 继续 when empty", (await page.locator(".send-btn").textContent()) === "继续");
const turnsBefore = await page.locator(".turn").count();
await page.locator(".send-btn").click();
await page.getByRole("button", { name: "停止" }).waitFor();
await page.getByRole("button", { name: "重说" }).waitFor({ timeout: 20000 });
await shot("05-continue");
check("continue adds a turn", (await page.locator(".turn").count()) === turnsBefore + 1);

// Regenerate → variants 1/2 ... 2/2.
await page.getByRole("button", { name: "重说" }).click();
await page.getByText("2/2").waitFor({ timeout: 20000 });
await page.getByRole("button", { name: "上一版" }).click();
await page.getByText("1/2").waitFor();
check("regenerate keeps both versions", true);

// Panel.
await page.getByRole("button", { name: "角色" }).click();
check("a new protagonist is a nobody, not famous", (await page.locator(".stat", { hasText: "名望" }).textContent()).includes("无名小卒"));
await page.getByRole("tab", { name: /人物/ }).click();
const panelText = await page.textContent(".panel");
check("panel lists people", panelText.includes("货栈管事"));
// 人物志: open someone, edit them, and add a person by hand.
await page.locator(".codex-item", { hasText: "货栈管事" }).click();
await page.getByLabel("身份", { exact: true }).fill("西市货栈的管事，嘴碎");
await page.getByLabel(/^来历/).fill("主角落难时收留过他");
await page.getByLabel(/^近况/).fill("主角欠他三十文");
await page.waitForTimeout(400);
await shot("06p-person");
await page.getByRole("button", { name: "保存", exact: true }).click();
await page.locator(".codex-item", { hasText: "嘴碎" }).waitFor();
await page.getByRole("button", { name: "添加人物" }).click();
await page.getByLabel("名字", { exact: true }).fill("货栈管事");
check("adding someone already listed is blocked", (await page.getByText("人物表里已经有").count()) === 1 && await page.getByRole("button", { name: "保存", exact: true }).isDisabled());
await page.getByLabel("名字", { exact: true }).fill("孙小二");
await page.getByLabel("身份", { exact: true }).fill("不良人");
await page.getByRole("button", { name: "保存", exact: true }).click();
await page.locator(".codex-item", { hasText: "孙小二" }).waitFor();
await page.waitForTimeout(400);
await shot("06q-people");
check("people records can be edited and added", (await page.textContent(".panel")).includes("主角欠他三十文"));
check("a person keeps a 来历 apart from the latest news", await page.evaluate(async () => {
  const { game } = window.__lishi;
  const world = (await game.repo.listWorlds())[0];
  const line = await game.repo.getLine(world.currentLineId);
  const person = (await game.repo.getState(line.nodeId)).people.find((p) => p.name === "货栈管事");
  return person?.origin === "主角落难时收留过他" && person.notes === "主角欠他三十文";
}));
await page.getByRole("tab", { name: /行囊/ }).click();
check("panel lists items", (await page.textContent(".panel")).includes("旧书"));
await shot("06-panel");

// 设定集: a new card is listed, recorded as an edit, and sent when its alias comes up.
await page.getByRole("tab", { name: "设定" }).click();
await shot("06a-codex-top");
await page.getByRole("button", { name: "新建势力" }).click();
await page.getByLabel("名称").fill("天地会");
await page.getByLabel(/别名/).fill("会党");
await page.getByLabel("内容").fill("一伙行走江湖的人，暗中贩私盐。");
await page.getByRole("button", { name: "保存", exact: true }).click();
await page.locator(".codex-item", { hasText: "天地会" }).waitFor();
check("new card listed in the 设定集", true);
await page.locator(".codex-era").getByRole("button", { name: /^(编辑|写一张)$/ }).click();
await page.getByLabel("名称").fill("测试时代");
await page.getByLabel("内容").fill("时局：天下太平。\n不要出现：手机");
await page.getByRole("button", { name: "保存", exact: true }).click();
await page.locator(".codex-era", { hasText: "时局：天下太平" }).waitFor();
check("era card editable", true);
await shot("06b-codex");
await page.keyboard.press("Escape");
await page.locator(".panel").waitFor({ state: "detached" });
check("back closes panel", true);
await page.locator(".edit-line", { hasText: "新建势力卡：天地会" }).waitFor();
await page.locator(".inputbar textarea").fill("去打听会党的消息");
await page.locator(".send-btn").click();
await page.getByRole("button", { name: "重说" }).waitFor({ timeout: 20000 });
const sent = JSON.stringify(await (await fetch(`http://127.0.0.1:${process.env.LISHI_FAKE_PORT ?? 18800}/debug/last-request`)).json());
check("mentioned card sent to the AI", sent.includes("【势力】天地会（又称会党）：一伙行走江湖的人"));
check("era card sent with the turn", sent.includes("【时代】测试时代") && sent.includes("时局：天下太平"));

// AI organizing from the 设定 tab replaces the player's era card after a confirm.
await page.getByRole("button", { name: "角色" }).click();
await page.getByRole("tab", { name: "设定" }).click();
await page.getByRole("button", { name: "AI 重新整理" }).click();
await page.locator(".dialog").waitFor();
check("replacing the player's era card asks in the app's own dialog", (await page.textContent(".dialog")).includes("让 AI 重新整理时代卡"));
await page.locator(".dialog").getByRole("button", { name: "重新整理" }).click();
// The random opening may already have been organized; wait for the player's era card to be replaced.
await page.locator(".codex-era", { hasText: "AI 整理的时代" }).waitFor({ timeout: 20000 });
check("AI organizes the 设定集", (await page.locator(".codex-era").textContent()).includes("AI 整理的时代 · AI 整理") && (await page.locator(".codex-item", { hasText: "漕帮" }).count()) === 1);
await page.keyboard.press("Escape");
await page.locator(".panel").waitFor({ state: "detached" });
await page.locator(".edit-line", { hasText: "AI 整理了设定集" }).waitFor();

// Rules: change the start date and currency from the time sheet, then undo.
const clockBeforeRules = await page.locator(".topbar .subtitle").textContent();
await page.getByRole("button", { name: "此时此地" }).click();
await page.getByRole("button", { name: "修改纪年与货币" }).click();
await page.getByLabel("年号").fill("景和");
await page.getByLabel("年", { exact: true }).fill("3");
await page.getByLabel("月", { exact: true }).selectOption("3");
await page.getByLabel("日", { exact: true }).fill("5");
await page.getByLabel("第 1 个单位名称").fill("吊");
await page.waitForTimeout(400);
await shot("06c-rules");
await page.getByRole("button", { name: "保存", exact: true }).click();
await page.locator(".edit-line", { hasText: "开局日期改为景和三年 三月初五" }).waitFor();
check("rules edit changes the date", (await page.locator(".topbar .subtitle").textContent()).startsWith("景和三年 三月"));
await page.getByRole("button", { name: "更多" }).click();
await page.getByRole("button", { name: "撤销", exact: true }).click();
await page.locator(".edit-line", { hasText: "开局日期改为" }).waitFor({ state: "detached" });
check("rules edit can be undone", (await page.locator(".topbar .subtitle").textContent()) === clockBeforeRules);
check("AI edits are not shown as the player's", !(await page.locator(".edit-line", { hasText: "AI 整理了设定集" }).textContent()).includes("你修改了"));

// 记住这件事: a passage becomes a 要点 for this route.
const lastTurn = page.locator(".turn").last();
await lastTurn.scrollIntoViewIfNeeded();
const turnBox = await lastTurn.boundingBox();
await page.mouse.move(turnBox.x + 40, turnBox.y + 20);
await page.mouse.down();
await page.waitForTimeout(650);
await page.mouse.up();
await page.getByRole("button", { name: "记住这件事" }).click();
await page.getByLabel("要点", { exact: true }).waitFor();
await page.waitForTimeout(400);
await shot("06d-remember");
await page.getByLabel("要点", { exact: true }).fill("漕帮在码头收保护费");
await page.getByRole("button", { name: "记下", exact: true }).click();
await page.getByText("记下了").waitFor();
await page.getByRole("button", { name: "更多" }).click();
await page.getByRole("button", { name: "故事设定与要点" }).click();
await page.getByText("漕帮在码头收保护费").waitFor();
await page.waitForTimeout(400);
await shot("06e-pins");
check("remembered passage listed as a 要点", true);
await page.keyboard.press("Escape");

// Long-press menu → go back to opening.
const firstTurn = page.locator(".turn").first();
await firstTurn.scrollIntoViewIfNeeded();
await page.waitForTimeout(200);
const box = await firstTurn.boundingBox();
await page.mouse.move(box.x + 40, box.y + 40);
await page.mouse.down();
await page.waitForTimeout(650);
await page.mouse.up();
await page.getByRole("button", { name: "回到这里" }).waitFor();
await shot("07-longpress");
await page.getByRole("button", { name: "回到这里" }).click();
await page.getByText(/已回到这里/).waitFor();
check("go back to opening", (await page.locator(".turn").count()) === 1);
check("going back says the old route is kept and offers the way back", (await page.locator(".toast .toast-action").count()) === 1);
await page.getByRole("button", { name: "更多" }).click();
await page.getByRole("button", { name: "故事设定与要点" }).click();
await page.getByLabel(/^要点/).waitFor();
check("a 要点 from a later passage is not on the earlier route", (await page.getByText("漕帮在码头收保护费").count()) === 0);
await page.keyboard.press("Escape");
await page.getByRole("button", { name: "更多" }).click();
await page.getByRole("button", { name: "世界线" }).click();
const lines = await page.locator(".sheet .card").count();
check("old route kept as a world line", lines === 2, `${lines} lines`);
// R06-T001: rename the old route, put it in the trash and restore it.
const oldRoute = page.locator(".line-row").filter({ hasNotText: "（当前）" }).first();
await oldRoute.getByRole("button", { name: /更多操作/ }).click();
await page.getByRole("button", { name: "重命名" }).click();
await page.getByLabel("名称", { exact: true }).fill("当铺那条路");
await page.getByRole("button", { name: "保存", exact: true }).click();
await page.locator(".line-row", { hasText: "当铺那条路" }).waitFor();
await page.locator(".line-row", { hasText: "当铺那条路" }).getByRole("button", { name: /更多操作/ }).click();
await page.getByRole("button", { name: "删除", exact: true }).click();
await page.getByText(/回收站 1/).waitFor();
await page.getByText(/回收站 1/).click();
await page.locator(".line-row", { hasText: "当铺那条路" }).locator(".card").click();
await page.getByRole("button", { name: "恢复", exact: true }).click();
await page.waitForTimeout(300);
check("a route can be renamed, deleted and restored", (await page.locator(".line-row", { hasText: "当铺那条路" }).count()) === 1 && (await page.getByText(/回收站/).count()) === 0);
await page.waitForTimeout(400);
await shot("07b-lines");
await page.keyboard.press("Escape");
// A bookmark on the opening, listed under 世界线.
const openingTurn = page.locator(".turn").first();
const openingBox = await openingTurn.boundingBox();
await page.mouse.move(openingBox.x + 40, openingBox.y + 40);
await page.mouse.down();
await page.waitForTimeout(650);
await page.mouse.up();
await page.getByRole("button", { name: "加书签" }).click();
await page.getByLabel("名称", { exact: true }).fill("刚穿越来时");
await page.getByRole("button", { name: "保存", exact: true }).click();
await page.getByText(/已加书签/).waitFor();
await page.getByRole("button", { name: "更多" }).click();
await page.getByRole("button", { name: "世界线" }).click();
check("the bookmark is listed", (await page.locator(".line-row", { hasText: "刚穿越来时" }).count()) === 1);
// R06-T002: the turn tree shows both routes with their marks.
await page.getByRole("button", { name: "看回合树 ›" }).click();
await page.locator(".tree-row").first().waitFor();
await page.locator(".tree-row").first().click();
await page.waitForTimeout(400);
await shot("07d-tree");
const treeText = await page.textContent(".tree");
check("the turn tree shows forks, routes and bookmarks", (await page.locator(".tree-row").count()) >= 3 && treeText.includes("书签：刚穿越来时") && treeText.includes("当铺那条路") && (await page.getByRole("button", { name: "从这里继续" }).count()) >= 1);
check("the turn tree fits the phone width", !(await page.evaluate(() => document.querySelector(".tree").scrollWidth > innerWidth)));
await page.keyboard.press("Escape");
await page.keyboard.press("Escape");

// Every six turns the AI files new cards in the background (R04-T001).
for (let i = 0; i < 6; i++) {
  await page.locator(".send-btn").click();
  await page.getByRole("button", { name: "停止" }).waitFor();
  await page.getByRole("button", { name: "重说" }).waitFor({ timeout: 20000 });
}
await page.locator(".edit-line", { hasText: "AI 整理了设定集：铜鹰符" }).waitFor({ timeout: 20000 });
const yearNow = (await page.locator(".topbar .subtitle").textContent()).split(" ")[0];
await page.getByRole("button", { name: "角色" }).click();
await page.getByRole("tab", { name: "设定" }).click();
check("AI files new cards every six turns", (await page.locator(".codex-item", { hasText: "铜鹰符" }).textContent()).includes("AI 整理"));

// 记事 (R04-T003): write the turns so far as a chapter, then rename it.
await page.getByRole("tab", { name: "记事" }).click();
await page.getByText("本章进行中 · 第 1～6 回合").waitFor();
await page.getByRole("button", { name: "把第 1～6 回合写成一章" }).click();
await page.locator(".codex-item", { hasText: "第 1 章 · 西市谋生" }).waitFor({ timeout: 20000 });
await page.waitForTimeout(400);
await shot("06r-journal");
await page.locator(".codex-item", { hasText: "第 1 章" }).click();
await page.waitForTimeout(400);
await shot("06s-chapter");
await page.getByRole("button", { name: "修改", exact: true }).click();
await page.getByLabel("标题").fill("初到西市");
await page.getByRole("button", { name: "保存", exact: true }).click();
await page.locator(".codex-item", { hasText: "第 1 章 · 初到西市" }).waitFor();
check("journal writes a chapter and the player can rename it", true);
check("panel tabs fit the phone width", !(await page.evaluate(() => { const t = document.querySelector(".tabs"); return t.scrollWidth > t.clientWidth; })));

// 目标 (R05-T003): add a wish, then finish the main goal from its sheet.
await page.getByRole("tab", { name: /目标/ }).click();
await page.getByRole("button", { name: "添加心愿" }).click();
await page.getByLabel("心愿", { exact: true }).fill("攒钱在长安买一处宅子");
await page.getByRole("button", { name: "记下", exact: true }).click();
await page.locator(".codex-item", { hasText: "攒钱在长安买一处宅子" }).waitFor();
check("a wish is listed with its kind", (await page.locator(".codex-item", { hasText: "攒钱在长安买一处宅子" }).textContent()).includes("心愿"));
await page.locator(".codex-item", { hasText: "三日内付清房钱九十文" }).click();
await page.waitForTimeout(400);
await shot("06t-goal");
check("a goal shows how it went", (await page.locator(".timeline li").count()) >= 1);
await page.getByRole("button", { name: "标为完成" }).click();
await page.getByText(/已结束 1/).waitFor();
check("a finished goal moves to the ended list", true);

// 天下大事 (R05-T004): an event next month; 过些日子 below crosses it.
await page.getByRole("tab", { name: "记事" }).click();
await page.getByRole("button", { name: "添加大事" }).click();
await page.getByLabel(/^日期/).fill(`${yearNow}腊月`);
await page.getByLabel("发生什么").fill("大雪封了城门");
await page.getByRole("button", { name: "固定（一定发生）" }).click();
await page.getByRole("button", { name: "添加", exact: true }).click();
await page.locator(".codex-item", { hasText: "大雪封了城门" }).waitFor();
await page.waitForTimeout(400);
await shot("06u-timeline");
check("a great event is added to the timeline", (await page.locator(".codex-item", { hasText: "大雪封了城门" }).textContent()).includes("腊月"));
await page.keyboard.press("Escape");
await page.locator(".panel").waitFor({ state: "detached" });

// 查一查 (R07-T001): answers from this world first; the story does not move.
const turnsBeforeAsk = await page.locator(".turn").count();
await page.getByRole("button", { name: "更多" }).click();
await page.getByRole("button", { name: "查一查" }).click();
await page.getByLabel("想问什么").fill("王掌柜是什么来头？");
await page.getByRole("button", { name: "问", exact: true }).click();
await page.locator(".ask-item", { hasText: "仅供参考" }).waitFor({ timeout: 20000 });
await page.waitForTimeout(400);
await shot("07e-ask");
check("查一查 answers from this world and marks general knowledge", (await page.locator(".ask-item").textContent()).includes("【本局】王掌柜"));
await page.keyboard.press("Escape");
check("查一查 does not move the story", (await page.locator(".turn").count()) === turnsBeforeAsk);

// 过些日子 (R05-T001): a month passes, with the report card and a month chip.
await page.getByRole("button", { name: "更多" }).click();
await page.getByRole("button", { name: "过些日子" }).click();
await page.getByRole("button", { name: "一个月", exact: true }).click();
await page.getByRole("button", { name: "读书", exact: true }).click();
await page.getByRole("button", { name: "开始", exact: true }).click();
await page.locator(".report-card").waitFor({ timeout: 20000 });
await page.getByRole("button", { name: "重说" }).waitFor({ timeout: 20000 });
await page.waitForTimeout(400);
await shot("07c-skip");
check("a month passes with a report and the time chip", (await page.locator(".turn").last().textContent()).includes("过一个月；这段时间读书") && (await page.locator(".chip", { hasText: "过了 1 个月" }).count()) === 1 && (await page.locator(".report-card").textContent()).includes("米价"));
check("the month crosses the great event", (await page.locator(".chip", { hasText: "📜 大雪封了城门" }).count()) === 1);

// Stop mid-generation keeps partial text as interrupted.
await page.getByRole("button", { name: "更多" }).click();
await page.getByRole("button", { name: "本局设置" }).click();
await page.locator(".sheet .segmented").first().waitFor();
check("本局设置 has a 玩法 group with 运势 and 用词提醒", (await page.locator(".sheet .settings-sub", { hasText: "玩法" }).count()) === 1 && (await page.locator(".sheet").textContent()).includes("用词提醒"));
await page.locator(".sheet .segmented", { has: page.getByRole("button", { name: "只作参考" }) }).getByRole("button", { name: "关", exact: true }).click();
await page.waitForTimeout(300);
await shot("07d-world-settings-fortune");
check("运势 can be turned off for this world and shows 本局", (await page.evaluate(async () => { const w = (await window.__lishi.game.repo.listWorlds())[0]; return w.settings.fortune; })) === "off" && (await page.locator(".sheet span.muted", { hasText: "运势" }).locator(".tag.own").count()) === 1);
await page.locator(".sheet .segmented", { has: page.getByRole("button", { name: "只作参考" }) }).getByRole("button", { name: "只作参考" }).click();
await page.keyboard.press("Escape");

// Reload persists everything. The browser harness saves the database one second
// after the last write, so give it time before reloading.
await page.waitForTimeout(1500);
await page.reload();
await page.locator(".world-card").first().waitFor();
await shot("08-home");
check("home lists the world after reload", (await page.locator(".world-card").count()) >= 1);
check("the latest world is a featured card with 继续, and new stories are secondary", (await page.locator(".world-card.featured .continue-btn").count()) === 1 && (await page.getByRole("button", { name: "开始新的故事" }).count()) === 1);
check("every world card has a visible ⋯ menu", (await page.locator(".world-menu").count()) === (await page.locator(".world-card").count()));

// "再来一局同样设定" from the home long-press menu.
const cardBox = await page.locator(".world-open").first().boundingBox();
await page.mouse.move(cardBox.x + 30, cardBox.y + 20);
await page.mouse.down();
await page.waitForTimeout(650);
await page.mouse.up();
await page.getByRole("button", { name: "用同样设定再开一局" }).click();
await page.getByLabel("名字", { exact: true }).waitFor();
check("same setup again opens the filled setup", (await page.getByLabel(/故事设定/).inputValue()).length > 0 && (await page.getByLabel("名字", { exact: true }).inputValue()).length > 0 && (await page.textContent("body")).includes("由身份决定"));
await page.getByRole("button", { name: "返回" }).click();
await page.getByRole("button", { name: "返回" }).click();
await page.locator(".world-card").first().waitFor();

// Edits are a single reversible change after the latest turn.
await page.locator(".world-open").first().click();
await page.locator(".dock .choice").first().waitFor();
await page.locator(".send-btn").click();
await page.getByRole("button", { name: "重说" }).waitFor({ timeout: 20000 });
const clockBeforeEdit = await page.locator(".topbar .subtitle").textContent();
const choicesBeforeEdit = await page.locator(".choice").allTextContents();
await page.getByRole("button", { name: "角色" }).click();
await page.getByRole("button", { name: "修改", exact: true }).click();
await page.getByLabel("钱", { exact: true }).fill("500");
await shot("09-panel-edit");
check("edit panel fits phone width", !(await page.evaluate(() => document.querySelector(".panel").scrollWidth > innerWidth)));
await page.getByRole("button", { name: "保存修改" }).click();
await page.getByRole("button", { name: "修改", exact: true }).waitFor();
await page.getByRole("button", { name: "关闭", exact: true }).click();
await page.locator(".edit-line", { hasText: "你修改了：钱" }).waitFor();
check("panel saves a readable edit in the story", true);
check("editing keeps time and choices", await page.locator(".topbar .subtitle").textContent() === clockBeforeEdit && JSON.stringify(await page.locator(".choice").allTextContents()) === JSON.stringify(choicesBeforeEdit));
check("regenerate stays on the preceding turn", (await page.locator(".turn").last().getByRole("button", { name: "重说" }).count()) === 1);
await shot("10-edit-saved");
await page.getByRole("button", { name: "更多" }).click();
await page.getByRole("button", { name: "撤销", exact: true }).click();
await page.locator(".edit-line", { hasText: "你修改了：钱" }).waitFor({ state: "detached" });
check("undo removes the edit from the story", true);
check("undo says what was undone and offers 重做", (await page.locator(".toast", { hasText: "已撤销这次修改" }).count()) === 1 && (await page.locator(".toast .toast-action", { hasText: "重做" }).count()) === 1);
await page.getByRole("button", { name: "更多" }).click();
await page.getByRole("dialog").getByRole("button", { name: "重做", exact: true }).click();
await page.locator(".edit-line", { hasText: "你修改了：钱" }).waitFor();
check("redo restores the edit", true);
await page.getByRole("button", { name: "重说", exact: true }).click();
await page.locator(".edit-line", { hasText: "（已沿用）" }).waitFor({ timeout: 20000 });
await page.getByRole("button", { name: "角色" }).click();
check("regenerating carries the edit to the new version", (await page.locator(".stat").first().textContent()).includes("500"));
await page.getByRole("button", { name: "关闭", exact: true }).click();
const editsBefore = await page.locator(".edit-line").count();
await page.getByRole("button", { name: "角色" }).click();
await page.getByRole("button", { name: "修改", exact: true }).click();
await page.getByRole("button", { name: "保存修改" }).click();
await page.getByRole("button", { name: "修改", exact: true }).waitFor();
await page.getByRole("button", { name: "关闭", exact: true }).click();
check("saving unchanged panel adds no edit", (await page.locator(".edit-line").count()) === editsBefore);

// Reading an earlier turn is restored when reopening the world.
for (let i = 0; i < 3; i++) {
  await page.locator(".send-btn").click();
  await page.getByRole("button", { name: "重说" }).waitFor({ timeout: 20000 });
}
await page.locator(".story").evaluate((el) => { el.scrollTop = 0; });
await page.getByRole("button", { name: "回到底部 ↓" }).waitFor();
await page.waitForTimeout(500);
const readTurn = await page.locator(".turn").first().getAttribute("data-node-id");
await page.getByRole("button", { name: "返回", exact: true }).click();
await page.locator(".world-open").first().click();
await page.getByRole("button", { name: "回到底部 ↓" }).waitFor();
check("reopening restores the earlier reading position", await page.locator(".story").evaluate((el) => el.scrollTop < 30) && await page.locator(".turn").first().getAttribute("data-node-id") === readTurn);
await shot("11-reading-restored");
await page.locator(".send-btn").click();
await page.getByRole("button", { name: "重说" }).waitFor({ timeout: 20000 });
check("new generation follows the bottom again", (await page.getByRole("button", { name: "回到底部 ↓" }).count()) === 0);

// The play guide: every feature and where it lives, from the home screen.
await page.getByRole("button", { name: "返回", exact: true }).click();
await page.getByRole("button", { name: "游玩指南" }).click();
await page.locator(".guide .fold").first().waitFor();
check("the play guide lists how to play, the features and common problems", (await page.locator(".guide .fold").count()) >= 7 && (await page.textContent(".guide")).includes("醒来") === false && (await page.textContent(".guide")).includes("这是什么游戏"));
await page.locator(".guide .fold-head", { hasText: "常见问题" }).click();
check("guide sections open to their answers", (await page.textContent(".guide")).includes("连不上服务"));
await shot("11c-guide");
await page.getByRole("button", { name: "返回", exact: true }).click();
await page.locator(".world-open").first().click();
await page.locator(".turn").last().waitFor();

// Developer call history is only shown after enabling developer mode.
await page.getByRole("button", { name: "返回", exact: true }).click();
await page.getByRole("button", { name: "设置", exact: true }).click();
check("settings home lists AI, game and app groups with the current state", (await page.locator(".settings-group h2").allTextContents()).join() === "AI,游戏,应用" && (await page.locator(".settings-entry", { hasText: "AI 服务" }).textContent()).includes("fake-normal") && (await page.locator(".settings-entry", { hasText: "关于与更新" }).textContent()).includes("版本"));
await shot("11b-settings-home");
check("call history hidden outside developer mode", (await page.getByText("调用记录", { exact: true }).count()) === 0 && (await page.locator(".settings-entry", { hasText: "开发者" }).count()) === 0);
// Developer mode: tap the version line seven times on 关于与更新, like Android.
await page.locator(".settings-entry", { hasText: "关于与更新" }).click();
for (let i = 0; i < 7; i++) await page.locator(".dev-switch").click();
await page.getByText("开发者模式已打开").first().waitFor();
await page.getByRole("button", { name: "返回", exact: true }).click();
await page.locator(".settings-entry", { hasText: "开发者" }).click();
await page.getByText("调用记录", { exact: true }).waitFor();
await page.locator(".item-row").first().waitFor();
const callText = await page.locator(".item-row").first().textContent();
check("developer mode shows recent call details", /\d{2}-\d{2}.*\d{2}:\d{2}/.test(callText) && callText.includes("回合") && callText.includes("fake-normal") && callText.includes("输入") && callText.includes("输出") && callText.includes("首字") && callText.includes("总计") && callText.includes("成功"));
check("call history has at most 30 rows", (await page.locator(".item-row").count()) <= 30);
await page.getByText("调用记录", { exact: true }).scrollIntoViewIfNeeded();
await shot("12-call-history");

// R08-T004: usage by world, day and purpose, with the player's prices (one set, in 用量与花费, R14).
await page.getByRole("button", { name: "返回", exact: true }).click();
await page.locator(".settings-entry", { hasText: "存档与数据" }).click();
check("data page shows the last backup and a way to back up now", (await page.locator(".status-card").first().textContent()).includes("备份") && (await page.getByRole("button", { name: "现在备份" }).count()) === 1);
await page.getByRole("button", { name: "返回", exact: true }).click();
await page.locator(".settings-entry", { hasText: "用量与花费" }).click();
await page.getByLabel("输入单价（元／百万 token）").fill("1");
await page.getByLabel("输出单价（元／百万 token）").fill("4");
await page.getByRole("button", { name: "保存", exact: true }).click();
await page.getByText("已保存", { exact: true }).waitFor();
await page.getByRole("button", { name: /^用量明细/ }).click();
await page.getByRole("heading", { name: "用量明细" }).waitFor();
await page.getByRole("button", { name: "按用途" }).click();
await page.locator(".sheet .item-row", { hasText: "回合" }).first().waitFor();
await page.locator(".sheet .tag", { hasText: "元" }).first().waitFor();
await page.waitForTimeout(400);
await shot("12b-usage");
check("usage shows calls by purpose with an estimated cost", (await page.textContent(".sheet")).includes("估计约") && (await page.locator(".sheet .item-row").count()) >= 2);
await page.keyboard.press("Escape");

// Context size per service and the developer context viewer (R04-T004).
await page.getByRole("button", { name: "返回", exact: true }).click();
await page.locator(".settings-entry", { hasText: "记忆与整理" }).click();
await page.getByRole("button", { name: "记得更多" }).click();
check("context size saved on the service", (await page.getByRole("button", { name: "记得更多" }).getAttribute("aria-pressed")) === "true");
// Play defaults: a new world starts from them; a world shows which settings are its own.
await page.getByRole("button", { name: "返回", exact: true }).click();
await page.locator(".settings-entry", { hasText: "游玩默认" }).click();
await page.getByRole("button", { name: "残酷" }).click();
check("the difficulty default can be set (it had no way in before)", (await page.getByRole("button", { name: "残酷" }).getAttribute("aria-pressed")) === "true");
await page.getByRole("button", { name: "标准" }).click();
// 运势 (R11-T008): 只作参考 by default, can be turned off.
check("运势 defaults to 只作参考", (await page.getByRole("button", { name: "只作参考" }).getAttribute("aria-pressed")) === "true");
await page.locator(".setting", { hasText: "运势" }).getByRole("button", { name: "关", exact: true }).click();
await page.waitForTimeout(300);
await shot("12f-play-defaults-fortune");
check("运势 can be set to 关 and is saved", (await page.locator(".setting", { hasText: "运势" }).getByRole("button", { name: "关", exact: true }).getAttribute("aria-pressed")) === "true"
  && (await page.textContent("body")).includes("不抽签，成败全按情理")
  && (await page.evaluate(async () => (await window.__lishi.game.repo.getSetting("playDefaults", {})).fortune)) === "off");
await page.getByRole("button", { name: "只作参考" }).click();
await page.getByRole("button", { name: "返回", exact: true }).click();
await page.locator(".settings-entry", { hasText: "网络与代理" }).click();
await page.getByRole("button", { name: "自定义代理" }).click();
await page.getByLabel("代理地址").fill("http://127.0.0.1:7890");
await page.getByRole("button", { name: "保存", exact: true }).click();
await page.getByText(/已保存，下一次请求开始生效/).waitFor();
check("a custom proxy can be entered and saved", (await page.evaluate(async () => JSON.stringify(await window.__lishi.game.repo.getSetting("network", null)))).includes("7890"));
await page.getByRole("button", { name: "直接连接" }).click();
await page.getByRole("button", { name: "返回", exact: true }).click();
await page.getByRole("button", { name: "返回", exact: true }).click();
await page.locator(".world-open").first().click();
await page.getByRole("button", { name: "更多" }).click();
await page.getByRole("button", { name: "查看上下文（开发者）" }).click();
await page.getByText("下一回合的上下文").waitFor();
await page.locator(".context-layer summary", { hasText: "最近原文" }).click();
await page.waitForTimeout(400);
await shot("13-context");
const contextText = await page.textContent(".sheet");
check("context viewer lists every layer with sizes", ["叙事规则", "时代卡", "前情提要", "最近原文", "当前状态与人物", "要点", "相关设定", "玩家行动"].every((t) => contextText.includes(t)) && /约 [\d,]+ token/.test(contextText));
check("context viewer fits the phone width", !(await page.evaluate(() => document.querySelector(".sheet").scrollWidth > innerWidth)));
await page.keyboard.press("Escape");
await page.getByRole("button", { name: "返回", exact: true }).click();
await page.getByRole("button", { name: "设置", exact: true }).click();
await page.locator(".settings-entry", { hasText: "开发者" }).click();
await page.getByLabel(/开发者模式/).uncheck();
await page.getByRole("button", { name: "返回", exact: true }).click();
check("disabling developer mode hides the developer page", (await page.locator(".settings-entry", { hasText: "开发者" }).count()) === 0);

// R08-T001: export a world to a file and import it back as a new world.
await page.getByRole("button", { name: "返回", exact: true }).click();
await page.locator(".world-card").first().waitFor();
const worldsBefore = await page.locator(".world-card").count();
const exportedTitle = (await page.locator(".world-card h3").first().textContent()).trim();
const homeCard = await page.locator(".world-open").first().boundingBox();
await page.mouse.move(homeCard.x + 30, homeCard.y + 20);
await page.mouse.down();
await page.waitForTimeout(650);
await page.mouse.up();
const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "导出成文件" }).click()]);
const archivePath = `${out}/world-export.json`;
await download.saveAs(archivePath);
const archive = JSON.parse(fs.readFileSync(archivePath, "utf8"));
check("a world exports with its turns, lines and states", archive.format === "lishi-world" && archive.nodes.length > 5 && archive.states.length === archive.nodes.length && archive.lines.length >= 2);
const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.getByRole("button", { name: "从文件导入世界…" }).click()]);
await chooser.setFiles(archivePath);
await page.getByRole("button", { name: "另存为新的世界" }).click();
await page.locator(".world-card h3", { hasText: `${exportedTitle}（导入）` }).waitFor();
check("the same world imports again as a new one", (await page.locator(".world-card").count()) === worldsBefore + 1);
await page.waitForTimeout(400);
await shot("14-imported");
// Deleting a world puts it in the bin with an undo; emptying the bin takes everything, 要点 included.
const importedTitle = `${exportedTitle}（导入）`;
await page.locator(".world-card", { hasText: importedTitle }).locator(".world-menu").click();
await page.getByRole("button", { name: "改名" }).click();
await page.locator(".dialog input").fill("导入的那一局");
await page.locator(".dialog").getByRole("button", { name: "保存" }).click();
await page.locator(".world-card", { hasText: "导入的那一局" }).waitFor();
check("a world can be renamed from its ⋯ menu", true);
await page.locator(".world-card", { hasText: "导入的那一局" }).locator(".world-menu").click();
await page.getByRole("button", { name: "删除这个世界" }).click();
await page.getByText(/已删除“导入的那一局”/).waitFor();
check("deleting a world puts it in 最近删除 with an undo", (await page.locator(".world-card").count()) === worldsBefore && (await page.locator(".toast .toast-action", { hasText: "撤销" }).count()) === 1 && (await page.locator(".recent-deleted").count()) === 1);
await page.locator(".toast .toast-action", { hasText: "撤销" }).click();
await page.locator(".world-card", { hasText: "导入的那一局" }).waitFor();
check("undo brings the deleted world back", (await page.locator(".world-card").count()) === worldsBefore + 1);
await page.locator(".world-card", { hasText: "导入的那一局" }).locator(".world-menu").click();
await page.getByRole("button", { name: "删除这个世界" }).click();
await page.locator(".recent-deleted summary").click();
await page.locator(".recent-deleted").getByRole("button", { name: "彻底删除" }).click();
await page.locator(".dialog").getByRole("button", { name: "彻底删除" }).click();
await page.locator(".recent-deleted").waitFor({ state: "detached" });
check("a world with 要点 can be deleted for good", (await page.locator(".world-card").count()) === worldsBefore && (await page.evaluate(async () => (await window.__lishi.game.platform.sql.query("SELECT COUNT(*) AS n FROM pins WHERE world_id NOT IN (SELECT id FROM worlds)"))[0].n)) === 0);

// D124: while 垂危 the play screen keeps a warning above the input.
const dyingWorld = await page.evaluate(async () => {
  const { game } = window.__lishi;
  const world = (await game.repo.listWorlds())[0];
  await game.editState(world.id, { status: [{ op: "add", name: "垂危", detail: "伤重濒死，再受重伤就会死" }] }, "测试：垂危");
  return world.title;
});
await page.evaluate(() => window.__lishiFlush?.());
await page.reload();
await page.locator(".world-card", { hasText: dyingWorld }).first().click();
await page.locator(".turn").last().waitFor();
check("a dying protagonist sees a standing warning", await page.getByText("你伤重垂危").isVisible());
await shot("15-dying");
// A death is an ending card with ways on, not an error line (AUDIT_V4 5.6).
await page.evaluate(async (title) => {
  const { game } = window.__lishi;
  const world = (await game.repo.listWorlds()).find((w) => w.title === title);
  await game.editState(world.id, { setStats: { health: 0 } }, "测试：死亡");
}, dyingWorld);
await page.getByRole("button", { name: "返回", exact: true }).click();
await page.locator(".world-card", { hasText: dyingWorld }).first().click();
await page.locator(".ending-card").waitFor();
check("a death shows an ending card with ways back", (await page.locator(".ending-card").textContent()).includes("卒于") && (await page.locator(".ending-actions button").count()) === 4);
await page.locator(".ending-card").scrollIntoViewIfNeeded();
await shot("16-ending");
await page.getByRole("button", { name: "看这一世小传" }).click();
await page.locator(".life-seal").waitFor();
await page.waitForTimeout(400);
check("a death's 小传 carries the 殉身 seal and speaks in the past", (await page.locator(".life-seal").textContent()) === "殉身" && (await page.locator(".life-bio").textContent()).includes("卒于"));
await shot("16b-ending-life");
await page.keyboard.press("Escape");
await page.getByRole("button", { name: "回到上一回合" }).click();
await page.locator(".ending-card").waitFor({ state: "detached" });
check("going back from the ending brings the story back", (await page.locator(".ending-card").count()) === 0);
await page.getByRole("button", { name: "返回", exact: true }).click();

// 完整感 (direction G): 目录 with 回目, bookmarks and 要点; search jumps to the passage.
await page.locator(".world-card", { hasText: dyingWorld }).first().click();
await page.locator(".turn").last().waitFor();
await page.getByRole("button", { name: "更多" }).click();
await page.getByRole("button", { name: "目录与搜索" }).click();
await page.locator(".toc .section-title", { hasText: "章回" }).waitFor();
await page.waitForTimeout(400);
await shot("17-toc");
const tocText = await page.textContent(".sheet");
check("目录 lists chapters as 回目 with their time, bookmarks and 要点", tocText.includes("第一回　初到西市") && tocText.includes("楔子") && tocText.includes("刚穿越来时") && tocText.includes("我记下的要点") && /天宝/.test(tocText));
check("目录 fits the phone width", !(await page.evaluate(() => document.querySelector(".sheet").scrollWidth > innerWidth)));
await page.getByLabel("搜索").fill("货栈");
await page.locator(".toc-snippet mark").first().waitFor();
await page.waitForTimeout(300);
await shot("18-search");
check("search shows snippets with the hit marked", (await page.locator(".toc-snippet mark").first().textContent()) === "货栈" && (await page.locator(".sheet .tag", { hasText: "正文" }).count()) >= 1);
const firstPassage = page.locator(".sheet button.codex-item", { has: page.locator(".tag", { hasText: "正文" }) }).last();
await page.locator(".story").evaluate((el) => { el.scrollTop = el.scrollHeight; });
await firstPassage.click();
await page.locator(".sheet").waitFor({ state: "detached" });
await page.waitForTimeout(300);
const jumped = await page.evaluate(() => {
  const story = document.querySelector(".story").getBoundingClientRect();
  const hit = [...document.querySelectorAll(".turn")].find((t) => t.textContent.includes("货栈"));
  const box = hit?.getBoundingClientRect();
  return !!box && box.top < story.bottom && box.bottom > story.top;
});
check("tapping a search result scrolls the story to that passage", jumped);
await page.getByRole("button", { name: "返回", exact: true }).click();

// 前情提要: away more than six hours, the story opens with a recap card.
await page.evaluate(async (title) => {
  const { game } = window.__lishi;
  const world = (await game.repo.listWorlds()).find((w) => w.title === title);
  const old = new Date(Date.now() - 8 * 3600_000).toISOString();
  await game.platform.sql.query("UPDATE worlds SET played_at = ? WHERE id = ?", [old, world.id]);
  await game.repo.setSetting("opened:" + world.id, Date.now() - 8 * 3600_000);
}, dyingWorld);
await page.evaluate(() => window.__lishiFlush?.());
await page.reload();
await page.locator(".world-card", { hasText: dyingWorld }).first().click();
await page.locator(".recap-card").waitFor();
await page.waitForTimeout(400);
await shot("19-recap");
const recapText = await page.textContent(".recap-card");
check("a recap card greets a player back after hours away", recapText.includes("前回说到") && recapText.includes("第一回") && recapText.includes("上回停在"));
check("the recap card is in view", await page.locator(".recap-card").evaluate((el) => { const s = document.querySelector(".story").getBoundingClientRect(); const b = el.getBoundingClientRect(); return b.top < s.bottom && b.bottom > s.top; }));
await page.locator(".recap-card").getByRole("button", { name: "收起" }).click();
check("the recap card can be dismissed", (await page.locator(".recap-card").count()) === 0);
await page.getByRole("button", { name: "返回", exact: true }).click();
await page.locator(".world-card", { hasText: dyingWorld }).first().click();
await page.locator(".turn").last().waitFor();
await page.waitForTimeout(300);
check("the recap shows once per return", (await page.locator(".recap-card").count()) === 0);
await page.getByRole("button", { name: "返回", exact: true }).click();

// Export as a readable novel.
await page.locator(".world-card", { hasText: dyingWorld }).first().locator(".world-menu").click();
const [novel] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "导出成小说（文本）" }).click()]);
const novelPath = `${out}/world-novel.txt`;
await novel.saveAs(novelPath);
const novelText = fs.readFileSync(novelPath, "utf8");
check("a world exports as a novel with 回目 and marked actions", novel.suggestedFilename().endsWith(".txt") && novelText.startsWith(`《${dyingWorld}》`) && novelText.includes("第一回　初到西市") && /^◇ (你|你说|过些日子)：/m.test(novelText) && novelText.includes("　　"));

// 完整感 (PLAN_V4 direction G): the 小传 with 行状 and 印谱, and 书摘卡 pictures.
await page.locator(".world-card", { hasText: dyingWorld }).first().click();
await page.locator(".turn").last().waitFor();
const sealsShown = await page.evaluate(async (title) => {
  const { game } = window.__lishi;
  const world = (await game.repo.listWorlds()).find((w) => w.title === title);
  return game.repo.getSetting("seals:" + world.id, []);
}, dyingWorld);
check("earned seals are remembered so the toast shows once", sealsShown.includes("arrive"), sealsShown.join(","));
await page.getByRole("button", { name: "更多" }).click();
await page.getByRole("button", { name: "这一世小传" }).click();
await page.locator(".life-stats").waitFor();
const lifeText = await page.locator(".life").textContent();
check("the 小传 tells origin, life, history and money without a model call", ["出身", "生平", "改史", "家产", "行状", "印谱"].every((w) => lifeText.includes(w)) && ["未竟", "功成"].includes(await page.locator(".life-seal").textContent()));
check("the 印谱 shows earned and unearned seals", (await page.locator(".seal-stamp").count()) >= 8 && (await page.locator(".seal-stamp.got").count()) >= 1 && (await page.locator(".seal-stamp:not(.got)").count()) >= 1);
check("the 行状 counts turns and lines", /\d+ 回合/.test(await page.locator(".life-stats").textContent()));
await page.waitForTimeout(400);
await shot("17-life");
await page.locator(".sheet").evaluate((el) => el.scrollTo(0, el.scrollHeight));
await page.waitForTimeout(200);
await shot("17b-seals");
await page.getByRole("button", { name: "做成图片" }).click();
await page.locator(".share-preview img").waitFor();
check("the 小传 becomes a picture", await page.locator(".share-preview img").evaluate((img) => img.complete && img.naturalWidth >= 1000));
await shot("18-life-card");
await page.getByRole("button", { name: "手卷", exact: true }).click();
await page.waitForTimeout(400);
await shot("18b-scroll-card");
const [cardDownload] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "保存图片" }).click()]);
check("the browser saves the picture as a PNG", cardDownload.suggestedFilename().endsWith(".png"), cardDownload.suggestedFilename());
await page.keyboard.press("Escape");
await page.locator(".life").waitFor();
await page.keyboard.press("Escape");
await page.locator(".life").waitFor({ state: "detached" });
const cardTurn = await page.locator(".turn").last().boundingBox();
await page.mouse.move(cardTurn.x + 40, cardTurn.y + 30);
await page.mouse.down();
await page.waitForTimeout(650);
await page.mouse.up();
await page.getByRole("button", { name: "做成书摘卡" }).click();
await page.locator(".share-preview img").waitFor();
await page.waitForTimeout(300);
check("a passage becomes a 书摘卡 with three layouts", (await page.getByRole("group", { name: "样式" }).getByRole("button").count()) === 3 && await page.locator(".share-preview img").evaluate((img) => img.naturalHeight > img.naturalWidth));
await shot("19-passage-card");
await page.getByRole("button", { name: "简洁", exact: true }).click();
await page.waitForTimeout(300);
await shot("19b-plain-card");
await page.keyboard.press("Escape");
await page.getByRole("button", { name: "返回", exact: true }).click();
// AUDIT_V4 §8 / AUDIT_V4_FUNCTION F6–F10, G1, H1, D5, D6, D8: the character panel's own editors.
await page.locator(".world-card", { hasText: dyingWorld }).first().locator(".world-open").click();
await page.locator(".turn").last().waitFor();
await page.getByRole("button", { name: "角色" }).click();
check("我 opens with a 人物小传: serif name, identity and 此时此地", (await page.locator(".bio-name").evaluate((el) => parseFloat(getComputedStyle(el).fontSize))) === 22 && (await page.locator(".bio-card").textContent()).includes("此时此地"));
await page.waitForTimeout(400);
await shot("17a-me");
await page.getByRole("button", { name: "改小传" }).click();
await page.locator(".sheet").getByLabel("名字", { exact: true }).fill("一二三四五六七八九十甲乙丙");
check("a name over 12 characters is marked and cannot be saved", (await page.locator(".sheet .field-suffix").textContent()) === "13/12" && await page.locator(".sheet").getByRole("button", { name: "保存" }).isDisabled());
await page.locator(".sheet").getByLabel("名字", { exact: true }).fill("沈长安");
await page.locator(".sheet").getByLabel("年龄", { exact: true }).fill("150");
check("an age outside 1–120 is marked inline", (await page.locator(".sheet").textContent()).includes("年龄要在 1～120 岁之间") && await page.locator(".sheet").getByRole("button", { name: "保存" }).isDisabled());
await page.locator(".sheet").getByLabel("年龄", { exact: true }).fill("24");
await page.locator(".sheet").getByLabel("金手指", { exact: true }).fill("熟读唐史");
await page.waitForTimeout(300);
await shot("17b-bio");
await page.locator(".sheet").getByRole("button", { name: "保存" }).click();
await page.locator(".bio-name", { hasText: "沈长安" }).waitFor();
check("the 人物小传 saves name, age and 金手指", (await page.locator(".bio-card").textContent()).includes("24 岁") && (await page.locator(".bio-card").textContent()).includes("熟读唐史"));
// Stats are edited by the words the panel shows; money is a whole number with its hint in the field.
await page.getByRole("button", { name: "修改", exact: true }).click();
check("health is edited by level words, not 0–100", (await page.getByRole("group", { name: "健康" }).getByRole("button").allTextContents()).join() === "康健,微恙,带伤,重伤,垂危");
await page.getByLabel("钱", { exact: true }).fill("12.7");
check("money takes whole numbers only, the hint stays inside the field", (await page.getByLabel("钱", { exact: true }).inputValue()) === "127" && (await page.locator(".field-line .field-suffix").count()) <= 1 && (await page.locator(".bio-fields + * small, label > small").count()) === 0);
await page.getByRole("group", { name: "精力" }).getByRole("button", { name: "疲惫" }).click();
await page.waitForTimeout(300);
await shot("17c-me-edit");
await page.getByRole("button", { name: "保存修改" }).click();
await page.getByRole("button", { name: "修改", exact: true }).waitFor();
check("a level saves as that word", (await page.locator(".stat", { hasText: "精力" }).textContent()).includes("疲惫"));
// 行囊: one editor per item; a name already there asks to merge.
await page.getByRole("tab", { name: /行囊/ }).click();
await page.getByRole("button", { name: "添加物品" }).click();
await page.locator(".sheet").getByLabel("名称", { exact: true }).fill("紫毫笔");
await page.locator(".sheet").getByLabel("数量", { exact: true }).fill("2");
await page.locator(".sheet").getByLabel("单位", { exact: true }).fill("支");
await page.locator(".sheet").getByLabel("放在哪", { exact: true }).fill("书箱");
await page.locator(".sheet").getByRole("button", { name: "保存" }).click();
await page.locator(".codex-item", { hasText: "紫毫笔" }).waitFor();
check("a new item has its unit and place", (await page.locator(".codex-item", { hasText: "紫毫笔" }).textContent()).includes("2 支") && (await page.locator(".codex-item", { hasText: "紫毫笔" }).textContent()).includes("放在书箱"));
await page.getByRole("button", { name: "添加物品" }).click();
await page.locator(".sheet").getByLabel("名称", { exact: true }).fill("紫毫笔");
await page.locator(".sheet").getByRole("button", { name: "保存" }).click();
await page.locator(".dialog").waitFor();
check("adding an item already in the bag asks whether to merge", (await page.textContent(".dialog")).includes("合并"));
await page.locator(".dialog").getByRole("button", { name: "合并" }).click();
await page.locator(".codex-item", { hasText: "3 支" }).waitFor();
await page.locator(".codex-item", { hasText: "紫毫笔" }).click();
await page.locator(".sheet").getByLabel("名称", { exact: true }).fill("湖笔");
await page.locator(".sheet").getByLabel("备注", { exact: true }).fill("西市买的");
await page.waitForTimeout(300);
await shot("17d-item");
await page.locator(".sheet").getByRole("button", { name: "保存" }).click();
await page.locator(".codex-item", { hasText: "湖笔" }).waitFor();
check("an item can be renamed and noted in its own editor", (await page.locator(".codex-item", { hasText: "湖笔" }).textContent()).includes("西市买的"));
await page.waitForTimeout(300);
await shot("17e-bag");
// Attitudes are coloured by closeness.
await page.getByRole("tab", { name: /人物/ }).click();
check("attitude tags carry a closeness class", (await page.locator(".person-side .tag[class*='att-']").count()) === (await page.locator(".person-side .tag").count()));
await page.waitForTimeout(300);
await shot("17f-people");
// 年表: the date is checked before saving, and an event can be edited.
await page.getByRole("tab", { name: "记事" }).click();
await page.getByRole("button", { name: "添加大事" }).click();
await page.getByLabel(/^日期/).fill("明年");
await page.getByLabel("发生什么").fill("城里闹瘟疫");
check("a date the game cannot count is flagged and cannot be saved", (await page.locator(".sheet").textContent()).includes("换算不了") && await page.locator(".sheet").getByRole("button", { name: "添加", exact: true }).isDisabled());
await page.getByLabel(/^日期/).fill(`${yearNow}腊月`);
await page.waitForTimeout(300);
await shot("17g-event");
await page.locator(".sheet").getByRole("button", { name: "添加", exact: true }).click();
await page.locator(".codex-item", { hasText: "城里闹瘟疫" }).click();
await page.locator(".sheet").getByRole("button", { name: "修改", exact: true }).click();
await page.getByLabel("发生什么").fill("城里闹时疫");
await page.locator(".sheet").getByRole("button", { name: "保存", exact: true }).click();
await page.locator(".codex-item", { hasText: "城里闹时疫" }).waitFor();
check("a great event can be edited", (await page.locator(".codex-item", { hasText: "城里闹瘟疫" }).count()) === 0);
// A chapter title cannot be emptied.
await page.locator(".codex-item", { hasText: "第 1 章" }).first().click();
await page.locator(".sheet").getByRole("button", { name: "修改", exact: true }).click();
await page.getByLabel("标题").fill("");
check("an empty chapter title disables save with a reason", await page.locator(".sheet").getByRole("button", { name: "保存", exact: true }).isDisabled() && (await page.locator(".sheet").textContent()).includes("标题不能空着"));
await page.keyboard.press("Escape");
// H1: an edit that changes nothing adds no line and says why.
await page.getByRole("tab", { name: /目标/ }).click();
const editsBeforeWish = await page.evaluate(async (title) => {
  const { game } = window.__lishi;
  const world = (await game.repo.listWorlds()).find((w) => w.title === title);
  const line = await game.repo.getLine(world.currentLineId);
  return { id: line.nodeId, goal: (await game.repo.getState(line.nodeId)).goals.find((g) => g.status === "进行中")?.name ?? null };
}, dyingWorld);
if (editsBeforeWish.goal) {
  const rejected = await page.evaluate(async ({ title, goal }) => {
    const { game } = window.__lishi;
    const world = (await game.repo.listWorlds()).find((w) => w.title === title);
    try { await game.editState(world.id, { goals: [{ op: "add", kind: "心愿", name: goal }] }, `新心愿：${goal}`); return null; } catch (e) { return e.reason ?? String(e); }
  }, { title: dyingWorld, goal: editsBeforeWish.goal });
  check("an edit the engine refuses adds no node and says why", typeof rejected === "string" && rejected.includes("已经有目标"));
}
await page.keyboard.press("Escape");
await page.locator(".panel").waitFor({ state: "detached" });
// G1: a bookmark named like an existing route gets a number and shows its game time.
const markTurn = page.locator(".turn").last();
await markTurn.scrollIntoViewIfNeeded();
const markBox = await markTurn.boundingBox();
await page.mouse.move(markBox.x + 40, markBox.y + 40);
await page.mouse.down();
await page.waitForTimeout(650);
await page.mouse.up();
await page.getByRole("button", { name: "加书签" }).click();
await page.getByLabel("名称", { exact: true }).fill("刚穿越来时");
await page.getByRole("button", { name: "保存", exact: true }).click();
await page.getByText(/已加书签/).waitFor();
await page.getByRole("button", { name: "更多" }).click();
await page.getByRole("button", { name: "世界线" }).click();
await page.locator(".line-row").first().waitFor();
check("a duplicate bookmark name gets a number", (await page.locator(".line-row", { hasText: "刚穿越来时（2）" }).count()) === 1);
check("route and bookmark cards show their game time", (await page.locator(".line-row .line-when").count()) === (await page.locator(".line-row:visible").count()));
await page.waitForTimeout(300);
await shot("17h-lines");
await page.keyboard.press("Escape");
await page.getByRole("button", { name: "返回", exact: true }).click();
// D5, D6: 我的开局 can be renamed and deleted; the one-line idea is kept with the draft.
await page.getByRole("button", { name: "开始新的故事" }).click();
await page.locator("[aria-label=\"一句话想法\"], [aria-label=\"名字\"]").first().waitFor();
if (await page.getByLabel("名字", { exact: true }).count()) { await page.getByRole("button", { name: "返回" }).first().click(); await page.getByLabel("一句话想法").waitFor(); }
await page.getByLabel("一句话想法").fill("我是长安城里的一个小郎中");
await page.locator(".template-row > button.template-card").first().click();
await page.getByRole("button", { name: "存为我的开局" }).click();
await page.locator(".dialog input").fill("举子开局");
await page.locator(".dialog").getByRole("button", { name: "保存" }).click();
await page.getByText("已保存到“我的开局”").waitFor();
await page.waitForTimeout(800);
await page.getByRole("button", { name: "返回" }).click();
await page.getByRole("button", { name: "返回" }).click();
await page.getByRole("button", { name: "开始新的故事" }).click();
// A draft with a name reopens on its setup; the idea lives on the first step.
await page.getByLabel("名字", { exact: true }).waitFor();
await page.getByRole("button", { name: "返回" }).first().click();
await page.getByLabel("一句话想法").waitFor();
const ideaKept = await page.getByLabel("一句话想法").inputValue();
check("the one-line idea is kept with the draft", ideaKept === "我是长安城里的一个小郎中", ideaKept);
await page.getByRole("button", { name: "“举子开局”的更多操作" }).click();
await page.getByRole("button", { name: "改名", exact: true }).click();
await page.locator(".dialog input").fill("我的举子");
await page.locator(".dialog").getByRole("button", { name: "保存" }).click();
await page.locator(".my-template", { hasText: "我的举子" }).waitFor();
await page.waitForTimeout(300);
await shot("17i-my-templates");
await page.getByRole("button", { name: "“我的举子”的更多操作" }).click();
await page.getByRole("button", { name: "删除", exact: true }).click();
await page.locator(".dialog").getByRole("button", { name: "删除" }).click();
await page.locator(".my-template", { hasText: "我的举子" }).waitFor({ state: "detached" });
check("我的开局 can be renamed and deleted", (await page.locator(".toast .toast-action", { hasText: "撤销" }).count()) === 1);
await page.getByRole("button", { name: "返回" }).click();

// No horizontal overflow, no page errors.
check("no horizontal overflow", !(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)));
check("no page errors", errors.length === 0, errors.join(" | "));

await browser.close();
console.log(results.join("\n"));
process.exitCode = results.some((r) => r.startsWith("FAIL")) ? 1 : 0;
