// Optional writing tools. No story turn is generated and nothing is saved until adoption.
import type { Game } from "../game";
import { ChatError, streamChat, type ChatHandle, type ChatMessage, type ChatResult } from "../llm/chat";
import { isRefusal } from "../llm/refusal";
import * as tree from "../tree";
import type { ActionMode, FactCitation, World, WorldState, WorldSettings } from "../types";
import { openingExtra, recordFields } from "../prompt/turn";
import { validBinding, type ReferenceContext } from "../sources/types";
import { chunksOf, getBook } from "../sources/library";
import { applyRecord, type TurnRecord } from "../state/apply";
import { eraContext, eraPack } from "../era";
import { formatDate, readDate } from "../calendar/date";
import { parseMoney } from "../money";
import { newId } from "../db/repo";
import { packCards } from "../era/card";
import { packTimeline } from "../timeline";
import { isFortune } from "../fortune";
import { parseRecord } from "../record/parse";

/** writing-2: the version is kept with each adopted rewrite; it is not sent to the model. */
export const WRITING_PROMPT_VERSION = "writing-2";
export const CANON_WRITING_PROMPT_VERSION = "writing-canon-3";
export function canonCorrectionRules(settings: WorldSettings, state: WorldState, opening = false): string {
  return `对这个回合按原著纠错。主动读取 canon-reference 技能，搜索并阅读原著原文，必要时补查邻段；核对身份、关系、称谓、时间、地点、物品和事件。玩家明确改变的事实及合理后果保留，AI自行写错不等于玩家改写。独立查证可同批完成，沿检索返回编号阅读，复用已读证据。只预览，不改当前路线。只改选中范围，允许按要求补全遗漏，不续写其后。范围外正文由程序原样保留。原回合记录默认保留，只对受改稿影响的字段返回最小recordPatch；数组只给受影响项目，不重写无关钱物/时间/目标。跨回合问题放related，资料不足放unresolved，不擅自改历史。最后只返回JSON：{"replacement":"选中范围的替换正文","recordPatch":{受影响的回合记录字段},"related":["关联问题"],"unresolved":["待核对问题"],"correctionPatch":{仅可用于校正继承的profile/people/place/places/cards，无法查证则省略},"corrections":[{"detail":"有原著依据的更正说明","citations":[{"bookId":"书籍ID","section":0,"chunk":0,"quote":"实际读到的原句"}]}]}。corrections只放原著更正，每项citations非空；玩家分支不是原著证据，不放进这个列表或伪造引文。原文没有依据时明确资料不足。record只记录本回合实际变化，不返回read_world的WorldState，不包含protagonist/source/facts/executionMode等整局字段。time写本回合经过多久，money写增减，choices为文字数组。字段沿用正常回合：\n${recordFields(settings, state)}\n${opening ? openingExtra(settings) : ""}`;
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
  done: Promise<CanonCorrectionPreview>;
  cancel(): void;
  catchUp(): Promise<void>;
  /** Detaches the page; the native run continues. Explicit cancel is separate. */
  detach?(): void;
}
export interface CanonCorrectionRunner {
  runCanonCorrection(request: CanonCorrectionRequest, onText: (text: string) => void): CanonCorrectionHandle;
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
export const STALE_WRITING = "故事或原文已经变了，请重新打开这个工具。";
export const MISSING_OPENING_SEED = "这个旧开场没有保存初始信息，请先补齐开场前的主角、时间和钱物，再按原著纠错。";

export function runCanonCorrection(game: Game, request: CanonCorrectionRequest, onText: (text: string) => void): CanonCorrectionHandle {
  const runner = game as Game & Partial<CanonCorrectionRunner>;
  if (!runner.runCanonCorrection) throw new WritingError("原著纠错尚未就绪，请稍后重试。");
  return runner.runCanonCorrection(request, onText);
}

export function paragraphs(text: string): TextRange[] {
  return [...text.matchAll(/[^\r\n]+/g)].filter((m) => m[0].trim()).map((m) => ({ start: m.index!, end: m.index! + m[0].length }));
}
export function replaceRange(original: string, range: TextRange, replacement: string): string {
  if (range.start < 0 || range.end > original.length || range.start >= range.end || !replacement.trim()) throw new WritingError("先选一段文字。" );
  return original.slice(0, range.start) + replacement.trim() + original.slice(range.end);
}

export async function assertWritingAnchor(game: Game, anchor: WritingAnchor): Promise<void> {
  const world = await game.repo.getWorld(anchor.worldId);
  if (!world || world.archived || world.currentLineId !== anchor.lineId) throw new WritingError(STALE_WRITING);
  const [current, node] = await Promise.all([tree.cursor(game.repo, anchor.worldId), game.repo.getNode(anchor.nodeId)]);
  if (current.head.id !== anchor.headId || node?.worldId !== anchor.worldId || node.narrative !== anchor.original) throw new WritingError(STALE_WRITING);
  if (!(await game.repo.path(current.head.id)).some((n) => n.id === anchor.nodeId)) throw new WritingError(STALE_WRITING);
}

export function writingMessages(kind: "rewrite" | "polish", text: string, hint: string, context: string, mode: ActionMode): ChatMessage[] {
  const task = kind === "rewrite"
    ? "只做文风润色，按玩家要求调整所选文字的措辞、节奏和描写。不改变已经发生的事实、人物决定、钱物数量、生死、时间与地点；要求涉及改事实时仍保留原事实。只输出替换这段的正文，不续写后续剧情。"
    : `润色玩家还没发送的输入（方式：${({ do: "行动", say: "说话", write: "亲手写剧情", direct: "幕后要求", skip: "过些日子", continue: "继续" })[mode]}）。保持原意与人称，不替玩家添加决定，也不写行动结果。只输出润色后的输入。`;
  return [
    { role: "system", content: `${task}不要解释，不加标题、引号包装或记录块。` },
    { role: "user", content: `【上下文，仅供参考】\n${context}\n\n【要处理的文字】\n${text}\n\n【玩家要求】\n${hint.trim() || "让表达更自然流畅"}` },
  ];
}

export interface WritingRequest { anchor: WritingAnchor; kind: "rewrite" | "polish"; text: string; hint: string; mode: ActionMode }

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
    const messages = writingMessages(request.kind, request.text, request.hint, request.anchor.original, request.mode);
    // Each actual attempt has its own usage row, including failed or cancelled attempts.
    for (let attempt = 1; ; attempt++) {
      if (cancelled) throw new ChatError("cancelled");
      let result: ChatResult | null = null;
      let outcome = "failed";
      const began = performance.now();
      try {
        handle = streamChat(game.platform, {
          slot: llm.slot, url: llm.url, model, messages, maxTokens: llm.maxTokens ?? 2048,
          includeUsage: llm.includeUsage, extra: llm.extra as never,
          timeouts: { firstByteMs: 30_000, idleMs: 30_000, totalMs: 90_000 },
        }, { onText: (_delta, full) => { if (!cancelled) onText(withoutRecord(full)); } });
        result = await Promise.race([handle.result, cancellation]);
        if (cancelled) throw new ChatError("cancelled");
        const text = withoutRecord(result.text).trim();
        if (!text) throw new ChatError("empty");
        if (isRefusal({ narrative: result.text, finishReason: result.finishReason, hasRecord: false })) {
          outcome = "refused";
          throw new WritingError("AI 这次没有给出改稿，可以调整要求再试。");
        }
        if (result.finishReason === "length") throw new WritingError("这次改稿没有写完，请缩短所选文字或再试一次。");
        await assertWritingAnchor(game, request.anchor);
        outcome = "ok";
        return text;
      } catch (error) {
        if (cancelled || (error instanceof ChatError && error.kind === "cancelled")) outcome = "cancelled";
        else if (error instanceof WritingError && error.message === STALE_WRITING) outcome = "stale";
        const retry = !cancelled && attempt === 1 && error instanceof ChatError && !error.partial &&
          (error.kind === "network" || error.kind === "timeout_first" || (error.kind === "http" && (error.status === 429 || (error.status ?? 0) >= 500)));
        if (!retry) throw error;
      } finally {
        const finished = handle;
        if (finished) void finished.streamId.then((id) => game.platform.llm.ack(id)).catch(() => {});
        await game.platform.sql.batch([game.repo.usageStatement({
          worldId: request.anchor.worldId, nodeId: request.anchor.nodeId,
          purpose: request.kind === "rewrite" ? "段落改写" : "行动润色", model,
          promptTokens: result?.usage?.promptTokens ?? null, completionTokens: result?.usage?.completionTokens ?? null,
          estimated: result?.usage?.promptTokens == null || result.usage.completionTokens == null, firstTokenMs: result?.firstTokenMs ?? null,
          totalMs: result?.totalMs ?? performance.now() - began, outcome,
        })]);
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

export function writingError(error: unknown): string {
  if (error instanceof WritingError) return error.message;
  if (error instanceof ChatError) {
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
export async function adoptRewrite(game: Game, anchor: WritingAnchor, text: string): Promise<tree.Cursor> {
  if (!text.trim() || text === anchor.original) throw new WritingError("文字没有变化。");
  await assertWritingAnchor(game, anchor);
  await game.platform.sql.batch([{
    sql: `UPDATE nodes SET narrative = ?, rewritten = 1,
        meta_json = json_set(meta_json, '$.original', CASE WHEN json_type(meta_json, '$.original') = 'text'
          THEN json_extract(meta_json, '$.original') ELSE narrative END, '$.writingVersion', ?)
      WHERE id = ? AND world_id = ? AND narrative = ? AND EXISTS (SELECT 1 FROM worlds w JOIN lines l ON l.id = w.current_line_id
        WHERE w.id = ? AND w.archived = 0 AND w.current_line_id = ? AND l.node_id = ? AND l.deleted_at IS NULL)`,
    params: [text, WRITING_PROMPT_VERSION, anchor.nodeId, anchor.worldId, anchor.original, anchor.worldId, anchor.lineId, anchor.headId],
  }]);
  if ((await game.repo.getNode(anchor.nodeId))?.narrative !== text) throw new WritingError(STALE_WRITING);
  return tree.cursor(game.repo, anchor.worldId);
}

export function isOpeningSeed(value: unknown): value is WorldState {
  const s = value as WorldState;
  return !!s && (s.version === 1 || s.version === 2) && s.time?.elapsedMinutes === 0 && typeof s.time.start === "string"
    && typeof s.protagonist?.name === "string" && typeof s.protagonist.identity === "string" && !!s.protagonist.stats
    && Array.isArray(s.protagonist.items) && Array.isArray(s.people) && Array.isArray(s.cards) && Array.isArray(s.places)
    && Array.isArray(s.goals) && !!s.era;
}

/** A correction can repair cited facts, never change the player's execution/settings/stat controls. */
export function checkedCorrectionPatch(patch: TurnRecord): TurnRecord {
  const allowed = new Set(["profile", "people", "place", "places", "cards"]);
  if (!patch || typeof patch !== "object" || Array.isArray(patch) || Object.keys(patch).some((key) => !allowed.has(key))) throw new WritingError("原著更正不能修改执行方式、参考用法、钱物统计或玩法设置。");
  if (patch.profile && Object.keys(patch.profile).some((key) => !["name", "age", "identity", "origin"].includes(key))) throw new WritingError("原著更正不能修改玩家的面板或特殊能力设置。");
  return structuredClone(patch);
}

/** The preview's complete passage is settled once from its parent, never from its old result. */
export async function adoptCanonCorrection(game: Game, preview: CanonCorrectionPreview): Promise<tree.Cursor> {
  const { anchor } = preview;
  await assertWritingAnchor(game, anchor);
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
  const seed = target.parentId ? await game.repo.getState(target.parentId) : target.meta.openingSeed ?? preview.baseline;
  if (!target.parentId && !isOpeningSeed(seed)) throw new WritingError(MISSING_OPENING_SEED);
  if (!seed || typeof seed !== "object") throw new WritingError("找不到修订前的状态。");
  for (const fact of preview.preservedPlayerFacts ?? []) {
    if (!(seed as WorldState).facts?.some((f) => f.origin === "player" && f.id === fact.id && f.detail === fact.detail)) throw new WritingError("玩家分支的来源已经改变，请重新查证。");
  }
  let baseline = structuredClone(seed as WorldState);
  let era = eraContext(world.eraId, baseline);
  if (preview.correctionPatch) {
    const patch = checkedCorrectionPatch(preview.correctionPatch);
    baseline = (await game.settleRecord(baseline, patch, { mode: "do", difficulty: world.settings.difficulty, currency: era.currency, clock: era.clock }, { advanceTime: false })).state;
    era = eraContext(world.eraId, baseline);
  }
  const normalized = parseRecord(JSON.stringify(preview.record)).record;
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
  result.state.source = structuredClone(reference.binding);
  result.state.executionMode = current.executionMode ?? "classic";
  result.state.facts = [...result.state.facts ?? [], ...preview.corrections.map((c) => ({ id: newId(), detail: c.detail, origin: "correction" as const, citations: structuredClone(c.citations), nodeId }))];
  try {
    return await tree.forkRevision(game.repo, { ...anchor, sourceGuard: preview.sourceGuard }, {
      id: nodeId, parentId: target.parentId, kind: target.kind, narrative: preview.narrative.trim(), state: result.state,
      actionMode: target.actionMode, actionText: target.actionText, directorNote: target.directorNote, record: normalized, choices: normalized.choices ?? [],
      meta: {
        reference: structuredClone(reference), writingVersion: typeof preview.writingVersion === "string" ? preview.writingVersion : "unknown", preservedPlayerFacts: structuredClone(preview.preservedPlayerFacts ?? []),
        revision: { kind: "canonCorrection", nodeId: target.id, lineId: anchor.lineId, corrections: structuredClone(preview.corrections) },
        ...(target.parentId ? {} : { openingSeed: structuredClone(seed), ...(target.meta.setup ? { setup: structuredClone(target.meta.setup) } : {}) }),
        chips: result.chips, notes: result.notes, log: result.log,
      },
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes("已经改变")) throw new WritingError(STALE_WRITING);
    throw error;
  }
}
