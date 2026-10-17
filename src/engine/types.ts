// Core game types. See docs/PLAN_V3.md §6.
import type { CalendarRules, GameDate } from "./calendar/date";
import type { FortuneMode } from "./fortune";

/**
 * do/say: the protagonist acts; write: the player writes narrative directly; direct: instruction to the narrator;
 * skip: "过些日子", time passes until the span ends or something needs the player (R05-T001).
 */
export type ActionMode = "do" | "say" | "write" | "direct" | "continue" | "skip";
export type NodeKind = "opening" | "turn" | "fastforward" | "edit";
export type NodeStatus = "ok" | "interrupted" | "no_record";
export type Attitude = "仇视" | "敌意" | "冷淡" | "一般" | "友善" | "亲近" | "生死之交";
export type GoalStatus = "进行中" | "完成" | "失败" | "放弃";
export type Difficulty = "宽松" | "标准" | "残酷";
export type Intensity = "含蓄" | "写实" | "浓烈";

export interface Item {
  name: string;
  quantity: number;
  unit: string;
  place: string | null; // null = carried
  note: string;
}

export interface Status {
  name: string;
  detail: string;
  sinceMinute: number;
}

export interface Person {
  id: string;
  name: string;
  aliases: string[];
  role: string;
  attitude: Attitude;
  alive: boolean;
  /** The latest news of this person (近况); each turn's record replaces it. */
  notes: string;
  /**
   * 来历: who they are to the protagonist, kept when later notes replace the
   * first one (eval H: a backstory like “早年受主角相救” was overwritten by
   * “暗中送药送粮” and forgotten). Absent until the notes first change.
   */
  origin?: string;
  lastSeenMinute: number | null;
}

/** A place card of the 设定集 (D121); the ledger creates one whenever the protagonist arrives somewhere new. */
export interface Place {
  id: string;
  name: string;
  /** Other names that bring the card into context. */
  aliases?: string[];
  description: string;
  /** Who wrote the description, as for cards; absent for places the ledger created. */
  source?: Card["source"];
}

export interface Goal {
  id: string;
  name: string;
  /** 心愿 are the player's own; the narrator may open chances but never fulfils them alone. */
  kind: "主线" | "支线" | "心愿";
  /** The latest progress, as the prompt shows it. */
  progress: string;
  status: GoalStatus;
  /** Game minutes when it began and ended, and how it went in between (R05-T003). */
  startedMinute?: number;
  endedMinute?: number;
  steps?: { minute: number; text: string }[];
}

export type CardKind = "时代" | "势力" | "物品" | "设定";

/**
 * A card of the 设定集 (PLAN §4.14, D121). People and places are cards too but
 * keep their own lists. A world has at most one 时代 card, always in context;
 * the others come in when their name or a key appears in recent text.
 */
export interface Card {
  id: string;
  kind: CardKind;
  name: string;
  /** Other names that bring the card into context. */
  keys: string[];
  content: string;
  /** 卡组: copied from a built-in pack; AI: drafted by the model; 玩家: written by the player. */
  source?: "卡组" | "AI" | "玩家";
}

/** One great event of the world's timeline (R05-T004). */
export interface TimelineEvent {
  id: string;
  /** As written, month precision: "天宝九载 十月". */
  date: string;
  /** Game minutes after the start when it happens; negative for history before the start, null when it could not be placed. */
  atMinute: number | null;
  title: string;
  /** 固定 happens whatever the player does; 可变 is what the books say, and the story may change it. */
  kind: "固定" | "可变";
  source?: "卡组" | "AI" | "玩家";
}

/** A chapter summary (R04-T003); used only while its last node is on the current path. */
export interface Chapter {
  id: string;
  worldId: string;
  firstNodeId: string;
  lastNodeId: string;
  title: string;
  /** One line, for older chapters in the recap. */
  gist: string;
  summary: string;
  model: string | null;
  promptVersion: string | null;
  /** The player changed it; it is not rewritten automatically. */
  edited: boolean;
  createdAt: string;
}

export interface Protagonist {
  name: string;
  aliases: string[];
  age: number | null;
  gender: string;
  identity: string;
  origin: string; // who the player was before the transmigration
  cheat: string;
  stats: { money: number; debt: number; health: number; energy: number; fame: number };
  statuses: Status[];
  items: Item[];
}

export interface WorldState {
  /** 2 from D121: the era card lives in `cards`; version 1 saves get it from their pack. */
  version: 1 | 2;
  /**
   * date: the date at minute 0 (D119), null when the opening gave none, absent in old saves;
   * start: how that date reads ("天宝七载 冬月十七", or the opening's own words such as "中平元年秋");
   * startHour: hour of day at minute 0.
   */
  time: { start: string; date?: GameDate | null; startHour?: number; elapsedMinutes: number };
  placeId: string | null;
  protagonist: Protagonist;
  people: Person[];
  places: Place[];
  cards: Card[];
  goals: Goal[];
  /** packId is null for free-form worlds; currency may be set by the opening. */
  era: {
    /** The built-in pack the world started from; a record only, the world's own copy rules. */
    packId: string | null;
    currency?: { units: { name: string; value: number }[]; aliases?: Record<string, string> };
    /** Era names and calendar style; absent in old saves, which fall back to the pack. */
    calendar?: CalendarRules;
  };
  deviations: string[];
  /** Names of cards and places the player deleted; the AI does not propose them again (D122). */
  dismissed?: string[];
  /** The world's great events (R05-T004); absent in old saves. */
  timeline?: TimelineEvent[];
}

export type Perspective = "你" | "我" | "他";

export interface WorldSettings {
  /** The story premise the player wrote (or a template filled in); in every prompt. */
  premise: string;
  /** Facts the narrator must always keep in mind (Plot Essentials), one per line. */
  essentials: string;
  /** Extra instructions to the narrator, written by the player. */
  rules: string;
  perspective: Perspective;
  length: "短" | "中" | "长";
  choiceCount: number;
  style: "白话" | "半文半白";
  difficulty: Difficulty;
  intensity: { violence: Intensity; romance: Intensity; darkness: Intensity };
  directive: string;
  /** Let the auxiliary model keep the 设定集 up to date every few turns (R04-T001, D122). */
  autoUpkeep: boolean;
  /** Turns per chapter summary; 0 turns automatic summaries off (R04-T003). */
  chapterEvery: number;
  /** How much the hidden roll counts: 有影响 / 只作参考 / 关 (R11-T008); old worlds without it behave as "hint". */
  fortune: FortuneMode;
  /** Remind the narrator of era words it should not have used (R07-T002); switchable since R11-T008. */
  tabooHints: boolean;
}

export const DEFAULT_SETTINGS: WorldSettings = {
  premise: "",
  essentials: "",
  rules: "",
  perspective: "你",
  length: "中",
  choiceCount: 3,
  style: "白话",
  difficulty: "标准",
  intensity: { violence: "写实", romance: "写实", darkness: "写实" },
  directive: "",
  autoUpkeep: true,
  chapterEvery: 12,
  fortune: "hint",
  tabooHints: true,
};

export interface World {
  id: string;
  title: string;
  eraId: string;
  currentLineId: string | null;
  settings: WorldSettings;
  createdAt: string;
  updatedAt: string;
  playedAt: string;
  archived: boolean;
}

/** A node as shown in the story stream (no state snapshot). */
export interface StoryNode {
  id: string;
  worldId: string;
  parentId: string | null;
  lastChildId: string | null;
  seq: number;
  kind: NodeKind;
  actionMode: ActionMode | null;
  actionText: string | null;
  directorNote: string | null;
  narrative: string;
  record: unknown;
  choices: string[];
  status: NodeStatus;
  rewritten: boolean;
  fate: string | null;
  meta: Record<string, unknown>;
  createdAt: string;
}

/** A 要点 remembered from a passage; it applies while its origin is on the current path (D106). */
export interface Pin {
  id: string;
  worldId: string;
  originNodeId: string;
  text: string;
  createdAt: string;
}

export interface Line {
  id: string;
  worldId: string;
  name: string;
  nodeId: string;
  kind: "line" | "bookmark";
  autoNamed: boolean;
  archived: boolean;
  createdAt: string;
  /** In the trash since then (R06-T001); purged after 30 days. */
  deletedAt: string | null;
}
