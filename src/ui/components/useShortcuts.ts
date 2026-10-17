// Desktop keyboard shortcuts (PLAN_V4 direction E, UX_APP_BASICS #56).
// Only active with a mouse and keyboard. Inside a text box only Ctrl/Alt
// combinations and F-keys count, so typing is never taken over, and nothing
// fires while an input method is composing Chinese text. While a sheet or
// dialog is open the screen's shortcuts wait; Escape closes the sheet first.
import { useEffect, useRef } from "react";

export interface Shortcut {
  /** Runs the action; return false when it did not apply (the key then does what it normally does). */
  run: () => boolean | void;
  /** Also works while typing in a text box (only Ctrl/Alt combinations and F-keys ever do). */
  inInputs?: boolean;
  /** Also works while a sheet or dialog is open. */
  overSheets?: boolean;
}

/** "Ctrl+Shift+Z", "Alt+1", "F1", "?", "Ctrl+/"…: one name per key press. */
export function comboOf(e: KeyboardEvent): string {
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push("Ctrl");
  if (e.altKey) parts.push("Alt");
  const printable = e.key.length === 1;
  // Shift is part of "?" itself, but not of "Z".
  if (e.shiftKey && (!printable || /[a-z]/i.test(e.key))) parts.push("Shift");
  // With Alt held some layouts change the character; the physical digit is what counts.
  const main = /^Digit\d$/.test(e.code) ? e.code.slice(5) : printable ? e.key.toUpperCase() : e.key;
  parts.push(main);
  return parts.join("+");
}

function editable(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || !el.closest) return false;
  return !!el.closest("input, textarea, select, [contenteditable=''], [contenteditable='true']");
}

const OVERLAY = ".sheet, .dialog, .panel:not(.docked)";

export function useShortcuts(map: Record<string, Shortcut>, enabled: boolean) {
  const latest = useRef(map);
  latest.current = map;
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing || e.key === "Process" || e.keyCode === 229) return;
      const shortcut = latest.current[comboOf(e)];
      if (!shortcut) return;
      const modified = e.ctrlKey || e.metaKey || e.altKey || /^F\d+$/.test(e.key);
      if (editable(e.target) && (!modified || !shortcut.inInputs)) return;
      // A Ctrl combination of ours never falls through to the WebView's own
      // (Ctrl+R would reload the page and lose what is on screen).
      if (e.ctrlKey || e.metaKey) e.preventDefault();
      if (e.repeat) return;
      if (!shortcut.overSheets && document.querySelector(OVERLAY)) return;
      if (shortcut.run() === false) return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled]);
}
