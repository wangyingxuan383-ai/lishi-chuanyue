// App-wide services, navigation stack and the Android back chain.
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { EXIT_MS, motionOn } from "./motion";
import type { Platform } from "../../platform";
import type { Game } from "../../engine/game";
import type { Profile } from "../../engine/llm/providers";

export type Route =
  | { name: "home" }
  | { name: "setup"; first?: boolean; profileId?: string }
  | { name: "newgame" }
  | { name: "play"; worldId: string }
  | { name: "agent"; worldId: string; lineId: string; sessionId?: string; initialText?: string; skills?: string[]; target?: { nodeId: string; paragraph?: number; evidence?: import("../../engine/types").FactCitation[] } }
  | { name: "settings" }
  | { name: "guide" };

export interface Reading {
  size: number;
  /** "auto" follows the system: paper by day, night when the phone is dark. */
  theme: "auto" | "paper" | "day" | "night";
  serif: boolean;
  /** Line height of the story text. */
  leading: number;
  /** Space between paragraphs, in em. */
  paragraph: number;
  /** Indent paragraphs two characters, like a Chinese book. */
  indent: boolean;
  /** Widest the story column gets on a big screen, in characters. */
  measure: number;
  /** Look of the whole app (D160): 宣纸书卷 (default) or 墨韵·新中式. */
  style: "scroll" | "ink";
  /** Animations (D160): rich (default), simple, or off. The system's "reduce motion" always means off. */
  motion: "rich" | "simple" | "off";
  /** A short vibration on long press. */
  haptics: boolean;
  /** Keep the screen on while reading and writing. */
  keepAwake: boolean;
  /** Follow newly generated story text to the bottom. */
  autoScroll: boolean;
}
export const DEFAULT_READING: Reading = { size: 18, theme: "paper", style: "scroll", serif: true, leading: 2, paragraph: 0.7, indent: true, measure: 36, motion: "rich", haptics: true, keepAwake: false, autoScroll: false };
/** Saved reading settings from older versions: "system" animations became "rich". */
export function normalizeReading(saved: Partial<Reading> & { motion?: string; style?: string }): Reading {
  const r = { ...DEFAULT_READING, ...saved } as Reading;
  if (!["rich", "simple", "off"].includes(r.motion)) r.motion = "rich";
  if (r.style !== "ink") r.style = "scroll";
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
  /** The app's own confirmation (R11-T003): resolves true when the player confirms. */
  ask(o: { title: string; message?: string; confirm: string; danger?: boolean }): Promise<boolean>;
  /** The app's own name prompt: resolves the trimmed name, or null when cancelled. */
  askName(o: { title: string; initial?: string; placeholder?: string; confirm?: string }): Promise<string | null>;
}

export interface ToastAction { label: string; run: () => void }
export interface ToastState { text: string; action?: ToastAction; /** Fading out (R28); removed a moment later. */ leaving?: boolean }

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
      // Fade out first, then remove; a new toast in between replaces it.
      if (!motionOn()) { setToast(null); return; }
      setToast((t) => t && { ...t, leaving: true });
      timer.current = setTimeout(() => setToast(null), EXIT_MS);
    }, action ? 5000 : 2200);
  }, []);
  const clear = useCallback(() => { clearTimeout(timer.current); setToast(null); }, []);
  return [toast, show, clear];
}
