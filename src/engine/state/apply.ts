// Applies a model's turn record to the world state, change by change
// (D104, D113). Invalid changes are corrected or dropped, never fatal; the
// player sees what actually happened as chips, and the next prompt gets notes.
import { newYearsBetween, nowOf, type GameClock } from "../calendar/clock";
import { coerceDate, formatDate } from "../calendar/date";
import { parseDurationMinutes } from "../calendar/duration";
import { currencyIssues, formatMoney, parseMoney, type Currency } from "../money";
import { newId } from "../db/repo";
import type { Fortune } from "../fortune";
import type { ActionMode, Attitude, Card, CardKind, Difficulty, Goal, Person, TimelineEvent, WorldState } from "../types";
import { eventsBetween, placeEvent } from "../timeline";

export type RiskResult = "成" | "败" | "半成";
const RISK_TEXT: Record<RiskResult, string> = { 成: "成了", 败: "没成", 半成: "成了一半" };
import { matchName } from "./names";

/** The normalised record every output format is converted into. */
export interface TurnRecord {
  time?: string | number | null;
  place?: string | null;
  money?: number | string | null;
  stats?: { health?: number; energy?: number; fame?: number } | null;
  setStats?: { money?: number; health?: number; energy?: number; fame?: number };
  items?: { name: string; delta: number | string; place?: string | null; unit?: string }[] | null;
  /** By name from the model; panel edits pass the id (and may rename, replace aliases or remove). */
  people?: { id?: string; op?: "remove"; name: string; role?: string; attitude?: string; note?: string; origin?: string; alive?: boolean; aliases?: string[] }[] | null;
  status?: { op: string; name: string; detail?: string }[] | null;
  goals?: { op: string; name: string; detail?: string; kind?: string; id?: string }[] | null;
  log?: string | null;
  /** The story changed what the history books say (R05-T004). */
  deviation?: string | null;
  /** Timeline edits from the 记事 page or the organizer: add by written date, remove by id. */
  timeline?: { op: "add" | "remove"; id?: string; date?: string; title?: string; kind?: string; source?: TimelineEvent["source"] }[] | null;
  /** "过些日子" only: what the protagonist heard while time passed (R05-T001). */
  report?: { world?: string; local?: string; people?: string } | null;
  /** The risky part of the action and how it went, when the fortune mattered (R05-T002). */
  risk?: { what: string; result?: RiskResult } | null;
  choices?: string[] | null;
  /** Opening only: the start date (an object for coerceDate, or words), hour of day and the era's currency units. */
  date?: string | Record<string, unknown> | null;
  hour?: number | null;
  currency?: { name: string; value: number }[] | null;
  /** Panel edits and the setup assistant: cards of the 设定集 (D121). */
  cards?: CardPatch[] | null;
  /** Panel edits: place cards. */
  places?: PlacePatch[] | null;
  /** Panel edits: the world's rules (D121). date is the start date as {era, year, month, day, ceYear?}; null clears it. */
  rules?: { currency?: { name: string; value: number }[]; lunar?: boolean; date?: Record<string, unknown> | null } | null;
}

/** update and remove find the card by id, or by kind and name. */
export interface CardPatch {
  op: "add" | "update" | "remove";
  id?: string;
  kind?: CardKind;
  name?: string;
  keys?: string[];
  content?: string;
  source?: Card["source"];
}

export interface PlacePatch {
  op: "add" | "update" | "remove";
  id?: string;
  name?: string;
  aliases?: string[];
  description?: string;
  source?: Card["source"];
}

const KINDS: CardKind[] = ["时代", "势力", "物品", "设定"];
/** Trimmed, unique, without the name itself. */
const cleanNames = (names: string[] | undefined, name: string) => [...new Set((names ?? []).map((n) => n.trim()).filter((n) => n && n !== name))];

export type ChipTone = "gain" | "loss" | "info" | "warn";
export interface Chip {
  text: string;
  tone: ChipTone;
}

export interface ApplyResult {
  state: WorldState;
  chips: Chip[];
  /** Told to the model at the start of the next turn (corrections). */
  notes: string[];
  /** Developer log: what was dropped or corrected, and why. */
  log: string[];
  minutes: number;
}

const DEFAULT_MINUTES: Record<ActionMode, number> = { do: 15, say: 5, write: 30, continue: 30, direct: 30, skip: 1440 };
const ATTITUDES: Attitude[] = ["仇视", "敌意", "冷淡", "一般", "友善", "亲近", "生死之交"];
const STAT_SOFT_CAP = 40;

function describeMinutes(minutes: number): string {
  if (minutes >= 525600 * 0.95) return `过了 ${Math.round(minutes / 525600)} 年`;
  if (minutes >= 43200 * 0.95) return `过了 ${Math.round(minutes / 43200)} 个月`;
  if (minutes >= 1440) return `过了 ${Math.round(minutes / 1440)} 天`;
  if (minutes >= 120) return `过了 ${Math.round(minutes / 120)} 个时辰`;
  if (minutes === 60) return "过了半个时辰";
  if (minutes >= 15) return `过了 ${Math.round(minutes / 15)} 刻`;
  return "片刻";
}

/** Coins and units of money as an item name: "铜钱", "开元通宝", "三百文", "碎银". */
function isCurrency(name: string, currency: Currency): boolean {
  const n = name.trim();
  if (/通宝|^铜钱$|^钱$|^碎银|^银两$|^铜板$/.test(n)) return true;
  return currency.units.some((u) => u.name && (n === u.name || new RegExp(`^[\\d零〇一二两三四五六七八九十百千万]+${u.name}$`).test(n)));
}

function attitudeOf(text: string | undefined): Attitude | null {
  if (!text) return null;
  return ATTITUDES.find((a) => text.includes(a)) ?? null;
}

const clamp = (n: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, n));

/** New notes from the story; the first notes this person had stay as their 来历. */
function renote(person: Person, note: string): void {
  const next = note.trim();
  if (next === person.notes) return;
  // An empty note clears the latest news; the 来历 stays.
  if (next && !person.origin && person.notes.trim()) person.origin = person.notes.trim();
  person.notes = next;
}

export function applyRecord(
  before: WorldState,
  record: TurnRecord | null,
  ctx: { mode: ActionMode; difficulty: Difficulty; currency: Currency; clock?: GameClock; fortune?: Fortune },
  opts?: { advanceTime?: boolean },
): ApplyResult {
  const s: WorldState = structuredClone(before);
  const chips: Chip[] = [];
  const notes: string[] = [];
  const log: string[] = [];
  const me = s.protagonist;
  const now = () => s.time.elapsedMinutes;
  const dismiss = (name: string) => { s.dismissed = [...new Set([...(s.dismissed ?? []), name])]; };

  // Edits keep the current time; turns fall back to the action's default.
  const parsed = parseDurationMinutes(record?.time ?? null);
  const minutes = opts?.advanceTime === false ? 0 : parsed ?? DEFAULT_MINUTES[ctx.mode];
  if (parsed === null && record?.time != null) log.push(`时间“${record.time}”无法识别，按 ${minutes} 分钟计`);
  s.time.elapsedMinutes += minutes;
  if (minutes >= 15) chips.push({ text: describeMinutes(minutes), tone: "info" });
  // Ages count the Chinese way (虚岁): everyone grows a year at New Year.
  const newYears = ctx.clock ? newYearsBetween(ctx.clock, before.time.elapsedMinutes, s.time.elapsedMinutes) : 0;
  // Great events whose time has come (R05-T004): fixed ones happen; changeable ones are what the books say.
  for (const e of eventsBetween(s.timeline, before.time.elapsedMinutes, s.time.elapsedMinutes)) {
    chips.push({ text: e.kind === "固定" ? `📜 ${e.title}` : `📜 按史书，此时应有：${e.title}`, tone: "info" });
  }
  if (newYears > 0) {
    if (me.age != null) me.age += newYears;
    chips.push({ text: `${newYears === 1 ? "过年了" : `过了 ${newYears} 个年`}${me.age != null ? `，${me.age} 岁` : ""}`, tone: "info" });
  }
  if (!record) return { state: s, chips, notes, log: [...log, "本回合没有记录"], minutes };

  // History changed by the story is kept, dated, for every later turn (R05-T004).
  if (record.deviation?.trim()) {
    const when = ctx.clock?.date ? nowOf(ctx.clock, s.time.elapsedMinutes) : null;
    const text = record.deviation.trim();
    s.deviations = [...(s.deviations ?? []), `${when?.date ? `${formatDate(when.date, ctx.clock!.rules)}：` : ""}${text}`];
    chips.push({ text: `⚠ 历史偏离：${text}`, tone: "warn" });
  }
  for (const raw of record.timeline ?? []) {
    if (raw.op === "remove") {
      const i = (s.timeline ?? []).findIndex((e) => e.id === raw.id);
      if (i >= 0) s.timeline!.splice(i, 1);
      continue;
    }
    if (!raw.date?.trim() || !raw.title?.trim()) { log.push(`大事缺少日期或内容：${JSON.stringify(raw)}`); continue; }
    if (!ctx.clock) { log.push("没有游戏日期，大事无法放进年表"); continue; }
    const placed = placeEvent(ctx.clock, { date: raw.date, title: raw.title, kind: raw.kind });
    if (placed.atMinute === null) log.push(`大事“${placed.title}”的日期无法换算，只记录不提醒`);
    if ((s.timeline ?? []).some((e) => e.title === placed.title)) continue;
    s.timeline = [...(s.timeline ?? []), { id: newId(), ...placed, source: raw.source ?? "玩家" }].sort((a, b) => (a.atMinute ?? Infinity) - (b.atMinute ?? Infinity));
  }

  // The fortune behind a risky action, shown so the outcome is not a black box (PLAN §5.5).
  if (record.risk?.what && ctx.fortune) {
    const result = record.risk.result;
    chips.push({ text: `🎲 ${ctx.fortune} · ${record.risk.what}${result ? ` · ${RISK_TEXT[result]}` : ""}`, tone: result === "败" ? "loss" : result === "成" ? "gain" : "info" });
  }

  // Place
  if (record.place && typeof record.place === "string") {
    const place = matchName(s.places, record.place) ?? (() => {
      const p = { id: newId(), name: record.place!, description: "" };
      s.places.push(p);
      return p;
    })();
    if (s.placeId !== place.id) {
      s.placeId = place.id;
      chips.push({ text: `到 ${place.name}`, tone: "info" });
    }
  }

  // Money first, so a failed purchase can also cancel the goods it would have bought.
  let purchaseFailed = false;
  if (record.money != null) {
    const delta = parseMoney(record.money, ctx.currency);
    if (delta === null) log.push(`钱数“${record.money}”无法识别，已忽略`);
    else if (delta !== 0) {
      const next = me.stats.money + delta;
      if (next >= 0) {
        me.stats.money = next;
        chips.push({ text: `钱 ${delta > 0 ? "+" : "−"}${formatMoney(Math.abs(delta), ctx.currency)}`, tone: delta > 0 ? "gain" : "loss" });
      } else if (ctx.difficulty === "宽松") {
        const owed = -next;
        me.stats.money = 0;
        me.stats.debt += owed;
        chips.push({ text: `钱不够，赊欠 ${formatMoney(owed, ctx.currency)}`, tone: "warn" });
        notes.push(`上回合钱不够，主角赊欠了 ${formatMoney(owed, ctx.currency)}，现在身上没有钱。`);
      } else {
        purchaseFailed = true;
        chips.push({ text: "钱不够，这笔没付成", tone: "warn" });
        notes.push(`上回合主角只有 ${formatMoney(me.stats.money, ctx.currency)}，付不起 ${formatMoney(-delta, ctx.currency)}，这笔交易没有成交；请在叙述中自然交代。`);
        log.push(`钱 ${delta} 超出余额 ${me.stats.money}，交易取消`);
      }
    }
  }

  // Core stats with a per-turn soft cap.
  const statNames = { health: "健康", energy: "精力", fame: "名望" } as const;
  for (const key of Object.keys(statNames) as (keyof typeof statNames)[]) {
    const raw = record.stats?.[key];
    if (typeof raw !== "number" || !Number.isFinite(raw) || raw === 0) continue;
    const delta = Math.max(-STAT_SOFT_CAP, Math.min(STAT_SOFT_CAP, Math.round(raw)));
    if (delta !== raw) log.push(`${statNames[key]}变化 ${raw} 超出单回合上限，按 ${delta} 计`);
    const before = me.stats[key];
    me.stats[key] = clamp(before + delta);
    if (me.stats[key] !== before) chips.push({ text: `${statNames[key]} ${delta > 0 ? "↑" : "↓"}`, tone: delta > 0 ? "gain" : "loss" });
  }
  if (opts?.advanceTime === false && record.setStats) {
    for (const key of ["money", "health", "energy", "fame"] as const) {
      const value = record.setStats[key];
      if (value !== undefined) me.stats[key] = clamp(value, 0, key === "money" ? Infinity : 100);
    }
  }
  // Death follows the story (D123): on 标准 the first time health runs out the protagonist is 垂危,
  // the narrator is told, and only another blow kills; 残酷 kills at once; 宽松 never kills.
  const dying = me.statuses.some((x) => x.name === "垂危");
  if (me.stats.health <= 0 && opts?.advanceTime !== false) {
    if (ctx.difficulty === "宽松") {
      me.stats.health = 1;
      if (!me.statuses.some((x) => x.name === "昏迷")) me.statuses.push({ name: "昏迷", detail: "伤重昏迷", sinceMinute: now() });
      chips.push({ text: "昏迷", tone: "warn" });
    } else if (ctx.difficulty !== "残酷" && !dying) {
      me.stats.health = 1;
      me.statuses.push({ name: "垂危", detail: "伤重濒死，再受重伤就会死", sinceMinute: now() });
      chips.push({ text: "垂危", tone: "warn" });
      notes.push("主角伤重濒死、命悬一线：叙述里要写出来；在伤势好转之前再受重伤，就会死去。");
    } else {
      chips.push({ text: "你死了", tone: "warn" });
    }
  } else if (dying && me.stats.health > 30) {
    me.statuses = me.statuses.filter((x) => x.name !== "垂危");
    chips.push({ text: "垂危 好了", tone: "gain" });
  }

  // Items
  for (const raw of record.items ?? []) {
    const delta = typeof raw?.delta === "number" ? raw.delta : Number(String(raw?.delta ?? "").replace(/[^\d+-]/g, ""));
    if (!raw?.name || !Number.isFinite(delta)) { log.push(`物品记录不完整：${JSON.stringify(raw)}`); continue; }
    // Money is counted in money, not in the bag ("开元通宝×180" next to 钱 +180).
    if (isCurrency(raw.name, ctx.currency)) { log.push(`“${raw.name}”是钱，按钱记，不放进行囊`); continue; }
    if (delta > 0 && purchaseFailed) { log.push(`钱不够，未获得 ${raw.name}`); continue; }
    let item = matchName(me.items, raw.name);
    if (delta === 0 && item && raw.place !== undefined) {
      item.place = raw.place || null;
      continue;
    }
    if (delta > 0) {
      if (!item) {
        item = { name: raw.name, quantity: 0, unit: raw.unit ?? "", place: raw.place ?? null, note: "" };
        me.items.push(item);
      }
      item.quantity += delta;
      chips.push({ text: `得 ${item.name}${delta > 1 ? `×${delta}` : ""}`, tone: "gain" });
    } else if (delta < 0) {
      if (!item || item.quantity <= 0) { log.push(`没有 ${raw.name}，无法减少`); notes.push(`主角身上并没有“${raw.name}”。`); continue; }
      const used = Math.min(item.quantity, -delta);
      if (used < -delta) log.push(`${item.name} 只有 ${item.quantity}，按实际扣减`);
      item.quantity -= used;
      chips.push({ text: `失 ${item.name}${used > 1 ? `×${used}` : ""}`, tone: "loss" });
    }
  }
  me.items = me.items.filter((i) => i.quantity > 0);

  // People
  for (const raw of record.people ?? []) {
    if (raw?.id) {
      const person = s.people.find((p) => p.id === raw.id);
      if (!person) { log.push(`人物“${raw.name}”不存在，修改已忽略`); continue; }
      if (raw.op === "remove") {
        s.people.splice(s.people.indexOf(person), 1);
        dismiss(person.name);
        continue;
      }
      const renamed = !!raw.name?.trim() && raw.name.trim() !== person.name;
      const aliases = [...(raw.aliases ?? person.aliases), ...(renamed ? [person.name] : [])];
      if (renamed) person.name = raw.name.trim();
      person.aliases = cleanNames(aliases, person.name);
      if (raw.role !== undefined) person.role = raw.role.trim();
      if (raw.note !== undefined) person.notes = raw.note.trim();
      if (raw.origin !== undefined) {
        if (raw.origin.trim()) person.origin = raw.origin.trim();
        else delete person.origin;
      }
      const attitude = attitudeOf(raw.attitude);
      if (attitude) person.attitude = attitude;
      if (raw.alive !== undefined) person.alive = raw.alive;
      continue;
    }
    if (!raw?.name) continue;
    // A person first met unnamed ("货栈管事") may later be named ("刘三郎"):
    // the model lists the old label in aliases, which finds the same entry.
    const existing = matchName<Person>(s.people, raw.name)
      ?? (raw.aliases ?? []).map((a) => matchName<Person>(s.people, a)).find(Boolean);
    if (!existing) {
      const person: Person = {
        id: newId(), name: raw.name, aliases: raw.aliases ?? [], role: raw.role ?? "",
        attitude: attitudeOf(raw.attitude) ?? "一般", alive: raw.alive !== false, notes: raw.note ?? "", lastSeenMinute: now(),
        ...(raw.origin?.trim() ? { origin: raw.origin.trim() } : {}),
      };
      s.people.push(person);
      chips.push({ text: `结识 ${person.name}`, tone: "info" });
      log.push(`新人物：${person.name}`);
      continue;
    }
    if (raw.name !== existing.name) {
      const learnedName = (raw.aliases ?? []).some((a) => a === existing.name || existing.aliases.includes(a));
      if (learnedName) {
        // The old label becomes an alias; the new name is the display name.
        if (!existing.aliases.includes(existing.name)) existing.aliases.push(existing.name);
        chips.push({ text: `得知 ${existing.name} 名叫 ${raw.name}`, tone: "info" });
        existing.name = raw.name;
      } else if (!existing.aliases.includes(raw.name)) existing.aliases.push(raw.name);
    }
    if (raw.role) existing.role = raw.role;
    if (raw.note !== undefined) renote(existing, raw.note);
    // Panel edits do not count as meeting someone.
    if (opts?.advanceTime !== false) existing.lastSeenMinute = now();
    const attitude = attitudeOf(raw.attitude);
    if (attitude && attitude !== existing.attitude) {
      const up = ATTITUDES.indexOf(attitude) > ATTITUDES.indexOf(existing.attitude);
      existing.attitude = attitude;
      chips.push({ text: `${existing.name}：${attitude}`, tone: up ? "gain" : "loss" });
    }
    if (raw.alive === false && existing.alive) {
      existing.alive = false;
      chips.push({ text: `${existing.name} 身故`, tone: "warn" });
    } else if (raw.alive === true && !existing.alive) {
      if (opts?.advanceTime === false) existing.alive = true;
      else {
        log.push(`${existing.name} 已死亡，不能复活`);
        notes.push(`${existing.name} 已经去世。`);
      }
    }
  }

  // Statuses (injuries, conditions)
  for (const raw of record.status ?? []) {
    if (!raw?.name) continue;
    const removing = /^(remove|del|-|解除|痊愈|结束)/i.test(raw.op ?? "");
    const current = matchName(me.statuses, raw.name);
    if (removing) {
      if (current) {
        me.statuses = me.statuses.filter((x) => x !== current);
        chips.push({ text: `${current.name} 好了`, tone: "gain" });
      }
    } else if (current) {
      if (raw.detail) current.detail = raw.detail;
    } else {
      me.statuses.push({ name: raw.name, detail: raw.detail ?? "", sinceMinute: now() });
      chips.push({ text: raw.name, tone: "warn" });
    }
  }

  // Goals: only "add" may create; other ops must match an existing goal (or its id, from the goals page).
  // Every progress line is kept as a step so the goals page can show how it went (R05-T003).
  const step = (goal: Goal, text: string | undefined) => {
    const t = text?.trim();
    if (!t || goal.steps?.at(-1)?.text === t) return;
    goal.steps = [...(goal.steps ?? []), { minute: now(), text: t }].slice(-12);
  };
  for (const raw of record.goals ?? []) {
    if (!raw?.name && !raw?.id) continue;
    const op = (raw.op ?? "progress").toLowerCase();
    const goal = raw.id ? s.goals.find((g) => g.id === raw.id)
      : matchName(s.goals.filter((g) => g.status === "进行中" || op === "add"), raw.name);
    if (op === "add") {
      if (goal) continue;
      const kind = raw.kind === "主线" || raw.kind === "心愿" ? raw.kind : "支线";
      const added: Goal = { id: newId(), name: raw.name, kind, progress: raw.detail ?? "", status: "进行中", startedMinute: now(), steps: [] };
      step(added, raw.detail);
      s.goals.push(added);
      chips.push({ text: `${kind === "心愿" ? "新心愿" : kind === "主线" ? "主线目标" : "新目标"}：${raw.name}`, tone: "info" });
      continue;
    }
    if (!goal) { log.push(`目标“${raw.name}”不存在，${op} 已忽略`); continue; }
    if (op === "reopen") {
      if (goal.status !== "进行中") { goal.status = "进行中"; delete goal.endedMinute; step(goal, "重新开始"); }
      continue;
    }
    if (goal.status !== "进行中") continue;
    step(goal, raw.detail);
    if (raw.detail) goal.progress = raw.detail;
    const end = { done: "完成", fail: "失败", abandon: "放弃" }[op] as Goal["status"] | undefined;
    if (!end) continue;
    goal.status = end;
    goal.endedMinute = now();
    chips.push({ text: `${end === "完成" ? "完成" : end === "失败" ? "失败" : "放弃"}：${goal.name}`, tone: end === "完成" ? "gain" : end === "失败" ? "loss" : "info" });
  }

  // Rules: currency units, calendar style and the start date every later date is counted from.
  const rules = record.rules;
  if (rules?.currency) {
    const problems = currencyIssues(rules.currency);
    if (problems.length) log.push(`货币设置没有生效：${problems[0].message}`);
    else {
      const units = rules.currency.map((u) => ({ name: u.name.trim(), value: u.value }));
      const names = new Set(units.map((u) => u.name));
      const aliases = Object.fromEntries(Object.entries(s.era.currency?.aliases ?? {}).filter(([alias, target]) => names.has(target) && !names.has(alias)));
      s.era.currency = { units, ...(Object.keys(aliases).length ? { aliases } : {}) };
    }
  }
  if (rules?.lunar !== undefined) {
    s.era.calendar = { ...(s.era.calendar ?? {}), lunar: rules.lunar };
    if (s.time.date && rules.date === undefined) s.time.date = { ...s.time.date, lunar: rules.lunar };
  }
  if (rules?.date !== undefined) {
    const calendar = s.era.calendar ?? {};
    const date = rules.date ? coerceDate({ ...rules.date, lunar: calendar.lunar ?? rules.date.lunar }, calendar) : null;
    if (rules.date && !date) log.push("开局日期写得不完整，没有生效");
    else {
      s.time.date = date;
      if (date) s.time.start = formatDate(date, calendar);
    }
  }

  // 设定集: a world has one era card; other cards are found by kind and name.
  for (const raw of record.cards ?? []) {
    const kind = KINDS.includes(raw.kind as CardKind) ? raw.kind! : undefined;
    const name = raw.name?.trim();
    const card = raw.id ? s.cards.find((c) => c.id === raw.id)
      : kind === "时代" ? s.cards.find((c) => c.kind === "时代")
      : name ? (() => {
        const found = matchName(s.cards.filter((c) => c.kind !== "时代" && (!kind || c.kind === kind)).map((c) => ({ id: c.id, name: c.name, aliases: c.keys })), name);
        return found && s.cards.find((c) => c.id === found.id);
      })() : undefined;
    if (raw.op === "remove") {
      if (card) {
        s.cards.splice(s.cards.indexOf(card), 1);
        if (card.kind !== "时代") dismiss(card.name);
      } else log.push(`卡片“${name ?? raw.id}”不存在，删除已忽略`);
      continue;
    }
    if (card) {
      // Only an edit by id (or of the one era card) renames; the old name stays a key so it still brings the card in.
      const renamed = (!!raw.id || card.kind === "时代") && !!name && name !== card.name;
      const keys = [...(raw.keys ?? card.keys), ...(renamed && card.kind !== "时代" ? [card.name] : [])];
      if (renamed) card.name = name!;
      if (raw.keys || renamed) card.keys = cleanNames(keys, card.name);
      if (raw.content !== undefined) card.content = raw.content.trim();
      if (raw.source) card.source = raw.source;
      continue;
    }
    if (!kind || !name) { log.push(`卡片缺少种类或名称：${JSON.stringify(raw)}`); continue; }
    s.cards.push({ id: newId(), kind, name, keys: cleanNames(raw.keys, name), content: (raw.content ?? "").trim(), source: raw.source ?? "玩家" });
  }
  for (const raw of record.places ?? []) {
    const name = raw.name?.trim();
    const place = raw.id ? s.places.find((p) => p.id === raw.id) : name ? matchName(s.places, name) : undefined;
    if (raw.op === "remove") {
      if (!place) log.push(`地点“${name ?? raw.id}”不存在，删除已忽略`);
      else if (place.id === s.placeId) log.push(`“${place.name}”是当前所在地，不能删除`);
      else {
        s.places.splice(s.places.indexOf(place), 1);
        dismiss(place.name);
      }
      continue;
    }
    if (place) {
      const renamed = !!raw.id && !!name && name !== place.name;
      const aliases = [...(raw.aliases ?? place.aliases ?? []), ...(renamed ? [place.name] : [])];
      if (renamed) place.name = name!;
      if (raw.aliases || renamed) place.aliases = cleanNames(aliases, place.name);
      if (raw.description !== undefined) place.description = raw.description.trim();
      if (raw.source) place.source = raw.source;
      continue;
    }
    if (!name) { log.push(`地点缺少名称：${JSON.stringify(raw)}`); continue; }
    s.places.push({ id: newId(), name, aliases: cleanNames(raw.aliases, name), description: (raw.description ?? "").trim(), ...(raw.source ? { source: raw.source } : {}) });
  }

  return { state: s, chips, notes, log, minutes };
}
