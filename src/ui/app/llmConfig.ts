// The game's service settings from the saved profiles: the one in use, and
// the backup that takes over passing failures (备用服务, D179).
import type { Game, LlmConfig } from "../../engine/game";
import { chatCompletionsUrl, listProfiles, type Profile } from "../../engine/llm/providers";

export function llmFor(profile: Profile | null): LlmConfig | null {
  if (!profile) return null;
  return {
    slot: profile.keySlot,
    url: chatCompletionsUrl(profile.baseUrl),
    model: profile.mainModel,
    auxModel: profile.auxModel ?? undefined,
    includeUsage: profile.includeUsage,
    contextTokens: profile.contextTokens,
  };
}

/** 备用服务 (D179): the chosen backup, when it is another service than the one in use. */
export async function applyFallback(game: Game, active: Profile | null): Promise<void> {
  const id = await game.repo.getSetting<string | null>("fallbackProfile", null);
  const backup = id && id !== active?.id ? (await listProfiles(game.repo)).find((p) => p.id === id) ?? null : null;
  game.fallbackLlm = llmFor(backup);
}

