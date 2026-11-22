import { Icon } from "../../components/Icon";
import { useLongPress } from "../../components/useLongPress";

export function ChoiceButton({ text, onTap, onLong, title }: { text: string; onTap: () => void; onLong: () => void; title?: string }) {
  const press = useLongPress(onLong, onTap);
  return (
    <div className="choice-row">
      <button className="choice" title={title} {...press}>{text}</button>
      <button type="button" className="icon-btn choice-fill" aria-label={`放进输入框修改：${text}`} title="放进输入框改一改" onClick={(e) => { e.stopPropagation(); onLong(); }}>
        <Icon name="pen" size={16} />
      </button>
    </div>
  );
}
