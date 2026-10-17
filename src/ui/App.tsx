import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getPlatform, type Platform } from "../platform";
import { Game, type LlmConfig } from "../engine/game";
import { chatCompletionsUrl, listProfiles, type Profile } from "../engine/llm/providers";
import { AppProvider, DEFAULT_READING, THEME_KEY, resolvedTheme, useToast, type AppValue, type Reading, type Route } from "./app/context";
import { Dialog, type DialogRequest } from "./components/Dialog";
import { Seal } from "./components/Seal";
import Home from "./screens/Home";
import Setup from "./screens/Setup";
import NewGame from "./screens/NewGame";
import Play from "./screens/Play";
import Settings from "./screens/Settings";

export function llmFor(profile: Profile | null): LlmConfig | null {
  if (!profile) return null;
  return {
    slot: profile.keySlot,
    url: chatCompletionsUrl(profile.baseUrl),
    model: profile.mainModel,
    auxModel: profile.auxModel ?? undefined,
    includeUsage: profile.includeUsage,
    contextTokens: profile.contextTokens,
  };
}

function applyReading(r: Reading) {
  const root = document.documentElement;
  root.dataset.theme = resolvedTheme(r.theme);
  root.dataset.font = r.serif ? "serif" : "sans";
  root.dataset.motion = r.motion;
  root.dataset.indent = r.indent ? "on" : "off";
  root.dataset.haptics = r.haptics ? "on" : "off";
  try { localStorage.setItem(THEME_KEY, r.theme); } catch { /* storage may be unavailable */ }
  root.style.setProperty("--story-size", `${r.size}px`);
  // Sans text reads better a little tighter (AUDIT_V4 10.3).
  root.style.setProperty("--story-leading", String(r.serif ? r.leading : Math.max(1.6, r.leading - 0.2)));
  root.style.setProperty("--story-paragraph", `${r.paragraph}em`);
  root.style.setProperty("--story-measure", `${r.measure}em`);
}

/** Keeps the screen on while the setting asks for it (Screen Wake Lock, where the WebView has it). */
function useKeepAwake(on: boolean) {
  useEffect(() => {
    const nav = navigator as Navigator & { wakeLock?: { request(type: "screen"): Promise<{ release(): Promise<void> }> } };
    if (!on || !nav.wakeLock) return;
    let lock: { release(): Promise<void> } | null = null;
    const take = () => { if (document.visibilityState === "visible") void nav.wakeLock!.request("screen").then((l) => { lock = l; }).catch(() => {}); };
    take();
    document.addEventListener("visibilitychange", take);
    return () => { document.removeEventListener("visibilitychange", take); void lock?.release().catch(() => {}); };
  }, [on]);
}

export default function App() {
  const [boot, setBoot] = useState<{ platform: Platform; game: Game } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [profile, setProfileState] = useState<Profile | null>(null);
  const [reading, setReadingState] = useState<Reading>(DEFAULT_READING);
  const [devMode, setDevModeState] = useState(false);
  const [stack, setStack] = useState<Route[]>([{ name: "home" }]);
  const [toastState, toast, clearToast] = useToast();
  useKeepAwake(reading.keepAwake);
  // "Follow the system" follows it live, too.
  useEffect(() => {
    if (reading.theme !== "auto") return;
    const query = matchMedia("(prefers-color-scheme: dark)");
    const change = () => applyReading(reading);
    query.addEventListener("change", change);
    return () => query.removeEventListener("change", change);
  }, [reading]);
  const [dialog, setDialog] = useState<DialogRequest | null>(null);
  const exitArmed = useRef(false);

  useEffect(() => {
    void (async () => {
      const platform = await getPlatform();
      const game = await Game.open(platform);
      void game.autoBackup();
      // Dev builds only: lets UI scripts build large test worlds (scripts/ui/long-world.mjs).
      if (import.meta.env.DEV) (window as unknown as { __lishi: unknown }).__lishi = { game };
      const profiles = await listProfiles(game.repo);
      const activeId = await game.repo.getSetting<string | null>("activeProfile", null);
      const active = profiles.find((p) => p.id === activeId) ?? profiles[0] ?? null;
      game.llm = llmFor(active);
      const r = { ...DEFAULT_READING, ...(await game.repo.getSetting<Partial<Reading>>("reading", {})) };
      // The network choice applies to every request from the start.
      const network = await game.repo.getSetting<{ proxy: "none" | "system" | "custom"; proxyUrl?: string | null }>("network", { proxy: "none" });
      void platform.llm.setNetwork(network).catch(() => {});
      applyReading(r);
      setReadingState(r);
      setDevModeState(await game.repo.getSetting("devMode", false));
      setProfileState(active);
      const recovered = active ? await game.recoverPending().catch(() => null) : null;
      const welcomed = await game.repo.getSetting("welcomed", false);
      setStack(recovered ? [{ name: "home" }, { name: "play", worldId: recovered }] : !active && !welcomed ? [{ name: "home" }, { name: "setup", first: true }] : [{ name: "home" }]);
      setBoot({ platform, game });
    })().catch((e) => setError(String(e?.message ?? e)));
  }, []);

  // A message belongs to the screen it was shown on (AUDIT_V4 1.10): moving on clears it.
  const push = useCallback((r: Route) => { clearToast(); setStack((s) => [...s, r]); }, [clearToast]);
  const replace = useCallback((r: Route) => { clearToast(); setStack((s) => [...s.slice(0, -1), r]); }, [clearToast]);
  const pop = useCallback(() => { clearToast(); setStack((s) => (s.length > 1 ? s.slice(0, -1) : s)); }, [clearToast]);
  const ask = useCallback((o: { title: string; message?: string; confirm: string; danger?: boolean }) =>
    new Promise<boolean>((resolve) => setDialog({ kind: "confirm", ...o, resolve })), []);
  const askName = useCallback((o: { title: string; initial?: string; placeholder?: string; confirm?: string }) =>
    new Promise<string | null>((resolve) => setDialog({ kind: "name", ...o, initial: o.initial ?? "", resolve })), []);

  // Screen-level back, registered once so overlays opened later run first:
  // pop the stack; on the home screen, press twice to exit.
  const depth = useRef(1);
  depth.current = stack.length;
  useEffect(() => {
    if (!boot) return;
    return boot.platform.system.onBack(() => {
      if (depth.current > 1) {
        pop();
        return true;
      }
      // Only Android's back button can leave the app; Escape on a desktop stops here.
      if (boot.platform.name !== "android") return false;
      if (exitArmed.current) return false;
      exitArmed.current = true;
      toast("再按一次退出");
      setTimeout(() => (exitArmed.current = false), 2000);
      return true;
    });
  }, [boot, pop, toast]);

  const value = useMemo<AppValue | null>(() => boot && {
    platform: boot.platform,
    game: boot.game,
    profile,
    setProfile(p) {
      setProfileState(p);
      boot.game.llm = llmFor(p);
      void boot.game.repo.setSetting("activeProfile", p?.id ?? null);
    },
    reading,
    setReading(r) {
      applyReading(r);
      setReadingState(r);
      void boot.game.repo.setSetting("reading", r);
    },
    devMode,
    setDevMode(v) {
      setDevModeState(v);
      void boot.game.repo.setSetting("devMode", v);
    },
    route: stack[stack.length - 1],
    push, replace, pop, toast, ask, askName,
  }, [boot, profile, reading, devMode, stack, push, replace, pop, toast, ask, askName]);

  if (error) return <div className="screen-body"><p>启动失败：{error}</p></div>;
  if (!value) {
    return (
      <div className="boot" role="status" aria-label="正在打开">
        <Seal />
        <p className="boot-name">历史穿越</p>
        <p className="muted">正在打开…</p>
      </div>
    );
  }
  const route = value.route;
  return (
    <AppProvider value={value}>
      {route.name === "home" && <Home />}
      {route.name === "setup" && <Setup first={route.first} profileId={route.profileId} />}
      {route.name === "newgame" && <NewGame />}
      {route.name === "play" && <Play key={route.worldId} worldId={route.worldId} />}
      {route.name === "settings" && <Settings />}
      {toastState && (
        <div className="toast" role="status">
          <span>{toastState.text}</span>
          {toastState.action && <button className="toast-action" onClick={() => { const run = toastState.action!.run; clearToast(); run(); }}>{toastState.action.label}</button>}
        </div>
      )}
      {dialog && <Dialog key={String(Math.random())} request={dialog} onDone={() => setDialog(null)} />}
    </AppProvider>
  );
}
