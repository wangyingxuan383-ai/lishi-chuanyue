// 改后同步 (D183): saving an edited passage asks whether its facts change too.
// “只改文字” keeps today's behaviour; “事实也一起改” asks the AI once to bring the
// turn's record and the earlier settings in line with the edited text, which stays
// exactly as the player wrote it.
import { useEffect, useRef, useState } from "react";
import { writingError, type PlayerRevisionPreview, type WritingAnchor } from "../../engine/writing/assist";
import { useApp } from "../app/context";
import { Sheet } from "./Sheet";
import { RecordChanges } from "./WritingAssist";

export interface FactSyncAsk { anchor: WritingAnchor; text: string; latest: boolean }

export function FactSyncSheet({ ask, onTextOnly, onAdopt, onClose }: {
  ask: FactSyncAsk; onTextOnly: () => Promise<void>; onAdopt: (preview: PlayerRevisionPreview) => Promise<void>; onClose: () => void;
}) {
  const { game } = useApp();
  const [step, setStep] = useState<"ask" | "syncing" | "preview">("ask");
  const [preview, setPreview] = useState<(PlayerRevisionPreview & { unchanged: boolean }) | null>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const task = useRef<{ cancel(): void } | null>(null);
  useEffect(() => () => task.current?.cancel(), []);
  const sync = async () => {
    setStep("syncing"); setError("");
    const work = game.runFactSync({ anchor: ask.anchor, text: ask.text });
    task.current = work;
    try {
      const result = await work.done;
      setPreview(result);
      setStep("preview");
    } catch (e) { setError(writingError(e)); setStep("ask"); }
    finally { task.current = null; }
  };
  const run = async (action: () => Promise<void>) => {
    setSaving(true); setError("");
    try { await action(); onClose(); } catch (e) { setError(writingError(e)); } finally { setSaving(false); }
  };
  const where = ask.latest ? "改好的会成为这一段的另一个版本，原来的留着。" : "这段不是最新一段：会另起一条“改写后的路线”，原路线和后面的剧情都留着。";
  return <Sheet title="这段的事实也要一起改吗？" onClose={() => { task.current?.cancel(); onClose(); }}>
    <div className="stack">
      {step === "ask" && <>
        <p className="muted m-0">只改了措辞的话，选“只改文字”。改了人名、关系、数字、本事、物品或发生了什么，选“事实也一起改”：AI 会对照改动，把本回合记录和之前的设定一起改正（用一次请求），以后的剧情就照新的写。</p>
        <div className="stack gap-2">
          <button className="primary" disabled={saving} onClick={() => void sync()}>事实也一起改</button>
          <button disabled={saving} onClick={() => void run(onTextOnly)}>只改文字</button>
          <button className="ghost" disabled={saving} onClick={onClose}>取消，不保存</button>
        </div>
      </>}
      {step === "syncing" && <p className="m-0" role="status"><span className="cursor-blink">AI 正在对照改动整理记录</span></p>}
      {step === "preview" && preview && <>
        {preview.unchanged
          ? <p className="m-0">看下来只是措辞变了，事实不用改。</p>
          : <>
            {preview.note && <p className="m-0">{preview.note}</p>}
            <RecordChanges changes={preview.recordChanges} patch={preview.correctionPatch} dropped={preview.droppedCorrections} />
            <p className="muted m-0">{where}</p>
          </>}
        <div className="writing-actions">
          <button disabled={saving} onClick={onClose}>取消，不保存</button>
          {preview.unchanged
            ? <button className="primary" disabled={saving} onClick={() => void run(onTextOnly)}>保存文字</button>
            : <>
              <button disabled={saving} onClick={() => void run(onTextOnly)}>只改文字</button>
              <button className="primary" disabled={saving} onClick={() => void run(() => onAdopt(preview))}>采用</button>
            </>}
        </div>
      </>}
      {error && <p role="alert" className="field-hint warn m-0">{error}</p>}
    </div>
  </Sheet>;
}
