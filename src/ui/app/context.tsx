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
  toast(text: string): void;
}

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

export function useToast(): [string | null, (text: string) => void] {
  const [text, setText] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const show = useCallback((t: string) => {
    setText(t);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setText(null), 2200);
  }, []);
  return [text, show];
}
