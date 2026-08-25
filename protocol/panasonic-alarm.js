// パナソニック集合住宅システム（ﾊﾟﾅｿﾆｯｸIFU）→他社通報機の警報プロトコル4種を扱う。
//   HPC      … 通信仕様書（ＨＰＣプロトコル）      2012年 1月10日
//   新TSS    … 通信仕様書（新ＴＳＳプロトコル）    2012年 3月26日
//   大興     … 通信仕様書（大興プロトコル）        2018年 1月 9日
//   リモート … 通信仕様書（リモートプロトコル）    2012年 1月10日
// HPC／TSSはSTXで始まる11byte固定電文、大興／リモートは"SND"で始まるASCIIレコード列で、
// 電文の組み立ても誤り検出も別物のため、形式(style)を分けて扱う。
// Browser: window.PanasonicAlarm / Node: require("./protocol/panasonic-alarm.js")
(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.PanasonicAlarm = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";

  const CODE = Object.freeze({ NULL: 0x00, STX: 0x02, ETX: 0x03, EOT: 0x04, ENQ: 0x05, ACK: 0x06, NAK: 0x15, CR: 0x0D });
  const SIZE = 0x37;          // データ長37H（データ部7byte）
  const BLOCK_LENGTH = 11;    // STX+データ長+データ7+ETX+BCC
  const RECORD_LENGTH = 10;   // モード+棟番号2+住戸番号4+警報No2+ETX
  const MAX_RECORDS = 10;     // 最大送信レコード10
  const RECORD_HEADER = "SND";
  const SCHEDULED_HEADER = "TRS";
  const ANSWER_OK = "OK";
  const ANSWER_NG = "NG";
  const SCHEDULED_MARK = "!7"; // 定時送信の識別子。チェックサムは[!]～[ETX]で算出する。

  const PROTOCOL = Object.freeze({ HPC: "hpc", TSS: "tss", DAIKO: "daiko", REMOTE: "remote" });
  const STYLE = Object.freeze({ BLOCK: "block", RECORD: "record" });
  const MODE = Object.freeze({ OCCUR: "N", RESTORE: "F" });
  const PROTOCOL_NAMES = Object.freeze([PROTOCOL.HPC, PROTOCOL.TSS, PROTOCOL.DAIKO, PROTOCOL.REMOTE]);

  // 大興／リモートは「垂直パリティ：チェックサム／水平パリティ：なし」で、
  // パリティビットを持たずチェックサムだけで誤りを検出する。
  const PROTOCOL_INFO = Object.freeze({
    [PROTOCOL.HPC]: Object.freeze({
      label: "ＨＰＣ", style: STYLE.BLOCK, document: "通信仕様書（ＨＰＣプロトコル）",
      serial: Object.freeze({ baudRate: 1200, dataBits: 8, stopBits: 1, parity: "even" }),
      history: true, dwellingRequest: true, scheduled: false,
      // ・ENQに対する応答待ちは1秒／テキストに対する応答待ちは1秒／テキスト待ちは1秒
      // ・ﾊﾟﾅｿﾆｯｸIFU→他社通報機 リトライMAX256回、他社通報機→ﾊﾟﾅｿﾆｯｸIFU MAX5回
      linkTimeoutMs: 1000, textTimeoutMs: 1000, textWaitMs: 1000,
      ifuRetries: 256, peerRetries: 5,
    }),
    [PROTOCOL.TSS]: Object.freeze({
      label: "新ＴＳＳ", style: STYLE.BLOCK, document: "通信仕様書（新ＴＳＳプロトコル）",
      serial: Object.freeze({ baudRate: 1200, dataBits: 8, stopBits: 1, parity: "even" }),
      history: false, dwellingRequest: false, scheduled: false,
      // ENQ応答がACK以外はMAX5回、ENQ応答タイムアウトはMAX256回、テキストNAKはMAX5回。
      linkTimeoutMs: 1000, textTimeoutMs: 1000, textWaitMs: 2000,
      ifuRetries: 5, peerRetries: 256,
    }),
    [PROTOCOL.DAIKO]: Object.freeze({
      label: "大興", style: STYLE.RECORD, document: "通信仕様書（大興プロトコル）",
      serial: Object.freeze({ baudRate: 1200, dataBits: 8, stopBits: 1, parity: "none" }),
      history: false, dwellingRequest: false, scheduled: false,
      answerbackTimeoutMs: 5000, sendAttempts: 3,
    }),
    [PROTOCOL.REMOTE]: Object.freeze({
      label: "リモート", style: STYLE.RECORD, document: "通信仕様書（リモートプロトコル）",
      serial: Object.freeze({ baudRate: 1200, dataBits: 8, stopBits: 1, parity: "none" }),
      history: false, dwellingRequest: false, scheduled: true,
      answerbackTimeoutMs: 5000, sendAttempts: 3,
    }),
  });

  function own(object, key) {
    return Object.prototype.hasOwnProperty.call(object, key);
  }

  function integer(value, min, max, name) {
    let number = value;
    if (typeof value === "string" && /^\d+$/.test(value)) number = Number(value);
    if (!Number.isSafeInteger(number) || number < min || number > max) {
      throw new RangeError(name + "は" + min + "～" + max + "の整数で指定してください");
    }
    return number;
  }

  function byte(value, name) {
    return integer(value, 0, 0xFF, name);
  }

  function bytes(value, name) {
    if (value == null || typeof value.length !== "number") throw new TypeError(name + "はバイト配列で指定してください");
    const result = Array.from(value);
    result.forEach(function (item, index) { byte(item, name + "[" + index + "]"); });
    return result;
  }

  function resolveProtocol(value) {
    const name = value == null ? "" : String(value);
    if (!own(PROTOCOL_INFO, name)) throw new RangeError("未知のプロトコルです: " + name);
    return name;
  }

  function protocolInfo(protocol) {
    return PROTOCOL_INFO[resolveProtocol(protocol)];
  }

  function styleOf(protocol) {
    return protocolInfo(protocol).style;
  }

  function requireStyle(protocol, style, subject) {
    const name = resolveProtocol(protocol);
    if (PROTOCOL_INFO[name].style !== style) {
      throw new Error(PROTOCOL_INFO[name].label + "プロトコルは" + subject + "を持ちません");
    }
    return name;
  }

  function hex2(value) {
    return byte(value, "値").toString(16).toUpperCase().padStart(2, "0");
  }

  function toHex(value) {
    return bytes(value, "value").map(hex2).join(" ");
  }

  function asciiBytes(text, name) {
    const source = String(text);
    return Array.from(source, function (character, index) {
      const code = source.charCodeAt(index);
      if (code > 0xFF) throw new RangeError(name + "にASCII以外の文字が含まれています: " + character);
      return code;
    });
  }

  function asciiText(value) {
    return bytes(value, "value").map(function (item) { return String.fromCharCode(item); }).join("");
  }

  // ------------------------------------------------------------------
  // HPC／新TSS：発信種別と警報情報のビット割付
  // ------------------------------------------------------------------

  // 仕様書のビット表はbit0がLSB。予備はlabel=nullで持ち、HEX直接入力で
  // 立ったときに「仕様上の予備bit」として注意を出せるようにする。
  const RESERVED = Object.freeze({ label: null, reserved: true });
  function bit(label) { return Object.freeze({ label: label, reserved: false }); }

  function bitRow(entries) {
    if (entries.length !== 8) throw new Error("ビット割付は8桁ちょうどで定義してください");
    return Object.freeze(entries.slice());
  }

  function reservedBits(count) {
    return new Array(count).fill(RESERVED);
  }

  const BLOCK_TYPES = Object.freeze({
    [PROTOCOL.HPC]: Object.freeze([
      Object.freeze({
        code: 0x00, name: "alarm1", label: "警報情報１",
        // 水漏れ／コールは機能設定でどちらか一方だけを送る（両方「有」なら送信しない）。
        bits: bitRow([bit("火災"), bit("非常"), bit("ガス"), bit("水漏れ／コール"),
          bit("火災回路断"), bit("ガス機器異常"), bit("ＣＯ"), bit("防犯(代表)")]),
      }),
      Object.freeze({
        code: 0x01, name: "alarm2", label: "警報情報２",
        bits: bitRow([bit("防犯１"), bit("防犯２"), bit("防犯３"), bit("防犯(代表)ｾｯﾄ/ﾘｾｯﾄ"),
          bit("防犯１ｾｯﾄ/ﾘｾｯﾄ"), bit("防犯２ｾｯﾄ/ﾘｾｯﾄ"), bit("防犯３ｾｯﾄ/ﾘｾｯﾄ"), bit("住戸電源断")]),
        note: "防犯セット：１、防犯リセット：０",
      }),
      Object.freeze({
        code: 0x02, name: "alarm3", label: "警報情報３",
        bits: bitRow([bit("コール１"), bit("コール２"), bit("コール３"), bit("コール４")]
          .concat(reservedBits(3), [bit("外部機器異常")])),
      }),
      Object.freeze({
        code: 0x04, name: "securitySet", label: "防犯セット情報",
        bits: bitRow([bit("防犯４")].concat(reservedBits(3), [bit("防犯４ｾｯﾄ/ﾘｾｯﾄ")], reservedBits(3))),
        note: "防犯セット：１、防犯リセット：０",
      }),
      Object.freeze({
        code: 0x05, name: "generalAlarm", label: "汎用警報情報",
        bits: bitRow([bit("汎用警報(代表)"), bit("汎用警報１"), bit("汎用警報２"), bit("汎用警報３"),
          bit("汎用警報４")].concat(reservedBits(3))),
      }),
      // 住戸情報要求は警報情報だけが00H固定で、棟番号・住戸番号は対象住戸を指定する。
      Object.freeze({ code: 0x10, name: "dwellingRequest", label: "住戸情報要求", bits: null, request: true, addressed: true }),
      // ヒストリー要求は棟番号・住戸番号も[00]。
      Object.freeze({ code: 0x30, name: "historyRequest", label: "ヒストリー要求", bits: null, request: true, addressed: false }),
    ]),
    [PROTOCOL.TSS]: Object.freeze([
      Object.freeze({
        code: 0x00, name: "alarm1", label: "警報情報１",
        bits: bitRow([bit("火災"), bit("非常"), bit("ガス漏れ"), bit("水漏れ"),
          bit("コール"), bit("防犯(代表)"), bit("火災断線"), bit("ガス機器異常")]),
      }),
      Object.freeze({
        code: 0x01, name: "alarm2", label: "警報情報２",
        bits: bitRow([bit("ＣＯ"), RESERVED, RESERVED, bit("住戸電源断"),
          bit("ﾜｲﾔﾚｽ電池切れ"), bit("ﾜｲﾔﾚｽ機器異常"), RESERVED, RESERVED]),
      }),
      Object.freeze({
        code: 0x02, name: "alarm3", label: "警報情報３",
        bits: bitRow([bit("コール１"), bit("コール２"), bit("コール３")].concat(reservedBits(5))),
        // 発信種別の一覧表(p.1)に02Hの行がないが、p.2にビット割付が載っている。
        note: "発信種別一覧(p.1)には未掲載。警報情報３のビット割付(p.2)を正として扱う",
      }),
      Object.freeze({
        code: 0x04, name: "securitySet", label: "警戒セット情報",
        bits: bitRow([bit("防犯ｾｯﾄ")].concat(reservedBits(7))),
      }),
      Object.freeze({
        code: 0x44, name: "securityClear", label: "警戒解除情報",
        bits: bitRow([bit("防犯ﾘｾｯﾄ")].concat(reservedBits(7))),
      }),
    ]),
  });

  function blockTypes(protocol) {
    return BLOCK_TYPES[requireStyle(protocol, STYLE.BLOCK, "発信種別")].slice();
  }

  function findBlockType(protocol, type) {
    const code = byte(type, "発信種別");
    const entry = blockTypes(protocol).find(function (item) { return item.code === code; });
    if (!entry) throw new RangeError(protocolInfo(protocol).label + "に発信種別 " + hex2(code) + "H はありません");
    return entry;
  }

  function bitAssignments(protocol, type) {
    const entry = findBlockType(protocol, type);
    return entry.bits ? entry.bits.slice() : null;
  }

  function bitMask(bitNumber) {
    return 1 << integer(bitNumber, 0, 7, "bit番号");
  }

  function encodeInfo(bitNumbers) {
    if (bitNumbers == null) return 0;
    if (typeof bitNumbers.length !== "number" || typeof bitNumbers === "string") {
      throw new TypeError("bit番号は配列で指定してください");
    }
    return Array.from(bitNumbers).reduce(function (info, bitNumber) { return info | bitMask(bitNumber); }, 0) & 0xFF;
  }

  function decodeInfo(info) {
    const value = byte(info, "警報情報");
    const result = [];
    for (let bitNumber = 0; bitNumber <= 7; bitNumber += 1) {
      if ((value & bitMask(bitNumber)) !== 0) result.push(bitNumber);
    }
    return result;
  }

  // 警報情報1Byteを、選択中の発信種別の割付で読める形へ展開する。
  // UIのビット選択と受信表示の両方で使う。
  function describeInfo(protocol, type, info) {
    const entry = findBlockType(protocol, type);
    const value = byte(info, "警報情報");
    const row = entry.bits;
    const bits = [];
    const labels = [];
    const violations = [];
    for (let bitNumber = 0; bitNumber <= 7; bitNumber += 1) {
      const cell = row ? row[bitNumber] : RESERVED;
      const on = (value & bitMask(bitNumber)) !== 0;
      bits.push({ bit: bitNumber, mask: bitMask(bitNumber), on: on, label: cell.label, reserved: cell.reserved });
      if (!on) continue;
      labels.push(cell.label == null ? "bit" + bitNumber + "（予備）" : cell.label);
      if (cell.label == null) violations.push(bitNumber);
    }
    return {
      protocol: resolveProtocol(protocol),
      type: entry.code,
      typeName: entry.name,
      typeLabel: entry.label,
      info: value,
      hex: hex2(value),
      assigned: row !== null,
      fixedZero: row === null,
      bits: bits,
      labels: labels,
      violations: violations,
      summary: row === null
        ? "00H固定（" + entry.label + "）"
        : (labels.length === 0 ? "全bit OFF（警報なし／復旧）" : labels.join("＋")),
    };
  }

  // ------------------------------------------------------------------
  // HPC／新TSS：棟番号・住戸番号・BCC・電文
  // ------------------------------------------------------------------

  // 棟番号は00H=単独棟設定:有り、01H=1棟…63H=99棟のバイナリ。64H以降は予備。
  // アイホンQ49-023GのようなBCDではないので、10棟は0AHになる。
  function encodeBuilding(buildingNo) {
    return integer(buildingNo, 0, 99, "棟番号");
  }

  function decodeBuilding(value) {
    const encoded = byte(value, "棟番号");
    if (encoded > 0x63) throw new RangeError("棟番号 " + hex2(encoded) + "H は予備領域です");
    return encoded;
  }

  // 住戸番号は4byte。下位4bitが千位／百位／十位／一位のBCD、
  // 上位4bitはHPCのヒストリー種別（0=イベント通知、1～F=ヒストリー1～15）。
  function encodeDwelling(roomNo, historyNumber) {
    const number = integer(roomNo == null ? 0 : roomNo, 0, 9999, "住戸番号");
    const history = integer(historyNumber == null ? 0 : historyNumber, 0, 15, "ヒストリー番号");
    return Array.from(String(number).padStart(4, "0"), function (digit) {
      return (history << 4) | Number(digit);
    });
  }

  function decodeDwelling(value) {
    const source = bytes(value, "住戸番号");
    if (source.length !== 4) throw new Error("住戸番号は4byteで指定してください");
    const history = source[0] >> 4;
    if (!source.every(function (item) { return (item >> 4) === history; })) {
      throw new Error("住戸番号4byteのヒストリー種別が一致していません");
    }
    const digits = source.map(function (item) { return item & 0x0F; });
    if (!digits.every(function (item) { return item <= 9; })) throw new RangeError("住戸番号がBCDではありません");
    return {
      roomNo: digits[0] * 1000 + digits[1] * 100 + digits[2] * 10 + digits[3],
      historyNumber: history,
      digits: digits,
      bytes: source,
    };
  }

  // BCCはSTXの次のキャラクタからETXまでのチェックサム（8bit加算、桁上がり無視）。
  function calculateBCC(frameWithoutBcc) {
    const frame = bytes(frameWithoutBcc, "frameWithoutBcc");
    if (frame.length < 2 || frame[0] !== CODE.STX) throw new Error("BCCの入力はSTXで始まる必要があります");
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

  function buildBlockFrame(options) {
    if (options == null || typeof options !== "object") throw new TypeError("電文の指定が必要です");
    const protocol = requireStyle(options.protocol, STYLE.BLOCK, "STX形式の電文");
    const entry = findBlockType(protocol, options.type);
    if (own(options, "info") && own(options, "infoBits")) throw new Error("infoとinfoBitsは同時に指定できません");
    const info = own(options, "infoBits")
      ? encodeInfo(options.infoBits)
      : byte(options.info == null ? 0 : options.info, "警報情報");
    const buildingNo = encodeBuilding(options.buildingNo == null ? 0 : options.buildingNo);
    const roomNo = integer(options.roomNo == null ? 0 : options.roomNo, 0, 9999, "住戸番号");
    const historyNumber = integer(options.historyNumber == null ? 0 : options.historyNumber, 0, 15, "ヒストリー番号");

    if (historyNumber !== 0 && !protocolInfo(protocol).history) {
      throw new Error(protocolInfo(protocol).label + "プロトコルにヒストリー応答はありません");
    }
    if (historyNumber !== 0 && entry.request) throw new Error("要求電文にヒストリー番号は設定できません");
    if (entry.bits === null && info !== 0) throw new Error(entry.label + "の警報情報は00H固定です");
    if (entry.request && entry.addressed === false && (buildingNo !== 0 || roomNo !== 0)) {
      throw new Error(entry.label + "の棟番号・住戸番号は00固定です");
    }

    const frame = [CODE.STX, SIZE, entry.code, info, buildingNo]
      .concat(encodeDwelling(roomNo, historyNumber), [CODE.ETX]);
    if (frame.length !== BLOCK_LENGTH - 1) throw new Error("STX形式の電文長を組み立てられませんでした");
    frame.push(calculateBCC(frame));
    return frame;
  }

  function parseBlockFrame(value, options) {
    const protocol = requireStyle((options || {}).protocol, STYLE.BLOCK, "STX形式の電文");
    const frame = bytes(value, "frame");
    if (frame.length !== BLOCK_LENGTH) throw new Error("電文は" + BLOCK_LENGTH + "byteちょうどである必要があります");
    if (frame[0] !== CODE.STX) throw new Error("STXが02Hではありません");
    if (frame[1] !== SIZE) throw new Error("データ長が37Hではありません");
    if (frame[9] !== CODE.ETX) throw new Error("ETXが03Hではありません");
    if (!verifyBCC(frame)) throw new Error("BCCが一致しません");

    const entry = findBlockType(protocol, frame[2]);
    const info = frame[3];
    const buildingNo = decodeBuilding(frame[4]);
    const dwelling = decodeDwelling(frame.slice(5, 9));
    if (dwelling.historyNumber !== 0 && !protocolInfo(protocol).history) {
      throw new Error(protocolInfo(protocol).label + "プロトコルにヒストリー応答はありません");
    }
    if (entry.bits === null && info !== 0) throw new Error(entry.label + "の警報情報は00H固定です");
    if (entry.request && entry.addressed === false && (buildingNo !== 0 || dwelling.roomNo !== 0 || dwelling.historyNumber !== 0)) {
      throw new Error(entry.label + "の棟番号・住戸番号は00固定です");
    }

    return {
      protocol: protocol,
      style: STYLE.BLOCK,
      type: entry.code,
      typeName: entry.name,
      typeLabel: entry.label,
      request: Boolean(entry.request),
      info: info,
      buildingNo: buildingNo,
      buildingByte: frame[4],
      roomNo: dwelling.roomNo,
      historyNumber: dwelling.historyNumber,
      dwelling: dwelling,
      bcc: frame[10],
      bytes: frame.slice(),
    };
  }

  // ------------------------------------------------------------------
  // 大興／リモート：警報No.台帳
  // ------------------------------------------------------------------

  function alarmNo(no, label) {
    return Object.freeze({ no: no, code: String(no).padStart(2, "0"), label: label });
  }

  // 03/04の割付は大興が「非常／防犯(代表)」、リモートが「防犯(代表)／非常」で
  // 入れ替わっている。どちらも各仕様書の別表どおりに持つ。
  const ALARM_NUMBERS = Object.freeze({
    [PROTOCOL.DAIKO]: Object.freeze([
      alarmNo(1, "火災"), alarmNo(2, "ガス漏れ"), alarmNo(3, "非常"), alarmNo(4, "防犯(代表)"),
      alarmNo(5, "ＣＯ"), alarmNo(6, "コール"), alarmNo(7, "水漏れ"),
      alarmNo(8, "防犯１"), alarmNo(9, "防犯２"), alarmNo(10, "防犯３"),
      alarmNo(11, "火災回路断"), alarmNo(12, "ガス機器異常"), alarmNo(13, "住戸通信異常"), alarmNo(14, "防犯４"),
      alarmNo(30, "防犯(代表)ｾｯﾄ/ﾘｾｯﾄ"), alarmNo(31, "防犯１ｾｯﾄ/ﾘｾｯﾄ"), alarmNo(32, "防犯２ｾｯﾄ/ﾘｾｯﾄ"),
      alarmNo(33, "防犯３ｾｯﾄ/ﾘｾｯﾄ"), alarmNo(34, "防犯４ｾｯﾄ/ﾘｾｯﾄ"),
      alarmNo(41, "コール１"), alarmNo(42, "コール２"), alarmNo(43, "コール３"), alarmNo(44, "コール４"),
      alarmNo(50, "汎用警報(代表)"), alarmNo(51, "汎用警報１"), alarmNo(52, "汎用警報２"),
      alarmNo(53, "汎用警報３"), alarmNo(54, "汎用警報４"),
    ]),
    [PROTOCOL.REMOTE]: Object.freeze([
      alarmNo(1, "火災"), alarmNo(2, "ガス漏れ"), alarmNo(3, "防犯(代表)"), alarmNo(4, "非常"),
      alarmNo(5, "ＣＯ"), alarmNo(6, "コール"), alarmNo(7, "水漏れ"),
      alarmNo(8, "防犯１"), alarmNo(9, "防犯２"), alarmNo(10, "防犯３"),
      alarmNo(11, "火災回路断"), alarmNo(12, "ガス機器異常"), alarmNo(13, "住戸通信異常"), alarmNo(14, "防犯４"),
      alarmNo(30, "防犯(代表)ｾｯﾄ/ﾘｾｯﾄ"), alarmNo(31, "防犯１ｾｯﾄ/ﾘｾｯﾄ"), alarmNo(32, "防犯２ｾｯﾄ/ﾘｾｯﾄ"),
      alarmNo(33, "防犯３ｾｯﾄ/ﾘｾｯﾄ"), alarmNo(34, "防犯４ｾｯﾄ/ﾘｾｯﾄ"),
      alarmNo(40, "宅配登録･削除"),
      alarmNo(41, "コール１"), alarmNo(42, "コール２"), alarmNo(43, "コール３"), alarmNo(44, "コール４"),
      alarmNo(50, "汎用警報(代表)"), alarmNo(51, "汎用警報１"), alarmNo(52, "汎用警報２"),
      alarmNo(53, "汎用警報３"), alarmNo(54, "汎用警報４"),
    ]),
  });

  function alarmNumbers(protocol) {
    return ALARM_NUMBERS[requireStyle(protocol, STYLE.RECORD, "警報No.")].slice();
  }

  function findAlarmNumber(protocol, no) {
    const number = integer(no, 0, 99, "警報No.");
    return alarmNumbers(protocol).find(function (item) { return item.no === number; }) || null;
  }

  // 警報No.は防犯セット／リセットと宅配登録／削除でモードの意味が変わる。
  function modeLabel(protocol, no, mode) {
    const name = resolveProtocol(protocol);
    const number = integer(no, 0, 99, "警報No.");
    const occur = mode === MODE.OCCUR;
    if (number >= 30 && number <= 34) return occur ? "セット" : "リセット";
    if (name === PROTOCOL.REMOTE && number === 40) return occur ? "登録" : "削除";
    return occur ? "異常発生" : "異常復旧";
  }

  function resolveMode(value) {
    if (value == null) return MODE.OCCUR;
    const text = String(value).toUpperCase();
    if (text === MODE.OCCUR || text === "OCCUR" || text === "発生") return MODE.OCCUR;
    if (text === MODE.RESTORE || text === "RESTORE" || text === "復旧") return MODE.RESTORE;
    throw new RangeError("モードはN（異常発生）またはF（異常復旧）で指定してください");
  }

  // ------------------------------------------------------------------
  // 大興／リモート：チェックサムとレコード電文
  // ------------------------------------------------------------------

  // SND直後のモードから最後のETXまでのASCIIコードを加算し、4桁のHEXで表す。
  function calculateChecksum(payloadBytes) {
    const payload = bytes(payloadBytes, "payload");
    const total = payload.reduce(function (sum, item) { return sum + item; }, 0);
    return total & 0xFFFF;
  }

  function checksumText(value) {
    return integer(value, 0, 0xFFFF, "チェックサム").toString(16).toUpperCase().padStart(4, "0");
  }

  function checksumBytes(payloadBytes) {
    return asciiBytes(checksumText(calculateChecksum(payloadBytes)), "チェックサム");
  }

  function encodeRecord(protocol, record) {
    if (record == null || typeof record !== "object") throw new TypeError("レコードの指定が必要です");
    const name = requireStyle(protocol, STYLE.RECORD, "レコード電文");
    const mode = resolveMode(record.mode);
    const buildingNo = integer(record.buildingNo == null ? 0 : record.buildingNo, 0, 99, "棟番号");
    const roomNo = integer(record.roomNo == null ? 0 : record.roomNo, 0, 9999, "住戸番号");
    const number = integer(record.alarmNo, 0, 99, "警報No.");
    if (!findAlarmNumber(name, number)) {
      throw new RangeError(protocolInfo(name).label + "の別表に警報No." + String(number).padStart(2, "0") + " はありません");
    }
    const text = mode + String(buildingNo).padStart(2, "0") + String(roomNo).padStart(4, "0") + String(number).padStart(2, "0");
    return asciiBytes(text, "レコード").concat([CODE.ETX]);
  }

  function buildRecordFrame(options) {
    if (options == null || typeof options !== "object") throw new TypeError("電文の指定が必要です");
    const protocol = requireStyle(options.protocol, STYLE.RECORD, "レコード電文");
    const list = options.records == null ? [] : Array.from(options.records);
    if (list.length === 0) throw new Error("レコードを1件以上指定してください");
    if (list.length > MAX_RECORDS) throw new RangeError("1回の送信は最大" + MAX_RECORDS + "レコードです");
    const payload = list.reduce(function (all, record) { return all.concat(encodeRecord(protocol, record)); }, []);
    return asciiBytes(RECORD_HEADER, "ヘッダ").concat(payload, checksumBytes(payload), [CODE.CR]);
  }

  function parseRecordFrame(value, options) {
    const protocol = requireStyle((options || {}).protocol, STYLE.RECORD, "レコード電文");
    const frame = bytes(value, "frame");
    if (frame.length < 1 || frame[frame.length - 1] !== CODE.CR) throw new Error("電文がCRで終わっていません");
    const body = frame.slice(0, -1);

    // NAKのアンサーバックはヘッダを持たず"NG"＋CRだけで送られる。
    if (asciiText(body) === ANSWER_NG) {
      return { protocol: protocol, style: STYLE.RECORD, kind: "nak", bytes: frame.slice() };
    }

    const head = asciiText(body.slice(0, 3));
    if (head !== RECORD_HEADER && head !== SCHEDULED_HEADER) {
      throw new Error("電文が" + RECORD_HEADER + "／" + SCHEDULED_HEADER + "／" + ANSWER_NG + "で始まっていません");
    }

    const rest = body.slice(3);
    if (asciiText(rest.slice(0, 2)) === ANSWER_OK) {
      const payload = rest.slice(0, 2);
      const received = asciiText(rest.slice(2));
      const expected = checksumText(calculateChecksum(payload));
      if (received !== expected) throw new Error("チェックサムが一致しません（受信 " + received + " / 期待 " + expected + "）");
      return {
        protocol: protocol, style: STYLE.RECORD, kind: "ack",
        header: head, scheduled: head === SCHEDULED_HEADER,
        checksum: expected, bytes: frame.slice(),
      };
    }

    // 定時送信は［!］～［ETX］がチェックサムの対象で、レコード列とは構造が違う。
    if (head === SCHEDULED_HEADER) {
      if (!protocolInfo(protocol).scheduled) throw new Error(protocolInfo(protocol).label + "プロトコルに定時送信はありません");
      const etx = rest.indexOf(CODE.ETX);
      if (etx === -1) throw new Error("定時送信にETXがありません");
      const mark = asciiText(rest.slice(0, SCHEDULED_MARK.length));
      if (mark !== SCHEDULED_MARK) throw new Error("定時送信の識別子が" + SCHEDULED_MARK + "ではありません");
      const payload = rest.slice(0, etx + 1);
      const received = asciiText(rest.slice(etx + 1));
      const expected = checksumText(calculateChecksum(payload));
      if (received !== expected) throw new Error("チェックサムが一致しません（受信 " + received + " / 期待 " + expected + "）");
      return {
        protocol: protocol, style: STYLE.RECORD, kind: "scheduled",
        propertyCode: asciiText(rest.slice(SCHEDULED_MARK.length, etx)),
        checksum: expected, bytes: frame.slice(),
      };
    }

    const checksumStart = rest.length - 4;
    if (checksumStart < RECORD_LENGTH) throw new Error("レコードとチェックサムの長さが足りません");
    const payload = rest.slice(0, checksumStart);
    if (payload.length % RECORD_LENGTH !== 0) throw new Error("レコード長が" + RECORD_LENGTH + "byteの倍数ではありません");
    const count = payload.length / RECORD_LENGTH;
    if (count > MAX_RECORDS) throw new RangeError("1回の送信は最大" + MAX_RECORDS + "レコードです");
    const received = asciiText(rest.slice(checksumStart));
    const expected = checksumText(calculateChecksum(payload));
    if (received !== expected) throw new Error("チェックサムが一致しません（受信 " + received + " / 期待 " + expected + "）");

    const records = [];
    for (let index = 0; index < count; index += 1) {
      const slice = payload.slice(index * RECORD_LENGTH, (index + 1) * RECORD_LENGTH);
      if (slice[RECORD_LENGTH - 1] !== CODE.ETX) throw new Error((index + 1) + "件目のレコードがETXで終わっていません");
      const text = asciiText(slice.slice(0, RECORD_LENGTH - 1));
      const matched = /^([NF])(\d{2})(\d{4})(\d{2})$/.exec(text);
      if (!matched) throw new Error((index + 1) + "件目のレコードが「モード＋棟番号2桁＋住戸番号4桁＋警報No.2桁」ではありません");
      const number = Number(matched[4]);
      const entry = findAlarmNumber(protocol, number);
      records.push({
        mode: matched[1],
        modeLabel: modeLabel(protocol, number, matched[1]),
        buildingNo: Number(matched[2]),
        roomNo: Number(matched[3]),
        alarmNo: number,
        alarmLabel: entry ? entry.label : null,
        known: entry !== null,
        bytes: slice.slice(),
      });
    }

    return {
      protocol: protocol, style: STYLE.RECORD, kind: "alarm",
      records: records, recordCount: records.length,
      checksum: expected, bytes: frame.slice(),
    };
  }

  // ------------------------------------------------------------------
  // アンサーバックと定時送信
  // ------------------------------------------------------------------

  // ACKは"SND"／"TRS"＋"OK"＋チェックサム4桁＋CR。仕様書の例 SNDOK009A は
  // "OK"（4FH+4BH=9AH）だけを加算した値で、レコードは対象外。
  function buildAnswerback(options) {
    const opts = options || {};
    const protocol = requireStyle(opts.protocol, STYLE.RECORD, "アンサーバック");
    const accepted = opts.accepted !== false && opts.kind !== "nak";
    if (!accepted) return asciiBytes(ANSWER_NG, "アンサーバック").concat([CODE.CR]);
    const scheduled = opts.scheduled === true;
    if (scheduled && !protocolInfo(protocol).scheduled) {
      throw new Error(protocolInfo(protocol).label + "プロトコルに定時送信はありません");
    }
    const payload = asciiBytes(ANSWER_OK, "アンサーバック");
    return asciiBytes(scheduled ? SCHEDULED_HEADER : RECORD_HEADER, "ヘッダ")
      .concat(payload, checksumBytes(payload), [CODE.CR]);
  }

  // 定時送信は他社通報機→ﾊﾟﾅｿﾆｯｸIFU。物件コードはリモート送信機で設定する値で、
  // IFUでは使用／参照しないため桁数の規定がなく、指定文字列をそのまま載せる。
  function buildScheduledFrame(options) {
    const opts = options || {};
    const protocol = resolveProtocol(opts.protocol);
    if (!protocolInfo(protocol).scheduled) throw new Error(protocolInfo(protocol).label + "プロトコルに定時送信はありません");
    const code = opts.propertyCode == null ? "" : String(opts.propertyCode);
    if (!/^[\x20-\x7E]*$/.test(code)) throw new RangeError("物件コードは印字可能なASCIIで指定してください");
    const payload = asciiBytes(SCHEDULED_MARK + code, "定時送信").concat([CODE.ETX]);
    return asciiBytes(SCHEDULED_HEADER, "ヘッダ").concat(payload, checksumBytes(payload), [CODE.CR]);
  }

  // ------------------------------------------------------------------
  // 形式をまたぐ入口
  // ------------------------------------------------------------------

  function buildFrame(options) {
    if (options == null || typeof options !== "object") throw new TypeError("電文の指定が必要です");
    return styleOf(options.protocol) === STYLE.BLOCK ? buildBlockFrame(options) : buildRecordFrame(options);
  }

  function parseFrame(value, options) {
    const opts = options || {};
    return styleOf(opts.protocol) === STYLE.BLOCK ? parseBlockFrame(value, opts) : parseRecordFrame(value, opts);
  }

  function validateFrame(value, options) {
    try {
      parseFrame(value, options);
      return true;
    } catch (_error) {
      return false;
    }
  }

  // ------------------------------------------------------------------
  // HPCのヒストリー処理
  // ------------------------------------------------------------------

  // ・現状より1つ前、2つ前…と出力し、15を超えたら再び現状へ戻るリング。
  // ・15に満たない場合は保持件数だけでリングを作る。
  // ・15を超えた場合は古い情報を消し、全体をシフトして新情報を加える。
  // ・ヒストリー情報がない場合の要求にはNAKを返す（応答電文は作らない）。
  const HISTORY_LIMIT = 15;

  class PanasonicHistory {
    constructor(options) {
      const opts = options || {};
      this.protocol = resolveProtocol(opts.protocol == null ? PROTOCOL.HPC : opts.protocol);
      if (!protocolInfo(this.protocol).history) {
        throw new Error(protocolInfo(this.protocol).label + "プロトコルにヒストリー応答はありません");
      }
      this.limit = integer(opts.limit == null ? HISTORY_LIMIT : opts.limit, 1, HISTORY_LIMIT, "保持件数");
      this._entries = [];
      this._pointer = 0;
    }

    get size() {
      return this._entries.length;
    }

    get pointer() {
      return this._pointer;
    }

    get empty() {
      return this._entries.length === 0;
    }

    reset() {
      this._entries = [];
      this._pointer = 0;
    }

    // 新規イベントの記録はポインタを先頭へ戻す（ヒストリー要求受信中でも同じ）。
    record(event) {
      const parsed = Array.isArray(event) || ArrayBuffer.isView(event)
        ? parseBlockFrame(event, { protocol: this.protocol })
        : parseBlockFrame(buildBlockFrame(Object.assign({ protocol: this.protocol }, event)), { protocol: this.protocol });
      if (parsed.request) throw new Error("要求電文はヒストリーに記録できません");
      this._entries.unshift({
        type: parsed.type,
        info: parsed.info,
        buildingNo: parsed.buildingNo,
        roomNo: parsed.roomNo,
      });
      if (this._entries.length > this.limit) this._entries.length = this.limit;
      this._pointer = 0;
      return this;
    }

    // ポインタ0は「現状」＝最新送信イベント。要求のたびに1つ前へ進み、
    // 保持件数を一周したら再び現状へ戻る（保持が15未満ならその件数でリング）。
    peek() {
      if (this.empty) return null;
      const entry = this._entries[this._pointer];
      return Object.assign({}, entry, { historyNumber: this._pointer });
    }

    next() {
      if (this.empty) return null;
      this._pointer = (this._pointer + 1) % this._entries.length;
      return this.peek();
    }

    nextFrame() {
      const entry = this.next();
      if (!entry) return null;
      return buildBlockFrame({
        protocol: this.protocol,
        type: entry.type,
        info: entry.info,
        buildingNo: entry.buildingNo,
        roomNo: entry.roomNo,
        historyNumber: entry.historyNumber,
      });
    }

    // 住戸情報要求はポインタを保持したまま、指定住戸の最新状態を返す。
    dwellingFrame(buildingNo, roomNo) {
      const building = encodeBuilding(buildingNo);
      const room = integer(roomNo, 0, 9999, "住戸番号");
      const entry = this._entries.find(function (item) {
        return item.buildingNo === building && item.roomNo === room;
      });
      if (!entry) return null;
      return buildBlockFrame({
        protocol: this.protocol,
        type: entry.type,
        info: entry.info,
        buildingNo: entry.buildingNo,
        roomNo: entry.roomNo,
        historyNumber: 0,
      });
    }

    toArray() {
      return this._entries.map(function (entry) { return Object.assign({}, entry); });
    }
  }

  return Object.freeze({
    CODE: CODE,
    SIZE: SIZE,
    BLOCK_LENGTH: BLOCK_LENGTH,
    RECORD_LENGTH: RECORD_LENGTH,
    MAX_RECORDS: MAX_RECORDS,
    HISTORY_LIMIT: HISTORY_LIMIT,
    RECORD_HEADER: RECORD_HEADER,
    SCHEDULED_HEADER: SCHEDULED_HEADER,
    SCHEDULED_MARK: SCHEDULED_MARK,
    PROTOCOL: PROTOCOL,
    PROTOCOL_NAMES: PROTOCOL_NAMES,
    PROTOCOL_INFO: PROTOCOL_INFO,
    STYLE: STYLE,
    MODE: MODE,
    protocolInfo: protocolInfo,
    styleOf: styleOf,
    blockTypes: blockTypes,
    findBlockType: findBlockType,
    bitAssignments: bitAssignments,
    bitMask: bitMask,
    encodeInfo: encodeInfo,
    decodeInfo: decodeInfo,
    describeInfo: describeInfo,
    encodeBuilding: encodeBuilding,
    decodeBuilding: decodeBuilding,
    encodeDwelling: encodeDwelling,
    decodeDwelling: decodeDwelling,
    calculateBCC: calculateBCC,
    verifyBCC: verifyBCC,
    calculateChecksum: calculateChecksum,
    checksumText: checksumText,
    alarmNumbers: alarmNumbers,
    findAlarmNumber: findAlarmNumber,
    modeLabel: modeLabel,
    resolveMode: resolveMode,
    encodeRecord: encodeRecord,
    buildBlockFrame: buildBlockFrame,
    parseBlockFrame: parseBlockFrame,
    buildRecordFrame: buildRecordFrame,
    parseRecordFrame: parseRecordFrame,
    buildAnswerback: buildAnswerback,
    buildScheduledFrame: buildScheduledFrame,
    build: buildFrame,
    buildFrame: buildFrame,
    parse: parseFrame,
    parseFrame: parseFrame,
    validate: validateFrame,
    validateFrame: validateFrame,
    PanasonicHistory: PanasonicHistory,
    toHex: toHex,
    toAscii: asciiText,
  });
});
