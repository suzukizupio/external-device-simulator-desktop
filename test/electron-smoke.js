"use strict";

const path = require("path");
const { spawn } = require("child_process");
const electronPath = require("electron");

const root = path.resolve(__dirname, "..");
const childEnvironment = { ...process.env, EXTERNAL_SIMULATOR_SMOKE_TEST: "1" };
delete childEnvironment.ELECTRON_RUN_AS_NODE;
const child = spawn(electronPath, [root], {
  cwd: root,
  env: childEnvironment,
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});

let output = "";
child.stdout.on("data", (chunk) => { output += chunk.toString(); });
child.stderr.on("data", (chunk) => { output += chunk.toString(); });

const timer = setTimeout(() => {
  child.kill();
  console.error(`electron-smoke: 30秒以内に完了しませんでした\n${output}`);
  process.exitCode = 1;
}, 30_000);

child.on("error", (error) => {
  clearTimeout(timer);
  console.error(`electron-smoke: Electronを起動できません: ${error.message}`);
  process.exitCode = 1;
});

child.on("exit", (code) => {
  clearTimeout(timer);
  if (code !== 0 || !output.includes("electron-smoke: OK")) {
    console.error(`electron-smoke: 失敗 (exit=${code})\n${output}`);
    process.exitCode = 1;
    return;
  }
  const marker = output.split(/\r?\n/).find((line) => line.includes("electron-smoke: OK"));
  console.log(marker.trim());
});
