// Local stand-in for an OpenAI-compatible service, for UI development and
// tests without spending tokens. Any bearer token is accepted.
//   node scripts/fake-llm.mjs [--port 18800]
// The model name picks the behaviour:
//   fake-normal   reasoning, then ~30 chunks of Chinese text, usage, [DONE]
//   fake-slow     same, 400 ms between chunks (for stop / background tests)
//   fake-http500  responds 500
//   fake-stall    sends two chunks, then goes silent
//   fake-nostream ignores stream:true and returns one JSON body
//   fake-plain    narrative only, no record (exercises the extraction fallback)
// fake-normal/slow/stall reply in the game's record format (opening, turns).
// Play modes have their own trigger words, listed in docs/DEVELOPMENT.md (本地模拟模型).
// GET /debug/last-request returns the last chat request, so UI tests can see the prompt.
import http from "node:http";

let lastRequest = null;

const portArg = process.argv.indexOf("--port");
const port = portArg > 0 ? Number(process.argv[portArg + 1]) : 18800;

const OPENING_RECORD = {
  time: "一刻", place: "西市旁邸店", log: "在邸店醒来，掌柜催讨房钱", date: { era: "天宝", year: 7, month: 11, day: 17, ceYear: 748 }, hour: 7, money: 300,
  people: [{ name: "王掌柜", role: "邸店掌柜", attitude: "冷淡", note: "催讨房钱九十文" }],
  items: [{ name: "旧书", delta: 3 }, { name: "换洗衣", delta: 1 }],
  goals: [{ op: "add", name: "三日内付清房钱九十文", kind: "主线" }],
  choices: ["开门见掌柜", "先看看屋里有什么", "从窗口偷看外面"],
};
const TURNS = [
  { text: "你推开房门，冷风裹着雪粒扑进来。王掌柜叉着腰站在廊下，见你出来，鼻子里哼了一声。\n\n“李郎君，九十文，今日可有着落？”", record: { time: "一刻", people: [{ name: "王掌柜", attitude: "冷淡" }], log: "出门遇见掌柜", choices: ["好言请他宽限", "先付三十文", "说要出门找活"] } },
  { text: "你从囊中数出三十文，一枚一枚排在柜上。掌柜的脸色缓了些，把钱拢进抽屉。\n\n“还差六十文，后日落锁前补齐。”", record: { time: "一刻", money: -30, goals: [{ op: "progress", name: "三日内付清房钱九十文", detail: "已付三十文，还差六十文" }], log: "付了三十文房钱", risk: { what: "求掌柜宽限余款", result: "半成" }, choices: ["出门找活", "回房歇息", "向掌柜打听差事"] } },
  { text: "西市刚开市，鼓声未歇。货栈门口一个管事模样的人正吆喝着招短工，你挤上前去。\n\n“扛一日货，六十文，管一顿饭。”他上下打量你，“书生也来凑热闹？”", record: { time: "半个时辰", place: "西市货栈", people: [{ name: "货栈管事", role: "货栈管事", attitude: "冷淡", note: "招短工，一日六十文" }], log: "在货栈遇到招短工的管事", choices: ["应下这份活", "问问有没有记账的差事", "去别处看看"] } },
];
// 旁观 (R14): the protagonist acts on his own and the choices are directions for the director.
const AI_TURNS = [
  { text: "你没有等掌柜开口，先拱手笑道：“王掌柜，房钱的事我记着，今日就去西市寻个活计。”说罢裹紧旧袍，踏着薄雪出了邸店。", record: { time: "一刻", place: "西市", log: "主角主动出门找活", choices: ["让他在西市撞见旧识", "下一场突如其来的大雪", "让掌柜派人暗中跟着"] } },
  { text: "货栈前人声嘈杂。你挤到管事面前，自报读过书，愿意替货栈记账，工钱少些也无妨。管事眯着眼打量你半晌，才点了点头。", record: { time: "半个时辰", people: [{ name: "货栈管事", role: "货栈管事", attitude: "一般", note: "让主角试着记一天账" }], log: "主角在货栈谋得记账的活", choices: ["让账目里藏着蹊跷", "让管事起了疑心", "让他早早收工回去"] } },
  { text: "账簿翻到第三页，你的笔停住了：同一批货记了两回。你抬眼看了看管事的背影，没有声张，只把那一行悄悄折了个角。", record: { time: "一个时辰", log: "主角发现账目有重复", choices: ["让管事察觉他看出了问题", "让一个陌生人来打听这批货", "让他把这事告诉掌柜"] } },
];
/** The mode fields of a turn (R14): a beat every second turn, challenge progress every turn, an outcome on trigger words. */
function modeFields(messages, turn) {
  const last = String(messages.at(-1)?.content ?? "");
  const fields = {};
  if (last.includes("【剧本】（玩家定的骨架）") && turn % 2 === 0) fields.beat = "done";
  if (last.includes("\n【挑战】")) {
    const action = last.slice(last.lastIndexOf("\n\n【"));
    fields.challenge = action.includes("达成") ? { progress: "目标达成了", result: "won", why: "主角做成了这件事" }
      : action.includes("放弃抵抗") ? { progress: "撑不下去了", result: "lost", why: "主角放弃了抵抗" }
        : { progress: `第 ${turn} 段：离目标又近了一步` };
  }
  return fields;
}
function gameReply(request) {
  const prompt = JSON.stringify(request.messages ?? []);
  const record = (r) => `

<record>
${JSON.stringify(r)}
</record>`;
  if (prompt.includes("只回复两个字")) return "你好";
  if (prompt.includes("拟剧本大纲")) return JSON.stringify({ line: "落第书生在长安闯出一条生路", beats: ["邸店掌柜催讨房钱", "西市货栈谋得差事", "账目里发现蹊跷", "夜探城隍庙", "真相大白，名动西市"], ending: "还清旧债，在长安站稳脚跟" });
  if (prompt.includes("出一个开局挑战")) return JSON.stringify({ goal: "三个月内凑够三百两", limit: "三个月", failIf: "被债主告到官府" });
  if (prompt.includes("请写这部小说的开场")) return TEXT + record(prompt.includes("【挑战】") ? { ...OPENING_RECORD, challenge: { progress: "还没有头绪" } } : OPENING_RECORD);
  if (prompt.includes("你帮玩家构思")) return JSON.stringify({ title: "汴京小吏", premise: "北宋宣和七年，汴京。金兵南下在即，朝野却仍歌舞升平。", name: "沈默", gender: "男", age: 26, identity: "你是开封府的一名小吏，掌管户籍文书。", arrival: "魂穿", origin: "历史系研究生", hint: "府衙里，上官让你连夜誊抄一份名册。", essentials: "主角知道靖康之变将至" });
  if (prompt.includes("整理出一张时代卡")) return JSON.stringify({ era: { name: "AI 整理的时代", content: "时局：天下初定。\n不要出现：手机" }, cards: [{ kind: "势力", name: "漕帮", keys: ["帮里"], content: "运河上的帮会" }], ...(prompt.includes("史书记载的大事") ? { timeline: [{ date: "天宝八载六月", ceYear: 749, title: "哥舒翰攻克石堡城", kind: "固定" }] } : {}) });
  if (prompt.includes("【玩家选择过些日子】") && prompt.lastIndexOf("【玩家选择过些日子】") > prompt.lastIndexOf("【玩家行动】")) return "一个月过得很快。你白天在西市货栈扛活，夜里替人抄书，攒下了一些钱；王掌柜的脸色也好看了些。月末，一个陌生人找上门来。" + record({ time: "一个月", money: 400, report: { world: "听说陇右又打了胜仗", local: "米价涨到一斗二十二文", people: "货栈管事请你喝了一回酒" }, log: "过了一个月", choices: ["开门见客", "装作不在"] });
  if (prompt.includes("替玩家查资料")) return "【本局】王掌柜是西市旁邸店的掌柜，正催你付九十文房钱。\n\n【仅供参考】唐代天宝年间，一斗米大约二十文上下。";
  if (prompt.includes("出记忆测试题")) return JSON.stringify([{ q: "主角欠谁房钱？", a: "王掌柜" }, { q: "欠了多少？", a: "九十文" }]);
  if (prompt.includes("这不是剧情，是一次记忆测试")) return "1. 王掌柜\n2. 九十文";
  if (prompt.includes("写成章节摘要")) return JSON.stringify({ title: "西市谋生", gist: "主角在西市货栈找活，欠下房钱", summary: "主角在西市邸店醒来，被王掌柜催讨九十文房钱；付了三十文后约定后日补齐，又去西市货栈应短工。" });
  if (prompt.includes("替作者维护“设定集”")) return JSON.stringify({ cards: [{ kind: "物品", name: "铜鹰符", keys: ["鹰符"], content: "平卢军的调兵信物" }], places: [{ name: "西市货栈", description: "王掌柜的货栈，主角在此落脚" }] });
  if (prompt.includes("玩家亲手写了开场")) return JSON.stringify({ time: "0", date: "某年某月", hour: 20, money: 12, place: "破庙", people: [{ name: "老乞丐", role: "乞丐", attitude: "友善" }], goals: [{ op: "add", name: "熬过今夜" }], log: "开场", choices: ["生火取暖", "去庙外看看", "问老乞丐话"] });
  if (prompt.includes("互动小说的记录员")) return JSON.stringify({ time: "一刻", log: "补记", choices: ["继续"] });
  // Pick the scripted turn from the conversation length so runs are repeatable.
  const messages = request.messages ?? [];
  const assistants = messages.filter((m) => m.role === "assistant").length;
  const pilotAi = String(messages[0]?.content ?? "").includes("主角由你来演");
  const t = (pilotAi ? AI_TURNS : TURNS)[Math.max(0, assistants - 1) % TURNS.length];
  return t.text + record({ ...t.record, ...modeFields(messages, assistants) });
}

const TEXT =
  "你睁开眼，先闻到的是一股潮湿的稻草味。窗纸透进灰白的天光，远处传来开市的鼓声，一声接一声，沉得像敲在胸口。" +
  "你撑起身子，指尖触到粗布被面——这不是你的床。门外有人用带着关中口音的腔调喊：“郎君，掌柜问今日的房钱何时结？”" +
  "记忆像潮水一样涌来：你叫李安，二十二岁，落第举子，客居西市旁的邸店，囊中只剩三百文。";

function chunks(text, size = 6) {
  const out = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

const server = http.createServer(async (req, res) => {
  let body = "";
  for await (const part of req) body += part;
  if (req.method === "GET" && req.url === "/debug/last-request") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(lastRequest));
  }
  if (req.method === "GET" && req.url?.endsWith("/models")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ data: ["fake-normal", "fake-slow", "fake-http500", "fake-stall", "fake-nostream", "fake-plain"].map((id) => ({ id })) }));
  }
  if (!req.url?.endsWith("/chat/completions")) {
    res.writeHead(404);
    return res.end();
  }
  const request = JSON.parse(body || "{}");
  lastRequest = request;
  const model = request.model ?? "fake-normal";
  if (model === "fake-http500") {
    res.writeHead(500, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: { message: "fake server error" } }));
  }
  if (model === "fake-nostream") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ choices: [{ message: { content: TEXT }, finish_reason: "stop" }], usage: { prompt_tokens: 50, completion_tokens: 120 } }));
  }
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
  const send = (value) => res.write(`data: ${JSON.stringify(value)}\n\n`);
  const delay = model === "fake-slow" ? 400 : 40;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  let closed = false;
  res.on("close", () => (closed = true));
  send({ choices: [{ delta: { reasoning_content: "（构思）" } }] });
  await wait(300);
  const parts = chunks(model === "fake-plain" ? TEXT : gameReply(request));
  for (let i = 0; i < parts.length && !closed; i++) {
    if (model === "fake-stall" && i === 2) return; // keep the socket open, send nothing
    send({ id: "x", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: parts[i] }, finish_reason: null }], unknown_field: { a: 1 } });
    await wait(delay);
  }
  if (closed) return;
  send({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
  if (request.stream_options?.include_usage) send({ choices: [], usage: { prompt_tokens: 50, completion_tokens: 120 } });
  res.write("data: [DONE]\n\n");
  res.end();
});

server.listen(port, "127.0.0.1", () => console.log(`fake LLM on http://127.0.0.1:${port}/v1`));
