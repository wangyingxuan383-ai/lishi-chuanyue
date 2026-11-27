import { useCallback, useEffect, useRef, useState } from "react";
import { archiveProblems, exportWorldFile, importWorld, replaceWorldWithBackup } from "../../engine/archive";
import { nowOf } from "../../engine/calendar/clock";
import { worldClock } from "../../engine/era";
import {
  countAllHighlights,
  getReadingStatsSummary,
  listLibraryShelfItems,
  saveWorldNovelToLibrary,
  type LibraryShelfItem,
  type ReadingStatsSummary,
} from "../../engine/reader/shelf";
import type { Repo } from "../../engine/db/repo";
import type { World } from "../../engine/types";
import { useApp } from "../app/context";
import { localFind } from "../app/localFind";
import { openWithFlourish } from "../app/motion";
import { newer } from "../app/update";
import { useUpdateNotice } from "../app/updateStore";
import { CinnabarSeal, EmptyVignette } from "../components/ChineseArt";
import { ExcerptsSheet } from "../components/ExcerptsSheet";
import { Icon } from "../components/Icon";
import { BudgetReminder } from "../components/MonthlyBudget";
import { NovelExportSheet } from "../components/NovelExportSheet";
import { MenuSheet } from "../components/Sheet";
import { UpdateSheet } from "../components/UpdateSheet";
import { WhatsNewNotice } from "../components/WhatsNew";
import { HomeLibrary } from "./home/HomeLibrary";
import { HomeScene } from "./home/HomeScene";
import { HomeShelf } from "./home/HomeShelf";
import type { WorldCard } from "./home/types";
import { fromSetup } from "./openingDraft";
import * as PlayModule from "./Play";

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
 * the front. The card shows it as it is — no quote marks of its own around it.
 */
export function lastSentence(text: string): string {
  const sentences = text.replace(/\s+/g, "").match(/[^。！？]+[。！？]*[”」』]*/g) ?? [];
  const last = sentences[sentences.length - 1] ?? "";
  return last.length > 40 ? `…${balanceQuotes(last.slice(-40)).replace(/^[，、；：,;:]+/, "")}` : balanceQuotes(last);
}

/** Reign names the templates and packs use, and their dynasty. */
const REIGNS: [RegExp, string][] = [
  [/始皇/, "秦"], [/建安|建兴|中平|初平|元狩|元封/, "汉"], [/永嘉|太康|永和/, "晋"], [/大业|开皇/, "隋"],
  [/天宝|开元|贞观|武德|永徽|元和|长庆|大中|天授/, "唐"], [/宣和|靖康|政和|崇宁|元祐|熙宁|庆历|绍兴|景德|嘉祐/, "宋"],
  [/至正|至元|大德/, "元"], [/崇祯|万历|永乐|洪武|嘉靖|天启|正德|成化|弘治|隆庆/, "明"],
  [/康熙|乾隆|雍正|光绪|道光|咸丰|同治|嘉庆|宣统/, "清"],
];

function dynastyMark(clock: string): string | undefined {
  const named = clock.match(/^(秦|汉|唐|宋|元|明|清|晋|隋|周)/)?.[1];
  if (named) return named;
  return REIGNS.find(([re]) => re.test(clock))?.[1];
}

function ShelfSkeleton() {
  return (
    <div className="stack" aria-hidden="true">
      <div className="skeleton skeleton-hero">
        <span className="skeleton-cover" />
        <span className="skeleton-lines"><i /><i /><i /></span>
      </div>
      <div className="skeleton skeleton-btn" />
      <div className="shelf">
        <div className="skeleton skeleton-book" />
        <div className="skeleton skeleton-book" />
      </div>
    </div>
  );
}

interface HomeMemoryCache {
  cards: WorldCard[] | null;
  deleted: World[];
  libraryItems: LibraryShelfItem[] | null;
  readingStats: ReadingStatsSummary | null;
  totalHighlights: number;
  purgedOnce: boolean;
}

const homeCacheByRepo = new WeakMap<Repo, HomeMemoryCache>();

function getHomeCache(repo: Repo): HomeMemoryCache {
  let cached = homeCacheByRepo.get(repo);
  if (!cached) {
    cached = {
      cards: null,
      deleted: [],
      libraryItems: null,
      readingStats: null,
      totalHighlights: 0,
      purgedOnce: false,
    };
    homeCacheByRepo.set(repo, cached);
  }
  return cached;
}

/** Stories still being written in the background. */
function useWritingWorlds(game: ReturnType<typeof useApp>["game"]) {
  const [writing, setWriting] = useState<Set<string>>(new Set());
  useEffect(() => {
    let live = true, timer = 0;
    const schedule = (ms: number) => {
      window.clearTimeout(timer);
      if (live) timer = window.setTimeout(() => void check(), ms);
    };
    const check = async () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") {
        schedule(15000);
        return;
      }
      try {
        const rows = await game.platform.sql.query("SELECT DISTINCT world_id FROM execution_runs WHERE status IN ('running','committing')");
        if (!live) return;
        const next = new Set(rows.map((r) => String((r as { world_id: string }).world_id)));
        setWriting((old) => (old.size === next.size && [...next].every((id) => old.has(id)) ? old : next));
        schedule(next.size ? 1500 : 15000);
      } catch { schedule(15000); }
    };
    const onVisible = () => { if (document.visibilityState === "visible") void check(); };
    void check();
    const off = game.subscribe(() => void check());
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      live = false;
      window.clearTimeout(timer);
      off();
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [game]);
  return writing;
}

/** Song-Painting Panorama Welcome Card when no stories exist yet. */
function PanoramaWelcomeCard({
  hasProfile,
  onStart,
  onGoLibrary,
}: {
  hasProfile: boolean;
  onStart: () => void;
  onGoLibrary: () => void;
}) {
  return (
    <section className="welcome-panorama" aria-label="欢迎来到穿越小说模拟">
      <div className="welcome-art" aria-hidden="true">
        <svg className="welcome-svg" viewBox="0 0 800 260" preserveAspectRatio="xMidYMax slice">
          <defs>
            <linearGradient id="wp-far" x1="0" y1="0" x2="0" y2="1">
              <stop className="wp-far-0" offset="0" />
              <stop className="wp-far-1" offset="1" />
            </linearGradient>
            <linearGradient id="wp-mid" x1="0" y1="0" x2="0" y2="1">
              <stop className="wp-mid-0" offset="0" />
              <stop className="wp-mid-1" offset="1" />
            </linearGradient>
            <linearGradient id="wp-near" x1="0" y1="0" x2="0" y2="1">
              <stop className="wp-near-0" offset="0" />
              <stop className="wp-near-1" offset="1" />
            </linearGradient>
          </defs>
          <circle className="wp-orb" cx="628" cy="64" r="36" />
          <path
            fill="url(#wp-far)"
            d="M0 260V128C68 116 124 62 186 68C248 74 288 134 356 122C424 110 478 52 548 58C618 64 676 126 738 118L800 102V260Z"
          />
          <path
            className="wp-gilt"
            fill="none"
            d="M0 168C76 154 138 106 208 114C278 122 332 168 412 152C492 136 558 88 634 98C696 106 748 148 800 142"
          />
          <path
            fill="url(#wp-mid)"
            d="M0 260V168C76 154 138 106 208 114C278 122 332 168 412 152C492 136 558 88 634 98C696 106 748 148 800 142V260Z"
          />
          <path
            fill="url(#wp-near)"
            d="M0 260V206C94 196 164 166 248 176C332 186 410 218 504 206C598 194 692 162 800 178V260Z"
          />
          <path
            className="wp-ripples"
            fill="none"
            d="M110 228h110M320 236h140M560 226h120M210 246h96"
          />
        </svg>
        <div className="welcome-mist" />
      </div>

      <div className="welcome-content">
        <CinnabarSeal text="穿越" variant="yin" size={54} tilt={-3} />
        <h2 className="welcome-headline">醒来时，你已在另一个时代</h2>
        <p className="welcome-sub">
          历史朝堂、市井烟火，或架空异界——不设固定路线，落笔皆成因果。
          {!hasProfile && "连接任一 AI 服务即可开启穿越；书斋可免配直接畅读本地小说。"}
        </p>
        <div className="welcome-actions">
          <button type="button" className="primary welcome-primary-btn" onClick={onStart}>
            <Icon name="sparkle" size={18} />
            <span>开始第一场穿越</span>
          </button>
          <button type="button" className="welcome-secondary-btn" onClick={onGoLibrary}>
            <Icon name="library-hall" size={18} />
            <span>去书斋读本地小说（免配 AI）</span>
          </button>
        </div>
      </div>
    </section>
  );
}

export default function Home() {
  const { game, push, profile, toast, ask, askName, reading, setReading } = useApp();
  const mem = getHomeCache(game.repo);
  const [deleted, setDeleted] = useState<World[]>(() => mem.deleted);
  const [cards, setCards] = useState<WorldCard[] | null>(() => mem.cards);
  const [libraryItems, setLibraryItems] = useState<LibraryShelfItem[] | null>(() => mem.libraryItems);
  const [readingStats, setReadingStats] = useState<ReadingStatsSummary | null>(() => mem.readingStats);
  const [totalHighlights, setTotalHighlights] = useState(() => mem.totalHighlights);

  const [query, setQuery] = useState("");
  const [menuFor, setMenuFor] = useState<WorldCard | null>(null);
  const [exportFor, setExportFor] = useState<WorldCard | null>(null);
  const [excerptsTarget, setExcerptsTarget] = useState<{ worldId?: string | null; bookId?: string | null } | null>(null);
  const [updateOpen, setUpdateOpen] = useState(false);

  const exporting = useRef(false);
  const [exportStatus, setExportStatus] = useState<string | null>(null);
  const importingRef = useRef(false);
  const [importing, setImporting] = useState(false);
  const [incoming, setIncoming] = useState<{ file: unknown; title: string } | null>(null);

  const importErrorText = (error: unknown): string => {
    const raw = error instanceof Error ? error.message : typeof error === "object" && error && "message" in error ? String((error as { message: unknown }).message) : "";
    if (/worlds\.title|archive-guard|lease|busy/i.test(raw)) return "这个世界正在后台续写或执行任务，请先停止或等完成后再导入";
    return raw || "文件读取或校验失败，请稍后重试";
  };

  const loadLibrary = useCallback(async () => {
    const [items, stats, hlCount] = await Promise.all([
      listLibraryShelfItems(game.repo).catch(() => []),
      getReadingStatsSummary(game.repo).catch(() => null),
      countAllHighlights(game.repo).catch(() => 0),
    ]);
    const cache = getHomeCache(game.repo);
    cache.libraryItems = items;
    cache.readingStats = stats;
    cache.totalHighlights = hlCount;
    setLibraryItems(items);
    setReadingStats(stats);
    setTotalHighlights(hlCount);
  }, [game.repo]);

  const loadWorlds = useCallback(async () => {
    const cache = getHomeCache(game.repo);
    if (!cache.purgedOnce) {
      cache.purgedOnce = true;
      await game.repo.purgeDeletedWorlds().catch(() => 0);
    }
    const [inputs, trashed] = await Promise.all([
      game.repo.listWorldCardInputs(),
      game.repo.deletedWorlds(),
    ]);
    const out: WorldCard[] = inputs.map(({ world, protagonistName, time, era: stateEra, turns, last }) => {
      const now = nowOf(worldClock(world.eraId, { time, era: stateEra }), time.elapsedMinutes);
      const clock = now.text;
      const free = world.settings.mode === "free" || stateEra.mode === "free";
      return {
        world,
        protagonist: protagonistName,
        lastLine: lastSentence(last),
        clock,
        hour: now.hour,
        turns,
        seal: free ? undefined : dynastyMark(clock),
      };
    });
    cache.cards = out;
    cache.deleted = trashed;
    setCards(out);
    setDeleted(trashed);
  }, [game.repo]);

  const loadAll = useCallback(async () => {
    await Promise.all([loadWorlds(), loadLibrary()]);
  }, [loadLibrary, loadWorlds]);

  useEffect(() => {
    void loadAll();
    const onLibraryChanged = () => {
      void loadLibrary();
    };
    window.addEventListener("lishi:library-changed", onLibraryChanged);
    const off = game.subscribe(() => {
      void loadWorlds();
    });
    return () => {
      window.removeEventListener("lishi:library-changed", onLibraryChanged);
      off();
    };
  }, [game, loadAll, loadLibrary, loadWorlds]);

  const exportOne = async (card: WorldCard) => {
    if (exporting.current) return;
    exporting.current = true;
    setExportStatus("正在准备完整存档…");
    try {
      const saved = await exportWorldFile(game.repo, card.world.id, card.world.title);
      if (saved) toast("已导出");
    } catch (error) {
      const message = error instanceof Error ? error.message : typeof error === "object" && error && "message" in error ? String(error.message) : "导出失败，请稍后重试";
      toast(message);
    } finally {
      setExportStatus(null);
      exporting.current = false;
    }
  };

  const importOne = async () => {
    if (importingRef.current) return;
    importingRef.current = true;
    setImporting(true);
    try {
      const text = await game.platform.files.importText();
      if (!text) return;
      let file: unknown = null;
      try { file = JSON.parse(text); } catch { /* reported below */ }
      const problems = archiveProblems(file);
      if (problems.length) { toast(`没有导入：${problems[0]}`); return; }
      const world = (file as { world: { id: string; title: string } }).world;
      if (await game.repo.getWorld(world.id)) { setIncoming({ file, title: world.title }); return; }
      await importWorld(game.repo, file, "replace");
      (PlayModule as { invalidatePlayViewCache?: () => void }).invalidatePlayViewCache?.();
      toast(`已导入“${world.title}”`);
      await loadWorlds();
    } catch (error) {
      toast(`没有导入：${importErrorText(error)}`);
    } finally {
      importingRef.current = false;
      setImporting(false);
    }
  };

  const finishImport = async (mode: "new" | "replace") => {
    if (!incoming || importingRef.current) return;
    const pending = incoming;
    setIncoming(null);
    importingRef.current = true;
    setImporting(true);
    try {
      if (mode === "replace") {
        await replaceWorldWithBackup(game.platform, game.repo, pending.file);
        (PlayModule as { invalidatePlayViewCache?: () => void }).invalidatePlayViewCache?.();
      } else {
        await importWorld(game.repo, pending.file, "new");
      }
      toast(mode === "new" ? "已另存为新的世界" : `已覆盖“${pending.title}”`);
      await loadWorlds();
    } catch (error) {
      toast(`没有导入：${importErrorText(error)}`);
    } finally {
      importingRef.current = false;
      setImporting(false);
    }
  };

  const { store: updates, state: updateState, unread, readyToPrompt } = useUpdateNotice(game);
  useEffect(() => { void updates.check().catch(() => {}); }, [updates]);
  const activeUpdateRelease =
    updateState.readyRelease &&
    updateState.release &&
    updateState.release.version !== updateState.readyRelease.version
      ? newer(updateState.release.version, updateState.readyRelease.version)
        ? updateState.release
        : updateState.readyRelease
      : (updateState.readyRelease ?? updateState.release);

  const start = () => (profile ? push({ name: "newgame" }) : push({ name: "setup", first: true }));
  const again = async (worldId: string) => {
    const setup = await game.setupOf(worldId);
    if (!setup) return;
    await game.repo.setSetting("newgameDraft", fromSetup(setup));
    start();
  };

  const shownCards = cards?.filter((card) =>
    localFind(query, card.world.title, card.protagonist, card.lastLine, card.clock),
  );
  const writing = useWritingWorlds(game);

  const openCard = (card: WorldCard, from: HTMLElement | null) => {
    const host = from?.closest<HTMLElement>(".home-scene, .shelf-book, .strip-card") ?? null;
    openWithFlourish(
      host,
      from,
      () => push({ name: "play", worldId: card.world.id }),
      host?.classList.contains("shelf-book") ? 600 : 420,
    );
  };

  const switchSpace = (tab: "stories" | "library") => {
    if (reading.homeTab === tab) return;
    setReading({ ...reading, homeTab: tab });
  };

  const isLibrary = reading.homeTab === "library";
  const libraryCount = libraryItems?.length ?? 0;
  const activeBridgeBook = libraryItems && libraryItems.length > 0
    ? (libraryItems.find((x) => x.progress) ?? libraryItems[0])
    : null;

  const newStory = cards && cards.length > 0 ? (
    <button className="big-btn new-story" onClick={start}>
      <span className="new-story-mark" aria-hidden="true"><Icon name="plus" size={22} /></span>
      <span className="new-story-text">
        <b>开始新的故事</b>
        <small>随便穿、我的开局，或从灵感出发</small>
      </span>
    </button>
  ) : null;

  return (
    <div className="screen">
      <div className="topbar home-topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">穿越</span>
          <h1 className="brand-title" aria-label="穿越小说模拟">
            穿越<span className="brand-sub">小说模拟</span>
          </h1>
        </div>

        <div
          className="home-space-switch"
          data-active={isLibrary ? "library" : "stories"}
          role="group"
          aria-label="主空间切换"
        >
          <span className="space-thumb" aria-hidden="true" />
          <button
            type="button"
            className="space-btn"
            aria-pressed={!isLibrary}
            onClick={() => switchSpace("stories")}
          >
            <Icon name="compass" size={15} />
            <span>穿越</span>
          </button>
          <button
            type="button"
            className="space-btn"
            aria-pressed={isLibrary}
            onClick={() => switchSpace("library")}
          >
            <Icon name="library-hall" size={15} />
            <span>书斋</span>
            {libraryCount > 0 && <em className="space-badge">{libraryCount}</em>}
          </button>
        </div>

        <div className="home-topbar-right">
          <button
            className="ghost home-companion-btn"
            aria-label="伴聊"
            onClick={() => push({ name: "companion" })}
          >
            <Icon name="chat" size={16} />
            <span>伴聊</span>
          </button>
          <button
            className="icon-btn update-mark"
            aria-label={unread ? "设置，有新版本" : "设置"}
            onClick={() => push({ name: "settings" })}
          >
            <Icon name="settings" />
            {unread && <i className="update-dot" aria-hidden="true" />}
          </button>
        </div>
      </div>

      <div className="screen-body home-body stack">
        {readyToPrompt && updateState.readyRelease && (
          <div className="update-ready-bar" role="status">
            <button
              type="button"
              className="ghost grow"
              style={{ justifyContent: "flex-start", textAlign: "left", padding: "4px 6px" }}
              onClick={() => setUpdateOpen(true)}
            >
              <Icon name="download" size={18} />
              <span>新版本 v{updateState.readyRelease.version} 已准备好，点此查看更新</span>
            </button>
            <button
              type="button"
              className="icon-btn"
              aria-label="暂不提示此次更新"
              onClick={() => void updates.dismissReady(updateState.readyRelease!.version)}
            >
              <Icon name="close" size={16} />
            </button>
          </div>
        )}
        {exportStatus && <div className="notice" role="status">{exportStatus}</div>}
        {importing && <div className="notice" role="status">正在导入存档…</div>}
        <BudgetReminder />
        <WhatsNewNotice />

        {isLibrary ? (
          <>
            <HomeLibrary
              items={libraryItems}
              stats={readingStats}
              totalHighlights={totalHighlights}
              worlds={cards}
              onReload={loadLibrary}
              onOpenExcerpts={(bookId) => {
                setExcerptsTarget({ worldId: null, bookId });
              }}
            />
            <div className="row wrap home-links">
              <button className="ghost" onClick={() => setExcerptsTarget({ worldId: null, bookId: null })}>
                佳句摘录簿
              </button>
              <button className="ghost" onClick={() => push({ name: "guide" })}>
                游玩指南
              </button>
            </div>
          </>
        ) : (
          <>
            {/* Cross-Space Quick Bridge to active novel in 书斋 */}
            {activeBridgeBook && (
              <div className="library-bridge-bar" role="region" aria-label="书斋在读快捷入口">
                <button
                  type="button"
                  className="bridge-space-tag"
                  onClick={() => switchSpace("library")}
                >
                  <Icon name="library-hall" size={14} />
                  <span>书斋在读</span>
                </button>
                <button
                  type="button"
                  className="bridge-open-btn"
                  data-book-id={activeBridgeBook.id}
                  onClick={() => push({ name: "reader", bookId: activeBridgeBook.id })}
                >
                  <span className="bridge-book-title">《{activeBridgeBook.title}》</span>
                  <span className="bridge-book-pct">
                    {activeBridgeBook.finished
                      ? "已读完"
                      : activeBridgeBook.progress
                        ? `${activeBridgeBook.progressPct}%`
                        : "未开卷"}
                  </span>
                  <span className="bridge-book-cta">
                    {activeBridgeBook.progress ? "继续读 ›" : "展卷 ›"}
                  </span>
                </button>
              </div>
            )}

            {/* Sub-header bar: Search + 画卷 | 书阁 view toggle */}
            {cards && cards.length > 0 && (
              <div className="stories-toolbar">
                <div className="stories-search">
                  <Icon name="search" size={16} />
                  <input
                    type="search"
                    aria-label="查找故事"
                    placeholder="搜书名、主角或剧情"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                  />
                </div>
                <div
                  className="home-view-switch"
                  data-view={reading.home === "shelf" ? "shelf" : "scene"}
                  role="group"
                  aria-label="穿越视图样式"
                >
                  <span className="view-thumb" aria-hidden="true" />
                  <button
                    type="button"
                    aria-label="画卷视图"
                    aria-pressed={reading.home !== "shelf"}
                    onClick={() => setReading({ ...reading, home: "scene" })}
                  >
                    <Icon name="landscape" size={15} />
                    <span className="switch-label">画卷</span>
                  </button>
                  <button
                    type="button"
                    aria-label="书阁视图"
                    aria-pressed={reading.home === "shelf"}
                    onClick={() => setReading({ ...reading, home: "shelf" })}
                  >
                    <Icon name="bookshelf" size={15} />
                    <span className="switch-label">书阁</span>
                  </button>
                </div>
              </div>
            )}

            {!cards && <ShelfSkeleton />}

            {cards && cards.length === 0 && (
              <PanoramaWelcomeCard
                hasProfile={!!profile}
                onStart={start}
                onGoLibrary={() => switchSpace("library")}
              />
            )}

            {cards && cards.length > 0 && shownCards && !shownCards.length && (
              <div role="status">
                <EmptyVignette kind="mist-search" title="没有找到相关故事" hint="清空查找即可查看全部。" compact />
              </div>
            )}

            {shownCards && shownCards.length > 0 && (
              reading.home === "shelf" ? (
                <HomeShelf
                  cards={shownCards}
                  writing={writing}
                  onOpen={openCard}
                  onMenu={setMenuFor}
                  onNew={start}
                  newStory={newStory}
                />
              ) : (
                <HomeScene
                  cards={shownCards}
                  writing={writing}
                  onOpen={openCard}
                  onMenu={setMenuFor}
                  newStory={newStory}
                />
              )
            )}

            {cards && cards.length > 0 && shownCards && shownCards.length === 0 && newStory}

            {cards && cards.length > 0 && !profile && (
              <p className="muted t-center">连接 AI 服务后即可继续推演或开启新故事。</p>
            )}

            {deleted.length > 0 && (
              <details className="recent-deleted">
                <summary className="muted">最近删除（{deleted.length}，30 天后自动清除）</summary>
                <div className="stack gap-1 mt-2">
                  {deleted.map((w) => (
                    <div key={w.id} className="item-row">
                      <span className="grow">{w.title}</span>
                      <button
                        className="ghost"
                        onClick={async () => {
                          await game.repo.restoreWorld(w.id);
                          toast(`已恢复“${w.title}”`);
                          void loadWorlds();
                        }}
                      >
                        恢复
                      </button>
                      <button
                        className="ghost danger-text"
                        onClick={async () => {
                          if (!await ask({ title: `彻底删除“${w.title}”？`, message: "所有路线和存档都会删掉，不能恢复。", confirm: "彻底删除", danger: true })) return;
                          await game.repo.deleteWorld(w.id);
                          void loadWorlds();
                        }}
                      >
                        彻底删除
                      </button>
                    </div>
                  ))}
                </div>
              </details>
            )}

            <div className="row wrap home-links">
              <button className="ghost" onClick={() => setExcerptsTarget({ worldId: null, bookId: null })}>
                佳句摘录簿
              </button>
              <button className="ghost" onClick={() => push({ name: "guide" })}>
                游玩指南
              </button>
              <button className="ghost" disabled={importing} onClick={() => void importOne()}>
                {importing ? "正在导入存档…" : "从文件导入世界…"}
              </button>
            </div>
          </>
        )}

        {incoming && !importing && (
          <MenuSheet
            title={`已经有“${incoming.title}”了`}
            onClose={() => setIncoming(null)}
            items={[
              { label: "另存为新的世界（两个都留着，新的标“导入”）", onSelect: () => void finishImport("new") },
              { label: "覆盖现有的（会先自动备份一次）", danger: true, onSelect: () => void finishImport("replace") },
            ]}
          />
        )}
      </div>

      {menuFor && (
        <MenuSheet
          title={menuFor.world.title}
          onClose={() => setMenuFor(null)}
          items={[
            { icon: "play", label: "继续游玩", onSelect: () => push({ name: "play", worldId: menuFor.world.id }) },
            { icon: "book-open", label: "小说模式阅读", onSelect: () => push({ name: "reader", worldId: menuFor.world.id }) },
            {
              icon: "library-hall",
              label: "编纂入书斋藏书",
              onSelect: async () => {
                try {
                  const res = await saveWorldNovelToLibrary(game.repo, menuFor.world.id);
                  await loadLibrary();
                  toast(`已将《${res.title}》收入书斋`, {
                    label: "去书斋",
                    run: () => switchSpace("library"),
                  });
                } catch (err) {
                  toast(err instanceof Error ? err.message : "尚无足够正文可编纂成书");
                }
              },
            },
            { icon: "highlight", label: "佳句摘录簿", onSelect: () => setExcerptsTarget({ worldId: menuFor.world.id, bookId: null }) },
            { icon: "download", label: "导出成小说（EPUB / TXT / MD）", onSelect: () => setExportFor(menuFor) },
            {
              icon: "pen",
              label: "改名",
              onSelect: async () => {
                const title = await askName({ title: "给这个故事改名", initial: menuFor.world.title });
                if (!title) return;
                await game.repo.renameWorld(menuFor.world.id, title);
                toast("已改名");
                void loadWorlds();
              },
            },
            { icon: "refresh", label: "用同样设定再开一局", onSelect: () => void again(menuFor.world.id) },
            { icon: "export", label: "导出成存档文件", onSelect: () => void exportOne(menuFor) },
            {
              icon: "trash",
              label: "删除这个世界",
              danger: true,
              onSelect: async () => {
                const { id, title } = menuFor.world;
                try {
                  await game.repo.trashWorld(id);
                  toast(`已删除“${title}”，30 天内可以在“最近删除”里恢复`, {
                    label: "撤销",
                    run: () => void game.repo.restoreWorld(id).then(() => loadWorlds()),
                  });
                } catch {
                  toast("没删掉，请再试一次");
                }
                void loadWorlds();
              },
            },
          ]}
        />
      )}

      {exportFor && (
        <NovelExportSheet
          worldId={exportFor.world.id}
          worldTitle={exportFor.world.title}
          onClose={() => setExportFor(null)}
        />
      )}

      {excerptsTarget !== null && (
        <ExcerptsSheet
          worldId={excerptsTarget.worldId}
          bookId={excerptsTarget.bookId}
          onClose={() => {
            setExcerptsTarget(null);
            void loadLibrary();
          }}
        />
      )}

      {updateOpen && activeUpdateRelease && (
        <UpdateSheet
          release={activeUpdateRelease}
          onClose={() => setUpdateOpen(false)}
        />
      )}
    </div>
  );
}
