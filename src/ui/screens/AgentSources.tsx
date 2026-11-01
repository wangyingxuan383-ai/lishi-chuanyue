import { useEffect, useState } from "react";
import { AgentClient, type AgentExternalSource, type AgentExternalText } from "../../engine/agent";
import { useApp } from "../app/context";
import { Sheet } from "../components/Sheet";
import { StoryText } from "../components/StoryText";

export function AgentSources({ client, sessionId, worldId, initialUrl, onClose }: { client: AgentClient; sessionId: string; worldId: string; initialUrl?: string; onClose: () => void }) {
  const { platform, toast } = useApp();
  const [items, setItems] = useState<AgentExternalSource[]>([]), [next, setNext] = useState<number | null>(null);
  const [selected, setSelected] = useState<AgentExternalSource | null>(null), [page, setPage] = useState<AgentExternalText | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  useEffect(() => { let live = true; setBusy(true); void client.externalSources(sessionId, worldId).then(result => {
    if (!live) return; setItems(result.items); setNext(result.nextOffset);
    const match = initialUrl && result.items.find(item => item.url === initialUrl); if (match) setSelected(match);
  }).catch(() => { if (live) setError("资料来源暂未读到，请重新打开。"); }).finally(() => { if (live) setBusy(false); }); return () => { live = false; }; }, [client, sessionId, worldId, initialUrl]);
  useEffect(() => { let live = true; setPage(null); if (!selected) return; setBusy(true); setError("");
    void client.externalSource(sessionId, worldId, selected.id).then(result => { if (live) setPage(result); }).catch(() => { if (live) setError("这份快照已删除或无法读取。"); }).finally(() => { if (live) setBusy(false); });
    return () => { live = false; };
  }, [client, sessionId, worldId, selected]);
  const more = async () => {
    setBusy(true); setError("");
    try {
      if (selected && page?.nextOffset != null) { const result = await client.externalSource(sessionId, worldId, selected.id, page.nextOffset); setPage({ ...result, text: `${page.text}\n\n${result.text}` }); }
      else if (!selected && next != null) { const result = await client.externalSources(sessionId, worldId, next); setItems(current => [...current, ...result.items]); setNext(result.nextOffset); }
    } catch { setError("后续资料未能读取，请重试。"); } finally { setBusy(false); }
  };
  const url = page?.url ?? selected?.url ?? initialUrl;
  return <Sheet title="资料来源" onClose={onClose}><div className="stack">
    {selected ? <><button className="link" onClick={() => setSelected(null)}>返回来源列表</button><h3>{page?.title || selected.title || "已保存资料"}</h3>{page?.source.capturedAt && <p className="muted">读取于 {new Date(page.source.capturedAt).toLocaleString("zh-CN")}</p>}{page?.text ? <StoryText emphasizeDate={false} text={page.text} /> : !busy && <p className="muted">这份来源保存了定位或检索结果，没有完整网页正文。</p>}</> : <><p className="muted">这里是本次对话实际读到的外部资料。网页说法与原著、本局事实分别核对。</p>{items.map(item => <button className="settings-entry" key={item.id} onClick={() => setSelected(item)}><span>{item.title || item.url || (item.kind.includes("document") ? "资料文件" : "外部资料")}<small>{new Date(item.createdAt).toLocaleString("zh-CN")}</small></span><span>›</span></button>)}{!items.length && !busy && <p className="muted">尚无保存的外部正文；搜索链接不等于已经阅读完整网页。</p>}</>}
    {url && <button className="link" onClick={() => void platform.system.openUrl(url).catch(() => toast("没能打开链接"))}>手动打开原网页</button>}
    {(selected ? page?.nextOffset != null : next != null) && <button disabled={busy} onClick={() => void more()}>继续读取</button>}
    {busy && <p className="muted">正在读取…</p>}{error && <p className="field-hint warn" role="alert">{error}</p>}
  </div></Sheet>;
}
