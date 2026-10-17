import { useEffect } from "react";
import { useApp } from "../app/context";
import { BudgetReminder } from "./MonthlyBudget";

/** The main agent mounts this in Play and removes App's old global useKeepAwake.
 * No completion notification here: rendering a saved node is not a new commit. */
export function PlayQualityEffects({ revision = "" }: { revision?: string | number }) {
  const { platform, reading } = useApp();
  useEffect(() => {
    void platform.system.setKeepAwake(reading.keepAwake).catch(() => {});
    return () => { void platform.system.setKeepAwake(false).catch(() => {}); };
  }, [platform, reading.keepAwake]);
  return <BudgetReminder revision={revision} />;
}
