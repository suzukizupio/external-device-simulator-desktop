// 非接触キー 通信電文ビルダー
// 仕様書: 【Q48-006F】集合住宅インターホンシステム非接触キー通信仕様 Ver1.15
// ブラウザでは window.NoncontactKey、Nodeでは require で使えるUMD形式。
(function (global) {
  "use strict";

  const CODE = { STX: 0x02, ETX: 0x03, ACK: 0x06, NAK: 0x15 };

  const FORMAT = {
    WITH_PERSON: "withPerson", // STX + gate(2) + room(5) + person(3) + ETX + BCC = 13 bytes
    ROOM_ONLY: "roomOnly",     // STX + gate(2) + room(5) + ETX + BCC = 10 bytes
  };

  const FORMAT_LABEL = {
    withPerson: "13バイト: ゲート+ルーム+個人番号",
    roomOnly: "10バイト: ゲート+ルーム",
  };

  function clampNumber(value, min, max, fallback) {
    const n = Number.parseInt(value, 10);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, n));
  }

  function asciiDigits(value, width) {
    const n = Math.abs(Number.parseInt(value, 10) || 0);
    return Array.from(String(n).padStart(width, "0").slice(-width), c => c.charCodeAt(0));
  }

  function asciiDigitString(value, width) {
    const s = String(value == null ? "" : value).replace(/\D/g, "").padStart(width, "0").slice(-width);
    return Array.from(s, c => c.charCodeAt(0));
  }

  function room5(opts) {
    opts = opts || {};
    if (opts.roomNo5 != null && String(opts.roomNo5).trim() !== "") {
      return asciiDigitString(opts.roomNo5, 5);
    }

    const buildingNo = clampNumber(opts.buildingNo, 0, 9, 0);
    const roomNo = clampNumber(opts.roomNo, 0, 9999, 0);
    return [
      0x30 + buildingNo,
      ...asciiDigits(roomNo, 4),
    ];
  }

  function calcBCC(frameWithoutBcc) {
    let v = 0;
    for (let i = 1; i < frameWithoutBcc.length; i++) v ^= frameWithoutBcc[i];
    return v & 0xFF;
  }

  function verifyBCC(packet) {
    let v = 0;
    for (let i = 1; i < packet.length; i++) v ^= packet[i];
    return (v & 0xFF) === 0;
  }

  function buildTelegram(opts) {
    opts = opts || {};
    const format = opts.format || FORMAT.WITH_PERSON;
    const body = [
      ...asciiDigits(clampNumber(opts.gateNo, 1, 99, 1), 2),
      ...room5(opts),
    ];

    if (format !== FORMAT.ROOM_ONLY) {
      body.push(...asciiDigits(clampNumber(opts.personNo, 0, 999, 0), 3));
    }

    const frame = [CODE.STX, ...body, CODE.ETX];
    frame.push(calcBCC(frame));
    return frame;
  }

  function corruptBCC(packet) {
    const copy = packet.slice();
    copy[copy.length - 1] ^= 0x01;
    return copy;
  }

  function toHex(arr) {
    return arr.map(b => b.toString(16).toUpperCase().padStart(2, "0")).join(" ");
  }

  function bytesToAscii(arr) {
    return arr.map(b => (b >= 0x20 && b <= 0x7E) ? String.fromCharCode(b) : ".").join("");
  }

  const api = {
    CODE,
    FORMAT,
    FORMAT_LABEL,
    asciiDigits,
    asciiDigitString,
    room5,
    calcBCC,
    verifyBCC,
    buildTelegram,
    corruptBCC,
    toHex,
    bytesToAscii,
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else global.NoncontactKey = api;
})(typeof window !== "undefined" ? window : globalThis);
