import { useEffect } from "react";
import { useApp } from "../app/context";
import { BudgetReminder } from "./MonthlyBudget";

/** The main agent mounts this in Play and removes App's old global useKeepAwake.
 * No completion notification here: rendering a saved node is not a new commit. */
export function PlayQualityEffects({ revision = "", active = true }: { revision?: string | number; active?: boolean }) {
  const { platform, reading } = useApp();
  useEffect(() => {
    if (!active) return;
    void platform.system.setKeepAwake(reading.keepAwake).catch(() => {});
    return () => { void platform.system.setKeepAwake(false).catch(() => {}); };
  }, [active, platform, reading.keepAwake]);
  if (!active) return null;
  return <BudgetReminder revision={revision} />;
}
