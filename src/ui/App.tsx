import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getPlatform, type Platform } from "../platform";
import { Game, type LlmConfig } from "../engine/game";
import { chatCompletionsUrl, listProfiles, type Profile } from "../engine/llm/providers";
import { AppProvider, DEFAULT_READING, THEME_KEY, resolvedTheme, useToast, type AppValue, type Reading, type Route } from "./app/context";
import { Dialog, type DialogRequest } from "./components/Dialog";
import { Seal } from "./components/Seal";
import { archiveProblems, importWorld } from "../engine/archive";
import { useMouse } from "./components/useMedia";
import { useShortcuts } from "./components/useShortcuts";
import Home from "./screens/Home";
import Setup, { sweepDraftKey } from "./screens/Setup";
import NewGame from "./screens/NewGame";
import Play from "./screens/Play";
import Settings from "./screens/Settings";
import Guide from "./screens/Guide";

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

/** Each theme's --bg (styles), for the phone's status and navigation bars. */
const BAR_COLORS = { paper: "#efe5cf", day: "#faf7f0", night: "#131518" } as const;

function applyReading(r: Reading) {
  const root = document.documentElement;
  const theme = resolvedTheme(r.theme);
  root.dataset.theme = theme;
  void getPlatform().then((p) => p.system.setSystemBars(BAR_COLORS[theme], theme === "night")).catch(() => {});
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

/**
 * Drag a .lishi.json world file onto the window to import it (UX_APP_BASICS #59).
 * Tauri's own drop handling is off (dragDropEnabled: false), so the WebView
 * gets ordinary HTML drop events with the file's contents, as in a browser.
 * Anything else dropped is ignored, and the window never navigates to it.
 */
function useDropImport(value: AppValue | null, imported: () => void) {
  const latest = useRef({ value, imported });
  latest.current = { value, imported };
  useEffect(() => {
    const hasFiles = (e: DragEvent) => !!e.dataTransfer && [...e.dataTransfer.types].includes("Files");
    const over = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = latest.current.value ? "copy" : "none";
    };
    const drop = async (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      const app = latest.current.value;
      const file = e.dataTransfer?.files[0];
      if (!app || !file) return;
      if (!/\.json$/i.test(file.name)) { app.toast("只能导入本游戏导出的世界文件（.lishi.json）"); return; }
      if (file.size > 64 * 1024 * 1024) { app.toast("没有导入：文件太大"); return; }
      let data: unknown = null;
      try { data = JSON.parse(await file.text()); } catch { /* reported below */ }
      const problems = archiveProblems(data);
      if (problems.length) { app.toast(`没有导入：${problems[0]}`); return; }
      const world = (data as { world: { id: string; title: string } }).world;
      let mode: "new" | "replace" = "replace";
      // The same world is already here: keep both, never overwrite from a drop.
      if (await app.game.repo.getWorld(world.id)) {
        if (!await app.ask({ title: `已经有“${world.title}”了`, message: "另存为新的世界，两个都留着，新的标“导入”。要覆盖现有的，请在首页用“从文件导入世界…”。", confirm: "另存为新的世界" })) return;
        mode = "new";
      }
      try {
        await importWorld(app.game.repo, data, mode);
      } catch {
        app.toast("没有导入，请再试一次");
        return;
      }
      app.toast(mode === "new" ? "已另存为新的世界" : `已导入“${world.title}”`);
      latest.current.imported();
    };
    const onDrop = (e: DragEvent) => void drop(e);
    window.addEventListener("dragover", over);
    window.addEventListener("drop", onDrop);
    return () => { window.removeEventListener("dragover", over); window.removeEventListener("drop", onDrop); };
  }, []);
}

export default function App() {
  const [boot, setBoot] = useState<{ platform: Platform; game: Game } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [profile, setProfileState] = useState<Profile | null>(null);
  const [reading, setReadingState] = useState<Reading>(DEFAULT_READING);
  const [devMode, setDevModeState] = useState(false);
  const [stack, setStack] = useState<Route[]>([{ name: "home" }]);
  const [toastState, toast, clearToast] = useToast();
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
      void sweepDraftKey(platform, game.repo).catch(() => {});
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
  // Each request gets its own id as the dialog's key, so re-renders keep what was typed;
  // a new request answers the one it replaces as cancelled.
  const dialogId = useRef(0);
  const openDialog = useCallback((next: DialogRequest) => setDialog((old) => {
    if (old) (old.resolve as (v: boolean | string | null) => void)(old.kind === "confirm" ? false : null);
    return next;
  }), []);
  const ask = useCallback((o: { title: string; message?: string; confirm: string; danger?: boolean }) =>
    new Promise<boolean>((resolve) => openDialog({ kind: "confirm", ...o, id: ++dialogId.current, resolve })), [openDialog]);
  const askName = useCallback((o: { title: string; initial?: string; placeholder?: string; confirm?: string }) =>
    new Promise<string | null>((resolve) => openDialog({ kind: "name", ...o, initial: o.initial ?? "", id: ++dialogId.current, resolve })), [openDialog]);

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

  // A dropped world shows up on the home screen at once.
  const [homeKey, setHomeKey] = useState(0);
  useDropImport(value, () => setHomeKey((k) => k + 1));
  // Outside the play screen (which has its own, longer list): settings and the guide from anywhere.
  const mouse = useMouse();
  const here = value?.route.name;
  useShortcuts({
    "Ctrl+,": { inInputs: true, run: () => { if (!value || here === "settings") return false; value.push({ name: "settings" }); } },
    "F1": { inInputs: true, run: () => { if (!value || here === "guide") return false; value.push({ name: "guide" }); } },
  }, mouse && !!value && here !== "play");

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
      {route.name === "home" && <Home key={homeKey} />}
      {route.name === "setup" && <Setup first={route.first} profileId={route.profileId} />}
      {route.name === "newgame" && <NewGame />}
      {route.name === "play" && <Play key={route.worldId} worldId={route.worldId} />}
      {route.name === "settings" && <Settings />}
      {route.name === "guide" && <Guide />}
      {toastState && (
        <div className="toast" role="status">
          <span>{toastState.text}</span>
          {toastState.action && <button className="toast-action" onClick={() => { const run = toastState.action!.run; clearToast(); run(); }}>{toastState.action.label}</button>}
        </div>
      )}
      {dialog && <Dialog key={dialog.id} request={dialog} onDone={() => setDialog(null)} />}
    </AppProvider>
  );
}
