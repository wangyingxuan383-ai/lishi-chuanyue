import type { TurnRecord } from "../../../engine/state/apply";

/** What the protagonist heard while time passed (R05-T001). */
export function ReportCard({ report }: { report?: TurnRecord["report"] }) {
  if (!report) return null;
  const rows = [["天下", report.world], ["市面", report.local], ["人情", report.people]].filter(([, text]) => text);
  if (!rows.length) return null;
  return (
    <div className="report-card">
      <div className="report-head"><b>这段日子</b><span>见闻录</span></div>
      {rows.map(([label, text]) => <p key={label}><span className="report-tag">{label}</span>{text}</p>)}
    </div>
  );
}
