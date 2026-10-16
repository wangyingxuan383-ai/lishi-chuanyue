// The play screen (PLAN_V3 §4.3–4.4): story stream, choices, input bar,
// regenerate/variants, long-press menu, stop/interrupt, character panel.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { getEra } from "../../content/eras";
import { formatClock } from "../../engine/calendar/clock";
import type { TurnEvent, TurnHandle } from "../../engine/game";
import { explainFailure } from "../../engine/llm/providers";
import type { Chip } from "../../engine/state/apply";
import * as tree from "../../engine/tree";
import type { ActionMode, Intensity, StoryNode, World, WorldState } from "../../engine/types";
import { useApp, useBack } from "../app/context";
import { Panel } from "../components/Panel";
import { MenuSheet, Sheet } from "../components/Sheet";
import { StoryText } from "../components/StoryText";
import { useLongPress } from "../components/useLongPress";

const PAGE = 30;
const MODES: { mode: ActionMode; label: string; placeholder: string }[] = [
  { mode: "do", label: "做", placeholder: "写下你要做的事…" },
  { mode: "say", label: "说", placeholder: "写下你要说的话…" },
  { mode: "direct", label: "导演", placeholder: "给叙事者的幕后要求，如“这段写紧张些”…" },
];
const HINTS = ["写短一点", "写长一点", "换个结果", "让对方拒绝", "多些对话", "节奏快一些"];

interface Gen {
  phase: "starting" | "thinking" | "writing" | "organizing";
  text: string;
  action: { mode: ActionMode; text: string } | null;
  variant: boolean;
}

function ChipRow({ chips }: { chips: Chip[] }) {
  if (!chips?.length) return null;
  return <div className="chips">{chips.map((c, i) => <span key={i} className={`chip ${c.tone}`}>{c.text}</span>)}</div>;
}

function TurnView({ node, onMenu, children }: { node: StoryNode; onMenu: (n: StoryNode) => void; children?: React.ReactNode }) {
  const press = useLongPress(() => onMenu(node));
  if (node.kind === "edit") return <div className="edit-line">你修改了记录</div>;
  return (
    <div className="turn" {...press}>
      {node.kind !== "opening" && node.actionMode !== "continue" && node.actionText && (
        <div className={`turn-action ${node.actionMode ?? ""}`}>{node.actionText}</div>
      )}
      {node.kind !== "opening" && node.actionMode === "continue" && <div className="turn-action continue">（继续）</div>}
      <StoryText text={node.narrative} />
      <ChipRow chips={(node.meta.chips as Chip[]) ?? []} />
      {children}
    </div>
  );
}

export default function Play({ worldId }: { worldId: string }) {
  const { game, push, toast, devMode, pop } = useApp();
  const [world, setWorld] = useState<World | null>(null);
  const [cursor, setCursor] = useState<tree.Cursor | null>(null);
  const [nodes, setNodes] = useState<StoryNode[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [limit, setLimit] = useState(PAGE);
  const [state, setState] = useState<WorldState | null>(null);
  const [variants, setVariants] = useState<tree.Variants | null>(null);
  const [gen, setGen] = useState<Gen | null>(null);
  const [notice, setNotice] = useState<{ text: string; retry?: () => void } | null>(null);
  const [modeIndex, setModeIndex] = useState(0);
  const [input, setInput] = useState("");
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState("");
  const [menuNode, setMenuNode] = useState<StoryNode | null>(null);
  const [editing, setEditing] = useState<{ node: StoryNode; field: "narrative" | "action"; text: string } | null>(null);
  const [rawNode, setRawNode] = useState<StoryNode | null>(null);
  const [sheet, setSheet] = useState<"more" | "hints" | "settings" | "lines" | null>(null);
  const [panel, setPanel] = useState(false);
  const [following, setFollowing] = useState(true);
  const [typing, setTyping] = useState(false);
  const handle = useRef<TurnHandle | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const era = getEra(world?.eraId ?? "tang-748");

  const refresh = useCallback(async (keepLimit = limit) => {
    const w = await game.repo.getWorld(worldId);
    if (!w) return pop();
    const c = await tree.cursor(game.repo, worldId);
    const path = await game.repo.path(c.head.id, keepLimit + 1);
    setHasMore(path.length > keepLimit);
    setNodes(path.slice(-keepLimit));
    setWorld(w);
    setCursor(c);
    setState(await game.repo.getState(c.head.id));
    setVariants(await tree.variants(game.repo, c.head));
  }, [game, worldId, limit, pop]);

  useEffect(() => { void refresh(); }, []);

  // Follow the bottom while the player is there; stop when they scroll up.
  const onScroll = () => {
    const el = scroller.current!;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    follow.current = atBottom;
    setFollowing(atBottom);
  };
  const toBottom = (smooth = false) => {
    const el = scroller.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" });
  };
  useLayoutEffect(() => {
    if (follow.current) toBottom();
  }, [nodes, gen?.text, gen?.phase, notice]);

  // Page came back from the background: replay what the stream cached meanwhile.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") void handle.current?.catchUp();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);

  useBack(() => {
    if (gen) {
      toast("正在写，先停止或等写完");
      return true;
    }
    return false;
  }, !!gen);

  const onEvent = (restore: { mode: ActionMode; text: string; note: string } | null) => (e: TurnEvent) => {
    if (e.type === "thinking") setGen((g) => g && { ...g, phase: "thinking" });
    else if (e.type === "text") setGen((g) => g && { ...g, phase: "writing", text: e.full });
    else if (e.type === "organizing") setGen((g) => g && { ...g, phase: "organizing" });
    else if (e.type === "done") {
      setGen(null);
      handle.current = null;
      void refresh();
    } else if (e.type === "failed") {
      setGen(null);
      handle.current = null;
      if (e.partialSaved) {
        void refresh();
        if (e.reason !== "cancelled") setNotice({ text: `${explainFailure(e.reason, e.status)} 已写出的部分保留了，可以续写或重说。` });
      } else {
        if (restore) {
          setInput(restore.text);
          setModeIndex(Math.max(0, MODES.findIndex((m) => m.mode === restore.mode)));
          if (restore.note) { setNote(restore.note); setNoteOpen(true); }
        }
        if (e.reason !== "cancelled") setNotice({ text: explainFailure(e.reason, e.status), retry: e.reason === "config" ? () => push({ name: "setup" }) : undefined });
      }
    }
  };

  const send = (override?: { mode: ActionMode; text: string }) => {
    if (gen || !cursor) return;
    if (!game.llm) { push({ name: "setup" }); return; }
    const mode = override?.mode ?? (input.trim() ? MODES[modeIndex].mode : "continue");
    const text = override?.text ?? (mode === "continue" ? "" : input.trim());
    const directorNote = !override && noteOpen && note.trim() ? note.trim() : null;
    setNotice(null);
    follow.current = true;
    setFollowing(true);
    setGen({ phase: "starting", text: "", action: { mode, text }, variant: false });
    setInput("");
    setNote("");
    setNoteOpen(false);
    setModeIndex(0);
    handle.current = game.play(worldId, { mode, text, directorNote }, onEvent(override ? null : { mode, text, note: directorNote ?? "" }));
  };

  const regenerate = (hint: string | null) => {
    if (gen || !cursor?.head.parentId) return;
    setNotice(null);
    follow.current = true;
    setGen({ phase: "starting", text: "", action: cursor.head.actionMode && cursor.head.actionMode !== "continue" ? { mode: cursor.head.actionMode, text: cursor.head.actionText ?? "" } : null, variant: true });
    handle.current = game.regenerate(worldId, hint, onEvent(null));
  };

  const resume = () => {
    if (gen || !cursor) return;
    setNotice(null);
    setGen({ phase: "starting", text: cursor.head.narrative, action: null, variant: true });
    handle.current = game.resumeInterrupted(worldId, onEvent(null));
  };

  const switchVariant = async (delta: number) => {
    if (!cursor || !variants) return;
    const next = variants.index + delta;
    if (next < 0 || next >= variants.count) return;
    await tree.switchVariant(game.repo, cursor, next);
    await refresh();
  };

  const goBack = async (node: StoryNode) => {
    if (!cursor) return;
    const before = cursor.line.id;
    const c = await tree.goBackTo(game.repo, cursor, node.id);
    await refresh();
    toast(c.line.id !== before ? "已回到这里，原来的路线保留着" : "已回到这里");
  };

  const editAction = async (node: StoryNode, text: string) => {
    if (!cursor || !node.parentId) return;
    await tree.goBackTo(game.repo, cursor, node.parentId);
    await refresh();
    send({ mode: node.actionMode === "say" ? "say" : "do", text });
  };

  const saveRewrite = async (node: StoryNode, text: string) => {
    await game.repo.updateNarrative(node.id, text);
    await refresh();
    toast("已改写，后面的剧情会按改过的文字继续");
  };

  const loadMore = async () => {
    const el = scroller.current!;
    const before = el.scrollHeight;
    const next = limit + PAGE;
    setLimit(next);
    await refresh(next);
    requestAnimationFrame(() => { el.scrollTop += el.scrollHeight - before; });
  };

  const updateSettings = async (patch: Partial<World["settings"]>) => {
    if (!world) return;
    const settings = { ...world.settings, ...patch };
    await game.repo.updateSettings(worldId, settings);
    setWorld({ ...world, settings });
  };

  if (!world || !cursor || !state) return <div className="screen-body"><p className="muted">正在读取…</p></div>;

  const head = cursor.head;
  const place = state.places.find((p) => p.id === state.placeId)?.name ?? era.title;
  const shown = gen?.variant ? nodes.slice(0, -1) : nodes;
  const mode = MODES[modeIndex];
  const dead = state.protagonist.stats.health <= 0 && world.settings.difficulty !== "宽松";
  const sendLabel = gen ? "停止" : input.trim() ? "发送" : "继续";
  const statusText = gen && { starting: "", thinking: "构思中…", writing: "", organizing: "整理中…" }[gen.phase];

  return (
    <div className="play">
      <div className="topbar">
        <button className="icon-btn" aria-label="返回" onClick={() => (gen ? toast("正在写，先停止或等写完") : pop())}>‹</button>
        <div className="title">
          <h1 style={{ fontSize: 15 }}>{place}</h1>
          <div className="subtitle">{era.startLabel} · {formatClock(era.startHour, state.time.elapsedMinutes)}</div>
        </div>
        <button className="icon-btn" aria-label="角色" onClick={() => setPanel(true)} style={{ fontSize: 15 }}>我</button>
        <button className="icon-btn" aria-label="更多" onClick={() => setSheet("more")}>⋯</button>
      </div>

      <div style={{ position: "relative", flex: 1, minHeight: 0, display: "flex" }}>
        <div className="story" ref={scroller} onScroll={onScroll}>
          <div className="story-inner">
            {hasMore && <button className="load-more ghost" onClick={loadMore}>加载更早的剧情</button>}
            {shown.map((node) => {
              const isHead = node.id === head.id && !gen;
              return (
                <TurnView key={node.id} node={node} onMenu={setMenuNode}>
                  {isHead && node.status === "interrupted" && (
                    <div className="notice">这段没有写完。<div className="row"><button onClick={resume}>续写</button><button onClick={() => regenerate(null)}>重说</button></div></div>
                  )}
                  {isHead && node.status === "no_record" && <p className="muted">这段没能整理出记录，状态可能没有更新。</p>}
                  {isHead && node.kind !== "opening" && (
                    <div className="turn-tools">
                      {variants && variants.count > 1 && (
                        <>
                          <button className="ghost" aria-label="上一版" disabled={variants.index === 0} onClick={() => switchVariant(-1)}>‹</button>
                          <span>{variants.index + 1}/{variants.count}</span>
                          <button className="ghost" aria-label="下一版" disabled={variants.index === variants.count - 1} onClick={() => switchVariant(1)}>›</button>
                        </>
                      )}
                      <RegenButton onTap={() => regenerate(null)} onLong={() => setSheet("hints")} />
                    </div>
                  )}
                </TurnView>
              );
            })}
            {gen && (
              <div className="turn">
                {gen.action && gen.action.mode !== "continue" && gen.action.text && <div className={`turn-action ${gen.action.mode}`}>{gen.action.text}</div>}
                {gen.text ? <StoryText text={gen.text} streaming={gen.phase === "writing"} /> : <p className="status-line">{statusText || "　"}</p>}
                {gen.text && statusText && <p className="status-line">{statusText}</p>}
              </div>
            )}
            {notice && (
              <div className="notice">
                {notice.text}
                {notice.retry && <div className="row"><button onClick={notice.retry}>去设置</button></div>}
              </div>
            )}
            {dead && <div className="notice">你已经死了。长按任意一段，可以回到那时重新来过。</div>}
          </div>
        </div>
        {!following && <button className="to-bottom" onClick={() => { follow.current = true; setFollowing(true); toBottom(true); }}>回到底部 ↓</button>}
      </div>

      <div className="dock">
        {!gen && !dead && !typing && head.choices.length > 0 && head.status !== "interrupted" && (
          <div className="choices">
            {head.choices.map((choice) => <ChoiceButton key={choice} text={choice} onTap={() => send({ mode: "do", text: choice })} onLong={() => { setInput(choice); setModeIndex(0); }} />)}
          </div>
        )}
        {noteOpen && mode.mode !== "direct" && (
          <input className="director-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="附加幕后要求（只影响这一段的写法）" />
        )}
        <div className="inputbar">
          <button className="mode-btn" onClick={() => setModeIndex((modeIndex + 1) % MODES.length)} disabled={!!gen}>{mode.label}</button>
          <textarea
            rows={1}
            value={input}
            disabled={dead}
            onFocus={() => setTyping(true)}
            onBlur={() => setTyping(false)}
            placeholder={dead ? "" : mode.placeholder}
            onChange={(e) => {
              const v = e.target.value;
              setInput(v);
              if (modeIndex === 0 && /^[“"「]/.test(v)) setModeIndex(1);
              e.target.style.height = "auto";
              e.target.style.height = `${e.target.scrollHeight}px`;
            }}
          />
          <button className={`send-btn ${gen ? "" : "primary"}`} disabled={dead && !gen} onClick={() => (gen ? handle.current?.stop() : send())}>{sendLabel}</button>
        </div>
      </div>

      {menuNode && (
        <MenuSheet
          onClose={() => setMenuNode(null)}
          items={[
            { label: "改写这段文字", hidden: menuNode.kind === "edit", onSelect: () => setEditing({ node: menuNode, field: "narrative", text: menuNode.narrative }) },
            { label: "改我的行动", hidden: !menuNode.actionText || menuNode.actionMode === "continue", onSelect: () => setEditing({ node: menuNode, field: "action", text: menuNode.actionText ?? "" }) },
            { label: "回到这里", hidden: menuNode.id === head.id, onSelect: () => void goBack(menuNode) },
            { label: "复制", onSelect: () => { void navigator.clipboard?.writeText(menuNode.narrative); toast("已复制"); } },
            { label: "查看原始输出（开发者）", hidden: !devMode, onSelect: () => setRawNode(menuNode) },
          ]}
        />
      )}
      {editing && (
        <Sheet title={editing.field === "action" ? "改我的行动" : "改写这段文字"} onClose={() => setEditing(null)}>
          <div className="stack">
            {editing.field === "action" && <p className="muted" style={{ margin: 0 }}>会从这一回合之前重新写，原来的内容保留在另一条路线里。</p>}
            <textarea rows={editing.field === "action" ? 3 : 12} value={editing.text} onChange={(e) => setEditing({ ...editing, text: e.target.value })} />
            <button className="primary" disabled={!editing.text.trim()} onClick={() => {
              const { node, field, text } = editing;
              setEditing(null);
              void (field === "action" ? editAction(node, text.trim()) : saveRewrite(node, text));
            }}>{editing.field === "action" ? "重新开始这一回合" : "保存"}</button>
          </div>
        </Sheet>
      )}
      {rawNode && (
        <Sheet title="原始输出" onClose={() => setRawNode(null)}>
          <p className="muted">模型 {String(rawNode.meta.model ?? "")} · 提示词 {String(rawNode.meta.promptVersion ?? "")} · 首字 {Math.round(Number(rawNode.meta.firstTokenMs ?? 0))}ms · 总计 {Math.round(Number(rawNode.meta.totalMs ?? 0))}ms{rawNode.meta.extracted ? " · 补记" : ""}</p>
          {(rawNode.meta.log as string[])?.length > 0 && <pre className="raw">{(rawNode.meta.log as string[]).join("\n")}</pre>}
          <pre className="raw">{String(rawNode.meta.raw ?? "（无）")}</pre>
        </Sheet>
      )}
      {sheet === "hints" && (
        <Sheet title="重说时希望…" onClose={() => setSheet(null)}>
          <div className="segmented">
            {HINTS.map((h) => <button key={h} onClick={() => { setSheet(null); regenerate(h); }}>{h}</button>)}
          </div>
          <HintInput onSubmit={(h) => { setSheet(null); regenerate(h); }} />
        </Sheet>
      )}
      {sheet === "more" && (
        <MenuSheet
          onClose={() => setSheet(null)}
          items={[
            { label: "撤销", hidden: !head.parentId || !!gen, onSelect: async () => { await tree.undo(game.repo, cursor); await refresh(); } },
            { label: "重做", hidden: !tree.canRedo(cursor) || !!gen, onSelect: async () => { await tree.redo(game.repo, cursor); await refresh(); } },
            { label: "附加幕后要求", hidden: noteOpen, onSelect: () => setNoteOpen(true) },
            { label: "世界线", onSelect: () => setSheet("lines") },
            { label: "本局设置", onSelect: () => setSheet("settings") },
            { label: "回到首页", onSelect: () => pop() },
          ]}
        />
      )}
      {sheet === "lines" && <LinesSheet worldId={worldId} current={cursor.line.id} onClose={() => setSheet(null)} onSwitch={async (id) => { await tree.switchLine(game.repo, worldId, id); setSheet(null); await refresh(); }} />}
      {sheet === "settings" && <WorldSettingsSheet world={world} onChange={updateSettings} onClose={() => setSheet(null)} />}
      {panel && <Panel state={state} era={era} onClose={() => setPanel(false)} />}
    </div>
  );
}

function RegenButton({ onTap, onLong }: { onTap: () => void; onLong: () => void }) {
  const press = useLongPress(onLong, onTap);
  return <button className="ghost" {...press}>重说</button>;
}

function ChoiceButton({ text, onTap, onLong }: { text: string; onTap: () => void; onLong: () => void }) {
  const press = useLongPress(onLong, onTap);
  return <button className="choice" {...press}>{text}</button>;
}

function HintInput({ onSubmit }: { onSubmit: (hint: string) => void }) {
  const [text, setText] = useState("");
  return (
    <div className="row" style={{ marginTop: 12 }}>
      <input className="grow" value={text} onChange={(e) => setText(e.target.value)} placeholder="或者自己写，如：让掌柜答应" />
      <button className="primary" disabled={!text.trim()} onClick={() => onSubmit(text.trim())}>重说</button>
    </div>
  );
}

function LinesSheet({ worldId, current, onClose, onSwitch }: { worldId: string; current: string; onClose: () => void; onSwitch: (id: string) => void }) {
  const { game } = useApp();
  const [lines, setLines] = useState<{ id: string; name: string; last: string; turns: number }[]>([]);
  useEffect(() => {
    void (async () => {
      const out = [];
      for (const l of await tree.listedLines(game.repo, worldId)) {
        const path = await game.repo.path(l.nodeId);
        const last = path[path.length - 1]?.narrative.replace(/\s+/g, "").slice(-30) ?? "";
        out.push({ id: l.id, name: l.name, last, turns: path.length - 1 });
      }
      setLines(out);
    })();
  }, []);
  return (
    <Sheet title="世界线" onClose={onClose}>
      <div className="list">
        {lines.map((l) => (
          <button key={l.id} className={`card${l.id === current ? " selected" : ""}`} onClick={() => onSwitch(l.id)}>
            <h3>{l.name}{l.id === current ? "（当前）" : ""}</h3>
            <p>{l.turns} 回合 · …{l.last}</p>
          </button>
        ))}
      </div>
      <p className="muted">长按任意一段选“回到这里”，就能从那里开出新的路线。</p>
    </Sheet>
  );
}

function WorldSettingsSheet({ world, onChange, onClose }: { world: World; onChange: (p: Partial<World["settings"]>) => void; onClose: () => void }) {
  const s = world.settings;
  const levels: Intensity[] = ["含蓄", "写实", "浓烈"];
  const intensity = (key: keyof typeof s.intensity, label: string) => (
    <div className="stack" style={{ gap: 6 }}>
      <span className="muted">{label}</span>
      <div className="segmented">
        {levels.map((l) => <button key={l} aria-pressed={s.intensity[key] === l} onClick={() => onChange({ intensity: { ...s.intensity, [key]: l } })}>{l}</button>)}
      </div>
    </div>
  );
  return (
    <Sheet title="本局设置" onClose={onClose}>
      <div className="stack">
        <span className="muted">每段篇幅</span>
        <div className="segmented">
          {(["短", "中", "长"] as const).map((l) => <button key={l} aria-pressed={s.length === l} onClick={() => onChange({ length: l })}>{l}</button>)}
        </div>
        <span className="muted">建议选项数量</span>
        <div className="segmented">
          {[0, 2, 3, 4].map((n) => <button key={n} aria-pressed={s.choiceCount === n} onClick={() => onChange({ choiceCount: n })}>{n === 0 ? "不要" : n}</button>)}
        </div>
        <span className="muted">文风</span>
        <div className="segmented">
          {(["白话", "半文半白"] as const).map((v) => <button key={v} aria-pressed={s.style === v} onClick={() => onChange({ style: v })}>{v}</button>)}
        </div>
        {intensity("violence", "暴力与伤亡")}
        {intensity("romance", "感情与亲密")}
        {intensity("darkness", "黑暗与压抑")}
        <p className="muted">修改从下一段开始生效。“浓烈”仍受所用 AI 服务的规则限制。</p>
      </div>
    </Sheet>
  );
}
