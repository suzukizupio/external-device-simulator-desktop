// 宅配2線式 電文ビルダーの検証（仕様書 Q55-001D V1.24 の値と照合）
const T = require("../protocol/locker2.js");

let pass = 0, fail = 0;
function check(name, a, e) {
  const A = Array.isArray(a) ? T.toHex(a) : String(a);
  const E = Array.isArray(e) ? T.toHex(e) : String(e);
  if (A === E) { console.log("  OK   " + name); pass++; }
  else { console.log("  NG   " + name + "\n        期待: " + E + "\n        実際: " + A); fail++; }
}
function checkThrows(name, fn, pattern) {
  try { fn(); console.log("  NG   " + name + "\n        例外が発生しませんでした"); fail++; }
  catch (err) {
    if (!pattern || pattern.test(String(err.message))) { console.log("  OK   " + name); pass++; }
    else { console.log("  NG   " + name + "\n        想定外の例外: " + err.message); fail++; }
  }
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
// STX 02 | CMD 11 | 棟1=31 | 住戸101=3F 31 30 31 | アドレス1=30 30 31 | ETX 03
check("仕様順（棟No→住戸番号→住戸アドレス）", tg,
  [0x02, 0x11, 0x31, 0x3F, 0x31, 0x30, 0x31, 0x30, 0x30, 0x31, 0x03]);

const parsed = T.parseTelegram(tg);
check("parse: コマンド", [parsed.command], [T.CMD.ARRIVE]);
check("parse: 棟No", [parsed.buildingNo], [1]);
check("parse: 住戸番号", parsed.roomNo, 101);
check("parse: 住戸アドレス", parsed.address, 1);

console.log("\n=== 棟なし・1108号室・取出・アドレス800 ===");
const tg2 = T.buildTelegram({ command: T.CMD.PICKUP, roomNo: 1108, buildingNo: 0, address: 800 });
console.log("  生成電文: " + T.toHex(tg2));
check("電文一致", tg2, [0x02, 0x13, 0x3F, 0x31, 0x31, 0x30, 0x38, 0x38, 0x30, 0x30, 0x03]);

console.log("\n=== 厳格な範囲・形式検証 ===");
checkThrows("未定義コマンドを拒否", () => T.buildTelegram({ command: 0x14, roomNo: 101, buildingNo: 1, address: 1 }), /コマンド/);
checkThrows("棟No 9を拒否", () => T.buildingByte(9), /棟No/);
checkThrows("住戸番号0を拒否", () => T.room4(0), /住戸番号/);
checkThrows("住戸番号10000を拒否", () => T.room4(10000), /住戸番号/);
checkThrows("住戸アドレス0を拒否", () => T.addr3(0), /住戸アドレス/);
checkThrows("住戸アドレス801を拒否", () => T.addr3(801), /住戸アドレス/);
checkThrows("不正STXを拒否", () => T.parseTelegram([0, ...tg.slice(1)]), /STX/);
checkThrows("不正ETXを拒否", () => T.parseTelegram([...tg.slice(0, 10), 0]), /ETX/);
checkThrows("不正長を拒否", () => T.parseTelegram(tg.slice(0, -1)), /11バイト/);

console.log("\n=== 登録リスト検証 ===");
const registrations = T.validateRegistrationList([
  { buildingNo: 1, roomNo: 101, address: 1, command: T.CMD.ARRIVE },
  { buildingNo: 2, roomNo: 101, address: 2 },
]);
check("異なる棟なら同じ住戸番号を許可", registrations.length, 2);
check("登録値を正規化", registrations[0].roomNo, 101);
checkThrows("住戸アドレス重複を拒否", () => T.validateRegistrationList([
  { buildingNo: 1, roomNo: 101, address: 1 }, { buildingNo: 1, roomNo: 102, address: 1 },
]), /重複/);
checkThrows("同一棟・住戸番号重複を拒否", () => T.validateRegistrationList([
  { buildingNo: 1, roomNo: 101, address: 1 }, { buildingNo: 1, roomNo: 101, address: 2 },
]), /重複/);
checkThrows("対象システムで禁止された棟を拒否", () => T.validateRegistrationList([
  { buildingNo: 2, roomNo: 101, address: 1 },
], { allowedBuildingNos: [0, 1] }), /使用できません/);
checkThrows("最大登録数を超えるリストを拒否", () => T.validateRegistrationList([
  { buildingNo: 1, roomNo: 101, address: 1 }, { buildingNo: 1, roomNo: 102, address: 2 },
], { maxEntries: 1 }), /1件以下/);

console.log("\n========================================");
console.log(`  結果: ${pass} 件成功 / ${fail} 件失敗`);
console.log("========================================");
process.exit(fail ? 1 : 0);
