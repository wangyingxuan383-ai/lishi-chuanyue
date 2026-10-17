// R14 play modes at phone size in the browser dev harness, against fake-llm:
// 剧本 (outline → chips → banner → edit → undo → end card), 挑战 (a ready-made
// card → banner → won → 再挑战一次 → lost → 回到之前 → give up → a new one from
// 本局设置), 旁观 (继续, directions, 连播 3 stopped mid-way, taking the
// protagonist back). The fake's mode triggers are listed in docs/DEVELOPMENT.md.
//   node scripts/fake-llm.mjs --port 18852 &  node_modules/.bin/vite --port 1452 --strictPort &
//   LISHI_APP=http://127.0.0.1:1452/ LISHI_FAKE_PORT=18852 node scripts/ui/modes.mjs
// Fresh browser profile. Screenshots of every new screen at 393×852 and 360×800,
// 纸张 and 夜间, go to output/playwright/modes/ (ignored by git).
import fs from "node:fs";
import { chromium } from "playwright-core";
import { connectFake } from "./connect.mjs";

const out = "output/playwright/modes";
fs.mkdirSync(out, { recursive: true });
const app = process.env.LISHI_APP ?? "http://127.0.0.1:1420/";
const port = Number(process.env.LISHI_FAKE_PORT ?? 18800);
const results = [];
const check = (name, ok, detail = "") => results.push(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
const browser = await chromium.launch({ channel: "msedge" });
const context = await browser.newContext({ viewport: { width: 393, height: 852 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
const report = () => {
  console.log([...results, ...errors.map((e) => `page error: ${e}`)].join("\n"));
  const failed = results.filter((r) => r.startsWith("FAIL")).length + errors.length;
  console.log(`${results.length - failed} passed, ${failed} failed`);
  return failed;
};
process.on("uncaughtException", async (error) => {
  await page.screenshot({ path: `${out}/failure.png` }).catch(() => {});
  results.push(`FAIL crashed — ${String(error.message ?? error).split("\n").slice(0, 4).join(" ¦ ")}`);
  report();
  await browser.close().catch(() => {});
  process.exit(1);
});

/** Every new screen in both phone sizes and both day and night paper; 360 must not scroll sideways. */
const SIZES = [[393, 852], [360, 800]];
const THEMES = ["paper", "night"];
const overflowAt = [];
const snap = async (name) => {
  for (const [width, height] of SIZES) {
    await page.setViewportSize({ width, height });
    for (const theme of THEMES) {
      await page.evaluate((t) => { document.documentElement.dataset.theme = t; }, theme);
      await page.waitForTimeout(260);
      await page.screenshot({ path: `${out}/${name}-${width}-${theme}.png` });
    }
    if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) overflowAt.push(`${name}@${width}`);
  }
  await page.setViewportSize({ width: 393, height: 852 });
  await page.evaluate(() => { document.documentElement.dataset.theme = "paper"; });
  await page.waitForTimeout(120);
};
const once = async (name) => { await page.waitForTimeout(200); await page.screenshot({ path: `${out}/${name}-393-paper.png` }); };

const input = page.locator(".inputbar textarea");
const banner = page.locator(".mode-banner");
const turnCount = () => page.locator(".turn[data-node-id]").count();
/** One passage: tap the main button (with words, or empty for 继续) and wait until it is saved. */
const play = async (text = "") => {
  const before = await turnCount();
  await input.fill(text);
  await page.locator(".send-btn").click();
  await page.waitForFunction((n) => document.querySelectorAll(".turn[data-node-id]").length > n && document.querySelector(".send-btn")?.textContent !== "停止", before, { timeout: 20000 });
  await page.waitForTimeout(150);
};
const more = async (name) => { await page.getByRole("button", { name: "更多" }).click(); await page.getByRole("button", { name, exact: true }).click(); };
const newStory = async () => {
  await page.getByRole("button", { name: "返回" }).click();
  await page.getByRole("button", { name: /^(开始穿越|开始新的故事)$/ }).click();
  await page.getByRole("button", { name: /随便穿/ }).waitFor();
};
const styles = page.getByRole("group", { name: "玩法" });
const worlds = () => page.evaluate(async () => (await window.__lishi.game.repo.listWorlds()).length);

await page.goto(app);
await page.getByText("连接 AI 服务").waitFor();
await connectFake(page, { port });
await page.getByRole("button", { name: /随便穿/ }).waitFor();

// ---------- 剧本 ----------
await page.getByRole("button", { name: /查看全部/ }).click();
await page.locator(".template-card", { hasText: "落第举子" }).click();
check("自由 is the default and shows no editor", (await styles.locator('[aria-pressed="true"]').getAttribute("aria-label")).startsWith("自由") && (await page.locator(".mode-panel").count()) === 0);
const plainScreens = await page.evaluate(() => document.documentElement.scrollHeight / innerHeight);
check("with 自由 the setup still reads in about two screens", plainScreens <= 2.3, `${plainScreens.toFixed(2)} 屏`);
await styles.getByRole("button", { name: /^剧本：/ }).click();
check("剧本 opens the outline editor, and 开始 names what is missing", (await page.locator(".mode-panel").count()) === 1 && (await page.locator(".sticky-bar .primary").textContent()) === "还差剧本");
check("an empty beat is not marked before 开始 is tapped", (await page.locator(".beat-row .wanted").count()) === 0);
await page.locator(".sticky-bar .primary").click();
check("tapping 开始 goes to the first beat", await page.getByLabel("第一幕", { exact: true }).evaluate((el) => el === document.activeElement && el.classList.contains("wanted")));
await page.getByRole("button", { name: "AI 帮我拟大纲" }).click();
await page.getByText("已拟好大纲，都可以改").waitFor({ timeout: 15000 });
check("AI drafts the outline into the empty parts", (await page.getByLabel("第五幕", { exact: true }).inputValue()) === "真相大白，名动西市" && (await page.getByLabel("主线", { exact: true }).inputValue()).includes("落第书生"));
await page.getByRole("button", { name: "第四幕的操作" }).click();
await page.getByRole("button", { name: "把第四幕上移" }).click();
check("a beat moves up", (await page.getByLabel("第三幕", { exact: true }).inputValue()) === "夜探城隍庙");
await page.getByRole("button", { name: "把第三幕下移" }).click();
check("and back down", (await page.getByLabel("第四幕", { exact: true }).inputValue()) === "夜探城隍庙");
await page.getByRole("button", { name: "第四幕的操作" }).click();
await page.locator(".play-styles").scrollIntoViewIfNeeded();
await snap("01-setup-script");
await page.locator(".sticky-bar .primary").click();
await banner.waitFor({ timeout: 20000 });
await page.locator(".dock .choice").first().waitFor({ timeout: 20000 });
check("the banner shows the first beat", (await banner.textContent()).includes("第 1/5 幕") && (await banner.textContent()).includes("邸店掌柜催讨房钱"));
check("the banner is a slim line", (await banner.boundingBox()).height <= 42, `${(await banner.boundingBox()).height}px`);
await snap("02-play-script");
await play();
await play();
await page.locator(".chip", { hasText: "📜 第 1 幕演完" }).waitFor({ timeout: 20000 });
check("a played beat leaves a chip and the banner moves on", (await banner.textContent()).includes("第 2/5 幕"));
await banner.getByRole("button").click();
const scriptSheet = page.getByRole("dialog", { name: "剧本" });
await scriptSheet.waitFor();
check("the 剧本 page marks played, current and upcoming beats", (await scriptSheet.locator(".script-beat.done").count()) === 1 && (await scriptSheet.locator(".script-beat.current").count()) === 1 && (await scriptSheet.locator(".script-beat.upcoming").count()) === 3);
await snap("03-script-sheet");
await scriptSheet.getByRole("button", { name: "第二幕的操作" }).click();
await snap("03b-script-sheet-tools");
await scriptSheet.getByRole("button", { name: "演完了", exact: true }).click();
await scriptSheet.getByRole("button", { name: "保存", exact: true }).click();
await page.locator(".edit-line", { hasText: "你把第二幕标为演完" }).waitFor();
check("marking a beat played is one line in the story, and the banner moves on", (await banner.textContent()).includes("第 3/5 幕"));
await page.locator(".toast .toast-action", { hasText: "撤销" }).click();
await page.locator(".edit-line", { hasText: "你把第二幕标为演完" }).waitFor({ state: "detached" });
check("the edit can be undone from the toast", (await banner.textContent()).includes("第 2/5 幕"));
await banner.getByRole("button").click();
await scriptSheet.getByRole("button", { name: /^第五幕：/ }).click();
await scriptSheet.getByLabel("第五幕", { exact: true }).fill("真相大白，名动长安");
await scriptSheet.getByRole("button", { name: "加一幕" }).click();
await scriptSheet.getByLabel("第六幕", { exact: true }).fill("衣锦还乡");
// A new beat opens with its tools; 删去 takes it out again.
await scriptSheet.getByRole("button", { name: "删去", exact: true }).click();
check("a beat can be added and removed", (await scriptSheet.locator(".script-beat").count()) === 5);
for (const name of ["第二幕", "第三幕", "第四幕"]) {
  await scriptSheet.getByRole("button", { name: `${name}的操作` }).click();
  await scriptSheet.getByRole("button", { name: "演完了", exact: true }).click();
}
await scriptSheet.getByRole("button", { name: "保存", exact: true }).click();
await page.locator(".edit-line", { hasText: "你修改了剧本" }).waitFor();
check("words, an added and a removed beat are saved as one edit", (await banner.textContent()).includes("第 5/5 幕") && (await banner.textContent()).includes("真相大白"));
await play();
await play();
await page.locator(".mode-end", { hasText: "剧本演完了" }).waitFor({ timeout: 20000 });
check("the last beat played ends with the script card, and the banner goes", (await banner.count()) === 0 && (await page.locator(".chip", { hasText: "📜 第 5 幕演完" }).count()) === 1);
await page.locator(".mode-end").scrollIntoViewIfNeeded();
await snap("04-script-end");
await page.getByRole("button", { name: "写尾声" }).click();
check("写尾声 puts an epilogue note in the box as 幕后", (await input.inputValue()).includes("尾声") && (await page.locator(".mode-btn").textContent()) === "幕后" && (await page.locator(".mode-end").count()) === 0);
await input.fill("");

// ---------- 挑战 ----------
await newStory();
await page.getByRole("button", { name: /自己从头写/ }).click();
await styles.getByRole("button", { name: /^挑战：/ }).click();
check("挑战 offers eight ready-made challenges", (await page.locator(".challenge-card").count()) === 8);
await page.locator(".challenge-card", { hasText: "赎回祖宅" }).click();
check("a card fills the story, the protagonist and the challenge", (await page.getByLabel("故事设定").inputValue()).includes("苏州") && (await page.getByLabel("名字", { exact: true }).inputValue()) === "顾湘君"
  && (await page.textContent("body")).includes("由身份决定") && (await page.getByLabel("挑战目标").inputValue()).includes("三百两"));
check("a challenge sets 运势 to 有影响 by default", (await page.locator(".fold", { hasText: "更多" }).textContent()).includes("运势有影响"));
await page.getByLabel("期限", { exact: true }).fill("春节前");
check("a limit that gives no span is pointed out", (await page.getByText("看不出有多久").count()) === 1);
await page.getByRole("group", { name: "常用期限" }).getByRole("button", { name: "三个月" }).click();
check("a picked limit shows how many days it gives", (await page.locator(".mode-panel .field-suffix").textContent()).includes("90 天"));
await page.locator(".challenge-row").scrollIntoViewIfNeeded();
await snap("05-setup-challenge");
await page.locator(".sticky-bar .primary").click();
await banner.waitFor({ timeout: 20000 });
await page.locator(".dock .choice").first().waitFor({ timeout: 20000 });
check("the banner shows the time left and the goal", /挑战 · 还剩 \d+ 天/.test(await banner.textContent()) && (await banner.textContent()).includes("凑够三百两"));
check("the challenge world plays with 运势 有影响", await page.evaluate(async () => (await window.__lishi.game.repo.listWorlds())[0].settings.fortune) === "on");
await snap("06-play-challenge");
await banner.getByRole("button").click();
const challengeSheet = page.getByRole("dialog", { name: "挑战" });
await challengeSheet.waitFor();
const challengePage = await challengeSheet.textContent();
check("the 挑战 page shows the goal, time left, failure and progress", ["凑够三百两", "还剩", "当铺提前把祖宅转卖给别人", "还没有头绪"].every((t) => challengePage.includes(t)), challengePage.slice(0, 90));
await snap("07-challenge-sheet");
await page.keyboard.press("Escape");
await challengeSheet.waitFor({ state: "detached" });
await play("把账册上的欠款一笔笔收回，终于达成目标");
await page.locator(".mode-end", { hasText: "挑战成功" }).waitFor({ timeout: 20000 });
check("a won challenge ends with its card and chip, and the banner goes", (await page.locator(".chip", { hasText: "⚑ 挑战成功" }).count()) === 1 && (await banner.count()) === 0);
check("the end card says what it came to and how long it took", (await page.locator(".mode-end").textContent()).includes("主角做成了这件事") && (await page.locator(".mode-end").textContent()).includes("用了"));
await page.locator(".mode-end").scrollIntoViewIfNeeded();
await snap("08-challenge-won");
await page.getByRole("button", { name: "继续玩下去" }).click();
check("继续玩下去 puts the card away and the story goes on", (await page.locator(".mode-end").count()) === 0 && (await page.locator(".send-btn").textContent()) === "继续");
// A new challenge after the won one, from 本局设置: its time counts from now.
await more("本局设置");
const settings = page.getByRole("dialog", { name: "本局设置" });
check("本局设置 has one 玩法 group with who plays and the two entries", (await settings.locator(".settings-sub", { hasText: "玩法" }).count()) === 1 && (await settings.getByRole("group", { name: "主角由谁来演" }).count()) === 1 && (await settings.locator(".mode-entries .settings-entry").count()) === 2);
await snap("11-settings-modes");
const newChallenge = async (goal) => {
  await more("本局设置");
  await settings.getByRole("button", { name: /^挑战：.*查看或换一个$/ }).click();
  await challengeSheet.getByRole("button", { name: "换一个挑战" }).click();
  await challengeSheet.getByLabel("挑战目标").fill(goal);
  await challengeSheet.getByRole("group", { name: "常用期限" }).getByRole("button", { name: "十日" }).click();
};
await page.keyboard.press("Escape");
await settings.waitFor({ state: "detached" });
await newChallenge("十日内找出纵火的人");
await snap("12-new-challenge");
await challengeSheet.getByRole("button", { name: "开始挑战" }).click();
await page.locator(".edit-line", { hasText: "你加了一个挑战" }).waitFor();
check("a challenge added mid-game counts its time from now", (await banner.textContent()).includes("还剩 10 天") && (await banner.textContent()).includes("纵火"));
await play("我放弃抵抗了");
await page.locator(".mode-end", { hasText: "挑战失败" }).waitFor({ timeout: 20000 });
check("a lost challenge ends with its card", (await page.locator(".chip", { hasText: "⚑ 挑战失败" }).count()) === 1 && (await page.locator(".mode-end").textContent()).includes("主角放弃了抵抗"));
await page.locator(".mode-end").scrollIntoViewIfNeeded();
await snap("09-challenge-lost");
await page.getByRole("button", { name: "回到之前" }).click();
await page.locator(".mode-end").waitFor({ state: "detached" });
check("回到之前 takes the losing passage back and the challenge goes on", /挑战 · 还剩/.test(await banner.textContent()));
await banner.getByRole("button").click();
await challengeSheet.getByRole("button", { name: "放弃挑战" }).click();
await page.locator(".dialog").waitFor();
check("giving up asks in the app's own dialog", (await page.locator(".dialog").textContent()).includes("放弃这个挑战"));
await snap("10-abandon-dialog");
await page.locator(".dialog").getByRole("button", { name: "放弃挑战" }).click();
await page.locator(".edit-line", { hasText: "你放弃了挑战" }).waitFor();
check("a challenge given up leaves an ordinary story", (await banner.count()) === 0);
await newChallenge("十日内查明纵火的人");
await challengeSheet.getByRole("button", { name: "开始挑战" }).click();
await page.locator(".edit-line", { hasText: "你加了一个挑战" }).last().waitFor();
// A month passing runs past the ten days: the program ends it.
await more("过些日子");
await page.getByRole("button", { name: "一个月", exact: true }).click();
await page.getByRole("button", { name: "开始", exact: true }).click();
await page.locator(".mode-end", { hasText: "挑战失败" }).waitFor({ timeout: 20000 });
check("a limit that runs out ends the challenge with 期限已到", (await page.locator(".mode-end").textContent()).includes("期限已到") && (await page.locator(".chip", { hasText: "⚑ 挑战失败：期限已到" }).count()) === 1);
await page.setViewportSize({ width: 1280, height: 800 });
await page.waitForTimeout(400);
await page.screenshot({ path: `${out}/16-desktop-challenge-end-1280-paper.png` });
check("on a wide window the end card stays in the story column", await page.locator(".mode-end").evaluate((el) => el.getBoundingClientRect().right <= document.querySelector(".play").getBoundingClientRect().right));
await page.setViewportSize({ width: 393, height: 852 });
const worldsBefore = await worlds();
await page.getByRole("button", { name: "再挑战一次" }).click();
await banner.waitFor({ timeout: 20000 });
await page.locator(".dock .choice").first().waitFor({ timeout: 20000 });
const worldsAfter = await worlds();
check("再挑战一次 starts one new world with this challenge at once", worldsAfter === worldsBefore + 1 && (await banner.textContent()).includes("查明纵火") && (await banner.textContent()).includes("还剩 10 天"), `${worldsBefore} → ${worldsAfter}: ${await banner.textContent()}`);

// ---------- 旁观 ----------
await newStory();
await page.getByRole("button", { name: /查看全部/ }).click();
await page.locator(".template-card", { hasText: "落第举子" }).click();
await styles.getByRole("button", { name: /^旁观：/ }).click();
check("旁观 adds one line and no editor", (await page.locator(".mode-panel").count()) === 0 && (await page.locator(".mode-hint").textContent()).includes("接过主角"));
await page.locator(".sticky-bar .primary").click();
await page.locator(".dock .choice").first().waitFor({ timeout: 20000 });
check("the 旁观 dock: 幕后, the director's placeholder, 继续 and 连播", (await page.locator(".mode-btn").textContent()) === "幕后" && (await input.getAttribute("placeholder")).startsWith("想让故事往哪走？")
  && (await page.locator(".send-btn").textContent()) === "继续" && (await page.getByRole("button", { name: "连播", exact: true }).count()) === 1);
check("the suggestions read as directions", (await page.locator(".choices-head").textContent()) === "接下来可以……");
await snap("13-watch-dock");
await input.fill("让王掌柜先松口");
check("with words the main button is 发送", (await page.locator(".send-btn").textContent()) === "发送");
await input.fill("");
await page.locator(".mode-btn").click();
check("the input offers only 幕后 and 写", (await page.locator(".mode-option").count()) === 2);
await page.keyboard.press("Escape");
await play();
check("旁观 passages have no （继续） line", (await page.locator(".turn-action.continue").count()) === 0);
const direction = (await page.locator(".choice").first().textContent()).trim();
const beforeDirection = await turnCount();
await page.locator(".choice").first().click();
await page.waitForFunction((n) => document.querySelectorAll(".turn[data-node-id]").length > n && document.querySelector(".send-btn")?.textContent !== "停止", beforeDirection, { timeout: 20000 });
check("tapping a direction sends it as a 幕后 note", (await page.locator(".turn-action.direct").last().textContent()) === direction);
const beforeAuto = await turnCount();
await page.getByRole("button", { name: "连播", exact: true }).click();
await page.getByRole("button", { name: "连播 3 段" }).waitFor();
await snap("14-autoplay-sheet");
await page.getByRole("button", { name: "连播 3 段" }).click();
await page.getByText("连播 2/3").waitFor({ timeout: 20000 });
check("连播 shows its step and 停止", (await page.locator(".send-btn").textContent()) === "停止");
await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
await once("15-autoplay-running");
await page.locator(".send-btn").click();
await page.waitForFunction(() => document.querySelector(".send-btn")?.textContent === "继续", null, { timeout: 20000 });
const played = (await turnCount()) - beforeAuto;
check("停止 ends 连播 part-way, keeping what was written", played >= 1 && played < 3, `${played} 段`);
check("after 连播 the dock is back to 连播", (await page.getByRole("button", { name: "连播", exact: true }).count()) === 1 && (await page.getByText(/连播 \d\/3/).count()) === 0);
await more("本局设置");
await page.getByRole("group", { name: "主角由谁来演" }).getByRole("button", { name: "我", exact: true }).click();
await page.keyboard.press("Escape");
await page.getByRole("dialog", { name: "本局设置" }).waitFor({ state: "detached" });
check("taking the protagonist back restores the player's dock", (await page.locator(".mode-btn").textContent()) === "做" && (await page.getByRole("button", { name: "连播", exact: true }).count()) === 0);
await more("本局设置");
await page.getByRole("button", { name: "加一个剧本" }).click();
const newScript = page.getByRole("dialog", { name: "加一个剧本" });
await newScript.getByLabel("第一幕", { exact: true }).fill("在西市撞见旧识");
await snap("17-add-script");
await newScript.getByRole("button", { name: "开始这个剧本" }).click();
await page.locator(".edit-line", { hasText: "你加了一个剧本" }).waitFor();
check("a script added mid-game starts at its first beat", (await banner.textContent()).includes("第 1/1 幕") && (await banner.textContent()).includes("在西市撞见旧识"));

check("no screen scrolls sideways at 360", overflowAt.length === 0, overflowAt.join(", "));
check("no page errors", errors.length === 0);
const failed = report();
await browser.close();
process.exit(failed ? 1 : 0);
