// The game session: opening, turns, variants, stop/interrupt, the extraction
// fallback, refusals and crash recovery (docs/PLAN_V3.md §5.1). UI code talks
// to this class only; it never touches SQL or the network directly.
import { formatDate, readDate } from "./calendar/date";
import { eraContext, eraPack, type EraContext } from "./era";
import { packCards } from "./era/card";
import type { Platform, SqlStatement } from "../platform";
import { migrate } from "./db/migrate";
import { Repo } from "./db/repo";
import { ChatError, parseChunk, streamChat, type ChatHandle, type ChatMessage, type ChatResult } from "./llm/chat";
import { explainFailure } from "./llm/providers";
import { hasChinese, isNotice, isRefusal, refusedFinish } from "./llm/refusal";
import {
  assistMessages, buildTurnContext, continueMessages, extractMessages, openingExtractMessages, openingMessages, PROMPT_VERSION,
  turnMessages, type Arrival, type ContextLayer, type SetupDraft, type TurnPromptInput,
} from "./prompt/turn";
import { CODEX_FREE_PROMPT_VERSION, CODEX_PROMPT_VERSION, codexMessages, codexPatch, codexSummary, type CodexInput } from "./prompt/codex";
import { UPKEEP_EVERY, UPKEEP_FREE_PROMPT_VERSION, UPKEEP_PROMPT_VERSION, upkeepMessages, upkeepPatch } from "./prompt/upkeep";
import { CHAPTER_PROMPT_VERSION, chapterMessages, parseChapter } from "./prompt/chapter";
import { askMessages } from "./prompt/ask";
import { findTaboos, tabooLine, tabooTerms, type TabooHit } from "./era/taboo";
import { lenientJson } from "./record/parse";
import { parseRecord } from "./record/parse";
import { RecordSplitter } from "./record/split";
import { applyRecord, type Chip, type TurnRecord } from "./state/apply";
import { skipSpanMinutes } from "./calendar/duration";
import { fortuneMode, isFortune, rollFortune, type Fortune } from "./fortune";
import { packTimeline } from "./timeline";
import { newId } from "./db/repo";
import { parseMoney } from "./money";
import { challengeInputOf, newChallenge, newScript, scriptInputOf, scriptProgress, type ChallengeInput, type ScriptInput } from "./modes";
import { draftChallengeMessages, draftScriptMessages, parseChallengeDraft, parseScriptDraft, type DraftInput } from "./prompt/draft";
import * as tree from "./tree";
import { DEFAULT_SETTINGS, type ActionMode, type Chapter, type StoryNode, type WorldSettings, type WorldState } from "./types";

export type { ChallengeInput, ScriptInput } from "./modes";

export interface LlmConfig {
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

export type TurnEvent =
  | { type: "thinking" }
  | { type: "text"; delta: string; full: string }
  | { type: "organizing" }
  | { type: "done"; cursor: tree.Cursor; node: StoryNode; chips: Chip[] }
  | { type: "failed"; reason: FailReason; status?: number; detail?: string; partialSaved: boolean; cursor?: tree.Cursor };

export interface NewWorld {
  title: string;
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
}

interface Pending {
  worldId: string;
  lineId: string;
  parentId: string;
  streamId: string;
  kind: "turn" | "variant";
  action: PlayerAction;
}

interface UsageScope { worldId: string | null; nodeId: string | null; purpose: string }
interface CallControl { signal?: AbortSignal; onHandle?: (h: ChatHandle) => void }
type CarriedEdit = Pick<StoryNode, "record" | "actionText">;

/** One stop owns every request of a turn, including record/choice extraction. */
function turnControl() {
  const controller = new AbortController();
  let handle: ChatHandle | null = null;
  let committing = false;
  const check = () => { if (controller.signal.aborted) throw new ChatError("cancelled"); };
  return {
    signal: controller.signal,
    onHandle(h: ChatHandle) { handle = h; },
    check,
    // Once storage begins, the completed operation can no longer be cancelled.
    beginCommit() { check(); committing = true; },
    stop() { if (!committing) controller.abort(); },
    async catchUp() { await handle?.catchUp(); },
  };
}

const EXTRACT_TIMEOUT = { firstByteMs: 20_000, idleMs: 20_000, totalMs: 40_000 };
const DEFAULT_CONTEXT_TOKENS = 12_000;
const CODEX_TIMEOUT = { firstByteMs: 30_000, idleMs: 30_000, totalMs: 75_000 };
// Free-mode wording is applied at the call site, keeping the shared chapter helper unchanged.
const FREE_CHAPTER_PROMPT_VERSION = "chapter-2-free";

function failReason(error: unknown): { reason: FailReason; status?: number; detail?: string } {
  if (!(error instanceof ChatError)) return { reason: "network", detail: String(error) };
  const status = error.status;
  switch (error.kind) {
    case "timeout_first": case "timeout_idle": case "timeout_total": return { reason: "timeout" };
    case "cancelled": return { reason: "cancelled" };
    case "empty": return { reason: "empty" };
    case "no_secret": case "url_not_bound": return { reason: "config" };
    case "http":
      if (isRefusal({ finishReason: null, narrative: "", hasRecord: true, httpMessage: error.message })) return { reason: "refused", status };
      if (status === 401 || status === 403) return { reason: "auth", status, detail: error.message };
      if (status === 402 || status === 429) return { reason: "quota", status, detail: error.message };
      return { reason: "http", status, detail: error.message };
    default: return { reason: "network", detail: error.message };
  }
}

/** Worth one automatic retry when nothing has arrived yet (D107). */
const retryable = (e: unknown) => e instanceof ChatError && !e.partial
  && (e.kind === "network" || e.kind === "timeout_first" || (e.kind === "http" && (e.status === 429 || (e.status ?? 0) >= 500)));

/** Lines of an apply log that say what happened, not what was refused. */
const INFO_LOG = /^新人物：|只记录不提醒|按不限时处理/;

/** As the death card has it: no health left on a difficulty that kills. */
const isDead = (state: WorldState, settings: WorldSettings) => state.protagonist.stats.health <= 0 && settings.difficulty !== "宽松";

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
  private autoplaying = new Set<string>();
  /** Per world: the tail of the queue that turns and edits wait on, so nodes are never appended concurrently. */
  private queues = new Map<string, Promise<unknown>>();
  private upkeeping = new Set<string>();
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

  /** Resolves once background work (设定集 upkeep) has finished; before a restore, and for tests and evals. */
  async settled(): Promise<void> {
    while (this.background.size) await Promise.allSettled([...this.background]);
  }

  private inBackground(work: Promise<void>): void {
    this.background.add(work);
    void work.catch(() => {}).then(() => this.background.delete(work));
  }

  /** A complete, selected story has reached storage; notification failures never undo it. */
  private announceCommitted(worldId: string, node: StoryNode): void {
    if (node.status !== "ok") return;
    this.inBackground(Promise.resolve().then(() => this.platform.system.storyCommitted(`${worldId}:${node.id}`)));
  }

  /** Told when a world changed in the background (设定集 upkeep, a new chapter). Returns an unsubscribe. */
  subscribe(fn: (worldId: string) => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  /** The model used for side jobs (records, 设定集, chapters, 查一查), for usage rows; empty when no service. */
  private auxModelName(): string {
    return this.llm ? this.llm.auxModel || this.llm.model : "";
  }

  private requireLlm(): LlmConfig {
    if (!this.llm) throw new ChatError("no_secret");
    return this.llm;
  }

  // ---------- model calls ----------

  /** One streamed call with a single retry before any data arrives. */
  private async call(
    messages: ChatMessage[],
    opts: CallControl & { aux?: boolean; timeouts?: typeof EXTRACT_TIMEOUT; onThinking?: () => void; onText?: (d: string, full: string) => void; usage: UsageScope },
  ): Promise<ChatResult & { attempts: number }> {
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
        onThinking: () => { if (!opts.signal?.aborted) opts.onThinking?.(); },
        onText: (delta, full) => { if (!opts.signal?.aborted) { partial = full; opts.onText?.(delta, full); } },
      });
      let cancel!: () => void;
      const cancellation = new Promise<never>((_, reject) => {
        cancel = () => {
          void handle.streamId.then((id) => this.platform.llm.cancel(id)).catch(() => {});
          reject(new ChatError("cancelled", undefined, partial));
        };
      });
      opts.signal?.addEventListener("abort", cancel, { once: true });
      opts.onHandle?.(handle);
      if (opts.signal?.aborted) cancel();
      try {
        received = await Promise.race([handle.result, cancellation]);
        if (opts.signal?.aborted) throw new ChatError("cancelled", undefined, partial);
        return { ...received, attempts: attempt };
      } catch (error) {
        const retry = !opts.signal?.aborted && attempt === 1 && retryable(error);
        // Callers retain their successful business usage rows. Every failed request
        // has its own unknown usage; local credential/binding refusals sent nothing.
        const unsent = error instanceof ChatError && (error.kind === "no_secret" || error.kind === "url_not_bound");
        if (!unsent) {
          const scope = opts.usage;
          await this.platform.sql.batch([this.usage(scope.worldId, scope.nodeId, scope.purpose, received,
            error instanceof ChatError && error.kind === "cancelled" ? "cancelled" : "failed", model)]);
        }
        if (retry) continue;
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

  /** The 补记 fallback: extracts a record from the narrative with the auxiliary model. */
  private async extract(era: EraContext, state: WorldState, action: string, narrative: string, settings?: WorldSettings,
    control: CallControl = {}, usage: UsageScope = { worldId: null, nodeId: null, purpose: "extract" },
  ): Promise<{ record: TurnRecord | null; result: ChatResult | null }> {
    try {
      const result = await this.call(extractMessages({ era, state, action, narrative, settings: { ...settings, mode: state.era.mode ?? settings?.mode } }), { ...control, usage, aux: true, timeouts: EXTRACT_TIMEOUT });
      return { record: parseRecord(`<record>${result.text}`).record, result };
    } catch (error) {
      if (error instanceof ChatError && error.kind === "cancelled") throw error;
      return { record: null, result: null };
    }
  }

  // ---------- opening ----------

  /** Expands a rough idea into a full setup; fields the player filled are kept. */
  async assist(idea: string, current: Partial<SetupDraft>): Promise<Partial<SetupDraft> | null> {
    try {
      const result = await this.call(assistMessages(idea, current), { usage: { worldId: null, nodeId: null, purpose: "assist" }, aux: true, timeouts: { firstByteMs: 30_000, idleMs: 30_000, totalMs: 90_000 } });
      const value = lenientJson(result.text) as Partial<SetupDraft> | null;
      await this.platform.sql.batch([this.usage(null, null, "assist", result, value ? "ok" : "no_record", this.auxModelName())]);
      return value;
    } catch {
      return null;
    }
  }

  /** “AI 帮我拟大纲” (R14): an outline from the opening filled in so far; null when it fails or gives no beat. */
  draftScript(current: DraftInput): Promise<ScriptInput | null> {
    return this.draft(draftScriptMessages(current), "outline", parseScriptDraft);
  }

  /** “AI 帮我出题” (R14): a challenge that suits the opening; null when it fails or gives no goal. */
  draftChallenge(current: DraftInput): Promise<ChallengeInput | null> {
    return this.draft(draftChallengeMessages(current), "challenge", parseChallengeDraft);
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
    const settings: WorldSettings = { ...DEFAULT_SETTINGS, ...input.settings };
    const free = settings.mode === "free";
    const pack = free ? null : eraPack(input.eraId);
    const p = input.protagonist;
    // A built-in pack is only a preset: its era card, places, calendar and currency are copied in (D121).
    const preset = pack ? packCards(pack) : { cards: [], places: [] };
    const initial: WorldState = {
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
    const opening = {
      era, settings, protagonistName: p.name, protagonist: p, arrival: input.arrival, origin: input.origin, hint: input.opening.mode === "ai" ? input.opening.hint : "",
      script: initial.script, challenge: initial.challenge,
    };
    // Organizing starts once the opening is under way, so it never delays the first words.
    const organize = !pack && input.organize === true;
    let codex: Promise<ChatResult | null> | null = null;
    const startCodex = (): Promise<ChatResult | null> | null => {
      if (organize && !codex) codex = this.codex({ mode: initial.era.mode, premise: settings.premise, protagonist: p, arrival: input.arrival });
      return codex;
    };
    // When the opening fails after organizing began, that request was still made: book it as unused.
    const dropCodex = () => {
      const started: Promise<ChatResult | null> | null = codex;
      if (!started) return;
      this.inBackground(started.then(async (r) => {
        if (r) await this.platform.sql.batch([this.usage(null, null, "codex", r, "stale", this.auxModelName())]);
      }));
    };

    let narrative: string;
    let record: TurnRecord | null;
    let result: ChatResult | null = null;
    let extractResult: ChatResult | null = null;
    const openingModel = input.opening.mode === "player" ? this.auxModelName() : this.llm?.model ?? "";
    const openingUsage: UsageScope = { worldId: null, nodeId: null, purpose: "opening" };
    if (input.opening.mode === "player") {
      // The player wrote the opening: keep it verbatim and only extract the state.
      narrative = input.opening.text.trim();
      onEvent({ type: "organizing" });
      try {
        result = await this.call(openingExtractMessages({ ...opening, text: narrative }), { usage: openingUsage, aux: true, timeouts: EXTRACT_TIMEOUT });
        record = parseRecord(`<record>${result.text}`).record;
      } catch (error) {
        onEvent({ type: "failed", ...failReason(error), partialSaved: false });
        return null;
      }
    } else {
      const splitter = new RecordSplitter();
      let shown = "";
      let sent = 0;
      try {
        result = await this.call(openingMessages(opening), {
          usage: openingUsage,
          onThinking: () => onEvent({ type: "thinking" }),
          onText: (delta) => {
            startCodex();
            const visible = splitter.push(delta);
            if (!visible) return;
            shown += visible;
            if (!hasChinese(shown)) return;
            onEvent({ type: "text", delta: shown.slice(sent), full: shown });
            sent = shown.length;
          },
        });
      } catch (error) {
        dropCodex();
        onEvent({ type: "failed", ...failReason(error), partialSaved: false });
        return null;
      }
      const split = splitter.finish();
      narrative = split.narrative;
      record = parseRecord(split.recordText).record;
      if (isRefusal({ finishReason: result?.finishReason ?? null, narrative, hasRecord: !!record })) {
        dropCodex();
        await this.platform.sql.batch([this.usage(null, null, "opening", result, "refused", openingModel)]);
        onEvent({ type: "failed", reason: "refused", partialSaved: false });
        return null;
      }
      if (!record) {
        onEvent({ type: "organizing" });
        const extracted = await this.extract(era, initial, "（开场）", narrative, settings);
        record = extracted.record;
        extractResult = extracted.result;
      }
    }
    if (!record) {
      dropCodex();
      const usage = result ? [this.usage(null, null, "opening", result, "no_record", openingModel)] : [];
      if (extractResult) usage.push(this.usage(null, null, "extract", extractResult, "no_record", this.auxModelName()));
      if (usage.length) await this.platform.sql.batch(usage);
      onEvent({ type: "failed", reason: "no_record", partialSaved: false });
      return null;
    }

    // The organized 设定集 goes into the opening state before the opening's own record.
    let codexResult: ChatResult | null = null;
    // Its great events wait until the opening has fixed the start date they are counted from.
    let codexTimeline: TurnRecord["timeline"] = null;
    if (organize) {
      onEvent({ type: "organizing" });
      codexResult = await startCodex();
      const patch = codexResult ? codexPatch(codexResult.text, initial) : null;
      if (patch) {
        const { timeline, ...rest } = patch;
        codexTimeline = timeline ?? null;
        Object.assign(initial, applyRecord(initial, rest, { mode: "do", difficulty: settings.difficulty, currency: era.currency }, { advanceTime: false }).state);
      }
    }

    // Opening-only fields: date, hour, currency and the starting purse (an absolute amount).
    // The program counts every later date (D119); a pack's date stays when the opening gave no usable one.
    const rules = era.clock.rules;
    if (record.date != null && era.clock.clockStyle !== "elapsed") {
      const date = readDate(record.date, rules);
      if (date) {
        initial.time.date = date;
        initial.time.start = formatDate(date, rules);
      } else if (!pack && typeof record.date === "string" && record.date.trim()) {
        initial.time.start = record.date.trim();
      }
    }
    if (record.hour != null) initial.time.startHour = record.hour;
    if (!pack && record.currency?.length) initial.era.currency = { units: record.currency };
    const startEra = eraContext(pack?.id ?? null, initial);
    // The great events (R05-T004) for the player's 记事 page: a pack's, or the organizer's for a real,
    // CE-dated dynasty; free worlds have none. The narrator only hears of each once its time has come (D129).
    if (pack) initial.timeline = packTimeline(pack.timeline, startEra.clock).map((e) => ({ id: newId(), ...e }));
    else if (codexTimeline?.length && startEra.clock.date?.ceYear != null) {
      Object.assign(initial, applyRecord(initial, { timeline: codexTimeline }, { mode: "do", difficulty: settings.difficulty, currency: startEra.currency, clock: startEra.clock }, { advanceTime: false }).state);
    }
    const purse = record.money != null ? parseMoney(record.money, startEra.currency) : null;
    initial.protagonist.stats.money = Math.max(0, purse ?? pack?.startMoney ?? 0);
    const { money: _m, time: _t, date: _d, hour: _h, currency: _c, ...rest } = record;
    const applied = applyRecord(initial, rest, { mode: "do", difficulty: settings.difficulty, currency: startEra.currency }, { advanceTime: false });

    const model = this.llm?.model ?? "";
    const { world, node } = await this.repo.createWorld({
      title: input.title.trim() || `${p.name || "无名"}的故事`, eraId: pack?.id ?? "free", settings,
      opening: {
        parentId: null, kind: "opening", narrative, record, choices: record.choices ?? [], state: applied.state,
        meta: {
          promptVersion: PROMPT_VERSION, model, playerWritten: input.opening.mode === "player",
          setup: { arrival: input.arrival, hint: input.opening.mode === "ai" ? input.opening.hint : "", organize },
          ...(organize ? { codexPromptVersion: free ? CODEX_FREE_PROMPT_VERSION : CODEX_PROMPT_VERSION, codexOk: !!codexResult } : {}),
          ...(setupLog.length ? { log: setupLog } : {}),
          firstTokenMs: result?.firstTokenMs, totalMs: result?.totalMs, usage: result?.usage, raw: result?.text,
        },
      },
    });
    const usage = result ? [this.usage(world.id, node.id, "opening", result, "ok", openingModel)] : [];
    if (extractResult) usage.push(this.usage(world.id, node.id, "extract", extractResult, "ok", this.auxModelName()));
    if (codexResult) usage.push(this.usage(world.id, node.id, "codex", codexResult, initial.cards.length ? "ok" : "no_record", this.auxModelName()));
    if (usage.length) await this.platform.sql.batch(usage);
    this.announceCommitted(world.id, node);
    onEvent({ type: "done", cursor: await tree.cursor(this.repo, world.id), node, chips: [] });
    return world.id;
  }

  /** How a world began, for "再来一局同样设定": the opening's protagonist and arrival with the world's current settings. */
  async setupOf(worldId: string): Promise<NewWorld | null> {
    const world = await this.repo.getWorld(worldId);
    const opening = world ? await this.repo.opening(worldId) : null;
    if (!world || !opening) return null;
    const state = await this.repo.getState(opening.id);
    const me = state.protagonist;
    const setup = (opening.meta.setup ?? {}) as { arrival?: Arrival; hint?: string; organize?: boolean };
    return {
      title: world.title, eraId: state.era.mode === "free" ? null : eraPack(world.eraId)?.id ?? null,
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
  async editState(worldId: string, patch: TurnRecord, summary: string, by?: "AI"): Promise<tree.Cursor> {
    const result = await this.serial(worldId, () => this.appendEdit(worldId, patch, summary, by ? { by } : {}));
    if ("rejected" in result) throw new EditRejected(result.rejected);
    return result;
  }

  /**
   * The player's edits are all or nothing: one refused part rejects the whole
   * edit, so the summary never claims what did not happen. The AI's own edits
   * keep what applied and are dropped only when nothing changed.
   */
  private async appendEdit(worldId: string, patch: TurnRecord, summary: string, meta: Record<string, unknown> = {}): Promise<tree.Cursor | { rejected: string }> {
    const c = await tree.cursor(this.repo, worldId);
    const state = await this.repo.getState(c.head.id);
    const world = (await this.repo.getWorld(worldId))!;
    const era = eraContext(world.eraId, state);
    const applied = applyRecord(state, patch, { mode: "do", difficulty: world.settings.difficulty, currency: era.currency, clock: era.clock }, { advanceTime: false });
    const rejected = rejection(state, applied.state, meta.by === "AI" ? [] : applied.log);
    if (rejected) return { rejected };
    return tree.append(this.repo, c, {
      kind: "edit", narrative: "", actionText: summary, record: patch, choices: [],
      state: applied.state, meta: { chips: applied.chips, ...meta },
    });
  }

  /** A new turn after the current head. */
  play(worldId: string, action: PlayerAction, onEvent: (e: TurnEvent) => void): TurnHandle {
    return this.run(worldId, action, "turn", null, onEvent);
  }

  /** Another version of the head turn, optionally with a direction ("写短一点"). */
  regenerate(worldId: string, hint: string | null, onEvent: (e: TurnEvent) => void): TurnHandle {
    return this.run(worldId, null, "variant", hint, onEvent);
  }

  /**
   * 连播 (R14): up to `turns` ordinary “继续” turns in a row while the AI plays
   * the protagonist (settings.pilot "ai"), with a short pause between them. It
   * ends early when a step fails, the protagonist dies, the challenge ends or the
   * script's last beat is played. Every step is billed and saved like any turn.
   */
  autoplay(worldId: string, opts: { turns: number }, onEvent: (e: AutoplayEvent) => void): AutoplayHandle {
    const total = Math.max(0, Math.floor(opts.turns));
    let stopped = false;
    let steps = 0;
    let step: TurnHandle | null = null;
    let wake = () => {};
    const head = async () => this.repo.getState((await tree.cursor(this.repo, worldId)).head.id);
    const pause = () => new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, this.autoplayPauseMs);
      wake = () => { clearTimeout(timer); resolve(); };
    });
    const run = async (): Promise<AutoplayStop> => {
      for (;;) {
        if (stopped) return "stopped";
        if (steps >= total) return "count";
        if (steps > 0) {
          await pause();
          if (stopped) return "stopped";
        }
        // Read again after the pause: the player may have changed the settings, script or challenge meanwhile.
        const world = await this.repo.getWorld(worldId);
        if (!world) return "failed";
        if (world.settings.pilot !== "ai") return "player";
        const before = await head();
        if (isDead(before, world.settings)) return "died";
        onEvent({ type: "step", index: steps + 1, total });
        let failed = false;
        step = this.play(worldId, { mode: "continue", text: "" }, (e) => {
          if (e.type === "failed") failed = true;
          onEvent(e);
        });
        await step.done.catch(() => { failed = true; });
        step = null;
        if (failed) return stopped ? "stopped" : "failed";
        steps++;
        const after = await head();
        if (isDead(after, world.settings)) return "died";
        if (before.challenge?.status === "active" && after.challenge?.status !== "active") return "challenge";
        if (scriptProgress(before)?.finished === false && scriptProgress(after)?.finished) return "script";
      }
    };
    // Anything already being written for this world, a 连播 included, comes first: nothing starts.
    const busy = this.autoplaying.has(worldId) || this.queues.has(worldId);
    if (!busy) this.autoplaying.add(worldId);
    const reason = busy ? Promise.resolve<AutoplayStop>("busy")
      : run().catch((): AutoplayStop => "failed").finally(() => this.autoplaying.delete(worldId));
    const done = reason.then((r) => {
      onEvent({ type: "finished", steps, reason: r });
      return { steps, reason: r };
    });
    return {
      stop: () => { stopped = true; step?.stop(); wake(); },
      catchUp: async () => { await step?.catchUp(); },
      done,
    };
  }

  private run(worldId: string, actionIn: PlayerAction | null, kind: "turn" | "variant", hint: string | null, onEvent: (e: TurnEvent) => void): TurnHandle {
    const control = turnControl();
    let active = true;
    const done = this.serial(worldId, async () => {
      let c = await tree.cursor(this.repo, worldId);
      let edits: CarriedEdit[] = [];
      if (kind === "variant") {
        // Replay, in order, every player edit made after the turn on the current path; AI edits
        // describe the old version. Edits the player undid or went back past are not on the path
        // (only a redo pointer keeps them) and stay undone.
        const pathEdits: StoryNode[] = [];
        while (c.head.kind === "edit") {
          pathEdits.unshift(c.head);
          c = { ...c, head: (await this.repo.getNode(c.head.parentId!))! };
        }
        edits = [...((c.head.meta.carriedEdits as CarriedEdit[] | undefined) ?? []), ...pathEdits.filter((e) => e.meta.by !== "AI")];
      }
      const world = (await this.repo.getWorld(worldId))!;
      // For a variant, the turn is re-played from the head's parent with the same action.
      const base = kind === "variant" ? (await this.repo.getNode(c.head.parentId!))! : c.head;
      const action: PlayerAction = actionIn ?? { mode: c.head.actionMode ?? "continue", text: c.head.actionText ?? "", directorNote: c.head.directorNote };
      const state = await this.repo.getState(base.id);
      const era = eraContext(world.eraId, state);
      const fortune = luckApplies(action.mode, world.settings) ? await this.fortuneFor(base, world.settings.difficulty, kind === "variant" && hint === "换个结果") : undefined;
      const { messages, chars } = buildTurnContext(await this.turnInput(worldId, base, {
        mode: action.mode, text: action.text, directorNote: action.directorNote, rewriteHint: hint, fortune,
      }));

      const splitter = new RecordSplitter();
      let shown = "";
      let sent = 0;
      let result: ChatResult & { attempts: number };
      const fail = async (error: unknown) => {
        await this.repo.setSetting("pending", null);
        const partial = error instanceof ChatError ? error.partial : "";
        const narrative = splitter.finish().narrative || partial;
        if (narrative) {
          const cursor = await this.saveInterrupted(c, base, kind, action, narrative, state, hint, edits);
          onEvent({ type: "failed", ...failReason(error), partialSaved: true, cursor });
        } else {
          onEvent({ type: "failed", ...failReason(error), partialSaved: false });
        }
      };
      try {
        result = await this.call(messages, {
          signal: control.signal, usage: { worldId, nodeId: null, purpose: "turn" },
          onThinking: () => onEvent({ type: "thinking" }),
          onText: (delta) => {
            const visible = splitter.push(delta);
            if (!visible) return;
            shown += visible;
            // Held back until there is Chinese in it, so a provider's notice in English never shows as story.
            if (!hasChinese(shown)) return;
            onEvent({ type: "text", delta: shown.slice(sent), full: shown });
            sent = shown.length;
          },
          onHandle: (h) => {
            control.onHandle(h);
            void h.streamId.then((streamId) => {
              if (!active || control.signal.aborted) return;
              return this.repo.setSetting("pending", {
                worldId, lineId: c.line.id, parentId: base.id, streamId, kind, action,
              } satisfies Pending);
            }).catch(() => {});
          },
        });
      } catch (error) {
        await fail(error);
        return;
      }

      const { narrative, recordText } = splitter.finish();
      const parsed = parseRecord(recordText);
      if (isRefusal({ finishReason: result.finishReason, narrative, hasRecord: !!parsed.record })) {
        await this.repo.setSetting("pending", null);
        await this.platform.sql.batch([this.usage(worldId, null, "turn", result, "refused", (this.llm?.model ?? ""))]);
        onEvent({ type: "failed", reason: "refused", partialSaved: false });
        return;
      }
      if (result.usage?.promptTokens) await this.learnRatio(result.usage.promptTokens / chars);
      let cursor: Awaited<ReturnType<Game["commit"]>>;
      try {
        cursor = await this.commit(c, base, kind, action, narrative, parsed.record, parsed.issues, state, era, world.settings, result, onEvent, fortune, control);
      } catch (error) {
        if (!(error instanceof ChatError) || error.kind !== "cancelled") throw error;
        // The narrative request finished before cancellation during extraction/storage preparation.
        await this.platform.sql.batch([this.usage(worldId, null, "turn", result, "cancelled", this.llm?.model ?? "")]);
        await fail(error);
        return;
      }
      for (const edit of edits) {
        // Carried as it was; an edit the new version already makes needs no second node.
        const carried = await this.appendEdit(worldId, edit.record as TurnRecord, `${edit.actionText ?? ""}（已沿用）`);
        if (!("rejected" in carried)) cursor.cursor = carried;
      }
      await this.repo.setSetting("pending", null);
      this.announceCommitted(worldId, cursor.node);
      onEvent({ type: "done", cursor: cursor.cursor, node: cursor.node, chips: cursor.chips });
      if (kind === "turn") {
        this.inBackground(this.upkeep(worldId, cursor.node));
        this.inBackground(this.chapterIfDue(worldId, cursor.node));
      }
    }).finally(() => { active = false; });
    return { stop: control.stop, catchUp: control.catchUp, done };
  }

  private async commit(
    c: tree.Cursor, base: StoryNode, kind: "turn" | "variant", action: PlayerAction, narrative: string,
    recordIn: TurnRecord | null, issues: string[], state: WorldState, era: EraContext, settings: WorldSettings,
    result: ChatResult & { attempts: number }, onEvent: (e: TurnEvent) => void, fortune?: Fortune, control?: ReturnType<typeof turnControl>,
  ): Promise<{ cursor: tree.Cursor; node: StoryNode; chips: Chip[] }> {
    control?.check();
    let record = recordIn;
    let extractResult: ChatResult | null = null;
    // A record without choices needs a fill-in only when choices were asked for (AUDIT_V4_FUNCTION #6).
    if (!record || (settings.choiceCount > 0 && !record.choices?.length)) {
      onEvent({ type: "organizing" });
      const extracted = await this.extract(era, state, action.text || "（继续）", narrative, settings, control, { worldId: c.worldId, nodeId: base.id, purpose: "extract" });
      extractResult = extracted.result;
      if (extractResult) await this.platform.sql.batch([this.usage(c.worldId, base.id, "extract", extractResult, extracted.record ? "ok" : "no_record", this.auxModelName())]);
      if (extracted.record) record = record ? { ...extracted.record, ...record, choices: extracted.record.choices } : extracted.record;
    }
    control?.check();
    const asked = action.mode === "skip" ? skipSpanMinutes(action.text) ?? undefined : undefined;
    const applied = applyRecord(state, record, { mode: action.mode, difficulty: settings.difficulty, currency: era.currency, clock: era.clock, fortune, asked });
    const model = this.llm?.model ?? "";
    // Words the era card says must not appear (R07-T002): shown in developer mode, reminded next turn.
    const taboos = state.era.mode === "free" ? [] : findTaboos(narrative, tabooTerms(era.eraCard, eraPack(era.packId)));
    const node = {
      kind: "turn" as const, actionMode: action.mode, actionText: action.text, directorNote: action.directorNote ?? null,
      narrative, record, choices: record?.choices ?? [], status: record ? ("ok" as const) : ("no_record" as const), state: applied.state,
      meta: {
        chips: applied.chips, notes: applied.notes, log: [...issues, ...applied.log], promptVersion: PROMPT_VERSION, model, ...(taboos.length ? { taboos } : {}),
        firstTokenMs: result.firstTokenMs, totalMs: result.totalMs, usage: result.usage, attempts: result.attempts,
        extracted: !!extractResult, raw: result.text,
      },
    };
    control?.beginCommit();
    const next = kind === "variant" ? await tree.addVariant(this.repo, c, node) : await tree.append(this.repo, { ...c, head: base }, node);
    const usage = [this.usage(c.worldId, next.head.id, "turn", result, "ok", model)];
    await this.platform.sql.batch(usage);
    return { cursor: next, node: next.head, chips: applied.chips };
  }

  /** `hint` is a variant's 重说 direction, kept so 续写 asks for the same thing. */
  private async saveInterrupted(c: tree.Cursor, base: StoryNode, kind: "turn" | "variant", action: PlayerAction, narrative: string, state: WorldState, hint: string | null, edits: CarriedEdit[] = []): Promise<tree.Cursor> {
    const node = {
      kind: "turn" as const, actionMode: action.mode, actionText: action.text, directorNote: action.directorNote ?? null,
      narrative, choices: [], status: "interrupted" as const, state,
      meta: { chips: [], promptVersion: PROMPT_VERSION, model: this.llm?.model,
        ...(hint ? { rewriteHint: hint } : {}),
        ...(edits.length ? { carriedEdits: edits.map(({ record, actionText }) => ({ record, actionText })) } : {}),
      },
    };
    return kind === "variant" ? tree.addVariant(this.repo, c, node) : tree.append(this.repo, { ...c, head: base }, node);
  }

  /** Continues an interrupted head turn in place. */
  resumeInterrupted(worldId: string, onEvent: (e: TurnEvent) => void): TurnHandle {
    const control = turnControl();
    const done = this.serial(worldId, async () => {
      const c = await tree.cursor(this.repo, worldId);
      const node = c.head;
      if (node.status !== "interrupted" || !node.parentId) return;
      const world = (await this.repo.getWorld(worldId))!;
      const state = await this.repo.getState(node.parentId);
      const era = eraContext(world.eraId, state);
      // Rebuilt from the current settings (a cached prompt could carry a panel since turned off),
      // with the turn's own luck, kept on the parent, and its 重说 direction.
      const parent = (await this.repo.getNode(node.parentId))!;
      const mode = node.actionMode ?? "continue";
      const fortune = luckApplies(mode, world.settings) && isFortune(parent.meta.fortune) ? parent.meta.fortune : undefined;
      const base = turnMessages(await this.turnInput(worldId, parent, {
        mode, text: node.actionText ?? "", directorNote: node.directorNote, fortune,
        rewriteHint: typeof node.meta.rewriteHint === "string" ? node.meta.rewriteHint : null,
      }));
      const splitter = new RecordSplitter();
      let shown = node.narrative;
      let result: (ChatResult & { attempts: number }) | null = null;
      try {
        result = await this.call(continueMessages(base, node.narrative), {
          ...control, usage: { worldId, nodeId: node.id, purpose: "continue" },
          onThinking: () => onEvent({ type: "thinking" }),
          onText: (delta) => {
            const visible = splitter.push(delta);
            if (visible) { shown += visible; onEvent({ type: "text", delta: visible, full: shown }); }
          },
        });
        const { narrative: addition, recordText } = splitter.finish();
        const narrative = `${node.narrative}${addition}`;
        let record = parseRecord(recordText).record;
        if (!record || (world.settings.choiceCount > 0 && !record.choices?.length)) {
          onEvent({ type: "organizing" });
          const extracted = await this.extract(era, state, node.actionText ?? "", narrative, world.settings, control, { worldId, nodeId: node.id, purpose: "extract" });
          if (extracted.result) await this.platform.sql.batch([this.usage(worldId, node.id, "extract", extracted.result, extracted.record ? "ok" : "no_record", this.auxModelName())]);
          if (extracted.record) record = record ? { ...extracted.record, ...record, choices: extracted.record.choices } : extracted.record;
        }
        control.check();
        const applied = applyRecord(state, record, { mode, difficulty: world.settings.difficulty, currency: era.currency, clock: era.clock, fortune });
        control.beginCommit();
        const updated = await this.repo.completeNode(node.id, {
          narrative, record, choices: record?.choices ?? [], status: record ? "ok" : "no_record",
          meta: { ...node.meta, messages: undefined, carriedEdits: undefined, rewriteHint: undefined, chips: applied.chips, notes: applied.notes, log: applied.log, resumed: true, usage: result.usage },
        }, applied.state, [this.usage(worldId, node.id, "continue", result, "ok", (this.llm?.model ?? ""))]);
        let cursor = { ...c, head: updated };
        for (const edit of (node.meta.carriedEdits as CarriedEdit[] | undefined) ?? []) {
          const carried = await this.appendEdit(worldId, edit.record as TurnRecord, `${edit.actionText ?? ""}（已沿用）`);
          if (!("rejected" in carried)) cursor = carried;
        }
        this.announceCommitted(worldId, updated);
        onEvent({ type: "done", cursor, node: updated, chips: applied.chips });
      } catch (error) {
        if (!(error instanceof ChatError)) throw error;
        // Retain newly received continuation text too, without applying any record.
        const narrative = `${node.narrative}${splitter.finish().narrative}`;
        const updated = await this.repo.completeNode(node.id, {
          narrative, record: null, choices: [], status: "interrupted",
          meta: { ...node.meta, messages: undefined, chips: [] },
        }, state, result ? [this.usage(worldId, node.id, "continue", result, "cancelled", this.llm?.model ?? "")] : []);
        onEvent({ type: "failed", ...failReason(error), partialSaved: true, cursor: { ...c, head: updated } });
      }
    });
    return { stop: control.stop, catchUp: control.catchUp, done };
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
  private async turnInput(worldId: string, base: StoryNode, action: Pick<TurnPromptInput, "mode" | "text" | "directorNote" | "rewriteHint" | "fortune">): Promise<TurnPromptInput> {
    const world = (await this.repo.getWorld(worldId))!;
    const state = await this.repo.getState(base.id);
    const ratio = await this.tokenRatio();
    return {
      era: eraContext(world.eraId, state), settings: world.settings, protagonistName: state.protagonist.name, state,
      ...(await this.repo.path(base.id).then((path) => ({ history: path.slice(-40), allTurns: path }))), notes: (base.meta.notes as string[] | undefined) ?? [],
      taboos: state.era.mode === "free" ? [] : (base.meta.taboos as TabooHit[] | undefined) ?? [],
      pins: (await this.repo.pinsOnPath(worldId, base.id)).map((p) => p.text),
      chapters: await this.repo.chaptersOnPath(worldId, base.id),
      budgetChars: Math.round((this.llm?.contextTokens ?? DEFAULT_CONTEXT_TOKENS) / ratio.value),
      ...action,
    };
  }

  /** Tokens per character for the main model: 1 until the service has reported real usage. */
  private async tokenRatio(): Promise<{ value: number; calibrated: boolean }> {
    const learned = this.llm ? await this.repo.getSetting<number | null>(`tokenRatio:${this.llm.model}`, null) : null;
    return learned ? { value: learned, calibrated: true } : { value: 1, calibrated: false };
  }

  /** Moves the ratio toward what one request actually cost (R04-T004). */
  private async learnRatio(observed: number): Promise<void> {
    if (!this.llm || !Number.isFinite(observed) || observed <= 0) return;
    const current = await this.repo.getSetting<number | null>(`tokenRatio:${this.llm.model}`, null);
    const next = Math.min(2, Math.max(0.3, current ? current * 0.7 + observed * 0.3 : observed));
    await this.repo.setSetting(`tokenRatio:${this.llm.model}`, Math.round(next * 1000) / 1000);
  }

  /**
   * 查一查 (R07-T001): answers a question from this world's records, marking
   * general knowledge as 【仅供参考】. Nothing advances or changes; one auxiliary call.
   */
  async ask(worldId: string, question: string, onText: (full: string) => void): Promise<string> {
    const world = (await this.repo.getWorld(worldId))!;
    const head = (await tree.cursor(this.repo, worldId)).head;
    const state = await this.repo.getState(head.id);
    const messages = askMessages({
      question, state, era: eraContext(world.eraId, state), settings: world.settings,
      chapters: await this.repo.chaptersOnPath(worldId, head.id), history: await this.repo.path(head.id),
      pins: (await this.repo.pinsOnPath(worldId, head.id)).map((p) => p.text),
    });
    let result: ChatResult | null = null;
    let refused = false;
    try {
      result = await this.call(messages, { usage: { worldId, nodeId: head.id, purpose: "ask" }, aux: true, timeouts: CODEX_TIMEOUT, onText: (_d, full) => { if (hasChinese(full)) onText(full); } });
      // An honest "抱歉，我无法确定……" is an answer; only the response's own signal or a notice is a refusal.
      refused = refusedFinish(result.finishReason) || isNotice(result.text);
      return refused ? explainFailure("refused") : result.text.trim();
    } finally {
      if (result) await this.platform.sql.batch([this.usage(worldId, head.id, "ask", result, refused ? "refused" : "ok", this.auxModelName())]);
    }
  }

  /** The next turn's request, layer by layer, for the developer context viewer (R04-T004). */
  async previewContext(worldId: string, action: { mode: ActionMode; text: string } = { mode: "do", text: "（下一回合的行动）" }): Promise<ContextPreview> {
    const head = (await tree.cursor(this.repo, worldId)).head;
    const ratio = await this.tokenRatio();
    const { messages, layers, chars, budgetChars } = buildTurnContext(await this.turnInput(worldId, head, action));
    return { messages, layers, chars, budgetChars, ratio: ratio.value, calibrated: ratio.calibrated };
  }

  /**
   * Writes a chapter once `chapterEvery` turns have passed on this path since the
   * last one (R04-T003). A failed summary is tried again three turns later.
   */
  private async chapterIfDue(worldId: string, head: StoryNode): Promise<void> {
    const every = (await this.repo.getWorld(worldId))?.settings.chapterEvery ?? 0;
    if (!every || !this.llm) return;
    const pending = await this.unsummarized(worldId, head);
    if (pending.turns.length >= every && (pending.turns.length - every) % 3 === 0) await this.writeChapter(worldId, head);
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

  /**
   * Keeps the 设定集 up to date (R04-T001, D122): once UPKEEP_EVERY turns have
   * passed on this path since the last pass, the auxiliary model reads them in
   * the background while the player goes on. The result becomes an AI edit node
   * after whatever turn is current by then; it is dropped if the player has
   * since gone back before the turns it read.
   */
  private async upkeep(worldId: string, head: StoryNode): Promise<void> {
    const world = await this.repo.getWorld(worldId);
    if (!world?.settings.autoUpkeep || !this.llm || this.upkeeping.has(worldId)) return;
    const turns: StoryNode[] = [];
    for (const n of (await this.repo.path(head.id, UPKEEP_EVERY * 4)).reverse()) {
      if (n.kind === "opening" || n.meta.upkeep) break;
      if (n.kind === "turn") turns.unshift(n);
    }
    if (turns.length < UPKEEP_EVERY) return;
    this.upkeeping.add(worldId);
    try {
      // Marked first, so a failed pass waits for the next window instead of retrying every turn.
      await this.repo.mergeMeta(head.id, { upkeep: true });
      const state = await this.repo.getState(head.id);
      let result: ChatResult | null = null;
      try {
        const taboos = state.era.mode === "free" ? undefined : tabooLine(eraContext(world.eraId, state).eraCard?.content) ?? undefined;
        result = await this.call(upkeepMessages({ premise: world.settings.premise, state, turns, taboos }), { usage: { worldId, nodeId: head.id, purpose: "upkeep" }, aux: true, timeouts: CODEX_TIMEOUT });
      } catch { /* the story goes on without it */ }
      await this.serial(worldId, async () => {
        const c = await tree.cursor(this.repo, worldId);
        const onPath = (await this.repo.path(c.head.id, UPKEEP_EVERY * 4)).some((n) => n.id === head.id);
        const patch = result && onPath ? upkeepPatch(result.text, await this.repo.getState(c.head.id)) : null;
        const outcome = !result ? "failed" : !onPath ? "stale" : patch ? "ok" : "no_record";
        if (result) await this.platform.sql.batch([this.usage(worldId, head.id, "upkeep", result, outcome, this.auxModelName())]);
        if (!patch) return;
        if ("rejected" in await this.appendEdit(worldId, patch, codexSummary(patch, state), { by: "AI", promptVersion: state.era.mode === "free" ? UPKEEP_FREE_PROMPT_VERSION : UPKEEP_PROMPT_VERSION })) return;
        for (const fn of this.listeners) fn(worldId);
      });
    } finally {
      this.upkeeping.delete(worldId);
    }
  }

  /**
   * After a restart: a turn that was generating when the app died is saved
   * from the native stream cache (complete if the stream finished, otherwise
   * as an interrupted turn). Returns the world id that changed, if any.
   */
  async recoverPending(): Promise<string | null> {
    const pending = await this.repo.getSetting<Pending | null>("pending", null);
    if (!pending) return null;
    await this.repo.setSetting("pending", null);
    const snapshot = await this.platform.llm.resume(pending.streamId).catch(() => null);
    if (!snapshot) return null;
    const splitter = new RecordSplitter();
    let text = "";
    let finished = false;
    for (const e of snapshot.events) {
      if (e.type === "data") {
        const chunk = parseChunk(e.data);
        if (chunk?.content) { text += chunk.content; splitter.push(chunk.content); }
      } else if (e.type === "done") finished = true;
    }
    await this.platform.llm.ack(pending.streamId).catch(() => {});
    if (!text) return null;
    const c = await tree.cursor(this.repo, pending.worldId);
    const base = (await this.repo.getNode(pending.parentId))!;
    const world = (await this.repo.getWorld(pending.worldId))!;
    const state = await this.repo.getState(base.id);
    const era = eraContext(world.eraId, state);
    const { narrative, recordText } = splitter.finish();
    const cur = { ...c, head: pending.kind === "variant" ? c.head : base };
    if (finished) {
      const parsed = parseRecord(recordText);
      await this.commit(cur, base, pending.kind, pending.action, narrative, parsed.record, parsed.issues, state, era, world.settings,
        { text, finishReason: null, usage: null, firstTokenMs: null, totalMs: 0, attempts: 1 }, () => {});
    } else {
      await this.saveInterrupted(cur, base, pending.kind, pending.action, narrative || text, state, null);
    }
    return pending.worldId;
  }
}
