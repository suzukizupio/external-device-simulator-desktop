"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const A = require("../protocol/alarm.js");

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

function rebuilt(frame) {
  const copy = frame.slice(0, -1);
  copy.push(A.calculateBCC(copy));
  return copy;
}

console.log("=== Q49-023G alarm protocol ===");

test("UMD exposes AlarmProtocol in a browser-like context", function () {
  const source = fs.readFileSync(path.join(__dirname, "../protocol/alarm.js"), "utf8");
  const context = {};
  vm.runInNewContext(source, context);
  assert.equal(typeof context.AlarmProtocol.buildFrame, "function");
});

test("control codes, fixed size, and transmission types match the specification", function () {
  assert.deepEqual(A.CODE, { STX: 0x02, ETX: 0x03, ENQ: 0x05, ACK: 0x06, NAK: 0x15 });
  assert.equal(A.SIZE, 0x37);
  assert.deepEqual(A.TYPE, {
    ALARM_1: 0x00,
    ALARM_2: 0x01,
    SECURITY_SET: 0x04,
    SECURITY_CLEAR: 0x44,
    HISTORY_REQUEST: 0x30,
  });
});

test("encodes and decodes the full 00-99 BCD building range", function () {
  assert.equal(A.encodeBCD(0), 0x00);
  assert.equal(A.encodeBCD(10), 0x10);
  assert.equal(A.encodeBCD(99), 0x99);
  assert.equal(A.decodeBCD(0x42), 42);
  assert.throws(function () { A.encodeBCD(100); }, /0 to 99/);
  assert.throws(function () { A.decodeBCD(0x0A); }, /invalid BCD/);
});

test("encodes every specified source-number form", function () {
  assert.deepEqual(A.encodeSource(A.sourceDwelling(101)), [0x00, 0x01, 0x00, 0x01]);
  assert.deepEqual(A.encodeSource(A.sourceManagement(12)), [0x0C, 0x00, 0x01, 0x02]);
  assert.deepEqual(A.encodeSource(A.sourceEntrance(123)), [0x0D, 0x01, 0x02, 0x03]);
  assert.deepEqual(A.encodeSource(A.sourceCommon()), [0x0C, 0x0A, 0x00, 0x00]);
  assert.deepEqual(A.encodeSource(A.sourceNone()), [0x00, 0x00, 0x00, 0x00]);
});

test("rejects source-number overflow instead of truncating it", function () {
  assert.throws(function () { A.sourceDwelling(10000); }, /0 to 9999/);
  assert.throws(function () { A.sourceManagement(1000); }, /0 to 999/);
  assert.throws(function () { A.sourceEntrance(-1); }, /0 to 999/);
  assert.throws(function () { A.encodeSource({ kind: "unknown", number: 1 }); }, /unknown alarm source/);
});

const alarm101 = [0x02, 0x37, 0x00, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x03, 0x3D];
const historyRequest = [0x02, 0x37, 0x30, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x03, 0x6A];
const history503 = [0x02, 0x37, 0x00, 0x04, 0x00, 0x10, 0x15, 0x10, 0x13, 0x03, 0x86];
// PDF p.20 prints 3E for this BCC, but its normative additive formula gives 41.
// (3E would be the checksum if the transmission type were 01 instead of 04.)
const securitySet101 = [0x02, 0x37, 0x04, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x03, 0x41];
const securityClear101 = [0x02, 0x37, 0x44, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x03, 0x81];

test("builds the PDF fire-at-room-101 golden vector", function () {
  const frame = A.buildFrame({ type: A.TYPE.ALARM_1, info: 0x01, roomNo: 101 });
  assert.deepEqual(frame, alarm101);
  assert.equal(frame.length, 11);
  assert.equal(A.verifyBCC(frame), true);
});

test("builds the PDF history-request golden vector", function () {
  assert.deepEqual(A.buildFrame({ type: A.TYPE.HISTORY_REQUEST }), historyRequest);
});

test("builds the PDF first-history response for gas at room 503", function () {
  const frame = A.buildFrame({
    type: A.TYPE.ALARM_1,
    info: 0x04,
    roomNo: 503,
    historyNumber: 1,
  });
  assert.deepEqual(frame, history503);
});

test("builds security-set and security-clear vectors with the normative additive BCC", function () {
  assert.deepEqual(A.buildFrame({ type: A.TYPE.SECURITY_SET, info: 0x01, roomNo: 101 }), securitySet101);
  assert.deepEqual(A.buildFrame({ type: A.TYPE.SECURITY_CLEAR, info: 0x01, roomNo: 101 }), securityClear101);
});

test("rejects the inconsistent 3E BCC printed for security-set on PDF p.20", function () {
  const printed = securitySet101.slice();
  printed[10] = 0x3E;
  assert.equal(A.validateFrame(printed), false);
});

test("parses BCD, source digits, history number, and additive BCC", function () {
  const parsed = A.parseFrame(history503);
  assert.equal(parsed.type, A.TYPE.ALARM_1);
  assert.equal(parsed.info, 0x04);
  assert.equal(parsed.buildingNo, 0);
  assert.equal(parsed.source.kind, A.SOURCE_KIND.DWELLING);
  assert.equal(parsed.source.number, 503);
  assert.equal(parsed.historyNumber, 1);
  assert.equal(parsed.bcc, 0x86);
});

test("round-trips management, entrance, and common-area sources", function () {
  const cases = [
    [A.sourceManagement(7), A.SOURCE_KIND.MANAGEMENT, 7],
    [A.sourceEntrance(321), A.SOURCE_KIND.ENTRANCE, 321],
    [A.sourceCommon(), A.SOURCE_KIND.COMMON, null],
  ];
  cases.forEach(function (item) {
    const frame = A.buildFrame({ type: A.TYPE.ALARM_2, info: 0x80, buildingNo: 10, source: item[0] });
    const parsed = A.parseFrame(frame);
    assert.equal(parsed.buildingNo, 10);
    assert.equal(parsed.source.kind, item[1]);
    assert.equal(parsed.source.number, item[2]);
  });
});

test("history number is repeated in the high nibble of all four source bytes", function () {
  assert.deepEqual(A.addHistoryNumber([0x00, 0x05, 0x00, 0x03], 15), [0xF0, 0xF5, 0xF0, 0xF3]);
  assert.throws(function () { A.addHistoryNumber([0x10, 0x00, 0x00, 0x00], 1); }, /already contains/);
  assert.throws(function () { A.addHistoryNumber([0, 0, 0, 0], 16); }, /0 to 15/);
});

test("history request strictly requires all payload fields to be zero", function () {
  assert.throws(function () { A.buildFrame({ type: A.TYPE.HISTORY_REQUEST, info: 1 }); }, /requires zero/);
  assert.throws(function () { A.buildFrame({ type: A.TYPE.HISTORY_REQUEST, buildingNo: 1 }); }, /requires zero/);
  assert.throws(function () { A.buildFrame({ type: A.TYPE.HISTORY_REQUEST, roomNo: 1 }); }, /requires zero/);
  assert.throws(function () { A.buildFrame({ type: A.TYPE.SECURITY_SET, historyNumber: 1 }); }, /only for alarm/);
});

test("rejects bad length, delimiters, size, BCC, type, BCD, and mixed history nibbles", function () {
  assert.equal(A.validateFrame(alarm101), true);
  assert.equal(A.validateFrame(alarm101.slice(0, -1)), false);
  const badStx = alarm101.slice();
  badStx[0] = 0x01;
  assert.equal(A.validateFrame(badStx), false);
  const badSize = alarm101.slice();
  badSize[1] = 0x07;
  assert.equal(A.validateFrame(rebuilt(badSize)), false);
  const badEtx = alarm101.slice();
  badEtx[9] = 0x04;
  assert.equal(A.validateFrame(rebuilt(badEtx)), false);
  const badBcc = alarm101.slice();
  badBcc[10] ^= 1;
  assert.equal(A.validateFrame(badBcc), false);
  const badType = alarm101.slice();
  badType[2] = 0x02;
  assert.equal(A.validateFrame(rebuilt(badType)), false);
  const badBcd = alarm101.slice();
  badBcd[4] = 0x1A;
  assert.equal(A.validateFrame(rebuilt(badBcd)), false);
  const mixedHistory = history503.slice();
  mixedHistory[6] = 0x25;
  assert.equal(A.validateFrame(rebuilt(mixedHistory)), false);
});

test("AlarmHistory returns the specified empty-history response", function () {
  const history = new A.AlarmHistory();
  const frame = history.nextFrame();
  const parsed = A.parseFrame(frame);
  assert.equal(parsed.type, A.TYPE.ALARM_1);
  assert.equal(parsed.info, 0);
  assert.equal(parsed.buildingNo, 0);
  assert.equal(parsed.source.kind, A.SOURCE_KIND.NONE);
  assert.equal(parsed.historyNumber, 1);
});

test("AlarmHistory retains at most 15 newest records and cycles newest-to-oldest", function () {
  const history = new A.AlarmHistory();
  for (let info = 1; info <= 16; info += 1) {
    history.add({ type: A.TYPE.ALARM_1, info: info, roomNo: 100 + info });
  }
  assert.equal(history.size, 15);
  assert.equal(history.toArray()[0].info, 16);
  assert.equal(history.toArray()[14].info, 2);
  const first = history.next();
  const second = history.next();
  assert.equal(first.info, 16);
  assert.equal(first.historyNumber, 1);
  assert.equal(second.info, 15);
  assert.equal(second.historyNumber, 2);
  for (let count = 0; count < 13; count += 1) history.next();
  const wrapped = history.next();
  assert.equal(wrapped.info, 16);
  assert.equal(wrapped.historyNumber, 1);
});

test("a newly recorded alarm resets the history-request cursor", function () {
  const history = new A.AlarmHistory();
  history.add({ type: A.TYPE.ALARM_1, info: 1, roomNo: 101 });
  history.add({ type: A.TYPE.ALARM_2, info: 2, roomNo: 102 });
  assert.equal(history.next().info, 2);
  assert.equal(history.next().info, 1);
  history.add({ type: A.TYPE.ALARM_1, info: 3, roomNo: 103 });
  const newest = history.next();
  assert.equal(newest.info, 3);
  assert.equal(newest.historyNumber, 1);
});

test("AlarmHistory refuses non-history command types and capacities above 15", function () {
  const history = new A.AlarmHistory();
  assert.throws(function () {
    history.add({ type: A.TYPE.SECURITY_SET, info: 1, roomNo: 101 });
  }, /only alarm information 1 and 2/);
  assert.throws(function () { return new A.AlarmHistory(16); }, /1 to 15/);
  assert.throws(function () { history.add(history503); }, /cannot be recorded/);
});

console.log("=== " + passed + " alarm tests passed ===");
