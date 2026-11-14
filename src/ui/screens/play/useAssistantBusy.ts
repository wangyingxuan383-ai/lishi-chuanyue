// A story has one writer at a time, even while its assistant works on another
// page: poll the Pi assistant's running tasks (fast while one runs, slow
// otherwise; a committed change also triggers a check).
import { useEffect, useRef, useState } from "react";
import type { Game } from "../../../engine/game";

export function useAssistantBusy(game: Game, worldId: string, onChange: (running: boolean) => void) {
  const [busy, setBusy] = useState(false);
  const active = useRef(false);
  const changed = useRef(onChange);
  changed.current = onChange;
  useEffect(() => {
    let live = true;
    const check = async () => {
      try {
        // The Pi assistant's tasks (pi_tasks); the old agent_task runs no longer exist (R26-T002).
        const rows = await game.platform.sql.query("SELECT id FROM pi_tasks WHERE world_id=? AND status IN ('running','committing') LIMIT 1", [worldId]);
        if (!live) return;
        const running = !!rows.length;
        if (running !== active.current) { active.current = running; changed.current(running); }
        setBusy(running);
      } catch { /* An older host still reports conflicts when a run starts. */ }
    };
    void check();
    let timer = 0;
    const loop = () => { timer = window.setTimeout(async () => { await check(); if (live) loop(); }, active.current ? 1000 : 4000); };
    loop();
    const off = game.subscribe((id) => { if (id === worldId) void check(); });
    return () => { live = false; window.clearTimeout(timer); off(); };
  }, [game, worldId]);
  return busy;
}
