// Plays an opening plus a few turns through the real engine and prints what a
// player would see. Uses the dev key in .cache/dev-secrets.json.
//   node_modules/.bin/tsx scripts/eval/smoke.ts --model <model> [--turns "行动1|行动2|..."]
import { chatCompletionsUrl } from "../../src/engine/llm/chat.ts";
import { Game, type TurnEvent } from "../../src/engine/game.ts";
import { createMemoryPlatform } from "../../src/platform/memory.ts";
import { nowOf } from "../../src/engine/calendar/clock.ts";
import { TEMPLATES, templateName } from "../../src/content/templates.ts";
import { eraContext } from "../../src/engine/era/index.ts";
import { formatMoney } from "../../src/engine/money.ts";
import { nodePlatform, serviceBaseUrl } from "./lib.ts";

const arg = (name: string, fallback?: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const model = arg("model")!;
const actions = (arg("turns", "先看看屋里有什么|“掌柜，房钱再宽限两日。”|出门去西市找活干|（继续）") as string).split("|");
const templateId = arg("template", "tang-scholar")!;

const platform = await createMemoryPlatform(nodePlatform().llm);
const game = await Game.open(platform, { slot: "main", url: chatCompletionsUrl(serviceBaseUrl()), model, includeUsage: true });
const log = (e: TurnEvent) => {
  if (e.type === "failed") console.log(`  ✗ ${e.reason} ${e.status ?? ""} ${e.detail ?? ""}`);
  if (e.type === "organizing") console.log("  （整理中…）");
};

const t0 = performance.now();
const t = TEMPLATES.find((x) => x.id === templateId)!;
const gender = t.gender ?? "女";
const worldId = await game.createWorld({
  title: t.title, eraId: t.eraId, settings: { premise: t.premise },
  protagonist: { name: templateName(t, gender), gender, age: t.age, identity: t.identity },
  arrival: t.arrival ?? "魂穿", origin: "历史系研究生", opening: { mode: "ai", hint: t.openingHint },
}, log);
if (!worldId) process.exit(1);

async function show(label: string) {
  const { cursor } = await import("../../src/engine/tree.ts");
  const c = await cursor(game.repo, worldId!);
  const s = await game.repo.getState(c.head.id);
  const era = eraContext((await game.repo.getWorld(worldId!))!.eraId, s);
  console.log(`\n=== ${label} · ${nowOf(era.clock, s.time.elapsedMinutes).text} · 钱 ${formatMoney(s.protagonist.stats.money, era.currency)} · ${c.head.meta.firstTokenMs ? `首字 ${Math.round(c.head.meta.firstTokenMs as number)}ms` : ""}`);
  console.log(c.head.narrative);
  console.log("  标签:", ((c.head.meta.chips as { text: string }[]) ?? []).map((x) => x.text).join(" | "));
  console.log("  选项:", c.head.choices.join(" | "));
  if ((c.head.meta.log as string[])?.length) console.log("  日志:", (c.head.meta.log as string[]).join("；"));
}
await show(`开场（${Math.round(performance.now() - t0)}ms）`);
for (const a of actions) {
  const mode = a === "（继续）" ? "continue" : /^[“"]/.test(a) ? "say" : a.startsWith("写：") ? "write" : "do";
  await game.play(worldId, { mode, text: mode === "continue" ? "" : a.replace(/^写：/, "") }, log).done;
  await show(a);
}
const { cursor } = await import("../../src/engine/tree.ts");
const s = await game.repo.getState((await cursor(game.repo, worldId)).head.id);
console.log("\n人物:", s.people.map((p) => `${p.name}(${p.attitude})`).join("、"), "\n物品:", s.protagonist.items.map((i) => `${i.name}×${i.quantity}`).join("、"), "\n目标:", s.goals.map((g) => `${g.name}[${g.status}]`).join("、"));
