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

const tss = new H.SendHandshakeFSM({
  packets: [[0x02, 0x03]],
  maxRetries: 256,
  retryUnexpectedControl: true,
  retryLimits: {
    linkResponse: 1,
    linkTimeout: 2,
    textResponse: 1,
    textTimeout: 1,
    other: 1,
  },
});
assert.strictEqual(tss.snapshot().maxRetries, 256, "MAX256を設定できる");
tss.start();
let events = tss.timeout();
assert.strictEqual(events[0].retryKey, "linkTimeout");
assert.strictEqual(events[0].retriesForKey, 1);
events = tss.receiveControl(0x30);
assert.strictEqual(events[0].retryKey, "linkResponse", "ACK以外の応答はリンク応答回数として数える");
assert.strictEqual(events[0].retriesForKey, 1);
events = tss.timeout();
assert.strictEqual(events[0].retryKey, "linkTimeout");
assert.strictEqual(events[0].retriesForKey, 2, "リンク応答とリンクタイムアウトは別々に数える");
events = tss.timeout();
assert.strictEqual(events[0].type, "failed");
assert.strictEqual(events[0].retryKey, "linkTimeout");
assert.strictEqual(events[0].maxRetries, 2);

const textFailure = new H.SendHandshakeFSM({
  packets: [[0x02, 0x03]],
  textRetryMode: "sameText",
  retryUnexpectedControl: true,
  retryLimits: { linkResponse: 5, linkTimeout: 256, textResponse: 1, textTimeout: 1, other: 1 },
});
textFailure.start();
textFailure.receiveControl(H.CODE.ACK);
events = textFailure.receiveControl(H.CODE.NAK);
assert.strictEqual(events[0].retryKey, "textResponse");
events = textFailure.timeout();
assert.strictEqual(events[0].retryKey, "textTimeout", "NAKと無応答は別々に数える");
events = textFailure.timeout();
assert.strictEqual(events[0].type, "failed");
assert.strictEqual(events[0].retryKey, "textTimeout");

assert.throws(() => new H.SendHandshakeFSM({ maxRetries: 65536 }), /0～65535/);
console.log("handshake-options: OK");
