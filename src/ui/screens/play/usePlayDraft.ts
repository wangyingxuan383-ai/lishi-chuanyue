// What the player is about to send, kept per story (R28): the words in the box,
// the 幕后要求 and the way of writing survive leaving the story or closing the
// app; sending clears them.
import { useEffect, useRef, useState } from "react";
import type { Game } from "../../../engine/game";
import type { Restore } from "./useGeneration";
import { MODES, WATCH_MODES } from "./constants";

export function usePlayDraft(game: Game, worldId: string, ready: boolean, watch: boolean) {
  const [input, setInput] = useState("");
  const [note, setNote] = useState("");
  const [noteOpen, setNoteOpen] = useState(false);
  const [modeIndex, setModeIndex] = useState(0);
  const modeList = watch ? WATCH_MODES : MODES;
  const currentMode = modeList[modeIndex] ?? modeList[0];
  const loaded = useRef(false);
  const touched = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  // Switching who plays the protagonist starts again from the first way of writing.
  useEffect(() => { if (loaded.current) setModeIndex(0); }, [watch]);
  useEffect(() => {
    if (!ready || loaded.current) return;
    void game.repo.getSetting<{ text?: string; note?: string; mode?: string } | null>(`draft:${worldId}`, null).then((saved) => {
      loaded.current = true;
      if (!saved) return;
      if (saved.text) setInput((current) => current || saved.text!);
      if (saved.note && !touched.current) { setNote((current) => current || saved.note!); setNoteOpen(true); }
      const index = modeList.findIndex((m) => m.mode === saved.mode);
      if (index > 0 && !touched.current) setModeIndex(index);
    }).catch(() => { loaded.current = true; });
  }, [ready, worldId]);
  useEffect(() => {
    if (!loaded.current) return;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const text = input.trim() ? input : "", kept = noteOpen && note.trim() ? note : "";
      void game.repo.setSetting(`draft:${worldId}`, text || kept || currentMode.mode !== modeList[0].mode ? { text, note: kept, mode: currentMode.mode } : null).catch(() => {});
    }, 500);
    return () => clearTimeout(timer.current);
  }, [input, note, noteOpen, currentMode.mode, worldId]);

  const selectMode = (mode: string) => { touched.current = true; setModeIndex(Math.max(0, modeList.findIndex((m) => m.mode === mode))); };
  /** After sending: the box and the note are emptied; 写 and 幕后 are one-off ways of writing. */
  const clearAfterSend = (mode: string) => {
    touched.current = true;
    setNote("");
    setNoteOpen(false);
    if (mode === "write" || (mode === "direct" && !watch)) setModeIndex(0);
  };
  /** A failed action comes back to the box, with its way of writing and note. */
  const restore = (r: Restore, force = false) => {
    touched.current = true;
    // Auto-restore never overwrites words typed meanwhile; an explicit button tap always restores.
    if (r.text.trim() || force) setInput((current) => (!force && current.trim() ? current : r.text));
    if (r.mode !== "continue" && r.mode !== "skip") selectMode(r.mode);
    if (r.note.trim()) { setNote((current) => (!force && current.trim() ? current : r.note)); setNoteOpen(true); }
  };
  /** Clears an auto-restored draft right before NoticeCard retries that exact saved run, preventing duplicates. */
  const clearIfMatches = (r: Restore) => {
    if (r.text.trim()) setInput((current) => (current.trim() === r.text.trim() ? "" : current));
    if (r.note.trim()) {
      setNote((current) => {
        if (current.trim() === r.note.trim()) { setNoteOpen(false); return ""; }
        return current;
      });
    }
  };
  /** The 幕后要求 that goes with the next passage (typed action or tapped choice alike). */
  const directorNote = () => (!watch && noteOpen && note.trim() ? note.trim() : null);

  return { input, setInput, note, setNote, noteOpen, setNoteOpen, modeIndex, setModeIndex, modeList, currentMode, selectMode, clearAfterSend, restore, clearIfMatches, directorNote };
}
