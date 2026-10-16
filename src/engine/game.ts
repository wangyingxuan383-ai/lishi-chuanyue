// The game session: opening, turns, variants, stop/interrupt, the extraction
// fallback, refusals and crash recovery (docs/PLAN_V3.md §5.1). UI code talks
// to this class only; it never touches SQL or the network directly.
import { formatDate, readDate } from "./calendar/date";
import { eraContext, eraPack, type EraContext } from "./era";
import type { Platform, SqlStatement } from "../platform";
import { migrate } from "./db/migrate";
import { Repo } from "./db/repo";
import { ChatError, parseChunk, streamChat, type ChatHandle, type ChatMessage, type ChatResult } from "./llm/chat";
import { isRefusal } from "./llm/refusal";
import {
  assistMessages, continueMessages, extractMessages, openingExtractMessages, openingMessages, PROMPT_VERSION, turnMessages,
  type Arrival, type SetupDraft,
} from "./prompt/turn";
import { lenientJson } from "./record/parse";
import { parseRecord } from "./record/parse";
import { RecordSplitter } from "./record/split";
import { applyRecord, type Chip, type TurnRecord } from "./state/apply";
import { parseMoney } from "./money";
import * as tree from "./tree";
import { DEFAULT_SETTINGS, type ActionMode, type StoryNode, type WorldSettings, type WorldState } from "./types";

export interface LlmConfig {
  slot: string;
  url: string;
  model: string;
  auxModel?: string;
  includeUsage: boolean;
  maxTokens?: number;
  extra?: Record<string, unknown>;
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

const EXTRACT_TIMEOUT = { firstByteMs: 20_000, idleMs: 20_000, totalMs: 40_000 };

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

export class Game {
  readonly repo: Repo;

  private constructor(readonly platform: Platform, public llm: LlmConfig | null) {
    this.repo = new Repo(platform);
  }

  static async open(platform: Platform, llm: LlmConfig | null = null): Promise<Game> {
    await migrate(platform);
    return new Game(platform, llm);
  }

  private requireLlm(): LlmConfig {
    if (!this.llm) throw new ChatError("no_secret");
    return this.llm;
  }

  // ---------- model calls ----------

  /** One streamed call with a single retry before any data arrives. */
  private async call(
    messages: ChatMessage[],
    opts: { aux?: boolean; timeouts?: typeof EXTRACT_TIMEOUT; onThinking?: () => void; onText?: (d: string, full: string) => void; onHandle?: (h: ChatHandle) => void },
  ): Promise<ChatResult & { attempts: number }> {
    const llm = this.requireLlm();
    for (let attempt = 1; ; attempt++) {
      const handle = streamChat(this.platform, {
        slot: llm.slot, url: llm.url, model: opts.aux ? llm.auxModel || llm.model : llm.model, messages,
        maxTokens: llm.maxTokens ?? 2048, includeUsage: llm.includeUsage, timeouts: opts.timeouts,
        extra: llm.extra as never,
      }, { onThinking: opts.onThinking, onText: opts.onText });
      opts.onHandle?.(handle);
      try {
        const result = await handle.result;
        void handle.streamId.then((id) => this.platform.llm.ack(id)).catch(() => {});
        return { ...result, attempts: attempt };
      } catch (error) {
        void handle.streamId.then((id) => this.platform.llm.ack(id)).catch(() => {});
        if (attempt === 1 && retryable(error)) continue;
        throw error;
      }
    }
  }

  private usage(worldId: string | null, nodeId: string | null, purpose: string, result: ChatResult | null, outcome: string, model: string): SqlStatement {
    return this.repo.usageStatement({
      worldId, nodeId, purpose, model,
      promptTokens: result?.usage?.promptTokens ?? null, completionTokens: result?.usage?.completionTokens ?? null,
      estimated: !result?.usage, firstTokenMs: result?.firstTokenMs ?? null, totalMs: result?.totalMs ?? null, outcome,
    });
  }

  /** The 补记 fallback: extracts a record from the narrative with the auxiliary model. */
  private async extract(era: EraContext, state: WorldState, action: string, narrative: string): Promise<{ record: TurnRecord | null; result: ChatResult | null }> {
    try {
      const result = await this.call(extractMessages({ era, state, action, narrative }), { aux: true, timeouts: EXTRACT_TIMEOUT });
      return { record: parseRecord(`<record>${result.text}`).record, result };
    } catch {
      return { record: null, result: null };
    }
  }

  // ---------- opening ----------

  /** Expands a rough idea into a full setup; fields the player filled are kept. */
  async assist(idea: string, current: Partial<SetupDraft>): Promise<Partial<SetupDraft> | null> {
    try {
      const result = await this.call(assistMessages(idea, current), { aux: true, timeouts: { firstByteMs: 30_000, idleMs: 30_000, totalMs: 90_000 } });
      const value = lenientJson(result.text) as Partial<SetupDraft> | null;
      await this.platform.sql.batch([this.usage(null, null, "assist", result, value ? "ok" : "no_record", this.llm!.auxModel || this.llm!.model)]);
      return value;
    } catch {
      return null;
    }
  }

  async createWorld(input: NewWorld, onEvent: (e: TurnEvent) => void): Promise<string | null> {
    const pack = eraPack(input.eraId);
    const settings: WorldSettings = { ...DEFAULT_SETTINGS, ...input.settings };
    const p = input.protagonist;
    const initial: WorldState = {
      version: 1,
      time: { start: pack ? formatDate(pack.start.date, pack.calendar) : "", date: pack?.start.date ?? null, startHour: pack?.start.hour, elapsedMinutes: 0 },
      placeId: null,
      protagonist: {
        name: p.name, aliases: [], age: p.age, gender: p.gender, identity: p.identity,
        origin: input.arrival === "不穿越" ? "" : input.origin, cheat: "",
        stats: { money: 0, debt: 0, health: 80, energy: 70, fame: 10 }, statuses: [], items: [],
      },
      people: [], places: [], cards: [], goals: [], era: { packId: pack?.id ?? null }, deviations: [],
    };
    const era = eraContext(pack?.id ?? null, initial);
    const opening = { era, settings, protagonistName: p.name, protagonist: p, arrival: input.arrival, origin: input.origin, hint: input.opening.mode === "ai" ? input.opening.hint : "" };

    let narrative: string;
    let record: TurnRecord | null;
    let result: ChatResult | null = null;
    if (input.opening.mode === "player") {
      // The player wrote the opening: keep it verbatim and only extract the state.
      narrative = input.opening.text.trim();
      onEvent({ type: "organizing" });
      try {
        result = await this.call(openingExtractMessages({ ...opening, text: narrative }), { aux: true, timeouts: EXTRACT_TIMEOUT });
        record = parseRecord(`<record>${result.text}`).record;
      } catch (error) {
        onEvent({ type: "failed", ...failReason(error), partialSaved: false });
        return null;
      }
    } else {
      const splitter = new RecordSplitter();
      let shown = "";
      try {
        result = await this.call(openingMessages(opening), {
          onThinking: () => onEvent({ type: "thinking" }),
          onText: (delta) => {
            const visible = splitter.push(delta);
            if (visible) { shown += visible; onEvent({ type: "text", delta: visible, full: shown }); }
          },
        });
      } catch (error) {
        onEvent({ type: "failed", ...failReason(error), partialSaved: false });
        return null;
      }
      const split = splitter.finish();
      narrative = split.narrative;
      record = parseRecord(split.recordText).record;
      if (!record) {
        onEvent({ type: "organizing" });
        record = (await this.extract(era, initial, "（开场）", narrative)).record;
      }
    }
    if (!record) {
      onEvent({ type: "failed", reason: "no_record", partialSaved: false });
      return null;
    }

    // Opening-only fields: date, hour, currency and the starting purse (an absolute amount).
    // The program counts every later date (D119); a pack's date stays when the opening gave no usable one.
    const rules = pack?.calendar ?? {};
    if (record.date != null) {
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
    const purse = record.money != null ? parseMoney(record.money, startEra.currency) : null;
    initial.protagonist.stats.money = Math.max(0, purse ?? pack?.startMoney ?? 0);
    const { money: _m, time: _t, date: _d, hour: _h, currency: _c, ...rest } = record;
    const applied = applyRecord(initial, rest, { mode: "do", difficulty: settings.difficulty, currency: startEra.currency }, { advanceTime: false });

    const model = this.llm!.model;
    const { world, node } = await this.repo.createWorld({
      title: input.title.trim() || `${p.name || "无名"}的故事`, eraId: pack?.id ?? "free", settings,
      opening: {
        parentId: null, kind: "opening", narrative, record, choices: record.choices ?? [], state: applied.state,
        meta: {
          promptVersion: PROMPT_VERSION, model, playerWritten: input.opening.mode === "player",
          firstTokenMs: result?.firstTokenMs, totalMs: result?.totalMs, usage: result?.usage, raw: result?.text,
        },
      },
    });
    if (result) await this.platform.sql.batch([this.usage(world.id, node.id, "opening", result, "ok", model)]);
    onEvent({ type: "done", cursor: await tree.cursor(this.repo, world.id), node, chips: [] });
    return world.id;
  }

  // ---------- turns ----------

  async editState(worldId: string, patch: TurnRecord, summary: string): Promise<tree.Cursor> {
    const c = await tree.cursor(this.repo, worldId);
    const state = await this.repo.getState(c.head.id);
    const world = (await this.repo.getWorld(worldId))!;
    const era = eraContext(world.eraId, state);
    const applied = applyRecord(state, patch, { mode: "do", difficulty: world.settings.difficulty, currency: era.currency, clock: era.clock }, { advanceTime: false });
    return tree.append(this.repo, c, {
      kind: "edit", narrative: "", actionText: summary, record: patch, choices: [],
      state: applied.state, meta: { chips: applied.chips },
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

  private run(worldId: string, actionIn: PlayerAction | null, kind: "turn" | "variant", hint: string | null, onEvent: (e: TurnEvent) => void): TurnHandle {
    let handle: ChatHandle | null = null;
    let stopped = false;
    const done = (async () => {
      let c = await tree.cursor(this.repo, worldId);
      let edit: StoryNode | null = null;
      if (kind === "variant") {
        while (c.head.kind === "edit") {
          edit = c.head;
          c = { ...c, head: (await this.repo.getNode(c.head.parentId!))! };
        }
        if (!edit && c.head.lastChildId) {
          const child = await this.repo.getNode(c.head.lastChildId);
          if (child?.kind === "edit") edit = child;
        }
      }
      const world = (await this.repo.getWorld(worldId))!;
      // For a variant, the turn is re-played from the head's parent with the same action.
      const base = kind === "variant" ? (await this.repo.getNode(c.head.parentId!))! : c.head;
      const action: PlayerAction = actionIn ?? { mode: c.head.actionMode ?? "continue", text: c.head.actionText ?? "", directorNote: c.head.directorNote };
      const state = await this.repo.getState(base.id);
      const era = eraContext(world.eraId, state);
      const history = await this.repo.path(base.id, 40);
      const messages = turnMessages({
        era, settings: world.settings, protagonistName: state.protagonist.name, state, history, mode: action.mode, text: action.text,
        directorNote: action.directorNote, notes: (base.meta.notes as string[] | undefined) ?? [], rewriteHint: hint,
      });

      const splitter = new RecordSplitter();
      let shown = "";
      let result: ChatResult & { attempts: number };
      try {
        result = await this.call(messages, {
          onThinking: () => onEvent({ type: "thinking" }),
          onText: (delta) => {
            const visible = splitter.push(delta);
            if (visible) { shown += visible; onEvent({ type: "text", delta: visible, full: shown }); }
          },
          onHandle: (h) => {
            handle = h;
            if (stopped) h.cancel();
            void h.streamId.then((streamId) => this.repo.setSetting("pending", {
              worldId, lineId: c.line.id, parentId: base.id, streamId, kind, action,
            } satisfies Pending));
          },
        });
      } catch (error) {
        await this.repo.setSetting("pending", null);
        const partial = error instanceof ChatError ? error.partial : "";
        const narrative = partial ? splitter.finish().narrative || partial : "";
        if (narrative) {
          const cursor = await this.saveInterrupted(c, base, kind, action, narrative, state, messages);
          onEvent({ type: "failed", ...failReason(error), partialSaved: true, cursor });
        } else {
          onEvent({ type: "failed", ...failReason(error), partialSaved: false });
        }
        return;
      }

      const { narrative, recordText } = splitter.finish();
      const parsed = parseRecord(recordText);
      if (isRefusal({ finishReason: result.finishReason, narrative, hasRecord: !!parsed.record })) {
        await this.repo.setSetting("pending", null);
        await this.platform.sql.batch([this.usage(worldId, null, "turn", result, "refused", this.llm!.model)]);
        onEvent({ type: "failed", reason: "refused", partialSaved: false });
        return;
      }
      const cursor = await this.commit(c, base, kind, action, narrative, parsed.record, parsed.issues, state, era, world.settings, result, onEvent);
      if (edit) cursor.cursor = await this.editState(worldId, edit.record as TurnRecord, `${edit.actionText ?? ""}（已沿用）`);
      await this.repo.setSetting("pending", null);
      onEvent({ type: "done", cursor: cursor.cursor, node: cursor.node, chips: cursor.chips });
    })();
    return {
      stop: () => {
        stopped = true;
        handle?.cancel();
      },
      catchUp: async () => {
        await handle?.catchUp();
      },
      done,
    };
  }

  private async commit(
    c: tree.Cursor, base: StoryNode, kind: "turn" | "variant", action: PlayerAction, narrative: string,
    recordIn: TurnRecord | null, issues: string[], state: WorldState, era: EraContext, settings: WorldSettings,
    result: ChatResult & { attempts: number }, onEvent: (e: TurnEvent) => void,
  ): Promise<{ cursor: tree.Cursor; node: StoryNode; chips: Chip[] }> {
    let record = recordIn;
    let extractResult: ChatResult | null = null;
    if (!record || !record.choices?.length) {
      onEvent({ type: "organizing" });
      const extracted = await this.extract(era, state, action.text || "（继续）", narrative);
      extractResult = extracted.result;
      if (extracted.record) record = record ? { ...extracted.record, ...record, choices: extracted.record.choices } : extracted.record;
    }
    const applied = applyRecord(state, record, { mode: action.mode, difficulty: settings.difficulty, currency: era.currency, clock: era.clock });
    const model = this.llm!.model;
    const node = {
      kind: "turn" as const, actionMode: action.mode, actionText: action.text, directorNote: action.directorNote ?? null,
      narrative, record, choices: record?.choices ?? [], status: record ? ("ok" as const) : ("no_record" as const), state: applied.state,
      meta: {
        chips: applied.chips, notes: applied.notes, log: [...issues, ...applied.log], promptVersion: PROMPT_VERSION, model,
        firstTokenMs: result.firstTokenMs, totalMs: result.totalMs, usage: result.usage, attempts: result.attempts,
        extracted: !!extractResult, raw: result.text,
      },
    };
    const next = kind === "variant" ? await tree.addVariant(this.repo, c, node) : await tree.append(this.repo, { ...c, head: base }, node);
    const usage = [this.usage(c.worldId, next.head.id, "turn", result, "ok", model)];
    if (extractResult) usage.push(this.usage(c.worldId, next.head.id, "extract", extractResult, "ok", this.llm!.auxModel || model));
    await this.platform.sql.batch(usage);
    return { cursor: next, node: next.head, chips: applied.chips };
  }

  private async saveInterrupted(c: tree.Cursor, base: StoryNode, kind: "turn" | "variant", action: PlayerAction, narrative: string, state: WorldState, messages: ChatMessage[]): Promise<tree.Cursor> {
    const node = {
      kind: "turn" as const, actionMode: action.mode, actionText: action.text, directorNote: action.directorNote ?? null,
      narrative, choices: [], status: "interrupted" as const, state,
      meta: { chips: [], promptVersion: PROMPT_VERSION, model: this.llm?.model, messages },
    };
    return kind === "variant" ? tree.addVariant(this.repo, c, node) : tree.append(this.repo, { ...c, head: base }, node);
  }

  /** Continues an interrupted head turn in place. */
  resumeInterrupted(worldId: string, onEvent: (e: TurnEvent) => void): TurnHandle {
    let handle: ChatHandle | null = null;
    const done = (async () => {
      const c = await tree.cursor(this.repo, worldId);
      const node = c.head;
      if (node.status !== "interrupted" || !node.parentId) return;
      const world = (await this.repo.getWorld(worldId))!;
      const state = await this.repo.getState(node.parentId);
      const era = eraContext(world.eraId, state);
      const base = (node.meta.messages as ChatMessage[] | undefined) ?? turnMessages({
        era, settings: world.settings, protagonistName: state.protagonist.name, state, history: await this.repo.path(node.parentId, 40),
        mode: node.actionMode ?? "continue", text: node.actionText ?? "",
      });
      const splitter = new RecordSplitter();
      let shown = node.narrative;
      let result: ChatResult & { attempts: number };
      try {
        result = await this.call(continueMessages(base, node.narrative), {
          onThinking: () => onEvent({ type: "thinking" }),
          onText: (delta) => {
            const visible = splitter.push(delta);
            if (visible) { shown += visible; onEvent({ type: "text", delta: visible, full: shown }); }
          },
          onHandle: (h) => (handle = h),
        });
      } catch (error) {
        onEvent({ type: "failed", ...failReason(error), partialSaved: true, cursor: c });
        return;
      }
      const { narrative: addition, recordText } = splitter.finish();
      const narrative = `${node.narrative}${addition}`;
      let record = parseRecord(recordText).record;
      if (!record) {
        onEvent({ type: "organizing" });
        record = (await this.extract(era, state, node.actionText ?? "", narrative)).record;
      }
      const action = { mode: node.actionMode ?? ("continue" as const), text: node.actionText ?? "" };
      const applied = applyRecord(state, record, { mode: action.mode, difficulty: world.settings.difficulty, currency: era.currency, clock: era.clock });
      const updated = await this.repo.completeNode(node.id, {
        narrative, record, choices: record?.choices ?? [], status: record ? "ok" : "no_record",
        meta: { ...node.meta, messages: undefined, chips: applied.chips, notes: applied.notes, log: applied.log, resumed: true, usage: result.usage },
      }, applied.state, [this.usage(worldId, node.id, "continue", result, "ok", this.llm!.model)]);
      onEvent({ type: "done", cursor: { ...c, head: updated }, node: updated, chips: applied.chips });
    })();
    return { stop: () => handle?.cancel(), catchUp: async () => { await handle?.catchUp(); }, done };
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
      await this.saveInterrupted(cur, base, pending.kind, pending.action, narrative || text, state, []);
    }
    return pending.worldId;
  }
}
