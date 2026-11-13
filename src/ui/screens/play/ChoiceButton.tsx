import { useLongPress } from "../../components/useLongPress";

export function ChoiceButton({ text, onTap, onLong, title }: { text: string; onTap: () => void; onLong: () => void; title?: string }) {
  const press = useLongPress(onLong, onTap);
  return <button className="choice" title={title} {...press}>{text}</button>;
}
