import { useState } from "react";
import { Sheet } from "../../components/Sheet";
import { PASTIMES, SPANS } from "./constants";

export function SkipSheet({ onStart, onClose }: { onStart: (text: string) => void; onClose: () => void }) {
  const [span, setSpan] = useState("一个月");
  const [pastime, setPastime] = useState("照常过日子");
  const [own, setOwn] = useState("");
  const how = pastime === "自己写" ? own.trim() : pastime;
  return (
    <Sheet title="过些日子" onClose={onClose}>
      <div className="stack">
        <span className="muted">过多久</span>
        <div className="segmented">
          {SPANS.map(([label]) => <button key={label} aria-pressed={span === label} onClick={() => setSpan(label)}>{label}</button>)}
        </div>
        <span className="muted">这段时间做什么</span>
        <div className="segmented">
          {[...PASTIMES, "自己写"].map((p) => <button key={p} aria-pressed={pastime === p} onClick={() => setPastime(p)}>{p}</button>)}
        </div>
        {pastime === "自己写" && <input aria-label="这段时间做什么" value={own} onChange={(e) => setOwn(e.target.value)} placeholder="如：在西市摆摊替人写信" />}
        <p className="muted m-0">遇到要你拿主意的事，会提前停下来。</p>
        <button className="primary" disabled={!how} onClick={() => onStart(`${SPANS.find(([label]) => label === span)![1]}；这段时间${how}`)}>开始</button>
      </div>
    </Sheet>
  );
}
