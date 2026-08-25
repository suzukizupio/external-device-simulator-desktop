"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const B = require("../protocol/alarm-bridge.js");
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

const labels = (result) => result.terms.map((item) => item.label);
const dropped = (result) => result.dropped.map((item) => item.label);

console.log("=== 警報のメーカー間変換 ===");

test("UMDがブラウザ相当のコンテキストでAlarmBridgeを公開する", function () {
  const sources = [
    "../protocol/alarm.js", "../protocol/panasonic-alarm.js",
    "../protocol/alarm-identifier.js", "../protocol/alarm-bridge.js",
  ];
  const context = {};
  for (const source of sources) {
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, source), "utf8"), context);
  }
  assert.equal(typeof context.AlarmBridge.convert, "function");
});

test("アイホンの火災・非常を4プロトコルすべてへ変換できる", function () {
  const frame = A.buildFrame({ type: 0x00, infoBits: [1, 2], buildingNo: 1, roomNo: 101 });

  // STX形式は1電文にまとまる。
  for (const target of ["hpc", "tss"]) {
    const result = B.convert(frame, "aiphone", target);
    assert.deepEqual(labels(result), ["火災", "非常"]);
    assert.equal(result.frames.length, 1);
    assert.equal(result.complete, true);
    const parsed = P.parseBlockFrame(result.frames[0], { protocol: target });
    assert.equal(parsed.buildingNo, 1);
    assert.equal(parsed.roomNo, 101);
    assert.equal(P.describeInfo(target, parsed.type, parsed.info).summary, "火災＋非常");
  }

  // レコード形式は1警報1レコード。大興は非常が03、リモートは04。
  const daiko = B.convert(frame, "aiphone", "daiko");
  const daikoRecords = P.parseRecordFrame(daiko.frames[0], { protocol: "daiko" }).records;
  assert.deepEqual(daikoRecords.map((record) => record.alarmNo), [1, 3]);
  assert.deepEqual(daikoRecords.map((record) => record.alarmLabel), ["火災", "非常"]);

  const remote = B.convert(frame, "aiphone", "remote");
  const remoteRecords = P.parseRecordFrame(remote.frames[0], { protocol: "remote" }).records;
  assert.deepEqual(remoteRecords.map((record) => record.alarmNo), [1, 4]);
  assert.deepEqual(remoteRecords.map((record) => record.alarmLabel), ["火災", "非常"]);
});

test("パナソニックからアイホンへも同じ内容で戻せる", function () {
  for (const source of ["hpc", "tss"]) {
    const frame = P.buildFrame({ protocol: source, type: 0x00, infoBits: [0, 1], buildingNo: 2, roomNo: 1201 });
    const result = B.convert(frame, source, "aiphone");
    assert.deepEqual(labels(result), ["火災", "非常"]);
    assert.equal(result.complete, true);
    const parsed = A.parseFrame(result.frames[0]);
    assert.equal(parsed.buildingNo, 2);
    assert.equal(parsed.source.number, 1201);
    assert.deepEqual(A.describeInfo(parsed.info, { type: parsed.type, pattern: "standard" }).labels,
      ["火災、遠隔試験", "非常"]);
  }

  // レコード形式からも読み取れる。
  const record = P.buildFrame({
    protocol: "daiko",
    records: [{ mode: "N", buildingNo: 1, roomNo: 101, alarmNo: 1 }, { mode: "N", buildingNo: 1, roomNo: 101, alarmNo: 3 }],
  });
  const back = B.convert(record, "daiko", "aiphone");
  assert.deepEqual(labels(back), ["火災", "非常"]);
  assert.equal(back.complete, true);
});

test("アイホンと大興を往復しても内容が保たれる", function () {
  const original = A.buildFrame({ type: 0x00, infoBits: [1, 2, 3], buildingNo: 3, roomNo: 505 });
  const forward = B.convert(original, "aiphone", "daiko");
  const back = B.convert(forward.frames[0], "daiko", "aiphone");
  assert.deepEqual(back.frames[0], original, "往復して同じ電文へ戻る");
});

test("1つの桁に複数の意味がある項目は全ての枠へ配り、注記を残す", function () {
  // アイホンの「ガス障害、火災障害」はHPCでは2つのビットに分かれている。
  const frame = A.buildFrame({ type: 0x00, infoBits: [4], buildingNo: 1, roomNo: 101 });
  const result = B.convert(frame, "aiphone", "hpc");
  assert.deepEqual(labels(result), ["ガス機器異常", "火災回路断"]);
  assert.equal(result.complete, true);
  const parsed = P.parseBlockFrame(result.frames[0], { protocol: "hpc" });
  assert.deepEqual(P.describeInfo("hpc", parsed.type, parsed.info).labels.sort(), ["ガス機器異常", "火災回路断"]);
  assert.ok(result.notes.some((note) => /「ガス障害、火災障害」は1つの桁に複数の意味があるため/.test(note)));
});

test("相手に枠がない警報は落とし、理由を残す", function () {
  // アイホンの標準割付には水漏れ・コール・COがない。
  const water = P.buildFrame({ protocol: "hpc", type: 0x00, infoBits: [3], buildingNo: 1, roomNo: 101 });
  const result = B.convert(water, "hpc", "aiphone");
  assert.deepEqual(dropped(result).sort(), ["コール", "水漏れ"]);
  assert.equal(result.frames.length, 0);
  assert.equal(result.complete, false);
  assert.ok(result.notes.some((note) => /「水漏れ」はアイホンに対応する枠がないため送れません/.test(note)));

  const co = P.buildFrame({ protocol: "hpc", type: 0x00, infoBits: [6], buildingNo: 1, roomNo: 101 });
  assert.deepEqual(dropped(B.convert(co, "hpc", "aiphone")), ["CO"]);
});

test("住戸以外からの発報はパナソニックへ変換しない", function () {
  for (const source of [{ managementNo: 1 }, { entranceNo: 2 }, { common: true }]) {
    const frame = A.buildFrame(Object.assign({ type: 0x00, infoBits: [1], buildingNo: 1 }, source));
    assert.throws(() => B.convert(frame, "aiphone", "hpc"), /発報元が住戸ではないため/);
  }
  // 住戸からの発報なら変換できる。
  assert.equal(B.convert(A.buildFrame({ type: 0x00, infoBits: [1], buildingNo: 1, roomNo: 101 }), "aiphone", "hpc").complete, true);
});

test("復旧はSTX形式へは変換でき、レコード形式へは変換できない", function () {
  const restore = A.buildFrame({ type: 0x00, info: 0x00, buildingNo: 1, roomNo: 101 });
  const toHpc = B.convert(restore, "aiphone", "hpc");
  assert.equal(toHpc.restore, true);
  assert.equal(toHpc.frames.length, 1);
  assert.equal(P.parseBlockFrame(toHpc.frames[0], { protocol: "hpc" }).info, 0x00);

  // 大興・リモートは1レコード1警報のため、復旧した警報を特定できない。
  const toDaiko = B.convert(restore, "aiphone", "daiko");
  assert.equal(toDaiko.frames.length, 0);
  assert.ok(toDaiko.notes.some((note) => /復旧（全bit OFF）は/.test(note)));

  // 逆にレコードの復旧（モードF）はアイホンの全bit OFFへ戻せる。
  const recordRestore = P.buildFrame({
    protocol: "daiko",
    records: [{ mode: "F", buildingNo: 1, roomNo: 101, alarmNo: 1 }],
  });
  const back = B.convert(recordRestore, "daiko", "aiphone");
  assert.equal(back.restore, true);
  assert.equal(A.parseFrame(back.frames[0]).info, 0x00);
});

test("ビット割付パターンで変換できる範囲が変わる", function () {
  // パターン１には外出警戒・在宅警戒があり、標準割付にはない。
  const away = A.buildFrame({ type: 0x00, infoBits: [6], buildingNo: 1, roomNo: 101 });
  const withPattern = B.convert(away, { id: "aiphone", pattern: "pattern1" }, "hpc");
  assert.deepEqual(labels(withPattern), ["外出警戒"]);
  // HPCに外出警戒の枠はないため落ちる。
  assert.deepEqual(dropped(withPattern), ["外出警戒"]);

  // 標準割付ではbit6が未割付なので、読み取り自体ができない。
  const withStandard = B.convert(away, { id: "aiphone", pattern: "standard" }, "hpc");
  assert.equal(withStandard.terms.length, 0);
  assert.equal(withStandard.unreadable.length, 1);
});

test("要求電文と警報以外は変換しない", function () {
  assert.throws(() => B.convert(A.buildFrame({ type: 0x30 }), "aiphone", "hpc"), /ヒストリー要求は/);
  assert.throws(() => B.convert(P.buildFrame({ protocol: "hpc", type: 0x30 }), "hpc", "aiphone"), /ヒストリー要求は/);
  assert.throws(() => B.convert(P.buildAnswerback({ protocol: "daiko" }), "daiko", "aiphone"), /警報データ以外は/);
  assert.throws(() => B.convert(A.buildFrame({ type: 0x00, infoBits: [1], buildingNo: 1, roomNo: 101 }), "aiphone", "aiphone"), /変換元と変換先が同じ/);
  assert.throws(() => B.convert([], "aiphone", "unknown"), /変換先が不明/);
});

test("住戸が異なるレコードが混在する電文は1件へまとめない", function () {
  const mixed = P.buildFrame({
    protocol: "daiko",
    records: [
      { mode: "N", buildingNo: 1, roomNo: 101, alarmNo: 1 },
      { mode: "N", buildingNo: 1, roomNo: 102, alarmNo: 1 },
    ],
  });
  assert.throws(() => B.convert(mixed, "daiko", "aiphone"), /住戸が異なるレコードが混在/);
});

test("変換表を一覧として取り出せる", function () {
  const rows = B.mappingTable("aiphone", "hpc");
  assert.ok(rows.length > 0);
  const fire = rows.find((row) => row.term === "fire");
  assert.equal(fire.label, "火災");
  assert.equal(fire.from.label, "火災、遠隔試験");
  assert.equal(fire.to.label, "火災");
  // 相手に枠がない項目は to が null になる。
  const toAiphone = B.mappingTable("hpc", "aiphone");
  const co = toAiphone.find((row) => row.term === "co");
  assert.equal(co.to, null);
});

console.log("=== " + passed + " alarm bridge tests passed ===");
