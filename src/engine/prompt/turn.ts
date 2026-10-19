// Prompts for opening, turns, the extraction fallback and the setup assistant.
// Changes are logged in ./CHANGES.md together with eval results.
import type { ChatMessage } from "../llm/chat";
import { nowOf, timeOfDay } from "../calendar/clock";
import { formatDate } from "../calendar/date";
import type { EraContext } from "../era";
import { ERA_CARD_LIMIT, activeCardLines } from "../memory/cards";
import { formatMoney } from "../money";
import type { ActionMode, Challenge, Chapter, Perspective, Pilot, Script, StoryNode, WorldSettings, WorldState } from "../types";
import { RECAP_BUDGET, recapBlock } from "./chapter";
import { fortuneMode, fortuneNote, type Fortune } from "../fortune";
import { worldBlock } from "../timeline";
import { tabooReminder, type TabooHit } from "../era/taboo";
import { RECALL_BUDGET, recallBlock } from "../memory/recall";
import { beatTitle, challengeView } from "../modes";

import { fitReference, referenceBlock } from "../sources/library";
import type { ReferenceContext } from "../sources/types";
export const PROMPT_VERSION = "turn-20";

// R13 settings are optional for old saves; kept local until the shared types land.
type PromptOptions = {
  mode?: "history" | "free";
  clockStyle?: "era" | "elapsed";
  heroPanel?: string;
  heroPanelEnabled?: boolean;
  pilot?: Pilot;
};
type PromptSettings = WorldSettings & PromptOptions;
const isFree = (settings: PromptOptions) => settings.mode === "free";
/** 旁观 (R14): the AI plays the protagonist and the player directs. */
const aiPilot = (settings: PromptOptions) => settings.pilot === "ai";
const elapsedClock = (settings: PromptOptions) => isFree(settings) || settings.clockStyle === "elapsed";

function heroPanelBlock(settings: PromptOptions, panel?: string): string {
  return settings.heroPanelEnabled && panel?.trim()
    ? `\n【主角面板（玩家自记，仅作背景，不推算数值）】\n${panel.trim()}\n`
    : "";
}

function snapshotPanel(state: WorldState): string | undefined {
  return (state.protagonist as WorldState["protagonist"] & { panel?: string }).panel;
}

const LENGTH: Record<WorldSettings["length"], string> = { 短: "约两百字", 中: "约四百字", 长: "约八百字" };

const INTENSITY_TEXT = {
  violence: { 含蓄: "暴力与伤亡点到为止，不写细节", 写实: "暴力与伤亡如实描写，但不猎奇、不渲染血腥", 浓烈: "暴力与伤亡可以直接、具体地描写" },
  romance: { 含蓄: "感情与亲密情节点到为止", 写实: "感情与亲密情节自然描写，亲密场面含蓄带过", 浓烈: "感情与亲密情节可以写得浓烈直接" },
  darkness: { 含蓄: "少写压抑、绝望的内容，基调偏温和", 写实: "如实呈现时代的苦难与阴暗面", 浓烈: "可以充分展现残酷、绝望与人性阴暗" },
} as const;

// Evaluation vocabulary only; no longer injected as a writing blacklist.
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
 "status":[{"op":"add 或 remove","name":"身体或精神的状况（伤、病、醉、饿、累、中毒、惊惧）","detail":"说明"}],
 "died":只有主角的伤病里已有“垂危”、这一段又写到他伤上加伤死去时才写 true，写了就要把死写出来,
 "goals":[{"op":"add / progress / done / fail","name":"目标名（已有目标沿用原名）","detail":"进展","kind":"新目标才写：主线 / 支线"}],
 "log":"一句话记下本回合发生了什么",
 "deviation":"本回合的剧情若改变了史书记载的事（如救下了本该死去的人、阻止了本该发生的事），写一句；没有就不写",
 "risk":{"what":"玩家的行动里有风险或要看运气的那件事（没有就不写 risk）","result":"成 / 败 / 半成"},
 "choices":["建议行动1","建议行动2","建议行动3"]}`;

// Play modes (R14): record fields that appear only when there is a beat to play or a challenge under way.
const CHOICES_FIELD = ' "choices":["建议行动1","建议行动2","建议行动3"]}';
const BEAT_FIELD = ' "beat":当前这一幕的关键事件已在本段正文发生时写 "done"，否则不写,';
const CHALLENGE_FIELD = ' "challenge":{"progress":"挑战的现状，一句话","result":"目标确实达成写 won，失败条件确实出现写 lost，否则不写","why":"成败的缘由，一句话"},';
const DIRECTIONS_FIELD = ' "choices":["接下来的一种走向","另一种走向"]}';

/** The play modes a request carries (R14); both absent in ordinary worlds. */
export interface ModeContext {
  script?: Script | null;
  challenge?: Challenge | null;
}

const RECORD_SPEC = `【输出格式】先写正文。正文结束后另起一行，输出记录块（只写有变化的字段；time、log、choices 每回合都要有）：
<record>
${RECORD_FIELDS}
</record>
记录必须与正文一致：正文里付了钱、得到或失去东西、受伤、结识人物，记录里都要写；正文没有发生的，记录里不要写。人物、物品、目标沿用【当前】中的原名。
items 只写主角真正拿到、买下、收下或失去、用掉、送出的东西；只是看见、身边本来就有的家具杂物不写，钱不算物品。people 只写本回合真正出场或打过交道的人。
主角已经许下的承诺、欠下的人情或债、和人约好的事，在 goals 里记成支线目标，兑现了写 done，落空了写 fail；不凭空添加任务。主线目标确实再也办不成才写 fail，一次失手不算。
status 只记身体和精神的状况；东西记 items，知道的事、处境、别人的态度都不记在 status 里；伤好了、状况过去了就 remove。`;

const OPENING_EXTRA = `开场的记录块另有要求：
- "date"：故事开始的日期，写成对象 {"era":"年号（西方背景写“公元”或“公元前”）","year":第几年,"month":月,"day":日,"ceYear":对应的公元年份（公元前为负数）}；中国背景用农历月日。如 {"era":"天宝","year":7,"month":11,"day":17,"ceYear":748}、{"era":"公元前","year":44,"month":3,"day":14,"ceYear":-44}。之后的日期由程序按经过的时间推算；
- "hour"：开场时刻，0～23 的整数；
- "money"：主角此刻身上的钱（不是增减，是总数，整数，单位为最小货币单位），符合主角身份与故事设定；
- "currency"：这个时代的货币单位，从大到小，如 [{"name":"贯","value":1000},{"name":"文","value":1}] 或 [{"name":"两","value":1000},{"name":"钱","value":100},{"name":"文","value":1}] 或 [{"name":"denarius","value":16},{"name":"as","value":1}]；
- goals 只记玩家已明确的目标，没有就省略；people 写出开场出现或与主角密切相关的人物；items 写出主角随身真正有的东西；place 写出当前地点。`;

function recordFields(settings: PromptOptions = {}, modes: ModeContext = {}): string {
  let fields = RECORD_FIELDS;
  if (elapsedClock(settings)) fields = fields.replace("一刻 / 半个时辰 / 两个时辰 / 一夜 / 三天", "十分钟 / 半小时 / 两小时 / 一夜 / 三天");
  if (isFree(settings)) fields = fields.split("\n").filter((line) => !line.trimStart().startsWith('"deviation":')).join("\n");
  const extra = [
    ...(modes.script?.beats.some((b) => b.status === "todo") ? [BEAT_FIELD] : []),
    ...(modes.challenge?.status === "active" ? [CHALLENGE_FIELD] : []),
  ];
  if (extra.length || aiPilot(settings)) fields = fields.replace(CHOICES_FIELD, [...extra, aiPilot(settings) ? DIRECTIONS_FIELD : CHOICES_FIELD].join("\n"));
  return fields;
}

function openingExtra(settings: PromptOptions): string {
  const lines = OPENING_EXTRA.split("\n");
  return lines.map((line) => {
    if (elapsedClock(settings) && line.startsWith('- "date"')) return '- "date"：省略日期，按开局后的第几天记时；';
    if (isFree(settings) && line.startsWith('- "currency"')) return '- "currency"：这个世界的钱或通用交换单位，从大到小列出 [{"name":"单位名","value":相当于多少最小单位}]；最小单位 value 为 1。';
    return line;
  }).join("\n");
}

export interface StoryContext {
  era: EraContext;
  settings: PromptSettings;
  protagonistName: string;
}

interface SystemParts { rules: string; premise: string; era: string; spec: string }

const PLAYER_AGENCY = "主角只做玩家写下或已开始的事，不替主角添计划、约定、许诺、威胁或贿赂，不擅自说出或藏起秘密、证据和底牌。试探只写试探的结果；需要新决定就停下，让玩家决定。";
const AI_AGENCY = "主角由你来演：照他的性格、处境和目标，自己决定此刻说什么、做什么；每段只往前推一小步，在有意思的地方停下；【幕后】是导演的安排，不是主角说的话。";

function choicesRule(settings: PromptSettings): string {
  if (settings.choiceCount <= 0) return "记录里的 choices 写空数组 []";
  return aiPilot(settings) ? "记录里给 2～3 个“接下来可以怎样发展”的短句（各不超过二十字），写成故事的走向而不是主角的动作，如“旧识带来一个坏消息”“让日子先平静几天”，供玩家在幕后挑选" : `记录里给 ${settings.choiceCount} 个简短、不同的建议行动（各不超过二十字），由玩家选择`;
}

function systemParts(ctx: StoryContext, panel?: string, modes: ModeContext = {}): SystemParts {
  const { era, settings } = ctx;
  const i = settings.intensity;
  const premise = settings.premise.trim();
  const rules = settings.rules.trim();
  const free = isFree(settings);
  const card = free && era.packId && era.eraCard?.source === "卡组" ? null : era.eraCard;
  const eraBlock = card
    ? `【${free ? "世界" : "时代"}】${card.name}（与【故事设定】冲突时以故事设定为准）\n${card.content.slice(0, ERA_CARD_LIMIT)}`
    : free ? "【世界】以【故事设定】为准，世界规则前后一致。"
      : "【时代】以【故事设定】为准。称谓、货币、器物符合那个时代；拿不准的细节写得模糊些。";
  const rulesText = `你是一部${free ? "" : "历史"}互动小说的作者兼叙事者。${aiPilot(settings) ? "主角和其他人物都由你来演，玩家在幕后指点。" : "玩家扮演主角，你写世界、其他人物和剧情。"}
【写作要求】
- ${PERSPECTIVE[settings.perspective](ctx.protagonistName)}；每回合${LENGTH[settings.length]}。${free ? "文风和对白贴合玩家设定与人物身份" : `叙述用${settings.style === "半文半白" ? "半文半白" : "白话"}，对白符合时代与人物身份`}，避免重复上回合的开头和句式。
- ${aiPilot(settings) ? AI_AGENCY : PLAYER_AGENCY}
- 行动按情理决定成败，失败有后果；其他人物有自己的目的和处境，态度变化有缘由。
- 性别、身份、年龄、钱物、生死以【当前】和已发生的故事为准；钱物只用现有数量，花用写明数目，钱不够就付不起。时间不倒退，正文的${elapsedClock(settings) ? "时间" : "时辰"}与经过时长一致，跳过多久写入 time。
- 回忆旧事时只依据已记录的事实，不补造过去的来源、承诺或秘密；可以描写此刻的感受和环境，新事件从现在发展。
- ${choicesRule(settings)}。
【内容尺度】${INTENSITY_TEXT.violence[i.violence]}；${INTENSITY_TEXT.romance[i.romance]}；${free ? INTENSITY_TEXT.darkness[i.darkness].replace("时代", "世界") : INTENSITY_TEXT.darkness[i.darkness]}。`;
  return {
    rules: rulesText,
    premise: `${premise ? `\n【故事设定】（玩家写的，始终遵守）\n${premise}\n` : ""}${rules ? `\n【玩家给你的额外规则】（始终遵守）\n${rules}\n` : ""}${heroPanelBlock(settings, panel)}`,
    era: eraBlock,
    spec: RECORD_SPEC.replace(RECORD_FIELDS, recordFields(settings, modes)),
  };
}

/** `recap` is the 【前情提要】 of chapters that left the raw-text window (R04-T003). */
function joinSystem(p: SystemParts, recap = ""): string {
  return `${p.rules}\n${p.premise}\n${p.era}\n${recap ? `\n${recap}\n` : ""}\n${p.spec}`;
}

function systemPrompt(ctx: StoryContext, modes: ModeContext = {}): string {
  return joinSystem(systemParts(ctx, ctx.settings.heroPanel, modes));
}

const level = (n: number, words: string[]) => words[Math.min(words.length - 1, Math.floor((100 - n) / (100 / words.length)))];

/** People listed with their role and attitude; beyond this, names only. */
const PEOPLE_LINES = 30;

/** 来历 and 近况 of someone in play. */
function personNotes(p: WorldState["people"][number]): string {
  const origin = p.origin && p.origin !== p.notes ? `；来历：${p.origin}` : "";
  const notes = p.notes ? `；${origin ? "近况：" : ""}${p.notes}` : "";
  return origin + notes;
}

/**
 * The 【当前】 block. `present` (person ids mentioned in the recent text) puts
 * those people first with their notes (R04-T001); without it everyone's notes
 * are shown.
 */
export function renderState(state: WorldState, era: EraContext, present?: Set<string>, settings: PromptOptions = {}): string {
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
    ...ordered.slice(0, PEOPLE_LINES).map((p) => `${p.name}${p.aliases.length ? `（又称${p.aliases.join("、")}）` : ""}：${p.role || "身份不明"}，对主角${p.attitude}${p.alive ? "" : "，已死"}${here(p.id) ? personNotes(p) : ""}`),
    ...(rest.length ? [`另有：${rest.map((p) => `${p.name}${p.alive ? "" : "（已死）"}`).join("、")}`] : []),
  ].join("\n") || "无";
  const goals = state.goals.filter((g) => g.status === "进行中").map((g) => `【${g.kind}】${g.name}${g.progress ? `（${g.progress}）` : ""}`).join("；") || "无";
  const smallest = era.currency.units[era.currency.units.length - 1].name;
  const when = now.date ? formatDate(now.date, era.clock.rules) : `${era.clock.label ? `${era.clock.label}起 ` : ""}第 ${now.day} 日`;
  const clock = elapsedClock(settings)
    ? `第 ${now.day} 天 ${String(now.hour).padStart(2, "0")}:${String(now.minute).padStart(2, "0")}`
    : `${when} ${timeOfDay(now)}`;
  return `【当前】${clock} · ${place}
主角：${me.name}，${me.gender}${me.age != null ? `，${me.age}岁` : ""}，${me.identity}${me.origin ? `（穿越前是${me.origin}）` : ""}
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
  write: (t) => `【玩家以作者身份亲手写下了接下来的情节，视为已经发生，不要复述，直接接着往下写】\n${t}\n正文从这段结束之后写起，不重演其中的动作；记录只结算这段变化一次。`,
  direct: (t) => `【玩家没有行动，只给叙事者一个幕后要求，照做但不要在正文中提及】${t}\n主角不做新的决定，可以顺着已经在做的事继续；由他人和环境推动剧情。`,
  continue: () => "【玩家选择继续】主角不做新的决定，可以顺着已经在做的事继续；由他人和环境推动剧情。",
  skip: (t) => `【玩家选择过些日子】${t}
用一段“时光流逝”的叙述（三五百字）概括这段日子：主角大致怎么过的、钱的进出、身体如何、和谁有过往来；世事照常推进，进行中的目标该有进展就写进展。
先看眼下：最近的剧情里如果还有没了结的事——正在对峙、被追捕、有人重伤垂危、今天之内就有约或到期——就从那里接着写，写到需要主角决定为止，不要跳过去替主角处理。
平静的日子可以过满；遇到需要主角决定的事就停下。主角受重伤、下狱、丧命这类大事不要在概括里一笔带过，要发生就停在它发生之前。
记录里的 time 写实际过了多久（提前停下就写到停下时），"hour" 写结尾那一刻是几点（0～23 的整数，如清晨写 6、黄昏写 18）；这段日子里好了的伤病、过去了的状况用 status 的 remove 去掉；钱、物品、人物照实记。若有听闻，可选写 "report"：{"world":"这段日子听到的风声","local":"本地见闻","people":"人情往来"}，只填故事中发生的部分。`,
};

/** 旁观 (R14): with the AI playing the protagonist, 继续 and 幕后 move the protagonist too. */
const AI_ACTION_TEXT: Partial<Record<ActionMode, (text: string) => string>> = {
  continue: () => "【继续】接着往下演，主角照自己的性格和打算行动。",
  direct: (t) => `【幕后】${t}\n照这个安排往下演，正文里不提这条安排。`,
};

const actionLine = (mode: ActionMode, text: string, settings: PromptOptions) => ((aiPilot(settings) && AI_ACTION_TEXT[mode]) || ACTION_TEXT[mode])(text);

/** The 【剧本】 block (R14): what has been played, the beat to play now and what comes after. */
function scriptBlock(script: Script | null | undefined, settings: PromptOptions): string {
  if (!script?.beats.length) return "";
  const at = script.beats.findIndex((b) => b.status === "todo");
  if (at < 0) return `\n【剧本】剧本已演完，之后${aiPilot(settings) ? "" : "按玩家的行动"}自由发展。`;
  const done = script.beats.filter((b) => b.status === "done").map((b) => beatTitle(b.text));
  const later = script.beats.slice(at + 1).filter((b) => b.status === "todo").map((b) => b.text);
  const lines = [
    script.line ? `主线：${script.line}` : "",
    done.length ? `已演完：${done.join("；")}` : "",
    `这一幕：${script.beats[at].text}`,
    later.length ? `之后：${later.join("；")}` : "",
    script.ending ? `想要的结局：${script.ending}` : "",
    `让这一幕的事在情理之中自然出现：人物、消息、机会和阻碍由你安排，${aiPilot(settings) ? "主角照自己的性格应对" : "主角怎么应对仍由玩家决定；玩家没往这一幕走时，只让苗头出现，不替主角行动，也不跳过时间去凑这一幕"}；之后几幕先不写。这一幕的关键事件在正文里发生了，就在记录里写 "beat":"done"。`,
    script.steer === "firm" ? "故事偏离时，用情理之中的人和事把它引回这一幕。" : "",
  ];
  return `\n【剧本】（玩家定的骨架）\n${lines.filter(Boolean).join("\n")}`;
}

/** The 【挑战】 block (R14), only while it is undecided. */
function challengeBlock(state: Pick<WorldState, "challenge" | "time">): string {
  const c = state.challenge;
  const view = c?.status === "active" ? challengeView(state) : null;
  if (!c || !view) return "";
  const lines = [
    `期限：${!c.limit ? "不限时" : c.deadlineMinute === null ? c.limit : `${c.limit}（${view.remaining}）`}`,
    c.failIf ? `失败条件：${c.failIf}` : "",
    c.progress ? `最近进展：${c.progress}` : "",
    `难处是真实的，不放水也不刻意刁难，进展要靠主角的行动和代价换来。记录里写 "challenge":{"progress":"一句话现状"}；目标确实达成时加 "result":"won"，失败条件确实出现时加 "result":"lost","why":"……"。`,
  ];
  return `\n【挑战】${c.goal}\n${lines.filter(Boolean).join("\n")}`;
}

export interface TurnPromptInput extends StoryContext {
  reference?: ReferenceContext;
  state: WorldState;
  /** Committed story so far on the current path, oldest first (opening included); the newest 40 nodes. */
  history: StoryNode[];
  /** The whole path, for 【相关旧事】 from turns long gone from the window. */
  allTurns?: StoryNode[];
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
  /** This turn's hidden fortune (R05-T002). */
  fortune?: Fortune;
  /** Era words the last passage should not have used (R07-T002). */
  taboos?: TabooHit[];
  /** Rough input budget in characters (≈ tokens for Chinese). */
  budgetChars?: number;
}

/** Recent turns as chat history, newest kept first until the budget runs out (minimum three); `ids` are the turns it kept. */
function historyWindow(history: StoryNode[], budget: number, settings: PromptOptions): { messages: ChatMessage[]; ids: Set<string> } {
  const pairs: ChatMessage[][] = [];
  const ids = new Set<string>();
  let used = 0;
  const turns = history.filter((n) => n.kind !== "edit");
  for (let i = turns.length - 1; i >= 0; i--) {
    const n = turns[i];
    const action = n.kind === "opening" ? "（开场）" : n.actionMode && n.actionText != null ? actionLine(n.actionMode, n.actionText, settings) : "（继续）";
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
function cardsBlock(lines: string[]): string {
  return lines.length ? `\n【相关设定】\n${lines.join("\n")}` : "";
}

/** People named in the recent text (by name or alias). */
function presentPeople(state: WorldState, recent: string): Set<string> {
  return new Set(state.people.filter((p) => [p.name, ...p.aliases].some((n) => n && recent.includes(n))).map((p) => p.id));
}

/** One layer of a turn's context, for the developer context viewer (PLAN §5.3). */
export interface ContextLayer {
  key: "rules" | "premise" | "era" | "recap" | "history" | "state" | "essentials" | "world" | "cards" | "recall" | "directive" | "modes" | "notes" | "action" | "spec" | "reference";
  label: string;
  chars: number;
  /** Why it is in, and what was left out. */
  note: string;
  content: string;
}

export interface TurnContext {
  reference?: ReferenceContext;
  messages: ChatMessage[];
  layers: ContextLayer[];
  /** Characters sent, and the target they were fitted to. */
  chars: number;
  budgetChars: number;
}

const DEFAULT_BUDGET_CHARS = 12000;

/**
 * The turn request, layer by layer (PLAN §5.3, R04-T004). Rules, premise, the
 * current state with people, 要点, the 方针 and the action are never trimmed;
 * the era card, cards and recap have their own limits; the raw-text window
 * takes what is left (at least three turns). Over the hard cap (7/6 of the
 * target) the recap shrinks to gists, then cards go, least recently mentioned first.
 */
export function buildTurnContext(input: TurnPromptInput): TurnContext {
  const parts = systemParts(input, snapshotPanel(input.state), input.state);
  const recent = recentText(input);
  const present = presentPeople(input.state, recent);
  const state = renderState(input.state, input.era, present, input.settings);
  const essentials = essentialsBlock(input.settings, input.pins);
  // No lookahead, including skips: the timeline is background, not a script.
  const world = isFree(input.settings) ? "" : worldBlock(input.state, 0);
  const directive = input.settings.directive ? `\n【叙事方针】${input.settings.directive}` : "";
  const modes = `${scriptBlock(input.state.script, input.settings)}${challengeBlock(input.state)}`;
  // Luck as the world has it (R11-T008): 有影响, 只作参考 (the default) or 关; era-word reminders can be turned off too.
  const luckMode = fortuneMode(input.settings.fortune);
  const luck = fortuneNote(input.fortune, luckMode);
  const taboo = isFree(input.settings) || input.settings.tabooHints === false ? "" : tabooReminder(input.taboos ?? []);
  const notes = `${input.notes?.length ? `\n【上回合的实际结果，请在叙述中自然体现】\n- ${input.notes.join("\n- ")}` : ""}${taboo}${luck}`;
  const director = input.directorNote ? `\n【幕后要求，照做但不要在正文中提及】${input.directorNote}` : "";
  const hint = input.rewriteHint ? `\n【重写要求】${input.rewriteHint}` : "";
  const action = `\n\n${actionLine(input.mode, input.text, input.settings)}${director}${hint}\n\n（写完正文后，别忘了输出 <record> 记录块。）`;
  const target = input.budgetChars ?? DEFAULT_BUDGET_CHARS;
  const hardCap = Math.round((target * 7) / 6);
  const chapters = input.chapters ?? [];
  // What the player wrote this turn also finds cards and old sentences it describes without the exact name.
  const query = input.mode === "continue" || input.mode === "skip" ? "" : [input.text, input.directorNote ?? ""].join("\n");
  const allCards = activeCardLines(input.state, recent, undefined, query);
  let cardLines = allCards;
  const fixed = parts.rules.length + parts.premise.length + parts.era.length + parts.spec.length + state.length + essentials.length + world.length + directive.length + modes.length + notes.length + action.length;
  // Turns that left the window, numbered from the opening (0), for 【相关旧事】.
  const story = (input.allTurns ?? input.history).filter((n) => n.kind !== "edit");
  const older = (ids: Set<string>) => story.map((node, turn) => ({ node, turn })).filter(({ node }) => !ids.has(node.id));
  // First pass reserves room for the recap and recall; the second gives the window whatever they left.
  const reserve = (chapters.length ? RECAP_BUDGET : 0) + (story.length > 3 ? RECALL_BUDGET : 0);
  let window = historyWindow(input.history, target - fixed - cardsBlock(cardLines).length - reserve, input.settings);
  let recap = recapBlock(chapters, (id) => window.ids.has(id));
  let recall = recallBlock(input.state, recent, older(window.ids), RECALL_BUDGET, query);
  if (reserve) {
    window = historyWindow(input.history, target - fixed - cardsBlock(cardLines).length - recap.length - recall.length, input.settings);
    recap = recapBlock(chapters, (id) => window.ids.has(id));
    recall = recallBlock(input.state, recent, older(window.ids), RECALL_BUDGET, query);
  }
  const historyChars = window.messages.reduce((n, m) => n + m.content.length, 0);
  const total = () => fixed + cardsBlock(cardLines).length + recap.length + recall.length + historyChars;
  // Over the hard cap: recall goes first, then the recap shrinks to gists, then cards.
  const recallDropped = total() > hardCap && !!recall;
  if (recallDropped) recall = "";
  let gistsOnly = false;
  if (total() > hardCap && recap) {
    recap = recapBlock(chapters, (id) => window.ids.has(id), RECAP_BUDGET, 0);
    gistsOnly = true;
  }
  while (total() > hardCap && cardLines.length) cardLines = cardLines.slice(0, -1);

  const cards = cardsBlock(cardLines);
  // References only use spare room, after the current facts and recent story.
  const usedReference = fitReference(input.reference, Math.max(0, Math.min(Math.floor(target / 4), target - total())));
  const reference = referenceBlock(usedReference);
  const system = joinSystem(parts, recap);
  const user = `${state}${essentials}${world}${cards}${recall}${reference}${directive}${modes}${notes}${action}`;
  const messages: ChatMessage[] = [{ role: "system", content: system }, ...window.messages, { role: "user", content: user }];

  const turnsIn = input.history.filter((n) => n.kind !== "edit" && window.ids.has(n.id)).length;
  const turnsOut = input.history.filter((n) => n.kind !== "edit").length - turnsIn;
  const recapped = chapters.map((c, i) => ({ c, n: i + 1 })).filter(({ c }) => !window.ids.has(c.firstNodeId));
  const globalLines = input.settings.essentials.split(/\n+/).filter((l) => l.trim()).length;
  const layers: ContextLayer[] = ([
    { key: "rules", label: "叙事规则", content: parts.rules, note: "每回合都有，不裁剪" },
    { key: "premise", label: "故事设定与额外规则", content: parts.premise, note: parts.premise ? "玩家写的，每回合都有" : "没写" },
    { key: "era", label: isFree(input.settings) ? "世界卡" : "时代卡", content: parts.era, note: "以故事设定为准；异世界不使用历史卡组" },
    {
      key: "recap", label: "前情提要", content: recap,
      note: recapped.length ? `第 ${recapped[0].n}～${recapped[recapped.length - 1].n} 章已移出原文范围${gistsOnly ? "；超出上限，只留梗概" : "；最近三章给全文"}` : chapters.length ? "章节都还在原文范围内" : "还没有章节",
    },
    {
      key: "history", label: "最近原文", content: window.messages.map((m) => `${m.role === "user" ? "▶" : ""}${m.content}`).join("\n\n"),
      note: `最近 ${turnsIn} 段（预算剩下的部分，至少 3 段）${turnsOut ? `；更早的 ${turnsOut}${input.history.length >= 40 ? " 段以上" : " 段"}不在原文里` : ""}`,
    },
    { key: "state", label: "当前状态与人物", content: state, note: `每回合都有，不裁剪；人物 ${input.state.people.length} 人，最近提到的 ${present.size} 人带备注` },
    { key: "world", label: "天下大事与历史偏离", content: world, note: isFree(input.settings) ? "异世界不用历史年表与偏离" : world ? "只带近来已到时间的大事和已经改变的历史，不预告未来；不裁剪" : "近来没有大事或历史偏离" },
    { key: "essentials", label: "要点", content: essentials, note: essentials ? `全局 ${globalLines} 条，剧情里记下 ${input.pins?.length ?? 0} 条；不裁剪` : "没有要点" },
    {
      key: "cards", label: "相关设定", content: cards,
      note: allCards.length ? `最近三回合或本次行动提到的，所在地优先${cardLines.length < allCards.length ? `；超出上限，去掉了 ${allCards.length - cardLines.length} 张` : ""}` : "最近没有提到设定集里的东西",
    },
    { key: "recall", label: "相关旧事", content: recall, note: recall ? "原文窗口以外、提到眼下这些人和物的句子（最早一次和最近一次）" : recallDropped ? "超出上限，这回合没放" : "眼下提到的人和物在更早的剧情里没出现过，或都还在原文里" },
    { key: "directive", label: "叙事方针", content: directive, note: directive ? "玩家写的，每回合都有" : "没写" },
    // Listed only in worlds that have them, so ordinary worlds keep their layers.
    ...(modes ? [{ key: "modes", label: "剧本与挑战", content: modes, note: "玩家定的剧本和挑战，每回合都有，不裁剪" }] : []),
    ...(input.reference ? [{ key: "reference", label: "参考书籍", content: reference, note: "只用预算余量，最多四分之一；原文和整理均限所选章节" }] : []),
    { key: "notes", label: "程序提示", content: notes, note: notes ? `${input.notes?.length ? "上回合程序修正过的变化；" : ""}${luck ? `本回合运势：${input.fortune}（${luckMode === "on" ? "有影响" : "只作参考"}）` : ""}` : "没有" },
    { key: "action", label: "玩家行动", content: action, note: "本回合的行动与幕后要求" },
    { key: "spec", label: "输出格式", content: parts.spec, note: "每回合都有，不裁剪" },
  ] as Omit<ContextLayer, "chars">[]).map((l) => ({ ...l, chars: l.content.length }));
  return { messages, layers, reference: usedReference, chars: messages.reduce((n, m) => n + m.content.length, 0), budgetChars: target };
}

export function turnMessages(input: TurnPromptInput): ChatMessage[] {
  return buildTurnContext(input).messages;
}

// ---------- opening ----------

export type Arrival = "魂穿" | "身穿" | "投胎" | "不穿越";

export interface OpeningInput extends StoryContext {
  reference?: ReferenceContext;
  protagonist: { name: string; gender: string; age: number | null; identity: string };
  arrival: Arrival;
  origin: string;
  /** What the player wants the first scene to show (may be empty). */
  hint: string;
  /** Play modes (R14): the script opens with its first beat; the challenge is put before the protagonist. */
  script?: Script | null;
  challenge?: Challenge | null;
}

function protagonistLine(input: OpeningInput): string {
  const p = input.protagonist;
  const world = isFree(input.settings) ? "世界" : "时代";
  const how = {
    魂穿: `意识进入${p.name}的身体，保留原主记忆`,
    身穿: `连人带衣物穿越而来，没有这个${world}的本地身份`,
    投胎: `带着前世记忆重生为${p.name}`,
    不穿越: "",
  }[input.arrival];
  return `主角：${p.name || "（由你取一个符合设定的名字）"}，${p.gender}${p.age != null ? `，${p.age}岁` : ""}。${p.identity}
${input.arrival === "不穿越" ? `主角就是这个${world}土生土长的人，没有穿越。` : `穿越方式：${input.arrival}——${how}。穿越前，主角是${input.origin || "一个普通的现代人"}。`}`;
}

/** With an era pack, the opening date and currency are already known. */
function packLine(era: EraContext, settings: PromptOptions): string {
  if (!era.packId || isFree(settings)) return "";
  const date = era.clock.date && !elapsedClock(settings) ? `开局日期是${formatDate(era.clock.date, era.clock.rules)}，除非【故事设定】另有说明，就用这个日期；` : "";
  return `\n本时代资料已定：${date}货币为${era.currency.units.map((u) => u.name).join("、")}，currency 可以省略。`;
}

export function openingMessages(input: OpeningInput): ChatMessage[] {
  const challenge = challengeBlock({ challenge: input.challenge, time: { start: "", elapsedMinutes: 0 } });
  const modes = `${scriptBlock(input.script, input.settings)}${challenge}${challenge ? "\n开场就把这场挑战摆到主角面前：目标、期限和眼下最大的难处，要让玩家一读就清楚。" : ""}`;
  return [
    { role: "system", content: systemPrompt(input, { script: input.script, challenge: input.challenge }) },
    {
      role: "user",
      content: `请写这部小说的开场。
${protagonistLine(input)}
${input.hint ? `玩家希望开场：${input.hint}\n` : ""}${modes ? `${modes.slice(1)}\n` : ""}从符合玩家设定的具体场景写起，${aiPilot(input.settings) ? "写到一个有意思的地方停下" : "写到需要玩家决定为止"}。
${openingExtra(input.settings)}${packLine(input.era, input.settings)}${referenceBlock(input.reference, 3000)}`,
    },
  ];
}

/** The player wrote the opening themselves: only extract the starting state. */
export function openingExtractMessages(input: OpeningInput & { text: string }): ChatMessage[] {
  return [
    {
      role: "system",
      content: `你是这部互动小说的记录员。玩家亲手写了开场。根据【故事设定】【主角】和【开场正文】，只输出一个 JSON 对象，记录故事开始时的状态。字段如下（没有的省略）：
${recordFields(input.settings)}
${openingExtra(input.settings)}${packLine(input.era, input.settings)}
time 写 "0"。只输出 JSON，不要输出其他文字。`,
    },
    {
      role: "user",
      content: `【故事设定】\n${input.settings.premise || "（未写）"}\n\n【主角】\n${protagonistLine(input)}${heroPanelBlock(input.settings, input.settings.heroPanel)}\n\n【开场正文】\n${input.text}`,
    },
  ];
}

// ---------- extraction fallback (补记) ----------

export function extractMessages(input: { era: EraContext; state: WorldState; action: string; narrative: string; settings?: PromptOptions }): ChatMessage[] {
  return [
    {
      role: "system",
      content: `你是互动小说的记录员。根据【当前】状态和【本回合正文】，只输出一个 JSON 对象，描述本回合的变化。字段与含义如下（没有变化的字段省略；time、log、choices 必须有）：
${recordFields(input.settings)}
只输出 JSON，不要输出其他文字。`,
    },
    { role: "user", content: `${renderState(input.state, input.era, undefined, input.settings)}${heroPanelBlock(input.settings ?? {}, snapshotPanel(input.state))}\n\n【玩家行动】${input.action}\n\n【本回合正文】\n${input.narrative}` },
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
  mode?: "history" | "free";
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
  const free = isFree(current);
  const filled = Object.entries(current).filter(([, v]) => v !== undefined && v !== null && String(v).trim()).map(([k, v]) => `${k}: ${v}`).join("\n");
  return [
    {
      role: "system",
      content: `你帮玩家构思一部${free ? "" : "历史"}互动小说的开局。玩家给出一个想法和已经填好的字段，你补全其余字段，让整体协调。已经填好的字段原样保留，不要改写。只输出一个 JSON 对象：
{"title":"故事标题（十字以内）",
 "premise":"故事设定：${free ? "世界、地点、日常与当前处境" : "时代、地点、时局与当前处境"}，150～300字，用第二人称或客观叙述",
 "name":"主角名字，符合${free ? "世界设定" : "时代"}",
 "gender":"男 或 女",
 "age":年龄整数,
 "identity":"主角的身份与处境，以“你是”开头，80～150字",
 "arrival":"魂穿 / 身穿 / 投胎 / 不穿越",
 "origin":"穿越前是谁（不穿越则为空字符串）",
 "hint":"开场第一幕的场景，一句话",
 "essentials":"需要一直记住的要点，每行一条，最多五条"}
性别与身份要一致（如公主、女王是女，皇子、国王是男）。只输出 JSON。`,
    },
    { role: "user", content: `玩家的想法：${idea || "（没有写，请你自由发挥一个有意思的开局）"}\n\n已经填好的字段：\n${filled || "（无）"}` },
  ];
}
