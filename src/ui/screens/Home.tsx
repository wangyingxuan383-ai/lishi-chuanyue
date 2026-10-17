import { useEffect, useState } from "react";
import { archiveProblems, exportWorld, importWorld } from "../../engine/archive";
import { eraContext } from "../../engine/era";
import { nowOf } from "../../engine/calendar/clock";
import type { World } from "../../engine/types";
import { useApp } from "../app/context";
import { MenuSheet } from "../components/Sheet";
import { useLongPress } from "../components/useLongPress";
import { fromSetup } from "./openingDraft";

interface WorldCard {
  world: World;
  protagonist: string;
  lastLine: string;
  clock: string;
  turns: number;
}

function relative(iso: string): string {
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  if (minutes < 1440) return `${Math.round(minutes / 60)} 小时前`;
  return `${Math.round(minutes / 1440)} 天前`;
}

export function lastSentence(text: string): string {
  // A closing quote stays with its sentence: “……？”
  const sentences = text.replace(/\s+/g, "").match(/[^。！？]+[。！？]*[”」』]*/g) ?? [];
  const last = sentences[sentences.length - 1] ?? "";
  return last.length > 40 ? `…${last.slice(-40)}` : last;
}

function WorldItem({ card, onOpen, onMenu }: { card: WorldCard; onOpen: () => void; onMenu: () => void }) {
  const press = useLongPress(onMenu, onOpen);
  return (
    <button className="card" {...press}>
      <h3>{card.world.title}</h3>
      <p>{card.protagonist} · {card.clock}</p>
      <p style={{ marginTop: 6 }}>{card.lastLine}</p>
      <p style={{ marginTop: 6, fontSize: 12 }}>{card.turns} 回合 · {relative(card.world.playedAt)}</p>
    </button>
  );
}

export default function Home() {
  const { game, push, profile, toast } = useApp();
  const [cards, setCards] = useState<WorldCard[] | null>(null);
  const [menuFor, setMenuFor] = useState<WorldCard | null>(null);
  const [incoming, setIncoming] = useState<{ file: unknown; title: string } | null>(null);

  // R08-T001: a world as one file.
  const exportOne = async (card: WorldCard) => {
    const archive = await exportWorld(game.repo, card.world.id);
    if (await game.platform.files.exportText(`${card.world.title}.lishi.json`, JSON.stringify(archive)).catch(() => false)) toast("已导出");
  };
  const importOne = async () => {
    const text = await game.platform.files.importText().catch(() => null);
    if (!text) return;
    let file: unknown = null;
    try { file = JSON.parse(text); } catch { /* reported below */ }
    const problems = archiveProblems(file);
    if (problems.length) { toast(`没有导入：${problems[0]}`); return; }
    const world = (file as { world: { id: string; title: string } }).world;
    // The same world is already here: ask whether to replace it or keep both.
    if (await game.repo.getWorld(world.id)) { setIncoming({ file, title: world.title }); return; }
    await importWorld(game.repo, file, "replace");
    toast(`已导入“${world.title}”`);
    void load();
  };
  const finishImport = async (mode: "new" | "replace") => {
    if (!incoming) return;
    await importWorld(game.repo, incoming.file, mode);
    toast(mode === "new" ? "已另存为新的世界" : `已覆盖“${incoming.title}”`);
    setIncoming(null);
    void load();
  };

  const load = async () => {
    const worlds = await game.repo.listWorlds();
    const out: WorldCard[] = [];
    for (const world of worlds) {
      const line = world.currentLineId ? await game.repo.getLine(world.currentLineId) : null;
      if (!line) continue;
      const state = await game.repo.getState(line.nodeId);
      const summary = await game.repo.homeSummary(line.nodeId);
      const era = eraContext(world.eraId, state);
      out.push({
        world, protagonist: state.protagonist.name, lastLine: lastSentence(summary.last),
        clock: nowOf(era.clock, state.time.elapsedMinutes).text, turns: summary.turns,
      });
    }
    setCards(out);
  };
  useEffect(() => { void load(); }, []);

  const start = () => (profile ? push({ name: "newgame" }) : push({ name: "setup" }));
  const again = async (worldId: string) => {
    const setup = await game.setupOf(worldId);
    if (!setup) return;
    await game.repo.setSetting("newgameDraft", fromSetup(setup));
    start();
  };

  return (
    <div className="screen">
      <div className="topbar">
        <div className="title"><h1>历史穿越</h1></div>
        <button className="icon-btn" aria-label="设置" onClick={() => push({ name: "settings" })}>⚙</button>
      </div>
      <div className="screen-body stack">
        {cards && cards.length === 0 && (
          <div className="hero">
            <div className="seal" aria-hidden="true">穿越</div>
            <h1>历史穿越</h1>
            <p className="muted">醒来时，你已在另一个时代。</p>
          </div>
        )}
        <button className="primary big-btn" onClick={start}>开始穿越</button>
        {!profile && <p className="muted" style={{ textAlign: "center" }}>先连接一个 AI 服务才能开始。</p>}
        {cards && cards.length > 0 && (
          <div className="list">
            <p className="muted" style={{ margin: "8px 0 0" }}>继续游玩</p>
            {cards.map((c) => (
              <WorldItem key={c.world.id} card={c} onOpen={() => push({ name: "play", worldId: c.world.id })} onMenu={() => setMenuFor(c)} />
            ))}
          </div>
        )}
        <button className="ghost" onClick={() => void importOne()}>从文件导入世界…</button>
        {incoming && <MenuSheet
          title={`已经有“${incoming.title}”了`}
          onClose={() => setIncoming(null)}
          items={[
            { label: "另存为新的世界", onSelect: () => void finishImport("new") },
            { label: "覆盖现有的", danger: true, onSelect: () => void finishImport("replace") },
          ]}
        />}
      </div>
      {menuFor && (
        <MenuSheet
          title={menuFor.world.title}
          onClose={() => setMenuFor(null)}
          items={[
            { label: "继续游玩", onSelect: () => push({ name: "play", worldId: menuFor.world.id }) },
            { label: "用同样设定再开一局", onSelect: () => void again(menuFor.world.id) },
            { label: "导出成文件", onSelect: () => void exportOne(menuFor) },
            {
              label: "删除这个世界", danger: true,
              onSelect: async () => {
                if (!confirm(`删除“${menuFor.world.title}”？删除后无法恢复。`)) return;
                try {
                  await game.repo.deleteWorld(menuFor.world.id);
                  toast("已删除");
                } catch {
                  toast("没删掉，请再试一次");
                }
                void load();
              },
            },
          ]}
        />
      )}
    </div>
  );
}
