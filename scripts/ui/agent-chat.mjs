// On-demand Agent conversation check. Isolated SQLite, loopback model only.
// node --import tsx scripts/ui/agent-chat.mjs
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
import { connectFake } from "./connect.mjs";

const root = process.cwd(), port = 1430, modelPort = 1440;
const previewOnly = process.argv.includes("--preview-only");
const origin = `http://127.0.0.1:${port}`, modelOrigin = `http://127.0.0.1:${modelPort}`;
const isolated = await fs.mkdtemp(path.join(root, ".cache/r17-agent-ui-"));
const out = path.join(root, "output/playwright", previewOnly ? "agent-chat-r17-preview" : "agent-chat-r17");
await fs.mkdir(out, { recursive: true });
const secretFile = path.join(isolated, "fake-secrets.json");
await fs.writeFile(secretFile, "{}");
process.env.LISHI_DEV_DATABASE_DIR = path.join(isolated, "database");
process.env.LISHI_DEV_SECRETS_FILE = secretFile;
const host = new HostBridge(root), secrets = new Map(), checks = [], requests = [], errors = [];
let server, browser, context, page, fixture, phase = "connect", hold = null, release = null, previousRunId = null;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const json = (res, value, status = 200) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
const read = (req) => new Promise((resolve, reject) => { let raw = ""; req.on("data", (part) => raw += part); req.on("end", () => { try { resolve(JSON.parse(raw || "{}")); } catch (error) { reject(error); } }); req.on("error", reject); });
const check = (name, ok, detail) => { checks.push({ name, ok: !!ok, ...(detail === undefined ? {} : { detail }) }); console.log(`${ok ? "PASS" : "FAIL"} ${name}`); assert.ok(ok, name); };
const save = () => fs.writeFile(path.join(out, "results.json"), JSON.stringify({ isolated: path.relative(root, isolated), realModelRequests: 0, mockModelRequests: requests.length, checks, errors, requests }, null, 2));
const shot = async (name) => { await delay(150); await page.screenshot({ path: path.join(out, `${name}.png`) }); };
const called = (body) => (body.messages ?? []).flatMap((message) => message.tool_calls ?? []).map((call) => call.function?.name);
const calls = (items) => ({ content: "", tool_calls: items.map(([name, args], index) => ({ id: `call_${requests.length}_${index}`, type: "function", function: { name, arguments: JSON.stringify(args) } })) });
const prose = "雨停以后，书铺里的灯仍然亮着。你听见门外有人轻叩了两下。\n\n众人依照本局已发生的事情交谈，没有把助手的执行说明写进故事。";
const record = { time: 5, log: "在书铺继续交谈", choices: ["开门", "继续读书"] };
function reply(body) {
  const definitions = (body.tools ?? []).map((tool) => tool.function?.name), names = called(body);
  if (definitions.includes("report_capability")) return calls([["report_capability", { value: "ready" }]]);
  if (JSON.stringify(body.messages).includes("只回复两个字")) return { content: "你好" };
  if (!definitions.includes("list_resources")) {
    if (JSON.stringify(body.messages).includes("只输出一个 JSON 对象") && JSON.stringify(body.messages).includes("本回合正文")) return { content: JSON.stringify(record) };
    return { content: `${prose}<record>${JSON.stringify(record)}</record>` };
  }
  if (phase === "query" || phase === "hold") return names.includes("read_resource") ? calls([["finish_task", { summary: "这里只回答查询，没有改动故事，也没有推进时间。" }]]) : calls([["read_resource", { kind: "settings" }]]);
  if (phase === "skill") return names.includes("read_skill") ? calls([["finish_task", { summary: "已实际读取世界整理技能，并按当前设定核对完成。" }]]) : calls([["read_skill", { id: "world-upkeep" }], ["read_resource", { kind: "settings" }]]);
  if (!names.includes("read_resource")) return calls([["read_resource", { kind: phase.startsWith("rewrite") ? "node" : "settings", ...(phase.startsWith("rewrite") ? { id: fixture.target } : {}) }]]);
  if (!names.includes("stage_edit")) {
    if (phase.startsWith("rewrite")) return calls([
      ["stage_edit", { kind: "node", id: fixture.target, path: "/narrative", operation: "set", value: `正文已按 ${phase} 要求修订。\n\n本回合人物仍在书铺等候，原来的时间和账目不变。`, summary: "修订目标回合的正文" }],
      ["stage_edit", { kind: "node", id: fixture.target, path: "/record", operation: "set", value: fixture.targetRecord, summary: "核对这一回合的状态记录" }],
    ]);
    return calls([["stage_edit", { kind: "settings", path: "/essentials", operation: "set", value: "本局新设定：书铺已经改名为听雨斋。", summary: "修改本局写作要求" }]]);
  }
  return calls([["finish_task", { summary: phase.startsWith("rewrite") ? "目标正文和对应记录已核对，关联状态已处理。" : "本局设定已改好，没有新增剧情或推进时间。" }]]);
}
const mock = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url.endsWith("/models")) return json(res, { data: [{ id: "fake-agent-chat", object: "model" }] });
  try {
    const body = await read(req), message = reply(body);
    requests.push({ phase, chars: JSON.stringify(body.messages ?? []).length, toolNames: called(body), highPermission: (body.tools ?? []).some((tool) => tool.function?.name === "stage_edit"), hasNewSetting: JSON.stringify(body.messages).includes("书铺已经改名为听雨斋"), includesBulkHistory: JSON.stringify(body.messages).includes("独立上下文哨兵") });
    if (hold && phase === "hold") {
      hold(); hold = null;
      res.writeHead(200, { "Content-Type": "text/event-stream" }); res.flushHeaders();
      await new Promise((resolve) => { release = resolve; res.once("close", resolve); });
      if (res.destroyed) return;
      res.write(`data: ${JSON.stringify({ choices: [{ delta: message, finish_reason: message.tool_calls ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`); res.end();
      return;
    }
    json(res, { choices: [{ message, finish_reason: message.tool_calls ? "tool_calls" : "stop" }], usage: { prompt_tokens: 60, completion_tokens: 40 } });
  } catch (error) { if (!res.headersSent) json(res, { error: String(error) }, 500); else res.end(); }
});

try {
  mock.listen(modelPort, "127.0.0.1"); await once(mock, "listening");
  const plugin = { name: "agent-chat-isolated-host", configureServer(vite) { vite.middlewares.use("/__dev", async (req, res) => {
    try {
      if (req.url.startsWith("/host/")) return hostRequest(host, req.url.slice(6), req, res);
      const body = await read(req);
      if (req.url === "/config") return json(res, {});
      if (req.url === "/secret/set") { assert.equal(new URL(body.boundBaseUrl).origin, modelOrigin); secrets.set(body.slot, body); await fs.writeFile(secretFile, JSON.stringify(Object.fromEntries(secrets))); return json(res, null); }
      if (req.url === "/secret/remove") { secrets.delete(body.slot); await fs.writeFile(secretFile, JSON.stringify(Object.fromEntries(secrets))); return json(res, null); }
      if (req.url === "/secret/has") return json(res, { configured: secrets.has(body.slot), boundBaseUrl: secrets.get(body.slot)?.boundBaseUrl ?? null });
      assert.equal(new URL(body.url).origin, modelOrigin, "real services are forbidden in this check");
      if (req.url === "/llm/get") { const upstream = await fetch(body.url); return json(res, { status: upstream.status, body: await upstream.text() }); }
      if (req.url === "/llm/stream") { res.writeHead(200, { "Content-Type": "application/x-ndjson" }); res.flushHeaders(); const controller = new AbortController(); res.once("close", () => controller.abort()); await relayStream({ ...body, key: "fake-ui-key", signal: controller.signal }, (event) => res.write(`${JSON.stringify(event)}\n`)); return res.end(); }
      json(res, { error: "unexpected isolated route" }, 404);
    } catch (error) { if (!res.headersSent) json(res, { code: "fixture", message: String(error) }, 500); else res.end(); }
  }); } };
  const version = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8")).version;
  server = await createServer({ root, configFile: false, envDir: false, cacheDir: path.join(isolated, "vite"), plugins: [react(), plugin], logLevel: "warn", define: { __APP_VERSION__: JSON.stringify(version) }, server: { host: "127.0.0.1", port, strictPort: true, hmr: false, watch: { ignored: ["**/target/**", "**/.cache/**", "**/output/**", "**/src-tauri/**"] } } });
  await server.listen();
  browser = await chromium.launch({ channel: "msedge" });
  context = await browser.newContext({ viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, locale: "zh-CN", reducedMotion: "reduce" });
  await context.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.origin === origin) return route.continue();
    if (url.hostname === "api.github.com") return route.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: "[]" });
    errors.push(`blocked external request: ${url.hostname}`); return route.abort();
  });
  page = await context.newPage(); page.setDefaultTimeout(20000);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(origin); await page.waitForFunction(() => !!window.__lishi?.game, { timeout: 120000 });
  if (previewOnly) {
    fixture = await page.evaluate(async (modelOrigin) => {
      const { game } = window.__lishi;
      const { sampleState } = await import("/src/engine/testing/fixtures.ts");
      const { saveProfile } = await import("/src/engine/llm/providers.ts");
      const { getAgentPreferences, saveAgentPreferences } = await import("/src/engine/agent.ts");
      const slot = "r17-preview-only"; await game.platform.secrets.set(slot, "fake-ui-key", `${modelOrigin}/v1`);
      const profile = await saveProfile(game.repo, { keySlot: slot, name: "预览模拟服务", provider: "custom", baseUrl: `${modelOrigin}/v1`, mainModel: "fake-agent-chat", auxModel: null, includeUsage: true, allowHttp: true }, null);
      await game.repo.setSetting("activeProfile", profile.id); await game.repo.setSetting("welcomed", true); await game.repo.setSetting("whatsNewSeen", ["0.11.1"]);
      const state = sampleState(); state.era = { mode: "free", clockStyle: "elapsed", packId: null }; state.time = { start: "第1天", elapsedMinutes: 0, startHour: 8 };
      const made = await game.repo.createWorld({ title: "具体改稿预览验证", eraId: "free", settings: { mode: "free", chapterEvery: 0, autoUpkeep: false }, opening: { parentId: null, kind: "opening", narrative: "你走进书铺。", record: { time: 0 }, state } });
      const target = await game.repo.appendNode(made.world.id, made.line.id, { parentId: made.node.id, kind: "turn", actionMode: "continue", narrative: "预览前正文：灯下的书铺很安静。", record: { time: 0 }, state });
      const preferences = await getAgentPreferences(game); preferences.policy = "preview"; preferences.network.mode = "off"; await saveAgentPreferences(game, preferences);
      return { worldId: made.world.id, lineId: made.line.id, target: target.id, targetRecord: target.record ?? {} };
    }, modelOrigin);
    await page.reload(); await page.waitForFunction(() => !!window.__lishi?.game);
    await page.getByRole("button", { name: "继续“具体改稿预览验证”", exact: true }).click();
    await page.getByRole("button", { name: /^输入方式：/ }).click(); await page.getByRole("button", { name: /^Agent 助手/ }).click();
    await page.getByLabel("给 Agent 助手的任务").fill("UI_CASE:rewrite-preview 请改写目标正文并核对记录。");
    await page.waitForFunction(() => document.querySelector(".agent-conversation .title .subtitle")?.textContent.includes(" · "));
    phase = "rewrite-preview"; await page.locator(".agent-conversation .send-btn").click();
    await page.getByRole("button", { name: "采用这批修改", exact: true }).waitFor({ timeout: 40000 });
    const text = await page.locator(".agent-change-preview").textContent();
    check("preview displays actual before and after prose", text.includes("预览前正文：灯下的书铺很安静。") && text.includes("正文已按 rewrite-preview 要求修订。"));
    await page.locator(".agent-change-preview").scrollIntoViewIfNeeded(); await shot("concrete-prose-preview");
    await page.getByRole("button", { name: "采用这批修改", exact: true }).click();
    await page.waitForFunction(async (id) => { const { game } = window.__lishi; const tree = await import("/src/engine/tree.ts"); return (await tree.cursor(game.repo, id)).head.narrative.includes("正文已按 rewrite-preview"); }, fixture.worldId);
    check("reviewed content is the exact prose adopted into story", true); check("preview check makes no external requests", errors.length === 0, errors);
  } else {
  if (await page.getByRole("button", { name: "开始穿越", exact: true }).count()) await page.getByRole("button", { name: "开始穿越", exact: true }).click();
  await connectFake(page, { port: modelPort, model: "fake-agent-chat" });
  await page.getByRole("button", { name: /随便穿/ }).waitFor();
  check("new story has no persistent classic/Agent mode selector", await page.getByRole("group", { name: "执行方式", exact: true }).count() === 0);
  await page.reload(); await page.waitForFunction(() => !!window.__lishi?.game);
  await page.getByRole("button", { name: "开始穿越", exact: true }).waitFor();
  fixture = await page.evaluate(async () => {
    const { game } = window.__lishi;
    const { sampleState } = await import("/src/engine/testing/fixtures.ts");
    const state = sampleState(); state.version = 2; state.executionMode = "agent";
    state.era = { mode: "free", clockStyle: "elapsed", packId: null }; state.time = { start: "第1天", elapsedMinutes: 0, startHour: 8 };
    const made = await game.repo.createWorld({ title: "按需助手验证", eraId: "free", settings: { mode: "free", premise: "青石桥旁的书铺。", autoUpkeep: false, chapterEvery: 0, choiceCount: 2 }, opening: { parentId: null, kind: "opening", narrative: "你来到桥边书铺。", state } });
    let head = made.node;
    for (let n = 1; n <= 35; n++) head = await game.repo.appendNode(made.world.id, made.line.id, { parentId: head.id, kind: "turn", actionMode: "continue", narrative: Array.from({ length: 8 }, (_, p) => `独立上下文哨兵 ${n}-${p}：窗外雨丝轻轻落下，书铺中的众人继续说着日常的事情。`).join("\n\n"), record: { time: 0 }, state });
    const other = await game.repo.createWorld({ title: "另一本故事", eraId: "free", settings: { mode: "free", autoUpkeep: false, chapterEvery: 0 }, opening: { parentId: null, kind: "opening", narrative: "另一条完全不同的故事。", state } });
    await game.repo.setSetting("tip:longPress", true); await game.repo.setSetting("notifAsked", true); await game.repo.setSetting("whatsNewSeen", ["0.11.1"]);
    const { getAgentPreferences, saveAgentPreferences } = await import("/src/engine/agent.ts");
    const preferences = await getAgentPreferences(game); preferences.network.mode = "off"; await saveAgentPreferences(game, preferences);
    return { worldId: made.world.id, lineId: made.line.id, otherId: other.world.id, otherLineId: other.line.id, target: head.id, targetRecord: head.record };
  });
  const story = () => page.locator('.preserved-play:not([data-inactive="true"]) .story');
  const input = () => page.locator('.preserved-play:not([data-inactive="true"]) .inputbar textarea');
  const readState = () => page.evaluate(async (id) => { const { game } = window.__lishi; const tree = await import("/src/engine/tree.ts"); const cursor = await tree.cursor(game.repo, id); return { head: cursor.head, line: cursor.line, state: await game.repo.getState(cursor.head.id), world: await game.repo.getWorld(id), path: (await game.repo.path(cursor.head.id)).filter((node) => node.kind !== "edit").map((node) => ({ id: node.id, text: node.narrative, seq: node.seq })) }; }, fixture.worldId);
  const measure = () => story().evaluate((el) => { const top = el.getBoundingClientRect().top; const paragraph = [...el.querySelectorAll(".story-text p")].find((p) => p.getBoundingClientRect().bottom > top + 1); return { top: el.scrollTop, text: paragraph?.textContent, y: paragraph?.getBoundingClientRect().top, loaded: el.querySelectorAll(".turn[data-node-id]").length }; });
  const enterAgent = async () => { await page.getByRole("button", { name: /^输入方式：/ }).click(); await page.getByRole("button", { name: /^Agent 助手/ }).click(); await page.getByLabel("给 Agent 助手的任务").waitFor(); await page.waitForFunction(() => document.querySelector(".agent-conversation .title .subtitle")?.textContent.includes(" · ")); };
  const enterStory = async () => { await page.getByRole("button", { name: "返回故事", exact: true }).click(); await story().waitFor(); await delay(250); };
  const updatePreferences = async (patch) => { await page.evaluate(async (patch) => { const { game } = window.__lishi; const { getAgentPreferences, saveAgentPreferences } = await import("/src/engine/agent.ts"); await saveAgentPreferences(game, { ...await getAgentPreferences(game), ...patch }); }, patch); };
  const startAgent = async (tag) => { previousRunId = (await task())?.id ?? null; phase = tag; await page.getByLabel("给 Agent 助手的任务").fill(`UI_CASE:${tag} 请完成本次要求。`); await page.locator(".agent-conversation .send-btn").click(); };
  const task = () => page.evaluate(async (id) => { const rows = await window.__lishi.game.platform.sql.query("SELECT id,status,budget_json,result_json,plan_json FROM execution_runs WHERE world_id=? AND json_extract(plan_json,'$.kind')='agent_task' ORDER BY created_at DESC LIMIT 1", [id]); return rows[0] ? { ...rows[0], budget: JSON.parse(rows[0].budget_json), plan: JSON.parse(rows[0].plan_json) } : null; }, fixture.worldId);
  const completedTask = async (resumed = false) => { await page.waitForFunction(async ({ id, previousRunId, resumed }) => { const rows = await window.__lishi.game.platform.sql.query("SELECT id,status FROM execution_runs WHERE world_id=? AND json_extract(plan_json,'$.kind')='agent_task' ORDER BY created_at DESC LIMIT 1", [id]); return rows[0] && (resumed || rows[0].id !== previousRunId) && !["running", "committing", "cancelled"].includes(rows[0].status); }, { id: fixture.worldId, previousRunId, resumed }, { timeout: 40000 }); await delay(900); const current = await task(); assert.ok(["committed", "completed", "previewed"].includes(current.status), `Agent task failed: ${current.status}`); return current; };
  await page.reload(); await page.waitForFunction(() => !!window.__lishi?.game);
  await page.getByRole("button", { name: "继续“按需助手验证”", exact: true }).click(); await story().locator(".turn").first().waitFor();
  phase = "ordinary"; await input().fill("普通输入仍按原流程继续"); await page.locator(".preserved-play .send-btn").click();
  await page.getByRole("button", { name: "停止", exact: true }).waitFor({ state: "hidden", timeout: 30000 }); await delay(350);
  const first = await readState();
  check("ordinary input ignores legacy whole-world Agent mode", first.head.narrative.includes("雨停以后") && requests.filter((item) => item.phase === "ordinary").every((item) => !item.highPermission));
  await input().fill("普通对话草稿不能丢"); await page.getByRole("button", { name: /^输入方式：/ }).click(); await page.locator(".sheet .mode-option", { hasText: /^说/ }).click();
  await page.getByRole("button", { name: /^输入方式：/ }).click(); await page.locator(".sheet .mode-option", { hasText: /^幕后要求/ }).click(); await page.getByLabel("幕后要求", { exact: true }).fill("这里要保留幕后要求");
  await story().evaluate((el) => el.scrollTop = Math.max(100, el.scrollHeight - el.clientHeight - 950)); await delay(150);
  const anchor = await measure();
  await enterAgent(); await shot("agent-independent-page"); await startAgent("query"); await completedTask();
  check("query does not create story or advance time", JSON.stringify((await readState()).path) === JSON.stringify(first.path) && (await readState()).state.time.elapsedMinutes === first.state.time.elapsedMinutes);
  check("Agent starts with task and locators, not whole history", requests.filter((item) => item.phase === "query").every((item) => !item.includesBulkHistory));
  await enterStory(); const returned = await measure();
  check("return preserves ordinary draft, input mode and director note", await input().inputValue() === "普通对话草稿不能丢" && await page.getByRole("button", { name: "输入方式：说", exact: true }).count() === 1 && await page.getByLabel("幕后要求", { exact: true }).inputValue() === "这里要保留幕后要求");
  check("return restores loaded history and exact reading paragraph once", returned.loaded === anchor.loaded && returned.text === anchor.text && Math.abs(returned.y - anchor.y) < 2, { before: anchor, after: returned });
  await enterAgent(); await startAgent("settings"); await completedTask(); const changed = await readState();
  check("settings-only task changes canonical settings without a turn", changed.world.settings.essentials.includes("听雨斋") && changed.path.length === first.path.length && changed.state.time.elapsedMinutes === first.state.time.elapsedMinutes);
  await enterStory(); phase = "ordinary-new-settings"; await input().fill("现在继续普通游玩"); await page.locator(".preserved-play .send-btn").click(); await page.getByRole("button", { name: "停止", exact: true }).waitFor({ state: "hidden", timeout: 30000 });
  check("next ordinary request reads committed Agent settings", requests.filter((item) => item.phase === "ordinary-new-settings").some((item) => item.hasNewSetting));
  await updatePreferences({ skills: ["world-upkeep"] }); await enterAgent(); await startAgent("skill"); const skilled = await completedTask();
  const skillSteps = await page.evaluate(async (id) => window.__lishi.game.platform.sql.query("SELECT kind FROM execution_steps WHERE run_id=?", [id]), skilled.id);
  check("explicitly selected skill is actually read", skillSteps.some((step) => step.kind === "read_skill"));
  await enterStory();
  for (const policy of ["auto-reversible", "preview", "auto"]) {
    const before = await readState(); fixture.target = before.head.id; fixture.targetRecord = before.head.record ?? {};
    await updatePreferences({ policy, skills: [] }); await enterAgent(); await startAgent(`rewrite-${policy}`); await completedTask();
    if (policy === "preview") { check("preview leaves official story untouched", (await readState()).head.narrative === before.head.narrative); await page.getByRole("button", { name: "采用这批修改", exact: true }).last().click(); await delay(800); }
    const after = await readState();
    check(`${policy}: formal prose is committed without Agent explanation`, after.head.narrative.includes(`正文已按 rewrite-${policy}`) && !after.head.narrative.includes("关联状态已处理") && after.path.length === before.path.length && after.state.time.elapsedMinutes === before.state.time.elapsedMinutes);
    if (policy === "auto-reversible") { await page.getByRole("button", { name: "撤回本次修改", exact: true }).last().click(); await delay(800); check("default policy can undo its task changes", (await readState()).head.narrative === before.head.narrative); }
    await enterStory();
  }
  await enterAgent(); await page.getByRole("button", { name: "Agent 执行设置", exact: true }).click(); await shot("agent-settings-mobile"); check("settings sheet fits phone width using existing components", await page.locator(".sheet").evaluate((el) => el.scrollWidth <= el.clientWidth + 1)); await page.getByRole("button", { name: "关闭", exact: true }).click();
  const started = new Promise((resolve) => hold = resolve); await startAgent("hold"); await started; await enterStory(); await delay(900);
  check("Agent can run while story is readable and ordinary generation waits", await story().isVisible() && await page.locator(".preserved-play .send-btn").isDisabled());
  await enterAgent(); await page.locator(".agent-conversation .send-btn").click(); await delay(1100); check("explicit stop persists native task progress", (await task()).status === "cancelled"); release?.();
  await page.getByRole("button", { name: "继续执行", exact: true }).last().click(); await completedTask(true); check("resume retains cumulative model count", (await task()).budget.modelRequests >= 2);
  const isolatedSessions = await page.evaluate(async ({ otherId, otherLineId, worldId, lineId }) => { const { game } = window.__lishi; const { AgentClient } = await import("/src/engine/agent.ts"); const client = new AgentClient(game); return { here: (await client.list(worldId, lineId)).length, other: (await client.list(otherId, otherLineId)).length, otherRoute: (await client.list(worldId, "missing-line")).length }; }, fixture);
  check("sessions are isolated by story and route", isolatedSessions.here >= 1 && isolatedSessions.other === 0 && isolatedSessions.otherRoute === 0);
  await enterStory(); const target = story().locator(".turn[data-node-id]").last(); await target.scrollIntoViewIfNeeded(); await target.dispatchEvent("pointerdown", { pointerType: "touch", button: 0, clientX: 100, clientY: 200 }); await delay(520); await target.dispatchEvent("pointerup", { pointerType: "touch", button: 0 }); await page.getByRole("button", { name: "AI 改写", exact: true }).click(); await page.getByRole("button", { name: "按原著纠错", exact: true }).click(); await page.getByRole("button", { name: "进入 Agent 助手", exact: true }).click();
  check("original-book correction opens shared Agent with target and skill", (await page.getByLabel("给 Agent 助手的任务").inputValue()).includes("查阅原著") && (await page.locator(".agent-conversation").textContent()).includes("遵循原著"));
  await shot("agent-complete-mobile"); check("no page errors or external model requests", errors.length === 0, errors);
  }
} catch (error) {
  console.error(error); if (page) await shot("failure").catch(() => {}); process.exitCode = 1;
} finally {
  release?.(); await save(); await browser?.close(); await server?.close(); await host.close(); await new Promise((resolve) => mock.close(resolve));
}
