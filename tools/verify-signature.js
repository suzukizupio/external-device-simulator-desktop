"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { version } = require("../package.json");

if (process.platform !== "win32") throw new Error("署名検証はWindowsで実行してください");

const artifact = path.resolve(__dirname, "..", "dist", `external-device-simulator-next-${version}-x64.exe`);
if (!fs.existsSync(artifact)) throw new Error(`配布ファイルがありません: ${artifact}`);

const script = [
  "$signature = Get-AuthenticodeSignature -LiteralPath $args[0]",
  "Write-Output $signature.Status",
  "if ($signature.SignerCertificate) { Write-Output $signature.SignerCertificate.Subject }",
].join("; ");
const output = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script, artifact], {
  encoding: "utf8",
}).trim();

if (!output.split(/\r?\n/).some((line) => line.trim() === "Valid")) {
  throw new Error(`Authenticode署名が有効ではありません: ${output || "結果なし"}`);
}
console.log(`signature: OK ${output.replace(/\r?\n/g, " / ")}`);
