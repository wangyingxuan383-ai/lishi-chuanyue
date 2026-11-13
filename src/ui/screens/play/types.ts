import type { ActionMode, World } from "../../../engine/types";

// These optional fields also accept saves from before R13. The engine owns their interpretation.
export type WritingSettings = World["settings"] & { mode?: "history" | "free"; clockStyle?: "era" | "elapsed"; heroPanelEnabled?: boolean };

export interface Gen {
  minHeight?: number;
  phase: "starting" | "thinking" | "writing" | "organizing";
  text: string;
  action: { mode: ActionMode; text: string } | null;
  variant: boolean;
}
