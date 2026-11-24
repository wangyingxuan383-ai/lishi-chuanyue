// The input bar (R28 第二批, D160): one bar at the bottom of the play screen —
// way of writing, the box, and one main button (继续 / 发送 / 停止). The
// suggested choices moved into the story, under the latest passage, so the
// bar never takes reading space at rest. Class names .dock / .inputbar /
// .mode-btn / .send-btn stay for the UI checks.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import type { StoryNode, WorldState } from "../../../engine/types";
import { Icon } from "../../components/Icon";
import type { MODES } from "./constants";
import type { Gen } from "./types";

export interface ComposerProps {
  dead: boolean; state: WorldState; watch?: boolean; auto: { step: number; total: number; runId?: string; activeNote?: string | null } | null;
  input: string; typing: boolean; mouse: boolean; busy: boolean; agentBusy: boolean;
  turn: StoryNode | undefined; head: StoryNode; noteOpen: boolean; note: string;
  mode: typeof MODES[number]; modeIndex: number; modeList: typeof MODES; gen: Gen | null; roomy: boolean;
  inputBox: RefObject<HTMLTextAreaElement | null>;
  setInput: (text: string) => void; setModeIndex: (index: number) => void;
  setNote: (note: string) => void; setNoteOpen: (open: boolean) => void; setTyping: (typing: boolean) => void;
  onModes: () => void; onDesk: () => void; onPolish: () => void; onAutoplay: () => void;
  onQueueAutoplayNote?: (note: string) => Promise<void>;
  onSend: () => void; onStopOrSend: () => void;
}

export function Composer(p: ComposerProps) {
  const { dead, state, watch, auto, input, typing, mouse, busy, agentBusy, noteOpen, note, mode, modeIndex, modeList, gen, roomy, inputBox } = p;
  const [autoDraft, setAutoDraft] = useState("");
  const [queuedNote, setQueuedNote] = useState("");
  const [activeNote, setActiveNote] = useState("");
  const [queueing, setQueueing] = useState(false);
  const prevAuto = useRef<{ step: number; runId?: string } | null>(null);
  useEffect(() => {
    const prev = prevAuto.current;
    if (!auto) {
      if (prev && queuedNote) {
        if (watch) p.setInput(input.trim() ? `${input.trim()}\n${queuedNote}` : queuedNote);
        else { p.setNote(queuedNote); p.setNoteOpen(true); }
      }
      setQueuedNote("");
      setActiveNote("");
      prevAuto.current = null;
      return;
    }
    const consumed = auto.activeNote?.trim() ?? "";
    const switchedRun = Boolean(prev?.runId && auto.runId && prev.runId !== auto.runId);
    if (!prev || switchedRun) {
      setActiveNote(consumed);
      if (switchedRun || consumed) {
        setQueuedNote((cur) => (switchedRun || cur === consumed ? "" : cur));
      }
    } else if (auto.step > prev.step) {
      setActiveNote(consumed);
      if (consumed) {
        setQueuedNote((cur) => (cur === consumed || !cur ? "" : cur));
      }
    } else if (auto.activeNote !== undefined) {
      setActiveNote(consumed);
      if (consumed) {
        setQueuedNote((cur) => (cur === consumed ? "" : cur));
      }
    }
    prevAuto.current = { step: auto.step, runId: auto.runId ?? prev?.runId };
  }, [auto?.step, auto?.runId, auto?.activeNote]);
  const typed = !!input.trim();
  const kind = agentBusy ? "wait" : busy ? "stop" : typed ? "send" : "continue";
  const label = { wait: "等待", stop: "停止", send: "发送", continue: "继续" }[kind];
  const icon = ({ wait: "hourglass", stop: "stop", send: "send", continue: "play" } as const)[kind];
  const showTools = !dead && (typing || typed);
  const toolCount = showTools ? ((!watch ? 1 : 0) + 1 + (typed ? 1 : 0)) : 0;
  const fieldRef = useRef<HTMLDivElement>(null);

  const syncTextareaHeight = useCallback(() => {
    const el = inputBox.current;
    if (!el) return;
    if (!input) {
      el.style.height = "";
      return;
    }
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [input, inputBox]);

  useLayoutEffect(() => {
    syncTextareaHeight();
  }, [syncTextareaHeight, showTools, roomy]);

  useEffect(() => {
    const host = fieldRef.current;
    if (!host || typeof ResizeObserver === "undefined") return;
    let lastWidth = host.clientWidth;
    const ro = new ResizeObserver(() => {
      const nextWidth = host.clientWidth;
      if (nextWidth !== lastWidth) {
        lastWidth = nextWidth;
        syncTextareaHeight();
      }
    });
    ro.observe(host);
    return () => ro.disconnect();
  }, [syncTextareaHeight]);
  const submitAutoplayNote = async () => {
    const clean = autoDraft.trim();
    if (!clean || !p.onQueueAutoplayNote || queueing) return;
    setQueueing(true);
    try {
      await p.onQueueAutoplayNote(clean);
      setQueuedNote(clean);
      setAutoDraft("");
    } finally { setQueueing(false); }
  };
  return (
    <div className={`dock${typing ? " typing" : ""}`} data-tools={toolCount}>
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
      {!dead && auto && p.onQueueAutoplayNote && (
        <div className="autoplay-note-bar">
          {activeNote && (
            <div className="row between autoplay-note-active">
              <small className="muted">本段已用提示：{activeNote}</small>
            </div>
          )}
          {queuedNote ? (
            <div className="row between autoplay-note-queued">
              <small className="muted">{auto.step >= auto.total ? `留给下一段：${queuedNote}` : `已排队待下段使用：${queuedNote}`}</small>
              <button type="button" className="ghost small" disabled={queueing} onClick={() => { setQueueing(true); void p.onQueueAutoplayNote?.("").finally(() => { setQueuedNote(""); setQueueing(false); }); }}>撤销</button>
            </div>
          ) : (
            <div className="row autoplay-note-input">
              <input className="grow" aria-label="下一段幕后提示" value={autoDraft} disabled={queueing} placeholder={auto.step >= auto.total ? "给连播结束后的下一段留提示" : "下一段幕后提示（不打断连播）"}
                onChange={(e) => setAutoDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing) { e.preventDefault(); void submitAutoplayNote(); } }} />
              <button type="button" className="ghost small" disabled={queueing || !autoDraft.trim()} onClick={() => void submitAutoplayNote()}>排队</button>
            </div>
          )}
        </div>
      )}
      {!dead && !watch && !auto && !busy && typing && modeList.length > 1 && (
        <div className="mode-chips" role="group" aria-label="快速切换输入方式">
          {modeList.map((m, i) => (
            <button key={m.mode} type="button" className="mode-chip" aria-pressed={i === modeIndex}
              onPointerDown={(e) => e.preventDefault()} onClick={() => p.setModeIndex(i)}>{m.label}</button>
          ))}
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
        <div className="composer-field" ref={fieldRef}>
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
          {/* The writing tools sit cleanly below the text in normal flow so multi-line prompts are never covered. */}
          {showTools && (
            <span className="composer-tools">
              {!watch && <button className="icon-btn" aria-label="润色行动" title="润色行动" disabled={busy || !typed} onPointerDown={(e) => e.preventDefault()} onClick={p.onPolish}><Icon name="sparkle" size={19} /></button>}
              <button className="icon-btn" aria-label="展开输入" title="展开输入" disabled={busy} onPointerDown={(e) => e.preventDefault()} onClick={p.onDesk}><Icon name="expand" size={19} /></button>
              {typed && <button className="icon-btn" aria-label="清空输入" title="清空输入" disabled={busy} onPointerDown={(e) => e.preventDefault()} onClick={() => { p.setInput(""); if (inputBox.current) { inputBox.current.style.height = ""; inputBox.current.focus(); } }}><Icon name="close" size={19} /></button>}
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
