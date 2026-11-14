import type { RefObject } from "react";
import type { Cursor } from "../../../engine/tree";
import type { AppValue } from "../../app/context";
import { Icon } from "../../components/Icon";
import { Sheet } from "../../components/Sheet";
import { MODE_NOTES, WATCH_NOTES, type MODES } from "./constants";

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
