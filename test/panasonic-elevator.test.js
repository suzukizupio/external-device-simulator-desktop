"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const E = require("../protocol/panasonic-elevator.js");
const FrameReader = require("../protocol/frame-reader.js");

let passed = 0;
function test(name, body) {
  try {
    body();
    passed += 1;
    console.log("  OK  " + name);
  } catch (error) {
    console.error("  NG  " + name);
    throw error;
  }
}

const ascii = (bytes) => E.toAscii(bytes);

console.log("=== パナソニック エレベータ連動プロトコル ===");

test("UMDがブラウザ相当のコンテキストでPanasonicElevatorを公開する", function () {
  const source = fs.readFileSync(path.join(__dirname, "../protocol/panasonic-elevator.js"), "utf8");
  const context = {};
  vm.runInNewContext(source, context);
  assert.equal(typeof context.PanasonicElevator.buildFrame, "function");
});

test("制御コードと固定値が仕様どおり", function () {
  assert.equal(E.CODE.STX, 0x02);
  assert.equal(E.CODE.ETX, 0x03);
  assert.equal(E.CODE.EOT, 0x04);
  assert.equal(E.CODE.ENQ, 0x05);
  assert.equal(E.CODE.SPACE, 0x20);
  // 正常応答は10Hと30Hの2種類。アイホンQ46-005Jの06Hとは違う。
  assert.deepEqual(E.ACK_CODES.slice(), [0x10, 0x30]);
  assert.equal(E.isAck(0x10), true);
  assert.equal(E.isAck(0x30), true);
  assert.equal(E.isAck(0x06), false);
  assert.equal(E.FRAME_LENGTH, 18);
  assert.equal(E.MODE, "N");
});

test("通信手順の規定値を持つ", function () {
  // ACK待ち1秒、リトライ2回（計3回）、ACK送出後5秒で相手の送信終了とみなす。
  assert.equal(E.TIMING.ackTimeoutMs, 1000);
  assert.equal(E.TIMING.sendAttempts, 3);
  assert.equal(E.TIMING.idleAfterAckMs, 5000);
  // ヘルスチェックは1分間隔、送信完了後1秒以内の応答で通信正常。
  assert.equal(E.TIMING.healthIntervalMs, 60_000);
  assert.equal(E.TIMING.healthResponseMs, 1000);
  // ENQ衝突時の再送待ちに差をつけ、再送時の衝突を避ける。
  assert.equal(E.TIMING.collisionBackoffMs[E.DIRECTION.TO_ELEVATOR], 2000);
  assert.equal(E.TIMING.collisionBackoffMs[E.DIRECTION.FROM_ELEVATOR], 1000);
});

test("コマンド表は5種類で、方向が決まっている", function () {
  assert.deepEqual(E.COMMAND_CODES.slice(), ["IE", "IK", "IH", "SB", "SH"]);
  assert.deepEqual(E.commands(E.DIRECTION.TO_ELEVATOR).map((entry) => entry.code), ["IE", "IK", "IH", "SB"]);
  assert.deepEqual(E.commands(E.DIRECTION.FROM_ELEVATOR).map((entry) => entry.code), ["SH"]);
  assert.equal(E.findCommand("ie").label, "住戸でのエレベータコール");
  assert.equal(E.findCommand("SH").label, "ヘルスチェック応答");
  assert.throws(() => E.findCommand("XX"), /未知のコマンド/);
  assert.throws(() => E.resolveDirection("both"), /toElevatorまたはfromElevator/);
});

test("付加コードの割付が仕様どおり", function () {
  // 共同玄関解錠は解錠の種類を付加コードで区別する。
  assert.deepEqual(E.findCommand("IK").extras.map((item) => item.code + " " + item.label), [
    "00 住戸による共同玄関解錠",
    "01 管理室による共同玄関解錠",
    "02 暗証番号による共同玄関解錠",
  ]);
  // ヘルスチェック応答は運行状態を返す。
  assert.deepEqual(E.findCommand("SH").extras.map((item) => item.code + " " + item.label), [
    "00 正常運行中",
    "01 点検中",
  ]);
  // 非接触キーID情報の付加コードは仕様書で■■（規定なし）。
  assert.equal(E.findCommand("SB").extras, null);
});

test("住戸を特定できるのは付加コード00の解錠だけ", function () {
  const byRoom = E.fieldUsage(E.findCommand("IK"), "00");
  assert.deepEqual({ building: byRoom.building, room: byRoom.room, lb: byRoom.lb }, { building: true, room: true, lb: true });
  const byAdmin = E.fieldUsage(E.findCommand("IK"), "01");
  assert.deepEqual({ building: byAdmin.building, room: byAdmin.room, lb: byAdmin.lb }, { building: false, room: false, lb: true });
  const byPin = E.fieldUsage(E.findCommand("IK"), "02");
  assert.deepEqual({ building: byPin.building, room: byPin.room, lb: byPin.lb }, { building: false, room: false, lb: true });
  // ヘルスチェックは全桁が固定値。
  const health = E.fieldUsage(E.findCommand("IH"), "00");
  assert.deepEqual({ building: health.building, room: health.room, lb: health.lb }, { building: false, room: false, lb: false });
});

test("住戸でのエレベータコールを組み立てて読み戻せる", function () {
  const frame = E.buildFrame({ command: "IE", buildingNo: 1, roomNo: 101 });
  assert.equal(frame.length, E.FRAME_LENGTH);
  assert.equal(ascii(frame), "\x02IE N0101010000\x03E2");
  const parsed = E.parse(frame);
  assert.equal(parsed.command, "IE");
  assert.equal(parsed.commandLabel, "住戸でのエレベータコール");
  assert.equal(parsed.direction, E.DIRECTION.TO_ELEVATOR);
  assert.equal(parsed.mode, "N");
  assert.equal(parsed.buildingNo, 1);
  assert.equal(parsed.roomNo, 101);
  assert.equal(parsed.lbNo, 0);
  assert.equal(parsed.extraCode, "00");
});

test("BCCはCMDからETXまでの総和を16進2文字で表す", function () {
  const frame = E.buildFrame({ command: "IE", buildingNo: 1, roomNo: 101 });
  // 0x49+0x45+0x20+0x4E+"0101010000"+0x03 = 0x2E2 → 下位1byteは0xE2
  assert.deepEqual(E.calculateBCC(frame.slice(0, 16)), [0x45, 0x32]);
  assert.equal(E.verifyBCC(frame), true);
  const broken = frame.slice();
  broken[17] = broken[17] === 0x32 ? 0x33 : 0x32;
  assert.equal(E.verifyBCC(broken), false);
  assert.equal(E.validate(broken), false);
  assert.throws(() => E.parse(broken), /BCCが一致しません/);
  // 相手装置が小文字で送ってきても値として一致すれば受け付ける。
  const lower = frame.slice();
  lower[16] = "e".charCodeAt(0);
  assert.equal(E.verifyBCC(lower), true);
});

test("共同玄関解錠は付加コードで使える桁が変わる", function () {
  const byRoom = E.buildFrame({ command: "IK", buildingNo: 2, roomNo: 1201, lbNo: 3, extraCode: "00" });
  assert.equal(ascii(byRoom).slice(1, 15), "IK N0212010300");
  const byAdmin = E.buildFrame({ command: "IK", lbNo: 3, extraCode: "01" });
  assert.equal(ascii(byAdmin).slice(1, 15), "IK N0000000301");
  assert.equal(E.parse(byAdmin).extraLabel, "管理室による共同玄関解錠");
  // 管理室・暗証番号による解錠では住戸を指定できない。
  assert.throws(() => E.buildFrame({ command: "IK", buildingNo: 1, lbNo: 3, extraCode: "01" }),
    /管理室による共同玄関解錠の棟番号は00固定です/);
  assert.throws(() => E.buildFrame({ command: "IK", roomNo: 101, lbNo: 3, extraCode: "02" }),
    /暗証番号による共同玄関解錠の住戸番号は0000固定です/);
  // 受信側でも同じ検査を行う。
  const violation = byAdmin.slice();
  violation[10] = "1".charCodeAt(0);
  violation.splice(16, 2, ...E.calculateBCC(violation.slice(0, 16)));
  assert.throws(() => E.parse(violation), /住戸番号は0000固定です/);
});

test("ヘルスチェックと応答", function () {
  const request = E.healthRequest();
  assert.equal(ascii(request).slice(1, 15), "IH N0000000000");
  // 全桁が固定値のため、値を載せようとすると弾く。
  assert.throws(() => E.buildFrame({ command: "IH", lbNo: 1 }), /ヘルスチェックのLB番号は00固定です/);

  const normal = E.healthResponse(request, {});
  assert.equal(E.parse(normal).extraLabel, "正常運行中");
  const inspection = E.healthResponse(request, { inspection: true });
  assert.equal(E.parse(inspection).extraLabel, "点検中");
  assert.equal(E.parse(inspection).direction, E.DIRECTION.FROM_ELEVATOR);
  // ヘルスチェック以外へは応答を作らない。
  assert.equal(E.healthResponse(E.buildFrame({ command: "IE", buildingNo: 1, roomNo: 101 }), {}), null);
});

test("非接触キーID情報は付加コードを2桁で自由に指定できる", function () {
  const frame = E.buildFrame({ command: "SB", buildingNo: 1, roomNo: 101, lbNo: 2, extraCode: "07" });
  assert.equal(ascii(frame).slice(1, 15), "SB N0101010207");
  assert.equal(E.parse(frame).extraCode, "07");
  assert.equal(E.parse(frame).extraLabel, null);
  assert.throws(() => E.buildFrame({ command: "SB", extraCode: "AB" }), /2桁の数字/);
  // 規定のあるコマンドでは台帳にない付加コードを拒否する。
  assert.throws(() => E.buildFrame({ command: "SH", extraCode: "09" }), /SHの付加コードは00／01のいずれかです/);
});

test("方向と固定バイトを厳格に検証する", function () {
  const response = E.buildFrame({ command: "SH" });
  assert.equal(E.validate(response, { direction: E.DIRECTION.FROM_ELEVATOR }), true);
  assert.throws(() => E.parse(response, { direction: E.DIRECTION.TO_ELEVATOR }), /SHはエレベータ→IFUの電文です/);

  const frame = E.buildFrame({ command: "IE", buildingNo: 1, roomNo: 101 });
  assert.throws(() => E.parse(frame.slice(0, 17)), /18byteちょうど/);
  const badStx = frame.slice(); badStx[0] = 0x01;
  assert.throws(() => E.parse(badStx), /STXが02Hではありません/);
  const badEtx = frame.slice(); badEtx[15] = 0x04;
  assert.throws(() => E.parse(badEtx), /ETXが03Hではありません/);
  const badSpare = frame.slice();
  badSpare[3] = 0x30;
  badSpare.splice(16, 2, ...E.calculateBCC(badSpare.slice(0, 16)));
  assert.throws(() => E.parse(badSpare), /予備が20H（スペース）ではありません/);
  const badMode = frame.slice();
  badMode[4] = "F".charCodeAt(0);
  badMode.splice(16, 2, ...E.calculateBCC(badMode.slice(0, 16)));
  assert.throws(() => E.parse(badMode), /モードがNではありません/);
  const badDigits = frame.slice();
  badDigits[7] = "A".charCodeAt(0);
  badDigits.splice(16, 2, ...E.calculateBCC(badDigits.slice(0, 16)));
  assert.throws(() => E.parse(badDigits), /住戸番号が4桁の数字ではありません/);
});

test("FrameReaderが18byte固定で切り出し、10H／30Hを制御コードとして扱う", function () {
  const reader = new FrameReader("panasonicElevator");
  const frame = E.buildFrame({ command: "IE", buildingNo: 1, roomNo: 101 });
  // ENQ → 電文 → ACK(10H) → ACK(30H) → EOT
  const events = reader.push([E.CODE.ENQ].concat(frame, [0x10, 0x30, E.CODE.EOT]));
  assert.deepEqual(events.map((event) => event.type), ["control", "frame", "control", "control", "control"]);
  assert.deepEqual(events[0].code, E.CODE.ENQ);
  assert.deepEqual(events[1].bytes, frame);
  assert.deepEqual(events.slice(2).map((event) => event.code), [0x10, 0x30, E.CODE.EOT]);

  // 電文の中の'0'(30H)はデータであり、制御コードとして拾わない。
  assert.equal(frame.filter((byte) => byte === 0x30).length > 0, true);

  // 1バイトずつ届いても同じ結果になる。
  const drip = new FrameReader("panasonicElevator");
  const dripped = [];
  for (const byte of [E.CODE.ENQ].concat(frame, [0x10, E.CODE.EOT])) dripped.push(...drip.push([byte]));
  assert.deepEqual(dripped.map((event) => event.type), ["control", "frame", "control", "control"]);
  assert.ok(FrameReader.PROFILES.includes("panasonicElevator"));
});

console.log("=== " + passed + " panasonic elevator tests passed ===");
