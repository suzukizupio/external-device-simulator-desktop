"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const L = require("../protocol/link-analyzer.js");
const P = require("../protocol/panasonic-alarm.js");
const { transfer } = require("./uart-simulator.js");

let passed = 0;
function test(name, body) {
  try {
    body();
    passed += 1;
    console.log("  OK  " + name);
  } catch (error) {
    console.error("  NG  " + name);
    throw error;
  }
}

// 11byteのSTX形式（HPC）と、18byteのASCIIレコード（大興）で確かめる。
const blockFrame = P.buildFrame({ protocol: "hpc", type: 0x00, infoBits: [0], buildingNo: 1, roomNo: 101 });
const recordFrame = P.buildFrame({ protocol: "daiko", records: [{ mode: "N", buildingNo: 1, roomNo: 101, alarmNo: 1 }] });

// 送信1200bpsの電文を、指定のボーレートで受けたときの生データ。
function garbled(frame, rxBaud, parity) {
  return transfer(frame, { baudRate: 1200, parity: parity || "even" }, { baudRate: rxBaud, parity: parity || "even" });
}

console.log("=== 通信条件のずれ分析 ===");

test("UMDがブラウザ相当のコンテキストでLinkAnalyzerを公開する", function () {
  const context = {};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../protocol/link-analyzer.js"), "utf8"), context);
  assert.equal(typeof context.LinkAnalyzer.analyze, "function");
});

test("条件が合っていれば偏りを指摘しない", function () {
  const received = garbled(blockFrame, 1200);
  assert.deepEqual(received, blockFrame, "同じ条件なら電文がそのまま届く");
  const result = L.analyze(received, { baudRate: 1200, expectedLength: blockFrame.length });
  assert.equal(result.verdict, L.VERDICT.MATCH);
  assert.equal(result.suspicious, false);
  assert.deepEqual(result.baudCandidates, []);
});

test("設定が相手より速いとビット変化が減り00Hが増える", function () {
  for (const rxBaud of [2400, 4800, 9600, 19200]) {
    const received = garbled(blockFrame, rxBaud);
    const result = L.analyze(received, { baudRate: rxBaud, expectedLength: blockFrame.length });
    assert.equal(result.verdict, L.VERDICT.TOO_FAST, `${rxBaud}bpsでtooFastを期待`);
    assert.equal(result.suspicious, true);
    // 受信は電文より長くなる。
    assert.ok(result.metrics.lengthRatio > 1.5, `${rxBaud}bps: lengthRatio=${result.metrics.lengthRatio}`);
    // 実際の1200bpsを候補に挙げられる。
    assert.ok(result.baudCandidates.includes(1200), `${rxBaud}bps: 候補=${result.baudCandidates.join(",")}`);
  }
});

test("速いほどビット変化が減り00Hの割合が上がる", function () {
  const at = (rxBaud) => L.analyze(garbled(blockFrame, rxBaud), { baudRate: rxBaud, expectedLength: blockFrame.length }).metrics;
  const x2 = at(2400);
  const x4 = at(4800);
  const x8 = at(9600);
  assert.ok(x4.transitionsPerByte < x2.transitionsPerByte, `4倍 ${x4.transitionsPerByte} < 2倍 ${x2.transitionsPerByte}`);
  assert.ok(x8.transitionsPerByte < x4.transitionsPerByte, `8倍 ${x8.transitionsPerByte} < 4倍 ${x4.transitionsPerByte}`);
  assert.ok(x8.zeroRatio > x4.zeroRatio, `8倍 ${x8.zeroRatio} > 4倍 ${x4.zeroRatio}`);
  assert.ok(x4.zeroRatio > x2.zeroRatio, `4倍 ${x4.zeroRatio} > 2倍 ${x2.zeroRatio}`);
});

test("設定が相手より遅いと電文より短くなる", function () {
  const received = garbled(blockFrame, 600);
  const result = L.analyze(received, { baudRate: 600, expectedLength: blockFrame.length });
  assert.equal(result.verdict, L.VERDICT.TOO_SLOW);
  assert.ok(result.metrics.lengthRatio < 0.7, `lengthRatio=${result.metrics.lengthRatio}`);
  assert.ok(result.baudCandidates.includes(1200), `候補=${result.baudCandidates.join(",")}`);
});

test("ASCIIレコード形式でも同じ傾向を検出する", function () {
  const ok = L.analyze(garbled(recordFrame, 1200, "none"), { baudRate: 1200, expectedLength: recordFrame.length });
  assert.equal(ok.verdict, L.VERDICT.MATCH);
  // 正常な大興電文はほぼ印字可能文字。
  assert.ok(ok.metrics.printableRatio > 0.8, `printableRatio=${ok.metrics.printableRatio}`);

  for (const rxBaud of [4800, 9600]) {
    const result = L.analyze(garbled(recordFrame, rxBaud, "none"), { baudRate: rxBaud, expectedLength: recordFrame.length });
    assert.equal(result.verdict, L.VERDICT.TOO_FAST, `${rxBaud}bps`);
    assert.ok(result.baudCandidates.includes(1200), `${rxBaud}bps: 候補=${result.baudCandidates.join(",")}`);
    // 化けると印字可能文字の割合が落ちる。
    assert.ok(result.metrics.printableRatio < 0.5, `${rxBaud}bps: printableRatio=${result.metrics.printableRatio}`);
  }
});

test("電文長が分からなくても偏りだけで向きを示す", function () {
  const received = garbled(blockFrame, 9600);
  const result = L.analyze(received, { baudRate: 9600 });
  assert.equal(result.verdict, L.VERDICT.TOO_FAST);
  assert.equal(result.metrics.lengthRatio, null);
  // 倍率が出せないため候補は挙げない。
  assert.deepEqual(result.baudCandidates, []);
  assert.ok(result.reasons.length > 0);
});

test("受信が短すぎるときは判断を保留する", function () {
  const result = L.analyze([0x02, 0x37, 0x00], { baudRate: 9600, expectedLength: 11 });
  assert.equal(result.verdict, L.VERDICT.UNKNOWN);
  assert.equal(result.suspicious, false);
  assert.match(result.reasons[0], /3バイトしかなく/);
  assert.equal(L.analyze([], { baudRate: 9600 }).verdict, L.VERDICT.UNKNOWN);
});

test("候補は標準ボーレートから近い順に最大3件返す", function () {
  assert.deepEqual(L.baudCandidates(9600, 8), [1200]);
  assert.deepEqual(L.baudCandidates(9600, 2), [4800]);
  // 比が中途半端でも、近い標準値へ寄せる。
  const loose = L.baudCandidates(9600, 3);
  assert.equal(loose[0], 2400, `候補=${loose.join(",")}`);
  assert.ok(loose.length <= 3);
  // 受信が途中で切れて比がぶれても、近い候補は残る。
  assert.ok(L.baudCandidates(9600, 7).includes(1200));
  assert.deepEqual(L.baudCandidates(9600, 0), []);
  assert.deepEqual(L.baudCandidates(null, 2), []);
});

test("入力の検査", function () {
  assert.throws(() => L.analyze([0x02, 300], {}), /0～255/);
  assert.throws(() => L.analyze(5, {}), /バイト配列/);
  assert.equal(L.analyze(null, {}).metrics.byteLength, 0);
  assert.equal(L.transitionsPerByte([]), 0);
  // 00Hは変化なし、AAHは7回変化する。
  assert.equal(L.transitionsPerByte([0x00]), 0);
  assert.equal(L.transitionsPerByte([0xAA]), 7);
});

console.log("=== " + passed + " link analyzer tests passed ===");
