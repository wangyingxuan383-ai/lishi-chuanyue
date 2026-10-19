// The opening setup being written on the new-story screen (D117), and how it
// travels: from a template, from an earlier world ("再来一局同样设定"), and as
// shareable text that a friend can paste back in.
import { ERAS } from "../../content/eras";
import { templateName, type Arrival, type OpeningTemplate } from "../../content/templates";
import { challengeName, type ChallengeCard } from "../../content/challenges";
import type { NewWorld } from "../../engine/game";
import type { FortuneMode } from "../../engine/fortune";
import { DEFAULT_SETTINGS, type Intensity, type Perspective, type WorldSettings } from "../../engine/types";
import { validBinding, type SourceBinding } from "../../engine/sources/types";

/**
 * How the story is played (R14): plain 自由, a 剧本 outline, a 挑战, or 旁观
 * (the AI plays the protagonist). 剧本 and 挑战 can hand the protagonist to
 * the AI as well (`aiPilot`).
 */
export type PlayStyle = "plain" | "script" | "challenge" | "watch";
export interface ScriptDraft { line: string; beats: string[]; ending: string; steer: "gentle" | "firm" }
export interface ChallengeDraft { goal: string; limit: string; failIf: string }
export const MAX_BEATS = 12;

export interface Draft {
  fanfic?: boolean;
  source?: SourceBinding | null;
  templateId: string | null;
  lockedGender: "男" | "女" | null;
  title: string;
  eraId: string | null;
  premise: string;
  name: string;
  gender: "男" | "女";
  age: string;
  identity: string;
  arrival: Arrival;
  origin: string;
  openingMode: "ai" | "player";
  hint: string;
  openingText: string;
  /** Without a built-in pack: let the AI organize the 设定集 from the premise. */
  organize: boolean;
  settings: Pick<WorldSettings, "perspective" | "style" | "length" | "choiceCount" | "intensity" | "essentials" | "rules" | "mode" | "clockStyle" | "heroPanel" | "heroPanelEnabled">;
  play: PlayStyle;
  /** 剧本 / 挑战 with the protagonist played by the AI. */
  aiPilot: boolean;
  /** Both are kept while the player switches between the cards, so nothing written is lost. */
  script: ScriptDraft;
  challenge: ChallengeDraft;
  /** The ready-made challenge the fields came from (highlighted), like templateId. */
  challengeId: string | null;
  /** 运势 chosen for this story; null follows the play defaults (有影响 for a challenge). */
  fortune: FortuneMode | null;
}

export const EMPTY_SCRIPT: ScriptDraft = { line: "", beats: ["", "", ""], ending: "", steer: "gentle" };
export const EMPTY_CHALLENGE: ChallengeDraft = { goal: "", limit: "", failIf: "" };

export const EMPTY: Draft = {
  templateId: null, lockedGender: null, title: "", eraId: null, premise: "", name: "", gender: "男", age: "",
  identity: "", arrival: "魂穿", origin: "历史系研究生", openingMode: "ai", hint: "", openingText: "", organize: true,
  play: "plain", aiPilot: false, script: EMPTY_SCRIPT, challenge: EMPTY_CHALLENGE, challengeId: null, fortune: null,
  settings: {
    mode: "history", clockStyle: "era", heroPanelEnabled: false, heroPanel: "",
    perspective: DEFAULT_SETTINGS.perspective, style: DEFAULT_SETTINGS.style, length: DEFAULT_SETTINGS.length,
    choiceCount: DEFAULT_SETTINGS.choiceCount, intensity: DEFAULT_SETTINGS.intensity, essentials: "", rules: "",
  },
};

export const ORIGINS = ["历史系研究生", "程序员", "外科医生", "中学语文老师", "律师", "工程师", "厨师", "退伍军人"];
export const ARRIVALS: Arrival[] = ["魂穿", "身穿", "投胎", "不穿越"];

export function fromTemplate(t: OpeningTemplate, keep: Draft, gender?: "男" | "女"): Draft {
  const g = t.gender ?? gender ?? keep.gender;
  return {
    ...keep,
    templateId: t.id,
    challengeId: null,
    lockedGender: t.gender,
    title: t.title,
    eraId: t.eraId,
    premise: t.premise,
    name: templateName(t, g),
    gender: g,
    age: String(t.age),
    identity: t.identity,
    arrival: t.arrival ?? "魂穿",
    openingMode: "ai",
    hint: t.openingHint,
    openingText: "",
    settings: { ...keep.settings, mode: t.mode ?? "history", clockStyle: t.mode === "free" ? "elapsed" : "era" },
  };
}

/** A ready-made challenge fills the story, the protagonist and the challenge; all stay editable. */
export function fromChallenge(c: ChallengeCard, keep: Draft): Draft {
  const gender = c.gender ?? keep.gender;
  return {
    ...keep,
    templateId: null,
    challengeId: c.id,
    lockedGender: c.gender,
    title: c.title,
    eraId: c.eraId,
    premise: c.premise,
    name: challengeName(c, gender),
    gender,
    age: String(c.age),
    identity: c.identity,
    arrival: c.arrival,
    origin: c.origin ?? keep.origin,
    openingMode: "ai",
    hint: c.hint,
    openingText: "",
    play: "challenge",
    challenge: { ...c.challenge },
    settings: { ...keep.settings, mode: c.mode, clockStyle: c.mode === "free" ? "elapsed" : "era" },
  };
}

/** The outline's filled beats, in order. */
export const filledBeats = (s: ScriptDraft) => s.beats.map((b) => b.trim()).filter(Boolean);
/** Who plays the protagonist in the world this draft starts. */
export const draftPilot = (d: Pick<Draft, "play" | "aiPilot">) => (d.play === "watch" || ((d.play === "script" || d.play === "challenge") && d.aiPilot) ? "ai" as const : "player" as const);
/** 运势 for the new world: the player's choice, else 有影响 for a challenge, else the play default. */
export const draftFortune = (d: Pick<Draft, "play" | "fortune">, fallback: FortuneMode = DEFAULT_SETTINGS.fortune): FortuneMode => d.fortune ?? (d.play === "challenge" ? "on" : fallback);

export function toNewWorld(d: Draft, defaults?: Partial<Pick<WorldSettings, "difficulty" | "autoUpkeep" | "chapterEvery" | "fortune" | "tabooHints">>): NewWorld {
  const pilot = draftPilot(d);
  const fortune = d.fortune ?? (d.play === "challenge" ? "on" : null);
  const beats = filledBeats(d.script);
  return {
    title: d.title,
    source: d.source,
    eraId: d.settings.mode === "free" ? null : d.eraId,
    settings: {
      ...defaults, ...d.settings, premise: d.premise,
      ...(fortune ? { fortune } : {}),
      ...(pilot === "ai" ? { pilot } : {}),
      ...(d.settings.mode === "free" ? { clockStyle: "elapsed" as const, tabooHints: false } : {}),
    },
    protagonist: { name: d.name.trim(), gender: d.lockedGender ?? d.gender, age: Number(d.age) || null, identity: d.identity.trim() },
    arrival: d.arrival,
    origin: d.arrival === "不穿越" ? "" : d.origin,
    opening: d.openingMode === "player" ? { mode: "player", text: d.openingText } : { mode: "ai", hint: d.hint },
    organize: !d.eraId && d.organize,
    ...(d.play === "script" && beats.length ? { script: { line: d.script.line.trim(), beats, ending: d.script.ending.trim(), steer: d.script.steer } } : {}),
    ...(d.play === "challenge" && d.challenge.goal.trim() ? { challenge: { goal: d.challenge.goal.trim(), limit: d.challenge.limit.trim(), failIf: d.challenge.failIf.trim() } } : {}),
  };
}

/** An earlier world's setup back as a draft; the gender stays fixed as it was played. */
export function fromSetup(setup: NewWorld): Draft {
  const s = setup.settings;
  const gender = setup.protagonist.gender === "女" ? "女" : "男";
  return clean({
    ...EMPTY,
    source: setup.source,
    fanfic: setup.source?.fanfic,
    title: setup.title, eraId: setup.eraId, premise: s.premise ?? "",
    name: setup.protagonist.name, gender, lockedGender: gender, age: setup.protagonist.age ? String(setup.protagonist.age) : "",
    identity: setup.protagonist.identity, arrival: setup.arrival, origin: setup.origin || EMPTY.origin,
    openingMode: setup.opening.mode, hint: setup.opening.mode === "ai" ? setup.opening.hint : "",
    openingText: setup.opening.mode === "player" ? setup.opening.text : "",
    organize: setup.organize !== false,
    settings: { ...EMPTY.settings, ...s, essentials: s.essentials ?? "", rules: s.rules ?? "" },
    // 再挑战一次 / 用同样设定再开一局 keep the way it was played.
    play: setup.challenge ? "challenge" : setup.script ? "script" : s.pilot === "ai" ? "watch" : "plain",
    aiPilot: !!(setup.challenge || setup.script) && s.pilot === "ai",
    script: setup.script ?? EMPTY_SCRIPT,
    challenge: setup.challenge ?? EMPTY_CHALLENGE,
    fortune: setup.challenge ? s.fortune ?? null : null,
  });
}

const BEGIN = "<<<LISHI-OPENING";
const END = "LISHI-OPENING>>>";
const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);

/** Readable text a player can send to a friend; the data block at the end is what import reads. */
/** The play line of a shared setup, in words; "" for plain 自由. */
function playLine(d: Draft): string {
  const ai = d.aiPilot ? "，主角交给 AI 演" : "";
  if (d.play === "script") return `玩法：剧本，${filledBeats(d.script).length} 幕${ai}`;
  if (d.play === "challenge") return `玩法：挑战 · ${cut(d.challenge.goal, 40)}${d.challenge.limit ? `（${d.challenge.limit}）` : ""}${ai}`;
  if (d.play === "watch") return "玩法：旁观，主角交给 AI 演";
  return "";
}

export function shareText(d: Draft): string {
  const era = ERAS.find((e) => e.id === d.eraId)?.title ?? "按故事设定";
  const { templateId: _t, challengeId: _c, ...data } = d;
  return [
    `【历史穿越 · 开局设定】${d.title || "未命名"}`,
    `${d.settings.mode === "free" ? "世界" : "时代"}：${d.settings.mode === "free" ? "自由世界" : era}`,
    playLine(d),
    d.premise && `故事设定：${cut(d.premise, 120)}`,
    `主角：${d.name || "未定"}，${d.lockedGender ?? d.gender}${d.age ? `，${d.age} 岁` : ""}，${d.arrival}`,
    d.identity && `身份：${cut(d.identity, 80)}`,
    "（在“新的故事”右上角 ⋯ 里选“导入开局设定”，粘贴整段文字即可使用）",
    BEGIN,
    JSON.stringify({ v: 1, ...data }),
    END,
  ].filter(Boolean).join("\n");
}

const str = (v: unknown) => (typeof v === "string" ? v : "");
export const OPENING_TEXT_LIMIT = 4 * 1024 * 1024;
const oneOf = <T extends string | number>(v: unknown, options: readonly T[], fallback: T): T => (options.includes(v as T) ? (v as T) : fallback);

/** Unknown options fall back; authored text is preserved, never silently truncated. */
function clean(raw: Record<string, unknown>): Draft {
  const s = (raw.settings && typeof raw.settings === "object" ? raw.settings : {}) as Record<string, unknown>;
  const intensity = (s.intensity && typeof s.intensity === "object" ? s.intensity : {}) as Record<string, unknown>;
  const levels: Intensity[] = ["含蓄", "写实", "浓烈"];
  const gender = oneOf(raw.gender, ["男", "女"] as const, "男");
  const locked = raw.lockedGender === "男" || raw.lockedGender === "女" ? raw.lockedGender : null;
  const script = (raw.script && typeof raw.script === "object" ? raw.script : {}) as Record<string, unknown>;
  const beats = Array.isArray(script.beats) ? script.beats.filter((b): b is string => typeof b === "string").slice(0, MAX_BEATS) : [];
  const challenge = (raw.challenge && typeof raw.challenge === "object" ? raw.challenge : {}) as Record<string, unknown>;
  return {
    templateId: null,
    ...(raw.source !== undefined ? { source: validBinding(raw.source) ? raw.source : null } : {}),
    ...(raw.fanfic !== undefined ? { fanfic: raw.fanfic === true } : {}),
    challengeId: null,
    play: oneOf(raw.play, ["plain", "script", "challenge", "watch"] as const, "plain"),
    aiPilot: raw.aiPilot === true,
    script: { line: str(script.line), beats: beats.length ? beats : [...EMPTY_SCRIPT.beats], ending: str(script.ending), steer: script.steer === "firm" ? "firm" : "gentle" },
    challenge: { goal: str(challenge.goal), limit: str(challenge.limit), failIf: str(challenge.failIf) },
    fortune: raw.fortune === "on" || raw.fortune === "hint" || raw.fortune === "off" ? raw.fortune : null,
    lockedGender: locked,
    title: str(raw.title),
    eraId: ERAS.some((e) => e.id === raw.eraId) ? (raw.eraId as string) : null,
    premise: str(raw.premise),
    name: str(raw.name),
    gender: locked ?? gender,
    age: str(String(raw.age ?? "")).replace(/\D/g, ""),
    identity: str(raw.identity),
    arrival: oneOf(raw.arrival, ARRIVALS, "魂穿"),
    origin: str(raw.origin),
    openingMode: oneOf(raw.openingMode, ["ai", "player"] as const, "ai"),
    hint: str(raw.hint),
    openingText: str(raw.openingText),
    organize: raw.organize !== false,
    settings: {
      mode: s.mode === "free" ? "free" : "history",
      clockStyle: s.mode === "free" ? "elapsed" : "era",
      heroPanelEnabled: s.heroPanelEnabled === true,
      heroPanel: str(s.heroPanel),
      perspective: oneOf(s.perspective, ["你", "我", "他"] as Perspective[], EMPTY.settings.perspective),
      style: oneOf(s.style, ["白话", "半文半白"] as const, EMPTY.settings.style),
      length: oneOf(s.length, ["短", "中", "长"] as const, EMPTY.settings.length),
      choiceCount: oneOf(s.choiceCount, [0, 2, 3, 4], EMPTY.settings.choiceCount),
      intensity: {
        violence: oneOf(intensity.violence, levels, EMPTY.settings.intensity.violence),
        romance: oneOf(intensity.romance, levels, EMPTY.settings.intensity.romance),
        darkness: oneOf(intensity.darkness, levels, EMPTY.settings.intensity.darkness),
      },
      essentials: str(s.essentials),
      rules: str(s.rules),
    },
  };
}

/** Reads shared text (or bare JSON); null when it holds no opening setup. */
export function parseShare(text: string): Draft | null {
  if (text.length > OPENING_TEXT_LIMIT) return null;
  const start = text.indexOf(BEGIN);
  const end = text.indexOf(END, start + BEGIN.length);
  const body = start >= 0 && end > start ? text.slice(start + BEGIN.length, end) : text;
  try {
    const raw = JSON.parse(body.trim()) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const draft = clean(raw as Record<string, unknown>);
    return draft.premise.trim() || draft.identity.trim() || draft.openingText.trim() ? draft : null;
  } catch {
    return null;
  }
}
