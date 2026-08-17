"use strict";

const assert = require("assert");
const { ACTION, FaultPlan, createPreset } = require("../protocol/fault-engine");

const original = [0x02, 0x31, 0x03, 0x32];
const once = new FaultPlan([{ id: "second", phase: "frame", occurrence: 2, action: ACTION.CORRUPT_LAST }]);
assert.deepStrictEqual(once.apply({ phase: "frame", bytes: original }).bytes, original);
const changed = once.apply({ phase: "frame", bytes: original });
assert.deepStrictEqual(changed.bytes, [0x02, 0x31, 0x03, 0x33]);
assert.deepStrictEqual(original, [0x02, 0x31, 0x03, 0x32], "input must not be mutated");

assert.strictEqual(createPreset("missing-bcc").apply({ phase: "frame", bytes: original }).bytes.length, 3);
assert.strictEqual(createPreset("no-response").apply({ direction: "rx-response", bytes: [0x06] }).bytes, null);
assert.deepStrictEqual(createPreset("nak-once").apply({ phase: "response", bytes: [0x06] }).bytes, [0x15]);
assert.strictEqual(createPreset("delay", { delayMs: 123 }).apply({ phase: "response", bytes: [0x06] }).delayMs, 123);
assert.throws(() => new FaultPlan([{ action: "unknown" }]), /unsupported/);

console.log("fault-engine: OK");
