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
  const pendingWriteRef = useRef(false);
  const buildDraftPayload = (rawInput: string, rawNote: string, isNoteOpen: boolean, modeName: string) => {
    const text = rawInput.trim() ? rawInput : "";
    const kept = isNoteOpen && rawNote.trim() ? rawNote : "";
    return text || kept || modeName !== modeList[0].mode ? { text, note: kept, mode: modeName } : null;
  };
  const latestRef = useRef<{ worldId: string; value: { text: string; note: string; mode: string } | null }>({
    worldId,
    value: null,
  });
  latestRef.current = {
    worldId,
    value: buildDraftPayload(input, note, noteOpen, currentMode.mode),
  };

  // Switching who plays the protagonist starts again from the first way of writing.
  useEffect(() => { if (loaded.current) setModeIndex(0); }, [watch]);
  useEffect(() => {
    loaded.current = false;
    touched.current = false;
    pendingWriteRef.current = false;
  }, [worldId]);
  useEffect(() => {
    if (!ready || loaded.current) return;
    let live = true;
    void game.repo.getSetting<{ text?: string; note?: string; mode?: string } | null>(`draft:${worldId}`, null).then((saved) => {
      if (!live) return;
      loaded.current = true;
      if (!saved) return;
      if (saved.text) setInput((current) => current || saved.text!);
      if (saved.note && !touched.current) { setNote((current) => current || saved.note!); setNoteOpen(true); }
      const index = modeList.findIndex((m) => m.mode === saved.mode);
      if (index > 0 && !touched.current) setModeIndex(index);
    }).catch(() => { if (live) loaded.current = true; });
    return () => { live = false; };
  }, [ready, worldId]);
  useEffect(() => {
    if (!loaded.current) return;
    clearTimeout(timer.current);
    pendingWriteRef.current = true;
    timer.current = setTimeout(() => {
      pendingWriteRef.current = false;
      timer.current = undefined;
      const { worldId: id, value } = latestRef.current;
      void game.repo.setSetting(`draft:${id}`, value).catch(() => {});
    }, 500);
    return () => clearTimeout(timer.current);
  }, [input, note, noteOpen, currentMode.mode, worldId]);
  // Flush any pending debounced draft write synchronously when Play unmounts or switches worldId.
  useEffect(() => {
    return () => {
      if (timer.current !== undefined) {
        clearTimeout(timer.current);
        timer.current = undefined;
      }
      if (loaded.current && pendingWriteRef.current) {
        pendingWriteRef.current = false;
        const { worldId: id, value } = latestRef.current;
        void game.repo.setSetting(`draft:${id}`, value).catch(() => {});
      }
    };
  }, [game, worldId]);

  const selectMode = (mode: string) => { touched.current = true; setModeIndex(Math.max(0, modeList.findIndex((m) => m.mode === mode))); };
  /** After sending: the box and the note are emptied; 写 and 幕后 are one-off ways of writing. */
  const clearAfterSend = (mode: string, keepInput = false) => {
    touched.current = true;
    if (timer.current !== undefined) {
      clearTimeout(timer.current);
      timer.current = undefined;
    }
    pendingWriteRef.current = false;
    setNote("");
    setNoteOpen(false);
    const nextMode = mode === "write" || (mode === "direct" && !watch) ? modeList[0].mode : currentMode.mode;
    if (mode === "write" || (mode === "direct" && !watch)) setModeIndex(0);
    const nextValue = keepInput ? buildDraftPayload(input, "", false, nextMode) : null;
    latestRef.current = { worldId, value: nextValue };
    void game.repo.setSetting(`draft:${worldId}`, nextValue).catch(() => {});
  };
  /** Clears only `input` while keeping any open `directorNote` (`note` + `noteOpen`) and mode intact. */
  const clearInputOnly = () => {
    touched.current = true;
    if (timer.current !== undefined) {
      clearTimeout(timer.current);
      timer.current = undefined;
    }
    pendingWriteRef.current = false;
    setInput("");
    const nextValue = buildDraftPayload("", note, noteOpen, currentMode.mode);
    latestRef.current = { worldId, value: nextValue };
    void game.repo.setSetting(`draft:${worldId}`, nextValue).catch(() => {});
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

  return { input, setInput, note, setNote, noteOpen, setNoteOpen, modeIndex, setModeIndex, modeList, currentMode, selectMode, clearAfterSend, clearInputOnly, restore, clearIfMatches, directorNote };
}
