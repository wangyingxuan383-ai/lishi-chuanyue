// AI service presets and saved profiles (PLAN_V3 §4.11, §5.7). Base URLs were
// taken from each provider's OpenAI-compatible documentation; model lists are
// always fetched live from GET /models because they change often.
import type { Platform } from "../../platform";
import type { Repo } from "../db/repo";
import { newId } from "../db/repo";
import { chatCompletionsUrl, serviceBase, type ChatError } from "./chat";

export interface ProviderPreset {
  id: string;
  name: string;
  baseUrl: string;
  keyHint: string;
  /** Substrings that make a model a good default, in order of preference. */
  prefer: string[];
}

export const PRESETS: ProviderPreset[] = [
  { id: "deepseek", name: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", keyHint: "sk-…", prefer: ["deepseek-chat", "deepseek"] },
  { id: "qwen", name: "通义千问", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", keyHint: "sk-…", prefer: ["qwen-plus", "qwen-max", "qwen"] },
  { id: "kimi", name: "Kimi", baseUrl: "https://api.moonshot.cn/v1", keyHint: "sk-…", prefer: ["kimi-k2", "moonshot-v1-32k", "kimi"] },
  { id: "zhipu", name: "智谱", baseUrl: "https://open.bigmodel.cn/api/paas/v4", keyHint: "…", prefer: ["glm-4-plus", "glm-4", "glm"] },
  { id: "siliconflow", name: "硅基流动", baseUrl: "https://api.siliconflow.cn/v1", keyHint: "sk-…", prefer: ["deepseek-ai/DeepSeek-V3", "Qwen/Qwen3", "deepseek"] },
  { id: "volcengine", name: "火山方舟", baseUrl: "https://ark.cn-beijing.volces.com/api/v3", keyHint: "…", prefer: ["doubao", "deepseek"] },
  { id: "openrouter", name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", keyHint: "sk-or-…", prefer: ["deepseek/deepseek-chat", "google/gemini", "anthropic/claude"] },
  { id: "gemini", name: "Gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", keyHint: "AIza…", prefer: ["gemini-2.5-flash", "gemini-flash", "gemini"] },
  { id: "custom", name: "自定义", baseUrl: "", keyHint: "", prefer: ["flash", "chat", "plus", "turbo"] },
];

const NOT_CHAT = /embed|image|tts|audio|whisper|vision|rerank|moderation|dall|speech|ocr/i;

/** Picks a sensible default from a fetched model list. */
export function recommendModel(models: string[], preset: ProviderPreset): string | null {
  const chat = models.filter((m) => !NOT_CHAT.test(m));
  for (const p of [...preset.prefer, "flash", "chat", "plus"]) {
    const hit = chat.find((m) => m.toLowerCase().includes(p.toLowerCase()));
    if (hit) return hit;
  }
  return chat[0] ?? null;
}

export interface Profile {
  id: string;
  name: string;
  provider: string;
  baseUrl: string;
  mainModel: string;
  auxModel: string | null;
  keySlot: string;
  /** Learned once at connection test: does the service accept stream_options.include_usage? */
  includeUsage: boolean;
  allowHttp: boolean;
  /** Target input tokens per turn; the game's default (12k) when absent (R04-T004). */
  contextTokens?: number;
}

export async function listProfiles(repo: Repo): Promise<Profile[]> {
  const rows = await repo.platform.sql.query("SELECT * FROM profiles ORDER BY created_at");
  return rows.map((r) => {
    const params = JSON.parse((r.params_json as string) || "{}");
    const caps = JSON.parse((r.capabilities_json as string) || "{}");
    return {
      id: r.id as string, name: r.name as string, provider: r.provider as string, baseUrl: r.base_url as string,
      mainModel: r.main_model as string, auxModel: (r.aux_model as string) ?? null, keySlot: r.key_slot as string,
      includeUsage: caps.includeUsage !== false, allowHttp: !!params.allowHttp,
      ...(typeof params.contextTokens === "number" ? { contextTokens: params.contextTokens } : {}),
    };
  });
}

export async function saveProfile(repo: Repo, p: Omit<Profile, "id" | "keySlot"> & { id?: string; keySlot?: string }, key: string | null): Promise<Profile> {
  const id = p.id ?? newId();
  const keySlot = p.keySlot ?? `profile-${id.slice(0, 12)}`;
  if (key) await repo.platform.secrets.set(keySlot, key, serviceBase(p.baseUrl));
  await repo.platform.sql.query(
    `INSERT INTO profiles (id, name, provider, base_url, main_model, aux_model, params_json, key_slot, capabilities_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, provider = excluded.provider, base_url = excluded.base_url,
       main_model = excluded.main_model, aux_model = excluded.aux_model, params_json = excluded.params_json,
       capabilities_json = excluded.capabilities_json`,
    [id, p.name, p.provider, p.baseUrl, p.mainModel, p.auxModel, JSON.stringify({ allowHttp: p.allowHttp, ...(p.contextTokens ? { contextTokens: p.contextTokens } : {}) }), keySlot,
      JSON.stringify({ includeUsage: p.includeUsage }), new Date().toISOString()],
  );
  return { ...p, id, keySlot };
}

export async function deleteProfile(repo: Repo, profile: Profile): Promise<void> {
  await repo.platform.secrets.remove(profile.keySlot);
  await repo.platform.sql.query("DELETE FROM profiles WHERE id = ?", [profile.id]);
}

export async function fetchModels(platform: Platform, slot: string, baseUrl: string): Promise<string[]> {
  const response = await platform.llm.get({ slot, url: `${serviceBase(baseUrl)}/models`, timeoutMs: 15_000 });
  if (response.status < 200 || response.status >= 300) throw Object.assign(new Error(`HTTP ${response.status}`), { status: response.status, body: response.body });
  const data = JSON.parse(response.body).data ?? [];
  return data.map((m: { id?: string }) => m.id).filter((id: unknown): id is string => typeof id === "string").sort();
}

/** Plain-language explanation of a failed connection or turn. */
export function explainFailure(kind: string, status?: number): string {
  if (kind === "auth" || status === 401 || status === 403) return "Key 不对或没有权限，请检查 API Key。";
  if (kind === "quota" || status === 402 || status === 429) return "服务额度不足或请求太频繁，稍后再试，或检查账户余额。";
  if (status === 404) return "地址或模型名不对，请检查服务地址和模型。";
  if (kind === "timeout" || kind?.startsWith("timeout")) return "服务太久没有回应，可能网络不稳或服务繁忙。";
  if (kind === "http" && (status ?? 0) >= 500) return "服务暂时出了问题，稍后再试，或换一个服务。";
  if (kind === "config" || kind === "no_secret" || kind === "url_not_bound") return "还没有配置好 AI 服务，请先到设置里连接。";
  if (kind === "refused") return "这段被服务拒绝了。可以换个说法、调整内容尺度，或换一个模型。";
  if (kind === "empty") return "服务没有写出内容，再试一次？";
  if (kind === "no_record") return "开场没准备好，再试一次？";
  if (kind === "cancelled") return "已停止。";
  return "连不上服务，请检查网络和服务地址。";
}

export { chatCompletionsUrl, type ChatError };
