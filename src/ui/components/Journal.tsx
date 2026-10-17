// The 记事 tab of the character panel (PLAN §4.5): chapter summaries on the
// current path, the turns not yet in a chapter, what happened in each turn,
// the world's great events and how this world's history has changed (R05-T004).
import { useEffect, useState } from "react";
import type { TurnRecord } from "../../engine/state/apply";
import type { Chapter, StoryNode, TimelineEvent, WorldState } from "../../engine/types";
import { useApp } from "../app/context";
import { Sheet } from "./Sheet";

interface Row { chapter: Chapter; n: number; from: number; to: number; turns: StoryNode[] }

/** "第 3 回合：……" from the turn's own record. */
function logLine(node: StoryNode, n: number): string {
  const log = (node.record as { log?: unknown } | null)?.log;
  return `第 ${n} 回合：${typeof log === "string" && log.trim() ? log.trim() : node.actionText || "（继续）"}`;
}

function ChapterSheet({ row, worldId, onClose, onChanged }: { row: Row; worldId: string; onClose: () => void; onChanged: () => void }) {
  const { game, toast } = useApp();
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(row.chapter.title);
  const [gist, setGist] = useState(row.chapter.gist);
  const [summary, setSummary] = useState(row.chapter.summary);
  const [busy, setBusy] = useState(false);
  const c = row.chapter;

  const save = async () => {
    setBusy(true);
    try {
      await game.repo.updateChapter(c.id, { title: title.trim() || c.title, gist: gist.trim() || c.gist, summary: summary.trim() || c.summary, edited: true });
      onChanged();
      onClose();
    } finally { setBusy(false); }
  };
  const rewrite = async () => {
    if (c.edited && !confirm("重写会换掉你改过的摘要。确定吗？")) return;
    setBusy(true);
    try {
      const next = await game.rewriteChapter(worldId, c.id);
      if (!next) { toast("这次没写出来，稍后再试"); return; }
      onChanged();
      onClose();
    } finally { setBusy(false); }
  };
  const remove = async () => {
    if (!confirm("删除这一章的摘要？这几回合以后会重新写成一章。")) return;
    await game.repo.deleteChapter(c.id);
    onChanged();
    onClose();
  };

  return (
    <Sheet title={`第 ${row.n} 章 · ${c.title}`} onClose={onClose}>
      {editing ? <div className="stack" style={{ gap: 10 }}>
        <label>标题<input value={title} onChange={(e) => setTitle(e.target.value)} /></label>
        <label>一句话梗概（更早的章节只交给 AI 这一句）<input value={gist} onChange={(e) => setGist(e.target.value)} /></label>
        <label>摘要<textarea rows={8} value={summary} onChange={(e) => setSummary(e.target.value)} /></label>
        <div className="row">
          <button disabled={busy} onClick={() => setEditing(false)}>取消</button>
          <button className="primary grow" disabled={busy} onClick={() => void save()}>保存</button>
        </div>
      </div> : <div className="stack" style={{ gap: 10 }}>
        <p className="muted" style={{ margin: 0 }}>第 {row.from}～{row.to} 回合 · {c.edited ? "你改过" : "AI 写的"}</p>
        <p className="codex-text" style={{ margin: 0 }}>{c.summary}</p>
        {row.turns.length > 0 && <details>
          <summary className="muted">这一章每回合发生了什么</summary>
          <div className="stack" style={{ gap: 4, marginTop: 6 }}>{row.turns.map((t, i) => <small key={t.id} className="muted">{logLine(t, row.from + i)}</small>)}</div>
        </details>}
        <div className="row">
          <button className="danger-text" disabled={busy} onClick={() => void remove()}>删除</button>
          <button disabled={busy} onClick={() => void rewrite()}>{busy ? "正在写…" : "重写"}</button>
          <button className="primary grow" disabled={busy} onClick={() => setEditing(true)}>修改</button>
        </div>
      </div>}
    </Sheet>
  );
}

type Save = (patch: TurnRecord, summary: string) => Promise<void>;

function EventSheet({ event, onClose, onSave }: { event: TimelineEvent | null; onClose: () => void; onSave: Save }) {
  const [date, setDate] = useState("");
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState<TimelineEvent["kind"]>("可变");
  const [saving, setSaving] = useState(false);
  const run = async (patch: TurnRecord, summary: string) => {
    setSaving(true);
    try { await onSave(patch, summary); onClose(); } finally { setSaving(false); }
  };
  if (event) return (
    <Sheet title={event.title} onClose={onClose}>
      <div className="stack" style={{ gap: 10 }}>
        <p className="muted" style={{ margin: 0 }}>{event.date} · {event.kind === "固定" ? "固定：不管你做什么都会发生" : "可变：你的行动可能改变它"}{event.source === "卡组" ? " · 来自内置卡组" : event.source === "AI" ? " · AI 整理" : ""}</p>
        <button className="danger-text" disabled={saving} onClick={() => void run({ timeline: [{ op: "remove", id: event.id }] }, `删除大事：${event.title}`)}>从年表删除</button>
      </div>
    </Sheet>
  );
  return (
    <Sheet title="添加大事" onClose={onClose}>
      <div className="stack" style={{ gap: 10 }}>
        <p className="muted" style={{ margin: 0 }}>史书上记载、或你想让它发生的大事。游戏时间到了，回合下会提醒，AI 也会知道。</p>
        <label>日期（写到月份）<input value={date} onChange={(e) => setDate(e.target.value)} placeholder="如：天宝九载十月" /></label>
        <label>发生什么<input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="如：杨钊请改名，玄宗赐名国忠" /></label>
        <div className="segmented">
          {(["固定", "可变"] as const).map((k) => <button key={k} aria-pressed={kind === k} onClick={() => setKind(k)}>{k === "固定" ? "固定（一定发生）" : "可变（能被改变）"}</button>)}
        </div>
        <button className="primary" disabled={saving || !date.trim() || !title.trim()} onClick={() => void run({ timeline: [{ op: "add", date: date.trim(), title: title.trim(), kind }] }, `添加大事：${title.trim()}`)}>添加</button>
      </div>
    </Sheet>
  );
}

export function Journal({ worldId, headId, chapterEvery, busy, state, onSave }: {
  worldId: string; headId: string; chapterEvery: number; busy: boolean; state: WorldState; onSave: Save;
}) {
  const { game, toast } = useApp();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [pending, setPending] = useState<{ from: number; turns: StoryNode[] }>({ from: 1, turns: [] });
  const [open, setOpen] = useState<Row | null>(null);
  const [writing, setWriting] = useState(false);
  const [event, setEvent] = useState<{ event: TimelineEvent | null } | null>(null);
  const now = state.time.elapsedMinutes;
  const timeline = state.timeline ?? [];

  const load = async () => {
    const [chapters, path] = await Promise.all([game.repo.chaptersOnPath(worldId, headId), game.repo.path(headId)]);
    const turns = path.filter((n) => n.kind === "turn" && n.status !== "interrupted");
    const number = new Map(path.filter((n) => n.kind === "turn").map((n, i) => [n.id, i + 1]));
    const next: Row[] = chapters.map((chapter, i) => {
      const from = number.get(chapter.firstNodeId) ?? 1;
      const to = number.get(chapter.lastNodeId) ?? from;
      return { chapter, n: i + 1, from, to, turns: turns.filter((t) => (number.get(t.id) ?? 0) >= from && (number.get(t.id) ?? 0) <= to) };
    });
    const done = next.at(-1)?.to ?? 0;
    setRows(next);
    setPending({ from: done + 1, turns: turns.filter((t) => (number.get(t.id) ?? 0) > done) });
  };
  useEffect(() => { void load(); }, [worldId, headId]);
  // A chapter written in the background shows up here too.
  useEffect(() => game.subscribe((id) => { if (id === worldId) void load(); }), [worldId, headId]);

  const writeNow = async () => {
    setWriting(true);
    try {
      const chapter = await game.writeChapter(worldId);
      if (!chapter) toast("这次没写出来，稍后再试");
      await load();
    } finally { setWriting(false); }
  };

  if (!rows) return null;
  const to = pending.from + pending.turns.length - 1;
  return (
    <div className="stack">
      {rows.length ? rows.map((row) => (
        <button key={row.chapter.id} className="item-row codex-item" disabled={busy} onClick={() => setOpen(row)}>
          <div className="grow">
            <b>第 {row.n} 章 · {row.chapter.title}</b>
            <small>{row.chapter.gist}</small>
          </div>
          <span className="person-side"><small>第 {row.from}～{row.to} 回合</small></span>
        </button>
      )) : <p className="muted">{chapterEvery ? `还没有章节。每过 ${chapterEvery} 回合，AI 会把这段剧情写成一章摘要，帮它记住更早的事。` : "自动写章节摘要已关闭，可以手动把最近的回合写成一章。"}</p>}
      {pending.turns.length > 0 && <section className="stack" style={{ gap: 6 }}>
        <b>本章进行中 · 第 {pending.from}～{to} 回合</b>
        {pending.turns.map((t, i) => <small key={t.id} className="muted">{logLine(t, pending.from + i)}</small>)}
        <button className="ghost" style={{ alignSelf: "flex-start" }} disabled={busy || writing} onClick={() => void writeNow()}>{writing ? "正在写…" : `把第 ${pending.from}～${to} 回合写成一章`}</button>
      </section>}
      <section className="stack" style={{ gap: 4 }}>
        <div className="row" style={{ justifyContent: "space-between" }}>
          <b>天下大事</b>
          <button className="ghost" aria-label="添加大事" disabled={busy} onClick={() => setEvent({ event: null })}>＋ 添加</button>
        </div>
        {timeline.length ? timeline.map((e) => (
          <button key={e.id} className="item-row codex-item" disabled={busy} style={e.atMinute !== null && e.atMinute <= now ? { opacity: 0.7 } : undefined} onClick={() => setEvent({ event: e })}>
            <div className="grow"><b>{e.title}</b><small>{e.date}{e.atMinute === null ? "（日期换算不了，不会提醒）" : e.atMinute < 0 ? " · 开局之前" : e.atMinute <= now ? " · 已到" : ""}</small></div>
            <span className="tag">{e.kind}</span>
          </button>
        )) : <p className="muted" style={{ margin: 0 }}>这个世界还没有年表。可以把史书上的大事加进来，时间到了会提醒。</p>}
      </section>
      {state.deviations.length > 0 && <section className="stack" style={{ gap: 4 }}>
        <b>历史偏离</b>
        {state.deviations.map((d, i) => <small key={i} className="muted">{d}</small>)}
      </section>}
      {open && <ChapterSheet row={open} worldId={worldId} onClose={() => setOpen(null)} onChanged={() => void load()} />}
      {event && <EventSheet event={event.event} onClose={() => setEvent(null)} onSave={onSave} />}
    </div>
  );
}
