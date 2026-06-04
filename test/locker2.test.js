// 宅配2線式 電文ビルダーの検証（仕様書 Q55-001D V1.24 の値と照合）
const T = require("../protocol/locker2.js");

let pass = 0, fail = 0;
function check(name, a, e) {
  const A = Array.isArray(a) ? T.toHex(a) : String(a);
  const E = Array.isArray(e) ? T.toHex(e) : String(e);
  if (A === E) { console.log("  OK   " + name); pass++; }
  else { console.log("  NG   " + name + "\n        期待: " + E + "\n        実際: " + A); fail++; }
}

console.log("=== 住戸番号 (注1: 4桁右詰め, 空き桁=3FH) ===");
check("101号室 → 3F 31 30 31", T.room4(101), [0x3F, 0x31, 0x30, 0x31]);
check("1108号室 → 31 31 30 38", T.room4(1108), [0x31, 0x31, 0x30, 0x38]);

console.log("\n=== 住戸アドレス (注2: 3桁, 頭0埋め) ===");
check("アドレス1 → 30 30 31", T.addr3(1), [0x30, 0x30, 0x31]);
check("アドレス25 → 30 32 35", T.addr3(25), [0x30, 0x32, 0x35]);

console.log("\n=== 棟No (1-8→31-38, 0/なし→3F) ===");
check("1棟 → 31", [T.buildingByte(1)], [0x31]);
check("8棟 → 38", [T.buildingByte(8)], [0x38]);
check("0(なし) → 3F", [T.buildingByte(0)], [0x3F]);

console.log("\n=== コマンド (4.3.3) ===");
check("着荷=11H", [T.CMD.ARRIVE], [0x11]);
check("滞留=12H", [T.CMD.STAY], [0x12]);
check("取出=13H", [T.CMD.PICKUP], [0x13]);

console.log("\n=== 電文(11バイト固定) 例: 着荷・101号室・1棟・アドレス1 ===");
const tg = T.buildTelegram({ command: T.CMD.ARRIVE, roomNo: 101, buildingNo: 1, address: 1 });
console.log("  生成電文: " + T.toHex(tg));
check("11バイト固定", [tg.length], [11]);
// STX 02 | CMD 11 | 住戸101=3F 31 30 31 | 棟1=31 | アドレス1=30 30 31 | ETX 03
check("電文一致", tg, [0x02, 0x11, 0x3F, 0x31, 0x30, 0x31, 0x31, 0x30, 0x30, 0x31, 0x03]);

console.log("\n=== 棟なし・1108号室・取出・アドレス800 ===");
const tg2 = T.buildTelegram({ command: T.CMD.PICKUP, roomNo: 1108, buildingNo: 0, address: 800 });
console.log("  生成電文: " + T.toHex(tg2));
check("電文一致", tg2, [0x02, 0x13, 0x31, 0x31, 0x30, 0x38, 0x3F, 0x38, 0x30, 0x30, 0x03]);

console.log("\n========================================");
console.log(`  結果: ${pass} 件成功 / ${fail} 件失敗`);
console.log("========================================");
process.exit(fail ? 1 : 0);
