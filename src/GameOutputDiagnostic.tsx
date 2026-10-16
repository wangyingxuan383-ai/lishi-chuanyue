import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { CallAttempt } from "./gameCallClient";
import { callT as t } from "./gameCallMessages";

type Diagnostic = { worldId: string; operationId: string; category: string; field: string | null; line: number | null; column: number | null; responseBytes: number };
const categories = ["shape_constraints", "too_large", "invalid_fence", "invalid_protocol", "json_syntax", "incomplete_json", "invalid_schema", "missing_field", "unknown_field", "unknown_variant", "holding_quantity_change", "domain_constraints"] as const;
export function parseOutputDiagnostic(value: unknown, worldId: string, operationId: string): Diagnostic | null {
  if (value === null) return null;
  if (typeof value !== "object" || Array.isArray(value) || !value) throw Error("diagnostic_invalid");
  const row = value as Record<string, unknown>;
  const integer = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
  if (Object.keys(row).length !== 7 || row.worldId !== worldId || row.operationId !== operationId ||
    !(categories as readonly unknown[]).includes(row.category) || !(row.field === null || typeof row.field === "string" && /^[A-Za-z][A-Za-z0-9]{0,63}$/u.test(row.field)) ||
    !(row.line === null || integer(row.line)) || !(row.column === null || integer(row.column)) || !integer(row.responseBytes)) throw Error("diagnostic_invalid");
  return row as Diagnostic;
}
export default function GameOutputDiagnostic({ attempt }: { attempt: CallAttempt }) {
  const [value, setValue] = useState<Diagnostic | null | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const active = useRef(false), mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  async function read() {
    if (active.current) return;
    active.current = true; setLoading(true); setError(false);
    try {
      const result = parseOutputDiagnostic(await invoke("get_game_output_diagnostic", { worldId: attempt.worldId, operationId: attempt.operationId }), attempt.worldId, attempt.operationId);
      if (mounted.current) setValue(result);
    } catch { if (mounted.current) setError(true); }
    finally { active.current = false; if (mounted.current) setLoading(false); }
  }
  return <div><button type="button" className="game-secondary" disabled={loading} onClick={() => void read()}>{t(loading ? "loading" : "outputRead")}</button>
    <p className="game-muted game-small">{t("outputHelp")}</p>
    {error && <p className="game-error" role="alert">{t("error")}</p>}
    {value === null && <p role="status">{t("outputEmpty")}</p>}
    {value && <dl className="game-capabilities"><div><dt>{t("outputCategory")}</dt><dd>{t(value.category as (typeof categories)[number])}</dd></div>
      <div><dt>{t("outputField")}</dt><dd>{value.field ?? t("unknown")}</dd></div><div><dt>{t("outputPosition")}</dt><dd>{value.line ?? "?"} : {value.column ?? "?"}</dd></div>
      <div><dt>{t("outputBytes")}</dt><dd>{value.category === "holding_quantity_change" || value.category === "domain_constraints" ? t("unknown") : value.responseBytes.toLocaleString("zh-CN")}</dd></div></dl>}
  </div>;
}
