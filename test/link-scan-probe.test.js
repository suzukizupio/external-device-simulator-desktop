"use strict";

const assert = require("node:assert/strict");
const { CODE, LinkScanProbe } = require("../lib/link-scan-probe");

const active = new LinkScanProbe();
assert.deepEqual(active.receive([CODE.ENQ]), [CODE.ACK]);
assert.deepEqual(active.receive([CODE.ENQ, CODE.ENQ, CODE.ENQ]), [CODE.ACK, CODE.ACK]);
assert.deepEqual(active.snapshot(), {
  respondToEnq: true,
  observedEnq: 4,
  acksSent: 3,
  frameStarted: false,
});

const payloadControl = new LinkScanProbe();
assert.deepEqual(payloadControl.receive([CODE.ENQ, CODE.STX, 0x37, CODE.ENQ, 0x00]), [CODE.ACK]);
assert.deepEqual(payloadControl.receive([CODE.ENQ]), []);
assert.equal(payloadControl.snapshot().observedEnq, 1);
assert.equal(payloadControl.snapshot().frameStarted, true);

const passive = new LinkScanProbe({ respondToEnq: false });
assert.deepEqual(passive.receive([CODE.ENQ, CODE.ENQ]), []);
assert.equal(passive.snapshot().observedEnq, 2);
assert.equal(passive.snapshot().acksSent, 0);

assert.throws(() => new LinkScanProbe({ respondToEnq: "yes" }), /boolean/);
assert.throws(() => new LinkScanProbe({ maxAcks: 0 }), /1～8/);
assert.throws(() => active.receive([256]), /0～255/);

console.log("link-scan-probe: OK");
