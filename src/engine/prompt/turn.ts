// Prompt v1 for opening, turns, continue/direct and the extraction fallback.
// Changes are logged in ./CHANGES.md together with eval results.
import type { EraDraft } from "../../content/eras";
import type { ChatMessage } from "../llm/chat";
import { clockParts } from "../calendar/clock";
import { formatMoney } from "../money";
import type { ActionMode, StoryNode, WorldSettings, WorldState } from "../types";

export const PROMPT_VERSION = "turn-2";

const LENGTH: Record<WorldSettings["length"], string> = { 短: "约两百字", 中: "约四百字", 长: "约八百字" };

const INTENSITY_TEXT = {
  violence: { 含蓄: "暴力与伤亡点到为止，不写细节", 写实: "暴力与伤亡如实描写，但不猎奇、不渲染血腥", 浓烈: "暴力与伤亡可以直接、具体地描写" },
  romance: { 含蓄: "感情与亲密情节点到为止", 写实: "感情与亲密情节自然描写，亲密场面含蓄带过", 浓烈: "感情与亲密情节可以写得浓烈直接" },
  darkness: { 含蓄: "少写压抑、绝望的内容，基调偏温和", 写实: "如实呈现时代的苦难与阴暗面", 浓烈: "可以充分展现残酷、绝望与人性阴暗" },
} as const;

export const CLICHES = ["指节泛白", "嘴角勾起", "一抹弧度", "眼中闪过一丝", "空气仿佛凝固", "五味杂陈", "心中一凛", "不由得", "仿佛", "一丝不易察觉"];

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

function rules(era: EraDraft, settings: WorldSettings): string {
  const i = settings.intensity;
  return `你是一部历史穿越互动小说的叙事者，玩家扮演穿越到古代的主角。
【写作要求】
- 用第二人称“你”。先写画面、声音、气味和动作，少用总结句；对话简短、口吻符合人物身份。叙述用${settings.style === "半文半白" ? "半文半白" : "白话"}，人物对白带时代口吻。每回合${LENGTH[settings.length]}。
- 只写到玩家需要做决定为止：不替玩家说话，不替玩家做行动以外的决定，不擅自把玩家没说要做完的事做完。玩家说“先试一下”“先问问”，就只写试一下、问一下的结果。
- 玩家的行动可能失败。行动有难度或风险时，按情理决定成败，失败也要写出后果。
- 其他人物有自己的目的、脾气和处境，不围着主角转；态度变化要有缘由。
- 涉及钱和物品时，只能使用【当前】中列出的数量，正文写清具体数目；钱不够就买不成、付不起。
- 拿不准的历史细节写得模糊些，不编造确切数字、人名和官职。
- 不要使用这些时代错误：${era.taboos.join("；")}。
- 避免套话和重复上一回合的开头与句式。不要用：${CLICHES.slice(0, 6).join("、")}。
- 内容尺度：${INTENSITY_TEXT.violence[i.violence]}；${INTENSITY_TEXT.romance[i.romance]}；${INTENSITY_TEXT.darkness[i.darkness]}。
- 每回合结尾留一个自然的行动点。${settings.choiceCount > 0 ? `在记录里给出 ${settings.choiceCount} 个简短、彼此不同的建议行动（各不超过二十字）` : "记录里的 choices 写空数组 []"}。

${era.promptExcerpt}

${RECORD_SPEC}`;
}

export function renderState(state: WorldState, era: EraDraft): string {
  const me = state.protagonist;
  const c = clockParts(era.startHour, state.time.elapsedMinutes);
  const place = state.places.find((p) => p.id === state.placeId)?.name ?? "（未记录）";
  const items = me.items.map((i) => `${i.name}×${i.quantity}${i.unit}${i.place ? `（放在${i.place}）` : ""}`).join("、") || "无";
  const statuses = me.statuses.map((s) => `${s.name}${s.detail ? `：${s.detail}` : ""}`).join("；") || "无";
  const people = state.people
    .map((p) => `${p.name}${p.aliases.length ? `（又称${p.aliases.join("、")}）` : ""}：${p.role || "身份不明"}，对你${p.attitude}${p.alive ? "" : "，已死"}${p.notes ? `；${p.notes}` : ""}`)
    .join("\n") || "无";
  const goals = state.goals.filter((g) => g.status === "进行中").map((g) => `${g.name}${g.progress ? `（${g.progress}）` : ""}`).join("；") || "无";
  const level = (n: number, words: string[]) => words[Math.min(words.length - 1, Math.floor((100 - n) / (100 / words.length)))];
  return `【当前】${era.startLabel} 第 ${c.day} 日 ${c.shichen}时（约 ${String(c.hour).padStart(2, "0")}:${String(c.minute).padStart(2, "0")}）· ${place}
主角：${me.name}，${me.age ?? "?"}岁，${me.identity}${me.origin ? `（穿越前是${me.origin}）` : ""}
可用的钱：${formatMoney(me.stats.money, era.currency)}（共 ${me.stats.money} 文）${me.stats.debt ? `；欠债 ${formatMoney(me.stats.debt, era.currency)}` : ""}
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
  direct: (t) => `【玩家没有行动，只给叙事者一个幕后要求，照做但不要在正文中提及】${t}\n主角只做等待、观察这类被动动作，由他人和环境推动剧情。`,
  continue: () => "【玩家选择继续】主角只做等待、观察这类被动动作，由他人和环境推动剧情，小幅推进时间。",
};

export interface TurnPromptInput {
  era: EraDraft;
  settings: WorldSettings;
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
  /** Rough input budget in characters (≈ tokens for Chinese). */
  budgetChars?: number;
}

/** Recent turns as chat history, newest kept first until the budget runs out (minimum three). */
function historyMessages(history: StoryNode[], budget: number): ChatMessage[] {
  const pairs: ChatMessage[][] = [];
  let used = 0;
  const turns = history.filter((n) => n.kind !== "edit");
  for (let i = turns.length - 1; i >= 0; i--) {
    const n = turns[i];
    const action = n.kind === "opening" ? "（开场）" : n.actionMode && n.actionText != null ? ACTION_TEXT[n.actionMode](n.actionText) : "（继续）";
    const cost = action.length + n.narrative.length;
    if (pairs.length >= 3 && used + cost > budget) break;
    used += cost;
    pairs.unshift([{ role: "user", content: action }, { role: "assistant", content: n.narrative }]);
  }
  return pairs.flat();
}

export function turnMessages(input: TurnPromptInput): ChatMessage[] {
  const system = rules(input.era, input.settings);
  const directive = input.settings.directive ? `\n【叙事方针】${input.settings.directive}` : "";
  const notes = input.notes?.length ? `\n【上回合的实际结果，请在叙述中自然体现】\n- ${input.notes.join("\n- ")}` : "";
  const director = input.directorNote ? `\n【幕后要求，照做但不要在正文中提及】${input.directorNote}` : "";
  const hint = input.rewriteHint ? `\n【重写要求】${input.rewriteHint}` : "";
  const budget = (input.budgetChars ?? 12000) - system.length - 1500;
  return [
    { role: "system", content: system },
    ...historyMessages(input.history, budget),
    {
      role: "user",
      content: `${renderState(input.state, input.era)}${directive}${notes}\n\n${ACTION_TEXT[input.mode](input.text)}${director}${hint}`,
    },
  ];
}

// ---------- opening ----------

export interface OpeningInput {
  era: EraDraft;
  settings: WorldSettings;
  protagonist: { name: string; gender: string; age: number; identity: string; situation: string; origin: string };
  transmigration: "魂穿" | "身穿" | "投胎";
}

export function openingMessages(input: OpeningInput): ChatMessage[] {
  const p = input.protagonist;
  const how = {
    魂穿: `你在现代的意识醒来时，已身处${p.name}的身体里，原主的记忆会一段段涌上来`,
    身穿: "你连人带衣物穿越而来，没有这个时代的户籍与身份，周围人只当你是来历不明的外乡人",
    投胎: `你带着前世记忆重生为${p.name}，此刻正是记忆完全苏醒的一天`,
  }[input.transmigration];
  return [
    { role: "system", content: rules(input.era, input.settings) },
    {
      role: "user",
      content: `请写这部小说的开场。
主角：${p.name}，${p.gender}，${p.age}岁，${p.identity}。处境：${p.situation}
穿越方式：${input.transmigration}——${how}。穿越前，主角是${p.origin}。
开场要求：
1. 先写醒来时的感官（冷暖、气味、声音、身体的不适），不要先解释。
2. 第二段开头单独一行写出当下的时间，格式如“${input.era.startLabel}，第一日，辰时”。
3. 写原主的记忆或眼前的线索，交代姓名、身份、处境${input.transmigration === "身穿" ? "（身穿则写主角意识到自己身处何时何地）" : ""}。
4. 以一个迫在眉睫的麻烦收尾，留给玩家决定。
记录块额外要求：goals 里用 op "add" 写出第一个目标；people 里写出开场出现的人物；items 写出主角身上的随身物品（数量用 delta）；place 写出当前地点；不要写 money（初始钱数已经由程序设定为 ${formatMoney(input.era.startMoney, input.era.currency)}，正文提到钱数时与此一致）。`,
    },
  ];
}

// ---------- extraction fallback (补记) ----------

export function extractMessages(input: { era: EraDraft; state: WorldState; action: string; narrative: string }): ChatMessage[] {
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
