// 速度体检: where the waiting goes over the last passages, read from the usage
// table (no request), and a one-tap faster 整理用 model when background work
// waits long for its first words — usually a model that thinks first.
import { useEffect, useState } from "react";
import { fetchModels, listProfiles, saveProfile } from "../../engine/llm/providers";
import { FAST_MODEL, SLOW_FIRST_MS, fastModelsFirst, secondsText, speedReport, tokenText, type SpeedReport } from "../../engine/usage";
import { useApp } from "../app/context";
import { ModelPicker } from "../screens/Setup";

/** Saved when the player switches the 整理用 model here, to compare before and after. */
interface SpeedSwitch { at: string; profileId: string; from: string | null; to: string; beforeMs: number | null }

export function SpeedCheck() {
  const { game, profile, setProfile, toast } = useApp();
  const [report, setReport] = useState<SpeedReport | null | undefined>(undefined);
  const [after, setAfter] = useState<{ change: SpeedSwitch; report: SpeedReport | null } | null>(null);
  const [models, setModels] = useState<string[] | null>(null);
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState("");
  const load = async () => {
    setReport(await speedReport(game.platform));
    const change = await game.repo.getSetting<SpeedSwitch | null>("speedSwitch", null);
    setAfter(change && change.profileId === profile?.id ? { change, report: await speedReport(game.platform, 20, change.at) } : null);
  };
  useEffect(() => { void load().catch(() => setReport(null)); }, [profile?.id]);

  const pick = async () => {
    if (!profile) return;
    setPicking(true);
    setError("");
    try {
      setModels(fastModelsFirst(await fetchModels(game.platform, profile.keySlot, profile.baseUrl), profile.mainModel));
    } catch {
      setError("没能读到这个服务的模型列表，可以到“AI 服务”里手动改整理用模型。");
    } finally {
      setPicking(false);
    }
  };
  const use = async (model: string) => {
    if (!profile) return;
    const latest = (await listProfiles(game.repo)).find((p) => p.id === profile.id) ?? profile;
    const saved = await saveProfile(game.repo, { ...latest, auxModel: model }, null);
    await game.repo.setSetting("speedSwitch", { at: new Date().toISOString(), profileId: saved.id, from: latest.auxModel, to: model, beforeMs: report?.auxFirstMs ?? null } satisfies SpeedSwitch);
    setProfile(saved);
    setModels(null);
    toast(`整理用模型换成了 ${model}`, { label: "换回", run: () => void saveProfile(game.repo, { ...saved, auxModel: latest.auxModel }, null).then(setProfile) });
  };

  if (report === undefined) return null;
  if (report === null) return <p className="muted m-0">写过几段之后，这里会显示时间花在了哪里。</p>;
  const slow = report.auxFirstMs !== null && report.auxFirstMs >= SLOW_FIRST_MS && report.auxCalls >= 3;
  const longest = Math.max(...report.parts.map((p) => p.totalMs), 1);
  const auxNow = after?.report?.auxFirstMs ?? null;
  return (
    <div className="stack">
      <p className="muted m-0">
        最近 {report.passages} 段，连同后台的补记、核对和整理。
        {report.writingShare !== null && `写正文占全部等待的 ${Math.round(report.writingShare * 100)}%。`}
      </p>
      <div>
        {report.parts.map((p) => (
          <div key={p.label} className="item-row speed-row">
            <div className="grow">
              <b>{p.label}</b>
              <small>{p.calls} 次 · 平均 {secondsText(p.totalMs / p.calls)}{p.firstMs !== null ? `，等 ${secondsText(p.firstMs)} 开始出字` : ""} · {tokenText(p.tokens)} tokens</small>
              <div className="bar" aria-hidden="true"><i style={{ width: `${(p.totalMs / longest) * 100}%` }} /></div>
            </div>
          </div>
        ))}
      </div>
      {after && (
        <p className="m-0">
          整理用模型从 {after.change.from ?? "和写作相同"} 换成 {after.change.to} 之后：
          {auxNow === null || (after.report?.auxCalls ?? 0) < 3 ? "还没积累够几次后台任务，过一会儿再来看。"
            : `后台任务平均等 ${secondsText(auxNow)} 开始出字${after.change.beforeMs !== null ? `（之前 ${secondsText(after.change.beforeMs)}）` : ""}。`}
        </p>
      )}
      {slow && profile && (
        <div className="tip">
          补记、核对、整理平均要等 {secondsText(report.auxFirstMs!)} 才开始出字，多半是整理用的模型会先思考。换成同一服务里不先思考的快模型，每段能少等不少。
          {!models && <button className="ghost" disabled={picking} onClick={() => void pick()}>{picking ? "正在读取模型…" : "换整理用模型"}</button>}
        </div>
      )}
      {!slow && profile && !models && (
        <button className="ghost" disabled={picking} onClick={() => void pick()}>{picking ? "正在读取模型…" : `整理用模型：${profile.auxModel ?? profile.mainModel}，换一个`}</button>
      )}
      {error && <p role="alert" className="notice m-0">{error}</p>}
      {models && profile && (
        <ModelPicker models={models} current={profile.auxModel ?? profile.mainModel} recommended={models.find((m) => FAST_MODEL.test(m)) ?? null} title="整理用模型"
          note={`补记、核对、整理和札记用这个模型，写正文仍用 ${profile.mainModel}。名字带 flash、lite、mini、turbo 的通常不先思考，排在前面；服务没说明哪些会先思考，换后回来这里看对比。`}
          onPick={(m) => void use(m)} onClose={() => setModels(null)} />
      )}
    </div>
  );
}
