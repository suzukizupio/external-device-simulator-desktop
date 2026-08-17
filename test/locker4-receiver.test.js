"use strict";

const assert = require("assert");
const { PacketSeries } = require("../protocol/locker4-receiver");

const series = new PacketSeries();
assert.strictEqual(series.accept({ type: "response", modelNo: 7, packageNo: 2 }).expectedPackage, 1);
assert.strictEqual(series.accept({ type: "response", modelNo: 7, packageNo: 1 }).expectedPackage, 0);
assert.strictEqual(series.accept({ type: "response", modelNo: 7, packageNo: 0 }).expectedPackage, -1);
assert.deepStrictEqual(series.finish(), { type: "response", modelNo: 7, packetCount: 3 });

assert.throws(() => new PacketSeries().finish(), /未完了/);
const missing = new PacketSeries();
missing.accept({ type: "response", modelNo: 1, packageNo: 1 });
assert.throws(() => missing.finish(), /未完了/);
assert.strictEqual(missing.snapshot().active, false);

const wrongOrder = new PacketSeries();
wrongOrder.accept({ type: "response", modelNo: 1, packageNo: 2 });
assert.throws(() => wrongOrder.accept({ type: "response", modelNo: 1, packageNo: 0 }), /連続/);
assert.strictEqual(wrongOrder.snapshot().active, false);

const wrongModel = new PacketSeries();
wrongModel.accept({ type: "response", modelNo: 1, packageNo: 1 });
assert.throws(() => wrongModel.accept({ type: "response", modelNo: 2, packageNo: 0 }), /連続/);

const request = new PacketSeries();
assert.strictEqual(request.accept({ type: "request", modelNo: null, packageNo: 0 }).expectedPackage, -1);
assert.deepStrictEqual(request.finish(), { type: "request", modelNo: null, packetCount: 1 });

console.log("locker4-receiver: OK");
