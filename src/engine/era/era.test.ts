import { describe, expect, it } from "vitest";
import { ERAS } from "../../content/eras";
import { TANG_748 } from "../../content/eras/tang-748";
import { TEMPLATES } from "../../content/templates";
import { nowOf } from "../calendar/clock";
import { sampleState } from "../testing/fixtures";
import { eraContext } from ".";
import { ERA_CARD_LIMIT } from "../memory/cards";
import { eraCardText, packCards, recentEvents } from "./card";
import { genderedWords, validatePack } from "./validate";

describe("era packs", () => {
  it("all pass validation", () => {
    for (const pack of ERAS) expect(validatePack(pack), pack.id).toEqual([]);
  });

  it("have unique ids, and every identity is also a template", () => {
    const ids = ERAS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    const templateIds = TEMPLATES.map((t) => t.id);
    expect(new Set(templateIds).size).toBe(templateIds.length);
    for (const pack of ERAS) {
      for (const identity of pack.identities) expect(TEMPLATES.find((t) => t.id === identity.id)?.eraId, identity.id).toBe(pack.id);
    }
  });

  it("keep templates open to both genders free of gendered words", () => {
    for (const t of TEMPLATES.filter((x) => x.gender === null)) expect(genderedWords(`${t.title} ${t.identity} ${t.openingHint} ${t.premise}`), t.id).toEqual([]);
  });
});

describe("validatePack", () => {
  const broken = (patch: Record<string, unknown>) => validatePack({ ...TANG_748, ...patch }).map((i) => `${i.path}: ${i.message}`);
  const eras = TANG_748.calendar.eras;

  it("finds missing fields and short lists", () => {
    const { situation: _situation, ...rest } = TANG_748;
    expect(validatePack(rest).map((i) => i.path)).toContain("situation");
    expect(broken({ taboos: TANG_748.taboos.slice(0, 5) })).toContain("taboos: 至少要 20 条，现在 5 条");
    expect(broken({ timeline: undefined })).toContain("timeline: 缺少这一项");
    expect(validatePack(null)).toHaveLength(1);
  });

  it("finds overlapping, unordered or repeated era names", () => {
    const calendar = (list: unknown[]) => ({ calendar: { ...TANG_748.calendar, eras: list } });
    expect(broken(calendar([eras[1], eras[0], ...eras.slice(2)])).some((m) => m.includes("顺序错乱或重叠"))).toBe(true);
    expect(broken(calendar([...eras, { name: "大历二", startCe: 766, startMonth: 11 }])).some((m) => m.includes("顺序错乱或重叠"))).toBe(true);
    expect(broken(calendar([...eras, { ...eras[0], startCe: 800 }])).some((m) => m.includes("重复"))).toBe(true);
    expect(broken(calendar([{ name: "天宝", startCe: 742, startMonth: 13 }]))).toContain("calendar.eras[0]: 改元月份要在 1～12 之间");
  });

  it("finds missing or broken currency conversions", () => {
    const units = (list: unknown[], aliases?: Record<string, string>) => ({ currency: { units: list, aliases } });
    expect(broken(units([{ name: "贯" }, { name: "文", value: 1 }]))).toContain("currency.units[0]: “贯”缺少换算（value 要是正整数，以最小单位计）");
    expect(broken(units([{ name: "两", value: 1000 }, { name: "钱", value: 300 }, { name: "文", value: 1 }]))).toContain("currency.units[0]: “两”不是“钱”的整数倍");
    expect(broken(units([{ name: "文", value: 1 }, { name: "贯", value: 1000 }])).some((m) => m.includes("从大到小"))).toBe(true);
    expect(broken(units([{ name: "贯", value: 1000 }, { name: "文", value: 10 }]))).toContain("currency.units[1]: 最小单位的 value 要是 1");
    expect(broken(units([{ name: "贯", value: 1000 }, { name: "文", value: 1 }], { 缗: "串" }))).toContain("currency.aliases.缗: 指向不存在的单位“串”");
    expect(broken(units([]))).toContain("currency.units: 缺少货币单位");
  });

  it("checks the start date against the era table", () => {
    const start = (date: Record<string, unknown>) => ({ start: { ...TANG_748.start, date: { ...TANG_748.start.date, ...date } } });
    expect(broken(start({ era: "开元" }))).toContain("start.date.era: 按年号表，这个月是“天宝”");
    expect(broken(start({ ceYear: 749 }))).toContain("start.date.ceYear: 公元年与年号表推算的不一致");
    expect(broken(start({ month: 12, day: 30 }))).toContain("start.date.day: 这个月只有 29 天");
    expect(broken(start({ lunar: false }))).toContain("start.date.lunar: 与历法设置不一致");
  });

  it("asks for varied identities and a sorted timeline", () => {
    const men = TANG_748.identities.map((i) => ({ ...i, gender: "男" }));
    expect(broken({ identities: men })).toEqual(expect.arrayContaining(["identities: 缺少女的身份", "identities: 缺少不限性别的身份"]));
    expect(broken({ identities: [...TANG_748.identities, TANG_748.identities[0]] })).toContain("identities[11].id: id“tang-prince”重复");
    const neutral = TANG_748.identities.map((i) => (i.id === "tang-hubing" ? { ...i, text: `${i.text}掌柜的女儿也在铺里。` } : i));
    expect(broken({ identities: neutral })).toContain("identities[5].gender: 不限性别的身份不要出现决定性别的词：女儿");
    expect(broken({ timeline: [...TANG_748.timeline].reverse() }).some((m) => m.includes("先后"))).toBe(true);
  });

  it("checks sources", () => {
    const sources = [...TANG_748.sources, { title: "某书", covers: "某事", url: "zh.wikipedia.org", accessed: "2026/10/17" }];
    const last = sources.length - 1;
    expect(broken({ sources })).toEqual([`sources[${last}].url: 网址要以 http:// 或 https:// 开头`, `sources[${last}].accessed: 查阅日期写成 YYYY-MM-DD`]);
  });

  it("flags an era card that cannot fit", () => {
    expect(broken({ situation: "长".repeat(1200) }).some((m) => m.startsWith("eraCard:"))).toBe(true);
  });
});

describe("era card from a pack", () => {
  it("fits the limit, keeps every taboo and ends with the 不要出现 line", () => {
    const text = eraCardText(TANG_748);
    expect(text.length).toBeLessThanOrEqual(ERA_CARD_LIMIT);
    for (const taboo of TANG_748.taboos) expect(text).toContain(taboo.name);
    expect(text.split("\n").at(-1)).toMatch(/^不要出现：/);
  });

  it("lists seasonal details from the opening month on", () => {
    expect(eraCardText(TANG_748).split("\n").find((l) => l.startsWith("节令："))).toMatch(/^节令：冬月：冬至是大节/);
  });

  it("mentions the past year's events, newest first", () => {
    expect(recentEvents(TANG_748).map((e) => `${e.ceYear}/${e.month}`)).toEqual(["748/11", "747/12"]);
    expect(eraCardText(TANG_748)).toContain("天宝六载腊月，高仙芝");
  });

  it("gives a new world an era card and a card per place", () => {
    const { cards, places } = packCards(TANG_748);
    expect(cards).toEqual([expect.objectContaining({ kind: "时代", name: TANG_748.title, source: "卡组", content: eraCardText(TANG_748) })]);
    expect(places.map((p) => p.name)).toEqual(TANG_748.places.map((p) => p.name));
  });
});

describe("eraContext", () => {
  it("reads the start date of old saves from the label", () => {
    const old = { ...sampleState(), time: { start: "天宝七载（戊子）冬月", elapsedMinutes: 0 } };
    const era = eraContext("tang-748", old);
    expect(era.clock.date).toMatchObject({ era: "天宝", year: 7, month: 11, day: 1, ceYear: 748 });
    expect(nowOf(era.clock, 0).text).toBe("天宝七载 冬月初一 · 辰时");
  });

  it("counts days for free worlds without a usable date", () => {
    const free = { ...sampleState(), time: { start: "建安年间", date: null, startHour: 9, elapsedMinutes: 1440 }, era: { packId: null } };
    const era = eraContext("free", free);
    expect(era).toMatchObject({ packId: null, title: "建安年间", eraCard: null });
    expect(nowOf(era.clock, free.time.elapsedMinutes).text).toBe("建安年间 · 第 2 日 · 巳时");
  });

  it("gives old saves their pack's era card and new worlds their own", () => {
    const old = sampleState();
    expect(eraContext("tang-748", old).eraCard).toMatchObject({ kind: "时代", content: eraCardText(TANG_748) });
    const own = { ...sampleState(), version: 2 as const, cards: [{ id: "c1", kind: "时代" as const, name: "我的唐朝", keys: [], content: "全是我写的" }] };
    expect(eraContext("tang-748", own).eraCard?.content).toBe("全是我写的");
    expect(eraContext("tang-748", { ...own, cards: [] }).eraCard).toBeNull();
  });

  it("prefers the world's own calendar and currency", () => {
    const state = { ...sampleState(), version: 2 as const, era: { packId: "tang-748", currency: { units: [{ name: "两", value: 1000 }, { name: "文", value: 1 }] }, calendar: { lunar: true, eras: [] } } };
    const era = eraContext("tang-748", state);
    expect(era.currency.units[0].name).toBe("两");
    expect(era.clock.rules).toEqual({ lunar: true, eras: [] });
  });
});
