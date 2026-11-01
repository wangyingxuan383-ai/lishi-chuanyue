// Focused mobile Agent check: isolated native SQLite and loopback mock only.
// node --import tsx scripts/ui/agent-harness.mjs (after Enter-Dev)
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { chromium } from "playwright-core";
import { HostBridge, hostRequest } from "../../devserver/host.ts";
import { relayStream } from "../../devserver/relay.ts";

const modelSwitchOnly = process.argv.includes("--model-switch-only");
const root = process.cwd(), port = 1435, modelPort = 1445;
const origin = `http://127.0.0.1:${port}`, modelOrigin = `http://127.0.0.1:${modelPort}`;
const isolated = await fs.mkdtemp(path.join(root, ".cache/r18-agent-ui-"));
const out = path.join(root, "output/playwright", modelSwitchOnly ? "agent-model-switch-r18" : "agent-harness-r18");
await fs.mkdir(out, { recursive: true });
const secretFile = path.join(isolated, "fake-secrets.json");
await fs.writeFile(secretFile, "{}");
process.env.LISHI_DEV_DATABASE_DIR = path.join(isolated, "database");
process.env.LISHI_DEV_SECRETS_FILE = secretFile;
const host = new HostBridge(root), secrets = new Map(), checks = [], requests = [], errors = [];
let server, browser, page, fixture, release, held = false;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const json = (res, value, status = 200) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
const read = (req) => new Promise((resolve, reject) => { let raw = ""; req.on("data", (part) => raw += part); req.on("end", () => { try { resolve(JSON.parse(raw || "{}")); } catch (error) { reject(error); } }); req.on("error", reject); });
const check = (name, ok, detail) => { checks.push({ name, ok: !!ok, ...(detail === undefined ? {} : { detail }) }); console.log(`${ok ? "PASS" : "FAIL"} ${name}`); assert.ok(ok, name); };
const save = () => fs.writeFile(path.join(out, "results.json"), JSON.stringify({ isolated: path.relative(root, isolated), realModelRequests: 0, mockModelRequests: requests.length, checks, errors, requests }, null, 2));
const shot = async (name) => { await delay(120); await page.screenshot({ path: path.join(out, `${name}.png`) }); };
const toolCalls = (body) => (body.messages ?? []).flatMap((message) => message.tool_calls ?? []);
const calls = (items) => ({ content: "", tool_calls: items.map(([name, args], index) => ({ id: `call_${requests.length}_${index}`, type: "function", function: { name, arguments: JSON.stringify(args) } })) });
function taskText(body) {
  const status = body.messages.find((message) => message.content?.startsWith?.("【持久任务状态"));
  try { return JSON.parse(status.content.slice(status.content.indexOf("{"))).originalTask ?? ""; } catch { return ""; }
}
function reply(body) {
  const definitions = (body.tools ?? []).map((tool) => tool.function?.name), previous = toolCalls(body), names = previous.map((call) => call.function?.name), text = taskText(body);
  const want = text.includes("UI:question") ? ["ask_user"] : text.includes("UI:basic") ? ["update_plan"] : [];
  if (want.some((name) => !definitions.includes(name))) return calls([["discover_tools", { names: want }]]);
  if (text.includes("UI:question")) {
    if (!names.includes("ask_user")) return calls([["ask_user", { title: "确认日期显示", questions: [{ id: "display", question: "这次使用哪种显示？", options: [{ label: "保留日序", description: "继续显示经过天数" }, { label: "采用纪年", description: "只校准显示，保留经过时间" }], allowFreeText: true }] }]]);
    return calls([["finish_task", { summary: "已收到你的日期显示选择；本轮只查询，没有修改故事或推进时间。" }]]);
  }
  if (text.includes("UI:basic")) {
    const updates = previous.filter((call) => call.function?.name === "update_plan");
    if (!updates.length) return calls([["update_plan", { steps: [{ id: "read", text: "读取当前设定", status: "in_progress" }, { id: "answer", text: "给出查询结果", status: "pending" }] }]]);
    if (!names.includes("read_resource")) return calls([["read_resource", { kind: "settings", path: "/premise" }]]);
    if (updates.length < 2) return calls([["update_plan", { steps: [{ id: "read", text: "读取当前设定", status: "completed" }, { id: "answer", text: "给出查询结果", status: "completed" }] }]]);
    return calls([["finish_task", { summary: "当前故事发生在青石桥旁的书铺。设定已核对，本次没有新增剧情。" }]]);
  }
  if (!names.includes("read_resource")) return calls([["read_resource", { kind: "settings", path: "/premise" }]]);
  return calls([["finish_task", { summary: text.includes("UI:queued") ? "排队任务已读取执行时的当前故事。" : "已处理本次补充要求，没有改动正式故事。" }]]);
}
const mock = http.createServer(async (req, res) => {
  try {
    const body = await read(req), text = taskText(body);
    requests.push({ text, model: body.model, chars: JSON.stringify(body.messages ?? []).length, hasSteering: JSON.stringify(body.messages).includes("补充：保留当前经过时间"), tools: toolCalls(body).map((call) => call.function?.name) });
    if (text.includes("UI:steer") && !held) { held = true; await new Promise((resolve) => { release = resolve; res.once("close", resolve); }); if (res.destroyed) return; }
    const message = reply(body);
    json(res, { choices: [{ message, finish_reason: message.tool_calls ? "tool_calls" : "stop" }], usage: { prompt_tokens: 60, completion_tokens: 40 } });
  } catch (error) { if (!res.headersSent) json(res, { error: String(error) }, 500); else res.end(); }
});

try {
  mock.listen(modelPort, "127.0.0.1"); await once(mock, "listening");
  const plugin = { name: "agent-harness-isolated-host", configureServer(vite) { vite.middlewares.use("/__dev", async (req, res) => {
    try {
      if (req.url.startsWith("/host/")) return hostRequest(host, req.url.slice(6), req, res);
      const body = await read(req);
      if (req.url === "/config") return json(res, {});
      if (req.url === "/secret/set") { assert.equal(new URL(body.boundBaseUrl).origin, modelOrigin); secrets.set(body.slot, body); await fs.writeFile(secretFile, JSON.stringify(Object.fromEntries(secrets))); return json(res, null); }
      if (req.url === "/secret/has") return json(res, { configured: secrets.has(body.slot), boundBaseUrl: secrets.get(body.slot)?.boundBaseUrl ?? null });
      assert.equal(new URL(body.url).origin, modelOrigin, "real services are forbidden in this check");
      if (req.url === "/llm/get") return json(res, { status: 200, body: JSON.stringify({ data: ["fake-agent-harness", "fake-agent-aux", "fake-agent-other-with-a-long-name-for-mobile-layout"].map((id) => ({ id })) }) });
      if (req.url === "/llm/stream") { res.writeHead(200, { "Content-Type": "application/x-ndjson" }); res.flushHeaders(); const controller = new AbortController(); res.once("close", () => controller.abort()); await relayStream({ ...body, key: "fake-ui-key", signal: controller.signal }, (event) => res.write(`${JSON.stringify(event)}\n`)); return res.end(); }
      json(res, { error: "unexpected isolated route" }, 404);
    } catch (error) { if (!res.headersSent) json(res, { code: "fixture", message: String(error) }, 500); else res.end(); }
  }); } };
  const version = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8")).version;
  server = await createServer({ root, configFile: false, envDir: false, cacheDir: path.join(isolated, "vite"), plugins: [react(), plugin], logLevel: "warn", define: { __APP_VERSION__: JSON.stringify(version) }, server: { host: "127.0.0.1", port, strictPort: true, hmr: false, watch: { ignored: ["**/target/**", "**/.cache/**", "**/output/**", "**/src-tauri/**"] } } });
  await server.listen();
  browser = await chromium.launch({ channel: "msedge" });
  const context = await browser.newContext({ viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, locale: "zh-CN", reducedMotion: "reduce" });
  await context.route("**/*", (route) => { const url = new URL(route.request().url()); if (url.origin === origin) return route.continue(); if (url.hostname === "api.github.com") return route.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: "[]" }); errors.push(`blocked external request: ${url.hostname}`); return route.abort(); });
  page = await context.newPage(); page.setDefaultTimeout(20000); page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(origin); await page.waitForFunction(() => !!window.__lishi?.game, { timeout: 120000 });
  fixture = await page.evaluate(async (modelOrigin) => {
    const { game } = window.__lishi, { sampleState } = await import("/src/engine/testing/fixtures.ts"), { saveProfile } = await import("/src/engine/llm/providers.ts"), { getAgentPreferences, saveAgentPreferences } = await import("/src/engine/agent.ts");
    const slot = "r18-harness-mock"; await game.platform.secrets.set(slot, "fake-ui-key", `${modelOrigin}/v1`);
    const profile = await saveProfile(game.repo, { keySlot: slot, name: "本机模拟服务", provider: "custom", baseUrl: `${modelOrigin}/v1`, mainModel: "fake-agent-harness", auxModel: "fake-agent-aux", includeUsage: true, contextTokens: 12000, allowHttp: true }, null);
    await game.repo.setSetting("activeProfile", profile.id); await game.repo.setSetting("welcomed", true); await game.repo.setSetting("whatsNewSeen", ["0.11.1", "0.11.2"]);
    const state = sampleState(); state.era = { mode: "free", clockStyle: "elapsed", packId: null }; state.time = { start: "第1天", elapsedMinutes: 0, startHour: 8 };
    const made = await game.repo.createWorld({ title: "Agent手机界面验证", eraId: "free", settings: { mode: "free", premise: "青石桥旁的书铺。", chapterEvery: 0, autoUpkeep: false }, opening: { parentId: null, kind: "opening", narrative: "你走进书铺。", record: { time: 0 }, state } });
    let head = made.node;
    for (let n = 1; n <= 32; n++) head = await game.repo.appendNode(made.world.id, made.line.id, { parentId: head.id, kind: "turn", actionMode: "continue", narrative: `第${n}段：书铺里的众人继续交谈。`.repeat(30), record: { time: 0 }, state });
    await game.repo.setSetting("tip:longPress", true); await game.repo.setSetting("notifAsked", true);
    const preferences = await getAgentPreferences(game); preferences.network.mode = "off"; await saveAgentPreferences(game, preferences);
    return { worldId: made.world.id, lineId: made.line.id, headId: head.id };
  }, modelOrigin);
  const story = () => page.locator('.preserved-play:not([data-inactive="true"]) .story');
  const agentInput = () => page.getByLabel("给 Agent 助手的任务");
  const enter = async () => { await page.getByRole("button", { name: /^输入方式：/ }).click(); await page.getByRole("button", { name: /^Agent 助手/ }).click(); await agentInput().waitFor(); await page.waitForFunction(() => !!document.querySelector(".agent-conversation .title .subtitle")?.textContent); };
  const lastTask = () => page.evaluate(async (id) => (await window.__lishi.game.platform.sql.query("SELECT t.* FROM agent_tasks t JOIN agent_sessions s ON s.id=t.session_id WHERE s.world_id=? ORDER BY t.rowid DESC LIMIT 1", [id]))[0], fixture.worldId);
  const settle = async (count, status = "committed") => { await page.waitForFunction(async ({ id, count, status }) => { const tasks = await window.__lishi.game.platform.sql.query("SELECT t.status FROM agent_tasks t JOIN agent_sessions s ON s.id=t.session_id WHERE s.world_id=? ORDER BY t.rowid DESC", [id]); return tasks.length >= count && tasks[0].status === status; }, { id: fixture.worldId, count, status }, { timeout: 40000 }); await delay(800); };
  const send = async (text) => { await agentInput().fill(text); await page.locator(".agent-conversation .send-btn").click(); };
  await page.reload(); await page.waitForFunction(() => !!window.__lishi?.game); await page.getByRole("button", { name: "继续“Agent手机界面验证”", exact: true }).click();
  await story().locator(".turn").first().waitFor();
  await page.locator('.preserved-play .inputbar textarea').fill("普通输入保留草稿");
  await story().evaluate((element) => element.scrollTop = Math.max(100, element.scrollHeight - element.clientHeight - 600));
  const originalTop = await story().evaluate((element) => element.scrollTop);
  await enter();
  const dock = await page.locator(".agent-dock").boundingBox();
  check("compact initial dock fits one toolbar and input row", dock.height < 140, dock);
  if (modelSwitchOnly) {
    const ordinary = await page.evaluate(async () => ({ model: window.__lishi.game.llm, activeProfile: await window.__lishi.game.repo.getSetting("activeProfile", null) }));
    const choose = async (model) => { await page.getByRole("button", { name: /^切换 Agent 模型/ }).click(); await page.getByRole("dialog", { name: "Agent 使用的模型", exact: true }).getByRole("button", { name: new RegExp(`^${model}`) }).click(); await page.getByRole("dialog", { name: "Agent 使用的模型", exact: true }).waitFor({ state: "detached" }); };
    await agentInput().fill("切换时保留的助手草稿");
    await choose("fake-agent-aux");
    check("quick model selection preserves input and ordinary service", await agentInput().inputValue() === "切换时保留的助手草稿" && await page.evaluate(async (before) => JSON.stringify({ model: window.__lishi.game.llm, activeProfile: await window.__lishi.game.repo.getSetting("activeProfile", null) }) === JSON.stringify(before), ordinary));
    await send("UI:steer 只查询，等我补充。"); await page.waitForFunction(() => document.querySelector(".agent-conversation .send-btn")?.textContent === "停止");
    const firstTask = await lastTask();
    await choose("fake-agent-harness");
    await agentInput().fill("UI:queued 使用刚选择的模型查询。"); await page.getByRole("button", { name: "助手更多操作", exact: true }).click(); await page.getByRole("button", { name: "做完当前任务后再执行", exact: true }).click();
    await page.getByRole("button", { name: /^切换 Agent 模型/ }).click();
    await page.getByRole("textbox", { name: "搜索 Agent 模型", exact: true }).fill("other-with");
    await page.getByRole("dialog", { name: "Agent 使用的模型", exact: true }).getByRole("button", { name: /^fake-agent-other/ }).waitFor(); await shot("model-picker");
    await page.getByRole("dialog", { name: "Agent 使用的模型", exact: true }).getByRole("button", { name: /^fake-agent-other/ }).click();
    const snapshots = await page.evaluate(async (runId) => {
      const db = window.__lishi.game.platform.sql;
      const running = JSON.parse((await db.query("SELECT plan_json FROM execution_runs WHERE id=?", [runId]))[0].plan_json);
      const queued = JSON.parse((await db.query("SELECT content_json FROM agent_inputs WHERE delivery='queued' ORDER BY rowid DESC LIMIT 1"))[0].content_json);
      return { running: running.model.model, queued: queued.request.model.model };
    }, firstTask.run_id);
    check("switching for next task preserves running and queued snapshots", snapshots.running === "fake-agent-aux" && snapshots.queued === "fake-agent-harness", snapshots);
    release?.(); await settle(2);
    check("queued task actually uses its selected model", requests.some((request) => request.text.includes("UI:steer") && request.model === "fake-agent-aux") && requests.some((request) => request.text.includes("UI:queued") && request.model === "fake-agent-harness"));
    await page.reload(); await page.waitForFunction(() => !!window.__lishi?.game); await page.getByRole("button", { name: "继续“Agent手机界面验证”", exact: true }).click(); await enter();
    check("unsent model choice remains after reopening and compact dock fits", (await page.getByRole("button", { name: /^切换 Agent 模型/ }).getAttribute("aria-label")).includes("fake-agent-other-with-a-long-name") && (await page.locator(".agent-dock").boundingBox()).height < 140 && await page.locator(".agent-conversation").evaluate((element) => element.scrollWidth <= element.clientWidth + 1)); await shot("model-quick-entry");
    check("no page errors or real requests", errors.length === 0, errors);
  } else {
  await send("UI:basic 请核对当前书铺设定并告诉我结果。"); await settle(1);
  check("one collapsed process per task and no tool-message feed", await page.locator(".agent-process").count() === 1 && await page.locator(".agent-process[open]").count() === 0 && !(await page.locator(".agent-messages").textContent()).includes("工具结果"));
  await page.locator(".agent-process > summary").click(); await page.locator(".agent-plan").waitFor();
  check("progress comes from real persistent plan and paired calls", (await page.locator(".agent-plan").textContent()).includes("读取当前设定") && await page.locator(".agent-steps > p").count() === 5);
  await page.locator(".agent-process > summary").click(); await shot("paper-compact-chat");
  await send("UI:question 请确认必要选项后继续。"); await settle(2, "waiting_user");
  await page.getByRole("button", { name: "补充信息", exact: true }).click();
  await page.getByRole("button", { name: /^采用纪年/ }).click();
  check("structured question offers choices and editable answer", await page.locator(".agent-question textarea").inputValue() === "采用纪年");
  await page.locator(".agent-question textarea").fill("采用纪年，但保留本局实际经过时间"); await shot("question-sheet");
  await page.getByRole("button", { name: "回答并继续", exact: true }).click(); await settle(2);
  check("structured answers appear as readable chat, not raw JSON", (await page.locator(".agent-messages").textContent()).includes("回答：") && !(await page.locator(".agent-messages").textContent()).includes('"display":'));
  await send("UI:steer 请先核对当前设定。"); await page.waitForFunction(() => document.querySelector(".agent-conversation .send-btn")?.textContent === "停止");
  await send("补充：保留当前经过时间");
  await agentInput().fill("UI:queued 下一项只查询当前设定。"); await page.getByRole("button", { name: "助手更多操作", exact: true }).click(); await page.getByRole("button", { name: "做完当前任务后再执行", exact: true }).click();
  check("busy input supports accepted steering and persistent queue", await page.locator(".agent-queue").count() === 1);
  await shot("steering-and-queue"); release?.(); await settle(4);
  check("steering reaches next model request and queue completes", requests.some((request) => request.hasSteering) && (await lastTask()).text.includes("UI:queued"));
  await page.getByRole("button", { name: "Agent 执行设置", exact: true }).click();
  await page.locator(".agent-settings > details > summary").filter({ hasText: "我的技能" }).click();
  const chooser = page.waitForEvent("filechooser"); await page.getByRole("button", { name: "从文件导入技能包", exact: true }).click();
  await (await chooser).setFiles({ name: "sample-skill.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify({ name: "日期核查", description: "核查日期显示与经过时间", version: "1.0.0", content: "先读取时间，再核对日期锚点，保持实际经过时间。", files: { "references/time.md": "日期显示和实际经过时间分开。", "scripts/check.js": "return 1 + 1;" }, capabilities: ["read_clock"] })) });
  await page.getByRole("button", { name: "采用为常用技能", exact: true }).waitFor();
  await page.getByText("查看说明与文件", { exact: true }).click(); await shot("skill-package-preview");
  await page.getByRole("button", { name: "采用为常用技能", exact: true }).click();
  await page.waitForFunction(async () => (await window.__lishi.game.repo.getSetting("agent:preferences", {})).customSkills?.some((skill) => skill.name === "日期核查"));
  check("skill package adoption is persistent without selecting it", await page.evaluate(async () => { const p = await window.__lishi.game.repo.getSetting("agent:preferences", {}); const skill = p.customSkills.find((skill) => skill.name === "日期核查"); return !!skill.files["scripts/check.js"] && !p.skills.includes(skill.id); }));
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await page.getByRole("button", { name: "返回故事", exact: true }).click();
  check("return preserves ordinary draft and reading position", await page.locator('.preserved-play .inputbar textarea').inputValue() === "普通输入保留草稿" && Math.abs(await story().evaluate((element) => element.scrollTop) - originalTop) < 2);
  for (const theme of ["day", "night"]) {
    await page.evaluate(async (theme) => { const { game } = window.__lishi; const reading = await game.repo.getSetting("reading", {}); await game.repo.setSetting("reading", { ...reading, theme, size: 24, autoScroll: false }); }, theme);
    await page.reload(); await page.waitForFunction(() => !!window.__lishi?.game); await page.getByRole("button", { name: "继续“Agent手机界面验证”", exact: true }).click(); await enter();
    check(`${theme} theme and large text fit phone width`, await page.locator(".agent-conversation").evaluate((element) => element.scrollWidth <= element.clientWidth + 1)); await shot(`${theme}-large-text`);
  }
  await page.setViewportSize({ width: 393, height: 520 }); await agentInput().focus(); await agentInput().fill("键盘出现时仍能输入补充。"); await shot("short-viewport-input");
  check("short viewport retains input and send controls", await agentInput().isVisible() && (await page.locator(".agent-dock").boundingBox()).height < 150);
  check("no page errors or real requests", errors.length === 0, errors);
  }
} catch (error) {
  console.error(error); if (page) await shot("failure").catch(() => {}); process.exitCode = 1;
} finally {
  release?.(); await save(); await browser?.close(); await server?.close(); host.close(); await new Promise((resolve) => mock.close(resolve));
}
