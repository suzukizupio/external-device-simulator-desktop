"use strict";

// build/icon.ico が「実際に絵が入っているか」を検証する。
//
// 背景: 以前 ImageMagick で icon.svg を直接ラスタライズしていたため、
// stroke="url(#accent)" のグラデーションストローク（枠線・コーナー飾り・
// シェブロン等）が黙って捨てられ、ほぼ真っ黒な角丸四角形だけのICOが
// コミットされていた。ファイルとしては正常なので気付きにくい。
// ここではICOを自前でデコードし、明るいアクセント色の画素が十分にあるかを
// 画素レベルで確認する。外部コマンドには依存しない。

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const ICO = path.join(__dirname, "..", "build", "icon.ico");
const REQUIRED_SIZES = [256, 128, 64, 48, 32, 24, 16];

function parseIco(buffer) {
  assert.strictEqual(buffer.readUInt16LE(0), 0, "ICOの予約領域が0ではありません");
  assert.strictEqual(buffer.readUInt16LE(2), 1, "ICOのタイプが1(アイコン)ではありません");
  const count = buffer.readUInt16LE(4);
  const entries = [];
  for (let index = 0; index < count; index += 1) {
    const base = 6 + index * 16;
    entries.push({
      width: buffer.readUInt8(base) || 256,
      height: buffer.readUInt8(base + 1) || 256,
      bpp: buffer.readUInt16LE(base + 6),
      size: buffer.readUInt32LE(base + 8),
      offset: buffer.readUInt32LE(base + 12),
    });
  }
  return entries;
}

// PNG(8bit RGBA, フィルタ0-4) を最小限デコードする。
function decodePng(buffer) {
  let offset = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  const chunks = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      colorType = data.readUInt8(9);
    } else if (type === "IDAT") {
      chunks.push(data);
    } else if (type === "IEND") {
      break;
    }
    offset += 12 + length;
  }
  assert.strictEqual(colorType, 6, "PNGがRGBAではありません");
  const raw = zlib.inflateSync(Buffer.concat(chunks));
  const stride = width * 4;
  const pixels = Buffer.alloc(stride * height);
  let previous = Buffer.alloc(stride);
  let position = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[position];
    position += 1;
    const line = Buffer.from(raw.subarray(position, position + stride));
    position += stride;
    for (let x = 0; x < stride; x += 1) {
      const left = x >= 4 ? line[x - 4] : 0;
      const up = previous[x];
      const upLeft = x >= 4 ? previous[x - 4] : 0;
      if (filter === 1) line[x] = (line[x] + left) & 0xff;
      else if (filter === 2) line[x] = (line[x] + up) & 0xff;
      else if (filter === 3) line[x] = (line[x] + ((left + up) >> 1)) & 0xff;
      else if (filter === 4) {
        const predictor = left + up - upLeft;
        const dl = Math.abs(predictor - left);
        const du = Math.abs(predictor - up);
        const dul = Math.abs(predictor - upLeft);
        line[x] = (line[x] + (dl <= du && dl <= dul ? left : du <= dul ? up : upLeft)) & 0xff;
      }
    }
    line.copy(pixels, y * stride);
    previous = line;
  }
  return { width, height, pixels };
}

// ICO内のBMP/DIBは下から上・BGRA順で格納される。
function decodeDib(buffer, width, height) {
  const headerSize = buffer.readUInt32LE(0);
  const bitCount = buffer.readUInt16LE(14);
  assert.strictEqual(bitCount, 32, `32bitではないDIBです (${bitCount}bit)`);
  const body = buffer.subarray(headerSize);
  const stride = width * 4;
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const source = (height - 1 - y) * stride;
    for (let x = 0; x < width; x += 1) {
      const from = source + x * 4;
      const to = y * stride + x * 4;
      pixels[to] = body[from + 2];
      pixels[to + 1] = body[from + 1];
      pixels[to + 2] = body[from];
      pixels[to + 3] = body[from + 3];
    }
  }
  return { width, height, pixels };
}

function analyze({ width, height, pixels }) {
  let opaque = 0;
  let bright = 0;
  let saturated = 0;
  for (let index = 0; index < pixels.length; index += 4) {
    const [r, g, b, a] = [pixels[index], pixels[index + 1], pixels[index + 2], pixels[index + 3]];
    if (a <= 128) continue;
    opaque += 1;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    if ((r * 299 + g * 587 + b * 114) / 1000 >= 110) bright += 1;
    // アクセント色(シアン〜青紫)は彩度が高い。真っ黒な四角には存在しない。
    if (max >= 90 && max - min >= 45) saturated += 1;
  }
  const total = width * height;
  return {
    brightRatio: opaque ? bright / opaque : 0,
    saturatedRatio: opaque ? saturated / opaque : 0,
    opaqueRatio: total ? opaque / total : 0,
  };
}

const buffer = fs.readFileSync(ICO);
const entries = parseIco(buffer);

const sizes = entries.map((entry) => entry.width).sort((a, b) => b - a);
for (const required of REQUIRED_SIZES) {
  assert.ok(sizes.includes(required), `icon.ico に ${required}px が含まれていません (${sizes.join(", ")})`);
}

for (const entry of entries) {
  const blob = buffer.subarray(entry.offset, entry.offset + entry.size);
  const isPng = blob.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const image = isPng ? decodePng(blob) : decodeDib(blob, entry.width, entry.height);
  assert.strictEqual(image.width, entry.width, `${entry.width}px: 幅が一致しません`);
  const stats = analyze(image);
  const label = `${entry.width}px`;

  // 角丸タイルなので不透明画素は7割前後を占める。
  assert.ok(stats.opaqueRatio > 0.5, `${label}: 不透明画素が少なすぎます (${stats.opaqueRatio.toFixed(3)})`);

  // 壊れたICOはここで落ちる。実測: 壊れた版 bright=0.4% / 正常版 8%以上。
  assert.ok(
    stats.brightRatio >= 0.03,
    `${label}: 明るい画素が不足しています (${(stats.brightRatio * 100).toFixed(1)}%)。`
    + " SVGのグラデーションストロークが落ちている可能性があります"
    + "（ImageMagickで直接SVGを変換していないか確認してください）",
  );
  assert.ok(
    stats.saturatedRatio >= 0.05,
    `${label}: アクセント色の画素が不足しています (${(stats.saturatedRatio * 100).toFixed(1)}%)`,
  );
}

console.log(`icon-asset: OK (${sizes.length}サイズ: ${sizes.join(", ")}px)`);
