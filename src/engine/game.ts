// Game session facade: native opening, turns, variants and recovery, plus
// local edits, context previews and auxiliary writing jobs.
import { validateContinuity, readContinuity } from "./continuity";
import { formatDate } from "./calendar/date";
import { eraContext, eraPack } from "./era";
import { packCards } from "./era/card";
import type { ExecutionSnapshot, Platform, SqlStatement } from "../platform";
import { migrate } from "./db/migrate";
import { Repo } from "./db/repo";
import { ChatError, compactChatMessages, retryDecision, streamChat, type ChatMessage, type ChatResult } from "./llm/chat";
import { hasChinese, isNotice, refusedFinish } from "./llm/refusal";
import {
  assistMessages, buildTurnContext, writingContextTemplate, renderState, continueMessages, extractMessages, openingExtractMessages, openingMessages, PROMPT_VERSION,
  type Arrival, type ContextLayer, type SetupDraft, type TurnPromptInput,
} from "./prompt/turn";
import { CODEX_FREE_PROMPT_VERSION, CODEX_PROMPT_VERSION, codexMessages, codexPatch, codexSummary, type CodexInput } from "./prompt/codex";
import { UPKEEP_EVERY, UPKEEP_FREE_PROMPT_VERSION, UPKEEP_PROMPT_VERSION, upkeepMessages } from "./prompt/upkeep";
import { CHAPTER_PROMPT_VERSION, chapterMessages, parseChapter } from "./prompt/chapter";
import { askMessages } from "./prompt/ask";
import type { TabooHit } from "./era/taboo";
import { lenientJson } from "./record/parse";
import { applyRecord, type Chip, type TurnRecord } from "./state/apply";
import { skipSpanMinutes } from "./calendar/duration";
import { fortuneMode, isFortune, rollFortune, type Fortune } from "./fortune";
import { packTimeline } from "./timeline";
import { newId } from "./db/repo";
import { challengeInputOf, newChallenge, newScript, scriptInputOf, type ChallengeInput, type ScriptInput } from "./modes";
import { draftChallengeMessages, draftScriptMessages, parseChallengeDraft, parseScriptDraft, type DraftInput } from "./prompt/draft";
import * as tree from "./tree";
import { DEFAULT_SETTINGS, type ActionMode, type Chapter, type StoryNode, type WorldSettings, type WorldState } from "./types";
import { analysisJobs, chunksOf, fitReference, getBook, newAnalysisJob, referenceBlock, referenceContext, referenceEvidenceBlock, referenceInstructionsBlock, saveJob, SOURCE_PROMPT_VERSION } from "./sources/library";
import { sourceAnalysisMessages, sourceAnalysisResult } from "./sources/analysis";
import { validBinding, type SourceBinding, type AnalysisJob } from "./sources/types";
import { asJson, startRun, type RunPlan } from "./execution";
import { assertWritingAnchor, CANON_WRITING_PROMPT_VERSION, canonCorrectionRules, correctionRecordChanges, isOpeningSeed, MISSING_OPENING_SEED, WritingError, type CanonCorrectionRequest, type CanonCorrectionHandle, type CanonCorrectionPreview } from "./writing/assist";

export type { ChallengeInput, ScriptInput } from "./modes";

export interface LlmConfig {
  protocol?: "chat-completions" | "openai-responses" | "anthropic" | "gemini";
  contextWindowTokens?: number;
  maxOutputTokens?: number;
  slot: string;
  url: string;
  model: string;
  auxModel?: string;
  includeUsage: boolean;
  maxTokens?: number;
  extra?: Record<string, unknown>;
  /** Target input tokens per turn (PLAN §5.3: 12k, hard cap 7/6 of it). */
  contextTokens?: number;
}

/** The next turn's request as the context viewer shows it (R04-T004). */
export interface ContextPreview {
  messages: ChatMessage[];
  layers: ContextLayer[];
  chars: number;
  budgetChars: number;
  /** Tokens per character, learned from what the service reported. */
  ratio: number;
  calibrated: boolean;
}

export type FailReason = "network" | "timeout" | "http" | "auth" | "quota" | "empty" | "refused" | "cancelled" | "config" | "no_record";

export function nativeFailReason(status: string, message: string | null, errorKind?: string | null): FailReason {
  if (errorKind != null) {
    switch (errorKind) {
      case "cancelled": case "timeout": case "network": case "auth": case "quota":
      case "http": case "refused": case "no_record": case "empty": return errorKind;
      default: return "config";
    }
  }
  if (status === "cancelled") return "cancelled";
  const text = message ?? "";
  if (/拒绝|refus|safety|blocked/i.test(text)) return "refused";
  if (/timeout|timed out|超时|流空闲/i.test(text)) return "timeout";
  if (/\b40[13]\b|密钥|凭据|认证/i.test(text)) return "auth";
  if (/\b(?:402|429)\b|余额不足|限流/i.test(text)) return "quota";
  if (/上限|预算|装配|超出|超过/.test(text)) return "config";
  if (/记录.*不完整|没有记录|记录块/.test(text)) return "no_record";
  if (/network|connection|connect error|网络|连接中断/i.test(text)) return "network";
  if (/\bHTTP\b|status.?[45]\d\d/i.test(text)) return "http";
  return "config";
}

export type TurnEvent =
  | { type: "step"; index: number; total: number }
  | { type: "finished"; steps: number; reason: AutoplayStop }
  | { type: "thinking" }
  | { type: "text"; delta: string; full: string }
  | { type: "organizing" }
  | { type: "done"; cursor: tree.Cursor; node: StoryNode; chips: Chip[] }
  | { type: "failed"; reason: FailReason; status?: number; detail?: string; partialSaved: boolean; runId?: string; cursor?: tree.Cursor; node?: StoryNode };

export interface NewWorld {
  /** @deprecated Accepted from legacy opening drafts and ignored. */
  source?: SourceBinding | null;
  title: string;
  titlePolicy?: "auto" | "manual";
  eraId: string | null;
  /** premise, essentials, rules, perspective and the usual play settings. */
  settings: Partial<WorldSettings>;
  protagonist: { name: string; gender: string; age: number | null; identity: string };
  arrival: Arrival;
  origin: string;
  opening: { mode: "ai"; hint: string } | { mode: "player"; text: string };
  /** Without a built-in pack: let the AI organize the 设定集 from the premise (R03-T008). */
  organize?: boolean;
  /** 剧本 and 挑战 (R14); 旁观 is settings.pilot. */
  script?: ScriptInput | null;
  challenge?: ChallengeInput | null;
}

/** Why a 连播 ended (R14). */
export type AutoplayStop =
  | "count"     // every step was played
  | "stopped"   // the player pressed stop
  | "failed"    // a step failed (never retried)
  | "died"      // the protagonist died
  | "challenge" // the challenge ended
  | "script"    // the last beat was played
  | "busy"      // something was already being written; nothing started
  | "player";   // the player plays the protagonist (not 旁观); nothing started

export type AutoplayEvent =
  | TurnEvent
  | { type: "step"; index: number; total: number }
  | { type: "finished"; steps: number; reason: AutoplayStop };

export interface AutoplayHandle {
  /** Stops the step being written (keeping what was written, as a normal stop does) and starts no other. */
  stop(): void;
  /** Call when the page returns to the foreground. */
  catchUp(): Promise<void>;
  done: Promise<{ steps: number; reason: AutoplayStop }>;
  detach?(): void;
}

export interface PlayerAction {
  mode: ActionMode;
  text: string;
  directorNote?: string | null;
}

export interface TurnHandle {
  /** Stop generating; whatever was written is kept as an interrupted turn. */
  stop(): void;
  /** Call when the page returns to the foreground. */
  catchUp(): Promise<void>;
  done: Promise<void>;
  /** Leaving the page does not stop its native run. */
  detach?(): void;
}

interface UsageScope { worldId: string | null; nodeId: string | null; purpose: string }
type CarriedEdit = Pick<StoryNode, "record" | "actionText">;

const DEFAULT_CONTEXT_TOKENS = 12_000;
const CODEX_TIMEOUT = { firstByteMs: 30_000, idleMs: 30_000, totalMs: 75_000 };
// Free-mode wording is applied at the call site, keeping the shared chapter helper unchanged.
const FREE_CHAPTER_PROMPT_VERSION = "chapter-2-free";

/** Lines of an apply log that say what happened, not what was refused. */
const INFO_LOG = /^新人物：|只记录不提醒|按不限时处理/;

/**
 * What the player writes (写) or directs (幕后) happens as written: no luck in it (G5: a 大不顺 roll had the narrator jail
 * the protagonist in a scene the player wrote). Nor in 过些日子, which is no risky act (eval H: a roll jailed him for a month).
 * A world with luck off (R11-T008) rolls nothing at all, so no 签 chip either.
 */
const luckApplies = (mode: ActionMode, settings: WorldSettings) =>
  mode !== "write" && mode !== "direct" && mode !== "skip" && fortuneMode(settings.fortune) !== "off";

/**
 * A panel edit the engine did not carry out (AUDIT_V4_FUNCTION H1): nothing
 * would change, or part of it was refused. `reason` is for the player.
 */
export class EditRejected extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "EditRejected";
  }
}

/** The player-facing reason when `e` is an EditRejected; other errors are rethrown. */
export function rejectedReason(e: unknown): string {
  if (e instanceof EditRejected) return e.reason;
  throw e;
}

/** Why an edit had no effect, in the player's words; the log's raw data is left out. */
function rejection(before: WorldState, after: WorldState, log: string[]): string | null {
  const refused = log.filter((l) => !INFO_LOG.test(l)).map((l) => l.replace(/：[{[].*$/, ""));
  if (refused.length) return refused[0];
  return JSON.stringify(before) === JSON.stringify(after) ? "和现在的内容一样，没有需要保存的改动" : null;
}

export class Game {
  readonly repo: Repo;
  /** Dice for fortune rolls; tests replace it. */
  random: () => number = Math.random;
  /** The pause between two steps of a 连播; tests shorten it. */
  autoplayPauseMs = 1000;
  /** Per world: the tail of the queue that turns and edits wait on, so nodes are never appended concurrently. */
  private queues = new Map<string, Promise<unknown>>();
  private chaptering = new Set<string>();
  private background = new Set<Promise<void>>();
  private listeners = new Set<(worldId: string) => void>();

  private constructor(readonly platform: Platform, public llm: LlmConfig | null) {
    this.repo = new Repo(platform);
  }

  static async open(platform: Platform, llm: LlmConfig | null = null): Promise<Game> {
    await migrate(platform);
    const game = new Game(platform, llm);
    // Routes in the trash for 30 days go at start, not only when 世界线 is opened (AUDIT_V4_FUNCTION G2).
    await game.repo.purgeAllTrash().catch(() => 0);
    return game;
  }

  /** Runs `fn` after everything already queued for the world. */
  private serial<T>(worldId: string, fn: () => Promise<T>): Promise<T> {
    const next = (this.queues.get(worldId) ?? Promise.resolve()).catch(() => {}).then(fn);
    this.queues.set(worldId, next);
    void next.catch(() => {}).then(() => { if (this.queues.get(worldId) === next) this.queues.delete(worldId); });
    return next;
  }

  /**
   * A database backup a day (R08-T001): at start, when the newest automatic
   * backup is older than a day. The native side keeps the latest 20.
   */
  async autoBackup(now = Date.now()): Promise<string | null> {
    const backups = await this.platform.sql.listBackups().catch(() => []);
    const last = backups.filter((b) => b.name.includes("-auto.")).map((b) => Date.parse(b.at)).sort((a, b) => b - a)[0];
    if (last && now - last < 86_400_000) return null;
    return this.platform.sql.backup("auto").catch(() => null);
  }

  /** Resolves once tracked background work has finished; before a restore, and for tests and evals. */
  async settled(): Promise<void> {
    while (this.background.size) await Promise.allSettled([...this.background]);
  }

  private inBackground(work: Promise<void>): void {
    this.background.add(work);
    void work.catch(() => {}).then(() => this.background.delete(work));
  }

  /** Told when a world changed in the background (设定集 upkeep, a new chapter). Returns an unsubscribe. */
  subscribe(fn: (worldId: string) => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  /** The independent assistant committed canonical story data. */
  notifyAgentChange(worldId: string): void {
    for (const fn of this.listeners) fn(worldId);
  }

  /** The model used for side jobs (records, 设定集, chapters, 查一查), for usage rows; empty when no service. */
  private auxModelName(): string {
    return this.llm ? this.llm.auxModel || this.llm.model : "";
  }

  private requireExecution(): void {
    if (!this.platform.execution) throw new Error("当前环境未连接原生执行核心");
  }

  private requireLlm(): LlmConfig {
    if (!this.llm) throw new ChatError("no_secret");
    return this.llm;
  }

  private nativeFailure(snapshot: ExecutionSnapshot, fallback: string): Extract<TurnEvent, { type: "failed" }> {
    return { type: "failed", reason: nativeFailReason(snapshot.status, snapshot.error, snapshot.errorKind),
      runId: snapshot.id, detail: snapshot.error ?? fallback, partialSaved: false };
  }

  // ---------- model calls ----------

  /** One streamed call with a single retry before any data arrives. */
  private async call(
    messages: ChatMessage[],
    opts: { signal?: AbortSignal; aux?: boolean; timeouts?: typeof CODEX_TIMEOUT; usage: UsageScope },
  ): Promise<ChatResult> {
    const llm = this.requireLlm();
    const model = opts.aux ? llm.auxModel || llm.model : llm.model;
    for (let attempt = 1; ; attempt++) {
      if (opts.signal?.aborted) throw new ChatError("cancelled");
      let partial = "";
      let received: ChatResult | null = null;
      const handle = streamChat(this.platform, {
        slot: llm.slot, url: llm.url, model, messages,
        maxTokens: llm.maxTokens ?? 2048, includeUsage: llm.includeUsage, timeouts: opts.timeouts,
        extra: llm.extra as never,
      }, {
        onText: (_delta, full) => { if (!opts.signal?.aborted) partial = full; },
      });
      let cancel!: () => void;
      const cancellation = new Promise<never>((_, reject) => {
        cancel = () => {
          void handle.streamId.then((id) => this.platform.llm.cancel(id)).catch(() => {});
          reject(new ChatError("cancelled", undefined, partial));
        };
      });
      opts.signal?.addEventListener("abort", cancel, { once: true });
      if (opts.signal?.aborted) cancel();
      try {
        received = await Promise.race([handle.result, cancellation]);
        if (opts.signal?.aborted) throw new ChatError("cancelled", undefined, partial);
        return received;
      } catch (error) {
        const decision = retryDecision(error, attempt, messages);
        // Callers retain their successful business usage rows. Every failed request
        // has its own unknown usage; local credential/binding refusals sent nothing.
        const unsent = error instanceof ChatError && (error.kind === "no_secret" || error.kind === "url_not_bound");
        if (!unsent) {
          const scope = opts.usage;
          await this.platform.sql.batch([this.usage(scope.worldId, scope.nodeId, scope.purpose, received,
            error instanceof ChatError && error.kind === "cancelled" ? "cancelled" : "failed", model)]);
        }
        if (opts.usage.purpose !== "source" && !opts.signal?.aborted && decision.retry) { messages = decision.messages; continue; }
        throw error;
      } finally {
        opts.signal?.removeEventListener("abort", cancel);
        void handle.streamId.then((id) => this.platform.llm.ack(id)).catch(() => {});
      }
    }
  }

  private usage(worldId: string | null, nodeId: string | null, purpose: string, result: ChatResult | null, outcome: string, model: string): SqlStatement {
    return this.repo.usageStatement({
      worldId, nodeId, purpose, model,
      promptTokens: result?.usage?.promptTokens ?? null, completionTokens: result?.usage?.completionTokens ?? null,
      estimated: result?.usage?.promptTokens == null || result.usage.completionTokens == null,
      firstTokenMs: result?.firstTokenMs ?? null, totalMs: result?.totalMs ?? null, outcome,
    });
  }

  // ---------- opening ----------

  /** Expands a rough idea into a full setup; fields the player filled are kept. */
  async assist(idea: string, current: Partial<SetupDraft>): Promise<Partial<SetupDraft> | null> {
    try {
      const result = await this.call(await this.withOpeningSources(assistMessages(idea, current), current, idea), { usage: { worldId: null, nodeId: null, purpose: "assist" }, aux: true, timeouts: { firstByteMs: 30_000, idleMs: 30_000, totalMs: 90_000 } });
      const value = lenientJson(result.text) as Partial<SetupDraft> | null;
      await this.platform.sql.batch([this.usage(null, null, "assist", result, value ? "ok" : "no_record", this.auxModelName())]);
      return value;
    } catch {
      return null;
    }
  }

  /** “AI 帮我拟大纲” (R14): an outline from the opening filled in so far; null when it fails or gives no beat. */
  draftScript(current: DraftInput): Promise<ScriptInput | null> {
    return this.withOpeningSources(draftScriptMessages(current), current, current.script?.line ?? "").then((messages) => this.draft(messages, "outline", parseScriptDraft));
  }

  /** “AI 帮我出题” (R14): a challenge that suits the opening; null when it fails or gives no goal. */
  draftChallenge(current: DraftInput): Promise<ChallengeInput | null> {
    return this.withOpeningSources(draftChallengeMessages(current), current, current.challenge?.goal ?? "").then((messages) => this.draft(messages, "challenge", parseChallengeDraft));
  }

  /** The same scoped local reference retrieval as ordinary writing. No extra AI probe. */
  private async withOpeningSources(messages: ChatMessage[], current: Partial<SetupDraft>, idea: string): Promise<ChatMessage[]> {
    if (!current.source) return messages;
    const budget = Math.round((this.llm?.contextTokens ?? DEFAULT_CONTEXT_TOKENS) / (await this.tokenRatio()).value);
    const context = await referenceContext(this.repo, current.source, [idea, current.premise, current.identity, current.hint].filter(Boolean).join("\n"), Math.min(2400, Math.floor(budget / 4)));
    const instructions = referenceInstructionsBlock(context);
    const evidence = referenceEvidenceBlock(context);
    return [...messages, { role: "user", content: `【本次开局参考】保留选定作品、起点和参考范围。以下原文只用于核对世界设定；不得将模型印象冒充原著。资料不足写在设定中待确认，不杜撰原著细节。${instructions}${evidence}` }];
  }

  private async draft<T>(messages: ChatMessage[], purpose: string, parse: (value: unknown) => T | null): Promise<T | null> {
    try {
      const result = await this.call(messages, { usage: { worldId: null, nodeId: null, purpose }, aux: true, timeouts: { firstByteMs: 30_000, idleMs: 30_000, totalMs: 90_000 } });
      const value = parse(lenientJson(result.text));
      await this.platform.sql.batch([this.usage(null, null, purpose, result, value ? "ok" : "no_record", this.auxModelName())]);
      return value;
    } catch {
      return null;
    }
  }

  /** One organizing call (R03-T008); null when it fails, which never blocks play. */
  private async codex(input: CodexInput, usage: UsageScope = { worldId: null, nodeId: null, purpose: "codex" }): Promise<ChatResult | null> {
    try {
      return await this.call(codexMessages(input), { usage, aux: true, timeouts: CODEX_TIMEOUT });
    } catch {
      return null;
    }
  }

  /** Organizes the 设定集 again from the current premise; an undoable edit node, or null if nothing came back. */
  async organize(worldId: string, opts: { replaceOwnEra?: boolean } = {}): Promise<tree.Cursor | null> {
    const world = await this.repo.getWorld(worldId);
    if (!world) return null;
    const state = await this.repo.getState((await tree.cursor(this.repo, worldId)).head.id);
    const me = state.protagonist;
    const result = await this.codex({
      mode: state.era.mode,
      premise: world.settings.premise, protagonist: { name: me.name, gender: me.gender, age: me.age, identity: me.identity },
      arrival: (await this.setupOf(worldId))?.arrival ?? "魂穿",
      known: [...state.cards.filter((c) => c.kind !== "时代").map((c) => c.name), ...state.places.map((p) => p.name)],
    }, { worldId, nodeId: null, purpose: "codex" });
    let patch = result ? codexPatch(result.text, state, opts) : null;
    // Great events only fill a timeline that has none from a pack or an earlier pass, on a CE-dated start.
    const seeded = state.timeline?.some((e) => e.source === "卡组" || e.source === "AI");
    if (patch?.timeline && (seeded || eraContext(world.eraId, state).clock.date?.ceYear == null)) {
      const { timeline: _t, ...rest } = patch;
      patch = rest.cards || rest.places ? rest : null;
    }
    if (result) await this.platform.sql.batch([this.usage(worldId, null, "codex", result, patch ? "ok" : "no_record", this.auxModelName())]);
    if (!patch) return null;
    const edited = await this.serial(worldId, () => this.appendEdit(worldId, patch, codexSummary(patch, state), { by: "AI", promptVersion: state.era.mode === "free" ? CODEX_FREE_PROMPT_VERSION : CODEX_PROMPT_VERSION }));
    return "rejected" in edited ? null : edited;
  }

  async createWorld(input: NewWorld, onEvent: (e: TurnEvent) => void): Promise<string | null> {
    this.requireExecution();
    if (input.source) {
      const book = validBinding(input.source) ? await getBook(this.repo, input.source.bookId) : null;
      if (!book || input.source.position >= book.sections.length || input.source.through !== null && (input.source.through >= book.sections.length || input.source.position > input.source.through)) { onEvent({ type: "failed", reason: "config", partialSaved: false }); return null; }
    }
    const settings: WorldSettings = { ...DEFAULT_SETTINGS, ...input.settings };
    const free = settings.mode === "free";
    const pack = free ? null : eraPack(input.eraId);
    const p = input.protagonist;
    // A built-in pack is only a preset: its era card, places, calendar and currency are copied in (D121).
    const preset = pack ? packCards(pack) : { cards: [], places: [] };
    const initial: WorldState = {
      ...(input.source && validBinding(input.source) ? { source: structuredClone(input.source) } : {}),
      version: 2,
      time: { start: pack ? formatDate(pack.start.date, pack.calendar) : "", date: pack?.start.date ?? null, startHour: pack?.start.hour, elapsedMinutes: 0 },
      placeId: null,
      protagonist: {
        name: p.name, aliases: [], age: p.age, gender: p.gender, identity: p.identity,
        origin: input.arrival === "不穿越" ? "" : input.origin, cheat: "",
        ...(settings.heroPanel !== undefined ? { panel: settings.heroPanel } : {}),
        stats: { money: 0, debt: 0, health: 80, energy: 70, fame: 10 }, statuses: [], items: [],
      },
      people: [], places: preset.places, cards: preset.cards, goals: [], deviations: [],
      era: {
        packId: pack?.id ?? null,
        ...(settings.mode ? { mode: settings.mode } : {}),
        ...(settings.clockStyle ? { clockStyle: settings.clockStyle } : free ? { clockStyle: "elapsed" as const } : {}),
        ...(pack ? { calendar: structuredClone(pack.calendar), currency: structuredClone(pack.currency) } : {}),
      },
    };
    // Play modes (R14): the challenge's limit counts from the start.
    const script = input.script ? newScript(input.script) : null;
    const challenge = input.challenge ? newChallenge(input.challenge, 0) : null;
    if (script) initial.script = script;
    if (challenge) initial.challenge = challenge;
    const setupLog = challenge?.limit && challenge.deadlineMinute === null ? [`期限“${challenge.limit}”无法换算，按不限时处理`] : [];
    const era = eraContext(pack?.id ?? null, initial);
    const inputBudget = Math.round((this.llm?.contextTokens ?? DEFAULT_CONTEXT_TOKENS) / (await this.tokenRatio()).value);
    const openingReference = fitReference(await referenceContext(this.repo, initial.source, [settings.premise, p.name, p.identity, input.opening.mode === "ai" ? input.opening.hint : ""].join("\n"), Math.floor(inputBudget / 4)), Math.min(3000, Math.floor(inputBudget / 4)));
    const opening = {
      reference: openingReference,
      era, settings, protagonistName: p.name, protagonist: p, arrival: input.arrival, origin: input.origin, hint: input.opening.mode === "ai" ? input.opening.hint : "",
      script: initial.script, challenge: initial.challenge,
    };
    const openingBaseChars = openingMessages({ ...opening, reference: undefined }).reduce((n, m) => n + m.content.length, 0) + referenceInstructionsBlock(opening.reference).length;
    opening.reference = fitReference(opening.reference, Math.max(0, Math.min(inputBudget / 4, inputBudget - openingBaseChars)));
    const titlePolicy = input.titlePolicy ?? (input.title.trim() ? "manual" : "auto");
    const nameOpening = (messages: ChatMessage[]): ChatMessage[] => titlePolicy === "auto" ? [...messages, { role: "system", content: "本次是新故事开场。请结合本段实际开场拟一个小说书名（2～12字为宜，最多24字）：像书架上的网文或小说名，点出核心处境、悬念或人物志向，可用意象或反差；不用“某某的故事/某某传/穿越之XX/重生之XX/我在XX当XX”等套式，不堆砌“天下、风云、传奇、录”，不照抄主角姓名或朝代名。将书名写在本次记录对象额外字段 storyTitle 中；书名不属于剧情、人物状态或 log，不写进正文。" }] : messages;

    const worldId = newId(), lineId = newId();
    const plan: RunPlan = {
      id: newId(), worldId, lineId, headId: "", baseId: null, kind: "opening",
      model: this.requireLlm(),
      messages: nameOpening(input.opening.mode === "player" ? openingExtractMessages({ ...opening, text: input.opening.text.trim() }) : openingMessages(opening)),
      extractMessages: nameOpening(openingExtractMessages({ ...opening, text: "{{NARRATIVE}}" })),
      state: initial, settings,
      options: { mode: "do", difficulty: settings.difficulty, currency: era.currency, clock: era.clock },
      action: { mode: "continue", text: "" }, reference: opening.reference,
      newWorld: { title: titlePolicy === "manual" ? input.title.trim() || "未命名故事" : "未命名故事", eraId: pack?.id ?? "free" },
      meta: {
        promptVersion: PROMPT_VERSION, titlePolicy, referenceReviewVersion: "reference-review-2", budgetChars: inputBudget, startMoney: pack?.startMoney ?? 0,
        playerWritten: input.opening.mode === "player", ...(input.opening.mode === "player" ? { playerNarrative: input.opening.text.trim() } : {}),
        setup: { arrival: input.arrival, hint: input.opening.mode === "ai" ? input.opening.hint : "", organize: !pack && input.organize === true && !initial.source },
        ...(pack ? { openingTimeline: packTimeline(pack.timeline, era.clock).map((e) => ({ id: newId(), ...e })) } : {}),
        ...(!pack && input.organize === true && !initial.source ? { codexMessages: codexMessages({ mode: initial.era.mode, premise: settings.premise, protagonist: p, arrival: input.arrival }) } : {}),
      },
    };
    const handle = startRun(this.platform, plan, (event) => this.nativeEvent(event, onEvent));
    try {
      const snapshot = await handle.done;
      if (snapshot.status !== "committed") { onEvent(this.nativeFailure(snapshot, "开场尚未完成，进度已保存")); return null; }
      const result = snapshot.result as { nodeId?: string };
      const node = result.nodeId ? await this.repo.getNode(result.nodeId) : null;
      if (!node) throw new Error("开场提交结果不完整");
      onEvent({ type: "done", cursor: await tree.cursor(this.repo, worldId), node, chips: (node.meta.chips as Chip[]) ?? [] });
      return worldId;
    } catch (error) { onEvent({ type: "failed", reason: "config", detail: error instanceof Error ? error.message : "开场未能完成", partialSaved: false }); return null; }
  }

  /** How a world began, for "再来一局同样设定": the opening's protagonist and arrival with the world's current settings. */
  async setupOf(worldId: string): Promise<NewWorld | null> {
    const world = await this.repo.getWorld(worldId);
    const opening = world ? (await this.repo.path((await tree.cursor(this.repo, worldId)).head.id)).find((n) => n.kind === "opening") ?? null : null;
    if (!world || !opening) return null;
    const state = await this.repo.getState(opening.id);
    const me = state.protagonist;
    const setup = (opening.meta.setup ?? {}) as { arrival?: Arrival; hint?: string; organize?: boolean };
    return {
      title: world.title, eraId: state.era.mode === "free" ? null : eraPack(world.eraId)?.id ?? null,
      source: state.source,
      settings: { ...world.settings, mode: state.era.mode, clockStyle: state.era.clockStyle, heroPanel: me.panel },
      protagonist: { name: me.name, gender: me.gender, age: me.age, identity: me.identity },
      arrival: setup.arrival ?? (me.origin ? "魂穿" : "不穿越"), origin: me.origin,
      opening: opening.meta.playerWritten ? { mode: "player", text: opening.narrative } : { mode: "ai", hint: setup.hint ?? "" },
      organize: setup.organize ?? (state.era.mode === "free" || !eraPack(world.eraId)),
      // The script and challenge as the story began, for “再挑战一次”.
      ...(state.script ? { script: scriptInputOf(state.script) } : {}),
      ...(state.challenge ? { challenge: challengeInputOf(state.challenge) } : {}),
    };
  }

  // ---------- turns ----------

  /**
   * A hidden edit node after the head; `by` marks edits the AI made for the player (organizing).
   * Rejects with EditRejected, and adds no node, when the edit would change nothing or was refused (H1).
   */
  async editState(worldId: string, patch: TurnRecord, summary: string, by?: "AI", expectedHeadId?: string): Promise<tree.Cursor> {
    const result = await this.serial(worldId, () => this.appendEdit(worldId, patch, summary, by ? { by } : {}, expectedHeadId));
    if ("rejected" in result) throw new EditRejected(result.rejected);
    return result;
  }

  /** Direct deterministic time correction; no model, no Agent session, original route retained. */
  async correctDuration(preview: import("./calendar/manualTime").DurationCorrectionPreview): Promise<tree.Cursor> {
    const { adoptDurationCorrection } = await import("./calendar/manualTime");
    return this.serial(preview.guard.worldId, () => adoptDurationCorrection(this, preview));
  }

  /** Player configuration only: external material can never set current facts through a model record. */
  async bindSource(worldId: string, source: SourceBinding | null): Promise<void> {
    if (source) {
      const book = validBinding(source) ? await getBook(this.repo, source.bookId) : null;
      if (!book || source.position >= book.sections.length || source.through !== null && (source.through >= book.sections.length || source.position > source.through)) throw new Error("参考书籍或用法无效，请重新选择");
    }
    await this.editState(worldId, { sourceSet: source }, source ? "你修改了参考书籍用法" : "你解除了参考书籍绑定");
  }

  private nativeEvent(event: Record<string, unknown>, onEvent: (event: TurnEvent) => void): void {
    if (event.type === "thinking" || event.type === "organizing") onEvent({ type: event.type });
    else if (event.type === "text" && typeof event.full === "string") onEvent({ type: "text", delta: typeof event.delta === "string" ? event.delta : "", full: event.full });
    // Completion is reconstructed from durable nodes after the terminal snapshot.
  }

  async currentExecution(worldId: string): Promise<{ id: string; status: string; error: string | null; kind: string; steps: number; total: number; hasText: boolean } | null> {
    if (!this.platform.execution) return null;
    const cursor = await tree.cursor(this.repo, worldId);
    const [row] = await this.platform.sql.query(`SELECT id,status,error,json_extract(plan_json,'$.kind') AS kind,COALESCE(json_extract(draft_json,'$.steps'),0) AS steps,COALESCE(json_extract(plan_json,'$.meta.autoplayCount'),0) AS total,EXISTS(SELECT 1 FROM execution_events e WHERE e.run_id=CASE WHEN json_extract(plan_json,'$.kind')='autoplay' THEN json_extract(draft_json,'$.childId') ELSE execution_runs.id END AND json_extract(e.event_json,'$.type')='text') AS has_text FROM execution_runs WHERE world_id=? AND line_id=? AND base_head_id=?
      AND status NOT IN ('committed','previewed','stale') AND json_extract(plan_json,'$.kind') IN ('turn','variant','continue','autoplay') ORDER BY created_at DESC LIMIT 1`, [worldId, cursor.line.id, cursor.head.id]);
    return row ? { id: String(row.id), status: String(row.status), error: row.error === null ? null : String(row.error), kind: String(row.kind), steps: Number(row.steps), total: Number(row.total), hasText: !!row.has_text } : null;
  }

  followExecution(id: string, onEvent: (event: TurnEvent) => void, resume = false): TurnHandle {
    let active: ReturnType<typeof startRun> | null = null, stopped = false, detached = false;
    let deliveries = Promise.resolve();
    const done = (async () => {
      try {
        const execution = this.platform.execution;
        if (!execution) throw new Error("当前环境未连接原生执行核心");
        const [run] = await this.platform.sql.query("SELECT json_extract(plan_json,'$.kind') AS kind FROM execution_runs WHERE id=?", [id]);
        const autoplay = run?.kind === "autoplay";
        let after = 0;
        if (autoplay) {
          const snapshot = await execution.snapshot(id);
          for (const event of snapshot.events) if (event.event && typeof event.event === "object" && !Array.isArray(event.event) && event.event.type === "done") after = event.seq;
        }
        if (resume) await execution.resume(id);
        active = startRun(this.platform, null, (event) => {
          deliveries = deliveries.then(async () => {
            if (detached) return;
            if (autoplay && event.type === "step") onEvent({ type: "step", index: Number(event.index), total: Number(event.total) });
            else if (autoplay && event.type === "done" && typeof event.nodeId === "string") {
              const node = await this.repo.getNode(event.nodeId);
              if (node) onEvent({ type: "done", cursor: await tree.cursor(this.repo, node.worldId), node, chips: (node.meta.chips as Chip[]) ?? [] });
            } else this.nativeEvent(event, onEvent);
          });
        }, id, after);
        if (stopped) active.cancel();
        if (detached) active.detach();
        const snapshot = await active.done;
        await deliveries;
        if (snapshot.status !== "committed") {
          if (!detached) onEvent(this.nativeFailure(snapshot, "进度已保存"));
          return;
        }
        const result = snapshot.result as { nodeId?: string }, node = result.nodeId ? await this.repo.getNode(result.nodeId) : null;
        if (autoplay) {
          const result = snapshot.result as { steps: number; reason: AutoplayStop };
          if (!detached) onEvent({ type: "finished", steps: result.steps, reason: result.reason });
        } else {
          if (!node) throw new Error("生成提交结果不完整");
          if (!detached) onEvent({ type: "done", cursor: await tree.cursor(this.repo, snapshot.worldId), node, chips: (node.meta.chips as Chip[]) ?? [] });
        }
        for (const fn of this.listeners) fn(snapshot.worldId);
      } catch (error) { if (!detached) onEvent({ type: "failed", reason: "config", detail: error instanceof Error ? error.message : "暂时不能恢复这次生成", partialSaved: false }); }
    })();
    return { done, stop() { stopped = true; active?.cancel(); }, async catchUp() { detached = false; await active?.catchUp(); }, detach() { detached = true; active?.detach(); } };
  }

  private async nativeGuard(worldId: string, headId: string): Promise<Record<string, unknown>> {
    const [row] = await this.platform.sql.query("SELECT settings_json FROM worlds WHERE id=?", [worldId]);
    const state = await this.repo.getState(headId);
    return { settingsGuard: JSON.parse(String(row.settings_json)), sourceGuard: state.source ?? null };
  }

  /** UI edits and revisions settle through the same rules as both native runners. */
  async settleRecord(state: WorldState, record: TurnRecord, context: Parameters<typeof applyRecord>[2], options?: Parameters<typeof applyRecord>[3]): Promise<ReturnType<typeof applyRecord>> {
    if (this.platform.execution) return await this.platform.execution.settle(asJson(state), asJson(record), asJson({ ...context, ...options })) as unknown as ReturnType<typeof applyRecord>;
    return applyRecord(state, record, context, options);
  }

  private nativeTurn(worldId: string, actionIn: PlayerAction | null, kind: "turn" | "variant" | "continue", hint: string | null, onEvent: (e: TurnEvent) => void, batch?: { turns: number; onStep(index: number, total: number): void; onFinished(steps: number, reason: AutoplayStop): void }): TurnHandle {
    this.requireExecution();
    let active: ReturnType<typeof startRun> | null = null, stopped = false, detached = false;
    let deliveries = Promise.resolve();
    const done = this.serial(worldId, async () => {
      try {
        const current = await tree.cursor(this.repo, worldId), world = (await this.repo.getWorld(worldId))!;
        const headState = await this.repo.getState(current.head.id);
        let target = current.head;
        const trailing: StoryNode[] = [];
        if (kind !== "turn") while (target.kind === "edit" && target.parentId) { trailing.unshift(target); target = (await this.repo.getNode(target.parentId))!; }
        if (kind !== "turn" && !target.parentId) throw new Error("开场请使用按原著纠错或重新开局");
        if (kind === "continue" && target.status !== "interrupted") throw new Error("这段正文没有待续写的中断");
        const base = kind === "turn" ? current.head : (await this.repo.getNode(target.parentId!))!;
        const action = actionIn ?? { mode: target.actionMode ?? "continue", text: target.actionText ?? "", directorNote: target.directorNote };
        const state = await this.repo.getState(base.id), era = eraContext(world.eraId, state);
        const fortune = luckApplies(action.mode, world.settings) ? await this.fortuneFor(base, world.settings.difficulty, kind === "variant" && hint === "换个结果") : undefined;
        const input = await this.turnInput(worldId, base, { ...action, rewriteHint: kind === "continue" ? target.meta.rewriteHint as string | undefined : hint, fortune }, headState.source);
        if (batch) input.settings = { ...input.settings, pilot: "ai" };
        const template = writingContextTemplate(input);
        const context = this.platform.execution?.context ? await this.platform.execution.context(asJson({ ...input, allTurns: undefined, history: input.history.map(({ id, kind, actionMode, actionText, narrative }) => ({ id, kind, actionMode, actionText, narrative })), template })) as unknown as ReturnType<typeof buildTurnContext> : buildTurnContext(input);
        const path = await this.repo.path(base.id);
        const upkeepTurns: StoryNode[] = [];
        for (const node of [...path].reverse()) { if (node.kind === "opening" || node.meta.upkeep) break; if (node.kind === "turn") upkeepTurns.unshift(node); }
        const pending = await this.unsummarized(worldId, base);
        const futureTurn = { actionText: action.text, narrative: "{{NARRATIVE}}" };
        const plan: RunPlan = {
          id: newId(), worldId, lineId: current.line.id, headId: current.head.id, baseId: base.id, kind: batch ? "autoplay" : kind,
          model: this.requireLlm(),
          messages: kind === "continue" ? continueMessages(context.messages, target.narrative) : context.messages,
          extractMessages: extractMessages({ era, state, action: action.text || "（继续）", narrative: "{{NARRATIVE}}", settings: world.settings }),
          state, settings: world.settings,
          options: { mode: action.mode, difficulty: world.settings.difficulty, currency: era.currency, clock: era.clock, fortune, asked: action.mode === "skip" ? skipSpanMinutes(action.text) ?? undefined : undefined },
          action, reference: context.reference, original: kind === "continue" ? target.narrative : "",
          trailingIds: kind === "continue" ? trailing.map((n) => n.id) : [],
          carriedEdits: kind === "variant" ? [...((target.meta.carriedEdits as CarriedEdit[] | undefined) ?? []), ...trailing.filter((n) => n.meta.by !== "AI").map(({ record, actionText }) => ({ record, actionText }))] : (target.meta.carriedEdits as CarriedEdit[] | undefined) ?? [],
          meta: {
            ...(await this.nativeGuard(worldId, current.head.id)),
            promptVersion: PROMPT_VERSION, referenceReviewVersion: "reference-review-2", budgetChars: input.budgetChars, writingContext: { template, era: input.era, pins: input.pins ?? [], settings: world.settings }, ...(kind === "continue" ? { targetId: target.id } : {}),
            ...(hint ? { rewriteHint: hint } : {}),
            ...(batch ? {
              autoplayCount: batch.turns, autoplayPilot: "temporary-ai", autoplayBudgetVersion: "per-passage-1", autoplayPauseMs: this.autoplayPauseMs, upkeepEvery: UPKEEP_EVERY,
              upkeepVersion: state.era.mode === "free" ? UPKEEP_FREE_PROMPT_VERSION : UPKEEP_PROMPT_VERSION,
              chapterVersion: state.era.mode === "free" ? FREE_CHAPTER_PROMPT_VERSION : CHAPTER_PROMPT_VERSION,
              autoplayTurnSystem: context.messages.find((m) => m.role === "system")?.content ?? "",
              autoplayExtractSystem: extractMessages({ era, state, action: "（继续）", narrative: "{{NARRATIVE}}", settings: world.settings })[0].content,
              autoplayUpkeepSystem: upkeepMessages({ premise: world.settings.premise, state, turns: [] })[0].content,
              autoplayChapterSystem: chapterMessages({ premise: world.settings.premise, protagonist: state.protagonist.name, previous: [], turns: [], firstTurn: 1 })[0].content,
            } : {}),
            ...(kind === "turn" && world.settings.autoUpkeep && upkeepTurns.length + 1 >= UPKEEP_EVERY ? { upkeepMessages: upkeepMessages({ premise: world.settings.premise, state, turns: [...upkeepTurns, futureTurn] }), upkeepVersion: state.era.mode === "free" ? UPKEEP_FREE_PROMPT_VERSION : UPKEEP_PROMPT_VERSION } : {}),
            ...(kind === "turn" && world.settings.chapterEvery && pending.turns.length + 1 >= world.settings.chapterEvery ? {
              chapterMessages: chapterMessages({ premise: world.settings.premise, protagonist: state.protagonist.name, previous: pending.chapters, turns: [...pending.turns, futureTurn], firstTurn: pending.firstTurn }),
              chapterFirstId: pending.turns[0]?.id ?? "{{NODE_ID}}", chapterVersion: CHAPTER_PROMPT_VERSION,
            } : {}),
          },
        };
        if (stopped) { onEvent({ type: "failed", reason: "cancelled", partialSaved: false }); return; }
        active = startRun(this.platform, plan, (event) => {
          if (!batch) { if (!detached) this.nativeEvent(event, onEvent); return; }
          deliveries = deliveries.then(async () => {
            if (detached) return;
            if (event.type === "step") batch.onStep(Number(event.index), Number(event.total));
            else if (event.type === "done" && typeof event.nodeId === "string") {
              const node = await this.repo.getNode(event.nodeId);
              if (node) onEvent({ type: "done", cursor: await tree.cursor(this.repo, worldId), node, chips: (node.meta.chips as Chip[]) ?? [] });
            } else this.nativeEvent(event, onEvent);
          });
        });
        const snapshot = await active.done;
        await deliveries;
        if (batch) {
          const result = snapshot.result as { steps?: number; reason?: AutoplayStop } | null;
          const draft = snapshot.draft as { steps?: number } | null;
          if (snapshot.status !== "committed" && !detached) onEvent(this.nativeFailure(snapshot, "连播进度已保存"));
          batch.onFinished(result?.steps ?? draft?.steps ?? 0, result?.reason ?? (stopped ? "stopped" : "failed"));
          for (const fn of this.listeners) fn(worldId);
          return;
        }
        if (snapshot.status !== "committed") { onEvent(this.nativeFailure(snapshot, "进度已保存，可以稍后恢复")); return; }
        const result = snapshot.result as { nodeId?: string };
        const node = result.nodeId ? await this.repo.getNode(result.nodeId) : null;
        if (!node) throw new Error("生成提交结果不完整");
        if (!detached) onEvent({ type: "done", cursor: await tree.cursor(this.repo, worldId), node, chips: (node.meta.chips as Chip[]) ?? [] });
        for (const fn of this.listeners) fn(worldId);
      } catch (error) { if (!detached) onEvent({ type: "failed", reason: stopped ? "cancelled" : "config", detail: error instanceof Error ? error.message : "这次生成没有完成", partialSaved: false }); batch?.onFinished(0, stopped ? "stopped" : "failed"); }
    });
    return { done, stop() { stopped = true; active?.cancel(); }, catchUp: async () => { detached = false; await active?.catchUp(); }, detach() { detached = true; active?.detach(); } };
  }

  runCanonCorrection(request: CanonCorrectionRequest, onText: (text: string) => void): CanonCorrectionHandle {
    let active: ReturnType<typeof startRun> | null = null, cancelled = false, detached = false;
    const done = (async (): Promise<CanonCorrectionPreview> => {
      await assertWritingAnchor(this, request.anchor);
      const { anchor } = request, world = (await this.repo.getWorld(anchor.worldId))!, target = (await this.repo.getNode(anchor.nodeId))!;
      const current = await this.repo.getState(anchor.headId), targetState = await this.repo.getState(anchor.nodeId);
      if (!validBinding(current.source)) throw new WritingError("先在本局设置绑定参考书籍");
      const baseline = target.parentId ? await this.repo.getState(target.parentId) : target.meta.openingSeed ?? request.baseline;
      if (!target.parentId && !isOpeningSeed(baseline)) throw new WritingError(MISSING_OPENING_SEED);
      if (!baseline || typeof baseline !== "object") throw new WritingError("找不到修订前的状态");
      const source = { ...current.source, ...(targetState.source?.bookId === current.source.bookId ? { position: Math.min(targetState.source.position, current.source.through ?? Infinity) } : {}) };
      const state = { ...(structuredClone(baseline) as WorldState), source }, era = eraContext(world.eraId, state);
      const budget = Math.round((this.llm?.contextTokens ?? DEFAULT_CONTEXT_TOKENS) / (await this.tokenRatio()).value);
      const reference = await referenceContext(this.repo, source, { text: anchor.original, rewriteHint: request.hint, entities: [state.protagonist, ...state.people.filter(p => anchor.original.includes(p.name)).slice(0, 6)].map(({ name, aliases }) => ({ name, aliases })) }, budget / 4);
      if (!reference) throw new WritingError("参考书籍不存在，请重新绑定");
      const focus = anchor.original.slice(request.range.start, request.range.end);
      const surrounding = anchor.original.slice(Math.max(0, request.range.start - 700), request.range.start) + "\n【选中范围之后】" + anchor.original.slice(request.range.end, request.range.end + 700);
      const relevant = focus + surrounding;
      const focusedState = { ...state, people: state.people.filter(p => [p.name, ...p.aliases].some(name => name && relevant.includes(name))) };
      const messages: ChatMessage[] = [
        { role: "system", content: canonCorrectionRules(world.settings, state, !target.parentId) },
        { role: "user", content: `${referenceInstructionsBlock(reference)}\n【选中范围】\n${focus}\n【必要前后文】\n${surrounding}\n【玩家要求】\n${request.hint}\n【本回合玩家行动】${target.actionText ?? "开场"}\n【修订前的本局事实】${renderState(focusedState, era, new Set(focusedState.people.map(p => p.id)), world.settings)}\n【原回合记录，仅修改受影响字段】${JSON.stringify(target.record)}\n旧资料来源不明的事实待核实。只预览选中范围，不清洗整局历史。` },
      ];
      const plan: RunPlan = {
        id: newId(), worldId: anchor.worldId, lineId: anchor.lineId, headId: anchor.headId, baseId: target.parentId, kind: "correction",
        model: this.requireLlm(), messages, extractMessages: [], state, settings: world.settings,
        options: { mode: target.actionMode ?? "continue", difficulty: world.settings.difficulty, currency: era.currency, clock: era.clock },
        action: { mode: target.actionMode ?? "continue", text: target.actionText ?? "" }, reference,
        meta: { ...(await this.nativeGuard(anchor.worldId, anchor.headId)), anchor, correctionRange: request.range, originalRecord: target.record, writingVersion: CANON_WRITING_PROMPT_VERSION, rewriteHint: request.hint, budgetChars: budget, baseline: target.parentId ? undefined : baseline },
      };
      if (cancelled) throw new ChatError("cancelled");
      active = startRun(this.platform, plan, (event) => { if (!detached && event.type === "text" && typeof event.full === "string") { const value = lenientJson(event.full) as { replacement?: string; narrative?: string } | null; if (value?.replacement) onText(value.replacement); } });
      if (detached) active.detach();
      const snapshot = await active.done;
      if (snapshot.status !== "previewed") throw new WritingError(snapshot.error ?? "原著改稿尚未完成，原路线未改动");
      const preview = snapshot.result as unknown as CanonCorrectionPreview;
      preview.recordChanges = correctionRecordChanges(target.record as TurnRecord | null, preview.record);
      await assertWritingAnchor(this, anchor);
      if (!detached) onText(preview.replacement ?? preview.narrative);
      return preview;
    })();
    return { done, cancel() { cancelled = true; active?.cancel(); }, async catchUp() { detached = false; await active?.catchUp(); }, detach() { detached = true; active?.detach(); } };
  }

  private sourceRuns = new Map<string, AbortController>();
  pauseSourceAnalysis(jobId: string) { this.sourceRuns.get(jobId)?.abort(); }
  async analyzeSource(binding: SourceBinding, onProgress: (job: AnalysisJob) => void): Promise<AnalysisJob> {
    const book = await getBook(this.repo, binding.bookId); if (!book) throw new Error("书籍不存在");
    const model = this.auxModelName(); this.requireLlm();
    let job = (await analysisJobs(this.repo, book.id)).find((j) => j.id === binding.analysisId);
    if (!job) job = newAnalysisJob(book, binding, model);
    if (job.model !== model || job.instructions !== binding.instructions || job.through !== binding.through || job.promptVersion !== SOURCE_PROMPT_VERSION) throw new Error("用法、范围或整理模型已变化，请新建一次整理；旧结果仍保留");
    if (this.sourceRuns.has(job.id)) throw new Error("这份书籍正在整理");
    const controller = new AbortController(); this.sourceRuns.set(job.id, controller);
    const chunks = chunksOf(book).filter((c) => job!.through === null || c.section <= job!.through!);
    const [count] = await this.platform.sql.query("SELECT COUNT(*) AS n FROM source_analysis WHERE job_id=?", [job.id]);
    job = { ...job, completed: Number(count.n), status: "running", error: undefined }; await saveJob(this.repo, job); onProgress({ ...job });
    try {
      for (const chunk of chunks) {
        if (controller.signal.aborted) break;
        const [cached] = await this.platform.sql.query("SELECT ordinal FROM source_analysis WHERE job_id=? AND ordinal=?", [job.id, chunk.ordinal]);
        if (cached) continue;
        const result = await this.call(sourceAnalysisMessages(book, chunk, job.instructions), { aux: true, signal: controller.signal, usage: { worldId: null, nodeId: null, purpose: "source" }, timeouts: CODEX_TIMEOUT });
        if (controller.signal.aborted) { await this.platform.sql.batch([this.usage(null, null, "source", result, "cancelled", model)]); break; }
        if (!result.text.trim() || refusedFinish(result.finishReason) || isNotice(result.text)) { await this.platform.sql.batch([this.usage(null, null, "source", result, "refused", model)]); throw new Error("模型没有返回可用整理，请稍后重试"); }
        const parsed = sourceAnalysisResult(result.text, book, chunk, job);
        await this.platform.sql.batch([
          { sql: "INSERT INTO source_analysis(job_id,book_id,ordinal,section,text) VALUES(?,?,?,?,?)", params: [job.id, book.id, chunk.ordinal, chunk.section, parsed.text] },
          ...parsed.statements,
          this.usage(null, null, "source", result, "ok", model),
        ]);
        job = { ...job, completed: job.completed + 1 }; await saveJob(this.repo, job); onProgress({ ...job });
      }
      job = { ...job, status: controller.signal.aborted ? "paused" : "done" };
    } catch (error) {
      job = { ...job, status: controller.signal.aborted ? "paused" : "failed", error: controller.signal.aborted ? undefined : "这一节没能整理，已完成的部分保留，可继续重试" };
    } finally { this.sourceRuns.delete(job.id); }
    await saveJob(this.repo, job); onProgress({ ...job }); return job;
  }

  /**
   * The player's edits are all or nothing: one refused part rejects the whole
   * edit, so the summary never claims what did not happen. The AI's own edits
   * keep what applied and are dropped only when nothing changed.
   */
  private async appendEdit(worldId: string, patch: TurnRecord, summary: string, meta: Record<string, unknown> = {}, expectedHeadId?: string): Promise<tree.Cursor | { rejected: string }> {
    const c = await tree.cursor(this.repo, worldId);
    if (expectedHeadId && c.head.id !== expectedHeadId) throw new Error("故事已变化，请重新打开时间设置。");
    const state = await this.repo.getState(c.head.id);
    const world = (await this.repo.getWorld(worldId))!;
    const era = eraContext(world.eraId, state);
    const applied = await this.settleRecord(state, patch, { mode: "do", difficulty: world.settings.difficulty, currency: era.currency, clock: era.clock }, { advanceTime: false });
    const id = newId();
    let hasContinuity = false;
    if (patch.continuity) {
      const checked = await validateContinuity(this.repo, worldId, c.head.id, id, "", summary, applied.state, patch.continuity, meta.by !== "AI");
      hasContinuity = Object.keys(checked.changes).length > 0;
      patch = { ...patch, ...(hasContinuity ? { continuity: checked.changes } : {}) };
      if (!hasContinuity) delete patch.continuity;
      applied.log.push(...checked.issues);
    }
    const rejected = rejection(state, applied.state, meta.by === "AI" ? [] : applied.log);
    if (rejected && !(hasContinuity && JSON.stringify(state) === JSON.stringify(applied.state) && !applied.log.length)) return { rejected };
    return tree.append(this.repo, c, {
      id, kind: "edit", narrative: "", actionText: hasContinuity && JSON.stringify(state) === JSON.stringify(applied.state) ? (meta.by === "AI" ? "AI补记了人物知情与线索" : "你更新了人物知情与线索") : summary,
      ...(hasContinuity ? { directorNote: summary } : {}), record: patch, choices: [],
      state: applied.state, meta: { chips: applied.chips, ...meta },
    }, expectedHeadId || hasContinuity ? { headId: expectedHeadId ?? c.head.id, requireIdle: true } : undefined);
  }

  /** A new turn after the current head. */
  play(worldId: string, action: PlayerAction, onEvent: (e: TurnEvent) => void): TurnHandle {
    return this.nativeTurn(worldId, action, "turn", null, onEvent);
  }

  /** Another version of the head turn, optionally with a direction ("写短一点"). */
  regenerate(worldId: string, hint: string | null, onEvent: (e: TurnEvent) => void): TurnHandle {
    return this.nativeTurn(worldId, null, "variant", hint, onEvent);
  }

  /**
   * 连播 (R14): up to `turns` ordinary “继续” turns in a row while the AI plays
   * the protagonist (settings.pilot "ai"), with a short pause between them. It
   * ends early when a step fails, the protagonist dies, the challenge ends or the
   * script's last beat is played. Every step is billed and saved like any turn.
   */
  autoplay(worldId: string, opts: { turns: number }, onEvent: (e: AutoplayEvent) => void): AutoplayHandle {
    let result: { steps: number; reason: AutoplayStop } = { steps: 0, reason: "failed" }, detached = false;
    const handle = this.nativeTurn(worldId, { mode: "continue", text: "" }, "turn", null, (event) => { if (!detached) onEvent(event); }, {
      turns: Math.max(0, Math.floor(opts.turns)),
      onStep(index, total) { if (!detached) onEvent({ type: "step", index, total }); },
      onFinished(steps, reason) { result = { steps, reason }; if (!detached) onEvent({ type: "finished", ...result }); },
    });
    return { done: handle.done.then(() => result), stop: () => handle.stop(), catchUp: async () => { detached = false; await handle.catchUp(); }, detach: () => { detached = true; handle.detach?.(); } };
  }

  /** Continues an interrupted head turn in place. */
  resumeInterrupted(worldId: string, onEvent: (e: TurnEvent) => void): TurnHandle {
    return this.nativeTurn(worldId, null, "continue", null, onEvent);
  }

  /**
   * The hidden fortune of the turn after `base` (R05-T002): rolled once per parent
   * node and kept there, so regenerating does not reroll it; "换个结果" does.
   */
  private async fortuneFor(base: StoryNode, difficulty: WorldSettings["difficulty"], reroll: boolean): Promise<Fortune> {
    const kept = (await this.repo.getNode(base.id))?.meta.fortune;
    if (isFortune(kept) && !reroll) return kept;
    const fortune = rollFortune(difficulty, this.random);
    await this.repo.mergeMeta(base.id, { fortune });
    return fortune;
  }

  /** Everything a turn prompt needs, read for the turn that follows `base`. */
  private async turnInput(worldId: string, base: StoryNode, action: Pick<TurnPromptInput, "mode" | "text" | "directorNote" | "rewriteHint" | "fortune">, sourceOverride?: SourceBinding | null): Promise<TurnPromptInput> {
    const world = (await this.repo.getWorld(worldId))!;
    const state = await this.repo.getState(base.id);
    const ratio = await this.tokenRatio();
    const path = await this.repo.path(base.id);
    const budgetChars = Math.round((this.llm?.contextTokens ?? DEFAULT_CONTEXT_TOKENS) / ratio.value);
    const reference = await referenceContext(this.repo, sourceOverride === undefined ? state.source : sourceOverride, {
      text: action.text, rewriteHint: action.rewriteHint, directorNote: action.directorNote,
      recent: path.slice(-3).map((n) => n.narrative).join("\n"),
      entities: [state.protagonist, ...state.people.slice(-6)].map(({ name, aliases }) => ({ name, aliases })),
      place: state.places.find((p) => p.id === state.placeId)?.name,
    }, Math.floor(budgetChars / 4));
    return {
      reference, continuity: await readContinuity(this.repo, worldId, base.id).catch(() => undefined),
      era: eraContext(world.eraId, state), settings: world.settings, protagonistName: state.protagonist.name, state,
      history: path.slice(-40), allTurns: path, notes: (base.meta.notes as string[] | undefined) ?? [],
      taboos: state.era.mode === "free" ? [] : (base.meta.taboos as TabooHit[] | undefined) ?? [],
      pins: (await this.repo.pinsOnPath(worldId, base.id)).map((p) => p.text),
      chapters: await this.repo.chaptersOnPath(worldId, base.id),
      budgetChars,
      ...action,
    };
  }

  /** Tokens per character for the main model: 1 until the service has reported real usage. */
  private async tokenRatio(): Promise<{ value: number; calibrated: boolean }> {
    const learned = this.llm ? await this.repo.getSetting<number | null>(`tokenRatio:${this.llm.model}`, null) : null;
    return learned ? { value: learned, calibrated: true } : { value: 1, calibrated: false };
  }

  /**
   * 查一查 (R07-T001): answers a question from this world's records, marking
   * general knowledge as 【仅供参考】. Nothing advances or changes; one auxiliary call.
   */
  async ask(worldId: string, question: string, onText: (full: string) => void): Promise<string> {
    this.requireExecution();
    const world = (await this.repo.getWorld(worldId))!;
    const head = (await tree.cursor(this.repo, worldId)).head;
    const state = await this.repo.getState(head.id);
    const askInput = {
      question, state, era: eraContext(world.eraId, state), settings: world.settings,
      chapters: await this.repo.chaptersOnPath(worldId, head.id), history: await this.repo.path(head.id),
      pins: (await this.repo.pinsOnPath(worldId, head.id)).map((p) => p.text),
    };
    const askBudget = Math.round((this.llm?.contextTokens ?? DEFAULT_CONTEXT_TOKENS) / (await this.tokenRatio()).value);
    let reference = await referenceContext(this.repo, state.source, { text: question, entities: [state.protagonist, ...state.people].map(({ name, aliases }) => ({ name, aliases })) }, askBudget / 4);
    let messages = askMessages(askInput);
    const messageChars = () => messages.reduce((n, m) => n + m.content.length, 0);
    while (askInput.history.length > 0 && messageChars() + referenceBlock(reference).length + 60 > askBudget) {
      askInput.history = askInput.history.slice(Math.max(1, Math.floor(askInput.history.length / 2)));
      messages = askMessages(askInput);
    }
    if (messageChars() + referenceBlock(reference).length + 60 > askBudget) messages = compactChatMessages(messages) ?? messages;
    reference = fitReference(reference, Math.max(0, Math.min(askBudget / 4, askBudget - messageChars() - referenceInstructionsBlock(reference).length - 60)));
    const appendReference = (suffix: string) => {
      const last = messages[messages.length - 1];
      last.content += suffix;
      if (last.compactContent !== undefined) last.compactContent += suffix;
    };
    appendReference(referenceBlock(reference) + "\n可以主动使用遵循原著技能查阅原文再回答，不得用记忆冒充查证。");
    const plan: RunPlan = {
      id: newId(), worldId, lineId: (await tree.cursor(this.repo, worldId)).line.id, headId: head.id, baseId: head.id, kind: "ask",
      model: { ...this.requireLlm(), model: this.auxModelName() }, messages, extractMessages: [], state, settings: world.settings,
      options: {}, action: { mode: "continue", text: question }, reference,
      meta: { ...(await this.nativeGuard(worldId, head.id)), budgetChars: askBudget },
    };
    const handle = startRun(this.platform, plan, (event) => { if (event.type === "text" && typeof event.full === "string" && hasChinese(event.full)) onText(event.full); });
    const snapshot = await handle.done;
    if (snapshot.status !== "previewed") throw new Error(snapshot.error ?? "这次查阅未完成");
    const result = snapshot.result as { text?: string };
    return result.text ?? "资料不足，暂时无法确定。";
  }

  /** The next turn's request, layer by layer, for the developer context viewer (R04-T004). */
  async previewContext(worldId: string, action: { mode: ActionMode; text: string } = { mode: "do", text: "（下一回合的行动）" }): Promise<ContextPreview> {
    const head = (await tree.cursor(this.repo, worldId)).head;
    const ratio = await this.tokenRatio();
    const input = await this.turnInput(worldId, head, action);
    const { messages, layers, chars, budgetChars } = this.platform.execution?.context ? await this.platform.execution.context(asJson({ ...input, allTurns: undefined, history: input.history.map(({ id, kind, actionMode, actionText, narrative }) => ({ id, kind, actionMode, actionText, narrative })), template: writingContextTemplate(input) })) as unknown as ReturnType<typeof buildTurnContext> : buildTurnContext(input);
    return { messages, layers, chars, budgetChars, ratio: ratio.value, calibrated: ratio.calibrated };
  }

  /** The turns on the path to `head` after the last chapter, with the chapters and the number of the first turn. */
  private async unsummarized(worldId: string, head: StoryNode): Promise<{ chapters: Chapter[]; turns: StoryNode[]; firstTurn: number }> {
    const chapters = await this.repo.chaptersOnPath(worldId, head.id);
    const path = await this.repo.path(head.id);
    const last = chapters.at(-1);
    const from = last ? path.findIndex((n) => n.id === last.lastNodeId) + 1 : 0;
    return {
      chapters,
      turns: path.slice(from).filter((n) => n.kind === "turn" && n.status !== "interrupted"),
      firstTurn: path.slice(0, from).filter((n) => n.kind === "turn").length + 1,
    };
  }

  /** One summary call; null when it failed or came back without a summary. */
  private async summarize(worldId: string, nodeId: string, input: Parameters<typeof chapterMessages>[0]): Promise<Pick<Chapter, "title" | "gist" | "summary"> | null> {
    let result: ChatResult | null = null;
    try {
      const messages = chapterMessages(input);
      if ((await this.repo.getState(nodeId)).era.mode === "free") {
        messages[0].content = messages[0].content.replace("历史互动小说", "互动小说")
          + "\n沿用本局世界设定与称呼，不补写年表或未来事件，不输出 timeline、deviation。";
      }
      result = await this.call(messages, { usage: { worldId, nodeId, purpose: "chapter" }, aux: true, timeouts: CODEX_TIMEOUT });
    } catch { /* play goes on without it */ }
    const parsed = result ? parseChapter(result.text) : null;
    if (result) await this.platform.sql.batch([this.usage(worldId, nodeId, "chapter", result, parsed ? "ok" : "no_record", this.auxModelName())]);
    return parsed;
  }

  /**
   * Summarizes the turns since the last chapter on the current path (or up to
   * `head`) as a new chapter. Null when there is nothing to summarize, another
   * summary of this world is running, or the call failed.
   */
  async writeChapter(worldId: string, head?: StoryNode): Promise<Chapter | null> {
    if (this.chaptering.has(worldId) || !this.llm) return null;
    this.chaptering.add(worldId);
    try {
      const at = head ?? (await tree.cursor(this.repo, worldId)).head;
      const { chapters, turns, firstTurn } = await this.unsummarized(worldId, at);
      if (!turns.length) return null;
      const world = (await this.repo.getWorld(worldId))!;
      const state = await this.repo.getState(at.id);
      const protagonist = state.protagonist.name;
      const parsed = await this.summarize(worldId, at.id, { premise: world.settings.premise, protagonist, previous: chapters, turns, firstTurn });
      if (!parsed) return null;
      const chapter = await this.repo.addChapter({
        worldId, firstNodeId: turns[0].id, lastNodeId: turns[turns.length - 1].id, ...parsed,
        model: this.llm.auxModel || this.llm.model, promptVersion: state.era.mode === "free" ? FREE_CHAPTER_PROMPT_VERSION : CHAPTER_PROMPT_VERSION,
      });
      for (const fn of this.listeners) fn(worldId);
      return chapter;
    } finally {
      this.chaptering.delete(worldId);
    }
  }

  /** Summarizes an existing chapter again from its turns; the player's edits are replaced. */
  async rewriteChapter(worldId: string, chapterId: string): Promise<Chapter | null> {
    if (!this.llm) return null;
    const chapters = await this.repo.chaptersOnPath(worldId, (await tree.cursor(this.repo, worldId)).head.id);
    const index = chapters.findIndex((c) => c.id === chapterId);
    if (index < 0) return null;
    const chapter = chapters[index];
    const path = await this.repo.path(chapter.lastNodeId);
    const from = path.findIndex((n) => n.id === chapter.firstNodeId);
    const turns = path.slice(from).filter((n) => n.kind === "turn" && n.status !== "interrupted");
    const world = (await this.repo.getWorld(worldId))!;
    const state = await this.repo.getState(chapter.lastNodeId);
    const protagonist = state.protagonist.name;
    const parsed = await this.summarize(worldId, chapter.lastNodeId, {
      premise: world.settings.premise, protagonist, previous: chapters.slice(0, index), turns,
      firstTurn: path.slice(0, from).filter((n) => n.kind === "turn").length + 1,
    });
    if (!parsed) return null;
    const fields = { ...parsed, model: this.llm.auxModel || this.llm.model, promptVersion: state.era.mode === "free" ? FREE_CHAPTER_PROMPT_VERSION : CHAPTER_PROMPT_VERSION, edited: false };
    await this.repo.updateChapter(chapter.id, fields);
    return { ...chapter, ...fields };
  }

  /** Reattaches native runs after a restart and discards legacy TS pending data. */
  async recoverPending(): Promise<string | null> {
    if (this.platform.execution) {
      for (const run of await this.platform.execution.list()) {
        if (run.status !== "running" && run.status !== "interrupted") continue;
        const [stored] = await this.platform.sql.query("SELECT plan_json FROM execution_runs WHERE id=?", [run.id]);
        const plan = stored ? JSON.parse(String(stored.plan_json)) as { kind?: string } : null;
        // Only ordinary runs belong to this executor.
        if (!plan?.kind || !["turn", "variant", "continue", "opening", "correction", "ask", "autoplay"].includes(plan.kind)) continue;
        const handle = this.followExecution(run.id, () => {}, true);
        this.inBackground(handle.done);
      }
    }
    const pending = await this.repo.getSetting<unknown>("pending", null);
    await this.platform.sql.batch([{ sql: "DELETE FROM settings WHERE key=?", params: ["pending"] }]);
    if (pending !== null) {
      console.warn("已清除旧版 TS 回合待恢复数据，不再尝试恢复");
    }
    return null;
  }
}
