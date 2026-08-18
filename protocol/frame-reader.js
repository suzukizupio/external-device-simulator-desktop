// 受信バイト列を機種ごとのフレーム境界で切り出す共通リーダー。
// マンションコントローラ(Q48-008I)は既存の StreamDecoder へ委譲し、
// それ以外の機種は仕様上の固定長または長さフィールドから総バイト数を求める。
// Browser: window.FrameReader / Node: require("./frame-reader.js")
(function (root, factory) {
  "use strict";
  if (typeof module !== "undefined" && module.exports) {
    module.exports = factory(require("./stream-decoder.js"));
  } else {
    root.FrameReader = factory(root.StreamDecoder);
  }
})(typeof window !== "undefined" ? window : globalThis, function (StreamDecoder) {
  "use strict";

  if (!StreamDecoder) throw new Error("StreamDecoder is required before FrameReader");

  const STX = 0x02;
  const ETX = 0x03;
  const TRANSPORT_CONTROLS = new Set([0x04, 0x05, 0x06, 0x15]);
  const MAX_BUFFER = 1100;
  const MANSION = "mansion";

  function toBytes(chunk) {
    if (!chunk || typeof chunk.length !== "number") throw new TypeError("受信データはバイト配列で指定してください");
    const bytes = Array.from(chunk);
    for (const byte of bytes) {
      if (!Number.isInteger(byte) || byte < 0 || byte > 0xFF) throw new RangeError("受信データに0～255以外の値が含まれています");
    }
    return bytes;
  }

  // 総バイト数を返す。null=まだ判定できない、-1=フレームとして成立しない。
  function locker4Length(buffer) {
    if (buffer.length < 6) return null;
    const text = String.fromCharCode(buffer[3], buffer[4], buffer[5]);
    if (!/^\d{3}$/.test(text)) return -1;
    const total = Number(text) + 8;
    return total < 23 ? -1 : total;
  }

  function keyLength(buffer) {
    const etx = buffer.indexOf(ETX, 1);
    if (etx === -1) return null;
    const total = etx + 2;
    return total === 10 || total === 13 ? total : -1;
  }

  const RULES = Object.freeze({
    locker2: { length: () => 11, resyncOnStx: true },
    locker4: { length: locker4Length, resyncOnStx: true },
    key: { length: keyLength, resyncOnStx: true },
    elevator: { length: () => 21, resyncOnStx: true },
    // 警報電文は発報元と履歴番号が生バイトのため、電文中に02Hが現れる。
    // 固定長で読み切り、STXでの再同期は行わない。
    alarm: { length: () => 11, resyncOnStx: false },
  });

  function controlEvent(code) {
    return { type: "control", code };
  }

  function errorEvent(code, message, bytes) {
    return { type: "error", code, message, bytes: bytes ? bytes.slice() : [] };
  }

  // StreamDecoder のイベントを FrameReader 共通の形へそろえる。
  function fromDecoderEvent(event) {
    if (event.type === "control") return controlEvent(event.code);
    if (event.type === "frame") return { type: "frame", bytes: event.raw.slice(), parsed: event.frame };
    const code = event.error && event.error.code ? event.error.code : "DECODE_ERROR";
    // EOTはQ48-008Iでは使わないが、誤接続の切り分けのため他機種と同じ伝送制御として扱う。
    if (code === "UNEXPECTED_BYTE" && event.raw.length === 1 && TRANSPORT_CONTROLS.has(event.raw[0])) {
      return controlEvent(event.raw[0]);
    }
    return errorEvent(code, event.error ? event.error.message : "受信データを解釈できません", event.raw);
  }

  class FrameReader {
    constructor(profile, options) {
      this.profile = String(profile == null ? "" : profile);
      this.rule = Object.prototype.hasOwnProperty.call(RULES, this.profile) ? RULES[this.profile] : null;
      this.decoder = this.profile === MANSION ? new StreamDecoder(options || {}) : null;
      this.buffer = [];
    }

    get bufferedLength() {
      return this.decoder ? this.decoder.bufferedLength : this.buffer.length;
    }

    reset() {
      this.buffer = [];
      if (this.decoder) this.decoder.reset();
    }

    push(chunk) {
      const bytes = toBytes(chunk);
      if (this.decoder) return this.decoder.push(bytes).map(fromDecoderEvent);
      const events = [];
      if (!this.rule) {
        for (const byte of bytes) if (TRANSPORT_CONTROLS.has(byte)) events.push(controlEvent(byte));
        return events;
      }
      for (const byte of bytes) this._consume(byte, events);
      return events;
    }

    flush() {
      if (this.decoder) return this.decoder.flush().map(fromDecoderEvent);
      if (this.buffer.length === 0) return [];
      const raw = this.buffer.slice();
      this.buffer = [];
      return [errorEvent("TRUNCATED_FRAME", "STXで始まったフレームが完結していません", raw)];
    }

    _expectedLength() {
      const expected = this.rule.length(this.buffer);
      return expected == null ? null : expected;
    }

    _consume(byte, events) {
      if (this.buffer.length === 0) {
        if (byte === STX) this.buffer.push(byte);
        else if (TRANSPORT_CONTROLS.has(byte)) events.push(controlEvent(byte));
        return;
      }

      // 長さが確定した後の最終バイトはBCCで、STXと同値になりうる。
      // ここで再同期すると仕様どおりの電文を最後の1バイトで捨ててしまう。
      const expectedBefore = this._expectedLength();
      const atFinalByte = expectedBefore != null && expectedBefore > 0 && this.buffer.length === expectedBefore - 1;
      if (byte === STX && this.rule.resyncOnStx && !atFinalByte) {
        const abandoned = this.buffer.slice();
        this.buffer = [STX];
        events.push(errorEvent("UNEXPECTED_STX", "未完了フレーム内でSTXを受信したため新しいフレームへ再同期しました", abandoned));
        return;
      }

      this.buffer.push(byte);
      const expected = this._expectedLength();
      if (expected === -1 || this.buffer.length > MAX_BUFFER) {
        const raw = this.buffer.slice();
        this.buffer = [];
        events.push(errorEvent("INVALID_FRAME", "フレーム長またはヘッダが仕様に合いません", raw));
        return;
      }
      if (expected != null && expected > 0 && this.buffer.length === expected) {
        const raw = this.buffer.slice();
        this.buffer = [];
        events.push({ type: "frame", bytes: raw });
      }
    }
  }

  Object.defineProperties(FrameReader, {
    FrameReader: { value: FrameReader, enumerable: true },
    PROFILES: { value: Object.freeze(Object.keys(RULES).concat(MANSION)), enumerable: true },
    TRANSPORT_CONTROLS: { value: Object.freeze(Array.from(TRANSPORT_CONTROLS)), enumerable: true },
  });

  return FrameReader;
});
