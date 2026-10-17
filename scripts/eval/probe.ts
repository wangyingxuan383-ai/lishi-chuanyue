// Re-asks memory probes on a saved game (autoplay --save-db) with the memory
// code as it is now: the line moves to each probe turn, the next turn's context
// is built with the questions as the player's action, and the model answers.
// Only these calls cost anything; the 150 turns are not replayed.
//   node_modules/.bin/tsx scripts/eval/probe.ts --db <file> --questions <summary.json> --at 60,100,150 --model <model> [--slot main] [--max-calls 6] [--out <dir>]
import fs from "node:fs";
import path from "node:path";
import { Game } from "../../src/engine/game.ts";
import { chatCompletionsUrl, parseChunk, streamChat, type ChatUsage } from "../../src/engine/llm/chat.ts";
import { PROMPT_VERSION } from "../../src/engine/prompt/turn.ts";
import { cursor } from "../../src/engine/tree.ts";
import { createMemoryPlatform } from "../../src/platform/memory.ts";
import type { Platform, StreamEvent } from "../../src/platform/types.ts";
import { loadDevSecret, nodePlatform, ROOT, stamp } from "./lib.ts";

const arg = (name: string, fallback?: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? fallback : process.argv[i + 1];
};

async function main() {
  const [dbFile, questionsFile, model] = [arg("db"), arg("questions"), arg("model")];
  if (!dbFile || !questionsFile || !model) throw new Error("用法：tsx scripts/eval/probe.ts --db <文件> --questions <summary.json> --at 60,100,150 --model <模型> [--slot main] [--max-calls 6] [--out <目录>]");
  const slot = arg("slot", "main")!;
  const maxCalls = Number(arg("max-calls", "6"));
  const at = (arg("at", "60,100,150") ?? "").split(",").map(Number).filter((n) => n > 0);
  const out = path.resolve(ROOT, arg("out", `.cache/eval/probe-${stamp()}`)!);
  const questions = (JSON.parse(fs.readFileSync(path.resolve(ROOT, questionsFile), "utf8")).probes?.questions ?? []) as { q: string; a: string }[];
  if (!questions.length) throw new Error("用法：summary.json 里没有记忆探针题目");
  const url = chatCompletionsUrl(loadDevSecret(slot).base);
  const upstream = nodePlatform(slot).llm;
  const calls: { usage: ChatUsage | null }[] = [];
  const llm: Platform["llm"] = {
    ...upstream,
    ack: async () => {},
    async stream(request, emit) {
      if (calls.length >= maxCalls) { emit({ type: "error", kind: "cancelled" }); return crypto.randomUUID(); }
      const call = { usage: null as ChatUsage | null };
      calls.push(call);
      return upstream.stream(request, (event: StreamEvent) => {
        if (event.type === "data") { const chunk = parseChunk(event.data); if (chunk?.usage) call.usage = chunk.usage; }
        emit(event);
      });
    },
  };
  const platform = await createMemoryPlatform(llm, { data: fs.readFileSync(path.resolve(ROOT, dbFile)) });
  const game = await Game.open(platform, { slot, url, model, includeUsage: true });
  const world = (await game.repo.listWorlds())[0];
  const c = await cursor(game.repo, world.id);
  const turns = (await game.repo.path(c.head.id)).filter((n) => n.kind === "turn" || n.kind === "fastforward");
  const rounds: { turn: number; answers: string[]; layers: Record<string, number> }[] = [];
  for (const turn of at) {
    const node = turns[turn - 1];
    if (!node || calls.length >= maxCalls) continue;
    await game.repo.moveLine(c.line.id, node.id);
    const preview = await game.previewContext(world.id, { mode: "do", text: questions.map((x) => x.q).join(" ") });
    const last = preview.messages[preview.messages.length - 1];
    const ask = `\n\n【这不是剧情，是一次记忆测试】请只根据上面的前文、前情提要和设定回答下列问题，每题一行，格式“编号. 答案”；不记得就写“不知道”，不要编。\n${questions.map((x, i) => `${i + 1}. ${x.q}`).join("\n")}`;
    const content = last.content.slice(0, last.content.indexOf("\n\n【玩家行动】")) + ask;
    const result = await streamChat(platform, { slot, url, model, includeUsage: true, maxTokens: 800, messages: [...preview.messages.slice(0, -1), { role: "user", content }] }).result;
    const answers = questions.map((_, i) => result.text.split("\n").map((l) => l.trim()).find((l) => l.startsWith(`${i + 1}.`) || l.startsWith(`${i + 1}、`))?.replace(/^\d+[.、]\s*/, "") ?? "（没有回答）");
    rounds.push({ turn, answers, layers: Object.fromEntries(preview.layers.map((l) => [l.key, l.chars])) });
    console.log(`第 ${turn} 回合：${answers.filter((a) => a !== "不知道" && a !== "（没有回答）").length}/${questions.length} 有答案，调用 ${calls.length}/${maxCalls}`);
  }
  await game.repo.moveLine(c.line.id, c.head.id);
  const summary = { model, promptVersion: PROMPT_VERSION, db: dbFile, questions, rounds, calls: calls.length, promptTokens: calls.reduce((n, x) => n + (x.usage?.promptTokens ?? 0), 0) };
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, "summary.json"), JSON.stringify(summary, null, 2) + "\n", "utf8");
  fs.writeFileSync(path.join(out, "transcript.md"), `# 记忆探针重测\n\n模型：${model}；提示词：${PROMPT_VERSION}；存档：${dbFile}\n\n${questions.map((x, i) => `${i + 1}. ${x.q}\n   标准答案：${x.a}${rounds.map((r) => `\n   第 ${r.turn} 回合：${r.answers[i]}`).join("")}`).join("\n")}\n\n${rounds.map((r) => `第 ${r.turn} 回合各层字数：${JSON.stringify(r.layers)}`).join("\n\n")}\n`, "utf8");
  console.log(`结果：${path.relative(ROOT, out)}`);
}

main().catch((error) => {
  console.error(error instanceof Error && /^用法：/.test(error.message) ? error.message : "评测未完成，请检查槽位配置和本地环境（错误详情未输出以免泄露秘密）。");
  process.exitCode = 1;
});
