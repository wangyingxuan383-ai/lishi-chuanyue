// Starting a story like an author (D117): write your own premise and
// protagonist, let the AI or yourself write the first scene. Templates are
// inspiration that fill the fields; everything stays editable.
import { useEffect, useMemo, useRef, useState } from "react";
import { TEMPLATES, pickRandom, type Arrival, type OpeningTemplate } from "../../content/templates";
import { ERAS } from "../../content/eras";
import type { TurnEvent } from "../../engine/game";
import { explainFailure } from "../../engine/llm/providers";
import type { Intensity, Perspective, WorldSettings } from "../../engine/types";
import { newId } from "../../engine/db/repo";
import { useApp, useBack } from "../app/context";
import { MenuSheet, Sheet } from "../components/Sheet";
import { StoryText } from "../components/StoryText";
import { ARRIVALS, EMPTY, ORIGINS, fromTemplate, parseShare, shareText, toNewWorld, type Draft } from "./openingDraft";

/** "唐 · 天宝七载" → "唐" */
const dynastyOf = (t: OpeningTemplate) => t.era.split(" · ")[0];
/** Filter chips: dynasties with at least three templates, the rest under 其他. */
const GROUPS = (() => {
  const counts = new Map<string, number>();
  for (const t of TEMPLATES) counts.set(dynastyOf(t), (counts.get(dynastyOf(t)) ?? 0) + 1);
  return [...counts].filter(([, n]) => n >= 3).map(([d]) => d);
})();

const TIPS = [
  "故事设定会一直交给 AI，相当于你写给它的开局提示词。",
  "游戏中可以用“写”模式亲手写一段剧情，AI 会顺着往下写。",
  "长按任意一段可以改写，或回到那里另走一条路。",
  "本局设置里随时可以改故事设定、要点和给 AI 的规则。",
];

interface UserTemplate { id: string; name: string; draft: Draft }

export default function NewGame() {
  const { game, replace, pop, toast, askName } = useApp();
  const [draft, setDraftState] = useState<Draft>(EMPTY);
  const [loaded, setLoaded] = useState(false);
  const [mine, setMine] = useState<UserTemplate[]>([]);
  const [idea, setIdea] = useState("");
  const [allTemplates, setAllTemplates] = useState(false);
  const [group, setGroup] = useState("全部");
  const [sheet, setSheet] = useState<"menu" | "import" | null>(null);
  const [pasted, setPasted] = useState("");
  const [assisting, setAssisting] = useState(false);
  const [phase, setPhase] = useState<"form" | "loading" | "thinking" | "writing" | "organizing">("form");
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const tip = useMemo(() => pickRandom(TIPS), []);

  // The draft survives leaving the screen.
  useEffect(() => {
    void (async () => {
      const saved = await game.repo.getSetting<Draft | null>("newgameDraft", null);
      if (saved) setDraftState({ ...EMPTY, ...saved, settings: { ...EMPTY.settings, ...saved.settings } });
      const rows = await game.platform.sql.query("SELECT id, name, json FROM templates WHERE kind = 'opening' ORDER BY created_at DESC");
      setMine(rows.map((r) => ({ id: r.id as string, name: r.name as string, draft: JSON.parse(r.json as string) })));
      setLoaded(true);
    })();
  }, []);
  const setDraft = (next: Draft | ((d: Draft) => Draft)) => {
    setDraftState((current) => {
      const value = typeof next === "function" ? next(current) : next;
      clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => void game.repo.setSetting("newgameDraft", value), 500);
      return value;
    });
  };
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((d) => ({ ...d, [key]: value }));
  const setS = <K extends keyof Draft["settings"]>(key: K, value: Draft["settings"][K]) => setDraft((d) => ({ ...d, settings: { ...d.settings, [key]: value } }));

  useBack(() => phase !== "form", phase !== "form");

  const useTemplate = (t: OpeningTemplate) => {
    setDraft((d) => fromTemplate(t, d));
    setError(null);
    toast(`已填入「${t.title}」，可以随意修改`);
  };

  const assist = async () => {
    if (!game.llm) { toast("先连接 AI 服务"); return; }
    setAssisting(true);
    const current = {
      title: draft.title, premise: draft.premise, name: draft.name, gender: draft.lockedGender ?? (draft.name ? draft.gender : ""),
      age: draft.age ? Number(draft.age) : null, identity: draft.identity, arrival: draft.arrival, origin: draft.origin,
      hint: draft.hint, essentials: draft.settings.essentials,
    };
    const result = await game.assist(idea, current);
    setAssisting(false);
    if (!result) { toast("没能生成，再试一次？"); return; }
    const fill = (mineValue: string, theirs: unknown) => (mineValue.trim() ? mineValue : typeof theirs === "string" ? theirs : mineValue);
    setDraft((d) => {
      const gender = d.lockedGender ?? (result.gender === "女" ? "女" : result.gender === "男" ? "男" : d.gender);
      return {
        ...d,
        title: fill(d.title, result.title),
        premise: fill(d.premise, result.premise),
        name: fill(d.name, result.name),
        gender,
        lockedGender: d.lockedGender ?? (result.gender === "女" || result.gender === "男" ? gender : null),
        age: d.age || (result.age ? String(result.age) : ""),
        identity: fill(d.identity, result.identity),
        arrival: ARRIVALS.includes(result.arrival as Arrival) && !d.templateId ? (result.arrival as Arrival) : d.arrival,
        origin: fill(d.origin, result.origin),
        hint: fill(d.hint, result.hint),
        settings: { ...d.settings, essentials: fill(d.settings.essentials, result.essentials) },
      };
    });
    toast("已补全空着的部分");
  };

  const start = async (d: Draft) => {
    if (!game.llm) { toast("先连接 AI 服务"); return; }
    setError(null);
    setText(d.openingMode === "player" ? d.openingText : "");
    setPhase(d.openingMode === "player" ? "organizing" : "loading");
    const input = toNewWorld(d);
    const onEvent = (e: TurnEvent) => {
      if (e.type === "thinking") setPhase("thinking");
      else if (e.type === "text") { setPhase("writing"); setText(e.full); }
      else if (e.type === "organizing") setPhase("organizing");
      else if (e.type === "failed") { setPhase("form"); setError(explainFailure(e.reason, e.status)); }
    };
    const worldId = await game.createWorld(input, onEvent);
    if (worldId) {
      await game.repo.setSetting("newgameDraft", null);
      replace({ name: "play", worldId });
    }
  };

  const randomStart = () => {
    const t = pickRandom(TEMPLATES);
    const d = fromTemplate(t, { ...EMPTY, settings: draft.settings }, pickRandom(["男", "女"] as const));
    d.origin = pickRandom(ORIGINS);
    void start(d);
  };

  const saveTemplate = async () => {
    const name = await askName({ title: "存为我的开局", initial: draft.title || "我的开局", placeholder: "给这个开局起个名字" });
    if (!name) return;
    const id = newId();
    await game.platform.sql.query("INSERT INTO templates (id, kind, name, json, created_at) VALUES (?, 'opening', ?, ?, ?)", [id, name.trim(), JSON.stringify(draft), new Date().toISOString()]);
    setMine((m) => [{ id, name: name.trim(), draft }, ...m]);
    toast("已保存到“我的开局”");
  };

  const share = async () => {
    await navigator.clipboard?.writeText(shareText(draft));
    toast("已复制开局设定，可以发给朋友");
  };
  const exportFile = async () => {
    if (await game.platform.files.exportText(`开局-${draft.title || "未命名"}.txt`, shareText(draft)).catch(() => false)) toast("已保存");
  };
  const importFrom = (text: string | null) => {
    const next = text ? parseShare(text) : null;
    if (!next) { toast("没有找到开局设定，请粘贴完整的分享文字"); return false; }
    setDraft(next);
    setError(null);
    toast(`已导入「${next.title || "开局设定"}」`);
    return true;
  };

  const ready = draft.identity.trim() && draft.name.trim() && (draft.openingMode === "ai" || draft.openingText.trim());

  if (phase !== "form") {
    return (
      <div className="screen">
        <div className="topbar"><div className="title"><h1>{draft.title || "新的故事"}</h1></div></div>
        <div className="screen-body">
          {!text ? (
            <div className="hero"><p style={{ fontSize: 20, letterSpacing: 4 }}>{phase === "organizing" ? "整理中…" : "落笔中…"}</p><p className="muted">{tip}</p></div>
          ) : <StoryText text={text} streaming={phase === "writing"} />}
          {text && phase === "organizing" && <p className="status-line">整理人物与设定…</p>}
        </div>
      </div>
    );
  }
  if (!loaded) return null;

  const shownTemplates = group === "全部" ? (allTemplates ? TEMPLATES : TEMPLATES.slice(0, 6))
    : group === "我的" ? []
    : group === "其他" ? TEMPLATES.filter((t) => !GROUPS.includes(dynastyOf(t)))
    : TEMPLATES.filter((t) => dynastyOf(t) === group);

  const intensity = (key: keyof WorldSettings["intensity"], label: string) => (
    <div className="row" style={{ flexWrap: "wrap" }}>
      <span className="muted" style={{ minWidth: 84 }}>{label}</span>
      <div className="segmented">
        {(["含蓄", "写实", "浓烈"] as Intensity[]).map((l) => <button key={l} aria-pressed={draft.settings.intensity[key] === l} onClick={() => setS("intensity", { ...draft.settings.intensity, [key]: l })}>{l}</button>)}
      </div>
    </div>
  );

  return (
    <div className="screen">
      <div className="topbar">
        <button className="icon-btn" aria-label="返回" onClick={pop}>‹</button>
        <div className="title"><h1>新的故事</h1></div>
        <button className="ghost" onClick={randomStart}>随便穿</button>
        <button className="icon-btn" aria-label="开局菜单" onClick={() => setSheet("menu")}>⋯</button>
      </div>
      <div className="screen-body stack">
        {error && <div className="notice">{error}</div>}

        <section className="stack" style={{ gap: 8 }}>
          <span className="muted">灵感（点一下填入，之后都能改）</span>
          <div className="segmented" role="group" aria-label="灵感分类">
            {["全部", ...GROUPS, "其他", ...(mine.length ? ["我的"] : [])].map((g) => <button key={g} aria-pressed={group === g} onClick={() => setGroup(g)}>{g}</button>)}
          </div>
          <div className="template-row">
            {(group === "全部" || group === "我的") && mine.map((m) => (
              <button key={m.id} className="template-card" onClick={() => { setDraft({ ...EMPTY, ...m.draft }); toast(`已填入「${m.name}」`); }}>
                <b>{m.name}</b><small>我的开局</small>
              </button>
            ))}
            {shownTemplates.map((t) => (
              <button key={t.id} className={`template-card${draft.templateId === t.id ? " selected" : ""}`} onClick={() => useTemplate(t)}>
                <b>{t.title}</b><small>{t.era}</small>
              </button>
            ))}
          </div>
          {group === "全部" && !allTemplates && <button className="ghost" onClick={() => setAllTemplates(true)}>查看全部 {TEMPLATES.length} 个灵感</button>}
        </section>

        <section className="stack" style={{ gap: 8 }}>
          <label>一句话想法（可选，交给 AI 补全空着的部分）
            <textarea rows={2} value={idea} onChange={(e) => setIdea(e.target.value)} placeholder="比如：靖康之变前一年，我是汴京的一个小吏，想办法救下更多的人" />
          </label>
          <button onClick={assist} disabled={assisting}>{assisting ? "构思中…" : "AI 帮我补全"}</button>
        </section>

        <label>故事设定（时代、地点、时局、你想讲的故事。会一直交给 AI）
          <textarea rows={6} value={draft.premise} onChange={(e) => set("premise", e.target.value)} placeholder="比如：北宋宣和年间，汴京。花石纲扰民，金国崛起……" />
        </label>

        <div className="stack" style={{ gap: 8 }}>
          <span className="muted">主角</span>
          <div className="row">
            <input className="grow" value={draft.name} onChange={(e) => set("name", e.target.value)} placeholder="名字" aria-label="名字" />
            <input style={{ width: 84 }} value={draft.age} onChange={(e) => set("age", e.target.value.replace(/\D/g, ""))} placeholder="年龄" inputMode="numeric" aria-label="年龄" />
          </div>
          {draft.lockedGender ? (
            <p className="muted" style={{ margin: 0 }}>性别：{draft.lockedGender}（由身份决定）<button className="ghost" style={{ minHeight: 32, padding: "2px 8px" }} onClick={() => set("lockedGender", null)}>改</button></p>
          ) : (
            <div className="segmented">
              {(["男", "女"] as const).map((g) => <button key={g} aria-pressed={draft.gender === g} onClick={() => set("gender", g)}>{g}</button>)}
            </div>
          )}
          <label>身份与处境
            <textarea rows={4} value={draft.identity} onChange={(e) => set("identity", e.target.value)} placeholder="你是谁、身处什么境地、眼下有什么麻烦" />
          </label>
        </div>

        <div className="stack" style={{ gap: 8 }}>
          <span className="muted">穿越</span>
          <div className="segmented">
            {ARRIVALS.map((a) => <button key={a} aria-pressed={draft.arrival === a} onClick={() => set("arrival", a)}>{a}</button>)}
          </div>
          {draft.arrival !== "不穿越" && (
            <>
              <input value={draft.origin} onChange={(e) => set("origin", e.target.value)} placeholder="穿越前，你是…" aria-label="穿越前的身份" />
              <div className="segmented">
                {ORIGINS.map((o) => <button key={o} aria-pressed={draft.origin === o} onClick={() => set("origin", o)}>{o}</button>)}
              </div>
            </>
          )}
        </div>

        <div className="stack" style={{ gap: 8 }}>
          <span className="muted">开场</span>
          <div className="segmented">
            <button aria-pressed={draft.openingMode === "ai"} onClick={() => set("openingMode", "ai")}>AI 来写</button>
            <button aria-pressed={draft.openingMode === "player"} onClick={() => set("openingMode", "player")}>我自己写</button>
          </div>
          {draft.openingMode === "ai" ? (
            <input value={draft.hint} onChange={(e) => set("hint", e.target.value)} placeholder="第一幕想看到什么（可不填）" aria-label="开场提示" />
          ) : (
            <textarea rows={8} value={draft.openingText} onChange={(e) => set("openingText", e.target.value)} placeholder="写下故事的第一段，AI 会从这里接着写。" aria-label="开场正文" />
          )}
        </div>

        <details>
          <summary className="muted">更多设置</summary>
          <div className="stack" style={{ marginTop: 12 }}>
            <label>故事名<input value={draft.title} onChange={(e) => set("title", e.target.value)} placeholder="不填则用主角名字" /></label>
            <span className="muted">时代设定（放进设定集，开局后可在“我 → 设定”里修改）</span>
            <div className="segmented" role="group" aria-label="时代设定">
              <button aria-pressed={!draft.eraId && draft.organize} onClick={() => setDraft((d) => ({ ...d, eraId: null, organize: true }))}>AI 按故事设定整理</button>
              {ERAS.map((e) => <button key={e.id} aria-pressed={draft.eraId === e.id} onClick={() => set("eraId", e.id)}>{e.title}</button>)}
              <button aria-pressed={!draft.eraId && !draft.organize} onClick={() => setDraft((d) => ({ ...d, eraId: null, organize: false }))}>不要</button>
            </div>
            <p className="muted" style={{ margin: 0 }}>{draft.eraId ? "使用整理好的内置资料：时代卡、主要地点、年号与货币。"
              : draft.organize ? "开场时 AI 按你的故事设定整理一张时代卡和几张关键卡片，只补你没写的部分。"
              : "不准备时代卡，AI 只按故事设定来写。"}</p>
            <span className="muted">叙述视角</span>
            <div className="segmented">
              {([["你", "你（第二人称）"], ["我", "我（第一人称）"], ["他", "他 / 她（小说式）"]] as [Perspective, string][]).map(([v, l]) => <button key={v} aria-pressed={draft.settings.perspective === v} onClick={() => setS("perspective", v)}>{l}</button>)}
            </div>
            <span className="muted">文风与篇幅</span>
            <div className="segmented">
              {(["白话", "半文半白"] as const).map((v) => <button key={v} aria-pressed={draft.settings.style === v} onClick={() => setS("style", v)}>{v}</button>)}
              {(["短", "中", "长"] as const).map((v) => <button key={v} aria-pressed={draft.settings.length === v} onClick={() => setS("length", v)}>{v}篇幅</button>)}
            </div>
            <span className="muted">建议选项</span>
            <div className="segmented">
              {[0, 2, 3, 4].map((n) => <button key={n} aria-pressed={draft.settings.choiceCount === n} onClick={() => setS("choiceCount", n)}>{n === 0 ? "不要" : `${n} 个`}</button>)}
            </div>
            {intensity("violence", "暴力与伤亡")}
            {intensity("romance", "感情与亲密")}
            {intensity("darkness", "黑暗与压抑")}
            <label>要点（AI 必须一直记住的事，每行一条）
              <textarea rows={3} value={draft.settings.essentials} onChange={(e) => setS("essentials", e.target.value)} placeholder="比如：主角知道三年后会有大乱" />
            </label>
            <label>给 AI 的额外规则
              <textarea rows={3} value={draft.settings.rules} onChange={(e) => setS("rules", e.target.value)} placeholder="比如：多写人物对话；不要让主角轻易获得权力" />
            </label>
          </div>
        </details>

        <div className="row sticky-bar">
          <button onClick={saveTemplate}>存为我的开局</button>
          <button className="primary grow" disabled={!ready} onClick={() => void start(draft)}>开始</button>
        </div>
        {!ready && <p className="muted" style={{ margin: 0, textAlign: "center" }}>填好名字和身份就能开始{draft.openingMode === "player" ? "（还要写下开场）" : ""}。</p>}
      </div>
      {sheet === "menu" && (
        <MenuSheet
          onClose={() => setSheet(null)}
          items={[
            { label: "复制开局设定（发给朋友）", onSelect: () => void share() },
            { label: "保存为文件", onSelect: () => void exportFile() },
            { label: "导入开局设定", onSelect: () => { setPasted(""); setSheet("import"); } },
            { label: "从文件导入", onSelect: async () => { importFrom(await game.platform.files.importText().catch(() => null)); } },
            { label: "清空重填", danger: true, onSelect: () => { setDraft({ ...EMPTY, settings: draft.settings }); toast("已清空"); } },
          ]}
        />
      )}
      {sheet === "import" && (
        <Sheet title="导入开局设定" onClose={() => setSheet(null)}>
          <textarea rows={6} value={pasted} onChange={(e) => setPasted(e.target.value)} placeholder="粘贴朋友分享的整段开局设定" aria-label="分享文字" />
          <div className="row" style={{ marginTop: 10 }}>
            <button className="primary grow" disabled={!pasted.trim()} onClick={() => { if (importFrom(pasted)) setSheet(null); }}>导入</button>
          </div>
        </Sheet>
      )}
    </div>
  );
}
