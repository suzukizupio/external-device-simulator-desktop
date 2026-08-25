"use strict";

const assert = require("assert");
const { SerialPort } = require("serialport");
const { SerialSession } = require("../lib/serial-session");

const portA = String(process.env.EXTERNAL_SIMULATOR_HIL_PORT_A || "").trim();
const portB = String(process.env.EXTERNAL_SIMULATOR_HIL_PORT_B || "").trim();
const options = { baudRate: 9600, dataBits: 8, stopBits: 1, parity: "none", flowControl: "none" };

if (!portA || !portB || portA === portB) {
  console.error("EXTERNAL_SIMULATOR_HIL_PORT_A と EXTERNAL_SIMULATOR_HIL_PORT_B に、com0comまたは実機治具の対向COMポートを指定してください。");
  process.exit(2);
}

function callbackCall(target, method, ...args) {
  return new Promise((resolve, reject) => target[method](...args, (error) => error ? reject(error) : resolve()));
}

function receiveBytes(emitter, eventName, expected, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const received = [];
    const timer = setTimeout(() => finish(new Error(`${eventName} timeout: ${received.join(" ")}`)), timeoutMs);
    const onData = (event) => {
      received.push(...Array.from(event && event.bytes ? event.bytes : event));
      if (received.length >= expected.length) finish(null, received.slice(0, expected.length));
    };
    const finish = (error, value) => {
      clearTimeout(timer);
      emitter.removeListener(eventName, onData);
      if (error) reject(error);
      else resolve(value);
    };
    emitter.on(eventName, onData);
  });
}

async function run() {
  const peer = new SerialPort({ path: portB, ...options, autoOpen: false });
  const session = new SerialSession({ SerialPortCtor: SerialPort, listPorts: () => SerialPort.list() });
  const toApp = [0x02, 0x48, 0x49, 0x4C, 0x03];
  const fromApp = [0x05, 0x06, 0x15, 0x04];

  try {
    await callbackCall(peer, "open");
    await session.open({ path: portA, ...options });

    const appReceive = receiveBytes(session, "data", toApp);
    await callbackCall(peer, "write", Buffer.from(toApp));
    await callbackCall(peer, "drain");
    assert.deepStrictEqual(await appReceive, toApp);

    const peerReceive = receiveBytes(peer, "data", fromApp);
    await session.write(fromApp);
    assert.deepStrictEqual(await peerReceive, fromApp);

    console.log(`serial-hil: OK (${portA} <-> ${portB}, 9600,N,8,1)`);
  } finally {
    await session.close().catch(() => undefined);
    if (peer.isOpen) await callbackCall(peer, "close").catch(() => undefined);
  }
}

run().catch((error) => {
  console.error(`serial-hil: NG ${error && error.stack || error}`);
  process.exitCode = 1;
});
