// Settings (R11-T006, docs/research/UX_SETTINGS_AI.md §5, UX_APP_BASICS):
// a home list in three groups — AI, 游戏, 应用 — each entry a page of its own,
// with the current state on the entry. What used to be one long page is split
// so each part can grow without the whole getting noisy.
import { DEFAULT_NOTIFY, loadNotifyPrefs, saveNotifyPrefs } from "../app/notifyPrefs";
import type { NotificationStatus, NotifyPrefs, OemFamily } from "../../platform";
import { DEPTH_LABEL } from "../../engine/depth";
import { DepthCards } from "./play/DepthSheet";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { deleteProfile, listProfiles, saveProfile, type Profile } from "../../engine/llm/providers";
import type { Intensity, Perspective } from "../../engine/types";
import { FORTUNE_MODES, FORTUNE_MODE_NOTE } from "../../engine/fortune";
import type { BackupInfo, BackupInventory, Row } from "../../platform";
import { FONT_FAMILIES, PAGE_TURN_ANIMS, PAPER_TONES, useApp, useBack, type Reading } from "../app/context";
import { BUILTIN_DEFAULTS, loadPlayDefaults, savePlayDefaults, type PlayDefaults } from "../app/playDefaults";
import { REPO_URL, openLink, newer, plainNotes } from "../app/update";
import { useUpdateNotice } from "../app/updateStore";
import { exportWorldFile } from "../../engine/archive";
import { purposeLabel } from "../../engine/usage";
import { Seal } from "../components/Seal";
import { Switch } from "../components/Switch";
import "./reader.css";
import { recentDiagnosis } from "../components/FailureSheet";
import { applyFallback } from "../app/llmConfig";
import { backupSize, BackupRestore } from "../components/BackupRestore";
import { Icon, type IconName } from "../components/Icon";
import { MonthlyBudgetSettings, budgetState } from "../components/MonthlyBudget";
import { SpeedCheck } from "../components/SpeedCheck";
import { WhatsNewSheet } from "../components/WhatsNew";
import { UpdateButton, UpdateDevSource } from "../components/UpdateSheet";
import { SourceLibrary } from "../components/Sources";
import { localFind } from "../app/localFind";

const OUTCOMES: Record<string, string> = { ok: "成功", refused: "被拒", no_record: "没有结果", failed: "失败", stale: "已过时，未采用", cancelled: "已取消", interrupted: "已中断" };
type Page = "home" | "services" | "writing" | "memory" | "play" | "reading" | "notify" | "data" | "network" | "about" | "dev" | "budget";
const TITLES: Record<Page, string> = {
  budget: "用量与花费",
  home: "设置", services: "AI 服务", writing: "写作与叙事（新开一局的默认）", memory: "记忆与整理", play: "游玩默认",
  reading: "阅读与外观", notify: "通知与提醒", data: "存档与数据", network: "网络与代理", about: "关于与更新", dev: "开发者",
};
export const THEMES: [Reading["theme"], string][] = [["auto", "跟随系统"], ["paper", "纸张"], ["day", "白天"], ["night", "夜间"]];
export const SIZES: [number, string][] = [[16, "小"], [18, "中"], [20, "大"], [22, "特大"]];
// Search only these public descriptions, never service addresses or credentials.
const FIND_WORDS: Record<string, string> = {
  services: "连接 模型 服务 Key 密钥 主模型 辅助模型 备用服务 自动接替",
  writing: "文风 篇幅 每段长短 叙述视角 第一人称 第二人称 第三人称 建议选项 写作",
  memory: "上下文 输入预算 前文 章节摘要 设定集 自动整理 记忆 主线梗概 札记",
  play: "难度 运势 运气 用词提醒 内容尺度 战斗 感情 死亡",
  reading: "主题 字号 字体 宋体 黑体 行距 段距 段首空两格 自动滚动 动画 触感 振动 阅读不锁屏 亮屏 翻页 音量键 单手 护眼 青竹 羊皮纸 纯黑 减光 楷体 圆体 页边距 字距 免打扰 画卷 书阁 首页样式",
  sources: "原著 同人 书库 参考资料 TXT EPUB PDF DOCX 导入 通读",
  guide: "帮助 操作说明 怎么玩 常见问题",
  notify: "通知 提醒 后台 声音 提示音 振动 静音 悬浮 横幅 自启动 省电 小米 澎湃 vivo OPPO 荣耀 华为 鸿蒙 三星",
  data: "存档 备份 恢复 导入 导出 数据 诊断 失败 原因",
  budget: "用量 费用 花费 单价 预算 请求次数 tokens 速度 太慢 等待 首字 整理用模型 辅助模型",
  network: "联网 网络 代理 连接方式",
  about: "版本 更新 升级 下载 反馈 Github 自动准备 Wi-Fi",
  dev: "开发者 日志 调试",
};

export default function Settings() {
  const { game, pop, push, profile, reading, devMode } = useApp();
  const { unread } = useUpdateNotice(game);
  const [page, setPage] = useState<Page>("home");
  const [defaults, setDefaults] = useState<PlayDefaults>(BUILTIN_DEFAULTS);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [notify, setNotify] = useState<NotificationStatus | null>(null);
  const [network, setNetwork] = useState<{ proxy: "none" | "system" | "custom"; proxyUrl?: string | null }>({ proxy: "none" });
  const [spend, setSpend] = useState("预算与单价");
  const [sources, setSources] = useState(false);
  const [query, setQuery] = useState("");
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
  const windows = game.platform.name === "windows";
  const supportsNotify = android || windows;
  const entries: { group: string; items: { page: Page; label: string; state: string; icon: IconName; hidden?: boolean }[] }[] = [
    { group: "AI", items: [
      { page: "services", label: "AI 服务", icon: "chat", state: profile ? `${profile.name} · ${profile.mainModel}` : "还没有连接" },
      { page: "writing", label: "写作与叙事", icon: "feather", state: `${defaults.style} · ${defaults.length}篇幅 · 第${defaults.perspective === "你" ? "二" : defaults.perspective === "我" ? "一" : "三"}人称` },
      { page: "memory", label: "记忆与整理", icon: "memo", state: `${({ 8000: "省一些", 12000: "标准", 16000: "记得更多" } as Record<number, string>)[profile?.contextTokens ?? 12000] ?? `${profile?.contextTokens?.toLocaleString()} tokens`} · ${defaults.chapterEvery ? `每 ${defaults.chapterEvery} 回合一章` : "不写章节"}` },
    ] },
    { group: "游戏", items: [
      { page: "play", label: "游玩默认", icon: "dice", state: `${DEPTH_LABEL[defaults.depth]}档 · 难度${defaults.difficulty} · 建议选项 ${defaults.choiceCount || "不要"}` },
      { page: "reading", label: "阅读与外观", icon: "palette", state: `${theme} · ${reading.size}px · ${FONT_FAMILIES.find(([f]) => f === reading.fontFamily)?.[1] ?? (reading.serif ? "宋体" : "黑体")}` },
      { page: "sources" as Page, label: "参考书籍", icon: "book", state: "导入、查看与管理，各个故事都能选用" },
      { page: "guide" as Page, label: "游玩指南", icon: "info", state: "怎么玩、各个功能在哪、常见问题" },
      { page: "notify", label: "通知与提醒", icon: "bell", state: !supportsNotify ? "开发台预览" : notify?.enabled ? "已打开" : "没打开", hidden: !supportsNotify && !devMode },
    ] },
    { group: "应用", items: [
      { page: "data", label: "存档与数据", icon: "database", state: "备份与导出" },
      { page: "budget", label: "用量与花费", icon: "coin", state: spend },
      { page: "network", label: "网络与代理", icon: "globe", state: network.proxy === "custom" ? "自定义代理" : network.proxy === "system" ? "跟随系统代理" : "直接连接" },
      { page: "about", label: "关于与更新", icon: "seal", state: `版本 ${__APP_VERSION__}` },
      { page: "dev", label: "开发者", icon: "key", state: devMode ? "已打开" : "关", hidden: !devMode },
    ] },
  ];
  const foundEntries = entries.map(group => ({ ...group, items: group.items.filter(item => !item.hidden && localFind(query, group.group, item.label, FIND_WORDS[item.page])) })).filter(group => group.items.length);

  return (
    <div className="screen">
      <div className="topbar">
        <button className="icon-btn" aria-label="返回" onClick={() => (page === "home" ? pop() : setPage("home"))}><Icon name="back" /></button>
        <div className="title"><h1>{TITLES[page]}</h1></div>
      </div>
      <div className="screen-body stack settings">
        {page === "home" && <input type="search" aria-label="查找设置" placeholder="查找设置，如字号、自动滚动、备份" value={query} onChange={event => setQuery(event.target.value)} />}
        {page === "home" && !!query.trim() && !foundEntries.length && <p className="muted" role="status">没有找到相关设置，试试功能名称。</p>}
        {/* The service the stories are written with, first and large (R28 第二批). */}
        {page === "home" && !query.trim() && (
          <button className={`service-hero${profile ? " ok" : ""}`} onClick={() => setPage("services")} aria-label={`AI 服务：${profile ? `${profile.name}，${profile.mainModel}` : "还没有连接"}`}>
            <span className="service-hero-icon"><Icon name="chat" size={26} /></span>
            <span className="service-hero-text"><small>AI 服务</small><b>{profile ? profile.name : "还没有连接"}</b><span>{profile ? profile.mainModel : "连接一个服务才能开始写故事"}</span></span>
            <span className="service-hero-state"><i aria-hidden="true" />{profile ? "已连接" : "去连接"}</span>
          </button>
        )}
        {page === "home" && foundEntries.map((g) => {
          const items = query.trim() ? g.items : g.items.filter((i) => i.page !== "services");
          if (!items.length) return null;
          return (
            <section key={g.group} className="settings-group">
              <h2>{g.group}</h2>
              <div className="settings-list">
                {items.map((i) => (
                  <button key={i.page} className="settings-entry" aria-label={i.page === "about" && unread ? `${i.label}，有新版本` : undefined} onClick={() => (i.page === ("guide" as Page) ? push({ name: "guide" }) : i.page === ("sources" as Page) ? setSources(true) : setPage(i.page))}>
                    <span className="entry-icon" aria-hidden="true"><Icon name={i.icon} size={20} /></span>
                    <span><b>{i.label}{i.page === "about" && unread && <i className="update-dot" aria-hidden="true" />}</b><small>{i.state}</small></span><span aria-hidden="true">›</span>
                  </button>
                ))}
              </div>
            </section>
          );
        })}
        {page === "services" && <ServicesPage profiles={profiles} onChanged={() => void listProfiles(game.repo).then(setProfiles)} />}
        {page === "writing" && <WritingPage defaults={defaults} onChange={(d) => { setDefaults(d); void savePlayDefaults(game.repo, d); }} />}
        {page === "memory" && <MemoryPage defaults={defaults} onChange={(d) => { setDefaults(d); void savePlayDefaults(game.repo, d); }} />}
        {page === "play" && <PlayPage defaults={defaults} onChange={(d) => { setDefaults(d); void savePlayDefaults(game.repo, d); }} />}
        {page === "reading" && <ReadingPage />}
        {page === "notify" && <NotifyPage status={notify} onRefresh={() => void game.platform.system.notificationStatus().then(setNotify)} />}
        {page === "data" && <DataPage />}
        {page === "budget" && <><MonthlyBudgetSettings /><h3 className="settings-sub">速度</h3><SpeedCheck /></>}
        {page === "network" && <NetworkPage value={network} onChange={setNetwork} />}
        {page === "about" && <AboutPage />}
        {page === "dev" && <DevPage />}
      </div>
      {sources && <SourceLibrary onClose={() => setSources(false)} />}
    </div>
  );
}

/** One labelled choice row: a name, a line on what it does, the options. */
export function Choice<T extends string | number | boolean>({ label, note, value, options, onChange }: {
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
  const [fallbackId, setFallbackId] = useState("");
  useEffect(() => { void game.repo.getSetting<string | null>("fallbackProfile", null).then((id) => setFallbackId(id ?? "")); }, []);
  return (
    <>
      <Note>故事由你自己的 AI 服务来写。可以连好几个，点一下就切换。</Note>
      <div className="list">
        {profiles.map((p) => (
          <div key={p.id} className={`card service-card${p.id === profile?.id ? " selected" : ""}`}>
            <button className="service-main" onClick={() => {
              if (p.id !== profile?.id) {
                if (p.id === fallbackId) {
                  setFallbackId("");
                  game.fallbackLlm = null;
                  void game.repo.setSetting("fallbackProfile", null);
                }
                setProfile(p);
                toast(`已改用“${p.name}”`);
              }
            }}>
              <h3>{p.name}{p.id === profile?.id ? <span className="tag">正在用</span> : p.id === fallbackId && <span className="tag">备用</span>}</h3>
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
                if (p.id === fallbackId) { setFallbackId(""); await game.repo.setSetting("fallbackProfile", null); game.fallbackLlm = null; }
                const rest = profiles.filter((x) => x.id !== p.id);
                if (p.id === profile?.id) {
                  const next = rest[0] ?? null;
                  if (next && next.id === fallbackId) {
                    setFallbackId("");
                    await game.repo.setSetting("fallbackProfile", null);
                    game.fallbackLlm = null;
                  }
                  setProfile(next);
                }
                onChanged();
                toast("已删除");
              }}>删除</button>
            </div>
          </div>
        ))}
        <button onClick={() => push({ name: "setup", profileId: "new" })}><Icon name="plus" size={18} />添加服务</button>
      </div>
      <FallbackChoice profiles={profiles} chosen={fallbackId} onChosen={setFallbackId} />
    </>
  );
}

/**
 * 备用服务 (D179): when the service in use fails a request for a passing reason
 * (no connection, a timeout, the service overloaded), this one answers instead.
 */
function FallbackChoice({ profiles, chosen, onChosen: setChosen }: { profiles: Profile[]; chosen: string; onChosen: (id: string) => void }) {
  const { game, profile } = useApp();
  const others = profiles.filter((p) => p.id !== profile?.id);
  if (!others.length) return <Note>连上第二个服务后，可以把它设成备用：正在用的服务暂时出错时，自动改用它接着写。</Note>;
  return (
    <>
      <h3 className="settings-sub">备用服务</h3>
      <label className="field">正在用的服务暂时出错时，改用
        <select value={chosen} onChange={async (e) => {
          const id = e.target.value; setChosen(id);
          await game.repo.setSetting("fallbackProfile", id || null);
          await applyFallback(game, profile);
        }}>
          <option value="">不用备用服务</option>
          {others.map((p) => <option key={p.id} value={p.id}>{p.name} · {p.mainModel}</option>)}
        </select>
      </label>
      <Note>只在连不上、等太久、服务繁忙或限流时接替，这一段剩下的部分都由备用服务写，提示里会说明。服务拒绝、Key 不对或额度用完不会自动换。</Note>
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
  const { game, profile, setProfile, toast } = useApp();
  const [custom, setCustom] = useState("");
  const [saving, setSaving] = useState(false);
  const tokens = Number(custom);
  const customValid = /^\d+$/.test(custom) && Number.isSafeInteger(tokens) && tokens > 0;
  const setTarget = async (value: number) => {
    if (!profile || saving) return;
    setSaving(true);
    try {
      setProfile(await saveProfile(game.repo, { ...profile, contextTokens: value }, null));
      setCustom("");
    } catch (error) {
      toast(error instanceof Error ? error.message : "输入目标未保存，请重试");
    } finally {
      setSaving(false);
    }
  };
  return (
    <>
      {profile && <><Choice label="每回合给 AI 看多少前文" note={`随 AI 服务“${profile.name}”保存。输入目标越高，可选前文越多，费用也可能增加。本次行动、所选改稿和玩家用法会完整保留。`}
        value={profile.contextTokens ?? 12000} options={[[8000, "省一些"], [12000, "标准"], [16000, "记得更多"]]}
        onChange={setTarget} />
        <details><summary>自定义输入目标</summary><div className="stack">
          <label>目标 tokens<input inputMode="numeric" value={custom} onChange={event => setCustom(event.target.value)} placeholder={String(profile.contextTokens ?? 12000)} /></label>
          <small className="muted">此目标用于挑选前文和参考资料。可接收的总量由当前 AI 服务和模型决定。</small>
          <button disabled={!customValid || saving} onClick={() => void setTarget(tokens)}>保存输入目标</button>
        </div></details></>}
      <Choice label="章节摘要" note="每过这么多回合，AI 把这段剧情写成一章摘要，在“角色 · 记事”里看" value={defaults.chapterEvery}
        options={[[0, "关"], [8, "每 8 回合"], [12, "每 12 回合"], [20, "每 20 回合"]]} onChange={(v) => onChange({ ...defaults, chapterEvery: v })} />
      <Choice label="设定集自动整理" note="每过几回合，AI 把新出现的人物、地点、势力记进设定集；只改它自己写的卡，你写的不会动" value={defaults.autoUpkeep}
        options={[[true, "开"], [false, "关"]]} onChange={(v) => onChange({ ...defaults, autoUpkeep: v })} />
      <Note>章节和整理的设定是新开一局的默认，已经开始的故事在“本局设置”里改。</Note>
      <AutoPlotChoice />
    </>
  );
}

/** 主线梗概 (D174): each new chapter summary is merged into the story's own plot note. */
function AutoPlotChoice() {
  const { game } = useApp();
  const [on, setOn] = useState(true);
  useEffect(() => { void game.repo.getSetting("autoStoryPlot", true).then(setOn); }, []);
  return <Choice label="本局主线梗概" note={on ? "每写好一章摘要，AI 顺带把它合进这局的“主线梗概”札记（一次辅助模型请求），长故事里 AI 不会忘了前面的大事" : "不自动整理；需要时在 ⋯ → 札记 里手动新建或更新"}
    value={on} options={[[true, "自动整理"], [false, "关"]]} onChange={(v) => { setOn(v); void game.repo.setSetting("autoStoryPlot", v); }} />;
}

function PlayPage({ defaults, onChange }: { defaults: PlayDefaults; onChange: (d: PlayDefaults) => void }) {
  const levels: [Intensity, string][] = [["含蓄", "含蓄"], ["写实", "写实"], ["浓烈", "浓烈"]];
  const intensity = (key: keyof PlayDefaults["intensity"], label: string) => (
    <Choice label={label} value={defaults.intensity[key]} options={levels} onChange={(v) => onChange({ ...defaults, intensity: { ...defaults.intensity, [key]: v } })} />
  );
  return (
    <>
      <div className="setting">
        <div className="setting-head"><b>生成档位</b><small>新开一局用哪一档；故事里点“Aa”旁边的小字随时换</small></div>
        <DepthCards value={defaults.depth} onChange={(depth) => onChange({ ...defaults, depth })} />
      </div>
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
      <button className="ghost reset" onClick={() => onChange({ ...defaults, depth: BUILTIN_DEFAULTS.depth, difficulty: BUILTIN_DEFAULTS.difficulty, fortune: BUILTIN_DEFAULTS.fortune, tabooHints: BUILTIN_DEFAULTS.tabooHints, intensity: BUILTIN_DEFAULTS.intensity })}>恢复默认</button>
    </>
  );
}

/** The two looks of the whole app (D160): 宣纸书卷 stays the default. */
export const STYLES: [Reading["style"], string, string][] = [
  ["scroll", "宣纸书卷", "纸色、宋体、朱砂印，像读一本线装书（默认）"],
  ["ink", "墨韵", "新中式：大圆角卡片、柔和阴影、墨黑与一枚朱印"],
];
export function StylePicker() {
  const { reading, setReading } = useApp();
  return (
    <div className="setting">
      <div className="setting-head"><b>外观风格</b><small>整套界面的样子，随时可以换回来</small></div>
      <div className="style-cards">
        {STYLES.map(([v, label, note]) => (
          <button key={v} className={`style-card style-${v}`} aria-pressed={reading.style === v} onClick={() => setReading({ ...reading, style: v })}>
            <span className="style-preview" aria-hidden="true"><i className="sp-bar" /><i className="sp-line" /><i className="sp-line" /><i className="sp-line short" /><i className="sp-card" /><i className="sp-input" /></span>
            <b>{label}</b><small>{note}</small>
          </button>
        ))}
      </div>
    </div>
  );
}

export const LETTER_SPACING_OPTIONS: [number, string][] = [
  [0.03, "标准"],
  [0.06, "舒展"],
  [0.1, "宽朗"],
];

export function resolveLetterSpacingBucket(val: number): number {
  if (val <= 0.045) return 0.03;
  if (val <= 0.08) return 0.06;
  return 0.1;
}

export function FontSizeControl({ size, onChange }: { size: number; onChange: (size: number) => void }) {
  const clamped = Math.min(28, Math.max(14, Math.round(size)));
  return (
    <div className="setting">
      <div className="setting-head">
        <b>字号</b>
        <small>14px–28px 连续无级调节</small>
      </div>
      <div className="size-stepper">
        <button type="button" aria-label="字号小一些" disabled={clamped <= 14} onClick={() => onChange(Math.max(14, clamped - 1))}>
          <span className="size-a small-a">A</span>−
        </button>
        <span className="size-now" aria-live="polite">{clamped}px</span>
        <button type="button" aria-label="字号大一些" disabled={clamped >= 28} onClick={() => onChange(Math.min(28, clamped + 1))}>
          <span className="size-a">A</span>+
        </button>
      </div>
      <input
        type="range"
        className="reading-range"
        aria-label="字号滑杆"
        min={14}
        max={28}
        step={1}
        value={clamped}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  );
}

export function PaperTonePicker({
  value,
  onChange,
}: {
  value: Reading["paperTone"];
  onChange: (tone: Reading["paperTone"]) => void;
}) {
  return (
    <div className="setting">
      <div className="setting-head">
        <b>护眼纸色</b>
        <small>在阅读器与故事正文中生效，“随主题”则跟随应用明暗</small>
      </div>
      <div className="paper-tone-row" role="radiogroup" aria-label="护眼纸色">
        {PAPER_TONES.map((tone) => {
          const active = value === tone.id;
          return (
            <button
              key={tone.id}
              type="button"
              role="radio"
              aria-checked={active}
              className={`paper-tone-chip tone-${tone.id}${active ? " is-active" : ""}`}
              onClick={() => onChange(tone.id)}
            >
              <span
                className="paper-swatch-dot"
                aria-hidden="true"
                style={
                  tone.bg
                    ? { background: tone.id === "oled" ? "#000000" : tone.bg, color: tone.fg }
                    : undefined
                }
              >
                文
              </span>
              <small>{tone.label}</small>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function NightDimControl({
  value,
  onChange,
}: {
  value: number;
  onChange: (dim: number) => void;
}) {
  const clamped = Math.min(50, Math.max(0, Math.round(value)));
  return (
    <div className="setting">
      <div className="setting-head">
        <div className="row between center">
          <b>深夜减光</b>
          <small aria-live="polite">{clamped > 0 ? `已压暗 ${clamped}%` : "不额外减光（0%）"}</small>
        </div>
        <small>关灯夜读时柔化屏幕亮度（也可沿左侧边缘上下滑动调节）</small>
      </div>
      <input
        type="range"
        className="reading-range"
        aria-label="深夜减光幅度"
        min={0}
        max={50}
        step={1}
        value={clamped}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  );
}

function ReadingPage() {
  const { reading, setReading } = useApp();
  const set = (patch: Partial<Reading>) => setReading({ ...reading, ...patch });
  const padPreview = reading.pageMargin === "compact" ? "12px" : reading.pageMargin === "wide" ? "26px" : "18px";
  return (
    <>
      <StylePicker />
      <Choice label="首页样式" note="画卷展四时山水与在读故事，书阁按博古书脊陈列" value={reading.home} options={[["scene", "画卷"], ["shelf", "书阁"]]} onChange={(v) => set({ home: v })} />
      <div className="setting">
        <div className="setting-head"><b>明暗</b><small>跟随系统：手机是浅色时用纸张，深色时用夜间</small></div>
        <div className="theme-cards">
          {THEMES.map(([v, l]) => (
            <button key={v} aria-pressed={reading.theme === v} className={`theme-card theme-${v}`} onClick={() => set({ theme: v })}><span className="swatch" aria-hidden="true" />{l}</button>
          ))}
        </div>
      </div>

      <h3 className="settings-sub">翻页与护眼</h3>
      <Choice
        label="阅读方式"
        note="内置阅读器与穿越正文的展现方式"
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
            note={reading.tapZones === "onehand" ? "下半屏与右侧点击均为下一页，左上角回翻上一页" : "左侧 28% 上一页、中间呼出菜单、右侧 28% 下一页"}
            value={reading.tapZones}
            options={[
              ["classic", "经典左中右"],
              ["onehand", "单手全屏下一页"],
            ]}
            onChange={(tapZones) => set({ tapZones })}
          />
        </>
      )}
      <Switch
        label="音量键翻页"
        note="在阅读器中按手机音量上/下键翻页（打开菜单或离开页面时自动恢复调节音量）"
        checked={reading.volumeKeyTurn}
        onChange={(volumeKeyTurn) => set({ volumeKeyTurn })}
      />
      <PaperTonePicker value={reading.paperTone} onChange={(paperTone) => set({ paperTone })} />
      <NightDimControl value={reading.nightDim} onChange={(nightDim) => set({ nightDim })} />

      <h3 className="settings-sub">字号与版式</h3>
      <FontSizeControl size={reading.size} onChange={(size) => set({ size })} />
      <Choice
        label="字体"
        value={reading.fontFamily}
        options={FONT_FAMILIES}
        onChange={(fontFamily) => set({ fontFamily, serif: fontFamily === "serif" || fontFamily === "kai" })}
      />
      <Choice label="行距" value={reading.leading} options={[[1.7, "紧"], [2, "适中"], [2.3, "松"]]} onChange={(v) => set({ leading: v })} />
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
      <Choice label="段距" value={reading.paragraph} options={[[0.3, "紧"], [0.7, "适中"], [1.2, "松"]]} onChange={(v) => set({ paragraph: v })} />
      <Choice label="段首空两格" value={reading.indent} options={[[true, "空"], [false, "不空"]]} onChange={(v) => set({ indent: v })} />

      <div
        className="story-text reading-preview"
        aria-label="效果预览"
        data-paper-tone={reading.paperTone === "default" ? undefined : reading.paperTone}
        style={{
          fontFamily: `var(--${reading.fontFamily})`,
          letterSpacing: `${reading.letterSpacing}em`,
          paddingInline: padPreview,
        }}
      >
        <p>西市的鼓声一声接一声，你裹紧单衣，跟着人流走进坊门。</p>
        <p>“郎君，买胡饼么？”炉边的老汉抬起头。</p>
      </div>

      <h3 className="settings-sub">沉浸与更多</h3>
      <Switch
        label="常驻页脚状态栏"
        note="左右翻页时在底部显示章节、全书进度、时间与电量"
        checked={reading.readerFooter}
        onChange={(readerFooter) => set({ readerFooter })}
      />
      <Switch
        label="阅读专注免打扰"
        note="专注看书时静默后台动态提示"
        checked={reading.focusMode}
        onChange={(focusMode) => set({ focusMode })}
      />
      <Choice label="生成时自动滚动" note="打开后，跟着新写出的内容往下读" value={reading.autoScroll} options={[[true, "开"], [false, "关"]]} onChange={(v) => set({ autoScroll: v })} />
      <Choice label="显示每段用量" note="最新一段下面一行小字：请求几次、多少 tokens、大约多少钱、多少秒" value={reading.usageLine} options={[[true, "开"], [false, "关"]]} onChange={(v) => set({ usageLine: v })} />
      <Choice label="动画" note="华丽：页面、回合和印章都有动效；简洁：只留轻微的淡入淡出。系统设置了减少动态效果时一律关闭" value={reading.motion} options={[["rich", "华丽"], ["simple", "简洁"], ["off", "关"]]} onChange={(v) => set({ motion: v })} />
      <Choice label="触感" note="长按、发送和写完一段时轻轻振一下" value={reading.haptics} options={[[true, "开"], [false, "关"]]} onChange={(v) => set({ haptics: v })} />
      <Choice label="阅读时不锁屏" note="只在读故事时生效" value={reading.keepAwake} options={[[true, "开"], [false, "关"]]} onChange={(v) => set({ keepAwake: v })} />
    </>
  );
}

const OEM_GUIDES: { id: OemFamily; name: string; banner: string; background: string }[] = [
  {
    id: "xiaomi",
    name: "小米 / Redmi（澎湃 OS · MIUI）",
    banner: "新装应用常默认关掉悬浮通知和提示音：点下方“打开通知渠道（开启悬浮通知与铃声）”，把“悬浮通知”“锁屏通知”和“允许发声”打开。",
    background: "省电策略选“无限制”，在“自启动管理”里允许本应用后台运行；长篇连写时可在最近任务下拉锁定。",
  },
  {
    id: "vivo",
    name: "vivo / iQOO（OriginOS）",
    banner: "点“打开通知渠道（开启悬浮通知与铃声）”，开启“悬浮通知（顶部预览）”并确认通知铃声不是静音。",
    background: "电池后台耗电管理中开启“允许后台高耗电”，并在权限管理的自启动与后台弹出里放行本应用。",
  },
  {
    id: "oppo",
    name: "OPPO / 一加 / 真我（ColorOS）",
    banner: "点“打开通知渠道（开启悬浮通知与铃声）”，打开“横幅通知”与“通知铃声”。",
    background: "应用耗电管理中开启“允许完全后台行为”和“允许自启动”，避免切屏后连接中断。",
  },
  {
    id: "honor",
    name: "荣耀（MagicOS）",
    banner: "点“打开通知渠道（开启悬浮通知与铃声）”，打开“横幅通知”并确认提示音已开启。",
    background: "在“应用启动管理”里关掉自动管理，手动开启“允许自启动”和“允许后台活动”。",
  },
  {
    id: "huawei",
    name: "华为（鸿蒙 HarmonyOS · EMUI）",
    banner: "点“打开通知渠道（开启悬浮通知与铃声）”，开启“横幅通知”“锁屏通知”和“铃声”。更新安装时若遇到纯净模式提示，按指引授权即可。",
    background: "在“应用启动管理”里改为手动管理，勾选“允许自启动”与“允许后台活动”。",
  },
  {
    id: "samsung",
    name: "三星（One UI）",
    banner: "点“打开通知渠道（开启悬浮通知与铃声）”，设为“发出声音并弹出到屏幕上”。",
    background: "电池里选择“不受限制”，并确认本应用没有被放进“深度休眠应用”。",
  },
  {
    id: "generic",
    name: "原生与其他安卓系统",
    banner: "点“打开通知渠道（开启悬浮通知与铃声）”，确认通知重要程度为“紧急 / 发出声音并弹出”。",
    background: "将应用电池用量设为“无限制”，锁屏或切到别的软件时也能把这一段写完。",
  },
];

function NotifyPage({ status, onRefresh }: { status: NotificationStatus | null; onRefresh: () => void }) {
  const { game } = useApp();
  const system = game.platform.system;
  const android = game.platform.name === "android";
  const windows = game.platform.name === "windows";
  const [background, setBackground] = useState<{ ignoringBattery: boolean; xiaomi: boolean; oem?: OemFamily } | null>(null);
  const [prefs, setPrefs] = useState<NotifyPrefs>(DEFAULT_NOTIFY);
  const [reminder, setReminder] = useState<{ sound: boolean; audible: boolean } | null>(null);
  const readBackground = () => {
    void system.backgroundStatus?.().then(setBackground).catch(() => setBackground(null));
    void system.reminderStatus?.().then(setReminder).catch(() => setReminder(null));
  };
  useEffect(() => {
    readBackground();
    void loadNotifyPrefs(game.repo).then((loaded) => {
      setPrefs(loaded);
      void system.setNotifyPrefs?.(loaded).catch(() => {});
    });
  }, []);
  const change = (patch: Partial<NotifyPrefs>) => {
    const next = { ...prefs, ...patch }; setPrefs(next);
    void saveNotifyPrefs(game.repo, next, system.setNotifyPrefs).then(() => {
      onRefresh();
      return system.reminderStatus?.().then(setReminder).catch(() => {});
    });
  };
  // Coming back from the system screen: read notification, channel, and battery status again.
  useEffect(() => {
    const again = () => { if (document.visibilityState === "visible") { onRefresh(); readBackground(); } };
    window.addEventListener("lishi:app-resume", again);
    document.addEventListener("visibilitychange", again);
    return () => {
      window.removeEventListener("lishi:app-resume", again);
      document.removeEventListener("visibilitychange", again);
    };
  }, []);
  const on = !!status?.enabled;
  const detectedOem: OemFamily = status?.oem ?? background?.oem ?? "generic";
  const currentGuide = OEM_GUIDES.find((item) => item.id === detectedOem) ?? OEM_GUIDES[OEM_GUIDES.length - 1];
  const channelMuted = prefs.sound && ((reminder !== null && !reminder.audible) || status?.reminderAudible === false || status?.canFloat === false);

  return (
    <>
      <div className={`status-card${on ? " ok" : ""}`}>
        <b>{windows ? "电脑桌面通知已打开" : on ? "通知已打开" : "通知没打开"}</b>
        <small>
          {windows
            ? "切到其他窗口或最小化时，故事写好了或中途停下会在屏幕右下角弹出横幅并响提示音。"
            : on
              ? "切到后台时，写的时候通知栏会显示进度，写好了会弹出横幅并响铃提醒你。"
              : "没有通知时，故事照样会在后台写，只是写好了不会提醒你。"}
        </small>
        {!on && android && <div className="row">
          <button className="primary" onClick={async () => { const granted = await system.requestNotifications().catch(() => false); if (!granted) await system.openSystemSettings("notifications"); onRefresh(); }}>打开通知</button>
        </div>}
      </div>
      <h3 className="settings-sub">提醒的声音与横幅</h3>
      <Choice label="写好了、没写完时响一声" note={prefs.sound ? (windows ? "切到其他窗口时，提醒会弹出系统横幅并播放提示音" : "切到后台时，提醒会弹出横幅、响提示音并振动") : "只静默显示在通知栏，不响"} value={prefs.sound} options={[[true, "响"], [false, "不响"]]} onChange={(v) => change({ sound: v })} />
      <div className="row wrap">
        {system.testReminder && <button onClick={() => void system.testReminder?.().then(() => { onRefresh(); return system.reminderStatus?.().then(setReminder); })}>试一下提醒</button>}
        {android && <button onClick={() => void system.openSystemSettings("channel_done")}>打开通知渠道（开启悬浮通知与铃声）</button>}
      </div>
      {android && channelMuted && <div className="status-card">
        <b>系统把悬浮通知或铃声关了</b>
        <small>当前提醒渠道的重要程度偏低、铃声为空，或手机正处于静音模式。点下面进入“写好了提醒”渠道，把悬浮通知（横幅）与提示音打开。</small>
        <div className="row wrap">
          <button className="primary" onClick={() => void system.openSystemSettings("channel_done")}>打开通知渠道（开启悬浮通知与铃声）</button>
          <button className="ghost" onClick={() => void system.openSystemSettings("channel_failed")}>检查“没写完”提醒渠道</button>
        </div>
      </div>}
      <h3 className="settings-sub">通知里显示什么</h3>
      {android && <Choice label="写的时候显示进度" note={prefs.progress ? "通知栏显示故事名、正在构思还是在写、已写多少字和用时，可以直接停止" : "只显示“正在写下一段”"} value={prefs.progress} options={[[true, "开"], [false, "关"]]} onChange={(v) => change({ progress: v })} />}
      <Choice label="写好了显示第一句" note={prefs.excerpt ? "提醒里带上新一段的第一句，点开直接回到那个故事" : "只提醒写好了"} value={prefs.excerpt} options={[[true, "开"], [false, "关"]]} onChange={(v) => change({ excerpt: v })} />
      {android && <Choice label="锁屏上也显示第一句" note={prefs.lockscreen ? "锁屏时也能看到第一句" : "锁屏时只显示故事名"} value={prefs.lockscreen} options={[[true, "开"], [false, "关"]]} onChange={(v) => change({ lockscreen: v })} />}
      <Note>没写完（比如服务出错、用到的请求太多先停下）也会提醒你，回到故事即可接着写完。</Note>
      {android ? (
        <>
          <h3 className="settings-sub">后台运行与手机系统设置</h3>
          {system.backgroundStatus && <div className={`status-card${background?.ignoringBattery ? " ok" : ""}`}>
            <b>{background?.ignoringBattery ? "已放行：省电不会停掉写作" : "可能被省电停掉"}</b>
            <small>{background?.ignoringBattery ? "切到后台、锁屏时，正在写的一段会继续写完。" : "手机为了省电，可能在后台停掉应用，故事写到一半就断了。放行后会稳很多。"}</small>
            <div className="row wrap">
              {!background?.ignoringBattery && <button className="primary" onClick={() => void system.openSystemSettings("battery")}>放行，不限制省电</button>}
              <button onClick={() => void system.openSystemSettings("autostart")}>后台运行与自启动设置</button>
            </div>
          </div>}
          <div className="status-card">
            <b>当前系统：{currentGuide.name}</b>
            <small>{currentGuide.banner}</small>
            <small>{currentGuide.background}</small>
            <div className="row wrap">
              <button onClick={() => void system.openSystemSettings("channel_done")}>打开通知渠道（开启悬浮通知与铃声）</button>
              <button onClick={() => void system.openSystemSettings("autostart")}>后台运行与自启动设置</button>
              <button className="ghost" onClick={() => void system.openSystemSettings("app")}>打开应用信息</button>
            </div>
          </div>
          <details>
            <summary className="muted">查看其他品牌手机的设置步骤</summary>
            <div className="stack">
              {OEM_GUIDES.filter((item) => item.id !== currentGuide.id).map((item) => (
                <div key={item.id} className="setting">
                  <div className="setting-head"><b>{item.name}</b><small>{item.banner} {item.background}</small></div>
                </div>
              ))}
            </div>
          </details>
        </>
      ) : (
        <details>
          <summary className="muted">手机版各品牌悬浮通知与后台不断连设置说明</summary>
          <div className="stack">
            {OEM_GUIDES.map((item) => (
              <div key={item.id} className="setting">
                <div className="setting-head"><b>{item.name}</b><small>{item.banner} {item.background}</small></div>
              </div>
            ))}
          </div>
        </details>
      )}
    </>
  );
}

function DataPage() {
  const { game, ask, toast } = useApp();
  const [sources, setSources] = useState(false);
  const [inventory, setInventory] = useState<BackupInventory | null>(null);
  const [backupReadFailed, setBackupReadFailed] = useState(false);
  const [dailyBackup, setDailyBackup] = useState<boolean | null>(null);
  const [backupBusy, setBackupBusy] = useState(false);
  const [worldCount, setWorldCount] = useState<number | null>(null);
  const [exporting, setExporting] = useState(false);
  const exportBusy = useRef(false);
  const loadBackups = async () => {
    try {
      setInventory(await game.platform.sql.backupInventory());
      setBackupReadFailed(false);
    } catch {
      setBackupReadFailed(true);
    }
  };
  useEffect(() => {
    void loadBackups();
    void game.repo.getSetting<boolean>("dailyBackup", false).then((enabled) => setDailyBackup(enabled === true)).catch(() => toast("没能读取每日备份设置"));
    void game.platform.sql.query("SELECT COUNT(*) AS worlds FROM worlds WHERE archived < 2").then((r) => setWorldCount(Number(r[0].worlds)));
  }, []);
  const changeDailyBackup = async (enabled: boolean) => {
    try {
      await game.repo.setSetting("dailyBackup", enabled);
      setDailyBackup(enabled);
    } catch { toast("没能保存每日备份设置"); }
  };
  const createBackup = async () => {
    setBackupBusy(true);
    try {
      await game.platform.sql.backup("manual");
      toast("已备份");
    } catch { toast("备份操作没完成，请检查可用空间后重试"); }
    finally { await loadBackups(); setBackupBusy(false); }
  };
  const removeBackups = async (items: BackupInfo[]) => {
    setBackupBusy(true);
    try {
      const ok = await ask({
        title: items.length === 1 ? "删除这份备份？" : `删除这 ${items.length} 份备份？`,
        message: "删除后将无法使用这些恢复点。当前存档和另外导出的文件会保留。",
        confirm: "删除", danger: true,
      });
      if (!ok) return;
      const result = await game.platform.sql.deleteBackups(items.map((item) => item.name));
      setInventory(result.inventory);
      setBackupReadFailed(false);
      toast(result.failed ? `有备份未删除，剩余 ${result.inventory.items.length} 份，可以重试` : "已删除备份");
    } catch {
      toast("备份没能全部删除，请重试");
      await loadBackups();
    } finally { setBackupBusy(false); }
  };
  const exportAll = async () => {
    if (exportBusy.current) return;
    exportBusy.current = true; setExporting(true);
    try {
    const worlds = await game.repo.listWorlds();
    let done = 0;
    for (const w of worlds) {
      try { if (await exportWorldFile(game.repo, w.id, w.title)) done++; else break; }
      catch (error) { toast(error instanceof Error ? error.message : "准备完整存档失败"); return; }
    }
    toast(done ? `已导出 ${done} 个世界` : "没有导出");
    } catch (error) { toast(error instanceof Error ? error.message : "准备完整存档失败"); }
    finally { exportBusy.current = false; setExporting(false); }
  };
  const backups = inventory?.items ?? [];
  return (
    <>
      {dailyBackup !== null && <Choice label="每日自动备份" note="开启后，启动应用时会检查是否需要备份。" value={dailyBackup}
        options={[[false, "关"], [true, "开"]]} onChange={(enabled) => void changeDailyBackup(enabled)} />}
      <div className="status-card ok">
        <b>{backupReadFailed ? "没能读取备份" : inventory ? `备份 ${backups.length} 份 · ${backupSize(inventory.totalBytes)}` : "正在读取备份…"}</b>
        <small>保留最近 5 份。备份存在这台设备的应用目录，卸载时会一起删除。重要的世界可以另外导出。</small>
        <div className="row">
          <button disabled={backupBusy} onClick={() => void createBackup()}>现在备份</button>
          {backupReadFailed && <button disabled={backupBusy} onClick={() => void loadBackups()}>重新读取</button>}
        </div>
      </div>
      {backups.length > 0 && <details>
        <summary className="muted">从备份恢复（{backups.length} 份）</summary>
        <BackupRestore backups={backups} deleting={backupBusy} onDelete={removeBackups} />
      </details>}
      <button onClick={() => setSources(true)}>参考书籍</button>
      {sources && <SourceLibrary onClose={() => setSources(false)} />}
      <h3 className="settings-sub">导出</h3>
      <Note>导出的文件，在另一台手机或电脑的首页用“从文件导入世界…”打开。只导出一个世界：点首页卡片上的“⋯”。</Note>
      <button disabled={exporting} onClick={() => void exportAll()}>{exporting ? "正在准备导出…" : `导出全部世界${worldCount !== null ? `（${worldCount} 个）` : ""}`}</button>
      <h3 className="settings-sub">生成失败诊断</h3>
      <Note>最近 20 次没写成的原因：出错的步骤、服务原话和时间。不含故事正文、提示词、Key 或服务地址，可以放心发给开发者。</Note>
      <button onClick={() => void recentDiagnosis(game.platform.sql).then((text) => navigator.clipboard.writeText(text)).then(() => toast("已复制诊断"), () => toast("没能复制诊断"))}>复制诊断</button>
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
      {mode === "system" && <Note>电脑上会使用系统代理；手机系统通常不会把系统代理传给应用，连不上时请改用自定义代理。</Note>}
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
  const { store: updates, state: { release: latest, readyRelease, checking, failed, preparing }, unread, readyToPrompt } = useUpdateNotice(game);
  const [autoCheck, setAutoCheck] = useState(true);
  const [autoUpdate, setAutoUpdate] = useState(false);
  const [whatsNew, setWhatsNew] = useState(false);
  useEffect(() => {
    void game.repo.getSetting("autoUpdateCheck", true).then(setAutoCheck);
    void game.repo.getSetting<boolean>("autoUpdate", false).then((v) => setAutoUpdate(v === true));
  }, []);
  const check = () => updates.check(true);
  const canInAppUpdate = game.platform.name === "android" && !!game.platform.update;
  const hasNew = latest && newer(latest.version, __APP_VERSION__);
  const readySuperseded = Boolean(
    readyRelease &&
      hasNew &&
      latest &&
      latest.version !== readyRelease.version &&
      !newer(readyRelease.version, latest.version),
  );
  const ready =
    canInAppUpdate && readyRelease && newer(readyRelease.version, __APP_VERSION__) && !readySuperseded
      ? readyRelease
      : null;
  return (
    <>
      <div className="about-head">
        <Seal />
        <div><h2>穿越小说模拟</h2><p className="muted">版本 {__APP_VERSION__}</p></div>
      </div>
      {canInAppUpdate && ready && (
        <div className="status-card ok">
          <b>新版本 {ready.version} 已准备好，校验无误</b>
          <small>安装包已提前下载并核对通过，点“立即安装”才会打开系统安装界面，不会自动安装。</small>
          <div className="row wrap">
            <UpdateButton release={ready} label="立即安装" />
            {readyToPrompt && <button className="ghost" onClick={() => void updates.dismissReady()}>稍后再说</button>}
          </div>
        </div>
      )}
      <div className="status-card">
        <b>{checking ? "正在检查…" : preparing ? "正在后台准备更新…" : failed ? "没连上 GitHub" : hasNew ? `有新版本：${latest!.version}` : latest ? "已经是最新版本" : "检查更新"}{unread && <i className="update-dot" aria-hidden="true" />}</b>
        {latest && hasNew && <small className="release-notes">{plainNotes(latest.notes, 4, 160)}</small>}
        {failed && <small>可能是网络问题，或者 GitHub 暂时访问不了；连回网络后会再试，需要的话也可以在“网络与代理”里设置代理。</small>}
        <div className="row">
          {hasNew && latest && <UpdateButton release={latest} label={ready ? "查看详情" : "去更新"} />}
          <button className={hasNew ? "ghost" : undefined} disabled={checking} onClick={() => void check()}>检查更新</button>
          <button className="ghost" onClick={() => void openLink(game.platform, toast, `${REPO_URL}/releases`)}>全部版本</button>
        </div>
        <small>更新时下载新的安装包直接覆盖安装，不要先卸载（卸载会删掉所有世界）。</small>
      </div>
      <Choice label="打开时自动检查更新" note="每天最多查一次，离线失败不会计入冷却时间" value={autoCheck} options={[[true, "开"], [false, "关"]]}
        onChange={(v) => { setAutoCheck(v); void game.repo.setSetting("autoUpdateCheck", v); }} />
      {canInAppUpdate && (
        <Choice label="Wi-Fi 下自动准备更新" note="默认关闭。打开后，连上不计流量的 Wi-Fi 且空间充足时，会在后台静默下载并校验新版安装包，准备好后提醒你手动安装" value={autoUpdate} options={[[false, "关"], [true, "开"]]}
          onChange={(v) => { setAutoUpdate(v); void game.repo.setSetting("autoUpdate", v).then(() => { if (v) void updates.autoPrepare(); }); }} />
      )}
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
        <input type="checkbox" checked={devMode} onChange={(e) => setDevMode(e.target.checked)} className="check-20" />
        开发者模式（长按段落可查看原始输出）
      </label>
      <UpdateDevSource />
      <p className="muted">调用记录</p>
      {calls.map((c) => <div className="item-row" key={String(c.id)}><div className="grow">
        <b>{new Date(String(c.at)).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).replaceAll("/", "-")} · {purposeLabel(String(c.purpose))}</b>
        <small>{String(c.model)}</small>
        <small>输入 {String(c.prompt_tokens ?? "未知")} / 输出 {String(c.completion_tokens ?? "未知")} token</small>
        <small>首字 {String(c.first_token_ms ?? "未知")} 毫秒 · 总计 {String(c.total_ms ?? "未知")} 毫秒</small>
      </div><span>{OUTCOMES[String(c.outcome)] ?? String(c.outcome)}</span></div>)}
      {!calls.length && <p className="muted">还没有调用记录。</p>}
    </>
  );
}
