import type { Platform } from "../../platform";
import { MIGRATIONS } from "./migrations";

/** Brings the database to the latest schema; backs up first when an upgrade is due. */
export async function migrate(platform: Platform): Promise<number> {
  await platform.sql.batch([{ sql: "CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)" }]);
  const rows = await platform.sql.query("SELECT MAX(version) AS v FROM schema_version");
  const current = Number(rows[0]?.v ?? 0);
  const pending = MIGRATIONS.filter((m) => m.version > current);
  if (pending.length === 0) return current;
  if (current > 0) await platform.sql.backup(`before-v${pending[0].version}`);
  for (const migration of pending) {
    await platform.sql.batch([
      { sql: migration.sql },
      { sql: "INSERT INTO schema_version (version) VALUES (?)", params: [migration.version] },
    ]);
  }
  return pending[pending.length - 1].version;
}
