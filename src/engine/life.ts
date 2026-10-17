// What a life leaves behind (PLAN_V4 direction G): the 小传 (a 列传-style
// summary), the 行状 (play statistics) and the 印谱 (a few achievements).
// All built from saved state and nodes, without a model call.
import { nowOf, type GameClock } from "./calendar/clock";
import { formatMoney, type Currency } from "./money";
import type { ActionMode, StoryNode, WorldState } from "./types";

/** How long, in game time: "不到一天" / "12 天" / "约 3 个月" / "2 年 5 个月". */
export function spanText(minutes: number): string {
  const days = Math.floor(Math.max(0, minutes) / 1440);
  if (days < 1) return "不到一天";
  if (days < 30) return `${days} 天`;
  if (days < 365) return `约 ${Math.floor(days / 30)} 个月`;
  const years = Math.floor(days / 365);
  const months = Math.floor((days % 365) / 30);
  return `${years} 年${months ? ` ${months} 个月` : ""}`;
}

/** The game date at a moment, without the hour: "天宝七载 冬月十七" or "中平元年秋 · 第 3 日". */
export function dateText(clock: GameClock, minutes: number): string {
  return nowOf(clock, minutes).text.replace(/\s·\s.时$/, "");
}

const sentence = (text: string) => (/[。！？…」”]$/.test(text) ? text : `${text}。`);

export type LifeSeal = "殉身" | "功成" | "未竟";

export interface LifeSection {
  label: string;
  text: string;
}

export interface LifeSummary {
  name: string;
  /** Two characters for the cinnabar 结局印. */
  seal: LifeSeal;
  sections: LifeSection[];
  /** The sections as one passage, for the picture. */
  prose: string;
}

export interface LifeInput {
  state: WorldState;
  clock: GameClock;
  currency: Currency;
  eraTitle: string;
  dead: boolean;
}

/** The outcome seal: 殉身 when dead, 功成 when every main goal is done, otherwise 未竟. */
export function lifeSeal(state: WorldState, dead: boolean): LifeSeal {
  if (dead) return "殉身";
  const main = state.goals.filter((g) => g.kind === "主线" && g.status !== "放弃");
  if (main.length && main.every((g) => g.status === "完成")) return "功成";
  return "未竟";
}

/** A 列传-style summary of the protagonist's life so far. */
export function lifeSummary({ state, clock, currency, eraTitle, dead }: LifeInput): LifeSummary {
  const me = state.protagonist;
  const name = me.name || "无名氏";
  const sections: LifeSection[] = [];

  const who: string[] = [];
  who.push(me.origin ? `${name}，原是${me.origin}，来到${eraTitle}。` : `${name}，${eraTitle}人。`);
  // Only the first sentence: the rest is usually the opening scene, written to the player.
  const identity = me.identity.trim().split(/(?<=[。！？])/)[0].replace(/[。！？]$/, "");
  // Written to the player ("你是…，家中只剩你主事"): the first 你 becomes the name, the others 他 or 她.
  const he = me.gender.includes("女") ? "她" : "他";
  const third = (t: string) => (t.startsWith("你") ? name + t.slice(1) : t).replace(/你们/g, `${he}们`).replace(/你/g, he);
  if (identity) who.push(sentence(identity.startsWith("你") ? third(identity) : `身为${third(identity)}`));
  sections.push({ label: "出身", text: who.join("") });

  const start = dateText(clock, 0);
  const end = dateText(clock, state.time.elapsedMinutes);
  const span = spanText(state.time.elapsedMinutes);
  const age = me.age != null ? (dead ? `，享年 ${me.age} 岁` : `，今年 ${me.age} 岁`) : "";
  sections.push({ label: "生平", text: `${start}入世，${dead ? "卒于" : "至今"}${end}，历时${span}${age}。` });

  if (state.places.length) {
    const here = state.places.find((p) => p.id === state.placeId)?.name;
    const names = state.places.map((p) => p.name);
    sections.push({ label: "足迹", text: `到过${names.join("、")}，共 ${names.length} 处${here ? `；${dead ? "最后在" : "如今在"}${here}` : ""}。` });
  }

  if (state.people.length) {
    const living = state.people.filter((p) => p.alive !== false);
    const gone = state.people.filter((p) => p.alive === false);
    const shown = living.slice(0, 8).map((p) => `${p.name}（${p.attitude}）`);
    let text = `结识 ${state.people.length} 人`;
    if (shown.length) text += `：${shown.join("、")}${living.length > shown.length ? " 等" : ""}`;
    if (gone.length) text += `；已故的有${gone.map((p) => p.name).join("、")}`;
    sections.push({ label: "交游", text: `${text}。` });
  }

  const done = state.goals.filter((g) => g.status === "完成").map((g) => g.name);
  const open = state.goals.filter((g) => g.status === "进行中").map((g) => g.name);
  const failed = state.goals.filter((g) => g.status === "失败" || g.status === "放弃").map((g) => g.name);
  if (done.length || open.length || failed.length) {
    const parts: string[] = [];
    if (done.length) parts.push(`做成了${done.join("、")}`);
    if (failed.length) parts.push(`没能做成${failed.join("、")}`);
    if (open.length) parts.push(`${dead ? "未了的心事" : "还在做的事"}：${open.join("、")}`);
    sections.push({ label: "事业", text: `${parts.join("；")}。` });
  }

  if (state.deviations.length) {
    sections.push({ label: "改史", text: `改变了 ${state.deviations.length} 件史事：${state.deviations.map((d) => d.replace(/[。；;]$/, "")).join("；")}。` });
  } else {
    sections.push({ label: "改史", text: "史事还是书上写的样子。" });
  }

  const money = formatMoney(me.stats.money, currency);
  const debt = me.stats.debt > 0 ? `，欠债 ${formatMoney(me.stats.debt, currency)}` : "";
  sections.push({ label: "家产", text: `${dead ? "身后留下" : "手头有"}钱 ${money}${debt}。` });

  return { name, seal: lifeSeal(state, dead), sections, prose: sections.map((s) => s.text).join("\n") };
}

// ---------- 行状: play statistics ----------

export const MODE_LABELS: Record<ActionMode, string> = { do: "做", say: "说", write: "写", direct: "幕后", continue: "继续", skip: "过些日子" };

export interface PlayStats {
  /** Turns on the current path (this life). */
  turns: number;
  /** All turns written in this world, every route included. */
  allTurns: number;
  gameMinutes: number;
  lines: number;
  /** Estimated real minutes: gaps between turns, each counted up to 10 minutes. */
  realMinutes: number;
  /** Action modes by use, most first. */
  modes: { mode: ActionMode; label: string; count: number }[];
}

const isTurn = (n: StoryNode) => n.kind === "turn" || n.kind === "fastforward";

/** Real play time from node timestamps; a pause longer than `capMinutes` counts as `capMinutes`. */
export function realMinutes(nodes: Pick<StoryNode, "createdAt">[], capMinutes = 10): number {
  const times = nodes.map((n) => Date.parse(n.createdAt)).filter(Number.isFinite).sort((a, b) => a - b);
  let total = 0;
  for (let i = 1; i < times.length; i++) total += Math.min(times[i] - times[i - 1], capMinutes * 60_000);
  return Math.round(total / 60_000);
}

export function playStats(input: { path: StoryNode[]; all: StoryNode[]; lines: number; gameMinutes: number }): PlayStats {
  const counts = new Map<ActionMode, number>();
  for (const n of input.all) if (isTurn(n) && n.actionMode) counts.set(n.actionMode, (counts.get(n.actionMode) ?? 0) + 1);
  const modes = [...counts].map(([mode, count]) => ({ mode, label: MODE_LABELS[mode], count })).sort((a, b) => b.count - a.count);
  return {
    turns: input.path.filter(isTurn).length,
    allTurns: input.all.filter(isTurn).length,
    gameMinutes: input.gameMinutes,
    lines: input.lines,
    realMinutes: realMinutes(input.all),
    modes,
  };
}

/** "约 40 分钟" / "约 2 小时 15 分" */
export function realTimeText(minutes: number): string {
  if (minutes < 60) return `约 ${Math.max(1, minutes)} 分钟`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `约 ${h} 小时${m ? ` ${m} 分` : ""}`;
}

// ---------- 印谱: achievements ----------

export interface SealFacts {
  turns: number;
  lines: number;
  state: WorldState;
  currency: Currency;
}

export interface SealRule {
  id: string;
  /** The seal's text, two to four characters. */
  name: string;
  /** How to earn it, in plain words. */
  how: string;
  test: (f: SealFacts) => boolean;
}

/** A thousand of the era's largest unit (千贯, 千两); 1000 when the currency is unnamed. */
export function richThreshold(currency: Currency): number {
  return 1000 * (currency.units[0]?.value ?? 1);
}

export const SEALS: SealRule[] = [
  { id: "arrive", name: "初到异乡", how: "走完第一回合", test: (f) => f.turns >= 1 },
  { id: "friends", name: "结识十人", how: "结识十个人", test: (f) => f.state.people.length >= 10 },
  { id: "bond", name: "生死之交", how: "有一个人与你成了生死之交", test: (f) => f.state.people.some((p) => p.attitude === "生死之交" && p.alive !== false) },
  { id: "travel", name: "行遍四方", how: "到过五个地方", test: (f) => f.state.places.length >= 5 },
  { id: "wish", name: "得偿所愿", how: "做成一件事（目标或心愿）", test: (f) => f.state.goals.some((g) => g.status === "完成") },
  { id: "change", name: "改变史事", how: "改变一件史事", test: (f) => f.state.deviations.length >= 1 },
  { id: "turn", name: "扭转乾坤", how: "改变三件史事", test: (f) => f.state.deviations.length >= 3 },
  { id: "year", name: "寒暑一载", how: "在这个世界过满一年", test: (f) => f.state.time.elapsedMinutes >= 365 * 1440 },
  { id: "sixty", name: "年过甲子", how: "活到六十岁", test: (f) => (f.state.protagonist.age ?? 0) >= 60 },
  { id: "rich", name: "家财千金", how: "家产攒到一千个最大的钱币单位（如一千贯）", test: (f) => f.state.protagonist.stats.money >= richThreshold(f.currency) },
  { id: "fame", name: "名动一方", how: "名望到六十", test: (f) => f.state.protagonist.stats.fame >= 60 },
  { id: "lines", name: "另辟蹊径", how: "走出三条世界线", test: (f) => f.lines >= 3 },
];

export function earnedSeals(facts: SealFacts): SealRule[] {
  return SEALS.filter((s) => s.test(facts));
}

/** Seals earned now that are not in `shown`; the toast text for them, or null. */
export function newSeals(facts: SealFacts, shown: string[]): { ids: string[]; text: string } | null {
  const fresh = earnedSeals(facts).filter((s) => !shown.includes(s.id));
  if (!fresh.length) return null;
  const names = fresh.map((s) => `“${s.name}”`);
  return { ids: fresh.map((s) => s.id), text: fresh.length === 1 ? `得一枚印：${names[0]}` : `得 ${fresh.length} 枚印：${names.join("、")}` };
}

// ---------- 书摘 ----------

/** Up to `max` characters of a passage, cut at a sentence end when one is near. */
export function excerpt(text: string, max = 300): string {
  const clean = text.split(/\n+/).map((p) => p.trim()).filter(Boolean).join("\n");
  if (clean.length <= max) return clean;
  const head = clean.slice(0, max);
  const cut = Math.max(...["。", "！", "？", "」", "”"].map((m) => head.lastIndexOf(m)));
  return cut >= max * 0.6 ? head.slice(0, cut + 1) : `${head}……`;
}
