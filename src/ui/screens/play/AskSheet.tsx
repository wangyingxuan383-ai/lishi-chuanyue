import { useEffect, useRef, useState } from "react";
import { AGENT_TASK_RECIPES, taskRecipeText } from "../../../content/agentTasks";
import { useApp } from "../../app/context";
import { Icon } from "../../components/Icon";
import { MenuSheet, Sheet } from "../../components/Sheet";
import { CompanionMarkdown } from "../companion/CompanionMarkdown";
import { SourceScopeRow } from "../../components/SourceScope";
import { RecentUsageLine } from "../../components/TurnUsage";
import { AUTO_SCOPE, type SourceScope } from "../../../engine/sources/scope";
import type { SourceBinding } from "../../../engine/sources/types";

/** 查一查 (R07-T001 / R31-P4): multi-turn questions about this world or the era; the story does not move. */
export function AskSheet({ worldId, bookId, source, initialQuestion, captureReading, onClose }: { worldId: string; bookId?: string; source?: SourceBinding | null; initialQuestion?: string; captureReading?: () => void; onClose: () => void }) {
  const { game, toast, push } = useApp();
  const [saved, setSaved] = useState<number[]>([]);
  const [question, setQuestion] = useState(initialQuestion ?? "");
  const [recipes, setRecipes] = useState(false);
  const [asked, setAsked] = useState<{ q: string; a: string; pending: boolean; note?: string; incomplete?: boolean }[]>([]);
  const [since, setSince] = useState<string | null>(null);
  const [usageTick, setUsageTick] = useState(0);
  /** 资料范围 (D184): kept while the sheet is open, 自动 when it opens again. */
  const [scope, setScope] = useState<SourceScope>(AUTO_SCOPE);
  const pending = asked.some((x) => x.pending);
  /** The question in flight; closing the sheet stops it too (R30, D170). */
  const running = useRef<AbortController | null>(null);
  useEffect(() => { if (initialQuestion) setQuestion(initialQuestion); }, [initialQuestion]);
  useEffect(() => () => running.current?.abort(), []);
  const update = (patch: { a: string; pending: boolean; note?: string; incomplete?: boolean }) => setAsked((list) => list.map((x, i) => (i === list.length - 1 ? { ...x, ...patch } : x)));
  const ask = async () => {
    const q = question.trim();
    if (!q || pending) return;
    const history = asked
      .filter((x) => !x.pending && !x.incomplete && x.a && x.a !== "已停止。" && x.a !== "这次没查到，稍后再试。")
      .map(({ q: pq, a: pa }) => ({ q: pq, a: pa }));
    setQuestion("");
    setSince((prev) => prev ?? new Date().toISOString());
    setAsked((list) => [...list, { q, a: "", pending: true }]);
    const control = new AbortController();
    running.current = control;
    let latest = "";
    try {
      const answer = await game.ask(worldId, q, (full) => { latest = full; update({ a: full, pending: true }); }, control.signal, scope, history);
      update({ a: answer || "没有查到。", pending: false });
    } catch (error) {
      const reason = error instanceof Error && error.message && /[\u4e00-\u9fff]/.test(error.message) ? error.message : "";
      if (latest.trim()) {
        update({ a: latest, pending: false, incomplete: true, note: control.signal.aborted ? "已停止，以上是已收到的部分回答。" : reason ? `${reason}，以上是已收到的部分回答。` : "连接中断，以上是已收到的部分回答。" });
      } else {
        update({ a: control.signal.aborted ? "已停止。" : reason || "这次没查到，稍后再试。", pending: false, incomplete: true });
      }
    } finally {
      if (running.current === control) running.current = null;
      setUsageTick((n) => n + 1);
    }
  };
  return (
    <Sheet title="查一查" onClose={onClose}>
      <div className="stack">
        <p className="muted m-0">问这个世界里的人和事，或者这个时代的常识。支持继续追问；只是查资料，故事不会往下走，生成时也能照常查。</p>
        {asked.map((x, i) => (
          <div key={i} className="ask-item">
            <b>{x.q}</b>
            {x.a ? <CompanionMarkdown text={x.a} streaming={x.pending} /> : <p className="muted">查找中…</p>}
            {x.note && <p className="field-hint">{x.note}</p>}
            {!x.pending && x.a && <button className="ghost small" onClick={() => void navigator.clipboard?.writeText(x.a).then(() => toast("已复制"), () => toast("没能复制"))}>复制</button>}
            {bookId && !x.pending && !x.incomplete && x.a && x.a !== "没有查到。" && <button className="ghost small" disabled={saved.includes(i)} onClick={() => void game.saveAnswerAsNote(worldId, bookId, x.q, x.a, source?.through ?? null).then(() => { setSaved((s) => [...s, i]); toast("已存为原著札记，写作时会参考"); }).catch((e) => toast(e instanceof Error ? e.message : "没能保存札记"))}>{saved.includes(i) ? "已存为札记" : "存为札记"}</button>}
          </div>
        ))}
        {!pending && since && <RecentUsageLine worldId={worldId} purposes={["ask"]} since={since} refreshKey={usageTick} />}
        <SourceScopeRow worldId={worldId} binding={source} value={scope} purpose="ask" disabled={pending} onChange={setScope} />
        <div className="row between wrap">
          <button className="ghost" onClick={() => setRecipes(true)}>常用问题 ›</button>
          <button
            className="ghost"
            onClick={() => {
              running.current?.abort();
              const turns = asked
                .filter((x) => !x.pending && x.a && x.a !== "已停止。")
                .map(({ q: tq, a: ta }) => ({ q: tq, a: ta }));
              const draftQuestion = question.trim();
              captureReading?.();
              onClose();
              push({
                name: "companion",
                worldId,
                bookId,
                gear: "research",
                handoff: {
                  ...(turns.length ? { asked: turns } : {}),
                  ...(draftQuestion ? { draftQuestion } : {}),
                  sourceScope: scope,
                },
              });
            }}
          >
            <span>转到伴聊深聊</span>
            <Icon name="external" size={16} />
          </button>
        </div>
        {recipes && <MenuSheet title="常用问题" onClose={() => setRecipes(false)} items={AGENT_TASK_RECIPES.filter(recipe => ["recap", "characters", "canon", "continuity", "clock-ledger"].includes(recipe.id)).map(recipe => ({ label: recipe.name, onSelect: () => setQuestion(taskRecipeText(recipe, recipe.scope, question)) }))} />}
        <div className="row">
          <input className="grow" aria-label="想问什么" value={question} onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229) { e.preventDefault(); void ask(); } }} placeholder={asked.length ? "继续追问，或换个问题…" : "如：王掌柜是什么来头？一斗米多少钱？"} />
          {pending ? <button onClick={() => running.current?.abort()}>停止</button>
            : <button className="primary" disabled={!question.trim()} onClick={() => void ask()}>问</button>}
        </div>
      </div>
    </Sheet>
  );
}
