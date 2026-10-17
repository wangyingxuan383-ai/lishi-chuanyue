// R05-T001 check: "过些日子" for a month and for a year, five versions each from
// the same turn, recording elapsed time, money, age, chips and the report.
//   node_modules/.bin/tsx scripts/eval/skip.ts --model <model> [--slot main] [--max-calls 24] [--out <dir>]
import fs from "node:fs";
import path from "node:path";
import { Game } from "../../src/engine/game.ts";
import { chatCompletionsUrl, parseChunk, type ChatUsage } from "../../src/engine/llm/chat.ts";
import { PROMPT_VERSION } from "../../src/engine/prompt/turn.ts";
import { cursor, goBackTo } from "../../src/engine/tree.ts";
import { TEMPLATES, templateName } from "../../src/content/templates.ts";
import { createMemoryPlatform } from "../../src/platform/memory.ts";
import type { Platform, StreamEvent } from "../../src/platform/types.ts";
import { loadDevSecret, nodePlatform, ROOT, stamp } from "./lib.ts";

const arg = (name: string, fallback?: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? fallback : process.argv[i + 1];
};
const SPANS = ["过一个月；这段时间照常过日子", "过一年；这段时间读书"];
const VERSIONS = 5;

async function main() {
  const model = arg("model");
  if (!model) throw new Error("用法：tsx scripts/eval/skip.ts --model <模型> [--slot main] [--max-calls 24] [--out <目录>]");
  const slot = arg("slot", "main")!;
  const maxCalls = Number(arg("max-calls", "24"));
  const out = path.resolve(ROOT, arg("out", `.cache/eval/skip-${stamp()}`)!);
  const url = chatCompletionsUrl(loadDevSecret(slot).base);
  const upstream = nodePlatform(slot).llm;
  const calls: { usage: ChatUsage | null; failed: string | null }[] = [];
  const llm: Platform["llm"] = {
    ...upstream,
    ack: async () => {},
    async stream(request, emit) {
      if (calls.length >= maxCalls) { emit({ type: "error", kind: "cancelled" }); return crypto.randomUUID(); }
      const call = { usage: null as ChatUsage | null, failed: null as string | null };
      calls.push(call);
      return upstream.stream(request, (event: StreamEvent) => {
        if (event.type === "data") { const chunk = parseChunk(event.data); if (chunk?.usage) call.usage = chunk.usage; }
        if (event.type === "error") call.failed = event.status ? `${event.kind}:${event.status}` : event.kind;
        emit(event);
      });
    },
  };
  const game = await Game.open(await createMemoryPlatform(llm), { slot, url, model, includeUsage: true });
  const t = TEMPLATES.find((x) => x.id === "tang-scholar")!;
  const worldId = await game.createWorld({
    title: t.title, eraId: t.eraId, settings: { premise: t.premise, autoUpkeep: false, chapterEvery: 0 },
    protagonist: { name: templateName(t, "男"), gender: "男", age: t.age, identity: t.identity },
    arrival: "魂穿", origin: "历史系研究生", opening: { mode: "ai", hint: t.openingHint },
  }, () => {});
  if (!worldId) throw new Error("开局失败");
  await game.play(worldId, { mode: "do", text: "先把房钱的事稳住，再出门找活计" }, () => {}).done;
  const base = (await cursor(game.repo, worldId)).head;
  const before = await game.repo.getState(base.id);
  const versions = [];
  for (const span of SPANS) {
    await goBackTo(game.repo, await cursor(game.repo, worldId), base.id);
    for (let v = 0; v < VERSIONS && calls.length < maxCalls; v++) {
      const handle = v === 0 ? game.play(worldId, { mode: "skip", text: span }, () => {}) : game.regenerate(worldId, null, () => {});
      await handle.done;
      const head = (await cursor(game.repo, worldId)).head;
      const after = await game.repo.getState(head.id);
      const record = (head.record ?? {}) as { time?: unknown; report?: unknown };
      versions.push({
        span, version: v + 1, status: head.status, narrative: head.narrative,
        time: record.time ?? null, elapsedDays: Math.round((after.time.elapsedMinutes - before.time.elapsedMinutes) / 1440),
        money: after.protagonist.stats.money - before.protagonist.stats.money, ageBefore: before.protagonist.age, ageAfter: after.protagonist.age,
        chips: ((head.meta.chips as { text: string }[]) ?? []).map((c) => c.text), report: record.report ?? null,
      });
      console.log(`${span} 第 ${v + 1} 版：${head.status}，过了 ${versions.at(-1)!.elapsedDays} 天，调用 ${calls.length}/${maxCalls}`);
    }
  }
  const summary = {
    model, promptVersion: PROMPT_VERSION, start: before.time.start, maxCalls,
    calls: { total: calls.length, failed: calls.filter((c) => c.failed).map((c) => c.failed) },
    tokens: { prompt: calls.reduce((n, c) => n + (c.usage?.promptTokens ?? 0), 0), completion: calls.reduce((n, c) => n + (c.usage?.completionTokens ?? 0), 0) },
    versions,
  };
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, "summary.json"), JSON.stringify(summary, null, 2) + "\n", "utf8");
  fs.writeFileSync(path.join(out, "transcript.md"), `# 过些日子评测\n\n模型：${model}；开局：${before.time.start}；起点年龄 ${before.protagonist.age}\n\n${versions.map((v) =>
    `## ${v.span} · 第 ${v.version} 版\n\n记录的时间：${JSON.stringify(v.time)}；程序算出过了 ${v.elapsedDays} 天；钱 ${v.money >= 0 ? "+" : ""}${v.money}；年龄 ${v.ageBefore} → ${v.ageAfter}\n\n标签：${v.chips.join(" | ") || "（无）"}\n\n见闻：${JSON.stringify(v.report)}\n\n${v.narrative}\n`).join("\n")}`, "utf8");
  console.log(JSON.stringify({ calls: summary.calls, tokens: summary.tokens }, null, 2));
  console.log(`结果：${path.relative(ROOT, out)}`);
}

main().catch((error) => {
  console.error(error instanceof Error && /^(用法：|开局失败)/.test(error.message) ? error.message : "评测未完成，请检查槽位配置和本地环境（错误详情未输出以免泄露秘密）。");
  process.exitCode = 1;
});
