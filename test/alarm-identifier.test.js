"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const I = require("../protocol/alarm-identifier.js");
const A = require("../protocol/alarm.js");
const P = require("../protocol/panasonic-alarm.js");

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

const ids = (bytes, options) => I.identify(bytes, options || {}).candidates;
const only = (bytes, options) => I.identify(bytes, options || {}).id;

console.log("=== 警報プロトコルのメーカー判定 ===");

test("UMDがブラウザ相当のコンテキストでAlarmIdentifierを公開する", function () {
  const sources = ["../protocol/alarm.js", "../protocol/panasonic-alarm.js", "../protocol/alarm-identifier.js"];
  const context = {};
  for (const source of sources) {
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, source), "utf8"), context);
  }
  assert.equal(typeof context.AlarmIdentifier.identify, "function");
});

test("判定対象はアイホン1種とパナソニック4種", function () {
  assert.deepEqual(I.TARGET_IDS.slice(), ["aiphone", "hpc", "tss", "daiko", "remote"]);
  assert.equal(I.findTarget("aiphone").vendor, I.VENDOR.AIPHONE);
  assert.equal(I.findTarget("aiphone").view, "alarm");
  assert.equal(I.findTarget("hpc").vendor, I.VENDOR.PANASONIC);
  assert.equal(I.findTarget("hpc").view, "panasonic");
  assert.equal(I.findTarget("hpc").label, "パナソニック HPC");
  assert.equal(I.findTarget("unknown"), null);
});

test("アイホンにしかない発報元と棟番号で一意に特定できる", function () {
  // 管理室(0C)・集合玄関(0D)・共用部の発報元は、パナソニックのBCD住戸番号として成立しない。
  assert.equal(only(A.buildFrame({ type: 0x00, infoBits: [1], buildingNo: 1, managementNo: 1 })), "aiphone");
  assert.equal(only(A.buildFrame({ type: 0x00, infoBits: [1], buildingNo: 1, entranceNo: 2 })), "aiphone");
  assert.equal(only(A.buildFrame({ type: 0x00, infoBits: [1], buildingNo: 1, common: true })), "aiphone");
  // 棟番号はアイホンがBCD、パナソニックがバイナリ。70棟(70H)はパナソニックの予備領域。
  assert.equal(only(A.buildFrame({ type: 0x00, infoBits: [1], buildingNo: 70, roomNo: 101 })), "aiphone");

  const identified = I.identify(A.buildFrame({ type: 0x00, infoBits: [1], buildingNo: 1, managementNo: 1 }));
  assert.equal(identified.target.label, "アイホン Q49-023G");
  // 決め手は同じ11byte形式のプロトコルから示す。
  assert.deepEqual(identified.rejected.map((item) => item.id), ["hpc", "tss"]);
  assert.match(identified.rejected[0].reason, /住戸番号がBCDではありません/);
});

test("パナソニックにしかない発信種別と棟番号で一意に特定できる", function () {
  // 02H(警報情報3)・05H(汎用警報情報)・10H(住戸情報要求)はアイホンの台帳にない。
  assert.equal(only(P.buildFrame({ protocol: "hpc", type: 0x05, infoBits: [0], buildingNo: 1, roomNo: 101 })), "hpc");
  assert.equal(only(P.buildFrame({ protocol: "hpc", type: 0x10, buildingNo: 1, roomNo: 101 })), "hpc");
  assert.deepEqual(ids(P.buildFrame({ protocol: "hpc", type: 0x02, infoBits: [0], buildingNo: 1, roomNo: 101 })), ["hpc", "tss"]);
  // 10棟はパナソニックが0AH、アイホンのBCDとしては不正。
  assert.deepEqual(ids(P.buildFrame({ protocol: "hpc", type: 0x00, infoBits: [0], buildingNo: 10, roomNo: 101 })), ["hpc", "tss"]);

  const identified = I.identify(P.buildFrame({ protocol: "hpc", type: 0x05, infoBits: [0], buildingNo: 1, roomNo: 101 }));
  assert.deepEqual(identified.rejected.map((item) => item.id), ["aiphone", "tss"]);
  assert.match(identified.rejected[0].reason, /発信種別 05H は台帳にありません/);
});

test("共通の発信種別しか含まない電文はメーカーをまたいで候補が残る", function () {
  // 00H(警報情報①/警報情報１)はアイホン・HPC・TSSのすべてにある。
  const shared = A.buildFrame({ type: 0x00, infoBits: [1], buildingNo: 1, roomNo: 101 });
  const identified = I.identify(shared, { aiphonePattern: "standard" });
  assert.deepEqual(identified.candidates, ["aiphone", "hpc", "tss"]);
  assert.equal(identified.id, null);
  // 同じバイト列でも割付が違うため、読みが変わることを示す。
  assert.equal(identified.differences.length, 1);
  assert.match(identified.differences[0], /アイホンなら「警報情報①：火災、遠隔試験/);
  assert.match(identified.differences[0], /HPCなら「警報情報１：火災/);
  // 候補が複数の画面にまたがることを呼び出し側へ伝える。
  assert.deepEqual(identified.views.slice().sort(), ["alarm", "panasonic"]);
});

test("発信種別44Hと30Hはメーカーで持ち主が分かれる", function () {
  // 44H(警戒解除)はアイホンとTSSにあり、HPCにはない。
  const clear = A.buildFrame({ type: 0x44, infoBits: [1], buildingNo: 1, roomNo: 101 });
  const clearId = I.identify(clear, { aiphonePattern: "pattern1" });
  assert.deepEqual(clearId.candidates, ["aiphone", "tss"]);
  assert.deepEqual(clearId.rejected.map((item) => item.id), ["hpc"]);
  assert.match(clearId.rejected[0].reason, /HPCに発信種別 44H はありません/);

  // 30H(ヒストリー要求)はアイホンとHPCにあり、TSSにはない。
  const request = A.buildFrame({ type: 0x30 });
  const requestId = I.identify(request);
  assert.deepEqual(requestId.candidates, ["aiphone", "hpc"]);
  assert.deepEqual(requestId.rejected.map((item) => item.id), ["tss"]);
});

test("レコード形式の電文にアイホンは候補として入らない", function () {
  const record = P.buildFrame({ protocol: "daiko", records: [{ mode: "N", buildingNo: 1, roomNo: 101, alarmNo: 3 }] });
  const identified = I.identify(record);
  assert.deepEqual(identified.candidates, ["daiko", "remote"]);
  assert.deepEqual(identified.views, ["panasonic"]);
  // 形式が違うアイホン・HPC・TSSは決め手として挙げない。
  assert.deepEqual(identified.rejected.map((item) => item.id), []);
  assert.match(identified.differences[0], /大興なら「N01-0101：非常」、リモートなら「N01-0101：防犯\(代表\)」/);

  // 宅配登録･削除(40)を含めばリモートに絞れる。
  assert.equal(only(P.buildFrame({ protocol: "remote", records: [{ mode: "N", buildingNo: 1, roomNo: 101, alarmNo: 40 }] })), "remote");
  assert.equal(only(P.buildScheduledFrame({ protocol: "remote", propertyCode: "0001" })), "remote");
});

test("アイホンのビット割付パターンは読みの比較にだけ効く", function () {
  const shared = A.buildFrame({ type: 0x00, infoBits: [5, 6], buildingNo: 1, roomNo: 101 });
  // 標準割付ではbit6・bit7が未割付、パターン１では外出警戒・在宅警戒になる。
  const standard = I.identify(shared, { aiphonePattern: "standard" });
  const pattern1 = I.identify(shared, { aiphonePattern: "pattern1" });
  assert.deepEqual(standard.candidates, pattern1.candidates);
  assert.notEqual(standard.differences[0], pattern1.differences[0]);
  assert.match(pattern1.differences[0], /外出警戒/);
});

test("どの警報プロトコルとしても成立しない電文は候補なしで返す", function () {
  const broken = A.buildFrame({ type: 0x00, infoBits: [1], buildingNo: 1, roomNo: 101 });
  broken[10] = (broken[10] + 1) & 0xFF;
  const identified = I.identify(broken);
  assert.deepEqual(identified.candidates, []);
  assert.equal(identified.id, null);
  assert.equal(identified.target, null);
  assert.equal(identified.style, null);
  assert.deepEqual(identified.views, []);
  assert.deepEqual(identified.rejected, []);
  // 5系統すべての不成立理由は残す。
  assert.equal(identified.results.length, 5);
  assert.ok(identified.results.every((item) => !item.accepted && item.reason));
  // アイホンの理由も日本語で返す（alarm.jsの例外文は英語のため言い換えている）。
  const aiphone = identified.results.find((item) => item.id === "aiphone");
  assert.ok(/[ぁ-んァ-ヶ一-龠]/.test(aiphone.reason), `日本語の理由を期待: ${aiphone.reason}`);
});

console.log("=== " + passed + " alarm identifier tests passed ===");
