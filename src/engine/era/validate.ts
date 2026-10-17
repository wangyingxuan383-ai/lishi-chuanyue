// Checks an era pack before it ships (R03-T001): required fields, the era-name
// table, currency conversion, minimum counts, the start date and the length of
// the era card it turns into. Works on raw JSON as well as typed packs.
// Field guide: docs/contracts/ERA_PACK.md.
import type { EraPack } from "../../content/eras/types";
import { ceYearOf, eraAt, monthDays, monthIndex } from "../calendar/date";
import { currencyIssues } from "../money";
import { ERA_CARD_LIMIT } from "../memory/cards";
import { eraCardText } from "./card";

export interface PackIssue {
  /** Where the problem is, e.g. "currency.units[1]". */
  path: string;
  message: string;
}

/** Minimum counts; R03-T002 asks for 8 identities, 20 taboos and 10 events. */
export const MINIMUM = { identities: 8, taboos: 20, timeline: 10, prices: 5, address: 6, places: 4, daily: 8, sources: 3, surnames: 6, given: 4 };

/** Words that would fix the protagonist's gender in an identity open to both. */
const GENDERED = ["她", "郎君", "娘子", "公子", "小姐", "姑娘", "儿子", "女儿", "丈夫", "妻子"];

export function genderedWords(text: string): string[] {
  return GENDERED.filter((w) => text.includes(w));
}

const CLASSES = ["皇族", "官宦", "士人", "商贾", "工匠", "农户", "市井", "贱籍", "方外", "军伍", "外族"];
const ARRIVALS = ["魂穿", "身穿", "投胎", "不穿越"];

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const isText = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
const isInt = (v: unknown): v is number => Number.isInteger(v);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

export function validatePack(raw: unknown): PackIssue[] {
  const issues: PackIssue[] = [];
  const add = (path: string, message: string) => issues.push({ path, message });
  if (!isObj(raw)) return [{ path: "", message: "时代包不是一个对象" }];
  const p = raw;

  for (const key of ["id", "title", "dynasty", "blurb", "premise", "situation", "currencyNote", "style"]) {
    if (!isText(p[key])) add(key, "缺少这项文字");
  }
  if (isText(p.id) && !/^[a-z0-9-]+$/.test(p.id)) add("id", "只能用小写字母、数字和连字符");
  const count = (key: "identities" | "taboos" | "timeline" | "prices" | "address" | "places" | "daily" | "sources") => {
    const items = list(p[key]);
    if (!Array.isArray(p[key])) add(key, "缺少这一项");
    else if (items.length < MINIMUM[key]) add(key, `至少要 ${MINIMUM[key]} 条，现在 ${items.length} 条`);
    return items;
  };

  // Calendar: era names in order, none starting in the same month as another.
  const calendar = isObj(p.calendar) ? p.calendar : null;
  if (!calendar) add("calendar", "缺少历法");
  const lunar = calendar?.lunar;
  if (calendar && typeof lunar !== "boolean") add("calendar.lunar", "要写明是否用农历（true / false）");
  const eras = list(calendar?.eras);
  if (calendar && lunar === true && !eras.length) add("calendar.eras", "农历时代要有年号表");
  const names = new Set<string>();
  let previous: { name: string; at: number } | null = null;
  eras.forEach((e, i) => {
    const path = `calendar.eras[${i}]`;
    if (!isObj(e) || !isText(e.name) || !isInt(e.startCe) || e.startCe === 0) return add(path, "年号要有名字和起始公元年（不为 0）");
    if (names.has(e.name)) add(path, `年号“${e.name}”重复`);
    names.add(e.name);
    const month = e.startMonth ?? 1;
    if (!isInt(month) || month < 1 || month > 12) return add(path, "改元月份要在 1～12 之间");
    if (e.firstYear !== undefined && (!isInt(e.firstYear) || e.firstYear < 1)) add(path, "firstYear 要是正整数");
    const at = monthIndex(e.startCe, month);
    if (previous && at <= previous.at) add(path, `年号表顺序错乱或重叠：“${e.name}”不晚于“${previous.name}”`);
    previous = { name: e.name, at };
  });

  // Start date: in range and consistent with the era table.
  const start = isObj(p.start) ? p.start : null;
  const date = isObj(start?.date) ? start.date : null;
  if (!start || !date) add("start", "缺少开局日期");
  if (start && (!isInt(start.hour) || start.hour < 0 || start.hour > 23)) add("start.hour", "开局时刻要是 0～23 的整数");
  if (start && !isText(start.place)) add("start.place", "缺少开局地点");
  if (date) {
    const ok = isText(date.era) && isInt(date.year) && date.year >= 1 && isInt(date.month) && date.month >= 1 && date.month <= 12 && isInt(date.day) && isInt(date.ceYear);
    if (!ok) add("start.date", "开局日期要有年号、年、月、日和公元年");
    else {
      if (date.lunar !== lunar) add("start.date.lunar", "与历法设置不一致");
      const days = monthDays({ lunar: date.lunar === true, month: date.month as number });
      if ((date.day as number) < 1 || (date.day as number) > days) add("start.date.day", `这个月只有 ${days} 天`);
      const rules = { eras: eras as EraPack["calendar"]["eras"], lunar: lunar === true };
      if (lunar === true) {
        const era = eraAt(date.ceYear as number, date.month as number, rules.eras);
        if (era?.name !== date.era) add("start.date.era", `按年号表，这个月是“${era?.name ?? "表外"}”`);
        else if (ceYearOf(date.era as string, date.year as number, rules) !== date.ceYear) add("start.date.ceYear", "公元年与年号表推算的不一致");
      }
    }
  }

  // Currency: largest first, the smallest worth 1, each a whole multiple of the next.
  const currency = isObj(p.currency) ? p.currency : null;
  const units = list(currency?.units);
  for (const issue of currencyIssues(units)) add(issue.index === null ? "currency.units" : `currency.units[${issue.index}]`, issue.message);
  const unitNames = new Set(units.filter(isObj).map((u) => String(u.name)));
  if (isObj(currency?.aliases)) {
    for (const [alias, target] of Object.entries(currency.aliases)) {
      if (!unitNames.has(String(target))) add(`currency.aliases.${alias}`, `指向不存在的单位“${String(target)}”`);
    }
  }
  if (!isInt(p.startMoney) || p.startMoney < 0) add("startMoney", "要是不小于 0 的整数（以最小单位计）");

  // Lists and their minimum counts.
  const prices = count("prices");
  prices.forEach((x, i) => {
    if (!isObj(x) || !isText(x.item) || !isText(x.price)) add(`prices[${i}]`, "物价要有物品和价格");
    else if (x.basis !== "史料" && x.basis !== "估算") add(`prices[${i}].basis`, "依据只能是“史料”或“估算”");
  });
  const address = count("address");
  address.forEach((x, i) => { if (!isObj(x) || !isText(x.term) || !isText(x.usage)) add(`address[${i}]`, "称谓要有称呼和用法"); });

  const identities = count("identities");
  const ids = new Set<string>();
  identities.forEach((x, i) => {
    const path = `identities[${i}]`;
    if (!isObj(x)) return add(path, "身份不是对象");
    if (!isText(x.id) || !/^[a-z0-9-]+$/.test(x.id)) add(`${path}.id`, "id 只能用小写字母、数字和连字符");
    else if (ids.has(x.id)) add(`${path}.id`, `id“${x.id}”重复`);
    else ids.add(x.id);
    for (const key of ["title", "text", "hint"]) if (!isText(x[key])) add(`${path}.${key}`, "缺少这项文字");
    if (!CLASSES.includes(x.class as string)) add(`${path}.class`, `阶层只能是：${CLASSES.join("、")}`);
    if (x.gender !== "男" && x.gender !== "女" && x.gender !== null) add(`${path}.gender`, "性别只能是“男”“女”或 null（不限）");
    if (x.gender === null) {
      const words = genderedWords([x.title, x.text, x.hint, x.premise].filter(isText).join(" "));
      if (words.length) add(`${path}.gender`, `不限性别的身份不要出现决定性别的词：${words.join("、")}`);
    }
    if (!isInt(x.age) || x.age < 1 || x.age > 100) add(`${path}.age`, "年龄要是 1～100 的整数");
    if (x.arrival !== undefined && !ARRIVALS.includes(x.arrival as string)) add(`${path}.arrival`, `穿越方式只能是：${ARRIVALS.join("、")}`);
    if (x.surnames !== undefined && !list(x.surnames).length) add(`${path}.surnames`, "写了就不能为空");
    if (!Array.isArray(x.tags)) add(`${path}.tags`, "缺少标签");
  });
  if (identities.length) {
    const classes = new Set(identities.map((x) => (isObj(x) ? x.class : null)));
    if (classes.size < 4) add("identities", `身份至少覆盖 4 个阶层，现在 ${classes.size} 个`);
    for (const g of ["男", "女", null]) {
      if (!identities.some((x) => isObj(x) && x.gender === g)) add("identities", `缺少${g ?? "不限性别"}的身份`);
    }
  }

  const places = count("places");
  places.forEach((x, i) => { if (!isObj(x) || !isText(x.name) || !isText(x.description)) add(`places[${i}]`, "地点要有名字和描述"); });

  const timeline = count("timeline");
  let last = -Infinity;
  timeline.forEach((x, i) => {
    const path = `timeline[${i}]`;
    if (!isObj(x) || !isInt(x.ceYear) || x.ceYear === 0 || !isInt(x.month) || x.month < 1 || x.month > 12 || !isText(x.title)) return add(path, "事件要有公元年（不为 0）、月（1～12）和标题");
    if (x.kind !== "固定" && x.kind !== "可变") add(`${path}.kind`, "只能是“固定”或“可变”");
    const at = monthIndex(x.ceYear, x.month);
    if (at < last) add(path, "时间线要按时间先后排列");
    last = at;
  });

  const daily = count("daily");
  daily.forEach((x, i) => {
    if (!isObj(x) || !isText(x.text)) return add(`daily[${i}]`, "缺少文字");
    if (x.months !== undefined && (!list(x.months).length || !list(x.months).every((m) => isInt(m) && m >= 1 && m <= 12))) add(`daily[${i}].months`, "月份要在 1～12 之间");
  });

  const taboos = count("taboos");
  const tabooNames = new Set<string>();
  taboos.forEach((x, i) => {
    const path = `taboos[${i}]`;
    if (!isObj(x) || !isText(x.name) || !isText(x.note)) return add(path, "禁忌要有名称和说明");
    if (tabooNames.has(x.name)) add(path, `“${x.name}”重复`);
    tabooNames.add(x.name);
    if (x.instead !== undefined && !isText(x.instead)) add(`${path}.instead`, "写了就不能为空");
    if (x.match !== undefined && (!Array.isArray(x.match) || !x.match.every(isText))) add(`${path}.match`, "要是非空字符串的列表（不想字面匹配就写 []）");
  });

  const nameRules = isObj(p.names) ? p.names : null;
  if (!nameRules) add("names", "缺少姓名");
  else {
    if (list(nameRules.surnames).length < MINIMUM.surnames) add("names.surnames", `至少要 ${MINIMUM.surnames} 个姓`);
    const given = isObj(nameRules.given) ? nameRules.given : {};
    for (const g of ["男", "女"]) {
      if (list(given[g]).length < MINIMUM.given) add(`names.given.${g}`, `至少要 ${MINIMUM.given} 个名字`);
    }
  }

  const sources = count("sources");
  sources.forEach((x, i) => {
    const path = `sources[${i}]`;
    if (!isObj(x) || !isText(x.title) || !isText(x.covers)) return add(path, "来源要有标题和支持的内容");
    if (x.url !== undefined && !/^https?:\/\/\S+$/.test(String(x.url))) add(`${path}.url`, "网址要以 http:// 或 https:// 开头");
    if (x.accessed !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(String(x.accessed))) add(`${path}.accessed`, "查阅日期写成 YYYY-MM-DD");
  });

  const confidence = isObj(p.confidence) ? p.confidence : null;
  if (!confidence || !["高", "中", "低"].includes(confidence.level as string) || !isText(confidence.note)) add("confidence", "要写明可信度（高 / 中 / 低）和说明");

  // The era card must fit once optional lines are trimmed.
  if (!issues.length) {
    const length = eraCardText(raw as unknown as EraPack).length;
    if (length > ERA_CARD_LIMIT) add("eraCard", `时代卡删到最少仍有 ${length} 字，超过 ${ERA_CARD_LIMIT} 字，请精简文字`);
  }
  return issues;
}
