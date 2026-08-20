"use strict";

const assert = require("assert");
const { EventEmitter } = require("events");
const { SerialSession, normalizeOptions, normalizeBytes } = require("../lib/serial-session");

class MockPort extends EventEmitter {
  static instances = [];
  static events = [];
  static blockedDrainPath = null;
  static releaseDrain = null;
  static failingDrainPaths = new Set();
  static failingClosePaths = new Set();
  static throwingConstructorPaths = new Set();

  constructor(options) {
    super();
    if (MockPort.throwingConstructorPaths.has(options.path)) throw new Error("mock constructor failure");
    this.options = options;
    this.isOpen = false;
    this.writes = [];
    MockPort.instances.push(this);
  }

  open(callback) {
    setImmediate(() => {
      this.isOpen = true;
      MockPort.events.push(`${this.options.path}:open`);
      callback();
    });
  }

  write(buffer, callback) {
    this.writes.push(Array.from(buffer));
    setImmediate(callback);
  }

  drain(callback) {
    if (MockPort.failingDrainPaths.has(this.options.path)) {
      return setImmediate(() => callback(new Error("Draining connection (FlushFileBuffers): Unknown error code 1")));
    }
    if (MockPort.blockedDrainPath === this.options.path) {
      MockPort.releaseDrain = () => {
        MockPort.events.push(`${this.options.path}:drain`);
        MockPort.blockedDrainPath = null;
        setImmediate(callback);
      };
      return;
    }
    setImmediate(() => {
      MockPort.events.push(`${this.options.path}:drain`);
      callback();
    });
  }

  set(options, callback) {
    this.signals = { ...(this.signals || {}), ...options };
    setImmediate(callback);
  }

  get(callback) {
    setImmediate(() => callback(null, { cts: true, dsr: false, dcd: false, ...this.signals }));
  }

  flush(callback) {
    setImmediate(callback);
  }

  close(callback) {
    setImmediate(() => {
      if (MockPort.failingClosePaths.has(this.options.path)) return callback(new Error("mock close failure"));
      this.isOpen = false;
      MockPort.events.push(`${this.options.path}:close`);
      callback();
      this.emit("close");
    });
  }
}

async function run() {
  assert.deepStrictEqual(normalizeOptions({
    path: "COM7", baudRate: 4800, dataBits: 8, stopBits: 1, parity: "even", flowControl: "none",
  }), {
    path: "COM7", baudRate: 4800, dataBits: 8, stopBits: 1, parity: "even", flowControl: "none",
  });
  assert.throws(() => normalizeOptions({ path: "", baudRate: 4800 }), /path/);
  assert.throws(() => normalizeBytes([0, 256]), /byte/);
  assert.throws(() => normalizeBytes(new Array(4097).fill(0)), /4096/);

  const session = new SerialSession({
    SerialPortCtor: MockPort,
    listPorts: async () => [{ path: "COM7", manufacturer: "Mock" }],
  });

  assert.deepStrictEqual(await session.list(), [{
    path: "COM7", manufacturer: "Mock", friendlyName: "", serialNumber: "", vendorId: "", productId: "",
  }]);

  const statuses = [];
  const received = [];
  session.on("status", (state) => statuses.push(state.status));
  session.on("data", (event) => received.push(event));

  const opened = await session.open({
    path: "COM7", baudRate: 4800, dataBits: 8, stopBits: 1, parity: "even", flowControl: "none",
  });
  assert.strictEqual(opened.status, "open");
  assert.strictEqual(MockPort.instances[0].options.autoOpen, false);

  const write1 = session.write([0x05]);
  const write2 = session.write([0x02, 0x03]);
  await Promise.all([write1, write2]);
  assert.deepStrictEqual(MockPort.instances[0].writes, [[0x05], [0x02, 0x03]], "writes must stay ordered");

  MockPort.instances[0].emit("data", Buffer.from([0x06]));
  assert.deepStrictEqual(received[0].bytes, [0x06]);
  assert.strictEqual(received[0].sessionId, opened.sessionId);
  assert.strictEqual((await session.setSignals({ dtr: true, rts: false })).dtr, true);
  assert.strictEqual((await session.getSignals()).cts, true);
  assert.strictEqual(await session.flush(), true);

  await session.close();
  assert.strictEqual(session.snapshot().status, "closed");
  await assert.rejects(() => session.write([0x05]), /not open/);
  assert.ok(statuses.includes("opening"));
  assert.ok(statuses.includes("open"));
  assert.ok(statuses.includes("closed"));

  const raceSession = new SerialSession({ SerialPortCtor: MockPort, listPorts: async () => [] });
  MockPort.events.length = 0;
  await raceSession.open({ path: "COM1", baudRate: 4800, dataBits: 8, stopBits: 1, parity: "even", flowControl: "none" });
  MockPort.blockedDrainPath = "COM1";
  const pendingWrite = raceSession.write([0x02, 0x03]);
  while (!MockPort.releaseDrain) await new Promise((resolve) => setImmediate(resolve));
  const pendingReopen = raceSession.open({ path: "COM2", baudRate: 4800, dataBits: 8, stopBits: 1, parity: "even", flowControl: "none" });
  await assert.rejects(() => raceSession.write([0x05]), /transition/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.strictEqual(MockPort.events.includes("COM1:close"), false, "reopen must not close a port before drain completes");
  MockPort.releaseDrain();
  await Promise.all([pendingWrite, pendingReopen]);
  assert.ok(MockPort.events.indexOf("COM1:drain") < MockPort.events.indexOf("COM1:close"));
  assert.ok(MockPort.events.indexOf("COM1:close") < MockPort.events.indexOf("COM2:open"));
  await raceSession.close();

  const closeFailureSession = new SerialSession({ SerialPortCtor: MockPort, listPorts: async () => [] });
  await closeFailureSession.open({ path: "COM_FAIL_CLOSE", baudRate: 4800, dataBits: 8, stopBits: 1, parity: "even", flowControl: "none" });
  const retainedPort = closeFailureSession.port;
  MockPort.failingClosePaths.add("COM_FAIL_CLOSE");
  await assert.rejects(() => closeFailureSession.close(), /mock close failure/);
  assert.strictEqual(closeFailureSession.port, retainedPort, "failed close must retain the native handle");
  assert.strictEqual(closeFailureSession.snapshot().status, "error");
  MockPort.failingClosePaths.delete("COM_FAIL_CLOSE");
  await closeFailureSession.close();

  MockPort.throwingConstructorPaths.add("COM_THROW");
  const constructorFailureSession = new SerialSession({ SerialPortCtor: MockPort, listPorts: async () => [] });
  await assert.rejects(() => constructorFailureSession.open({ path: "COM_THROW", baudRate: 4800, dataBits: 8, stopBits: 1, parity: "even", flowControl: "none" }), /constructor failure/);
  assert.strictEqual(constructorFailureSession.snapshot().status, "error");
  assert.match(constructorFailureSession.snapshot().error, /constructor failure/);
  MockPort.throwingConstructorPaths.delete("COM_THROW");

  // drain非対応の仮想COMポートでも、書き込めた電文を失敗扱いにしない。
  MockPort.failingDrainPaths.add("COM_NO_DRAIN");
  const noDrainSession = new SerialSession({ SerialPortCtor: MockPort, listPorts: async () => [] });
  const drainWarnings = [];
  noDrainSession.on("serial-error", (event) => drainWarnings.push(event.message));
  await noDrainSession.open({ path: "COM_NO_DRAIN", baudRate: 1200, dataBits: 8, stopBits: 1, parity: "even", flowControl: "none" });
  const noDrainPort = MockPort.instances[MockPort.instances.length - 1];
  const firstWrite = await noDrainSession.write([0x02, 0x37]);
  assert.deepStrictEqual(firstWrite.bytes, [0x02, 0x37], "drain失敗でも書き込みイベントを返す");
  await noDrainSession.write([0x06]);
  assert.deepStrictEqual(noDrainPort.writes, [[0x02, 0x37], [0x06]], "drain失敗後も送信を続けられる");
  assert.strictEqual(drainWarnings.length, 1, "drain未対応の通知はセッションにつき1回だけ");
  assert.match(drainWarnings[0], /drain\(FlushFileBuffers\)/);
  assert.strictEqual(noDrainSession.snapshot().status, "open", "drain失敗でセッションを壊さない");
  assert.strictEqual(noDrainSession.snapshot().error, null, "drain失敗をポート異常として残さない");
  await noDrainSession.close();
  MockPort.failingDrainPaths.delete("COM_NO_DRAIN");

  const signalSession = new SerialSession({ SerialPortCtor: MockPort, listPorts: async () => [] });
  await signalSession.open({ path: "COM_SIGNAL", baudRate: 4800, dataBits: 8, stopBits: 1, parity: "even", flowControl: "none" });
  await assert.rejects(() => signalSession.setSignals({ dtr: "false" }), /boolean/);
  await signalSession.close();

  console.log("serial-session: OK");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
