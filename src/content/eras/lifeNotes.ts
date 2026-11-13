// Optional, sourced background notes. Copy selected cards into a story;
// never change its calendar, currency rules, past events or existing cards.
export interface HistoryLifeSource {
  id: string;
  title: string;
  url: string;
  accessed: string;
  covers: string;
}
export interface HistoryLifeCard {
  id: string;
  title: string;
  kind: "制度" | "生活" | "货币";
  text: string;
  keywords?: string[];
  sourceIds: string[];
}
export interface HistoryLifePack {
  id: string;
  version: string;
  title: string;
  period: string;
  scope: string;
  note: string;
  cards: HistoryLifeCard[];
  sources: HistoryLifeSource[];
  skills: string[];
}

const ACCESSED = "2026-11-04";
export const HISTORY_LIFE_PACKS: HistoryLifePack[] = [
  {
    id: "life-tang-changan", version: "1.0.0", title: "唐代长安生活札记", period: "盛唐 · 长安与两京制度",
    scope: "以天宝时期故事为使用场景，补充钱物、市场官署与实物细节；不替代本局时代卡。",
    note: "只有下列专题经过来源核对，不是完整唐代资料库。制度文献与出土实物证明其存在，不保证每处、每人都相同；不提供固定物价、官员名单或未来年表。",
    skills: ["historical-world"],
    cards: [
      { id: "tang-kaiyuan-cash", title: "唐代钱名：开元通宝", kind: "货币", text: "开元通宝始铸于武德四年（621），不是开元年间才出现的钱名，可用于天宝故事。它是唐代重要流通钱；本卡不规定物价或银钱汇率。", keywords: ["开元通宝", "铜钱", "付账", "钱", "天宝"], sourceIds: ["nmc-kaiyuan"] },
      { id: "tang-money-silk", title: "唐代钱帛与计量称谓", kind: "货币", text: "《唐六典》将钱帛列为财货，记绢以匹、钱以贯、金银以铤称量。写官库或交割时可区分材质与单位，不由此推定一匹绢在所有地方价值相同。", keywords: ["绢", "布", "匹", "贯", "铤", "交割", "库"], sourceIds: ["tang-liudian-20"] },
      { id: "tang-market-office", title: "两京市场官署", kind: "制度", text: "《唐六典》卷二十列两京诸市署的令、丞等官属，并将两京市场列入太府寺所统职务。涉及官府管理市场时可据此定位；不将它概括成全国一切市集的同一规则。", keywords: ["长安", "洛阳", "西市", "东市", "市署", "太府寺"], sourceIds: ["tang-liudian-20"] },
      { id: "tang-silver-incense", title: "唐代金属香囊", kind: "生活", text: "唐代已有镂空金属香囊，内部机环使香盂保持平衡，可悬挂或佩戴。它可作为贵重器物的写作参考，不应把精巧银香囊写成人人都有的日用品。", keywords: ["香囊", "银器", "熏香", "香盂", "金银作坊"], sourceIds: ["nmc-incense"] },
    ],
    sources: [
      { id: "nmc-kaiyuan", title: "中国国家博物馆：开元通宝", url: "https://www.chnmuseum.cn/zp/zpml/hb/202203/t20220301_253935.shtml", accessed: ACCESSED, covers: "始铸年代、钱名及唐代流通地位。" },
      { id: "tang-liudian-20", title: "《唐六典》卷二十·太府寺（原典转录）", url: "https://zh.wikisource.org/wiki/唐六典/卷20", accessed: ACCESSED, covers: "两京诸市署、太府寺职务、钱帛及计量称谓；不是地方实际物价表。" },
      { id: "nmc-incense", title: "中国国家博物馆：熏香器中的机巧", url: "https://www.chnmuseum.cn/yj/xscg/xslw/201812/t20181224_33175.shtml", accessed: ACCESSED, covers: "唐代鎏金银香囊实物、内部结构与使用方式。" },
    ],
  },
  {
    id: "life-song-xuanhe", version: "1.0.0", title: "北宋宣和汴京生活札记", period: "北宋末 · 汴京",
    scope: "依据《东京梦华录》的京城旧事，覆盖市食、雇工、钱陌与防火。",
    note: "原书为孟元老事后追记的汴京生活，不等于整个北宋全国通例。钱陌随行市不同，本文不替玩家改货币换算；食物、行当与官署须结合具体地点和本局剧情。",
    skills: ["historical-world"],
    cards: [
      { id: "song-zhouqiao-market", title: "州桥南的夜市", kind: "生活", text: "《东京梦华录》卷二记州桥南到龙津桥一带夜市有多种熟食，延续到三更。可作汴京夜间市食的参考，不据此断言所有街门、所有地方整夜开放。", keywords: ["州桥", "龙津桥", "夜市", "熟食", "汴京"], sourceIds: ["dongjing-2"] },
      { id: "song-short-cash", title: "汴京行市中的钱陌", kind: "货币", text: "《东京梦华录》卷三并列官用、街市与各类交易所用的不同钱陌。书中金额与实际点钱须辨语境，不能把所有买卖都写成完全相同的足陌，也不在本卡强定折算。", keywords: ["钱陌", "短陌", "付钱", "铜钱", "交易"], sourceIds: ["dongjing-3"] },
      { id: "song-hiring", title: "雇工与行老", kind: "制度", text: "《东京梦华录》卷三记雇作匠、酒食等人力可由行老介绍。需要雇人时可写寻找具体行当的中介，不凭本条补造工资、契约条款或所有人的身份自由。", keywords: ["行老", "雇工", "作匠", "雇人", "牙人"], sourceIds: ["dongjing-3"] },
      { id: "song-fire-watch", title: "汴京的巡铺与望火楼", kind: "制度", text: "《东京梦华录》卷三记军巡铺夜间巡警、高处望火楼及灭火器具，火起后有官军救扑。写城内火警时可区分报火、巡警和救扑，不借此给某条街编造固定驻兵。", keywords: ["军巡铺", "望火楼", "火警", "巡夜", "救火"], sourceIds: ["dongjing-3"] },
    ],
    sources: [
      { id: "dongjing-2", title: "《东京梦华录》卷二·州桥夜市等（原典转录）", url: "https://zh.wikisource.org/wiki/東京夢華錄/卷二", accessed: ACCESSED, covers: "汴京特定街区的夜市、饮食和时段；不支持全国夜禁结论。" },
      { id: "dongjing-3", title: "《东京梦华录》卷三·都市钱陌、雇觅人力、防火（原典转录）", url: "https://zh.wikisource.org/wiki/東京夢華錄/卷三", accessed: ACCESSED, covers: "钱陌差异、行老供雇、军巡铺与望火楼。" },
    ],
  },
  {
    id: "life-ming-chongzhen", version: "1.0.0", title: "明崇祯京师生活札记", period: "明末 · 北京及相关制度",
    scope: "以崇祯故事为场景，补充京府官署称谓、城市事务、银钱与官服辨识。",
    note: "《明史》为后修史书，职官条目含制度沿革，不能当某一天的完整官员名单。服饰实物和钱币记载只支持相应专题；不覆盖各地物价、司法细则或崇祯全朝时局。",
    skills: ["historical-world"],
    cards: [
      { id: "ming-shuntian", title: "京府与京县官名", kind: "制度", text: "《明史》职官志列顺天府尹、府丞及所辖宛平、大兴二县。北京地方事务须辨府与县，不把顺天府、京县、内阁混成同一衙门；具体任职者另查。", keywords: ["顺天府", "府尹", "宛平", "大兴", "京县", "北京"], sourceIds: ["ming-offices"] },
      { id: "ming-five-cities", title: "五城兵马司的事务", kind: "制度", text: "《明史》记五城兵马指挥司涉及京城巡捕、街道沟渠与火禁等事。可作京师治安和市政场景的依据，不将其等同锦衣卫或东厂，也不据此补全每案的审判权限。", keywords: ["兵马司", "五城", "火禁", "巡捕", "街道", "沟渠"], sourceIds: ["ming-offices"] },
      { id: "ming-money-context", title: "明末银钱不能一概定价", kind: "货币", text: "《明史》食货志记晚明银钱并用及钱式、折值的变化，崇祯铸钱也有不同定值。写交易应分清银两与铜钱；本卡不把一两银恒等于一千文，不改本局既有计账规则。", keywords: ["白银", "银两", "铜钱", "折值", "通宝", "铸钱"], sourceIds: ["ming-money"] },
      { id: "ming-rank-badge", title: "明代官服的胸背纹样", kind: "生活", text: "明代品官服饰以胸背鸟兽纹样区别等级，通常文官用飞禽、武官用走兽。衣服、品秩与场合需一起核对；不能只凭一件华服猜出人物官职。", keywords: ["官服", "胸背", "补子", "品秩", "衣冠"], sourceIds: ["palace-ming-dress"] },
    ],
    sources: [
      { id: "ming-offices", title: "《明史》卷七十四·职官三（原典转录）", url: "https://zh.wikisource.org/wiki/明史/卷74", accessed: ACCESSED, covers: "顺天府、宛平大兴及五城兵马指挥司职务；沿革不等于当日实况。" },
      { id: "ming-money", title: "《明史》卷八十一·食货五（原典转录）", url: "https://zh.wikisource.org/wiki/明史/卷81", accessed: ACCESSED, covers: "晚明银钱、钱式及崇祯铸钱折值变化；不提供固定物价换算。" },
      { id: "palace-ming-dress", title: "中国 蓝地织金狮纹方补，国立故宫博物院，台北（说明摘述，CC BY 4.0）", url: "https://digitalarchive.npm.gov.tw/Collection/Detail/192?dep=X", accessed: ACCESSED, covers: "17世纪实物及馆方对明代胸背纹样、文武品秩的说明；器物不精确定年为崇祯。" },
    ],
  },
];
