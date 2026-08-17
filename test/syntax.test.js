"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const root = path.resolve(__dirname, "..");
const ignored = new Set(["node_modules", ".git", "dist", "release"]);

function collect(directory, result = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignored.has(entry.name)) continue;
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) collect(target, result);
    else if (entry.name.endsWith(".js")) result.push(target);
  }
  return result;
}

const files = collect(root);
const failures = [];
for (const file of files) {
  const checked = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (checked.status !== 0) failures.push(`${path.relative(root, file)}\n${checked.stderr}`);
}

assert.deepStrictEqual(failures, [], failures.join("\n"));
console.log(`syntax: OK (${files.length} JavaScript files)`);
