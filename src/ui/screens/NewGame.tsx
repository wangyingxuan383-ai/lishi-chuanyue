// Starting a story like an author (D117): write your own premise and
// protagonist, let the AI or yourself write the first scene. Templates are
// inspiration that fill the fields; everything stays editable.
import { useEffect, useMemo, useRef, useState } from "react";
import { TEMPLATES, pickRandom, type Arrival, type OpeningTemplate } from "../../content/templates";
import { FREE_TEMPLATES } from "../../content/freeTemplates";
import type { ChallengeCard } from "../../content/challenges";
import { ERAS } from "../../content/eras";
import type { TurnEvent } from "../../engine/game";
import { FORTUNE_MODES } from "../../engine/fortune";
import { explainFailure } from "../../engine/llm/providers";
import type { Intensity, Perspective, WorldSettings } from "../../engine/types";
import { newId } from "../../engine/db/repo";
import { useApp, useBack } from "../app/context";
import { MenuSheet, Sheet } from "../components/Sheet";
import { StoryText } from "../components/StoryText";
import { useLongPress } from "../components/useLongPress";
import { loadPlayDefaults, type PlayDefaults } from "../app/playDefaults";
import {
  ARRIVALS, EMPTY, MAX_BEATS, ORIGINS, OPENING_TEXT_LIMIT, draftFortune, filledBeats, fromChallenge, fromTemplate, parseShare, shareText, toNewWorld,
  type Draft, type PlayStyle,
} from "./openingDraft";
import { Icon } from "../components/Icon";
import { ChallengeSetup, PlayStyles, ScriptOutline } from "../components/ModeSetup";
import { SourceSetup } from "../components/Sources";
import type { SourceBinding } from "../../engine/sources/types";
import { getBook } from "../../engine/sources/library";

/** "唐 · 天宝七载" → "唐" */
const dynastyOf = (t: OpeningTemplate) => t.era.split(" · ")[0];
/** Filter chips: dynasties with at least three templates, the rest under 其他. */
const GROUPS = (() => {
  const counts = new Map<string, number>();
  for (const t of TEMPLATES) counts.set(dynastyOf(t), (counts.get(dynastyOf(t)) ?? 0) + 1);
  return [...counts].filter(([, n]) => n >= 3).map(([d]) => d);
})();

const TIPS = [
  "故事设定会一直交给 AI，它写每一段都会参考。",
  "游戏中可以用“写”模式亲手写一段剧情，AI 会顺着往下写。",
  "长按任意一段可以改写，或回到那里另走一条路。",
  "⋯ 里的“故事设定与要点”随时能改，从下一段起生效。",
  "想歇一歇，可以在本局设置里把主角交给 AI，坐看故事发展。",
];
/** “写一个作品里的世界” starts the premise with the three things worth saying. */
const WORK_PREMISE = "作品：\n故事从哪里开始：\n我想改变的：";

interface UserTemplate { id: string; name: string; draft: Draft }
/** The saved draft keeps the one-line idea too (AUDIT_V4_FUNCTION D6). */
type SavedDraft = Draft & { idea?: string };
const NAME_MAX = 12;
const ageProblem = (age: string, free = false) => age && (!Number.isSafeInteger(Number(age)) || Number(age) < 1 || Number(age) > (free ? 999999 : 120)) ? (free ? "年龄填正整数，也可以留空" : "年龄要在 1～120 岁之间") : null;

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
  const free = draft.settings.mode === "free";
  const templates = free ? FREE_TEMPLATES : TEMPLATES;
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
  const assistTicket = useRef(0);
  /** “AI 帮我拟大纲 / 出题” in flight. */
  const [drafting, setDrafting] = useState<"script" | "challenge" | null>(null);
  const draftTicket = useRef(0);
  const beatBox = useRef<HTMLTextAreaElement>(null);
  /** The part 开始 last pointed at: a mode's empty field is marked only after that, not as soon as the card is picked. */
  const [pointed, setPointed] = useState<string | null>(null);
  const goalBox = useRef<HTMLTextAreaElement>(null);
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
    // A mount that is already gone (React's development double mount) leaves the work to the next one,
    // so 再挑战一次 starts one world, not two.
    let live = true;
    void (async () => {
      const stored = await game.repo.getSetting<SavedDraft | null>("newgameDraft", null);
      if (!live) return;
      const { idea: savedIdea, ...saved } = stored ?? ({} as SavedDraft);
      if (savedIdea) { ideaRef.current = savedIdea; setIdeaState(savedIdea); }
      const d = await loadPlayDefaults(game.repo);
      setDefaults(d);
      const base = fresh(d);
      const restored = stored ? { ...base, ...saved, settings: { ...base.settings, ...saved.settings } } : base;
      const pendingSource = await game.repo.getSetting<SourceBinding | null>("source:pending", null);
      if (pendingSource) { restored.source = pendingSource; restored.fanfic = pendingSource.fanfic; if (pendingSource.fanfic) { restored.settings.mode = "free"; restored.settings.clockStyle = "elapsed"; } await game.repo.setSetting("source:pending", null); setStep("setup"); }
      draftRef.current = restored;
      setDraftState(restored);
      if (stored && (saved.name || saved.premise || saved.identity || saved.source || saved.fanfic)) setStep("setup");
      // 再挑战一次: the same opening starts at once, as a game's retry does.
      const autostart = await game.repo.getSetting<boolean>("newgameAutostart", false);
      if (!live) return;
      if (autostart) await game.repo.setSetting("newgameAutostart", false);
      const rows = await game.platform.sql.query("SELECT id, name, json FROM templates WHERE kind = 'opening' ORDER BY created_at DESC");
      setMine(rows.map((r) => ({ id: r.id as string, name: r.name as string, draft: JSON.parse(r.json as string) })));
      setLoaded(true);
      if (autostart && stored && saved.name && saved.identity) void start(restored, d);
    })();
    return () => { live = false; };
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
  const switchMode = (choice: "history" | "free" | "fanfic") => {
    const mode = choice === "fanfic" ? "free" : choice;
    setDraft((d) => ({ ...d, fanfic: choice === "fanfic", source: d.source ? { ...d.source, fanfic: choice === "fanfic" } : null, templateId: null, eraId: null, settings: { ...d.settings, mode, clockStyle: mode === "free" ? "elapsed" : "era" } }));
    if (choice === "fanfic") setStep("setup");
    setGroup("全部");
    setAllTemplates(false);
  };
  const blank = () => ({ ...fresh(), fanfic: draft.fanfic, source: draft.source, settings: { ...fresh().settings, mode: draft.settings.mode, clockStyle: free ? "elapsed" as const : "era" as const }, ...(free ? { origin: "", arrival: "不穿越" as const } : {}) });

  useBack(() => phase !== "form", phase !== "form");
  useEffect(() => () => { assistTicket.current++; draftTicket.current++; }, []);

  const useTemplate = (t: OpeningTemplate) => {
    setDraft((d) => fromTemplate(t, d));
    setError(null);
    setStep("setup");
    window.scrollTo?.(0, 0);
  };

  /** What the AI helpers are told the player has filled in so far. */
  const setupSoFar = (d: Draft) => ({
    mode: d.settings.mode === "free" ? "free" as const : "history" as const,
    title: d.title, premise: d.premise, name: d.name, gender: d.lockedGender ?? (d.name ? d.gender : ""),
    age: d.age ? Number(d.age) : null, identity: d.identity, arrival: d.arrival, origin: d.origin,
    hint: d.hint, essentials: d.settings.essentials,
  });

  const assist = async () => {
    if (!game.llm) { toast("先连接 AI 服务"); return; }
    if (assisting) return;
    const ticket = ++assistTicket.current;
    const sourceMode = draftRef.current.settings.mode;
    const sourceIdea = ideaRef.current;
    setAssisting(true);
    const result = await game.assist(free ? `自由世界，按玩家的设定创作，不套用真实历史。${idea}` : idea, setupSoFar(draftRef.current));
    if (ticket !== assistTicket.current) return;
    setAssisting(false);
    // Only a changed idea or world kind makes the result stale; fields typed meanwhile are kept below.
    if (sourceIdea !== ideaRef.current || sourceMode !== draftRef.current.settings.mode) {
      toast("想法改过了，这次的补全没有用上，可以再点一次。");
      return;
    }
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

  /** 玩法 cards: switching keeps what was written under every card. */
  const pickPlay = (play: PlayStyle) => setDraft((d) => ({ ...d, play }));
  /** A ready-made challenge fills the story too; the player's own words can come back with 撤销. */
  const useChallenge = (c: ChallengeCard) => {
    const before = draftRef.current;
    setDraft((d) => fromChallenge(c, d));
    setError(null);
    toast(`已填入“${c.title}”`, { label: "撤销", run: () => setDraft(before) });
  };
  /** AI 帮我拟大纲 / 出题: fills only what is still empty when the answer comes, never the player's words. */
  const draftMode = async (kind: "script" | "challenge") => {
    if (!game.llm) { toast("先连接 AI 服务"); return; }
    if (drafting) return;
    const d = draftRef.current;
    const full = kind === "script"
      ? d.script.line.trim() && filledBeats(d.script).length && d.script.ending.trim()
      : d.challenge.goal.trim() && d.challenge.limit.trim() && d.challenge.failIf.trim();
    if (full) { toast(kind === "script" ? "大纲都写好了，没有空着的地方" : "挑战都写好了，没有空着的地方"); return; }
    const ticket = ++draftTicket.current;
    setDrafting(kind);
    try {
      const keep = (mine: string, theirs: unknown) => (mine.trim() ? mine : typeof theirs === "string" ? theirs.trim() : mine);
      if (kind === "script") {
        const result = await game.draftScript({ ...setupSoFar(d), script: { line: d.script.line, beats: filledBeats(d.script), ending: d.script.ending } });
        if (ticket !== draftTicket.current) return;
        const beats = (result?.beats ?? []).map((b) => String(b).trim()).filter(Boolean).slice(0, MAX_BEATS);
        if (!result || !beats.length) { toast("没能拟出大纲，再试一次？"); return; }
        setDraft((x) => {
          // The model keeps the beats already written first; only the ones after them are new.
          const mine = filledBeats(x.script);
          return { ...x, script: {
            ...x.script, line: keep(x.script.line, result.line), ending: keep(x.script.ending, result.ending),
            beats: mine.length ? [...mine, ...beats.slice(mine.length)].slice(0, MAX_BEATS) : beats,
          } };
        });
        toast("已拟好大纲，都可以改");
      } else {
        const result = await game.draftChallenge({ ...setupSoFar(d), challenge: d.challenge });
        if (ticket !== draftTicket.current) return;
        if (!result || !String(result.goal ?? "").trim()) { toast("没能出好题，再试一次？"); return; }
        setDraft((x) => ({ ...x, challenge: { goal: keep(x.challenge.goal, result.goal), limit: keep(x.challenge.limit, result.limit), failIf: keep(x.challenge.failIf, result.failIf) } }));
        toast("已出好题，都可以改");
      }
    } catch {
      if (ticket === draftTicket.current) toast("没能生成，再试一次？");
    } finally {
      if (ticket === draftTicket.current) setDrafting(null);
    }
  };

  const start = async (d: Draft, defs: PlayDefaults | null = defaults) => {
    if (!game.llm) { toast("先连接 AI 服务"); return; }
    if (d.source && !await getBook(game.repo, d.source.bookId)) { setError("这台设备上没有选中的参考书籍，请重新选择或导入。"); return; }
    setError(null);
    setText(d.openingMode === "player" ? d.openingText : "");
    setPhase(d.openingMode === "player" ? "organizing" : "loading");
    const input = toNewWorld(d, defs ? { difficulty: defs.difficulty, autoUpkeep: defs.autoUpkeep, chapterEvery: defs.chapterEvery, fortune: defs.fortune, tabooHints: defs.tabooHints } : undefined);
    window.scrollTo?.(0, 0);
    const onEvent = (e: TurnEvent) => {
      if (e.type === "thinking") setPhase("thinking");
      else if (e.type === "text") { setPhase("writing"); setText(e.full); }
      else if (e.type === "organizing") setPhase("organizing");
      else if (e.type === "failed") { setPhase("form"); setError(explainFailure(e.reason, e.status)); }
    };
    const worldId = await game.createWorld(input, onEvent);
    if (worldId) {
      clearTimeout(saveTimer.current);
      await game.repo.setSetting("newgameDraft", null);
      replace({ name: "play", worldId });
    }
  };

  const randomStart = () => {
    const t = pickRandom(templates);
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
    if (text && text.length > OPENING_TEXT_LIMIT) { toast("这份开局设定太大，无法导入；原设定没有变化。"); return false; }
    const next = text ? parseShare(text) : null;
    if (!next) { toast("没有找到开局设定，请粘贴完整的分享文字"); return false; }
    setDraft(next);
    setError(null);
    toast(`已导入「${next.title || "开局设定"}」`);
    return true;
  };


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

  const filters = ["全部", ...(free ? [] : [...GROUPS, "其他"]), ...(mine.length ? ["我的"] : [])];
  const shownTemplates = group === "全部" ? (allTemplates ? templates : templates.slice(0, 6))
    : group === "我的" ? []
    : group === "其他" ? templates.filter((t) => !GROUPS.includes(dynastyOf(t)))
    : templates.filter((t) => dynastyOf(t) === group);

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
              // The words go; how the story is played and written stays.
              setDraft({ ...fresh(), settings: draft.settings, play: draft.play, aiPilot: draft.aiPilot, fortune: draft.fortune });
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
  /** 运势 the new world gets: a challenge defaults to 有影响 until the player picks one. */
  const fortune = draftFortune(draft, defaults?.fortune);
  const missing = draft.fanfic && !draft.source ? "原著书籍" : !draft.name.trim() || nameLength > NAME_MAX ? "名字" : ageProblem(draft.age, free) ? "年龄" : !draft.identity.trim() ? "身份"
    : draft.play === "script" && !filledBeats(draft.script).length ? "剧本"
    : draft.play === "challenge" && !draft.challenge.goal.trim() ? "挑战目标"
    : draft.openingMode === "player" && !draft.openingText.trim() ? "开场" : null;
  const startOrPoint = () => {
    if (!missing) { void start(draft); return; }
    setPointed(missing);
    // A grey button that does nothing is a dead end: take the player to what is missing (AUDIT_V4 3.7).
    if (missing === "名字") nameBox.current?.focus();
    else if (missing === "年龄") ageBox.current?.focus();
    else if (missing === "身份") identityBox.current?.focus();
    else if (missing === "剧本") beatBox.current?.focus();
    else if (missing === "挑战目标") goalBox.current?.focus();
    else setOpen((o) => ({ ...o, opening: true }));
    toast(missing === "名字" && nameLength > NAME_MAX ? `名字最多 ${NAME_MAX} 个字` : missing === "年龄" ? ageProblem(draft.age, free)! : `还差${missing}`);
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
          <div className="segmented" role="group" aria-label="故事模式">
            <button aria-pressed={!free} onClick={() => switchMode("history")}>历史穿越</button>
            <button aria-pressed={free && !draft.fanfic} onClick={() => switchMode("free")}>自由世界</button>
            <button aria-pressed={!!draft.fanfic} onClick={() => switchMode("fanfic")}>同人</button>
          </div>
          <p className="muted" style={{ margin: 0 }}>{free ? "仙侠、奇幻、科幻，或你喜欢的作品里的世界，都由你来定义。" : "从真实历史出发，也可以自由改写。"}</p>
          <button className="random-card" onClick={randomStart}>
            <span className="seal small" aria-hidden="true"><span>随</span><span>缘</span></span>
            <span><b>随便穿</b><small>{free ? "抽一个原创世界和身份，马上开始" : "让命运替你选一个时代和身份，马上开始"}</small></span>
          </button>

          <section className="stack" style={{ gap: 8 }}>
            <h2 className="section-title">一句话，AI 帮你补全</h2>
            <textarea rows={2} value={idea} onChange={(e) => setIdea(e.target.value)} aria-label="一句话想法" placeholder={free ? "比如：我是经营星际书店的精灵，今天想遇见一位有趣的客人" : "比如：靖康之变前一年，我是汴京的一个小吏，想办法救下更多的人"} />
            <button className={idea.trim() ? "primary" : ""} onClick={assist} disabled={assisting || !idea.trim()}>{assisting ? "构思中…" : "补全设定"}</button>
          </section>

          <section className="stack" style={{ gap: 8 }}>
            <h2 className="section-title">从灵感开始</h2>
            {/* A filter with only 全部 in it filters nothing: shown once there is a choice. */}
            {filters.length > 1 && <div className="segmented" role="group" aria-label="灵感分类">
              {filters.map((g) => <button key={g} aria-pressed={group === g} onClick={() => setGroup(g)}>{g}</button>)}
            </div>}
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
            {group === "全部" && !allTemplates && <button className="ghost" onClick={() => setAllTemplates(true)}>查看全部 {templates.length} 个灵感</button>}
          </section>

          <div className="pick-more">
            <button className="ghost" onClick={() => { setDraft(blank()); setStep("setup"); }}>什么都不选，自己从头写<span aria-hidden="true"> ›</span></button>
            {/* An authored world starts from three prompts in the premise instead of a long toast. */}
            {free && <button className="ghost" onClick={() => { setDraft({ ...blank(), premise: WORK_PREMISE }); setIdea(""); setStep("setup"); }}>写一个作品里的世界<span aria-hidden="true"> ›</span></button>}
          </div>
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
      <div className="screen-body stack setup-form">
        {error && <div className="notice">{error}</div>}
        <div className="segmented" role="group" aria-label="故事模式">
          <button aria-pressed={!free} onClick={() => switchMode("history")}>历史穿越</button>
          <button aria-pressed={free && !draft.fanfic} onClick={() => switchMode("free")}>自由世界</button>
          <button aria-pressed={!!draft.fanfic} onClick={() => switchMode("fanfic")}>同人</button>
        </div>
        <p className="muted" style={{ margin: 0 }}>都可以改。名字和身份填好就能开始，其余有默认。</p>
        <details open={draft.fanfic || undefined}><summary>{draft.fanfic ? "原著与用法" : "参考书籍（可选）"}</summary><SourceSetup value={draft.source} fanfic={draft.fanfic} onChange={(source) => setDraft((d) => ({ ...d, source, ...(source?.fanfic ? { fanfic: true, settings: { ...d.settings, mode: "free", clockStyle: "elapsed" } } : {}) }))} /></details>

        <label className="field">故事设定
          <textarea aria-label="故事设定" rows={5} value={draft.premise} onChange={(e) => set("premise", e.target.value)} placeholder={free ? "世界、作品或题材，故事从哪里开始，你想保留或改变什么。都可以自己写。" : "时代、地点、时局，你想讲的故事。比如：北宋宣和年间，汴京……"} />
        </label>

        <section className="stack" style={{ gap: 8 }}>
          <span className="field-label">主角</span>
          <div className="row">
            <span className="field-line grow">
              <input ref={nameBox} className={missing === "名字" ? "wanted" : ""} value={draft.name} onChange={(e) => set("name", e.target.value)} placeholder="名字" aria-label="名字" />
              <span className={`field-suffix${nameLength > NAME_MAX ? " over" : ""}`}>{nameLength}/{NAME_MAX}</span>
            </span>
            <input ref={ageBox} style={{ width: 84 }} className={ageProblem(draft.age, free) ? "wanted" : ""} value={draft.age} onChange={(e) => set("age", e.target.value.replace(/\D/g, "").slice(0, free ? 6 : 3))} placeholder="年龄" inputMode="numeric" aria-label="年龄" />
          </div>
          {(nameLength > NAME_MAX || ageProblem(draft.age, free)) && <p className="field-hint warn" style={{ margin: 0 }}>{nameLength > NAME_MAX ? `名字最多 ${NAME_MAX} 个字，现在 ${nameLength} 个` : ageProblem(draft.age, free)}</p>}
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

        <section className="stack" style={{ gap: 8 }}>
          <span className="field-label">玩法</span>
          <PlayStyles value={draft.play} onChange={pickPlay} />
          {draft.play === "script" && (
            <ScriptOutline value={draft.script} onChange={(script) => set("script", script)} aiPilot={draft.aiPilot} onAiPilot={(v) => set("aiPilot", v)}
              drafting={drafting === "script"} onDraft={() => void draftMode("script")} wanted={missing === "剧本" && pointed === "剧本"} firstBeat={beatBox} />
          )}
          {draft.play === "challenge" && (
            <ChallengeSetup value={draft.challenge} onChange={(challenge) => set("challenge", challenge)} selected={draft.challengeId} onCard={useChallenge}
              aiPilot={draft.aiPilot} onAiPilot={(v) => set("aiPilot", v)} drafting={drafting === "challenge"} onDraft={() => void draftMode("challenge")}
              free={free} wanted={missing === "挑战目标" && pointed === "挑战目标"} goalBox={goalBox} />
          )}
          {draft.play === "watch" && <p className="mode-hint">随时可以在本局设置里接过主角。</p>}
        </section>

        <Fold open={open} onToggle={toggle} id="arrival" title="穿越" summary={draft.arrival === "不穿越" ? `不穿越，本来就是这个${free ? "世界" : "时代"}的人` : `${draft.arrival} · 穿越前是${draft.origin || "……"}`}>
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

        <Fold open={open} onToggle={toggle} id="more" title="更多" summary={`${draft.title ? `故事名“${draft.title}” · ` : ""}${draft.eraId ? "内置时代资料" : draft.organize ? `AI 整理${free ? "世界设定" : "时代资料"}` : `不准备${free ? "世界设定" : "时代资料"}`}${fortune !== (defaults?.fortune ?? fortune) ? ` · 运势${FORTUNE_MODES.find(([v]) => v === fortune)?.[1]}` : ""}${draft.settings.essentials.trim() ? " · 有要点" : ""}`}>
          <label className="field">故事名<input value={draft.title} onChange={(e) => set("title", e.target.value)} placeholder="不填则用主角名字" /></label>
          <span className="muted">运势</span>
          <div className="segmented" role="group" aria-label="运势">
            {FORTUNE_MODES.map(([v, l]) => <button key={v} aria-pressed={fortune === v} onClick={() => set("fortune", v)}>{l}</button>)}
          </div>
          <span className="muted">{free ? "世界设定" : "时代资料"}（放进设定集，开局后在“我 → 设定”里改）</span>
          <div className="segmented" role="group" aria-label="时代设定">
            <button aria-pressed={!draft.eraId && draft.organize} onClick={() => setDraft((d) => ({ ...d, eraId: null, organize: true }))}>AI 按故事设定整理</button>
            {!free && ERAS.map((e) => <button key={e.id} aria-pressed={draft.eraId === e.id} onClick={() => set("eraId", e.id)}>{e.title.split(" · ")[0]}（内置）</button>)}
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
