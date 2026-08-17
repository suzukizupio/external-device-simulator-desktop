"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const E = require("../protocol/elevator.js");

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
  copy.push(E.calculateBCC(copy));
  return copy;
}

console.log("=== Q46-005J elevator protocol ===");

test("UMD exposes ElevatorProtocol in a browser-like context", function () {
  const source = fs.readFileSync(path.join(__dirname, "../protocol/elevator.js"), "utf8");
  const context = {};
  vm.runInNewContext(source, context);
  assert.equal(typeof context.ElevatorProtocol.buildFrame, "function");
});

test("control codes match the specification", function () {
  assert.deepEqual(E.CODE, { NULL: 0x00, STX: 0x02, ETX: 0x03, ENQ: 0x05, ACK: 0x06, NAK: 0x15 });
});

test("formats gate, dwelling, management, and person fields without truncation", function () {
  assert.equal(E.formatGate({ buildingNo: 12, id: 34 }), "1234");
  assert.equal(E.formatRoom({ buildingNo: 0, roomNo: 101 }), "00B101");
  assert.equal(E.formatRoom({ buildingNo: 7, roomNo: 1505 }), "071505");
  assert.equal(E.formatRoom({ buildingNo: 0, managementNo: 9 }), "00C009");
  assert.equal(E.formatPerson(2), "002");
});

test("VIXUS Advance permits C099 while the standard profile stops at C009", function () {
  assert.equal(E.formatRoom({ managementNo: 99 }, E.PROFILE.VIXUS_ADVANCE), "00C099");
  assert.throws(function () { E.formatRoom({ managementNo: 10 }, E.PROFILE.FULL); }, /1 to 9/);
});

test("rejects numeric overflow and non-canonical room encodings", function () {
  assert.throws(function () { E.formatGate({ id: 100 }); }, /0 to 99/);
  assert.throws(function () { E.formatRoom({ roomNo: 10000 }); }, /0 to 9999/);
  assert.throws(function () { E.formatPerson(1000); }, /0 to 999/);
  assert.throws(function () { E.formatRoom("000101"); }, /1000 to 9999/);
  assert.throws(function () { E.formatGate("123"); }, /four decimal digits/);
});

const hinfoGolden = [
  0x02,
  0x48, 0x49, 0x4E, 0x46, 0x4F,
  0x30, 0x30, 0x30, 0x33,
  0x30, 0x30, 0x42, 0x31, 0x30, 0x31,
  0x30, 0x30, 0x30,
  0x03, 0x04,
];

test("builds the Q46 HINFO example as an exact 21-byte golden vector", function () {
  const frame = E.buildFrame({
    command: E.COMMAND.HINFO,
    direction: E.DIRECTION.TO_ELEVATOR,
    gateNo: 3,
    roomNo: 101,
  });
  assert.deepEqual(frame, hinfoGolden);
  assert.equal(frame.length, 21);
  assert.equal(E.verifyBCC(frame), true);
});

test("parses command, gate, room, and person from the golden vector", function () {
  const parsed = E.parseFrame(hinfoGolden, { direction: E.DIRECTION.TO_ELEVATOR });
  assert.equal(parsed.command, E.COMMAND.HINFO);
  assert.deepEqual(parsed.gate, { raw: "0003", buildingNo: 0, id: 3 });
  assert.equal(parsed.room.raw, "00B101");
  assert.equal(parsed.room.kind, "dwelling");
  assert.equal(parsed.room.number, 101);
  assert.equal(parsed.person, 0);
});

test("builds and parses every command in its specified direction", function () {
  const cases = [
    [E.COMMAND.ECALL, E.DIRECTION.TO_ELEVATOR, { roomNo: 101 }],
    [E.COMMAND.HINFO, E.DIRECTION.TO_ELEVATOR, { gateNo: 1, roomNo: 101 }],
    [E.COMMAND.GINFO, E.DIRECTION.TO_ELEVATOR, { gateNo: 1 }],
    [E.COMMAND.KINFO, E.DIRECTION.TO_ELEVATOR, { gateNo: 1, roomNo: 101, personNo: 2 }],
    [E.COMMAND.COPEN, E.DIRECTION.TO_ELEVATOR, { gateNo: 1 }],
    [E.COMMAND.CCLSE, E.DIRECTION.TO_ELEVATOR, { gateNo: 1 }],
    [E.COMMAND.EOPEN, E.DIRECTION.TO_ELEVATOR, { gateNo: 1 }],
    [E.COMMAND.ECLSE, E.DIRECTION.TO_ELEVATOR, { gateNo: 1 }],
    [E.COMMAND.INITI, E.DIRECTION.TO_ELEVATOR, {}],
    [E.COMMAND.ESTAT, E.DIRECTION.FROM_ELEVATOR, { roomNo: 101 }],
    [E.COMMAND.ESTOP, E.DIRECTION.FROM_ELEVATOR, { roomNo: 101 }],
    [E.COMMAND.INITI, E.DIRECTION.FROM_ELEVATOR, {}],
    [E.COMMAND.INITE, E.DIRECTION.FROM_ELEVATOR, {}],
    [E.COMMAND.CHECK, E.DIRECTION.FROM_ELEVATOR, {}],
  ];
  cases.forEach(function (item) {
    const options = Object.assign({ command: item[0], direction: item[1] }, item[2]);
    const frame = E.buildFrame(options);
    assert.equal(E.parseFrame(frame, { direction: item[1] }).command, item[0]);
  });
});

test("enforces command-specific zero fields", function () {
  const ecall = E.parseFrame(E.buildFrame({ command: E.COMMAND.ECALL, roomNo: 101 }));
  assert.equal(ecall.gate.raw, "0000");
  const ginfo = E.parseFrame(E.buildFrame({ command: E.COMMAND.GINFO, gateNo: 6 }));
  assert.equal(ginfo.room.raw, "000000");
  assert.throws(function () {
    E.buildFrame({ command: E.COMMAND.CHECK, gateNo: 1 });
  }, /requires gate 0000/);
  assert.throws(function () {
    E.buildFrame({ command: E.COMMAND.HINFO, gateNo: 1, roomNo: 101, personNo: 1 });
  }, /requires person 000/);
});

test("enforces command direction", function () {
  assert.throws(function () {
    E.buildFrame({ command: E.COMMAND.ECALL, direction: E.DIRECTION.FROM_ELEVATOR, roomNo: 101 });
  }, /not supported from/);
  assert.throws(function () {
    E.parseFrame(hinfoGolden, { direction: E.DIRECTION.FROM_ELEVATOR });
  }, /not supported from/);
});

test("enforces the V-fine/VBZ command subset", function () {
  assert.doesNotThrow(function () {
    E.buildFrame({ command: E.COMMAND.HINFO, profile: E.PROFILE.V_FINE_VBZ, gateNo: 1, roomNo: 101 });
  });
  assert.doesNotThrow(function () {
    E.buildFrame({ command: E.COMMAND.INITE, profile: E.PROFILE.V_FINE_VBZ, direction: E.DIRECTION.FROM_ELEVATOR });
  });
  assert.throws(function () {
    E.buildFrame({ command: E.COMMAND.ECALL, profile: E.PROFILE.V_FINE_VBZ, roomNo: 101 });
  }, /not supported/);
  assert.throws(function () {
    E.buildFrame({ command: E.COMMAND.ESTAT, profile: E.PROFILE.V_FINE_VBZ, roomNo: 101 });
  }, /not supported/);
});

test("rejects bad length, delimiters, BCC, and unknown commands", function () {
  assert.equal(E.validateFrame(hinfoGolden), true);
  assert.equal(E.validateFrame(hinfoGolden.slice(0, -1)), false);
  const badStx = hinfoGolden.slice();
  badStx[0] = 0x01;
  assert.equal(E.validateFrame(badStx), false);
  const badEtx = hinfoGolden.slice();
  badEtx[19] = 0x04;
  assert.equal(E.validateFrame(rebuilt(badEtx)), false);
  const badBcc = hinfoGolden.slice();
  badBcc[20] ^= 0x01;
  assert.equal(E.validateFrame(badBcc), false);
  const unknown = hinfoGolden.slice();
  unknown.splice(1, 5, 0x58, 0x58, 0x58, 0x58, 0x58);
  assert.equal(E.validateFrame(rebuilt(unknown)), false);
});

test("rejects a structurally valid frame with forbidden nonzero fields", function () {
  const invalidCheck = E.buildFrame({ command: E.COMMAND.CHECK });
  invalidCheck[9] = 0x31;
  assert.equal(E.validateFrame(rebuilt(invalidCheck)), false);
});

console.log("=== " + passed + " elevator tests passed ===");
