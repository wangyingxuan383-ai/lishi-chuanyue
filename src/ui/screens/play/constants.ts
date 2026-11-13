import type { ActionMode } from "../../../engine/types";

export const PAGE = 30;
/** `short` is the placeholder on a phone, where the one-line box would cut the long one off. */
export const MODES: { mode: ActionMode; label: string; placeholder: string; short?: string }[] = [
  { mode: "do", label: "做", placeholder: "写下你要做的事…" },
  { mode: "say", label: "说", placeholder: "写下你要说的话…" },
  { mode: "write", label: "写", placeholder: "亲手写一段剧情，AI 会顺着往下写…", short: "亲手写一段剧情…" },
  { mode: "direct", label: "幕后", placeholder: "给叙事者的要求，如“这段写紧张些”", short: "给叙事者的要求…" },
];
/** 旁观 (R14): the AI plays the protagonist; the player directs from behind the scenes or writes. */
export const WATCH_MODES: typeof MODES = [
  { mode: "direct", label: "幕后", placeholder: "想让故事往哪走？留空就让它自己发展", short: "想让故事往哪走？" },
  { mode: "write", label: "写", placeholder: "亲手写一段剧情，AI 会顺着往下写…", short: "亲手写一段剧情…" },
];
/** What each input mode does, shown in the mode picker (AUDIT 4.9). */
export const MODE_NOTES: Record<string, string> = {
  do: "写你要做的事，AI 写出结果", say: "写你要说的话，原样说出口", write: "亲手写一段剧情，AI 顺着往下写", direct: "不写行动，只告诉叙事者这段怎么写",
};
export const WATCH_NOTES: Record<string, string> = { direct: "写一句想要的走向，主角怎么做由 AI 来演", write: "亲手写一段剧情，AI 顺着往下写" };
/** The words 写尾声 puts in the box. */
export const EPILOGUE = "写一段尾声，交代主要人物后来的去向";
/** The toast after a 剧本 / 挑战 edit, from the line it leaves in the story. */
export const MODE_SAVED: [RegExp, string][] = [[/删掉了剧本/, "已删掉剧本"], [/加了一个剧本/, "剧本定下了"], [/放弃了挑战/, "已放弃挑战"], [/加了一个挑战/, "挑战开始了"], [/挑战/, "已修改挑战"]];
export const HINTS = ["写短一点", "写长一点", "换个结果", "让对方拒绝", "多些对话", "节奏快一些"];
/** "过些日子" (PLAN §4.6): how long, and how the protagonist spends it. */
export const SPANS: [string, string][] = [
  ["到明天", "过一天"], ["几天", "过三五天"], ["一个月", "过一个月"], ["一季", "过一季"], ["一年", "过一年"], ["直到有事发生", "一直过下去，直到有事发生"],
];
export const PASTIMES = ["照常过日子", "读书", "经营", "练武"];
