// Exit motion (R28): overlays play a short closing animation before they are
// removed. With reduced motion (system setting or 阅读设置 → 动效 off) they
// are removed at once.

/** How long a closing overlay stays on screen; matches --dur-fast in base.css plus a frame. */
export const EXIT_MS = 170;

/** rich / simple / off (D160); the system's "reduce motion" always means off. */
export function motionLevel(): "rich" | "simple" | "off" {
  if (typeof document === "undefined" || typeof matchMedia !== "function") return "off";
  const level = document.documentElement.dataset.motion;
  if (level === "off" || matchMedia("(prefers-reduced-motion: reduce)").matches) return "off";
  return level === "simple" ? "simple" : "rich";
}

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

/** Ink ripples on buttons at 华丽 (D160): one listener for the whole app. */
const RIPPLE = "button.primary, .choice, .tool-btn, .send-btn, .sheet-menu button, .world-open, .mode-option, .settings-entry, .new-story, .theme-card, .style-card";
export function installRipples(): () => void {
  const onDown = (e: PointerEvent) => {
    if (motionLevel() !== "rich" || e.button !== 0) return;
    const target = (e.target as Element | null)?.closest<HTMLElement>(RIPPLE);
    if (!target || (target as HTMLButtonElement).disabled) return;
    const rect = target.getBoundingClientRect();
    const size = Math.max(rect.width, rect.height);
    const dot = document.createElement("span");
    dot.className = "ripple";
    dot.style.width = dot.style.height = `${size}px`;
    dot.style.left = `${e.clientX - rect.left - size / 2}px`;
    dot.style.top = `${e.clientY - rect.top - size / 2}px`;
    if (getComputedStyle(target).position === "static") target.style.position = "relative";
    target.style.overflow = "hidden";
    target.appendChild(dot);
    dot.addEventListener("animationend", () => dot.remove(), { once: true });
    if (target.classList.contains("send-btn")) {
      target.classList.remove("fired"); void target.offsetWidth; target.classList.add("fired");
    }
  };
  document.addEventListener("pointerdown", onDown, { passive: true });
  return () => document.removeEventListener("pointerdown", onDown);
}

type ViewTransitionDocument = Document & { startViewTransition?: (update: () => void) => { finished: Promise<void> } };
/**
 * Runs a navigation inside a View Transition at 华丽 (where the WebView has the
 * API); otherwise just runs it. `prepare` can name shared elements in the new page.
 */
export function withViewTransition(direction: "push" | "pop", update: () => void, prepare?: () => void): void {
  const doc = document as ViewTransitionDocument;
  if (motionLevel() !== "rich" || typeof doc.startViewTransition !== "function") { update(); prepare?.(); return; }
  const root = document.documentElement;
  root.dataset.vt = direction;
  try {
    const vt = doc.startViewTransition(() => { update(); prepare?.(); });
    void vt.finished.finally(() => {
      delete root.dataset.vt;
      document.querySelectorAll<HTMLElement>("[data-vt-named]").forEach((el) => { el.style.viewTransitionName = ""; delete el.dataset.vtNamed; });
    });
  } catch { delete root.dataset.vt; update(); prepare?.(); }
}
/** Gives an element a View Transition name until the transition ends. */
export function nameForTransition(el: Element | null | undefined, name: string): void {
  if (!el) return;
  (el as HTMLElement).style.viewTransitionName = name;
  (el as HTMLElement).dataset.vtNamed = "1";
}
