// 字号与主题: the reading settings used most, one tap from the story or built-in reader.
// Shares the same Reading state as 设置 → 阅读与外观; changes apply live behind the sheet.
import { FONT_FAMILIES, PAGE_TURN_ANIMS, useApp, type Reading } from "../../app/context";
import { Sheet } from "../../components/Sheet";
import { Switch } from "../../components/Switch";
import {
  Choice,
  FontSizeControl,
  LETTER_SPACING_OPTIONS,
  NightDimControl,
  PaperTonePicker,
  STYLES,
  THEMES,
  resolveLetterSpacingBucket,
} from "../Settings";

export function ReadingQuickSheet({ onClose }: { onClose: () => void }) {
  const { reading, setReading } = useApp();
  const set = (patch: Partial<Reading>) => setReading({ ...reading, ...patch });

  return (
    <Sheet title="排版与护眼" onClose={onClose}>
      <div className="stack gap-2 reading-quick-stack">
        <PaperTonePicker value={reading.paperTone} onChange={(paperTone) => set({ paperTone })} />
        <NightDimControl value={reading.nightDim} onChange={(nightDim) => set({ nightDim })} />
        <FontSizeControl size={reading.size} onChange={(size) => set({ size })} />

        <Choice
          label="阅读方式"
          value={reading.pageMode}
          options={[
            ["scroll", "上下滚动"],
            ["paged", "左右翻页"],
          ]}
          onChange={(pageMode) => set({ pageMode })}
        />

        {reading.pageMode === "paged" && (
          <>
            <Choice
              label="翻页动效"
              value={reading.pageTurnAnim}
              options={PAGE_TURN_ANIMS}
              onChange={(pageTurnAnim) => set({ pageTurnAnim })}
            />
            <Choice
              label="点击翻页区"
              value={reading.tapZones}
              options={[
                ["classic", "经典左中右"],
                ["onehand", "单手全屏下一页"],
              ]}
              onChange={(tapZones) => set({ tapZones })}
            />
            <Switch
              label="音量键翻页"
              note="按手机音量上下键翻页"
              checked={reading.volumeKeyTurn}
              onChange={(volumeKeyTurn) => set({ volumeKeyTurn })}
            />
          </>
        )}

        <Choice
          label="字体"
          value={reading.fontFamily}
          options={FONT_FAMILIES}
          onChange={(fontFamily) =>
            set({ fontFamily, serif: fontFamily === "serif" || fontFamily === "kai" })
          }
        />

        <div className="setting">
          <div className="setting-head">
            <b>应用明暗</b>
          </div>
          <div className="theme-cards">
            {THEMES.map(([v, l]) => (
              <button
                key={v}
                type="button"
                aria-pressed={reading.theme === v}
                className={`theme-card theme-${v}`}
                onClick={() => set({ theme: v })}
              >
                <span className="swatch" aria-hidden="true" />
                {l}
              </button>
            ))}
          </div>
        </div>

        <Choice
          label="外观风格"
          value={reading.style}
          options={STYLES.map(([v, l]) => [v, l] as [typeof v, string])}
          onChange={(style) => set({ style })}
        />

        <Choice
          label="行距"
          value={reading.leading}
          options={[
            [1.7, "紧"],
            [2, "适中"],
            [2.3, "松"],
          ]}
          onChange={(leading) => set({ leading })}
        />

        <Choice
          label="页边距"
          value={reading.pageMargin}
          options={[
            ["compact", "紧凑"],
            ["normal", "标准"],
            ["wide", "宽裕"],
          ]}
          onChange={(pageMargin) => set({ pageMargin })}
        />

        <Choice
          label="字间距"
          value={resolveLetterSpacingBucket(reading.letterSpacing)}
          options={LETTER_SPACING_OPTIONS}
          onChange={(letterSpacing) => set({ letterSpacing })}
        />

        <Switch
          label="常驻页脚状态栏"
          note="显示章节、全书进度、时间与电量"
          checked={reading.readerFooter}
          onChange={(readerFooter) => set({ readerFooter })}
        />

        <Switch
          label="阅读专注免打扰"
          note="专注阅读时静默后台打扰提示"
          checked={reading.focusMode}
          onChange={(focusMode) => set({ focusMode })}
        />
      </div>
    </Sheet>
  );
}
