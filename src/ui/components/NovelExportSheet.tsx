import { useEffect, useState } from "react";
import {
  buildNovelBook,
  formatNovelMarkdown,
  formatNovelTxt,
  novelFileName,
  type NovelBook,
} from "../../engine/novel";
import { saveBook } from "../../engine/sources/library";
import { useApp } from "../app/context";
import { TitleCartouche } from "./ChineseArt";
import { Icon } from "./Icon";
import { Sheet } from "./Sheet";

type ExportFormat = "epub" | "txt" | "md";

function formatCharTotal(chars: number): string {
  if (chars >= 10_000) {
    return `${(chars / 10_000).toFixed(1).replace(/\.0$/, "")} 万字`;
  }
  return `${chars.toLocaleString()} 字`;
}

function downloadBytesFallback(name: string, bytes: Uint8Array, mime: string): boolean {
  if (typeof document === "undefined" || typeof URL === "undefined") return false;
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const blob = new Blob([copy], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  return true;
}

export interface NovelExportSheetProps {
  worldId: string;
  lineId?: string;
  worldTitle?: string;
  onClose: () => void;
}

export function NovelExportSheet({ worldId, lineId, worldTitle, onClose }: NovelExportSheetProps) {
  const { game, push, toast } = useApp();
  const [format, setFormat] = useState<ExportFormat>("epub");
  const [includePreface, setIncludePreface] = useState(true);
  const [includeChronicle, setIncludeChronicle] = useState(true);
  const [includeActions, setIncludeActions] = useState(false);
  const [book, setBook] = useState<NovelBook | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let live = true;
    setLoading(true);
    setError("");
    void buildNovelBook(game.repo, worldId, {
      lineId,
      includePreface,
      includeChronicle,
      includeActions,
    })
      .then((built) => {
        if (!live) return;
        setBook(built);
        if (!built) setError("暂时没能整理出这部故事的正文。");
      })
      .catch((e: unknown) => {
        if (!live) return;
        setError(e instanceof Error ? e.message : "整理小说章节时出错，请稍后再试。");
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [game.repo, includeActions, includeChronicle, includePreface, lineId, worldId]);

  const exportNow = async () => {
    if (!book || busy) return;
    setBusy(true);
    try {
      if (format === "epub") {
        const { buildEpubBytes } = await import("../../engine/epub");
        const bytes = buildEpubBytes(book);
        const fileName = novelFileName(book.title, "epub");
        const ok = game.platform.files.exportBytes
          ? await game.platform.files.exportBytes(fileName, bytes, "application/epub+zip")
          : downloadBytesFallback(fileName, bytes, "application/epub+zip");
        if (ok) {
          toast("已导出 EPUB 3 电子书");
          onClose();
        }
        return;
      }
      if (format === "txt") {
        const text = formatNovelTxt(book);
        const ok = await game.platform.files.exportText(novelFileName(book.title, "txt"), text);
        if (ok) {
          toast("已导出精排 TXT 小说");
          onClose();
        }
        return;
      }
      const md = formatNovelMarkdown(book);
      const ok = await game.platform.files.exportText(novelFileName(book.title, "md"), md);
      if (ok) {
        toast("已导出 Markdown 小说");
        onClose();
      }
    } catch (e: unknown) {
      toast(e instanceof Error ? e.message : "导出失败，请稍后重试");
    } finally {
      setBusy(false);
    }
  };

  const saveToLibrary = async () => {
    if (!book || busy) return;
    setBusy(true);
    try {
      const [{ buildEpubBytes }, { parseBook }] = await Promise.all([
        import("../../engine/epub"),
        import("../../engine/sources/parse"),
      ]);
      const bytes = buildEpubBytes(book);
      const parsed = await parseBook(
        { name: novelFileName(book.title, "epub"), bytes },
        game.platform,
      );
      await saveBook(game.repo, parsed);
      toast(`已将《${book.title}》存入参考书库`);
    } catch (e: unknown) {
      toast(e instanceof Error ? e.message : "存入书库失败，请稍后再试");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet title={worldTitle ? `导出《${worldTitle}》` : "导出成正式小说"} onClose={onClose}>
      <div className="stack gap-3">
        {book && (
          <div className="stack gap-1">
            <TitleCartouche
              title={`《${book.title}》`}
              subtitle={book.subtitle}
              seal={book.seal.slice(0, 2)}
            />
            <p className="muted t-center m-0">
              共 {book.chapterCount} 回 · {book.turnCount} 段剧情 · 约 {formatCharTotal(book.totalChars)} · {book.statusLine.replace(/——\s*|\s*——/g, "")}
            </p>
          </div>
        )}
        {loading && !book && <p className="muted m-0">正在整理章回与卷首小传…</p>}
        {error && <p className="notice m-0" role="alert">{error}</p>}

        <div className="stack gap-2">
          <span className="muted">成书格式</span>
          <div className="segmented" role="group" aria-label="成书格式">
            <button type="button" aria-pressed={format === "epub"} onClick={() => setFormat("epub")}>
              EPUB 3 电子书
            </button>
            <button type="button" aria-pressed={format === "txt"} onClick={() => setFormat("txt")}>
              精排 TXT
            </button>
            <button type="button" aria-pressed={format === "md"} onClick={() => setFormat("md")}>
              Markdown
            </button>
          </div>
          <small className="muted m-0">
            {format === "epub"
              ? "自带线装封面、可跳转章回目录与首行缩进排版，可用本应用阅读器或主流读书软件直接打开。"
              : format === "txt"
                ? "标准中文段首两格缩进与「第X回」章名格式，主流本地阅读软件可自动识别目录。"
                : "结构化章回与分隔标记，便于二次润色、归档或发布。"}
          </small>
        </div>

        <div className="stack gap-2">
          <span className="muted">装帧与附录</span>
          <label className="row between">
            <span>附卷首「人物与前情」</span>
            <input
              type="checkbox"
              className="check-20"
              checked={includePreface}
              onChange={(e) => setIncludePreface(e.target.checked)}
            />
          </label>
          <label className="row between">
            <span>附卷尾「本局大事纪年」</span>
            <input
              type="checkbox"
              className="check-20"
              checked={includeChronicle}
              onChange={(e) => setIncludeChronicle(e.target.checked)}
            />
          </label>
          <label className="row between">
            <span className="grow">
              保留玩家行动记录
              <small className="muted" style={{ display: "block" }}>
                默认隐去「你选择/指令」痕迹，让正文读起来像一部完整小说
              </small>
            </span>
            <input
              type="checkbox"
              className="check-20"
              checked={includeActions}
              onChange={(e) => setIncludeActions(e.target.checked)}
            />
          </label>
        </div>

        <button
          type="button"
          className="primary"
          disabled={!book || loading || busy}
          onClick={() => void exportNow()}
        >
          <Icon name="download" size={18} />
          {busy
            ? "正在生成书卷…"
            : format === "epub"
              ? "导出 EPUB 3 电子书"
              : format === "txt"
                ? "导出精排 TXT"
                : "导出 Markdown"}
        </button>

        <div className="row wrap">
          <button
            type="button"
            className="ghost grow"
            disabled={!book || busy}
            onClick={() => {
              onClose();
              push({ name: "reader", worldId, lineId });
            }}
          >
            <Icon name="book-open" size={18} />
            先在阅读器里翻阅
          </button>
          <button
            type="button"
            className="ghost grow"
            disabled={!book || busy}
            onClick={() => void saveToLibrary()}
          >
            <Icon name="bookshelf" size={18} />
            存入参考书库
          </button>
        </div>
      </div>
    </Sheet>
  );
}
