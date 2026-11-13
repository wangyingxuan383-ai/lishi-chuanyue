// Exit motion (R28): overlays play a short closing animation before they are
// removed. With reduced motion (system setting or 阅读设置 → 动效 off) they
// are removed at once.

/** How long a closing overlay stays on screen; matches --dur-fast in base.css plus a frame. */
export const EXIT_MS = 170;

export function motionOn(): boolean {
  if (typeof document === "undefined") return false;
  if (document.documentElement.dataset.motion === "off") return false;
  // Test environments without matchMedia get no motion, so overlays close at once there.
  if (typeof matchMedia !== "function") return false;
  return !matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Which way the last navigation went, for the screen entry animation. */
export function markNavigation(direction: "push" | "pop"): void {
  if (typeof document !== "undefined") document.documentElement.dataset.nav = direction;
}

/** A short vibration for a sent action, a finished passage or a failure; follows the 震动 setting. */
export function buzz(platform: { system: { haptic(): Promise<boolean> } }): void {
  if (typeof document !== "undefined" && document.documentElement.dataset.haptics === "off") return;
  void platform.system.haptic().catch(() => false);
}
