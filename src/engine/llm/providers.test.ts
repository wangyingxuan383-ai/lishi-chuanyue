import { describe, expect, it } from "vitest";
import { PRESETS, chatModels, cleanBaseUrl, defaultProfileName, looksLikeUrl, presetForUrl, recommendAuxModel, recommendModel } from "./providers";

const preset = (id: string) => PRESETS.find((p) => p.id === id)!;

describe("service setup helpers (UX_PROVIDERS J-02, J-03, J-05)", () => {
  it("cleans what players paste as an address", () => {
    expect(cleanBaseUrl(" api.deepseek.com/v1/ ")).toBe("https://api.deepseek.com/v1");
    expect(cleanBaseUrl("https://x.com/v1/chat/completions")).toBe("https://x.com/v1");
    expect(cleanBaseUrl("https://x.com/v1/models")).toBe("https://x.com/v1");
    expect(cleanBaseUrl("http://1.2.3.4:8317")).toBe("http://1.2.3.4:8317");
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
  });
});
