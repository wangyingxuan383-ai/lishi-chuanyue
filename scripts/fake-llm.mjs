// Local stand-in for an OpenAI-compatible service, for UI development and
// tests without spending tokens. Any bearer token is accepted.
//   node scripts/fake-llm.mjs [--port 18800]
// The model name picks the behaviour:
//   fake-normal   reasoning, then ~30 chunks of Chinese text, usage, [DONE]
//   fake-slow     same, 400 ms between chunks (for stop / background tests)
//   fake-http500  responds 500
//   fake-stall    sends two chunks, then goes silent
//   fake-nostream ignores stream:true and returns one JSON body
import http from "node:http";

const portArg = process.argv.indexOf("--port");
const port = portArg > 0 ? Number(process.argv[portArg + 1]) : 18800;

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
    return res.end(JSON.stringify({ data: ["fake-normal", "fake-slow", "fake-http500", "fake-stall", "fake-nostream"].map((id) => ({ id })) }));
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
  const parts = chunks(TEXT);
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
