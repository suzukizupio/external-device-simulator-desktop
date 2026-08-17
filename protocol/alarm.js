// Q49-023G alarm transmitter interface telegram codec (Ver.1.22).
// Browser: window.AlarmProtocol / Node: require("./protocol/alarm.js")
(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.AlarmProtocol = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";

  const CODE = Object.freeze({ STX: 0x02, ETX: 0x03, ENQ: 0x05, ACK: 0x06, NAK: 0x15 });
  const SIZE = 0x37; // ASCII "7"
  const TYPE = Object.freeze({
    ALARM_1: 0x00,
    ALARM_2: 0x01,
    SECURITY_SET: 0x04,
    SECURITY_CLEAR: 0x44,
    HISTORY_REQUEST: 0x30,
  });
  const TYPE_NAME = Object.freeze({
    0x00: "alarm1",
    0x01: "alarm2",
    0x04: "securitySet",
    0x44: "securityClear",
    0x30: "historyRequest",
  });
  const SOURCE_KIND = Object.freeze({
    NONE: "none",
    DWELLING: "dwelling",
    MANAGEMENT: "management",
    ENTRANCE: "entrance",
    COMMON: "common",
  });

  function own(object, key) {
    return Object.prototype.hasOwnProperty.call(object, key);
  }

  function integer(value, min, max, name) {
    let number = value;
    if (typeof value === "string" && /^\d+$/.test(value)) number = Number(value);
    if (!Number.isSafeInteger(number) || number < min || number > max) {
      throw new RangeError(name + " must be an integer from " + min + " to " + max);
    }
    return number;
  }

  function byte(value, name) {
    return integer(value, 0, 0xFF, name);
  }

  function bytes(value, name) {
    if (value == null || typeof value.length !== "number") throw new TypeError(name + " must be byte array-like");
    const result = Array.from(value);
    result.forEach(function (item, index) { byte(item, name + "[" + index + "]"); });
    return result;
  }

  function resolveType(value) {
    const type = byte(value, "type");
    if (!own(TYPE_NAME, type)) throw new RangeError("unknown alarm transmission type: 0x" + type.toString(16));
    return type;
  }

  function encodeBCD(value) {
    const number = integer(value, 0, 99, "building number");
    return ((Math.floor(number / 10) << 4) | (number % 10)) & 0xFF;
  }

  function decodeBCD(value) {
    const encoded = byte(value, "BCD value");
    const high = encoded >> 4;
    const low = encoded & 0x0F;
    if (high > 9 || low > 9) throw new RangeError("invalid BCD building number");
    return high * 10 + low;
  }

  function decimalDigitBytes(value, width, name) {
    const number = integer(value, 0, Math.pow(10, width) - 1, name);
    return Array.from(String(number).padStart(width, "0"), function (digit) { return Number(digit); });
  }

  function sourceNone() {
    return { kind: SOURCE_KIND.NONE };
  }

  function sourceDwelling(roomNo) {
    return { kind: SOURCE_KIND.DWELLING, number: integer(roomNo, 0, 9999, "dwelling number") };
  }

  function sourceManagement(number) {
    return { kind: SOURCE_KIND.MANAGEMENT, number: integer(number, 0, 999, "management station number") };
  }

  function sourceEntrance(number) {
    return { kind: SOURCE_KIND.ENTRANCE, number: integer(number, 0, 999, "entrance station number") };
  }

  function sourceCommon() {
    return { kind: SOURCE_KIND.COMMON };
  }

  function encodeSource(source) {
    if (source == null) return [0x00, 0x00, 0x00, 0x00];
    if (typeof source === "string") source = { kind: source };
    if (typeof source !== "object" || Array.isArray(source) || ArrayBuffer.isView(source)) {
      throw new TypeError("source must be a source descriptor object");
    }
    switch (source.kind) {
      case SOURCE_KIND.NONE:
        return [0x00, 0x00, 0x00, 0x00];
      case SOURCE_KIND.DWELLING:
        return decimalDigitBytes(source.number == null ? source.roomNo : source.number, 4, "dwelling number");
      case SOURCE_KIND.MANAGEMENT:
        return [0x0C].concat(decimalDigitBytes(source.number, 3, "management station number"));
      case SOURCE_KIND.ENTRANCE:
        return [0x0D].concat(decimalDigitBytes(source.number, 3, "entrance station number"));
      case SOURCE_KIND.COMMON:
        return [0x0C, 0x0A, 0x00, 0x00];
      default:
        throw new RangeError("unknown alarm source kind: " + source.kind);
    }
  }

  function addHistoryNumber(sourceBytes, historyNumber) {
    const source = bytes(sourceBytes, "sourceBytes");
    if (source.length !== 4) throw new Error("source must be exactly four bytes");
    source.forEach(function (item) {
      if ((item & 0xF0) !== 0) throw new Error("source already contains a history number");
    });
    const number = integer(historyNumber, 0, 15, "history number");
    return source.map(function (item) { return (number << 4) | item; });
  }

  function decodeSource(sourceBytes) {
    const source = bytes(sourceBytes, "sourceBytes");
    if (source.length !== 4) throw new Error("source must be exactly four bytes");
    const historyNumber = source[0] >> 4;
    if (!source.every(function (item) { return (item >> 4) === historyNumber; })) {
      throw new Error("history number must be identical in all four source bytes");
    }
    const value = source.map(function (item) { return item & 0x0F; });
    let kind;
    let number = null;
    if (value.every(function (item) { return item === 0; })) {
      kind = SOURCE_KIND.NONE;
      number = 0;
    } else if (value[0] === 0x0C && value[1] === 0x0A && value[2] === 0 && value[3] === 0) {
      kind = SOURCE_KIND.COMMON;
    } else if (value[0] === 0x0C && value.slice(1).every(function (item) { return item <= 9; })) {
      kind = SOURCE_KIND.MANAGEMENT;
      number = value[1] * 100 + value[2] * 10 + value[3];
    } else if (value[0] === 0x0D && value.slice(1).every(function (item) { return item <= 9; })) {
      kind = SOURCE_KIND.ENTRANCE;
      number = value[1] * 100 + value[2] * 10 + value[3];
    } else if (value.every(function (item) { return item <= 9; })) {
      kind = SOURCE_KIND.DWELLING;
      number = value[0] * 1000 + value[1] * 100 + value[2] * 10 + value[3];
    } else {
      throw new Error("invalid alarm source encoding");
    }
    return {
      kind: kind,
      number: number,
      historyNumber: historyNumber,
      baseBytes: value,
      bytes: source,
    };
  }

  function calculateBCC(frameWithoutBcc) {
    const frame = bytes(frameWithoutBcc, "frameWithoutBcc");
    if (frame.length < 2 || frame[0] !== CODE.STX) throw new Error("BCC input must start with STX");
    let bcc = 0;
    for (let index = 1; index < frame.length; index += 1) bcc = (bcc + frame[index]) & 0xFF;
    return bcc;
  }

  function verifyBCC(frame) {
    try {
      const packet = bytes(frame, "frame");
      if (packet.length < 3 || packet[0] !== CODE.STX) return false;
      return calculateBCC(packet.slice(0, -1)) === packet[packet.length - 1];
    } catch (_error) {
      return false;
    }
  }

  function sourceOption(options) {
    if (own(options, "source")) return options.source;
    if (own(options, "roomNo")) return sourceDwelling(options.roomNo);
    if (own(options, "managementNo")) return sourceManagement(options.managementNo);
    if (own(options, "entranceNo")) return sourceEntrance(options.entranceNo);
    if (options.common === true) return sourceCommon();
    return sourceNone();
  }

  function buildFrame(options) {
    if (options == null || typeof options !== "object") throw new TypeError("options are required");
    const type = resolveType(options.type);
    const info = byte(options.info == null ? 0 : options.info, "alarm information");
    const buildingNo = integer(options.buildingNo == null ? 0 : options.buildingNo, 0, 99, "building number");
    const sourceBase = encodeSource(sourceOption(options));
    const historyNumber = integer(options.historyNumber == null ? 0 : options.historyNumber, 0, 15, "history number");

    if (historyNumber !== 0 && type !== TYPE.ALARM_1 && type !== TYPE.ALARM_2) {
      throw new Error("history numbers are valid only for alarm information 1 or 2");
    }
    if (type === TYPE.HISTORY_REQUEST) {
      if (info !== 0 || buildingNo !== 0 || sourceBase.some(function (item) { return item !== 0; }) || historyNumber !== 0) {
        throw new Error("history request requires zero information, building, source, and history number");
      }
    }

    const source = addHistoryNumber(sourceBase, historyNumber);
    const frame = [CODE.STX, SIZE, type, info, encodeBCD(buildingNo)].concat(source, [CODE.ETX]);
    if (frame.length !== 10) throw new Error("internal alarm frame length error");
    frame.push(calculateBCC(frame));
    return frame;
  }

  function parseFrame(value) {
    const frame = bytes(value, "frame");
    if (frame.length !== 11) throw new Error("alarm frame must be exactly 11 bytes");
    if (frame[0] !== CODE.STX) throw new Error("invalid alarm STX");
    if (frame[1] !== SIZE) throw new Error("alarm SIZE must be 0x37");
    if (frame[9] !== CODE.ETX) throw new Error("invalid alarm ETX");
    if (!verifyBCC(frame)) throw new Error("invalid alarm BCC");

    const type = resolveType(frame[2]);
    const info = frame[3];
    const buildingNo = decodeBCD(frame[4]);
    const source = decodeSource(frame.slice(5, 9));
    if (source.historyNumber !== 0 && type !== TYPE.ALARM_1 && type !== TYPE.ALARM_2) {
      throw new Error("history number is invalid for this transmission type");
    }
    if (type === TYPE.HISTORY_REQUEST) {
      if (info !== 0 || buildingNo !== 0 || source.kind !== SOURCE_KIND.NONE || source.historyNumber !== 0) {
        throw new Error("malformed history request");
      }
    }

    return {
      type: type,
      typeName: TYPE_NAME[type],
      info: info,
      buildingNo: buildingNo,
      buildingByte: frame[4],
      source: source,
      historyNumber: source.historyNumber,
      bcc: frame[10],
      bytes: frame.slice(),
    };
  }

  function validateFrame(frame) {
    try {
      parseFrame(frame);
      return true;
    } catch (_error) {
      return false;
    }
  }

  function descriptorFromSource(source) {
    switch (source.kind) {
      case SOURCE_KIND.NONE: return sourceNone();
      case SOURCE_KIND.DWELLING: return sourceDwelling(source.number);
      case SOURCE_KIND.MANAGEMENT: return sourceManagement(source.number);
      case SOURCE_KIND.ENTRANCE: return sourceEntrance(source.number);
      case SOURCE_KIND.COMMON: return sourceCommon();
      default: throw new Error("cannot copy unknown source kind");
    }
  }

  function normalizeHistoryEntry(entry) {
    let parsed;
    if (entry != null && typeof entry.length === "number" && typeof entry !== "string") {
      parsed = parseFrame(entry);
    } else if (entry != null && typeof entry === "object") {
      parsed = parseFrame(buildFrame(entry));
    } else {
      throw new TypeError("history entry must be an alarm frame or frame options");
    }
    if (parsed.type !== TYPE.ALARM_1 && parsed.type !== TYPE.ALARM_2) {
      throw new Error("only alarm information 1 and 2 are retained in history");
    }
    if (parsed.historyNumber !== 0) throw new Error("a history response cannot be recorded as a new alarm event");
    return {
      type: parsed.type,
      info: parsed.info,
      buildingNo: parsed.buildingNo,
      source: descriptorFromSource(parsed.source),
    };
  }

  class AlarmHistory {
    constructor(options) {
      if (typeof options === "number") options = { capacity: options };
      options = options || {};
      this.capacity = integer(options.capacity == null ? 15 : options.capacity, 1, 15, "history capacity");
      this.emptyBuildingNo = integer(options.emptyBuildingNo == null ? 0 : options.emptyBuildingNo, 0, 99, "empty-history building number");
      this._entries = [];
      this._cursor = 0;
    }

    get size() {
      return this._entries.length;
    }

    clear() {
      this._entries = [];
      this._cursor = 0;
    }

    resetCursor() {
      this._cursor = 0;
    }

    add(entry) {
      this._entries.unshift(normalizeHistoryEntry(entry));
      if (this._entries.length > this.capacity) this._entries.length = this.capacity;
      this._cursor = 0;
      return this;
    }

    record(entry) {
      return this.add(entry);
    }

    next() {
      if (this._entries.length === 0) {
        return {
          type: TYPE.ALARM_1,
          info: 0,
          buildingNo: this.emptyBuildingNo,
          source: sourceNone(),
          historyNumber: 1,
          empty: true,
        };
      }
      const index = this._cursor;
      const entry = this._entries[index];
      this._cursor = (index + 1) % this._entries.length;
      return {
        type: entry.type,
        info: entry.info,
        buildingNo: entry.buildingNo,
        source: Object.assign({}, entry.source),
        historyNumber: index + 1,
        empty: false,
      };
    }

    nextFrame() {
      return buildFrame(this.next());
    }

    toArray() {
      return this._entries.map(function (entry) {
        return {
          type: entry.type,
          info: entry.info,
          buildingNo: entry.buildingNo,
          source: Object.assign({}, entry.source),
        };
      });
    }
  }

  function toHex(value) {
    return bytes(value, "value").map(function (item) { return item.toString(16).toUpperCase().padStart(2, "0"); }).join(" ");
  }

  return Object.freeze({
    CODE: CODE,
    SIZE: SIZE,
    TYPE: TYPE,
    TYPE_NAME: TYPE_NAME,
    SOURCE_KIND: SOURCE_KIND,
    encodeBCD: encodeBCD,
    decodeBCD: decodeBCD,
    sourceNone: sourceNone,
    sourceDwelling: sourceDwelling,
    sourceManagement: sourceManagement,
    sourceEntrance: sourceEntrance,
    sourceCommon: sourceCommon,
    encodeSource: encodeSource,
    decodeSource: decodeSource,
    addHistoryNumber: addHistoryNumber,
    applyHistoryNumber: addHistoryNumber,
    calculateBCC: calculateBCC,
    calcBCC: calculateBCC,
    verifyBCC: verifyBCC,
    build: buildFrame,
    buildFrame: buildFrame,
    buildTelegram: buildFrame,
    parse: parseFrame,
    parseFrame: parseFrame,
    parseTelegram: parseFrame,
    validate: validateFrame,
    validateFrame: validateFrame,
    AlarmHistory: AlarmHistory,
    toHex: toHex,
  });
});
