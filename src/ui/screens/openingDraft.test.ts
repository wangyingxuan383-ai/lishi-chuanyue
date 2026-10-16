import { describe, expect, it } from "vitest";
import { TEMPLATES } from "../../content/templates";
import { EMPTY, fromSetup, fromTemplate, parseShare, shareText, toNewWorld } from "./openingDraft";

const daughter = TEMPLATES.find((t) => t.id === "tang-chancellor-daughter")!;

describe("opening drafts", () => {
  it("round-trips through shared text", () => {
    const draft = { ...fromTemplate(daughter, EMPTY), settings: { ...EMPTY.settings, rules: "多写对话", choiceCount: 4 } };
    const text = shareText(draft);
    expect(text).toContain("【历史穿越 · 开局设定】相府庶女");
    expect(text).toContain("时代：唐 · 天宝七载 · 长安");
    expect(parseShare(`朋友发来：\n${text}\n（转发）`)).toEqual({ ...draft, templateId: null });
  });

  it("cleans what it reads", () => {
    const draft = parseShare(JSON.stringify({ premise: "汉末", eraId: "no-such-pack", gender: "猫", arrival: "飞升", age: "二十", settings: { choiceCount: 9, intensity: { violence: "浓烈" } } }));
    expect(draft).toMatchObject({ premise: "汉末", eraId: null, gender: "男", arrival: "魂穿", age: "", templateId: null });
    expect(draft?.settings).toMatchObject({ choiceCount: 3, intensity: { violence: "浓烈", romance: "写实" } });
    expect(parseShare(JSON.stringify({ premise: "x".repeat(5000), identity: "y" }))?.premise).toHaveLength(4000);
  });

  it("rejects text without a setup", () => {
    expect(parseShare("随便一段话")).toBeNull();
    expect(parseShare("[1, 2]")).toBeNull();
    expect(parseShare(JSON.stringify({ title: "只有标题" }))).toBeNull();
  });

  it("turns an earlier world's setup back into a draft", () => {
    const world = toNewWorld({ ...fromTemplate(daughter, EMPTY), name: "崔婉" });
    const draft = fromSetup({ ...world, settings: { ...world.settings, rules: "节奏快些" } });
    expect(draft).toMatchObject({ name: "崔婉", gender: "女", lockedGender: "女", eraId: "tang-748", arrival: "魂穿", openingMode: "ai", hint: daughter.openingHint });
    expect(draft.premise).toContain("平康坊");
    expect(draft.settings.rules).toBe("节奏快些");
    expect(toNewWorld(draft).protagonist).toEqual(world.protagonist);
  });
});
