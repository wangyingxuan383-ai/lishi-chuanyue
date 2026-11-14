// The input bar (R28 第二批, D160): one bar at the bottom of the play screen —
// way of writing, the box, and one main button (继续 / 发送 / 停止). The
// suggested choices moved into the story, under the latest passage, so the
// bar never takes reading space at rest. Class names .dock / .inputbar /
// .mode-btn / .send-btn stay for the UI checks.
import type { RefObject } from "react";
import type { StoryNode, WorldState } from "../../../engine/types";
import { Icon } from "../../components/Icon";
import type { MODES } from "./constants";
import type { Gen } from "./types";

export interface ComposerProps {
  dead: boolean; state: WorldState; watch?: boolean; auto: { step: number; total: number } | null;
  input: string; typing: boolean; mouse: boolean; busy: boolean; agentBusy: boolean;
  turn: StoryNode | undefined; head: StoryNode; noteOpen: boolean; note: string;
  mode: typeof MODES[number]; modeIndex: number; gen: Gen | null; roomy: boolean;
  inputBox: RefObject<HTMLTextAreaElement | null>;
  setInput: (text: string) => void; setModeIndex: (index: number) => void;
  setNote: (note: string) => void; setNoteOpen: (open: boolean) => void; setTyping: (typing: boolean) => void;
  onModes: () => void; onDesk: () => void; onPolish: () => void; onAutoplay: () => void;
  onSend: () => void; onStopOrSend: () => void;
}

export function Composer(p: ComposerProps) {
  const { dead, state, watch, auto, input, typing, mouse, busy, agentBusy, noteOpen, note, mode, modeIndex, gen, roomy, inputBox } = p;
  const typed = !!input.trim();
  const kind = agentBusy ? "wait" : busy ? "stop" : typed ? "send" : "continue";
  const label = { wait: "等待", stop: "停止", send: "发送", continue: "继续" }[kind];
  const icon = ({ wait: "hourglass", stop: "stop", send: "send", continue: "play" } as const)[kind];
  return (
    <div className={`dock${typing ? " typing" : ""}`}>
      {!dead && state.protagonist.statuses.some((x) => x.name === "垂危") && <p className="dying-note">你伤重垂危：再受重伤就会死去，先设法疗伤。</p>}
      {/* 旁观 and 连播: progress, or the way to start one. */}
      {!dead && (watch || auto) && (
        <div className="dock-tools">
          {auto ? (
            <span className="autoplay-state" role="status">连播 {Math.max(1, auto.step)}/{auto.total}
              <span className="autoplay-dots" aria-hidden="true">{Array.from({ length: auto.total }, (_, i) => <i key={i} className={i + 1 < auto.step ? "done" : i + 1 === auto.step ? "now" : ""} />)}</span>
            </span>
          ) : <span className="choices-head">AI 来演主角，你在幕后指点</span>}
          {!auto && <button className="autoplay-btn" disabled={busy} onClick={p.onAutoplay}><span>连播</span></button>}
        </div>
      )}
      {noteOpen && !watch && mode.mode !== "direct" && (
        <div className="note-chip">
          <span className="note-chip-label">幕后</span>
          <input className="director-note grow" value={note} onChange={(e) => p.setNote(e.target.value)} placeholder="这一段怎么写（只影响这一段）" aria-label="幕后要求" />
          <button className="icon-btn" aria-label="去掉幕后要求" onClick={() => { p.setNote(""); p.setNoteOpen(false); }}><Icon name="close" size={18} /></button>
        </div>
      )}
      <div className="inputbar">
        <button className="mode-btn" aria-label={`输入方式：${mode.label}`} onClick={p.onModes} disabled={!!gen || !!auto}>{mode.label}</button>
        <div className="composer-field">
          <textarea
            ref={inputBox}
            rows={1}
            value={input}
            disabled={dead}
            onFocus={() => p.setTyping(true)}
            onBlur={() => p.setTyping(false)}
            placeholder={dead ? "" : roomy ? mode.placeholder : mode.short ?? mode.placeholder}
            onKeyDown={(e) => {
              // On a desktop keyboard Enter sends and Shift+Enter starts a new line.
              if (mouse && e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.nativeEvent.isComposing) { e.preventDefault(); if (!busy) p.onSend(); }
            }}
            onChange={(e) => {
              const v = e.target.value;
              p.setInput(v);
              if (!watch && modeIndex === 0 && /^[“"「]/.test(v)) p.setModeIndex(1);
              e.target.style.height = "auto";
              e.target.style.height = `${e.target.scrollHeight}px`;
            }}
          />
          {/* The writing tools come up with the keyboard or with words in the box. */}
          {!dead && (typing || typed) && (
            <span className="composer-tools">
              {!watch && <button className="icon-btn" aria-label="润色行动" title="润色行动" disabled={busy || !typed} onMouseDown={(e) => e.preventDefault()} onClick={p.onPolish}><Icon name="sparkle" size={20} /></button>}
              <button className="icon-btn" aria-label="展开输入" title="展开输入" disabled={busy} onMouseDown={(e) => e.preventDefault()} onClick={p.onDesk}><Icon name="expand" size={20} /></button>
            </span>
          )}
        </div>
        <button className={`send-btn ${kind}${kind === "continue" || kind === "send" ? " primary" : ""}`}
          title={agentBusy ? "助手正在处理，完成或停止后可继续游玩" : mouse ? (busy ? "停止" : "Enter 发送，Shift+Enter 换行") : undefined}
          disabled={agentBusy || (dead && !busy)} onClick={p.onStopOrSend}>
          <Icon name={icon} size={18} /><span className="send-label">{label}</span>
        </button>
      </div>
    </div>
  );
}
