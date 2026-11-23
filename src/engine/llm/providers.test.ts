import { describe, expect, it } from "vitest";
import {
  PRESETS, chatCompletionsUrl, chatModels, cleanBaseUrl, defaultProfileName, geminiNativeUrl, geminiOpenAiUrl,
  looksLikeUrl, presetForUrl, recommendAuxModel, recommendModel, sameServiceBase, serviceBase,
} from "./providers";

const preset = (id: string) => PRESETS.find((p) => p.id === id)!;

describe("service setup helpers (UX_PROVIDERS J-02, J-03, J-05)", () => {
  it("cleans what players paste as an address", () => {
    expect(cleanBaseUrl(" api.deepseek.com/v1/ ")).toBe("https://api.deepseek.com/v1");
    expect(cleanBaseUrl("https://x.com/v1/chat/completions")).toBe("https://x.com/v1");
    expect(cleanBaseUrl("https://x.com/v1/responses")).toBe("https://x.com/v1");
    expect(cleanBaseUrl("https://x.com/v1/responses/")).toBe("https://x.com/v1");
    expect(cleanBaseUrl("https://api.anthropic.com/v1/messages")).toBe("https://api.anthropic.com/v1");
    expect(cleanBaseUrl("https://api.anthropic.com/v1/messages/")).toBe("https://api.anthropic.com/v1");
    expect(cleanBaseUrl("https://x.com/v1/models")).toBe("https://x.com/v1");
    expect(cleanBaseUrl("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse"))
      .toBe("https://generativelanguage.googleapis.com/v1beta");
    expect(cleanBaseUrl("http://1.2.3.4:8317")).toBe("http://1.2.3.4:8317");
  });

  it("maps Gemini OpenAI-compatible and native v1beta URLs cleanly in both directions", () => {
    expect(geminiOpenAiUrl("https://generativelanguage.googleapis.com")).toBe("https://generativelanguage.googleapis.com/v1beta/openai");
    expect(geminiOpenAiUrl("https://generativelanguage.googleapis.com/v1beta")).toBe("https://generativelanguage.googleapis.com/v1beta/openai");
    expect(geminiOpenAiUrl("https://generativelanguage.googleapis.com/v1beta/openai")).toBe("https://generativelanguage.googleapis.com/v1beta/openai");
    expect(geminiOpenAiUrl("https://relay.example.com/gemini/v1beta")).toBe("https://relay.example.com/gemini/v1beta/openai");
    expect(geminiOpenAiUrl("https://relay.example.com/v1")).toBe("https://relay.example.com/v1");

    expect(geminiNativeUrl("https://generativelanguage.googleapis.com")).toBe("https://generativelanguage.googleapis.com/v1beta");
    expect(geminiNativeUrl("https://generativelanguage.googleapis.com/v1beta/openai")).toBe("https://generativelanguage.googleapis.com/v1beta");
    expect(geminiNativeUrl("https://generativelanguage.googleapis.com/v1beta")).toBe("https://generativelanguage.googleapis.com/v1beta");
    expect(geminiNativeUrl("https://relay.example.com/gemini/v1beta/openai")).toBe("https://relay.example.com/gemini/v1beta");

    // Explicit `/v1beta` stays `/v1beta` for key binding while OpenAI chat routes to `/v1beta/openai/chat/completions`.
    expect(serviceBase("https://generativelanguage.googleapis.com/v1beta")).toBe("https://generativelanguage.googleapis.com/v1beta");
    expect(chatCompletionsUrl("https://generativelanguage.googleapis.com/v1beta"))
      .toBe("https://generativelanguage.googleapis.com/v1beta/openai/chat/completions");
    expect(sameServiceBase(
      "https://generativelanguage.googleapis.com/v1beta",
      "https://generativelanguage.googleapis.com/v1beta/openai",
    )).toBe(true);
    expect(sameServiceBase(
      "https://generativelanguage.googleapis.com/v1beta",
      "https://other.example.com/v1beta/openai",
    )).toBe(false);
  });

  it("knows a preset by its address and tells keys from addresses", () => {
    expect(presetForUrl("https://api.deepseek.com")?.id).toBe("deepseek");
    expect(presetForUrl("https://relay.example.com/v1")).toBeNull();
    expect(looksLikeUrl("api.deepseek.com/v1")).toBe(true);
    expect(looksLikeUrl("sk-abc123")).toBe(false);
    // 智谱 keys look like id.secret: a dot without a scheme or a path is not an address.
    expect(looksLikeUrl("0a1b2c3d4e5f.AbCdEfGhIj")).toBe(false);
    expect(looksLikeUrl("sk-abc.def")).toBe(false);
  });

  it("names services so two custom ones differ", () => {
    expect(defaultProfileName(preset("deepseek"), "", [])).toBe("DeepSeek");
    expect(defaultProfileName(preset("deepseek"), "", ["DeepSeek"])).toBe("DeepSeek 2");
    expect(defaultProfileName(preset("custom"), "https://api.relay.example.com/v1", [])).toBe("relay.example.com");
    expect(defaultProfileName(preset("custom"), "https://relay.example.com/v1", ["relay.example.com"])).toBe("relay.example.com 2");
  });

  it("puts recommended chat models first and leaves out the rest", () => {
    const list = ["text-embedding-3", "deepseek-v4-pro", "deepseek-flash", "tts-1"];
    expect(chatModels(list, preset("deepseek"))).toEqual(["deepseek-flash", "deepseek-v4-pro"]);
    expect(recommendModel(list, preset("deepseek"))).toBe("deepseek-flash");
    expect(recommendAuxModel(["gpt-x", "gpt-x-mini"], "gpt-x")).toBe("gpt-x-mini");
    expect(recommendAuxModel(["gpt-x"], "gpt-x")).toBe("gpt-x");
    expect(recommendAuxModel(["gemini-3-pro", "gemini-3-flash", "gemini-3.8"], "gemini-3.8")).toBe("gemini-3-flash");
  });
});
