// Ready-made challenges (R14, docs/plans/R14_PLAY_MODES.md §2): one tap fills
// the premise, the protagonist and the challenge on the new-story screen, and
// every field stays editable. Varied on purpose: four periods of history and
// four original worlds; different classes; women, men and identities open to
// either. Gender is fixed only when the identity implies it (寡居的长媳, 县尉,
// 长子, 女伯爵); otherwise `gender` is null, the texts stay gender-neutral and
// the name follows the gender the player picks.
import type { Arrival } from "./templates";

export interface ChallengeCard {
  id: string;
  /** History opens a historical world; free opens an original one. */
  mode: "history" | "free";
  title: string;
  /** Short label on the card: the period, or the kind of world. */
  era: string;
  /** Built-in era pack, when one exists for the period. */
  eraId: string | null;
  /** One line under the title. */
  blurb: string;
  premise: string;
  gender: "男" | "女" | null;
  /** A neutral identity has a name for either gender. */
  name: string | { 男: string; 女: string };
  age: number;
  identity: string;
  arrival: Arrival;
  /** Who the protagonist was before the crossing, when there is one. */
  origin?: string;
  /** What the first scene should show. */
  hint: string;
  challenge: { goal: string; limit: string; failIf: string };
}

export const CHALLENGES: ChallengeCard[] = [
  {
    id: "ming-redeem-house", mode: "history", title: "赎回祖宅", era: "明 · 崇祯十五年", eraId: null,
    blurb: "三个月，凑够三百两，赎回典出去的祖宅。",
    premise: "崇祯十五年秋，苏州。北方流寇四起，清兵几度入塞，江南却依旧笙歌不辍，只是米价一月三涨，阊门外的铺面一家接一家关张。城东沈家原是书香门第，家主病故后，族中叔伯分走了田产，只留下一座三进的祖宅，去年又为还债典给了广源当铺：典银三百两，典期一年，逾期不赎，宅子便归当铺。如今离期满只剩三个月，当铺的朝奉已经放出话来，说有位徽州盐商看中了这处宅院。",
    gender: "女", name: "顾湘君", age: 26,
    identity: "你是沈家守寡三年的长媳，上有多病的婆婆，下有一个八岁、还要读书的小叔子。家里值钱的东西早已当尽，你手头只剩七两碎银、一手好针线，和亡夫留下的一本旧账册，账上似乎还有几笔没收回来的欠款。",
    arrival: "魂穿", origin: "会计师",
    hint: "广源当铺的朝奉领着那位徽州盐商登门，说要“看看宅子”。",
    challenge: { goal: "凑够三百两银子，赎回沈家祖宅", limit: "三个月", failIf: "当铺提前把祖宅转卖给别人" },
  },
  {
    id: "tang-west-market", mode: "history", title: "西市招牌", era: "唐 · 天宝七载", eraId: "tang-748",
    blurb: "一年之内，在长安西市挂出自己的招牌。",
    premise: "天宝七载冬，长安。西市里二百二十行，胡商云集，珠宝、香料、绢帛、药材堆满了邸店，一间临街铺面的年租抵得上寻常人家几年的口粮。市署管得严，开铺要有同行作保，还得在市署立契，外来的生面孔往往连门路都摸不着。年关将近，几家老字号的东家在打听买主，说是要把北街的几间旧铺面转手。坊间都说，能在西市站住脚的人，十年后就是长安的富户。",
    gender: null, name: { 男: "康思远", 女: "康明月" }, age: 19,
    identity: "你是粟特商人的遗孤，父亲的驼队去年折在了沙州道上，货没了，人也没了。你会说胡汉两种话，一眼就认得出香料的成色，如今在一家胡饼铺帮工度日，攒下的钱不过三贯。父亲生前常说：在长安，有了自己的铺子，才算有了根。",
    arrival: "不穿越",
    hint: "胡饼铺的掌柜悄悄告诉你，北街有间香料铺要转手，东家只等三天。",
    challenge: { goal: "在西市有一间自己的铺子，挂上自己的招牌", limit: "一年", failIf: "被市署逐出西市，或欠下还不起的债" },
  },
  {
    id: "song-hold-the-city", mode: "history", title: "孤城十日", era: "北宋 · 靖康元年", eraId: null,
    blurb: "守住孤城十日，等援军到来。",
    premise: "靖康元年冬，河北西路。金兵第二次南下，沿途州县望风而溃。安平县是通往真定府的一座小城，城墙年久失修，守军不足五百，大半是临时招来的乡兵；城里除了本县百姓，还挤满了从北边逃来的难民，粮价一日三涨。知县昨夜带着印信不知所踪，真定府的援军最快也要十日才到。护城河已经结了薄冰，城外，金军的游骑正在砍伐树木，赶造云梯。",
    gender: "男", name: "陈彦章", age: 31,
    identity: "你是安平县的县尉，管着县里的弓手和捕快，平日里抓得最多的是偷牛贼。知县一走，满城的人都看向你。你手里有三百多个兵、半仓粮食、几十架床弩，还有一座一夜之间就要你来做主的城。",
    arrival: "魂穿", origin: "退伍军人",
    hint: "城头的鼓声把你惊醒，有人跑来报信：知县跑了，金军的旗号已经看得见了。",
    challenge: { goal: "守住安平县城，撑到援军到来", limit: "十日", failIf: "城破，或你弃城而走" },
  },
  {
    id: "han-flee-south", mode: "history", title: "南下避祸", era: "东汉 · 中平元年", eraId: null,
    blurb: "赶在黄巾起事之前，带全家离开巨鹿。",
    premise: "东汉中平元年正月，冀州巨鹿郡。连年疫病旱蝗，豪强兼并，百姓卖儿鬻女；太平道的符水传遍八州，乡里的青壮夜里成群去听“大贤良师”讲道，官府和豪族的门上被人用白土写下“甲子”二字。郡里只当是愚民迷信，照旧催逼赋税。你很清楚，再过一个多月，这里就会燃起遍地烽火，随后是几十年的兵荒马乱。往南去要渡黄河、过颍川，一家老小只有一辆牛车，走得再快也要一个多月。",
    gender: "男", name: "李衡", age: 18,
    identity: "你是巨鹿城外一户自耕农家的长子，父亲早逝，家里有祖母、母亲、两个弟弟和一个还在襁褓里的妹妹，还有三十亩薄田和一头老牛。叔父已经入了太平道，正劝全家一起去“受符”。",
    arrival: "魂穿", origin: "历史系研究生",
    hint: "叔父领着太平道的人进了院子，要给全家施符水。",
    challenge: { goal: "赶在黄巾起事前离开巨鹿，带全家六口平安到达南阳", limit: "四十天", failIf: "家里有人死去或失散" },
  },
  {
    id: "xianxia-clear-master", mode: "free", title: "三十日洗冤", era: "仙侠", eraId: null,
    blurb: "宗门公审之前，找出真凶，替师父洗冤。",
    premise: "云岫山有七峰，是人与灵兽共居的修行之地，各峰自有传承，明争暗斗已有百年。半月前，镇守藏经阁的长老死在本门剑诀之下，现场留下一枚刻着你师父名号的玉佩。执法堂当即封了你们所在的落霞峰，把师父押进寒狱，定于三十日后的宗门大典上公审：若无新证，便废去修为，逐出山门。落霞峰本就人丁稀落，如今更是人人避之不及，连送饭的杂役都绕道走。",
    gender: null, name: { 男: "林云舟", 女: "林云舒" }, age: 17,
    identity: "你是落霞峰唯一的弟子，资质平平，入门五年才堪堪练气，平日替师父照看药圃、喂养一只脾气古怪的白鹤。师父被押走前，只来得及对你说了一句：“去后山的石洞里，看看那盏灯还亮不亮。”",
    arrival: "不穿越",
    hint: "执法堂的人刚走，那只白鹤就叼着一角烧焦的符纸，落在你的脚边。",
    challenge: { goal: "在宗门公审之前找出真凶，洗清师父的罪名", limit: "三十日", failIf: "师父被废去修为，或你也被定为同党" },
  },
  {
    id: "wasteland-winter-camp", mode: "free", title: "寒潮之前", era: "末世重建", eraId: null,
    blurb: "九十天，在寒潮到来前建起能过冬的营地。",
    premise: "大断电后的第三年，北方平原。城市早已空了，幸存者三五成群，沿着废弃的公路和河道迁徙，用旧零件换药品，用罐头换子弹。气象站残存的数据显示，今年的寒潮比往年早：三个月后，气温会骤降到零下三十度，没有屋顶、没有火、没有存粮的人，都熬不过这个冬天。你们这支队伍刚在一座废弃的水电站旁停下脚步：厂房还算结实，屋顶却塌了一半，最近的镇子在二十公里外。",
    gender: null, name: { 男: "周远", 女: "周遥" }, age: 34,
    identity: "你是这支十二人队伍里说话最管用的人，大断电前在气象站当技术员，会修发电机，看得懂云，却从没带过人。队伍里有老人，有孩子，有一个总想单干的猎户，还有一个来历不明、怎么也不肯交出背包的年轻人。",
    arrival: "不穿越",
    hint: "傍晚，猎户从水电站里钻出来，说里面有人住过，灶灰还是温的。",
    challenge: { goal: "在寒潮到来前建起能让十二个人过冬的营地：有屋顶、有火、有存粮", limit: "九十天", failIf: "有人冻死或饿死，或者队伍散了伙" },
  },
  {
    id: "fantasy-forty-day-truce", mode: "free", title: "四十日和约", era: "奇幻", eraId: null,
    blurb: "停战四十日，谈成和约，否则烽烟再起。",
    premise: "白鸦王国与草原上的风语部族打了七年仗，边境的麦田荒了一半，两边都已经打不动了。在神殿的调停下，双方定下四十日的停战：使团在中立的盐湖城会面，期满若签不下和约，大军就要再度开拔。王都的主战派并不想看到和约，草原上也有人等着用一场大胜去换族长之位。草原人敬重守信的人，也记仇；王国的贵族们更看重脸面。盐湖城的客栈里，各方的耳目比商人还多。",
    gender: "女", name: "薇拉·洛恩", age: 23,
    identity: "你是白鸦王国最年轻的女伯爵，领地正在边境线上，七年里被烧过三次。国王把你派来当议和使节，一半因为你懂草原话，一半因为没人愿意来。你带着十名护卫、一份底线写得很死的国书，还有上辈子当谈判律师练出来的一张嘴。",
    arrival: "投胎", origin: "律师",
    hint: "抵达盐湖城的头一晚，草原使团派人送来一只烤羊，羊腹里藏着一封没有署名的信。",
    challenge: { goal: "在停战期满之前，让两国签下和约", limit: "四十天", failIf: "停战期内战事重开，或你被对方扣押" },
  },
  {
    id: "wuxia-dark-escort", mode: "free", title: "暗镖", era: "武侠", eraId: null,
    blurb: "二十日，把一趟要命的暗镖送到洛阳。",
    premise: "这是一个架空的江湖：漕帮、盐枭、名门正派和官府各占一方。扬州的长风镖局是家老字号，三年前总镖头死在一趟镖上，生意一落千丈，只剩几个老镖师撑着门面。三天前，一位蒙面客人送来一只铁匣，出价一千两，要在二十日内送到洛阳城南的白马寺，交给一个“认得这只匣子的人”。不许问匣中何物，也不许走漏风声。从扬州到洛阳，水路要过漕帮的地盘，旱路要穿盗匪出没的伏牛山。",
    gender: null, name: { 男: "沈怀远", 女: "沈若霜" }, age: 21,
    identity: "你是长风镖局的少当家，刀法是父亲手把手教的，跟着跑过几趟短镖，却从没自己担过一趟。镖局账上只剩八十两，几个老镖师各有心思。这一千两的镖金是镖局翻身的最后机会，这只铁匣，也可能是父亲当年那趟镖的另一半。",
    arrival: "不穿越",
    hint: "出发前夜，镖局门口来了个挑货担的瞎眼老人，问你这趟镖走哪条道。",
    challenge: { goal: "把铁匣送到洛阳白马寺，交到收镖人手里", limit: "二十日", failIf: "铁匣被劫走，或镖局有人因此丧命" },
  },
];

/** The protagonist's name on a card for the gender the player has. */
export function challengeName(card: ChallengeCard, gender: "男" | "女"): string {
  return typeof card.name === "string" ? card.name : card.name[card.gender ?? gender];
}
