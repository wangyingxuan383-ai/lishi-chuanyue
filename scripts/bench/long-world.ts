// R08-T003: how the engine copes with a 1000-turn world. Builds one in memory
// (600-character passages, a realistic state, a branch every 100 turns) and
// times what opening the home screen, the play screen and the next turn do.
//   node_modules/.bin/tsx scripts/bench/long-world.ts [--turns 1000]
import { createMemoryPlatform } from "../../src/platform/memory.ts";
import { Game } from "../../src/engine/game.ts";
import { buildTurnContext } from "../../src/engine/prompt/turn.ts";
import { eraContext } from "../../src/engine/era/index.ts";
import { sampleState } from "../../src/engine/testing/fixtures.ts";
import * as tree from "../../src/engine/tree.ts";

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? fallback : process.argv[i + 1];
};
const TURNS = Number(arg("turns", "1000"));

async function time<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const start = performance.now();
  const value = await fn();
  console.log(`${label}：${(performance.now() - start).toFixed(1)} 毫秒`);
  return value;
}

async function main() {
  const platform = await createMemoryPlatform();
  const game = await Game.open(platform);
  const state = sampleState();
  state.people = Array.from({ length: 40 }, (_, i) => ({ id: `p${i}`, name: `人物${i}`, aliases: [], role: "坊里的人", attitude: "一般" as const, alive: true, notes: "一句备注".repeat(5), lastSeenMinute: i }));
  state.cards = Array.from({ length: 30 }, (_, i) => ({ id: `c${i}`, kind: "势力" as const, name: `势力${i}`, keys: [], content: "资料".repeat(40) }));
  const { world } = await game.repo.createWorld({ title: "长局", eraId: "tang-748", opening: { parentId: null, kind: "opening", narrative: "开场".repeat(300), state } });
  let c = await tree.cursor(game.repo, world.id);
  const built = performance.now();
  for (let i = 1; i <= TURNS; i++) {
    c = await tree.append(game.repo, c, { kind: "turn", actionMode: "do", actionText: `第${i}步`, narrative: `第${i}段，人物${i % 40}与势力${i % 30}`.padEnd(600, "文"), state, choices: ["甲", "乙", "丙"], meta: { chips: [{ text: "过了 1 刻", tone: "info" }] } });
    if (i % 100 === 0) await game.repo.createLine(world.id, c.head.id, `第${i}回合的岔路`, false);
  }
  console.log(`建好 ${TURNS} 回合：${((performance.now() - built) / 1000).toFixed(1)} 秒`);

  await time("首页：数回合、取最后一句（每个世界）", async () => {
    const line = (await game.repo.getLine(world.currentLineId!))!;
    return game.repo.homeSummary(line.nodeId);
  });
  await time("世界线弹层：12 条线各数回合", async () => {
    for (const l of await game.repo.lines(world.id)) await game.repo.homeSummary(l.nodeId);
  });
  await time("打开游玩页：最近 31 段", async () => game.repo.path(c.head.id, 31));
  await time("游玩页状态", async () => game.repo.getState(c.head.id));
  await time("下一回合的上下文（整条路径、章节、要点、组装）", async () => {
    const path = await game.repo.path(c.head.id);
    const chapters = await game.repo.chaptersOnPath(world.id, c.head.id);
    const pins = await game.repo.pinsOnPath(world.id, c.head.id);
    return buildTurnContext({
      era: eraContext("tang-748", state), settings: (await game.repo.getWorld(world.id))!.settings, protagonistName: "李安", state,
      history: path.slice(-40), allTurns: path, chapters, pins: pins.map((p) => p.text), mode: "do", text: "去找人物7和势力3", budgetChars: 17000,
    });
  });
  await time("回合树：取全部节点", async () => game.repo.allNodes(world.id));
  // The browser harness (and a future static web version on sql.js) saves by exporting the whole database.
  const bytes = await time("网页版存一次盘：导出整个数据库", async () => platform.exportDb());
  console.log(`数据库大小：${(bytes.length / 1024 / 1024).toFixed(1)} MB`);
}

void main();
