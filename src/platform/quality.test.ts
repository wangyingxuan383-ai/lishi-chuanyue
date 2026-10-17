import { afterEach, describe, expect, it, vi } from "vitest";
import { PRESETS } from "../engine/llm/providers";
import { allowedLink, getPublic } from "./linkPolicy";
import policy from "./link-policy.json";
import { orderedKeepAwake, screenAwakeController } from "./screenAwake";

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
describe("ordered native screen flag", () => {
  it("applies leaving-play off only after a delayed on has finished", async () => {
    let finishOn!: () => void;
    const calls: boolean[] = [];
    const set = orderedKeepAwake(async (on) => { calls.push(on); if (on) await new Promise<void>((resolve) => { finishOn = resolve; }); });
    const opening = set(true);
    await Promise.resolve(); await Promise.resolve();
    const leaving = set(false);
    expect(calls).toEqual([true]);
    finishOn();
    await Promise.all([opening, leaving]);
    expect(calls).toEqual([true, false]);
  });
  it("still releases after a failed enable", async () => {
    const calls: boolean[] = [];
    const set = orderedKeepAwake(async (on) => { calls.push(on); if (on) throw new Error("denied"); });
    const on = set(true);
    const off = set(false);
    await expect(on).rejects.toThrow("denied");
    await off;
    expect(calls).toEqual([true, false]);
  });
});
describe("public link boundary", () => {
  it("allows every shipped provider console and price page, plus this project's releases", () => {
    for (const provider of PRESETS) {
      if (provider.keyUrl) expect(allowedLink(provider.keyUrl, "browser")).toBe(true);
      if (provider.priceUrl) expect(allowedLink(provider.priceUrl, "browser")).toBe(true);
    }
    expect(allowedLink("https://github.com/wangyingxuan383-ai/lishi-chuanyue/releases/tag/v0.9.0", "browser")).toBe(true);
  });
  it.each([
    "http://github.com/wangyingxuan383-ai/lishi-chuanyue", "https://github.com.evil.test/wangyingxuan383-ai/lishi-chuanyue",
    "https://user:pass@github.com/wangyingxuan383-ai/lishi-chuanyue", "https://github.com:444/wangyingxuan383-ai/lishi-chuanyue",
    "https://github.com/wangyingxuan383-ai/lishi-chuanyue-evil", "https://github.com/another/repo", "https://openrouter.ai/redirect",
    "https://github.com/wangyingxuan383-ai/lishi-chuanyue\n", "https://github.com\\@evil.test/", "file:///C:/Windows",
  ])("blocks %s before fetch", async (url) => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    expect(allowedLink(url, "browser")).toBe(false);
    await expect(getPublic(url, 100)).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
  it("allows only the exact update API endpoint", () => {
    expect(allowedLink(policy.publicGet[0], "publicGet")).toBe(true);
    expect(allowedLink(`${policy.publicGet[0]}&extra=1`, "publicGet")).toBe(false);
  });
  it("times out even when headers arrive but the body stalls", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(async (_: string, { signal, redirect }: RequestInit) => {
      expect(redirect).toBe("error");
      return { status: 200, text: () => new Promise((_, reject) => signal!.addEventListener("abort", () => reject(new Error("aborted")))) };
    }));
    const result = expect(getPublic(policy.publicGet[0], 50)).rejects.toThrow("aborted");
    await vi.advanceTimersByTimeAsync(51); await result;
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("screen awake ownership", () => {
  it("releases on leaving play and reacquires only when visible and enabled", async () => {
    let visible = true;
    const release = vi.fn(async () => {});
    const request = vi.fn(async () => ({ release }));
    const control = screenAwakeController(request, () => visible);
    await control.setEnabled(true); await control.visibilityChanged();
    expect(request).toHaveBeenCalledTimes(1);
    visible = false; await control.visibilityChanged(); expect(release).toHaveBeenCalledTimes(1);
    visible = true; await control.visibilityChanged(); expect(request).toHaveBeenCalledTimes(2);
    await control.setEnabled(false); expect(release).toHaveBeenCalledTimes(2);
    await control.visibilityChanged(); expect(request).toHaveBeenCalledTimes(2);
  });
  it("a late grant after leaving play is immediately released", async () => {
    let grant!: (lock: { release(): Promise<void> }) => void;
    const release = vi.fn(async () => {});
    const control = screenAwakeController(() => new Promise((resolve) => { grant = resolve; }), () => true);
    const starting = control.setEnabled(true);
    await control.setEnabled(false); grant({ release }); await starting;
    expect(release).toHaveBeenCalledTimes(1);
  });
  it("handles off/on while the old grant is pending without releasing the new lock", async () => {
    const grants: Array<(lock: { release(): Promise<void> }) => void> = [];
    const control = screenAwakeController(() => new Promise((resolve) => grants.push(resolve)), () => true);
    const old = control.setEnabled(true); await control.setEnabled(false);
    const fresh = control.setEnabled(true);
    const releaseOld = vi.fn(async () => {}), releaseNew = vi.fn(async () => {});
    grants[1]({ release: releaseNew }); await fresh;
    grants[0]({ release: releaseOld }); await old;
    expect(releaseOld).toHaveBeenCalledTimes(1); expect(releaseNew).not.toHaveBeenCalled();
    await control.setEnabled(false); expect(releaseNew).toHaveBeenCalledTimes(1);
  });
  it("keeps unsupported devices usable", async () => {
    const control = screenAwakeController(async () => { throw new Error("unsupported"); }, () => true);
    await expect(control.setEnabled(true)).resolves.toBeUndefined();
    await expect(control.setEnabled(false)).resolves.toBeUndefined();
  });
});
