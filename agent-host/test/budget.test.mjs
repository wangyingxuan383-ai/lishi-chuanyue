import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { PiHost } from "../.cache/runtime/host/src/host.mjs";

const hostRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("packaged Pi honors APP budgets, compacts history and refuses oversized requests without truncation", { timeout: 35_000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "lishi-pi-budget-"));
  const requests = [], events = [];
  let mode = "normal", historyResponses = 0;
  const server = http.createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString()));
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const content = mode === "history" && historyResponses++ < 2 ? "h".repeat(1000) : "预算验证摘要：保留原任务要求，继续处理本局资料。";
    response.end(`data: ${JSON.stringify({ id: `budget-${requests.length}`, object: "chat.completion.chunk", created: 1, model: "budget-model", choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const model = { id: "budget-model", protocol: "chat-completions", baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: "local-budget-fixture-only", inputTokens: 2000, contextWindowTokens: 32_000, maxOutputTokens: 512 };
  const tool = { name: "read_resource", readOnly: true, description: "读取资料定位", parameters: { type: "object", properties: { ref: { type: "string", description: "资料定位" } }, additionalProperties: false } };
  let host, heavyHost, historyHost, passed = false, errorMessage;
  try {
    host = await PiHost.create({ directory: path.join(directory, "normal"), model, tools: [tool], systemPrompt: "保留玩家的原始要求。", invokeTool: async () => { throw new Error("This case must not call tools"); }, onEvent: value => events.push(value.event) });
    const initial = host.inspect();
    assert.equal(initial.modelContextWindowTokens, 32_000);
    assert.equal(initial.modelWindowConfigured, true);
    assert.equal(initial.modelWindowSource, "configured");
    assert.equal(initial.modelWindowVerified, false);
    assert.equal(initial.effectiveInputBudgetTokens, 2000);
    assert.equal(initial.runtimeContextWindowTokens, 32_000);
    assert.equal(initial.compactionReserveTokens, 30_000);
    const original = "x".repeat(12_000);
    await assert.rejects(host.prompt(original, "budget-oversized"), error => {
      assert.equal(error.code, "input_budget_exceeded");
      assert.equal(error.details.effectiveInputBudgetTokens, 2000);
      assert.ok(error.details.estimatedInputTokens > 2000);
      return true;
    });
    assert.equal(requests.length, 0, "An oversized single input must not reach the provider");
    assert.ok((await fs.readFile(host.inspect().sessionFile, "utf8")).includes(original), "The original requirement was truncated or lost");
    await host.setModel({ ...model, inputTokens: 8000, maxOutputTokens: 1024 });
    assert.equal(host.inspect().runtimeContextWindowTokens, 32_000);
    assert.equal(host.inspect().compactionReserveTokens, 24_000);
    const continued = await host.prompt("继续原任务，附加资料：" + "y".repeat(8000), "budget-after-increase");
    assert.match(continued.text, /预算验证/);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].max_tokens ?? requests[0].max_completion_tokens, 1024, "The APP cap consumed Pi's output safety margin");
    assert.ok(JSON.stringify(requests.at(-1)).includes("资料定位"), "The final tool declaration was missing from the request");
    await host.setModel({ ...model, inputTokens: 50_000, contextWindowTokens: 4096, maxOutputTokens: 512 });
    assert.equal(host.inspect().effectiveInputBudgetTokens, 3584);
    assert.equal(host.inspect().runtimeContextWindowTokens, 4096);
    await host.setModel({ ...model, inputTokens: 6000, contextWindowTokens: null, maxOutputTokens: 1024 });
    assert.equal(host.inspect().modelContextWindowTokens, null);
    assert.equal(host.inspect().modelWindowVerified, false);
    assert.equal(host.inspect().modelWindowConfigured, false);
    assert.equal(host.inspect().modelWindowSource, "unknown");
    assert.equal(host.inspect().effectiveInputBudgetTokens, 6000);
    assert.equal(host.inspect().runtimeContextWindowTokens, 11_120);
    assert.equal(host.inspect().compactionReserveTokens, 5120);
    await assert.rejects(host.setModel({ ...model, contextWindowTokens: 512, maxOutputTokens: 512 }), { code: "invalid_context_budget" });
    const beforeHeavy = requests.length;
    heavyHost = await PiHost.create({ directory: path.join(directory, "heavy"), model: { ...model, inputTokens: 1000 }, systemPrompt: "s".repeat(1800), tools: [{ ...tool, description: "工具使用说明".repeat(1000) }], invokeTool: async () => { throw new Error("This case must not call tools"); } });
    await assert.rejects(heavyHost.prompt("检查一下", "budget-heavy-declarations"), error => {
      assert.equal(error.code, "input_budget_exceeded");
      assert.ok(error.details.estimatedInputTokens > 1000);
      return true;
    });
    assert.equal(requests.length, beforeHeavy, "System prompt and tools must count before sending");
    mode = "history";
    historyHost = await PiHost.create({ directory: path.join(directory, "history"), model: { ...model, inputTokens: 5000, maxOutputTokens: 1024 }, tools: [tool], systemPrompt: "保留玩家的原始要求。", invokeTool: async () => { throw new Error("This case must not call tools"); }, onEvent: value => events.push(value.event) });
    await historyHost.prompt("a".repeat(6000), "budget-history-one");
    await historyHost.prompt("b".repeat(6000), "budget-history-two");
    const withNewInput = await historyHost.prompt("c".repeat(8000), "budget-history-and-new-input");
    assert.equal(withNewInput.preflightCompaction?.ok, true, "The new input did not get a Pi preflight compaction");
    assert.ok(events.some(event => event.type === "compaction_end" && event.result), "Pi did not perform its own compaction at the APP threshold");
    assert.ok(historyHost.manager.getBranch().some(entry => entry.type === "compaction"));
    assert.ok(historyHost.inspect().lastRequestBudget.estimatedInputTokens <= 5000);
    assert.ok(requests.length >= 4 && requests.length <= 6, "Unexpected compaction/provider request count");
    assert.ok(requests.slice(1).every(request => (request.max_tokens ?? request.max_completion_tokens) === 1024), "Pi compaction lost its configured output cap");
    await historyHost.setModel({ ...model, inputTokens: 1000, maxOutputTokens: 512 });
    const beforeFailedCompaction = requests.length;
    const checkpointCount = historyHost.manager.getBranch().filter(entry => entry.type === "compaction").length;
    await assert.rejects(historyHost.prompt("保留这条新要求，再继续。", "budget-compaction-too-large"), { code: "input_budget_exceeded" });
    assert.equal(requests.length, beforeFailedCompaction, "An oversized compaction request bypassed the new budget");
    assert.equal(historyHost.inspect().preflightCompaction?.ok, false);
    assert.equal(historyHost.inspect().preflightCompaction?.error.code, "input_budget_exceeded");
    assert.equal(historyHost.manager.getBranch().filter(entry => entry.type === "compaction").length, checkpointCount, "A failed compaction replaced the valid checkpoint");
    assert.ok((await fs.readFile(historyHost.inspect().sessionFile, "utf8")).includes("保留这条新要求，再继续。"));
    passed = true;
  } catch (error) { errorMessage = error.message; throw error; }
  finally {
    await historyHost?.close(); await heavyHost?.close(); await host?.close();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await fs.mkdir(path.join(hostRoot, ".cache/validation"), { recursive: true });
    await fs.appendFile(path.join(hostRoot, ".cache/validation/ledger.jsonl"), JSON.stringify({ recordedAt: new Date().toISOString(), case: "packaged-input-budget", ok: passed, mockRequests: requests.length, realRequests: 0, error: errorMessage, oversizedRefusedBeforeSend: passed, originalRequirementPreserved: passed, piPreflightCompactionAtAppThreshold: passed, overBudgetCompactionRefused: passed, modelWindowSeparated: passed, systemAndToolsCounted: passed }) + "\n");
    if (path.dirname(directory) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith("lishi-pi-budget-")) throw new Error("Unexpected owned test directory");
    await fs.rm(directory, { recursive: true, force: true });
  }
});
