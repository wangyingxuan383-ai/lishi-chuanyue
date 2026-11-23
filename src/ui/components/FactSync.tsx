// 改后同步 (D183): saving an edited passage asks whether its facts change too.
// “只改文字” keeps today's behaviour; “事实也一起改” asks the AI once to bring the
// turn's record and the earlier settings in line with the edited text, which stays
// exactly as the player wrote it.
import { useEffect, useMemo, useRef, useState } from "react";
import { writingError, type PlayerRevisionPreview, type WritingAnchor } from "../../engine/writing/assist";
import { useApp } from "../app/context";
import { Sheet } from "./Sheet";
import { RecentUsageLine } from "./TurnUsage";
import { DiffView, RecordChanges } from "./WritingAssist";
import { diffStats, diffText } from "./textDiff";

export interface FactSyncAsk { anchor: WritingAnchor; text: string; latest: boolean; isOpening?: boolean; autoStart?: boolean }

export function FactSyncSheet({ ask, onTextOnly, onAdopt, onClose }: {
  ask: FactSyncAsk; onTextOnly: () => Promise<void>; onAdopt: (preview: PlayerRevisionPreview) => Promise<void>; onClose: () => void;
}) {
  const { game } = useApp();
  const [step, setStep] = useState<"ask" | "syncing" | "preview">(ask.autoStart ? "syncing" : "ask");
  const [preview, setPreview] = useState<(PlayerRevisionPreview & { unchanged: boolean }) | null>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [since, setSince] = useState<string | null>(null);
  const [usageTick, setUsageTick] = useState(0);
  const task = useRef<{ cancel(): void } | null>(null);
  const autoStarted = useRef(false);
  useEffect(() => () => task.current?.cancel(), []);
  const stats = useMemo(() => diffStats(diffText(ask.anchor.original, ask.text)), [ask.anchor.original, ask.text]);
  const hasDiff = stats.added > 0 || stats.removed > 0;
  const sync = async () => {
    setStep("syncing"); setError(""); setSince((prev) => prev ?? new Date().toISOString());
    const work = game.runFactSync({ anchor: ask.anchor, text: ask.text });
    task.current = work;
    try {
      const result = await work.done;
      setPreview(result);
      setStep("preview");
    } catch (e) { setError(writingError(e)); setStep("ask"); }
    finally { task.current = null; setUsageTick((n) => n + 1); }
  };
  useEffect(() => {
    if (!ask.autoStart || autoStarted.current) return;
    autoStarted.current = true;
    void sync();
  }, [ask.autoStart]);
  const run = async (action: () => Promise<void>) => {
    setSaving(true); setError("");
    try { await action(); onClose(); } catch (e) { setError(writingError(e)); } finally { setSaving(false); }
  };
  const where = ask.isOpening
    ? "这是开场段：采用后会另起一条“修订开场后的路线”，原来的开场留着。"
    : ask.latest
      ? "改好的会成为这一段的另一个版本，原来的留着。"
      : "这段不是最新一段：会另起一条“改写后的路线”，原路线和后面的剧情都留着。";
  return <Sheet title="这段的事实也要一起改吗？" onClose={() => { task.current?.cancel(); onClose(); }}>
    <div className="stack">
      {hasDiff && step !== "syncing" && (
        <details className="diff-fold">
          <summary>查看正文改动<span className="diff-counts">{stats.removed > 0 && <em className="del">-{stats.removed}</em>}{stats.added > 0 && <em className="ins">+{stats.added}</em>}</span></summary>
          <DiffView before={ask.anchor.original} after={ask.text} />
        </details>
      )}
      {step === "ask" && <>
        <p className="muted m-0">只改了措辞的话，选“只改文字”。改了人名、关系、数字、本事、物品或发生了什么，选“事实也一起改”：AI 会对照改动，把本回合记录和之前的设定一起改正（用一次请求），以后的剧情就照新的写。</p>
        <div className="stack gap-2">
          <button className="primary" disabled={saving} onClick={() => void sync()}>事实也一起改</button>
          <button disabled={saving} onClick={() => void run(onTextOnly)}>只改文字</button>
          <button className="ghost" disabled={saving} onClick={onClose}>取消，不保存</button>
        </div>
      </>}
      {step === "syncing" && <p className="m-0" role="status"><span className="cursor-blink">AI 正在对照改动整理记录</span></p>}
      {step === "preview" && preview && (() => {
        const noFactChange = preview.unchanged || (preview.recordChanges.length === 0 && !preview.correctionPatch);
        return <>
        {noFactChange
          ? <p className="m-0">看下来只是措辞变了，事实不用改。</p>
          : <>
            {preview.note && <p className="m-0">{preview.note}</p>}
            <RecordChanges changes={preview.recordChanges} patch={preview.correctionPatch} dropped={preview.droppedCorrections} />
            <p className="muted m-0">{where}</p>
          </>}
        <div className="writing-actions">
          <button disabled={saving} onClick={onClose}>取消，不保存</button>
          {noFactChange
            ? <button className="primary" disabled={saving} onClick={() => void run(onTextOnly)}>保存文字</button>
            : <>
              <button disabled={saving} onClick={() => void run(onTextOnly)}>只改文字</button>
              <button className="primary" disabled={saving} onClick={() => void run(() => onAdopt({ ...preview, anchor: { ...preview.anchor, headId: ask.anchor.headId } }))}>采用</button>
            </>}
        </div>
      </>; })()}
      {step !== "syncing" && since && <RecentUsageLine worldId={ask.anchor.worldId} purposes={["sync-facts"]} since={since} refreshKey={usageTick} />}
      {error && <p role="alert" className="field-hint warn m-0">{error}</p>}
    </div>
  </Sheet>;
}
