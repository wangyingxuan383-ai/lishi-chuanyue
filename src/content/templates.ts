// Opening templates: inspiration that fills the author-mode fields, all of
// which the player can edit. Classes and eras are deliberately varied.
// Gender is fixed only when the identity implies it (公主, 皇子, 宫女…);
// otherwise `gender` is null and every text stays gender-neutral.
// Era packs contribute their identities; periods without a pack are written here.
import { yearLabel } from "../engine/calendar/date";
import { ERAS } from "./eras";
import type { Arrival, EraPack } from "./eras/types";

export type { Arrival } from "./eras/types";

export interface OpeningTemplate {
  id: string;
  title: string;
  /** Short label shown on the card, e.g. "唐 · 天宝七载". */
  era: string;
  /** Era pack with currency/taboos, when one exists; otherwise the premise carries the era. */
  eraId: string | null;
  gender: "男" | "女" | null;
  age: number;
  /** How the player arrives; 魂穿 unless stated. */
  arrival?: Arrival;
  /** Story premise in the player's voice; becomes the always-present 故事设定. */
  premise: string;
  /** Who the protagonist is, written to "你" without gendered words when gender is null. */
  identity: string;
  /** What the first scene should show. */
  openingHint: string;
  surnames: string[];
  given: { 男: string[]; 女: string[] };
  tags: string[];
}

const SONG = { surnames: ["赵", "王", "陈", "苏", "沈", "林", "周", "范"], given: { 男: ["彦章", "伯谦", "子瞻", "文渊", "仲宣"], 女: ["清照", "婉容", "素娥", "念奴", "惜惜"] } };
const MING = { surnames: ["朱", "沈", "陆", "周", "徐", "顾", "方", "吴"], given: { 男: ["承恩", "子安", "怀德", "景行", "世卿"], 女: ["婉清", "如是", "小宛", "湘君", "绣娘"] } };
const HAN = { surnames: ["袁", "荀", "陈", "司马", "孙", "周", "陆", "诸葛"], given: { 男: ["文远", "公瑾", "子敬", "伯言", "孝直"], 女: ["昭姬", "文君", "婉华", "令仪", "贞姜"] } };
const QING = { surnames: ["沈", "周", "盛", "徐", "顾", "叶", "林"], given: { 男: ["怀瑾", "思远", "景澄", "伯安"], 女: ["佩玉", "静宜", "曼殊", "婉贞"] } };

const WRITTEN: OpeningTemplate[] = [
  {
    id: "song-prince", title: "官家的第十七子", era: "北宋 · 宣和年间", eraId: null, gender: "男", age: 17, ...SONG,
    surnames: ["赵"],
    premise: "北宋宣和年间，汴京。徽宗崇道好艺，花石纲扰民，朝中蔡京、童贯当权；北方金国崛起，朝廷正与之结盟伐辽。距离靖康之变只剩几年。",
    identity: "你是官家众多皇子中毫不起眼的一个，封了郡王，平日只被叫去陪官家写字赏画。你清楚地知道，几年后汴京将被攻破，皇族将被掳往北方。",
    openingHint: "宫中设宴，官家点名要你作诗助兴。",
    tags: ["宫廷", "救亡"],
  },
  {
    id: "song-courtesan", title: "樊楼行首", era: "北宋 · 宣和年间", eraId: null, gender: "女", age: 20, ...SONG,
    premise: "北宋宣和年间，汴京樊楼。达官文人在此饮宴唱和，消息比朝堂还灵通；行首以才艺闻名，往来皆是权贵。",
    identity: "你是樊楼当红的行首，词曲一绝，却身不由己。一位常来的客人昨夜醉后塞给你一封密信，今早便传来他下狱的消息。",
    openingHint: "开封府的差役与那位客人的政敌，前后脚到了樊楼。",
    tags: ["市井", "权谋"],
  },
  {
    id: "song-magistrate", title: "新任知县", era: "北宋 · 宣和年间", eraId: null, gender: "男", age: 28, ...SONG,
    premise: "北宋宣和年间，两浙路。花石纲搜刮民间奇石，地方官吏借机盘剥，民怨沸腾，方腊之乱一触即发。",
    identity: "你是刚到任的知县，进士出身，满腔抱负。前任知县离任前留下一本对不上的账簿，县衙里的胥吏个个都是地头蛇。",
    openingHint: "上任第一天，花石纲的差官就带着公文上门。",
    tags: ["官场", "治理"],
  },
  {
    id: "song-physician", title: "汴京女医", era: "北宋 · 宣和年间", eraId: null, gender: "女", age: 24, ...SONG,
    premise: "北宋宣和年间，汴京。医家多为男子，女医只给女眷看病，却常能出入高门内宅。",
    identity: "你是汴京小有名气的女医，父亲是被革职的翰林医官。一位王府侧妃难产，王府连夜派车来接，而上一个给她看病的郎中已经下了狱。",
    openingHint: "王府的马车停在门口，管事催你快些。",
    tags: ["医术", "后宅"],
  },
  {
    id: "ming-jinyiwei", title: "锦衣卫百户", era: "明 · 崇祯元年", eraId: null, gender: "男", age: 30, ...MING,
    premise: "崇祯元年，北京。新帝登基，魏忠贤一党刚被清算，朝中人人自危；辽东战事吃紧，陕西已有饥民作乱。",
    identity: "你是锦衣卫百户，曾受阉党提携，如今上司倒台，同僚都在找替罪羊。你手里有一本记着许多人把柄的册子。",
    openingHint: "东厂的人深夜来访，说要借那本册子一看。",
    tags: ["权谋", "悬疑"],
  },
  {
    id: "ming-palace-maid", title: "坤宁宫掌事宫女", era: "明 · 崇祯元年", eraId: null, gender: "女", age: 21, ...MING,
    premise: "崇祯元年，紫禁城。新皇后入主中宫，宫中旧人新人交替，客氏一党余孽尚未清尽。",
    identity: "你是坤宁宫的掌事宫女，伺候过前朝的娘娘，如今在新皇后身边如履薄冰。今早皇后的一支御赐金簪不见了。",
    openingHint: "皇后命你一个时辰内找出金簪，否则满宫杖责。",
    tags: ["宫廷", "悬疑"],
  },
  {
    id: "ming-salt-heiress", title: "盐商独女", era: "明 · 崇祯元年", eraId: null, gender: "女", age: 18, ...MING,
    premise: "崇祯元年，扬州。两淮盐商富甲天下，与官府、漕帮盘根错节；女子不能继承家业，只能招婿。",
    identity: "你是扬州大盐商的独女，父亲突然中风卧床，族中叔伯虎视眈眈，要么逼你嫁给他们挑的人，要么把盐引收回族里。",
    openingHint: "族老们齐聚正堂，要你今日表态。",
    tags: ["经商", "后宅"],
  },
  {
    id: "ming-refugee", title: "流民中的读书人", era: "明 · 崇祯元年", eraId: null, gender: null, age: 23, ...MING,
    premise: "崇祯元年，陕西。连年大旱，赋税不减，饥民成群逃荒，有人开始聚众抢粮。",
    identity: "你是一个识字的人，家乡颗粒无收，你随着逃荒的人群一路向东，身上只剩半块麸饼。人群里有人在商量去抢县城的粮仓，想拉你写檄文。",
    openingHint: "夜里，流民头领找到了你。",
    tags: ["乱世", "求生"],
  },
  {
    id: "han-heir", title: "世家嫡子", era: "东汉 · 中平元年", eraId: null, gender: "男", age: 20, ...HAN,
    premise: "东汉中平元年（184年），颍川。黄巾起事，天下震动；世家大族各自招募部曲，朝廷党锢刚刚解除。",
    identity: "你是颍川世家的嫡子，族中长辈在洛阳为官，家中只剩你主事。黄巾军已到百里之外，佃户们人心惶惶。",
    openingHint: "探马来报，黄巾前锋离庄子只有一日路程。",
    tags: ["乱世", "争霸"],
  },
  {
    id: "jiangdong-general-daughter", title: "江东将门之女", era: "东汉末 · 建安年间", eraId: null, gender: "女", age: 18, ...HAN,
    premise: "东汉末年建安年间，江东。孙氏据有江东，北方曹操虎视眈眈；将门之间联姻与兵权交织。",
    identity: "你是江东一位老将的女儿，自幼习武读兵书。父亲在前线战死，他留下的部曲由谁统领，江东诸将争执不下。",
    openingHint: "父亲的灵柩运回那天，几位将军已在灵堂外剑拔弩张。",
    tags: ["乱世", "军事"],
  },
  {
    id: "qing-returnee", title: "留洋归来", era: "清末 · 光绪二十六年", eraId: null, gender: null, age: 22, ...QING,
    premise: "光绪二十六年（1900年），上海。北方义和团蜂起，八国联军将至；租界里洋行林立，新旧思潮激烈碰撞。",
    identity: "你是上海丝商之家的孩子，刚从英国留学归来。家里的丝厂被洋行压价，账上亏空，长辈却只想让你回来成亲、守住家业。",
    openingHint: "轮船靠岸，来接你的不是家人，而是讨债的洋行买办。",
    tags: ["近代", "经商"],
  },
  {
    id: "qin-clerk", title: "咸阳刀笔吏", era: "秦 · 始皇三十七年", eraId: null, gender: "男", age: 26, ...HAN,
    surnames: ["赵", "李", "王", "蒙", "冯"],
    premise: "秦始皇三十七年，咸阳。始皇东巡途中驾崩的消息尚未传开，赵高、李斯秘不发丧；秦法严苛，连坐之罪人人自危。",
    identity: "你是丞相府的一名刀笔吏，负责誊抄文书。今夜一份加急诏书经你之手，你认出那不是先帝的笔迹。",
    openingHint: "誊抄完毕，赵高的人站在门外等着取走诏书。",
    tags: ["权谋", "改变历史"],
  },
  {
    id: "rome-senator-son", title: "元老之子", era: "古罗马 · 公元前 44 年", eraId: null, gender: "男", age: 20, surnames: ["Marcus ", "Lucius ", "Gaius "], given: { 男: ["Valerius", "Cornelius", "Junius"], 女: ["Valeria", "Cornelia", "Julia"] },
    premise: "公元前44年三月，罗马。凯撒成为终身独裁官，元老院内暗流涌动，一群元老正密谋刺杀他。",
    identity: "你是一位元老的儿子，父亲是密谋者之一。你知道三月十五日会发生什么，也知道之后罗马将陷入多年内战。",
    openingHint: "三月十四日夜，父亲把你叫进书房。",
    tags: ["异域", "改变历史"],
  },
  {
    id: "body-transmigration", title: "身穿到战国", era: "战国 · 秦王政十年", eraId: null, gender: null, age: 25, arrival: "身穿",
    surnames: ["林", "陈", "张", "周", "许"], given: { 男: ["默", "远", "一凡", "子航"], 女: ["悦", "晴", "思雨", "可欣"] },
    premise: "战国末年，秦王政十年，邯郸附近。七国并立，秦国东出之势已成；各国边境关卡森严，没有身份凭证的人会被当作逃户或奸细。",
    identity: "你连人带衣物穿越而来，背包里只有手机（快没电了）、一把多功能刀、一盒止痛药和半瓶矿泉水。你不会说这个时代的话，没有户籍，没有钱。",
    openingHint: "你在田埂上醒来，几个持戈的乡卒正朝你走来。",
    tags: ["身穿", "求生"],
  },
];

/** An era pack's identities as templates; the pack's premise fills in when an identity has none. */
function fromPack(pack: EraPack): OpeningTemplate[] {
  const era = `${pack.dynasty} · ${yearLabel(pack.start.date, pack.calendar)}`;
  return pack.identities.map((i) => ({
    id: i.id, title: i.title, era, eraId: pack.id, gender: i.gender, age: i.age, arrival: i.arrival,
    premise: i.premise ?? pack.premise, identity: i.text, openingHint: i.hint,
    surnames: i.surnames ?? pack.names.surnames, given: pack.names.given, tags: i.tags,
  }));
}

/** Shown first: different classes, genders and dynasties. */
const FEATURED = ["tang-prince", "tang-chancellor-daughter", "song-courtesan", "ming-jinyiwei", "tang-sogdian", "ming-refugee"];

const ALL = [...ERAS.flatMap(fromPack), ...WRITTEN];
export const TEMPLATES: OpeningTemplate[] = [
  ...FEATURED.map((id) => ALL.find((t) => t.id === id)).filter((t): t is OpeningTemplate => !!t),
  ...ALL.filter((t) => !FEATURED.includes(t.id)),
];

export function pickRandom<T>(items: T[]): T {
  return items[Math.floor(Math.random() * items.length)];
}

export function templateName(t: OpeningTemplate, gender: "男" | "女"): string {
  return (pickRandom(t.surnames) + pickRandom(t.given[gender])).trim();
}
