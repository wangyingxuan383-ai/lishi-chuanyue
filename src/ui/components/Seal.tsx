/** The 穿越 seal: two characters stacked top to bottom (AUDIT_V4 1.1: vertical-rl read as 越穿). */
export function Seal({ small }: { small?: boolean }) {
  return <div className={`seal${small ? " small" : ""}`} aria-hidden="true"><span>穿</span><span>越</span></div>;
}
