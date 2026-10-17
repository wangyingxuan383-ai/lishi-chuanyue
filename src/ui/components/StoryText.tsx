/** Narrative paragraphs; the date line of an opening is emphasised. */
export function StoryText({ text, streaming = false }: { text: string; streaming?: boolean }) {
  const paragraphs = text.split(/\n+/).filter((p) => p.trim());
  if (streaming && paragraphs.length === 0) paragraphs.push("");
  return (
    <div className="story-text">
      {paragraphs.map((p, i) => {
        const last = streaming && i === paragraphs.length - 1 ? "cursor-blink" : undefined;
        const dateLine = p.length < 40 && /[载年]/.test(p) && /[时日]/.test(p) && !/[“”"]/.test(p);
        return dateLine
          ? <p key={i} className={["date-line", last].filter(Boolean).join(" ")}>{p.trim()}</p>
          : <p key={i} className={last}>{p}</p>;
      })}
    </div>
  );
}
