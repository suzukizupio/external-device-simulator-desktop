"use strict";
// 通信条件が食い違ったときの受信バイト列を作るUARTシミュレータ（テスト専用）。
// 実機なしで「ボーレートがずれたまま受けた生データ」を再現し、
// protocol/link-analyzer.js の判定を検証するために使う。

// 送信する線上のビット列（アイドル1、スタート0、データLSB first、パリティ、ストップ1）。
function txBits(bytes, options) {
  const opts = options || {};
  const parity = opts.parity || "none";
  const stopBits = opts.stopBits || 1;
  const dataBits = opts.dataBits || 8;
  const bits = new Array(8).fill(1);
  for (const byte of bytes) {
    bits.push(0);
    let ones = 0;
    for (let index = 0; index < dataBits; index += 1) {
      const bit = (byte >> index) & 1;
      ones += bit;
      bits.push(bit);
    }
    if (parity === "even") bits.push(ones % 2);
    if (parity === "odd") bits.push(1 - (ones % 2));
    for (let index = 0; index < stopBits; index += 1) bits.push(1);
  }
  for (let index = 0; index < 16; index += 1) bits.push(1);
  return bits;
}

// 線上の波形を、別のボーレートでサンプリングして読み取る。
function receive(bits, txBaud, rxBaud, options) {
  const opts = options || {};
  const parity = opts.parity || "none";
  const dataBits = opts.dataBits || 8;
  const oversample = 64;
  const level = [];
  for (const bit of bits) for (let index = 0; index < oversample; index += 1) level.push(bit);

  const rxBitSamples = (oversample * txBaud) / rxBaud;
  const frameBits = 1 + dataBits + (parity === "none" ? 0 : 1);
  const out = [];
  let position = 0;
  while (position < level.length) {
    while (position < level.length && level[position] === 1) position += 1;
    if (position >= level.length) break;
    const start = position;
    let value = 0;
    for (let index = 0; index < dataBits; index += 1) {
      const at = Math.round(start + rxBitSamples * (1.5 + index));
      if (at >= level.length) return out;
      if (level[at]) value |= 1 << index;
    }
    out.push(value);
    position = Math.round(start + rxBitSamples * (frameBits + 0.5));
  }
  return out;
}

// 指定の送信条件で送ったものを、指定の受信条件で受けた結果を返す。
function transfer(bytes, txOptions, rxOptions) {
  const tx = txOptions || {};
  const rx = rxOptions || {};
  return receive(txBits(bytes, tx), tx.baudRate, rx.baudRate, {
    parity: rx.parity || tx.parity || "none",
    dataBits: rx.dataBits || tx.dataBits || 8,
  });
}

module.exports = { txBits, receive, transfer };
