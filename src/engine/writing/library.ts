import type { Repo } from "../db/repo";
import { newId } from "../db/repo";
import type { ActionMode } from "../types";

export interface NarrativePreset { id: string; name: string; directive: string; rules: string }
export interface SavedAction { id: string; name: string; text: string; mode: ActionMode }
export const PRESETS_KEY = "writing:presets:1";
export const ACTIONS_KEY = "writing:actions:1";

export async function loadPresets(repo: Repo): Promise<NarrativePreset[]> {
  const list = await repo.getSetting<unknown>(PRESETS_KEY, []);
  return Array.isArray(list) ? list.filter((p): p is NarrativePreset => !!p && typeof p.id === "string" && typeof p.name === "string" && typeof p.directive === "string" && typeof p.rules === "string") : [];
}
export async function savePreset(repo: Repo, name: string, value: Pick<NarrativePreset, "directive" | "rules">): Promise<NarrativePreset[]> {
  const list = await loadPresets(repo);
  // A repeated name creates another entry instead of silently overwriting a saved group.
  const next = [...list, { id: newId(), name: name.trim(), ...value }];
  await repo.setSetting(PRESETS_KEY, next);
  return next;
}
export async function loadActions(repo: Repo): Promise<SavedAction[]> {
  const list = await repo.getSetting<unknown>(ACTIONS_KEY, []);
  return Array.isArray(list) ? list.filter((p): p is SavedAction => !!p && typeof p.id === "string" && typeof p.name === "string" && typeof p.text === "string" && ["do", "say", "write", "direct"].includes(p.mode)) : [];
}
