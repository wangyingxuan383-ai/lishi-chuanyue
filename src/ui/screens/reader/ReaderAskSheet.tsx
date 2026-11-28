// Inline "问伴聊" sheet inside ReaderScreen (R36-T005, D194).
// Answers literary, character, and world-setting questions about the selected passage
// with surrounding chapter context, and supports one-tap handoff to Companion research.
import { useEffect, useRef, useState } from "react";
import { fallbackEligible, type LlmConfig } from "../../../engine/game";
import {
  ChatError,
  isMaxCompletionTokensParamError,
  streamChat,
  type ChatHandle,
  type ChatMessage,
  type ChatResult,
} from "../../../engine/llm/chat";
import { chatCompletionsUrl, explainFailure } from "../../../engine/llm/providers";
import type { Json } from "../../../platform";
import { useApp } from "../../app/context";
import { Icon } from "../../components/Icon";
import { Sheet } from "../../components/Sheet";
import { CompanionMarkdown } from "../companion/CompanionMarkdown";

const QUICK_CHIPS = [
  "解释这段里的典故与名物",
  "梳理此处出场人物与关系",
  "赏析这段的伏笔与写法",
] as const;

export interface ReaderAskHandoff {
  prompt: string;
  asked: { q: string; a: string }[];
  draftQuestion: string;
}

export interface ReaderAskSheetProps {
  bookId?: string;
  worldId?: string;
  bookTitle: string;
  sectionIndex: number;
  sectionTitle: string;
  selectedText: string;
  contextParagraphs: string[];
  onOpenFullCompanion: (payload: ReaderAskHandoff) => void;
  onClose: () => void;
}

export interface AskTurn {
  q: string;
  a: string;
  pending: boolean;
  thinking?: boolean;
  incomplete?: boolean;
  note?: string;
}

/**
 * Pure handoff builder for transferring inline ReaderAskSheet Q&A into CompanionScreen:
 * - Excludes `pending` and `incomplete` turns from `asked` so error banners or `"已停止。"`
 *   are never imported as assistant answers.
 * - Prioritizes `customQ?.trim()`, typed `question.trim()`, or the trailing `pending || incomplete`
 *   turn's `q` when filling `draftQuestion` so failed/interrupted questions are preserved in the input box
 *   without resurrecting an older failed turn that was already superseded by a completed Q&A turn.
 */
export function buildReaderAskHandoff(params: {
  bookTitle: string;
  sectionIndex: number;
  sectionTitle: string;
  selectedText: string;
  turns: AskTurn[];
  question: string;
  customQ?: string;
}): ReaderAskHandoff {
  const { bookTitle, sectionIndex, sectionTitle, selectedText, turns, question, customQ } = params;
  const lastTurn = turns.at(-1);
  const unresolved = lastTurn && (lastTurn.pending || lastTurn.incomplete) ? lastTurn : undefined;
  const lastUnresolvedQ = unresolved?.q?.trim();
  const explicitOrPendingQ = customQ?.trim() || question.trim() || lastUnresolvedQ || "";
  const qForPrompt = explicitOrPendingQ || "请结合这段原文帮我解读";
  const excerpt = selectedText.slice(0, 320);
  const prompt = `我正在读《${bookTitle}》第 ${sectionIndex + 1} 节（${sectionTitle}）。\n\n原文摘录：\n> ${excerpt}\n\n想聊的问题：${qForPrompt}`;
  const asked = turns
    .filter((t) => !t.pending && !t.incomplete && t.a.trim())
    .map((t, idx) => ({
      q:
        idx === 0
          ? `我正在读《${bookTitle}》第 ${sectionIndex + 1} 节（${sectionTitle}）。\n\n原文摘录：\n> ${excerpt}\n\n${t.q}`
          : t.q,
      a: t.a,
    }));
  const draftQuestion = asked.length > 0 ? explicitOrPendingQ : prompt;
  return { prompt, asked, draftQuestion };
}

function buildReaderAskSystemPrompt(
  bookTitle: string,
  sectionIndex: number,
  sectionTitle: string,
  selectedText: string,
  contextParagraphs: string[],
): string {
  const contextText = contextParagraphs
    .map((p) => p.trim())
    .filter(Boolean)
    .join("\n\n")
    .slice(0, 2600);
  return [
    `你是“伴聊”读书知己，正在陪读者阅读《${bookTitle}》。`,
    "请结合读者选中的原文与所在章节上下文，用通顺、温润、言简意赅的中文解答名物典故、人物关系、伏笔或写法问题；重点清晰，不编造原文没有的情节，不要堆砌空话。",
    "",
    `【当前章节】：第 ${sectionIndex + 1} 节 · ${sectionTitle}`,
    `【读者选中的原文】：\n${selectedText.slice(0, 1200)}`,
    ...(contextText ? [`【所在段落上下文】：\n${contextText}`] : []),
  ].join("\n");
}

function needsCompletionTokensRetry(err: unknown): boolean {
  if (isMaxCompletionTokensParamError(err)) return true;
  if (!(err instanceof ChatError) || err.kind !== "http" || !!err.partial || ![400, 422].includes(err.status ?? 0)) {
    return false;
  }
  const lower = err.message.toLowerCase();
  return (
    /max_completion_tokens/i.test(lower) ||
    (lower.includes("max_tokens") && (lower.includes("not supported") || lower.includes("unsupported"))) ||
    (lower.includes("temperature") &&
      (lower.includes("not supported") || lower.includes("unsupported") || lower.includes("only the default")))
  );
}

function isAskFallbackEligible(err: unknown): boolean {
  if (fallbackEligible(err)) return true;
  if (!(err instanceof ChatError)) return false;
  const k = String(err.kind);
  return k === "rate_limit" || k === "server" || k === "timeout" || k === "network";
}

function sameAskLlm(a: LlmConfig, b: LlmConfig): boolean {
  return a.slot === b.slot && a.url === b.url && a.model === b.model;
}

export function ReaderAskSheet({
  worldId,
  bookTitle,
  sectionIndex,
  sectionTitle,
  selectedText,
  contextParagraphs,
  onOpenFullCompanion,
  onClose,
}: ReaderAskSheetProps) {
  const { game, profile, push, toast } = useApp();
  const [question, setQuestion] = useState("");
  const [turns, setTurns] = useState<AskTurn[]>([]);
  const handleRef = useRef<ChatHandle | null>(null);

  useEffect(
    () => () => {
      handleRef.current?.cancel();
      handleRef.current = null;
    },
    [],
  );

  const pending = turns.some((t) => t.pending);

  const updateLatest = (patch: Partial<AskTurn>) => {
    setTurns((prev) => prev.map((item, idx) => (idx === prev.length - 1 ? { ...item, ...patch } : item)));
  };

  const buildCompanionHandoff = (customQ?: string): ReaderAskHandoff =>
    buildReaderAskHandoff({
      bookTitle,
      sectionIndex,
      sectionTitle,
      selectedText,
      turns,
      question,
      customQ,
    });

  const askQuestion = async (rawQ?: string) => {
    const q = (rawQ ?? question).trim();
    const primaryLlm: LlmConfig | null =
      game.llm ??
      (profile
        ? {
            slot: profile.keySlot,
            url: chatCompletionsUrl(profile.baseUrl),
            model: profile.mainModel,
            includeUsage: profile.includeUsage,
          }
        : null);
    if (!q || pending || !primaryLlm) return;

    const historyMessages: ChatMessage[] = [];
    for (const t of turns) {
      if (!t.pending && !t.incomplete && t.a.trim()) {
        historyMessages.push({ role: "user", content: t.q });
        historyMessages.push({ role: "assistant", content: t.a });
      }
    }

    if (!rawQ) setQuestion("");
    setTurns((prev) => [...prev, { q, a: "", pending: true, thinking: false }]);

    const systemPrompt = buildReaderAskSystemPrompt(
      bookTitle,
      sectionIndex,
      sectionTitle,
      selectedText,
      contextParagraphs,
    );
    const messages: ChatMessage[] = [
      { role: "system", content: systemPrompt },
      ...historyMessages,
      { role: "user", content: q },
    ];

    let streamed = "";
    let cancelledByUser = false;

    const recordUsage = async (
      usedModel: string,
      res: ChatResult | null,
      outcome: "ok" | "cancelled" | "failed",
    ) => {
      await game.platform.sql
        .batch([
          game.repo.usageStatement({
            worldId: worldId ?? null,
            nodeId: null,
            purpose: "ask",
            model: usedModel,
            promptTokens: res?.usage?.promptTokens ?? null,
            completionTokens: res?.usage?.completionTokens ?? null,
            estimated: res?.usage?.promptTokens == null || res?.usage?.completionTokens == null,
            firstTokenMs: res?.firstTokenMs ?? null,
            totalMs: res?.totalMs ?? null,
            outcome,
          }),
        ])
        .catch(() => {});
    };

    const runWithLlm = async (llm: LlmConfig): Promise<{ res: ChatResult; usedLlm: LlmConfig }> => {
      let useCompletionTokens = false;
      for (;;) {
        const handle = streamChat(
          game.platform,
          {
            slot: llm.slot,
            url: llm.url,
            model: llm.model,
            includeUsage: llm.includeUsage,
            temperature: useCompletionTokens ? undefined : 0.5,
            maxTokens: useCompletionTokens ? undefined : 1200,
            extra: useCompletionTokens
              ? { ...(llm.extra as Record<string, Json> | undefined), max_completion_tokens: 1200 }
              : (llm.extra as Record<string, Json> | undefined),
            messages,
          },
          {
            onThinking: () => updateLatest({ thinking: true }),
            onText: (_delta, full) => {
              streamed = full;
              updateLatest({ a: full, thinking: false, pending: true });
            },
          },
        );
        handleRef.current = Object.assign(handle, {
          cancelWithFlag: () => {
            cancelledByUser = true;
            handle.cancel();
          },
        });
        try {
          const res = await handle.result;
          await recordUsage(llm.model, res, "ok");
          return { res, usedLlm: llm };
        } catch (err: unknown) {
          if (!cancelledByUser && !useCompletionTokens && needsCompletionTokensRetry(err)) {
            useCompletionTokens = true;
            continue;
          }
          const unsent =
            err instanceof ChatError && (err.kind === "no_secret" || err.kind === "url_not_bound");
          if (!unsent) {
            const isCancelled =
              cancelledByUser || (err instanceof ChatError && err.kind === "cancelled");
            await recordUsage(llm.model, null, isCancelled ? "cancelled" : "failed");
          }
          throw err;
        } finally {
          void handle.streamId.then((id) => game.platform.llm.ack?.(id)).catch(() => {});
        }
      }
    };

    try {
      let outcome: { res: ChatResult; usedLlm: LlmConfig };
      try {
        outcome = await runWithLlm(primaryLlm);
      } catch (primaryErr: unknown) {
        const backup = game.fallbackLlm;
        if (
          !cancelledByUser &&
          backup &&
          !sameAskLlm(backup, primaryLlm) &&
          isAskFallbackEligible(primaryErr)
        ) {
          streamed = "";
          updateLatest({ a: "", thinking: false, pending: true });
          outcome = await runWithLlm(backup);
        } else {
          throw primaryErr;
        }
      }
      updateLatest({ a: outcome.res.text || "没有收到回答。", pending: false, thinking: false });
    } catch (err: unknown) {
      const friendly =
        cancelledByUser || (err instanceof ChatError && err.kind === "cancelled")
          ? "已停止。"
          : err instanceof ChatError
            ? explainFailure(err.kind, err.status)
            : "这次没有连上服务，请稍后再试。";
      if (streamed.trim()) {
        updateLatest({
          a: streamed,
          pending: false,
          thinking: false,
          incomplete: true,
          note: `${friendly}（以上是已收到的内容）`,
        });
      } else {
        updateLatest({
          a: friendly,
          pending: false,
          thinking: false,
          incomplete: true,
        });
      }
    } finally {
      handleRef.current = null;
    }
  };

  const stopStream = () => {
    const h = handleRef.current as (ChatHandle & { cancelWithFlag?: () => void }) | null;
    if (!h) return;
    if (h.cancelWithFlag) h.cancelWithFlag();
    else h.cancel();
  };

  return (
    <Sheet title="问伴聊" onClose={onClose}>
      <div className="stack gap-3">
        <div className="reader-ask-excerpt">
          <small className="muted">
            《{bookTitle}》第 {sectionIndex + 1} 节{sectionTitle ? ` · ${sectionTitle}` : ""}
          </small>
          <blockquote>{selectedText.length > 180 ? `${selectedText.slice(0, 180)}…` : selectedText}</blockquote>
        </div>

        {!profile && !game.llm ? (
          <div className="status-card">
            <b>还没有连接 AI 服务</b>
            <small>连接一个你自己的 AI 服务后，选段即可随时解释典故、梳理人物关系与赏析写法。</small>
            <div className="row wrap gap-2">
              <button
                type="button"
                className="primary"
                onClick={() => {
                  onClose();
                  push({ name: "setup" });
                }}
              >
                去连接 AI 服务
              </button>
              <button
                type="button"
                className="ghost"
                onClick={() => {
                  const payload = buildCompanionHandoff();
                  onClose();
                  onOpenFullCompanion(payload);
                }}
              >
                打开伴聊
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="reader-ask-chips" role="group" aria-label="快捷提问">
              {QUICK_CHIPS.map((chip) => (
                <button
                  key={chip}
                  type="button"
                  className="reader-ask-chip"
                  disabled={pending}
                  onClick={() => void askQuestion(chip)}
                >
                  <Icon name="sparkle" size={14} />
                  <span>{chip}</span>
                </button>
              ))}
            </div>

            {turns.map((turn, idx) => (
              <div key={idx} className="ask-item reader-ask-turn">
                <b>{turn.q}</b>
                {turn.a ? (
                  <CompanionMarkdown text={turn.a} streaming={turn.pending} />
                ) : (
                  <p className="muted m-0">{turn.thinking ? "伴聊正在细想…" : "正在翻阅本节上下文…"}</p>
                )}
                {turn.note && <p className="field-hint m-0">{turn.note}</p>}
                {!turn.pending && turn.a && !turn.incomplete && (
                  <div className="row gap-1">
                    <button
                      type="button"
                      className="ghost small"
                      onClick={() =>
                        void navigator.clipboard
                          ?.writeText(turn.a)
                          .then(() => toast("已复制解答"), () => toast("没能复制"))
                      }
                    >
                      复制
                    </button>
                  </div>
                )}
              </div>
            ))}

            <div className="row between center">
              <small className="muted">结合选中段落与本章上下文解答</small>
              <button
                type="button"
                className="ghost small"
                onClick={() => {
                  stopStream();
                  const unresolvedQ = [...turns]
                    .reverse()
                    .find((t) => t.pending || t.incomplete)
                    ?.q?.trim();
                  const payload = buildCompanionHandoff(question.trim() || unresolvedQ);
                  onClose();
                  onOpenFullCompanion(payload);
                }}
              >
                <span>转到伴聊深聊</span>
                <Icon name="external" size={15} />
              </button>
            </div>

            <div className="row gap-2">
              <input
                className="grow"
                aria-label="向伴聊提问"
                value={question}
                placeholder={turns.length ? "继续追问这段细节…" : "输入你想问的词句、人物或背景…"}
                onChange={(e) => setQuestion(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229) {
                    e.preventDefault();
                    void askQuestion();
                  }
                }}
              />
              {pending ? (
                <button type="button" onClick={stopStream}>
                  停止
                </button>
              ) : (
                <button
                  type="button"
                  className="primary"
                  disabled={!question.trim()}
                  onClick={() => void askQuestion()}
                >
                  问
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </Sheet>
  );
}
