// パナソニック集合住宅システム（ﾊﾟﾅｿﾆｯｸIFU）↔エレベータの連動プロトコル。
//   通信仕様書（エレベータ連動プロトコル） 2012年 1月10日
// 9600bps・半二重・偶数パリティ。電文は STX＋CMD2＋予備＋モード＋棟番号2＋住戸番号4＋
// LB番号2＋付加コード2＋ETX＋BCC2 の18byte固定で、BCCはCMDからETXまでの総和の
// 下位1byteを16進2文字（JIS8）で表す。ACKが10H／30Hの2種類ある点がアイホンQ46-005Jと違う。
// Browser: window.PanasonicElevator / Node: require("./protocol/panasonic-elevator.js")
(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.PanasonicElevator = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";

  const CODE = Object.freeze({
    STX: 0x02, ETX: 0x03, EOT: 0x04, ENQ: 0x05,
    // 正常応答は10Hと30Hのどちらでも成立する。30Hは'0'と同値のため、
    // フレームの外側でだけ制御コードとして扱う。
    ACK: 0x10, ACK_ALT: 0x30,
    SPACE: 0x20,
  });
  const ACK_CODES = Object.freeze([CODE.ACK, CODE.ACK_ALT]);
  const FRAME_LENGTH = 18;
  const MODE = "N";
  const DIRECTION = Object.freeze({ TO_ELEVATOR: "toElevator", FROM_ELEVATOR: "fromElevator" });

  // 通信手順の規定値。ENQ衝突時の再送待ちは、エレベータ1秒・パナソニック2秒と
  // 差をつけることで再送時の衝突を避ける。
  const TIMING = Object.freeze({
    ackTimeoutMs: 1000,
    sendAttempts: 3,          // 1回の送信＋リトライ2回
    idleAfterAckMs: 5000,     // ACK送出後にEOT／次データが来なければ相手の送信終了とみなす
    healthIntervalMs: 60_000, // ヘルスチェックの間隔は1分
    healthResponseMs: 1000,   // 送信完了後1秒以内に応答があれば通信正常
    collisionBackoffMs: Object.freeze({ [DIRECTION.TO_ELEVATOR]: 2000, [DIRECTION.FROM_ELEVATOR]: 1000 }),
  });

  // 電文のフィールド割付（オフセット, 長さ）。
  const FIELD = Object.freeze({
    STX: Object.freeze({ offset: 0, length: 1 }),
    COMMAND: Object.freeze({ offset: 1, length: 2 }),
    SPARE: Object.freeze({ offset: 3, length: 1 }),
    MODE: Object.freeze({ offset: 4, length: 1 }),
    BUILDING: Object.freeze({ offset: 5, length: 2 }),
    ROOM: Object.freeze({ offset: 7, length: 4 }),
    LB: Object.freeze({ offset: 11, length: 2 }),
    EXTRA: Object.freeze({ offset: 13, length: 2 }),
    ETX: Object.freeze({ offset: 15, length: 1 }),
    BCC: Object.freeze({ offset: 16, length: 2 }),
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

  function bytes(value, name) {
    if (value == null || typeof value.length !== "number") throw new TypeError(name + "はバイト配列で指定してください");
    return Array.from(value, function (item, index) {
      const byte = Number(item);
      if (!Number.isInteger(byte) || byte < 0 || byte > 0xFF) throw new RangeError(name + "[" + index + "]が0～255ではありません");
      return byte;
    });
  }

  function asciiBytes(text, name) {
    const source = String(text);
    return Array.from(source, function (character, index) {
      const code = source.charCodeAt(index);
      if (code > 0x7F) throw new RangeError(name + "にJIS8で送れない文字が含まれています: " + character);
      return code;
    });
  }

  function asciiText(value) {
    return bytes(value, "value").map(function (item) { return String.fromCharCode(item); }).join("");
  }

  function digitsText(value, width, name) {
    const number = integer(value, 0, Math.pow(10, width) - 1, name);
    return String(number).padStart(width, "0");
  }

  // ------------------------------------------------------------------
  // コマンド台帳
  // ------------------------------------------------------------------

  // 各コマンドで使える桁を持つ。使わない桁は仕様上0固定で、勝手な値を載せない。
  function extra(code, label, options) {
    const opts = options || {};
    return Object.freeze({
      code: code,
      label: label,
      building: opts.building === true,
      room: opts.room === true,
    });
  }

  const COMMANDS = Object.freeze([
    Object.freeze({
      code: "IE", label: "住戸でのエレベータコール", direction: DIRECTION.TO_ELEVATOR,
      building: true, room: true, lb: false,
      extras: Object.freeze([extra("00", "住戸でのエレベータコール", { building: true, room: true })]),
    }),
    Object.freeze({
      code: "IK", label: "共同玄関解錠", direction: DIRECTION.TO_ELEVATOR,
      building: true, room: true, lb: true,
      // 付加コードで解錠の種類が変わり、住戸を特定できるのは00だけ。
      extras: Object.freeze([
        extra("00", "住戸による共同玄関解錠", { building: true, room: true }),
        extra("01", "管理室による共同玄関解錠"),
        extra("02", "暗証番号による共同玄関解錠"),
      ]),
    }),
    Object.freeze({
      code: "IH", label: "ヘルスチェック", direction: DIRECTION.TO_ELEVATOR,
      building: false, room: false, lb: false,
      extras: Object.freeze([extra("00", "ヘルスチェック")]),
    }),
    Object.freeze({
      code: "SB", label: "非接触キーID情報", direction: DIRECTION.TO_ELEVATOR,
      building: true, room: true, lb: true,
      // 付加コードは仕様書で■■（内容の規定なし）のため、2桁を自由に指定できる。
      extras: null,
    }),
    Object.freeze({
      code: "SH", label: "ヘルスチェック応答", direction: DIRECTION.FROM_ELEVATOR,
      building: false, room: false, lb: false,
      extras: Object.freeze([
        extra("00", "正常運行中"),
        extra("01", "点検中"),
      ]),
    }),
  ]);

  const COMMAND_CODES = Object.freeze(COMMANDS.map(function (entry) { return entry.code; }));

  function commands(direction) {
    if (direction == null) return COMMANDS.slice();
    const name = resolveDirection(direction);
    return COMMANDS.filter(function (entry) { return entry.direction === name; });
  }

  function resolveDirection(value) {
    const name = value == null ? "" : String(value);
    if (name !== DIRECTION.TO_ELEVATOR && name !== DIRECTION.FROM_ELEVATOR) {
      throw new RangeError("方向はtoElevatorまたはfromElevatorで指定してください");
    }
    return name;
  }

  function findCommand(code) {
    const text = String(code == null ? "" : code).toUpperCase();
    const entry = COMMANDS.find(function (item) { return item.code === text; });
    if (!entry) throw new RangeError("未知のコマンドです: " + (code == null ? "(指定なし)" : code));
    return entry;
  }

  function findExtra(entry, code) {
    if (!entry.extras) return null;
    const text = String(code == null ? "" : code);
    return entry.extras.find(function (item) { return item.code === text; }) || null;
  }

  // 付加コードによって住戸を特定できるかが変わるため、実際に使える桁をここで確定する。
  function fieldUsage(entry, extraCode) {
    const matched = findExtra(entry, extraCode);
    return {
      building: entry.building && (matched ? matched.building : true),
      room: entry.room && (matched ? matched.room : true),
      lb: entry.lb,
      extra: matched,
    };
  }

  // ------------------------------------------------------------------
  // BCC
  // ------------------------------------------------------------------

  function hexDigit(value) {
    return "0123456789ABCDEF".charCodeAt(value & 0x0F);
  }

  // CMD(コマンド)からETXまでのHEX総和の最下位1byteの上位・下位4bitをJIS8へ変換する。
  function calculateBCC(frameWithoutBcc) {
    const frame = bytes(frameWithoutBcc, "frameWithoutBcc");
    if (frame.length < 2 || frame[0] !== CODE.STX) throw new Error("BCCの入力はSTXで始まる必要があります");
    let sum = 0;
    for (let index = FIELD.COMMAND.offset; index < frame.length; index += 1) sum = (sum + frame[index]) & 0xFF;
    return [hexDigit(sum >> 4), hexDigit(sum)];
  }

  function verifyBCC(frame) {
    try {
      const packet = bytes(frame, "frame");
      if (packet.length !== FRAME_LENGTH) return false;
      const expected = calculateBCC(packet.slice(0, FIELD.BCC.offset));
      const received = packet.slice(FIELD.BCC.offset);
      // 相手装置が小文字で送る場合にも読めるよう、16進数の値で突き合わせる。
      return bccValue(expected) === bccValue(received);
    } catch (_error) {
      return false;
    }
  }

  function bccValue(pair) {
    const text = asciiText(pair);
    if (!/^[0-9A-Fa-f]{2}$/.test(text)) return null;
    return Number.parseInt(text, 16);
  }

  // ------------------------------------------------------------------
  // 電文
  // ------------------------------------------------------------------

  function buildFrame(options) {
    if (options == null || typeof options !== "object") throw new TypeError("電文の指定が必要です");
    const entry = findCommand(options.command);
    const extraCode = resolveExtraCode(entry, options.extraCode);
    const usage = fieldUsage(entry, extraCode);

    const buildingNo = options.buildingNo == null ? 0 : options.buildingNo;
    const roomNo = options.roomNo == null ? 0 : options.roomNo;
    const lbNo = options.lbNo == null ? 0 : options.lbNo;
    if (!usage.building && integer(buildingNo, 0, 99, "棟番号") !== 0) {
      throw new Error(describeUsage(entry, usage) + "の棟番号は00固定です");
    }
    if (!usage.room && integer(roomNo, 0, 9999, "住戸番号") !== 0) {
      throw new Error(describeUsage(entry, usage) + "の住戸番号は0000固定です");
    }
    if (!usage.lb && integer(lbNo, 0, 99, "LB番号") !== 0) {
      throw new Error(describeUsage(entry, usage) + "のLB番号は00固定です");
    }

    const text = entry.code
      + String.fromCharCode(CODE.SPACE)
      + MODE
      + digitsText(usage.building ? buildingNo : 0, FIELD.BUILDING.length, "棟番号")
      + digitsText(usage.room ? roomNo : 0, FIELD.ROOM.length, "住戸番号")
      + digitsText(usage.lb ? lbNo : 0, FIELD.LB.length, "LB番号")
      + extraCode;
    const frame = [CODE.STX].concat(asciiBytes(text, "電文"), [CODE.ETX]);
    if (frame.length !== FIELD.BCC.offset) throw new Error("電文長を組み立てられませんでした");
    return frame.concat(calculateBCC(frame));
  }

  function resolveExtraCode(entry, value) {
    if (entry.extras) {
      const code = value == null ? entry.extras[0].code : String(value);
      if (!findExtra(entry, code)) {
        throw new RangeError(entry.code + "の付加コードは" + entry.extras.map(function (item) { return item.code; }).join("／") + "のいずれかです");
      }
      return code;
    }
    // 規定のない付加コードは2桁の数字として扱う。
    const code = value == null ? "00" : String(value);
    if (!/^\d{2}$/.test(code)) throw new RangeError(entry.code + "の付加コードは2桁の数字で指定してください");
    return code;
  }

  function describeUsage(entry, usage) {
    return usage.extra ? usage.extra.label : entry.label;
  }

  function parseFrame(value, options) {
    const opts = options || {};
    const frame = bytes(value, "frame");
    if (frame.length !== FRAME_LENGTH) throw new Error("電文は" + FRAME_LENGTH + "byteちょうどである必要があります");
    if (frame[FIELD.STX.offset] !== CODE.STX) throw new Error("STXが02Hではありません");
    if (frame[FIELD.ETX.offset] !== CODE.ETX) throw new Error("ETXが03Hではありません");
    if (!verifyBCC(frame)) throw new Error("BCCが一致しません");

    const entry = findCommand(asciiText(frame.slice(FIELD.COMMAND.offset, FIELD.COMMAND.offset + FIELD.COMMAND.length)));
    if (frame[FIELD.SPARE.offset] !== CODE.SPACE) throw new Error("予備が20H（スペース）ではありません");
    const mode = String.fromCharCode(frame[FIELD.MODE.offset]);
    if (mode !== MODE) throw new Error("モードが" + MODE + "ではありません");

    const buildingText = asciiText(frame.slice(FIELD.BUILDING.offset, FIELD.BUILDING.offset + FIELD.BUILDING.length));
    const roomText = asciiText(frame.slice(FIELD.ROOM.offset, FIELD.ROOM.offset + FIELD.ROOM.length));
    const lbText = asciiText(frame.slice(FIELD.LB.offset, FIELD.LB.offset + FIELD.LB.length));
    const extraCode = asciiText(frame.slice(FIELD.EXTRA.offset, FIELD.EXTRA.offset + FIELD.EXTRA.length));
    if (!/^\d{2}$/.test(buildingText)) throw new Error("棟番号が2桁の数字ではありません");
    if (!/^\d{4}$/.test(roomText)) throw new Error("住戸番号が4桁の数字ではありません");
    if (!/^\d{2}$/.test(lbText)) throw new Error("LB番号が2桁の数字ではありません");
    if (entry.extras && !findExtra(entry, extraCode)) {
      throw new Error(entry.code + "に付加コード" + extraCode + "はありません");
    }
    if (!entry.extras && !/^\d{2}$/.test(extraCode)) throw new Error("付加コードが2桁の数字ではありません");

    if (opts.direction != null && resolveDirection(opts.direction) !== entry.direction) {
      throw new Error(entry.code + "は" + (entry.direction === DIRECTION.TO_ELEVATOR ? "IFU→エレベータ" : "エレベータ→IFU") + "の電文です");
    }

    const usage = fieldUsage(entry, extraCode);
    const buildingNo = Number(buildingText);
    const roomNo = Number(roomText);
    const lbNo = Number(lbText);
    if (!usage.building && buildingNo !== 0) throw new Error(describeUsage(entry, usage) + "の棟番号は00固定です");
    if (!usage.room && roomNo !== 0) throw new Error(describeUsage(entry, usage) + "の住戸番号は0000固定です");
    if (!usage.lb && lbNo !== 0) throw new Error(describeUsage(entry, usage) + "のLB番号は00固定です");

    return {
      command: entry.code,
      commandLabel: entry.label,
      direction: entry.direction,
      mode: mode,
      buildingNo: buildingNo,
      roomNo: roomNo,
      lbNo: lbNo,
      extraCode: extraCode,
      extraLabel: usage.extra ? usage.extra.label : null,
      usage: Object.freeze({ building: usage.building, room: usage.room, lb: usage.lb }),
      bcc: bccValue(frame.slice(FIELD.BCC.offset)),
      bytes: frame.slice(),
    };
  }

  function validateFrame(value, options) {
    try {
      parseFrame(value, options);
      return true;
    } catch (_error) {
      return false;
    }
  }

  function isAck(code) {
    return ACK_CODES.indexOf(Number(code)) !== -1;
  }

  // ヘルスチェック(IH)へは、運行状態を載せたヘルスチェック応答(SH)を返す。
  function healthResponse(frame, options) {
    const opts = options || {};
    const parsed = parseFrame(frame, { direction: DIRECTION.TO_ELEVATOR });
    if (parsed.command !== "IH") return null;
    return buildFrame({ command: "SH", extraCode: opts.inspection === true ? "01" : "00" });
  }

  function healthRequest() {
    return buildFrame({ command: "IH" });
  }

  function toHex(value) {
    return bytes(value, "value").map(function (item) { return item.toString(16).toUpperCase().padStart(2, "0"); }).join(" ");
  }

  return Object.freeze({
    CODE: CODE,
    ACK_CODES: ACK_CODES,
    FRAME_LENGTH: FRAME_LENGTH,
    MODE: MODE,
    DIRECTION: DIRECTION,
    TIMING: TIMING,
    FIELD: FIELD,
    COMMANDS: COMMANDS,
    COMMAND_CODES: COMMAND_CODES,
    commands: commands,
    findCommand: findCommand,
    findExtra: findExtra,
    fieldUsage: fieldUsage,
    resolveDirection: resolveDirection,
    calculateBCC: calculateBCC,
    verifyBCC: verifyBCC,
    isAck: isAck,
    build: buildFrame,
    buildFrame: buildFrame,
    parse: parseFrame,
    parseFrame: parseFrame,
    validate: validateFrame,
    validateFrame: validateFrame,
    healthRequest: healthRequest,
    healthResponse: healthResponse,
    toHex: toHex,
    toAscii: asciiText,
  });
});
