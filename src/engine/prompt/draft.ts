// “AI 帮我拟大纲” and “AI 帮我出题” (R14): one auxiliary call each, drafting
// from the opening the player has filled in. Changes are logged in ./CHANGES.md.
import type { ChatMessage } from "../llm/chat";
import { MAX_BEATS, type ChallengeInput, type ScriptInput } from "../modes";
import type { SetupDraft } from "./turn";

export const DRAFT_PROMPT_VERSION = "draft-1";

/** The opening as far as the player has filled it in; `script` / `challenge` are the parts of the draft already written. */
export type DraftInput = Partial<SetupDraft> & { script?: Partial<ScriptInput> | null; challenge?: Partial<ChallengeInput> | null };

const SETUP_LABELS: [keyof SetupDraft, string][] = [
  ["title", "标题"], ["premise", "故事设定"], ["name", "主角"], ["gender", "性别"], ["age", "年龄"], ["identity", "身份"],
  ["arrival", "穿越方式"], ["origin", "穿越前"], ["hint", "开场"], ["essentials", "要点"],
];

function setupText(current: DraftInput): string {
  const lines = SETUP_LABELS.flatMap(([key, label]) => {
    const value = current[key];
    return value !== undefined && value !== null && String(value).trim() ? [`${label}：${String(value).trim()}`] : [];
  });
  return lines.join("\n") || "（还没有填，请你自由发挥）";
}

const story = (current: DraftInput) => (current.mode === "free" ? "互动小说" : "历史互动小说");

export function draftScriptMessages(current: DraftInput): ChatMessage[] {
  const s = current.script ?? {};
  const beats = (s.beats ?? []).map((b) => b.trim()).filter(Boolean);
  const written = [
    s.line?.trim() ? `主线：${s.line.trim()}` : "",
    beats.length ? `已写的幕：\n${beats.map((b, i) => `${i + 1}. ${b}`).join("\n")}` : "",
    s.ending?.trim() ? `结局：${s.ending.trim()}` : "",
  ].filter(Boolean).join("\n");
  return [
    {
      role: "system",
      content: `你帮玩家给一部${story(current)}拟剧本大纲：一句话的主线，三到八幕骨架，和想要的结局。每一幕一句话，写这一幕会发生的事（谁、在哪、出了什么事），按先后排；只写局面和事件，不替主角做决定，给玩家留出选择。符合故事设定和主角的身份。玩家已经写好的部分原样保留，接着补全。只输出一个 JSON 对象：
{"line":"主线，一句话","beats":["第一幕","第二幕","第三幕"],"ending":"想要的结局，一句话"}`,
    },
    { role: "user", content: `开局设定：\n${setupText(current)}\n\n已经写好的大纲：\n${written || "（无）"}` },
  ];
}

export function draftChallengeMessages(current: DraftInput): ChatMessage[] {
  const c = current.challenge ?? {};
  const written = [c.goal?.trim() ? `目标：${c.goal.trim()}` : "", c.limit?.trim() ? `期限：${c.limit.trim()}` : "", c.failIf?.trim() ? `失败条件：${c.failIf.trim()}` : ""].filter(Boolean).join("\n");
  return [
    {
      role: "system",
      content: `你帮玩家给一部${story(current)}出一个开局挑战：一个具体的目标，难，但凭主角的身份和本事有办法做到；一个期限，写成时长（如“十日”“三个月”“半年”）；一个失败条件（没有合适的可以留空）。难处要真实，符合故事设定和主角的处境。玩家已经写好的部分原样保留。只输出一个 JSON 对象：
{"goal":"目标，一句话","limit":"期限","failIf":"失败条件，一句话"}`,
    },
    { role: "user", content: `开局设定：\n${setupText(current)}\n\n已经写好的挑战：\n${written || "（无）"}` },
  ];
}

const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/** The outline the model drafted; null when it gave no beat. */
export function parseScriptDraft(value: unknown): ScriptInput | null {
  const o = value as Record<string, unknown> | null;
  if (!o || typeof o !== "object" || !Array.isArray(o.beats)) return null;
  const beats = o.beats.map(text).filter(Boolean).slice(0, MAX_BEATS);
  return beats.length ? { line: text(o.line), beats, ending: text(o.ending) } : null;
}

/** The challenge the model drafted; null without a goal. */
export function parseChallengeDraft(value: unknown): ChallengeInput | null {
  const o = value as Record<string, unknown> | null;
  if (!o || typeof o !== "object") return null;
  const goal = text(o.goal);
  return goal ? { goal, limit: text(o.limit), failIf: text(o.failIf) } : null;
}
