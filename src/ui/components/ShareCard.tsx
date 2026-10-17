// 书摘卡 (PLAN_V4 direction G, UX_CN 11): a passage or a life drawn on paper
// with an offscreen canvas — no libraries, no network fonts — previewed in a
// sheet and saved. The browser downloads a PNG; the app has only a text
// export, so there the picture is saved inside an .html file, and the sheet
// says so.
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { eraContext } from "../../engine/era";
import { dateText } from "../../engine/life";
import type { StoryNode, World } from "../../engine/types";
import { useApp } from "../app/context";
import { Sheet } from "./Sheet";
import { checkCardSize, checkCardText } from "./shareLimits";

export type CardLayout = "册页" | "手卷" | "简洁";
export const LAYOUTS: { id: CardLayout; note: string }[] = [
  { id: "册页", note: "横排，带边框" },
  { id: "手卷", note: "竖排，从右往左读" },
  { id: "简洁", note: "素纸横排" },
];

export interface CardContent {
  /** The world's title. */
  title: string;
  /** Optional heading above the text, e.g. "李安小传". */
  heading?: string;
  body: string;
  /** Game date, place, protagonist; empty ones are left out. */
  date: string;
  place: string;
  name: string;
  /** Two characters for the seal; "穿越" by default. */
  seal?: string;
}

const PAPER = { bg: "#efe5cf", leaf: "#f6eedc", ink: "#2a2019", muted: "#6f5d47", line: "#b9a37c", seal: "#a83221", plain: "#faf7f0" };

function fontStack(): string {
  const css = typeof document !== "undefined" ? getComputedStyle(document.documentElement).getPropertyValue("--serif").trim() : "";
  return css || '"Noto Serif SC", "Songti SC", "SimSun", serif';
}

/** Light paper grain: a few thousand faint dots, deterministic so the card looks the same each time. */
function grain(ctx: CanvasRenderingContext2D, w: number, h: number) {
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  ctx.save();
  for (let i = 0; i < (w * h) / 260; i++) {
    ctx.fillStyle = rand() > 0.5 ? "rgba(110, 80, 40, 0.05)" : "rgba(255, 250, 235, 0.08)";
    ctx.fillRect(rand() * w, rand() * h, 1 + rand() * 2, 1 + rand() * 2);
  }
  ctx.restore();
}

/** The cinnabar seal, two characters stacked, white on red with an inner border. */
export function drawSeal(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, text: string, font: string) {
  const chars = [...text].slice(0, 4);
  ctx.save();
  ctx.fillStyle = PAPER.seal;
  ctx.fillRect(x, y, size, size);
  ctx.strokeStyle = "rgba(255,255,255,0.6)";
  ctx.lineWidth = Math.max(1, size / 40);
  const inset = size * 0.08;
  ctx.strokeRect(x + inset, y + inset, size - inset * 2, size - inset * 2);
  ctx.fillStyle = "#ffffff";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  if (chars.length <= 2) {
    const fs = size * 0.36;
    ctx.font = `700 ${fs}px ${font}`;
    chars.forEach((c, i) => ctx.fillText(c, x + size / 2, y + size * (chars.length === 1 ? 0.5 : 0.3 + i * 0.4)));
  } else {
    // Four characters read right column first, top to bottom.
    const fs = size * 0.3;
    ctx.font = `700 ${fs}px ${font}`;
    chars.forEach((c, i) => ctx.fillText(c, x + size * (i < 2 ? 0.7 : 0.3), y + size * (i % 2 ? 0.7 : 0.3)));
  }
  ctx.restore();
}

/** Between passages on a card of several: the story's own divider, centred. */
export const SEPARATOR = "◇";

const NO_LINE_START ="，。、；：！？）」』”’》…—";

/** Wraps Chinese text by character, keeping closing punctuation off a line's start. */
export function wrap(measure: (s: string) => number, text: string, width: number): string[] {
  const lines: string[] = [];
  for (const para of text.split("\n")) {
    let line = "";
    for (const ch of [...para]) {
      if (line && measure(line + ch) > width && !NO_LINE_START.includes(ch)) {
        lines.push(line);
        line = ch;
      } else line += ch;
    }
    lines.push(line);
  }
  return lines;
}

const VERTICAL: Record<string, string> = { "“": "﹁", "”": "﹂", "‘": "﹃", "’": "﹄", "「": "﹁", "」": "﹂", "（": "︵", "）": "︶", "…": "︙", "—": "︱", "《": "︽", "》": "︾", "：": "︰" };
const CORNER = "，。、！？；";

function footer(c: CardContent): string[] {
  return [c.date, c.place, c.name ? `${c.name}记` : ""].filter(Boolean);
}

/** Draws the card and returns the canvas; width 1080 for the horizontal layouts. */
export function renderCard(content: CardContent, layout: CardLayout): HTMLCanvasElement {
  checkCardText(content.body);
  const font = fontStack();
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d")!;
  const seal = content.seal ?? "穿越";
  if (layout === "手卷") return renderScroll(canvas, ctx, content, font, seal);

  const W = 1080;
  const plain = layout === "简洁";
  const pad = plain ? 96 : 120;
  const bodySize = 40;
  const lead = bodySize * 1.9;
  ctx.font = `${bodySize}px ${font}`;
  const indent = plain ? "" : "　　";
  const body = content.body.split("\n").map((p) => (p === SEPARATOR ? p : indent + p)).join("\n");
  const lines = wrap((s) => ctx.measureText(s).width, body, W - pad * 2);
  const headH = (content.heading ? 150 : 0) + 120;
  const footH = 220;
  // At least 4:5, so a short passage is still a card and not a strip; then its text sits a little above the middle.
  const needed = pad + headH + lines.length * lead + footH + pad;
  const H = Math.max(1350, needed);
  checkCardSize(W, H);
  canvas.width = W;
  canvas.height = H;

  ctx.fillStyle = plain ? PAPER.plain : PAPER.bg;
  ctx.fillRect(0, 0, W, H);
  if (!plain) {
    grain(ctx, W, H);
    // 册页: a lighter leaf inside a double frame.
    ctx.fillStyle = PAPER.leaf;
    ctx.fillRect(60, 60, W - 120, H - 120);
    ctx.strokeStyle = PAPER.line;
    ctx.lineWidth = 3;
    ctx.strokeRect(60, 60, W - 120, H - 120);
    ctx.lineWidth = 1.5;
    ctx.strokeRect(76, 76, W - 152, H - 152);
  }

  let y = pad + 40 + Math.round((H - needed) * 0.35);
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = PAPER.muted;
  ctx.textAlign = "center";
  ctx.font = `30px ${font}`;
  ctx.fillText(spaced(content.title), W / 2, y + 20);
  y += 80;
  if (content.heading) {
    ctx.fillStyle = PAPER.ink;
    ctx.font = `700 56px ${font}`;
    ctx.fillText(spaced(content.heading), W / 2, y + 60);
    y += 150;
  }
  // A short rule under the title.
  ctx.strokeStyle = PAPER.seal;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(W / 2 - 40, y);
  ctx.lineTo(W / 2 + 40, y);
  ctx.stroke();
  y += 40 + bodySize;

  ctx.textAlign = "left";
  ctx.fillStyle = PAPER.ink;
  ctx.font = `${bodySize}px ${font}`;
  for (const line of lines) {
    if (line === SEPARATOR) {
      ctx.save();
      ctx.textAlign = "center";
      ctx.fillStyle = PAPER.seal;
      ctx.font = `${Math.round(bodySize * 0.6)}px ${font}`;
      ctx.fillText(line, W / 2, y - bodySize * 0.25);
      ctx.restore();
    } else ctx.fillText(line, pad, y);
    y += lead;
  }

  // 落款 at the bottom right, the seal beside it.
  const sealSize = 112;
  const fy = H - pad - 30;
  ctx.textAlign = "right";
  ctx.fillStyle = PAPER.muted;
  ctx.font = `30px ${font}`;
  const foot = footer(content);
  foot.forEach((t, i) => ctx.fillText(t, W - pad - sealSize - 28, fy - (foot.length - 1 - i) * 46));
  drawSeal(ctx, W - pad - sealSize, fy - sealSize + 20, sealSize, seal, font);
  return canvas;
}

const spaced = (s: string) => [...s].join(" ");

/** 手卷: vertical columns read right to left; the title on the right, 落款 and seal on the left. */
function renderScroll(canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D, content: CardContent, font: string, seal: string): HTMLCanvasElement {
  const H = 1440;
  const size = 40;
  const colW = size * 1.8;
  const top = 150;
  const perCol = Math.floor((H - top * 2) / (size * 1.12));
  const cols: string[][] = [];
  for (const para of content.body.split("\n")) {
    if (para === SEPARATOR) {
      cols.push([...Array<string>(Math.floor(perCol / 2)).fill("　"), SEPARATOR]);
      continue;
    }
    let col: string[] = ["　", "　"];
    for (const ch of [...para]) {
      if (col.length >= perCol && !NO_LINE_START.includes(ch)) { cols.push(col); col = []; }
      col.push(ch);
    }
    cols.push(col);
  }
  const titleCols = content.heading ? 2 : 1;
  const footCols = footer(content).length;
  const W = Math.max(1080, 140 * 2 + (titleCols + cols.length) * colW + footCols * 52 + 260);
  checkCardSize(W, H);
  canvas.width = W;
  canvas.height = H;
  ctx.fillStyle = PAPER.bg;
  ctx.fillRect(0, 0, W, H);
  grain(ctx, W, H);
  // Mounting: darker bands top and bottom, a thin rule inside.
  ctx.fillStyle = "#d9c8a7";
  ctx.fillRect(0, 0, W, 56);
  ctx.fillRect(0, H - 56, W, 56);
  ctx.strokeStyle = PAPER.line;
  ctx.lineWidth = 2;
  ctx.strokeRect(70, 90, W - 140, H - 180);

  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const column = (x: number, text: string[] | string, px: number, color: string, weight = "") => {
    ctx.fillStyle = color;
    ctx.font = `${weight}${px}px ${font}`;
    [...text].forEach((ch, i) => {
      const y = top + i * px * 1.12 + px / 2;
      if (CORNER.includes(ch)) ctx.fillText(ch, x + px * 0.32, y - px * 0.32);
      else ctx.fillText(VERTICAL[ch] ?? ch, x, y);
    });
  };
  let x = W - 140 - colW / 2;
  column(x, content.title, 30, PAPER.muted);
  x -= colW;
  if (content.heading) { column(x, content.heading, 48, PAPER.ink, "700 "); x -= colW; }
  x -= colW * 0.3;
  for (const col of cols) { column(x, col, size, PAPER.ink); x -= colW; }
  x -= 30;
  for (const t of footer(content)) { column(x, t, 28, PAPER.muted); x -= 52; }
  drawSeal(ctx, Math.max(100, x - 100), H - 150 - 112, 112, seal, font);
  return canvas;
}

/** Preview, layout choice and saving. */
export function CardSheet({ content, onClose, title = "书摘卡", controls }: { content: CardContent; onClose: () => void; title?: string; controls?: ReactNode }) {
  const { game, toast } = useApp();
  const [layout, setLayout] = useState<CardLayout>("册页");
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState("");
  const browser = game.platform.name === "web-dev";
  useEffect(() => {
    // After the fonts the page uses are ready, so the canvas draws with them.
    let live = true;
    setUrl(null); setError("");
    void (document.fonts?.ready ?? Promise.resolve()).then(() => {
      if (!live) return;
      const canvas = renderCard(content, layout);
      try {
        const result = canvas.toDataURL("image/png");
        if (!result.startsWith("data:image/png")) throw new Error("设备没能画出这张图，请少选几段再试。");
        setUrl(result);
      } finally { canvas.width = 0; canvas.height = 0; }
    }).catch((e: unknown) => { if (live) setError(e instanceof Error ? e.message : "没能画出图片，请重试。"); });
    return () => { live = false; };
  }, [content, layout]);
  const name = `${content.heading ?? content.title}-${layout}`.replace(/[\\/:*?"<>|\s]/g, "");
  const save = async () => {
    if (!url) return;
    if (browser) {
      Object.assign(document.createElement("a"), { href: url, download: `${name}.png` }).click();
      toast("已保存图片");
      return;
    }
    const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(content.heading ?? content.title)}</title></head>`
      + `<body style="margin:0;background:#efe5cf"><img alt="${escapeHtml(content.heading ?? content.title)}" src="${url}" style="display:block;max-width:100%;margin:0 auto"></body></html>`;
    if (await game.platform.files.exportText(`${name}.html`, html).catch(() => false)) toast("已保存为网页文件");
  };
  return (
    <Sheet title={title} onClose={onClose}>
      <div className="stack">
        {controls}
        <div className="stack" style={{ gap: 6 }}>
          <span className="muted">样式 · {LAYOUTS.find((l) => l.id === layout)!.note}</span>
          <div className="segmented" role="group" aria-label="样式">
            {LAYOUTS.map((l) => <button key={l.id} aria-pressed={layout === l.id} onClick={() => setLayout(l.id)}>{l.id}</button>)}
          </div>
        </div>
        <div className={`share-preview${layout === "手卷" ? " scroll" : ""}`}>
          {/* A 手卷 reads from the right: start the preview there. */}
          {url ? <img src={url} alt="书摘卡预览" onLoad={(e) => { const box = e.currentTarget.parentElement; if (box) box.scrollLeft = box.scrollWidth; }} /> : <p className={error ? "notice" : "muted"} role={error ? "alert" : undefined}>{error || "正在画…"}</p>}
        </div>
        <button className="primary" disabled={!url} onClick={() => void save()}>保存图片</button>
        {!browser && <p className="muted" style={{ margin: 0, fontSize: 13 }}>手机上暂时不能直接存进相册：会存成一个网页文件（.html），用浏览器打开就能看到这张图，再长按图片保存。</p>}
      </div>
    </Sheet>
  );
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

/** 做成书摘卡 from the passage menu: the date and place are those of that passage. */
export function PassageCardSheet({ world, node, onClose }: { world: World; node: StoryNode; onClose: () => void }) {
  const { game } = useApp();
  const [meta, setMeta] = useState<{ date: string; place: string; name: string } | null>(null);
  const [passages, setPassages] = useState<StoryNode[]>([node]);
  const [count, setCount] = useState(1);
  useEffect(() => {
    let live = true;
    setCount(1); setPassages([node]);
    void game.repo.path(node.id, 50).then((path) => { if (live) setPassages(path.filter((p) => p.kind !== "edit" && p.narrative.trim()).slice(-5)); }).catch(() => {});
    return () => { live = false; };
  }, [game, node]);
  useEffect(() => {
    void game.repo.getState(node.id).then((state) => {
      const era = eraContext(world.eraId, state);
      setMeta({
        date: dateText(era.clock, state.time.elapsedMinutes),
        place: state.places.find((p) => p.id === state.placeId)?.name ?? "",
        name: state.protagonist.name,
      });
    }).catch(() => setMeta({ date: "", place: "", name: "" }));
  }, [game, world.eraId, node.id]);
  const content = useMemo<CardContent | null>(() => meta && {
    title: world.title, body: count === 1 ? node.narrative : passages.slice(-count).map((p) => p.narrative).join(`\n\n${SEPARATOR}\n\n`), ...meta,
  }, [meta, world.title, node.narrative, passages, count]);
  if (!content) return null;
  // Up to five passages ending with this one, along the route it is on; the date is this one's.
  const range = passages.length > 1 && (
    <div className="stack" style={{ gap: 6 }}>
      <span className="muted">连同前面几段</span>
      <div className="segmented" role="group" aria-label="分享范围">
        {passages.map((_, i) => (
          <button key={i} aria-pressed={count === i + 1} onClick={() => setCount(i + 1)}>{i === 0 ? "只这一段" : `共 ${i + 1} 段`}</button>
        ))}
      </div>
    </div>
  );
  return <CardSheet content={content} onClose={onClose} controls={range} />;
}
