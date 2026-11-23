import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import { PiHost } from "../src/host.mjs";
import { TaskContext } from "../src/task-context.mjs";

function geminiSse(response, text) {
  response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
  response.write(`data: ${JSON.stringify({
    responseId: "gem-think-1",
    candidates: [{ index: 0, content: { role: "model", parts: [{ text }] }, finishReason: "STOP" }],
    usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 4, totalTokenCount: 16 },
  })}\n\n`);
  response.end();
}

test("thinkingMode controls Gemini thinkingConfig across off / default / deep", { timeout: 20_000 }, async () => {
  const bodies = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    bodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    geminiSse(res, "已收到。");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lishi-p3-think-"));
  try {
    for (const [index, thinkingMode] of ["off", "default", "deep"].entries()) {
      const subDir = path.join(dir, thinkingMode);
      const host = await PiHost.create({
        directory: subDir,
        model: {
          id: "gemini-2.5-flash",
          protocol: "gemini",
          thinkingMode,
          baseUrl: `http://127.0.0.1:${port}/v1beta`,
          apiKey: "local-fixture-key",
          inputTokens: 12000,
          contextWindowTokens: 20000,
          maxOutputTokens: 1024,
        },
        systemPrompt: "简短回复。",
        tools: [],
        invokeTool: async () => ({ ok: true, data: {} }),
        onEvent: () => {},
      });
      try {
        await host.prompt(`模式 ${thinkingMode}`, `task-${index}`);
      } finally {
        await host.close();
      }
    }
    assert.equal(bodies.length, 3);
    assert.equal(bodies[0]?.generationConfig?.thinkingConfig?.thinkingBudget, 0, "thinkingMode=off must disable Gemini thinking with thinkingBudget: 0");
    assert.equal(bodies[1]?.generationConfig?.thinkingConfig, undefined, "thinkingMode=default must not force thinkingConfig");
    assert.ok(bodies[2]?.generationConfig?.thinkingConfig && bodies[2].generationConfig.thinkingConfig.thinkingBudget !== 0, "thinkingMode=deep must enable thinkingConfig");
  } finally {
    server.closeAllConnections();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("TaskContext sends compact unchanged marker across turns when state is unchanged and full snapshot for compaction", async () => {
  const state = {
    ok: true,
    data: {
      goal: "核对第三章人物称呼并保持一致",
      corrections: [],
      plan: [{ step: "读原文", status: "in_progress" }],
      draftRefs: [],
      skillRefs: [],
      requestedSkills: [],
      intentRevision: 1,
      consumedIntentRevision: 1,
      storyVersion: "v1",
      status: "running",
    },
  };
  const ctx = new TaskContext({ getTaskId: () => "t-1", getTaskState: async () => state });
  const m1 = [{ role: "user", content: "核对第三章" }];
  const first = await ctx.prepare({ messages: m1 });
  const firstPayload = JSON.parse(first.messages.at(-1).content.split("\n")[1]);
  assert.equal(firstPayload.goal, state.data.goal);
  assert.equal(firstPayload.unchanged, undefined);

  const m2 = [...m1, { role: "assistant", content: "正在查" }, { role: "toolResult", toolCallId: "c1", toolName: "read_world", content: [{ type: "text", text: "{}" }] }];
  const second = await ctx.prepare({ messages: m2 });
  const secondPayload = JSON.parse(second.messages.at(-1).content.split("\n")[1]);
  assert.equal(secondPayload.unchanged, true, "unchanged snapshot across advancing turns must use compact marker");
  assert.equal(second.messages.at(-1).timestamp, first.messages.at(-1).timestamp);

  // Compaction always receives the full snapshot
  const prep = { messagesToSummarize: m2, turnPrefixMessages: [], isSplitTurn: false };
  await ctx.prepareCompaction({ preparation: prep });
  const compactPayload = JSON.parse(prep.messagesToSummarize.at(-1).content.split("\n")[1]);
  assert.equal(compactPayload.goal, state.data.goal);
  assert.equal(compactPayload.unchanged, undefined);
});

test("B45 thinkingMode matrix prevents HTTP 400 across Gemini 2.5-pro / 3 / 4 / 2.0, OpenAI Responses, Anthropic and third-party Chat-Completions", { timeout: 35_000 }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lishi-b45-matrix-"));
  const runCase = async ({ model, protocol, baseUrl, thinkingMode, seedMessages = [] }) => {
    const starts = [];
    let host;
    let readDone = false;
    try {
      host = await PiHost.create({
        directory: await fs.mkdtemp(path.join(dir, "case-")),
        nativeModelHttp: true,
        model: {
          id: model,
          protocol,
          thinkingMode,
          baseUrl,
          apiKey: "local-b45-fixture-only",
          inputTokens: 12000,
          contextWindowTokens: 20000,
          maxOutputTokens: 1024,
        },
        systemPrompt: "测试指令。",
        tools: [],
        invokeTool: async () => ({ ok: true, data: {} }),
        invokeModelHttp: async (action, args) => {
          if (action === "start") {
            starts.push({ url: args.url, model: args.model, body: JSON.parse(Buffer.from(args.body, "base64").toString("utf8")) });
            return { ok: true, data: { status: 400, headers: [["content-type", "application/json"]] } };
          }
          if (action === "read") {
            if (readDone) return { ok: true, data: { done: true } };
            readDone = true;
            return { ok: true, data: { done: false, chunk: Buffer.from(JSON.stringify({ error: { message: "fixture-stop", type: "invalid_request_error" } })).toString("base64") } };
          }
          return { ok: true, data: {} };
        },
      });
      for (const msg of seedMessages) host.manager.appendMessage(msg);
      await host.prompt("你好", "b45-task").catch(() => {});
      assert.equal(starts.length, 1, `expected 1 request for ${protocol}/${model}/${thinkingMode}`);
      return starts[0];
    } finally {
      await host?.close();
    }
  };

  try {
    // (a) Gemini: 2.5-pro min budget 128 on "off"; gemini-3 / gemini-4 thinkingLevel without thinkingBudget:0; 2.0 omits thinkingConfig
    const gem25ProOff = await runCase({ model: "gemini-2.5-pro", protocol: "gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", thinkingMode: "off" });
    assert.equal(new URL(gem25ProOff.url).pathname, "/v1beta/models/gemini-2.5-pro:streamGenerateContent");
    assert.equal(gem25ProOff.body.generationConfig?.thinkingConfig?.thinkingBudget, 128);

    const gem3FlashOff = await runCase({ model: "gemini-3-flash-preview", protocol: "gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta", thinkingMode: "off" });
    assert.equal(gem3FlashOff.body.generationConfig?.thinkingConfig?.thinkingLevel, "MINIMAL");
    assert.equal(gem3FlashOff.body.generationConfig?.thinkingConfig?.thinkingBudget, undefined);

    const gem4ProDeep = await runCase({ model: "gemini-4-pro", protocol: "gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta", thinkingMode: "deep" });
    assert.equal(gem4ProDeep.body.generationConfig?.thinkingConfig?.thinkingLevel, "HIGH");
    assert.equal(gem4ProDeep.body.generationConfig?.thinkingConfig?.thinkingBudget, undefined);

    const gem20Off = await runCase({ model: "gemini-2.0-flash", protocol: "gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta", thinkingMode: "off" });
    assert.equal(gem20Off.body.generationConfig?.thinkingConfig, undefined);

    // (b) OpenAI Responses: gpt-5.1 -> "none" on "off"; o3 / gpt-5 / codex -> "low" on "off"; gpt-4.1 -> omitted
    const gpt51Off = await runCase({ model: "gpt-5.1", protocol: "openai-responses", baseUrl: "https://api.openai.com/v1", thinkingMode: "off" });
    assert.deepEqual(gpt51Off.body.reasoning, { effort: "none" });

    for (const legacyReasoner of ["o3", "gpt-5", "gpt-5.1-codex"]) {
      const resOff = await runCase({ model: legacyReasoner, protocol: "openai-responses", baseUrl: "https://api.openai.com/v1", thinkingMode: "off" });
      assert.deepEqual(resOff.body.reasoning, { effort: "low" }, `${legacyReasoner} must not send effort:"none"`);
    }

    const gpt41Off = await runCase({ model: "gpt-4.1", protocol: "openai-responses", baseUrl: "https://api.openai.com/v1", thinkingMode: "off" });
    assert.equal(gpt41Off.body.reasoning, undefined);

    // (c) Third-party Chat-Completions: no store / developer / max_completion_tokens; deepseek-reasoner backfills reasoning_content:""; Qwen3 enable_thinking
    const dsRelay = await runCase({
      model: "deepseek-ai/DeepSeek-R1",
      protocol: "chat-completions",
      baseUrl: "https://relay.invalid/v1",
      thinkingMode: "deep",
      seedMessages: [
        { role: "user", content: [{ type: "text", text: "第一轮" }], timestamp: 1 },
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "tc-1", name: "read_world", arguments: {} }],
          api: "openai-completions", provider: "lishi", model: "deepseek-ai/DeepSeek-R1",
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: "toolUse", timestamp: 2,
        },
        { role: "toolResult", toolCallId: "tc-1", toolName: "read_world", content: [{ type: "text", text: "{}" }], isError: false, timestamp: 3 },
      ],
    });
    assert.equal(dsRelay.body.store, undefined);
    assert.equal(dsRelay.body.max_completion_tokens, undefined);
    assert.equal(dsRelay.body.max_tokens, 1024);
    assert.equal(dsRelay.body.reasoning_effort, undefined);
    assert.ok(dsRelay.body.messages.every(m => m.role !== "developer"), "third-party relay must use system role");
    const assistantToolTurn = dsRelay.body.messages.find(m => m.role === "assistant" && Array.isArray(m.tool_calls));
    assert.equal(assistantToolTurn?.reasoning_content, "", "deepseek-r1 tool-call turn must backfill reasoning_content:''");

    const qwenOff = await runCase({ model: "qwen3-235b-a22b", protocol: "chat-completions", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", thinkingMode: "off" });
    assert.equal(qwenOff.body.enable_thinking, false);
    const qwenDeep = await runCase({ model: "qwen3-235b-a22b", protocol: "chat-completions", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", thinkingMode: "deep" });
    assert.equal(qwenDeep.body.enable_thinking, true);

    // (d) Anthropic: omit thinking on "off"; max_tokens >= budget_tokens + 2048 on "deep"
    const claudeOff = await runCase({ model: "claude-sonnet-4-5", protocol: "anthropic", baseUrl: "https://api.anthropic.com/v1", thinkingMode: "off" });
    assert.equal(claudeOff.body.thinking, undefined);

    const claudeDeep = await runCase({ model: "claude-sonnet-4-5", protocol: "anthropic", baseUrl: "https://api.anthropic.com/v1", thinkingMode: "deep" });
    assert.equal(claudeDeep.body.thinking?.type, "enabled");
    assert.ok(claudeDeep.body.thinking.budget_tokens >= 1024);
    assert.ok(claudeDeep.body.max_tokens >= claudeDeep.body.thinking.budget_tokens + 2048, "Anthropic deep mode must leave >=2048 tokens above budget_tokens");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("B49 auxModel trims whitespace, caps context window safely, skips custom endpointRef, and forwards model ID on HTTP start", async () => {
  const { auxModelSpec } = await import("../src/context-budget.mjs");
  const bounded = auxModelSpec({
    id: " main-1m-model ",
    auxModel: "  lite-64k-model  ",
    protocol: "chat-completions",
    baseUrl: "https://relay.invalid/v1",
    inputTokens: 475_000,
    contextWindowTokens: 1_000_000,
    maxOutputTokens: 32_768,
    cost: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18 },
  });
  assert.equal(bounded.id, "lite-64k-model");
  assert.equal(bounded.contextWindowTokens, 64_000);
  assert.equal(bounded.maxOutputTokens, 8192);
  assert.equal(bounded.inputTokens, 55_808);
  assert.equal(bounded.cost, undefined);
  // Any custom endpointRef (not only Gemini) falls back to main model
  assert.equal(auxModelSpec({
    id: "main-model",
    auxModel: "aux-model",
    protocol: "chat-completions",
    baseUrl: "https://relay.invalid/deployments/main/chat/completions",
    endpointRef: "b".repeat(64),
  }), null);
});
