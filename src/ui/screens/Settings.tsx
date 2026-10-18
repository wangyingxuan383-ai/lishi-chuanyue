// Settings (R11-T006, docs/research/UX_SETTINGS_AI.md §5, UX_APP_BASICS):
// a home list in three groups — AI, 游戏, 应用 — each entry a page of its own,
// with the current state on the entry. What used to be one long page is split
// so each part can grow without the whole getting noisy.
import { useEffect, useState, type ReactNode } from "react";
import { deleteProfile, listProfiles, saveProfile, type Profile } from "../../engine/llm/providers";
import type { Intensity, Perspective } from "../../engine/types";
import { FORTUNE_MODES, FORTUNE_MODE_NOTE } from "../../engine/fortune";
import type { Row } from "../../platform";
import { useApp, useBack, type Reading } from "../app/context";
import { BUILTIN_DEFAULTS, loadPlayDefaults, savePlayDefaults, type PlayDefaults } from "../app/playDefaults";
import { REPO_URL, latestRelease, openLink, newer, plainNotes, type ReleaseInfo } from "../app/update";
import { exportWorld } from "../../engine/archive";
import { PURPOSES } from "../components/Usage";
import { Seal } from "../components/Seal";
import { BackupRestore } from "../components/BackupRestore";
import { Icon } from "../components/Icon";
import { MonthlyBudgetSettings, budgetState } from "../components/MonthlyBudget";
import { WhatsNewSheet } from "../components/WhatsNew";
import { UpdateButton, UpdateDevSource } from "../components/UpdateSheet";

const OUTCOMES: Record<string, string> = { ok: "成功", refused: "被拒", no_record: "没有结果", failed: "失败", stale: "已过时，未采用", cancelled: "已取消" };
type Page = "home" | "services" | "writing" | "memory" | "play" | "reading" | "notify" | "data" | "network" | "about" | "dev" | "budget";
const TITLES: Record<Page, string> = {
  budget: "用量与花费",
  home: "设置", services: "AI 服务", writing: "写作与叙事（新开一局的默认）", memory: "记忆与整理", play: "游玩默认",
  reading: "阅读与外观", notify: "通知与提醒", data: "存档与数据", network: "网络与代理", about: "关于与更新", dev: "开发者",
};
const THEMES: [Reading["theme"], string][] = [["auto", "跟随系统"], ["paper", "纸张"], ["day", "白天"], ["night", "夜间"]];
const SIZES: [number, string][] = [[16, "小"], [18, "中"], [20, "大"], [22, "特大"]];

export default function Settings() {
  const { game, pop, push, profile, reading, devMode } = useApp();
  const [page, setPage] = useState<Page>("home");
  const [defaults, setDefaults] = useState<PlayDefaults>(BUILTIN_DEFAULTS);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [notify, setNotify] = useState<{ granted: boolean; enabled: boolean } | null>(null);
  const [network, setNetwork] = useState<{ proxy: "none" | "system" | "custom"; proxyUrl?: string | null }>({ proxy: "none" });
  const [spend, setSpend] = useState("预算与单价");
  useEffect(() => {
    void loadPlayDefaults(game.repo).then(setDefaults);
    void budgetState(game).then(setSpend).catch(() => setSpend("预算与单价"));
    void listProfiles(game.repo).then(setProfiles);
    void game.platform.system.notificationStatus().then(setNotify).catch(() => setNotify(null));
    void game.repo.getSetting("network", { proxy: "none" as const }).then(setNetwork);
  }, [page]);
  // Back from a page goes to the settings home, not out of settings.
  useBack(() => { if (page === "home") return false; setPage("home"); return true; }, page !== "home");

  const theme = THEMES.find(([v]) => v === reading.theme)?.[1] ?? "纸张";
  const android = game.platform.name === "android";
  const entries: { group: string; items: { page: Page; label: string; state: string; hidden?: boolean }[] }[] = [
    { group: "AI", items: [
      { page: "services", label: "AI 服务", state: profile ? `${profile.name} · ${profile.mainModel}` : "还没有连接" },
      { page: "writing", label: "写作与叙事", state: `${defaults.style} · ${defaults.length}篇幅 · 第${defaults.perspective === "你" ? "二" : defaults.perspective === "我" ? "一" : "三"}人称` },
      { page: "memory", label: "记忆与整理", state: `${({ 8000: "省一些", 12000: "标准", 16000: "记得更多" } as Record<number, string>)[profile?.contextTokens ?? 12000] ?? "标准"} · ${defaults.chapterEvery ? `每 ${defaults.chapterEvery} 回合一章` : "不写章节"}` },
    ] },
    { group: "游戏", items: [
      { page: "play", label: "游玩默认", state: `难度${defaults.difficulty} · 建议选项 ${defaults.choiceCount || "不要"}` },
      { page: "reading", label: "阅读与外观", state: `${theme} · ${SIZES.find(([s]) => s === reading.size)?.[1] ?? "中"}号 · ${reading.serif ? "宋体" : "黑体"}` },
      { page: "guide" as Page, label: "游玩指南", state: "怎么玩、各个功能在哪、常见问题" },
      { page: "notify", label: "通知与提醒", state: !android ? "电脑上不需要" : notify?.enabled ? "已打开" : "没打开", hidden: !android && !devMode },
    ] },
    { group: "应用", items: [
      { page: "data", label: "存档与数据", state: "备份与导出" },
      { page: "budget", label: "用量与花费", state: spend },
      { page: "network", label: "网络与代理", state: network.proxy === "custom" ? "自定义代理" : network.proxy === "system" ? "跟随系统代理" : "直接连接" },
      { page: "about", label: "关于与更新", state: `版本 ${__APP_VERSION__}` },
      { page: "dev", label: "开发者", state: devMode ? "已打开" : "关", hidden: !devMode },
    ] },
  ];

  return (
    <div className="screen">
      <div className="topbar">
        <button className="icon-btn" aria-label="返回" onClick={() => (page === "home" ? pop() : setPage("home"))}><Icon name="back" /></button>
        <div className="title"><h1>{TITLES[page]}</h1></div>
      </div>
      <div className="screen-body stack settings">
        {page === "home" && entries.map((g) => (
          <section key={g.group} className="settings-group">
            <h2>{g.group}</h2>
            <div className="settings-list">
              {g.items.filter((i) => !i.hidden).map((i) => (
                <button key={i.page} className="settings-entry" onClick={() => (i.page === ("guide" as Page) ? push({ name: "guide" }) : setPage(i.page))}>
                  <span><b>{i.label}</b><small>{i.state}</small></span><span aria-hidden="true">›</span>
                </button>
              ))}
            </div>
          </section>
        ))}
        {page === "services" && <ServicesPage profiles={profiles} onChanged={() => void listProfiles(game.repo).then(setProfiles)} />}
        {page === "writing" && <WritingPage defaults={defaults} onChange={(d) => { setDefaults(d); void savePlayDefaults(game.repo, d); }} />}
        {page === "memory" && <MemoryPage defaults={defaults} onChange={(d) => { setDefaults(d); void savePlayDefaults(game.repo, d); }} />}
        {page === "play" && <PlayPage defaults={defaults} onChange={(d) => { setDefaults(d); void savePlayDefaults(game.repo, d); }} />}
        {page === "reading" && <ReadingPage />}
        {page === "notify" && <NotifyPage status={notify} onRefresh={() => void game.platform.system.notificationStatus().then(setNotify)} />}
        {page === "data" && <DataPage />}
        {page === "budget" && <MonthlyBudgetSettings />}
        {page === "network" && <NetworkPage value={network} onChange={setNetwork} />}
        {page === "about" && <AboutPage />}
        {page === "dev" && <DevPage />}
      </div>
    </div>
  );
}

/** One labelled choice row: a name, a line on what it does, the options. */
function Choice<T extends string | number | boolean>({ label, note, value, options, onChange }: {
  label: string; note?: string; value: T; options: [T, string][]; onChange: (v: T) => void;
}) {
  return (
    <div className="setting">
      <div className="setting-head"><b>{label}</b>{note && <small>{note}</small>}</div>
      <div className="segmented">
        {options.map(([v, l]) => <button key={String(v)} aria-pressed={value === v} onClick={() => onChange(v)}>{l}</button>)}
      </div>
    </div>
  );
}

function Note({ children }: { children: ReactNode }) {
  return <p className="settings-note">{children}</p>;
}

function ServicesPage({ profiles, onChanged }: { profiles: Profile[]; onChanged: () => void }) {
  const { game, push, profile, setProfile, toast, ask, askName } = useApp();
  return (
    <>
      <Note>故事由你自己的 AI 服务来写。可以连好几个，点一下就切换。</Note>
      <div className="list">
        {profiles.map((p) => (
          <div key={p.id} className={`card service-card${p.id === profile?.id ? " selected" : ""}`}>
            <button className="service-main" onClick={() => { if (p.id !== profile?.id) { setProfile(p); toast(`已改用“${p.name}”`); } }}>
              <h3>{p.name}{p.id === profile?.id && <span className="tag">正在用</span>}</h3>
              <p>{p.mainModel}{p.auxModel ? ` · 整理用 ${p.auxModel}` : ""}</p>
            </button>
            <div className="row service-actions">
              <button className="ghost" onClick={() => push({ name: "setup", profileId: p.id })}>修改</button>
              <button className="ghost" onClick={async () => {
                const name = await askName({ title: "重命名", initial: p.name });
                if (!name) return;
                const saved = await saveProfile(game.repo, { ...p, name }, null);
                if (p.id === profile?.id) setProfile(saved);
                onChanged();
              }}>改名</button>
              <button className="ghost danger-text" onClick={async () => {
                if (!await ask({ title: `删除“${p.name}”？`, message: "保存在这台设备上的 Key 也会一起删掉。", confirm: "删除", danger: true })) return;
                await deleteProfile(game.repo, p);
                const rest = profiles.filter((x) => x.id !== p.id);
                if (p.id === profile?.id) setProfile(rest[0] ?? null);
                onChanged();
                toast("已删除");
              }}>删除</button>
            </div>
          </div>
        ))}
        <button onClick={() => push({ name: "setup", profileId: "new" })}><Icon name="plus" size={18} />添加服务</button>
      </div>
    </>
  );
}

function WritingPage({ defaults, onChange }: { defaults: PlayDefaults; onChange: (d: PlayDefaults) => void }) {
  const set = <K extends keyof PlayDefaults>(k: K, v: PlayDefaults[K]) => onChange({ ...defaults, [k]: v });
  return (
    <>
      <Note>这里是新开一局时的默认写法。已经开始的故事不受影响，在游戏里的“本局设置”单独改。</Note>
      <Choice label="文风" note="叙述用白话，或带些古味" value={defaults.style} options={[["白话", "白话"], ["半文半白", "半文半白"]]} onChange={(v) => set("style", v)} />
      <Choice label="每段长短" value={defaults.length} options={[["短", "短（约 200 字）"], ["中", "中（约 400 字）"], ["长", "长（约 800 字）"]]} onChange={(v) => set("length", v)} />
      <Choice<Perspective> label="叙述视角" value={defaults.perspective} options={[["你", "你（第二人称）"], ["我", "我"], ["他", "他 / 她"]]} onChange={(v) => set("perspective", v)} />
      <Choice label="建议选项" note="每段末尾给几个可以直接点的行动" value={defaults.choiceCount} options={[[0, "不要"], [2, "2 个"], [3, "3 个"], [4, "4 个"]]} onChange={(v) => set("choiceCount", v)} />
      <label className="setting">
        <div className="setting-head"><b>每局都附加的要求</b><small>新开一局时放进“给 AI 的额外规则”，开局后还能改</small></div>
        <textarea rows={3} value={defaults.rules} onChange={(e) => set("rules", e.target.value)} placeholder="比如：多写人物对话；不要让主角轻易获得权力" />
      </label>
      <button className="ghost reset" onClick={() => onChange({ ...defaults, style: BUILTIN_DEFAULTS.style, length: BUILTIN_DEFAULTS.length, perspective: BUILTIN_DEFAULTS.perspective, choiceCount: BUILTIN_DEFAULTS.choiceCount, rules: "" })}>恢复默认</button>
    </>
  );
}

function MemoryPage({ defaults, onChange }: { defaults: PlayDefaults; onChange: (d: PlayDefaults) => void }) {
  const { game, profile, setProfile } = useApp();
  return (
    <>
      {profile && <Choice label="每回合给 AI 看多少前文" note={`跟着 AI 服务“${profile.name}”走。越多记得越清楚，但每回合更贵、更慢；更早的剧情靠章节摘要和设定集记住。`}
        value={profile.contextTokens ?? 12000} options={[[8000, "省一些"], [12000, "标准"], [16000, "记得更多"]]}
        onChange={async (n) => setProfile(await saveProfile(game.repo, { ...profile, contextTokens: n }, null))} />}
      <Choice label="章节摘要" note="每过这么多回合，AI 把这段剧情写成一章摘要，在“角色 · 记事”里看" value={defaults.chapterEvery}
        options={[[0, "关"], [8, "每 8 回合"], [12, "每 12 回合"], [20, "每 20 回合"]]} onChange={(v) => onChange({ ...defaults, chapterEvery: v })} />
      <Choice label="设定集自动整理" note="每过几回合，AI 把新出现的人物、地点、势力记进设定集；只改它自己写的卡，你写的不会动" value={defaults.autoUpkeep}
        options={[[true, "开"], [false, "关"]]} onChange={(v) => onChange({ ...defaults, autoUpkeep: v })} />
      <Note>章节和整理的设定是新开一局的默认，已经开始的故事在“本局设置”里改。</Note>
    </>
  );
}

function PlayPage({ defaults, onChange }: { defaults: PlayDefaults; onChange: (d: PlayDefaults) => void }) {
  const levels: [Intensity, string][] = [["含蓄", "含蓄"], ["写实", "写实"], ["浓烈", "浓烈"]];
  const intensity = (key: keyof PlayDefaults["intensity"], label: string) => (
    <Choice label={label} value={defaults.intensity[key]} options={levels} onChange={(v) => onChange({ ...defaults, intensity: { ...defaults.intensity, [key]: v } })} />
  );
  return (
    <>
      <Choice label="难度" value={defaults.difficulty}
        note={defaults.difficulty === "宽松" ? "运气偏好；受了重伤也只是昏过去，不会死。" : defaults.difficulty === "残酷" ? "运气偏差；重伤可能直接丧命。" : "运气平常；伤重时先“垂危”，剧情真写到才会死。"}
        options={[["宽松", "宽松"], ["标准", "标准"], ["残酷", "残酷"]]} onChange={(v) => onChange({ ...defaults, difficulty: v })} />
      <h3 className="settings-sub">玩法</h3>
      <Choice label="运势" note={FORTUNE_MODE_NOTE[defaults.fortune]} value={defaults.fortune} options={FORTUNE_MODES} onChange={(v) => onChange({ ...defaults, fortune: v })} />
      <Choice label="用词提醒" note={defaults.tabooHints ? "AI 用了这个朝代不该有的说法，下一段提醒它改。" : "不提醒，AI 偶尔会用到后世的说法。"} value={defaults.tabooHints}
        options={[[true, "开"], [false, "关"]]} onChange={(v) => onChange({ ...defaults, tabooHints: v })} />
      <Note>章节摘要和设定集自动整理在“记忆与整理”里。</Note>
      <h3 className="settings-sub">内容尺度</h3>
      {intensity("violence", "暴力与伤亡")}
      {intensity("romance", "感情与亲密")}
      {intensity("darkness", "黑暗与压抑")}
      <Note>“浓烈”仍受所用 AI 服务自己的规则限制。这些是新开一局的默认，已经开始的故事在“本局设置”里改。</Note>
      <button className="ghost reset" onClick={() => onChange({ ...defaults, difficulty: BUILTIN_DEFAULTS.difficulty, fortune: BUILTIN_DEFAULTS.fortune, tabooHints: BUILTIN_DEFAULTS.tabooHints, intensity: BUILTIN_DEFAULTS.intensity })}>恢复默认</button>
    </>
  );
}

function ReadingPage() {
  const { reading, setReading } = useApp();
  const set = (patch: Partial<Reading>) => setReading({ ...reading, ...patch });
  return (
    <>
      <div className="setting">
        <div className="setting-head"><b>主题</b><small>跟随系统：手机是浅色时用纸张，深色时用夜间</small></div>
        <div className="theme-cards">
          {THEMES.map(([v, l]) => (
            <button key={v} aria-pressed={reading.theme === v} className={`theme-card theme-${v}`} onClick={() => set({ theme: v })}><span className="swatch" aria-hidden="true" />{l}</button>
          ))}
        </div>
      </div>
      <Choice label="字号" value={reading.size} options={SIZES} onChange={(v) => set({ size: v })} />
      <Choice label="正文字体" value={reading.serif} options={[[true, "宋体"], [false, "黑体"]]} onChange={(v) => set({ serif: v })} />
      <Choice label="行距" value={reading.leading} options={[[1.7, "紧"], [2, "适中"], [2.3, "松"]]} onChange={(v) => set({ leading: v })} />
      <Choice label="段距" value={reading.paragraph} options={[[0.3, "紧"], [0.7, "适中"], [1.2, "松"]]} onChange={(v) => set({ paragraph: v })} />
      <Choice label="段首空两格" value={reading.indent} options={[[true, "空"], [false, "不空"]]} onChange={(v) => set({ indent: v })} />
      <div className="story-text reading-preview" aria-label="效果预览"><p>西市的鼓声一声接一声，你裹紧单衣，跟着人流走进坊门。</p><p>“郎君，买胡饼么？”炉边的老汉抬起头。</p></div>
      <h3 className="settings-sub">更多</h3>
      <Choice label="生成时自动滚动" note="打开后，跟着新写出的内容往下读" value={reading.autoScroll} options={[[true, "开"], [false, "关"]]} onChange={(v) => set({ autoScroll: v })} />
      <Choice label="动画" note="弹层、标签出现时的轻微动画" value={reading.motion} options={[["system", "跟随系统"], ["off", "关"]]} onChange={(v) => set({ motion: v })} />
      <Choice label="触感" note="长按时轻轻振一下" value={reading.haptics} options={[[true, "开"], [false, "关"]]} onChange={(v) => set({ haptics: v })} />
      <Choice label="阅读时不锁屏" note="只在读故事时生效" value={reading.keepAwake} options={[[true, "开"], [false, "关"]]} onChange={(v) => set({ keepAwake: v })} />
    </>
  );
}

function NotifyPage({ status, onRefresh }: { status: { granted: boolean; enabled: boolean } | null; onRefresh: () => void }) {
  const { game } = useApp();
  // Coming back from the system screen: read the switch again.
  useEffect(() => {
    const again = () => { if (document.visibilityState === "visible") onRefresh(); };
    document.addEventListener("visibilitychange", again);
    return () => document.removeEventListener("visibilitychange", again);
  }, []);
  const on = !!status?.enabled;
  return (
    <>
      <div className={`status-card${on ? " ok" : ""}`}>
        <b>{on ? "通知已打开" : "通知没打开"}</b>
        <small>{on ? "切到后台时，写的时候通知栏会显示进度，写好了会提醒你。" : "没有通知时，故事照样会在后台写，只是写好了不会提醒你。"}</small>
        {!on && <div className="row">
          <button className="primary" onClick={async () => { const granted = await game.platform.system.requestNotifications().catch(() => false); if (!granted) await game.platform.system.openSystemSettings("notifications"); onRefresh(); }}>打开通知</button>
        </div>}
      </div>
      <h3 className="settings-sub">在后台被系统停掉？</h3>
      <Note>小米、华为等手机为了省电，可能在后台停掉应用，故事写到一半就断了。可以在系统设置里给“历史穿越”放行：</Note>
      <ol className="steps">
        <li>省电策略选“无限制”（应用信息 → 省电策略）。</li>
        <li>打开“自启动”。</li>
        <li>在最近任务里下拉锁定“历史穿越”。</li>
      </ol>
      <button onClick={() => void game.platform.system.openSystemSettings("app")}>打开应用信息</button>
    </>
  );
}

function DataPage() {
  const { game, toast } = useApp();
  const [backups, setBackups] = useState<{ name: string; at: string; bytes?: number }[]>([]);
  const [worldCount, setWorldCount] = useState<number | null>(null);
  const load = () => {
    void game.platform.sql.listBackups().then((b) => setBackups([...b].sort((x, y) => Date.parse(y.at) - Date.parse(x.at)))).catch(() => setBackups([]));
    void game.platform.sql.query("SELECT COUNT(*) AS worlds FROM worlds WHERE archived < 2").then((r) => setWorldCount(Number(r[0].worlds)));
  };
  useEffect(load, []);
  const exportAll = async () => {
    const worlds = await game.repo.listWorlds();
    let done = 0;
    for (const w of worlds) {
      const archive = await exportWorld(game.repo, w.id);
      if (await game.platform.files.exportText(`${w.title}.lishi.json`, JSON.stringify(archive)).catch(() => false)) done++;
    }
    toast(done ? `已导出 ${done} 个世界` : "没有导出");
  };
  const fmt = (iso: string) => new Date(iso).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).replaceAll("/", "-");
  return (
    <>
      <div className="status-card ok">
        <b>{backups[0] ? `上次备份：${fmt(backups[0].at)}` : "还没有备份"}</b>
        <small>每天第一次打开时自动备份整个存档，保留最近 20 份，存在这台设备上的应用目录里。卸载应用会一起删掉，重要的世界请另外导出。</small>
        <div className="row">
          <button onClick={async () => { const done = await game.platform.sql.backup("manual").catch(() => null); toast(done ? "已备份" : "备份没成功"); load(); }}>现在备份</button>
        </div>
      </div>
      {backups.length > 0 && <details>
        <summary className="muted">从备份恢复（{backups.length} 份）</summary>
        <BackupRestore refresh={backups[0]?.name ?? ""} />
      </details>}
      <h3 className="settings-sub">导出</h3>
      <Note>导出的文件，在另一台手机或电脑的首页用“从文件导入世界…”打开。只导出一个世界：点首页卡片上的“⋯”。</Note>
      <button onClick={() => void exportAll()}>导出全部世界{worldCount !== null ? `（${worldCount} 个）` : ""}</button>
    </>
  );
}

function NetworkPage({ value, onChange }: { value: { proxy: "none" | "system" | "custom"; proxyUrl?: string | null }; onChange: (v: { proxy: "none" | "system" | "custom"; proxyUrl?: string | null }) => void }) {
  const { game, toast } = useApp();
  const [url, setUrl] = useState(value.proxyUrl ?? "");
  const [mode, setMode] = useState(value.proxy);
  const apply = async (next: { proxy: "none" | "system" | "custom"; proxyUrl?: string | null }) => {
    try {
      await game.platform.llm.setNetwork(next);
      await game.repo.setSetting("network", next);
      onChange(next);
      toast("已保存，下一次请求开始生效");
    } catch (e: any) {
      toast(e?.message ?? "代理地址不对");
    }
  };
  return (
    <>
      <Note>连不上海外服务（比如 OpenRouter、Gemini）时才需要改。国内的服务一般直接连接就好。</Note>
      <Choice label="连接方式" value={mode} options={[["none", "直接连接"], ["system", "跟随系统代理"], ["custom", "自定义代理"]]}
        onChange={(v) => { setMode(v); if (v !== "custom") void apply({ proxy: v }); }} />
      {mode === "system" && <Note>电脑上会用系统设置里的代理。手机上的应用请求不一定能读到系统代理【还没在手机上验证】，连不上时改用自定义代理。</Note>}
      {mode === "custom" && <label className="setting">
        <div className="setting-head"><b>代理地址</b><small>如 http://127.0.0.1:7890 或 socks5://127.0.0.1:1080</small></div>
        <div className="row">
          <input className="grow" value={url} onChange={(e) => setUrl(e.target.value.trim())} placeholder="http://主机:端口" inputMode="url" autoCapitalize="off" aria-label="代理地址" />
          <button className="primary" disabled={!url} onClick={() => void apply({ proxy: "custom", proxyUrl: url })}>保存</button>
        </div>
        <small className="field-hint">地址会原样存在本机和备份里，别把账号密码写进去；需要认证的代理，请用本机的代理工具转接。</small>
      </label>}
    </>
  );
}

function AboutPage() {
  const { game, toast } = useApp();
  const [checking, setChecking] = useState(false);
  const [latest, setLatest] = useState<ReleaseInfo | null | "error">(null);
  const [autoCheck, setAutoCheck] = useState(true);
  const [whatsNew, setWhatsNew] = useState(false);
  useEffect(() => { void game.repo.getSetting("autoUpdateCheck", true).then(setAutoCheck); }, []);
  const check = async () => {
    setChecking(true);
    try { setLatest(await latestRelease(game.platform)); } catch { setLatest("error"); } finally { setChecking(false); }
  };
  const hasNew = latest && latest !== "error" && newer(latest.version, __APP_VERSION__);
  return (
    <>
      <div className="about-head">
        <Seal />
        <div><h2>历史穿越</h2><p className="muted">版本 {__APP_VERSION__}</p></div>
      </div>
      <div className="status-card">
        <b>{checking ? "正在检查…" : latest === "error" ? "没连上 GitHub" : hasNew ? `有新版本：${latest!.version}` : latest ? "已经是最新版本" : "检查更新"}</b>
        {latest && latest !== "error" && hasNew && <small className="release-notes">{plainNotes(latest.notes, 4, 160)}</small>}
        {latest === "error" && <small>可能是网络问题，或者 GitHub 暂时访问不了；需要的话可以在“网络与代理”里设置代理。</small>}
        <div className="row">
          {hasNew ? <UpdateButton release={latest as ReleaseInfo} /> : <button disabled={checking} onClick={() => void check()}>检查更新</button>}
          <button className="ghost" onClick={() => void openLink(game.platform, toast, `${REPO_URL}/releases`)}>全部版本</button>
        </div>
        <small>安卓更新时下载新的安装包直接覆盖安装，不要先卸载（卸载会删掉所有世界）。</small>
      </div>
      <Choice label="打开时自动检查更新" note="每天最多查一次，只看有没有新版本，不会自动下载" value={autoCheck} options={[[true, "开"], [false, "关"]]}
        onChange={(v) => { setAutoCheck(v); void game.repo.setSetting("autoUpdateCheck", v); }} />
      <button onClick={() => setWhatsNew(true)}>这一版新增</button>
      {whatsNew && <WhatsNewSheet onClose={() => setWhatsNew(false)} />}
      <h3 className="settings-sub">说明</h3>
      <dl className="facts">
        <dt>存档</dt><dd>世界与存档保存在这台设备上。</dd>
        <dt>AI 调用</dt><dd>生成故事或整理记录时，会将相关设定、正文和人物等上下文发给你配置的 AI 服务，由该服务处理。</dd>
        <dt>导出与分享</dt><dd>只有你主动导出或分享时，才会生成相应文件；交给其他应用或他人后的使用，由你选择的分享方式决定。</dd>
        <dt>Key</dt><dd>加密保存在系统的安全存储里，只发给你自己填的服务。</dd>
        <dt>网络</dt><dd>只连你的 AI 服务；检查和下载更新时连 GitHub。</dd>
        <dt>源代码</dt><dd><button className="link" onClick={() => void openLink(game.platform, toast, REPO_URL)}>GitHub 仓库</button></dd>
        <dt>反馈</dt><dd><button className="link" onClick={() => void openLink(game.platform, toast, `${REPO_URL}/issues`)}>提交问题</button></dd>
      </dl>
      <DevSwitch onToggled={(on) => toast(on ? "开发者模式已打开" : "开发者模式已关闭")} />
    </>
  );
}

/** Tapping the version line seven times turns developer mode on (and off), like Android. */
function DevSwitch({ onToggled }: { onToggled: (on: boolean) => void }) {
  const { devMode, setDevMode } = useApp();
  const [taps, setTaps] = useState(0);
  return (
    <button className="ghost dev-switch" onClick={() => {
      const n = taps + 1;
      setTaps(n);
      if (n >= 7) { setDevMode(!devMode); onToggled(!devMode); setTaps(0); }
    }}>{devMode ? "开发者模式已打开（再连点 7 下关闭）" : taps >= 3 ? `再点 ${7 - taps} 下打开开发者模式` : "　"}</button>
  );
}

function DevPage() {
  const { game, devMode, setDevMode } = useApp();
  const [calls, setCalls] = useState<Row[]>([]);
  useEffect(() => { void game.platform.sql.query("SELECT * FROM usage ORDER BY at DESC LIMIT 30").then(setCalls); }, []);
  return (
    <>
      <label className="row">
        <input type="checkbox" checked={devMode} onChange={(e) => setDevMode(e.target.checked)} style={{ width: 20, minHeight: 20 }} />
        开发者模式（长按段落可查看原始输出）
      </label>
      <UpdateDevSource />
      <p className="muted">调用记录</p>
      {calls.map((c) => <div className="item-row" key={String(c.id)}><div className="grow">
        <b>{new Date(String(c.at)).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).replaceAll("/", "-")} · {PURPOSES[String(c.purpose)] ?? String(c.purpose)}</b>
        <small>{String(c.model)}</small>
        <small>输入 {String(c.prompt_tokens ?? "未知")} / 输出 {String(c.completion_tokens ?? "未知")} token</small>
        <small>首字 {String(c.first_token_ms ?? "未知")} 毫秒 · 总计 {String(c.total_ms ?? "未知")} 毫秒</small>
      </div><span>{OUTCOMES[String(c.outcome)] ?? String(c.outcome)}</span></div>)}
      {!calls.length && <p className="muted">还没有调用记录。</p>}
    </>
  );
}
