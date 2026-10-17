// Optional writing tools. No story turn is generated and nothing is saved until adoption.
import type { Game } from "../game";
import { ChatError, streamChat, type ChatHandle, type ChatMessage, type ChatResult } from "../llm/chat";
import { isRefusal } from "../llm/refusal";
import * as tree from "../tree";
import type { ActionMode } from "../types";

/** writing-2: the version is kept with each adopted rewrite; it is not sent to the model. */
export const WRITING_PROMPT_VERSION = "writing-2";
export interface WritingAnchor { worldId: string; lineId: string; headId: string; nodeId: string; original: string }
export interface TextRange { start: number; end: number }
export class WritingError extends Error {}
export const STALE_WRITING = "故事或原文已经变了，请重新打开这个工具。";

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
