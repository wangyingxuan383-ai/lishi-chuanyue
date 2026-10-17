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
  /** One line on why someone would pick it (UX_PROVIDERS J-10). */
  blurb: string;
  /** Where to create a key and see prices: the link is the guide (J-06). */
  keyUrl?: string;
  priceUrl?: string;
}

// Links and model names checked 2026-10-17 against each provider's own docs
// (docs/research/UX_PROVIDERS.md). deepseek-chat was retired on 2026-07-24.
export const PRESETS: ProviderPreset[] = [
  { id: "deepseek", name: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", keyHint: "sk-…", prefer: ["deepseek-flash", "deepseek-v4-flash", "deepseek"], blurb: "便宜，中文好，新手推荐", keyUrl: "https://platform.deepseek.com/api_keys", priceUrl: "https://api-docs.deepseek.com/zh-cn/quick_start/pricing" },
  { id: "siliconflow", name: "硅基流动", baseUrl: "https://api.siliconflow.cn/v1", keyHint: "sk-…", prefer: ["deepseek-ai/DeepSeek-V4", "deepseek-ai/DeepSeek-V3", "Qwen/Qwen3", "deepseek"], blurb: "一把 Key 用很多模型，新人有赠送额度", keyUrl: "https://cloud.siliconflow.cn/account/ak", priceUrl: "https://cloud.siliconflow.cn/models" },
  { id: "zhipu", name: "智谱", baseUrl: "https://open.bigmodel.cn/api/paas/v4", keyHint: "…", prefer: ["glm-4.7", "glm-4.6", "glm-4-plus", "glm"], blurb: "有免费的 Flash 模型，可以先试玩", keyUrl: "https://open.bigmodel.cn/usercenter/proj-mgmt/apikeys", priceUrl: "https://open.bigmodel.cn/pricing" },
  { id: "qwen", name: "通义千问", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", keyHint: "sk-…", prefer: ["qwen-plus", "qwen-max", "qwen"], blurb: "阿里云百炼，模型多", keyUrl: "https://bailian.console.aliyun.com/?apiKey=1#/api-key", priceUrl: "https://help.aliyun.com/zh/model-studio/model-pricing" },
  { id: "kimi", name: "Kimi", baseUrl: "https://api.moonshot.cn/v1", keyHint: "sk-…", prefer: ["kimi-k2", "moonshot-v1-32k", "kimi"], blurb: "月之暗面，长文好", keyUrl: "https://platform.moonshot.cn/console/api-keys", priceUrl: "https://platform.moonshot.cn/docs/pricing/chat" },
  { id: "volcengine", name: "火山方舟", baseUrl: "https://ark.cn-beijing.volces.com/api/v3", keyHint: "…", prefer: ["doubao", "deepseek"], blurb: "字节豆包系列", keyUrl: "https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey", priceUrl: "https://www.volcengine.com/docs/82379/1544106" },
  { id: "openrouter", name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", keyHint: "sk-or-…", prefer: ["deepseek/deepseek", "google/gemini", "anthropic/claude"], blurb: "海外，各家模型都有", keyUrl: "https://openrouter.ai/settings/keys", priceUrl: "https://openrouter.ai/models" },
  { id: "gemini", name: "Gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", keyHint: "AIza…", prefer: ["gemini-2.5-flash", "gemini-flash", "gemini"], blurb: "谷歌，海外", keyUrl: "https://aistudio.google.com/app/apikey", priceUrl: "https://ai.google.dev/pricing" },
  { id: "custom", name: "自定义", baseUrl: "", keyHint: "", prefer: ["flash", "chat", "plus", "turbo"], blurb: "其他兼容 OpenAI 接口的服务或中转" },
];

/**
 * Cleans what a player pastes as a service address (J-05): spaces, a missing
 * https://, a pasted …/chat/completions or …/models, trailing slashes.
 */
export function cleanBaseUrl(input: string): string {
  let url = input.trim().replace(/[\s　]+/g, "");
  if (!url) return "";
  if (!/^[a-z]+:\/\//i.test(url)) url = `https://${url}`;
  url = url.replace(/\/(chat\/completions|completions|models)\/?$/i, "").replace(/\/+$/, "");
  return url;
}

/** The preset a pasted address belongs to, by its host (so 自定义 with api.deepseek.com is DeepSeek). */
export function presetForUrl(url: string): ProviderPreset | null {
  let host = "";
  try { host = new URL(cleanBaseUrl(url)).host; } catch { return null; }
  return PRESETS.find((p) => p.baseUrl && new URL(p.baseUrl).host === host) ?? null;
}

/** Looks like a key rather than an address, or the other way round (pasted into the wrong box). */
// A host needs a scheme or a path: 智谱 keys are `id.secret`, a bare dotted word.
export const looksLikeUrl = (text: string) => /^(https?:\/\/|[\w-]+(\.[\w-]+)+(:\d+)?\/)/i.test(text.trim());

/**
 * A name for a new service (J-02): the preset's name, or the address's host
 * for a custom one; a number when the name is taken.
 */
export function defaultProfileName(preset: ProviderPreset, baseUrl: string, taken: string[]): string {
  let base = preset.id === "custom" ? "" : preset.name;
  if (!base) {
    try { base = new URL(cleanBaseUrl(baseUrl)).hostname.replace(/^(api|www)\./, ""); } catch { base = "我的服务"; }
  }
  if (!taken.includes(base)) return base;
  for (let i = 2; ; i++) if (!taken.includes(`${base} ${i}`)) return `${base} ${i}`;
}

/** Chat models first, recommended ones at the top; embedding, image and audio models are left out (J-03). */
export function chatModels(models: string[], preset: ProviderPreset): string[] {
  const chat = models.filter((m) => !NOT_CHAT.test(m));
  const rank = (m: string) => {
    const i = preset.prefer.findIndex((p) => m.toLowerCase().includes(p.toLowerCase()));
    return i < 0 ? preset.prefer.length : i;
  };
  return [...chat].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

/** A cheaper sibling for 整理记录 (J-12): flash, mini, lite, air, turbo… or the main model when none. */
export function recommendAuxModel(models: string[], main: string): string {
  const chat = models.filter((m) => !NOT_CHAT.test(m) && m !== main);
  return chat.find((m) => /flash|mini|lite|air|turbo|haiku|small/i.test(m)) ?? main;
}

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

export { chatCompletionsUrl, serviceBase, type ChatError };
