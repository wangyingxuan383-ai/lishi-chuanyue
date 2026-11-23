// Optional writing tools. No story turn is generated and nothing is saved until adoption.
import type { SourceScope } from "../sources/scope";
import { remapContinuity, validateContinuity } from "../continuity";
import type { Game } from "../game";
import { ChatError, DEFAULT_TIMEOUTS, retryDecision, CONTEXT_WINDOW_MESSAGE, isContextWindowError, outputWasTruncated, streamChat, type ChatHandle, type ChatMessage, type ChatResult } from "../llm/chat";
import { isRefusal } from "../llm/refusal";
import * as tree from "../tree";
import type { ActionMode, FactCitation, StoryNode, World, WorldState, WorldSettings } from "../types";
import { openingExtra, recordFields } from "../prompt/turn";
import { validBinding, type ReferenceContext } from "../sources/types";
import { chunksOf, getBook } from "../sources/library";
import { applyRecord, type TurnRecord } from "../state/apply";
import { eraContext, eraPack } from "../era";
import { formatDate, readDate } from "../calendar/date";
import { parseMoney } from "../money";
import { newId, staleChaptersStatement, type NewNode } from "../db/repo";
import { matchName } from "../state/names";
import { packCards } from "../era/card";
import { packTimeline } from "../timeline";
import { isFortune } from "../fortune";
import { completeJson, parseRecord } from "../record/parse";

/** writing-4: the version is kept with each adopted rewrite; it is not sent to the model. */
export const WRITING_PROMPT_VERSION = "writing-4";
export const CANON_WRITING_PROMPT_VERSION = "writing-canon-6";
export function canonCorrectionRules(settings: WorldSettings, state: WorldState, opening = false): string {
  return `对这个回合按原著纠错。遵循原著技能已随本次任务附上，按它的方法核对；下面已给出相关原文片段和札记，先用它们，不够再搜索、阅读原文，必要时补查邻段。核对身份、关系、称谓、时间、地点、物品和事件。玩家明确改变的事实及合理后果保留，AI自行写错不等于玩家改写。独立查证可同批完成，沿检索返回编号阅读，复用已读证据。只预览，不改当前路线。
结果分四种，写在 outcome 里：
- changed：选中范围里有与原著不符、且有原文依据的地方。只改选中范围，允许按要求补全遗漏，不续写其后，范围外正文由程序原样保留；原回合记录默认保留，只对受影响的字段返回最小 recordPatch（数组只给受影响项目）；每条更正写进 corrections，citations 引自已读原文；继承的 profile/people/place/places/cards 有错时用 correctionPatch 校正。
- verified：核对后这段与原著一致，不用改。findings 写核对了什么，citations 附原文。
- answer：玩家在提问（比如“城门几时关？”“他俩是什么关系？”）。answer 写答案，findings 附原文出处；不改正文。
- not_found：读过的原文里没有这件事的依据（比如它是本局自己的设定或玩家的分支）。把缺什么写进 unresolved，不要凭记忆补原著细节。
跨回合问题放 related。引文只能逐字摘自已读原文；玩家分支不是原著证据，不放进 corrections，也不伪造引文。
最后只返回一个 JSON 对象（不要加代码块或额外说明）：{"outcome":"changed/verified/answer/not_found","replacement":"changed 时为选中范围的替换正文","recordPatch":{},"correctionPatch":{},"corrections":[{"detail":"有原著依据的更正说明","citations":[{"section":0,"chunk":0,"quote":"实际读到的原句"}]}],"findings":[{"detail":"核对结果或答案要点","citations":[{"section":0,"chunk":0,"quote":"实际读到的原句"}]}],"answer":"answer 时的答案","related":["关联问题"],"unresolved":["待核对问题"]}。recordPatch 只记录本回合实际变化，不返回 read_world 的 WorldState，不包含 protagonist/source/facts/executionMode/setStats 等整局字段；需要删除本回合误记的 items/people/goals 项目时写 {"name":"原名","remove":true}，替换名称时写 {"oldName":"原名","name":"新名",...}。time 写本回合经过多久，money 写增减，choices 为文字数组。字段沿用正常回合：\n${recordFields(settings, state)}\n${opening ? openingExtra(settings) : ""}`;
}
export interface WritingAnchor { worldId: string; lineId: string; headId: string; nodeId: string; original: string }
export interface TextRange { start: number; end: number }
export type WritingPurpose = "style" | "factCorrection";
export interface CanonCorrectionRequest {
  anchor: WritingAnchor;
  range: TextRange;
  hint: string;
  /** Explicitly supplied initial information for a legacy opening that has no saved seed. */
  baseline?: WorldState;
  /** 资料范围 (D184): only these notes or chapters; absent is 自动. */
  scope?: SourceScope;
}
export interface CanonCorrectionPreview {
  anchor: WritingAnchor;
  sourceGuard: string;
  narrative: string;
  writingVersion?: string;
  record: TurnRecord;
  recordChanges?: { name: string; before: string; after: string }[];
  correctionPatch?: TurnRecord;
  range?: TextRange;
  replacement?: string;
  unresolved?: string[];
  related?: string[];
  corrections: { detail: string; citations: FactCitation[] }[];
  /** D182: absent in previews from before, which were always changes. */
  outcome?: CanonOutcome;
  findings?: { detail: string; citations: FactCitation[] }[];
  answer?: string;
  reason?: "no_excerpt" | "out_of_range" | "no_basis";
  /** What was looked up, grouped: “比试（2 次，命中 3 段）”. */
  searched?: { tool: string; query: string; hits: number; times: number }[];
  /** How many original passages were actually read. */
  read?: number;
  preservedPlayerFacts?: { id: string; detail: string }[];
  reference: ReferenceContext;
  baseline?: WorldState;
}
/** Player-facing preview of the actual record delta, without protocol JSON. */
export function correctionRecordChanges(before: TurnRecord | null, after: TurnRecord) {
  const names: Record<string, string> = { time: "经过时间", hour: "结束时刻", place: "地点", money: "钱的增减", stats: "属性", items: "物品", people: "人物", status: "身体状况", goals: "目标", log: "本回合记事", choices: "建议行动", died: "生死", deviation: "剧情变化", date: "日期" };
  const describe = (value: unknown): string => {
    if (value == null) return "未记录";
    if (typeof value === "boolean") return value ? "是" : "否";
    if (typeof value !== "object") return String(value);
    if (Array.isArray(value)) return value.map(describe).join("；") || "无";
    const v = value as Record<string, unknown>;
    return Object.entries(v).filter(([key]) => !["id", "source", "nodeId"].includes(key)).map(([key, item]) => `${({ name: "名称", role: "身份", note: "备注", delta: "增减", detail: "说明", op: "操作", health: "健康", energy: "精力", fame: "名望" } as Record<string, string>)[key] ?? key}：${describe(item)}`).join("，");
  };
  return [...new Set([...Object.keys(before ?? {}), ...Object.keys(after)])]
    .filter(key => JSON.stringify((before as Record<string, unknown> | null)?.[key]) !== JSON.stringify((after as Record<string, unknown>)[key]))
    .map(key => ({ name: names[key] ?? "其他记录", before: describe((before as Record<string, unknown> | null)?.[key]), after: describe((after as Record<string, unknown>)[key]) }));
}

export interface CanonCorrectionHandle {
  /** The native run, once started: a paused one can be resumed with it. */
  runId?: string;
  done: Promise<CanonCorrectionPreview>;
  cancel(): void;
  catchUp(): Promise<void>;
  /** Detaches the page; the native run continues. Explicit cancel is separate. */
  detach?(): void;
}
export interface CanonCorrectionRunner {
  runCanonCorrection(request: CanonCorrectionRequest, onText: (text: string) => void, resumeRunId?: string): CanonCorrectionHandle;
}
export interface OpeningBaselineInput {
  name: string; gender: string; age: string; identity: string; origin: string;
  date: string; money: string; place: string; items: string;
}

/** Only explicit player input and the original pack form a legacy opening seed. */
export function openingBaseline(world: Pick<World, "eraId" | "settings">, input: OpeningBaselineInput): WorldState {
  if (!input.name.trim() || !input.gender.trim() || !input.identity.trim() || !input.date.trim() || !input.money.trim()) throw new WritingError("请填好初始姓名、性别、身份、时间和金额；没有钱请填 0。");
  const pack = world.settings.mode === "free" ? null : eraPack(world.eraId), preset = pack ? packCards(pack) : { places: [], cards: [] };
  const age = input.age.trim() ? Number(input.age) : null;
  if (age !== null && (!Number.isSafeInteger(age) || age < 1)) throw new WritingError("年龄请填正整数；不确定可以留空。");
  const seed: WorldState = {
    version: 2, time: { start: input.date.trim(), date: null, elapsedMinutes: 0 }, placeId: null,
    protagonist: { name: input.name.trim(), aliases: [], gender: input.gender.trim(), age, identity: input.identity.trim(), origin: input.origin.trim(), cheat: "", stats: { money: 0, debt: 0, health: 80, energy: 70, fame: 10 }, statuses: [], items: [] },
    people: [], places: structuredClone(preset.places), cards: structuredClone(preset.cards), goals: [], deviations: [],
    era: { packId: pack?.id ?? null, mode: world.settings.mode ?? "history", clockStyle: world.settings.clockStyle ?? (world.settings.mode === "free" ? "elapsed" : "era"), ...(pack ? { calendar: structuredClone(pack.calendar), currency: structuredClone(pack.currency) } : {}) },
  };
  const era = eraContext(world.eraId, seed), money = parseMoney(input.money, era.currency);
  if (money === null || money < 0) throw new WritingError("初始金额无法识别，请填写 0 或这个世界的金额。");
  seed.protagonist.stats.money = money;
  if (seed.era.clockStyle !== "elapsed") seed.time.date = readDate(input.date, era.clock.rules);
  if (input.place.trim()) { const id = newId(); seed.places.push({ id, name: input.place.trim(), description: "玩家补充的开场前地点", source: "玩家" }); seed.placeId = id; }
  seed.protagonist.items = input.items.split("\n").map((line) => line.trim()).filter(Boolean).map((line) => {
    const match = /^(.*?)\s*[×x]\s*(\d+)\s*$/.exec(line);
    return { name: match?.[1].trim() || line, quantity: match ? Number(match[2]) : 1, unit: "", place: null, note: "玩家补充的初始物品" };
  });
  return seed;
}
export class WritingError extends Error {}
/** A correction that stopped without a preview; `runId` when it can go on (接着查). */
export class CanonStop extends WritingError {
  constructor(message: string, readonly runId?: string) { super(message); }
}
export const STALE_WRITING = "故事或原文已经变了，请重新打开这个工具。";
export const MISSING_OPENING_SEED = "这个旧开场没有保存初始信息，请先补齐开场前的主角、时间和钱物，再按原著纠错。";
export const MISSING_OPENING_SEED_REVISE = "这个旧开场没有保存初始信息，不能自动同步事实；请改用“只润色文字”。";
export const MISSING_OPENING_SEED_SYNC = "这个旧开场没有保存初始信息，不能同步事实；请点“只改文字”保留你的改写。";

/** `resumeRunId`: 接着查 on a correction that stopped at its allowance (D182). */
export function runCanonCorrection(game: Game, request: CanonCorrectionRequest, onText: (text: string) => void, resumeRunId?: string): CanonCorrectionHandle {
  const runner = game as Game & Partial<CanonCorrectionRunner>;
  if (!runner.runCanonCorrection) throw new WritingError("原著纠错尚未就绪，请稍后重试。");
  return runner.runCanonCorrection(request, onText, resumeRunId);
}

export function paragraphs(text: string): TextRange[] {
  return [...text.matchAll(/[^\r\n]+/g)].filter((m) => m[0].trim()).map((m) => ({ start: m.index!, end: m.index! + m[0].length }));
}
export function replaceRange(original: string, range: TextRange, replacement: string): string {
  if (range.start < 0 || range.end > original.length || range.start >= range.end || !replacement.trim()) throw new WritingError("先选一段文字。" );
  return original.slice(0, range.start) + replacement.trim() + original.slice(range.end);
}

export const isUpkeepEdit = (node: Pick<StoryNode, "kind" | "meta">): boolean =>
  node.kind === "edit" && node.meta.by === "AI" && node.meta.upkeep === true;

/** True when `headId` is `anchorHeadId` or only AI background 设定集整理 edits landed after it on the same path. */
export function headFollowsUpkeep(path: Pick<StoryNode, "id" | "kind" | "meta">[], anchorHeadId: string, headId: string | null | undefined): boolean {
  if (!headId) return false;
  if (headId === anchorHeadId) return true;
  const from = path.findIndex((n) => n.id === anchorHeadId);
  const to = path.findIndex((n) => n.id === headId);
  if (from < 0 || to <= from) return false;
  for (let i = from + 1; i <= to; i++) if (!isUpkeepEdit(path[i])) return false;
  return true;
}

export async function assertWritingAnchor(game: Game, anchor: WritingAnchor): Promise<WritingAnchor> {
  const world = await game.repo.getWorld(anchor.worldId);
  if (!world || world.archived || world.currentLineId !== anchor.lineId) throw new WritingError(STALE_WRITING);
  const [current, node] = await Promise.all([tree.cursor(game.repo, anchor.worldId), game.repo.getNode(anchor.nodeId)]);
  if (node?.worldId !== anchor.worldId || node.narrative !== anchor.original) throw new WritingError(STALE_WRITING);
  const path = await game.repo.path(current.head.id);
  if (!path.some((n) => n.id === anchor.nodeId)) throw new WritingError(STALE_WRITING);
  if (!headFollowsUpkeep(path, anchor.headId, current.head.id)) throw new WritingError(STALE_WRITING);
  return current.head.id === anchor.headId ? anchor : { ...anchor, headId: current.head.id };
}

export function writingMessages(kind: "rewrite" | "polish", text: string, hint: string, context: string, mode: ActionMode, range?: TextRange): ChatMessage[] {
  const task = kind === "rewrite"
    ? "只做文风润色，按玩家要求调整所选文字的措辞、节奏和描写。不改变已经发生的事实、人物决定、钱物数量、生死、时间与地点；保持原有叙事人称与说话人归属；要求涉及改事实时仍保留原事实。只输出替换这段的正文，不续写后续剧情，不加代码块或额外说明。"
    : `润色玩家还没发送的输入（方式：${({ do: "行动", say: "说话", write: "亲手写剧情", direct: "幕后要求", skip: "过些日子", continue: "继续" })[mode]}）。保持原意与人称，不替玩家添加决定，也不写行动结果。只输出润色后的输入，不加多余引号或额外说明。`;
  const required = `【要处理的文字】\n${text}\n\n【玩家要求】\n${hint.trim() || "让表达更自然流畅"}`;
  // The selected text already appears in the required part. Keep just the
  // neighbouring text as optional context.
  const offset = range && context.slice(range.start, range.end) === text ? range.start : context.indexOf(text);
  const nearby = offset < 0 ? context.slice(-1600) :
    context.slice(Math.max(0, offset - 800), offset) + "\n" + context.slice(offset + text.length, offset + text.length + 800);
  return [
    { role: "system", content: `${task}不要解释，不加标题、引号包装或记录块。` },
    { role: "user", content: nearby.trim() ? `【前后文，仅供参考】\n${nearby}\n\n${required}` : required, compactContent: required },
  ];
}

export interface WritingRequest { anchor: WritingAnchor; kind: "rewrite" | "polish"; text: string; hint: string; mode: ActionMode; range?: TextRange }

/** A model that answers in the turn format may append a <record> block; it never belongs in a rewrite. */
export const withoutRecord = (text: string) => text.replace(/<record[\s\S]*$/i, "").trimEnd();
/** Uses the same stream transport, auxiliary model, usage table and cancel protocol as Game. */
export function startWriting(game: Game, request: WritingRequest, onText: (text: string) => void) {
  let handle: ChatHandle | null = null;
  let cancelled = false;
  let rejectCancelled!: (e: Error) => void;
  const cancellation = new Promise<never>((_, reject) => { rejectCancelled = reject; });
  // Cancellation can precede the first asynchronous database read.
  void cancellation.catch(() => {});
  const done = (async () => {
    await assertWritingAnchor(game, request.anchor);
    if (cancelled) throw new ChatError("cancelled");
    const llm = game.llm;
    if (!llm) throw new WritingError("先在设置里连接 AI 服务。");
    const model = llm.auxModel || llm.model;
    let messages = writingMessages(request.kind, request.text, request.hint, request.anchor.original, request.mode, request.range);
    // Each actual attempt has its own usage row, including failed or cancelled attempts.
    for (let attempt = 1; ; attempt++) {
      if (cancelled) throw new ChatError("cancelled");
      handle = null;
      let result: ChatResult | null = null;
      let outcome = "failed";
      const began = performance.now();
      try {
        handle = streamChat(game.platform, {
          slot: llm.slot, url: llm.url, model, messages, maxTokens: llm.maxTokens ?? 2048,
          includeUsage: llm.includeUsage, extra: llm.extra as never,
          timeouts: DEFAULT_TIMEOUTS,
        }, { onText: (_delta, full) => { if (!cancelled) onText(withoutRecord(full)); } });
        result = await Promise.race([handle.result, cancellation]);
        if (cancelled) throw new ChatError("cancelled");
        const text = withoutRecord(result.text).trim();
        if (!text) throw new ChatError("empty");
        if (isRefusal({ narrative: result.text, finishReason: result.finishReason, hasRecord: false })) {
          outcome = "refused";
          throw new WritingError("AI 这次没有给出改稿，可以调整要求再试。");
        }
        if (outputWasTruncated(result.finishReason)) throw new WritingError("这次改稿没有写完，请缩短所选文字或再试一次。");
        await assertWritingAnchor(game, request.anchor);
        outcome = "ok";
        return text;
      } catch (error) {
        if (cancelled || (error instanceof ChatError && error.kind === "cancelled")) outcome = "cancelled";
        else if (error instanceof WritingError && error.message === STALE_WRITING) outcome = "stale";
        const decision = retryDecision(error, attempt, messages);
        if (cancelled || !decision.retry) throw error;
        messages = decision.messages;
      } finally {
        const finished = handle;
        const streamId = finished ? await finished.streamId.catch(() => null) : null;
        if (streamId) {
          void game.platform.llm.ack(streamId).catch(() => {});
          await game.platform.sql.batch([game.repo.usageStatement({
            worldId: request.anchor.worldId, nodeId: request.anchor.nodeId,
            purpose: request.kind === "rewrite" ? "段落改写" : "行动润色", model,
            promptTokens: result?.usage?.promptTokens ?? null, completionTokens: result?.usage?.completionTokens ?? null,
            estimated: result?.usage?.promptTokens == null || result.usage.completionTokens == null, firstTokenMs: result?.firstTokenMs ?? null,
            totalMs: result?.totalMs ?? performance.now() - began, outcome,
          })]);
        }
      }
    }
  })();
  return {
    done,
    cancel() {
      if (cancelled) return;
      cancelled = true;
      rejectCancelled(new ChatError("cancelled"));
      // Handle a rejected start without creating an unhandled cancel promise.
      if (handle) void handle.streamId.then((id) => game.platform.llm.cancel(id)).catch(() => {});
    },
    catchUp: () => handle?.catchUp() ?? Promise.resolve(),
  };
}

/** When 按原著纠错 finds no quotable basis, the player hears that and where to go instead, not “进度已保存”. */
export type CanonOutcome = "changed" | "verified" | "answer" | "not_found";
/** The hint offered whenever the book gives no basis: the player's own words are evidence enough there. */
export const CANON_NOT_FOUND = "原著里没有这处的依据，原文没有改动。如果这是本局自己的设定，或者就想这样改，用“按我的要求改”。";

/** “比试（2 次，命中 3 段）、青铜钥匙（没有命中）”. */
export function searchedText(searched: CanonCorrectionPreview["searched"]): string {
  return (searched ?? []).slice(0, 6).map((s) => `${s.query}（${s.times > 1 ? `${s.times} 次，` : ""}${s.hits ? `命中 ${s.hits} 段` : "没有命中"}）`).join("、");
}

/** What a finished correction found, in the player's words (D182). */
export function canonOutcomeText(preview: CanonCorrectionPreview, through?: number | null): string {
  const searched = searchedText(preview.searched);
  const looked = searched ? `查过：${searched}。` : "";
  switch (preview.outcome ?? "changed") {
    case "changed": return "";
    case "verified": return "核对过了，这段和原著对得上，不用改。";
    case "answer": return preview.answer?.trim() || "查到了原文，见下面的出处。";
    case "not_found":
      if (preview.reason === "out_of_range") return `相关内容可能在你设的参考范围${through != null ? `（截至第 ${through + 1} 节）` : ""}之后，没有读到。可以在本局设置里放宽参考范围再查。${looked}`;
      if (preview.reason === "no_excerpt") return `在允许的范围里没有找到相关的原文。${looked}换个说法再查，或者${CANON_NOT_FOUND.slice(CANON_NOT_FOUND.indexOf("如果"))}`;
      return `读了 ${preview.read ?? 0} 段原文，没有找到要改的依据。${looked}${CANON_NOT_FOUND.slice(CANON_NOT_FOUND.indexOf("如果"))}`;
  }
}

/** Why a correction stopped without a preview: each cause told as it is, never “not in the book” for all (D182). */
export function canonStop(snapshot: { status: string; error?: string | null; draft?: unknown }): { text: string; resumable: boolean; offerRevise: boolean } {
  const stop = (snapshot.draft as { correctionStop?: { code?: string; quotes?: unknown[]; searched?: CanonCorrectionPreview["searched"] } } | null)?.correctionStop;
  const error = snapshot.error ?? "";
  if (snapshot.status === "paused" || /已先停下/.test(error)) return { text: "查阅次数到了这次的上限，已先停下；读到的原文都保留了，可以接着查。", resumable: true, offerRevise: false };
  if (stop?.code === "quote_mismatch" || /对不上/.test(error)) {
    const quotes = (stop?.quotes ?? []).filter((q): q is string => typeof q === "string" && !!q.trim()).slice(0, 2).map((q) => `“${q.slice(0, 30)}${q.length > 30 ? "…" : ""}”`).join("、");
    return { text: `AI 引的原文${quotes ? ` ${quotes} ` : ""}和实际查到的对不上，没有采用。可以再查一次。`, resumable: false, offerRevise: false };
  }
  if (/书籍不符/.test(error)) return { text: "AI 引了另一本书的原文，没有采用。再查一次。", resumable: false, offerRevise: false };
  if (!error) return { text: "原著改稿没有完成，原文没有改动。", resumable: false, offerRevise: false };
  return { text: error.replace(/，进度已保存$/, ""), resumable: false, offerRevise: false };
}

export function writingError(error: unknown): string {
  if (error instanceof WritingError) return error.message;
  if (error instanceof ChatError) {
    if (isContextWindowError(error)) return CONTEXT_WINDOW_MESSAGE;
    if (error.kind === "cancelled") return "已取消，原文没有改动。";
    if (error.kind === "empty") return "AI 没有返回文字，请再试一次。";
    if (error.kind.startsWith("timeout")) return "等得有些久了，请稍后再试。";
    if (error.kind === "no_secret" || error.kind === "url_not_bound" || error.status === 401 || error.status === 403) return "服务暂时不可用，请检查 AI 服务设置。";
  }
  return "这次没有完成，请稍后再试。";
}

/**
 * Puts the adopted text into the passage itself, as the player's own 改写这段文字
 * always has (0.9.0): the story stays where it is, later turns read the new
 * wording, and the first original is kept so 恢复原文 can bring it back. The
 * passage's facts are not settled again. A passage several routes share is the
 * same past in all of them, so they all read the new wording.
 *
 * The update is a compare-and-swap: it only applies while the world is still on
 * the anchor's line and head and the passage still has the original text.
 */
export async function adoptRewrite(game: Game, anchorIn: WritingAnchor, text: string): Promise<tree.Cursor> {
  if (!text.trim() || text === anchorIn.original) throw new WritingError("文字没有变化。");
  const anchor = await assertWritingAnchor(game, anchorIn);
  await game.platform.sql.batch([{
    sql: `UPDATE nodes SET narrative = ?, rewritten = 1,
        meta_json = json_set(meta_json, '$.original', CASE WHEN json_type(meta_json, '$.original') = 'text'
          THEN json_extract(meta_json, '$.original') ELSE narrative END, '$.writingVersion', ?)
      WHERE id = ? AND world_id = ? AND narrative = ? AND EXISTS (SELECT 1 FROM worlds w JOIN lines l ON l.id = w.current_line_id
        WHERE w.id = ? AND w.archived = 0 AND w.current_line_id = ? AND l.node_id = ? AND l.deleted_at IS NULL)`,
    params: [text, WRITING_PROMPT_VERSION, anchor.nodeId, anchor.worldId, anchor.original, anchor.worldId, anchor.lineId, anchor.headId],
  }, staleChaptersStatement(anchor.worldId, anchor.nodeId, text)]);
  if ((await game.repo.getNode(anchor.nodeId))?.narrative !== text) throw new WritingError(STALE_WRITING);
  await game.afterTextEdit(anchor.worldId, anchor.nodeId).catch(() => {});
  return tree.cursor(game.repo, anchor.worldId);
}

export function isOpeningSeed(value: unknown): value is WorldState {
  const s = value as WorldState;
  return !!s && (s.version === 1 || s.version === 2) && s.time?.elapsedMinutes === 0 && typeof s.time.start === "string"
    && typeof s.protagonist?.name === "string" && typeof s.protagonist.identity === "string" && !!s.protagonist.stats
    && Array.isArray(s.protagonist.items) && Array.isArray(s.people) && Array.isArray(s.cards) && Array.isArray(s.places)
    && Array.isArray(s.goals) && !!s.era;
}

/**
 * A correction's cards against the 设定集 it lands in: an existing card (by name or
 * alias, any kind) is updated as its own kind and keeps its owner — the player's stays
 * the player's; only a new card is created, as a 设定 card the AI keeps up.
 */
export function resolveCorrectionCards(patch: TurnRecord, state: WorldState): TurnRecord {
  if (!patch.cards?.length) return patch;
  const pool = state.cards.filter((c) => c.kind !== "时代").map((c) => ({ id: c.id, name: c.name, aliases: c.keys }));
  return { ...patch, cards: patch.cards.map(({ source: _source, ...card }) => {
    const found = card.name ? matchName(pool, card.name) : undefined;
    const existing = found ? state.cards.find((c) => c.id === found.id) : undefined;
    return existing ? { ...card, kind: existing.kind } : { ...card, kind: card.kind && card.kind !== "时代" ? card.kind : "设定", source: "AI" as const };
  }) };
}

/** A correction can repair cited facts, never change the player's execution/settings/stat controls. */
export function checkedCorrectionPatch(patch: TurnRecord): TurnRecord {
  const allowed = new Set(["profile", "people", "place", "places", "cards"]);
  if (!patch || typeof patch !== "object" || Array.isArray(patch) || Object.keys(patch).some((key) => !allowed.has(key))) throw new WritingError("原著更正不能修改执行方式、参考用法、钱物统计或玩法设置。");
  if (patch.profile && Object.keys(patch.profile).some((key) => !["name", "age", "identity", "origin"].includes(key))) throw new WritingError("原著更正不能修改玩家的面板或特殊能力设置。");
  return structuredClone(patch);
}

const PATCH_NAMES: Record<string, string> = { stats: "属性", setStats: "钱物统计", money: "钱", items: "物品", goals: "目标", status: "身体状况", time: "时间", settings: "玩法设置", rules: "规则", source: "参考书用法", sourceSet: "参考书用法", panel: "主角面板", cheat: "特殊能力" };
/**
 * The parts of a correction this tool may make, and the names of what it left
 * out, so a stray field no longer throws away the whole correction (R30 step 3).
 */
export function filterCorrectionPatch(raw: unknown): { kept?: TurnRecord; dropped: string[] } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { dropped: [] };
  const allowed = ["profile", "people", "place", "places", "cards"];
  const kept: Record<string, unknown> = {};
  const dropped: string[] = [];
  for (const [key, value] of Object.entries(structuredClone(raw) as Record<string, unknown>)) {
    if (value == null) continue;
    if (!allowed.includes(key)) { dropped.push(PATCH_NAMES[key] ?? key); continue; }
    if (key === "profile") {
      if (typeof value !== "object" || Array.isArray(value)) { dropped.push("主角资料"); continue; }
      const profile = Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([k]) => ["name", "age", "identity", "origin"].includes(k)));
      for (const k of Object.keys(value as object)) if (!(k in profile)) dropped.push(PATCH_NAMES[k] ?? k);
      if (Object.keys(profile).length) kept.profile = profile;
      continue;
    }
    if (key === "cards") {
      if (!Array.isArray(value)) continue;
      if (value.some((c) => c && typeof c === "object" && !Array.isArray(c) && (c as Record<string, unknown>).op === "remove")) {
        dropped.push("删除设定卡");
      }
      // Kind and owner are settled against the 设定集 when it is applied (resolveCorrectionCards); never delete cards via correctionPatch.
      const cards = value.filter((c) => c && typeof c === "object" && !Array.isArray(c) && (c as Record<string, unknown>).op !== "remove" && typeof (c as Record<string, unknown>).name === "string" && String((c as Record<string, unknown>).name).trim()).map(({ source: _source, ...c }) => c);
      if (cards.length) kept.cards = cards;
      continue;
    }
    kept[key] = value;
  }
  return { kept: Object.keys(kept).length ? kept as TurnRecord : undefined, dropped: [...new Set(dropped)] };
}

// 按我的要求改 (R30 step 2): the player's words are the evidence. Facts change as
// asked, the turn's record follows, earlier facts the player corrected are fixed
// in the 设定集 too; no book quote is needed, unlike 按原著纠错.
export const REVISION_PROMPT_VERSION = "revise-passage-3";
export interface PlayerRevisionRequest { anchor: WritingAnchor; range: TextRange; hint: string; /** 资料范围 (D184). */ scope?: SourceScope }
export interface PlayerRevisionPreview {
  anchor: WritingAnchor; range: TextRange; hint: string; replacement: string; narrative: string;
  record: TurnRecord; recordChanges: { name: string; before: string; after: string }[]; correctionPatch?: TurnRecord;
  /** One sentence on what changed, from the model. */ note: string; writingVersion: string;
  /** Earlier-fact corrections left out because they touch what this tool may not change. */ droppedCorrections?: string[];
  /** `factSync`: the player edited the text and its facts follow; absent for 按我的要求改. */ kind?: "revise" | "factSync";
}
export { abilityCardName } from "../memory/cards";
import { abilityCardName } from "../memory/cards";

export function playerRevisionRules(settings: WorldSettings, state: WorldState, opening = false): string {
  return `按玩家的要求修改互动小说里选中的这段正文。玩家的要求就是依据：要求改的事实（人物、身份、数字、等级、年限、能力、物品、关系、时间、地点等）照改，选中范围里与之矛盾的说法一并改顺；没要求改的内容和写法尽量保持原样。只改选中范围，不续写其后的剧情，范围外的正文由程序原样保留。
- recordPatch：改动影响本回合记录时，只对受影响的字段返回最小 recordPatch（字段同正常回合，数组只给受影响的项目；删除本回合误记的 items/people/goals 项目写 {"name":"原名","remove":true}，改名替换写 {"oldName":"原名","name":"新名",...}）；改动涉及剧情变化时按改后正文重写 log；改的是较早段落而非最新一段时不要改 choices；不返回 protagonist/source/facts/executionMode/setStats 等整局字段；无影响就省略。
- correctionPatch：玩家改的如果是这一段之前就已成立的事实（主角已有的能力或修为、身份、人物的关系或来历、地点、设定），用它把之前的资料也一起改正，只能用 profile、people、place、places、cards：profile 只改 name、age、identity、origin；cards 用 {"name":"卡片名","kind":"原卡片的种类，新卡写设定","content":"改正后的全文"}，主角自己的本事写在“${abilityCardName(state.protagonist.name)}”这张卡里（没有就新建）。
不需要原著引文。最后只返回一个 JSON 对象（不要加代码块或额外说明）：{"replacement":"选中范围改好的正文","recordPatch":{},"correctionPatch":{},"note":"一句话说明改了什么"}。
记录字段：\n${recordFields(settings, state)}\n${opening ? openingExtra(settings) : ""}`;
}

const WHOLE_STORY_KEYS = ["protagonist", "source", "executionMode", "facts", "settings", "rules", "sourceSet", "executionSet", "setStats", "scriptSet", "challengeSet"];
/** The turn's record with only the patched fields changed: arrays by id or name, objects merged (as 按原著纠错 does). */
export function mergeRecordPatch(original: TurnRecord | null, patch: unknown): TurnRecord {
  const record = structuredClone((original ?? {}) as Record<string, unknown>);
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return record as TurnRecord;
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    if (WHOLE_STORY_KEYS.includes(key) || value == null) continue;
    if (key === "choices" && Array.isArray(value) && value.every((v) => typeof v === "string")) record[key] = value;
    else if (Array.isArray(value)) {
      const list = Array.isArray(record[key]) ? [...(record[key] as Record<string, unknown>[])] : [];
      for (const change of value) {
        if (!change || typeof change !== "object" || Array.isArray(change)) continue;
        const entry = change as Record<string, unknown>;
        const isRemove = entry.remove === true || (key !== "status" && entry.op === "remove");
        const lookupId = entry.oldName ?? entry.id ?? entry.name;
        const at = lookupId === undefined ? -1 : list.findIndex((v) => (v?.id ?? v?.name) === lookupId);
        if (isRemove) {
          if (at >= 0) list.splice(at, 1);
          continue;
        }
        const { oldName: _old, remove: _rm, ...clean } = entry;
        if (at >= 0) list[at] = { ...list[at], ...clean };
        else list.push(clean);
      }
      record[key] = list;
    } else if (typeof value === "object") record[key] = { ...((record[key] as Record<string, unknown>) ?? {}), ...(value as Record<string, unknown>) };
    else record[key] = value;
  }
  return record as TurnRecord;
}

// 改后同步 (R30 step 3, D183): the player edited a passage's text and wants its
// facts to follow. The edited text is final; only the record and earlier facts change.
export const FACT_SYNC_PROMPT_VERSION = "fact-sync-2";
export interface FactSyncRequest { anchor: WritingAnchor; text: string }

export function factSyncRules(settings: WorldSettings, state: WorldState, opening = false): string {
  return `玩家亲手改了互动小说里的一段正文，现在要让这段的记录和之前的资料跟上改后的正文。改后的正文是定稿，不要改写它。
对照【改前正文】和【改后正文】找出事实上的变化（人物、身份、关系、数字、等级、能力、物品、钱、伤病、时间、地点、发生了什么），只就这些变化：
- recordPatch：只返回受影响的本回合记录字段（数组只给受影响的项目；删除本回合误记的 items/people/goals 项目写 {"name":"原名","remove":true}，改名替换写 {"oldName":"原名","name":"新名",...}），不返回 protagonist/source/facts/executionMode/setStats 等整局字段；log 一定按改后正文重写一句；标明【这是最新一段】时，choices 按改后正文重新给，否则不给 choices。
- correctionPatch：改的如果是这一段之前就成立的事实（主角已有的本事、身份、人物的关系或来历、地点、设定），用它一并改正，只能用 profile、people、place、places、cards：profile 只改 name、age、identity、origin；cards 用 {"name":"卡片名","kind":"原卡片的种类，新卡写设定","content":"改正后的全文"}，主角自己的本事写在“${abilityCardName(state.protagonist.name)}”这张卡里。
- 只是措辞、语气的改动，没有事实变化：unchanged 写 true，其他都省略。
最后只返回一个 JSON 对象（不要加代码块或额外说明）：{"unchanged":false,"recordPatch":{},"correctionPatch":{},"note":"一句话说明事实变了什么"}。
记录字段：\n${recordFields(settings, state)}\n${opening ? openingExtra(settings) : ""}`;
}

/** The sync's answer as a revision preview whose text is exactly the player's; null when nothing usable came back. */
export function parseFactSync(text: string, request: FactSyncRequest, original: TurnRecord | null): (PlayerRevisionPreview & { unchanged: boolean }) | null {
  const value = completeJson(text) as Record<string, unknown> | null;
  if (!value || typeof value !== "object") return null;
  const rawUnchanged = value.unchanged === true;
  const record = mergeRecordPatch(original, rawUnchanged ? null : value.recordPatch);
  const { kept: correctionPatch, dropped } = rawUnchanged ? { kept: undefined, dropped: [] as string[] } : filterCorrectionPatch(value.correctionPatch);
  const recordChanges = correctionRecordChanges(original, record);
  const unchanged = rawUnchanged || (recordChanges.length === 0 && !correctionPatch);
  const whole = { start: 0, end: request.anchor.original.length };
  return {
    kind: "factSync", unchanged, anchor: request.anchor, range: whole, hint: "", replacement: request.text,
    narrative: replaceRange(request.anchor.original, whole, request.text), record,
    recordChanges, ...(correctionPatch ? { correctionPatch } : {}), ...(dropped.length ? { droppedCorrections: dropped } : {}),
    note: typeof value.note === "string" ? value.note.trim().slice(0, 200) : "", writingVersion: FACT_SYNC_PROMPT_VERSION,
  };
}

/** The model's answer as a preview; null when it gave no replacement. Cards it corrects stay the AI's to keep up. */
export function parsePlayerRevision(text: string, request: PlayerRevisionRequest, original: TurnRecord | null): PlayerRevisionPreview | null {
  const value = completeJson(text) as Record<string, unknown> | null;
  const replacement = typeof value?.replacement === "string" ? value.replacement.trim() : "";
  if (!value || !replacement) return null;
  const record = mergeRecordPatch(original, value.recordPatch);
  const { kept: correctionPatch, dropped } = filterCorrectionPatch(value.correctionPatch);
  return {
    anchor: request.anchor, range: request.range, hint: request.hint, replacement,
    narrative: replaceRange(request.anchor.original, request.range, replacement), record,
    recordChanges: correctionRecordChanges(original, record), ...(correctionPatch ? { correctionPatch } : {}), ...(dropped.length ? { droppedCorrections: dropped } : {}),
    note: typeof value.note === "string" ? value.note.trim().slice(0, 200) : "", writingVersion: REVISION_PROMPT_VERSION,
  };
}

/**
 * The edits after the passage when nothing but edits follows it (oldest first),
 * or null when a later passage does. An empty list: the passage is the head.
 */
async function editsAfter(game: Game, anchor: WritingAnchor): Promise<StoryNode[] | null> {
  const after: StoryNode[] = [];
  let node = await game.repo.getNode(anchor.headId);
  while (node && node.id !== anchor.nodeId) {
    if (node.kind !== "edit" || !node.parentId) return null;
    after.unshift(node);
    node = await game.repo.getNode(node.parentId);
  }
  return node ? after : null;
}

/** No passage follows it — only edits, if anything (the player's settings, the AI's 设定集 tidy-ups). */
export async function isLatestPassage(game: Game, anchor: WritingAnchor): Promise<boolean> {
  const target = await game.repo.getNode(anchor.nodeId);
  return !!target?.parentId && (await editsAfter(game, anchor)) !== null;
}

/** 采用: like 按原著纠错, settled from the parent; the latest passage gets another version, an earlier one a revision route. */
export async function adoptPlayerRevision(game: Game, preview: PlayerRevisionPreview): Promise<tree.Cursor> {
  const anchor = await assertWritingAnchor(game, preview.anchor);
  const [target, world, targetState] = await Promise.all([game.repo.getNode(anchor.nodeId), game.repo.getWorld(anchor.worldId), game.repo.getState(anchor.nodeId)]);
  if (!target || !world || target.kind === "edit" || !preview.narrative.trim()) throw new WritingError(STALE_WRITING);
  if (replaceRange(anchor.original, preview.range, preview.replacement) !== preview.narrative) throw new WritingError("改稿超出了选中范围，请重新生成。");
  // Nothing different: adopting would only add an identical version.
  const recordSame = JSON.stringify(preview.record ?? {}) === JSON.stringify(target.record ?? {});
  if (preview.narrative.trim() === anchor.original.trim() && recordSame && !preview.correctionPatch) throw new WritingError("这次改稿和原来一样，没有要采用的改动。");
  const current = await game.repo.getState(anchor.headId);
  return commitRevision(game, {
    anchor, target, world, correctionPatch: preview.correctionPatch, record: preview.record, narrative: preview.narrative,
    source: targetState.source ?? null, sourceGuard: JSON.stringify(current.source ?? null),
    facts: (nodeId) => [{ id: newId(), detail: `${preview.kind === "factSync" ? "玩家改写了这段" : "玩家修订"}：${preview.note || preview.hint || "按改后的正文"}`.slice(0, 300), origin: "player" as const, citations: [], nodeId }],
    meta: { writingVersion: preview.writingVersion, revision: { kind: preview.kind === "factSync" ? "factSync" : "playerRevision", nodeId: target.id, lineId: anchor.lineId, hint: preview.hint.slice(0, 300) } },
    asVersion: true, lineName: target.parentId ? "改写后的路线" : "修订开场后的路线",
  });
}

/** The preview's complete passage is settled once from its parent, never from its old result. */
export async function adoptCanonCorrection(game: Game, preview: CanonCorrectionPreview): Promise<tree.Cursor> {
  const anchor = await assertWritingAnchor(game, preview.anchor);
  const [target, current, world] = await Promise.all([game.repo.getNode(anchor.nodeId), game.repo.getState(anchor.headId), game.repo.getWorld(anchor.worldId)]);
  if (!target || !world || target.kind === "edit" || !preview.narrative.trim()) throw new WritingError(STALE_WRITING);
  if (JSON.stringify(current.source ?? null) !== preview.sourceGuard) throw new WritingError("参考书籍用法已经改变，请重新生成改稿。");
  if (preview.range && (!preview.replacement || replaceRange(anchor.original, preview.range, preview.replacement) !== preview.narrative)) throw new WritingError("改稿超出了选中范围，请重新生成。");
  const binding = current.source, reference = preview.reference;
  if (!validBinding(binding) || !reference || !validBinding(reference.binding) || reference.bookId !== binding.bookId
    || reference.binding.bookId !== binding.bookId || reference.binding.instructions !== binding.instructions
    || reference.binding.through !== binding.through || reference.binding.plot !== binding.plot || reference.binding.fanfic !== binding.fanfic
    || reference.binding.method !== binding.method || reference.binding.analysisId !== binding.analysisId) throw new WritingError("改稿引用的书籍用法无效，请重新生成。");
  const book = await getBook(game.repo, binding.bookId);
  if ((preview.outcome ?? "changed") !== "changed") throw new WritingError("这次核对没有要改的地方，不用采用。");
  if (!book || !Array.isArray(preview.corrections) || !preview.corrections.length) throw new WritingError("还没有查到可以采用的原著依据。");
  if (reference.binding.position >= book.sections.length || reference.binding.through !== null && reference.binding.position > reference.binding.through) throw new WritingError("原著位置超出了参考范围。");
  const chunks = chunksOf(book);
  for (const correction of preview.corrections) {
    if (!correction.detail.trim() || !correction.citations.length) throw new WritingError("每项更正都需要原著出处。");
    for (const citation of correction.citations) {
      const chunk = chunks[citation.chunk];
      if (citation.bookId !== binding.bookId || !chunk || chunk.section !== citation.section || !citation.quote.trim()
        || citation.title !== book.sections[citation.section].title || citation.page !== book.sections[citation.section].page
        || binding.through !== null && citation.section > binding.through || !chunk.text.includes(citation.quote)
        || (citation.start !== undefined || citation.end !== undefined) && (!Number.isInteger(citation.start) || !Number.isInteger(citation.end) || citation.start! < 0 || citation.end! <= citation.start! || chunk.text.slice(citation.start, citation.end) !== citation.quote)
        || !reference.passages.some((p) => p.kind === "original" && p.chunk === citation.chunk && p.section === citation.section && p.text.includes(citation.quote))) {
        throw new WritingError("更正的原文出处不完整或超出参考范围，请重新查证。");
      }
    }
  }
  return commitRevision(game, {
    anchor, target, world, baseline: preview.baseline, correctionPatch: preview.correctionPatch, record: preview.record, narrative: preview.narrative,
    source: reference.binding, sourceGuard: preview.sourceGuard,
    checkSeed: (seed) => {
      for (const fact of preview.preservedPlayerFacts ?? []) {
        if (!seed.facts?.some((f) => f.origin === "player" && f.id === fact.id && f.detail === fact.detail)) throw new WritingError("玩家分支的来源已经改变，请重新查证。");
      }
    },
    facts: (nodeId) => preview.corrections.map((c) => ({ id: newId(), detail: c.detail, origin: "correction" as const, citations: structuredClone(c.citations), nodeId })),
    meta: {
      reference: structuredClone(reference), writingVersion: typeof preview.writingVersion === "string" ? preview.writingVersion : "unknown", preservedPlayerFacts: structuredClone(preview.preservedPlayerFacts ?? []),
      revision: { kind: "canonCorrection", nodeId: target.id, lineId: anchor.lineId, corrections: structuredClone(preview.corrections) },
    },
  });
}

/**
 * The revised passage settled once from its parent (or the opening's seed), with
 * any earlier facts the revision corrected applied first. An earlier passage
 * gets a revision route, so what followed it stays on the original one; the
 * latest passage gets another version beside the old one (按我的要求改).
 */
async function commitRevision(game: Game, r: {
  anchor: WritingAnchor; target: StoryNode; world: World; baseline?: WorldState; correctionPatch?: TurnRecord; record: TurnRecord; narrative: string;
  source: WorldState["source"]; sourceGuard: string; checkSeed?: (seed: WorldState) => void; facts: (nodeId: string) => NonNullable<WorldState["facts"]>;
  meta: Record<string, unknown>; asVersion?: boolean; lineName?: string;
}): Promise<tree.Cursor> {
  const { anchor, target, world } = r;
  const seed = target.parentId ? await game.repo.getState(target.parentId) : target.meta.openingSeed ?? r.baseline;
  if (!target.parentId && !isOpeningSeed(seed)) throw new WritingError(MISSING_OPENING_SEED);
  if (!seed || typeof seed !== "object") throw new WritingError("找不到修订前的状态。");
  r.checkSeed?.(seed as WorldState);
  let baseline = structuredClone(seed as WorldState);
  let era = eraContext(world.eraId, baseline);
  if (r.correctionPatch) {
    const patch = resolveCorrectionCards(checkedCorrectionPatch(r.correctionPatch), baseline);
    baseline = (await game.settleRecord(baseline, patch, { mode: "do", difficulty: world.settings.difficulty, currency: era.currency, clock: era.clock }, { advanceTime: false })).state;
    era = eraContext(world.eraId, baseline);
  }
  const normalized = parseRecord(JSON.stringify(r.record)).record;
  if (!normalized) throw new WritingError("改稿的事实整理尚未完成。");
  let record = structuredClone(normalized);
  if (!target.parentId) {
    const pack = eraPack(world.eraId);
    if (record.date != null && era.clock.clockStyle !== "elapsed") {
      const date = readDate(record.date, era.clock.rules);
      if (date) { baseline.time.date = date; baseline.time.start = formatDate(date, era.clock.rules); }
      else if (!pack && typeof record.date === "string" && record.date.trim()) baseline.time.start = record.date.trim();
    }
    if (record.hour != null) baseline.time.startHour = record.hour;
    if (!pack && record.currency?.length) baseline.era.currency = { units: record.currency };
    era = eraContext(world.eraId, baseline);
    if (pack) baseline.timeline = packTimeline(pack.timeline, era.clock).map((event) => ({ id: newId(), ...event }));
    const purse = record.money != null ? parseMoney(record.money, era.currency) : null;
    if (purse !== null) baseline.protagonist.stats.money = Math.max(0, purse);
    const { money: _money, time: _time, date: _date, hour: _hour, currency: _currency, ...rest } = record;
    record = rest;
  }
  const parent = target.parentId ? await game.repo.getNode(target.parentId) : null;
  const fortune = isFortune(parent?.meta.fortune) ? parent.meta.fortune : undefined;
  const result = await game.settleRecord(baseline, record, { mode: target.actionMode ?? "do", difficulty: world.settings.difficulty, currency: era.currency, clock: era.clock, fortune }, target.parentId ? undefined : { advanceTime: false });
  const nodeId = newId();
  if (normalized.continuity) {
    normalized.continuity = remapContinuity(normalized.continuity, id => id === target.id ? nodeId : id);
    normalized.continuity = (await validateContinuity(game.repo, anchor.worldId, target.parentId, nodeId, r.narrative, `${target.actionText ?? ""}\n${target.directorNote ?? ""}`, result.state, normalized.continuity, false)).changes;
    if (!Object.keys(normalized.continuity).length) delete normalized.continuity;
  }
  result.state.source = structuredClone(r.source ?? null);
  result.state.facts = [...result.state.facts ?? [], ...r.facts(nodeId)];
  const node = {
    id: nodeId, parentId: target.parentId, kind: target.kind, narrative: r.narrative.trim(), state: result.state,
    actionMode: target.actionMode, actionText: target.actionText, directorNote: target.directorNote, record: normalized, choices: normalized.choices ?? [],
    meta: {
      ...r.meta,
      ...(target.parentId ? {} : { openingSeed: structuredClone(seed), ...(target.meta.setup ? { setup: structuredClone(target.meta.setup) } : {}) }),
      chips: result.chips, notes: result.notes, log: result.log,
    },
  };
  // The latest passage gets a new version beside it. The player's own edits made
  // after it (a book bound, a card changed) are made again on top in the same write,
  // as 重说 does; the AI's tidy-ups described the old text and stay with it (D183).
  const after = r.asVersion && target.parentId ? await editsAfter(game, anchor) : null;
  const carried: NewNode[] = [];
  if (after) {
    let previous = nodeId, state = result.state;
    const mapped = new Map([[target.id, nodeId]]);
    const staged = [{ id: nodeId, narrative: node.narrative, action: `${node.actionText ?? ""}\n${node.directorNote ?? ""}`, changes: normalized.continuity }];
    for (const edit of after.filter((n) => n.meta.by !== "AI")) {
      const editEra = eraContext(world.eraId, state);
      const editRecord = { ...(edit.record as TurnRecord | undefined) };
      const next = (await game.settleRecord(state, editRecord, { mode: "do", difficulty: world.settings.difficulty, currency: editEra.currency, clock: editEra.clock }, { advanceTime: false })).state;
      const id = newId();
      const action = `${edit.actionText ?? ""}\n${edit.directorNote ?? ""}`;
      if (editRecord.continuity) {
        const remapped = remapContinuity(editRecord.continuity, (source) => source === edit.id ? id : mapped.get(source) ?? source);
        const { changes } = await validateContinuity(game.repo, anchor.worldId, target.parentId, id, "", action, next, remapped, false, staged);
        if (Object.keys(changes).length) editRecord.continuity = changes;
        else delete editRecord.continuity;
      }
      if (JSON.stringify(next) === JSON.stringify(state) && !editRecord.continuity) continue;
      carried.push({ id, parentId: previous, kind: "edit", actionText: edit.actionText, directorNote: edit.directorNote, narrative: "", record: editRecord, state: next, meta: { ...edit.meta, carriedFrom: edit.id } });
      mapped.set(edit.id, id);
      staged.push({ id, narrative: "", action, changes: editRecord.continuity });
      previous = id; state = next;
    }
  }
  try {
    return await tree.forkRevision(game.repo, { ...anchor, sourceGuard: r.sourceGuard, requireIdle: true }, node, r.lineName, !!after, carried);
  } catch (error) {
    if (error instanceof Error && error.message.includes("已经改变")) throw new WritingError(STALE_WRITING);
    throw error;
  }
}
