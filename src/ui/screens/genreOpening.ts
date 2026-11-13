import type { Draft } from "./openingDraft";

export interface GenreOpeningFields { premise?: string; identity?: string; hint?: string; guidance?: string }

/** Only explicitly selected fields change; binding, play style and hand-written title stay. */
export function fillGenreOpening(draft: Draft, value: GenreOpeningFields): Draft {
  if (draft.settings.mode !== "free" || draft.fanfic || draft.source?.fanfic) throw new Error("原创题材灵感用于自由世界；同人请保留原著设定");
  const guidance = value.guidance?.trim();
  return {
    ...draft,
    ...(value.premise !== undefined ? { premise: value.premise } : {}),
    ...(value.identity !== undefined ? { identity: value.identity } : {}),
    ...(value.hint !== undefined ? { hint: value.hint } : {}),
    settings: { ...draft.settings, rules: guidance && !draft.settings.rules.includes(guidance) ? [draft.settings.rules, guidance].filter(Boolean).join("\n") : draft.settings.rules },
  };
}
