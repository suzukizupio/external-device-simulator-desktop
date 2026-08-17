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
const missing = Array.from(new Set(references.filter((id) => !unique.has(id))));
assert.deepStrictEqual(missing, [], `renderer.js references missing DOM IDs: ${missing.join(", ")}`);

const scripts = Array.from(html.matchAll(/<script\s+src="([^"]+)"/g), (match) => match[1]);
for (const source of scripts) assert.strictEqual(fs.existsSync(path.join(root, source)), true, `missing script: ${source}`);

for (const view of ["overview", "terminal", "locker4", "locker2", "key", "mansion", "elevator", "alarm", "faults", "settings"]) {
  assert.ok(unique.has(`view-${view}`), `missing view-${view}`);
  assert.ok(html.includes(`data-view="${view}"`), `missing navigation for ${view}`);
}

console.log(`dom-contract: OK (${ids.length} IDs, ${scripts.length} scripts)`);
