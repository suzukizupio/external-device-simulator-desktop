#!/usr/bin/env node
"use strict";

/**
 * build/icon.svg から build/icon.ico と build/icon.png を生成する。
 *
 * 注意: ImageMagick(convert) で直接SVGを読ませてはいけない。
 * ImageMagick内蔵のSVGレンダラは stroke="url(#gradient)" を解釈できず、
 * グラデーション指定のストローク（枠線・コーナー飾り・シェブロン等）を
 * 黙って捨てるため、ほぼ真っ黒な四角形しか残らない。
 * ラスタライズは必ず rsvg-convert(librsvg) で行い、
 * ImageMagickはPNGの結合のみに使う。
 *
 * 依存: rsvg-convert (librsvg2-bin), convert (imagemagick)
 *
 * 使い方: node tools/build-icons.js
 */

const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

const ROOT = path.join(__dirname, "..");
const BUILD = path.join(ROOT, "build");
const SOURCE = path.join(BUILD, "icon.svg");
// 16/24pxでは細部が潰れるため、装飾を省いた簡略版を使う。
const SOURCE_SMALL = path.join(BUILD, "icon-small.svg");
const ICO_SIZES = [256, 128, 64, 48, 32, 24, 16];
const SMALL_THRESHOLD = 24;

function which(command) {
  try {
    execFileSync("sh", ["-c", `command -v ${command}`], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function requireTool(command, hint) {
  if (which(command)) return;
  throw new Error(`${command} が見つかりません。${hint}`);
}

function rasterize(source, size, output) {
  execFileSync("rsvg-convert", ["-w", String(size), "-h", String(size), source, "-o", output]);
}

function main() {
  requireTool("rsvg-convert", "sudo apt-get install -y librsvg2-bin を実行してください。");
  requireTool("convert", "sudo apt-get install -y imagemagick を実行してください。");
  if (!fs.existsSync(SOURCE)) throw new Error(`${SOURCE} がありません。`);

  const hasSmall = fs.existsSync(SOURCE_SMALL);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "icon-build-"));
  try {
    const layers = ICO_SIZES.map((size) => {
      const source = hasSmall && size <= SMALL_THRESHOLD ? SOURCE_SMALL : SOURCE;
      const output = path.join(work, `icon-${size}.png`);
      rasterize(source, size, output);
      return output;
    });

    // ICOは大きい順に並べる（Windowsは必要なサイズを自前で選ぶ）。
    execFileSync("convert", [...layers, path.join(BUILD, "icon.ico")]);
    // Linux/macOS 及び electron の BrowserWindow 用。
    rasterize(SOURCE, 512, path.join(BUILD, "icon.png"));

    console.log(`icon.ico: ${ICO_SIZES.join(", ")}px を生成しました`);
    if (hasSmall) console.log(`  (${SMALL_THRESHOLD}px以下は icon-small.svg を使用)`);
    console.log("icon.png: 512px を生成しました");
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

try {
  main();
} catch (error) {
  console.error(`build-icons: ${error.message}`);
  process.exit(1);
}
