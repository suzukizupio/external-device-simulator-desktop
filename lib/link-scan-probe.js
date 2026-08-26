"use strict";

const CODE = Object.freeze({ STX: 0x02, ENQ: 0x05, ACK: 0x06 });

function normalizeBytes(chunk) {
  if (!chunk || typeof chunk.length !== "number") throw new TypeError("受信データはバイト配列で指定してください");
  const bytes = Array.from(chunk);
  for (const byte of bytes) {
    if (!Number.isInteger(byte) || byte < 0 || byte > 0xFF) throw new RangeError("受信データに0～255以外の値が含まれています");
  }
  return bytes;
}

// 通信条件判別中の最小限のハンドシェイク。
// STX本文が始まる前のENQだけへACKを返し、本文中の05Hを制御コードと誤認しない。
class LinkScanProbe {
  constructor(options) {
    const opts = options || {};
    if (opts.respondToEnq !== undefined && typeof opts.respondToEnq !== "boolean") {
      throw new TypeError("respondToEnq はbooleanで指定してください");
    }
    const maxAcks = opts.maxAcks == null ? 3 : Number(opts.maxAcks);
    if (!Number.isInteger(maxAcks) || maxAcks < 1 || maxAcks > 8) {
      throw new RangeError("maxAcks は1～8で指定してください");
    }
    this.respondToEnq = opts.respondToEnq !== false;
    this.maxAcks = maxAcks;
    this.observedEnq = 0;
    this.acksSent = 0;
    this.frameStarted = false;
  }

  receive(chunk) {
    const replies = [];
    for (const byte of normalizeBytes(chunk)) {
      if (byte === CODE.STX) {
        this.frameStarted = true;
        continue;
      }
      if (this.frameStarted || byte !== CODE.ENQ) continue;
      this.observedEnq += 1;
      if (this.respondToEnq && this.acksSent < this.maxAcks) {
        this.acksSent += 1;
        replies.push(CODE.ACK);
      }
    }
    return replies;
  }

  snapshot() {
    return Object.freeze({
      respondToEnq: this.respondToEnq,
      observedEnq: this.observedEnq,
      acksSent: this.acksSent,
      frameStarted: this.frameStarted,
    });
  }
}

module.exports = { CODE, LinkScanProbe };
