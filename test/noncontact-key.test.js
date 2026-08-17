"use strict";

const assert = require("assert");
const Key = require("../protocol/noncontact-key");

const packet13 = Key.buildTelegram({
  format: Key.FORMAT.WITH_PERSON,
  gateNo: 1,
  buildingNo: 0,
  roomNo: 101,
  personNo: 3,
});
assert.deepStrictEqual(packet13, [0x02, 0x30, 0x31, 0x30, 0x30, 0x31, 0x30, 0x31, 0x30, 0x30, 0x33, 0x03, 0x01]);
assert.strictEqual(Key.verifyBCC(packet13), true);
assert.strictEqual(Key.verifyBCC([]), false);
assert.deepStrictEqual(Key.parseTelegram(packet13), {
  format: Key.FORMAT.WITH_PERSON,
  gateNo: 1,
  roomNo5: "00101",
  buildingNo: 0,
  roomNo: 101,
  personNo: 3,
  bcc: 0x01,
  bytes: packet13,
});

const packet10 = Key.buildTelegram({ format: Key.FORMAT.ROOM_ONLY, gateNo: 99, roomNo5: "90101" });
assert.strictEqual(packet10.length, 10);
assert.strictEqual(Key.parseTelegram(packet10).personNo, null);
assert.throws(() => Key.buildTelegram({ gateNo: 0, roomNo5: "00101", personNo: 0 }), /gateNo/);
assert.throws(() => Key.buildTelegram({ gateNo: 1, roomNo5: "101", personNo: 0 }), /exactly 5/);
assert.throws(() => Key.buildTelegram({ gateNo: 1, roomNo5: "00101", personNo: 9, personMax: 8 }), /personNo/);
assert.throws(() => Key.parseTelegram(Key.corruptBCC(packet13)), /BCC/);

const receiver = new Key.NoncontactReceiver();
assert.deepStrictEqual(receiver.push(packet13.slice(0, 4)), []);
const events = receiver.push(packet13.slice(4));
assert.strictEqual(events.length, 1);
assert.strictEqual(events[0].response, Key.CODE.ACK);
assert.strictEqual(events[0].accepted, true);

const restarted = new Key.NoncontactReceiver();
restarted.push([0x02, 0x30, 0x31, 0x02]);
assert.strictEqual(restarted.push(packet10.slice(1))[0].accepted, true, "mid-frame STX must restart framing");

const invalidLengthFrame = [0x02, 0x31, 0x03];
invalidLengthFrame.push(Key.calcBCC(invalidLengthFrame));
const invalidLengthEvent = new Key.NoncontactReceiver().push(invalidLengthFrame)[0];
assert.strictEqual(invalidLengthEvent.response, Key.CODE.ACK, "valid BCC with invalid length is ACKed");
assert.strictEqual(invalidLengthEvent.accepted, false);

const sender = new Key.NoncontactSender({ maxRetries: 5 });
assert.strictEqual(sender.start(packet10).attempt, 1);
for (let attempt = 2; attempt <= 6; attempt += 1) {
  assert.strictEqual(sender.onControl(Key.CODE.NAK).attempt, attempt);
}
assert.strictEqual(sender.onControl(Key.CODE.NAK).reason, "nak-limit");

const timeoutSender = new Key.NoncontactSender();
timeoutSender.start(packet10);
assert.strictEqual(timeoutSender.onTimeout().reason, "timeout");
assert.strictEqual(timeoutSender.attempts, 1, "no response must not be retried");

console.log("noncontact-key: OK");
