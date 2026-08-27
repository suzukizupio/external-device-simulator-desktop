#!/usr/bin/env node
"use strict";

/**
 * build/icon.svg から build/icon.ico と build/icon.png を生成する。
 *
 * ラスタライズは Electron(Chromium) の canvas で行い、外部ツールには依存しない。
 * 以前は rsvg-convert + ImageMagick を使っていたが、Windows ではどちらも入らず、
 * さらに PATH 上の `convert` が ImageMagick ではなく Windows 標準の
 * convert.exe(FAT→NTFS変換) に当たるため、誤って実行する危険があった。
 *
 * SVGは出力サイズをルート要素の width/height に指定してから読み込ませる。
 * 512pxでラスタライズしてから縮小するのではなく、各サイズで直接ベクタから
 * 描かせるため、16pxでも輪郭が濁らない。
 *
 * 使い方: npm run icons  (= electron tools/build-icons.js)
 */

const { app, BrowserWindow } = require("electron");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const BUILD = path.join(ROOT, "build");
const SOURCE = path.join(BUILD, "icon.svg");
// 16/24pxでは細部が潰れるため、装飾を省いた簡略版を使う。
const SOURCE_SMALL = path.join(BUILD, "icon-small.svg");
const ICO_SIZES = [256, 128, 64, 48, 32, 24, 16];
const SMALL_THRESHOLD = 24;
const PNG_SIZE = 512;

// ルート<svg>の width/height だけを出力サイズへ差し替える（viewBoxは保つ）。
function withSize(svg, size) {
  return svg.replace(/<svg\b[^>]*>/, (tag) =>
    tag
      .replace(/\swidth="[^"]*"/, ` width="${size}"`)
      .replace(/\sheight="[^"]*"/, ` height="${size}"`));
}

async function rasterize(win, svg, size) {
  const source = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(withSize(svg, size))}`;
  const dataUrl = await win.webContents.executeJavaScript(`(async () => {
    const img = new Image();
    img.src = ${JSON.stringify(source)};
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = ${size};
    canvas.height = ${size};
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0, ${size}, ${size});
    return canvas.toDataURL("image/png");
  })()`);
  return Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64");
}

// ICOコンテナを組み立てる。Windows Vista以降はPNGをそのまま格納できる。
function buildIco(layers) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(layers.length, 4);

  let offset = header.length + 16 * layers.length;
  const entries = layers.map(({ size, data }) => {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size >= 256 ? 0 : size, 0); // 256は0で表す
    entry.writeUInt8(size >= 256 ? 0 : size, 1);
    entry.writeUInt8(0, 2); // パレット数（トゥルーカラーは0）
    entry.writeUInt8(0, 3); // reserved
    entry.writeUInt16LE(1, 4); // プレーン数
    entry.writeUInt16LE(32, 6); // ビット深度
    entry.writeUInt32LE(data.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += data.length;
    return entry;
  });

  return Buffer.concat([header, ...entries, ...layers.map((layer) => layer.data)]);
}

async function main() {
  if (!fs.existsSync(SOURCE)) throw new Error(`${SOURCE} がありません。`);
  const full = fs.readFileSync(SOURCE, "utf8");
  const hasSmall = fs.existsSync(SOURCE_SMALL);
  const small = hasSmall ? fs.readFileSync(SOURCE_SMALL, "utf8") : null;

  const win = new BrowserWindow({ show: false, width: 640, height: 640 });
  try {
    await win.loadURL("about:blank");

    // ICOは大きい順に並べる（Windowsは必要なサイズを自前で選ぶ）。
    const layers = [];
    for (const size of ICO_SIZES) {
      const svg = hasSmall && size <= SMALL_THRESHOLD ? small : full;
      layers.push({ size, data: await rasterize(win, svg, size) });
    }
    fs.writeFileSync(path.join(BUILD, "icon.ico"), buildIco(layers));

    // Linux/macOS 及び electron の BrowserWindow 用。
    fs.writeFileSync(path.join(BUILD, "icon.png"), await rasterize(win, full, PNG_SIZE));
  } finally {
    win.destroy();
  }

  console.log(`icon.ico: ${ICO_SIZES.join(", ")}px を生成しました`);
  if (hasSmall) console.log(`  (${SMALL_THRESHOLD}px以下は icon-small.svg を使用)`);
  console.log(`icon.png: ${PNG_SIZE}px を生成しました`);
}

app.disableHardwareAcceleration();
app.whenReady().then(main).then(
  () => app.exit(0),
  (error) => {
    console.error(`build-icons: ${error.message}`);
    app.exit(1);
  });
