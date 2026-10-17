// World lines (PLAN §4.8, R06-T001): routes, bookmarks, archived routes and a
// trash that keeps deleted ones for 30 days. Tap a route to switch to it, a
// bookmark to carry on from there.
import { useEffect, useState } from "react";
import * as tree from "../../engine/tree";
import type { Line } from "../../engine/types";
import { useApp } from "../app/context";
import { MenuSheet, Sheet } from "./Sheet";
import { TreeView } from "./TreeView";

interface Row { line: Line; turns: number; last: string }

function NameSheet({ title, initial, onSave, onClose }: { title: string; initial: string; onSave: (name: string) => void; onClose: () => void }) {
  const [name, setName] = useState(initial);
  return (
    <Sheet title={title} onClose={onClose}>
      <div className="stack">
        <input aria-label="名称" value={name} onChange={(e) => setName(e.target.value)} />
        <button className="primary" disabled={!name.trim()} onClick={() => onSave(name.trim())}>保存</button>
      </div>
    </Sheet>
  );
}

export function LinesSheet({ worldId, current, onClose, onChanged }: { worldId: string; current: string; onClose: () => void; onChanged: (message: string) => void }) {
  const { game } = useApp();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [menu, setMenu] = useState<Row | null>(null);
  const [renaming, setRenaming] = useState<Row | null>(null);
  const [showTree, setShowTree] = useState(false);

  const load = async () => {
    await game.repo.purgeTrash(worldId);
    const out: Row[] = [];
    for (const line of await game.repo.lines(worldId)) {
      const summary = await game.repo.homeSummary(line.nodeId);
      const last = summary.last.replace(/\s+/g, "");
      out.push({ line, turns: summary.turns, last: last.length > 28 ? `…${last.slice(-28)}` : last });
    }
    setRows(out);
  };
  useEffect(() => { void load(); }, [worldId]);
  if (!rows) return null;

  const routes = rows.filter((r) => r.line.kind === "line" && !r.line.archived && !r.line.deletedAt);
  const bookmarks = rows.filter((r) => r.line.kind === "bookmark" && !r.line.deletedAt);
  const archived = rows.filter((r) => r.line.kind === "line" && r.line.archived && !r.line.deletedAt);
  const trash = rows.filter((r) => r.line.deletedAt);
  const act = async (fn: () => Promise<unknown>, message: string) => { await fn(); await load(); onChanged(message); };
  const card = (r: Row, onTap: () => void) => (
    <div key={r.line.id} className="row line-row">
      <button className={`card grow${r.line.id === current ? " selected" : ""}`} onClick={onTap}>
        <h3>{r.line.name}{r.line.id === current ? "（当前）" : ""}</h3>
        <p>{r.turns} 回合 · {r.last}</p>
      </button>
      <button className="ghost" aria-label={`${r.line.name}的更多操作`} onClick={() => setMenu(r)}>⋯</button>
    </div>
  );

  return (
    <Sheet title="世界线" onClose={onClose}>
      <div className="list">
        {routes.map((r) => card(r, () => void act(() => tree.switchLine(game.repo, worldId, r.line.id), `已切换到“${r.line.name}”`)))}
      </div>
      {bookmarks.length > 0 && <>
        <p className="muted">书签（点一下从那里接着玩）</p>
        <div className="list">{bookmarks.map((r) => card(r, () => void act(() => tree.jumpTo(game.repo, worldId, r.line.nodeId, `从书签“${r.line.name}”继续`), `已回到书签“${r.line.name}”`)))}</div>
      </>}
      {archived.length > 0 && <details>
        <summary className="muted">已归档 {archived.length}</summary>
        <div className="list">{archived.map((r) => card(r, () => setMenu(r)))}</div>
      </details>}
      {trash.length > 0 && <details>
        <summary className="muted">回收站 {trash.length}（30 天后自动清除）</summary>
        <div className="list">{trash.map((r) => card(r, () => setMenu(r)))}</div>
      </details>}
      <button className="ghost" style={{ alignSelf: "flex-start" }} onClick={() => setShowTree(true)}>看回合树 ›</button>
      <p className="muted">长按任意一段，可以“回到这里”开出新路线，或者“加书签”。</p>
      {showTree && <TreeView worldId={worldId} onClose={() => setShowTree(false)} onJumped={(message) => { setShowTree(false); onClose(); onChanged(message); }} />}
      {menu && <MenuSheet
        title={menu.line.name}
        onClose={() => setMenu(null)}
        items={menu.line.deletedAt ? [
          { label: "恢复", onSelect: () => void act(() => game.repo.setLineDeleted(menu.line.id, false), `已恢复“${menu.line.name}”`) },
          { label: "彻底删除", danger: true, onSelect: () => { if (confirm(`彻底删除“${menu.line.name}”？只属于它的回合会一起删掉，不能恢复。`)) void act(() => game.repo.purgeLine(menu.line.id), "已彻底删除"); } },
        ] : [
          { label: "重命名", onSelect: () => setRenaming(menu) },
          { label: "归档", hidden: menu.line.kind !== "line" || menu.line.archived || menu.line.id === current, onSelect: () => void act(() => game.repo.setLineArchived(menu.line.id, true), `已归档“${menu.line.name}”`) },
          { label: "取消归档", hidden: !menu.line.archived, onSelect: () => void act(() => game.repo.setLineArchived(menu.line.id, false), `“${menu.line.name}”回到了路线列表`) },
          { label: "删除", danger: true, hidden: menu.line.id === current, onSelect: () => void act(() => game.repo.setLineDeleted(menu.line.id, true), `“${menu.line.name}”已放进回收站`) },
        ]}
      />}
      {renaming && <NameSheet title="重命名" initial={renaming.line.name} onClose={() => setRenaming(null)}
        onSave={(name) => { const id = renaming.line.id; setRenaming(null); void act(() => game.repo.renameLine(id, name), "已重命名"); }} />}
    </Sheet>
  );
}

/** Asks for a bookmark's name, prefilled from the passage. */
export function BookmarkSheet({ initial, onSave, onClose }: { initial: string; onSave: (name: string) => void; onClose: () => void }) {
  return <NameSheet title="加书签" initial={initial} onSave={onSave} onClose={onClose} />;
}
