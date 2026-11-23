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
const VOLUME_HEADING_RE = /^(?:第\s*[零〇一二三四五六七八九十百千万两\d]+\s*[卷部篇](?!.*第\s*[零〇一二三四五六七八九十百千万两\d]+\s*[章节回话幕折])[^\n]{0,65}|part\s+[\divxlc]+[^\n]{0,65})$/i;
const CHAPTER_HEADING_RE = /^(?:第\s*[零〇一二三四五六七八九十百千万两\d]+\s*[章节回话幕折][^\n]{0,65}|chapter\s+[\divxlc]+[^\n]{0,65})$/i;
const SECTION_LINE_RE = /^\s*(?![^\n]*。$)(?:第[零〇一二三四五六七八九十百千万两\d]+[卷章节回部篇话幕折][^\n]{0,65}|(?:序章|序言|楔子|尾声|后记|前言|引子)|(?:chapter|part)\s+[\divxlc]+[^\n]{0,65})\s*$/i;
const HAS_VOLUME_MARKER_RE = /(?:第\s*[零〇一二三四五六七八九十百千万两\d]+\s*[卷部篇]|\bpart\s+[\divxlc]+\b)/i;

function isVolumeHeading(line: string): boolean {
  return VOLUME_HEADING_RE.test(line.trim());
}

function withVolume(volume: string, heading: string): string {
  const cleanHeading = heading.trim();
  const cleanVolume = volume.trim();
  if (!cleanVolume || !cleanHeading || !CHAPTER_HEADING_RE.test(cleanHeading)) return cleanHeading;
  if (cleanHeading.includes(cleanVolume) || HAS_VOLUME_MARKER_RE.test(cleanHeading)) return cleanHeading;
  return `${cleanVolume} · ${cleanHeading}`;
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
      else title = withVolume(volume, trimmed);
    } else lines.push(line);
  }
  flush();
  return sections;
}

async function readBook(file: { name: string; bytes: Uint8Array }, platform: Platform, options: { encoding?: TextEncoding; signal?: AbortSignal; progress?: (text: string) => void } = {}): Promise<SourceBook> {
  const { bytes, name } = file;
  const { signal, progress = () => {} } = options;
  checkCancelled(signal);
  if (!bytes.length || bytes.length > 64 * 1024 * 1024) throw new Error("文件为空或超过 64 MiB");
  let format: BookFormat = "txt", title = name.replace(/\.[^.]+$/, "") || "参考书籍", sections: BookSection[] = [];
  progress("正在读取正文…"); await tick();
  checkCancelled(signal);
  if (new TextDecoder().decode(bytes.subarray(0, 5)) === "%PDF-") {
    format = "pdf";
    const { pages, headings } = await platform.files.extractPdf(bytes, signal);
    const ordered = [...headings].sort((a, b) => a.page - b.page)
      .filter((heading, index, all) => !index || all[index - 1].page !== heading.page);
    let next = 0;
    for (const [i, text] of pages.entries()) {
      if (i % 40 === 0) { await tick(); checkCancelled(signal); }
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
      if (XMLValidator.validate(safe) !== true) throw new Error("书籍文档已损坏");
      return safe;
    };
    const parser = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true, processEntities: true, htmlEntities: true, parseTagValue: false });
    const list = <T,>(x: T | T[] | undefined): T[] => x === undefined ? [] : Array.isArray(x) ? x : [x];
    const textOf = (value: string, docx = false) => {
      const ordered = new XMLParser({ preserveOrder: true, ignoreAttributes: false, removeNSPrefix: true, processEntities: true, htmlEntities: true, parseTagValue: false }).parse(value) as any[];
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
        for (const part of (base + decodeURIComponent(href.split("#")[0])).split("/")) { if (part === "..") path.pop(); else if (part !== "." && part) path.push(part); }
        return path.join("/");
      };
      const toc = new Map<string, string>();
      const nav = [...manifest.values()].find((item) => String(item["@_properties"] ?? "").split(/\s+/).includes("nav"));
      if (nav) {
        const navPath = resolvePath(nav["@_href"]), value = xml(navPath);
        for (const match of value.matchAll(/<(?:\w+:)?a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/(?:\w+:)?a>/gi)) {
          const path = resolvePath(match[1], navPath);
          if (!toc.has(path)) toc.set(path, textOf(`<root>${match[2]}</root>`));
        }
      } else {
        const ncx = manifest.get(pkg?.spine?.["@_toc"]) ?? [...manifest.values()].find((item) => item["@_media-type"] === "application/x-dtbncx+xml");
        if (ncx) {
          const ncxPath = resolvePath(ncx["@_href"]);
          const walk = (points: any, parentVolume = "") => {
            for (const point of list<any>(points)) {
              const href = point.content?.["@_src"], rawLabel = point.navLabel?.text;
              const label = typeof rawLabel === "string" ? rawLabel.trim() : "";
              const nextVolume = label && isVolumeHeading(label) ? label : parentVolume;
              if (typeof href === "string" && label) {
                const path = resolvePath(href, ncxPath);
                const prev = toc.get(path);
                if (!prev || (isVolumeHeading(prev) && !isVolumeHeading(label))) {
                  toc.set(path, withVolume(parentVolume, label));
                }
              }
              walk(point.navPoint, nextVolume);
            }
          };
          walk(parser.parse(xml(ncxPath)).ncx?.navMap?.navPoint);
        }
      }
      const spine = list<any>(pkg?.spine?.itemref);
      let epubVolume = "";
      for (const itemref of spine) {
        checkCancelled(signal); await tick();
        const item = manifest.get(itemref["@_idref"]);
        if (!item || itemref["@_linear"] === "no") continue;
        const path = resolvePath(item["@_href"]);
        const value = xml(path), text = textOf(value);
        const heading = /<h[1-6](?:\s[^>]*)?>([\s\S]*?)<\/h[1-6]>/i.exec(value)?.[1];
        const rawTitle = (toc.get(path) || (heading ? textOf(`<root>${heading}</root>`) : "")).trim();
        if (rawTitle && isVolumeHeading(rawTitle)) {
          epubVolume = rawTitle;
          // Skip bare volume cover pages whose text only repeats the volume heading.
          if (!text || text === rawTitle) continue;
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
