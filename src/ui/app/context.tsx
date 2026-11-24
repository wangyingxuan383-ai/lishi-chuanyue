// App-wide services, navigation stack and the Android back chain.
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { EXIT_MS, motionOn } from "./motion";
import type { Platform } from "../../platform";
import type { Game } from "../../engine/game";
import type { Profile } from "../../engine/llm/providers";
import type { CompanionScreenProps } from "../screens/CompanionScreen";

export interface ReaderRouteProps {
  bookId?: string;
  worldId?: string;
  lineId?: string;
  initialSection?: number;
  initialParagraph?: number;
  initialNodeId?: string;
  through?: number | null;
  fanfic?: boolean;
}

export type Route =
  | { name: "home" }
  | { name: "setup"; first?: boolean; profileId?: string }
  | { name: "newgame"; resumeRunId?: string }
  | { name: "play"; worldId: string; resumeRunId?: string }
  | { name: "agent"; worldId: string; lineId: string; sessionId?: string; initialText?: string; skills?: string[]; target?: { nodeId: string; paragraph?: number; evidence?: import("../../engine/types").FactCitation[] } }
  | ({ name: "companion" } & CompanionScreenProps)
  | ({ name: "reader" } & ReaderRouteProps)
  | { name: "settings" }
  | { name: "guide" };

export type ReaderPaperTone = "default" | "xuan" | "pure" | "bamboo" | "almond" | "smoke" | "oled";
export type ReaderFontFamily = "serif" | "sans" | "kai" | "round";
export type PageTurnAnim = "cover" | "slide" | "fade" | "none";
export type ReaderTapZones = "classic" | "onehand";
export type ReaderPageMargin = "compact" | "normal" | "wide";
export type HomePrimaryTab = "stories" | "library";

export const PAPER_TONES: { id: ReaderPaperTone; label: string; bg: string; fg: string; dark: boolean }[] = [
  { id: "default", label: "随主题", bg: "", fg: "", dark: false },
  { id: "xuan", label: "宣纸", bg: "#efe5cf", fg: "#2a2019", dark: false },
  { id: "pure", label: "素白", bg: "#faf8f3", fg: "#231f1b", dark: false },
  { id: "bamboo", label: "青竹绿", bg: "#dcebd8", fg: "#1d2d21", dark: false },
  { id: "almond", label: "杏仁纸", bg: "#f2e4cc", fg: "#302318", dark: false },
  { id: "smoke", label: "松烟夜", bg: "#181a1e", fg: "#e5dac6", dark: true },
  { id: "oled", label: "纯黑屏", bg: "#050506", fg: "#d6ccb8", dark: true },
];

export const FONT_FAMILIES: [ReaderFontFamily, string][] = [
  ["serif", "宋体"],
  ["kai", "楷体"],
  ["sans", "黑体"],
  ["round", "圆体"],
];

export const PAGE_TURN_ANIMS: [PageTurnAnim, string][] = [
  ["cover", "覆页"],
  ["slide", "平滑"],
  ["fade", "淡入"],
  ["none", "无动画"],
];

export interface Reading {
  size: number;
  /** "auto" follows the system: paper by day, night when the phone is dark. */
  theme: "auto" | "paper" | "day" | "night";
  serif: boolean;
  /** Four curated CJK reading font stacks; synchronized with `serif` for legacy consumers. */
  fontFamily: ReaderFontFamily;
  /** Line height of the story text. */
  leading: number;
  /** Space between paragraphs, in em. */
  paragraph: number;
  /** Indent paragraphs two characters, like a Chinese book. */
  indent: boolean;
  /** Widest the story column gets on a big screen, in characters. */
  measure: number;
  /** Look of the whole app: 宣纸书卷 (default) or 墨韵·新中式. */
  style: "scroll" | "ink";
  /** Animations: rich (default), simple, or off. The system's "reduce motion" always means off. */
  motion: "rich" | "simple" | "off";
  /** A short vibration on long press. */
  haptics: boolean;
  /** Keep the screen on while reading and writing. */
  keepAwake: boolean;
  /** Follow newly generated story text to the bottom / last page. */
  autoScroll: boolean;
  /** A small line under the latest passage with what it cost. */
  usageLine: boolean;
  /** Top-level home space: interactive穿越 stories vs local novel reader 书斋. */
  homeTab: HomePrimaryTab;
  /** Within 穿越: landscape scroll view vs 3D bookcase view. */
  home: "scene" | "shelf";
  /** Vertical scroll or horizontal CSS multi-column book pages. */
  pageMode: "scroll" | "paged";
  /** Dedicated eye-care paper tone inside the reader ("default" follows app theme). */
  paperTone: ReaderPaperTone;
  /** Extra eye-comfort dim veil percentage (0..50) for late-night reading. */
  nightDim: number;
  /** Horizontal & vertical page breathing room in reader/paged view. */
  pageMargin: ReaderPageMargin;
  /** Character tracking in em (0..0.12). */
  letterSpacing: number;
  /** Horizontal page-turn animation style. */
  pageTurnAnim: PageTurnAnim;
  /** Tap zone preset: classic left/center/right vs one-handed full-screen next page. */
  tapZones: ReaderTapZones;
  /** Turn pages with Android hardware Volume Up/Down keys while reading. */
  volumeKeyTurn: boolean;
  /** Show quiet status footer (chapter, page, book %, clock, battery) in reader. */
  readerFooter: boolean;
  /** Do-not-disturb focus mode while reading (suppresses background story toasts). */
  focusMode: boolean;
}
export const DEFAULT_READING: Reading = {
  size: 18,
  theme: "paper",
  style: "scroll",
  serif: true,
  fontFamily: "serif",
  leading: 2,
  paragraph: 0.7,
  indent: true,
  measure: 36,
  motion: "rich",
  haptics: true,
  keepAwake: false,
  autoScroll: false,
  usageLine: true,
  homeTab: "stories",
  home: "scene",
  pageMode: "scroll",
  paperTone: "default",
  nightDim: 0,
  pageMargin: "normal",
  letterSpacing: 0.03,
  pageTurnAnim: "cover",
  tapZones: "classic",
  volumeKeyTurn: true,
  readerFooter: true,
  focusMode: false,
};
/** Saved reading settings from older versions: "system" animations became "rich". */
export function normalizeReading(saved: Partial<Reading> & { motion?: string; style?: string; pageMode?: string }): Reading {
  const hasExplicitFont = saved.fontFamily !== undefined;
  const r = { ...DEFAULT_READING, ...saved } as Reading;
  r.size = Number.isFinite(r.size) ? Math.min(28, Math.max(14, Math.round(r.size))) : 18;
  r.leading = Number.isFinite(r.leading) ? Math.min(2.6, Math.max(1.4, Number(r.leading.toFixed(2)))) : 2;
  r.paragraph = Number.isFinite(r.paragraph) ? Math.min(1.6, Math.max(0.2, Number(r.paragraph.toFixed(2)))) : 0.7;
  r.measure = Number.isFinite(r.measure) ? Math.min(52, Math.max(26, Math.round(r.measure))) : 36;
  if (!["rich", "simple", "off"].includes(r.motion)) r.motion = "rich";
  if (r.style !== "ink") r.style = "scroll";
  if (r.homeTab !== "library") r.homeTab = "stories";
  if (r.home !== "shelf") r.home = "scene";
  if (r.pageMode !== "paged") r.pageMode = "scroll";
  if (!hasExplicitFont) {
    r.fontFamily = saved.serif === false ? "sans" : "serif";
  } else if (!["serif", "sans", "kai", "round"].includes(r.fontFamily)) {
    r.fontFamily = r.serif ? "serif" : "sans";
  }
  r.serif = r.fontFamily === "serif" || r.fontFamily === "kai";
  if (!["default", "xuan", "pure", "bamboo", "almond", "smoke", "oled"].includes(r.paperTone)) {
    r.paperTone = "default";
  }
  r.nightDim = Number.isFinite(r.nightDim) ? Math.min(50, Math.max(0, Math.round(r.nightDim))) : 0;
  if (!["compact", "normal", "wide"].includes(r.pageMargin)) r.pageMargin = "normal";
  r.letterSpacing = Number.isFinite(r.letterSpacing)
    ? Math.min(0.12, Math.max(0, Number(r.letterSpacing.toFixed(3))))
    : 0.03;
  if (!["cover", "slide", "fade", "none"].includes(r.pageTurnAnim)) r.pageTurnAnim = "cover";
  if (r.tapZones !== "onehand") r.tapZones = "classic";
  r.volumeKeyTurn = typeof r.volumeKeyTurn === "boolean" ? r.volumeKeyTurn : true;
  r.readerFooter = typeof r.readerFooter === "boolean" ? r.readerFooter : true;
  r.focusMode = typeof r.focusMode === "boolean" ? r.focusMode : false;
  return r;
}
/** The theme a setting resolves to now. */
export const resolvedTheme = (theme: Reading["theme"]): "paper" | "day" | "night" =>
  theme === "auto" ? (matchMedia?.("(prefers-color-scheme: dark)").matches ? "night" : "paper") : theme;
/** The theme is remembered outside the database too, so the first frame already has it. */
export const THEME_KEY = "lishi.theme";
export const STYLE_KEY = "lishi.style";

export interface AppValue {
  platform: Platform;
  game: Game;
  profile: Profile | null;
  setProfile(p: Profile | null): void;
  reading: Reading;
  setReading(r: Reading): void;
  devMode: boolean;
  setDevMode(v: boolean): void;
  route: Route;
  push(r: Route): void;
  replace(r: Route): void;
  pop(): void;
  /** A short message; with an action (e.g. 撤回) it stays a little longer. */
  toast(text: string, action?: ToastAction): void;
  /** The app's own confirmation: resolves true when the player confirms. */
  ask(o: { title: string; message?: string; confirm: string; danger?: boolean }): Promise<boolean>;
  /** The app's own name prompt: resolves the trimmed name, or null when cancelled. */
  askName(o: { title: string; initial?: string; placeholder?: string; confirm?: string }): Promise<string | null>;
}

export interface ToastAction { label: string; run: () => void }
export interface ToastState { text: string; action?: ToastAction; leaving?: boolean }

const AppContext = createContext<AppValue | null>(null);

export function useApp(): AppValue {
  const value = useContext(AppContext);
  if (!value) throw new Error("useApp outside provider");
  return value;
}

export function AppProvider({ value, children }: { value: AppValue; children: ReactNode }) {
  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

/** Registers a back handler while `active`; the newest registration runs first. */
export function useBack(handler: () => boolean, active = true) {
  const { platform } = useApp();
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    if (!active) return;
    return platform.system.onBack(() => ref.current());
  }, [platform, active]);
}

export function useToast(): [ToastState | null, (text: string, action?: ToastAction) => void, () => void] {
  const [toast, setToast] = useState<ToastState | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const show = useCallback((text: string, action?: ToastAction) => {
    setToast({ text, action });
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      if (!motionOn()) { setToast(null); return; }
      setToast((t) => t && { ...t, leaving: true });
      timer.current = setTimeout(() => setToast(null), EXIT_MS);
    }, action ? 5000 : 2200);
  }, []);
  const clear = useCallback(() => { clearTimeout(timer.current); setToast(null); }, []);
  return [toast, show, clear];
}
