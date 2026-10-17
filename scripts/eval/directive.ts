// R04-T002 check: does the 叙事方针 change the next turn's style? One opening and
// one action; the same turn is then regenerated in place, alternating without and
// with the 方针, so the only difference between requests is the 方针 line.
//   node_modules/.bin/tsx scripts/eval/directive.ts --model <model> [--slot main] [--reps 2] [--max-calls 6] [--out <dir>]
import fs from "node:fs";
import path from "node:path";
import { Game } from "../../src/engine/game.ts";
import { chatCompletionsUrl, parseChunk, type ChatUsage } from "../../src/engine/llm/chat.ts";
import { PROMPT_VERSION } from "../../src/engine/prompt/turn.ts";
import { cursor } from "../../src/engine/tree.ts";
import { TEMPLATES, templateName } from "../../src/content/templates.ts";
import { createMemoryPlatform } from "../../src/platform/memory.ts";
import type { Platform, StreamEvent } from "../../src/platform/types.ts";
import { loadDevSecret, nodePlatform, ROOT, stamp } from "./lib.ts";

const arg = (name: string, fallback?: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? fallback : process.argv[i + 1];
};

const TEMPLATE = "tang-buliang";
const DIRECTIVE = "节奏快一些：每段最多两三句，多用人物对话推进，少写景物和心理。";
const ACTION = { mode: "do" as const, text: "向王县尉告退，带弟兄去平康坊案发现场查验" };

type Call = { usage: ChatUsage | null; failed: string | null };

/** Shape of a passage: paragraphs, their length, and how much of it is dialogue. */
function shape(text: string) {
  const paragraphs = text.split(/\n+/).map((p) => p.trim()).filter(Boolean);
  const chars = [...text.replace(/\s/g, "")].length;
  const quoted = [...text.matchAll(/“[^”]*”/g)].reduce((n, m) => n + [...m[0]].length, 0);
  return {
    chars, paragraphs: paragraphs.length,
    charsPerParagraph: paragraphs.length ? Math.round(chars / paragraphs.length) : 0,
    dialogueShare: chars ? Math.round((quoted / chars) * 100) / 100 : 0,
  };
}

async function main() {
  const model = arg("model");
  if (!model) throw new Error("用法：tsx scripts/eval/directive.ts --model <模型> [--slot main] [--reps 2] [--max-calls 6] [--out <目录>]");
  const slot = arg("slot", "main")!;
  const reps = Number(arg("reps", "2"));
  const maxCalls = Number(arg("max-calls", "6"));
  const out = path.resolve(ROOT, arg("out", `.cache/eval/directive-${stamp()}`)!);
  // The key stays inside lib.ts; never persist request bodies, URLs or error details.
  const url = chatCompletionsUrl(loadDevSecret(slot).base);
  const upstream = nodePlatform(slot).llm;
  const calls: Call[] = [];
  const llm: Platform["llm"] = {
    ...upstream,
    ack: async () => {},
    async stream(request, emit) {
      if (calls.length >= maxCalls) {
        emit({ type: "error", kind: "cancelled" });
        return crypto.randomUUID();
      }
      const call: Call = { usage: null, failed: null };
      calls.push(call);
      return upstream.stream(request, (event: StreamEvent) => {
        if (event.type === "data") {
          const chunk = parseChunk(event.data);
          if (chunk?.usage) call.usage = chunk.usage;
        }
        if (event.type === "error") call.failed = event.status ? `${event.kind}:${event.status}` : event.kind;
        emit(event);
      });
    },
  };
  const platform = await createMemoryPlatform(llm);
  const game = await Game.open(platform, { slot, url, model, includeUsage: true });
  const t = TEMPLATES.find((x) => x.id === TEMPLATE)!;
  const gender = t.gender ?? "男";
  const worldId = await game.createWorld({
    title: t.title, eraId: t.eraId, settings: { premise: t.premise },
    protagonist: { name: templateName(t, gender), gender, age: t.age, identity: t.identity },
    arrival: t.arrival ?? "魂穿", origin: "历史系研究生", opening: { mode: "ai", hint: t.openingHint },
  }, () => {});
  if (!worldId) throw new Error("开局失败");
  const setDirective = async (directive: string) => {
    const world = (await game.repo.getWorld(worldId))!;
    await game.repo.updateSettings(worldId, { ...world.settings, directive });
  };
  const versions: { directive: boolean; status: string; narrative: string; shape: ReturnType<typeof shape> }[] = [];
  const record = async (directive: boolean) => {
    const head = (await cursor(game.repo, worldId)).head;
    versions.push({ directive, status: head.status, narrative: head.narrative, shape: shape(head.narrative) });
    console.log(`${directive ? "带方针" : "不带方针"}：${head.status}，${shape(head.narrative).chars} 字，调用 ${calls.length}/${maxCalls}`);
  };
  await game.play(worldId, ACTION, () => {}).done;
  await record(false);
  for (let r = 0; r < reps && calls.length < maxCalls; r++) {
    await setDirective(DIRECTIVE);
    await game.regenerate(worldId, null, () => {}).done;
    await record(true);
    if (r === reps - 1 || calls.length >= maxCalls) break;
    await setDirective("");
    await game.regenerate(worldId, null, () => {}).done;
    await record(false);
  }
  const mean = (list: typeof versions, key: "chars" | "charsPerParagraph" | "dialogueShare") =>
    list.length ? Math.round((list.reduce((n, v) => n + v.shape[key], 0) / list.length) * 100) / 100 : null;
  const groups = Object.fromEntries((["without", "with"] as const).map((g) => {
    const list = versions.filter((v) => v.directive === (g === "with"));
    return [g, { versions: list.length, chars: mean(list, "chars"), charsPerParagraph: mean(list, "charsPerParagraph"), dialogueShare: mean(list, "dialogueShare") }];
  }));
  const summary = {
    model, promptVersion: PROMPT_VERSION, template: TEMPLATE, directive: DIRECTIVE, action: ACTION.text, maxCalls,
    calls: { total: calls.length, failed: calls.filter((c) => c.failed).map((c) => c.failed) },
    tokens: {
      prompt: calls.reduce((n, c) => n + (c.usage?.promptTokens ?? 0), 0),
      completion: calls.reduce((n, c) => n + (c.usage?.completionTokens ?? 0), 0),
    },
    groups, versions,
  };
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, "summary.json"), JSON.stringify(summary, null, 2) + "\n", "utf8");
  fs.writeFileSync(path.join(out, "transcript.md"), `# 叙事方针对照\n\n模型：${model}；方针：${DIRECTIVE}\n\n行动：${ACTION.text}\n\n${versions.map((v, i) =>
    `## 第 ${i + 1} 版 · ${v.directive ? "带方针" : "不带方针"}（${v.shape.chars} 字，${v.shape.paragraphs} 段，对话占比 ${v.shape.dialogueShare}）\n\n${v.narrative}\n`).join("\n")}`, "utf8");
  console.log(JSON.stringify({ calls: summary.calls, tokens: summary.tokens, groups }, null, 2));
  console.log(`结果：${path.relative(ROOT, out)}`);
}

main().catch((error) => {
  console.error(error instanceof Error && /^(用法：|开局失败)/.test(error.message) ? error.message : "评测未完成，请检查槽位配置和本地环境（错误详情未输出以免泄露秘密）。");
  process.exitCode = 1;
});
