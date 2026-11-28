import { useCallback, useEffect, useMemo, useState } from "react";
import type { Repo } from "../../engine/db/repo";
import { buildNovelBook } from "../../engine/novel";
import {
  exportHighlightsMarkdown,
  listReaderHighlights,
  removeReaderHighlight,
  resolveHighlightRouteTarget,
  updateReaderHighlight,
  type HighlightColor,
  type ReaderHighlight,
  type ReaderTargetType,
} from "../../engine/reader/store";
import { listBooks } from "../../engine/sources/library";
import { useApp } from "../app/context";
import { localFind } from "../app/localFind";
import { EmptyVignette } from "./ChineseArt";
import { Icon } from "./Icon";
import { CardSheet, SEPARATOR, type CardContent } from "./ShareCard";
import { Sheet } from "./Sheet";

const COLOR_META: { id: HighlightColor; label: string; dot: string }[] = [
  { id: "cinnabar", label: "朱砂", dot: "#b33b2a" },
  { id: "amber", label: "藤黄", dot: "#c88a22" },
  { id: "bamboo", label: "竹青", dot: "#3f7a58" },
];

const LINE_NODE_PREFIX = "line:";

function isLineScopedNode(nodeId: string | null | undefined): nodeId is string {
  return typeof nodeId === "string" && nodeId.startsWith(LINE_NODE_PREFIX);
}

function hasTextSnippet(text: string, needle: string): boolean {
  if (!needle) return true;
  if (text.includes(needle)) return true;
  const t = needle.trim();
  return t.length > 0 && text.includes(t);
}

function resolveSectionByTitle(
  sections: { title: string }[],
  sectionIndex: number,
  sectionTitle: string,
): number {
  if (
    sectionIndex >= 0 &&
    sectionIndex < sections.length &&
    (!sectionTitle || sections[sectionIndex]?.title === sectionTitle)
  ) {
    return sectionIndex;
  }
  if (sectionTitle) {
    const byTitle = sections.findIndex((s) => s.title === sectionTitle);
    if (byTitle >= 0) return byTitle;
  }
  return -1;
}

export async function filterExcerptsForWorldRoute(
  repo: Repo,
  rows: ReaderHighlight[],
  worldId: string,
  opts?: {
    lineId?: string | null;
    routeNodeIds?: ReadonlySet<string>;
  },
): Promise<ReaderHighlight[]> {
  if (!rows.some((h) => h.targetType === "world_novel" && h.targetId === worldId)) {
    return rows;
  }
  const built = await buildNovelBook(repo, worldId, {
    lineId: opts?.lineId ?? undefined,
    includePreface: true,
    includeChronicle: true,
    includeActions: false,
  }).catch(() => null);

  let effectiveLineId = built?.lineId ?? opts?.lineId?.trim() ?? "";
  if (!effectiveLineId) {
    const w = await repo.getWorld(worldId).catch(() => null);
    effectiveLineId = w?.currentLineId ?? "";
  }

  const nodeSet = new Set<string>();
  if (built) {
    for (const sec of built.sections) {
      if (sec.firstNodeId) nodeSet.add(sec.firstNodeId);
      if (sec.lastNodeId) nodeSet.add(sec.lastNodeId);
      for (const p of sec.paragraphs) {
        if (p.nodeId) nodeSet.add(p.nodeId);
      }
    }
  } else if (opts?.routeNodeIds) {
    for (const id of opts.routeNodeIds) nodeSet.add(id);
  }

  return rows.filter((h) => {
    if (h.targetType !== "world_novel" || h.targetId !== worldId) {
      return true;
    }
    if (isLineScopedNode(h.nodeId)) {
      if (!effectiveLineId || h.nodeId !== `${LINE_NODE_PREFIX}${effectiveLineId}`) {
        return false;
      }
      return built ? resolveSectionByTitle(built.sections, h.sectionIndex, h.sectionTitle) >= 0 : true;
    }
    if (h.nodeId) {
      return nodeSet.has(h.nodeId);
    }
    if (!built) return true;
    const secIdx = resolveSectionByTitle(built.sections, h.sectionIndex, h.sectionTitle);
    if (secIdx < 0 || !h.sectionTitle || built.sections[secIdx]?.title !== h.sectionTitle) {
      return false;
    }
    return built.sections[secIdx]!.paragraphs.some((p) => hasTextSnippet(p.text, h.selectedText));
  });
}

export interface ExcerptsSheetProps {
  worldId?: string | null;
  lineId?: string | null;
  routeNodeIds?: ReadonlySet<string>;
  targetType?: ReaderTargetType;
  bookId?: string | null;
  onJumpHighlight?: (h: ReaderHighlight) => void;
  onClose: () => void;
}

export function ExcerptsSheet({
  worldId,
  lineId,
  routeNodeIds,
  targetType,
  bookId,
  onJumpHighlight,
  onClose,
}: ExcerptsSheetProps) {
  const { game, push, replace, toast, ask } = useApp();
  const hasScopedTarget = !!(worldId || bookId);
  const [scope, setScope] = useState<"current" | "all">(hasScopedTarget ? "current" : "all");
  const [colorFilter, setColorFilter] = useState<"all" | HighlightColor>("all");
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<ReaderHighlight[]>([]);
  const [titles, setTitles] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [noteDraft, setNoteDraft] = useState("");
  const [cardFor, setCardFor] = useState<CardContent | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const filter =
        scope === "current"
          ? bookId
            ? { targetType: "book" as const, targetId: bookId }
            : worldId
              ? targetType === "world_novel"
                ? { targetType: "world_novel" as const, targetId: worldId }
                : { worldId }
              : undefined
          : undefined;
      const [rawRows, worlds, books] = await Promise.all([
        listReaderHighlights(game.repo, filter),
        game.repo.listWorlds().catch(() => []),
        listBooks(game.repo).catch(() => []),
      ]);
      const rows =
        scope === "current" && !bookId && worldId
          ? await filterExcerptsForWorldRoute(game.repo, rawRows, worldId, {
              lineId,
              routeNodeIds,
            })
          : rawRows;
      const map: Record<string, string> = {};
      for (const w of worlds) {
        map[w.id] = w.title;
        map[`world_novel:${w.id}`] = w.title;
      }
      for (const b of books) {
        map[b.id] = b.title;
        map[`book:${b.id}`] = b.title;
      }
      setTitles(map);
      setItems(rows);
    } finally {
      setLoading(false);
    }
  }, [bookId, game.repo, lineId, routeNodeIds, scope, targetType, worldId]);

  useEffect(() => {
    void load();
  }, [load]);

  const shown = useMemo(
    () =>
      items.filter(
        (h) =>
          (colorFilter === "all" || h.color === colorFilter) &&
          localFind(query, h.selectedText, h.note, h.sectionTitle, titles[h.targetId] ?? ""),
      ),
    [colorFilter, items, query, titles],
  );

  const targetName = (h: ReaderHighlight) =>
    titles[`${h.targetType}:${h.targetId}`] ??
    titles[h.targetId] ??
    (h.targetType === "world_novel" ? "本局故事" : "书库藏书");

  const jumpTo = async (h: ReaderHighlight) => {
    if (h.targetType === "book") {
      if (onJumpHighlight && !!bookId && h.targetId === bookId) {
        onJumpHighlight(h);
        onClose();
        return;
      }
      onClose();
      push({
        name: "reader",
        bookId: h.targetId,
        initialSection: h.sectionIndex,
        initialParagraph: h.paragraphIndex,
      });
      return;
    }

    if (isLineScopedNode(h.nodeId)) {
      const hlLineId = h.nodeId.slice(LINE_NODE_PREFIX.length);
      const wId = h.worldId || h.targetId;
      const lineRows = await game.repo.platform.sql
        .query("SELECT id FROM lines WHERE id = ? AND world_id = ? AND deleted_at IS NULL", [
          hlLineId,
          wId,
        ])
        .catch(() => []);
      if (!lineRows[0]?.id) {
        toast("这段原文所在回合已被删改或移入回收站，无法定位到原处");
        return;
      }

      const matchesOpenWorld = !bookId && !!worldId && h.targetId === worldId;
      if (onJumpHighlight && matchesOpenWorld && !!lineId && hlLineId === lineId) {
        onJumpHighlight(h);
        onClose();
        return;
      }

      const built = await buildNovelBook(game.repo, h.targetId, {
        lineId: hlLineId,
        includePreface: true,
        includeChronicle: true,
        includeActions: false,
      }).catch(() => null);
      let targetSec = h.sectionIndex;
      let targetPara = h.paragraphIndex;
      if (built) {
        const resolvedSec = resolveSectionByTitle(built.sections, h.sectionIndex, h.sectionTitle);
        if (resolvedSec >= 0) targetSec = resolvedSec;
        const fullSec = built.sections[targetSec];
        if (fullSec && h.selectedText.trim()) {
          const curP = fullSec.paragraphs[targetPara];
          if (!curP || !hasTextSnippet(curP.text, h.selectedText)) {
            const pHit = fullSec.paragraphs.findIndex(
              (p) => p.kind !== "divider" && hasTextSnippet(p.text, h.selectedText),
            );
            if (pHit >= 0) targetPara = pHit;
          }
        }
      }

      onClose();
      const targetRoute = {
        name: "reader" as const,
        worldId: h.targetId,
        lineId: hlLineId,
        initialSection: targetSec,
        initialParagraph: targetPara,
      };
      if (onJumpHighlight && matchesOpenWorld && !!lineId) {
        replace(targetRoute);
      } else {
        push(targetRoute);
      }
      return;
    }

    const resolved = await resolveHighlightRouteTarget(game.repo, h);
    if (h.nodeId && !resolved.nodeExists) {
      toast("这段原文所在回合已被删改或移入回收站，无法定位到原处");
      return;
    }

    const matchesOpenWorld = !bookId && !!worldId && h.targetId === worldId;
    const matchesOpenLine = !resolved.lineId || !lineId || resolved.lineId === lineId;
    if (onJumpHighlight && matchesOpenWorld && matchesOpenLine) {
      onJumpHighlight(h);
      onClose();
      return;
    }

    onClose();
    const targetRoute = {
      name: "reader" as const,
      worldId: h.targetId,
      ...(resolved.lineId ? { lineId: resolved.lineId } : {}),
      initialSection: h.sectionIndex,
      initialParagraph: h.paragraphIndex,
      ...(h.nodeId ? { initialNodeId: h.nodeId } : {}),
    };
    if (onJumpHighlight && matchesOpenWorld) {
      replace(targetRoute);
    } else {
      push(targetRoute);
    }
  };

  const saveNote = async (id: string) => {
    await updateReaderHighlight(game.repo, id, { note: noteDraft.trim() });
    setEditingId(null);
    toast("已保存批注");
    await load();
  };

  const changeColor = async (id: string, color: HighlightColor) => {
    await updateReaderHighlight(game.repo, id, { color });
    await load();
  };

  const removeOne = async (h: ReaderHighlight) => {
    if (!(await ask({ title: "删除这条摘录？", message: "划线与批注都会移除。", confirm: "删除", danger: true }))) {
      return;
    }
    await removeReaderHighlight(game.repo, h.id);
    toast("已删除摘录");
    await load();
  };

  const exportMarkdown = async () => {
    if (!shown.length) return;
    const md = exportHighlightsMarkdown(shown, titles);
    try {
      if (await game.platform.files.exportText("佳句摘录.md", md)) {
        toast("已导出 Markdown 摘录");
      }
    } catch {
      toast("导出失败，请稍后再试");
    }
  };

  return (
    <Sheet title="佳句摘录簿" onClose={onClose}>
      <div className="stack gap-3">
        {hasScopedTarget && (
          <div className="segmented" role="group" aria-label="摘录范围">
            <button type="button" aria-pressed={scope === "current"} onClick={() => setScope("current")}>
              当前书卷
            </button>
            <button type="button" aria-pressed={scope === "all"} onClick={() => setScope("all")}>
              全部摘录
            </button>
          </div>
        )}

        {items.length > 0 && (
          <>
            <div className="row wrap gap-1" role="group" aria-label="批注色标">
              <button
                type="button"
                className={`ghost small${colorFilter === "all" ? " active" : ""}`}
                aria-pressed={colorFilter === "all"}
                onClick={() => setColorFilter("all")}
              >
                全部（{items.length}）
              </button>
              {COLOR_META.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  className="ghost small"
                  aria-pressed={colorFilter === c.id}
                  onClick={() => setColorFilter(c.id)}
                >
                  <span
                    aria-hidden="true"
                    style={{
                      display: "inline-block",
                      width: 10,
                      height: 10,
                      borderRadius: "50%",
                      background: c.dot,
                      marginRight: 6,
                    }}
                  />
                  {c.label}
                </button>
              ))}
            </div>
            <input
              type="search"
              aria-label="查找摘录"
              placeholder="按原句、批注或章回查找"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </>
        )}

        {loading && !items.length ? (
          <p className="muted m-0">正在翻阅摘录簿…</p>
        ) : !items.length ? (
          <EmptyVignette
            kind="blank-bamboo"
            title="还没有记下佳句摘录"
            hint="在阅读器里选中文字或长按段落划线批注，或在故事段落菜单点「收入佳句摘录」，都会收在这里。"
          />
        ) : !shown.length ? (
          <EmptyVignette
            kind="mist-search"
            title="没有找到相符的摘录"
            hint="换个关键词或切换色标看看。"
            compact
          />
        ) : (
          <div className="stack gap-2">
            {shown.map((h) => {
              const colorInfo = COLOR_META.find((c) => c.id === h.color) ?? COLOR_META[0]!;
              const bookTitle = targetName(h);
              return (
                <article
                  key={h.id}
                  className="stack gap-2"
                  style={{
                    padding: "12px 14px",
                    borderRadius: "var(--radius)",
                    background: "var(--surface)",
                    border: "1px solid var(--line)",
                    borderLeft: `3px solid ${colorInfo.dot}`,
                  }}
                >
                  <div className="row between wrap gap-1">
                    <small className="muted">
                      《{bookTitle}》 · {h.sectionTitle || `第 ${h.sectionIndex + 1} 节`}
                    </small>
                    <small className="muted">{h.createdAt.slice(0, 10)}</small>
                  </div>
                  <p className="m-0" style={{ fontFamily: "var(--serif)", lineHeight: 1.75, whiteSpace: "pre-wrap" }}>
                    {h.selectedText}
                  </p>
                  {editingId === h.id ? (
                    <div className="stack gap-2">
                      <textarea
                        rows={2}
                        aria-label="批注内容"
                        placeholder="写下一句眉批或感想…"
                        value={noteDraft}
                        onChange={(e) => setNoteDraft(e.target.value)}
                      />
                      <div className="row end gap-1">
                        <button type="button" className="ghost small" onClick={() => setEditingId(null)}>
                          取消
                        </button>
                        <button type="button" className="primary small" onClick={() => void saveNote(h.id)}>
                          保存批注
                        </button>
                      </div>
                    </div>
                  ) : (
                    h.note.trim() && (
                      <p className="muted m-0" style={{ fontSize: "0.9em", paddingLeft: 8, borderLeft: "2px solid var(--line)" }}>
                        批注：{h.note}
                      </p>
                    )
                  )}
                  <div className="row between wrap gap-1">
                    <div className="row gap-1" role="group" aria-label="切换划线颜色">
                      {COLOR_META.map((c) => (
                        <button
                          key={c.id}
                          type="button"
                          className="ghost small"
                          aria-label={`改为${c.label}`}
                          aria-pressed={h.color === c.id}
                          onClick={() => void changeColor(h.id, c.id)}
                          style={{ padding: "4px 8px", minHeight: 32 }}
                        >
                          <span
                            aria-hidden="true"
                            style={{
                              display: "inline-block",
                              width: 10,
                              height: 10,
                              borderRadius: "50%",
                              background: c.dot,
                            }}
                          />
                        </button>
                      ))}
                    </div>
                    <div className="row wrap gap-1">
                      <button
                        type="button"
                        className="ghost small"
                        onClick={() => {
                          setEditingId(h.id);
                          setNoteDraft(h.note);
                        }}
                      >
                        {h.note.trim() ? "改批注" : "写批注"}
                      </button>
                      <button
                        type="button"
                        className="ghost small"
                        onClick={() =>
                          setCardFor({
                            title: bookTitle,
                            heading: h.sectionTitle || undefined,
                            body: h.note.trim() ? `${h.selectedText}\n\n${SEPARATOR}\n\n批注：${h.note.trim()}` : h.selectedText,
                            date: h.createdAt.slice(0, 10),
                            place: "",
                            name: "",
                            seal: "摘录",
                          })
                        }
                      >
                        书摘卡
                      </button>
                      <button type="button" className="ghost small" onClick={() => void jumpTo(h)}>
                        去原文
                      </button>
                      <button type="button" className="ghost small danger-text" onClick={() => void removeOne(h)}>
                        删除
                      </button>
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        )}

        {shown.length > 0 && (
          <button type="button" onClick={() => void exportMarkdown()}>
            <Icon name="download" size={18} />
            导出当前列表（Markdown）
          </button>
        )}
      </div>

      {cardFor && <CardSheet content={cardFor} onClose={() => setCardFor(null)} />}
    </Sheet>
  );
}
