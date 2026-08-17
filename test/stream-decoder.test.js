"use strict";

const assert = require("node:assert/strict");
const M = require("../protocol/mansion-controller.js");
const StreamDecoder = require("../protocol/stream-decoder.js");

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

function collect(decoder, chunks) {
  const events = [];
  for (const chunk of chunks) events.push(...decoder.push(chunk));
  return events;
}

function eventTypes(events) {
  return events.map((event) => event.type + (event.name ? `:${event.name}` : ""));
}

console.log("=== Q48-008I stream decoder ===");

test("NULL/ENQ/ACK/NAKを独立したtransport controlとして返す", () => {
  const decoder = new StreamDecoder();
  const events = decoder.push([M.CODE.NULL, M.CODE.ENQ, M.CODE.ACK, M.CODE.NAK]);
  assert.deepEqual(eventTypes(events), ["control:NULL", "control:ENQ", "control:ACK", "control:NAK"]);
  assert.equal(events.some((event) => event.code === 0x04), false);
});

test("1バイトずつ分割されたフレームを復元", () => {
  const frame = M.buildInitializationRequest({ version: 3, deliveryNotification: true });
  const decoder = new StreamDecoder({ version: 3, from: M.ROLE.IC });
  const events = collect(decoder, frame.map((byte) => [byte]));
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "frame");
  assert.deepEqual(events[0].raw, frame);
  assert.equal(events[0].frame.messageText, "5");
  assert.equal(decoder.bufferedLength, 0);
});

test("全分割境界で同じフレームを復元", () => {
  const frame = M.buildFrame({ kind: 0x37, command: 0x42, message: "01BBB101003", version: 3 });
  for (let split = 0; split <= frame.length; split += 1) {
    const decoder = new StreamDecoder({ version: 3 });
    const events = collect(decoder, [Buffer.from(frame.slice(0, split)), Uint8Array.from(frame.slice(split))]);
    assert.equal(events.length, 1, `split=${split}`);
    assert.equal(events[0].type, "frame", `split=${split}`);
    assert.deepEqual(events[0].raw, frame, `split=${split}`);
  }
});

test("複数フレームとcontrolが同一chunkで連結されても順序を維持", () => {
  const request = M.buildHealthCheckRequest({ version: 3, from: M.ROLE.IC });
  const response = M.buildHealthCheckResponse({ version: 3, from: M.ROLE.MC });
  const decoder = new StreamDecoder({ version: 3 });
  const events = decoder.push(Buffer.from([M.CODE.ENQ, M.CODE.ACK, ...request, ...response, M.CODE.NAK]));
  assert.deepEqual(eventTypes(events), ["control:ENQ", "control:ACK", "frame", "frame", "control:NAK"]);
  assert.equal(events[2].frame.command, 0x41);
  assert.equal(events[3].frame.command, 0x61);
});

test("BCCが制御コードと同値でもフレーム終端としてのみ扱う", () => {
  const targetBccValues = [M.CODE.STX, M.CODE.ETX, M.CODE.ENQ, M.CODE.ACK, M.CODE.NAK];
  const frames = targetBccValues.map((target) => {
    let found = null;
    for (let byte = 0x20; byte <= 0x7E; byte += 1) {
      const candidate = M.buildFrame({ kind: 0x3A, command: 0x41, message: [byte], version: 3 });
      if (candidate.at(-1) === target) {
        found = candidate;
        break;
      }
    }
    assert.ok(found, `BCC=${target.toString(16)}`);
    return found;
  });
  const decoder = new StreamDecoder({ version: 3 });
  const events = decoder.push(frames.flat());
  assert.equal(events.length, targetBccValues.length);
  assert.ok(events.every((event) => event.type === "frame"));
  assert.deepEqual(events.map((event) => event.raw.at(-1)), targetBccValues);
});

test("BCC異常をerrorにし、直後の正常フレームを失わない", () => {
  const bad = M.buildHealthCheckRequest({ version: 3 });
  bad[bad.length - 1] ^= 0x01;
  const good = M.buildHealthCheckResponse({ version: 3 });
  const decoder = new StreamDecoder({ version: 3 });
  const events = decoder.push([...bad, ...good]);
  assert.deepEqual(eventTypes(events), ["error", "frame"]);
  assert.equal(events[0].error.code, "BCC_MISMATCH");
  assert.equal(events[1].frame.command, 0x61);
});

test("LEN非数字から次のSTXへ再同期", () => {
  const good = M.buildHealthCheckRequest({ version: 3 });
  const decoder = new StreamDecoder({ version: 3 });
  const events = decoder.push([M.CODE.STX, 0x58, ...good]);
  assert.deepEqual(eventTypes(events), ["error", "frame"]);
  assert.equal(events[0].error.code, "INVALID_LEN_ENCODING");
});

test("未完了フレーム内のSTXを新フレーム先頭として再同期", () => {
  const good = M.buildHealthCheckRequest({ version: 3 });
  const decoder = new StreamDecoder({ version: 3 });
  const events = decoder.push([M.CODE.STX, 0x30, 0x39, 0x30, 0x41, ...good]);
  assert.deepEqual(eventTypes(events), ["error", "frame"]);
  assert.equal(events[0].error.code, "UNEXPECTED_STX");
  assert.deepEqual(events[1].raw, good);
});

test("宣言LENより早いETXを異常として検出", () => {
  const decoder = new StreamDecoder({ validateCommand: false });
  const events = decoder.push([M.CODE.STX, 0x30, 0x39, 0x30, 0x41, M.CODE.ETX]);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "error");
  assert.equal(events[0].error.code, "UNEXPECTED_ETX");
  assert.equal(decoder.bufferedLength, 0);
});

test("flushは途中フレームをTRUNCATED_FRAMEとして確定", () => {
  const decoder = new StreamDecoder();
  assert.deepEqual(decoder.push([M.CODE.STX, 0x30]), []);
  const events = decoder.flush();
  assert.equal(events.length, 1);
  assert.equal(events[0].error.code, "TRUNCATED_FRAME");
  assert.deepEqual(events[0].raw, [M.CODE.STX, 0x30]);
  assert.equal(decoder.bufferedLength, 0);
  assert.deepEqual(decoder.flush(), []);
});

test("指定バージョンで未対応のCMDをstream errorにする", () => {
  const ver3Only = M.buildFrame({ kind: 0x39, command: 0x4C, message: "BBB1010130", version: 3 });
  const decoder = new StreamDecoder({ version: 2 });
  const events = decoder.push(ver3Only);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "error");
  assert.equal(events[0].error.code, "UNSUPPORTED_VERSION");
});

test("validateCommand=falseなら未定義CMDをstreamで保持", () => {
  const raw = M.buildFrame({ kind: 0x30, command: 0x44, validateCommand: false });
  const decoder = new StreamDecoder({ validateCommand: false });
  const events = decoder.push(raw);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "frame");
  assert.equal(events[0].frame.commandDefinition, null);
});

test("フレーム外のETX/任意byteを黙って破棄しない", () => {
  const decoder = new StreamDecoder();
  const events = decoder.push([M.CODE.ETX, 0x04, 0x7F]);
  assert.deepEqual(eventTypes(events), ["error", "error", "error"]);
  assert.ok(events.every((event) => event.error.code === "UNEXPECTED_BYTE"));
});

test("decoder設定値も厳格に検証", () => {
  assert.throws(() => new StreamDecoder({ version: "3" }), (error) => error.code === "INVALID_VERSION");
  assert.throws(() => new StreamDecoder({ from: "ic" }), (error) => error.code === "INVALID_ROLE");
  assert.throws(() => new StreamDecoder({ validateCommand: 0 }), (error) => error.code === "INVALID_BOOLEAN");
});

test("入力byte範囲外はイベント化せず呼出側エラー", () => {
  const decoder = new StreamDecoder();
  assert.throws(() => decoder.push([256]), (error) => error.code === "INVALID_BYTE");
  assert.throws(() => decoder.push([-1]), (error) => error.code === "INVALID_BYTE");
});

test("onEvent callbackへ戻り値と同じ順序で通知", () => {
  const observed = [];
  const decoder = new StreamDecoder({ version: 3, onEvent: (event) => observed.push(event) });
  const returned = decoder.push([M.CODE.ENQ, ...M.buildHealthCheckRequest({ version: 3 }), M.CODE.ACK]);
  assert.deepEqual(eventTypes(observed), ["control:ENQ", "frame", "control:ACK"]);
  assert.deepEqual(observed, returned);
});

console.log("\n========================================");
console.log(`  結果: ${passed} 件成功 / ${failed} 件失敗`);
console.log("========================================");
if (failed) process.exitCode = 1;
