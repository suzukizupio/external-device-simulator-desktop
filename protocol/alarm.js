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

  // 5.2.2／5.2.3／5.2.4 の発信情報ビット割付。bit1がLSB(0x01)、bit8がMSB(0x80)。
  // 仕様書の表記は次のように写している。
  //   locked=true                  … ◇（対応付けを変更できない）
  //   label!==null, locked=false   … 割付あり（受注対応で変更できる）
  //   label===null, extensible     … ―（未割付。受注対応で追加できる）
  //   label===null, !extensible    … ×（未使用。追加も変更もできない）
  const BIT_PATTERN = Object.freeze({
    STANDARD: "standard",
    PATTERN_1: "pattern1",
    PATTERN_2: "pattern2",
    PATTERN_3: "pattern3",
  });
  const BIT_PATTERN_NAMES = Object.freeze(Object.keys(BIT_PATTERN).map(function (key) { return BIT_PATTERN[key]; }));

  function assignedBit(label) { return Object.freeze({ label: label, locked: false, extensible: true }); }
  function fixedBit(label) { return Object.freeze({ label: label, locked: true, extensible: false }); }
  const OPEN_BIT = Object.freeze({ label: null, locked: false, extensible: true });    // 仕様書の「―」
  const UNUSED_BIT = Object.freeze({ label: null, locked: false, extensible: false }); // 仕様書の「×」

  function bitRow(entries) {
    if (entries.length !== 8) throw new Error("a bit assignment row needs exactly eight entries");
    return Object.freeze(entries.slice());
  }

  function repeatBit(entry, count) {
    return new Array(count).fill(entry);
  }

  // 5.2.2／5.2.3のいずれのパターンでも警報情報①bit1～4は同じ割付。
  const ALARM1_HEAD = [
    assignedBit("火災、遠隔試験"),
    assignedBit("非常"),
    assignedBit("ガス漏れ"),
    assignedBit("ガス障害、火災障害"),
  ];
  // 5.2.3パターン２／３の警報情報②は同一の割付。
  const ALARM2_SECURITY = bitRow([
    OPEN_BIT, OPEN_BIT, OPEN_BIT,
    fixedBit("防犯１"), fixedBit("防犯２"), fixedBit("防犯３"),
    fixedBit("外出警戒"), fixedBit("在宅警戒"),
  ]);
  const ALARM_UNASSIGNED = bitRow(repeatBit(OPEN_BIT, 8));

  const BIT_ASSIGNMENTS = Object.freeze({
    // 警報情報①：標準は5.2.2、パターン１～３は5.2.3。
    [TYPE.ALARM_1]: Object.freeze({
      standard: bitRow(ALARM1_HEAD.concat([assignedBit("防犯(侵入)"), OPEN_BIT, OPEN_BIT, OPEN_BIT])),
      pattern1: bitRow(ALARM1_HEAD.concat([fixedBit("防犯(侵入)"), fixedBit("外出警戒"), fixedBit("在宅警戒"), OPEN_BIT])),
      pattern2: bitRow(ALARM1_HEAD.concat(repeatBit(OPEN_BIT, 4))),
      pattern3: bitRow(ALARM1_HEAD.concat([fixedBit("防犯４"), fixedBit("防犯５"), OPEN_BIT, OPEN_BIT])),
    }),
    // 警報情報②：初期状態では割付なし（5.2.2）。パターン２／３のみ防犯情報を持つ（5.2.3）。
    [TYPE.ALARM_2]: Object.freeze({
      standard: ALARM_UNASSIGNED,
      pattern1: ALARM_UNASSIGNED,
      pattern2: ALARM2_SECURITY,
      pattern3: ALARM2_SECURITY,
    }),
    // 警戒設定情報／警戒解除情報は5.2.4の受注対応のみ。標準割付は存在しない。
    [TYPE.SECURITY_SET]: Object.freeze({
      pattern1: bitRow([fixedBit("警戒設定")].concat(repeatBit(UNUSED_BIT, 7))),
      pattern2: bitRow([fixedBit("外出警戒設定"), fixedBit("在宅警戒設定")].concat(repeatBit(UNUSED_BIT, 6))),
      pattern3: bitRow([
        fixedBit("外出警戒設定"),
        fixedBit("在宅警戒１設定"), fixedBit("在宅警戒２設定"), fixedBit("在宅警戒３設定"),
        fixedBit("在宅警戒４設定"), fixedBit("在宅警戒５設定"),
        UNUSED_BIT, UNUSED_BIT,
      ]),
    }),
    // 仕様書p.11の警戒解除情報パターン３ bit1は「外出警戒設定」と印字されているが、
    // 同表パターン１「警戒解除」・パターン２「外出警戒解除」および本節の趣旨から解除側の
    // 誤記と判断し、「外出警戒解除」として扱う。電文上の値は変わらない。
    [TYPE.SECURITY_CLEAR]: Object.freeze({
      pattern1: bitRow([fixedBit("警戒解除")].concat(repeatBit(UNUSED_BIT, 7))),
      pattern2: bitRow([fixedBit("外出警戒解除"), fixedBit("在宅警戒解除")].concat(repeatBit(UNUSED_BIT, 6))),
      pattern3: bitRow([
        fixedBit("外出警戒解除"),
        fixedBit("在宅警戒１解除"), fixedBit("在宅警戒２解除"), fixedBit("在宅警戒３解除"),
        fixedBit("在宅警戒４解除"), fixedBit("在宅警戒５解除"),
        UNUSED_BIT, UNUSED_BIT,
      ]),
    }),
    // ヒストリー要求(5.2.5)は発信情報を持たず、全bitを"OFF"とする。
  });

  // 発信情報が00Hのときに何を意味するかは発信種別で異なる（5.2.1／5.2.4／5.2.5）。
  const EMPTY_INFO_TEXT = Object.freeze({
    [TYPE.ALARM_1]: "全復旧（全bit OFF）",
    [TYPE.ALARM_2]: "全復旧（全bit OFF）",
    [TYPE.SECURITY_SET]: "警戒中の項目なし",
    [TYPE.SECURITY_CLEAR]: "解除ありの項目なし",
    [TYPE.HISTORY_REQUEST]: "ヒストリー要求（発信情報なし）",
  });

  // 5.2.3（警報情報①②の防犯発報割付）と5.2.4（警戒設定情報／警戒解除情報の割付）は、
  // 仕様書でも選択できるパターンがシステムごとに別々に定められている（例：VIXUSは
  // 5.2.3がパターン１・３、5.2.4はパターン１・２・３）。dearisメンテナンスシステムでも
  // 「外部移報情報出力Bit割付」と「警戒設定・解除情報割付」の2項目に分かれているため、
  // { alarm: ..., guard: ... } で発信種別ごとの割付を指定できる。
  // 文字列を渡した場合は両方へ同じパターンを使う（従来の呼び出しとの互換）。
  function usesGuardPattern(type) {
    return type === TYPE.SECURITY_SET || type === TYPE.SECURITY_CLEAR;
  }

  function normalizeBitPattern(value) {
    const pattern = value == null ? BIT_PATTERN.STANDARD : String(value);
    if (BIT_PATTERN_NAMES.indexOf(pattern) === -1) throw new RangeError("unknown alarm bit pattern: " + pattern);
    return pattern;
  }

  function resolveBitPattern(value, type) {
    if (value != null && typeof value === "object") {
      return normalizeBitPattern(value[usesGuardPattern(type) ? "guard" : "alarm"]);
    }
    return normalizeBitPattern(value);
  }

  // 割付表を持たない組み合わせ（ヒストリー要求、警戒設定／解除の割付なし）はnullを返す。
  function bitAssignments(type, pattern) {
    const code = resolveType(type);
    const table = BIT_ASSIGNMENTS[code];
    if (!table) return null;
    const row = table[resolveBitPattern(pattern, code)];
    return row ? row.slice() : null;
  }

  function bitMask(bitNumber) {
    return 1 << (integer(bitNumber, 1, 8, "bit number") - 1);
  }

  function encodeInfo(bitNumbers) {
    if (bitNumbers == null) return 0;
    if (typeof bitNumbers.length !== "number" || typeof bitNumbers === "string") {
      throw new TypeError("bit numbers must be array-like");
    }
    return Array.from(bitNumbers).reduce(function (info, bitNumber) { return info | bitMask(bitNumber); }, 0) & 0xFF;
  }

  function decodeInfo(info) {
    const value = byte(info, "alarm information");
    const result = [];
    for (let bitNumber = 1; bitNumber <= 8; bitNumber += 1) {
      if ((value & bitMask(bitNumber)) !== 0) result.push(bitNumber);
    }
    return result;
  }

  // 発信情報1Byteを、選択中の割付で読める形へ展開する。UIのビット選択と受信表示の両方で使う。
  function describeInfo(info, options) {
    options = options || {};
    const value = byte(info, "alarm information");
    const type = resolveType(options.type == null ? TYPE.ALARM_1 : options.type);
    const pattern = resolveBitPattern(options.pattern, type);
    const row = bitAssignments(type, pattern);
    const bits = [];
    const labels = [];
    const violations = [];
    for (let bitNumber = 1; bitNumber <= 8; bitNumber += 1) {
      const mask = bitMask(bitNumber);
      const entry = row ? row[bitNumber - 1] : UNUSED_BIT;
      const on = (value & mask) !== 0;
      bits.push({
        bit: bitNumber,
        mask: mask,
        on: on,
        label: entry.label,
        locked: entry.locked,
        extensible: entry.extensible,
      });
      if (!on) continue;
      labels.push(entry.label == null ? "bit" + bitNumber + (entry.extensible ? "（未割付）" : "（未使用）") : entry.label);
      if (entry.label == null && !entry.extensible) violations.push(bitNumber);
    }
    return {
      info: value,
      hex: value.toString(16).toUpperCase().padStart(2, "0"),
      type: type,
      pattern: pattern,
      assigned: row !== null,
      bits: bits,
      labels: labels,
      violations: violations,
      summary: labels.length === 0 ? (EMPTY_INFO_TEXT[type] || "全bit OFF") : labels.join("＋"),
    };
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
    if (own(options, "info") && own(options, "infoBits")) throw new Error("specify either info or infoBits, not both");
    const info = own(options, "infoBits")
      ? encodeInfo(options.infoBits)
      : byte(options.info == null ? 0 : options.info, "alarm information");
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
    BIT_PATTERN: BIT_PATTERN,
    BIT_PATTERN_NAMES: BIT_PATTERN_NAMES,
    usesGuardPattern: usesGuardPattern,
    bitAssignments: bitAssignments,
    bitMask: bitMask,
    encodeInfo: encodeInfo,
    decodeInfo: decodeInfo,
    describeInfo: describeInfo,
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
