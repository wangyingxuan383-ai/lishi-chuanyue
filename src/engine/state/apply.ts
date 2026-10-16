// Applies a model's turn record to the world state, change by change
// (D104, D113). Invalid changes are corrected or dropped, never fatal; the
// player sees what actually happened as chips, and the next prompt gets notes.
import { parseDurationMinutes } from "../calendar/duration";
import { formatMoney, parseMoney, type Currency } from "../money";
import { newId } from "../db/repo";
import type { ActionMode, Attitude, Difficulty, Person, WorldState } from "../types";
import { matchName } from "./names";

/** The normalised record every output format is converted into. */
export interface TurnRecord {
  time?: string | number | null;
  place?: string | null;
  money?: number | string | null;
  stats?: { health?: number; energy?: number; fame?: number } | null;
  items?: { name: string; delta: number | string; place?: string | null; unit?: string }[] | null;
  people?: { name: string; role?: string; attitude?: string; note?: string; alive?: boolean; aliases?: string[] }[] | null;
  status?: { op: string; name: string; detail?: string }[] | null;
  goals?: { op: string; name: string; detail?: string; kind?: string }[] | null;
  log?: string | null;
  risk?: string | null;
  choices?: string[] | null;
  /** Opening only: date label, hour of day and the era's currency units. */
  date?: string | null;
  hour?: number | null;
  currency?: { name: string; value: number }[] | null;
}

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

const DEFAULT_MINUTES: Record<ActionMode, number> = { do: 15, say: 5, write: 30, continue: 30, direct: 30 };
const ATTITUDES: Attitude[] = ["仇视", "敌意", "冷淡", "一般", "友善", "亲近", "生死之交"];
const STAT_SOFT_CAP = 40;

function describeMinutes(minutes: number): string {
  if (minutes >= 1440) return `过了 ${Math.round(minutes / 1440)} 天`;
  if (minutes >= 120) return `过了 ${Math.round(minutes / 120)} 个时辰`;
  if (minutes === 60) return "过了半个时辰";
  if (minutes >= 15) return `过了 ${Math.round(minutes / 15)} 刻`;
  return "片刻";
}

function attitudeOf(text: string | undefined): Attitude | null {
  if (!text) return null;
  return ATTITUDES.find((a) => text.includes(a)) ?? null;
}

const clamp = (n: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, n));

export function applyRecord(
  before: WorldState,
  record: TurnRecord | null,
  ctx: { mode: ActionMode; difficulty: Difficulty; currency: Currency },
): ApplyResult {
  const s: WorldState = structuredClone(before);
  const chips: Chip[] = [];
  const notes: string[] = [];
  const log: string[] = [];
  const me = s.protagonist;
  const now = () => s.time.elapsedMinutes;

  // Time: always advances; falls back to a default for the action mode.
  const parsed = parseDurationMinutes(record?.time ?? null);
  const minutes = parsed ?? DEFAULT_MINUTES[ctx.mode];
  if (parsed === null && record?.time != null) log.push(`时间“${record.time}”无法识别，按 ${minutes} 分钟计`);
  s.time.elapsedMinutes += minutes;
  if (minutes >= 15) chips.push({ text: describeMinutes(minutes), tone: "info" });
  if (!record) return { state: s, chips, notes, log: [...log, "本回合没有记录"], minutes };

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
  if (me.stats.health <= 0) {
    if (ctx.difficulty === "宽松") {
      me.stats.health = 1;
      if (!me.statuses.some((x) => x.name === "昏迷")) me.statuses.push({ name: "昏迷", detail: "伤重昏迷", sinceMinute: now() });
      chips.push({ text: "昏迷", tone: "warn" });
    } else {
      chips.push({ text: "你死了", tone: "warn" });
    }
  }

  // Items
  for (const raw of record.items ?? []) {
    const delta = typeof raw?.delta === "number" ? raw.delta : Number(String(raw?.delta ?? "").replace(/[^\d+-]/g, ""));
    if (!raw?.name || !Number.isFinite(delta)) { log.push(`物品记录不完整：${JSON.stringify(raw)}`); continue; }
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
    if (!raw?.name) continue;
    // A person first met unnamed ("货栈管事") may later be named ("刘三郎"):
    // the model lists the old label in aliases, which finds the same entry.
    const existing = matchName<Person>(s.people, raw.name)
      ?? (raw.aliases ?? []).map((a) => matchName<Person>(s.people, a)).find(Boolean);
    if (!existing) {
      const person: Person = {
        id: newId(), name: raw.name, aliases: raw.aliases ?? [], role: raw.role ?? "",
        attitude: attitudeOf(raw.attitude) ?? "一般", alive: raw.alive !== false, notes: raw.note ?? "", lastSeenMinute: now(),
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
    if (raw.note) existing.notes = raw.note;
    existing.lastSeenMinute = now();
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
      log.push(`${existing.name} 已死亡，不能复活`);
      notes.push(`${existing.name} 已经去世。`);
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

  // Goals: only "add" may create; other ops must match an existing goal.
  for (const raw of record.goals ?? []) {
    if (!raw?.name) continue;
    const op = (raw.op ?? "progress").toLowerCase();
    const goal = matchName(s.goals.filter((g) => g.status === "进行中" || op === "add"), raw.name);
    if (op === "add") {
      if (goal) continue;
      const kind = raw.kind === "主线" || raw.kind === "心愿" ? raw.kind : "支线";
      s.goals.push({ id: newId(), name: raw.name, kind, progress: raw.detail ?? "", status: "进行中" });
      chips.push({ text: `新目标：${raw.name}`, tone: "info" });
      continue;
    }
    if (!goal) { log.push(`目标“${raw.name}”不存在，${op} 已忽略`); continue; }
    if (op === "done") { goal.status = "完成"; chips.push({ text: `完成：${goal.name}`, tone: "gain" }); }
    else if (op === "fail") { goal.status = "失败"; chips.push({ text: `失败：${goal.name}`, tone: "loss" }); }
    else if (raw.detail) goal.progress = raw.detail;
  }

  return { state: s, chips, notes, log, minutes };
}
