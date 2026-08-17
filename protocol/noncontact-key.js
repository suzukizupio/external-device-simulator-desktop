// Q48-006F 非接触キー通信 Ver.1.15
(function (global) {
  "use strict";

  const CODE = Object.freeze({ STX: 0x02, ETX: 0x03, ACK: 0x06, NAK: 0x15 });
  const FORMAT = Object.freeze({ WITH_PERSON: "withPerson", ROOM_ONLY: "roomOnly" });
  const FORMAT_LABEL = Object.freeze({
    withPerson: "13バイト（ゲート＋ルーム＋個人番号）",
    roomOnly: "10バイト（ゲート＋ルーム）",
  });

  function integerInRange(value, name, min, max) {
    const number = Number(value);
    if (!Number.isInteger(number) || number < min || number > max) {
      throw new RangeError(`${name} must be an integer from ${min} to ${max}`);
    }
    return number;
  }

  function asciiDigits(value, width, name = "value") {
    const number = integerInRange(value, name, 0, (10 ** width) - 1);
    return Array.from(String(number).padStart(width, "0"), (character) => character.charCodeAt(0));
  }

  function asciiDigitString(value, width, name = "value") {
    const string = String(value == null ? "" : value);
    if (!new RegExp(`^\\d{${width}}$`).test(string)) {
      throw new RangeError(`${name} must contain exactly ${width} ASCII digits`);
    }
    return Array.from(string, (character) => character.charCodeAt(0));
  }

  function room5(options) {
    const opts = options || {};
    if (opts.roomNo5 != null && String(opts.roomNo5) !== "") {
      return asciiDigitString(opts.roomNo5, 5, "roomNo5");
    }
    const buildingNo = integerInRange(opts.buildingNo == null ? 0 : opts.buildingNo, "buildingNo", 0, 9);
    const roomNo = integerInRange(opts.roomNo, "roomNo", 0, 9999);
    return [0x30 + buildingNo, ...asciiDigits(roomNo, 4, "roomNo")];
  }

  function calcBCC(frameWithoutBcc) {
    const frame = Array.from(frameWithoutBcc || []);
    if (frame.length < 2 || frame[0] !== CODE.STX || frame[frame.length - 1] !== CODE.ETX) {
      throw new RangeError("frame must start with STX and end with ETX");
    }
    let value = 0;
    for (let index = 1; index < frame.length; index += 1) value ^= frame[index];
    return value & 0xFF;
  }

  function verifyBCC(packet) {
    const bytes = Array.from(packet || []);
    if (bytes.length < 4 || bytes[0] !== CODE.STX || bytes[bytes.length - 2] !== CODE.ETX) return false;
    let value = 0;
    for (let index = 1; index < bytes.length; index += 1) value ^= bytes[index];
    return (value & 0xFF) === 0;
  }

  function buildTelegram(options) {
    const opts = options || {};
    const format = opts.format || FORMAT.WITH_PERSON;
    if (!Object.values(FORMAT).includes(format)) throw new RangeError("unsupported telegram format");
    const personMax = opts.personMax == null ? 999 : integerInRange(opts.personMax, "personMax", 0, 999);
    const body = [
      ...asciiDigits(integerInRange(opts.gateNo, "gateNo", 1, 99), 2, "gateNo"),
      ...room5(opts),
    ];
    if (format === FORMAT.WITH_PERSON) {
      body.push(...asciiDigits(integerInRange(opts.personNo, "personNo", 0, personMax), 3, "personNo"));
    }
    const frame = [CODE.STX, ...body, CODE.ETX];
    frame.push(calcBCC(frame));
    return frame;
  }

  function parseTelegram(packet, options) {
    const bytes = Array.from(packet || []);
    if (bytes.length !== 10 && bytes.length !== 13) throw new RangeError("telegram must be exactly 10 or 13 bytes");
    if (bytes[0] !== CODE.STX || bytes[bytes.length - 2] !== CODE.ETX) throw new RangeError("invalid STX/ETX");
    if (!verifyBCC(bytes)) throw new RangeError("invalid BCC");
    const body = bytes.slice(1, -2);
    if (!body.every((byte) => byte >= 0x30 && byte <= 0x39)) throw new RangeError("message fields must be ASCII digits");
    const string = String.fromCharCode(...body);
    const format = bytes.length === 13 ? FORMAT.WITH_PERSON : FORMAT.ROOM_ONLY;
    const parsed = {
      format,
      gateNo: Number(string.slice(0, 2)),
      roomNo5: string.slice(2, 7),
      buildingNo: Number(string[2]),
      roomNo: Number(string.slice(3, 7)),
      personNo: format === FORMAT.WITH_PERSON ? Number(string.slice(7, 10)) : null,
      bcc: bytes[bytes.length - 1],
      bytes,
    };
    integerInRange(parsed.gateNo, "gateNo", 1, 99);
    const personMax = options && options.personMax != null ? options.personMax : 999;
    if (parsed.personNo != null) integerInRange(parsed.personNo, "personNo", 0, personMax);
    return parsed;
  }

  function corruptBCC(packet) {
    const copy = Array.from(packet || []);
    if (copy.length === 0) throw new RangeError("packet is empty");
    copy[copy.length - 1] ^= 0x01;
    return copy;
  }

  class NoncontactReceiver {
    constructor(options) {
      this.options = options || {};
      this.reset();
    }

    reset() {
      this.packet = null;
      this.waitingForBCC = false;
    }

    push(chunk) {
      const events = [];
      for (const byte of Array.from(chunk || [])) {
        if (byte === CODE.STX) {
          this.packet = [CODE.STX];
          this.waitingForBCC = false;
          continue;
        }
        if (!this.packet) continue;
        if (this.waitingForBCC) {
          this.packet.push(byte);
          const packet = this.packet.slice();
          const bccValid = verifyBCC(packet);
          let parsed = null;
          let error = null;
          try { parsed = parseTelegram(packet, this.options); } catch (caught) { error = caught.message; }
          events.push({
            type: "frame",
            packet,
            bccValid,
            lengthValid: packet.length === 10 || packet.length === 13,
            accepted: Boolean(parsed),
            response: bccValid ? CODE.ACK : CODE.NAK,
            parsed,
            error,
          });
          this.reset();
          continue;
        }
        if (byte === CODE.ETX) {
          this.packet.push(byte);
          this.waitingForBCC = true;
          continue;
        }
        if (byte < 0x30 || byte > 0x39) {
          events.push({ type: "reset", reason: "invalid-character", byte });
          this.reset();
          continue;
        }
        this.packet.push(byte);
      }
      return events;
    }
  }

  class NoncontactSender {
    constructor({ maxRetries = 5 } = {}) {
      this.maxRetries = integerInRange(maxRetries, "maxRetries", 0, 99);
      this.state = "idle";
      this.attempts = 0;
      this.packet = null;
    }

    start(packet) {
      if (this.state === "waiting") throw new Error("a telegram is already pending");
      parseTelegram(packet);
      this.packet = Array.from(packet);
      this.attempts = 1;
      this.state = "waiting";
      return { type: "send", packet: this.packet.slice(), attempt: this.attempts };
    }

    onControl(code) {
      if (this.state !== "waiting") return { type: "ignored", code };
      if (code === CODE.ACK) {
        this.state = "complete";
        return { type: "complete", attempts: this.attempts };
      }
      if (code !== CODE.NAK) return { type: "ignored", code };
      if (this.attempts > this.maxRetries) {
        this.state = "failed";
        return { type: "failed", reason: "nak-limit", attempts: this.attempts };
      }
      this.attempts += 1;
      return { type: "send", packet: this.packet.slice(), attempt: this.attempts };
    }

    onTimeout() {
      if (this.state !== "waiting") return { type: "ignored", reason: "not-waiting" };
      this.state = "failed";
      return { type: "failed", reason: "timeout", attempts: this.attempts };
    }
  }

  function toHex(bytes) {
    return Array.from(bytes || [], (byte) => byte.toString(16).toUpperCase().padStart(2, "0")).join(" ");
  }

  function bytesToAscii(bytes) {
    return Array.from(bytes || [], (byte) => byte >= 0x20 && byte <= 0x7E ? String.fromCharCode(byte) : ".").join("");
  }

  const api = {
    CODE,
    FORMAT,
    FORMAT_LABEL,
    integerInRange,
    asciiDigits,
    asciiDigitString,
    room5,
    calcBCC,
    verifyBCC,
    buildTelegram,
    parseTelegram,
    corruptBCC,
    NoncontactReceiver,
    NoncontactSender,
    toHex,
    bytesToAscii,
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else global.NoncontactKey = api;
}(typeof window !== "undefined" ? window : globalThis));
