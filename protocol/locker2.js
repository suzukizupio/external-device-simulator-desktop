// 宅配ボックス(2線式) 通信電文ビルダー/パーサー
// 仕様書: 【Q55-001D】集合住宅システム宅配ボックス連動インターフェイス仕様書 V1.24
// 特徴: 単方向通信・BCCなし・11バイト固定。ブラウザでは window.Telegram2、Nodeでは require。
(function (global) {
  "use strict";

  const CODE = { STX: 0x02, ETX: 0x03, SP: 0x3F };

  // 4.3.3 コマンド（ON=お届け/フリッカ=滞留/OFF=取り出し）
  const CMD = { ARRIVE: 0x11, STAY: 0x12, PICKUP: 0x13 };
  const CMD_LABEL = { 0x11: "着荷(お届け)", 0x12: "滞留", 0x13: "取り出し" };
  const VALID_COMMANDS = new Set(Object.values(CMD));

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

  function validateCommand(command) {
    const value = integer(command, "コマンド", 0, 0xFF);
    if (!VALID_COMMANDS.has(value)) fail("コマンドは11H、12H、13Hのいずれかを指定してください");
    return value;
  }

  // 棟No: 1～8 → 0x31～0x38、0/なし → 0x3F（仕様書注4）
  function buildingByte(value) {
    const buildingNo = integer(value, "棟No", 0, 8);
    return buildingNo === 0 ? CODE.SP : 0x30 + buildingNo;
  }

  function parseBuildingByte(value) {
    if (value === CODE.SP) return 0;
    if (value >= 0x31 && value <= 0x38) return value - 0x30;
    fail("棟Noバイトは3FHまたは31H～38Hでなければなりません");
  }

  // 住戸番号: 1～9999、4桁右詰め、空き桁は3FH。
  function room4(value) {
    const roomNo = integer(value, "住戸番号", 1, 9999);
    return Array.from(String(roomNo).padStart(4, " "), c => (c === " " ? CODE.SP : c.charCodeAt(0)));
  }

  // 住戸アドレス: 001～800。
  function addr3(value) {
    const address = integer(value, "住戸アドレス", 1, 800);
    return Array.from(String(address).padStart(3, "0"), c => c.charCodeAt(0));
  }

  function bytes(input, expectedLength) {
    if (!input || typeof input.length !== "number") throw new TypeError("電文はバイト配列で指定してください");
    const out = Array.from(input);
    if (out.length !== expectedLength) throw new RangeError(`電文長は${expectedLength}バイトでなければなりません`);
    out.forEach((value, index) => {
      if (!Number.isInteger(value) || value < 0 || value > 0xFF) {
        throw new RangeError(`電文の${index}バイト目が不正です`);
      }
    });
    return out;
  }

  function decodeRoom(data) {
    let seenDigit = false;
    let text = "";
    for (const value of data) {
      if (value === CODE.SP && !seenDigit) continue;
      if (value < 0x30 || value > 0x39) fail("住戸番号は先頭の3FHとASCII数字でなければなりません");
      seenDigit = true;
      text += String.fromCharCode(value);
    }
    if (!text) fail("住戸番号が空です");
    const roomNo = integer(text, "住戸番号", 1, 9999);
    if (toHex(room4(roomNo)) !== toHex(data)) fail("住戸番号が正規形式ではありません");
    return roomNo;
  }

  function decodeAddress(data) {
    if (data.some(value => value < 0x30 || value > 0x39)) fail("住戸アドレスはASCII数字でなければなりません");
    const address = integer(String.fromCharCode(...data), "住戸アドレス", 1, 800);
    if (toHex(addr3(address)) !== toHex(data)) fail("住戸アドレスが正規形式ではありません");
    return address;
  }

  // 電文(11バイト固定)。仕様順は 棟No → 住戸番号4桁 → 住戸アドレス3桁。
  function buildTelegram(opts) {
    opts = opts || {};
    const command = validateCommand(opts.command);
    const buildingNo = integer(opts.buildingNo, "棟No", 0, 8);
    const roomNo = integer(opts.roomNo, "住戸番号", 1, 9999);
    const address = integer(opts.address, "住戸アドレス", 1, 800);
    return [
      CODE.STX,
      command,
      buildingByte(buildingNo),
      ...room4(roomNo),
      ...addr3(address),
      CODE.ETX,
    ];
  }

  function parseTelegram(input) {
    const packet = bytes(input, 11);
    if (packet[0] !== CODE.STX) fail("STXがありません");
    if (packet[10] !== CODE.ETX) fail("ETXがありません");
    const command = validateCommand(packet[1]);
    const buildingNo = parseBuildingByte(packet[2]);
    const roomNo = decodeRoom(packet.slice(3, 7));
    const address = decodeAddress(packet.slice(7, 10));
    return { command, buildingNo, roomNo, address };
  }

  // 登録住戸は「棟No+住戸番号」と住戸アドレスがそれぞれ一意でなければならない。
  function validateRegistrationList(list, options) {
    options = options || {};
    if (!Array.isArray(list)) throw new TypeError("登録リストは配列で指定してください");
    const maxEntries = options.maxEntries == null ? 100 : integer(options.maxEntries, "最大登録数", 1, 100);
    if (list.length > maxEntries) fail(`登録数は${maxEntries}件以下でなければなりません`);

    let allowedBuildings = null;
    if (options.allowedBuildingNos != null) {
      if (!Array.isArray(options.allowedBuildingNos) || options.allowedBuildingNos.length === 0) {
        throw new TypeError("allowedBuildingNosは1件以上の配列で指定してください");
      }
      allowedBuildings = new Set(options.allowedBuildingNos.map(value => integer(value, "許可棟No", 0, 8)));
    }

    const addresses = new Set();
    const residences = new Set();
    return list.map((entry, index) => {
      if (!entry || typeof entry !== "object") throw new TypeError(`登録リストの${index + 1}件目が不正です`);
      const buildingNo = integer(entry.buildingNo, `登録${index + 1}の棟No`, 0, 8);
      const roomNo = integer(entry.roomNo, `登録${index + 1}の住戸番号`, 1, 9999);
      const address = integer(entry.address, `登録${index + 1}の住戸アドレス`, 1, 800);
      if (allowedBuildings && !allowedBuildings.has(buildingNo)) fail(`登録${index + 1}の棟Noは対象システムで使用できません`);
      if (addresses.has(address)) fail(`住戸アドレス${address}が重複しています`);
      const residenceKey = `${buildingNo}:${roomNo}`;
      if (residences.has(residenceKey)) fail(`棟No${buildingNo}・住戸番号${roomNo}が重複しています`);
      addresses.add(address);
      residences.add(residenceKey);
      const normalized = { buildingNo, roomNo, address };
      if (entry.command != null) normalized.command = validateCommand(entry.command);
      return normalized;
    });
  }

  function toHex(arr) { return Array.from(arr).map(b => b.toString(16).toUpperCase().padStart(2, "0")).join(" "); }

  const api = {
    CODE,
    CMD,
    CMD_LABEL,
    buildingByte,
    room4,
    addr3,
    buildTelegram,
    parseTelegram,
    validateRegistrationList,
    toHex,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else global.Telegram2 = api;

})(typeof window !== "undefined" ? window : globalThis);
