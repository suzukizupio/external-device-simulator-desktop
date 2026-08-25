"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const renderer = fs.readFileSync(path.join(root, "renderer.js"), "utf8");

const ids = Array.from(html.matchAll(/\bid="([^"]+)"/g), (match) => match[1]);
const unique = new Set(ids);
assert.strictEqual(unique.size, ids.length, "index.html contains duplicate IDs");

const references = Array.from(renderer.matchAll(/\$\((?:"|'|`)([^"'`]+)(?:"|'|`)\)/g), (match) => match[1]);
// テンプレートで組み立てるIDはここでは判定できないため、下の受信モニタ検査で実IDを突き合わせる。
const staticReferences = references.filter((id) => !id.includes("${"));
const missing = Array.from(new Set(staticReferences.filter((id) => !unique.has(id))));
assert.deepStrictEqual(missing, [], `renderer.js references missing DOM IDs: ${missing.join(", ")}`);

// 受信モニタのIDは RECEIVE_MONITORS の接頭辞と接尾辞の組み合わせで動的に引かれる。
// 接頭辞・接尾辞をrenderer.jsから読み出し、実在するIDと総当たりで突き合わせる。
const monitorBlock = renderer.match(/const RECEIVE_MONITORS = Object\.freeze\(\{([\s\S]*?)\}\);/);
assert.ok(monitorBlock, "RECEIVE_MONITORS の定義を renderer.js から読み取れません");
const monitorPrefixes = Array.from(monitorBlock[1].matchAll(/prefix:\s*"([^"]+)"/g), (match) => match[1]);
assert.ok(monitorPrefixes.length >= 3, `受信モニタの定義が不足しています: ${monitorPrefixes.join(", ")}`);

const monitorSuffixes = new Set([
  ...Array.from(renderer.matchAll(/receiveElement\((?:view|"[^"]+")\s*,\s*"([^"]+)"\)/g), (match) => match[1]),
  ...Array.from(renderer.matchAll(/\$\(`\$\{config\.prefix\}([A-Za-z0-9]+)`\)/g), (match) => match[1]),
]);
assert.ok(monitorSuffixes.size >= 6, `受信モニタの参照項目が不足しています: ${Array.from(monitorSuffixes).join(", ")}`);

const monitorMissing = [];
for (const prefix of monitorPrefixes) {
  for (const suffix of monitorSuffixes) {
    // ロッカーデータ内訳は4線式だけが持つため、他機種では存在しないことを許容する。
    const optional = ["Lockers", "LockerCount"].includes(suffix) && prefix !== "locker4Rx";
    if (!unique.has(`${prefix}${suffix}`) && !optional) monitorMissing.push(`${prefix}${suffix}`);
  }
}
assert.deepStrictEqual(monitorMissing, [], `受信モニタのDOM IDが index.html にありません: ${monitorMissing.join(", ")}`);

const scripts = Array.from(html.matchAll(/<script\s+src="([^"]+)"/g), (match) => match[1]);
for (const source of scripts) assert.strictEqual(fs.existsSync(path.join(root, source)), true, `missing script: ${source}`);

for (const view of ["overview", "terminal", "locker4", "locker2", "key", "mansion", "elevator", "alarm", "panasonic", "faults", "settings"]) {
  assert.ok(unique.has(`view-${view}`), `missing view-${view}`);
  assert.ok(html.includes(`data-view="${view}"`), `missing navigation for ${view}`);
}

console.log(`dom-contract: OK (${ids.length} IDs, ${scripts.length} scripts)`);
