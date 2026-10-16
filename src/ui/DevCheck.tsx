// R01 self-check screen: proves storage, secrets, streaming, background resume
// and back-button handling on each platform. Replaced by the game UI in R02.
import { useEffect, useRef, useState } from "react";
import { getPlatform, type Platform } from "../platform";
import { ChatError, chatCompletionsUrl, parseChunk, serviceBase, streamChat, type ChatHandle } from "../engine/llm/chat";

const SLOT = "main";
const PROMPT = "你是历史小说作者。用第二人称写一段约两百字的开场：你在唐天宝七载冬日清晨的长安西市醒来。只写正文。";

interface Sample {
  id: string;
  text: string;
  at: string;
}

const errorText: Record<string, string> = {
  network: "连不上服务，检查网络或地址",
  timeout_first: "服务太久没有回应",
  timeout_idle: "服务中途停住了",
  timeout_total: "这段写得太久，被停止了",
  http: "服务返回了错误",
  cancelled: "已停止",
  too_large: "回复太长",
  secret_echo: "回复里出现了 Key，已拦截",
  url_not_bound: "地址和保存 Key 时的服务不一致，请重新保存",
  no_secret: "还没有保存 Key",
  empty: "服务没有写出内容",
};

async function ensureTables(platform: Platform) {
  await platform.sql.batch([
    { sql: "CREATE TABLE IF NOT EXISTS dev_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)" },
    { sql: "CREATE TABLE IF NOT EXISTS dev_samples (id TEXT PRIMARY KEY, text TEXT NOT NULL, at TEXT NOT NULL)" },
  ]);
}

export default function DevCheck() {
  const [platform, setPlatform] = useState<Platform | null>(null);
  const [base, setBase] = useState("");
  const [model, setModel] = useState("");
  const [key, setKey] = useState("");
  const [keyState, setKeyState] = useState("读取中…");
  const [models, setModels] = useState<string[]>([]);
  const [phase, setPhase] = useState<"idle" | "thinking" | "writing">("idle");
  const [text, setText] = useState("");
  const [note, setNote] = useState("");
  const [samples, setSamples] = useState<Sample[]>([]);
  const [toast, setToast] = useState("");
  const handle = useRef<ChatHandle | null>(null);
  const streamId = useRef<string | null>(null);

  async function loadSamples(p: Platform) {
    const rows = await p.sql.query("SELECT id, text, at FROM dev_samples ORDER BY at DESC LIMIT 5");
    setSamples(rows as unknown as Sample[]);
  }

  useEffect(() => {
    void (async () => {
      const p = await getPlatform();
      await ensureTables(p);
      const rows = await p.sql.query("SELECT key, value FROM dev_settings");
      const settings = Object.fromEntries(rows.map((r) => [r.key, r.value]));
      let savedBase = (settings.base as string) ?? "";
      let savedModel = (settings.model as string) ?? "";
      if (p.name === "web-dev" && (!savedBase || !savedModel)) {
        const pre = await fetch("/__dev/config").then((r) => r.json()).catch(() => ({}));
        savedBase ||= pre.baseUrl ?? "";
        savedModel ||= pre.model ?? "";
      }
      setBase(savedBase);
      setModel(savedModel);
      const status = await p.secrets.has(SLOT);
      setKeyState(status.configured ? `已保存（${status.boundBaseUrl}）` : "未保存");
      await loadSamples(p);
      setPlatform(p);
    })().catch((error) => setNote(`初始化失败：${error?.message ?? error}`));
  }, []);

  // Back: close nothing else here, so the first press warns and the second exits.
  useEffect(() => {
    if (!platform) return;
    let armed = false;
    let timer: ReturnType<typeof setTimeout>;
    return platform.system.onBack(() => {
      if (armed) return false;
      armed = true;
      setToast("再按一次退出");
      timer = setTimeout(() => {
        armed = false;
        setToast("");
      }, 2000);
      return true;
    });
  }, [platform]);

  // When the page returns to the foreground, replay what the stream cached meanwhile.
  useEffect(() => {
    if (!platform) return;
    const onVisible = async () => {
      if (document.visibilityState !== "visible" || !streamId.current) return;
      const snapshot = await platform.llm.resume(streamId.current);
      if (!snapshot) return;
      let replay = "";
      for (const event of snapshot.events) {
        if (event.type === "data") replay += parseChunk(event.data)?.content ?? "";
      }
      setText((current) => (replay.length > current.length ? replay : current));
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [platform]);

  async function saveService() {
    if (!platform) return;
    try {
      await platform.sql.batch([
        { sql: "INSERT OR REPLACE INTO dev_settings (key, value) VALUES ('base', ?)", params: [base.trim()] },
        { sql: "INSERT OR REPLACE INTO dev_settings (key, value) VALUES ('model', ?)", params: [model.trim()] },
      ]);
      if (key.trim()) await platform.secrets.set(SLOT, key.trim(), serviceBase(base));
      setKey("");
      const status = await platform.secrets.has(SLOT);
      setKeyState(status.configured ? `已保存（${status.boundBaseUrl}）` : "未保存");
      setNote("服务已保存");
    } catch (error: any) {
      setNote(`保存失败：${error?.message ?? error}`);
    }
  }

  async function fetchModels() {
    if (!platform) return;
    try {
      const response = await platform.llm.get({ slot: SLOT, url: `${serviceBase(base)}/models`, timeoutMs: 15_000 });
      const ids = (JSON.parse(response.body).data ?? []).map((m: { id: string }) => m.id).filter(Boolean);
      setModels(ids);
      setNote(`获取到 ${ids.length} 个模型`);
    } catch (error: any) {
      setNote(`获取模型失败：${error?.message ?? error}`);
    }
  }

  function write() {
    if (!platform || phase !== "idle") return;
    setText("");
    setNote("");
    setPhase("thinking");
    const h = streamChat(
      platform,
      { slot: SLOT, url: chatCompletionsUrl(base), model: model.trim(), messages: [{ role: "user", content: PROMPT }], includeUsage: true },
      { onThinking: () => setPhase("thinking"), onText: (_d, full) => { setPhase("writing"); setText(full); } },
    );
    handle.current = h;
    void h.streamId.then((id) => (streamId.current = id));
    h.result
      .then(async (result) => {
        setText(result.text);
        const usage = result.usage ? `，用量 ${result.usage.promptTokens}/${result.usage.completionTokens}` : "，服务未返回用量";
        setNote(`完成：首字 ${Math.round(result.firstTokenMs ?? 0)} 毫秒，总计 ${(result.totalMs / 1000).toFixed(1)} 秒${usage}`);
        await platform.sql.query("INSERT INTO dev_samples (id, text, at) VALUES (?, ?, ?)", [
          crypto.randomUUID(), result.text, new Date().toISOString(),
        ]);
        await loadSamples(platform);
      })
      .catch((error: unknown) => {
        const e = error instanceof ChatError ? error : new ChatError("network");
        if (e.partial) setText(e.partial);
        setNote(`${errorText[e.kind] ?? e.kind}${e.status ? `（HTTP ${e.status}）` : ""}${e.message && e.message !== e.kind ? `：${e.message.slice(0, 200)}` : ""}`);
      })
      .finally(() => {
        setPhase("idle");
        if (streamId.current) void platform.llm.ack(streamId.current);
        streamId.current = null;
        handle.current = null;
      });
  }

  return (
    <main className="devcheck">
      <h1>历史穿越 · 开发自检</h1>
      <p className="muted">平台：{platform?.name ?? "加载中"}　Key：{keyState}</p>

      <section>
        <label>服务地址<input value={base} onChange={(e) => setBase(e.target.value)} placeholder="https://api.example.com/v1" inputMode="url" /></label>
        <label>模型<input value={model} onChange={(e) => setModel(e.target.value)} list="models" /></label>
        <datalist id="models">{models.map((m) => <option key={m} value={m} />)}</datalist>
        <label>API Key（留空表示不修改）<input value={key} onChange={(e) => setKey(e.target.value)} type="password" autoComplete="off" /></label>
        <div className="row">
          <button onClick={saveService} disabled={!platform || !base.trim()}>保存</button>
          <button onClick={fetchModels} disabled={!platform || !base.trim()}>获取模型</button>
        </div>
      </section>

      <section>
        <div className="row">
          {phase === "idle"
            ? <button className="primary" onClick={write} disabled={!platform || !model.trim()}>试写一段</button>
            : <button className="primary" onClick={() => handle.current?.cancel()}>停止</button>}
          <span className="muted">{phase === "thinking" ? "构思中…" : phase === "writing" ? "写作中…" : ""}</span>
        </div>
        <article className="story">{text}</article>
        {note && <p className="muted">{note}</p>}
      </section>

      <section>
        <h2>已保存的试写（重启后应仍在）</h2>
        {samples.length === 0 ? <p className="muted">还没有</p> : samples.map((s) => (
          <details key={s.id}><summary>{new Date(s.at).toLocaleString("zh-CN")}</summary><p className="story">{s.text}</p></details>
        ))}
      </section>
      {toast && <div className="toast">{toast}</div>}
    </main>
  );
}
