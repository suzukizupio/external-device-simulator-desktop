"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const A = require("../protocol/alarm.js");

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

function rebuilt(frame) {
  const copy = frame.slice(0, -1);
  copy.push(A.calculateBCC(copy));
  return copy;
}

console.log("=== Q49-023G alarm protocol ===");

test("UMD exposes AlarmProtocol in a browser-like context", function () {
  const source = fs.readFileSync(path.join(__dirname, "../protocol/alarm.js"), "utf8");
  const context = {};
  vm.runInNewContext(source, context);
  assert.equal(typeof context.AlarmProtocol.buildFrame, "function");
});

test("control codes, fixed size, and transmission types match the specification", function () {
  assert.deepEqual(A.CODE, { STX: 0x02, ETX: 0x03, ENQ: 0x05, ACK: 0x06, NAK: 0x15 });
  assert.equal(A.SIZE, 0x37);
  assert.deepEqual(A.TYPE, {
    ALARM_1: 0x00,
    ALARM_2: 0x01,
    SECURITY_SET: 0x04,
    SECURITY_CLEAR: 0x44,
    HISTORY_REQUEST: 0x30,
  });
});

test("encodes and decodes the full 00-99 BCD building range", function () {
  assert.equal(A.encodeBCD(0), 0x00);
  assert.equal(A.encodeBCD(10), 0x10);
  assert.equal(A.encodeBCD(99), 0x99);
  assert.equal(A.decodeBCD(0x42), 42);
  assert.throws(function () { A.encodeBCD(100); }, /0 to 99/);
  assert.throws(function () { A.decodeBCD(0x0A); }, /invalid BCD/);
});

test("encodes every specified source-number form", function () {
  assert.deepEqual(A.encodeSource(A.sourceDwelling(101)), [0x00, 0x01, 0x00, 0x01]);
  assert.deepEqual(A.encodeSource(A.sourceManagement(12)), [0x0C, 0x00, 0x01, 0x02]);
  assert.deepEqual(A.encodeSource(A.sourceEntrance(123)), [0x0D, 0x01, 0x02, 0x03]);
  assert.deepEqual(A.encodeSource(A.sourceCommon()), [0x0C, 0x0A, 0x00, 0x00]);
  assert.deepEqual(A.encodeSource(A.sourceNone()), [0x00, 0x00, 0x00, 0x00]);
});

test("rejects source-number overflow instead of truncating it", function () {
  assert.throws(function () { A.sourceDwelling(10000); }, /0 to 9999/);
  assert.throws(function () { A.sourceManagement(1000); }, /0 to 999/);
  assert.throws(function () { A.sourceEntrance(-1); }, /0 to 999/);
  assert.throws(function () { A.encodeSource({ kind: "unknown", number: 1 }); }, /unknown alarm source/);
});

const alarm101 = [0x02, 0x37, 0x00, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x03, 0x3D];
const historyRequest = [0x02, 0x37, 0x30, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x03, 0x6A];
const history503 = [0x02, 0x37, 0x00, 0x04, 0x00, 0x10, 0x15, 0x10, 0x13, 0x03, 0x86];
// PDF p.20 prints 3E for this BCC, but its normative additive formula gives 41.
// (3E would be the checksum if the transmission type were 01 instead of 04.)
const securitySet101 = [0x02, 0x37, 0x04, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x03, 0x41];
const securityClear101 = [0x02, 0x37, 0x44, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x03, 0x81];

test("builds the PDF fire-at-room-101 golden vector", function () {
  const frame = A.buildFrame({ type: A.TYPE.ALARM_1, info: 0x01, roomNo: 101 });
  assert.deepEqual(frame, alarm101);
  assert.equal(frame.length, 11);
  assert.equal(A.verifyBCC(frame), true);
});

test("builds the PDF history-request golden vector", function () {
  assert.deepEqual(A.buildFrame({ type: A.TYPE.HISTORY_REQUEST }), historyRequest);
});

test("builds the PDF first-history response for gas at room 503", function () {
  const frame = A.buildFrame({
    type: A.TYPE.ALARM_1,
    info: 0x04,
    roomNo: 503,
    historyNumber: 1,
  });
  assert.deepEqual(frame, history503);
});

test("builds security-set and security-clear vectors with the normative additive BCC", function () {
  assert.deepEqual(A.buildFrame({ type: A.TYPE.SECURITY_SET, info: 0x01, roomNo: 101 }), securitySet101);
  assert.deepEqual(A.buildFrame({ type: A.TYPE.SECURITY_CLEAR, info: 0x01, roomNo: 101 }), securityClear101);
});

test("rejects the inconsistent 3E BCC printed for security-set on PDF p.20", function () {
  const printed = securitySet101.slice();
  printed[10] = 0x3E;
  assert.equal(A.validateFrame(printed), false);
});

test("parses BCD, source digits, history number, and additive BCC", function () {
  const parsed = A.parseFrame(history503);
  assert.equal(parsed.type, A.TYPE.ALARM_1);
  assert.equal(parsed.info, 0x04);
  assert.equal(parsed.buildingNo, 0);
  assert.equal(parsed.source.kind, A.SOURCE_KIND.DWELLING);
  assert.equal(parsed.source.number, 503);
  assert.equal(parsed.historyNumber, 1);
  assert.equal(parsed.bcc, 0x86);
});

test("round-trips management, entrance, and common-area sources", function () {
  const cases = [
    [A.sourceManagement(7), A.SOURCE_KIND.MANAGEMENT, 7],
    [A.sourceEntrance(321), A.SOURCE_KIND.ENTRANCE, 321],
    [A.sourceCommon(), A.SOURCE_KIND.COMMON, null],
  ];
  cases.forEach(function (item) {
    const frame = A.buildFrame({ type: A.TYPE.ALARM_2, info: 0x80, buildingNo: 10, source: item[0] });
    const parsed = A.parseFrame(frame);
    assert.equal(parsed.buildingNo, 10);
    assert.equal(parsed.source.kind, item[1]);
    assert.equal(parsed.source.number, item[2]);
  });
});

test("history number is repeated in the high nibble of all four source bytes", function () {
  assert.deepEqual(A.addHistoryNumber([0x00, 0x05, 0x00, 0x03], 15), [0xF0, 0xF5, 0xF0, 0xF3]);
  assert.throws(function () { A.addHistoryNumber([0x10, 0x00, 0x00, 0x00], 1); }, /already contains/);
  assert.throws(function () { A.addHistoryNumber([0, 0, 0, 0], 16); }, /0 to 15/);
});

test("history request strictly requires all payload fields to be zero", function () {
  assert.throws(function () { A.buildFrame({ type: A.TYPE.HISTORY_REQUEST, info: 1 }); }, /requires zero/);
  assert.throws(function () { A.buildFrame({ type: A.TYPE.HISTORY_REQUEST, buildingNo: 1 }); }, /requires zero/);
  assert.throws(function () { A.buildFrame({ type: A.TYPE.HISTORY_REQUEST, roomNo: 1 }); }, /requires zero/);
  assert.throws(function () { A.buildFrame({ type: A.TYPE.SECURITY_SET, historyNumber: 1 }); }, /only for alarm/);
});

test("rejects bad length, delimiters, size, BCC, type, BCD, and mixed history nibbles", function () {
  assert.equal(A.validateFrame(alarm101), true);
  assert.equal(A.validateFrame(alarm101.slice(0, -1)), false);
  const badStx = alarm101.slice();
  badStx[0] = 0x01;
  assert.equal(A.validateFrame(badStx), false);
  const badSize = alarm101.slice();
  badSize[1] = 0x07;
  assert.equal(A.validateFrame(rebuilt(badSize)), false);
  const badEtx = alarm101.slice();
  badEtx[9] = 0x04;
  assert.equal(A.validateFrame(rebuilt(badEtx)), false);
  const badBcc = alarm101.slice();
  badBcc[10] ^= 1;
  assert.equal(A.validateFrame(badBcc), false);
  const badType = alarm101.slice();
  badType[2] = 0x02;
  assert.equal(A.validateFrame(rebuilt(badType)), false);
  const badBcd = alarm101.slice();
  badBcd[4] = 0x1A;
  assert.equal(A.validateFrame(rebuilt(badBcd)), false);
  const mixedHistory = history503.slice();
  mixedHistory[6] = 0x25;
  assert.equal(A.validateFrame(rebuilt(mixedHistory)), false);
});

test("AlarmHistory returns the specified empty-history response", function () {
  const history = new A.AlarmHistory();
  const frame = history.nextFrame();
  const parsed = A.parseFrame(frame);
  assert.equal(parsed.type, A.TYPE.ALARM_1);
  assert.equal(parsed.info, 0);
  assert.equal(parsed.buildingNo, 0);
  assert.equal(parsed.source.kind, A.SOURCE_KIND.NONE);
  assert.equal(parsed.historyNumber, 1);
});

test("AlarmHistory retains at most 15 newest records and cycles newest-to-oldest", function () {
  const history = new A.AlarmHistory();
  for (let info = 1; info <= 16; info += 1) {
    history.add({ type: A.TYPE.ALARM_1, info: info, roomNo: 100 + info });
  }
  assert.equal(history.size, 15);
  assert.equal(history.toArray()[0].info, 16);
  assert.equal(history.toArray()[14].info, 2);
  const first = history.next();
  const second = history.next();
  assert.equal(first.info, 16);
  assert.equal(first.historyNumber, 1);
  assert.equal(second.info, 15);
  assert.equal(second.historyNumber, 2);
  for (let count = 0; count < 13; count += 1) history.next();
  const wrapped = history.next();
  assert.equal(wrapped.info, 16);
  assert.equal(wrapped.historyNumber, 1);
});

test("a newly recorded alarm resets the history-request cursor", function () {
  const history = new A.AlarmHistory();
  history.add({ type: A.TYPE.ALARM_1, info: 1, roomNo: 101 });
  history.add({ type: A.TYPE.ALARM_2, info: 2, roomNo: 102 });
  assert.equal(history.next().info, 2);
  assert.equal(history.next().info, 1);
  history.add({ type: A.TYPE.ALARM_1, info: 3, roomNo: 103 });
  const newest = history.next();
  assert.equal(newest.info, 3);
  assert.equal(newest.historyNumber, 1);
});

test("AlarmHistory refuses non-history command types and capacities above 15", function () {
  const history = new A.AlarmHistory();
  assert.throws(function () {
    history.add({ type: A.TYPE.SECURITY_SET, info: 1, roomNo: 101 });
  }, /only alarm information 1 and 2/);
  assert.throws(function () { return new A.AlarmHistory(16); }, /1 to 15/);
  assert.throws(function () { history.add(history503); }, /cannot be recorded/);
});

// --- 5.2.2／5.2.3／5.2.4 発信情報ビット割付 -------------------------------------

// 割付表からラベルでbit番号を引く。仕様書の表そのものを検証対象にするため、
// テスト側にbit番号を書き写さない。
function bitOf(type, pattern, label) {
  const row = A.bitAssignments(type, pattern);
  assert.ok(row, "no bit assignment table for type 0x" + type.toString(16) + " / " + pattern);
  const index = row.findIndex(function (entry) { return entry.label === label; });
  assert.notEqual(index, -1, "bit for " + label + " is missing from " + pattern);
  return index + 1;
}

function labelsOf(type, pattern) {
  return A.bitAssignments(type, pattern).map(function (entry) { return entry.label; });
}

test("5.2.2 警報情報①の初期値警報ビット割付が仕様の並びどおり", function () {
  assert.deepEqual(labelsOf(A.TYPE.ALARM_1, A.BIT_PATTERN.STANDARD), [
    "火災、遠隔試験", "非常", "ガス漏れ", "ガス障害、火災障害", "防犯(侵入)", null, null, null,
  ]);
  // 初期状態の警報情報②は対応付けが為されていない。
  assert.deepEqual(labelsOf(A.TYPE.ALARM_2, A.BIT_PATTERN.STANDARD), new Array(8).fill(null));
  // 標準割付は受注対応で変更できるため、◇（変更不可）は付かない。
  assert.equal(A.bitAssignments(A.TYPE.ALARM_1, A.BIT_PATTERN.STANDARD).every(function (entry) { return !entry.locked; }), true);
});

test("5.2.3 警戒情報付き防犯情報の3パターンが仕様の表どおり", function () {
  assert.deepEqual(labelsOf(A.TYPE.ALARM_1, A.BIT_PATTERN.PATTERN_1), [
    "火災、遠隔試験", "非常", "ガス漏れ", "ガス障害、火災障害", "防犯(侵入)", "外出警戒", "在宅警戒", null,
  ]);
  assert.deepEqual(labelsOf(A.TYPE.ALARM_2, A.BIT_PATTERN.PATTERN_1), new Array(8).fill(null));
  assert.deepEqual(labelsOf(A.TYPE.ALARM_1, A.BIT_PATTERN.PATTERN_2), [
    "火災、遠隔試験", "非常", "ガス漏れ", "ガス障害、火災障害", null, null, null, null,
  ]);
  // 防犯１～３と警戒情報は警報情報②のbit4以降。bit1へ詰めない。
  assert.deepEqual(labelsOf(A.TYPE.ALARM_2, A.BIT_PATTERN.PATTERN_2), [
    null, null, null, "防犯１", "防犯２", "防犯３", "外出警戒", "在宅警戒",
  ]);
  assert.deepEqual(labelsOf(A.TYPE.ALARM_1, A.BIT_PATTERN.PATTERN_3), [
    "火災、遠隔試験", "非常", "ガス漏れ", "ガス障害、火災障害", "防犯４", "防犯５", null, null,
  ]);
  assert.deepEqual(labelsOf(A.TYPE.ALARM_2, A.BIT_PATTERN.PATTERN_3), labelsOf(A.TYPE.ALARM_2, A.BIT_PATTERN.PATTERN_2));
  // ◇の付いた防犯・警戒情報は対応付けを変更できない。
  assert.equal(A.bitAssignments(A.TYPE.ALARM_1, A.BIT_PATTERN.PATTERN_1)[bitOf(A.TYPE.ALARM_1, "pattern1", "外出警戒") - 1].locked, true);
  assert.equal(A.bitAssignments(A.TYPE.ALARM_1, A.BIT_PATTERN.PATTERN_1)[0].locked, false);
});

test("5.2.4 警戒設定情報／警戒解除情報の3パターンが仕様の表どおり", function () {
  assert.deepEqual(labelsOf(A.TYPE.SECURITY_SET, A.BIT_PATTERN.PATTERN_1), ["警戒設定", null, null, null, null, null, null, null]);
  assert.deepEqual(labelsOf(A.TYPE.SECURITY_SET, A.BIT_PATTERN.PATTERN_2), ["外出警戒設定", "在宅警戒設定", null, null, null, null, null, null]);
  assert.deepEqual(labelsOf(A.TYPE.SECURITY_SET, A.BIT_PATTERN.PATTERN_3), [
    "外出警戒設定", "在宅警戒１設定", "在宅警戒２設定", "在宅警戒３設定", "在宅警戒４設定", "在宅警戒５設定", null, null,
  ]);
  assert.deepEqual(labelsOf(A.TYPE.SECURITY_CLEAR, A.BIT_PATTERN.PATTERN_1), ["警戒解除", null, null, null, null, null, null, null]);
  assert.deepEqual(labelsOf(A.TYPE.SECURITY_CLEAR, A.BIT_PATTERN.PATTERN_3), [
    "外出警戒解除", "在宅警戒１解除", "在宅警戒２解除", "在宅警戒３解除", "在宅警戒４解除", "在宅警戒５解除", null, null,
  ]);
  // 未割付は「×」＝追加も変更もできない。5.2.3の「―」と区別する。
  assert.equal(A.bitAssignments(A.TYPE.SECURITY_SET, A.BIT_PATTERN.PATTERN_1)[7].extensible, false);
  assert.equal(A.bitAssignments(A.TYPE.ALARM_1, A.BIT_PATTERN.PATTERN_1)[7].extensible, true);
});

test("警戒設定／解除に標準割付はなく、ヒストリー要求は割付表を持たない", function () {
  assert.equal(A.bitAssignments(A.TYPE.SECURITY_SET, A.BIT_PATTERN.STANDARD), null);
  assert.equal(A.bitAssignments(A.TYPE.SECURITY_CLEAR, A.BIT_PATTERN.STANDARD), null);
  for (const pattern of A.BIT_PATTERN_NAMES) {
    assert.equal(A.bitAssignments(A.TYPE.HISTORY_REQUEST, pattern), null);
  }
  assert.throws(function () { A.bitAssignments(A.TYPE.ALARM_1, "pattern9"); }, /unknown alarm bit pattern/);
});

test("5.2.3と5.2.4の割付は種別ごとに別々へ指定できる", function () {
  // 仕様書もdearisメンテナンスシステムも、防犯発報（5.2.3）と警戒設定・解除（5.2.4）を
  // 別々の設定項目として持つ。片方だけを変えても、もう片方は連動しない。
  const guardOnly = { alarm: A.BIT_PATTERN.STANDARD, guard: A.BIT_PATTERN.PATTERN_1 };
  assert.deepEqual(labelsOf(A.TYPE.ALARM_1, guardOnly), labelsOf(A.TYPE.ALARM_1, A.BIT_PATTERN.STANDARD));
  assert.deepEqual(labelsOf(A.TYPE.SECURITY_SET, guardOnly), labelsOf(A.TYPE.SECURITY_SET, A.BIT_PATTERN.PATTERN_1));
  assert.deepEqual(labelsOf(A.TYPE.SECURITY_CLEAR, guardOnly), labelsOf(A.TYPE.SECURITY_CLEAR, A.BIT_PATTERN.PATTERN_1));

  const alarmOnly = { alarm: A.BIT_PATTERN.PATTERN_1, guard: A.BIT_PATTERN.STANDARD };
  assert.deepEqual(labelsOf(A.TYPE.ALARM_1, alarmOnly), labelsOf(A.TYPE.ALARM_1, A.BIT_PATTERN.PATTERN_1));
  assert.equal(A.bitAssignments(A.TYPE.SECURITY_SET, alarmOnly), null, "警戒設定・解除は割付なし");

  // VIXUSのように5.2.3と5.2.4で選べるパターンが違う組み合わせも表現できる。
  const mixed = { alarm: A.BIT_PATTERN.PATTERN_1, guard: A.BIT_PATTERN.PATTERN_3 };
  assert.equal(A.bitAssignments(A.TYPE.ALARM_1, mixed)[5].label, "外出警戒");
  assert.equal(A.bitAssignments(A.TYPE.SECURITY_SET, mixed)[1].label, "在宅警戒１設定");

  // 文字列指定は従来どおり両方へ同じ割付を使う。
  assert.deepEqual(labelsOf(A.TYPE.SECURITY_SET, "pattern1"), ["警戒設定", null, null, null, null, null, null, null]);
  assert.equal(A.describeInfo(0x01, { type: A.TYPE.SECURITY_SET, pattern: guardOnly }).labels[0], "警戒設定");
  assert.equal(A.describeInfo(0x10, { type: A.TYPE.ALARM_1, pattern: guardOnly }).labels[0], "防犯(侵入)");
  assert.equal(A.usesGuardPattern(A.TYPE.SECURITY_CLEAR), true);
  assert.equal(A.usesGuardPattern(A.TYPE.ALARM_2), false);
  assert.throws(function () { A.bitAssignments(A.TYPE.SECURITY_SET, { alarm: "pattern1", guard: "pattern9" }); }, /unknown alarm bit pattern/);
});

test("bit1がLSB、bit8がMSBとして発信情報を組み立て・分解する", function () {
  assert.equal(A.encodeInfo([1]), 0x01);
  assert.equal(A.encodeInfo([8]), 0x80);
  assert.equal(A.encodeInfo([1, 3]), 0x05); // 5.2.1の火災＋ガス漏れの例
  assert.equal(A.encodeInfo([]), 0x00);
  assert.deepEqual(A.decodeInfo(0x05), [1, 3]);
  assert.deepEqual(A.decodeInfo(0x00), []);
  assert.deepEqual(A.decodeInfo(0xFF), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.throws(function () { A.encodeInfo([0]); }, /1 to 8/);
  assert.throws(function () { A.encodeInfo([9]); }, /1 to 8/);
});

test("仕様書5.5①③：標準割付の火災・ガス漏れが印字どおりの電文になる", function () {
  const fire = [bitOf(A.TYPE.ALARM_1, A.BIT_PATTERN.STANDARD, "火災、遠隔試験")];
  assert.deepEqual(A.buildFrame({ type: A.TYPE.ALARM_1, infoBits: fire, buildingNo: 0, roomNo: 101 }), alarm101);
  const gas = [bitOf(A.TYPE.ALARM_1, A.BIT_PATTERN.STANDARD, "ガス漏れ")];
  assert.deepEqual(
    A.buildFrame({ type: A.TYPE.ALARM_1, infoBits: gas, buildingNo: 0, roomNo: 503, historyNumber: 1 }),
    history503,
  );
});

test("仕様書5.5④：パターン１の警戒設定が01Hになる", function () {
  const bits = [bitOf(A.TYPE.SECURITY_SET, A.BIT_PATTERN.PATTERN_1, "警戒設定")];
  assert.equal(A.encodeInfo(bits), 0x01);
  assert.deepEqual(A.buildFrame({ type: A.TYPE.SECURITY_SET, infoBits: bits, buildingNo: 0, roomNo: 101 }), securitySet101);
});

test("仕様書5.5⑥⑦：警戒情報付き防犯情報が30H／50Hになる", function () {
  const away = [
    bitOf(A.TYPE.ALARM_1, A.BIT_PATTERN.PATTERN_1, "防犯(侵入)"),
    bitOf(A.TYPE.ALARM_1, A.BIT_PATTERN.PATTERN_1, "外出警戒"),
  ];
  assert.equal(A.encodeInfo(away), 0x30);
  assert.deepEqual(
    A.buildFrame({ type: A.TYPE.ALARM_1, infoBits: away, buildingNo: 0, roomNo: 101 }),
    [0x02, 0x37, 0x00, 0x30, 0x00, 0x00, 0x01, 0x00, 0x01, 0x03, 0x6C],
  );
  const home = [
    bitOf(A.TYPE.ALARM_1, A.BIT_PATTERN.PATTERN_1, "防犯(侵入)"),
    bitOf(A.TYPE.ALARM_1, A.BIT_PATTERN.PATTERN_1, "在宅警戒"),
  ];
  assert.equal(A.encodeInfo(home), 0x50);
  assert.deepEqual(
    A.buildFrame({ type: A.TYPE.ALARM_1, infoBits: home, buildingNo: 0, roomNo: 101 }),
    [0x02, 0x37, 0x00, 0x50, 0x00, 0x00, 0x01, 0x00, 0x01, 0x03, 0x8C],
  );
});

test("infoとinfoBitsの同時指定を拒否し、infoBits省略時は従来どおりinfoを使う", function () {
  assert.throws(function () {
    A.buildFrame({ type: A.TYPE.ALARM_1, info: 1, infoBits: [1], roomNo: 101 });
  }, /either info or infoBits/);
  assert.deepEqual(A.buildFrame({ type: A.TYPE.ALARM_1, info: 0x01, roomNo: 101 }), alarm101);
  assert.equal(A.buildFrame({ type: A.TYPE.ALARM_1, infoBits: [], roomNo: 101 })[3], 0x00);
});

test("describeInfoが選択中の割付で発信情報を読み解く", function () {
  const away = A.describeInfo(0x30, { type: A.TYPE.ALARM_1, pattern: A.BIT_PATTERN.PATTERN_1 });
  assert.equal(away.hex, "30");
  assert.deepEqual(away.labels, ["防犯(侵入)", "外出警戒"]);
  assert.equal(away.summary, "防犯(侵入)＋外出警戒");
  assert.deepEqual(away.violations, []);
  assert.equal(away.assigned, true);

  // 同じ 30H でも標準割付には外出警戒がないため、bit6は未割付として読む。桁は落とさない。
  const standard = A.describeInfo(0x30, { type: A.TYPE.ALARM_1, pattern: A.BIT_PATTERN.STANDARD });
  assert.deepEqual(standard.labels, ["防犯(侵入)", "bit6（未割付）"]);
  assert.deepEqual(standard.violations, []);

  // 5.2.1：全bit OFFは全復旧を意味する。
  assert.equal(A.describeInfo(0x00, { type: A.TYPE.ALARM_1 }).summary, "全復旧（全bit OFF）");
  assert.equal(A.describeInfo(0x00, { type: A.TYPE.SECURITY_SET, pattern: "pattern1" }).summary, "警戒中の項目なし");
  assert.equal(A.describeInfo(0x00, { type: A.TYPE.SECURITY_CLEAR, pattern: "pattern1" }).summary, "解除ありの項目なし");
});

test("describeInfoは仕様上使えないbitのONを違反として挙げる", function () {
  // 5.2.4のパターン１はbit2以降が「×」。
  const set = A.describeInfo(0x03, { type: A.TYPE.SECURITY_SET, pattern: A.BIT_PATTERN.PATTERN_1 });
  assert.deepEqual(set.violations, [2]);
  assert.deepEqual(set.labels, ["警戒設定", "bit2（未使用）"]);
  // 5.2.5のヒストリー要求は全bit OFFが規定。
  const request = A.describeInfo(0x01, { type: A.TYPE.HISTORY_REQUEST });
  assert.equal(request.assigned, false);
  assert.deepEqual(request.violations, [1]);
  assert.equal(A.describeInfo(0x00, { type: A.TYPE.HISTORY_REQUEST }).summary, "ヒストリー要求（発信情報なし）");
});

console.log("=== " + passed + " alarm tests passed ===");
