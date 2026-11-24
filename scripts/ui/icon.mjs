// R36 R2-A: Offline SVG-to-PNG icon pipeline + multi-platform Tauri icon generation +
// Small-size (16/24/32px) high-contrast simplified desktop frames + pure-Buffer multi-frame
// PNG-in-ICO builder (16, 24, 32, 48, 64, 128, 256) + tightened legacy Android mipmap icons.
//   node scripts/ui/icon.mjs
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { chromium } from "playwright-core";
import { launchBrowser } from "./browser.mjs";

const root = process.cwd();
const fontPkgDir = path.resolve(root, "node_modules/@fontsource-variable/noto-serif-sc");
const fontCssPath = path.join(fontPkgDir, "index.css");
if (!fs.existsSync(fontCssPath)) {
  throw new Error(`Missing local font package CSS: ${fontCssPath}`);
}

const rawCss = fs.readFileSync(fontCssPath, "utf8");
const woffCache = new Map();

function rangeMatches(unicodeRange, targetCodes) {
  const re = /U\+([0-9a-fA-F]+)(?:-([0-9a-fA-F]+))?/g;
  let match;
  while ((match = re.exec(unicodeRange)) !== null) {
    const start = Number.parseInt(match[1], 16);
    const end = match[2] ? Number.parseInt(match[2], 16) : start;
    for (const code of targetCodes) {
      if (code >= start && code <= end) return true;
    }
  }
  return false;
}

function buildOfflineFontCss(targetText) {
  const targetCodes = [...new Set([...targetText].map((ch) => ch.codePointAt(0)).filter((n) => n !== undefined))];
  const blocks = rawCss.match(/@font-face\s*\{[^}]+\}/g) ?? [];
  const inlinedRules = [];

  for (const block of blocks) {
    const rangeMatch = block.match(/unicode-range:\s*([^;]+);/i);
    if (rangeMatch && !rangeMatches(rangeMatch[1], targetCodes)) continue;

    const rewritten = block
      .replace(/font-display:\s*swap;/gi, "font-display: block;")
      .replace(/url\(\.\/files\/([^)]+)\)\s*format\(['"]woff2-variations['"]\)/g, (_full, fileName) => {
        let dataUrl = woffCache.get(fileName);
        if (!dataUrl) {
          const woffPath = path.join(fontPkgDir, "files", fileName);
          if (!fs.existsSync(woffPath)) {
            throw new Error(`Missing local woff2 subset: ${woffPath}`);
          }
          dataUrl = `data:font/woff2;base64,${fs.readFileSync(woffPath).toString("base64")}`;
          woffCache.set(fileName, dataUrl);
        }
        return `url("${dataUrl}") format("woff2")`;
      });

    inlinedRules.push(rewritten);
    inlinedRules.push(rewritten.replace(/font-family:\s*['"]Noto Serif SC Variable['"]/g, 'font-family: "Noto Serif SC"'));
  }

  if (inlinedRules.length === 0) {
    throw new Error("No @font-face subsets matched target glyphs in @fontsource-variable/noto-serif-sc");
  }
  return inlinedRules.join("\n");
}

/**
 * High-contrast simplified SVG specifically engineered for 16x16, 24x24, and 32x32
 * Windows taskbar / titlebar / tray icons:
 * - Zero 1px fine Wu-si-lan grid lines (prevents muddy gray-brown pages)
 * - Bright warm-ivory tilted open book pages + warm gold page block
 * - Full-bodied vibrant cinnabar seal + crisp ivory-gold rim & clean high-legibility mark
 * - Bold luminous brushed-gold C-crescent portal arc
 * - Exact >= 1.2px-1.5px gilded outer border + inner highlight so pure-black taskbar never melts
 */
function buildCompactSmallDesktopSvg(size) {
  // Scale stroke widths in 1024-space so physical pixel stroke is ~1.15px at 16px and ~1.45px at 24/32px
  const pxUnit = 1024 / size;
  const outerRimW = Math.round(pxUnit * (size <= 16 ? 1.15 : 1.45));
  const innerRimW = Math.round(pxUnit * 0.68);
  const pad = size <= 16 ? 12 : 16;
  const box = 1024 - pad * 2;
  const rx = Math.round(box * 0.225);
  const outerHalf = outerRimW / 2;
  const sealRimW = Math.round(pxUnit * 0.82);

  // Seal outer face sits at x=304..720 (center 512), y=258..674 (geometric center y=466, NOT 512!).
  // - At 16px (1px = 64 units): snap a minimal symmetric seal crown+stem mark to the 64-unit pixel grid
  //   strictly centered at (512, 466) [y=384..548 => center 466; x=384..640 & 448..576 => center 512],
  //   preserving ~2px pure cinnabar red margins all around with zero pink-white blur blob.
  // - At 24px/32px: lift bold '穿' baseline to y=538 (optical center of y=258..674) so bottom stroke clears rim.
  const sealInner =
    size <= 16
      ? `<g fill="#fffaf0">
           <rect x="384" y="384" width="256" height="64" rx="14"/>
           <rect x="448" y="384" width="128" height="164" rx="14"/>
         </g>`
      : `<rect x="${304 + sealRimW * 1.55}" y="${258 + sealRimW * 1.55}"
               width="${416 - sealRimW * 3.1}" height="${416 - sealRimW * 3.1}"
               rx="${Math.max(40, Math.round(86 - sealRimW * 1.2))}"
               fill="none" stroke="#fff5df" stroke-width="${sealRimW}" stroke-opacity="0.88"/>
         <text x="512" y="538" text-anchor="middle" font-family="'Noto Serif SC Variable', 'Noto Serif SC', serif" font-weight="700" font-size="214" fill="#fffaf0">穿</text>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="${size}" height="${size}">
    <defs>
      <clipPath id="smClip">
        <rect x="${pad}" y="${pad}" width="${box}" height="${box}" rx="${rx}"/>
      </clipPath>
      <radialGradient id="smBg" cx="50%" cy="38%" r="72%">
        <stop offset="0%" stop-color="#241c15"/>
        <stop offset="62%" stop-color="#120f0c"/>
        <stop offset="100%" stop-color="#090807"/>
      </radialGradient>
      <linearGradient id="smGold" gradientUnits="userSpaceOnUse" x1="790" y1="200" x2="210" y2="800">
        <stop offset="0%" stop-color="#fff8da"/>
        <stop offset="45%" stop-color="#f9d57e"/>
        <stop offset="100%" stop-color="#d19636"/>
      </linearGradient>
      <linearGradient id="smSeal" x1="15%" y1="10%" x2="85%" y2="90%">
        <stop offset="0%" stop-color="#f25238"/>
        <stop offset="52%" stop-color="#cc2b1c"/>
        <stop offset="100%" stop-color="#991a10"/>
      </linearGradient>
      <clipPath id="smFrontArc">
        <polygon points="500,0 1024,0 1024,1024 120,1024 120,675 500,605"/>
      </clipPath>
      <g id="smOrbit">
        <g transform="rotate(-24 512 512)">
          <path d="M 126 446
                   A 398 350 0 1 1 166 692
                   A 338 292 0 1 0 126 446 Z"
                fill="url(#smGold)"/>
        </g>
      </g>
    </defs>

    <g clip-path="url(#smClip)">
      <rect x="${pad}" y="${pad}" width="${box}" height="${box}" rx="${rx}" fill="url(#smBg)"/>

      <!-- Back half of bold luminous gold arc -->
      <use href="#smOrbit"/>

      <!-- Bold tilted warm-ivory Xuan-paper book wings (zero 1px Wu-si-lan clutter!) -->
      <g transform="rotate(-5.5 512 528)">
        <!-- Warm golden-ochre page thickness block -->
        <path d="M 98 642 Q 305 602, 512 674 Q 719 602, 926 642 L 932 702 Q 720 662, 512 732 Q 304 662, 92 702 Z"
              fill="#cfa66c"/>
        <!-- Bright ivory-cream left & right open pages -->
        <path d="M 106 410 Q 309 368, 512 432 L 512 676 Q 305 604, 98 648 Z"
              fill="#fffaf0"/>
        <path d="M 512 432 Q 715 368, 918 410 L 926 648 Q 719 604, 512 676 Z"
              fill="#f6e5c4"/>
        <!-- Clean central spine divider -->
        <line x1="512" y1="432" x2="512" y2="680" stroke="#8f6535" stroke-width="${Math.max(22, Math.round(pxUnit * 0.82))}"/>
      </g>

      <!-- Full-bodied vibrant Cinnabar Square-Rounded Seal -->
      <rect x="304" y="280" width="416" height="416" rx="86" fill="#630f08"/>
      <rect x="304" y="258" width="416" height="416" rx="86" fill="url(#smSeal)"/>
      ${sealInner}

      <!-- Front sweep of bold luminous gold arc -->
      <g clip-path="url(#smFrontArc)">
        <use href="#smOrbit"/>
      </g>

      <!-- Inner specular catchlight inside gilded frame -->
      <rect x="${pad + outerRimW + innerRimW / 2}" y="${pad + outerRimW + innerRimW / 2}"
            width="${box - (outerRimW + innerRimW / 2) * 2}" height="${box - (outerRimW + innerRimW / 2) * 2}"
            rx="${Math.max(40, rx - outerRimW)}"
            fill="none" stroke="rgba(255, 246, 218, 0.30)" stroke-width="${innerRimW}"/>

      <!-- Crisp gilded outer rim so 16/24/32 never melts into pure-black Windows 11 taskbar -->
      <rect x="${pad + outerHalf}" y="${pad + outerHalf}"
            width="${box - outerRimW}" height="${box - outerRimW}"
            rx="${Math.max(48, Math.round(rx - outerHalf))}"
            fill="none" stroke="rgba(232, 194, 116, 0.70)" stroke-width="${outerRimW}"/>
    </g>
  </svg>`;
}

/**
 * Wraps assets/app-icon-desktop.svg for mid-size desktop icons (48x48, 64x64) with
 * reinforced physical-pixel gilded outer border so 48px taskbar also stays crisp on #000.
 */
function buildSizedFullDesktopSvg(baseDesktopSvg, size) {
  const pxUnit = 1024 / size;
  const extraStroke = size <= 64 ? Math.round(pxUnit * 1.25) : 0;
  const overlay =
    extraStroke > 0
      ? `<rect x="${24 + extraStroke / 2}" y="${24 + extraStroke / 2}" width="${976 - extraStroke}" height="${976 - extraStroke}" rx="${Math.round(216 - extraStroke / 2)}" fill="none" stroke="rgba(226, 188, 112, 0.56)" stroke-width="${extraStroke}"/>`
      : "";
  return baseDesktopSvg
    .replace('width="1024" height="1024"', `width="${size}" height="${size}"`)
    .replace("</svg>", `${overlay}</svg>`);
}

/**
 * Tightened legacy Android launcher SVG (ic_launcher.png & ic_launcher_round.png):
 * eliminates the excessive adaptive-icon outer margin so visual area matches mainstream
 * domestic Android launcher icons (~93.75% of 48dp canvas, minimal 1.5dp clean edge).
 */
function buildAndroidLegacySvg(baseDesktopSvg, shape, size) {
  // Extract inner <defs> content and motif <g transform="translate(512 516)..."> from app-icon-desktop.svg
  const innerDefs = baseDesktopSvg.match(/<defs>([\s\S]*?)<\/defs>/)?.[1] ?? "";
  const motifMatch = baseDesktopSvg.match(/<g transform="translate\(512 516\) scale\(1\.42\) translate\(-512 -512\)">([\s\S]*?)<\/g>\s*\n\s*<!-- Dual-layer/)?.[1];
  if (!motifMatch) {
    throw new Error("Could not extract desktop motif group for legacy Android icon");
  }
  const pxUnit = 1024 / size;
  const rimW = Math.max(8, Math.round(pxUnit * 1.15));

  if (shape === "round") {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="${size}" height="${size}">
      <defs>
        ${innerDefs}
        <clipPath id="legacyRoundClip"><circle cx="512" cy="512" r="480"/></clipPath>
      </defs>
      <g clip-path="url(#legacyRoundClip)">
        <circle cx="512" cy="512" r="480" fill="url(#bg)"/>
        <g transform="translate(512 516) scale(1.36) translate(-512 -512)">${motifMatch}</g>
        <circle cx="512" cy="512" r="${480 - rimW / 2}" fill="none" stroke="rgba(226, 188, 112, 0.50)" stroke-width="${rimW}"/>
      </g>
    </svg>`;
  }

  // Squircle / rounded-square legacy icon: x=32 y=32 width=960 height=960 rx=216 (93.75% visual area)
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="${size}" height="${size}">
    <defs>
      ${innerDefs}
      <clipPath id="legacySqClip"><rect x="32" y="32" width="960" height="960" rx="216"/></clipPath>
    </defs>
    <g clip-path="url(#legacySqClip)">
      <rect x="32" y="32" width="960" height="960" rx="216" fill="url(#bg)"/>
      <g transform="translate(512 516) scale(1.40) translate(-512 -512)">${motifMatch}</g>
      <rect x="${32 + rimW / 2}" y="${32 + rimW / 2}" width="${960 - rimW}" height="${960 - rimW}" rx="${Math.round(216 - rimW / 2)}" fill="none" stroke="rgba(226, 188, 112, 0.52)" stroke-width="${rimW}"/>
    </g>
  </svg>`;
}

/**
 * Pure Node Buffer multi-frame PNG-in-ICO builder.
 * Frames: [{ size: 16|24|32|48|64|128|256, png: Buffer }]
 */
function buildPngIco(frames) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // Reserved
  header.writeUInt16LE(1, 2); // Type 1 = ICO
  header.writeUInt16LE(frames.length, 4);

  const dirSize = 16 * frames.length;
  const dir = Buffer.alloc(dirSize);
  let dataOffset = 6 + dirSize;

  frames.forEach(({ size, png }, idx) => {
    const entryOff = idx * 16;
    dir.writeUInt8(size >= 256 ? 0 : size, entryOff + 0);
    dir.writeUInt8(size >= 256 ? 0 : size, entryOff + 1);
    dir.writeUInt8(0, entryOff + 2); // No palette
    dir.writeUInt8(0, entryOff + 3); // Reserved
    dir.writeUInt16LE(1, entryOff + 4); // Color planes
    dir.writeUInt16LE(32, entryOff + 6); // 32 bpp RGBA
    dir.writeUInt32LE(png.length, entryOff + 8);
    dir.writeUInt32LE(dataOffset, entryOff + 12);
    dataOffset += png.length;
  });

  return Buffer.concat([header, dir, ...frames.map((f) => f.png)]);
}

function runTauriIcon(inputPng, outDir, extraArgs = []) {
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  const tauriCliJs = path.resolve(root, "node_modules/@tauri-apps/cli/tauri.js");
  execFileSync(process.execPath, [tauriCliJs, "icon", inputPng, "--output", outDir, ...extraArgs], {
    cwd: root,
    stdio: "inherit",
  });
}

const appIconSvg = fs.readFileSync(path.resolve(root, "assets/app-icon.svg"), "utf8");
const desktopIconSvg = fs.readFileSync(path.resolve(root, "assets/app-icon-desktop.svg"), "utf8");
const fontCss = buildOfflineFontCss(`穿越${appIconSvg}${desktopIconSvg}`);

async function renderSvgBuffer(page, svgMarkup, size) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>
${fontCss}
html,body{margin:0;padding:0;width:${size}px;height:${size}px;background:transparent;overflow:hidden}
svg{display:block;width:${size}px;height:${size}px}
</style></head><body>${svgMarkup}</body></html>`);

  await page.evaluate(async () => {
    await Promise.all([
      document.fonts.load('700 140px "Noto Serif SC"', "穿越"),
      document.fonts.load('700 140px "Noto Serif SC Variable"', "穿越"),
    ]);
    await document.fonts.ready;
  });

  const loaded = await page.evaluate(
    () =>
      document.fonts.check('700 140px "Noto Serif SC"', "穿越") &&
      document.fonts.check('700 140px "Noto Serif SC Variable"', "穿越"),
  );
  if (!loaded) {
    throw new Error("Offline Noto Serif SC did not load; refusing to render fallback glyphs");
  }

  return await page.locator("svg").screenshot({ omitBackground: true });
}

const browser = await launchBrowser(chromium);
try {
  const page = await browser.newPage({ viewport: { width: 1024, height: 1024 }, deviceScaleFactor: 1 });

  // 1. Render base 1024x1024 PNGs
  const android1024 = await renderSvgBuffer(page, appIconSvg, 1024);
  fs.writeFileSync(path.resolve(root, "assets/app-icon.png"), android1024);
  console.log("assets/app-icon.png");

  const desktop1024 = await renderSvgBuffer(page, desktopIconSvg, 1024);
  fs.writeFileSync(path.resolve(root, "assets/app-icon-desktop.png"), desktop1024);
  console.log("assets/app-icon-desktop.png");

  // 2. Run `tauri icon` in isolated .cache directories so we never clobber monochrome XML or values XML
  const cacheBase = path.resolve(root, ".cache/icons-gen");
  const cacheAndroid = path.join(cacheBase, "android");
  const cacheDesktop = path.join(cacheBase, "desktop");
  runTauriIcon("assets/app-icon.png", cacheAndroid, ["--ios-color", "#0F0D0B"]);
  runTauriIcon("assets/app-icon-desktop.png", cacheDesktop);

  // Copy desktop base icons (icon.icns, icon.png, Square*Logo.png, StoreLogo.png, etc.) to src-tauri/icons/
  for (const entry of fs.readdirSync(cacheDesktop, { withFileTypes: true })) {
    if (entry.isFile()) {
      fs.copyFileSync(path.join(cacheDesktop, entry.name), path.resolve(root, "src-tauri/icons", entry.name));
    }
  }
  // Copy iOS icons from cacheAndroid/ios to src-tauri/icons/ios/
  const iosSrc = path.join(cacheAndroid, "ios");
  const iosDst = path.resolve(root, "src-tauri/icons/ios");
  if (fs.existsSync(iosSrc)) {
    fs.mkdirSync(iosDst, { recursive: true });
    for (const entry of fs.readdirSync(iosSrc, { withFileTypes: true })) {
      if (entry.isFile()) {
        fs.copyFileSync(path.join(iosSrc, entry.name), path.join(iosDst, entry.name));
      }
    }
  }

  // Copy adaptive foregrounds from cacheAndroid/android/mipmap-* to both icon trees
  const densities = [
    { name: "mdpi", legacySize: 48 },
    { name: "hdpi", legacySize: 72 },
    { name: "xhdpi", legacySize: 96 },
    { name: "xxhdpi", legacySize: 144 },
    { name: "xxxhdpi", legacySize: 192 },
  ];

  for (const { name, legacySize } of densities) {
    const fgSrc = path.join(cacheAndroid, "android", `mipmap-${name}`, "ic_launcher_foreground.png");
    const genDir = path.resolve(root, `src-tauri/gen/android/app/src/main/res/mipmap-${name}`);
    const tauriIconAndroidDir = path.resolve(root, `src-tauri/icons/android/mipmap-${name}`);
    fs.mkdirSync(genDir, { recursive: true });
    fs.mkdirSync(tauriIconAndroidDir, { recursive: true });
    fs.copyFileSync(fgSrc, path.join(genDir, "ic_launcher_foreground.png"));
    fs.copyFileSync(fgSrc, path.join(tauriIconAndroidDir, "ic_launcher_foreground.png"));

    // 3. Render tightened legacy Android ic_launcher.png & ic_launcher_round.png
    const sqBuf = await renderSvgBuffer(page, buildAndroidLegacySvg(desktopIconSvg, "square", legacySize), legacySize);
    const rdBuf = await renderSvgBuffer(page, buildAndroidLegacySvg(desktopIconSvg, "round", legacySize), legacySize);
    for (const targetDir of [genDir, tauriIconAndroidDir]) {
      fs.writeFileSync(path.join(targetDir, "ic_launcher.png"), sqBuf);
      fs.writeFileSync(path.join(targetDir, "ic_launcher_round.png"), rdBuf);
    }
    console.log(`mipmap-${name}: foreground + tightened ic_launcher (${legacySize}x${legacySize})`);
  }

  // 4. Render small-size high-contrast compact desktop frames (16, 24, 32, plus 30 & 44 Windows tiles)
  //    and full-detail desktop frames (48, 64, 128, 256), then assemble 7-frame PNG-in-ICO
  const icoSizes = [16, 24, 32, 48, 64, 128, 256];
  const icoFrames = [];
  const frameMap = new Map();

  for (const sz of icoSizes) {
    const markup =
      sz <= 32 ? buildCompactSmallDesktopSvg(sz) : buildSizedFullDesktopSvg(desktopIconSvg, sz);
    const png = await renderSvgBuffer(page, markup, sz);
    icoFrames.push({ size: sz, png });
    frameMap.set(sz, png);
  }

  // Write sharp standalone PNGs in src-tauri/icons/
  fs.writeFileSync(path.resolve(root, "src-tauri/icons/32x32.png"), frameMap.get(32));
  fs.writeFileSync(path.resolve(root, "src-tauri/icons/64x64.png"), frameMap.get(64));
  fs.writeFileSync(path.resolve(root, "src-tauri/icons/128x128.png"), frameMap.get(128));
  fs.writeFileSync(path.resolve(root, "src-tauri/icons/128x128@2x.png"), frameMap.get(256));

  // Crisp small Windows tiles
  const sq30 = await renderSvgBuffer(page, buildCompactSmallDesktopSvg(30), 30);
  const sq44 = await renderSvgBuffer(page, buildSizedFullDesktopSvg(desktopIconSvg, 44), 44);
  fs.writeFileSync(path.resolve(root, "src-tauri/icons/Square30x30Logo.png"), sq30);
  fs.writeFileSync(path.resolve(root, "src-tauri/icons/Square44x44Logo.png"), sq44);

  // Assemble multi-frame PNG-in-ICO (16, 24, 32 compact; 48, 64, 128, 256 full)
  const icoBuffer = buildPngIco(icoFrames);
  fs.writeFileSync(path.resolve(root, "src-tauri/icons/icon.ico"), icoBuffer);
  console.log(`src-tauri/icons/icon.ico (${icoFrames.map((f) => `${f.size}x${f.size}`).join(", ")}; ${icoBuffer.length} bytes)`);
} finally {
  await browser.close();
}
