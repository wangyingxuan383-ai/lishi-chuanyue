// sql.js implementation of Platform["sql"], shared by the browser dev harness
// and the in-memory platform used by tests and evals.
import type { Database, SqlValue } from "sql.js";
import { PlatformError, type Json, type Platform, type Row } from "./types";

const MAX_SAFE = Number.MAX_SAFE_INTEGER;

function toSql(value: Json): SqlValue {
  if (value === null || typeof value === "string") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number") return value;
  throw new PlatformError("sql_param_type", "SQL 参数只能是标量");
}

function fromSql(value: SqlValue): Json {
  if (value instanceof Uint8Array) throw new PlatformError("sql_blob_unsupported", "不支持 BLOB");
  if (typeof value === "number" && Number.isInteger(value) && Math.abs(value) > MAX_SAFE) {
    throw new PlatformError("sql_integer_range", "整数超出安全范围");
  }
  return value;
}

function run(db: Database, sql: string, params: Json[]): Row[] {
  // Parameterless statements may hold several SQL commands (migrations).
  if (params.length === 0 && !/^\s*(select|with|pragma)/i.test(sql)) {
    db.exec(sql);
    return [];
  }
  const statement = db.prepare(sql);
  try {
    statement.bind(params.map(toSql));
    const rows: Row[] = [];
    while (statement.step()) {
      const out: Row = {};
      for (const [key, value] of Object.entries(statement.getAsObject())) out[key] = fromSql(value);
      rows.push(out);
    }
    return rows;
  } finally {
    statement.free();
  }
}

export function sqlJsSql(
  db: Database,
  hooks: { persist?: () => void; backup?: (label: string) => Promise<string> } = {},
): Platform["sql"] {
  const backups: { name: string; at: string; size: number }[] = [];
  return {
    async query(sql, params = []) {
      try {
        const rows = run(db, sql, params);
        if (!/^\s*(select|with|pragma)/i.test(sql)) hooks.persist?.();
        return rows;
      } catch (error) {
        throw error instanceof PlatformError ? error : new PlatformError("sql_failed", String(error));
      }
    },
    async batch(statements) {
      db.exec("BEGIN");
      try {
        for (const s of statements) run(db, s.sql, s.params ?? []);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error instanceof PlatformError ? error : new PlatformError("sql_failed", String(error));
      }
      hooks.persist?.();
    },
    async backup(label) {
      if (hooks.backup) return hooks.backup(label);
      const name = `${new Date().toISOString().replace(/[:.]/g, "-")}-${label}.sqlite`;
      backups.unshift({ name, at: new Date().toISOString(), size: db.export().length });
      return name;
    },
    async listBackups() {
      return [...backups];
    },
  };
}
