import { useEffect, useRef, useState } from "react";
import { AgentClient, type AgentToolPackage } from "../../engine/agent";
import { useApp } from "../app/context";
import { Sheet } from "../components/Sheet";
import { Switch } from "../components/Switch";

export function AgentToolPackages({ client, onClose }: { client: AgentClient; onClose: () => void }) {
  const { game } = useApp();
  const [packages, setPackages] = useState<AgentToolPackage[]>([]);
  const importing = useRef<string | null>(null);
  const [importId, setImportId] = useState<string | null>(null);
  useEffect(() => () => { if (importing.current) void client.cancelToolPackageImport(importing.current); }, [client]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const refresh = async () => setPackages(await client.toolPackages());
  useEffect(() => { let live = true; void client.toolPackages().then(value => { if (live) setPackages(value); }).catch(() => { if (live) setError("工具包读取失败，请重新打开。"); }); return () => { live = false; }; }, [client]);
  const importPackage = async () => {
    setBusy(true); setError("");
    try {
      const picker = game.repo.platform.files.importSkillPackage;
      if (!picker) throw new Error("当前平台尚未提供工具包文件选择器。");
      const selected = await picker();
      if (selected) {
        let binary = "";
        for (let offset = 0; offset < selected.bytes.length; offset += 8192) binary += String.fromCharCode(...selected.bytes.slice(offset, offset + 8192));
        const importId = crypto.randomUUID(); importing.current = importId; setImportId(importId);
        await client.importToolPackage(btoa(binary), importId); await refresh();
      }
    } catch (failure) { setError(failure instanceof Error ? failure.message : "工具包未能导入，请检查文件和兼容范围。"); }
    finally { importing.current = null; setImportId(null); setBusy(false); }
  };
  const toggle = async (entry: AgentToolPackage, enabled: boolean) => {
    setBusy(true); setError("");
    try { await client.enableToolPackage(entry.id, enabled); await refresh(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "工具包设置未能保存。"); }
    finally { setBusy(false); }
  };
  return <Sheet title="工具包" onClose={onClose}><div className="stack">
    <p className="muted">支持 Operit 纯 JavaScript 工具包的部分接口。先检查兼容情况，再启用；不会安装终端或扩大授权。</p>
    <button disabled={busy} onClick={() => void importPackage()}>{busy ? "正在处理…" : "从文件导入工具包"}</button>
    <button className="link" hidden={!importId} onClick={() => { if (importing.current) void client.cancelToolPackageImport(importing.current); }}>取消导入</button>
    <p className="muted">启用对新任务生效；停用会阻止后续调用。工具包中的文字和代码可以使用已授权工具，不能直接访问密钥。</p>
    {packages.map(entry => <div className="setting" key={entry.id}>
      <Switch label={entry.name || entry.packageId || "工具包"} note={`${entry.version} · ${entry.compatibility.supported ? "支持纯工具子集" : "存在缺失能力"}`} checked={entry.enabled} disabled={busy || entry.draft || !entry.compatibility.supported} onChange={enabled => void toggle(entry, enabled)} />
      {entry.draft && <button disabled={busy} onClick={() => { setBusy(true); void client.adoptToolPackage(entry.id, entry.hash).then(refresh).catch(failure => setError(failure instanceof Error ? failure.message : "草稿未能保存。")).finally(() => setBusy(false)); }}>保存为常用工具包</button>}
      {entry.description && <p>{entry.description}</p>}
      <details><summary>兼容详情与工具</summary><div className="stack">
        {entry.compatibility.missing.map((message, index) => <p className="field-hint warn" key={index}>{message}</p>)}
        {entry.compatibility.tools.map(tool => <p key={`${tool.entry}:${tool.name}`}>{tool.name}<small className="muted"> · {tool.entry}</small></p>)}
      </div></details>
    </div>)}
    {!packages.length && !busy && <p className="muted">还没有导入工具包。</p>}
    {error && <p className="field-hint warn" role="alert">{error}</p>}
  </div></Sheet>;
}
