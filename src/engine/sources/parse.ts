import type { Platform } from "../../platform";
import type { BookFormat, BookSection, SourceBook } from "./types";
import { newId } from "../db/ids";

export type TextEncoding = "auto" | "utf-8" | "utf-16le" | "utf-16be" | "gb18030";
export const checkCancelled = (signal?: AbortSignal) => { if (signal?.aborted) throw new DOMException("已取消", "AbortError"); };
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const clean = (s: string) => s.replace(/\r\n?/g, "\n").replace(/[\t \u00a0]+/g, " ").replace(/\n[ \t]+/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
export function decodeText(bytes: Uint8Array, encoding: TextEncoding = "auto"): string {
  let chosen = encoding;
  if (chosen === "auto") {
    chosen = bytes[0] === 255 && bytes[1] === 254 ? "utf-16le" : bytes[0] === 254 && bytes[1] === 255 ? "utf-16be" : "utf-8";
    if (chosen === "utf-8") { try { new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { chosen = "gb18030"; } }
  }
  return clean(new TextDecoder(chosen, { fatal: true }).decode(bytes).replace(/^\uFEFF/, ""));
}
const SHORT_VOL_RE = String.raw`(?:[上中下前后全]\s*[卷部篇集]|[卷部篇集]\s*[零〇一二三四五六七八九十百千万两上中下\d]+)`;
const VOLUME_HEADING_RE = new RegExp(
  String.raw`^(?:第\s*[零〇一二三四五六七八九十百千万两\d]+\s*[卷部篇集](?!.*第\s*[零〇一二三四五六七八九十百千万两\d]+\s*[章节回话幕折])[^\n]{0,65}|${SHORT_VOL_RE}(?!.*第\s*[零〇一二三四五六七八九十百千万两\d]+\s*[章节回话幕折])(?:\s*$|[\s：:·—\-]+[^\n。！？；，”]{1,40})|part\s+[\divxlc]+[^\n]{0,65})$`,
  "i",
);
const CHAPTER_HEADING_RE = /^(?:第\s*[零〇一二三四五六七八九十百千万两\d]+\s*[章节回话幕折][^\n]{0,65}|chapter\s+[\divxlc]+[^\n]{0,65})$/i;
const SECTION_LINE_RE = new RegExp(
  String.raw`^\s*(?![^\n]*。$)(?:第\s*[零〇一二三四五六七八九十百千万两\d]+\s*[卷章节回集部篇话幕折][^\n]{0,65}|${SHORT_VOL_RE}(?:\s*$|[\s：:·—\-]+[^\n。！？；，”]{1,40})|(?:序章|序言|楔子|尾声|后记|前言|引子)(?:\s*$|[\s：:·—\-]+[^\n。！？；，”]{1,40})|(?:chapter|part)\s+[\divxlc]+[^\n]{0,65})\s*$`,
  "i",
);
const HAS_VOLUME_MARKER_RE = new RegExp(
  String.raw`(?:第\s*[零〇一二三四五六七八九十百千万两\d]+\s*[卷部篇集]|(?:^|[\s·—\-])${SHORT_VOL_RE}(?=$|[\s：:·—\-])|\bpart\s+[\divxlc]+\b)`,
  "i",
);
const INLINE_VOLUME_RE = new RegExp(
  String.raw`^((?:第\s*[零〇一二三四五六七八九十百千万两\d]+\s*[卷部篇集]|${SHORT_VOL_RE})(?:\s+[^\s第]{1,30})?)\s+(?=第\s*[零〇一二三四五六七八九十百千万两\d]+\s*[章节回话幕折]|\bchapter\s+)`,
  "i",
);

function isVolumeHeading(line: string): boolean {
  return VOLUME_HEADING_RE.test(line.trim());
}

function extractInlineVolume(line: string): string | null {
  return INLINE_VOLUME_RE.exec(line.trim())?.[1]?.trim() ?? null;
}

function withVolume(volume: string, heading: string): string {
  const cleanHeading = heading.trim();
  const cleanVolume = volume.trim();
  if (!cleanVolume || !cleanHeading || !CHAPTER_HEADING_RE.test(cleanHeading)) return cleanHeading;
  if (cleanHeading.includes(cleanVolume) || HAS_VOLUME_MARKER_RE.test(cleanHeading)) return cleanHeading;
  return `${cleanVolume} · ${cleanHeading}`;
}

function safeDecodeUri(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw.replace(/(?:%[0-9a-fA-F]{2})+/g, (seq) => {
      try {
        return decodeURIComponent(seq);
      } catch {
        return seq.replace(/%[0-7][0-9a-fA-F]/g, (ascii) => decodeURIComponent(ascii));
      }
    });
  }
}

function splitOversizedBlock(block: string): string[] {
  if (block.length <= 12_000) return [block];
  const lines = block.split("\n").map((s) => s.trim()).filter(Boolean);
  const pieces: string[] = [];
  for (const ln of lines) {
    if (ln.length <= 12_000) {
      pieces.push(ln);
      continue;
    }
    let start = 0;
    while (start < ln.length) {
      if (ln.length - start <= 6_000) {
        const tail = ln.slice(start).trim();
        if (tail) pieces.push(tail);
        break;
      }
      let cut = start + 6_000;
      const searchEnd = Math.min(ln.length, start + 6_500);
      const searchStart = start + 3_000;
      let best = -1;
      for (let j = searchEnd - 1; j >= searchStart; j--) {
        if ("。！？；.!?".includes(ln[j]!)) {
          best = j + 1;
          while (best < ln.length && "”’」』）)".includes(ln[best]!)) best++;
          break;
        }
      }
      if (best > start) cut = best;
      const seg = ln.slice(start, cut).trim();
      if (seg) pieces.push(seg);
      start = cut;
    }
  }
  return pieces;
}

export async function textSections(text: string, signal?: AbortSignal): Promise<BookSection[]> {
  const sections: BookSection[] = [];
  let title = "正文", volume = "", lines: string[] = [];
  const flush = () => { const body = clean(lines.join("\n")); if (body) sections.push({ title, text: body }); lines = []; };
  const source = text.split("\n");
  for (let i = 0; i < source.length; i++) {
    if (i % 2000 === 0) { await tick(); checkCancelled(signal); }
    const line = source[i];
    if (SECTION_LINE_RE.test(line)) {
      flush();
      const trimmed = line.trim();
      if (isVolumeHeading(trimmed)) { volume = trimmed; title = trimmed; }
      else {
        const inlineVol = extractInlineVolume(trimmed);
        if (inlineVol) volume = inlineVol;
        title = withVolume(volume, trimmed);
      }
    } else lines.push(line);
  }
  flush();
  if (sections.length === 1 && sections[0].title === "正文" && sections[0].text.length > 24_000) {
    const rawBlocks = sections[0].text.split("\n\n").map((b) => b.trim()).filter(Boolean);
    const expanded: string[] = [];
    for (const blk of rawBlocks) {
      for (const piece of splitOversizedBlock(blk)) expanded.push(piece);
    }
    const autoSections: BookSection[] = [];
    let buf: string[] = [];
    let bufLen = 0;
    const flushAuto = () => {
      if (!buf.length) return;
      autoSections.push({ title: `第 ${autoSections.length + 1} 节`, text: buf.join("\n\n") });
      buf = [];
      bufLen = 0;
    };
    for (let k = 0; k < expanded.length; k++) {
      if (k > 0 && k % 500 === 0) { await tick(); checkCancelled(signal); }
      const item = expanded[k]!;
      if (bufLen > 0 && bufLen + item.length > 6_000) flushAuto();
      buf.push(item);
      bufLen += item.length;
    }
    flushAuto();
    if (autoSections.length > 1) return autoSections;
  }
  return sections;
}

function hasPdfMagic(bytes: Uint8Array): boolean {
  const limit = Math.min(bytes.length, 8192);
  for (let i = 0; i + 5 <= limit; i++) {
    if (bytes[i] === 0x25 && bytes[i + 1] === 0x50 && bytes[i + 2] === 0x44 && bytes[i + 3] === 0x46 && bytes[i + 4] === 0x2d) return true;
  }
  return false;
}

async function readBook(file: { name: string; bytes: Uint8Array }, platform: Platform, options: { encoding?: TextEncoding; signal?: AbortSignal; progress?: (text: string) => void } = {}): Promise<SourceBook> {
  const { bytes, name } = file;
  const { signal, progress = () => {} } = options;
  checkCancelled(signal);
  if (!bytes.length || bytes.length > 64 * 1024 * 1024) throw new Error("文件为空或超过 64 MiB");
  let format: BookFormat = "txt", title = name.replace(/\.[^.]+$/, "") || "参考书籍", sections: BookSection[] = [];
  progress("正在读取正文…"); await tick();
  checkCancelled(signal);
  if (hasPdfMagic(bytes)) {
    format = "pdf";
    const { pages, headings } = await platform.files.extractPdf(bytes, signal);
    const byPage = new Map<number, string[]>();
    for (const h of [...headings].sort((a, b) => a.page - b.page)) {
      const t = h.title.trim();
      if (!t) continue;
      const list = byPage.get(h.page) ?? [];
      if (!list.includes(t)) list.push(t);
      byPage.set(h.page, list);
    }
    const ordered: { page: number; title: string }[] = [];
    let pdfVolume = "";
    for (const [page, titles] of [...byPage.entries()].sort((a, b) => a[0] - b[0])) {
      const nonVol: string[] = [];
      for (const t of titles) {
        if (isVolumeHeading(t)) pdfVolume = t;
        else {
          const inlineVol = extractInlineVolume(t);
          if (inlineVol) pdfVolume = inlineVol;
          nonVol.push(withVolume(pdfVolume, t));
        }
      }
      ordered.push({ page, title: nonVol.length ? nonVol.join(" · ") : pdfVolume || titles[0] });
    }
    let next = 0;
    for (const [i, text] of pages.entries()) {
      if (i % 256 === 0) { await tick(); checkCancelled(signal); }
      const page = i + 1;
      while (next < ordered.length && ordered[next].page <= page) next++;
      const heading = ordered[next - 1];
      const body = clean(text);
      if (body) sections.push({ title: `${heading?.title ? heading.title + " · " : ""}第 ${page} 页`, text: body, page });
    }
    if (!sections.length) throw new Error("没有提取到文字。这可能是扫描图片型 PDF，本版不支持图片识别。");
  } else if (bytes[0] === 80 && bytes[1] === 75 && [3, 5, 7].includes(bytes[2]) && [4, 6, 8].includes(bytes[3])) {
    const { unzip, strFromU8 } = await import("fflate");
    const { XMLParser, XMLValidator } = await import("fast-xml-parser");
    checkCancelled(signal);
    // Enforce the uncompressed budget before allocating entries; never resolve external entities.
    let expanded = 0;
    const files = await new Promise<Record<string, Uint8Array>>((resolve, reject) => {
      const abort = () => { terminate(); reject(new DOMException("已取消", "AbortError")); };
      const terminate = unzip(bytes, { filter: (entry) => { expanded += entry.originalSize; if (expanded > 96 * 1024 * 1024 || entry.originalSize > 24 * 1024 * 1024) return false; return true; } }, (error, data) => {
        signal?.removeEventListener("abort", abort);
        if (error) reject(new Error("无法打开书籍，文件可能已损坏或受保护")); else resolve(data);
      });
      signal?.addEventListener("abort", abort, { once: true });
    });
    checkCancelled(signal);
    if (expanded > 96 * 1024 * 1024) throw new Error("解压后的书籍过大，请拆分后导入");
    const xml = (path: string) => {
      const data = files[path]; if (!data) throw new Error("书籍缺少必要的正文文件");
      const value = strFromU8(data);
      if (/<!DOCTYPE|<!ENTITY/i.test(value)) {
        // EPUB may include a standard HTML doctype, but never an entity/internal subset.
        if (/<!ENTITY|<!DOCTYPE[^>]*\[/i.test(value)) throw new Error("书籍包含不支持的 XML 声明");
      }
      const safe = value.replace(/<!DOCTYPE[^>]*>/gi, "");
      if (XMLValidator.validate(safe, { allowBooleanAttributes: true }) !== true) throw new Error("书籍文档已损坏");
      return safe;
    };
    const parser = new XMLParser({ ignoreAttributes: false, allowBooleanAttributes: true, removeNSPrefix: true, processEntities: true, htmlEntities: true, parseTagValue: false });
    const list = <T,>(x: T | T[] | undefined): T[] => x === undefined ? [] : Array.isArray(x) ? x : [x];
    const textOf = (value: string, docx = false) => {
      const ordered = new XMLParser({ preserveOrder: true, ignoreAttributes: false, allowBooleanAttributes: true, removeNSPrefix: true, processEntities: true, htmlEntities: true, parseTagValue: false }).parse(value) as any[];
      const walk = (rows: any[]): string => rows.map((row) => Object.entries(row).map(([key, content]) => {
        if (key === ":@" || key === "script" || key === "style" || key === "head") return "";
        if (key === "#text") return String(content);
        if (!Array.isArray(content)) return "";
        const body = walk(content);
        if (key === "br" || key === "cr") return "\n";
        if (key === "tab") return " ";
        return body + ((docx ? /^(p|tr)$/ : /^(p|div|h[1-6]|li|tr|section)$/).test(key) ? "\n\n" : key === "tc" ? " | " : "");
      }).join("")).join("");
      return clean(walk(ordered));
    };
    if (files["word/document.xml"]) {
      format = "docx";
      const doc = xml("word/document.xml");
      const headingStyles = new Set(["Title", "Heading1", "Heading2", "Heading3", "Heading4", "Heading5", "Heading6", "标题1", "标题2", "标题3"]);
      if (files["word/styles.xml"]) for (const style of list<any>(parser.parse(xml("word/styles.xml")).styles?.style)) {
        const name = String(style.name?.["@_val"] ?? "");
        const outline = style.pPr?.outlineLvl?.["@_val"];
        if (/heading|标题|^title$/i.test(name) || outline !== undefined && Number(outline) < 9) headingStyles.add(String(style["@_styleId"]));
      }
      // Paragraph styles/headings delimit sections; tables remain in document order.
      const blocks = doc.match(/<w:(p|tbl)(?:\s[^>]*)?>[\s\S]*?<\/w:\1>/g) ?? [];
      let current: BookSection = { title: "正文", text: "" };
      let volume = "";
      for (const [i, block] of blocks.entries()) {
        if (i % 256 === 0) await tick();
        checkCancelled(signal);
        const body = textOf(`<root xmlns:w="w">${block}</root>`, true);
        const style = /<w:pStyle[^>]+w:val=["']([^"']+)["']/i.exec(block)?.[1];
        const heading = style !== undefined && headingStyles.has(style) || /<w:outlineLvl[^>]+w:val=["'][0-8]["']/.test(block);
        if (heading && body) {
          if (current.text) sections.push(current);
          if (isVolumeHeading(body)) { volume = body; current = { title: body, text: "" }; }
          else current = { title: withVolume(volume, body), text: "" };
        }
        else if (body) current.text += (current.text ? "\n\n" : "") + body;
      }
      if (current.text) sections.push(current);
    } else if (files["META-INF/container.xml"]) {
      format = "epub";
      const container = parser.parse(xml("META-INF/container.xml"));
      const opf = list<any>(container.container?.rootfiles?.rootfile)[0]?.["@_full-path"];
      if (!opf || /(^|\/)\.\.(\/|$)/.test(opf)) throw new Error("找不到 EPUB 的阅读顺序");
      const pkg = parser.parse(xml(opf)).package;
      const entry = list<any>(pkg?.metadata?.title)[0];
      const t = typeof entry === "string" ? entry : entry?.["#text"];
      if (typeof t === "string" && t.trim()) title = t.trim();
      const manifest = new Map(list<any>(pkg?.manifest?.item).map((it) => [it["@_id"], it]));
      const resolvePath = (href: string, from = opf) => {
        if (/^[a-z]+:/i.test(href)) throw new Error("书籍含有外部正文地址");
        const base = from.includes("/") ? from.slice(0, from.lastIndexOf("/") + 1) : "";
        const path: string[] = [];
        for (const part of (base + safeDecodeUri(href.split("#")[0])).split("/")) { if (part === "..") path.pop(); else if (part !== "." && part) path.push(part); }
        return path.join("/");
      };
      const toc = new Map<string, string>();
      const tocAnchors = new Map<string, { anchor: string; label: string }[]>();
      const recordToc = (href: string, fromDir: string, label: string, parentVolume: string) => {
        const cleanLabel = label.trim();
        if (!cleanLabel) return;
        const path = resolvePath(href, fromDir);
        const fullLabel = withVolume(parentVolume, cleanLabel);
        const prev = toc.get(path);
        if (!prev || (isVolumeHeading(prev) && !isVolumeHeading(cleanLabel))) {
          toc.set(path, fullLabel);
        }
        const hashIdx = href.indexOf("#");
        if (hashIdx >= 0 && !isVolumeHeading(cleanLabel)) {
          const anchor = safeDecodeUri(href.slice(hashIdx + 1)).trim();
          if (anchor) {
            const list = tocAnchors.get(path) ?? [];
            if (!list.some((x) => x.anchor === anchor)) list.push({ anchor, label: fullLabel });
            tocAnchors.set(path, list);
          }
        }
      };
      const nav = [...manifest.values()].find((item) => String(item["@_properties"] ?? "").split(/\s+/).includes("nav"));
      if (nav) {
        const navPath = resolvePath(nav["@_href"]), value = xml(navPath);
        const navOrdered = new XMLParser({ preserveOrder: true, ignoreAttributes: false, allowBooleanAttributes: true, removeNSPrefix: true, processEntities: true, htmlEntities: true, parseTagValue: false }).parse(value) as any[];
        const inlineText = (nodes: any[]): string => clean(nodes.map((row) => Object.entries(row).map(([k, v]) => {
          if (k === ":@" || k === "ol" || k === "ul" || k === "li" || k === "script" || k === "style") return "";
          if (k === "#text") return String(v);
          return Array.isArray(v) ? inlineText(v) : "";
        }).join("")).join(""));
        const collectLiLinks = (items: any[], out: { href: string; label: string }[] = []) => {
          for (const item of items) {
            for (const [k, v] of Object.entries(item)) {
              if (k === ":@" || k === "ol" || k === "ul" || k === "li" || !Array.isArray(v)) continue;
              if (k === "a") {
                const attrs = item[":@"] ?? {};
                const h = typeof attrs["@_href"] === "string" ? attrs["@_href"] : null;
                const l = inlineText(v);
                if (h && l) out.push({ href: h, label: l });
              } else {
                collectLiLinks(v, out);
              }
            }
          }
          return out;
        };
        const walkNav = (nodes: any[], parentVolume = "", insideLi = false): string => {
          let currentVolume = parentVolume;
          for (const node of nodes) {
            for (const [tag, children] of Object.entries(node)) {
              if (tag === ":@" || !Array.isArray(children)) continue;
              if (tag === "li") {
                const links = collectLiLinks(children);
                const primaryLabel = links[0]?.label || inlineText(children);
                const inlineVol = primaryLabel ? extractInlineVolume(primaryLabel) : null;
                const nextVolume = primaryLabel && isVolumeHeading(primaryLabel) ? primaryLabel : inlineVol ?? currentVolume;
                for (const lnk of links) {
                  recordToc(lnk.href, navPath, lnk.label, currentVolume);
                }
                walkNav(children, nextVolume, true);
              } else if (tag === "ol" || tag === "ul") {
                walkNav(children, currentVolume, false);
              } else if (tag === "a") {
                if (!insideLi) {
                  const attrs = node[":@"] ?? {};
                  const href = typeof attrs["@_href"] === "string" ? attrs["@_href"] : null;
                  const label = inlineText(children);
                  if (href && label) {
                    recordToc(href, navPath, label, currentVolume);
                    const inlineVol = extractInlineVolume(label);
                    if (isVolumeHeading(label)) currentVolume = label;
                    else if (inlineVol) currentVolume = inlineVol;
                  }
                }
              } else {
                currentVolume = walkNav(children, currentVolume, insideLi);
              }
            }
          }
          return currentVolume;
        };
        const collectNavRoots = (nodes: any[]): any[][] => {
          const tocNavs: any[][] = [], allNavs: any[][] = [];
          const scan = (items: any[]) => {
            for (const row of items) {
              for (const [k, v] of Object.entries(row)) {
                if (k === ":@" || !Array.isArray(v)) continue;
                if (k === "nav") {
                  const attrs = row[":@"] ?? {};
                  const epubType = String(attrs["@_type"] ?? ""), role = String(attrs["@_role"] ?? "");
                  allNavs.push(v);
                  if (/\btoc\b/i.test(epubType) || /\bdoc-toc\b/i.test(role)) tocNavs.push(v);
                } else scan(v);
              }
            }
          };
          scan(nodes);
          return tocNavs.length ? tocNavs : allNavs.length ? [allNavs[0]] : [nodes];
        };
        for (const root of collectNavRoots(navOrdered)) walkNav(root);
      } else {
        const ncx = manifest.get(pkg?.spine?.["@_toc"]) ?? [...manifest.values()].find((item) => item["@_media-type"] === "application/x-dtbncx+xml");
        if (ncx) {
          const ncxPath = resolvePath(ncx["@_href"]);
          const walk = (points: any, parentVolume = "") => {
            for (const point of list<any>(points)) {
              const href = point.content?.["@_src"], rawLabel = point.navLabel?.text;
              const label = typeof rawLabel === "string" ? rawLabel.trim() : "";
              const inlineVol = label ? extractInlineVolume(label) : null;
              const nextVolume = label && isVolumeHeading(label) ? label : inlineVol ?? parentVolume;
              if (typeof href === "string" && label) recordToc(href, ncxPath, label, parentVolume);
              walk(point.navPoint, nextVolume);
            }
          };
          walk(parser.parse(xml(ncxPath)).ncx?.navMap?.navPoint);
        }
      }
      const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const spine = list<any>(pkg?.spine?.itemref);
      let epubVolume = "";
      for (const itemref of spine) {
        checkCancelled(signal); await tick();
        const item = manifest.get(itemref["@_idref"]);
        if (!item || itemref["@_linear"] === "no") continue;
        const path = resolvePath(item["@_href"]);
        const value = xml(path);
        const anchors = tocAnchors.get(path);
        if (anchors && anchors.length >= 2) {
          const located = anchors
            .map((a) => ({ ...a, index: new RegExp(`<[^>]+\\b(?:id|name)=["']${escapeRegExp(a.anchor)}["'][^>]*>`, "i").exec(value)?.index ?? -1 }))
            .filter((a) => a.index >= 0)
            .sort((a, b) => a.index - b.index);
          if (located.length >= 2) {
            const bodyEnd = /<\/body>/i.exec(value)?.index ?? value.length;
            for (let idx = 0; idx < located.length; idx++) {
              const slice = value.slice(located[idx].index, idx + 1 < located.length ? located[idx + 1].index : bodyEnd);
              const partText = clean(slice.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, "").replace(/<(?:br|cr)\b[^>]*>/gi, "\n").replace(/<\/(?:p|div|h[1-6]|li|tr|section)>/gi, "\n\n").replace(/<[^>]+>/g, "").replace(/&nbsp;/gi, " ").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&quot;/gi, '"').replace(/&apos;/gi, "'").replace(/&amp;/gi, "&"));
              if (partText) sections.push({ title: withVolume(epubVolume, located[idx].label), text: partText });
            }
            progress(`正在读取章节…${sections.length}`);
            continue;
          }
        }
        const text = textOf(value);
        const heading = /<h[1-6](?:\s[^>]*)?>([\s\S]*?)<\/h[1-6]>/i.exec(value)?.[1];
        const rawTitle = (toc.get(path) || (heading ? textOf(`<root>${heading}</root>`) : "")).trim();
        if (rawTitle && isVolumeHeading(rawTitle)) {
          epubVolume = rawTitle;
          // Skip bare volume cover pages whose text only repeats the volume heading.
          if (!text || text === rawTitle) continue;
        } else if (rawTitle) {
          const inlineVol = extractInlineVolume(rawTitle);
          if (inlineVol) epubVolume = inlineVol;
        }
        if (text) {
          const secTitle = rawTitle ? withVolume(epubVolume, rawTitle) : `第 ${sections.length + 1} 节`;
          sections.push({ title: secTitle, text });
        }
        progress(`正在读取章节…${sections.length}`);
      }
    } else throw new Error("不支持这种压缩文件，请选择 EPUB 或 DOCX");
  } else {
    if (/\.(?:mobi|azw3|azw|doc|zip|pdf|epub|docx)$/i.test(name) || bytes.subarray(0, 2048).includes(0) && !(bytes[0] === 255 && bytes[1] === 254 || bytes[0] === 254 && bytes[1] === 255)) throw new Error("文件可能已损坏或格式不受支持，请选择有效的 TXT、EPUB、PDF 或 DOCX");
    sections = await textSections(decodeText(bytes, options.encoding), signal);
  }
  checkCancelled(signal);
  if (!sections.length) throw new Error("没有找到可用正文，文件可能受保护或没有文字");
  return { id: newId(), title, format, createdAt: new Date().toISOString(), sections };
}

export async function parseBook(...args: Parameters<typeof readBook>): Promise<SourceBook> {
  try { return await readBook(...args); }
  catch (error) {
    if (error instanceof Error && (error.name === "AbortError" || /[\u4e00-\u9fff]/.test(error.message))) throw error;
    throw new Error("无法打开书籍，文件可能已损坏、受保护，或与所选编码不符");
  }
}
