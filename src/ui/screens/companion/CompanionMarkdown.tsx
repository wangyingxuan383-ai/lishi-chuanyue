import { memo, type ReactNode } from "react";
import "./companion.css";

function renderInline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const tokenRe = /(\*\*([^*\n]+)\*\*|`([^`\n]+)`|\*([^*\s][^*\n]*?)\*)/g;
  let last = 0;
  let k = 0;
  let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[2] !== undefined) {
      out.push(<strong key={k++}>{m[2]}</strong>);
    } else if (m[3] !== undefined) {
      out.push(<code key={k++} className="companion-md-code">{m[3]}</code>);
    } else if (m[4] !== undefined) {
      out.push(<em key={k++}>{m[4]}</em>);
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out.length ? out : [text];
}

export const CompanionMarkdown = memo(function CompanionMarkdown({
  text,
  streaming = false,
}: {
  text: string;
  streaming?: boolean;
}) {
  const blocks: ReactNode[] = [];
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block ```
    if (line.trimStart().startsWith("```")) {
      const lang = line.trimStart().slice(3).trim();
      i++;
      const codeLines: string[] = [];
      while (i < lines.length && !lines[i].trimStart().startsWith("```")) {
        codeLines.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++;
      blocks.push(
        <pre key={key++} className="companion-md-pre" data-lang={lang || undefined}>
          <code>{codeLines.join("\n")}</code>
        </pre>,
      );
      continue;
    }

    if (!line.trim()) {
      i++;
      continue;
    }

    // Horizontal rule
    if (/^\s*(?:---+|\*\*\*+|___+)\s*$/.test(line)) {
      blocks.push(<hr key={key++} className="companion-md-hr" />);
      i++;
      continue;
    }

    // Heading # .. ####
    const hm = /^\s*(#{1,4})\s+(.+)$/.exec(line);
    if (hm) {
      const level = hm[1].length;
      const content = renderInline(hm[2].trim());
      blocks.push(
        level <= 2 ? (
          <h3 key={key++} className="companion-md-h">{content}</h3>
        ) : (
          <h4 key={key++} className="companion-md-h sub">{content}</h4>
        ),
      );
      i++;
      continue;
    }

    // Blockquote >
    if (/^\s*>\s?/.test(line)) {
      const qLines: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        qLines.push(lines[i].replace(/^\s*>\s?/, ""));
        i++;
      }
      blocks.push(
        <blockquote key={key++} className="companion-md-quote">
          {renderInline(qLines.join("\n"))}
        </blockquote>,
      );
      continue;
    }

    // Unordered list - / * / •
    if (/^\s*[-*•]\s+/.test(line)) {
      const items: ReactNode[] = [];
      while (i < lines.length && /^\s*[-*•]\s+/.test(lines[i])) {
        items.push(<li key={items.length}>{renderInline(lines[i].replace(/^\s*[-*•]\s+/, ""))}</li>);
        i++;
      }
      blocks.push(<ul key={key++} className="companion-md-list">{items}</ul>);
      continue;
    }

    // Ordered list 1. / 1、
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items: ReactNode[] = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
        items.push(<li key={items.length}>{renderInline(lines[i].replace(/^\s*\d+[.)]\s+/, ""))}</li>);
        i++;
      }
      blocks.push(<ol key={key++} className="companion-md-list">{items}</ol>);
      continue;
    }

    // Paragraph (coalesce contiguous plain lines)
    const pLines: string[] = [line];
    i++;
    while (
      i < lines.length &&
      lines[i].trim() &&
      !lines[i].trimStart().startsWith("```") &&
      !/^\s*(?:#{1,4}\s+|>\s?|[-*•]\s+|\d+[.)]\s+|---+|\*\*\*+|___+)/.test(lines[i])
    ) {
      pLines.push(lines[i]);
      i++;
    }
    const isLast = streaming && i >= lines.length;
    blocks.push(
      <p key={key++} className={isLast ? "cursor-blink" : undefined}>
        {renderInline(pLines.join("\n"))}
      </p>,
    );
  }

  if (streaming && blocks.length === 0) {
    blocks.push(<p key="empty" className="cursor-blink" />);
  }

  return <div className={`story-text companion-md${streaming ? " streaming" : ""}`}>{blocks}</div>;
});
