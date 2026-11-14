import { useState } from "react";
import { AGENT_TASK_RECIPES, taskRecipeText } from "../../../content/agentTasks";
import { useApp } from "../../app/context";
import { MenuSheet, Sheet } from "../../components/Sheet";
import { StoryText } from "../../components/StoryText";

/** 查一查 (R07-T001): questions about this world or the era; the story does not move. */
export function AskSheet({ worldId, bookId, onClose }: { worldId: string; bookId?: string; onClose: () => void }) {
  const { game, toast } = useApp();
  const [saved, setSaved] = useState<number[]>([]);
  const [question, setQuestion] = useState("");
  const [recipes, setRecipes] = useState(false);
  const [asked, setAsked] = useState<{ q: string; a: string; pending: boolean }[]>([]);
  const pending = asked.some((x) => x.pending);
  const update = (patch: { a: string; pending: boolean }) => setAsked((list) => list.map((x, i) => (i === list.length - 1 ? { ...x, ...patch } : x)));
  const ask = async () => {
    const q = question.trim();
    if (!q || pending) return;
    setQuestion("");
    setAsked((list) => [...list, { q, a: "", pending: true }]);
    try {
      const answer = await game.ask(worldId, q, (full) => update({ a: full, pending: true }));
      update({ a: answer || "没有查到。", pending: false });
    } catch {
      update({ a: "这次没查到，稍后再试。", pending: false });
    }
  };
  return (
    <Sheet title="查一查" onClose={onClose}>
      <div className="stack">
        <p className="muted m-0">问这个世界里的人和事，或者这个时代的常识。只是查资料，故事不会往下走。</p>
        {asked.map((x, i) => (
          <div key={i} className="ask-item">
            <b>{x.q}</b>
            {x.a ? <StoryText text={x.a} /> : <p className="muted">查找中…</p>}
            {bookId && !x.pending && x.a && <button className="ghost small" disabled={saved.includes(i)} onClick={() => void game.saveAnswerAsNote(worldId, bookId, x.q, x.a).then(() => { setSaved((s) => [...s, i]); toast("已存为原著札记，写作时会参考"); })}>{saved.includes(i) ? "已存为札记" : "存为札记"}</button>}
          </div>
        ))}
        <button className="ghost" onClick={() => setRecipes(true)}>常用问题 ›</button>
        {recipes && <MenuSheet title="常用问题" onClose={() => setRecipes(false)} items={AGENT_TASK_RECIPES.filter(recipe => ["recap", "characters", "canon", "continuity", "clock-ledger"].includes(recipe.id)).map(recipe => ({ label: recipe.name, onSelect: () => setQuestion(taskRecipeText(recipe, recipe.scope, question) + `\n请按需读取技能：${recipe.skills.join("、")}。`) }))} />}
        <div className="row">
          <input className="grow" aria-label="想问什么" value={question} onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void ask(); }} placeholder="如：王掌柜是什么来头？一斗米多少钱？" />
          <button className="primary" disabled={!question.trim() || pending} onClick={() => void ask()}>问</button>
        </div>
      </div>
    </Sheet>
  );
}
