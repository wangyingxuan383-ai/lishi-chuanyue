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
import http from "node:http";

const portArg = process.argv.indexOf("--port");
const port = portArg > 0 ? Number(process.argv[portArg + 1]) : 18800;

const OPENING_RECORD = {
  time: "一刻", place: "西市旁邸店", log: "在邸店醒来，掌柜催讨房钱",
  people: [{ name: "王掌柜", role: "邸店掌柜", attitude: "冷淡", note: "催讨房钱九十文" }],
  items: [{ name: "旧书", delta: 3 }, { name: "换洗衣", delta: 1 }],
  goals: [{ op: "add", name: "三日内付清房钱九十文", kind: "主线" }],
  choices: ["开门见掌柜", "先看看屋里有什么", "从窗口偷看外面"],
};
const TURNS = [
  { text: "你推开房门，冷风裹着雪粒扑进来。王掌柜叉着腰站在廊下，见你出来，鼻子里哼了一声。\n\n“李郎君，九十文，今日可有着落？”", record: { time: "一刻", people: [{ name: "王掌柜", attitude: "冷淡" }], log: "出门遇见掌柜", choices: ["好言请他宽限", "先付三十文", "说要出门找活"] } },
  { text: "你从囊中数出三十文，一枚一枚排在柜上。掌柜的脸色缓了些，把钱拢进抽屉。\n\n“还差六十文，后日落锁前补齐。”", record: { time: "一刻", money: -30, goals: [{ op: "progress", name: "三日内付清房钱九十文", detail: "已付三十文，还差六十文" }], log: "付了三十文房钱", choices: ["出门找活", "回房歇息", "向掌柜打听差事"] } },
  { text: "西市刚开市，鼓声未歇。货栈门口一个管事模样的人正吆喝着招短工，你挤上前去。\n\n“扛一日货，六十文，管一顿饭。”他上下打量你，“书生也来凑热闹？”", record: { time: "半个时辰", place: "西市货栈", people: [{ name: "货栈管事", role: "货栈管事", attitude: "冷淡", note: "招短工，一日六十文" }], log: "在货栈遇到招短工的管事", choices: ["应下这份活", "问问有没有记账的差事", "去别处看看"] } },
];
function gameReply(request) {
  const prompt = JSON.stringify(request.messages ?? []);
  const record = (r) => `

<record>
${JSON.stringify(r)}
</record>`;
  if (prompt.includes("只回复两个字")) return "你好";
  if (prompt.includes("请写这部小说的开场")) return TEXT + record(OPENING_RECORD);
  if (prompt.includes("你是互动小说的记录员")) return JSON.stringify({ time: "一刻", log: "补记", choices: ["继续"] });
  // Pick the scripted turn from the conversation length so runs are repeatable.
  const assistants = (request.messages ?? []).filter((m) => m.role === "assistant").length;
  const t = TURNS[Math.max(0, assistants - 1) % TURNS.length];
  return t.text + record(t.record);
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
  if (req.method === "GET" && req.url?.endsWith("/models")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ data: ["fake-normal", "fake-slow", "fake-http500", "fake-stall", "fake-nostream", "fake-plain"].map((id) => ({ id })) }));
  }
  if (!req.url?.endsWith("/chat/completions")) {
    res.writeHead(404);
    return res.end();
  }
  const request = JSON.parse(body || "{}");
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
