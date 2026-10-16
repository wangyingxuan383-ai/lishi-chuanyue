// Connecting an AI service: pick a provider, paste the key, fetch models,
// test once. Advanced options stay folded (PLAN_V3 §4.1 step 2, §4.11).
import { useEffect, useState } from "react";
import { streamChat, ChatError } from "../../engine/llm/chat";
import {
  PRESETS, chatCompletionsUrl, explainFailure, fetchModels, listProfiles, recommendModel, saveProfile, type Profile,
} from "../../engine/llm/providers";
import { useApp } from "../app/context";

export default function Setup({ first, profileId }: { first?: boolean; profileId?: string }) {
  const { game, platform, setProfile, pop, replace, toast } = useApp();
  const [presetId, setPresetId] = useState("deepseek");
  const [baseUrl, setBaseUrl] = useState(PRESETS[0].baseUrl);
  const [key, setKey] = useState("");
  const [existing, setExisting] = useState<Profile | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [model, setModel] = useState("");
  const [auxModel, setAuxModel] = useState("");
  const [allowHttp, setAllowHttp] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const preset = PRESETS.find((p) => p.id === presetId)!;

  useEffect(() => {
    void (async () => {
      const profiles = await listProfiles(game.repo);
      const p = profiles.find((x) => x.id === profileId) ?? (profileId ? null : profiles[0]) ?? null;
      if (p) {
        setExisting(p);
        setPresetId(p.provider);
        setBaseUrl(p.baseUrl);
        setModel(p.mainModel);
        setAuxModel(p.auxModel ?? "");
        setAllowHttp(p.allowHttp);
      } else if (platform.name === "web-dev") {
        const pre = await fetch("/__dev/config").then((r) => r.json()).catch(() => ({}));
        if (pre.baseUrl) { setPresetId("custom"); setBaseUrl(pre.baseUrl); setModel(pre.model ?? ""); }
      }
    })();
  }, []);

  const choosePreset = (id: string) => {
    setPresetId(id);
    const p = PRESETS.find((x) => x.id === id)!;
    if (p.baseUrl) setBaseUrl(p.baseUrl);
    setModels([]);
    setResult(null);
  };

  const isHttp = baseUrl.trim().startsWith("http://");
  const canSave = baseUrl.trim() && (key.trim() || existing) && (!isHttp || allowHttp);

  /** Saves the key under a draft profile so the native layer can use it. */
  const ensureProfile = async (): Promise<Profile> => {
    const saved = await saveProfile(game.repo, {
      id: existing?.id, keySlot: existing?.keySlot, name: preset.name, provider: presetId, baseUrl: baseUrl.trim(),
      mainModel: model, auxModel: auxModel || null, includeUsage: existing?.includeUsage ?? true, allowHttp,
    }, key.trim() || null);
    setKey("");
    setExisting(saved);
    return saved;
  };

  const loadModels = async () => {
    setBusy("models");
    setResult(null);
    try {
      const p = await ensureProfile();
      const list = await fetchModels(platform, p.keySlot, p.baseUrl);
      setModels(list);
      if (!model || !list.includes(model)) setModel(recommendModel(list, preset) ?? "");
      if (!list.length) setResult({ ok: false, text: "服务没有返回模型列表，请手动填写模型名。" });
    } catch (e: any) {
      setResult({ ok: false, text: `获取模型失败：${explainFailure("http", e?.status)}` });
    } finally {
      setBusy(null);
    }
  };

  /** One short request; also learns whether the service accepts usage reporting. */
  const test = async () => {
    setBusy("test");
    setResult(null);
    const p = await ensureProfile().catch((e) => { setResult({ ok: false, text: String(e?.message ?? e) }); return null; });
    if (!p) { setBusy(null); return; }
    const run = (includeUsage: boolean) => streamChat(platform, {
      slot: p.keySlot, url: chatCompletionsUrl(p.baseUrl), model, includeUsage, maxTokens: 16,
      messages: [{ role: "user", content: "只回复两个字：你好" }],
    }).result;
    try {
      let includeUsage = true;
      const started = performance.now();
      try {
        await run(true);
      } catch (e) {
        if (e instanceof ChatError && e.kind === "http" && e.status === 400) {
          includeUsage = false;
          await run(false);
        } else throw e;
      }
      const seconds = ((performance.now() - started) / 1000).toFixed(1);
      const saved = await saveProfile(game.repo, { ...p, mainModel: model, auxModel: auxModel || null, includeUsage }, null);
      setExisting(saved);
      setResult({ ok: true, text: `连接成功，响应 ${seconds} 秒。` });
    } catch (e) {
      const err = e instanceof ChatError ? e : new ChatError("network");
      const kind = err.kind === "http" ? (err.status === 401 || err.status === 403 ? "auth" : err.status === 429 || err.status === 402 ? "quota" : "http") : err.kind;
      setResult({ ok: false, text: explainFailure(kind, err.status) });
    } finally {
      setBusy(null);
    }
  };

  const finish = async () => {
    const p = await ensureProfile();
    setProfile(p);
    await game.repo.setSetting("welcomed", true);
    toast("已保存");
    if (first) replace({ name: "newgame" });
    else pop();
  };

  const skip = async () => {
    await game.repo.setSetting("welcomed", true);
    pop();
  };

  return (
    <div className="screen">
      <div className="topbar">
        <button className="icon-btn" aria-label="返回" onClick={first ? skip : pop}>‹</button>
        <div className="title"><h1>{first ? "连接 AI 服务" : "AI 服务"}</h1></div>
      </div>
      <div className="screen-body stack">
        {first && <p className="muted">游戏的剧情由你自己的 AI 服务来写。Key 只保存在这台设备上，会加密存放。</p>}
        <div className="segmented" role="group" aria-label="服务商">
          {PRESETS.map((p) => (
            <button key={p.id} aria-pressed={presetId === p.id} onClick={() => choosePreset(p.id)}>{p.name}</button>
          ))}
        </div>
        {(presetId === "custom" || !preset.baseUrl) ? (
          <label>服务地址<input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.example.com/v1" inputMode="url" autoCapitalize="off" /></label>
        ) : (
          <details>
            <summary className="muted">服务地址：{baseUrl}</summary>
            <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} inputMode="url" autoCapitalize="off" style={{ marginTop: 8 }} />
          </details>
        )}
        {isHttp && (
          <label className="row" style={{ color: "var(--warn)" }}>
            <input type="checkbox" checked={allowHttp} onChange={(e) => setAllowHttp(e.target.checked)} style={{ width: 20, minHeight: 20 }} />
            这是 HTTP 地址，Key 和剧情会以明文经过网络。我了解，仍要使用。
          </label>
        )}
        <label>
          API Key{existing ? "（已保存，留空表示不修改）" : ""}
          <input value={key} onChange={(e) => setKey(e.target.value)} type="password" placeholder={preset.keyHint} autoComplete="off" />
        </label>
        <div className="row">
          <button onClick={loadModels} disabled={!canSave || !!busy}>{busy === "models" ? "获取中…" : "获取模型列表"}</button>
        </div>
        <label>
          模型
          {models.length ? (
            <select value={model} onChange={(e) => setModel(e.target.value)}>
              {models.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          ) : (
            <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="例如 deepseek-chat" autoCapitalize="off" />
          )}
        </label>
        <details>
          <summary className="muted">高级</summary>
          <label style={{ marginTop: 8 }}>
            辅助模型（用于整理记录，可选更便宜的模型；留空则与上面相同）
            <input value={auxModel} onChange={(e) => setAuxModel(e.target.value)} list="aux-models" autoCapitalize="off" />
            <datalist id="aux-models">{models.map((m) => <option key={m} value={m} />)}</datalist>
          </label>
        </details>
        <button onClick={test} disabled={!canSave || !model || !!busy}>{busy === "test" ? "测试中…" : "测试连接"}</button>
        {result && <div className="notice" style={{ color: result.ok ? "var(--gain)" : "var(--loss)" }}>{result.text}</div>}
        <button className="primary big-btn" onClick={finish} disabled={!canSave || !model || !!busy}>{first ? "保存，开始穿越" : "保存"}</button>
        {first && <button className="ghost" onClick={skip}>稍后再说</button>}
      </div>
    </div>
  );
}
