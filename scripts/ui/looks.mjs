// R09-T001: screenshots of the three visual directions (src/ui/styles/looks.css)
// on the same sample worlds, at phone size, plus one board per direction and an
// overview, for the user to choose from. Web fonts stand in for the phone's
// own (Noto Serif/Sans SC, 霞鹜文楷); they are loaded only here.
//   node scripts/fake-llm.mjs & pnpm dev &  node scripts/ui/looks.mjs [--out docs/design]
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";

const out = path.resolve(process.argv.includes("--out") ? process.argv[process.argv.indexOf("--out") + 1] : ".cache/ui/looks");
const shots = path.resolve(".cache/ui/looks");
fs.mkdirSync(out, { recursive: true });
fs.mkdirSync(shots, { recursive: true });

const LOOKS = [
  { id: "scroll", name: "甲 · 宣纸书卷", line: "像在读一本线装书：纸色底子、宋体正文、朱砂色的印记与编号，选项写成“一、二、三”。历史味最浓。" },
  { id: "modern", name: "乙 · 简洁现代", line: "像现在的读书和聊天应用：无衬线字、大留白、柔和的白卡片，你的行动像一条发出去的消息。最清爽，历史味交给文字本身。" },
  { id: "candle", name: "丙 · 夜读", line: "深色底、烛光一样的暖色字，正文用楷体，金色点缀。适合夜里躺着读，长时间看不刺眼。" },
];
const FONTS = [
  "https://fonts.googleapis.com/css2?family=Noto+Serif+SC:wght@400;600;700&family=Noto+Sans+SC:wght@400;500;700&display=block",
  "https://cdn.jsdelivr.net/npm/lxgw-wenkai-screen-webfont@1.7.0/style.css",
];

const browser = await chromium.launch({ channel: "msedge" });
const context = await browser.newContext({ viewport: { width: 393, height: 852 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
await context.addInitScript((urls) => {
  document.addEventListener("DOMContentLoaded", () => {
    for (const href of urls) document.head.append(Object.assign(document.createElement("link"), { rel: "stylesheet", href }));
  });
}, FONTS);
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));

// A fresh profile starts at the service setup; connect the fake model.
await page.goto("http://127.0.0.1:1420/");
await page.getByText("连接 AI 服务").waitFor();
await page.getByRole("button", { name: "自定义" }).click();
await page.getByLabel("服务地址").fill("http://127.0.0.1:18800/v1");
await page.getByText(/这是 HTTP 地址/).click();
await page.getByLabel(/API Key/).fill("fake-ui-key");
await page.getByRole("button", { name: "获取模型列表" }).click();
await page.locator("select").waitFor();
await page.locator("select").selectOption("fake-normal");
await page.getByRole("button", { name: "测试连接" }).click();
await page.getByText(/连接成功/).waitFor();
await page.getByRole("button", { name: "保存，开始穿越" }).click();
await page.waitForFunction(() => !!window.__lishi);

await page.evaluate(async () => {
  const repo = window.__lishi.game.repo;
  const base = (over) => ({
    version: 2, placeId: null, people: [], places: [], cards: [], goals: [], deviations: [],
    protagonist: { name: "", aliases: [], age: 30, gender: "男", identity: "", origin: "", cheat: "", stats: { money: 300, debt: 0, health: 80, energy: 70, fame: 10 }, statuses: [], items: [] },
    ...over,
  });
  const filler = async (world, line, from, count, last) => {
    let parent = from;
    for (let i = 1; i <= count; i++) {
      const node = await repo.appendNode(world.id, line.id, { parentId: parent, kind: "turn", actionMode: "do", actionText: "往前走", narrative: i === count ? last : "雪下得更紧了。", state: (await repo.getState(parent)) });
      parent = node.id;
    }
  };

  // Older worlds first, so the main one is listed on top.
  const ming = base({
    time: { start: "崇祯元年 正月初八", date: { era: "崇祯", year: 1, month: 1, day: 8, ceYear: 1628, lunar: true }, startHour: 20, elapsedMinutes: 2400 },
    era: { packId: null },
    protagonist: { name: "徐怀德", aliases: [], age: 30, gender: "男", identity: "锦衣卫北镇抚司百户", origin: "", cheat: "", stats: { money: 4000, debt: 0, health: 60, energy: 50, fame: 30 }, statuses: [], items: [] },
  });
  const m = await repo.createWorld({ title: "锦衣夜行", eraId: "free", opening: { parentId: null, kind: "opening", narrative: "北镇抚司的灯笼在风雪里晃。", state: ming } });
  await filler(m.world, m.line, m.node.id, 23, "门外的雪地上，响起了绣春刀出鞘的声音。");

  const song = base({
    time: { start: "宣和元年 三月初三", date: { era: "宣和", year: 1, month: 3, day: 3, ceYear: 1119, lunar: true }, startHour: 10, elapsedMinutes: 600 },
    era: { packId: null },
    protagonist: { name: "沈清和", aliases: [], age: 19, gender: "女", identity: "樊楼的琵琶女", origin: "", cheat: "", stats: { money: 800, debt: 0, health: 90, energy: 80, fame: 20 }, statuses: [], items: [] },
  });
  const s = await repo.createWorld({ title: "汴京梦华", eraId: "free", opening: { parentId: null, kind: "opening", narrative: "汴河上的船挤成一片。", state: song } });
  await filler(s.world, s.line, s.node.id, 6, "樊楼上有人拍案叫好，你抬头，正对上一双含笑的眼睛。");

  // The main sample: a Tang 落第举子 in the first snow of winter.
  const tang = base({
    time: { start: "天宝七载 冬月十七", startHour: 7, elapsedMinutes: 330 },
    era: { packId: "tang-748" },
    placeId: "pl-chongren",
    places: [
      { id: "pl-chongren", name: "崇仁坊", aliases: [], description: "皇城东南，候选官员与举子多在此赁屋，昼夜喧闹" },
      { id: "pl-xishi", name: "西市", aliases: [], description: "胡商云集，旗亭下常有人雇人抄写" },
    ],
    protagonist: {
      name: "李安", aliases: [], age: 22, gender: "男", identity: "落第举子，陇西人，滞留长安", origin: "历史系研究生", cheat: "",
      stats: { money: 120, debt: 0, health: 72, energy: 55, fame: 5 },
      statuses: [{ name: "风寒", detail: "微咳，夜里畏冷", sinceMinute: 0 }],
      items: [
        { name: "旧书箱", quantity: 1, unit: "只", place: null, note: "" },
        { name: "《文选》", quantity: 1, unit: "半卷", place: null, note: "卷首有自己写的一行小字" },
        { name: "紫毫笔", quantity: 2, unit: "支", place: null, note: "" },
      ],
    },
    people: [
      { id: "p-wang", name: "王店主", aliases: [], role: "西市书肆店主", attitude: "友善", alive: true, origin: "雇你抄书，嘴上刻薄，心里不坏", notes: "预支了你六十文，等你三日后交第一卷", lastSeenMinute: 300 },
      { id: "p-zhou", name: "周婆", aliases: [], role: "崇仁坊房主", attitude: "冷淡", alive: true, notes: "收了六十文，说年前还差一贯二百文就赶人", lastSeenMinute: 320 },
      { id: "p-chen", name: "陈九郎", aliases: ["九郎"], role: "同乡举子", attitude: "亲近", alive: true, origin: "一同落第的陇西同乡，常借你书看", notes: "去平康坊替人写诗，好些天没回来", lastSeenMinute: 0 },
    ],
    goals: [
      { id: "g1", name: "凑足房钱", kind: "主线", progress: "还差一贯二百文", status: "进行中" },
      { id: "g2", name: "替王店主抄完《文选》三卷", kind: "支线", progress: "第一卷三日后交", status: "进行中" },
      { id: "g3", name: "明年春闱再考一次", kind: "心愿", progress: "", status: "进行中" },
    ],
  });
  const opening = "天宝七载 冬月十七 辰时\n\n冷。\n\n你是被冻醒的。窗纸透进一层青白的光，炭盆里只剩一撮灰。身下是硬邦邦的土榻，身上压着一床又薄又潮的絮被。\n\n记忆像隔着一层水涌上来——你叫李安，陇西人，今年春闱落第，滞留长安已有大半年。这间屋子赁在崇仁坊北曲，房主周婆昨夜又来敲过门：房钱拖了两个月，三日之内再不结清，就请郎君另寻住处。\n\n坊外的街鼓一声紧似一声地响起来。坊门要开了。";
  const t = await repo.createWorld({ title: "长安雪夜", eraId: "tang-748", opening: { parentId: null, kind: "opening", narrative: opening, state: tang } });
  const turns = [
    { mode: "do", text: "收拾书箱，去西市找活计", chips: [{ text: "过了 2 刻", tone: "info" }, { text: "到 西市", tone: "info" }, { text: "结识 王店主", tone: "info" }],
      narrative: "西市的旗亭下早已挤满了人。胡商牵着骆驼从金光门进来，驼铃在雪地里闷闷地响；卖胡饼的炉子冒着白汽，芝麻的焦香混着牲口的膻味，一股脑往鼻子里钻。\n\n你在一家书肆门口站定。店主是个精瘦的中年人，正踮着脚往檐下挂新到的经卷，回头打量你两眼：\n\n“郎君识字？替人抄书，一卷三十文，管一顿午饭。”" },
    { mode: "say", text: "“三十文太少了。我抄过秘书省的本子，楷书、行书都写得。”", chips: [{ text: "🎲 顺 · 讨价还价 · 成了", tone: "gain" }, { text: "王店主：友善", tone: "gain" }, { text: "新支线：替王店主抄完《文选》三卷", tone: "info" }],
      narrative: "王店主手上一顿，把经卷搁回竹架，又上下看了你一回。\n\n“秘书省的本子？”他嘴角往下一撇，“这话我一个月要听十回。”说着却从柜底抽出一张黄麻纸，又推过来一方砚，“写两行来看。”\n\n你提笔蘸墨，略一凝神，写下《文选》里的两句：“盛年不重来，一日难再晨。”墨色匀净，转折处见筋骨。\n\n店主看了半晌，把纸收进袖里：“四十文一卷。先抄三卷，抄得好，往后的活都给你。”" },
    { mode: "do", text: "先预支六十文，回去把房钱的事稳住", chips: [{ text: "过了半个时辰", tone: "info" }, { text: "钱 +60 文", tone: "gain" }, { text: "钱 −60 文", tone: "loss" }, { text: "周婆：冷淡", tone: "info" }],
      narrative: "王店主嘀咕了一句“读书人就是事多”，还是从钱箱里数出六十文，用麻绳串好，丢到你怀里。\n\n回崇仁坊的路上雪又大了。周婆正倚在门口嗑瓜子，见你回来，眼皮也不抬：“哟，郎君今日倒回得早。”\n\n你把那串钱递过去。周婆掂了掂，脸色松动了些：“还差一贯二百文。年前结不清，老身可就不讲情面了。”\n\n屋里的炭盆还是冷的。你把书箱放下，从箱底翻出那半卷《文选》，借着窗纸透进来的雪光，看见卷首自己写的一行小字：天宝七载，誓不负此身。\n\n门外，有人轻轻叩了三下。",
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
});
await page.waitForTimeout(1500); // the harness saves one second after the last write

const settle = async () => {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(900);
};
for (const look of LOOKS) {
  await page.goto(`http://127.0.0.1:1420/?look=${look.id}`);
  await page.locator(".card", { hasText: "长安雪夜" }).waitFor();
  await settle();
  await page.screenshot({ path: `${shots}/${look.id}-1-home.png` });
  await page.locator(".card", { hasText: "长安雪夜" }).click();
  await page.locator(".turn").last().waitFor();
  // The last turn from its action down: shows how the player's own line looks.
  await page.evaluate(() => { const s = document.querySelector(".story"); const turns = s.querySelectorAll(".turn"); s.scrollTop = turns[turns.length - 1].offsetTop - 10; });
  await settle();
  await page.screenshot({ path: `${shots}/${look.id}-2-play.png` });
  await page.getByRole("button", { name: "角色" }).click();
  await settle();
  await page.screenshot({ path: `${shots}/${look.id}-3-me.png` });
  await page.getByRole("tab", { name: /人物/ }).click();
  await settle();
  await page.screenshot({ path: `${shots}/${look.id}-4-people.png` });
}

// One board per direction, and an overview of the play screen in all three.
const board = await browser.newPage({ viewport: { width: 1320, height: 900 }, deviceScaleFactor: 1.5 });
const img = (file) => `data:image/png;base64,${fs.readFileSync(file).toString("base64")}`;
const style = `<style>
  body { margin: 0; padding: 28px 32px; font-family: "Microsoft YaHei", sans-serif; background: #e9e7e2; color: #222; }
  h1 { font-size: 26px; margin: 0 0 6px; } p { margin: 0 0 18px; font-size: 15px; color: #555; max-width: 1150px; line-height: 1.6; }
  .row { display: flex; gap: 18px; } figure { margin: 0; } figure img { width: 300px; border-radius: 22px; box-shadow: 0 6px 24px rgba(0,0,0,.18); display: block; }
  figcaption { text-align: center; font-size: 14px; color: #666; margin-top: 8px; }
</style>`;
const captions = ["首页", "游玩", "角色 · 我", "角色 · 人物"];
for (const look of LOOKS) {
  const figures = ["1-home", "2-play", "3-me", "4-people"].map((k, i) => `<figure><img src="${img(`${shots}/${look.id}-${k}.png`)}"><figcaption>${captions[i]}</figcaption></figure>`).join("");
  await board.setContent(`${style}<h1>${look.name}</h1><p>${look.line}</p><div class="row">${figures}</div>`);
  await board.screenshot({ path: `${out}/look-${look.id}.jpg`, type: "jpeg", quality: 86, fullPage: true });
}
const overview = LOOKS.map((look) => `<figure><img src="${img(`${shots}/${look.id}-2-play.png`)}"><figcaption>${look.name}</figcaption></figure>`).join("");
await board.setViewportSize({ width: 1040, height: 900 });
await board.setContent(`${style}<h1>三个视觉方向 · 同一段游玩</h1><p>同一个存档、同一段剧情，分别用三个方向显示。字体用网页字体模拟手机效果。</p><div class="row">${overview}</div>`);
await board.screenshot({ path: `${out}/looks-overview.jpg`, type: "jpeg", quality: 86, fullPage: true });

console.log(errors.length ? `页面错误：${errors.slice(0, 3).join(" | ")}` : "没有页面错误");
console.log(`截图：${shots}；拼图：${out}`);
await browser.close();
