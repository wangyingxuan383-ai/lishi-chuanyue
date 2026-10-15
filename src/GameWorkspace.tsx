import { useRef, type ReactNode } from "react";
import { workspaceT as t, type WorkspaceMessageKey } from "./workspaceMessages";
import "./gameWorkspace.css";

export type WorkspacePanelId = "story" | "state" | "branches" | "memory" | "fast" | "research" | "saves";
const panels = ["story", "state", "branches", "memory", "fast", "research", "saves"] as const;
const labels = {
  story: "workspace.story", state: "workspace.state", branches: "workspace.branches", memory: "workspace.memory",
  fast: "workspace.fast", research: "workspace.research", saves: "workspace.saves",
} as const satisfies Record<WorkspacePanelId, WorkspaceMessageKey>;

export function WorkspaceNavigation({ active, hasWorld, onSelect, onLatest, onAction, workingPanel }: {
  active: WorkspacePanelId; hasWorld: boolean; onSelect: (panel: WorkspacePanelId) => void;
  onLatest: () => void; onAction: () => void; workingPanel: WorkspacePanelId | null;
}) {
  const buttons = useRef(new Map<WorkspacePanelId, HTMLButtonElement>());
  function move(from: WorkspacePanelId, key: string): boolean {
    const available = panels.filter(panel => hasWorld || panel === "saves");
    let index = available.indexOf(from);
    if (key === "Home") index = 0;
    else if (key === "End") index = available.length - 1;
    else if (key === "ArrowRight" || key === "ArrowDown") index = (index + 1) % available.length;
    else if (key === "ArrowLeft" || key === "ArrowUp") index = (index + available.length - 1) % available.length;
    else return false;
    const next = available[index];
    onSelect(next); buttons.current.get(next)?.focus(); return true;
  }
  return <nav className="game-workspace-nav" aria-label={t("workspace.navigation")}>
    <div role="tablist" aria-label={t("workspace.navigation")} className="game-workspace-tabs">{panels.map(panel => <button
      ref={node => { if (node) buttons.current.set(panel, node); else buttons.current.delete(panel); }} key={panel}
      type="button" role="tab" id={"game-tab-" + panel} aria-controls={"game-panel-" + panel}
      aria-selected={active === panel} tabIndex={active === panel || !hasWorld && panel === "saves" ? 0 : -1}
      disabled={!hasWorld && panel !== "saves"} onClick={() => onSelect(panel)} onKeyDown={event => { if (move(panel, event.key)) event.preventDefault(); }}>
      {t(labels[panel])}{workingPanel === panel && <span className="game-workspace-pending" aria-hidden="true">●</span>}
    </button>)}</div>
    {hasWorld && <div className="game-workspace-shortcuts">
      {active === "story" && <><button type="button" onClick={onLatest}>{t("workspace.latest")}</button><button type="button" onClick={onAction}>{t("workspace.action")}</button></>}
      {workingPanel && active !== workingPanel && <button type="button" className="game-workspace-active-task" onClick={() => onSelect(workingPanel)}>{t("workspace.backToTask")}</button>}
    </div>}
  </nav>;
}

// A hidden panel keeps owned requests, cancellation state and drafts mounted.
// Its descendants are excluded from keyboard navigation and accessibility tree.
export function WorkspacePanel({ panel, active, children }: { panel: WorkspacePanelId; active: WorkspacePanelId; children: ReactNode }) {
  return <section id={"game-panel-" + panel} className="game-workspace-panel" role="tabpanel" aria-labelledby={"game-tab-" + panel}
    hidden={active !== panel} tabIndex={0}>{children}</section>;
}
