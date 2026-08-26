"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const D = require("../protocol/device-bridge.js");
const Key = require("../protocol/noncontact-key.js");
const L4 = require("../protocol/locker4.js");
const MC = require("../protocol/mansion-controller.js");

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

const messageOf = (frame) => MC.parseFrame(frame, { version: 3 }).messageText;

console.log("=== 宅配・非接触キー → マンションコントローラ ===");

test("UMDがブラウザ相当のコンテキストでDeviceBridgeを公開する", function () {
  const sources = [
    "../protocol/locker4.js", "../protocol/noncontact-key.js",
    "../protocol/mansion-controller.js", "../protocol/device-bridge.js",
  ];
  const context = {};
  for (const source of sources) {
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, source), "utf8"), context);
  }
  assert.equal(typeof context.DeviceBridge.convert, "function");
});

test("非接触キー13byteはICキー情報-2(62H)へ載る", function () {
  const frame = Key.buildTelegram({ format: Key.FORMAT.WITH_PERSON, gateNo: 2, buildingNo: 1, roomNo: 101, personNo: 3 });
  const result = D.convert(frame, { from: "key", version: 3 });
  assert.equal(result.complete, true);
  assert.equal(result.frames.length, 1);
  const parsed = MC.parseFrame(result.frames[0], { version: 3 });
  assert.equal(parsed.kind, 0x37);
  assert.equal(parsed.cmd, 0x62);
  // ゲート02 + ADDR(B1B101) + 個人003
  assert.equal(parsed.messageText, "02B1B101003");
  assert.equal(result.records[0].commandLabel, "ICキー情報-2");
});

test("非接触キー10byteは個人番号を持たないICキー情報-1(61H)へ載る", function () {
  const frame = Key.buildTelegram({ format: Key.FORMAT.ROOM_ONLY, gateNo: 1, buildingNo: 0, roomNo: 1201 });
  const result = D.convert(frame, { from: "key", version: 3 });
  const parsed = MC.parseFrame(result.frames[0], { version: 3 });
  assert.equal(parsed.cmd, 0x61);
  // 棟番号なし(0)は標準システムのBBになる。
  assert.equal(parsed.messageText, "01BB1201");
  assert.equal(result.records[0].commandLabel, "ICキー情報-1");
});

test("棟番号の有無でADDRの棟コードが変わる", function () {
  // 棟0は標準システムのBB、棟1～9は多棟システムのB1～B9。
  assert.equal(D.addressOf(0, 101, { version: 3 }).text, "BBB101");
  assert.equal(D.addressOf(1, 101, { version: 3 }).text, "B1B101");
  assert.equal(D.addressOf(9, 9999, { version: 3 }).text, "B99999");
  assert.equal(D.addressOf(0, 101, { version: 3 }).topology, "standard");
  assert.equal(D.addressOf(1, 101, { version: 3 }).topology, "multi-building");
  // 3桁住戸はB付き、4桁住戸はそのまま。
  assert.equal(D.addressOf(0, 999, { version: 3 }).text, "BBB999");
  assert.equal(D.addressOf(0, 1001, { version: 3 }).text, "BB1001");
});

test("宅配4線式のロッカーは1件ずつICボックス情報(43H)へ分ける", function () {
  const frame = L4.buildResponseTelegram({
    packageNo: 0, modelNo: 1,
    lockers: [
      { state: L4.STATE.PARCEL, lockerNo: 5, buildingNo: 1, roomNo: 101 },
      { state: L4.STATE.EMPTY, lockerNo: 6, buildingNo: 1, roomNo: 102 },
    ],
  });
  const result = D.convert(frame, { from: "locker4", version: 3 });
  assert.equal(result.complete, true);
  assert.equal(result.frames.length, 2);
  // 残PKT(4桁) + PKT NO(1件=31H) + STS + ADDR
  assert.equal(messageOf(result.frames[0]), "000111B1B101", "1件目は残1・着荷状態");
  assert.equal(messageOf(result.frames[1]), "000010B1B102", "2件目は残0・取出し状態");
  for (const frame of result.frames) {
    const parsed = MC.parseFrame(frame, { version: 3 });
    assert.equal(parsed.kind, 0x36);
    assert.equal(parsed.cmd, 0x43);
  }
});

test("ボックス状態は取出しと着荷だけが対応する", function () {
  // Q48-005Fの荷物なし/ありが、Q48-008Iの取出し/着荷に対応する。
  assert.equal(D.BOX_STATUS[L4.STATE.EMPTY], 0x30);
  assert.equal(D.BOX_STATUS[L4.STATE.PARCEL], 0x31);
  // 集荷・食配・書留・宅配ロボに対応する状態はない。
  for (const state of [0x32, 0x33, 0x34, 0x35, 0x40, 0x41, 0x42]) {
    assert.equal(D.BOX_STATUS[state], undefined, `状態${state.toString(16)}に対応があってはならない`);
  }
});

test("対応する状態がないロッカーは理由を付けて落とす", function () {
  const frame = L4.buildResponseTelegram({
    packageNo: 0, modelNo: 1,
    lockers: [
      { state: L4.STATE.PARCEL, lockerNo: 5, buildingNo: 1, roomNo: 101 },
      { state: 0x32, lockerNo: 7, buildingNo: 1, roomNo: 103 },
    ],
  });
  const result = D.convert(frame, { from: "locker4", version: 3 });
  assert.equal(result.complete, false);
  assert.equal(result.frames.length, 1, "変換できた1件だけを送る");
  assert.equal(result.dropped.length, 1);
  assert.equal(result.dropped[0].lockerNo, 7);
  assert.match(result.dropped[0].reason, /ボックス状態識別（取出し／着荷／滞留）に対応する値がありません/);
  assert.ok(result.notes.some((note) => /ロッカー007の「集荷預かり」は送れません/.test(note)));
});

test("住戸番号が0000のものはADDRを作れないため落とす", function () {
  const frame = L4.buildResponseTelegram({
    packageNo: 0, modelNo: 1,
    lockers: [{ state: L4.STATE.PARCEL, lockerNo: 5, buildingNo: 1, roomNo: 0 }],
  });
  const result = D.convert(frame, { from: "locker4", version: 3 });
  assert.equal(result.frames.length, 0);
  assert.match(result.dropped[0].reason, /住戸ADDRを組み立てられません/);
  // 非接触キーは部屋番号0001～9999しか電文にならないため、この経路は宅配だけにある。
  assert.throws(() => Key.buildTelegram({ format: Key.FORMAT.ROOM_ONLY, gateNo: 1, buildingNo: 0, roomNo: 0 }),
    /roomNo must be an integer from 1 to 9999/);
});

test("情報要求など変換できない電文は理由を返す", function () {
  const request = L4.buildRequestTelegram({});
  assert.throws(() => D.convert(request, { from: "locker4", version: 3 }), /情報応答／変化通知だけを変換できます/);
  assert.throws(() => D.convert([], { from: "unknown" }), /宅配4線式か非接触キー/);
});

test("対応表を一覧として取り出せる", function () {
  const key = D.mappingTable("key");
  assert.equal(key.length, 3);
  assert.match(key[0].from, /ゲートNo/);
  assert.match(key[1].to, /ADDR/);

  const locker = D.mappingTable("locker4");
  // 対応がないものは「（対応なし）」で示す。
  const unsupported = locker.filter((row) => row.to.startsWith("（"));
  assert.ok(unsupported.length >= 2);
  assert.ok(locker.some((row) => /集荷預り/.test(row.from) && /対応なし/.test(row.to)));
});

// ボックス再送要求への応答は、保持している状態から直接組み立てる。
test("保持ロッカーからICボックス情報を残PKT付きで組み立てる", function () {
  const held = [
    { state: L4.STATE.PARCEL, lockerNo: 1, buildingNo: 0, roomNo: 101 },
    { state: L4.STATE.PARCEL, lockerNo: 2, buildingNo: 0, roomNo: 102 },
  ];
  const converted = D.boxRecords(held, { version: 3 });
  assert.equal(converted.records.length, 2);
  assert.equal(converted.dropped.length, 0);

  const frames = D.boxInfoFrames(converted.records, { version: 3, role: "IC" });
  assert.equal(frames.length, 2);
  const first = MC.parseFrame(frames[0], { version: 3, from: "IC" });
  const last = MC.parseFrame(frames[1], { version: 3, from: "IC" });
  assert.equal(first.command, 0x43);
  // 残PKTは1件ずつ減り、最終パケットは0になる。
  assert.equal(first.messageText, "0001" + "1" + "1" + "BBB101");
  assert.equal(last.messageText, "0000" + "1" + "1" + "BBB102");
});

test("役割がMCならボックスNOを持つMCボックス情報を組み立てる", function () {
  const converted = D.boxRecords([{ state: L4.STATE.PARCEL, lockerNo: 7, buildingNo: 0, roomNo: 101 }], { version: 3 });
  const frames = D.boxInfoFrames(converted.records, { version: 3, role: "MC" });
  const parsed = MC.parseFrame(frames[0], { version: 3, from: "MC" });
  assert.equal(parsed.command, 0x41);
  // 41Hは残PKT3桁＋PKT NO＋ボックスNO3桁＋STS＋ADDR。
  assert.equal(parsed.messageText, "000" + "1" + "007" + "1" + "BBB101");
});

test("ボックス状態識別に対応しないロッカーは理由を付けて落とす", function () {
  const converted = D.boxRecords([{ state: L4.STATE.PICKUP_HOLD, lockerNo: 3, buildingNo: 0, roomNo: 103 }], { version: 3 });
  assert.equal(converted.records.length, 0);
  assert.match(converted.dropped[0].reason, /ボックス状態識別/);
  assert.equal(D.boxInfoFrames(converted.records, { version: 3, role: "IC" }).length, 0);
});

console.log("=== " + passed + " device bridge tests passed ===");
