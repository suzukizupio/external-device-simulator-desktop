"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const directory = __dirname;
const files = fs.readdirSync(directory)
  .filter((file) => file.endsWith(".test.js"))
  .sort();

let failures = 0;
for (const file of files) {
  console.log(`\n>>> ${file}`);
  const result = spawnSync(process.execPath, [path.join(directory, file)], {
    cwd: path.resolve(directory, ".."),
    stdio: "inherit",
  });
  if (result.status !== 0) failures += 1;
}

if (failures > 0) {
  console.error(`\n${failures}個のテストファイルが失敗しました。`);
  process.exitCode = 1;
} else {
  console.log(`\n全${files.length}テストファイルが成功しました。`);
}
