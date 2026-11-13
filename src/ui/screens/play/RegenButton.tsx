import { useLongPress } from "../../components/useLongPress";

export function RegenButton({ onTap, onLong, title }: { onTap: () => void; onLong: () => void; title?: string }) {
  const press = useLongPress(onLong, onTap);
  return <button className="ghost" title={title} {...press}>重说</button>;
}
