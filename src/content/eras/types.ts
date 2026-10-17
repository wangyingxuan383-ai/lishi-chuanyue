// Era packs (D111): what the narrator and the interface know about a period.
// Field guide: docs/contracts/ERA_PACK.md. Checked by src/engine/era/validate.ts.
import type { EraName, GameDate } from "../../engine/calendar/date";
import type { Currency } from "../../engine/money";

export type Arrival = "魂穿" | "身穿" | "投胎" | "不穿越";
export type Confidence = "高" | "中" | "低";
export type SocialClass = "皇族" | "官宦" | "士人" | "商贾" | "工匠" | "农户" | "市井" | "贱籍" | "方外" | "军伍" | "外族";

/** A starting identity (身份签); each one is also an opening template. */
export interface EraIdentity {
  id: string;
  /** Card title, e.g. "相府庶女". */
  title: string;
  class: SocialClass;
  /** Fixed only when the identity implies it (宫女, 皇子); null keeps every text gender-neutral. */
  gender: "男" | "女" | null;
  age: number;
  /** Story premise for this opening; the pack's premise when absent. */
  premise?: string;
  /** Who you are and what trouble you are in, addressed to "你". */
  text: string;
  /** What the first scene should show. */
  hint: string;
  arrival?: Arrival;
  /** Overrides the pack's surnames (皇子 are all 李). */
  surnames?: string[];
  tags: string[];
}

export interface EraEvent {
  ceYear: number;
  /** Month in the setting's calendar (lunar for Chinese packs). */
  month: number;
  title: string;
  /** 固定: happens whatever the player does (disasters, distant wars); 可变: people's choices that play can change. */
  kind: "固定" | "可变";
}

export interface Taboo {
  /** What must not appear, as told to the narrator: "算盘". */
  name: string;
  /** Why, for players and the anachronism check: "算盘宋元以后才流行". */
  note: string;
  /** What fits instead, told to the narrator: "用算筹". */
  instead?: string;
  /** Literal words that flag it in text; defaults to [name]; [] when a plain match would misfire. */
  match?: string[];
}

export interface EraSource {
  title: string;
  url?: string;
  /** YYYY-MM-DD */
  accessed?: string;
  /** What this source supports. */
  covers: string;
}

export interface EraPack {
  id: string;
  /** "唐 · 天宝七载 · 长安" */
  title: string;
  /** "唐"; with the start year it labels template cards. */
  dynasty: string;
  blurb: string;
  calendar: { eras: EraName[]; lunar: boolean; yearWord?: string };
  start: { date: GameDate; hour: number; place: string };
  /** Default 故事设定 for this pack's openings. */
  premise: string;
  /** Who holds power and what people talk about at the start (for the narrator). */
  situation: string;
  currency: Currency;
  /** How money works, one or two sentences. */
  currencyNote: string;
  /** Purse when an opening does not give one, in the smallest unit. */
  startMoney: number;
  /** basis 史料 = from a source in `sources`; 估算 = an estimate consistent with them. */
  prices: { item: string; price: string; basis: "史料" | "估算" }[];
  address: { term: string; usage: string }[];
  identities: EraIdentity[];
  places: { name: string; description: string }[];
  timeline: EraEvent[];
  /** Everyday details; `months` limits seasonal ones (冬至 in 冬月). */
  daily: { text: string; months?: number[] }[];
  taboos: Taboo[];
  /**
   * More words the narrative is checked for after each turn (R07-T002), kept
   * out of the era card so it stays within its length: the style line names
   * the worst of them, the check catches the rest (eval H).
   */
  watch?: { words: string[]; instead: string }[];
  /** How narration and dialogue should sound. */
  style: string;
  names: { surnames: string[]; given: { 男: string[]; 女: string[] } };
  sources: EraSource[];
  confidence: { level: Confidence; note: string };
}
