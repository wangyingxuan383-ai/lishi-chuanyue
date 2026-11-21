import { useState } from "react";
import { useApp } from "../app/context";
import type { BackupInfo } from "../../platform";

/** What each backup label means to the player (names end in `-<label>.sqlite`). */
function kind(name: string): string {
  name = name.replace(/\.zip$/, "");
  if (name.endsWith("-before-restore.sqlite")) return "恢复前自动保存";
  if (name.endsWith("-before-import.sqlite")) return "导入前自动保存";
  if (/-before-v\d+\.sqlite$/.test(name)) return "更新前自动保存";
  if (name.endsWith("-auto.sqlite")) return "每日自动";
  if (name.endsWith("-manual.sqlite")) return "手动";
  return "备份";
}

export function backupSize(bytes: number): string {
  if (bytes === 0) return "0 MB";
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
  if (bytes < 1e6) return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
  return `${(bytes / 1e6).toFixed(1)} MB`;
}

const when = (iso: string) =>
  new Date(iso).toLocaleString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).replaceAll("/", "-");

/**
 * B2: the device's backups, newest first, each restorable after the app's own
 * confirmation. The current data is saved as a backup first, then the app
 * reloads on the restored data.
 */
export function BackupRestore({ backups, deleting, onDelete }: {
  backups: BackupInfo[];
  deleting: boolean;
  onDelete: (items: BackupInfo[]) => Promise<void>;
}) {
  const { platform, game, ask, toast } = useApp();
  const [busy, setBusy] = useState(false);

  const restore = async (b: BackupInfo) => {
    const ok = await ask({
      title: "恢复到这一份备份？",
      message: `存档会回到 ${when(b.at)} 的样子，之后的进度都不在了。恢复前会先把现在的存档另存一份备份，想反悔可以再恢复回来。`,
      confirm: "恢复",
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      // Background upkeep from the last turn finishes first, so it cannot write into the restored save.
      await game.settled();
      await platform.sql.restore(b.name);
      toast("已恢复，正在重新打开");
      location.reload();
    } catch (error) {
      setBusy(false);
      const code = (error as { code?: string }).code;
      toast(
        code === "sql_restore_invalid" ? "这份备份已损坏，没有恢复"
          : code === "sql_restore_newer" ? "这份备份来自更新的版本，请先更新应用"
            : code === "sql_restore_unsupported" ? "这里不支持从备份恢复"
              : "恢复没成功，存档没有变化",
      );
    }
  };

  return (
    <div className="stack gap-0">
      {backups.map((b) => (
        <div key={b.name} className="item-row center">
          <div>
            <span>{when(b.at)}</span>
            <small>{kind(b.name)} · {backupSize(b.size)}</small>
          </div>
          <div className="row wrap">
            <button disabled={busy || deleting} onClick={() => void restore(b)}>恢复</button>
            <button disabled={busy || deleting} onClick={() => void onDelete([b])}>删除</button>
          </div>
        </div>
      ))}
      <div className="row">
        <button className="danger" disabled={busy || deleting} onClick={() => void onDelete(backups)}>删除全部备份</button>
      </div>
    </div>
  );
}
