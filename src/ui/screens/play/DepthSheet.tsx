// 生成档位 (R29, D161): 快速 / 标准 / 深度 for this story, one tap from the
// story's top bar. 设置 → 游玩默认 holds the default for new stories.
import { DEPTHS, DEPTH_LABEL, DEPTH_MARK, DEPTH_NOTE, type Depth } from "../../../engine/depth";
import { Sheet } from "../../components/Sheet";

export function DepthCards({ value, onChange }: { value: Depth; onChange: (depth: Depth) => void }) {
  return (
    <div className="depth-cards" role="radiogroup" aria-label="生成档位">
      {DEPTHS.map((d) => (
        <button key={d} role="radio" aria-checked={value === d} className={`depth-card depth-${d}`} onClick={() => onChange(d)}>
          <span className="depth-mark" aria-hidden="true">{DEPTH_MARK[d]}</span>
          <span className="depth-text"><b>{DEPTH_LABEL[d]}{d === "standard" ? <small>（推荐）</small> : null}</b><small>{DEPTH_NOTE[d]}</small></span>
        </button>
      ))}
    </div>
  );
}

export function DepthSheet({ value, onChange, onClose }: { value: Depth; onChange: (depth: Depth) => void; onClose: () => void }) {
  return (
    <Sheet title="生成档位" onClose={onClose}>
      <p className="muted m-0">只改这个故事，从下一段起生效。每段花了多少，写完后在正文下方能看到。</p>
      <DepthCards value={value} onChange={(d) => { onChange(d); onClose(); }} />
    </Sheet>
  );
}
