"use strict";

const { EventEmitter } = require("events");

const VALID_DATA_BITS = new Set([5, 6, 7, 8]);
const VALID_STOP_BITS = new Set([1, 1.5, 2]);
const VALID_PARITY = new Set(["none", "even", "odd", "mark", "space"]);
const VALID_FLOW = new Set(["none", "hardware"]);
const MAX_WRITE_BYTES = 4096;
const DRIVER_TIMEOUT_MS = 30_000;

function asInteger(value, name, min, max) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new RangeError(`${name} must be an integer from ${min} to ${max}`);
  }
  return number;
}

function normalizeOptions(options) {
  if (!options || typeof options !== "object") {
    throw new TypeError("serial options are required");
  }

  const path = String(options.path || "").trim();
  if (!path) throw new RangeError("serial path is required");

  const baudRate = asInteger(options.baudRate, "baudRate", 50, 4_000_000);
  const dataBits = Number(options.dataBits);
  const stopBits = Number(options.stopBits);
  const parity = String(options.parity || "none").toLowerCase();
  const flowControl = String(options.flowControl || "none").toLowerCase();

  if (!VALID_DATA_BITS.has(dataBits)) throw new RangeError("dataBits must be 5, 6, 7, or 8");
  if (!VALID_STOP_BITS.has(stopBits)) throw new RangeError("stopBits must be 1, 1.5, or 2");
  if (!VALID_PARITY.has(parity)) throw new RangeError("unsupported parity");
  if (!VALID_FLOW.has(flowControl)) throw new RangeError("unsupported flow control");

  return Object.freeze({ path, baudRate, dataBits, stopBits, parity, flowControl });
}

function normalizeBytes(bytes) {
  if (!Array.isArray(bytes) && !ArrayBuffer.isView(bytes)) {
    throw new TypeError("data must be an array of bytes");
  }
  const result = Array.from(bytes);
  if (result.length === 0) throw new RangeError("at least one byte is required");
  if (result.length > MAX_WRITE_BYTES) throw new RangeError(`data must not exceed ${MAX_WRITE_BYTES} bytes`);
  for (const value of result) {
    if (!Number.isInteger(value) || value < 0 || value > 0xFF) {
      throw new RangeError("every value must be a byte from 0 to 255");
    }
  }
  return result;
}

function callWithCallback(target, method, ...args) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => done(new Error(`${method} timed out after ${DRIVER_TIMEOUT_MS}ms`)), DRIVER_TIMEOUT_MS);
    const done = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    try {
      target[method](...args, done);
    } catch (error) {
      done(error);
    }
  });
}

function callWithResult(target, method) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error(`${method} timed out after ${DRIVER_TIMEOUT_MS}ms`)), DRIVER_TIMEOUT_MS);
    try {
      target[method](finish);
    } catch (error) {
      finish(error);
    }
  });
}

class SerialSession extends EventEmitter {
  constructor({ SerialPortCtor, listPorts } = {}) {
    super();
    if (typeof SerialPortCtor !== "function") throw new TypeError("SerialPortCtor is required");
    if (typeof listPorts !== "function") throw new TypeError("listPorts is required");

    this.SerialPortCtor = SerialPortCtor;
    this.listPorts = listPorts;
    this.port = null;
    this.options = null;
    this.status = "closed";
    this.lastError = null;
    this.sessionId = 0;
    this.sequence = 0;
    this.generation = 0;
    this.transitionGeneration = 0;
    this.lifecycleTail = Promise.resolve();
    this.writeTail = Promise.resolve();
  }

  snapshot() {
    return {
      status: this.status,
      sessionId: this.sessionId,
      options: this.options ? { ...this.options } : null,
      error: this.lastError,
    };
  }

  emitStatus() {
    const state = this.snapshot();
    this.emit("status", state);
    return state;
  }

  async list() {
    const ports = await this.listPorts();
    return ports.map((port) => ({
      path: port.path,
      manufacturer: port.manufacturer || "",
      friendlyName: port.friendlyName || "",
      serialNumber: port.serialNumber || "",
      vendorId: port.vendorId || "",
      productId: port.productId || "",
    }));
  }

  enqueueLifecycle(operation) {
    const result = this.lifecycleTail.then(operation, operation);
    this.lifecycleTail = result.catch(() => undefined);
    return result;
  }

  enqueueIo(operation) {
    const result = this.writeTail.then(operation, operation);
    this.writeTail = result.catch(() => undefined);
    return result;
  }

  open(rawOptions) {
    const options = normalizeOptions(rawOptions);
    const generation = ++this.generation;
    this.transitionGeneration = generation;

    return this.enqueueLifecycle(async () => {
      let candidate = null;
      try {
        if (generation !== this.generation) throw new Error("serial open request was superseded");
        await this.writeTail.catch(() => undefined);
        await this.closeCurrent();
        if (generation !== this.generation) throw new Error("serial open request was superseded");

        this.status = "opening";
        this.options = options;
        this.lastError = null;
        this.emitStatus();

        candidate = new this.SerialPortCtor({
          path: options.path,
          baudRate: options.baudRate,
          dataBits: options.dataBits,
          stopBits: options.stopBits,
          parity: options.parity,
          rtscts: options.flowControl === "hardware",
          autoOpen: false,
        });

        const nextSessionId = this.sessionId + 1;
        this.attachPortEvents(candidate, generation, nextSessionId);
        await callWithCallback(candidate, "open");
        if (generation !== this.generation) {
          if (candidate.isOpen) await callWithCallback(candidate, "close").catch(() => undefined);
          throw new Error("serial open request was superseded");
        }
        this.port = candidate;
        this.sessionId = nextSessionId;
        this.sequence = 0;
        this.status = "open";
        this.lastError = null;
        return this.emitStatus();
      } catch (error) {
        if (candidate && this.port === candidate) this.port = null;
        if (generation === this.generation) {
          this.status = "error";
          this.lastError = String(error && error.message || error);
          this.emitStatus();
        }
        throw error;
      } finally {
        if (this.transitionGeneration === generation) this.transitionGeneration = 0;
      }
    });
  }

  attachPortEvents(candidate, generation, sessionId) {
    candidate.on("data", (chunk) => {
      if (generation !== this.generation || this.port !== candidate) return;
      this.emit("data", {
        sessionId,
        sequence: ++this.sequence,
        timestamp: Date.now(),
        bytes: Array.from(chunk),
      });
    });

    candidate.on("error", (error) => {
      if (generation !== this.generation) return;
      this.lastError = String(error && error.message || error);
      this.emit("serial-error", { sessionId, message: this.lastError });
      this.emitStatus();
    });

    candidate.on("close", () => {
      if (generation !== this.generation || this.port !== candidate) return;
      this.port = null;
      this.status = "closed";
      this.emitStatus();
    });
  }

  write(rawBytes) {
    const bytes = normalizeBytes(rawBytes);
    if (this.transitionGeneration) return Promise.reject(new Error("serial lifecycle transition is in progress"));
    const port = this.port;
    const sessionId = this.sessionId;

    const operation = async () => {
      if (!port || this.port !== port || !port.isOpen || this.status !== "open") {
        throw new Error("serial port is not open");
      }
      await callWithCallback(port, "write", Buffer.from(bytes));
      await callWithCallback(port, "drain");
      const event = {
        sessionId,
        sequence: ++this.sequence,
        timestamp: Date.now(),
        bytes: bytes.slice(),
      };
      this.emit("write", event);
      return event;
    };

    return this.enqueueIo(operation);
  }

  async setSignals(signals) {
    if (this.transitionGeneration) throw new Error("serial lifecycle transition is in progress");
    const port = this.port;
    if (!port || !port.isOpen || this.status !== "open") throw new Error("serial port is not open");
    if (!signals || typeof signals !== "object") throw new TypeError("signals are required");
    const allowed = ["brk", "cts", "dtr", "rts"];
    const options = {};
    for (const key of allowed) {
      if (!Object.prototype.hasOwnProperty.call(signals, key)) continue;
      if (typeof signals[key] !== "boolean") throw new TypeError(`${key} must be boolean`);
      options[key] = signals[key];
    }
    if (Object.keys(options).length === 0) throw new RangeError("no supported signals were supplied");
    return this.enqueueIo(async () => {
      if (this.port !== port || !port.isOpen || this.status !== "open") throw new Error("serial port is not open");
      await callWithCallback(port, "set", options);
      return { ...(await callWithResult(port, "get")) };
    });
  }

  async getSignals() {
    if (this.transitionGeneration) throw new Error("serial lifecycle transition is in progress");
    const port = this.port;
    if (!port || !port.isOpen || this.status !== "open") throw new Error("serial port is not open");
    return this.enqueueIo(async () => {
      if (this.port !== port || !port.isOpen || this.status !== "open") throw new Error("serial port is not open");
      return { ...(await callWithResult(port, "get")) };
    });
  }

  async flush() {
    if (this.transitionGeneration) throw new Error("serial lifecycle transition is in progress");
    const port = this.port;
    if (!port || !port.isOpen || this.status !== "open") throw new Error("serial port is not open");
    return this.enqueueIo(async () => {
      if (this.port !== port || !port.isOpen || this.status !== "open") throw new Error("serial port is not open");
      await callWithCallback(port, "flush");
      return true;
    });
  }

  close() {
    const generation = ++this.generation;
    this.transitionGeneration = generation;
    return this.enqueueLifecycle(async () => {
      try {
        await this.writeTail.catch(() => undefined);
        await this.closeCurrent();
        this.options = null;
        this.lastError = null;
        this.status = "closed";
        return this.emitStatus();
      } catch (error) {
        this.status = "error";
        this.lastError = String(error && error.message || error);
        this.emitStatus();
        throw error;
      } finally {
        if (this.transitionGeneration === generation) this.transitionGeneration = 0;
      }
    });
  }

  async closeCurrent() {
    const current = this.port;
    if (!current) return;
    if (!current.isOpen) {
      if (this.port === current) this.port = null;
      return;
    }
    await callWithCallback(current, "close");
    if (this.port === current) this.port = null;
  }
}

module.exports = {
  SerialSession,
  normalizeOptions,
  normalizeBytes,
  MAX_WRITE_BYTES,
};
