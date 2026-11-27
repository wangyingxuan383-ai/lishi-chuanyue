// On-demand Companion ("伴聊 · 改档") & Agent ("助手") mobile regression check.
// Uses isolated native SQLite + isolated secrets file + loopback mock model only.
//   node scripts/ui/agent-chat.mjs [--preview-only]
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { chromium } from "playwright-core";
import { tsImport } from "tsx/esm/api";
import { connectFake } from "./connect.mjs";

const root = process.cwd();
const cargoBin = path.join(os.homedir(), ".cargo", "bin");
const pathKey = Object.keys(process.env).find((k) => k.toLowerCase() === "path") ?? "PATH";
if (!(process.env[pathKey] ?? "").toLowerCase().includes(cargoBin.toLowerCase())) {
  process.env[pathKey] = `${cargoBin}${path.delimiter}${process.env[pathKey] ?? ""}`;
}
delete process.env.DEV_LLM_BASE_URL;
delete process.env.DEV_LLM_KEY;
delete process.env.DEV_LLM_MODEL;

const previewOnly = process.argv.includes("--preview-only");
const isolated = await fs.mkdtemp(path.join(root, ".cache/r41-agent-ui-"));
const out = path.join(root, "output/playwright", previewOnly ? "agent-chat-r41-preview" : "agent-chat-r41");
await fs.mkdir(out, { recursive: true });
const secretFile = path.join(isolated, "fake-secrets.json");
await fs.writeFile(secretFile, "{}");
process.env.LISHI_DEV_DATABASE_DIR = path.join(isolated, "database");
process.env.LISHI_DEV_SECRETS_FILE = secretFile;

const { HostBridge, hostRequest } = await tsImport("../../devserver/host.ts", import.meta.url);
const { relayStream } = await tsImport("../../devserver/relay.ts", import.meta.url);

const host = new HostBridge(root);
const secrets = new Map();
const checks = [];
const requests = [];
const errors = [];
let server, browser, context, page, fixture;
let phase = "connect";
let hold = null;
let release = null;
let previousTaskId = null;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitUntil = async (fn, timeoutMs = 45000, label = "condition") => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await delay(150);
  }
  throw new Error(`Timed out waiting for ${label} after ${timeoutMs}ms`);
};
const json = (res, value, status = 200) => {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(value));
};
const readJson = (req) =>
  new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (part) => (raw += part));
    req.on("end", () => {
      try {
        resolve(JSON.parse(raw || "{}"));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
const check = (name, ok, detail) => {
  checks.push({ name, ok: !!ok, ...(detail === undefined ? {} : { detail }) });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
  assert.ok(ok, name);
};
const save = () =>
  fs.writeFile(
    path.join(out, "results.json"),
    JSON.stringify(
      {
        isolated: path.relative(root, isolated),
        realModelRequests: 0,
        mockModelRequests: requests.length,
        checks,
        errors,
        requests,
      },
      null,
      2,
    ),
  );
const shot = async (name) => {
  await delay(150);
  await page.screenshot({ path: path.join(out, `${name}.png`) });
};

function userTaskTag(message) {
  if (message?.role !== "user") return null;
  const parts = Array.isArray(message.content)
    ? message.content.map((p) => (typeof p?.text === "string" ? p.text : ""))
    : [typeof message.content === "string" ? message.content : ""];
  for (const part of parts) {
    const trimmed = part.trimStart();
    if (trimmed.startsWith("本次任务实时约束")) continue;
    const m = trimmed.match(/UI_CASE:([a-z0-9_-]+)/i);
    if (m) return m[1];
  }
  return null;
}

function currentTaskScope(body) {
  const messages = body.messages ?? [];
  let startIdx = -1;
  let tag = phase;
  for (let i = messages.length - 1; i >= 0; i--) {
    const found = userTaskTag(messages[i]);
    if (found) {
      startIdx = i;
      tag = found;
      break;
    }
  }
  const scoped = startIdx >= 0 ? messages.slice(startIdx + 1) : messages;
  const called = scoped
    .filter((m) => m?.role === "assistant")
    .flatMap((m) => m.tool_calls ?? [])
    .map((c) => c.function?.name);
  return { tag, called };
}

const makeToolCalls = (items) => ({
  role: "assistant",
  content: "",
  tool_calls: items.map(([name, args], index) => ({
    index,
    id: `call_${requests.length}_${index}`,
    type: "function",
    function: { name, arguments: JSON.stringify(args) },
  })),
});

const prose =
  "雨停以后，书铺里的灯仍然亮着。你听见门外有人轻叩了两下。\n\n众人依照本局已发生的事情交谈，没有把助手的执行说明写进故事。";
const record = { time: "5分钟", log: "在书铺继续交谈", choices: ["开门", "继续读书"] };

function replyFor(body) {
  const promptText = JSON.stringify(body.messages ?? []);
  const definitions = (body.tools ?? []).map((tool) => tool.function?.name);
  const { tag, called } = currentTaskScope(body);

  // 1. Setup connection test
  if (promptText.includes("只回复两个字")) {
    return { role: "assistant", content: "你好" };
  }

  // 2. WritingAssist "按原著纠错" (`kind: "correction"` in story-core)
  if (promptText.includes("对这个回合按原著纠错") || promptText.includes("核实本段正文")) {
    const corrCalls = [];
    if (definitions.includes("read_skill") && !called.includes("read_skill")) {
      corrCalls.push(["read_skill", { name: "canon-reference" }]);
    }
    if (definitions.includes("search_original") && !called.includes("search_original")) {
      corrCalls.push(["search_original", { query: "阿青 阿白 阿姊 青铜钥匙" }]);
    }
    if (definitions.includes("read_original") && !called.includes("read_original")) {
      corrCalls.push(["read_original", { section: 0, chunk: 0 }]);
    }
    if (corrCalls.length > 0) return makeToolCalls(corrCalls);
    return {
      role: "assistant",
      content: JSON.stringify({
        outcome: "changed",
        narrative: "阿白唤了声阿姊，阿青从灯座下取出青铜钥匙。",
        replacement: "阿白唤了声阿姊，阿青从灯座下取出青铜钥匙。",
        record: { time: "5分钟", log: "核对姐弟称谓与钥匙位置", choices: ["开门", "继续读书"] },
        recordPatch: { log: "核对姐弟称谓与钥匙位置" },
        corrections: [
          {
            detail: "阿青是阿白的姐姐，应称阿姊。",
            citations: [
              {
                bookId: fixture?.bookId ?? "r41-book",
                section: 0,
                chunk: 0,
                title: "第一章 青石桥",
                quote: "阿青是阿白的姐姐。阿白应称她为阿姊。",
              },
            ],
          },
        ],
        related: ["前文其他段落里的称谓也建议一并核对"],
      }),
    };
  }

  // 3. Native Pi Agent task (`pi_agent`)
  const isPiTask =
    promptText.includes("本次任务实时约束") ||
    definitions.includes("discover_tools") ||
    definitions.includes("finish_task");
  if (!isPiTask) {
    if (promptText.includes("互动小说的记录员") || (promptText.includes("只输出一个 JSON 对象") && promptText.includes("本回合正文"))) {
      return { role: "assistant", content: JSON.stringify(record) };
    }
    return { role: "assistant", content: `${prose}\n\n<record>\n${JSON.stringify(record)}\n</record>` };
  }

  // After `finish_task` returns its receipt, Pi asks for one final plain-text assistant summary.
  if (called.includes("finish_task")) {
    const doneReply = tag.startsWith("rewrite")
      ? "目标正文和对应记录已核对完成，关联状态已妥善处理。"
      : tag === "settings"
        ? "本局设定已改好，没有新增剧情或推进时间。"
        : tag === "skill"
          ? "已读取世界整理技能并按当前设定核对完毕。"
          : "这里只回答查询，没有改动故事，也没有推进时间。";
    return { role: "assistant", content: doneReply };
  }

  // Discover any needed tools not yet in active loadout.
  const requiredTools =
    tag === "skill"
      ? ["read_skill", "read_resource", "finish_task"]
      : tag === "settings" || tag.startsWith("rewrite")
        ? ["read_resource", "stage_edit", "finish_task"]
        : ["read_resource", "finish_task"];
  const missingTools = requiredTools.filter((name) => !definitions.includes(name));
  if (missingTools.length > 0 && definitions.includes("discover_tools")) {
    return makeToolCalls([["discover_tools", { names: missingTools }]]);
  }

  if (tag === "query" || tag === "hold") {
    return called.includes("read_resource")
      ? makeToolCalls([["finish_task", { summary: "这里只回答查询，没有改动故事，也没有推进时间。" }]])
      : makeToolCalls([["read_resource", { kind: "settings" }]]);
  }

  if (tag === "skill") {
    return called.includes("read_skill")
      ? makeToolCalls([["finish_task", { summary: "已实际读取世界整理技能，并按当前设定核对完成。" }]])
      : makeToolCalls([
          ["read_skill", { id: "world-upkeep" }],
          ["read_resource", { kind: "settings" }],
        ]);
  }

  if (!called.includes("read_resource")) {
    return makeToolCalls([
      [
        "read_resource",
        tag.startsWith("rewrite")
          ? { kind: "node", id: fixture.target }
          : { kind: "settings" },
      ],
    ]);
  }

  if (!called.includes("stage_edit")) {
    if (tag.startsWith("rewrite")) {
      return makeToolCalls([
        [
          "stage_edit",
          {
            kind: "node",
            id: fixture.target,
            path: "/narrative",
            operation: "set",
            value: `正文已按 ${tag} 要求修订。\n\n本回合人物仍在书铺等候，原来的时间和账目不变。`,
            summary: "修订目标回合的正文",
          },
        ],
        [
          "stage_edit",
          {
            kind: "node",
            id: fixture.target,
            path: "/record",
            operation: "set",
            value: fixture.targetRecord ?? { time: 0 },
            summary: "核对这一回合的状态记录",
          },
        ],
      ]);
    }
    return makeToolCalls([
      [
        "stage_edit",
        {
          kind: "settings",
          path: "/essentials",
          operation: "set",
          value: "本局新设定：书铺已经改名为听雨斋。",
          summary: "修改本局写作要求",
        },
      ],
    ]);
  }

  return makeToolCalls([
    [
      "finish_task",
      {
        summary: tag.startsWith("rewrite")
          ? "目标正文和对应记录已核对，关联状态已处理。"
          : "本局设定已改好，没有新增剧情或推进时间。",
      },
    ],
  ]);
}

function writeSseReply(res, modelName, message, seq) {
  const finishReason = message.tool_calls ? "tool_calls" : "stop";
  const makeChunk = (delta, finish, withUsage = false) => ({
    id: `mock-${seq}`,
    object: "chat.completion.chunk",
    created: 1,
    model: modelName || "fake-agent-chat",
    ...(withUsage ? { usage: { prompt_tokens: 60, completion_tokens: 40, total_tokens: 100 } } : {}),
    choices: [{ index: 0, delta, finish_reason: finish }],
  });
  const payload =
    `data: ${JSON.stringify(makeChunk(message, null))}\n\n` +
    `data: ${JSON.stringify(makeChunk({}, finishReason, true))}\n\n` +
    `data: [DONE]\n\n`;
  if (!res.headersSent) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
    });
  }
  res.end(payload);
}

const mock = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url?.endsWith("/models")) {
    return json(res, { data: [{ id: "fake-agent-chat", object: "model" }] });
  }
  try {
    const body = await readJson(req);
    const { tag, called } = currentTaskScope(body);
    const seq = requests.length + 1;
    requests.push({
      phase: tag,
      chars: JSON.stringify(body.messages ?? []).length,
      toolNames: called,
      highPermission: (body.tools ?? []).some((tool) =>
        ["stage_edit", "finish_task", "discover_tools"].includes(tool.function?.name),
      ),
      hasNewSetting: JSON.stringify(body.messages ?? []).includes("书铺已经改名为听雨斋"),
      includesBulkHistory: JSON.stringify(body.messages ?? []).includes("独立上下文哨兵"),
    });

    if (hold && tag === "hold") {
      const notifyStarted = hold;
      hold = null;
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
      });
      res.write(
        `data: ${JSON.stringify({
          id: `mock-${seq}`,
          object: "chat.completion.chunk",
          created: 1,
          model: body.model || "fake-agent-chat",
          choices: [{ index: 0, delta: { role: "assistant", content: "正在等待更多内容" }, finish_reason: null }],
        })}\n\n`,
      );
      notifyStarted();
      await new Promise((resolve) => {
        release = resolve;
        res.once("close", resolve);
      });
      if (!res.destroyed && !res.writableEnded) res.end();
      return;
    }

    const message = replyFor(body);
    if (body.stream === false) {
      return json(res, {
        id: `mock-${seq}`,
        object: "chat.completion",
        model: body.model || "fake-agent-chat",
        choices: [{ index: 0, message, finish_reason: message.tool_calls ? "tool_calls" : "stop" }],
        usage: { prompt_tokens: 60, completion_tokens: 40, total_tokens: 100 },
      });
    }
    writeSseReply(res, body.model, message, seq);
  } catch (error) {
    if (!res.headersSent) json(res, { error: { message: String(error) } }, 500);
    else res.end();
  }
});

let allPassed = false;
try {
  mock.listen(0, "127.0.0.1");
  await once(mock, "listening");
  const modelPort = mock.address().port;
  const modelOrigin = `http://127.0.0.1:${modelPort}`;

  const plugin = {
    name: "agent-chat-isolated-host",
    configureServer(vite) {
      vite.middlewares.use("/__dev", async (req, res) => {
        try {
          const route = (req.url ?? "").split("?", 1)[0];
          if (route.startsWith("/host/")) return hostRequest(host, route.slice(6), req, res);
          if (route === "/config") return json(res, {});
          const body = await readJson(req);
          if (route === "/secret/set") {
            assert.equal(new URL(body.boundBaseUrl).origin, modelOrigin);
            secrets.set(body.slot, body);
            await fs.writeFile(secretFile, JSON.stringify(Object.fromEntries(secrets), null, 2));
            return json(res, null);
          }
          if (route === "/secret/remove") {
            secrets.delete(body.slot);
            await fs.writeFile(secretFile, JSON.stringify(Object.fromEntries(secrets), null, 2));
            return json(res, null);
          }
          if (route === "/secret/has") {
            return json(res, {
              configured: secrets.has(body.slot),
              boundBaseUrl: secrets.get(body.slot)?.boundBaseUrl ?? null,
            });
          }
          assert.equal(new URL(body.url).origin, modelOrigin, "real services are forbidden in this check");
          if (route === "/llm/get") {
            const upstream = await fetch(body.url);
            return json(res, { status: upstream.status, body: await upstream.text() });
          }
          if (route === "/llm/stream") {
            res.writeHead(200, { "Content-Type": "application/x-ndjson; charset=utf-8" });
            res.flushHeaders();
            const controller = new AbortController();
            res.once("close", () => controller.abort());
            await relayStream(
              { ...body, key: "fake-ui-key", signal: controller.signal },
              (event) => res.write(`${JSON.stringify(event)}\n`),
            );
            return res.end();
          }
          json(res, { error: "unexpected isolated route" }, 404);
        } catch (error) {
          if (!res.headersSent) json(res, { code: "fixture", message: String(error) }, 500);
          else res.end();
        }
      });
    },
  };

  const version = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8")).version;
  server = await createServer({
    root,
    configFile: false,
    envDir: false,
    cacheDir: path.join(isolated, "vite"),
    plugins: [react(), plugin],
    logLevel: "warn",
    define: { __APP_VERSION__: JSON.stringify(version) },
    server: {
      host: "127.0.0.1",
      port: 0,
      strictPort: false,
      hmr: false,
      watch: { ignored: ["**/target/**", "**/.cache/**", "**/output/**", "**/src-tauri/**"] },
    },
  });
  await server.listen();
  const port = server.httpServer.address().port;
  const origin = `http://127.0.0.1:${port}`;

  // Pre-warm isolated `story-dev-host` before opening the browser so any build/start issue surfaces immediately.
  await host.call("status", {});

  browser = await chromium.launch({ channel: "msedge" });
  context = await browser.newContext({
    viewport: { width: 393, height: 852 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 2,
    locale: "zh-CN",
    reducedMotion: "reduce",
  });
  await context.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.origin === origin) return route.continue();
    if (url.hostname === "api.github.com") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { "access-control-allow-origin": "*" },
        body: "[]",
      });
    }
    errors.push(`blocked external request: ${url.hostname}`);
    return route.abort();
  });

  page = await context.newPage();
  page.setDefaultTimeout(25000);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(origin);
  await page.waitForFunction(() => !!window.__lishi?.game, null, { timeout: 120000 });

  if (previewOnly) {
    fixture = await page.evaluate(
      async ({ modelOrigin, appVersion }) => {
        const { game } = window.__lishi;
        const { sampleState } = await import("/src/engine/testing/fixtures.ts");
        const { saveProfile } = await import("/src/engine/llm/providers.ts");
        const { getAgentPreferences, saveAgentPreferences } = await import("/src/engine/agent.ts");
        const { saveCompanionAgentPolicy } = await import("/src/engine/companion.ts");

        const slot = "r41-preview-only";
        await game.platform.secrets.set(slot, "fake-ui-key", `${modelOrigin}/v1`);
        const profile = await saveProfile(
          game.repo,
          {
            keySlot: slot,
            name: "预览模拟服务",
            provider: "custom",
            baseUrl: `${modelOrigin}/v1`,
            mainModel: "fake-agent-chat",
            auxModel: null,
            includeUsage: true,
            allowHttp: true,
          },
          null,
        );
        await game.repo.setSetting("activeProfile", profile.id);
        await game.repo.setSetting("welcomed", true);
        await game.repo.setSetting("notifAsked", true);
        await game.repo.setSetting("tip:longPress", true);
        await game.repo.setSetting("whatsNewSeen", [appVersion]);

        const state = sampleState();
        state.era = { mode: "free", clockStyle: "elapsed", packId: null };
        state.time = { start: "第1天", elapsedMinutes: 0, startHour: 8 };
        const made = await game.repo.createWorld({
          title: "具体改稿预览验证",
          eraId: "free",
          settings: { mode: "free", chapterEvery: 0, autoUpkeep: false },
          opening: {
            parentId: null,
            kind: "opening",
            narrative: "你走进书铺。",
            record: { time: 0 },
            state,
          },
        });
        const target = await game.repo.appendNode(made.world.id, made.line.id, {
          parentId: made.node.id,
          kind: "turn",
          actionMode: "continue",
          narrative: "预览前正文：灯下的书铺很安静。",
          record: { time: 0 },
          state,
        });
        const preferences = await getAgentPreferences(game);
        preferences.policy = "preview";
        preferences.network.mode = "off";
        await saveAgentPreferences(game, preferences);
        await saveCompanionAgentPolicy(game, "preview");
        return {
          worldId: made.world.id,
          lineId: made.line.id,
          target: target.id,
          targetRecord: target.record ?? { time: 0 },
        };
      },
      { modelOrigin, appVersion: version },
    );

    await page.reload();
    await page.waitForFunction(() => !!window.__lishi?.game);
    await page.getByRole("button", { name: "继续“具体改稿预览验证”", exact: true }).click();
    await page.locator(".story .turn[data-node-id]").first().waitFor();

    // Enter Companion ("伴聊") from Play's input mode sheet and switch to "改档" gear.
    await page.getByRole("button", { name: /^输入方式：/ }).click();
    await page.getByRole("button", { name: /^伴聊/ }).click();
    await page.getByRole("button", { name: "改档", exact: true }).click();
    await page.locator(".companion-agent-hint", { hasText: "先看修改预览" }).waitFor();

    phase = "rewrite-preview";
    await page.getByLabel("输入消息", { exact: true }).fill("UI_CASE:rewrite-preview 请改写目标正文并核对记录。");
    await page.getByRole("button", { name: "发送", exact: true }).click();

    await page.getByRole("button", { name: "采用这批修改", exact: true }).waitFor({ timeout: 45000 });
    const readDiffSides = (selector) =>
      page.locator(selector).evaluate((el) => {
        const boxes = [...el.querySelectorAll(".diff-box")];
        const before = boxes
          .map((b) => [...b.childNodes].filter((n) => n.nodeName !== "INS").map((n) => n.textContent).join(""))
          .join("\n");
        const after = boxes
          .map((b) => [...b.childNodes].filter((n) => n.nodeName !== "DEL").map((n) => n.textContent).join(""))
          .join("\n");
        return { before, after };
      });
    const companionSides = await readDiffSides(".companion-agent-diffs");
    check(
      "companion preview card shows before and after prose diff",
      companionSides.before.includes("预览前正文：灯下的书铺很安静。") &&
        companionSides.after.includes("正文已按 rewrite-preview 要求修订。"),
      companionSides,
    );

    // Open full Agent workspace ("查看修改预览 / 采用 ›") and verify concrete prose preview + adoption.
    await page.getByRole("button", { name: "查看修改预览 / 采用 ›", exact: true }).first().click();
    await page.locator(".agent-change-preview").waitFor();
    const agentDiffSides = await readDiffSides(".agent-change-preview");
    await page.locator(".agent-change-preview").getByRole("button", { name: "看修改前/后", exact: true }).click();
    const previewText = await page.locator(".agent-change-preview").textContent();
    check(
      "preview displays actual before and after prose",
      agentDiffSides.before.includes("预览前正文：灯下的书铺很安静。") &&
        agentDiffSides.after.includes("正文已按 rewrite-preview 要求修订。") &&
        previewText.includes("预览前正文：灯下的书铺很安静。") &&
        previewText.includes("正文已按 rewrite-preview 要求修订。"),
    );
    await page.locator(".agent-change-preview").scrollIntoViewIfNeeded();
    await shot("concrete-prose-preview");

    await page.getByRole("button", { name: "采用这批修改", exact: true }).first().click();
    await waitUntil(
      async () =>
        page.evaluate(async (id) => {
          const { game } = window.__lishi;
          const tree = await import("/src/engine/tree.ts");
          return (await tree.cursor(game.repo, id)).head.narrative.includes("正文已按 rewrite-preview");
        }, fixture.worldId),
      30000,
      "preview adoption into story cursor",
    );
    check("reviewed content is the exact prose adopted into story", true);
    check("preview check makes no external requests", errors.length === 0, errors);
  } else {
    // Fresh empty database -> Home welcome card ("开始第一场穿越") -> Setup -> NewGame.
    await page.getByRole("button", { name: "开始第一场穿越" }).click();
    await page.getByRole("heading", { name: "连接 AI 服务" }).waitFor();
    await connectFake(page, { port: modelPort, model: "fake-agent-chat" });
    await page.getByRole("button", { name: /随便穿/ }).waitFor();
    check(
      "new story has no persistent classic/Agent mode selector",
      (await page.getByRole("group", { name: "执行方式", exact: true }).count()) === 0,
    );

    await page.reload();
    await page.waitForFunction(() => !!window.__lishi?.game);
    await page.getByRole("button", { name: "开始第一场穿越" }).waitFor();

    fixture = await page.evaluate(async (appVersion) => {
      const { game } = window.__lishi;
      const { sampleState } = await import("/src/engine/testing/fixtures.ts");
      const { saveBook } = await import("/src/engine/sources/library.ts");
      const { getAgentPreferences, saveAgentPreferences } = await import("/src/engine/agent.ts");
      const { saveCompanionAgentPolicy } = await import("/src/engine/companion.ts");

      const book = {
        id: "r41-book",
        title: "青石桥短篇",
        format: "txt",
        createdAt: new Date().toISOString(),
        sections: [
          {
            title: "第一章 青石桥",
            text: "阿青是阿白的姐姐。阿白应称她为阿姊。青铜钥匙藏在灯座下。",
          },
        ],
      };
      await saveBook(game.repo, book);

      const state = sampleState();
      state.version = 2;
      state.executionMode = "agent";
      state.era = { mode: "free", clockStyle: "elapsed", packId: null };
      state.time = { start: "第1天", elapsedMinutes: 0, startHour: 8 };

      const made = await game.repo.createWorld({
        title: "按需助手验证",
        eraId: "free",
        settings: {
          mode: "free",
          premise: "青石桥旁的书铺。",
          autoUpkeep: false,
          chapterEvery: 0,
          choiceCount: 2,
        },
        opening: {
          parentId: null,
          kind: "opening",
          narrative: "你来到桥边书铺。",
          record: { time: 0 },
          state,
        },
      });
      let head = made.node;
      for (let n = 1; n <= 35; n++) {
        head = await game.repo.appendNode(made.world.id, made.line.id, {
          parentId: head.id,
          kind: "turn",
          actionMode: "continue",
          narrative: Array.from(
            { length: 8 },
            (_, p) => `独立上下文哨兵 ${n}-${p}：窗外雨丝轻轻落下，书铺中的众人继续说着日常的事情。`,
          ).join("\n\n"),
          record: { time: 0 },
          state,
        });
      }
      const other = await game.repo.createWorld({
        title: "另一本故事",
        eraId: "free",
        settings: { mode: "free", autoUpkeep: false, chapterEvery: 0 },
        opening: {
          parentId: null,
          kind: "opening",
          narrative: "另一条完全不同的故事。",
          record: { time: 0 },
          state,
        },
      });

      await game.repo.setSetting("tip:longPress", true);
      await game.repo.setSetting("notifAsked", true);
      await game.repo.setSetting("whatsNewSeen", [appVersion]);

      const preferences = await getAgentPreferences(game);
      preferences.policy = "auto-reversible";
      preferences.network.mode = "off";
      await saveAgentPreferences(game, preferences);
      await saveCompanionAgentPolicy(game, "auto-reversible");

      return {
        bookId: book.id,
        worldId: made.world.id,
        lineId: made.line.id,
        otherId: other.world.id,
        otherLineId: other.line.id,
        target: head.id,
        targetRecord: head.record ?? { time: 0 },
      };
    }, version);

    const story = () => page.locator('.preserved-play:not([data-inactive="true"]) .story');
    const input = () => page.locator('.preserved-play:not([data-inactive="true"]) .inputbar textarea');
    const readState = () =>
      page.evaluate(async (id) => {
        const { game } = window.__lishi;
        const tree = await import("/src/engine/tree.ts");
        const cur = await tree.cursor(game.repo, id);
        return {
          head: cur.head,
          line: cur.line,
          state: await game.repo.getState(cur.head.id),
          world: await game.repo.getWorld(id),
          path: (await game.repo.path(cur.head.id))
            .filter((node) => node.kind !== "edit")
            .map((node) => ({ id: node.id, text: node.narrative, seq: node.seq })),
        };
      }, fixture.worldId);
    const measure = () =>
      story().evaluate((el) => {
        const top = el.getBoundingClientRect().top;
        const paragraph = [...el.querySelectorAll(".story-text p")].find(
          (p) => p.getBoundingClientRect().bottom > top + 1,
        );
        return {
          top: el.scrollTop,
          text: paragraph?.textContent,
          y: paragraph?.getBoundingClientRect().top,
          loaded: el.querySelectorAll(".turn[data-node-id]").length,
        };
      });

    // Navigate Play -> Companion ("伴聊") -> "改档" gear -> AgentConversation ("打开改档预览与恢复点").
    const enterAgent = async () => {
      await page.getByRole("button", { name: /^输入方式：/ }).click();
      await page.getByRole("button", { name: /^伴聊/ }).click();
      await page.getByRole("button", { name: "改档", exact: true }).click();
      await page.getByRole("button", { name: "更多操作", exact: true }).click();
      await page.getByRole("button", { name: "打开改档预览与恢复点", exact: true }).click();
      await page.getByLabel("给助手的任务", { exact: true }).waitFor();
      await page.waitForFunction(
        () => document.querySelector(".agent-conversation .title .subtitle")?.textContent?.includes("按需助手验证"),
      );
    };
    const enterStory = async () => {
      // Pop AgentConversation -> CompanionScreen -> Play
      if (await page.locator(".agent-conversation").count()) {
        await page.getByRole("button", { name: "返回故事", exact: true }).click();
      }
      if (await page.locator(".companion-main").count()) {
        await page.locator(".companion-topbar").getByRole("button", { name: "返回", exact: true }).click();
      }
      await story().waitFor();
      await delay(250);
    };
    const updatePreferences = async (patch) => {
      await page.evaluate(async (patch) => {
        const { game } = window.__lishi;
        const { getAgentPreferences, saveAgentPreferences } = await import("/src/engine/agent.ts");
        const { saveCompanionAgentPolicy } = await import("/src/engine/companion.ts");
        const next = { ...(await getAgentPreferences(game)), ...patch };
        await saveAgentPreferences(game, next);
        if (patch.policy) await saveCompanionAgentPolicy(game, patch.policy);
      }, patch);
    };
    const latestPiTask = () =>
      page.evaluate(async (id) => {
        const rows = await window.__lishi.game.platform.sql.query(
          "SELECT t.id, t.session_id, t.status, t.policy, t.result_json, t.metadata_json, t.error, (SELECT COUNT(*) FROM pi_model_requests m WHERE m.task_id = t.id) AS model_requests FROM pi_tasks t WHERE t.world_id = ? ORDER BY t.rowid DESC LIMIT 1",
          [id],
        );
        if (!rows[0]) return null;
        return {
          ...rows[0],
          modelRequests: Number(rows[0].model_requests ?? 0),
          meta: rows[0].metadata_json ? JSON.parse(String(rows[0].metadata_json)) : {},
          result: rows[0].result_json ? JSON.parse(String(rows[0].result_json)) : null,
        };
      }, fixture.worldId);
    const startAgent = async (tag) => {
      previousTaskId = (await latestPiTask())?.id ?? null;
      phase = tag;
      await page.getByLabel("给助手的任务", { exact: true }).fill(`UI_CASE:${tag} 请完成本次要求。`);
      await page.locator(".agent-conversation .send-btn").click();
    };
    const completedTask = async (resumed = false) => {
      await waitUntil(
        async () => {
          const cur = await latestPiTask();
          return (
            !!cur &&
            (resumed || cur.id !== previousTaskId) &&
            !["running", "committing", "compacting", "stopping", "cancelled"].includes(String(cur.status))
          );
        },
        45000,
        `pi_task completion (phase=${phase}, resumed=${resumed})`,
      );
      await delay(300);
      const current = await latestPiTask();
      assert.ok(
        ["committed", "completed", "previewed", "answered"].includes(String(current?.status)),
        `Agent task failed: ${current?.status} (${current?.error ?? ""})`,
      );
      return current;
    };

    await page.reload();
    await page.waitForFunction(() => !!window.__lishi?.game);
    await page.getByRole("button", { name: "继续“按需助手验证”", exact: true }).click();
    await story().locator(".turn").first().waitFor();

    // 1. Ordinary play ignores legacy whole-world executionMode="agent".
    phase = "ordinary";
    await input().fill("普通输入仍按原流程继续");
    await page.locator(".preserved-play .send-btn").click();
    await page.getByRole("button", { name: "停止", exact: true }).waitFor({ state: "hidden", timeout: 30000 });
    await delay(350);
    const first = await readState();
    check(
      "ordinary input ignores legacy whole-world Agent mode",
      first.head.narrative.includes("雨停以后") &&
        requests.filter((item) => item.phase === "ordinary").every((item) => !item.highPermission),
    );

    // 2. Draft, input mode, director note & reading viewport preserved across Companion/Agent navigation.
    await input().fill("普通对话草稿不能丢");
    await page.getByRole("button", { name: /^输入方式：/ }).click();
    await page.locator(".sheet .mode-option", { hasText: /^说/ }).click();
    await page.getByRole("button", { name: /^输入方式：/ }).click();
    await page.locator(".sheet .mode-option", { hasText: /幕后要求/ }).click();
    await page.getByLabel("幕后要求", { exact: true }).fill("这里要保留幕后要求");
    await story().evaluate((el) => {
      el.scrollTop = Math.max(100, el.scrollHeight - el.clientHeight - 950);
    });
    await delay(150);
    const anchor = await measure();

    await enterAgent();
    await shot("agent-independent-page");
    await startAgent("query");
    await completedTask();
    const afterQuery = await readState();
    check(
      "query does not create story or advance time",
      JSON.stringify(afterQuery.path) === JSON.stringify(first.path) &&
        afterQuery.state.time.elapsedMinutes === first.state.time.elapsedMinutes,
    );
    check(
      "Agent starts with task and locators, not whole history",
      requests.filter((item) => item.phase === "query").every((item) => !item.includesBulkHistory),
    );

    await enterStory();
    const returned = await measure();
    check(
      "return preserves ordinary draft, input mode and director note",
      (await input().inputValue()) === "普通对话草稿不能丢" &&
        (await page.getByRole("button", { name: "输入方式：说", exact: true }).count()) === 1 &&
        (await page.getByLabel("幕后要求", { exact: true }).inputValue()) === "这里要保留幕后要求",
    );
    check(
      "return restores loaded history and exact reading paragraph once",
      returned.loaded === anchor.loaded && returned.text === anchor.text && Math.abs(returned.y - anchor.y) < 2,
      { before: anchor, after: returned },
    );

    // 3. Settings-only task commits canonical settings without adding a turn, and next ordinary turn reads it.
    await enterAgent();
    await startAgent("settings");
    await completedTask();
    const changed = await readState();
    check(
      "settings-only task changes canonical settings without a turn",
      changed.world.settings.essentials.includes("听雨斋") &&
        changed.path.length === first.path.length &&
        changed.state.time.elapsedMinutes === first.state.time.elapsedMinutes,
    );

    await enterStory();
    phase = "ordinary-new-settings";
    await input().fill("现在继续普通游玩");
    await page.locator(".preserved-play .send-btn").click();
    await page.getByRole("button", { name: "停止", exact: true }).waitFor({ state: "hidden", timeout: 30000 });
    await delay(350);
    check(
      "next ordinary request reads committed Agent settings",
      requests.filter((item) => item.phase === "ordinary-new-settings").some((item) => item.hasNewSetting),
    );

    // 4. Explicitly selected skill is read via `read_skill` in `pi_calls`.
    await updatePreferences({ skills: ["world-upkeep"] });
    await enterAgent();
    await startAgent("skill");
    const skilled = await completedTask();
    const skillCalls = await page.evaluate(
      async (id) => window.__lishi.game.platform.sql.query("SELECT tool FROM pi_calls WHERE task_id = ?", [id]),
      skilled.id,
    );
    check(
      "explicitly selected skill is actually read",
      skillCalls.some((step) => step.tool === "read_skill"),
    );
    await enterStory();

    // 5. All three policies: auto-reversible (with undo), preview (via CompanionScreen "改档" gear!), and auto.
    for (const policy of ["auto-reversible", "preview", "auto"]) {
      const before = await readState();
      fixture.target = before.head.id;
      fixture.targetRecord = before.head.record ?? { time: "5分钟" };
      await updatePreferences({ policy, skills: [] });

      let taskRecord;
      if (policy === "preview") {
        // Drive preview + adopt directly from CompanionScreen's "改档" gear!
        await page.getByRole("button", { name: /^输入方式：/ }).click();
        await page.getByRole("button", { name: /^伴聊/ }).click();
        await page.getByRole("button", { name: "改档", exact: true }).click();
        previousTaskId = (await latestPiTask())?.id ?? null;
        phase = `rewrite-${policy}`;
        await page.getByLabel("输入消息", { exact: true }).fill(`UI_CASE:rewrite-${policy} 请修订目标正文并核对记录。`);
        await page.getByRole("button", { name: "发送", exact: true }).click();
        taskRecord = await completedTask();
        check(
          "preview leaves official story untouched before adoption",
          (await readState()).head.narrative === before.head.narrative,
        );
        await page.getByRole("button", { name: "采用这批修改", exact: true }).last().click();
        await waitUntil(
          async () => (await readState()).head.narrative.includes(`正文已按 rewrite-${policy}`),
          30000,
          "companion preview adoption",
        );
      } else {
        await enterAgent();
        await startAgent(`rewrite-${policy}`);
        taskRecord = await completedTask();
      }

      const after = await readState();
      check(
        `${policy}: formal prose is committed without Agent explanation`,
        after.head.narrative.includes(`正文已按 rewrite-${policy}`) &&
          !after.head.narrative.includes("关联状态已处理") &&
          after.path.length === before.path.length &&
          after.state.time.elapsedMinutes === before.state.time.elapsedMinutes,
      );

      if (policy === "auto-reversible") {
        const turnCard = page.locator(`.agent-turn[data-task-id="${taskRecord.id}"]`);
        await turnCard.getByRole("button", { name: "撤回最近一批", exact: true }).click();
        await waitUntil(
          async () => (await readState()).head.narrative === before.head.narrative,
          30000,
          "undo of auto-reversible task",
        );
        check("default policy can undo its task changes", (await readState()).head.narrative === before.head.narrative);
      }
      await enterStory();
    }

    // 6. Mobile layout check on Agent settings sheet ("助手设置").
    await enterAgent();
    await page.getByRole("button", { name: "助手设置", exact: true }).click();
    await page.locator(".sheet").waitFor();
    await shot("agent-settings-mobile");
    check(
      "settings sheet fits phone width using existing components",
      await page.locator(".sheet").evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
    );
    await page.getByRole("button", { name: "关闭", exact: true }).click();

    // 7. Background run while story remains readable + explicit stop + resume cumulative model count.
    const started = new Promise((resolve) => {
      hold = resolve;
    });
    await startAgent("hold");
    await started;
    await enterStory();
    await page.waitForFunction(
      () => document.querySelector(".preserved-play .send-btn")?.hasAttribute("disabled"),
      null,
      { timeout: 8000 },
    );
    check(
      "Agent can run while story is readable and ordinary generation waits",
      (await story().isVisible()) && (await page.locator(".preserved-play .send-btn").isDisabled()),
    );

    await enterAgent();
    await page.locator(".agent-conversation").getByRole("button", { name: "停止", exact: true }).first().click();
    release?.();
    release = null;
    await waitUntil(
      async () => {
        const cur = await latestPiTask();
        return cur?.status === "cancelled" && cur.meta?.stopReceipt?.settled === true;
      },
      15000,
      "cancelled pi_task settled after explicit stop",
    );
    const cancelledTask = await latestPiTask();
    check("explicit stop persists native task progress", cancelledTask.status === "cancelled");

    const heldCard = page.locator(`.agent-turn[data-task-id="${cancelledTask.id}"]`);
    for (let attempt = 0; attempt < 10; attempt++) {
      await delay(400);
      await heldCard.getByRole("button", { name: "继续执行", exact: true }).click();
      await delay(500);
      if ((await latestPiTask())?.status !== "cancelled") break;
    }
    const resumedTask = await completedTask(true);
    check("resume retains cumulative model count", resumedTask.modelRequests >= 2, resumedTask);

    // 8. Session isolation by story and route.
    const isolatedSessions = await page.evaluate(async ({ otherId, otherLineId, worldId, lineId }) => {
      const { game } = window.__lishi;
      const { AgentClient } = await import("/src/engine/agent.ts");
      const client = new AgentClient(game);
      return {
        here: (await client.list(worldId, lineId)).length,
        other: (await client.list(otherId, otherLineId)).length,
        otherRoute: (await client.list(worldId, "missing-line")).length,
      };
    }, fixture);
    check(
      "sessions are isolated by story and route",
      isolatedSessions.here >= 1 && isolatedSessions.other === 0 && isolatedSessions.otherRoute === 0,
    );

    // 9. Canon correction in WritingAssist escalates related issues to shared Agent with target & skill.
    await enterStory();
    await page.evaluate(
      async ({ worldId, bookId }) => {
        const { game } = window.__lishi;
        await game.bindSource(worldId, {
          bookId,
          fanfic: true,
          plot: "rewrite",
          through: null,
          position: 0,
          method: "search",
          instructions: "核对人物称谓与信物位置。",
        });
      },
      { worldId: fixture.worldId, bookId: fixture.bookId },
    );
    await page.reload();
    await page.waitForFunction(() => !!window.__lishi?.game);
    await page.getByRole("button", { name: "继续“按需助手验证”", exact: true }).click();
    const menuBtn = page.getByRole("button", { name: "这一段还能做什么", exact: true });
    await menuBtn.waitFor();
    await menuBtn.scrollIntoViewIfNeeded();
    await menuBtn.click();
    await page.getByRole("button", { name: "AI 改写", exact: true }).click();
    await page.getByRole("button", { name: "按原著纠错", exact: true }).click();
    await page.getByRole("button", { name: "开始核对", exact: true }).click();
    await page.getByRole("button", { name: "交给助手处理关联问题", exact: true }).waitFor({ timeout: 30000 });
    await page.getByRole("button", { name: "交给助手处理关联问题", exact: true }).click();
    await page.getByLabel("给助手的任务", { exact: true }).waitFor();
    check(
      "original-book correction opens shared Agent with target and skill",
      (await page.getByLabel("给助手的任务", { exact: true }).inputValue()).includes("关联问题") &&
        (await page.locator(".agent-conversation").textContent()).includes("已带入要修改的") &&
        (await page.getByRole("button", { name: "助手技能设置", exact: true }).textContent()).includes("技能"),
    );

    await shot("agent-complete-mobile");
    check("no page errors or external model requests", errors.length === 0, errors);
  }
  allPassed = true;
} catch (error) {
  console.error(error);
  if (page) await shot("failure").catch(() => {});
  process.exitCode = 1;
} finally {
  release?.();
  await save().catch(() => {});
  await browser?.close().catch(() => {});
  await server?.close().catch(() => {});
  host.close();
  await new Promise((resolve) => mock.close(() => resolve()));
  if (allPassed) {
    await delay(300);
    await fs.rm(isolated, { recursive: true, force: true }).catch(() => {});
  }
}
