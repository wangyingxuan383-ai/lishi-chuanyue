interface Lock { release(): Promise<void>; released?: boolean }

/** Native IPC must finish applying one flag before the next intent can overtake it. */
export function orderedKeepAwake(send: (enabled: boolean) => Promise<void>) {
  let tail = Promise.resolve();
  return (enabled: boolean): Promise<void> => {
    const next = tail.catch(() => {}).then(() => send(enabled));
    tail = next;
    return next;
  };
}

/** A delayed grant after leaving/turning off is released immediately. */
export function screenAwakeController(request: () => Promise<Lock>, visible: () => boolean) {
  let enabled = false;
  let generation = 0;
  let lock: Lock | null = null;
  let pending = false;
  const sync = async () => {
    if (!enabled || !visible()) {
      generation++;
      pending = false;
      const previous = lock;
      lock = null;
      await previous?.release().catch(() => {});
      return;
    }
    if ((lock && !lock.released) || pending) return;
    const ticket = generation;
    pending = true;
    try {
      const next = await request();
      if (ticket !== generation || !enabled || !visible()) await next.release().catch(() => {});
      else lock = next;
    } catch { /* Unsupported/denied: retain the device's normal screen timeout. */ }
    finally { if (ticket === generation) pending = false; }
  };
  return { setEnabled(on: boolean) { enabled = on; return sync(); }, visibilityChanged: sync };
}

let controller: ReturnType<typeof screenAwakeController> | undefined;
export function setBrowserKeepAwake(enabled: boolean): Promise<void> {
  if (!controller) {
    controller = screenAwakeController(() => navigator.wakeLock.request("screen"), () => document.visibilityState === "visible");
    document.addEventListener("visibilitychange", () => { void controller!.visibilityChanged(); });
  }
  return controller.setEnabled(enabled);
}
