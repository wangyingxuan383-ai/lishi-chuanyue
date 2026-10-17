// An on/off row (R14): the whole row is the button, with the label on the left
// and a small square track on the right, in the book's restrained corners.
import "./modes.css";

export function Switch({ label, note, checked, onChange, disabled = false }: {
  label: string; note?: string; checked: boolean; onChange: (next: boolean) => void; disabled?: boolean;
}) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} className="switch-row" disabled={disabled} onClick={() => onChange(!checked)}>
      <span><b>{label}</b>{note && <small>{note}</small>}</span>
      <span className="switch-track" aria-hidden="true" />
    </button>
  );
}
