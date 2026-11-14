// 通知与提醒 (R29-T006): what the phone's notifications show. Saved in the
// database and handed to the Android service, which reads them when it shows one.
import type { Repo } from "../../engine/db/repo";
import type { NotifyPrefs } from "../../platform";

export const DEFAULT_NOTIFY: NotifyPrefs = { progress: true, excerpt: true, lockscreen: false };
export async function loadNotifyPrefs(repo: Repo): Promise<NotifyPrefs> {
  return { ...DEFAULT_NOTIFY, ...(await repo.getSetting<Partial<NotifyPrefs>>("notifyPrefs", {})) };
}
export async function saveNotifyPrefs(repo: Repo, prefs: NotifyPrefs, apply?: (prefs: NotifyPrefs) => Promise<void>): Promise<void> {
  await repo.setSetting("notifyPrefs", prefs);
  await apply?.(prefs).catch(() => {});
}
