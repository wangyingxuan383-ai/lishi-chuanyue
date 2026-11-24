// Unit tests for R36 flagship reader controls, tap-zone math, typography/paper
// normalization, total book progress calculation, and TTS helpers.
import { describe, expect, it } from "vitest";
import { inferFrontMatterTitle } from "../../../engine/sources/resplit";
import { DEFAULT_READING, PAPER_TONES, normalizeReading } from "../../app/context";
import { resolveTapZone } from "../../components/Paginator";
import { computeBookProgressPct, computeReadingEtaText } from "../ReaderScreen";
import { formatSleepRemaining, isSpeakableParagraph } from "./readerTts";

describe("resolveTapZone", () => {
  it("resolves classic left / center / right zones regardless of vertical position", () => {
    expect(resolveTapZone(0.05, 0.1, "classic")).toBe("prev");
    expect(resolveTapZone(0.279, 0.9, "classic")).toBe("prev");
    expect(resolveTapZone(0.28, 0.5, "classic")).toBe("center");
    expect(resolveTapZone(0.5, 0.85, "classic")).toBe("center");
    expect(resolveTapZone(0.72, 0.2, "classic")).toBe("center");
    expect(resolveTapZone(0.721, 0.15, "classic")).toBe("next");
    expect(resolveTapZone(0.95, 0.95, "classic")).toBe("next");
  });

  it("resolves onehand mode: top-left prev, top-center HUD, entire bottom 64% + right side next", () => {
    // Top-left (relX < 0.26 && relY < 0.62) -> prev
    expect(resolveTapZone(0.1, 0.2, "onehand")).toBe("prev");
    expect(resolveTapZone(0.25, 0.61, "onehand")).toBe("prev");

    // Bottom-left (relX < 0.26 && relY >= 0.62) -> next (thumb comfort zone!)
    expect(resolveTapZone(0.1, 0.62, "onehand")).toBe("next");
    expect(resolveTapZone(0.2, 0.88, "onehand")).toBe("next");

    // Top-center (0.26..0.74 && relY < 0.36) -> center HUD
    expect(resolveTapZone(0.26, 0.12, "onehand")).toBe("center");
    expect(resolveTapZone(0.5, 0.35, "onehand")).toBe("center");
    expect(resolveTapZone(0.74, 0.2, "onehand")).toBe("center");

    // Mid/Bottom center (relY >= 0.36) -> next
    expect(resolveTapZone(0.5, 0.36, "onehand")).toBe("next");
    expect(resolveTapZone(0.4, 0.75, "onehand")).toBe("next");

    // Right column (relX > 0.74) at any height -> next
    expect(resolveTapZone(0.75, 0.1, "onehand")).toBe("next");
    expect(resolveTapZone(0.92, 0.5, "onehand")).toBe("next");
  });
});

describe("normalizeReading (R36 typography, paper tones, and paged options)", () => {
  it("preserves clean R36 defaults when migrating empty settings", () => {
    const r = normalizeReading({});
    expect(r).toEqual(DEFAULT_READING);
    expect(r.fontFamily).toBe("serif");
    expect(r.paperTone).toBe("default");
    expect(r.nightDim).toBe(0);
    expect(r.pageMargin).toBe("normal");
    expect(r.letterSpacing).toBe(0.03);
    expect(r.pageTurnAnim).toBe("cover");
    expect(r.tapZones).toBe("classic");
    expect(r.volumeKeyTurn).toBe(true);
    expect(r.readerFooter).toBe(true);
    expect(r.focusMode).toBe(false);
  });

  it("clamps continuous font size (14..28), nightDim (0..50), and letterSpacing (0..0.12)", () => {
    expect(normalizeReading({ size: 8 }).size).toBe(14);
    expect(normalizeReading({ size: 42 }).size).toBe(28);
    expect(normalizeReading({ size: 21.4 }).size).toBe(21);

    expect(normalizeReading({ nightDim: -15 }).nightDim).toBe(0);
    expect(normalizeReading({ nightDim: 85 }).nightDim).toBe(50);
    expect(normalizeReading({ nightDim: 27.6 }).nightDim).toBe(28);

    expect(normalizeReading({ letterSpacing: -0.2 }).letterSpacing).toBe(0);
    expect(normalizeReading({ letterSpacing: 0.5 }).letterSpacing).toBe(0.12);
    expect(normalizeReading({ letterSpacing: 0.06 }).letterSpacing).toBe(0.06);
  });

  it("synchronizes legacy serif boolean and 4 CJK fontFamily presets", () => {
    expect(normalizeReading({ serif: false })).toMatchObject({ fontFamily: "sans", serif: false });
    expect(normalizeReading({ serif: true })).toMatchObject({ fontFamily: "serif", serif: true });
    expect(normalizeReading({ fontFamily: "kai" })).toMatchObject({ fontFamily: "kai", serif: true });
    expect(normalizeReading({ fontFamily: "round" })).toMatchObject({ fontFamily: "round", serif: false });
    expect(normalizeReading({ fontFamily: "unknown" as never, serif: false })).toMatchObject({
      fontFamily: "sans",
      serif: false,
    });
  });

  it("validates all 7 paper tones, pageTurnAnim, pageMargin, tapZones, and booleans", () => {
    for (const tone of PAPER_TONES) {
      expect(normalizeReading({ paperTone: tone.id }).paperTone).toBe(tone.id);
    }
    expect(normalizeReading({ paperTone: "neon" as never }).paperTone).toBe("default");
    expect(normalizeReading({ pageTurnAnim: "fade" }).pageTurnAnim).toBe("fade");
    expect(normalizeReading({ pageTurnAnim: "flip3d" as never }).pageTurnAnim).toBe("cover");
    expect(normalizeReading({ pageMargin: "wide" }).pageMargin).toBe("wide");
    expect(normalizeReading({ pageMargin: "huge" as never }).pageMargin).toBe("normal");
    expect(normalizeReading({ tapZones: "onehand" }).tapZones).toBe("onehand");
    expect(normalizeReading({ tapZones: "weird" as never }).tapZones).toBe("classic");
    expect(
      normalizeReading({ volumeKeyTurn: false, readerFooter: false, focusMode: true }),
    ).toMatchObject({
      volumeKeyTurn: false,
      readerFooter: false,
      focusMode: true,
    });
  });
});

describe("computeBookProgressPct", () => {
  it("returns null for empty TOC and 0..100 for character-weighted chapters", () => {
    expect(computeBookProgressPct([], 0, 0)).toBeNull();

    const toc = [{ chars: 1000 }, { chars: 3000 }];
    expect(computeBookProgressPct(toc, 0, 0)).toBe(0);
    expect(computeBookProgressPct(toc, 0, 0.5)).toBe(12.5);
    expect(computeBookProgressPct(toc, 1, 0)).toBe(25);
    expect(computeBookProgressPct(toc, 1, 0.5)).toBe(62.5);
    expect(computeBookProgressPct(toc, 1, 1)).toBe(100);
  });

  it("clamps out-of-range section indices and zero-char chapters safely", () => {
    const emptyChars = [{ chars: 0 }, { chars: 0 }, { chars: 0 }, { chars: 0 }];
    expect(computeBookProgressPct(emptyChars, -2, -1)).toBe(0);
    expect(computeBookProgressPct(emptyChars, 2, 0)).toBe(50);
    expect(computeBookProgressPct(emptyChars, 99, 2)).toBe(100);
  });
});

describe("readerTts helpers", () => {
  it("skips ornament dividers and blank lines while keeping prose paragraphs", () => {
    expect(isSpeakableParagraph(undefined)).toBe(false);
    expect(isSpeakableParagraph({ kind: "divider", text: "◇ 第三日 ◇" })).toBe(false);
    expect(isSpeakableParagraph({ kind: "prose", text: "   ◇ ✦ —  " })).toBe(false);
    expect(isSpeakableParagraph({ kind: "prose", text: "长安西市的暮鼓敲响了。" })).toBe(true);
  });

  it("formats sleep timer countdowns cleanly", () => {
    expect(formatSleepRemaining(null)).toBe("");
    expect(formatSleepRemaining(0)).toBe("");
    expect(formatSleepRemaining(65)).toBe("01:05");
    expect(formatSleepRemaining(900)).toBe("15:00");
  });
});

describe("computeReadingEtaText & front-matter naming (R36 R2-C)", () => {
  it("estimates remaining chapter reading minutes at ~420 chars/min", () => {
    expect(computeReadingEtaText(0, 0, false)).toBeNull();
    expect(computeReadingEtaText(4200, 0, false)).toBe("剩 10 分钟");
    expect(computeReadingEtaText(4200, 0.5, false)).toBe("剩 5 分钟");
    expect(computeReadingEtaText(1000, 0.75, false)).toBe("剩 <1 分钟");
    expect(computeReadingEtaText(4200, 1, false)).toBe("本章末");
    expect(computeReadingEtaText(4200, 0.8, true)).toBe("本章末");
  });

  it("infers intuitive front-matter headings instead of ambiguous '正文'", () => {
    expect(inferFrontMatterTitle("作品简介：风起陇右。")).toBe("作品简介");
    expect(inferFrontMatterTitle("内容简介\n一段江湖往事。")).toBe("内容简介");
    expect(inferFrontMatterTitle("序章 寒江独钓")).toBe("序章 寒江独钓");
    expect(inferFrontMatterTitle("引子：雪落长安。")).toBe("引子");
    expect(inferFrontMatterTitle("没有任何标题标记的开篇导语。")).toBe("前言");
  });
});
