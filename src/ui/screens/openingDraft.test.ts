import { describe, expect, it } from "vitest";
import { TEMPLATES } from "../../content/templates";
import { FREE_TEMPLATES } from "../../content/freeTemplates";
import { CHALLENGES } from "../../content/challenges";
import { deadlineOf } from "../../engine/modes";
import { EMPTY, fromChallenge, fromSetup, fromTemplate, parseShare, shareText, toNewWorld } from "./openingDraft";

const daughter = TEMPLATES.find((t) => t.id === "tang-chancellor-daughter")!;

describe("opening drafts", () => {
  it("keeps free worlds, custom notes and long-lived protagonists through sharing and replay", () => {
    const draft = fromTemplate(FREE_TEMPLATES[1], EMPTY);
    draft.age = "1200";
    draft.settings.heroPanelEnabled = true;
    draft.settings.heroPanel = "会御风，尚不懂医术";
    const restored = parseShare(shareText(draft))!;
    expect(restored.settings).toEqual(draft.settings);
    expect(restored.age).toBe("1200");
    expect(fromSetup(toNewWorld(restored)).settings).toEqual(restored.settings);
  });

  it("a free draft cannot carry a historical pack into a new world", () => {
    const input = toNewWorld({ ...fromTemplate(daughter, EMPTY), settings: { ...EMPTY.settings, mode: "free" } }, { tabooHints: true });
    expect(input.eraId).toBeNull();
    expect(input.settings).toMatchObject({ mode: "free", clockStyle: "elapsed", tabooHints: false });
  });

  it("provides ten editable original inspirations with neutral identities", () => {
    expect(FREE_TEMPLATES).toHaveLength(10);
    expect(new Set(FREE_TEMPLATES.map((t) => t.id)).size).toBe(10);
    expect(FREE_TEMPLATES.every((t) => t.mode === "free" && t.eraId === null && t.gender === null)).toBe(true);
    expect(FREE_TEMPLATES.every((t) => fromTemplate(t, EMPTY, "女").gender === "女")).toBe(true);
  });
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
    expect(parseShare(JSON.stringify({ premise: "x".repeat(5000), identity: "y" }))?.premise).toHaveLength(5000);
  });

  it("rejects text without a setup", () => {
    expect(parseShare("随便一段话")).toBeNull();
    expect(parseShare("[1, 2]")).toBeNull();
    expect(parseShare(JSON.stringify({ title: "只有标题" }))).toBeNull();
  });

  it("round-trips a detailed authored world without quietly cutting its opening or rules", () => {
    const draft = { ...EMPTY, premise: "自定世界。".repeat(1200), identity: "长期生活的记忆。".repeat(300), openingText: "开场原文。".repeat(1800),
      settings: { ...EMPTY.settings, rules: "请保留我的设定。".repeat(300) } };
    const restored = parseShare(shareText(draft))!;
    expect(restored.premise).toBe(draft.premise);
    expect(restored.identity).toBe(draft.identity);
    expect(restored.openingText).toBe(draft.openingText);
    expect(restored.settings.rules).toBe(draft.settings.rules);
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

describe("play modes in the opening draft (R14)", () => {
  const redeem = CHALLENGES.find((c) => c.id === "ming-redeem-house")!;
  const market = CHALLENGES.find((c) => c.id === "tang-west-market")!;

  it("a plain draft starts an ordinary world: no script, challenge or pilot", () => {
    const world = toNewWorld(fromTemplate(daughter, EMPTY));
    expect(world).not.toHaveProperty("script");
    expect(world).not.toHaveProperty("challenge");
    expect(world.settings).not.toHaveProperty("pilot");
    expect(world.settings).not.toHaveProperty("fortune");
  });

  it("a ready-made challenge fills the story, the protagonist and the challenge, with 运势 有影响", () => {
    const draft = fromChallenge(redeem, EMPTY);
    expect(draft).toMatchObject({ play: "challenge", challengeId: redeem.id, lockedGender: "女", gender: "女", name: "顾湘君", age: "26", arrival: "魂穿", origin: "会计师" });
    const world = toNewWorld(draft, { fortune: "hint" });
    expect(world.challenge).toEqual(redeem.challenge);
    expect(world.settings.fortune).toBe("on");
    expect(world.script).toBeUndefined();
    // The player's own choice of 运势 wins.
    expect(toNewWorld({ ...draft, fortune: "off" }).settings.fortune).toBe("off");
    // A neutral identity takes the gender the player has.
    expect(fromChallenge(market, { ...EMPTY, gender: "女" })).toMatchObject({ lockedGender: null, gender: "女", name: "康明月", eraId: "tang-748" });
  });

  it("an outline drops its empty beats; 主角交给 AI 演 sets the pilot", () => {
    const draft = { ...fromTemplate(daughter, EMPTY), play: "script" as const, aiPilot: true, script: { line: " 一句主线 ", beats: ["第一幕", " ", "第三幕"], ending: "", steer: "firm" as const } };
    const world = toNewWorld(draft);
    expect(world.script).toEqual({ line: "一句主线", beats: ["第一幕", "第三幕"], ending: "", steer: "firm" });
    expect(world.settings.pilot).toBe("ai");
    expect(world.challenge).toBeUndefined();
    // Only the chosen card's editor goes into the world; the other stays in the draft.
    expect(toNewWorld({ ...draft, play: "plain" })).not.toHaveProperty("script");
    expect(toNewWorld({ ...draft, play: "watch" }).settings.pilot).toBe("ai");
  });

  it("modes travel through shared text and back from an earlier world", () => {
    const draft = { ...fromChallenge(redeem, EMPTY), aiPilot: true, fortune: "hint" as const };
    const text = shareText(draft);
    expect(text).toContain("玩法：挑战 · 凑够三百两银子，赎回沈家祖宅（三个月），主角交给 AI 演");
    expect(parseShare(text)).toEqual({ ...draft, challengeId: null });
    expect(fromSetup(toNewWorld(draft))).toMatchObject({ play: "challenge", aiPilot: true, fortune: "hint", challenge: redeem.challenge });
    const script = { ...fromTemplate(daughter, EMPTY), play: "script" as const, script: { line: "", beats: ["一", "二"], ending: "", steer: "gentle" as const } };
    expect(fromSetup(toNewWorld(script))).toMatchObject({ play: "script", aiPilot: false, script: { beats: ["一", "二"], steer: "gentle" } });
    expect(fromSetup(toNewWorld({ ...script, play: "watch" }))).toMatchObject({ play: "watch", aiPilot: false });
  });

  it("reads unknown mode values back as plain, keeping the words", () => {
    const draft = parseShare(JSON.stringify({ premise: "汉末", play: "speedrun", aiPilot: "yes", fortune: "lucky", script: { beats: ["一", 2, "三"], steer: "loose" }, challenge: { goal: 5 } }))!;
    expect(draft).toMatchObject({ play: "plain", aiPilot: false, fortune: null, script: { beats: ["一", "三"], steer: "gentle" }, challenge: { goal: "", limit: "", failIf: "" } });
  });
});

describe("ready-made challenges", () => {
  it("are eight varied, well-formed cards", () => {
    expect(CHALLENGES).toHaveLength(8);
    expect(new Set(CHALLENGES.map((c) => c.id)).size).toBe(8);
    expect(CHALLENGES.filter((c) => c.mode === "history")).toHaveLength(4);
    expect(new Set(CHALLENGES.map((c) => c.gender))).toEqual(new Set(["男", "女", null]));
    for (const c of CHALLENGES) {
      expect([...c.premise].length, c.id).toBeGreaterThanOrEqual(150);
      expect([...c.premise].length, c.id).toBeLessThanOrEqual(250);
      expect(c.identity.startsWith("你是"), c.id).toBe(true);
      // Every limit gives a span the program can count down.
      expect(deadlineOf(c.challenge.limit, 0), c.id).toBeGreaterThan(0);
      expect(JSON.stringify(c), c.id).not.toMatch(/科举|考中|及第/);
      // A name for either gender when the identity leaves it open.
      expect(typeof c.name === "string", c.id).toBe(c.gender !== null);
    }
  });
});
