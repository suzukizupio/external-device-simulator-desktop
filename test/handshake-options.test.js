"use strict";

const assert = require("assert");
const H = require("../protocol/handshake");

const fsm = new H.SendHandshakeFSM({ sendEot: false, textRetryMode: "sameText", maxRetries: 5 });
assert.strictEqual(fsm.start([[0x02, 0x03]])[0].kind, "ENQ");
assert.strictEqual(fsm.receiveControl(H.CODE.ACK)[0].kind, "TEXT");
const retry = fsm.receiveControl(H.CODE.NAK);
assert.strictEqual(retry[0].type, "retry");
assert.strictEqual(retry[1].kind, "TEXT", "Q46/Q49/MC retry the same text without ENQ");
const complete = fsm.receiveControl(H.CODE.ACK);
assert.strictEqual(complete.length, 1);
assert.strictEqual(complete[0].type, "complete", "EOT must be omitted for non-locker protocols");

assert.throws(() => new H.SendHandshakeFSM({ textRetryMode: "invalid" }), /textRetryMode/);
console.log("handshake-options: OK");
