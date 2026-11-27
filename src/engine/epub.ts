// W3C EPUB 3.3 packager (R35-T004).
// Produces a standards-compliant OCF ZIP container using `fflate.zipSync`
// with uncompressed `mimetype` at exact byte offsets 30..58, OPF 3.0 + NCX,
// `nav.xhtml` (`epub:type="toc"`), vector thread-bound book cover SVG, and
// night-mode-friendly Chinese typography.
import { strToU8, zipSync, type Zippable } from "fflate";
import type { NovelBook, NovelSection } from "./novel";

/** Strips illegal XML 1.0 control chars & lone surrogates, then escapes `&`, `<`, `>`, `"`, `'`. */
export function escapeXml(raw: string): string {
  return raw
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\uFFFE\uFFFF]/g, "")
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function formatDctermsModified(iso: string): string {
  const parsed = Date.parse(iso);
  const d = Number.isFinite(parsed) ? new Date(parsed) : new Date();
  return d.toISOString().replace(/\.\d+Z$/, "Z");
}

function sectionFileName(idx: number): string {
  return `section-${String(idx + 1).padStart(3, "0")}.xhtml`;
}

function sectionItemId(idx: number): string {
  return `sec-${String(idx + 1).padStart(3, "0")}`;
}

function buildContainerXml(): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">',
    "  <rootfiles>",
    '    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>',
    "  </rootfiles>",
    "</container>",
    "",
  ].join("\n");
}

function buildBookCss(): string {
  return [
    "@charset \"UTF-8\";",
    "/* Chinese classical typography; inherits reader foreground/background for night & sepia modes. */",
    "body {",
    "  margin: 0;",
    "  padding: 4% 5%;",
    "  color: inherit;",
    "  font-family: \"Source Han Serif SC\", \"Noto Serif CJK SC\", \"Songti SC\", \"STSong\", \"SimSun\", serif;",
    "  line-height: 1.9;",
    "  letter-spacing: 0.02em;",
    "  overflow-wrap: break-word;",
    "}",
    "h1.section-title {",
    "  font-size: 1.38em;",
    "  font-weight: 600;",
    "  line-height: 1.45;",
    "  margin: 1.4em 0 0.5em 0;",
    "  text-indent: 0;",
    "  letter-spacing: 0.06em;",
    "}",
    "p.section-subtitle {",
    "  font-size: 0.86em;",
    "  opacity: 0.72;",
    "  margin: 0 0 1.8em 0;",
    "  text-indent: 0;",
    "}",
    "p.prose {",
    "  margin: 0 0 0.78em 0;",
    "  text-indent: 2em;",
    "  text-align: justify;",
    "}",
    "p.divider {",
    "  margin: 1.45em 0;",
    "  text-indent: 0;",
    "  text-align: center;",
    "  opacity: 0.72;",
    "  letter-spacing: 0.14em;",
    "  font-size: 0.92em;",
    "}",
    "p.action {",
    "  margin: 0.95em 0;",
    "  padding-left: 0.85em;",
    "  text-indent: 0;",
    "  border-left: 2px solid currentColor;",
    "  opacity: 0.78;",
    "  font-size: 0.93em;",
    "}",
    "p.colophon {",
    "  margin: 2.6em 0 1.2em 0;",
    "  text-indent: 0;",
    "  text-align: center;",
    "  opacity: 0.72;",
    "  letter-spacing: 0.16em;",
    "  font-size: 0.92em;",
    "}",
    "nav#toc ol {",
    "  list-style: none;",
    "  padding-left: 0;",
    "  margin: 1em 0;",
    "}",
    "nav#toc li {",
    "  margin: 0.65em 0;",
    "  line-height: 1.6;",
    "}",
    "nav#toc a {",
    "  color: inherit;",
    "  text-decoration: none;",
    "}",
    ".cover-wrap {",
    "  margin: 0;",
    "  padding: 0;",
    "  text-align: center;",
    "}",
    ".cover-wrap svg {",
    "  max-width: 100%;",
    "  max-height: 94vh;",
    "  height: auto;",
    "}",
    "",
  ].join("\n");
}

function buildCoverSvgMarkup(book: NovelBook): string {
  const cleanChars = [...book.title.replace(/[\x00-\x1f\s]/g, "").trim()];
  const titleChars = (cleanChars.length ? cleanChars : [..."无题书卷"]).slice(0, 10);
  const sealChars = [...(book.seal || "未竟")].slice(0, 2);
  const eraText = (book.eraTitle || book.subtitle || "").slice(0, 16);

  const fontSize = titleChars.length <= 5 ? 42 : titleChars.length <= 8 ? 34 : 28;
  const stepY = Math.round(fontSize * 1.24);
  const startY = 178;

  const verticalTitleNodes = titleChars
    .map(
      (ch, idx) =>
        `    <text x="458" y="${startY + idx * stepY}" text-anchor="middle" font-size="${fontSize}" font-weight="700" fill="#231c16" font-family="Songti SC, Noto Serif CJK SC, STSong, serif">${escapeXml(ch)}</text>`,
    )
    .join("\n");

  const sealBottomY = Math.min(690, Math.max(540, startY + titleChars.length * stepY + 26));

  return [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 840" width="600" height="840" role="img" aria-label="书籍封面">',
    "  <!-- Indigo-slate classical thread-bound cover -->",
    '  <rect x="0" y="0" width="600" height="840" fill="#233142"/>',
    '  <rect x="14" y="14" width="572" height="812" fill="none" stroke="#394b61" stroke-width="1.5"/>',
    "  <!-- Left thread-binding spine & silk stitches -->",
    '  <line x1="76" y1="0" x2="76" y2="840" stroke="#c8bca8" stroke-width="2" stroke-opacity="0.72"/>',
    '  <line x1="82" y1="0" x2="82" y2="840" stroke="#16202b" stroke-width="1" stroke-opacity="0.6"/>',
    '  <line x1="0" y1="140" x2="76" y2="140" stroke="#dfd5c3" stroke-width="2.2"/>',
    '  <circle cx="76" cy="140" r="3" fill="#dfd5c3"/>',
    '  <line x1="0" y1="326" x2="76" y2="326" stroke="#dfd5c3" stroke-width="2.2"/>',
    '  <circle cx="76" cy="326" r="3" fill="#dfd5c3"/>',
    '  <line x1="0" y1="514" x2="76" y2="514" stroke="#dfd5c3" stroke-width="2.2"/>',
    '  <circle cx="76" cy="514" r="3" fill="#dfd5c3"/>',
    '  <line x1="0" y1="700" x2="76" y2="700" stroke="#dfd5c3" stroke-width="2.2"/>',
    '  <circle cx="76" cy="700" r="3" fill="#dfd5c3"/>',
    "  <!-- Warm xuan-paper vertical title slip (题签) -->",
    '  <rect x="394" y="96" width="128" height="648" rx="3" fill="#f3ead8" stroke="#8a7456" stroke-width="2"/>',
    '  <rect x="401" y="103" width="114" height="634" fill="none" stroke="#b39c7d" stroke-width="1"/>',
    verticalTitleNodes,
    "  <!-- Cinnabar seal (朱文印) -->",
    `  <g transform="translate(430, ${sealBottomY})">`,
    '    <rect x="0" y="0" width="56" height="56" rx="4" fill="#b3392a"/>',
    '    <rect x="4" y="4" width="48" height="48" rx="2" fill="none" stroke="#f5ece0" stroke-width="1.4"/>',
    `    <text x="28" y="25" text-anchor="middle" font-size="18" font-weight="700" fill="#f5ece0" font-family="Songti SC, Noto Serif CJK SC, serif">${escapeXml(sealChars[0] ?? "藏")}</text>`,
    `    <text x="28" y="47" text-anchor="middle" font-size="18" font-weight="700" fill="#f5ece0" font-family="Songti SC, Noto Serif CJK SC, serif">${escapeXml(sealChars[1] ?? "书")}</text>`,
    "  </g>",
    eraText
      ? `  <text x="148" y="768" font-size="16" fill="#cfd6de" fill-opacity="0.78" letter-spacing="2" font-family="Songti SC, Noto Serif CJK SC, serif">${escapeXml(eraText)}</text>`
      : "",
    "</svg>",
  ]
    .filter(Boolean)
    .join("\n");
}

function buildCoverXhtml(book: NovelBook, svgMarkup: string): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE html>',
    '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="zh-CN" lang="zh-CN">',
    "<head>",
    '  <meta charset="UTF-8"/>',
    `  <title>${escapeXml(book.title)} · 封面</title>`,
    '  <link rel="stylesheet" type="text/css" href="styles/book.css"/>',
    "</head>",
    '<body epub:type="cover">',
    '  <div class="cover-wrap">',
    svgMarkup,
    "  </div>",
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

function buildSectionXhtml(section: NovelSection, isFinalNarrative: boolean, statusLine: string): string {
  const bodyLines: string[] = [
    `    <h1 class="section-title">${escapeXml(section.title)}</h1>`,
  ];
  if (section.subtitle) {
    bodyLines.push(`    <p class="section-subtitle">${escapeXml(section.subtitle)}</p>`);
  }
  for (const p of section.paragraphs) {
    if (p.kind === "divider") {
      const text = p.text === "◇" ? "◇" : `◇ ${p.text} ◇`;
      bodyLines.push(`    <p class="divider">${escapeXml(text)}</p>`);
    } else if (p.kind === "action") {
      bodyLines.push(`    <p class="action">${escapeXml(`◇ ${p.text}`)}</p>`);
    } else {
      bodyLines.push(`    <p class="prose">${escapeXml(p.text)}</p>`);
    }
  }
  if (isFinalNarrative && statusLine) {
    bodyLines.push(`    <p class="colophon" epub:type="z3998:colophon">${escapeXml(statusLine)}</p>`);
  }

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<!DOCTYPE html>",
    '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="zh-CN" lang="zh-CN">',
    "<head>",
    '  <meta charset="UTF-8"/>',
    `  <title>${escapeXml(section.title)}</title>`,
    '  <link rel="stylesheet" type="text/css" href="styles/book.css"/>',
    "</head>",
    "<body>",
    '  <section epub:type="chapter">',
    ...bodyLines,
    "  </section>",
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

function buildNavXhtml(book: NovelBook, sections: NovelSection[]): string {
  const tocItems = sections
    .map((sec, idx) => `      <li><a href="${sectionFileName(idx)}">${escapeXml(sec.title)}</a></li>`)
    .join("\n");

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<!DOCTYPE html>",
    '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="zh-CN" lang="zh-CN">',
    "<head>",
    '  <meta charset="UTF-8"/>',
    `  <title>${escapeXml(book.title)} · 目录</title>`,
    '  <link rel="stylesheet" type="text/css" href="styles/book.css"/>',
    "</head>",
    "<body>",
    '  <nav epub:type="toc" id="toc" role="doc-toc">',
    "    <h1>目录</h1>",
    "    <ol>",
    tocItems,
    "    </ol>",
    "  </nav>",
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

function buildTocNcx(bookIdUrn: string, book: NovelBook, sections: NovelSection[]): string {
  const navPoints = sections
    .map(
      (sec, idx) => [
        `    <navPoint id="navPoint-${idx + 1}" playOrder="${idx + 1}">`,
        `      <navLabel><text>${escapeXml(sec.title)}</text></navLabel>`,
        `      <content src="${sectionFileName(idx)}"/>`,
        "    </navPoint>",
      ].join("\n"),
    )
    .join("\n");

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1" xml:lang="zh-CN">',
    "  <head>",
    `    <meta name="dtb:uid" content="${escapeXml(bookIdUrn)}"/>`,
    '    <meta name="dtb:depth" content="1"/>',
    '    <meta name="dtb:totalPageCount" content="0"/>',
    '    <meta name="dtb:maxPageNumber" content="0"/>',
    "  </head>",
    `  <docTitle><text>${escapeXml(book.title)}</text></docTitle>`,
    `  <docAuthor><text>${escapeXml(book.author || "佚名")}</text></docAuthor>`,
    "  <navMap>",
    navPoints,
    "  </navMap>",
    "</ncx>",
    "",
  ].join("\n");
}

function buildContentOpf(bookIdUrn: string, book: NovelBook, sections: NovelSection[]): string {
  const modified = formatDctermsModified(book.generatedAt);
  const manifestSections = sections
    .map(
      (_, idx) =>
        `    <item id="${sectionItemId(idx)}" href="${sectionFileName(idx)}" media-type="application/xhtml+xml"/>`,
    )
    .join("\n");
  const spineItems = sections
    .map((_, idx) => `    <itemref idref="${sectionItemId(idx)}"/>`)
    .join("\n");

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id" xml:lang="zh-CN">',
    '  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">',
    `    <dc:identifier id="book-id">${escapeXml(bookIdUrn)}</dc:identifier>`,
    `    <dc:title>${escapeXml(book.title || "未命名书卷")}</dc:title>`,
    `    <dc:creator>${escapeXml(book.author || "佚名")}</dc:creator>`,
    "    <dc:language>zh-CN</dc:language>",
    book.subtitle ? `    <dc:description>${escapeXml(book.subtitle)}</dc:description>` : "",
    `    <meta property="dcterms:modified">${escapeXml(modified)}</meta>`,
    '    <meta name="cover" content="cover-image"/>',
    "  </metadata>",
    "  <manifest>",
    '    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>',
    '    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>',
    '    <item id="css" href="styles/book.css" media-type="text/css"/>',
    '    <item id="cover-image" href="cover.svg" media-type="image/svg+xml" properties="cover-image"/>',
    '    <item id="cover" href="cover.xhtml" media-type="application/xhtml+xml" properties="svg"/>',
    manifestSections,
    "  </manifest>",
    '  <spine toc="ncx">',
    '    <itemref idref="cover" linear="no"/>',
    spineItems,
    "  </spine>",
    "</package>",
    "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Packages a `NovelBook` into W3C EPUB 3.3 OCF bytes with uncompressed leading `mimetype`. */
export function buildEpubBytes(book: NovelBook): Uint8Array {
  const sections: NovelSection[] = book.sections.length
    ? book.sections
    : [
        {
          index: 0,
          kind: "chapter",
          title: "第一回",
          chapterNumber: 1,
          paragraphs: [{ kind: "prose", text: book.statusLine || "（正文暂缺）", nodeId: null }],
          chars: (book.statusLine || "").length,
        },
      ];

  let lastNarrativeIdx = sections.length - 1;
  for (let i = sections.length - 1; i >= 0; i--) {
    if (sections[i].kind === "chapter" || sections[i].kind === "prologue") {
      lastNarrativeIdx = i;
      break;
    }
  }

  const safeWorld = (book.worldId || "world").replace(/[^A-Za-z0-9_-]/g, "");
  const safeLine = (book.lineId || "main").replace(/[^A-Za-z0-9_-]/g, "");
  const bookIdUrn = `urn:lishi:novel:${safeWorld || "story"}:${safeLine || "line"}`;
  const coverSvg = buildCoverSvgMarkup(book);

  // CRITICAL OCF SPEC: `mimetype` MUST be the very first entry, stored at compression level 0 with no extra fields.
  const archive: Zippable = {
    mimetype: [strToU8("application/epub+zip"), { level: 0 }],
    "META-INF/container.xml": strToU8(buildContainerXml()),
    "OEBPS/content.opf": strToU8(buildContentOpf(bookIdUrn, book, sections)),
    "OEBPS/nav.xhtml": strToU8(buildNavXhtml(book, sections)),
    "OEBPS/toc.ncx": strToU8(buildTocNcx(bookIdUrn, book, sections)),
    "OEBPS/styles/book.css": strToU8(buildBookCss()),
    "OEBPS/cover.svg": strToU8(`<?xml version="1.0" encoding="UTF-8"?>\n${coverSvg}\n`),
    "OEBPS/cover.xhtml": strToU8(buildCoverXhtml(book, coverSvg)),
  };

  sections.forEach((sec, idx) => {
    archive[`OEBPS/${sectionFileName(idx)}`] = strToU8(
      buildSectionXhtml(sec, idx === lastNarrativeIdx, book.statusLine),
    );
  });

  return zipSync(archive);
}
