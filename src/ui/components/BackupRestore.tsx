import { useEffect, useState } from "react";
import { useApp } from "../app/context";
import type { BackupInfo } from "../../platform";

/** What each backup label means to the player (names end in `-<label>.sqlite`). */
function kind(name: string): string {
  if (name.endsWith("-before-restore.sqlite")) return "恢复前自动保存";
  if (name.endsWith("-before-import.sqlite")) return "导入前自动保存";
  if (/-before-v\d+\.sqlite$/.test(name)) return "更新前自动保存";
  if (name.endsWith("-auto.sqlite")) return "每日自动";
  if (name.endsWith("-manual.sqlite")) return "手动";
  return "备份";
}

function size(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const when = (iso: string) =>
  new Date(iso).toLocaleString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).replaceAll("/", "-");

/**
 * B2: the device's backups, newest first, each restorable after the app's own
 * confirmation. The current data is saved as a backup first, then the app
 * reloads on the restored data. `refresh` changes when the parent makes a new backup.
 */
export function BackupRestore({ refresh = 0 }: { refresh?: number }) {
  const { platform, ask, toast } = useApp();
  const [backups, setBackups] = useState<BackupInfo[] | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void platform.sql.listBackups()
      .then((b) => setBackups([...b].sort((x, y) => (x.name < y.name ? 1 : -1))))
      .catch(() => setBackups([]));
  }, [platform, refresh]);

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
      await platform.sql.restore(b.name);
      toast("已恢复，正在重新打开");
      setTimeout(() => location.reload(), 600);
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

  if (backups === null) return null;
  if (backups.length === 0) return <p className="settings-note">还没有备份。</p>;
  return (
    <div className="stack" style={{ gap: 0 }}>
      {backups.map((b) => (
        <div key={b.name} className="item-row" style={{ alignItems: "center" }}>
          <div>
            <span>{when(b.at)}</span>
            <small>{kind(b.name)} · {size(b.size)}</small>
          </div>
          <button disabled={busy} onClick={() => void restore(b)}>恢复</button>
        </div>
      ))}
    </div>
  );
}
