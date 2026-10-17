// The phone screenshots in README.md, reproducible from the code: its own Vite
// server (no dev bridge, no .env.local, never reads the dev secrets file), the
// local fake model, a fresh browser profile at 393×852 in the 纸张 theme, and
// sample worlds written straight into the engine. Requests to any other host
// are blocked, except the web font (Noto Serif SC, SIL OFL) that stands in for
// a phone's serif; --no-webfont uses this machine's fonts instead.
//   node scripts/ui/readme-shots.mjs [--port 1461] [--fake-port 18861] [--out docs/images/readme] [--no-webfont]
// Writes home.jpg (the bookshelf), story.jpg (a passage with its change chips
// and choices), opening.jpg (the 玩法 picker with an AI-drafted outline) and
// script.jpg (the 剧本 page after the first beat is played). No free world on
// the shelf yet: its cover seal takes the first character of the clock (第).
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { chromium } from "playwright-core";
import { connectFake } from "./connect.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const arg = (name, fallback) => { const at = process.argv.indexOf(name); return at > 0 ? process.argv[at + 1] : fallback; };
const port = Number(arg("--port", 1461));
const fakePort = Number(arg("--fake-port", 18861));
const out = path.resolve(root, arg("--out", "docs/images/readme"));
const webfont = !process.argv.includes("--no-webfont");
const SIZE = { width: 393, height: 852 };
const SCALE = 2;
const QUALITY = 78;
const LIMIT = 200 * 1024;
const origin = `http://127.0.0.1:${port}`;
const fakeOrigin = `http://127.0.0.1:${fakePort}`;
const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
const FONT_HOSTS = new Set(["fonts.googleapis.com", "fonts.gstatic.com"]);
const FONT_CSS = "https://fonts.googleapis.com/css2?family=Noto+Serif+SC:wght@400;600;700&display=block";
fs.mkdirSync(out, { recursive: true });

const fake = spawn(process.execPath, ["scripts/fake-llm.mjs", "--port", String(fakePort)], { cwd: root, windowsHide: true, stdio: "ignore" });
let server;
let browser;
let page;
const errors = [];
const written = [];
try {
  for (let i = 0; ; i++) {
    try { if ((await fetch(`${fakeOrigin}/v1/models`)).ok) break; } catch { /* not listening yet */ }
    if (i > 50) throw new Error(`the fake model did not start on port ${fakePort}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  // configFile:false keeps the project's disk-backed dev bridge (and its secrets file) out of this run.
  server = await createServer({
    root, configFile: false, envDir: false, cacheDir: path.join(root, ".cache/vite-readme"), plugins: [react()], logLevel: "warn",
    define: { __APP_VERSION__: JSON.stringify(version) },
    server: { host: "127.0.0.1", port, strictPort: true, watch: { ignored: ["**/target/**", "**/src-tauri/**", "**/output/**", "**/.cache/**", "**/.claude/**", "**/docs/**"] } },
  });
  await server.listen();

  browser = await chromium.launch({ channel: "msedge" });
  const context = await browser.newContext({
    viewport: SIZE, deviceScaleFactor: SCALE, isMobile: true, hasTouch: true, colorScheme: "light", reducedMotion: "reduce", locale: "zh-CN",
  });
  if (webfont) {
    await context.addInitScript((href) => {
      document.addEventListener("DOMContentLoaded", () => document.head.append(Object.assign(document.createElement("link"), { rel: "stylesheet", href })));
    }, FONT_CSS);
  }
  // The dev bridge, in memory: keys stay in this map, model calls go only to the local fake.
  const secrets = new Map();
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (webfont && FONT_HOSTS.has(url.hostname)) return route.continue();
    if (url.origin !== origin) return route.abort();
    if (!url.pathname.startsWith("/__dev/")) return route.continue();
    const body = route.request().postDataJSON() ?? {};
    const reply = (json) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(json) });
    if (url.pathname === "/__dev/config") return reply({});
    if (url.pathname === "/__dev/secret/set") { secrets.set(body.slot, body); return reply(null); }
    if (url.pathname === "/__dev/secret/remove") { secrets.delete(body.slot); return reply(null); }
    if (url.pathname === "/__dev/secret/has") return reply({ configured: secrets.has(body.slot), boundBaseUrl: secrets.get(body.slot)?.boundBaseUrl ?? null });
    if (new URL(body.url).origin !== fakeOrigin) return route.abort();
    if (url.pathname === "/__dev/llm/get") {
      const response = await fetch(body.url);
      return reply({ status: response.status, body: await response.text() });
    }
    if (url.pathname === "/__dev/llm/stream") {
      const response = await fetch(body.url, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer local-fake" }, body: JSON.stringify(body.body) });
      const events = [{ type: "open", status: response.status }];
      for (const line of (await response.text()).split("\n")) {
        const data = line.startsWith("data:") ? line.slice(5).trim() : "";
        if (data && data !== "[DONE]") events.push({ type: "data", data });
      }
      events.push({ type: "done" });
      return route.fulfill({ contentType: "application/x-ndjson", body: events.map((e) => JSON.stringify(e)).join("\n") + "\n" });
    }
    return route.abort();
  });

  page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  const settle = async () => {
    await page.locator(".toast").first().waitFor({ state: "detached", timeout: 8000 }).catch(() => {});
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(500);
  };
  const shoot = async (name) => {
    await settle();
    const file = path.join(out, `${name}.jpg`);
    await page.screenshot({ path: file, type: "jpeg", quality: QUALITY });
    written.push([name, fs.statSync(file).size]);
  };
  const flush = () => page.evaluate(() => window.__lishiFlush?.());

  // A fresh profile starts at the service setup: connect the fake model.
  await page.goto(origin);
  await page.getByText("连接 AI 服务").waitFor();
  await connectFake(page, { port: fakePort });
  await page.getByRole("button", { name: /随便穿/ }).waitFor();
  await page.waitForFunction(() => !!window.__lishi);

  // Sample worlds, oldest first so 长安雪夜 is the one on top of the shelf.
  await page.evaluate(async (appVersion) => {
    const repo = window.__lishi.game.repo;
    await repo.setSetting("whatsNewSeen", appVersion);
    await repo.setSetting("autoUpdateCheck", false);
    const hero = (over) => ({ name: "", aliases: [], age: 30, gender: "男", identity: "", origin: "", cheat: "", stats: { money: 300, debt: 0, health: 80, energy: 70, fame: 10 }, statuses: [], items: [], ...over });
    const base = (over) => ({ version: 2, placeId: null, people: [], places: [], cards: [], goals: [], deviations: [], ...over });
    const world = async ({ title, eraId, settings, state, opening, filler, last }) => {
      const made = await repo.createWorld({ title, eraId, settings, opening: { parentId: null, kind: "opening", narrative: opening, state } });
      let parent = made.node.id;
      for (let i = 1; i <= filler; i++) {
        const node = await repo.appendNode(made.world.id, made.line.id, { parentId: parent, kind: "turn", actionMode: "do", actionText: "往前走", narrative: i === filler ? last : "又过了一阵。", state });
        parent = node.id;
      }
      return { ...made, parent };
    };

    await world({
      title: "汴京梦华", eraId: "free", opening: "汴河上的船挤成一片。", filler: 6, last: "樊楼上有人拍案叫好，你抬头，正对上一双含笑的眼睛。",
      state: base({ time: { start: "宣和元年 三月初三", date: { era: "宣和", year: 1, month: 3, day: 3, ceYear: 1119, lunar: true }, startHour: 10, elapsedMinutes: 600 }, era: { packId: null },
        protagonist: hero({ name: "沈清和", age: 19, gender: "女", identity: "樊楼的琵琶女" }) }),
    });
    await world({
      title: "锦衣夜行", eraId: "free", opening: "北镇抚司的灯笼在风雪里晃。", filler: 23, last: "门外的雪地上，响起了绣春刀出鞘的声音。",
      state: base({ time: { start: "崇祯元年 正月初八", date: { era: "崇祯", year: 1, month: 1, day: 8, ceYear: 1628, lunar: true }, startHour: 20, elapsedMinutes: 2400 }, era: { packId: null },
        protagonist: hero({ name: "徐怀德", identity: "锦衣卫北镇抚司百户", stats: { money: 4000, debt: 0, health: 60, energy: 50, fame: 30 } }) }),
    });
    // The main sample: a Tang 落第举子 in the first snow of winter.
    const tang = base({
      time: { start: "天宝七载 冬月十七", startHour: 7, elapsedMinutes: 330 },
      era: { packId: "tang-748" },
      placeId: "pl-chongren",
      places: [
        { id: "pl-chongren", name: "崇仁坊", aliases: [], description: "皇城东南，候选官员与举子多在此赁屋，昼夜喧闹" },
        { id: "pl-xishi", name: "西市", aliases: [], description: "胡商云集，旗亭下常有人雇人抄写" },
      ],
      protagonist: hero({
        name: "李安", age: 22, identity: "落第举子，陇西人，滞留长安", origin: "历史系研究生",
        stats: { money: 120, debt: 0, health: 72, energy: 55, fame: 5 },
        statuses: [{ name: "风寒", detail: "微咳，夜里畏冷", sinceMinute: 0 }],
        items: [{ name: "旧书箱", quantity: 1, unit: "只", place: null, note: "" }, { name: "《文选》", quantity: 1, unit: "半卷", place: null, note: "卷首有自己写的一行小字" }],
      }),
      people: [
        { id: "p-wang", name: "王店主", aliases: [], role: "西市书肆店主", attitude: "友善", alive: true, origin: "雇你抄书，嘴上刻薄，心里不坏", notes: "预支了你六十文，等你三日后交第一卷", lastSeenMinute: 300 },
        { id: "p-zhou", name: "周婆", aliases: [], role: "崇仁坊房主", attitude: "冷淡", alive: true, notes: "收了六十文，说年前还差一贯二百文就赶人", lastSeenMinute: 320 },
      ],
      goals: [
        { id: "g1", name: "凑足房钱", kind: "主线", progress: "还差一贯二百文", status: "进行中" },
        { id: "g2", name: "替王店主抄完《文选》三卷", kind: "支线", progress: "第一卷三日后交", status: "进行中" },
      ],
    });
    const opening = "天宝七载 冬月十七 辰时\n\n冷。\n\n你是被冻醒的。窗纸透进一层青白的光，炭盆里只剩一撮灰。身下是硬邦邦的土榻，身上压着一床又薄又潮的絮被。\n\n记忆像隔着一层水涌上来——你叫李安，陇西人，今年春闱落第，滞留长安已有大半年。这间屋子赁在崇仁坊北曲，房主周婆昨夜又来敲过门：房钱拖了两个月，三日之内再不结清，就请郎君另寻住处。";
    const t = await repo.createWorld({ title: "长安雪夜", eraId: "tang-748", opening: { parentId: null, kind: "opening", narrative: opening, state: tang } });
    const turns = [
      { mode: "do", text: "收拾书箱，去西市找活计", chips: [{ text: "过了 2 刻", tone: "info" }, { text: "到 西市", tone: "info" }, { text: "结识 王店主", tone: "info" }],
        narrative: "西市的旗亭下早已挤满了人。胡商牵着骆驼从金光门进来，驼铃在雪地里闷闷地响；卖胡饼的炉子冒着白汽，芝麻的焦香混着牲口的膻味，一股脑往鼻子里钻。\n\n你在一家书肆门口站定。店主是个精瘦的中年人，回头打量你两眼：“郎君识字？替人抄书，一卷三十文，管一顿午饭。”" },
      { mode: "say", text: "“三十文太少了。我抄过秘书省的本子，楷书、行书都写得。”", chips: [{ text: "🎲 顺 · 讨价还价 · 成了", tone: "gain" }, { text: "王店主：友善", tone: "gain" }, { text: "新支线：替王店主抄完《文选》三卷", tone: "info" }],
        narrative: "王店主手上一顿，把经卷搁回竹架，又上下看了你一回。\n\n“秘书省的本子？”他嘴角往下一撇，“这话我一个月要听十回。”说着却从柜底抽出一张黄麻纸，又推过来一方砚，“写两行来看。”\n\n你提笔蘸墨，写下《文选》里的两句：“盛年不重来，一日难再晨。”墨色匀净，转折处见筋骨。\n\n店主看了半晌，把纸收进袖里：“四十文一卷。先抄三卷，抄得好，往后的活都给你。”" },
      { mode: "do", text: "先预支六十文，回去把房钱的事稳住", chips: [{ text: "过了半个时辰", tone: "info" }, { text: "钱 +60 文", tone: "gain" }, { text: "钱 −60 文", tone: "loss" }, { text: "周婆：冷淡", tone: "info" }],
        narrative: "王店主嘀咕了一句“读书人就是事多”，还是从钱箱里数出六十文，用麻绳串好，丢到你怀里。\n\n回崇仁坊的路上雪又大了。周婆倚在门口嗑瓜子，接过那串钱掂了掂，脸色松动了些：“还差一贯二百文。年前结不清，老身可就不讲情面了。”\n\n屋里的炭盆还是冷的。你刚翻开那半卷《文选》，门外有人轻轻叩了三下。",
        choices: ["开门看看是谁", "装作不在，先抄书", "隔着门问一声"] },
    ];
    let parent = t.node.id;
    for (const turn of turns) {
      const node = await repo.appendNode(t.world.id, t.line.id, {
        parentId: parent, kind: "turn", actionMode: turn.mode, actionText: turn.text, narrative: turn.narrative, state: tang,
        choices: turn.choices ?? [], meta: { chips: turn.chips },
      });
      parent = node.id;
    }
  }, version);
  await flush();
  await page.goto(origin);
  await page.locator(".card", { hasText: "长安雪夜" }).first().waitFor();
  const theme = await page.evaluate(() => document.documentElement.dataset.theme);
  if (theme !== "paper") throw new Error(`expected the 纸张 theme, got ${theme}`);
  if (webfont && !(await page.evaluate(async () => { await document.fonts.ready; return document.fonts.check('16px "Noto Serif SC"', "长安"); }))) {
    console.log("注意：网页字体没有加载（没有联网？），截图用的是本机字体。");
  }

  // 1. The bookshelf.
  await shoot("home");

  // 2. The end of the latest passage: the player's action, the change chips and the numbered choices.
  await page.locator(".world-open", { hasText: "长安雪夜" }).click();
  await page.locator(".turn").last().waitFor();
  await page.locator(".dock .choice").first().waitFor();
  await page.evaluate(() => { const story = document.querySelector(".story"); story.scrollTop = story.scrollHeight; });
  await shoot("story");

  // 3. A new story from an inspiration, 剧本 picked, the outline drafted by the (fake) AI.
  await page.getByRole("button", { name: "返回", exact: true }).click();
  await page.getByRole("button", { name: /^(开始穿越|开始新的故事)$/ }).click();
  await page.getByRole("button", { name: /查看全部/ }).click();
  await page.locator(".template-card", { hasText: "落第举子" }).click();
  const styles = page.getByRole("group", { name: "玩法" });
  await styles.getByRole("button", { name: /^剧本：/ }).click();
  await page.getByRole("button", { name: "AI 帮我拟大纲" }).click();
  await page.getByText("已拟好大纲，都可以改").waitFor({ timeout: 15000 });
  await page.locator(".play-styles").evaluate((el) => {
    let box = el.parentElement;
    while (box && getComputedStyle(box).overflowY !== "auto" && getComputedStyle(box).overflowY !== "scroll") box = box.parentElement;
    const scroller = box ?? document.scrollingElement;
    scroller.scrollTop += el.getBoundingClientRect().top - 64;
  });
  await shoot("opening");

  // 4. Play two passages so the first beat is done, then open the 剧本 page.
  await page.locator(".sticky-bar .primary").click();
  const banner = page.locator(".mode-banner");
  await banner.waitFor({ timeout: 20000 });
  await page.locator(".dock .choice").first().waitFor({ timeout: 20000 });
  const input = page.locator(".inputbar textarea");
  for (let i = 0; i < 2; i++) {
    const before = await page.locator(".turn[data-node-id]").count();
    await input.fill("");
    await page.locator(".send-btn").click();
    await page.waitForFunction((n) => document.querySelectorAll(".turn[data-node-id]").length > n && document.querySelector(".send-btn")?.textContent !== "停止", before, { timeout: 20000 });
  }
  await page.locator(".chip", { hasText: "第 1 幕演完" }).waitFor({ timeout: 20000 });
  await banner.getByRole("button").click();
  await page.getByRole("dialog", { name: "剧本" }).waitFor();
  await shoot("script");
} finally {
  await browser?.close().catch(() => {});
  await server?.close().catch(() => {});
  fake.kill();
}

for (const [name, bytes] of written) console.log(`${name}.jpg  ${Math.round(bytes / 1024)} KB${bytes > LIMIT ? "  ← 超过 200 KB" : ""}`);
console.log(errors.length ? `页面错误：${errors.slice(0, 3).join(" | ")}` : "没有页面错误");
console.log(`截图在 ${path.relative(root, out) || "."}`);
process.exit(errors.length || written.length !== 4 ? 1 : 0);
