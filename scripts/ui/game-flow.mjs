// R02 game flow at phone size in the browser dev harness, against fake-llm.
//   node scripts/fake-llm.mjs & pnpm dev &  node scripts/ui/game-flow.mjs
// Uses a fresh browser profile; screenshots go to .cache/ui/game-*.png.
import fs from "node:fs";
import { chromium } from "playwright-core";

const out = ".cache/ui";
fs.mkdirSync(out, { recursive: true });
const results = [];
const check = (name, ok, detail = "") => results.push(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
const browser = await chromium.launch({ channel: "msedge" });
const context = await browser.newContext({ viewport: { width: 393, height: 852 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
const shot = (name) => page.screenshot({ path: `${out}/game-${name}.png` });

await page.goto("http://127.0.0.1:1420/");

// First launch → AI service setup.
await page.getByText("连接 AI 服务").waitFor();
await shot("01-setup");
await page.getByRole("button", { name: "自定义" }).click();
await page.getByLabel("服务地址").fill("http://127.0.0.1:18800/v1");
await page.getByText(/这是 HTTP 地址/).click();
await page.getByLabel(/API Key/).fill("fake-ui-key");
await page.getByRole("button", { name: "获取模型列表" }).click();
await page.locator("select").waitFor();
await page.locator("select").selectOption("fake-normal");
await page.getByRole("button", { name: "测试连接" }).click();
await page.getByText(/连接成功/).waitFor();
check("setup: models + connection test", true);
await page.getByRole("button", { name: "保存，开始穿越" }).click();

// New game: templates fill fields, gender locks when the identity implies it.
await page.getByRole("button", { name: "随便穿" }).waitFor();
await shot("02-newgame");
await page.locator(".template-card", { hasText: "相府庶女" }).click();
check("template fills premise and identity", (await page.getByLabel(/故事设定/).inputValue()).includes("平康坊") && (await page.getByLabel("身份与处境").inputValue()).includes("庶女"));
check("gender locked by identity", (await page.textContent("body")).includes("性别：女（由身份决定）"));
await page.getByRole("button", { name: /查看全部/ }).click();
check("all templates listed", (await page.locator(".template-card").count()) >= 18);
await page.locator(".template-card", { hasText: "留洋归来" }).click();
check("neutral identity offers a gender choice", (await page.getByRole("button", { name: "男", exact: true }).count()) === 1);

// AI assist fills only empty fields.
await page.getByLabel(/故事设定/).fill("");
await page.getByLabel(/一句话想法/).fill("靖康之变前，我是汴京小吏");
await page.getByRole("button", { name: "AI 帮我补全" }).click();
await page.getByText("已补全空着的部分").waitFor({ timeout: 15000 });
check("assist fills the empty premise", (await page.getByLabel(/故事设定/).inputValue()).includes("宣和七年"));
check("assist keeps the filled identity", (await page.getByLabel("身份与处境").inputValue()).includes("留学归来"));

// A player-written opening on a fresh template.
await page.locator(".template-card", { hasText: "落第举子" }).click();
await page.getByRole("button", { name: "我自己写" }).click();
await page.getByLabel("开场正文").fill("雨夜，破庙。你缩在神像后面，听见外面有脚步声。");
await page.getByRole("button", { name: "开始" }).click();
await page.locator(".dock .choice").first().waitFor({ timeout: 20000 });
check("player-written opening kept verbatim", (await page.textContent(".story")).includes("雨夜，破庙。你缩在神像后面"));
check("opening state extracted", (await page.locator(".choice").first().textContent()) === "生火取暖");
await page.getByRole("button", { name: "返回" }).click();

// An AI-written opening via one-tap random start.
await page.getByRole("button", { name: "开始穿越" }).click();
await page.getByRole("button", { name: "随便穿" }).click();
await page.locator(".dock .choice").first().waitFor({ timeout: 20000 });
await shot("03-opening");
check("opening streamed and choices shown", (await page.locator(".choice").count()) === 3);
check("record not visible", !(await page.textContent("body")).includes("<record"));

// "写" mode: the player writes narrative directly.
await page.locator(".mode-btn").click();
await page.locator(".mode-btn").click();
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
await page.locator(".inputbar textarea").fill("推开门出去看看");
check("send button says 发送", (await page.locator(".send-btn").textContent()) === "发送");
await page.locator(".send-btn").click();
await page.getByRole("button", { name: "停止" }).waitFor();
await page.getByRole("button", { name: "重说" }).waitFor({ timeout: 20000 });
await shot("04-turn");
check("turn appended with player action", (await page.textContent("body")).includes("推开门出去看看"));

// The scripted fake replies rotate: this turn paid 30 coins.
check("money chip after paying", (await page.locator(".chip", { hasText: /钱 −30/ }).count()) === 1);

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
await page.getByRole("tab", { name: /人物/ }).click();
const panelText = await page.textContent(".panel");
check("panel lists people", panelText.includes("货栈管事"));
await page.getByRole("tab", { name: /行囊/ }).click();
check("panel lists items", (await page.textContent(".panel")).includes("旧书"));
await shot("06-panel");
await page.keyboard.press("Escape");
await page.locator(".panel").waitFor({ state: "detached" });
check("back closes panel", true);

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
await page.getByRole("button", { name: "更多" }).click();
await page.getByRole("button", { name: "世界线" }).click();
const lines = await page.locator(".sheet .card").count();
check("old route kept as a world line", lines === 2, `${lines} lines`);
await page.keyboard.press("Escape");

// Stop mid-generation keeps partial text as interrupted.
await page.getByRole("button", { name: "更多" }).click();
await page.getByRole("button", { name: "本局设置" }).click();
await page.keyboard.press("Escape");

// Reload persists everything.
await page.reload();
await page.getByText("继续游玩").waitFor();
await shot("08-home");
check("home lists the world after reload", (await page.locator(".card").count()) >= 1);

// No horizontal overflow, no page errors.
check("no horizontal overflow", !(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)));
check("no page errors", errors.length === 0, errors.join(" | "));

await browser.close();
console.log(results.join("\n"));
process.exitCode = results.some((r) => r.startsWith("FAIL")) ? 1 : 0;
