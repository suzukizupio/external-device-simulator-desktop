"use strict";

const assert = require("node:assert/strict");
const FrameReader = require("../protocol/frame-reader.js");
const M = require("../protocol/mansion-controller.js");
const Telegram2 = require("../protocol/locker2.js");
const Telegram4 = require("../protocol/locker4.js");
const NoncontactKey = require("../protocol/noncontact-key.js");
const Alarm = require("../protocol/alarm.js");
const Elevator = require("../protocol/elevator.js");

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

function collect(reader, chunks) {
  const events = [];
  for (const chunk of chunks) events.push(...reader.push(chunk));
  return events;
}

function frames(events) {
  return events.filter((event) => event.type === "frame").map((event) => event.bytes);
}

// あらゆる分割位置で同じフレームが復元されることを確かめる。
function everySplit(profile, stream, expectedFrames) {
  for (let cut = 0; cut <= stream.length; cut += 1) {
    const reader = new FrameReader(profile);
    const events = collect(reader, [stream.slice(0, cut), stream.slice(cut)]);
    assert.deepEqual(frames(events), expectedFrames, `分割位置 ${cut} で復元できません`);
  }
}

console.log("=== frame reader ===");

test("宅配2線式の11byte電文を切り出し、制御コードは分離する", () => {
  const frame = Telegram2.buildTelegram({ command: 0x11, buildingNo: 1, roomNo: 101, address: 1 });
  const reader = new FrameReader("locker2");
  const events = reader.push([0x06, ...frame, 0x04]);
  assert.deepEqual(events.map((event) => event.type), ["control", "frame", "control"]);
  assert.deepEqual(events[0].code, 0x06);
  assert.deepEqual(events[1].bytes, frame);
  assert.deepEqual(events[2].code, 0x04);
});

test("宅配2線式を全分割境界で復元", () => {
  const frame = Telegram2.buildTelegram({ command: 0x13, buildingNo: 0, roomNo: 9999, address: 800 });
  everySplit("locker2", [0x05, ...frame], [frame]);
});

test("非接触キーは10byteと13byteをETX位置から判定", () => {
  const short = NoncontactKey.buildTelegram({ format: NoncontactKey.FORMAT.ROOM_ONLY, gateNo: 1, roomNo5: "00101" });
  const long = NoncontactKey.buildTelegram({ format: NoncontactKey.FORMAT.WITH_PERSON, gateNo: 99, roomNo5: "99999", personNo: 999 });
  assert.equal(short.length, 10);
  assert.equal(long.length, 13);
  const reader = new FrameReader("key");
  assert.deepEqual(frames(reader.push([...short, ...long])), [short, long]);
});

test("エレベータはBCCが02Hでも最終バイトで再同期しない", () => {
  // BCCがSTXと同値になる電文を探し、その1件で最終バイトの扱いを検証する。
  let target = null;
  for (let room = 1; room <= 9999 && !target; room += 1) {
    const frame = Elevator.buildFrame({
      command: "ECALL",
      direction: Elevator.DIRECTION.TO_ELEVATOR,
      gate: { buildingNo: 0, id: 0 },
      room: { buildingNo: 0, roomNo: room },
      person: "000",
    });
    if (frame[frame.length - 1] === 0x02) target = frame;
  }
  assert.ok(target, "BCCが02Hになる電文が見つかりません");
  assert.equal(target.length, 21);
  const reader = new FrameReader("elevator");
  assert.deepEqual(frames(reader.push(target)), [target]);
});

test("警報電文は本文に02Hを含んでも固定長で読み切る", () => {
  const frame = Alarm.buildFrame({
    type: Alarm.TYPE.ALARM_1,
    info: 0x01,
    buildingNo: 0,
    source: Alarm.sourceDwelling(1020),
    historyNumber: 0,
  });
  assert.equal(frame.length, 11);
  assert.ok(frame.slice(1, -1).includes(0x02), "本文に02Hを含む電文で検証する必要があります");
  everySplit("alarm", frame, [frame]);
});

test("宅配4線式はデータ長から総バイト数を求める", () => {
  const request = Telegram4.buildRequestTelegram({ modelNo: 1 });
  const response = Telegram4.buildResponseTelegram({
    packageNo: 0,
    modelNo: 1,
    lockers: [{ state: 0x31, lockerNo: 1, buildingNo: 0, roomNo: 101 }],
  });
  const reader = new FrameReader("locker4");
  assert.deepEqual(frames(reader.push([...request, ...response])), [request, response]);
});

test("宅配4線式のデータ長が数字でなければフレームを破棄する", () => {
  const reader = new FrameReader("locker4");
  const events = reader.push([0x02, 0x38, 0x37, 0x30, 0x30, 0x41]);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "error");
  assert.equal(events[0].code, "INVALID_FRAME");
  assert.equal(reader.bufferedLength, 0);
});

test("未完了フレーム中のSTXは再同期として記録する", () => {
  const frame = Telegram2.buildTelegram({ command: 0x11, buildingNo: 1, roomNo: 101, address: 1 });
  const reader = new FrameReader("locker2");
  const events = reader.push([0x02, 0x11, 0x31, ...frame]);
  assert.deepEqual(events.map((event) => event.type), ["error", "frame"]);
  assert.equal(events[0].code, "UNEXPECTED_STX");
  assert.deepEqual(events[0].bytes, [0x02, 0x11, 0x31]);
  assert.deepEqual(events[1].bytes, frame);
});

test("マンションコントローラはStreamDecoderへ委譲する", () => {
  const frame = M.buildHealthCheckRequest({ version: 3, from: M.ROLE.IC });
  const reader = new FrameReader("mansion", { validateCommand: false });
  const events = collect(reader, frame.map((byte) => [byte]));
  assert.deepEqual(events.map((event) => event.type), ["frame"]);
  assert.deepEqual(events[0].bytes, frame);
  assert.equal(events[0].parsed.kind, 0x3A);
});

test("マンションコントローラはLEN範囲外を検出する", () => {
  const reader = new FrameReader("mansion", { validateCommand: false });
  const events = reader.push([0x02, 0x30, 0x34]);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "error");
  assert.equal(events[0].code, "INVALID_LEN_RANGE");
});

test("マンションコントローラでもEOTは伝送制御として扱う", () => {
  const reader = new FrameReader("mansion", { validateCommand: false });
  const events = reader.push([0x05, 0x04, 0x06]);
  assert.deepEqual(events.map((event) => event.type), ["control", "control", "control"]);
  assert.deepEqual(events.map((event) => event.code), [0x05, 0x04, 0x06]);
});

test("プロファイル外の画面では制御コードだけを返す", () => {
  const reader = new FrameReader("terminal");
  const events = reader.push([0x02, 0x31, 0x03, 0x05, 0x06, 0x15, 0x04]);
  assert.deepEqual(events.map((event) => event.code), [0x05, 0x06, 0x15, 0x04]);
  assert.equal(reader.bufferedLength, 0);
});

test("flushは途中のフレームを未完として確定する", () => {
  const reader = new FrameReader("elevator");
  reader.push([0x02, 0x45, 0x43]);
  assert.equal(reader.bufferedLength, 3);
  const events = reader.flush();
  assert.equal(events.length, 1);
  assert.equal(events[0].code, "TRUNCATED_FRAME");
  assert.deepEqual(events[0].bytes, [0x02, 0x45, 0x43]);
  assert.equal(reader.bufferedLength, 0);
});

test("resetは保持中のバイトを破棄する", () => {
  const reader = new FrameReader("locker2");
  reader.push([0x02, 0x11]);
  reader.reset();
  assert.equal(reader.bufferedLength, 0);
  assert.deepEqual(reader.flush(), []);
});

test("バイト以外の入力は呼出側エラーにする", () => {
  const reader = new FrameReader("locker2");
  assert.throws(() => reader.push([0x02, 256]), RangeError);
  assert.throws(() => reader.push(null), TypeError);
});

console.log("\n========================================");
console.log(`  結果: ${passed} 件成功 / ${failed} 件失敗`);
console.log("========================================");
if (failed) process.exitCode = 1;
