"use strict";
// 配布EXEがどの版なのかを実行中の画面から特定できるよう、ビルド時刻とコミットを
// build-stamp.json へ書き出す。electron-builder はこのファイルをasarへ同梱し、
// main.js が読み出して画面と通信ログへ表示する。
// 開発実行（npm start）では生成されないため、その場合は「開発実行」として扱う。

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const root = path.resolve(__dirname, "..");
const target = path.join(root, "build-stamp.json");
const { version } = require(path.join(root, "package.json"));

function git(args) {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch (_error) {
    return null;
  }
}

const commit = git(["rev-parse", "--short", "HEAD"]);
// 未コミットの変更を含むビルドは、それと分かるようにしておく。
const dirty = commit === null ? false : git(["status", "--porcelain"]) !== "";

const stamp = {
  version,
  builtAt: new Date().toISOString(),
  commit: commit === null ? null : commit + (dirty ? "+" : ""),
};

fs.writeFileSync(target, JSON.stringify(stamp, null, 2) + "\n", "utf8");
console.log(`build-stamp: ${stamp.version} / ${stamp.builtAt} / ${stamp.commit || "commit不明"}`);
