// 宅配ボックス(2線式) 通信電文ビルダー
// 仕様書: 【Q55-001D】集合住宅システム宅配ボックス連動インターフェイス仕様書 V1.24
// 特徴: 単方向通信・BCCなし・11バイト固定。ブラウザでは window.Telegram2、Nodeでは require。
(function (global) {
  "use strict";

  const CODE = { STX: 0x02, ETX: 0x03 };

  // 4.3.3 コマンド（ON=お届け/フリッカ=滞留/OFF=取り出し）
  const CMD = { ARRIVE: 0x11, STAY: 0x12, PICKUP: 0x13 };
  const CMD_LABEL = { 0x11: "着荷(お届け)", 0x12: "滞留", 0x13: "取り出し" };

  // 棟No: 1～8 → 0x31～0x38、0/なし → 0x3F（仕様書注4 / 画面の注意書き）
  function buildingByte(b) {
    b = parseInt(b) || 0;
    return (b >= 1 && b <= 8) ? (0x30 + b) : 0x3F;
  }

  // 住戸番号: 4桁右詰め、空き桁は 3FH(SP)。（注1 例:101→3F 31 30 31 / 1108→31 31 30 38）
  function room4(n) {
    const s = String(Math.abs(parseInt(n) || 0));
    const t = s.length > 4 ? s.slice(-4) : s.padStart(4, " ");
    return Array.from(t, c => (c === " " ? 0x3F : c.charCodeAt(0)));
  }

  // 住戸アドレス: 3桁、頭0埋め(0x30)。（注2 例:1→001 / 25→025）
  function addr3(n) {
    const s = String(Math.abs(parseInt(n) || 0)).padStart(3, "0").slice(-3);
    return Array.from(s, c => c.charCodeAt(0));
  }

  // 電文(11バイト固定)。BCCなし・単方向。
  // opts = { command, roomNo, buildingNo, address }
  function buildTelegram(opts) {
    opts = opts || {};
    return [
      CODE.STX,                       // [0] STX
      opts.command & 0xFF,            // [1] コマンド
      ...room4(opts.roomNo),          // [2-5] 住戸番号(4)
      buildingByte(opts.buildingNo),  // [6] 棟No(1)
      ...addr3(opts.address),         // [7-9] 住戸アドレス(3)
      CODE.ETX,                       // [10] ETX
    ];
  }

  function toHex(arr) { return arr.map(b => b.toString(16).toUpperCase().padStart(2, "0")).join(" "); }

  const api = { CODE, CMD, CMD_LABEL, buildingByte, room4, addr3, buildTelegram, toHex };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else global.Telegram2 = api;

})(typeof window !== "undefined" ? window : globalThis);
