// 非接触キー 電文ビルダーの検証（仕様書 Q48-006F Ver1.15）
const T = require("../protocol/noncontact-key.js");

let pass = 0, fail = 0;
function check(name, actual, expected) {
  const a = Array.isArray(actual) ? T.toHex(actual) : String(actual);
  const e = Array.isArray(expected) ? T.toHex(expected) : String(expected);
  if (a === e) { console.log("  OK   " + name); pass++; }
  else { console.log("  NG   " + name + "\n        期待: " + e + "\n        実際: " + a); fail++; }
}

console.log("=== ASCII 数字ヘルパ ===");
check("ゲート1 → '01'", T.asciiDigits(1, 2), [0x30, 0x31]);
check("個人8 → '008'", T.asciiDigits(8, 3), [0x30, 0x30, 0x38]);
check("ルーム 棟0・101号室 → '00101'", T.room5({ buildingNo: 0, roomNo: 101 }), [0x30, 0x30, 0x31, 0x30, 0x31]);
check("ルーム文字列 1108 → '01108'", T.room5({ roomNo5: "1108" }), [0x30, 0x31, 0x31, 0x30, 0x38]);

console.log("\n=== 13バイト形式: ゲート+ルーム+個人番号 ===");
const withPerson = T.buildTelegram({ gateNo: 1, buildingNo: 0, roomNo: 101, personNo: 3 });
console.log("  生成電文: " + T.toHex(withPerson));
check("13バイト固定", [withPerson.length], [13]);
check("BCC除く電文", withPerson.slice(0, -1), [0x02, 0x30, 0x31, 0x30, 0x30, 0x31, 0x30, 0x31, 0x30, 0x30, 0x33, 0x03]);
check("BCC検証OK", T.verifyBCC(withPerson), true);
check("BCC = calcBCC", [withPerson[withPerson.length - 1]], [T.calcBCC(withPerson.slice(0, -1))]);

console.log("\n=== 10バイト形式: ゲート+ルーム ===");
const roomOnly = T.buildTelegram({ gateNo: 99, roomNo5: "90101", format: T.FORMAT.ROOM_ONLY });
console.log("  生成電文: " + T.toHex(roomOnly));
check("10バイト固定", [roomOnly.length], [10]);
check("BCC除く電文", roomOnly.slice(0, -1), [0x02, 0x39, 0x39, 0x39, 0x30, 0x31, 0x30, 0x31, 0x03]);
check("BCC検証OK", T.verifyBCC(roomOnly), true);

console.log("\n=== BCC異常系 ===");
check("BCC誤り注入で検証NG", T.verifyBCC(T.corruptBCC(withPerson)), false);

console.log("\n=== 制御コード ===");
check("STX=02H", [T.CODE.STX], [0x02]);
check("ETX=03H", [T.CODE.ETX], [0x03]);
check("ACK=06H", [T.CODE.ACK], [0x06]);
check("NAK=15H", [T.CODE.NAK], [0x15]);

console.log("\n========================================");
console.log(`  結果: ${pass} 件成功 / ${fail} 件失敗`);
console.log("========================================");
process.exit(fail ? 1 : 0);
