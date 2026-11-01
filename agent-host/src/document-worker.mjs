// Trusted parser worker, not a skill or model-controlled Node extension.
import { parentPort, workerData } from "node:worker_threads";
import fs from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { parseBook } from "./document-parser.mjs";

try {
  const { path, name, version, operation, section = 0, offset = 0, charBudget = 4000, through, boundBookHash, query } = workerData;
  const bytes = new Uint8Array(await fs.readFile(path));
  if (createHash("sha256").update(bytes).digest("hex") !== version) throw new Error("资料文件版本已变化，请重新读取。");
  const platform = { files: { extractPdf: async () => {
    if (!workerData.pdf) throw new Error("PDF原生文字提取结果尚未取得。");
    return workerData.pdf;
  } } };
  const cachePath = `${path}.parser1-${workerData.encoding ?? "auto"}.json`;
  let book;
  try { const saved = JSON.parse(await fs.readFile(cachePath, "utf8")); if (saved.version === version && Array.isArray(saved.book?.sections)) book = saved.book; } catch { /* Rebuild an absent/invalid derived cache. */ }
  if (!book) {
    book = await parseBook({ name, bytes }, platform, { encoding: workerData.encoding ?? "auto" });
    const temporary = `${cachePath}.${randomUUID()}.tmp`;
    await fs.writeFile(temporary, JSON.stringify({ version, book }), { mode: 0o600 });
    await fs.rename(temporary, cachePath).catch(async () => { await fs.rm(temporary, { force: true }); });
  }
  const normalizedHash = createHash("sha256").update(JSON.stringify(book.sections.map(s => s.text))).digest("hex");
  const sections = boundBookHash === normalizedHash && Number.isSafeInteger(through) ? book.sections.slice(0, through + 1) : book.sections;
  const scalarLength = text => { let size = 0; for (const _ of text) size++; return size; };
  const take = (text, start, size) => { let pos = 0, result = ""; for (const ch of text) { if (pos >= start + size) break; if (pos >= start) result += ch; pos++; } return result; };
  let result = { title: book.title, format: book.format, version, normalizedHash, sectionCount: sections.length, untrusted: true };
  if (operation === "find") {
    if (typeof query !== "string" || !query || query.length > 512) throw new Error("请填写不超过512字的查找文字。");
    const hits = [];
    for (let i = 0; i < sections.length && hits.length < 20; i++) {
      const text = sections[i].text, found = text.indexOf(query);
      if (found < 0) continue;
      const at = scalarLength(text.slice(0, found)), start = Math.max(0, at - 160);
      hits.push({ section: i, title: sections[i].title, page: sections[i].page, offset: start, text: take(text, start, 600) });
    }
    result.hits = hits;
  } else {
    if (!Number.isSafeInteger(section) || section < 0 || section >= sections.length) throw new Error("所选章节不存在或超出本次参考范围。");
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("读取位置无效。");
    const current = sections[section], size = Math.min(24000, Math.max(1, Number(charBudget) || 4000));
    const text = take(current.text, offset, size), total = scalarLength(current.text);
    const directoryOffset = Math.max(0, Math.floor(Number(workerData.sectionOffset) || 0)), directorySize = Math.min(100, Math.max(1, Number(workerData.pageSize) || 40));
    result = { ...result, section, sectionTitle: current.title, page: current.page, text, offset, total,
      nextOffset: Math.min(total, offset + scalarLength(text)), complete: offset + scalarLength(text) >= total,
      nextSectionOffset: directoryOffset + directorySize < sections.length ? directoryOffset + directorySize : null,
      sections: sections.slice(directoryOffset, directoryOffset + directorySize).map((s, index) => ({ index: index + directoryOffset, title: s.title, page: s.page })) };
  }
  parentPort.postMessage({ ok: true, data: result });
} catch (error) {
  const message = error instanceof Error && /[\u4e00-\u9fff]/.test(error.message) ? error.message : "资料解析未完成，文件可能损坏、受保护或格式不受支持。";
  parentPort.postMessage({ ok: false, error: { code: "document_parse_failed", message } });
}
