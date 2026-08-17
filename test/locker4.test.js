// 宅配4線式 電文ビルダーの検証（仕様書 Q48-005F Ver.1.24 の値と照合）
const T = require("../protocol/locker4.js");
const H = require("../protocol/handshake.js");

let pass = 0, fail = 0;
function check(name, actual, expected) {
  const a = Array.isArray(actual) ? T.toHex(actual) : String(actual);
  const e = Array.isArray(expected) ? T.toHex(expected) : String(expected);
  if (a === e) { console.log("  OK   " + name); pass++; }
  else { console.log("  NG   " + name + "\n        期待: " + e + "\n        実際: " + a); fail++; }
}
function checkThrows(name, fn, pattern) {
  try { fn(); console.log("  NG   " + name + "\n        例外が発生しませんでした"); fail++; }
  catch (err) {
    if (!pattern || pattern.test(String(err.message))) { console.log("  OK   " + name); pass++; }
    else { console.log("  NG   " + name + "\n        想定外の例外: " + err.message); fail++; }
  }
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
check("仕様例のBCC固定値=19H", [tg[tg.length - 1]], [0x19]);
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

console.log("\n=== 情報要求 build/parse ===");
const request = T.buildRequestTelegram();
check("要求方向 38H→37H", request.slice(1, 3), [0x38, 0x37]);
check("要求データ長='015'", request.slice(3, 6), [0x30, 0x31, 0x35]);
check("要求パッケージNO='00'", request.slice(6, 8), [0x30, 0x30]);
check("全件要求の機種NO=20H×3", request.slice(8, 11), [0x20, 0x20, 0x20]);
check("要求固定データ", request.slice(11, 21), T.buildRequestLockerData());
const parsedRequest = T.parseTelegram(request);
check("parse要求 type", parsedRequest.type, "request");
check("parse要求 modelNo=null", parsedRequest.modelNo, null);
check("指定機種要求 modelNo=12", T.parseTelegram(T.buildRequestTelegram({ modelNo: 12 })).modelNo, 12);

console.log("\n=== 応答 parse/複数パケット ===");
const parsedResponse = T.parseTelegram(tg);
check("parse応答 type", parsedResponse.type, "response");
check("parse応答 ロッカー件数", parsedResponse.lockers.length, 1);
check("parse応答 ロッカーNO", parsedResponse.lockers[0].lockerNo, 1);
check("parse応答 棟NO", parsedResponse.lockers[0].buildingNo, 0);
check("parse応答 住戸NO", parsedResponse.lockers[0].roomNo, 101);

const manyLockers = Array.from({ length: 23 }, (_, i) => ({
  state: T.STATE.EMPTY, lockerNo: i + 1, buildingNo: 0, roomNo: i + 1,
}));
const packets = T.buildResponsePackets({ lockers: manyLockers, packetSize: 10, modelNo: 7 });
check("23件→3パケット", packets.length, 3);
check("packageNoが2,1,0と降順", packets.map(packet => T.parseTelegram(packet).packageNo), [2, 1, 0]);
check("各パケット件数10,10,3", packets.map(packet => T.parseTelegram(packet).lockers.length), [10, 10, 3]);
check("全パケットの機種NO=007", packets.map(packet => T.parseTelegram(packet).modelNo), [7, 7, 7]);

console.log("\n=== 厳格な形式検証 ===");
checkThrows("1パケット11件を拒否", () => T.buildTextTelegram({ lockers: manyLockers.slice(0, 11) }), /1～10件/);
checkThrows("空応答を拒否", () => T.buildTextTelegram({ lockers: [] }), /1～10件/);
checkThrows("未定義状態を拒否", () => T.buildLockerData({ state: 0x36, lockerNo: 1, buildingNo: 0, roomNo: 1 }), /未定義/);
checkThrows("ロッカーNO 1000を拒否", () => T.buildLockerData({ state: T.STATE.EMPTY, lockerNo: 1000, buildingNo: 0, roomNo: 1 }), /ロッカーNO/);
checkThrows("packetSize 11を拒否", () => T.buildResponsePackets({ lockers: manyLockers, packetSize: 11 }), /1パケット件数/);
const badBcc = tg.slice(); badBcc[badBcc.length - 1] ^= 0x01;
checkThrows("BCC不一致を拒否", () => T.parseTelegram(badBcc), /BCC/);
const badLength = tg.slice(); badLength[5] = 0x34; badLength[badLength.length - 1] = T.calcBCC(badLength.slice(0, -1));
checkThrows("宣言データ長不一致を拒否", () => T.parseTelegram(badLength), /データ長/);

console.log("\n=== ENQ→ACK→TEXT→ACK→EOT FSM ===");
const fsm = new H.SendHandshakeFSM({ packets: [packets[0], packets[1]] });
let events = fsm.start();
check("開始時ENQ", events[0].bytes, [H.CODE.ENQ]);
events = fsm.receiveControl(H.CODE.ACK);
check("リンクACK後に先頭TEXT", events[0].bytes, packets[0]);
events = fsm.receiveControl(H.CODE.ACK);
check("先頭TEXTのACK後に次のENQ", events[0].bytes, [H.CODE.ENQ]);
events = fsm.receiveControl(H.CODE.ACK);
check("次のリンクACK後に2番目TEXT", events[0].bytes, packets[1]);
events = fsm.receiveControl(H.CODE.ACK);
check("最終TEXTのACK後にEOT", events[0].bytes, [H.CODE.EOT]);
check("正常完了イベント", events[1].type, "complete");
check("正常完了状態", fsm.snapshot().state, H.STATE.COMPLETE);

console.log("\n=== FSM再送・先頭パケット復帰 ===");
const retryFsm = new H.SendHandshakeFSM({ packets: [packets[0], packets[1]], maxRetries: 5 });
retryFsm.start();
retryFsm.receiveControl(H.CODE.ACK); // TEXT 1
retryFsm.receiveControl(H.CODE.ACK); // ENQ 2
retryFsm.receiveControl(H.CODE.ACK); // TEXT 2
events = retryFsm.receiveControl(H.CODE.NAK);
check("2番目失敗を記録", events[0].failedPacketIndex, 1);
check("再送時は先頭へ戻る", events[0].restartPacketIndex, 0);
check("再送はENQから", events[1].bytes, [H.CODE.ENQ]);
events = retryFsm.receiveControl(H.CODE.ACK);
check("再リンク後は先頭TEXT", events[0].bytes, packets[0]);

const timeoutFsm = new H.SendHandshakeFSM({ packets: [packets[0]], maxRetries: 5 });
timeoutFsm.start();
for (let i = 1; i <= 5; i++) {
  events = timeoutFsm.timeout();
  check(`タイムアウト再送${i}回目`, events[1].bytes, [H.CODE.ENQ]);
}
events = timeoutFsm.timeout();
check("6回目の失敗で打ち切り", events[0].type, "failed");
check("失敗状態", timeoutFsm.snapshot().state, H.STATE.FAILED);

console.log("\n========================================");
console.log(`  結果: ${pass} 件成功 / ${fail} 件失敗`);
console.log("========================================");
process.exit(fail ? 1 : 0);
