import { useEffect, useState } from "react";
import { archiveProblems, exportWorld, importWorld } from "../../engine/archive";
import { exportStory } from "../../engine/book";
import { eraContext } from "../../engine/era";
import { nowOf } from "../../engine/calendar/clock";
import type { World } from "../../engine/types";
import { useApp } from "../app/context";
import { MenuSheet } from "../components/Sheet";
import { useLongPress } from "../components/useLongPress";
import { fromSetup } from "./openingDraft";
import { Seal } from "../components/Seal";
import { latestRelease, newer, type ReleaseInfo } from "../app/update";
import { Icon } from "../components/Icon";

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

/** The first character of the period, for the card's little seal: 唐, 宋, 明… */
function dynastyMark(clock: string): string {
  const named = clock.match(/^(秦|汉|唐|宋|元|明|清|晋|隋|周)/)?.[1];
  return named ?? clock.replace(/\s/g, "").slice(0, 1) ?? "世";
}

function WorldItem({ card, onOpen, onMenu, featured }: { card: WorldCard; onOpen: () => void; onMenu: () => void; featured?: boolean }) {
  const press = useLongPress(onMenu, onOpen);
  return (
    <div className={`card world-card${featured ? " featured" : ""}`}>
      <button className="world-open" {...press} aria-label={`继续“${card.world.title}”`}>
        <span className="mark" aria-hidden="true">{dynastyMark(card.clock)}</span>
        <h3>{card.world.title}</h3>
        <p>{card.protagonist} · {card.clock}</p>
        {card.lastLine && <p className="last-line">“{card.lastLine}”</p>}
        <p className="meta">{card.turns ? `${card.turns} 回合` : "刚开局"} · {relative(card.world.playedAt)}</p>
        {featured && <span className="primary continue-btn">继续</span>}
      </button>
      <button className="icon-btn world-menu" aria-label={`“${card.world.title}”的更多操作`} onClick={onMenu}><Icon name="more" /></button>
    </div>
  );
}

export default function Home() {
  const { game, push, profile, toast, ask, askName } = useApp();
  const [deleted, setDeleted] = useState<World[]>([]);
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
    if (mode === "replace") await game.platform.sql.backup("before-import").catch(() => null);
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
    await game.repo.purgeDeletedWorlds();
    setDeleted(await game.repo.deletedWorlds());
  };
  useEffect(() => { void load(); }, []);

  // Once a day, if the player allows it: is there a newer release? (设置 → 关于与更新)
  const [update, setUpdate] = useState<ReleaseInfo | null>(null);
  useEffect(() => {
    void (async () => {
      if (!await game.repo.getSetting("autoUpdateCheck", true)) return;
      const last = await game.repo.getSetting<number>("updateCheckedAt", 0);
      const skipped = await game.repo.getSetting<string | null>("updateSkipped", null);
      if (Date.now() - last < 86_400_000) return;
      await game.repo.setSetting("updateCheckedAt", Date.now());
      const latest = await latestRelease(game.platform).catch(() => null);
      if (latest && newer(latest.version, __APP_VERSION__) && latest.version !== skipped) setUpdate(latest);
    })();
  }, []);

  // Without a service, connecting leads straight on to the new story (AUDIT_V4_FUNCTION C4).
  const start = () => (profile ? push({ name: "newgame" }) : push({ name: "setup", first: true }));
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
        <button className="icon-btn" aria-label="设置" onClick={() => push({ name: "settings" })}><Icon name="settings" /></button>
      </div>
      <div className="screen-body stack">
        {update && (
          <div className="notice">
            有新版本 {update.version}，覆盖安装即可，不要先卸载。
            <div className="row">
              <button className="primary" onClick={() => void game.platform.system.openUrl(update.url)}>去下载</button>
              <button className="ghost" onClick={() => { void game.repo.setSetting("updateSkipped", update.version); setUpdate(null); }}>这版不提醒</button>
            </div>
          </div>
        )}
        {cards && cards.length === 0 && (
          <div className="hero">
            <Seal />
            <h1>历史穿越</h1>
            <p className="muted">醒来时，你已在另一个时代。</p>
          </div>
        )}
        {cards && cards.length > 0 && (
          <WorldItem featured card={cards[0]} onOpen={() => push({ name: "play", worldId: cards[0].world.id })} onMenu={() => setMenuFor(cards[0])} />
        )}
        <button className={cards && cards.length > 0 ? "big-btn" : "primary big-btn"} onClick={start}>{cards && cards.length > 0 ? "开始新的故事" : "开始穿越"}</button>
        {!profile && <p className="muted" style={{ textAlign: "center" }}>先连接一个 AI 服务才能开始。</p>}
        {cards && cards.length > 1 && (
          <div className="list">
            <p className="section-title">其他故事</p>
            {cards.slice(1).map((c) => (
              <WorldItem key={c.world.id} card={c} onOpen={() => push({ name: "play", worldId: c.world.id })} onMenu={() => setMenuFor(c)} />
            ))}
          </div>
        )}
        {deleted.length > 0 && <details className="recent-deleted">
          <summary className="muted">最近删除（{deleted.length}，30 天后自动清除）</summary>
          <div className="stack" style={{ gap: 4, marginTop: 8 }}>
            {deleted.map((w) => (
              <div key={w.id} className="item-row">
                <span className="grow">{w.title}</span>
                <button className="ghost" onClick={async () => { await game.repo.restoreWorld(w.id); toast(`已恢复“${w.title}”`); void load(); }}>恢复</button>
                <button className="ghost danger-text" onClick={async () => {
                  if (!await ask({ title: `彻底删除“${w.title}”？`, message: "所有路线和存档都会删掉，不能恢复。", confirm: "彻底删除", danger: true })) return;
                  await game.repo.deleteWorld(w.id);
                  void load();
                }}>彻底删除</button>
              </div>
            ))}
          </div>
        </details>}
        <div className="row home-links">
          <button className="ghost" onClick={() => push({ name: "guide" })}>游玩指南</button>
          <button className="ghost" onClick={() => void importOne()}>从文件导入世界…</button>
        </div>
        {incoming && <MenuSheet
          title={`已经有“${incoming.title}”了`}
          onClose={() => setIncoming(null)}
          items={[
            { label: "另存为新的世界（两个都留着，新的标“导入”）", onSelect: () => void finishImport("new") },
            { label: "覆盖现有的（会先自动备份一次）", danger: true, onSelect: () => void finishImport("replace") },
          ]}
        />}
      </div>
      {menuFor && (
        <MenuSheet
          title={menuFor.world.title}
          onClose={() => setMenuFor(null)}
          items={[
            { label: "继续游玩", onSelect: () => push({ name: "play", worldId: menuFor.world.id }) },
            { label: "改名", onSelect: async () => {
              const title = await askName({ title: "给这个故事改名", initial: menuFor.world.title });
              if (!title) return;
              await game.repo.renameWorld(menuFor.world.id, title);
              toast("已改名");
              void load();
            } },
            { label: "用同样设定再开一局", onSelect: () => void again(menuFor.world.id) },
            { label: "导出成文件", onSelect: () => void exportOne(menuFor) },
            // The current route as a readable novel (direction G): 回目 headings, the player's actions as short lines.
            { label: "导出成小说（文本）", onSelect: async () => {
              const story = await exportStory(game.repo, menuFor.world.id).catch(() => null);
              if (!story) { toast("没导出来，请再试一次"); return; }
              if (await game.platform.files.exportText(story.fileName, story.text).catch(() => false)) toast("已导出成小说");
            } },
            {
              label: "删除这个世界", danger: true,
              // Into the recycle bin, with a way back right away (AUDIT_V4_FUNCTION C2).
              onSelect: async () => {
                const { id, title } = menuFor.world;
                try {
                  await game.repo.trashWorld(id);
                  toast(`已删除“${title}”，30 天内可以在“最近删除”里恢复`, { label: "撤销", run: () => void game.repo.restoreWorld(id).then(() => load()) });
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
