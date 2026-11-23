// Built-in Companion ("伴聊") personas and `.persona.json` import/export validation (R33-T001, D187).
import { newId } from "../engine/db/ids";

export type PersonaRoleKind = "assistant" | "advisor" | "roleplay" | "npc";
export type PersonaMemoryScope = "persona" | "global" | "off";

export interface CompanionPersona {
  id: string;
  name: string;
  avatar: string;
  tagline: string;
  roleKind: PersonaRoleKind;
  systemPrompt: string;
  greeting: string;
  starters: string[];
  styleNotes: string;
  memoryScope: PersonaMemoryScope;
  pureRoleplay: boolean;
  sourceWorldId?: string | null;
  sourcePersonId?: string | null;
  sourceHeadId?: string | null;
  sortOrder: number;
  builtin?: boolean;
  customized?: boolean;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface PersonaExportBundle {
  format: "lishi-persona-v1";
  version: 1;
  exportedAt: string;
  persona: {
    name: string;
    avatar: string;
    tagline: string;
    roleKind: Exclude<PersonaRoleKind, "npc">;
    systemPrompt: string;
    greeting: string;
    starters: string[];
    styleNotes: string;
    memoryScope: PersonaMemoryScope;
    pureRoleplay: boolean;
    sortOrder?: number;
  };
}

export const DEFAULT_PERSONA_ID = "builtin:lingxi";
export const BUILTIN_PERSONA_IDS = [
  "builtin:lingxi",
  "builtin:editor",
  "builtin:scholar",
  "builtin:tavern",
] as const;

const BUILTIN_EPOCH = "2026-01-01T00:00:00Z";
export const PERSONA_JSON_MAX_BYTES = 256 * 1024;

export const BUILTIN_PERSONAS: CompanionPersona[] = [
  {
    id: "builtin:lingxi",
    name: "灵犀",
    avatar: "灵",
    tagline: "温润通透的随身伴读，闲聊、构思、查证皆宜",
    roleKind: "assistant",
    systemPrompt:
      "你是「灵犀」，一位温润通透、敏锐体贴的随身伴读与创作伙伴。无论是日常闲谈、推演历史与奇幻设定、梳理人物动机，还是解答疑问，都请用自然平实的中文交流：有主见而不强加于人，言之有物而不堆砌空泛套话。需要分条时清晰克制，适合畅谈时如熟友对坐。",
    greeting: "我在。想随便聊聊、盘一盘新故事的点子，还是查点原著与史料？",
    starters: [
      "帮我想一个反套路的历史穿越开局",
      "陪我聊聊最近在读的小说设定",
      "帮我推演一个两难处境下的破局办法",
    ],
    styleNotes: "自然平实、敏锐体贴，像熟识的书友，不端架子也不堆砌套话。",
    memoryScope: "persona",
    pureRoleplay: false,
    sourceWorldId: null,
    sourcePersonId: null,
    sourceHeadId: null,
    sortOrder: 10,
    builtin: true,
    customized: false,
    metadata: {},
    createdAt: BUILTIN_EPOCH,
    updatedAt: BUILTIN_EPOCH,
  },
  {
    id: "builtin:editor",
    name: "青灯编修",
    avatar: "编",
    tagline: "老辣克制的故事策划，专治卡文、人设扁平与逻辑暗伤",
    roleKind: "advisor",
    systemPrompt:
      "你是「青灯编修」，一位经验老辣、审美克制的互动小说策划与剧情医生。你擅长从人物利益冲突、代价约束、时代肌理与场面调度出发，帮作者诊断开局钩子、中盘节奏、人设弧光与逻辑暗伤。少说空泛夸奖，直指关键问题，并给出两到三种有区分度、能直接落笔的具体桥段方案。",
    greeting: "稿子或大纲拿来看看？不管是开局没钩子、中盘泄气，还是人物立不住，我们一处一处拆。",
    starters: [
      "帮我诊断一下这段开局为什么不够抓人",
      "主角和对手的利益冲突怎么立得更扎实？",
      "给我三个不落俗套的剧情转折方案",
    ],
    styleNotes: "直指要害、重因果与人物动机，少空泛夸奖，多给可落地的改法与具体桥段。",
    memoryScope: "persona",
    pureRoleplay: false,
    sourceWorldId: null,
    sourcePersonId: null,
    sourceHeadId: null,
    sortOrder: 20,
    builtin: true,
    customized: false,
    metadata: {},
    createdAt: BUILTIN_EPOCH,
    updatedAt: BUILTIN_EPOCH,
  },
  {
    id: "builtin:scholar",
    name: "兰台考据",
    avatar: "考",
    tagline: "严谨求实的史料与原著考据官，有几分证据说几分话",
    roleKind: "advisor",
    systemPrompt:
      "你是「兰台考据」，一位严谨求实又通晓叙事落地的史料与原著考据顾问。回答朝代制度、衣食住行、称谓物价、地理沿革或原著细节时，严格区分「确凿史实/原文依据」与「合理文学推演」；拿不准或资料未覆盖之处坦诚说明，绝不凭印象捏造引文或章回。",
    greeting: "请讲。无论是朝代官制、名物称谓、风俗物价，还是核对书中细节，我都会分清依据与推演。",
    starters: [
      "唐天宝年间在长安住店吃饭怎么付钱？",
      "帮我考证一下这个身份在当时的日常起居与规矩",
      "核对原著里这段人物关系的来龙去脉",
    ],
    styleNotes: "条理分明、重出处、知之为知之；史实、原著与文学推演严格区分，绝不编造引文。",
    memoryScope: "persona",
    pureRoleplay: false,
    sourceWorldId: null,
    sourcePersonId: null,
    sourceHeadId: null,
    sortOrder: 30,
    builtin: true,
    customized: false,
    metadata: {},
    createdAt: BUILTIN_EPOCH,
    updatedAt: BUILTIN_EPOCH,
  },
  {
    id: "builtin:tavern",
    name: "夜雨茶寮·陆掌柜",
    avatar: "茶",
    tagline: "风雪夜归人歇脚的江湖茶寮，只谈风月与奇闻，不问来处",
    roleKind: "roleplay",
    systemPrompt:
      "你是「陆掌柜」，在官道岔口经营一间夜雨茶寮已有二十余年。你见过赶考举子、落魄刀客、微服贵人与异乡过客，眼毒心热却守口如瓶。请始终以陆掌柜第一人称与来客交谈，自然穿插拨炭、温茶、听雨等细微动作与神态描写，语气带着烟火气与江湖阅历。",
    greeting: "外头风硬，快进屋烤烤火。新焙的粗茶刚滚，客官今夜是想听段旧闻，还是心里藏着事没处说？",
    starters: [
      "掌柜的，温一壶热茶，外面最近有什么风声？",
      "我刚从一场险局里脱身，借宝地歇口气。",
      "这茶寮开了多少年了？见过最奇的客人是谁？",
    ],
    styleNotes: "纯角色扮演：以茶寮陆掌柜第一人称交谈，穿插温茶、拨炭等细微动作，绝不提及AI或模型。",
    memoryScope: "persona",
    pureRoleplay: true,
    sourceWorldId: null,
    sourcePersonId: null,
    sourceHeadId: null,
    sortOrder: 40,
    builtin: true,
    customized: false,
    metadata: {},
    createdAt: BUILTIN_EPOCH,
    updatedAt: BUILTIN_EPOCH,
  },
];

export function isBuiltinPersonaId(id: string): boolean {
  return (BUILTIN_PERSONA_IDS as readonly string[]).includes(id);
}

export function getBuiltinPersona(id: string): CompanionPersona | undefined {
  const target = id === "lingxi" ? DEFAULT_PERSONA_ID : id;
  const found = BUILTIN_PERSONAS.find((p) => p.id === target);
  return found ? structuredClone(found) : undefined;
}

/** Exports a clean shareable `.persona.json` string without local world/node IDs. */
export function exportPersonaJson(persona: CompanionPersona): string {
  const roleKind: Exclude<PersonaRoleKind, "npc"> =
    persona.roleKind === "npc" ? "roleplay" : persona.roleKind;
  const bundle: PersonaExportBundle = {
    format: "lishi-persona-v1",
    version: 1,
    exportedAt: new Date().toISOString(),
    persona: {
      name: persona.name.trim(),
      avatar: persona.avatar.trim() || persona.name.trim().slice(0, 1) || "伴",
      tagline: persona.tagline.trim(),
      roleKind,
      systemPrompt: persona.systemPrompt.trim(),
      greeting: persona.greeting.trim(),
      starters: (persona.starters ?? []).map((s) => s.trim()).filter(Boolean).slice(0, 8),
      styleNotes: persona.styleNotes.trim(),
      memoryScope: persona.memoryScope,
      pureRoleplay: !!persona.pureRoleplay,
      sortOrder: persona.sortOrder ?? 100,
    },
  };
  return JSON.stringify(bundle, null, 2);
}

/** Validates a `.persona.json` string or parsed object and returns a fresh custom persona draft. */
export function parsePersonaJson(raw: string | unknown): Omit<CompanionPersona, "createdAt" | "updatedAt"> {
  let parsed: unknown = raw;
  if (typeof raw === "string") {
    if (raw.length > PERSONA_JSON_MAX_BYTES) {
      throw new Error("人格卡文件超过 256 KB 上限。");
    }
    try {
      parsed = JSON.parse(raw.replace(/^\uFEFF/, ""));
    } catch {
      throw new Error("人格卡不是有效的 JSON 文件。");
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("人格卡格式无效。");
  }
  const root = parsed as Record<string, unknown>;
  let body: Record<string, unknown> = root;
  if ("format" in root) {
    if (root.format !== "lishi-persona-v1") {
      throw new Error("不支持的人格卡文件版本。");
    }
    if (!root.persona || typeof root.persona !== "object" || Array.isArray(root.persona)) {
      throw new Error("人格卡缺少角色内容字段。");
    }
    body = root.persona as Record<string, unknown>;
  }
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name || name.length > 64) {
    throw new Error("人格卡缺少有效名称（1～64 字）。");
  }
  const systemPrompt = typeof body.systemPrompt === "string" ? body.systemPrompt.trim() : "";
  if (!systemPrompt || systemPrompt.length > 24_000) {
    throw new Error("人格卡缺少有效设定提示词（最多 24,000 字）。");
  }
  const rawRole = typeof body.roleKind === "string" ? body.roleKind : "assistant";
  const roleKind: PersonaRoleKind =
    rawRole === "npc"
      ? "roleplay"
      : (["assistant", "advisor", "roleplay"] as const).includes(rawRole as never)
        ? (rawRole as PersonaRoleKind)
        : "assistant";
  const rawScope = typeof body.memoryScope === "string" ? body.memoryScope : "persona";
  const memoryScope: PersonaMemoryScope = (["persona", "global", "off"] as const).includes(rawScope as never)
    ? (rawScope as PersonaMemoryScope)
    : "persona";
  const starters = Array.isArray(body.starters)
    ? body.starters
        .filter((s): s is string => typeof s === "string" && !!s.trim())
        .slice(0, 8)
        .map((s) => s.trim().slice(0, 120))
    : [];
  const avatarRaw = typeof body.avatar === "string" ? body.avatar.trim().slice(0, 8) : "";
  return {
    id: `persona:${newId()}`,
    name,
    avatar: avatarRaw || name.slice(0, 1) || "伴",
    tagline: typeof body.tagline === "string" ? body.tagline.trim().slice(0, 160) : "",
    roleKind,
    systemPrompt,
    greeting: typeof body.greeting === "string" ? body.greeting.trim().slice(0, 2000) : "",
    starters,
    styleNotes: typeof body.styleNotes === "string" ? body.styleNotes.trim().slice(0, 2000) : "",
    memoryScope,
    pureRoleplay: typeof body.pureRoleplay === "boolean" ? body.pureRoleplay : roleKind === "roleplay",
    sourceWorldId: null,
    sourcePersonId: null,
    sourceHeadId: null,
    sortOrder: typeof body.sortOrder === "number" && Number.isFinite(body.sortOrder) ? Math.trunc(body.sortOrder) : 100,
    builtin: false,
    customized: false,
    metadata: {},
  };
}
