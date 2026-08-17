// 宅配ボックス(4線式 B方式) 通信電文ビルダー/パーサー
// 仕様書: 【Q48-005F】集合住宅システム4線式(B方式)宅配ボックス通信仕様書 Ver.1.24
// ブラウザ(renderer)では window.Telegram4、Node(テスト)では require で使えるUMD形式。
(function (global) {
  "use strict";

  // 4.3.2 伝送コード
  const CODE = { NULL: 0x00, STX: 0x02, ETX: 0x03, EOT: 0x04, ENQ: 0x05, ACK: 0x06, NAK: 0x15, SP: 0x20 };

  // 4.3.3 装置ID（宅配ボックス=37H / 集合住宅システム=38H）
  const ID = { LOCKER: 0x37, SYSTEM: 0x38 };

  // 4.3.4-5② ロッカーデータ DATA1(状態)
  const STATE = {
    EMPTY: 0x30,
    PARCEL: 0x31,
    PICKUP_HOLD: 0x32,
    PICKUP_DONE: 0x33,
    FOOD: 0x34,
    REGISTERED: 0x35,
    ROBO_DEPART: 0x40,
    ROBO_NEAR: 0x41,
    ROBO_ARRIVE: 0x42,
  };
  const STATE_LABEL = {
    0x30: "荷物なし", 0x31: "荷物あり", 0x32: "集荷預かり", 0x33: "集荷回収",
    0x34: "食配着荷", 0x35: "書留着荷", 0x40: "宅配ロボ出発", 0x41: "宅配ロボ接近", 0x42: "宅配ロボ到着"
  };
  const VALID_STATES = new Set(Object.values(STATE));

  function fail(message) { throw new RangeError(message); }

  function integer(value, name, min, max) {
    let n;
    if (typeof value === "number") n = value;
    else if (typeof value === "string" && /^\d+$/.test(value.trim())) n = Number(value.trim());
    else fail(`${name}は${min}～${max}の整数で指定してください`);
    if (!Number.isSafeInteger(n) || n < min || n > max) {
      fail(`${name}は${min}～${max}の整数で指定してください`);
    }
    return n;
  }

  function byteArray(input, name) {
    if (!input || typeof input.length !== "number") throw new TypeError(`${name || "データ"}はバイト配列で指定してください`);
    const out = Array.from(input);
    out.forEach((value, index) => {
      if (!Number.isInteger(value) || value < 0 || value > 0xFF) {
        throw new RangeError(`${name || "データ"}の${index}バイト目が不正です`);
      }
    });
    return out;
  }

  function ascii(value, width) {
    const digits = integer(width, "桁数", 1, 9);
    const n = integer(value, "数値", 0, (10 ** digits) - 1);
    return Array.from(String(n).padStart(digits, "0"), c => c.charCodeAt(0));
  }

  function decodeAscii(data, name, min, max) {
    if (data.some(value => value < 0x30 || value > 0x39)) fail(`${name}はASCII数字でなければなりません`);
    return integer(String.fromCharCode(...data), name, min, max);
  }

  // BCC = STXの次のキャラクタからETX(含む)までの排他的論理和(XOR)
  function calcBCC(input) {
    const frame = byteArray(input, "BCC計算対象");
    if (frame.length < 2 || frame[0] !== CODE.STX || frame[frame.length - 1] !== CODE.ETX) {
      fail("BCC計算対象はSTXで始まりETXで終わらなければなりません");
    }
    let value = 0;
    for (let i = 1; i < frame.length; i++) value ^= frame[i];
    return value & 0xFF;
  }

  function verifyBCC(input) {
    const packet = byteArray(input, "電文");
    if (packet.length < 3 || packet[0] !== CODE.STX || packet[packet.length - 2] !== CODE.ETX) return false;
    return calcBCC(packet.slice(0, -1)) === packet[packet.length - 1];
  }

  function validateState(value) {
    const state = integer(value, "ロッカー状態", 0, 0xFF);
    if (!VALID_STATES.has(state)) fail("未定義のロッカー状態です");
    return state;
  }

  function validateData2(value) {
    const data2 = value == null ? CODE.SP : integer(value, "DATA2", 0, 0xFF);
    if (data2 !== CODE.SP && (data2 < 0x30 || data2 > 0x39)) fail("DATA2は20Hまたは30H～39Hでなければなりません");
    return data2;
  }

  // ロッカーデータ1件(10byte)。lk = {state, lockerNo, buildingNo, roomNo, data2?}
  function buildLockerData(lk) {
    if (!lk || typeof lk !== "object") throw new TypeError("ロッカーデータを指定してください");
    return [
      validateState(lk.state),
      validateData2(lk.data2),
      ...ascii(integer(lk.lockerNo, "ロッカーNO", 0, 999), 3),
      ...ascii(integer(lk.buildingNo, "棟NO", 0, 9), 1),
      ...ascii(integer(lk.roomNo, "住戸NO", 0, 9999), 4),
    ];
  }

  function parseLockerData(input) {
    const data = byteArray(input, "ロッカーデータ");
    if (data.length !== 10) fail("ロッカーデータは10バイトでなければなりません");
    return {
      state: validateState(data[0]),
      data2: validateData2(data[1]),
      lockerNo: decodeAscii(data.slice(2, 5), "ロッカーNO", 0, 999),
      buildingNo: decodeAscii(data.slice(5, 6), "棟NO", 0, 9),
      roomNo: decodeAscii(data.slice(6, 10), "住戸NO", 0, 9999),
    };
  }

  // 4.3.4-5① ロッカー情報要求時の固定ロッカーデータ
  function buildRequestLockerData() {
    return [0x32, 0x20, 0x30, 0x20, 0x20, 0x20, 0x20, 0x20, 0x20, 0x20];
  }

  function validateId(value, name) {
    const id = integer(value, name, 0, 0xFF);
    if (id !== ID.LOCKER && id !== ID.SYSTEM) fail(`${name}は37Hまたは38Hでなければなりません`);
    return id;
  }

  function buildFrame(srcId, dstId, packageNo, modelBytes, data) {
    const source = validateId(srcId, "発信ID");
    const destination = validateId(dstId, "着信ID");
    if (source === destination) fail("発信IDと着信IDは異なる必要があります");
    const packetNumber = integer(packageNo, "パッケージNO", 0, 99);
    const model = byteArray(modelBytes, "機種NO");
    if (model.length !== 3) fail("機種NOは3バイトでなければなりません");
    const payload = byteArray(data, "データ");
    const dataLength = 5 + payload.length;
    if (dataLength > 999) fail("データ長が3桁を超えています");
    const frame = [
      CODE.STX,
      source,
      destination,
      ...ascii(dataLength, 3),
      ...ascii(packetNumber, 2),
      ...model,
      ...payload,
      CODE.ETX,
    ];
    frame.push(calcBCC(frame));
    return frame;
  }

  function buildResponseTelegram(opts) {
    opts = opts || {};
    const lockers = opts.lockers;
    if (!Array.isArray(lockers) || lockers.length < 1 || lockers.length > 10) {
      fail("応答1パケットのロッカーデータは1～10件でなければなりません");
    }
    if (opts.srcId != null && validateId(opts.srcId, "発信ID") !== ID.LOCKER) fail("応答の発信IDは37H固定です");
    if (opts.dstId != null && validateId(opts.dstId, "着信ID") !== ID.SYSTEM) fail("応答の着信IDは38H固定です");
    const packageNo = opts.packageNo == null ? 0 : integer(opts.packageNo, "パッケージNO", 0, 99);
    const modelNo = opts.modelNo == null ? 1 : integer(opts.modelNo, "機種NO", 0, 999);
    const lockerBytes = [];
    for (const locker of lockers) lockerBytes.push(...buildLockerData(locker));
    return buildFrame(ID.LOCKER, ID.SYSTEM, packageNo, ascii(modelNo, 3), lockerBytes);
  }

  // 従来API。宅配ボックスから集合住宅システムへの応答/変化通知を生成する。
  function buildTextTelegram(opts) { return buildResponseTelegram(opts); }

  function buildRequestTelegram(opts) {
    opts = opts || {};
    const modelBytes = opts.modelNo == null
      ? [CODE.SP, CODE.SP, CODE.SP]
      : ascii(integer(opts.modelNo, "機種NO", 0, 999), 3);
    return buildFrame(ID.SYSTEM, ID.LOCKER, 0, modelBytes, buildRequestLockerData());
  }

  function decodeModel(data) {
    if (data.every(value => value === CODE.SP)) return null;
    if (data.some(value => value === CODE.SP)) fail("機種NOは3桁ASCII数字または20H×3でなければなりません");
    return decodeAscii(data, "機種NO", 0, 999);
  }

  function parseTelegram(input) {
    const packet = byteArray(input, "電文");
    if (packet.length < 23) fail("電文が短すぎます");
    if (packet[0] !== CODE.STX) fail("STXがありません");
    if (packet[packet.length - 2] !== CODE.ETX) fail("ETX位置が不正です");
    if (!verifyBCC(packet)) fail("BCCが一致しません");

    const srcId = validateId(packet[1], "発信ID");
    const dstId = validateId(packet[2], "着信ID");
    if (srcId === dstId) fail("発信IDと着信IDが同一です");
    const dataLength = decodeAscii(packet.slice(3, 6), "データ長", 0, 999);
    const etxIndex = packet.length - 2;
    if (dataLength !== etxIndex - 6) fail("データ長と実データ長が一致しません");
    const packageNo = decodeAscii(packet.slice(6, 8), "パッケージNO", 0, 99);
    const modelNo = decodeModel(packet.slice(8, 11));
    const payload = packet.slice(11, etxIndex);
    if (payload.length < 10 || payload.length > 100 || payload.length % 10 !== 0) {
      fail("ロッカーデータは1～10件の10バイト単位でなければなりません");
    }

    if (srcId === ID.SYSTEM && dstId === ID.LOCKER) {
      if (packageNo !== 0) fail("情報要求のパッケージNOは00固定です");
      if (payload.length !== 10 || toHex(payload) !== toHex(buildRequestLockerData())) fail("情報要求データが不正です");
      return { type: "request", srcId, dstId, dataLength, packageNo, modelNo, lockers: [] };
    }
    if (srcId !== ID.LOCKER || dstId !== ID.SYSTEM) fail("未定義の通信方向です");
    if (modelNo == null) fail("応答の機種NOはASCII数字でなければなりません");
    const lockers = [];
    for (let offset = 0; offset < payload.length; offset += 10) {
      lockers.push(parseLockerData(payload.slice(offset, offset + 10)));
    }
    return { type: "response", srcId, dstId, dataLength, packageNo, modelNo, lockers };
  }

  function buildResponsePackets(opts) {
    opts = opts || {};
    if (!Array.isArray(opts.lockers) || opts.lockers.length === 0) fail("ロッカーデータを1件以上指定してください");
    const packetSize = opts.packetSize == null ? 10 : integer(opts.packetSize, "1パケット件数", 1, 10);
    const packetCount = Math.ceil(opts.lockers.length / packetSize);
    if (packetCount > 100) fail("パッケージNOで表現できる最大100パケットを超えています");
    const modelNo = opts.modelNo == null ? 1 : integer(opts.modelNo, "機種NO", 0, 999);
    const packets = [];
    for (let index = 0; index < packetCount; index++) {
      packets.push(buildResponseTelegram({
        packageNo: packetCount - 1 - index,
        modelNo,
        lockers: opts.lockers.slice(index * packetSize, (index + 1) * packetSize),
      }));
    }
    return packets;
  }

  function toHex(arr) { return Array.from(arr).map(b => b.toString(16).toUpperCase().padStart(2, "0")).join(" "); }

  const api = {
    CODE,
    ID,
    STATE,
    STATE_LABEL,
    ascii,
    calcBCC,
    verifyBCC,
    buildLockerData,
    parseLockerData,
    buildRequestLockerData,
    buildTextTelegram,
    buildResponseTelegram,
    buildRequestTelegram,
    buildResponsePackets,
    parseTelegram,
    toHex,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else global.Telegram4 = api;

})(typeof window !== "undefined" ? window : globalThis);
