import { useEffect, useRef, useState } from "react";
import { archiveProblems, exportWorldFile, importWorld } from "../../engine/archive";
import { exportStory } from "../../engine/book";
import { eraContext } from "../../engine/era";
import { nowOf } from "../../engine/calendar/clock";
import type { World } from "../../engine/types";
import { useApp } from "../app/context";
import { MenuSheet } from "../components/Sheet";
import { useLongPress } from "../components/useLongPress";
import { fromSetup } from "./openingDraft";
import { Seal } from "../components/Seal";
import { useUpdateNotice } from "../app/updateStore";
import { Icon } from "../components/Icon";
import { BookCover } from "../components/BookArt";
import { BudgetReminder } from "../components/MonthlyBudget";
import { WhatsNewNotice } from "../components/WhatsNew";
import { localFind } from "../app/localFind";

interface WorldCard {
  world: World;
  protagonist: string;
  lastLine: string;
  clock: string;
  turns: number;
  /** The dynasty for the cover's seal; none for a free world or an unknown era. */
  seal?: string;
}

function relative(iso: string): string {
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  if (minutes < 1440) return `${Math.round(minutes / 60)} 小时前`;
  return `${Math.round(minutes / 1440)} 天前`;
}

const QUOTE_PAIRS: Record<string, string> = { "“": "”", "「": "」", "『": "』", "‘": "’" };
const CLOSING_QUOTES = new Set(Object.values(QUOTE_PAIRS));

/** Quote marks in pairs: a closing mark whose opening was cut off goes, an open one is closed. */
function balanceQuotes(text: string): string {
  const open: string[] = [];
  let out = "";
  for (const ch of text) {
    if (QUOTE_PAIRS[ch]) {
      open.push(QUOTE_PAIRS[ch]);
      out += ch;
    } else if (CLOSING_QUOTES.has(ch)) {
      if (open[open.length - 1] === ch) {
        open.pop();
        out += ch;
      }
    } else out += ch;
  }
  return out + open.reverse().join("");
}

/**
 * The last sentence of a passage, for the card: at most 40 characters, cut at
 * the front. The card shows it as it is — no quote marks of its own around it
 * (a line of dialogue already has them: …不讲情面！” must not become ””).
 */
export function lastSentence(text: string): string {
  // A closing quote stays with its sentence: “……？”
  const sentences = text.replace(/\s+/g, "").match(/[^。！？]+[。！？]*[”」』]*/g) ?? [];
  const last = sentences[sentences.length - 1] ?? "";
  // Cut in the middle: no comma right after the ellipsis.
  return last.length > 40 ? `…${balanceQuotes(last.slice(-40)).replace(/^[，、；：,;:]+/, "")}` : balanceQuotes(last);
}

/** Reign names the templates and packs use, and their dynasty. */
const REIGNS: [RegExp, string][] = [
  [/始皇/, "秦"], [/建安|建兴|中平|初平|元狩|元封/, "汉"], [/永嘉|太康|永和/, "晋"], [/大业|开皇/, "隋"],
  [/天宝|开元|贞观|武德|永徽|元和|长庆|大中|天授/, "唐"], [/宣和|靖康|政和|崇宁|元祐|熙宁|庆历|绍兴|景德|嘉祐/, "宋"],
  [/至正|至元|大德/, "元"], [/崇祯|万历|永乐|洪武|嘉靖|天启|正德|成化|弘治|隆庆/, "明"],
  [/康熙|乾隆|雍正|光绪|道光|咸丰|同治|嘉庆|宣统/, "清"],
];
/**
 * The dynasty for the cover's seal: 唐, 宋, 明…, from the dynasty or reign
 * named in the date. Nothing when neither is known — a wrong seal (or the
 * first character of “第 4 天”) is worse than none.
 */
function dynastyMark(clock: string): string | undefined {
  const named = clock.match(/^(秦|汉|唐|宋|元|明|清|晋|隋|周)/)?.[1];
  if (named) return named;
  return REIGNS.find(([re]) => re.test(clock))?.[1];
}

function WorldItem({ card, onOpen, onMenu, featured, writing, index = 0 }: { card: WorldCard; onOpen: () => void; onMenu: () => void; featured?: boolean; writing?: boolean; index?: number }) {
  const press = useLongPress(onMenu, onOpen);
  return (
    <div className={`card world-card${featured ? " featured" : " shelf-item"}${writing ? " writing" : ""}`} style={{ ["--i" as string]: index }}>
      <button className="world-open" data-world-id={card.world.id} {...press} aria-label={`继续“${card.world.title}”`}>
        <BookCover seed={card.world.id} title={card.world.title} seal={card.seal} />
        <span className="world-info">
          <h3>{card.world.title}</h3>
          <p>{card.protagonist} · {card.clock}</p>
          {featured && card.lastLine && <p className="last-line">{card.lastLine}</p>}
          <p className="meta">
            {writing ? <span className="writing-badge"><i aria-hidden="true" />正在写…</span> : <>{card.turns ? `${card.turns} 回合` : "刚开局"} · {relative(card.world.playedAt)}</>}
          </p>
          {featured && <span className="primary continue-btn"><Icon name="play" size={16} />继续</span>}
        </span>
      </button>
      <button className="icon-btn world-menu" aria-label={`“${card.world.title}”的更多操作`} onClick={onMenu}><Icon name="more" /></button>
    </div>
  );
}

/** Paper-coloured placeholders with a passing light while the shelf loads. */
function ShelfSkeleton() {
  return (
    <div className="stack" aria-hidden="true">
      <div className="skeleton skeleton-hero"><span className="skeleton-cover" /><span className="skeleton-lines"><i /><i /><i /></span></div>
      <div className="skeleton skeleton-btn" />
      <div className="shelf"><div className="skeleton skeleton-book" /><div className="skeleton skeleton-book" /></div>
    </div>
  );
}

/** Stories still being written (D160: leaving the page does not stop them). */
function useWritingWorlds(game: ReturnType<typeof useApp>["game"]) {
  const [writing, setWriting] = useState<Set<string>>(new Set());
  useEffect(() => {
    let live = true, timer = 0;
    const check = async () => {
      try {
        const rows = await game.platform.sql.query("SELECT DISTINCT world_id FROM execution_runs WHERE status IN ('running','committing')");
        if (!live) return;
        const next = new Set(rows.map((r) => String((r as { world_id: string }).world_id)));
        setWriting((old) => (old.size === next.size && [...next].every((id) => old.has(id)) ? old : next));
        timer = window.setTimeout(check, next.size ? 1500 : 6000);
      } catch { if (live) timer = window.setTimeout(check, 6000); }
    };
    void check();
    const off = game.subscribe(() => { window.clearTimeout(timer); void check(); });
    return () => { live = false; window.clearTimeout(timer); off(); };
  }, [game]);
  return writing;
}

export default function Home() {
  const { game, push, profile, toast, ask, askName } = useApp();
  const [deleted, setDeleted] = useState<World[]>([]);
  const [cards, setCards] = useState<WorldCard[] | null>(null);
  const [query, setQuery] = useState("");
  const [menuFor, setMenuFor] = useState<WorldCard | null>(null);
  const exporting = useRef(false);
  const [exportStatus, setExportStatus] = useState<string | null>(null);
  const [incoming, setIncoming] = useState<{ file: unknown; title: string } | null>(null);

  // R08-T001: a world as one file.
  const exportOne = async (card: WorldCard) => {
    if (exporting.current) return;
    exporting.current = true; setExportStatus("正在准备完整存档…");
    try {
      const saved = await exportWorldFile(game.repo, card.world.id, card.world.title);
      setExportStatus(null); if (saved) toast("已导出");
    } catch (error) {
      const message = error instanceof Error ? error.message : typeof error === "object" && error && "message" in error ? String(error.message) : "导出失败，请稍后重试";
      setExportStatus(message);
    } finally { exporting.current = false; }
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
      const clock = nowOf(era.clock, state.time.elapsedMinutes).text;
      const free = world.settings.mode === "free" || state.era.mode === "free";
      out.push({
        world, protagonist: state.protagonist.name, lastLine: lastSentence(summary.last),
        clock, turns: summary.turns, seal: free ? undefined : dynastyMark(clock),
      });
    }
    setCards(out);
    await game.repo.purgeDeletedWorlds();
    setDeleted(await game.repo.deletedWorlds());
  };
  useEffect(() => { void load(); return game.subscribe(() => { void load(); }); }, [game]);

  // Once a day, if the player allows it: is there a newer release? (设置 → 关于与更新)
  const { store: updates, unread } = useUpdateNotice(game);
  useEffect(() => { void updates.check().catch(() => {}); }, [updates]);

  // Without a service, connecting leads straight on to the new story (AUDIT_V4_FUNCTION C4).
  const start = () => (profile ? push({ name: "newgame" }) : push({ name: "setup", first: true }));
  const again = async (worldId: string) => {
    const setup = await game.setupOf(worldId);
    if (!setup) return;
    await game.repo.setSetting("newgameDraft", fromSetup(setup));
    start();
  };
  const shownCards = cards?.filter(card => localFind(query, card.world.title, card.protagonist, card.lastLine));
  const writing = useWritingWorlds(game);

  return (
    <div className="screen">
      <div className="topbar home-topbar">
        <div className="title brand"><span className="brand-mark" aria-hidden="true">穿越</span><h1>穿越小说模拟</h1></div>
        <button className="icon-btn update-mark" aria-label={unread ? "设置，有新版本" : "设置"} onClick={() => push({ name: "settings" })}><Icon name="settings" />{unread && <i className="update-dot" aria-hidden="true" />}</button>
      </div>
      <div className="screen-body stack">
        {exportStatus && <div className="notice" role="status">{exportStatus}</div>}
        <BudgetReminder />
        <WhatsNewNotice />
        {!cards && <ShelfSkeleton />}
        {cards && cards.length === 0 && (
          <div className="hero">
            <Seal />
            <h1>穿越小说模拟</h1>
            <p className="muted">醒来时，你已在另一个时代。</p>
          </div>
        )}
        {cards && cards.length > 3 && <input type="search" aria-label="查找故事" placeholder="按书名、主角或最近剧情查找故事" value={query} onChange={event => setQuery(event.target.value)} />}
        {cards && cards.length > 0 && shownCards && !shownCards.length && <p className="muted" role="status">没有找到相关故事，清空查找即可查看全部。</p>}
        {shownCards && shownCards.length > 0 && (
          <WorldItem featured card={shownCards[0]} writing={writing.has(shownCards[0].world.id)} onOpen={() => push({ name: "play", worldId: shownCards[0].world.id })} onMenu={() => setMenuFor(shownCards[0])} />
        )}
        {cards && <button className={`big-btn new-story${cards.length > 0 ? "" : " primary"}`} onClick={start}>
          <span className="new-story-mark" aria-hidden="true"><Icon name="plus" size={22} /></span>
          <span className="new-story-text"><b>{cards.length > 0 ? "开始新的故事" : "开始穿越"}</b><small>随便穿、我的开局，或从灵感出发</small></span>
        </button>}
        {!profile && <p className="muted t-center">先连接一个 AI 服务才能开始。</p>}
        {shownCards && shownCards.length > 1 && (
          <div className="list">
            <p className="section-title">书架</p>
            <div className="shelf">
              {shownCards.slice(1).map((c, i) => (
                <WorldItem key={c.world.id} card={c} index={i} writing={writing.has(c.world.id)} onOpen={() => push({ name: "play", worldId: c.world.id })} onMenu={() => setMenuFor(c)} />
              ))}
            </div>
          </div>
        )}
        {deleted.length > 0 && <details className="recent-deleted">
          <summary className="muted">最近删除（{deleted.length}，30 天后自动清除）</summary>
          <div className="stack gap-1 mt-2">
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
