// Draft era pack for R02 (Tang, Tianbao 7 / 748, Chang'an). The full era-pack
// format arrives in R03 (docs/PLAN_V3.md §3.3, D111); this draft only holds
// what the R02 prompts and opening need. Facts are AI-drafted, spot-checked,
// and kept vague where unsure.
import { TANG_CURRENCY } from "../../engine/money";
import type { EraDraft } from "./types";

export const TANG_748: EraDraft = {
  id: "tang-748",
  title: "唐 · 天宝七载 · 长安",
  blurb: "盛世余晖下的长安。西市胡商云集，杨氏兄妹权势日盛，边镇节度使拥兵渐重。",
  startLabel: "天宝七载（戊子）冬月",
  startHour: 7,
  currency: TANG_CURRENCY,
  startMoney: 300,
  promptExcerpt: `【时代】唐玄宗天宝七载（748年，戊子年）冬，长安。
- 货币：开元通宝铜钱，以“文”计，一贯（缗）为一千文；绢帛也常作货币。日常不以银两计价。
- 物价参考：胡饼一枚约三文，粗米一斗约二三十文，邸店一宿约三十文，搬货短工一日约五六十文，驽马一匹约十贯。
- 计时：一昼夜十二时辰，一时辰为两小时；一刻为十五分钟。坊门、市门以鼓声开闭，夜间宵禁，犯夜要受罚。
- 城市：东市多权贵，西市多胡商；百姓住在坊内，坊有坊门。
- 称谓：称年轻男子为“郎君”或“某郎”，女子为“娘子”；自称“某”“儿”（女子）；称父亲为“阿耶”，母亲为“阿娘”；官员称“明府”“少府”等，不称“大人”。
- 时代大势：李林甫为相，杨贵妃得宠、杨国忠渐起；安禄山兼领边镇。重要人物是否出场、如何出场，要符合主角的身份与处境。`,
  taboos: [
    "算盘（唐代计数用算筹）", "银票、交子（宋以后才有）", "以银两作日常货币", "辣椒、玉米、番薯、土豆、烟草（美洲作物，明以后传入）",
    "太师椅（宋以后）", "官员称“大人”、太监自称“奴才”（清代习惯）", "秀才、举人作为功名等级（明清）", "火柴、眼镜",
    "“奉天承运”诏书开头（明清）", "知府、巡抚等官名（宋以后）",
  ],
};
