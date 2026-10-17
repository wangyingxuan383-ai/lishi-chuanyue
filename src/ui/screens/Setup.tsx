// Connecting an AI service (R11-T005, docs/research/UX_PROVIDERS.md): pick a
// provider (with a line on why), paste the key, and the models arrive by
// themselves to pick from — the main one and the cheaper one for keeping
// records. One button tests and saves. A custom service has a name of its
// own, and a mistyped address or a key in the wrong box is fixed on the spot.
import { useEffect, useRef, useState } from "react";
import { streamChat, ChatError } from "../../engine/llm/chat";
import {
  PRESETS, chatCompletionsUrl, chatModels, cleanBaseUrl, defaultProfileName, explainFailure, fetchModels, listProfiles,
  looksLikeUrl, presetForUrl, recommendAuxModel, recommendModel, saveProfile, serviceBase, type Profile,
} from "../../engine/llm/providers";
import { newId } from "../../engine/db/repo";
import { useApp } from "../app/context";
import { Sheet } from "../components/Sheet";

type Result = { ok: boolean; text: string } | null;

export default function Setup({ first, profileId }: { first?: boolean; profileId?: string }) {
  const { game, platform, setProfile, pop, replace, toast } = useApp();
  const [presetId, setPresetId] = useState("deepseek");
  const [name, setName] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const [baseUrl, setBaseUrl] = useState(PRESETS[0].baseUrl);
  const [key, setKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [existing, setExisting] = useState<Profile | null>(null);
  const [taken, setTaken] = useState<string[]>([]);
  const [models, setModels] = useState<string[]>([]);
  const [model, setModel] = useState("");
  const [auxModel, setAuxModel] = useState("");
  const [allowHttp, setAllowHttp] = useState(false);
  const [busy, setBusy] = useState<"models" | "save" | null>(null);
  const [result, setResult] = useState<Result>(null);
  const [modelsNote, setModelsNote] = useState<string | null>(null);
  const [picking, setPicking] = useState<"main" | "aux" | null>(null);
  const [presetsOpen, setPresetsOpen] = useState(false);
  /** The key is kept in a draft slot until 保存 (J-09): nothing lands in the service list before that. */
  const draftSlot = useRef(`draft-${newId().slice(0, 12)}`);
  const draftKeyBase = useRef<string | null>(null);
  const saved = useRef(false);
  const preset = PRESETS.find((p) => p.id === presetId)!;

  useEffect(() => {
    void (async () => {
      const profiles = await listProfiles(game.repo);
      const p = profileId === "new" ? null : profiles.find((x) => x.id === profileId) ?? (profileId ? null : profiles[0]) ?? null;
      setTaken(profiles.filter((x) => x.id !== p?.id).map((x) => x.name));
      if (p) {
        setExisting(p);
        setPresetId(p.provider);
        setName(p.name);
        setNameTouched(true);
        setBaseUrl(p.baseUrl);
        setModel(p.mainModel);
        setAuxModel(p.auxModel ?? "");
        setAllowHttp(p.allowHttp);
        void loadModels(p.keySlot, p.baseUrl, PRESETS.find((x) => x.id === p.provider) ?? PRESETS[0], p.mainModel, p.auxModel ?? "");
      } else if (platform.name === "web-dev") {
        const pre = await fetch("/__dev/config").then((r) => r.json()).catch(() => ({}));
        if (pre.baseUrl) { setPresetId("custom"); setBaseUrl(pre.baseUrl); setModel(pre.model ?? ""); }
      }
    })();
    // A key typed and then abandoned is not left behind.
    return () => { if (!saved.current) void platform.secrets.remove(draftSlot.current).catch(() => {}); };
  }, []);

  const cleanUrl = cleanBaseUrl(baseUrl);
  const isHttp = cleanUrl.startsWith("http://");
  const shownName = nameTouched ? name : defaultProfileName(preset, cleanUrl, taken);
  /** The key in use: the one being typed (in the draft slot), or the saved one. */
  const keyReady = key.trim().length >= 8 || !!existing;
  const baseChanged = !!existing && serviceBase(cleanUrl) !== serviceBase(existing.baseUrl);
  const canSave = !!cleanUrl && (key.trim() || (existing && !baseChanged)) && (!isHttp || allowHttp) && !!model.trim();

  const choosePreset = (id: string) => {
    setPresetId(id);
    const p = PRESETS.find((x) => x.id === id)!;
    if (p.baseUrl) setBaseUrl(p.baseUrl);
    else if (presetId !== "custom") setBaseUrl("");
    setModels([]);
    setModel("");
    setAuxModel("");
    setResult(null);
    setModelsNote(null);
    setPresetsOpen(false);
  };

  /** The slot to call with: the draft (a new key typed) or the saved profile's. */
  const slotFor = async (): Promise<string | null> => {
    if (key.trim()) {
      const base = serviceBase(cleanUrl);
      if (draftKeyBase.current !== `${base}\n${key.trim()}`) {
        await platform.secrets.set(draftSlot.current, key.trim(), base);
        draftKeyBase.current = `${base}\n${key.trim()}`;
      }
      return draftSlot.current;
    }
    if (existing && !baseChanged) return existing.keySlot;
    return null;
  };

  /** Fetches the models as soon as a key is there (J-01); the button is only a refresh. */
  const loadModels = async (slotArg?: string, baseArg?: string, presetArg = preset, keepMain = model, keepAux = auxModel) => {
    const slot = slotArg ?? await slotFor().catch(() => null);
    const base = baseArg ?? cleanUrl;
    if (!slot || !base) return;
    setBusy("models");
    setModelsNote(null);
    try {
      const list = chatModels(await fetchModels(platform, slot, base), presetArg);
      setModels(list);
      if (!list.length) { setModelsNote("这个服务没有给出模型列表，请手动填写模型名。"); return; }
      const main = keepMain && list.includes(keepMain) ? keepMain : recommendModel(list, presetArg) ?? "";
      setModel(main);
      setAuxModel(keepAux && list.includes(keepAux) ? keepAux : main ? recommendAuxModel(list, main) : "");
    } catch (e: any) {
      const status = e?.status as number | undefined;
      setModelsNote(status === 401 || status === 403 ? "Key 不对，或者不是这家的 Key。" : status === 404 ? "这个地址拿不到模型列表，检查一下地址，或手动填写模型名。" : `没拿到模型列表：${explainFailure("http", status)}`);
    } finally {
      setBusy(null);
    }
  };

  // Typing stops for a moment with a key in the box: fetch.
  useEffect(() => {
    if (key.trim().length < 8 || !cleanUrl || (isHttp && !allowHttp)) return;
    const id = setTimeout(() => void loadModels(), 700);
    return () => clearTimeout(id);
  }, [key, cleanUrl, allowHttp]);

  const onKeyChange = (value: string) => {
    // An address pasted into the key box goes where it belongs (J-05).
    if (looksLikeUrl(value) && !value.trim().startsWith("sk-")) { onUrlChange(value); toast("这是地址，已填到“服务地址”里"); return; }
    setKey(value.trim());
    setResult(null);
  };
  const onUrlChange = (value: string) => {
    setBaseUrl(value);
    const match = presetForUrl(value);
    if (match && match.id !== presetId && presetId === "custom") { setPresetId(match.id); setBaseUrl(match.baseUrl); toast(`认出来了，这是${match.name}`); }
  };
  const paste = async () => {
    const text = await navigator.clipboard?.readText?.().catch(() => "");
    if (text) onKeyChange(text);
    else toast("剪贴板里没有内容，或不允许读取");
  };

  /** One short request, then save (J-04): says which model answered and how fast. */
  const save = async (skipTest = false) => {
    setBusy("save");
    setResult(null);
    try {
      const slot = await slotFor();
      if (!slot) { setResult({ ok: false, text: baseChanged ? "换了地址，要重新填一次 Key。" : "先填 Key。" }); return; }
      let includeUsage = existing?.includeUsage ?? true;
      let line = "";
      if (!skipTest) {
        const run = (usage: boolean) => streamChat(platform, {
          slot, url: chatCompletionsUrl(cleanUrl), model: model.trim(), includeUsage: usage, maxTokens: 16,
          messages: [{ role: "user", content: "只回复两个字：你好" }],
        }).result;
        const started = performance.now();
        let reply;
        try { reply = await run(true); includeUsage = true; } catch (e) {
          if (e instanceof ChatError && e.kind === "http" && e.status === 400) { includeUsage = false; reply = await run(false); } else throw e;
        }
        line = `${model.trim()} 回了一句“${reply.text.trim().slice(0, 12) || "（空）"}”，用时 ${((performance.now() - started) / 1000).toFixed(1)} 秒。`;
      }
      const keySlot = existing?.keySlot ?? `profile-${newId().slice(0, 12)}`;
      const profile = await saveProfile(game.repo, {
        id: existing?.id, keySlot, name: shownName.trim() || preset.name, provider: presetId, baseUrl: cleanUrl,
        mainModel: model.trim(), auxModel: auxModel.trim() && auxModel.trim() !== model.trim() ? auxModel.trim() : null,
        includeUsage, allowHttp, contextTokens: existing?.contextTokens,
      }, key.trim() || null);
      saved.current = true;
      void platform.secrets.remove(draftSlot.current).catch(() => {});
      setProfile(profile);
      await game.repo.setSetting("welcomed", true);
      toast(line ? `已连接：${line}` : "已保存");
      if (first) replace({ name: "newgame" }); else pop();
    } catch (e) {
      const err = e instanceof ChatError ? e : new ChatError("network");
      const kind = err.kind === "http" ? (err.status === 401 || err.status === 403 ? "auth" : err.status === 429 || err.status === 402 ? "quota" : "http") : err.kind;
      setResult({ ok: false, text: explainFailure(kind, err.status) });
    } finally {
      setBusy(null);
    }
  };

  const skip = async () => {
    await game.repo.setSetting("welcomed", true);
    pop();
  };

  return (
    <div className="screen">
      <div className="topbar">
        <button className="icon-btn" aria-label="返回" onClick={first ? skip : pop}>‹</button>
        <div className="title"><h1>{first ? "连接 AI 服务" : existing ? "修改 AI 服务" : "添加 AI 服务"}</h1></div>
      </div>
      <div className="screen-body stack">
        {first && <p className="muted" style={{ margin: 0 }}>故事由你自己的 AI 服务来写。Key 只加密保存在这台设备上。</p>}

        <section className="stack" style={{ gap: 8 }}>
          <span className="field-label">服务商</span>
          <button className="picker" onClick={() => setPresetsOpen(true)} aria-label={`服务商：${preset.name}`}>
            <span><b>{preset.name}</b><small>{preset.blurb}</small></span><span aria-hidden="true">›</span>
          </button>
          {preset.keyUrl && (
            <p className="links">
              <button className="link" onClick={() => void platform.system.openUrl(preset.keyUrl!)}>申请 Key</button>
              {preset.priceUrl && <> · <button className="link" onClick={() => void platform.system.openUrl(preset.priceUrl!)}>价格</button></>}
            </p>
          )}
        </section>

        {(presetId === "custom" || !preset.baseUrl) ? (
          <label className="field">服务地址
            <input value={baseUrl} onChange={(e) => onUrlChange(e.target.value)} onBlur={() => setBaseUrl(cleanUrl)} placeholder="https://api.example.com/v1" inputMode="url" autoCapitalize="off" />
          </label>
        ) : (
          <details>
            <summary className="muted">服务地址：{cleanUrl}</summary>
            <input value={baseUrl} onChange={(e) => onUrlChange(e.target.value)} onBlur={() => setBaseUrl(cleanUrl)} inputMode="url" autoCapitalize="off" style={{ marginTop: 8 }} aria-label="服务地址" />
          </details>
        )}
        {isHttp && (
          <label className="row" style={{ color: "var(--warn)" }}>
            <input type="checkbox" checked={allowHttp} onChange={(e) => setAllowHttp(e.target.checked)} style={{ width: 20, minHeight: 20 }} />
            这是 HTTP 地址，Key 和剧情会以明文经过网络。我了解，仍要使用。
          </label>
        )}

        <label className="field">
          API Key
          <div className="input-tools">
            <input value={key} onChange={(e) => onKeyChange(e.target.value)} type={showKey ? "text" : "password"}
              placeholder={existing ? "已保存，不改就留空" : preset.keyHint || "粘贴 Key"} autoComplete="off" autoCapitalize="off" spellCheck={false} />
            <button className="icon-btn" aria-label={showKey ? "隐藏 Key" : "显示 Key"} onClick={() => setShowKey(!showKey)}>{showKey ? "藏" : "看"}</button>
            <button className="icon-btn" aria-label="粘贴" onClick={() => void paste()}>贴</button>
          </div>
          {baseChanged && !key.trim() && <small className="field-hint warn">换了地址，要重新填一次 Key。</small>}
        </label>

        <div className="stack" style={{ gap: 8 }}>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <span className="field-label">模型</span>
            {keyReady && <button className="link" disabled={busy === "models"} onClick={() => void loadModels()}>{busy === "models" ? "正在获取…" : models.length ? "刷新列表" : "获取模型列表"}</button>}
          </div>
          {models.length ? (
            <>
              <button className="picker" onClick={() => setPicking("main")} aria-label={`写故事用的模型：${model || "未选"}`}>
                <span><small>写故事</small><b>{model || "选一个"}</b></span><span aria-hidden="true">›</span>
              </button>
              <button className="picker" onClick={() => setPicking("aux")} aria-label={`整理记录用的模型：${auxModel || model}`}>
                <span><small>整理记录（便宜的就行）</small><b>{auxModel || model || "同上"}</b></span><span aria-hidden="true">›</span>
              </button>
            </>
          ) : (
            <>
              <p className="muted" style={{ margin: 0 }}>{busy === "models" ? "正在从服务拿模型列表…" : modelsNote ?? (keyReady ? "" : "填好 Key，模型列表会自己出来。")}</p>
              {(modelsNote || (keyReady && busy !== "models")) && (
                <label className="field">模型名（手动填写）
                  <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="例如 deepseek-flash" autoCapitalize="off" spellCheck={false} />
                </label>
              )}
            </>
          )}
        </div>

        <label className="field">名称
          <input value={shownName} onChange={(e) => { setName(e.target.value); setNameTouched(true); }} placeholder="给这个服务起个名字" />
          <small className="field-hint">在设置里用这个名字区分不同的服务。</small>
        </label>

        {result && <div className={`notice${result.ok ? " ok" : ""}`}>{result.text}
          {!result.ok && canSave && <div className="row"><button onClick={() => void save(true)}>不测试，直接保存</button></div>}
        </div>}
        <button className="primary big-btn" onClick={() => void save()} disabled={!canSave || !!busy}>{busy === "save" ? "正在连接…" : first ? "连接并开始" : "连接并保存"}</button>
        {first && <button className="ghost" onClick={skip}>稍后再说</button>}
      </div>

      {presetsOpen && (
        <Sheet title="选择服务商" onClose={() => setPresetsOpen(false)}>
          <div className="sheet-menu">
            {PRESETS.map((p) => (
              <button key={p.id} className="mode-option" aria-pressed={p.id === presetId} onClick={() => choosePreset(p.id)}>
                <b>{p.name}{p.id === "deepseek" ? "（推荐）" : ""}</b><small>{p.blurb}</small>
              </button>
            ))}
          </div>
        </Sheet>
      )}
      {picking && <ModelPicker models={models} current={picking === "main" ? model : auxModel || model} recommended={picking === "main" ? recommendModel(models, preset) : recommendAuxModel(models, model)}
        title={picking === "main" ? "写故事用的模型" : "整理记录用的模型"} note={picking === "aux" ? "用来整理人物、设定集和章节摘要，选便宜快的就够了。" : undefined}
        onPick={(m) => { if (picking === "main") { setModel(m); if (!auxModel || auxModel === model) setAuxModel(recommendAuxModel(models, m)); } else setAuxModel(m); setPicking(null); setResult(null); }}
        onClose={() => setPicking(null)} />}
    </div>
  );
}

/** A searchable list of the service's chat models, the recommended one first (J-03). */
function ModelPicker({ models, current, recommended, title, note, onPick, onClose }: {
  models: string[]; current: string; recommended: string | null; title: string; note?: string; onPick: (m: string) => void; onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [typed, setTyped] = useState("");
  const shown = models.filter((m) => m.toLowerCase().includes(query.trim().toLowerCase()));
  return (
    <Sheet title={title} onClose={onClose}>
      <div className="stack">
        {note && <p className="muted" style={{ margin: 0 }}>{note}</p>}
        {models.length > 8 && <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索模型" aria-label="搜索模型" autoCapitalize="off" />}
        <div className="sheet-menu model-list">
          {shown.map((m) => (
            <button key={m} aria-pressed={m === current} className="mode-option" onClick={() => onPick(m)}>
              <b>{m}</b>{m === recommended && <small>推荐</small>}
            </button>
          ))}
          {!shown.length && <p className="muted">没有找到“{query}”。</p>}
        </div>
        <details>
          <summary className="muted">列表里没有？手动填写</summary>
          <div className="row" style={{ marginTop: 8 }}>
            <input className="grow" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="模型名" aria-label="手动填写模型名" autoCapitalize="off" spellCheck={false} />
            <button className="primary" disabled={!typed.trim()} onClick={() => onPick(typed.trim())}>用这个</button>
          </div>
        </details>
      </div>
    </Sheet>
  );
}
