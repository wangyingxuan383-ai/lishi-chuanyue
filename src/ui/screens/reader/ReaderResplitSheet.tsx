// TXT chapter re-splitter sheet for ReaderScreen (R36-T005).
// Lets players switch between 5 chapter-matching presets, customize regex or fixed char count,
// inspect live preview counts & sample headings, and atomically rebuild the book's TOC.
import { useEffect, useMemo, useState } from "react";
import {
  RESPLIT_PRESETS,
  applyBookResplit,
  previewBookResplit,
  type ResplitPresetId,
  type ResplitPreview,
  type ResplitRule,
} from "../../../engine/sources/resplit";
import { useApp } from "../../app/context";
import { Sheet } from "../../components/Sheet";

const FIXED_CHAR_CHOICES: [number, string][] = [
  [2500, "约 2500 字"],
  [4000, "约 4000 字"],
  [6000, "约 6000 字"],
  [8000, "约 8000 字"],
];

export interface ReaderResplitSheetProps {
  bookId: string;
  bookTitle: string;
  onApplied: (newSectionCount: number) => void | Promise<void>;
  onClose: () => void;
}

export function ReaderResplitSheet({
  bookId,
  bookTitle,
  onApplied,
  onClose,
}: ReaderResplitSheetProps) {
  const { game, toast } = useApp();
  const [preset, setPreset] = useState<ResplitPresetId>("standard");
  const [customPattern, setCustomPattern] = useState("^第[0-9一二三四五六七八九十百千]+话.*");
  const [fixedChars, setFixedChars] = useState(4000);
  const [preview, setPreview] = useState<ResplitPreview | null>(null);
  const [previewError, setPreviewError] = useState("");
  const [previewBusy, setPreviewBusy] = useState(true);
  const [applying, setApplying] = useState(false);

  const rule = useMemo<ResplitRule>(
    () => ({
      preset,
      customPattern: preset === "custom" ? customPattern : undefined,
      fixedChars: preset === "fixed_length" ? fixedChars : undefined,
    }),
    [customPattern, fixedChars, preset],
  );

  useEffect(() => {
    let live = true;
    setPreviewBusy(true);
    setPreviewError("");
    const timer = setTimeout(() => {
      void previewBookResplit(game.repo, bookId, rule)
        .then((res) => {
          if (!live) return;
          setPreview(res);
          setPreviewError(res.sectionCount === 0 ? "没有匹配到任何章节内容，请调整分章规则" : "");
        })
        .catch((err: unknown) => {
          if (!live) return;
          setPreview(null);
          setPreviewError(err instanceof Error ? err.message : "预览分章失败，请换个规则试试");
        })
        .finally(() => {
          if (live) setPreviewBusy(false);
        });
    }, 160);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [bookId, game.repo, rule]);

  const handleApply = async () => {
    if (applying || !preview || preview.sectionCount <= 0) return;
    setApplying(true);
    try {
      const res = await applyBookResplit(game.repo, bookId, rule);
      await onApplied(res.sectionCount);
      toast(`已重建《${bookTitle}》目录，共 ${res.sectionCount} 章`);
      onClose();
    } catch (err: unknown) {
      toast(err instanceof Error ? err.message : "重建目录失败，请重试");
    } finally {
      setApplying(false);
    }
  };

  const activeMeta = RESPLIT_PRESETS.find((p) => p.id === preset) ?? RESPLIT_PRESETS[0]!;

  return (
    <Sheet title="重分章节目录" onClose={onClose}>
      <div className="stack gap-3">
        <p className="muted m-0">
          若导入的 TXT 章节合并或漏识别，可切换分章规则实时预览。书签、划线与本局绑定不会丢失。
        </p>

        <div className="setting">
          <div className="setting-head">
            <b>分章规则</b>
            <small>示例：{activeMeta.example}</small>
          </div>
          <div className="resplit-preset-grid" role="radiogroup" aria-label="分章规则预设">
            {RESPLIT_PRESETS.map((item) => (
              <button
                key={item.id}
                type="button"
                role="radio"
                aria-checked={preset === item.id}
                className={`resplit-preset-card${preset === item.id ? " is-active" : ""}`}
                onClick={() => setPreset(item.id)}
              >
                <b>{item.label}</b>
                <small>{item.desc}</small>
              </button>
            ))}
          </div>
        </div>

        {preset === "fixed_length" && (
          <div className="setting">
            <div className="setting-head">
              <b>每节目标字数</b>
              <small>按自然段切分，不会把一句话截成两半</small>
            </div>
            <div className="segmented">
              {FIXED_CHAR_CHOICES.map(([chars, label]) => (
                <button
                  key={chars}
                  type="button"
                  aria-pressed={fixedChars === chars}
                  onClick={() => setFixedChars(chars)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        )}

        {preset === "custom" && (
          <label className="setting">
            <div className="setting-head">
              <b>自定义章节正则表达式</b>
              <small>按行匹配（不超过 85 字的标题行），如 ^第[0-9一二三四五六七八九十百千]+话.*</small>
            </div>
            <input
              type="text"
              aria-label="自定义章节正则表达式"
              value={customPattern}
              onChange={(e) => setCustomPattern(e.target.value)}
              placeholder="^第[0-9一二三四五六七八九十百千]+话.*"
              autoCapitalize="off"
              spellCheck={false}
            />
          </label>
        )}

        <div className="resplit-preview-box" aria-live="polite">
          {previewBusy ? (
            <p className="muted m-0">正在扫描全书并预览目录…</p>
          ) : previewError ? (
            <div className="resplit-error">
              <b>未能识别章节</b>
              <small>{previewError}</small>
            </div>
          ) : preview ? (
            <div className="stack gap-2">
              <div className="row between center">
                <b>预览结果：共 {preview.sectionCount} 章</b>
                <small className="muted">前 {preview.sampleTitles.length} 章示例</small>
              </div>
              <ol className="resplit-sample-list">
                {preview.sampleTitles.map((title, idx) => (
                  <li key={idx}>
                    <span className="resplit-idx">{idx + 1}.</span>
                    <span>{title}</span>
                  </li>
                ))}
              </ol>
              {preview.sectionCount > preview.sampleTitles.length && (
                <small className="muted m-0">
                  ……其余 {preview.sectionCount - preview.sampleTitles.length} 章也将一并生成目录
                </small>
              )}
            </div>
          ) : null}
        </div>

        <div className="row gap-2">
          <button type="button" className="ghost" onClick={onClose} disabled={applying}>
            取消
          </button>
          <button
            type="button"
            className="primary grow"
            disabled={applying || previewBusy || !!previewError || !preview || preview.sectionCount <= 0}
            onClick={() => void handleApply()}
          >
            {applying ? "正在重建目录…" : "应用并重建目录"}
          </button>
        </div>
      </div>
    </Sheet>
  );
}
