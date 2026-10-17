// Play defaults (设置 → 游玩默认, docs/research/UX_SETTINGS_AI.md §5.2): the
// settings a new world starts from. A world keeps its own copy, so changing a
// default never touches stories already under way.
import { DEFAULT_SETTINGS, type WorldSettings } from "../../engine/types";
import type { Repo } from "../../engine/db/repo";

export type PlayDefaults = Pick<WorldSettings, "perspective" | "length" | "choiceCount" | "style" | "difficulty" | "intensity" | "autoUpkeep" | "chapterEvery"> & {
  /** Extra rules every new world starts with (the world can change them). */
  rules: string;
};

export const BUILTIN_DEFAULTS: PlayDefaults = {
  perspective: DEFAULT_SETTINGS.perspective, length: DEFAULT_SETTINGS.length, choiceCount: DEFAULT_SETTINGS.choiceCount,
  style: DEFAULT_SETTINGS.style, difficulty: DEFAULT_SETTINGS.difficulty, intensity: DEFAULT_SETTINGS.intensity,
  autoUpkeep: DEFAULT_SETTINGS.autoUpkeep, chapterEvery: DEFAULT_SETTINGS.chapterEvery, rules: "",
};

export async function loadPlayDefaults(repo: Repo): Promise<PlayDefaults> {
  const saved = await repo.getSetting<Partial<PlayDefaults>>("playDefaults", {});
  return { ...BUILTIN_DEFAULTS, ...saved, intensity: { ...BUILTIN_DEFAULTS.intensity, ...saved.intensity } };
}

export function savePlayDefaults(repo: Repo, defaults: PlayDefaults): Promise<void> {
  return repo.setSetting("playDefaults", defaults);
}

/** Which play settings of a world differ from the defaults (shown as 本局 in 本局设置). */
export function differsFromDefaults(settings: WorldSettings, defaults: PlayDefaults): (keyof PlayDefaults)[] {
  return (Object.keys(BUILTIN_DEFAULTS) as (keyof PlayDefaults)[]).filter((k) =>
    k === "rules" ? false : JSON.stringify(settings[k as keyof WorldSettings]) !== JSON.stringify(defaults[k]));
}
