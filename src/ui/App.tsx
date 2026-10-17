import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getPlatform, type Platform } from "../platform";
import { Game, type LlmConfig } from "../engine/game";
import { chatCompletionsUrl, listProfiles, type Profile } from "../engine/llm/providers";
import { AppProvider, DEFAULT_READING, useToast, type AppValue, type Reading, type Route } from "./app/context";
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
  root.dataset.theme = r.theme;
  root.dataset.font = r.serif ? "serif" : "sans";
  root.style.setProperty("--story-size", `${r.size}px`);
}

export default function App() {
  const [boot, setBoot] = useState<{ platform: Platform; game: Game } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [profile, setProfileState] = useState<Profile | null>(null);
  const [reading, setReadingState] = useState<Reading>(DEFAULT_READING);
  const [devMode, setDevModeState] = useState(false);
  const [stack, setStack] = useState<Route[]>([{ name: "home" }]);
  const [toastText, toast] = useToast();
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

  const push = useCallback((r: Route) => setStack((s) => [...s, r]), []);
  const replace = useCallback((r: Route) => setStack((s) => [...s.slice(0, -1), r]), []);
  const pop = useCallback(() => setStack((s) => (s.length > 1 ? s.slice(0, -1) : s)), []);

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
    push, replace, pop, toast,
  }, [boot, profile, reading, devMode, stack, push, replace, pop, toast]);

  if (error) return <div className="screen-body"><p>启动失败：{error}</p></div>;
  if (!value) return <div className="screen-body"><p className="muted">正在打开…</p></div>;
  const route = value.route;
  return (
    <AppProvider value={value}>
      {route.name === "home" && <Home />}
      {route.name === "setup" && <Setup first={route.first} profileId={route.profileId} />}
      {route.name === "newgame" && <NewGame />}
      {route.name === "play" && <Play key={route.worldId} worldId={route.worldId} />}
      {route.name === "settings" && <Settings />}
      {toastText && <div className="toast" role="status">{toastText}</div>}
    </AppProvider>
  );
}
