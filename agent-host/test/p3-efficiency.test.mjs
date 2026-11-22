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
