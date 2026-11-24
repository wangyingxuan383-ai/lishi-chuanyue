// Inline spoiler-safe "问伴聊" sheet inside ReaderScreen (R36-T005).
// Answers literary, character, and historical questions about the selected passage
// while strictly forbidding spoilers beyond the reader's current chapter (`sectionIndex`).
import { useEffect, useRef, useState } from "react";
import { ChatError, streamChat, type ChatHandle, type ChatMessage } from "../../../engine/llm/chat";
import { chatCompletionsUrl, explainFailure } from "../../../engine/llm/providers";
import { useApp } from "../../app/context";
import { Icon } from "../../components/Icon";
import { Sheet } from "../../components/Sheet";
import { CompanionMarkdown } from "../companion/CompanionMarkdown";

const QUICK_CHIPS = [
  "解释这段里的典故与名物",
  "梳理此处出场人物与关系",
  "赏析这段的伏笔与写法",
] as const;

export interface ReaderAskSheetProps {
  bookId?: string;
  worldId?: string;
  bookTitle: string;
  sectionIndex: number;
  sectionTitle: string;
  selectedText: string;
  contextParagraphs: string[];
  onOpenFullCompanion: (prompt: string) => void;
  onClose: () => void;
}

interface AskTurn {
  q: string;
  a: string;
  pending: boolean;
  thinking?: boolean;
  incomplete?: boolean;
  note?: string;
}

function buildSpoilerSafeSystemPrompt(
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
    `【严格防剧透红线】：读者目前只读到《${bookTitle}》第 ${sectionIndex + 1} 节（${sectionTitle}）。严禁透露、暗示或剧透第 ${sectionIndex + 1} 节之后的任何剧情走向、人物结局、隐藏身份或后文反转！如果读者的问题涉及后文才揭晓的谜团，请明确说明“读到当前章节尚未揭晓”，仅基于前文与本段线索做分析。`,
    "请用通顺、温润、言简意赅的中文回答，重点清晰，不要堆砌空话。",
    "",
    `【当前章节】：第 ${sectionIndex + 1} 节 · ${sectionTitle}`,
    `【读者选中的原文】：\n${selectedText.slice(0, 1200)}`,
    ...(contextText ? [`【所在段落上下文】：\n${contextText}`] : []),
  ].join("\n");
}

export function ReaderAskSheet({
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

  const buildCompanionHandoffPrompt = (customQ?: string) => {
    const q = (customQ ?? question.trim()) || "请结合这段原文帮我解读";
    const excerpt = selectedText.slice(0, 320);
    return `我正在读《${bookTitle}》第 ${sectionIndex + 1} 节（${sectionTitle}），请勿剧透后续章节。\n\n原文摘录：\n> ${excerpt}\n\n想聊的问题：${q}`;
  };

  const askQuestion = async (rawQ?: string) => {
    const q = (rawQ ?? question).trim();
    if (!q || pending || !profile) return;

    const historyMessages: ChatMessage[] = [];
    for (const t of turns) {
      if (!t.pending && !t.incomplete && t.a.trim()) {
        historyMessages.push({ role: "user", content: t.q });
        historyMessages.push({ role: "assistant", content: t.a });
      }
    }

    if (!rawQ) setQuestion("");
    setTurns((prev) => [...prev, { q, a: "", pending: true, thinking: false }]);

    const systemPrompt = buildSpoilerSafeSystemPrompt(
      bookTitle,
      sectionIndex,
      sectionTitle,
      selectedText,
      contextParagraphs,
    );

    let streamed = "";
    let cancelledByUser = false;
    const handle = streamChat(
      game.platform,
      {
        slot: profile.keySlot,
        url: chatCompletionsUrl(profile.baseUrl),
        model: profile.mainModel,
        includeUsage: profile.includeUsage,
        temperature: 0.5,
        maxTokens: 1200,
        messages: [
          { role: "system", content: systemPrompt },
          ...historyMessages,
          { role: "user", content: q },
        ],
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
      updateLatest({ a: res.text || "没有收到回答。", pending: false, thinking: false });
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
      if (handleRef.current === handle) {
        handleRef.current = null;
      }
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
            《{bookTitle}》第 {sectionIndex + 1} 节 · 防剧透保护中
          </small>
          <blockquote>{selectedText.length > 180 ? `${selectedText.slice(0, 180)}…` : selectedText}</blockquote>
        </div>

        {!profile ? (
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
                  const p = buildCompanionHandoffPrompt();
                  onClose();
                  onOpenFullCompanion(p);
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
              <small className="muted">仅依据截至第 {sectionIndex + 1} 节的内容解答</small>
              <button
                type="button"
                className="ghost small"
                onClick={() => {
                  stopStream();
                  const p = buildCompanionHandoffPrompt(turns.at(-1)?.q);
                  onClose();
                  onOpenFullCompanion(p);
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
