import type { StoryNode } from "../../../engine/types";
import type { AppValue } from "../../app/context";
import { Sheet } from "../../components/Sheet";

interface RememberSheetProps {
  remember: { node: StoryNode; text: string };
  setRemember: (value: { node: StoryNode; text: string } | null) => void;
  game: AppValue["game"];
  worldId: string;
  toast: AppValue["toast"];
}

export function RememberSheet({ remember, setRemember, game, worldId, toast }: RememberSheetProps) {
  return (
    <Sheet title="记住这件事" onClose={() => setRemember(null)}>
      <div className="stack">
        <p className="muted m-0">把这段删改成一句要点。AI 之后每一段都会记着它；只在这条路线有效，回到这段之前就不算数。</p>
        <textarea rows={6} aria-label="要点" value={remember.text} onChange={(e) => setRemember({ ...remember, text: e.target.value })} />
        {remember.text.length > 120 && <p className="muted m-0">{remember.text.length} 字，越短越好。</p>}
        <button className="primary" disabled={!remember.text.trim()} onClick={() => {
          const { node, text } = remember;
          setRemember(null);
          void game.repo.addPin(worldId, node.id, text).then(() => toast("记下了"));
        }}>记下</button>
      </div>
    </Sheet>
  );
}
