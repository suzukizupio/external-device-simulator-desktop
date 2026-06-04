// 宅配ボックス(4線式 B方式) 通信電文ビルダー
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
    EMPTY: 0x30,        // 荷物なし
    PARCEL: 0x31,       // 荷物あり
    PICKUP_HOLD: 0x32,  // 集荷預かり
    PICKUP_DONE: 0x33,  // 集荷回収
    FOOD: 0x34,         // 食配着荷
    REGISTERED: 0x35,   // 書留着荷
    ROBO_DEPART: 0x40,  // 宅配ロボ出発
    ROBO_NEAR: 0x41,    // 宅配ロボ接近
    ROBO_ARRIVE: 0x42,  // 宅配ロボ到着
  };
  // 状態の表示名(UI/ログ用)
  const STATE_LABEL = {
    0x30: "荷物なし", 0x31: "荷物あり", 0x32: "集荷預かり", 0x33: "集荷回収",
    0x34: "食配着荷", 0x35: "書留着荷", 0x40: "宅配ロボ出発", 0x41: "宅配ロボ接近", 0x42: "宅配ロボ到着"
  };

  // 数値 → 固定桁のASCIIバイト列（"001"等）。下位 width 桁を採用。
  function ascii(num, width) {
    const s = String(Math.abs(Math.trunc(num))).padStart(width, "0").slice(-width);
    return Array.from(s, c => c.charCodeAt(0));
  }

  // 4.2/4.3.3 BCC = STXの次のキャラクタからETX(含む)までの排他的論理和(XOR)
  // frame: STXを含み末尾がETXの配列（BCC付与前）
  function calcBCC(frame) {
    let v = 0;
    for (let i = 1; i < frame.length; i++) v ^= frame[i]; // i=0(STX)を除外、ETXまで含む
    return v & 0xFF;
  }

  // ロッカーデータ1件(10byte)。lk = {state, lockerNo, buildingNo, roomNo, data2?}
  function buildLockerData(lk) {
    return [
      lk.state & 0xFF,                          // #1 DATA1 状態
      (lk.data2 != null ? lk.data2 : CODE.SP),  // #2 DATA2 20H固定
      ...ascii(lk.lockerNo, 3),                 // #3-5 ロッカーNO
      ...ascii(lk.buildingNo, 1),               // #6 棟NO
      ...ascii(lk.roomNo, 4),                   // #7-10 住戸NO
    ];
  }

  // 4.3.4-5① ロッカー情報要求時(システム→宅配)のロッカーデータ: 32 20 30 20 20 20 20 20 20 20
  function buildRequestLockerData() {
    return [0x32, 0x20, 0x30, 0x20, 0x20, 0x20, 0x20, 0x20, 0x20, 0x20];
  }

  // テキスト電文(STX..ETX BCC)を生成
  // opts = { srcId?, dstId?, packageNo?, modelNo?, lockers:[{state,lockerNo,buildingNo,roomNo}] }
  function buildTextTelegram(opts) {
    opts = opts || {};
    const srcId = opts.srcId != null ? opts.srcId : ID.LOCKER;   // 擬似装置=宅配側 発信37H
    const dstId = opts.dstId != null ? opts.dstId : ID.SYSTEM;   // 着信38H
    const packageNo = opts.packageNo != null ? opts.packageNo : 0;
    const modelNo = opts.modelNo != null ? opts.modelNo : 1;     // 送信時 "001" 固定

    const lockerBytes = [];
    for (const lk of (opts.lockers || [])) lockerBytes.push(...buildLockerData(lk));

    // 4.3.4-2 データ長 = パッケージNO(2) + 機種NO(3) + ロッカーデータ(10×n)
    const dataLen = 2 + 3 + lockerBytes.length;

    const frame = [
      CODE.STX,
      srcId, dstId,
      ...ascii(dataLen, 3),
      ...ascii(packageNo, 2),
      ...ascii(modelNo, 3),
      ...lockerBytes,
      CODE.ETX,
    ];
    frame.push(calcBCC(frame));
    return frame;
  }

  // 16進文字列化
  function toHex(arr) { return arr.map(b => b.toString(16).toUpperCase().padStart(2, "0")).join(" "); }

  const api = { CODE, ID, STATE, STATE_LABEL, ascii, calcBCC, buildLockerData, buildRequestLockerData, buildTextTelegram, toHex };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else global.Telegram4 = api;

})(typeof window !== "undefined" ? window : globalThis);
