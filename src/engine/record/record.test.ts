import { describe, expect, it } from "vitest";
import { lenientJson, parseRecord } from "./parse";
import { RecordSplitter } from "./split";

/** Streams `text` in chunks of `size` and returns what the UI saw plus the final split. */
function stream(text: string, size: number) {
  const splitter = new RecordSplitter();
  let shown = "";
  for (let i = 0; i < text.length; i += size) shown += splitter.push(text.slice(i, i + size));
  const end = splitter.finish();
  shown += end.tail;
  return { shown, ...end };
}

const NARRATIVE = "你推开门，雪光刺眼。\n掌柜抬头：“郎君早。”";
const RECORD = '<record>\n{"time":"一刻","money":-2,"choices":["出门","回房"]}\n</record>';

describe("RecordSplitter", () => {
  it.each([1, 2, 3, 7, 1000])("never shows the record, chunk size %i", (size) => {
    const r = stream(`${NARRATIVE}\n\n${RECORD}`, size);
    expect(r.shown.trim()).toBe(NARRATIVE);
    expect(r.narrative).toBe(NARRATIVE);
    expect(parseRecord(r.recordText).record?.money).toBe(-2);
  });

  it("detects tags with spaces and capitals", () => {
    const r = stream(`${NARRATIVE}\n< Record >{"time":"一刻","choices":["甲"]}`, 4);
    expect(r.shown.trim()).toBe(NARRATIVE);
    expect(parseRecord(r.recordText).record?.choices).toEqual(["甲"]);
  });

  it("releases a held-back '<' that was not a tag", () => {
    const r = stream("他写下 <之> 字，又写下 3<5。", 2);
    expect(r.shown).toBe("他写下 <之> 字，又写下 3<5。");
    expect(r.recordText).toBeNull();
  });

  it("accepts a trailing fenced JSON record without a tag", () => {
    const r = stream(`${NARRATIVE}\n\n\`\`\`json\n{"time":"半个时辰","choices":["走"]}\n\`\`\``, 5);
    expect(r.shown.trim()).toBe(NARRATIVE);
    expect(parseRecord(r.recordText).record?.time).toBe("半个时辰");
  });

  it("accepts a trailing bare JSON record without a tag", () => {
    const r = stream(`${NARRATIVE}\n{"log":"出门","choices":["走"]}`, 1000);
    expect(r.narrative).toBe(NARRATIVE);
    expect(parseRecord(r.recordText).record?.log).toBe("出门");
  });

  it("shows narrative that merely contains a code fence", () => {
    const r = stream("墙上刻着：\n```\n天宝\n```\n你看了一眼。", 3);
    expect(r.shown).toContain("天宝");
    expect(r.recordText).toBeNull();
  });

  it.each([1, 3, 1000])("cuts context the model copied after the story, chunk size %i", (size) => {
    const echo = "\n\n【当前】天宝七载 冬月十七 · 西市\n可用的钱：300 文";
    const r = stream(`${NARRATIVE}${echo}\n${RECORD}`, size);
    expect(r.shown.trim()).toBe(NARRATIVE);
    expect(r.narrative).toBe(NARRATIVE);
    expect(parseRecord(r.recordText).record?.money).toBe(-2);
    const bare = stream(`${NARRATIVE}${echo}`, size);
    expect(bare.narrative).toBe(NARRATIVE);
    expect(bare.shown.trim()).toBe(NARRATIVE);
  });

  it("keeps a bracket in the story that is not one of the request's sections", () => {
    const r = stream("门上贴着告示：\n【告示】宵禁之后不得出坊。", 2);
    expect(r.narrative).toContain("【告示】宵禁之后不得出坊。");
    expect(r.shown).toContain("【告示】");
  });

  it("reports a missing record", () => {
    const r = stream(NARRATIVE, 4);
    expect(parseRecord(r.recordText)).toEqual({ record: null, issues: ["没有记录块"] });
  });
});

describe("parseRecord", () => {
  const cases: Array<[string, string, (r: NonNullable<ReturnType<typeof parseRecord>["record"]>) => void]> = [
    ["trailing comma", '<record>{"time":"一刻","choices":["甲","乙",],}</record>', (r) => expect(r.choices).toEqual(["甲", "乙"])],
    ["no closing tag", '<record>{"time":"一刻","money":5,"choices":["甲"]}', (r) => expect(r.money).toBe(5)],
    ["text after json", '<record>{"time":"一刻","choices":["甲"]}</record>\n（以上为记录）', (r) => expect(r.time).toBe("一刻")],
    ["fence inside tag", '<record>\n```json\n{"time":"一刻","choices":["甲"]}\n```\n</record>', (r) => expect(r.choices).toHaveLength(1)],
    ["unquoted keys", "<record>{time:\"一刻\", choices:[\"甲\"]}</record>", (r) => expect(r.time).toBe("一刻")],
    ["single quotes", "<record>{'time':'一刻','choices':['甲']}</record>", (r) => expect(r.choices).toEqual(["甲"])],
    ["smart quotes as delimiters", "<record>{“time”:“一刻”,“choices”:[“甲”]}</record>", (r) => expect(r.time).toBe("一刻")],
    ["chinese quotes inside values survive", '<record>{"log":"他说“好”","choices":["回答“是”"]}</record>', (r) => expect(r.choices).toEqual(["回答“是”"])],
    ["truncated mid-array", '<record>{"time":"一刻","money":-3,"items":[{"name":"胡饼","delta":1},{"name":"茶', (r) => {
      expect(r.money).toBe(-3);
      expect(r.items).toEqual([{ name: "胡饼", delta: 1 }]);
    }],
    ["truncated mid-string", '<record>{"time":"一刻","log":"买了胡', (r) => expect(r.time).toBe("一刻")],
    ["string delta", '<record>{"items":[{"name":"胡饼","delta":"+2"}],"choices":["甲"]}</record>', (r) => expect(r.items).toEqual([{ name: "胡饼", delta: 2 }])],
    ["item shorthand strings", '<record>{"items":["胡饼 +2","旧书 -1"],"choices":["甲"]}</record>', (r) => expect(r.items).toEqual([{ name: "胡饼", delta: 2 }, { name: "旧书", delta: -1 }])],
    ["bad item dropped", '<record>{"items":[{"name":"胡饼"},{"name":"茶","delta":1}],"choices":["甲"]}</record>', (r) => expect(r.items).toEqual([{ name: "茶", delta: 1 }])],
    ["single object instead of array", '<record>{"people":{"name":"孙管事","attitude":"冷淡"},"choices":["甲"]}</record>', (r) => expect(r.people?.[0].name).toBe("孙管事")],
    ["choice objects and numbering", '<record>{"choices":[{"text":"1. 出门"},"2、回房","- 睡觉"]}</record>', (r) => expect(r.choices).toEqual(["出门", "回房", "睡觉"])],
    ["more than six choices", `<record>{"choices":${JSON.stringify(["一", "二", "三", "四", "五", "六", "七"])}}</record>`, (r) => expect(r.choices).toHaveLength(6)],
    ["numeric time and money string", '<record>{"time":45,"money":"-三十文","choices":["甲"]}</record>', (r) => {
      expect(r.time).toBe(45);
      expect(r.money).toBe("-三十文");
    }],
    ["aliases kept", '<record>{"people":[{"name":"刘三郎","aliases":["货栈管事"]}],"choices":["甲"]}</record>', (r) => expect(r.people?.[0].aliases).toEqual(["货栈管事"])],
    ["unknown fields ignored", '<record>{"time":"一刻","mood":"紧张","choices":["甲"],"extra":{"a":1}}</record>', (r) => expect(Object.keys(r)).not.toContain("mood")],
    ["stats numbers", '<record>{"stats":{"health":"-10","energy":-5,"fame":"x"},"choices":["甲"]}</record>', (r) => expect(r.stats).toEqual({ health: -10, energy: -5 })],
  ];

  it.each(cases)("%s", (_name, text, check) => {
    const { record } = parseRecord(text);
    expect(record).not.toBeNull();
    check(record!);
  });

  it("keeps a structured opening date", () => {
    const { record } = parseRecord('{"time":"0","date":{"era":"天宝","year":7,"month":11,"day":17,"ceYear":748},"choices":["a"]}');
    expect(record?.date).toEqual({ era: "天宝", year: 7, month: 11, day: 17, ceYear: 748 });
    expect(parseRecord('{"time":"0","date":"宣和四年春二月","choices":["a"]}').record?.date).toBe("宣和四年春二月");
  });

  it("reads the report of a span of days", () => {
    const parse = (report: unknown) => parseRecord(JSON.stringify({ time: "一个月", log: "略", choices: ["甲"], report })).record!.report;
    expect(parse({ world: "陇右又打了胜仗", local: "米价涨了", people: "" })).toEqual({ world: "陇右又打了胜仗", local: "米价涨了" });
    expect(parse({ world: "" })).toBeUndefined();
    expect(parse("一句话")).toBeUndefined();
  });

  it("reads what the fortune was used for and how it went", () => {
    const parse = (risk: unknown) => parseRecord(JSON.stringify({ time: "一刻", log: "略", choices: ["甲"], risk })).record!.risk;
    expect(parse({ what: "说服掌柜赊账", result: "败" })).toEqual({ what: "说服掌柜赊账", result: "败" });
    expect(parse({ what: "翻墙", result: "没成" })).toEqual({ what: "翻墙", result: "败" });
    expect(parse({ what: "讨价还价", result: "半成" })).toEqual({ what: "讨价还价", result: "半成" });
    expect(parse("撬锁")).toEqual({ what: "撬锁" });
    expect(parse(null)).toBeUndefined();
  });

  it("returns null for hopeless input", () => {
    expect(parseRecord("<record>完全不是 JSON</record>").record).toBeNull();
    expect(lenientJson("[1,2]")).toBeNull();
  });

  it("notes missing time and choices", () => {
    expect(parseRecord('<record>{"log":"x"}</record>').issues).toEqual(["缺少 time", "缺少 choices"]);
  });
});
