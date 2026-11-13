import type { RefObject } from "react";
import type { ActionMode, StoryNode, WorldState } from "../../../engine/types";
import type { Cursor } from "../../../engine/tree";
import type { AppValue } from "../../app/context";
import { Icon } from "../../components/Icon";
import { Sheet } from "../../components/Sheet";
import { ChoiceButton } from "./ChoiceButton";
import { MODE_NOTES, WATCH_NOTES, type MODES } from "./constants";
import type { Gen } from "./types";

interface PlayDockProps {
  dead: boolean; state: WorldState; watch?: boolean; auto: { step: number; total: number } | null;
  showChoices: boolean; input: string; typing: boolean; mouse: boolean; busy: boolean;
  turn: StoryNode | undefined; head: StoryNode; noteOpen: boolean; mode: typeof MODES[number]; note: string;
  inputBox: RefObject<HTMLTextAreaElement | null>; gen: Gen | null; roomy: boolean; modeIndex: number;
  agentBusy: boolean; sendLabel: string;
  setDesk: (open: boolean) => void;
  setSheet: (sheet: "autoplay") => void;
  send: (override?: { mode: ActionMode; text: string }, overrideNote?: string | null) => void;
  setInput: (text: string) => void;
  setModeIndex: (index: number) => void;
  setNote: (note: string) => void;
  setNoteOpen: (open: boolean) => void;
  openWriting: (kind: "rewrite" | "polish", node: StoryNode) => void;
  setModePicker: (open: boolean) => void;
  setTyping: (typing: boolean) => void;
  stopOrSend: () => void;
}

export function PlayDock({ dead, state, watch, auto, showChoices, input, typing, mouse, busy, turn, head, noteOpen, mode, note,
  inputBox, gen, roomy, modeIndex, agentBusy, sendLabel, setDesk, setSheet, send, setInput, setModeIndex, setNote,
  setNoteOpen, openWriting, setModePicker, setTyping, stopOrSend }: PlayDockProps) {
  return (
    <div className="dock">
      {!dead && state.protagonist.statuses.some((x) => x.name === "垂危") && <p className="dying-note">你伤重垂危：再受重伤就会死去，先设法疗伤。</p>}
      {/* 旁观: one row for 连播 (or its progress) and, while typing, the big box; the suggestions under it are directions. */}
      {!dead && (watch || auto) && (
        <div className="dock-tools">
          {auto ? (
            <span className="autoplay-state" role="status">连播 {Math.max(1, auto.step)}/{auto.total}
              <span className="autoplay-dots" aria-hidden="true">{Array.from({ length: auto.total }, (_, i) => <i key={i} className={i + 1 < auto.step ? "done" : i + 1 === auto.step ? "now" : ""} />)}</span>
            </span>
          ) : showChoices ? <span className="choices-head">接下来可以……</span> : <span />}
          {/* With words in the box (or the keyboard up on a phone) the big box is the tool; otherwise 连播. */}
          {!auto && (input.trim() || (typing && !mouse)
            ? <button className="ghost" disabled={busy} onMouseDown={(e) => e.preventDefault()} onClick={() => setDesk(true)}>展开输入</button>
            : <button className="autoplay-btn" disabled={busy} onClick={() => setSheet("autoplay")}><span>连播</span></button>)}
        </div>
      )}
      {showChoices && (
        <div className="choices">
          {turn!.choices.map((choice, i) => <ChoiceButton key={choice} text={choice} title={mouse ? `${i < 4 ? `Alt+${i + 1} 选这个，` : ""}右键放进输入框改一改` : undefined}
            onTap={() => send({ mode: watch ? "direct" : "do", text: choice })} onLong={() => { setInput(choice); setModeIndex(0); }} />)}
        </div>
      )}
      {noteOpen && !watch && mode.mode !== "direct" && (
        <div className="row director-row">
          <input className="director-note grow" value={note} onChange={(e) => setNote(e.target.value)} placeholder="幕后要求（只影响这一段）" aria-label="幕后要求" />
          <button className="icon-btn" aria-label="去掉幕后要求" onClick={() => { setNote(""); setNoteOpen(false); }}><Icon name="close" size={20} /></button>
        </div>
      )}
      {/* The writing tools come up with the keyboard, so they never take reading space at rest. */}
      {!dead && !watch && (typing || !!input.trim()) && (
        <div className="dock-tools end">
          <button className="ghost" disabled={busy || !input.trim()} onMouseDown={(e) => e.preventDefault()} onClick={() => openWriting("polish", turn ?? head)}>润色行动</button>
          <button className="ghost" disabled={busy} onMouseDown={(e) => e.preventDefault()} onClick={() => setDesk(true)}>展开输入</button>
        </div>
      )}
      <div className="inputbar">
        <button className="mode-btn" aria-label={`输入方式：${mode.label}`} onClick={() => setModePicker(true)} disabled={!!gen || !!auto}>{mode.label}</button>
        <textarea
          ref={inputBox}
          rows={1}
          value={input}
          disabled={dead}
          onFocus={() => setTyping(true)}
          onBlur={() => setTyping(false)}
          placeholder={dead ? "" : roomy ? mode.placeholder : mode.short ?? mode.placeholder}
          onKeyDown={(e) => {
            // On a desktop keyboard Enter sends and Shift+Enter starts a new line.
            if (mouse && e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.nativeEvent.isComposing) { e.preventDefault(); if (!busy) send(); }
          }}
          onChange={(e) => {
            const v = e.target.value;
            setInput(v);
            if (!watch && modeIndex === 0 && /^[“"「]/.test(v)) setModeIndex(1);
            e.target.style.height = "auto";
            e.target.style.height = `${e.target.scrollHeight}px`;
          }}
        />
        <button className={`send-btn ${busy ? "" : "primary"}`} title={agentBusy ? "助手正在处理，完成或停止后可继续游玩" : mouse ? (busy ? "停止" : "Enter 发送，Shift+Enter 换行") : undefined} disabled={agentBusy || (dead && !busy)} onClick={stopOrSend}>{sendLabel}</button>
      </div>
    </div>
  );
}

interface InputModeSheetProps {
  watch?: boolean; modeList: typeof MODES; modeIndex: number; inputBox: RefObject<HTMLTextAreaElement | null>;
  noteOpen: boolean; mode: typeof MODES[number]; worldId: string; cursor: Cursor;
  setModePicker: (open: boolean) => void;
  setModeIndex: (index: number) => void;
  setNoteOpen: (open: boolean) => void;
  captureReading: () => void;
  push: AppValue["push"];
}

export function InputModeSheet({ watch, modeList, modeIndex, inputBox, noteOpen, mode, worldId, cursor,
  setModePicker, setModeIndex, setNoteOpen, captureReading, push }: InputModeSheetProps) {
  return (
    <Sheet title={watch ? "怎么指点这一段" : "怎么写这一回合"} onClose={() => setModePicker(false)}>
      <div className="sheet-menu">
        {modeList.map((m, i) => (
          <button key={m.mode} aria-pressed={i === modeIndex} className="mode-option" onClick={() => { setModeIndex(i); setModePicker(false); inputBox.current?.focus(); }}>
            <b>{m.label}</b><small>{(watch ? WATCH_NOTES : MODE_NOTES)[m.mode]}</small>
          </button>
        ))}
        {!watch && !noteOpen && mode.mode !== "direct" && <button className="mode-option" onClick={() => { setNoteOpen(true); setModePicker(false); }}><b><Icon name="plus" size={16} />幕后要求</b><small>行动照写，另外告诉叙事者这一段怎么写</small></button>}
        <button className="mode-option" onClick={() => { captureReading(); setModePicker(false); push({ name: "agent", worldId, lineId: cursor.line.id }); }}><b>助手 ›</b><small>单独交谈、查资料或修改本局，完成后继续游玩</small></button>
      </div>
    </Sheet>
  );
}
