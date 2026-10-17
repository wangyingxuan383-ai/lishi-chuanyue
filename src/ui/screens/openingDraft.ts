// The opening setup being written on the new-story screen (D117), and how it
// travels: from a template, from an earlier world ("再来一局同样设定"), and as
// shareable text that a friend can paste back in.
import { ERAS } from "../../content/eras";
import { templateName, type Arrival, type OpeningTemplate } from "../../content/templates";
import type { NewWorld } from "../../engine/game";
import { DEFAULT_SETTINGS, type Intensity, type Perspective, type WorldSettings } from "../../engine/types";

export interface Draft {
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
  settings: Pick<WorldSettings, "perspective" | "style" | "length" | "choiceCount" | "intensity" | "essentials" | "rules">;
}

export const EMPTY: Draft = {
  templateId: null, lockedGender: null, title: "", eraId: null, premise: "", name: "", gender: "男", age: "",
  identity: "", arrival: "魂穿", origin: "历史系研究生", openingMode: "ai", hint: "", openingText: "", organize: true,
  settings: {
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
  };
}

export function toNewWorld(d: Draft, defaults?: Partial<Pick<WorldSettings, "difficulty" | "autoUpkeep" | "chapterEvery">>): NewWorld {
  return {
    title: d.title,
    eraId: d.eraId,
    settings: { ...defaults, ...d.settings, premise: d.premise },
    protagonist: { name: d.name.trim(), gender: d.lockedGender ?? d.gender, age: Number(d.age) || null, identity: d.identity.trim() },
    arrival: d.arrival,
    origin: d.arrival === "不穿越" ? "" : d.origin,
    opening: d.openingMode === "player" ? { mode: "player", text: d.openingText } : { mode: "ai", hint: d.hint },
    organize: !d.eraId && d.organize,
  };
}

/** An earlier world's setup back as a draft; the gender stays fixed as it was played. */
export function fromSetup(setup: NewWorld): Draft {
  const s = setup.settings;
  const gender = setup.protagonist.gender === "女" ? "女" : "男";
  return clean({
    ...EMPTY,
    title: setup.title, eraId: setup.eraId, premise: s.premise ?? "",
    name: setup.protagonist.name, gender, lockedGender: gender, age: setup.protagonist.age ? String(setup.protagonist.age) : "",
    identity: setup.protagonist.identity, arrival: setup.arrival, origin: setup.origin || EMPTY.origin,
    openingMode: setup.opening.mode, hint: setup.opening.mode === "ai" ? setup.opening.hint : "",
    openingText: setup.opening.mode === "player" ? setup.opening.text : "",
    organize: setup.organize !== false,
    settings: { ...EMPTY.settings, ...s, essentials: s.essentials ?? "", rules: s.rules ?? "" },
  });
}

const BEGIN = "<<<LISHI-OPENING";
const END = "LISHI-OPENING>>>";
const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);

/** Readable text a player can send to a friend; the data block at the end is what import reads. */
export function shareText(d: Draft): string {
  const era = ERAS.find((e) => e.id === d.eraId)?.title ?? "按故事设定";
  const { templateId: _t, ...data } = d;
  return [
    `【历史穿越 · 开局设定】${d.title || "未命名"}`,
    `时代：${era}`,
    d.premise && `故事设定：${cut(d.premise, 120)}`,
    `主角：${d.name || "未定"}，${d.lockedGender ?? d.gender}${d.age ? `，${d.age} 岁` : ""}，${d.arrival}`,
    d.identity && `身份：${cut(d.identity, 80)}`,
    "（在“新的故事”右上角 ⋯ 里选“导入开局设定”，粘贴整段文字即可使用）",
    BEGIN,
    JSON.stringify({ v: 1, ...data }),
    END,
  ].filter(Boolean).join("\n");
}

const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");
const oneOf = <T extends string | number>(v: unknown, options: readonly T[], fallback: T): T => (options.includes(v as T) ? (v as T) : fallback);

/** Brings any draft-like object into a valid draft: unknown values fall back, long text is cut. */
function clean(raw: Record<string, unknown>): Draft {
  const s = (raw.settings && typeof raw.settings === "object" ? raw.settings : {}) as Record<string, unknown>;
  const intensity = (s.intensity && typeof s.intensity === "object" ? s.intensity : {}) as Record<string, unknown>;
  const levels: Intensity[] = ["含蓄", "写实", "浓烈"];
  const gender = oneOf(raw.gender, ["男", "女"] as const, "男");
  const locked = raw.lockedGender === "男" || raw.lockedGender === "女" ? raw.lockedGender : null;
  return {
    templateId: null,
    lockedGender: locked,
    title: str(raw.title, 40),
    eraId: ERAS.some((e) => e.id === raw.eraId) ? (raw.eraId as string) : null,
    premise: str(raw.premise, 4000),
    name: str(raw.name, 20),
    gender: locked ?? gender,
    age: str(String(raw.age ?? ""), 3).replace(/\D/g, ""),
    identity: str(raw.identity, 1000),
    arrival: oneOf(raw.arrival, ARRIVALS, "魂穿"),
    origin: str(raw.origin, 40),
    openingMode: oneOf(raw.openingMode, ["ai", "player"] as const, "ai"),
    hint: str(raw.hint, 200),
    openingText: str(raw.openingText, 8000),
    organize: raw.organize !== false,
    settings: {
      perspective: oneOf(s.perspective, ["你", "我", "他"] as Perspective[], EMPTY.settings.perspective),
      style: oneOf(s.style, ["白话", "半文半白"] as const, EMPTY.settings.style),
      length: oneOf(s.length, ["短", "中", "长"] as const, EMPTY.settings.length),
      choiceCount: oneOf(s.choiceCount, [0, 2, 3, 4], EMPTY.settings.choiceCount),
      intensity: {
        violence: oneOf(intensity.violence, levels, EMPTY.settings.intensity.violence),
        romance: oneOf(intensity.romance, levels, EMPTY.settings.intensity.romance),
        darkness: oneOf(intensity.darkness, levels, EMPTY.settings.intensity.darkness),
      },
      essentials: str(s.essentials, 1000),
      rules: str(s.rules, 1000),
    },
  };
}

/** Reads shared text (or bare JSON); null when it holds no opening setup. */
export function parseShare(text: string): Draft | null {
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
