import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { zipSync, strToU8 } from "fflate";
import { parseDocument, cancelDocument } from "../.cache/runtime/host/src/documents.mjs";

test("packaged parser worker reuses book parsing, preserves spine/order and fences an identical bound file", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "lishi-documents-"));
  const hash = bytes => createHash("sha256").update(bytes).digest("hex");
  async function read(name, bytes, extra = {}) {
    const file = path.join(directory, name); await fs.writeFile(file, bytes);
    return parseDocument({ id: randomUUID(), taskId: "isolated", path: file, name, version: hash(bytes), operation: "read", ...extra });
  }
  try {
    const text = strToU8("第一章 灯\n甲😀乙丙\n第二章 信\n后续秘密");
    const first = await read("book.txt", text, { charBudget: 2 });
    assert.equal(first.ok, true); assert.equal(first.data.text, "甲😀"); assert.equal(first.data.nextOffset, 2);
    const limited = await read("book.txt", text, { boundBookHash: first.data.normalizedHash, through: 0, query: "秘密", operation: "find" });
    assert.equal(limited.data.sectionCount, 1); assert.deepEqual(limited.data.hits, []);
    assert.equal((await read("book.txt", text, { boundBookHash: first.data.normalizedHash, through: 0, section: 1 })).ok, false);
    assert.equal((await read("gbk.txt", Uint8Array.from([0xd6, 0xd0, 0xce, 0xc4]))).data.text, "中文");
    const epub = zipSync({
      "META-INF/container.xml": strToU8('<container><rootfiles><rootfile full-path="OEBPS/book.opf"/></rootfiles></container>'),
      "OEBPS/book.opf": strToU8('<package><metadata><title>样本</title></metadata><manifest><item id="one" href="z.xhtml"/><item id="two" href="a.xhtml"/></manifest><spine><itemref idref="one"/><itemref idref="two"/></spine></package>'),
      "OEBPS/z.xhtml": strToU8('<html><body><h1>第一章</h1><p>先读甲。</p></body></html>'),
      "OEBPS/a.xhtml": strToU8('<html><body><h1>第二章</h1><p>后读乙。</p></body></html>'),
    });
    const book = await read("book.epub", epub, { pageSize: 1 });
    assert.match(book.data.text, /先读甲/); assert.equal(book.data.nextSectionOffset, 1);
    const second = await read("book.epub", epub, { section: 1, sectionOffset: 1, pageSize: 1 }); assert.equal(second.data.sections[0].index, 1); assert.match(second.data.text, /后读乙/);
    const docx = zipSync({ "word/document.xml": strToU8('<w:document xmlns:w="w"><w:body><w:p><w:r><w:t>段落甲</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>表格乙</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:p><w:r><w:t>段落丙</w:t></w:r></w:p></w:body></w:document>') });
    assert.match((await read("book.docx", docx)).data.text, /段落甲[\s\S]*表格乙[\s\S]*段落丙/);
    assert.equal((await read("scan.pdf", strToU8("%PDF-1.7"), { pdf: { pages: [""], headings: [] } })).ok, false);
    const pdf = await read("text.pdf", strToU8("%PDF-1.7"), { pdf: { pages: ["原生提取中文第一页", "第二页"], headings: [] }, section: 1 });
    assert.equal(pdf.data.page, 2); assert.equal(pdf.data.text, "第二页");
    assert.equal((await read("broken.epub", strToU8("PK坏文件"))).ok, false);
    const cancelled = randomUUID(); const pending = parseDocument({ id: cancelled, path: path.join(directory, "book.txt"), name: "book.txt", version: hash(text), operation: "read" });
    cancelDocument(cancelled); await assert.rejects(pending, /停止/);
  } finally { await fs.rm(directory, { force: true, recursive: true }); }
});
