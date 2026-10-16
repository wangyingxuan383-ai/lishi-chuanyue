// In-memory platform for unit tests and eval scripts (Node). The llm part is
// supplied by the caller, e.g. a scripted fake or the Node relay.
import initSqlJs from "sql.js";
import { sqlJsSql } from "./sqljs";
import type { Platform } from "./types";

export async function createMemoryPlatform(llm?: Platform["llm"]): Promise<Platform> {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  db.exec("PRAGMA foreign_keys = ON;");
  const secrets = new Map<string, { value: string; boundBaseUrl: string }>();
  const unsupported = async () => {
    throw new Error("not available in the memory platform");
  };
  return {
    name: "other",
    sql: sqlJsSql(db),
    secrets: {
      async set(slot, value, boundBaseUrl) {
        secrets.set(slot, { value, boundBaseUrl });
      },
      async has(slot) {
        const entry = secrets.get(slot);
        return { configured: !!entry, boundBaseUrl: entry?.boundBaseUrl ?? null };
      },
      async remove(slot) {
        secrets.delete(slot);
      },
    },
    llm: llm ?? {
      stream: unsupported,
      cancel: unsupported,
      resume: unsupported,
      list: unsupported,
      ack: unsupported,
      get: unsupported,
    },
    files: { exportText: unsupported, importText: unsupported },
    system: { requestNotifications: async () => true, onBack: () => () => {} },
  };
}
