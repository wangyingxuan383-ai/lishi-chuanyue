// Asked once before the first passage on Android. Closing the sheet is not a no (it asks again next time);
// a no is remembered, and Settings shows the state with a way to the system switch (ANDROID_COMPAT F1).
import { useState } from "react";
import type { Game } from "../../../engine/game";
import type { AppValue } from "../../app/context";
import { Sheet } from "../../components/Sheet";

export function useNotificationGate(game: Game, toast: AppValue["toast"]) {
  const [pending, setPending] = useState<(() => void) | null>(null);
  const gate = async (start: () => void) => {
    if (game.platform.name !== "android" || await game.repo.getSetting("notifAsked", false)) { start(); return; }
    const status = await game.platform.system.notificationStatus().catch(() => ({ granted: false, enabled: false }));
    if (status.enabled) { await game.repo.setSetting("notifAsked", true); start(); return; }
    setPending(() => start);
  };
  const answer = async (choice: "allow" | "no" | "later") => {
    const start = pending;
    setPending(null);
    if (choice !== "later") await game.repo.setSetting("notifAsked", true);
    if (choice === "allow") {
      const granted = await game.platform.system.requestNotifications().catch(() => false);
      if (!granted) toast("没有打开通知。以后可以在 设置 → 通知 里打开", { label: "去打开", run: () => void game.platform.system.openSystemSettings("notifications") });
    }
    start?.();
  };
  const sheet = pending && (
    <Sheet title="写好了提醒你？" onClose={() => void answer("later")}>
      <p className="muted mt-0">切到别的应用时，故事会在后台接着写。打开通知，写好了会提醒你回来看。</p>
      <div className="row"><button className="primary grow" onClick={() => void answer("allow")}>打开通知</button><button onClick={() => void answer("no")}>不用了</button></div>
    </Sheet>
  );
  return { gate, sheet };
}
