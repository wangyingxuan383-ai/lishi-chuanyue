// App-wide services, navigation stack and the Android back chain.
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type { Platform } from "../../platform";
import type { Game } from "../../engine/game";
import type { Profile } from "../../engine/llm/providers";

export type Route =
  | { name: "home" }
  | { name: "setup"; first?: boolean; profileId?: string }
  | { name: "newgame" }
  | { name: "play"; worldId: string }
  | { name: "settings" };

export interface Reading {
  size: number;
  theme: "paper" | "day" | "night";
  serif: boolean;
}
export const DEFAULT_READING: Reading = { size: 18, theme: "paper", serif: true };
/** The theme is remembered outside the database too, so the first frame already has it. */
export const THEME_KEY = "lishi.theme";

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
export interface ToastState { text: string; action?: ToastAction }

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
    timer.current = setTimeout(() => setToast(null), action ? 5000 : 2200);
  }, []);
  const clear = useCallback(() => { clearTimeout(timer.current); setToast(null); }, []);
  return [toast, show, clear];
}
