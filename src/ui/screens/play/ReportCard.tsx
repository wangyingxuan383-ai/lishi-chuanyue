import type { TurnRecord } from "../../../engine/state/apply";

/** What the protagonist heard while time passed (R05-T001). */
export function ReportCard({ report }: { report?: TurnRecord["report"] }) {
  if (!report) return null;
  const rows = [["天下", report.world], ["市面", report.local], ["人情", report.people]].filter(([, text]) => text);
  if (!rows.length) return null;
  return <div className="report-card"><b>这段日子</b>{rows.map(([label, text]) => <p key={label}><span>{label}</span>{text}</p>)}</div>;
}
