// 宅配4線式 電文ビルダーの検証（仕様書 Q48-005F Ver.1.24 の値と照合）
const T = require("../protocol/locker4.js");

let pass = 0, fail = 0;
function check(name, actual, expected) {
  const a = Array.isArray(actual) ? T.toHex(actual) : String(actual);
  const e = Array.isArray(expected) ? T.toHex(expected) : String(expected);
  if (a === e) { console.log("  OK   " + name); pass++; }
  else { console.log("  NG   " + name + "\n        期待: " + e + "\n        実際: " + a); fail++; }
}

console.log("=== ascii ヘルパ ===");
check("ascii(1,3) = '001'", T.ascii(1, 3), [0x30, 0x30, 0x31]);
check("ascii(101,4) = '0101'", T.ascii(101, 4), [0x30, 0x31, 0x30, 0x31]);
check("ascii(0,2) = '00'", T.ascii(0, 2), [0x30, 0x30]);

console.log("\n=== ロッカー情報要求データ (4.3.4-5①) ===");
check("要求データ = 32 20 30 20×7", T.buildRequestLockerData(),
  [0x32, 0x20, 0x30, 0x20, 0x20, 0x20, 0x20, 0x20, 0x20, 0x20]);

console.log("\n=== 例: 荷物あり・ロッカー001・棟0・住戸0101 ===");
const tg = T.buildTextTelegram({ lockers: [{ state: T.STATE.PARCEL, lockerNo: 1, buildingNo: 0, roomNo: 101 }] });
console.log("  生成電文: " + T.toHex(tg));
const expNoBcc = [0x02, 0x37, 0x38, 0x30, 0x31, 0x35, 0x30, 0x30, 0x30, 0x30, 0x31, 0x31, 0x20, 0x30, 0x30, 0x31, 0x30, 0x30, 0x31, 0x30, 0x31, 0x03];
check("電文(BCC除く)が仕様例と一致", tg.slice(0, -1), expNoBcc);
check("BCCが自己整合 (末尾 == calcBCC)", [tg[tg.length - 1]], [T.calcBCC(tg.slice(0, -1))]);
console.log("  → BCC = 0x" + tg[tg.length - 1].toString(16).toUpperCase());

console.log("\n=== データ長 (4.3.4-2) ===");
const mk = n => T.buildTextTelegram({ lockers: Array.from({ length: n }, () => ({ state: T.STATE.EMPTY, lockerNo: 1, buildingNo: 0, roomNo: 1 })) });
check("1ロッカー → '015'", tg.slice(3, 6), [0x30, 0x31, 0x35]);
check("3ロッカー → '035'", mk(3).slice(3, 6), [0x30, 0x33, 0x35]);
check("10ロッカー → '105'", mk(10).slice(3, 6), [0x31, 0x30, 0x35]);

console.log("\n=== 状態コード (DATA1) ===");
check("荷物なし=30H", [T.STATE.EMPTY], [0x30]);
check("荷物あり=31H", [T.STATE.PARCEL], [0x31]);
check("書留着荷=35H", [T.STATE.REGISTERED], [0x35]);
check("宅配ロボ到着=42H", [T.STATE.ROBO_ARRIVE], [0x42]);

console.log("\n=== 装置ID (4.3.3) ===");
check("宅配ボックス=37H", [T.ID.LOCKER], [0x37]);
check("システム=38H", [T.ID.SYSTEM], [0x38]);

console.log("\n========================================");
console.log(`  結果: ${pass} 件成功 / ${fail} 件失敗`);
console.log("========================================");
process.exit(fail ? 1 : 0);
