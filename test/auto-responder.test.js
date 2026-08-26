"use strict";

const assert = require("node:assert/strict");
const AutoResponder = require("../protocol/auto-responder.js");
const M = require("../protocol/mansion-controller.js");
const E = require("../protocol/elevator.js");
const Telegram4 = require("../protocol/locker4.js");

let passed = 0;
let failed = 0;

function test(name, callback) {
  try {
    callback();
    console.log("  OK   " + name);
    passed += 1;
  } catch (error) {
    console.error("  NG   " + name);
    console.error(error.stack || error);
    failed += 1;
  }
}

console.log("=== auto responder ===");

test("MCヘルスチェック要求へ応答コマンドを返す", () => {
  const request = M.buildHealthCheckRequest({ version: 3, from: M.ROLE.MC });
  const result = AutoResponder.mansionResponse(request, { version: 3, role: M.ROLE.IC });
  assert.equal(result.type, "frame");
  assert.equal(result.definition.kind, 0x3A);
  assert.equal(result.definition.command, 0x61);
  const parsed = M.parseFrame(result.frame, { version: 3, from: M.ROLE.IC });
  assert.equal(parsed.messageText, "");
});

test("応答が完了電文しかない初期化要求にも応答する", () => {
  const request = M.buildInitializationRequest({ version: 3, deliveryNotification: true });
  const result = AutoResponder.mansionResponse(request, { version: 3, role: M.ROLE.MC });
  assert.equal(result.type, "frame");
  assert.equal(result.definition.name, "初期化完了");
  assert.equal(result.definition.command, 0x42);
});

test("VIXUS Advanceで許可された静止画要求だけに応答する", () => {
  const request = M.buildFrame({
    kind: M.KIND.STILL_IMAGE,
    command: 0x45,
    version: 3,
    from: M.ROLE.MC,
    product: M.PRODUCT.VIXUS_ADVANCE,
  });
  const result = AutoResponder.mansionResponse(request, {
    version: 3,
    role: M.ROLE.IC,
    product: M.PRODUCT.VIXUS_ADVANCE,
  });
  assert.equal(result.definition.command, 0x65);
  assert.equal(M.parseFrame(result.frame, {
    version: 3,
    from: M.ROLE.IC,
    product: M.PRODUCT.VIXUS_ADVANCE,
  }).command, 0x65);
});

// 一括応答の中身は持てないが、該当住戸が無い場合は完了パケットを即送信する規定がある。
test("一括応答が必要な要求へ完了パケットのみを返す", () => {
  // 34/44 全防犯情報要求 → 34/65 全防犯情報完了（警戒設定住戸なし）
  const request = M.buildFrame({ kind: 0x34, command: 0x44, version: 3, from: M.ROLE.MC, message: [] });
  const result = AutoResponder.mansionResponse(request, { version: 3, role: M.ROLE.IC });
  assert.equal(result.type, "frame");
  assert.equal(result.definition.name, "全防犯情報完了");
  assert.equal(result.completionOnly, true);
});

test("完了パケットにはADDRも自動応答MESGも付けない", () => {
  const request = M.buildFrame({ kind: 0x35, command: 0x46, version: 3, from: M.ROLE.MC, message: [] });
  const result = AutoResponder.mansionResponse(request, { version: 3, role: M.ROLE.IC, message: "0" });
  assert.equal(result.definition.name, "全警報情報完了");
  // STX + LEN2 + KIND + CMD + ETX + BCC の7バイトで、MESGは空
  assert.equal(result.frame.length, 7);
  assert.equal(result.address, "");
});

test("全メッセージ再送要求へ全メッセージ報告完了を返す", () => {
  const request = M.buildFrame({ kind: 0x38, command: 0x44, version: 3, from: M.ROLE.MC, message: [] });
  const result = AutoResponder.mansionResponse(request, { version: 3, role: M.ROLE.IC });
  assert.equal(result.definition.name, "全メッセージ報告完了");
  assert.equal(result.completionOnly, true);
});

test("応答コマンドが台帳にある要求は従来どおり応答電文を返す", () => {
  // 32/41 住戸全情報要求 → 32/61 住戸全情報応答（bulkではないので完了に流さない）
  const address = M.buildResidenceAddress({ version: 3, topology: M.TOPOLOGY.STANDARD, building: "BB", room: 101 });
  const request = M.buildFrame({
    kind: 0x32, command: 0x41, version: 3, from: M.ROLE.MC,
    message: Array.from(address, (character) => character.charCodeAt(0)),
  });
  const result = AutoResponder.mansionResponse(request, { version: 3, topology: M.TOPOLOGY.STANDARD, role: M.ROLE.IC });
  assert.equal(result.definition.name, "住戸全情報応答");
  assert.equal(result.completionOnly, false);
  assert.equal(result.address, address);
});

test("要求ではない通知電文には応答しない", () => {
  const notification = M.buildFrame({ kind: 0x34, command: 0x41, version: 3, from: M.ROLE.IC, message: [] });
  assert.equal(AutoResponder.mansionResponse(notification, { version: 3, role: M.ROLE.MC }), null);
});

test("受信MESGの先頭がADDRなら応答へ引き継ぐ", () => {
  const address = M.buildResidenceAddress({ version: 3, topology: M.TOPOLOGY.STANDARD, building: "BB", room: 101 });
  const request = M.buildFrame({
    kind: 0x34,
    command: 0x42,
    version: 3,
    from: M.ROLE.MC,
    message: Array.from(address, (character) => character.charCodeAt(0)),
  });
  const result = AutoResponder.mansionResponse(request, { version: 3, topology: M.TOPOLOGY.STANDARD, role: M.ROLE.IC });
  assert.equal(result.type, "frame");
  assert.equal(result.address, address);
  const parsed = M.parseFrame(result.frame, { version: 3, from: M.ROLE.IC });
  assert.equal(parsed.messageText, address);
});

test("ADDRとして成立しないMESGは引き継がない", () => {
  const request = M.buildFrame({
    kind: 0x34,
    command: 0x42,
    version: 3,
    from: M.ROLE.MC,
    message: Array.from("XXXXXX", (character) => character.charCodeAt(0)),
  });
  const result = AutoResponder.mansionResponse(request, { version: 3, role: M.ROLE.IC });
  assert.equal(result.address, "");
  assert.equal(M.parseFrame(result.frame, { version: 3, from: M.ROLE.IC }).messageText, "");
});

test("自局から送信できない応答は生成しない", () => {
  // 32/41 住戸全情報要求はMC→IC、応答32/61はIC→MC。IC役で受けた場合のみ応答できる。
  const request = M.buildFrame({ kind: 0x32, command: 0x41, version: 3, from: M.ROLE.MC, message: [] });
  assert.equal(AutoResponder.mansionResponse(request, { version: 3, role: M.ROLE.IC }).type, "frame");
  assert.throws(() => AutoResponder.mansionResponse(request, { version: 3, role: M.ROLE.MC }), /送信することはできません/);
});

test("応答MESGの指定値はADDRの後ろへ付く", () => {
  const address = M.buildResidenceAddress({ version: 3, topology: M.TOPOLOGY.STANDARD, building: "BB", room: 101 });
  const request = M.buildFrame({
    kind: 0x34,
    command: 0x42,
    version: 3,
    from: M.ROLE.MC,
    message: Array.from(address, (character) => character.charCodeAt(0)),
  });
  const result = AutoResponder.mansionResponse(request, { version: 3, topology: M.TOPOLOGY.STANDARD, role: M.ROLE.IC, message: "01" });
  assert.equal(M.parseFrame(result.frame, { version: 3, from: M.ROLE.IC }).messageText, address + "01");
});

test("エレベータコールへ動作中情報を同じルーム番号で返す", () => {
  const call = E.buildFrame({ command: "ECALL", direction: E.DIRECTION.TO_ELEVATOR, room: { buildingNo: 0, roomNo: 101 } });
  const result = AutoResponder.elevatorResponse(call, { moving: true });
  assert.equal(result.command, "ESTAT");
  const parsed = E.parseFrame(result.frame, { direction: E.DIRECTION.FROM_ELEVATOR });
  assert.equal(parsed.command, "ESTAT");
  assert.equal(parsed.room.raw, "00B101");
  assert.equal(parsed.gate.raw, "0000");
});

test("停止中を選ぶとESTOPを返す", () => {
  const call = E.buildFrame({ command: "ECALL", direction: E.DIRECTION.TO_ELEVATOR, room: { buildingNo: 2, roomNo: 1505 } });
  const result = AutoResponder.elevatorResponse(call, { moving: false });
  assert.equal(result.command, "ESTOP");
  assert.equal(E.parseFrame(result.frame, { direction: E.DIRECTION.FROM_ELEVATOR }).room.raw, "021505");
});

test("エレベータコール以外は片方向通知として応答しない", () => {
  const notice = E.buildFrame({
    command: "HINFO",
    direction: E.DIRECTION.TO_ELEVATOR,
    gate: { buildingNo: 0, id: 3 },
    room: { buildingNo: 0, roomNo: 101 },
  });
  assert.equal(AutoResponder.elevatorResponse(notice, {}), null);
});

test("宅配4線式の情報要求へ応答パケットを組む", () => {
  const request = Telegram4.buildRequestTelegram({ modelNo: 1 });
  const result = AutoResponder.locker4Response(request, {
    lockers: [{ state: 0x31, lockerNo: 1, buildingNo: 0, roomNo: 101 }],
    packetSize: 10,
  });
  assert.equal(result.type, "frames");
  assert.equal(result.frames.length, 1);
  const parsed = Telegram4.parseTelegram(result.frames[0]);
  assert.equal(parsed.type, "response");
  assert.equal(parsed.modelNo, 1);
  assert.equal(parsed.lockers.length, 1);
});

test("宅配4線式は要求の機種NOを引き継ぐ", () => {
  const request = Telegram4.buildRequestTelegram({ modelNo: 7 });
  const result = AutoResponder.locker4Response(request, {
    lockers: [{ state: 0x30, lockerNo: 2, buildingNo: 0, roomNo: 102 }],
  });
  assert.equal(Telegram4.parseTelegram(result.frames[0]).modelNo, 7);
});

test("機種NO空白の要求は応答を生成できない", () => {
  const request = Telegram4.buildRequestTelegram({});
  const result = AutoResponder.locker4Response(request, {
    lockers: [{ state: 0x30, lockerNo: 1, buildingNo: 0, roomNo: 101 }],
  });
  assert.equal(result.type, "unsupported");
  assert.match(result.reason, /機種NO/);
});

test("ロッカーデータ未設定は応答を生成できない", () => {
  const request = Telegram4.buildRequestTelegram({ modelNo: 1 });
  const result = AutoResponder.locker4Response(request, { lockers: [] });
  assert.equal(result.type, "unsupported");
});

test("宅配4線式の情報応答には応答しない", () => {
  const response = Telegram4.buildResponseTelegram({
    packageNo: 0,
    modelNo: 1,
    lockers: [{ state: 0x31, lockerNo: 1, buildingNo: 0, roomNo: 101 }],
  });
  assert.equal(AutoResponder.locker4Response(response, { lockers: [] }), null);
});

console.log("\n========================================");
console.log(`  結果: ${passed} 件成功 / ${failed} 件失敗`);
console.log("========================================");
if (failed) process.exitCode = 1;
