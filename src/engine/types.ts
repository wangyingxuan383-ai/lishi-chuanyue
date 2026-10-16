// Core game types. See docs/PLAN_V3.md §6.
import type { GameDate } from "./calendar/date";

/** do/say: the protagonist acts; write: the player writes narrative directly; direct: instruction to the narrator. */
export type ActionMode = "do" | "say" | "write" | "direct" | "continue";
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
  notes: string;
  lastSeenMinute: number | null;
}

export interface Place {
  id: string;
  name: string;
  description: string;
}

export interface Goal {
  id: string;
  name: string;
  kind: "主线" | "支线" | "心愿";
  progress: string;
  status: GoalStatus;
}

export interface Card {
  id: string;
  kind: "势力" | "物品" | "设定";
  name: string;
  keys: string[];
  content: string;
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
  version: 1;
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
  era: { packId: string | null; currency?: { units: { name: string; value: number }[] } };
  deviations: string[];
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

export interface Line {
  id: string;
  worldId: string;
  name: string;
  nodeId: string;
  kind: "line" | "bookmark";
  autoNamed: boolean;
  archived: boolean;
  createdAt: string;
}
