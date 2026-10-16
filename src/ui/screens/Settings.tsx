import { useEffect, useState } from "react";
import { deleteProfile, listProfiles, type Profile } from "../../engine/llm/providers";
import { useApp, type Reading } from "../app/context";
import type { Row } from "../../platform";

const PURPOSES: Record<string, string> = { turn: "回合", opening: "开场", extract: "补记", assist: "补全", continue: "续写", test: "测试" };

export default function Settings() {
  const { game, push, pop, profile, setProfile, reading, setReading, devMode, setDevMode, toast } = useApp();
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [usage, setUsage] = useState<{ calls: number; prompt: number; completion: number } | null>(null);
  const [calls, setCalls] = useState<Row[]>([]);
  useEffect(() => {
    if (devMode) void game.platform.sql.query("SELECT * FROM usage ORDER BY at DESC LIMIT 30").then(setCalls);
  }, [devMode, game]);
  useEffect(() => {
    void listProfiles(game.repo).then(setProfiles);
    void game.platform.sql.query("SELECT COUNT(*) AS calls, COALESCE(SUM(prompt_tokens),0) AS prompt, COALESCE(SUM(completion_tokens),0) AS completion FROM usage")
      .then((r) => setUsage({ calls: Number(r[0].calls), prompt: Number(r[0].prompt), completion: Number(r[0].completion) }));
  }, []);
  const set = (patch: Partial<Reading>) => setReading({ ...reading, ...patch });

  return (
    <div className="screen">
      <div className="topbar">
        <button className="icon-btn" aria-label="返回" onClick={pop}>‹</button>
        <div className="title"><h1>设置</h1></div>
      </div>
      <div className="screen-body stack">
        <p className="muted" style={{ margin: 0 }}>AI 服务</p>
        <div className="list">
          {profiles.map((p) => (
            <div key={p.id} className={`card${p.id === profile?.id ? " selected" : ""}`}>
              <h3>{p.name}{p.id === profile?.id ? "（正在使用）" : ""}</h3>
              <p>{p.mainModel}</p>
              <div className="row" style={{ marginTop: 8 }}>
                {p.id !== profile?.id && <button onClick={() => { setProfile(p); toast("已切换"); }}>使用</button>}
                <button onClick={() => push({ name: "setup", profileId: p.id })}>修改</button>
                <button className="ghost" onClick={async () => {
                  if (!confirm(`删除“${p.name}”？Key 也会一并删除。`)) return;
                  await deleteProfile(game.repo, p);
                  const rest = profiles.filter((x) => x.id !== p.id);
                  setProfiles(rest);
                  if (p.id === profile?.id) setProfile(rest[0] ?? null);
                }}>删除</button>
              </div>
            </div>
          ))}
          <button onClick={() => push({ name: "setup", profileId: "new" })}>＋ 添加服务</button>
        </div>

        <p className="muted" style={{ margin: "12px 0 0" }}>阅读</p>
        <span className="muted">字号</span>
        <div className="segmented">
          {[16, 18, 20, 22].map((s) => <button key={s} aria-pressed={reading.size === s} onClick={() => set({ size: s })}>{["小", "中", "大", "特大"][[16, 18, 20, 22].indexOf(s)]}</button>)}
        </div>
        <span className="muted">主题</span>
        <div className="segmented">
          {([["paper", "纸张"], ["day", "白天"], ["night", "夜间"]] as const).map(([v, l]) => <button key={v} aria-pressed={reading.theme === v} onClick={() => set({ theme: v })}>{l}</button>)}
        </div>
        <span className="muted">正文字体</span>
        <div className="segmented">
          <button aria-pressed={!reading.serif} onClick={() => set({ serif: false })}>黑体</button>
          <button aria-pressed={reading.serif} onClick={() => set({ serif: true })}>宋体</button>
        </div>
        <p className="story-text" style={{ padding: 12, background: "var(--surface)", borderRadius: 12 }}>西市的鼓声一声接一声，你裹紧单衣，跟着人流走进坊门。</p>

        <p className="muted" style={{ margin: "12px 0 0" }}>用量</p>
        {usage && <p className="muted" style={{ margin: 0 }}>共 {usage.calls} 次调用，输入 {usage.prompt.toLocaleString()} token，输出 {usage.completion.toLocaleString()} token（部分服务不返回用量，实际可能更多）。</p>}

        <label className="row" style={{ marginTop: 12 }}>
          <input type="checkbox" checked={devMode} onChange={(e) => setDevMode(e.target.checked)} style={{ width: 20, minHeight: 20 }} />
          开发者模式（长按段落可查看原始输出）
        </label>
        {devMode && <div>
          <p className="muted">调用记录</p>
          {calls.map((c) => <div className="item-row" key={String(c.id)}><div className="grow">
            <b>{new Date(String(c.at)).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).replaceAll("/", "-")} · {PURPOSES[String(c.purpose)] ?? String(c.purpose)}</b>
            <small>{String(c.model)}</small>
            <small>输入 {String(c.prompt_tokens ?? "未知")} / 输出 {String(c.completion_tokens ?? "未知")} token</small>
            <small>首字 {String(c.first_token_ms ?? "未知")} 毫秒 · 总计 {String(c.total_ms ?? "未知")} 毫秒</small>
          </div><span>{c.outcome === "ok" ? "成功" : c.outcome === "refused" ? "被拒" : String(c.outcome)}</span></div>)}
          {!calls.length && <p className="muted">还没有调用记录。</p>}
        </div>}
      </div>
    </div>
  );
}
