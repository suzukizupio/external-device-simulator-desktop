// Deterministic fault injection shared by every simulator profile.
(function (global) {
  "use strict";

  const ACTION = Object.freeze({
    PASS: "pass",
    DROP: "drop",
    DELAY: "delay",
    REPLACE: "replace",
    CORRUPT_LAST: "corrupt-last",
    OMIT_LAST: "omit-last",
    DUPLICATE_STX: "duplicate-stx",
  });

  function byteArray(value, name = "bytes") {
    const bytes = Array.from(value || []);
    for (const byte of bytes) {
      if (!Number.isInteger(byte) || byte < 0 || byte > 0xFF) throw new RangeError(`${name} contains a non-byte value`);
    }
    return bytes;
  }

  function normalizeRule(rule, index) {
    if (!rule || typeof rule !== "object") throw new TypeError("fault rule must be an object");
    const action = rule.action || ACTION.PASS;
    if (!Object.values(ACTION).includes(action)) throw new RangeError(`unsupported fault action: ${action}`);
    const occurrence = rule.occurrence == null ? "every" : rule.occurrence;
    if (occurrence !== "every" && (!Number.isInteger(occurrence) || occurrence < 1)) {
      throw new RangeError("occurrence must be 'every' or a positive integer");
    }
    const delayMs = rule.delayMs == null ? 0 : Number(rule.delayMs);
    if (!Number.isFinite(delayMs) || delayMs < 0 || delayMs > 3_600_000) throw new RangeError("delayMs is out of range");
    return Object.freeze({
      id: String(rule.id || `rule-${index + 1}`),
      enabled: rule.enabled !== false,
      phase: rule.phase == null ? "*" : String(rule.phase),
      direction: rule.direction == null ? "*" : String(rule.direction),
      occurrence,
      action,
      delayMs,
      replacement: rule.replacement == null ? null : byteArray(rule.replacement, "replacement"),
      note: String(rule.note || ""),
    });
  }

  class FaultPlan {
    constructor(rules) {
      this.rules = Array.from(rules || [], normalizeRule);
      this.counts = new Map();
    }

    reset() {
      this.counts.clear();
    }

    apply(event) {
      if (!event || typeof event !== "object") throw new TypeError("event is required");
      const phase = String(event.phase || "frame");
      const direction = String(event.direction || "tx");
      const original = byteArray(event.bytes);

      for (const rule of this.rules) {
        if (!rule.enabled) continue;
        if (rule.phase !== "*" && rule.phase !== phase) continue;
        if (rule.direction !== "*" && rule.direction !== direction) continue;
        const count = (this.counts.get(rule.id) || 0) + 1;
        this.counts.set(rule.id, count);
        if (rule.occurrence !== "every" && count !== rule.occurrence) continue;

        let bytes = original.slice();
        if (rule.action === ACTION.DROP) bytes = null;
        else if (rule.action === ACTION.REPLACE) bytes = rule.replacement.slice();
        else if (rule.action === ACTION.CORRUPT_LAST) {
          if (bytes.length === 0) throw new RangeError("cannot corrupt an empty frame");
          bytes[bytes.length - 1] ^= 0x01;
        } else if (rule.action === ACTION.OMIT_LAST) {
          if (bytes.length === 0) throw new RangeError("cannot truncate an empty frame");
          bytes.pop();
        } else if (rule.action === ACTION.DUPLICATE_STX) {
          if (bytes[0] !== 0x02) throw new RangeError("duplicate-stx requires an STX-prefixed frame");
          bytes.splice(1, 0, 0x02);
        }

        return {
          bytes,
          delayMs: rule.action === ACTION.DELAY ? rule.delayMs : 0,
          applied: true,
          ruleId: rule.id,
          action: rule.action,
          count,
          note: rule.note,
        };
      }

      return { bytes: original, delayMs: 0, applied: false, ruleId: null, action: ACTION.PASS, count: 0, note: "" };
    }
  }

  function createPreset(name, options) {
    const opts = options || {};
    if (name === "none") return new FaultPlan([]);
    if (name === "bad-bcc") return new FaultPlan([{ phase: "frame", action: ACTION.CORRUPT_LAST }]);
    if (name === "missing-bcc") return new FaultPlan([{ phase: "frame", action: ACTION.OMIT_LAST }]);
    if (name === "no-response") return new FaultPlan([{ direction: "rx-response", action: ACTION.DROP }]);
    if (name === "nak-once") return new FaultPlan([{ phase: "response", occurrence: 1, action: ACTION.REPLACE, replacement: [0x15] }]);
    if (name === "delay") return new FaultPlan([{ phase: opts.phase || "response", action: ACTION.DELAY, delayMs: opts.delayMs || 1000 }]);
    throw new RangeError(`unknown fault preset: ${name}`);
  }

  const api = { ACTION, FaultPlan, createPreset };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else global.FaultEngine = api;
}(typeof window !== "undefined" ? window : globalThis));
