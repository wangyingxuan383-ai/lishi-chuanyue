// R05-T004 check: when the player changes an event the history books record
// (a 可变 entry of the timeline), the record notes the deviation; when the
// player only sets something in motion, it does not yet. From the same turn of
// a Tang 万年县不良人 world: three versions of a written scene in which 杨钊
// (later 杨国忠, “赐名国忠” is a 可变 event of 750) is put to death, then two
// versions of an action that only sends evidence to a censor.
//   node_modules/.bin/tsx scripts/eval/deviation.ts --model <model> [--slot main] [--max-calls 12] [--out <dir>]
import fs from "node:fs";
import path from "node:path";
import { Game } from "../../src/engine/game.ts";
import { chatCompletionsUrl, parseChunk, type ChatUsage } from "../../src/engine/llm/chat.ts";
import { PROMPT_VERSION } from "../../src/engine/prompt/turn.ts";
import { cursor, goBackTo } from "../../src/engine/tree.ts";
import { TEMPLATES, templateName } from "../../src/content/templates.ts";
import { createMemoryPlatform } from "../../src/platform/memory.ts";
import type { ActionMode } from "../../src/engine/types.ts";
import type { Platform, StreamEvent } from "../../src/platform/types.ts";
import { loadDevSecret, nodePlatform, ROOT, stamp } from "./lib.ts";

const arg = (name: string, fallback?: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? fallback : process.argv[i + 1];
};
const CASES: { label: string; mode: ActionMode; text: string; versions: number; expect: boolean }[] = [
  { label: "写明杨钊被赐死", mode: "write", text: "数月后，你搜集到杨钊私吞度支钱粮的铁证，借御史之手当廷揭发；玄宗震怒，杨钊被赐死于狱中，杨氏一门受了牵连。", versions: 3, expect: true },
  { label: "只是把证据送去御史台", mode: "do", text: "把杨钊私吞度支钱粮的账本誊抄一份，托人悄悄送到御史台", versions: 2, expect: false },
];

async function main() {
  const model = arg("model");
  if (!model) throw new Error("用法：tsx scripts/eval/deviation.ts --model <模型> [--slot main] [--max-calls 12] [--out <目录>]");
  const slot = arg("slot", "main")!;
  const maxCalls = Number(arg("max-calls", "12"));
  const out = path.resolve(ROOT, arg("out", `.cache/eval/deviation-${stamp()}`)!);
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
  const t = TEMPLATES.find((x) => x.id === "tang-buliang")!;
  const worldId = await game.createWorld({
    title: t.title, eraId: t.eraId, settings: { premise: t.premise, autoUpkeep: false, chapterEvery: 0 },
    protagonist: { name: templateName(t, "男"), gender: "男", age: t.age, identity: t.identity },
    arrival: "魂穿", origin: "历史系研究生", opening: { mode: "ai", hint: t.openingHint },
  }, () => {});
  if (!worldId) throw new Error("开局失败");
  const base = (await cursor(game.repo, worldId)).head;
  const results = [];
  for (const c of CASES) {
    await goBackTo(game.repo, await cursor(game.repo, worldId), base.id);
    for (let v = 0; v < c.versions && calls.length < maxCalls; v++) {
      const handle = v === 0 ? game.play(worldId, { mode: c.mode, text: c.text }, () => {}) : game.regenerate(worldId, null, () => {});
      await handle.done;
      const head = (await cursor(game.repo, worldId)).head;
      const state = await game.repo.getState(head.id);
      const record = (head.record ?? {}) as { deviation?: unknown };
      results.push({
        case: c.label, expect: c.expect, version: v + 1, status: head.status,
        deviation: typeof record.deviation === "string" ? record.deviation : null,
        recorded: state.deviations,
        chips: ((head.meta.chips as { text: string }[]) ?? []).map((x) => x.text),
        narrative: head.narrative,
      });
      console.log(`${c.label} 第 ${v + 1} 版：${head.status}，偏离 ${results.at(-1)!.deviation ?? "无"}，调用 ${calls.length}/${maxCalls}`);
    }
  }
  const summary = {
    model, promptVersion: PROMPT_VERSION, maxCalls,
    calls: { total: calls.length, failed: calls.filter((c) => c.failed).map((c) => c.failed) },
    tokens: { prompt: calls.reduce((n, c) => n + (c.usage?.promptTokens ?? 0), 0), completion: calls.reduce((n, c) => n + (c.usage?.completionTokens ?? 0), 0) },
    results,
  };
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, "summary.json"), JSON.stringify(summary, null, 2) + "\n", "utf8");
  fs.writeFileSync(path.join(out, "transcript.md"), `# 历史偏离评测\n\n模型：${model}\n\n${results.map((r) =>
    `## ${r.case} · 第 ${r.version} 版（应当${r.expect ? "" : "不"}记偏离）\n\n记录的偏离：${r.deviation ?? "（无）"}；世界里的偏离：${r.recorded.join(" / ") || "（无）"}\n\n标签：${r.chips.join(" | ") || "（无）"}\n\n${r.narrative}\n`).join("\n")}`, "utf8");
  console.log(JSON.stringify({ calls: summary.calls, tokens: summary.tokens }, null, 2));
  console.log(`结果：${path.relative(ROOT, out)}`);
}

main().catch((error) => {
  console.error(error instanceof Error && /^(用法：|开局失败)/.test(error.message) ? error.message : "评测未完成，请检查槽位配置和本地环境（错误详情未输出以免泄露秘密）。");
  process.exitCode = 1;
});
