// 前情提要 (UX_INTL 13): back after a while, the bottom of the story says where
// things stood — the latest chapter, how the last passage ended and the goals
// still open. Built from what is saved; no model call.
import { useEffect, useState } from "react";
import { needsRecap, recapOf, type Recap } from "../../engine/book";
import type { WorldState } from "../../engine/types";
import { useApp } from "../app/context";

/**
 * The recap for a world opened after more than six hours away, or null. The
 * time away counts from the later of the last turn and the last visit, and
 * the visit is recorded at once, so the card shows once per return.
 */
export function useRecap(worldId: string, playedAt: string | null, headId: string | null, state: WorldState | null): [Recap | null, () => void] {
  const { game } = useApp();
  const [recap, setRecap] = useState<Recap | null>(null);
  const [checked, setChecked] = useState(false);
  useEffect(() => {
    if (checked || !playedAt || !headId || !state) return;
    setChecked(true);
    void (async () => {
      const key = "opened:" + worldId;
      const opened = await game.repo.getSetting<number>(key, 0);
      await game.repo.setSetting(key, Date.now());
      if (!needsRecap(Math.max(Date.parse(playedAt) || 0, opened))) return;
      const [path, chapters] = await Promise.all([game.repo.path(headId, 4), game.repo.chaptersOnPath(worldId, headId)]);
      // A short path slice is enough to know the last passage; recapOf only needs to see a turn in it.
      setRecap(recapOf({ path, chapters, state }));
    })();
  }, [checked, playedAt, headId, state, worldId]);
  return [recap, () => setRecap(null)];
}

export function RecapCard({ recap, place, time, onClose }: { recap: Recap; place: string; time: string; onClose: () => void }) {
  return (
    <section className="recap-card" aria-label="前情提要">
      <div className="recap-head">
        <b>前回说到……</b>
        <button className="ghost" onClick={onClose}>收起</button>
      </div>
      {recap.chapter && <p><span className="recap-label">{recap.chapter.heading}</span>{recap.chapter.summary}</p>}
      {recap.last && <p><span className="recap-label">上回停在</span>{recap.last}</p>}
      <p><span className="recap-label">此时此地</span>{place} · {time}</p>
      {recap.goals.length > 0 && <p><span className="recap-label">眼下要做</span>{recap.goals.join("；")}</p>}
    </section>
  );
}
