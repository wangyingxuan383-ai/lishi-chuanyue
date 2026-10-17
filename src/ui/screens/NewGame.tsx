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
import { useLongPress } from "../components/useLongPress";
import { loadPlayDefaults, type PlayDefaults } from "../app/playDefaults";
import { ARRIVALS, EMPTY, ORIGINS, fromTemplate, parseShare, shareText, toNewWorld, type Draft } from "./openingDraft";
import { Icon } from "../components/Icon";

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
/** The saved draft keeps the one-line idea too (AUDIT_V4_FUNCTION D6). */
type SavedDraft = Draft & { idea?: string };
const NAME_MAX = 12;
const ageProblem = (age: string) => (age && (Number(age) < 1 || Number(age) > 120) ? "年龄要在 1～120 岁之间" : null);

/** One of 我的开局: tap to use it, long press or ⋯ to rename or delete it (AUDIT_V4_FUNCTION D5). */
function MyTemplateCard({ t, onUse, onMenu }: { t: UserTemplate; onUse: () => void; onMenu: () => void }) {
  const press = useLongPress(onMenu, onUse);
  return (
    <div className="my-template">
      <button className="template-card" {...press} aria-label={`我的开局：${t.name}`}>
        <b>{t.name}</b><small>我的开局</small>{t.draft.premise && <span className="hook">{t.draft.premise}</span>}
      </button>
      <button className="icon-btn my-template-menu" aria-label={`“${t.name}”的更多操作`} onClick={onMenu}>⋯</button>
    </div>
  );
}

export default function NewGame() {
  const { game, replace, pop, toast, ask, askName } = useApp();
  const [draft, setDraftState] = useState<Draft>(EMPTY);
  const [loaded, setLoaded] = useState(false);
  const [mine, setMine] = useState<UserTemplate[]>([]);
  const [idea, setIdeaState] = useState("");
  const ideaRef = useRef("");
  const draftRef = useRef<Draft>(EMPTY);
  const [templateMenu, setTemplateMenu] = useState<UserTemplate | null>(null);
  const [allTemplates, setAllTemplates] = useState(false);
  const [group, setGroup] = useState("全部");
  const [sheet, setSheet] = useState<"menu" | "import" | null>(null);
  const [pasted, setPasted] = useState("");
  const [assisting, setAssisting] = useState(false);
  const [phase, setPhase] = useState<"form" | "loading" | "thinking" | "writing" | "organizing">("form");
  /** "pick": choose a way in (随便穿, an inspiration, a line of your own); "setup": the fields. */
  const [step, setStep] = useState<"pick" | "setup">("pick");
  /** Folded parts of the setup; a part opens when tapped or when something is missing there. */
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const toggle = (k: string) => setOpen((o) => ({ ...o, [k]: !o[k] }));
  const nameBox = useRef<HTMLInputElement>(null);
  const ageBox = useRef<HTMLInputElement>(null);
  const identityBox = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const tip = useMemo(() => pickRandom(TIPS), []);
  /** 设置 → 游玩默认: what a fresh draft (and 清空重填) starts from. */
  const [defaults, setDefaults] = useState<PlayDefaults | null>(null);
  const fresh = (d: PlayDefaults | null = defaults): Draft => d
    ? { ...EMPTY, settings: { ...EMPTY.settings, perspective: d.perspective, style: d.style, length: d.length, choiceCount: d.choiceCount, intensity: d.intensity, rules: d.rules } }
    : EMPTY;

  // The draft survives leaving the screen.
  useEffect(() => {
    void (async () => {
      const stored = await game.repo.getSetting<SavedDraft | null>("newgameDraft", null);
      const { idea: savedIdea, ...saved } = stored ?? ({} as SavedDraft);
      if (savedIdea) { ideaRef.current = savedIdea; setIdeaState(savedIdea); }
      const d = await loadPlayDefaults(game.repo);
      setDefaults(d);
      const base = fresh(d);
      const restored = stored ? { ...base, ...saved, settings: { ...base.settings, ...saved.settings } } : base;
      draftRef.current = restored;
      setDraftState(restored);
      if (stored && (saved.name || saved.premise || saved.identity)) setStep("setup");
      const rows = await game.platform.sql.query("SELECT id, name, json FROM templates WHERE kind = 'opening' ORDER BY created_at DESC");
      setMine(rows.map((r) => ({ id: r.id as string, name: r.name as string, draft: JSON.parse(r.json as string) })));
      setLoaded(true);
    })();
  }, []);
  const persist = () => {
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => void game.repo.setSetting("newgameDraft", { ...draftRef.current, idea: ideaRef.current } satisfies SavedDraft), 500);
  };
  const setDraft = (next: Draft | ((d: Draft) => Draft)) => {
    setDraftState((current) => {
      const value = typeof next === "function" ? next(current) : next;
      draftRef.current = value;
      persist();
      return value;
    });
  };
  const setIdea = (value: string) => {
    ideaRef.current = value;
    setIdeaState(value);
    persist();
  };
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((d) => {
    const next = { ...d, [key]: value };
    // A Tang template's calendar must not survive a premise rewritten to Song (AUDIT_V4_FUNCTION D2).
    if (key === "premise" && d.eraId) {
      const pack = ERAS.find((e) => e.id === d.eraId);
      const words = pack ? [pack.title.split(" · ")[0], ...pack.title.split(/[ ·]+/)].filter((w) => w.length >= 1) : [];
      if (pack && String(value).trim().length >= 6 && !words.some((w) => String(value).includes(w))) { next.eraId = null; next.organize = true; }
    }
    return next;
  });
  const setS = <K extends keyof Draft["settings"]>(key: K, value: Draft["settings"][K]) => setDraft((d) => ({ ...d, settings: { ...d.settings, [key]: value } }));

  useBack(() => phase !== "form", phase !== "form");

  const useTemplate = (t: OpeningTemplate) => {
    setDraft((d) => fromTemplate(t, d));
    setError(null);
    setStep("setup");
    window.scrollTo?.(0, 0);
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
    setStep("setup");
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
    toast("已补全空着的部分，都可以改");
  };

  const start = async (d: Draft) => {
    if (!game.llm) { toast("先连接 AI 服务"); return; }
    setError(null);
    setText(d.openingMode === "player" ? d.openingText : "");
    setPhase(d.openingMode === "player" ? "organizing" : "loading");
    const input = toNewWorld(d, defaults ? { difficulty: defaults.difficulty, autoUpkeep: defaults.autoUpkeep, chapterEvery: defaults.chapterEvery, fortune: defaults.fortune, tabooHints: defaults.tabooHints } : undefined);
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
  const renameTemplate = async (t: UserTemplate) => {
    const name = await askName({ title: "给这个开局改名", initial: t.name, placeholder: "开局的名字" });
    if (!name || name === t.name) return;
    await game.platform.sql.query("UPDATE templates SET name = ? WHERE id = ?", [name, t.id]);
    setMine((m) => m.map((x) => (x.id === t.id ? { ...x, name } : x)));
    toast("已改名");
  };
  const deleteTemplate = async (t: UserTemplate) => {
    if (!await ask({ title: `删除“${t.name}”？`, message: "只删掉这份存下的开局设定，已经开始的故事不受影响。", confirm: "删除", danger: true })) return;
    await game.platform.sql.query("DELETE FROM templates WHERE id = ?", [t.id]);
    setMine((m) => m.filter((x) => x.id !== t.id));
    toast(`已删除“${t.name}”`, { label: "撤销", run: () => {
      void game.platform.sql.query("INSERT INTO templates (id, kind, name, json, created_at) VALUES (?, 'opening', ?, ?, ?)", [t.id, t.name, JSON.stringify(t.draft), new Date().toISOString()]);
      setMine((m) => [t, ...m]);
    } });
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

  const menuSheets = (<>
      {sheet === "menu" && (
        <MenuSheet
          onClose={() => setSheet(null)}
          items={[
            { label: "复制开局设定（发给朋友）", onSelect: () => void share() },
            { label: "保存为文件", onSelect: () => void exportFile() },
            { label: "导入开局设定", onSelect: () => { setPasted(""); setSheet("import"); } },
            { label: "从文件导入", onSelect: async () => { importFrom(await game.platform.files.importText().catch(() => null)); } },
            { label: "清空重填", danger: true, onSelect: () => {
              const before = draft;
              const beforeIdea = idea;
              setDraft({ ...fresh(), settings: draft.settings });
              setIdea("");
              toast("已清空", { label: "撤销", run: () => { setDraft(before); setIdea(beforeIdea); } });
            } },
          ]}
        />
      )}
      {templateMenu && (
        <MenuSheet
          title={templateMenu.name}
          onClose={() => setTemplateMenu(null)}
          items={[
            { label: "用这个开局", onSelect: () => { setDraft({ ...fresh(), ...templateMenu.draft }); setStep("setup"); } },
            { label: "改名", onSelect: () => void renameTemplate(templateMenu) },
            { label: "删除", danger: true, onSelect: () => void deleteTemplate(templateMenu) },
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
  </>);

  const nameLength = [...draft.name.trim()].length;
  const missing = !draft.name.trim() || nameLength > NAME_MAX ? "名字" : ageProblem(draft.age) ? "年龄" : !draft.identity.trim() ? "身份" : draft.openingMode === "player" && !draft.openingText.trim() ? "开场" : null;
  const startOrPoint = () => {
    if (!missing) { void start(draft); return; }
    // A grey button that does nothing is a dead end: take the player to what is missing (AUDIT_V4 3.7).
    if (missing === "名字") nameBox.current?.focus();
    else if (missing === "年龄") ageBox.current?.focus();
    else if (missing === "身份") identityBox.current?.focus();
    else setOpen((o) => ({ ...o, opening: true }));
    toast(missing === "名字" && nameLength > NAME_MAX ? `名字最多 ${NAME_MAX} 个字` : missing === "年龄" ? ageProblem(draft.age)! : `还差${missing}`);
  };

  if (step === "pick") {
    return (
      <div className="screen">
        <div className="topbar">
          <button className="icon-btn" aria-label="返回" onClick={pop}><Icon name="back" /></button>
          <div className="title"><h1>新的故事</h1></div>
          <button className="icon-btn" aria-label="开局菜单" onClick={() => setSheet("menu")}><Icon name="more" /></button>
        </div>
        <div className="screen-body stack">
          {error && <div className="notice">{error}</div>}
          <button className="random-card" onClick={randomStart}>
            <span className="seal small" aria-hidden="true"><span>随</span><span>缘</span></span>
            <span><b>随便穿</b><small>让命运替你选一个时代和身份，马上开始</small></span>
          </button>

          <section className="stack" style={{ gap: 8 }}>
            <h2 className="section-title">一句话，AI 帮你补全</h2>
            <textarea rows={2} value={idea} onChange={(e) => setIdea(e.target.value)} aria-label="一句话想法" placeholder="比如：靖康之变前一年，我是汴京的一个小吏，想办法救下更多的人" />
            <button className={idea.trim() ? "primary" : ""} onClick={assist} disabled={assisting || !idea.trim()}>{assisting ? "构思中…" : "补全设定"}</button>
          </section>

          <section className="stack" style={{ gap: 8 }}>
            <h2 className="section-title">从灵感开始</h2>
            <div className="segmented" role="group" aria-label="灵感分类">
              {["全部", ...GROUPS, "其他", ...(mine.length ? ["我的"] : [])].map((g) => <button key={g} aria-pressed={group === g} onClick={() => setGroup(g)}>{g}</button>)}
            </div>
            <div className="template-row">
              {(group === "全部" || group === "我的") && mine.map((m) => (
                <MyTemplateCard key={m.id} t={m} onUse={() => { setDraft({ ...fresh(), ...m.draft }); setStep("setup"); }} onMenu={() => setTemplateMenu(m)} />
              ))}
              {shownTemplates.map((t) => (
                <button key={t.id} className={`template-card${draft.templateId === t.id ? " selected" : ""}`} onClick={() => useTemplate(t)}>
                  <b>{t.title}</b><small>{t.era}</small><span className="hook">{t.openingHint}</span>
                </button>
              ))}
            </div>
            {group === "全部" && !allTemplates && <button className="ghost" onClick={() => setAllTemplates(true)}>查看全部 {TEMPLATES.length} 个灵感</button>}
          </section>

          <button className="ghost" onClick={() => { setDraft(fresh()); setStep("setup"); }}>什么都不选，自己从头写 ›</button>
        </div>
        {menuSheets}
      </div>
    );
  }

  return (
    <div className="screen">
      <div className="topbar">
        <button className="icon-btn" aria-label="返回" onClick={() => setStep("pick")}><Icon name="back" /></button>
        <div className="title"><h1>{draft.title || "开局设定"}</h1></div>
        <button className="icon-btn" aria-label="开局菜单" onClick={() => setSheet("menu")}><Icon name="more" /></button>
      </div>
      <div className="screen-body stack">
        {error && <div className="notice">{error}</div>}
        <p className="muted" style={{ margin: 0 }}>都可以改。名字和身份填好就能开始，其余有默认。</p>

        <label className="field">故事设定
          <textarea rows={5} value={draft.premise} onChange={(e) => set("premise", e.target.value)} placeholder="时代、地点、时局，你想讲的故事。比如：北宋宣和年间，汴京。花石纲扰民，金国崛起……" />
        </label>

        <section className="stack" style={{ gap: 8 }}>
          <span className="field-label">主角</span>
          <div className="row">
            <span className="field-line grow">
              <input ref={nameBox} className={missing === "名字" ? "wanted" : ""} value={draft.name} onChange={(e) => set("name", e.target.value)} placeholder="名字" aria-label="名字" />
              <span className={`field-suffix${nameLength > NAME_MAX ? " over" : ""}`}>{nameLength}/{NAME_MAX}</span>
            </span>
            <input ref={ageBox} style={{ width: 84 }} className={ageProblem(draft.age) ? "wanted" : ""} value={draft.age} onChange={(e) => set("age", e.target.value.replace(/\D/g, "").slice(0, 3))} placeholder="年龄" inputMode="numeric" aria-label="年龄" />
          </div>
          {(nameLength > NAME_MAX || ageProblem(draft.age)) && <p className="field-hint warn" style={{ margin: 0 }}>{nameLength > NAME_MAX ? `名字最多 ${NAME_MAX} 个字，现在 ${nameLength} 个` : ageProblem(draft.age)}</p>}
          {draft.lockedGender ? (
            <button className="picker" onClick={() => set("lockedGender", null)} aria-label={`性别：${draft.lockedGender}（由身份决定），点一下可以改`}>
              <span><b>{draft.lockedGender}</b><small>由身份决定，点一下可以改</small></span><span aria-hidden="true">›</span>
            </button>
          ) : (
            <div className="segmented">
              {(["男", "女"] as const).map((g) => <button key={g} aria-pressed={draft.gender === g} onClick={() => set("gender", g)}>{g}</button>)}
            </div>
          )}
          <textarea ref={identityBox} className={missing === "身份" && draft.name.trim() ? "wanted" : ""} rows={4} value={draft.identity} onChange={(e) => set("identity", e.target.value)} aria-label="身份与处境" placeholder="身份与处境：你是谁、身处什么境地、眼下有什么麻烦" />
        </section>

        <Fold open={open} onToggle={toggle} id="arrival" title="穿越" summary={draft.arrival === "不穿越" ? "不穿越，本来就是这个时代的人" : `${draft.arrival} · 穿越前是${draft.origin || "……"}`}>
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
        </Fold>

        <Fold open={open} onToggle={toggle} id="opening" title="开场" summary={draft.openingMode === "player" ? (draft.openingText.trim() ? "我自己写的开场" : "我自己写（还没写）") : draft.hint.trim() ? `AI 来写：${draft.hint.trim().slice(0, 18)}` : "AI 来写"}>
          <div className="segmented">
            <button aria-pressed={draft.openingMode === "ai"} onClick={() => set("openingMode", "ai")}>AI 来写</button>
            <button aria-pressed={draft.openingMode === "player"} onClick={() => set("openingMode", "player")}>我自己写</button>
          </div>
          {draft.openingMode === "ai" ? (
            <input value={draft.hint} onChange={(e) => set("hint", e.target.value)} placeholder="第一幕想看到什么（可不填）" aria-label="开场提示" />
          ) : (
            <textarea rows={8} value={draft.openingText} onChange={(e) => set("openingText", e.target.value)} placeholder="写下故事的第一段，AI 会从这里接着写。" aria-label="开场正文" />
          )}
        </Fold>

        <Fold open={open} onToggle={toggle} id="writing" title="写法" summary={`${draft.settings.style} · 每段${draft.settings.length} · ${draft.settings.perspective === "你" ? "第二人称" : draft.settings.perspective === "我" ? "第一人称" : "小说式"} · 建议选项 ${draft.settings.choiceCount || "不要"}`}>
          <span className="muted">叙述视角</span>
          <div className="segmented">
            {([["你", "你（第二人称）"], ["我", "我（第一人称）"], ["他", "他 / 她（小说式）"]] as [Perspective, string][]).map(([v, l]) => <button key={v} aria-pressed={draft.settings.perspective === v} onClick={() => setS("perspective", v)}>{l}</button>)}
          </div>
          <span className="muted">文风</span>
          <div className="segmented">
            {(["白话", "半文半白"] as const).map((v) => <button key={v} aria-pressed={draft.settings.style === v} onClick={() => setS("style", v)}>{v}</button>)}
          </div>
          <span className="muted">每段长短</span>
          <div className="segmented">
            {(["短", "中", "长"] as const).map((v) => <button key={v} aria-pressed={draft.settings.length === v} onClick={() => setS("length", v)}>{v}</button>)}
          </div>
          <span className="muted">建议选项</span>
          <div className="segmented">
            {[0, 2, 3, 4].map((n) => <button key={n} aria-pressed={draft.settings.choiceCount === n} onClick={() => setS("choiceCount", n)}>{n === 0 ? "不要" : `${n} 个`}</button>)}
          </div>
          {intensity("violence", "暴力与伤亡")}
          {intensity("romance", "感情与亲密")}
          {intensity("darkness", "黑暗与压抑")}
          <p className="muted" style={{ margin: 0 }}>默认值在 设置 → 写作与叙事 / 游玩默认 里改。</p>
        </Fold>

        <Fold open={open} onToggle={toggle} id="more" title="更多" summary={`${draft.title ? `故事名“${draft.title}” · ` : ""}${draft.eraId ? "内置时代资料" : draft.organize ? "AI 整理时代资料" : "不准备时代资料"}${draft.settings.essentials.trim() ? " · 有要点" : ""}`}>
          <label className="field">故事名<input value={draft.title} onChange={(e) => set("title", e.target.value)} placeholder="不填则用主角名字" /></label>
          <span className="muted">时代资料（放进设定集，开局后在“我 → 设定”里改）</span>
          <div className="segmented" role="group" aria-label="时代设定">
            <button aria-pressed={!draft.eraId && draft.organize} onClick={() => setDraft((d) => ({ ...d, eraId: null, organize: true }))}>AI 按故事设定整理</button>
            {ERAS.map((e) => <button key={e.id} aria-pressed={draft.eraId === e.id} onClick={() => set("eraId", e.id)}>{e.title.split(" · ")[0]}（内置）</button>)}
            <button aria-pressed={!draft.eraId && !draft.organize} onClick={() => setDraft((d) => ({ ...d, eraId: null, organize: false }))}>不要</button>
          </div>
          <label className="field">要点（AI 必须一直记住的事，每行一条）
            <textarea rows={3} value={draft.settings.essentials} onChange={(e) => setS("essentials", e.target.value)} placeholder="比如：主角知道三年后会有大乱" />
          </label>
          <label className="field">给 AI 的额外规则
            <textarea rows={3} value={draft.settings.rules} onChange={(e) => setS("rules", e.target.value)} placeholder="比如：多写人物对话；不要让主角轻易获得权力" />
          </label>
        </Fold>

        <div className="row sticky-bar">
          <button onClick={saveTemplate}>存为我的开局</button>
          <button className={`primary grow${missing ? " soft" : ""}`} onClick={startOrPoint}>{missing ? `还差${missing}` : "开始"}</button>
        </div>
      </div>
      {menuSheets}
    </div>
  );
}

/** A part of the setup folded to a one-line summary, so the whole reads in one screen (AUDIT_V4 3.1). */
function Fold({ id, title, summary, open, onToggle, children }: {
  id: string; title: string; summary: string; open: Record<string, boolean>; onToggle: (id: string) => void; children: React.ReactNode;
}) {
  return (
    <section className={`fold${open[id] ? " open" : ""}`}>
      <button className="fold-head" aria-expanded={!!open[id]} onClick={() => onToggle(id)}>
        <span><b>{title}</b>{!open[id] && <small>{summary}</small>}</span><span aria-hidden="true">{open[id] ? "收起" : "改"}</span>
      </button>
      {open[id] && <div className="stack fold-body">{children}</div>}
    </section>
  );
}
