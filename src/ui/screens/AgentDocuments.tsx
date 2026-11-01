import { useEffect, useState } from "react";
import { AgentClient, type AgentDocumentGrant } from "../../engine/agent";
import { useApp } from "../app/context";
import { Sheet } from "../components/Sheet";
import { Switch } from "../components/Switch";

export function AgentDocuments({ client, onClose }: { client: AgentClient; onClose: () => void }) {
  const { game, toast } = useApp();
  const [grants, setGrants] = useState<AgentDocumentGrant[]>([]);
  const [directory, setDirectory] = useState(false), [writable, setWritable] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const refresh = async () => setGrants(await client.documentGrants());
  useEffect(() => { let live = true; void client.documentGrants().then(value => { if (live) setGrants(value); }).catch(() => { if (live) setError("资料授权读取失败，请重新打开。"); }); return () => { live = false; }; }, [client]);
  const choose = async () => {
    setBusy(true); setError("");
    try {
      const picker = game.repo.platform.files.grantAgentResource;
      if (!picker) throw new Error("当前开发平台没有系统资料授权入口，请在原生应用中选择。");
      const chosen = await picker(directory, writable);
      if (chosen) { await refresh(); if (writable && typeof chosen === "object" && !Array.isArray(chosen) && chosen.writable === false) toast("所选位置只允许读取，已按只读加入"); }
    } catch (failure) { setError(failure instanceof Error ? failure.message : "资料授权未完成。"); }
    finally { setBusy(false); }
  };
  const revoke = async (id: string) => {
    setBusy(true); setError("");
    try { await client.revokeDocument(id); await refresh(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "资料授权未能解除。"); }
    finally { setBusy(false); }
  };
  return <Sheet title="资料文件" onClose={onClose}><div className="stack">
    <p className="muted">选择助手可以查阅的资料，之后在任务中直接说明用途。支持 TXT、EPUB、PDF、DOCX，以及文字笔记。</p>
    <div className="setting"><Switch label="选择整个目录" note="关闭时只选择一个文件。" checked={directory} disabled={busy} onChange={setDirectory} /></div>
    <div className="setting"><Switch label="允许写出笔记" note="仅允许在所选范围写出 TXT、MD、JSON；外部文件不随故事撤回。" checked={writable} disabled={busy} onChange={setWritable} /></div>
    <button disabled={busy} onClick={() => void choose()}>{busy ? "正在处理…" : directory ? "选择资料目录" : "选择资料文件"}</button>
    <p className="muted">新选资料在下一项任务使用。解除授权会阻止后续调用，不会删除你的文件。</p>
    {grants.filter(grant => grant.enabled).map(grant => <div className="setting" key={grant.id}>
      <div className="setting-head"><b>{grant.name || "资料"}</b><small>{grant.directory ? "目录" : "文件"} · {grant.writable ? "可读取和写出笔记" : "只读"}</small></div>
      <button className="ghost" disabled={busy} onClick={() => void revoke(grant.id)}>解除授权</button>
    </div>)}
    {!grants.some(grant => grant.enabled) && <p className="muted">还没有选择资料。</p>}
    {error && <p className="field-hint warn" role="alert">{error}</p>}
  </div></Sheet>;
}
