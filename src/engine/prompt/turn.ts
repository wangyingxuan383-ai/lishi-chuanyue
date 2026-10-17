// Prompts for opening, turns, the extraction fallback and the setup assistant.
// Changes are logged in ./CHANGES.md together with eval results.
import type { ChatMessage } from "../llm/chat";
import { nowOf, timeOfDay } from "../calendar/clock";
import { formatDate } from "../calendar/date";
import type { EraContext } from "../era";
import { ERA_CARD_LIMIT, activeCardLines } from "../memory/cards";
import { formatMoney } from "../money";
import type { ActionMode, Chapter, Perspective, StoryNode, WorldSettings, WorldState } from "../types";
import { RECAP_BUDGET, recapBlock } from "./chapter";

export const PROMPT_VERSION = "turn-6";

const LENGTH: Record<WorldSettings["length"], string> = { 短: "约两百字", 中: "约四百字", 长: "约八百字" };

const INTENSITY_TEXT = {
  violence: { 含蓄: "暴力与伤亡点到为止，不写细节", 写实: "暴力与伤亡如实描写，但不猎奇、不渲染血腥", 浓烈: "暴力与伤亡可以直接、具体地描写" },
  romance: { 含蓄: "感情与亲密情节点到为止", 写实: "感情与亲密情节自然描写，亲密场面含蓄带过", 浓烈: "感情与亲密情节可以写得浓烈直接" },
  darkness: { 含蓄: "少写压抑、绝望的内容，基调偏温和", 写实: "如实呈现时代的苦难与阴暗面", 浓烈: "可以充分展现残酷、绝望与人性阴暗" },
} as const;

export const CLICHES = ["指节泛白", "嘴角勾起", "一抹弧度", "眼中闪过一丝", "空气仿佛凝固", "五味杂陈", "心中一凛", "不由得", "仿佛", "一丝不易察觉"];

const PERSPECTIVE: Record<Perspective, (name: string) => string> = {
  你: () => "用第二人称“你”称呼主角",
  我: () => "用第一人称“我”，“我”就是主角",
  他: (name) => `用第三人称，以主角的名字“${name}”或“他/她”称呼主角，像写小说一样`,
};

const RECORD_FIELDS = `{"time":"本回合经过的时长，如：一刻 / 半个时辰 / 两个时辰 / 一夜 / 三天",
 "place":"主角到了新的地点才写，写地点名",
 "money":钱的增减，整数，单位为最小货币单位，花钱为负数,
 "stats":{"health":健康增减,"energy":精力增减,"fame":名望增减},
 "items":[{"name":"物品名（已有物品沿用原名）","delta":数量增减}],
 "people":[{"name":"人物名","role":"身份","attitude":"仇视/敌意/冷淡/一般/友善/亲近/生死之交","note":"一句备注","aliases":["此前对他的称呼（如原来只知道是“货栈管事”，现在得知名叫刘三郎，就写 name 刘三郎、aliases 货栈管事）"]}],
 "status":[{"op":"add 或 remove","name":"伤病或状态名","detail":"说明"}],
 "goals":[{"op":"add / progress / done / fail","name":"目标名（已有目标沿用原名）","detail":"进展"}],
 "log":"一句话记下本回合发生了什么",
 "choices":["建议行动1","建议行动2","建议行动3"]}`;

const RECORD_SPEC = `【输出格式】先写正文。正文结束后另起一行，输出记录块（只写有变化的字段；time、log、choices 每回合都要有）：
<record>
${RECORD_FIELDS}
</record>
记录必须与正文一致：正文里付了钱、得到或失去东西、受伤、结识人物，记录里都要写；正文没有发生的，记录里不要写。人物、物品、目标沿用【当前】中的原名。
items 只写主角真正拿到、买下、收下或失去、用掉、送出的东西；只是看见、身边本来就有的家具杂物不写。people 只写本回合真正出场或打过交道的人。`;

const OPENING_EXTRA = `开场的记录块另有要求：
- "date"：故事开始的日期，写成对象 {"era":"年号（西方背景写“公元”或“公元前”）","year":第几年,"month":月,"day":日,"ceYear":对应的公元年份（公元前为负数）}；中国背景用农历月日。如 {"era":"天宝","year":7,"month":11,"day":17,"ceYear":748}、{"era":"公元前","year":44,"month":3,"day":14,"ceYear":-44}。之后的日期由程序按经过的时间推算；
- "hour"：开场时刻，0～23 的整数；
- "money"：主角此刻身上的钱（不是增减，是总数，整数，单位为最小货币单位），要符合主角的身份——皇子与乞丐差别很大；
- "currency"：这个时代的货币单位，从大到小，如 [{"name":"贯","value":1000},{"name":"文","value":1}] 或 [{"name":"两","value":1000},{"name":"钱","value":100},{"name":"文","value":1}] 或 [{"name":"denarius","value":16},{"name":"as","value":1}]；
- goals 里用 op "add" 写出第一个目标；people 写出开场出现或与主角密切相关的人物；items 写出主角随身真正有的东西；place 写出当前地点。`;

export interface StoryContext {
  era: EraContext;
  settings: WorldSettings;
  protagonistName: string;
}

/** `recap` is the 【前情提要】 of chapters that left the raw-text window (R04-T003). */
function systemPrompt(ctx: StoryContext, recap = ""): string {
  const { era, settings } = ctx;
  const i = settings.intensity;
  const premise = settings.premise.trim();
  const rules = settings.rules.trim();
  const eraBlock = era.eraCard
    ? `【时代】${era.eraCard.name}（与【故事设定】冲突时以故事设定为准；拿不准的细节写得模糊些）\n${era.eraCard.content.slice(0, ERA_CARD_LIMIT)}`
    : "【时代】以【故事设定】为准。称谓、货币、器物、制度要符合那个时代；拿不准的细节写得模糊些，不编造确切数字、人名和官职。";
  return `你是一部历史互动小说的作者兼叙事者。玩家扮演主角，你负责写出世界、其他人物和剧情。
【写作要求】
- ${PERSPECTIVE[settings.perspective](ctx.protagonistName)}。先写画面、声音、气味和动作，少用总结句；对话简短、口吻符合人物身份。叙述用${settings.style === "半文半白" ? "半文半白" : "白话"}，人物对白带时代口吻。每回合${LENGTH[settings.length]}。
- 只写到玩家需要做决定为止。主角只做玩家写下的事：玩家只说了大意，就照大意写，不替主角添新的计划、约定、许诺、威胁或贿赂，不替主角说出或藏起玩家没提的秘密、证据和底牌，不擅自把玩家没说要做完的事做完。玩家说“先试一下”“先问问”，就只写试一下、问一下的结果。拿不准主角会怎么做，就写到那里停下，让玩家决定。
- 玩家的行动可能失败。行动有难度或风险时，按情理决定成败，失败也要写出后果。
- 其他人物有自己的目的、脾气和处境，不围着主角转；态度变化要有缘由。
- 涉及钱和物品时，只能使用【当前】中列出的数量，正文写清具体数目；钱不够就买不成、付不起。
- 主角的性别、身份、年龄以【当前】为准，前后保持一致。正文里的时辰要和【当前】的时辰加上本回合经过的时间对得上；要跳过一段时间（如等到傍晚），就在记录的 time 里写明经过了多久。
- 避免套话和重复上一回合的开头与句式。不要用：${CLICHES.slice(0, 6).join("、")}。
- 内容尺度：${INTENSITY_TEXT.violence[i.violence]}；${INTENSITY_TEXT.romance[i.romance]}；${INTENSITY_TEXT.darkness[i.darkness]}。
- 每回合结尾留一个自然的行动点。${settings.choiceCount > 0 ? `在记录里给出 ${settings.choiceCount} 个简短、彼此不同的建议行动（各不超过二十字）` : "记录里的 choices 写空数组 []"}。
${premise ? `\n【故事设定】（玩家写的，始终遵守）\n${premise}\n` : ""}${rules ? `\n【玩家给你的额外规则】（始终遵守）\n${rules}\n` : ""}
${eraBlock}
${recap ? `\n${recap}\n` : ""}
${RECORD_SPEC}`;
}

const level = (n: number, words: string[]) => words[Math.min(words.length - 1, Math.floor((100 - n) / (100 / words.length)))];

/** People listed with their role and attitude; beyond this, names only. */
const PEOPLE_LINES = 30;

/**
 * The 【当前】 block. `present` (person ids mentioned in the recent text) puts
 * those people first with their notes (R04-T001); without it everyone's notes
 * are shown.
 */
export function renderState(state: WorldState, era: EraContext, present?: Set<string>): string {
  const me = state.protagonist;
  const now = nowOf(era.clock, state.time.elapsedMinutes);
  const place = state.places.find((p) => p.id === state.placeId)?.name ?? "（未记录）";
  const items = me.items.map((i) => `${i.name}×${i.quantity}${i.unit}${i.place ? `（放在${i.place}）` : ""}`).join("、") || "无";
  const statuses = me.statuses.map((s) => `${s.name}${s.detail ? `：${s.detail}` : ""}`).join("；") || "无";
  const here = (id: string) => !present || present.has(id);
  const ordered = present
    ? [...state.people].sort((a, b) => Number(present.has(b.id)) - Number(present.has(a.id)) || (b.lastSeenMinute ?? -1) - (a.lastSeenMinute ?? -1))
    : state.people;
  const rest = ordered.slice(PEOPLE_LINES);
  const people = [
    ...ordered.slice(0, PEOPLE_LINES).map((p) => `${p.name}${p.aliases.length ? `（又称${p.aliases.join("、")}）` : ""}：${p.role || "身份不明"}，对主角${p.attitude}${p.alive ? "" : "，已死"}${p.notes && here(p.id) ? `；${p.notes}` : ""}`),
    ...(rest.length ? [`另有：${rest.map((p) => `${p.name}${p.alive ? "" : "（已死）"}`).join("、")}`] : []),
  ].join("\n") || "无";
  const goals = state.goals.filter((g) => g.status === "进行中").map((g) => `${g.name}${g.progress ? `（${g.progress}）` : ""}`).join("；") || "无";
  const smallest = era.currency.units[era.currency.units.length - 1].name;
  const when = now.date ? formatDate(now.date, era.clock.rules) : `${era.clock.label ? `${era.clock.label}起 ` : ""}第 ${now.day} 日`;
  return `【当前】${when} ${timeOfDay(now)} · ${place}
主角：${me.name}，${me.gender}${me.age ? `，${me.age}岁` : ""}，${me.identity}${me.origin ? `（穿越前是${me.origin}）` : ""}
可用的钱：${formatMoney(me.stats.money, era.currency)}（共 ${me.stats.money} ${smallest}）${me.stats.debt ? `；欠债 ${formatMoney(me.stats.debt, era.currency)}` : ""}
身体：健康${level(me.stats.health, ["康健", "微恙", "带伤", "重伤", "垂危"])}，精力${level(me.stats.energy, ["充沛", "尚可", "疲惫", "力竭"])}
身上的伤病与状态：${statuses}
行囊：${items}
已知人物：
${people}
进行中的目标：${goals}`;
}

const ACTION_TEXT: Record<ActionMode, (text: string) => string> = {
  do: (t) => `【玩家行动】${t}`,
  say: (t) => `【玩家说】${/^[“"「]/.test(t) ? t : `“${t}”`}`,
  write: (t) => `【玩家以作者身份亲手写下了接下来的情节，视为已经发生，不要复述，直接接着往下写】\n${t}`,
  direct: (t) => `【玩家没有行动，只给叙事者一个幕后要求，照做但不要在正文中提及】${t}\n主角只做等待、观察这类被动动作，由他人和环境推动剧情。`,
  continue: () => "【玩家选择继续】主角只做等待、观察这类被动动作，由他人和环境推动剧情，小幅推进时间。",
};

export interface TurnPromptInput extends StoryContext {
  state: WorldState;
  /** Committed story so far on the current path, oldest first (opening included). */
  history: StoryNode[];
  mode: ActionMode;
  text: string;
  directorNote?: string | null;
  /** Corrections from the previous turn's ledger (e.g. "钱不够，没买成"). */
  notes?: string[];
  /** Regenerate direction, e.g. "写短一点" or "换个结果". */
  rewriteHint?: string | null;
  /** 要点 remembered from passages on the current path (D106). */
  pins?: string[];
  /** Chapter summaries on the current path, oldest first (R04-T003). */
  chapters?: Chapter[];
  /** Rough input budget in characters (≈ tokens for Chinese). */
  budgetChars?: number;
}

/** Recent turns as chat history, newest kept first until the budget runs out (minimum three); `ids` are the turns it kept. */
function historyWindow(history: StoryNode[], budget: number): { messages: ChatMessage[]; ids: Set<string> } {
  const pairs: ChatMessage[][] = [];
  const ids = new Set<string>();
  let used = 0;
  const turns = history.filter((n) => n.kind !== "edit");
  for (let i = turns.length - 1; i >= 0; i--) {
    const n = turns[i];
    const action = n.kind === "opening" ? "（开场）" : n.actionMode && n.actionText != null ? ACTION_TEXT[n.actionMode](n.actionText) : "（继续）";
    const cost = action.length + n.narrative.length;
    if (pairs.length >= 3 && used + cost > budget) break;
    used += cost;
    ids.add(n.id);
    pairs.unshift([{ role: "user", content: action }, { role: "assistant", content: n.narrative }]);
  }
  return { messages: pairs.flat(), ids };
}

function essentialsBlock(settings: WorldSettings, pins: string[] = []): string {
  const lines = [...settings.essentials.split(/\n+/), ...pins].map((l) => l.trim()).filter(Boolean);
  return lines.length ? `\n【要点，必须记住】\n- ${lines.join("\n- ")}` : "";
}

/** The last three turns and this action: what decides which cards and people's notes come in. */
function recentText(input: TurnPromptInput): string {
  return [...input.history.filter((n) => n.kind !== "edit").slice(-3).flatMap((n) => [n.actionText ?? "", n.narrative]), input.text, input.directorNote ?? ""].join("\n");
}

/** Places and cards mentioned in the last three turns or this action (D121). */
function cardsBlock(input: TurnPromptInput, recent: string): string {
  const lines = activeCardLines(input.state, recent);
  return lines.length ? `\n【相关设定】\n${lines.join("\n")}` : "";
}

/** People named in the recent text (by name or alias). */
function presentPeople(state: WorldState, recent: string): Set<string> {
  return new Set(state.people.filter((p) => [p.name, ...p.aliases].some((n) => n && recent.includes(n))).map((p) => p.id));
}

export function turnMessages(input: TurnPromptInput): ChatMessage[] {
  const base = systemPrompt(input);
  const directive = input.settings.directive ? `\n【叙事方针】${input.settings.directive}` : "";
  const notes = input.notes?.length ? `\n【上回合的实际结果，请在叙述中自然体现】\n- ${input.notes.join("\n- ")}` : "";
  const director = input.directorNote ? `\n【幕后要求，照做但不要在正文中提及】${input.directorNote}` : "";
  const hint = input.rewriteHint ? `\n【重写要求】${input.rewriteHint}` : "";
  // Chapters take their share of the budget first; the raw-text window gets the rest.
  const chapters = input.chapters ?? [];
  const budget = (input.budgetChars ?? 12000) - base.length - 1500 - (chapters.length ? RECAP_BUDGET : 0);
  const window = historyWindow(input.history, budget);
  const recap = recapBlock(chapters, (id) => window.ids.has(id));
  const recent = recentText(input);
  return [
    { role: "system", content: recap ? systemPrompt(input, recap) : base },
    ...window.messages,
    {
      role: "user",
      content: `${renderState(input.state, input.era, presentPeople(input.state, recent))}${essentialsBlock(input.settings, input.pins)}${cardsBlock(input, recent)}${directive}${notes}\n\n${ACTION_TEXT[input.mode](input.text)}${director}${hint}\n\n（写完正文后，别忘了输出 <record> 记录块。）`,
    },
  ];
}

// ---------- opening ----------

export type Arrival = "魂穿" | "身穿" | "投胎" | "不穿越";

export interface OpeningInput extends StoryContext {
  protagonist: { name: string; gender: string; age: number | null; identity: string };
  arrival: Arrival;
  origin: string;
  /** What the player wants the first scene to show (may be empty). */
  hint: string;
}

function protagonistLine(input: OpeningInput): string {
  const p = input.protagonist;
  const how = {
    魂穿: `现代人的意识在${p.name}身上醒来，原主的记忆会一段段涌上来`,
    身穿: "连人带衣物穿越而来，没有这个时代的户籍与身份，周围人只当是来历不明的外乡人",
    投胎: `带着前世记忆重生为${p.name}，此刻正是记忆完全苏醒的一天`,
    不穿越: "",
  }[input.arrival];
  return `主角：${p.name || "（由你取一个符合时代的名字）"}，${p.gender}${p.age ? `，${p.age}岁` : ""}。${p.identity}
${input.arrival === "不穿越" ? "主角就是这个时代土生土长的人，没有穿越。" : `穿越方式：${input.arrival}——${how}。穿越前，主角是${input.origin || "一个普通的现代人"}。`}`;
}

/** With an era pack, the opening date and currency are already known. */
function packLine(era: EraContext): string {
  if (!era.packId) return "";
  const date = era.clock.date ? `开局日期是${formatDate(era.clock.date, era.clock.rules)}，除非【故事设定】另有说明，就用这个日期；` : "";
  return `\n本时代资料已定：${date}货币为${era.currency.units.map((u) => u.name).join("、")}，currency 可以省略。`;
}

export function openingMessages(input: OpeningInput): ChatMessage[] {
  const arrivalSteps = input.arrival === "不穿越"
    ? "1. 从一个具体的场景切入，先写画面与动作，不要先交代背景。"
    : `1. 先写醒来时的感官（冷暖、气味、声音、身体的不适），不要先解释。\n${input.arrival === "身穿" ? "2. 写主角意识到自己身处何时何地，周围人如何看待这个来历不明的人。" : "2. 写原主的记忆或眼前的线索，交代姓名、身份与处境。"}`;
  return [
    { role: "system", content: systemPrompt(input) },
    {
      role: "user",
      content: `请写这部小说的开场。
${protagonistLine(input)}
${input.hint ? `玩家希望开场：${input.hint}\n` : ""}开场要求：
${arrivalSteps}
3. 在开场中自然地点出当下的时间。
4. 以一个迫在眉睫的情境收尾，留给玩家决定。
${OPENING_EXTRA}${packLine(input.era)}`,
    },
  ];
}

/** The player wrote the opening themselves: only extract the starting state. */
export function openingExtractMessages(input: OpeningInput & { text: string }): ChatMessage[] {
  return [
    {
      role: "system",
      content: `你是这部互动小说的记录员。玩家亲手写了开场。根据【故事设定】【主角】和【开场正文】，只输出一个 JSON 对象，记录故事开始时的状态。字段如下（没有的省略）：
${RECORD_FIELDS}
${OPENING_EXTRA}${packLine(input.era)}
time 写 "0"。只输出 JSON，不要输出其他文字。`,
    },
    {
      role: "user",
      content: `【故事设定】\n${input.settings.premise || "（未写）"}\n\n【主角】\n${protagonistLine(input)}\n\n【开场正文】\n${input.text}`,
    },
  ];
}

// ---------- extraction fallback (补记) ----------

export function extractMessages(input: { era: EraContext; state: WorldState; action: string; narrative: string }): ChatMessage[] {
  return [
    {
      role: "system",
      content: `你是互动小说的记录员。根据【当前】状态和【本回合正文】，只输出一个 JSON 对象，描述本回合的变化。字段与含义如下（没有变化的字段省略；time、log、choices 必须有）：
${RECORD_FIELDS}
只输出 JSON，不要输出其他文字。`,
    },
    { role: "user", content: `${renderState(input.state, input.era)}\n\n【玩家行动】${input.action}\n\n【本回合正文】\n${input.narrative}` },
  ];
}

// ---------- continuing an interrupted turn ----------

export function continueMessages(base: ChatMessage[], partial: string): ChatMessage[] {
  return [
    ...base,
    { role: "assistant", content: partial },
    { role: "user", content: "上一段回复被中断了。请从中断处直接接着写（不要重复已写的内容），写完正文后照常输出记录块，记录块要涵盖整段回复中发生的变化。" },
  ];
}

// ---------- setup assistant ----------

export interface SetupDraft {
  title: string;
  premise: string;
  name: string;
  gender: string;
  age: number | null;
  identity: string;
  arrival: Arrival;
  origin: string;
  hint: string;
  essentials: string;
}

/** Turns a rough idea (and whatever the player already filled in) into a complete setup. */
export function assistMessages(idea: string, current: Partial<SetupDraft>): ChatMessage[] {
  const filled = Object.entries(current).filter(([, v]) => v !== undefined && v !== null && String(v).trim()).map(([k, v]) => `${k}: ${v}`).join("\n");
  return [
    {
      role: "system",
      content: `你帮玩家构思一部历史互动小说的开局。玩家给出一个想法和已经填好的字段，你补全其余字段，并让整体协调、有戏剧张力。已经填好的字段原样保留，不要改写。只输出一个 JSON 对象：
{"title":"故事标题（十字以内）",
 "premise":"故事设定：时代、地点、时局与这个故事的核心冲突，150～300字，用第二人称或客观叙述",
 "name":"主角名字，符合时代",
 "gender":"男 或 女",
 "age":年龄整数,
 "identity":"主角的身份与处境，以“你是”开头，80～150字，包含一个迫在眉睫的麻烦",
 "arrival":"魂穿 / 身穿 / 投胎 / 不穿越",
 "origin":"穿越前是谁（不穿越则为空字符串）",
 "hint":"开场第一幕的场景，一句话",
 "essentials":"需要一直记住的要点，每行一条，最多五条"}
性别必须与身份一致（公主、宫女是女，皇子、驸马是男）。只输出 JSON。`,
    },
    { role: "user", content: `玩家的想法：${idea || "（没有写，请你自由发挥一个有意思的开局）"}\n\n已经填好的字段：\n${filled || "（无）"}` },
  ];
}
