"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const P = require("../protocol/panasonic-alarm.js");
const FrameReader = require("../protocol/frame-reader.js");

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

const ascii = (bytes) => P.toAscii(bytes);

console.log("=== パナソニック警報プロトコル4種 ===");

test("UMDがブラウザ相当のコンテキストでPanasonicAlarmを公開する", function () {
  const source = fs.readFileSync(path.join(__dirname, "../protocol/panasonic-alarm.js"), "utf8");
  const context = {};
  vm.runInNewContext(source, context);
  assert.equal(typeof context.PanasonicAlarm.buildFrame, "function");
});

test("4プロトコルの形式と通信条件が仕様どおり", function () {
  assert.deepEqual(P.PROTOCOL_NAMES.slice(), ["hpc", "tss", "daiko", "remote"]);
  // HPC／新TSSは偶数パリティ＋BCC、大興／リモートはパリティなし＋チェックサム。
  assert.equal(P.styleOf("hpc"), P.STYLE.BLOCK);
  assert.equal(P.styleOf("tss"), P.STYLE.BLOCK);
  assert.equal(P.styleOf("daiko"), P.STYLE.RECORD);
  assert.equal(P.styleOf("remote"), P.STYLE.RECORD);
  for (const name of P.PROTOCOL_NAMES) {
    assert.equal(P.protocolInfo(name).serial.baudRate, 1200);
    assert.equal(P.protocolInfo(name).serial.dataBits, 8);
  }
  assert.equal(P.protocolInfo("hpc").serial.parity, "even");
  assert.equal(P.protocolInfo("tss").serial.parity, "even");
  assert.equal(P.protocolInfo("daiko").serial.parity, "none");
  assert.equal(P.protocolInfo("remote").serial.parity, "none");
  // ヒストリーと住戸情報要求はHPCだけ、定時送信はリモートだけ。
  assert.equal(P.protocolInfo("hpc").history, true);
  assert.equal(P.protocolInfo("tss").history, false);
  assert.equal(P.protocolInfo("remote").scheduled, true);
  assert.equal(P.protocolInfo("daiko").scheduled, false);
  assert.throws(() => P.protocolInfo("unknown"), /未知のプロトコル/);
});

// ---------------------------------------------------------------- HPC／新TSS

test("HPCの発信種別は7種、新TSSは5種", function () {
  assert.deepEqual(P.blockTypes("hpc").map((entry) => entry.code), [0x00, 0x01, 0x02, 0x04, 0x05, 0x10, 0x30]);
  assert.deepEqual(P.blockTypes("tss").map((entry) => entry.code), [0x00, 0x01, 0x02, 0x04, 0x44]);
  // 新TSSに05H(汎用警報情報)・10H(住戸情報要求)・30H(ヒストリー要求)はない。
  assert.throws(() => P.findBlockType("tss", 0x05), /新ＴＳＳに発信種別 05H はありません/);
  assert.throws(() => P.findBlockType("tss", 0x30), /新ＴＳＳに発信種別 30H はありません/);
  // 大興／リモートは発信種別を持たない。
  assert.throws(() => P.blockTypes("daiko"), /発信種別を持ちません/);
});

test("HPCの警報情報ビット割付が仕様の表と一致する", function () {
  const label = (protocol, type) => P.bitAssignments(protocol, type).map((cell) => cell.label);
  assert.deepEqual(label("hpc", 0x00),
    ["火災", "非常", "ガス", "水漏れ／コール", "火災回路断", "ガス機器異常", "ＣＯ", "防犯(代表)"]);
  assert.deepEqual(label("hpc", 0x01),
    ["防犯１", "防犯２", "防犯３", "防犯(代表)ｾｯﾄ/ﾘｾｯﾄ", "防犯１ｾｯﾄ/ﾘｾｯﾄ", "防犯２ｾｯﾄ/ﾘｾｯﾄ", "防犯３ｾｯﾄ/ﾘｾｯﾄ", "住戸電源断"]);
  assert.deepEqual(label("hpc", 0x02),
    ["コール１", "コール２", "コール３", "コール４", null, null, null, "外部機器異常"]);
  assert.deepEqual(label("hpc", 0x04),
    ["防犯４", null, null, null, "防犯４ｾｯﾄ/ﾘｾｯﾄ", null, null, null]);
  assert.deepEqual(label("hpc", 0x05),
    ["汎用警報(代表)", "汎用警報１", "汎用警報２", "汎用警報３", "汎用警報４", null, null, null]);
  // 要求電文は00H固定で割付を持たない。
  assert.equal(P.bitAssignments("hpc", 0x10), null);
  assert.equal(P.bitAssignments("hpc", 0x30), null);
});

test("新TSSの警報情報ビット割付が仕様の表と一致する", function () {
  const label = (type) => P.bitAssignments("tss", type).map((cell) => cell.label);
  assert.deepEqual(label(0x00),
    ["火災", "非常", "ガス漏れ", "水漏れ", "コール", "防犯(代表)", "火災断線", "ガス機器異常"]);
  assert.deepEqual(label(0x01),
    ["ＣＯ", null, null, "住戸電源断", "ﾜｲﾔﾚｽ電池切れ", "ﾜｲﾔﾚｽ機器異常", null, null]);
  assert.deepEqual(label(0x02), ["コール１", "コール２", "コール３", null, null, null, null, null]);
  assert.deepEqual(label(0x04), ["防犯ｾｯﾄ", null, null, null, null, null, null, null]);
  assert.deepEqual(label(0x44), ["防犯ﾘｾｯﾄ", null, null, null, null, null, null, null]);
  // 同じ00Hでも割付が違うため、HPCと新TSSでbit3の意味が入れ替わる。
  assert.equal(P.describeInfo("hpc", 0x00, 0x08).summary, "水漏れ／コール");
  assert.equal(P.describeInfo("tss", 0x00, 0x08).summary, "水漏れ");
});

test("警報情報の展開はbit0がLSBで、予備bitを注意として返す", function () {
  const detail = P.describeInfo("hpc", 0x00, 0x03);
  assert.equal(detail.hex, "03");
  assert.deepEqual(detail.labels, ["火災", "非常"]);
  assert.deepEqual(detail.violations, []);
  assert.equal(detail.summary, "火災＋非常");
  // 02H(警報情報3)のbit4～6は予備。HEX直接入力で立てたら注意にする。
  const reserved = P.describeInfo("hpc", 0x02, 0x10);
  assert.deepEqual(reserved.violations, [4]);
  assert.equal(reserved.summary, "bit4（予備）");
  // 全bit OFFは復旧を意味する。
  assert.equal(P.describeInfo("hpc", 0x00, 0x00).summary, "全bit OFF（警報なし／復旧）");
  assert.equal(P.describeInfo("hpc", 0x30, 0x00).summary, "00H固定（ヒストリー要求）");
  assert.equal(P.encodeInfo([0, 7]), 0x81);
  assert.deepEqual(P.decodeInfo(0x81), [0, 7]);
});

test("棟番号はBCDではなくバイナリで、64H以降は予備", function () {
  // 0AH=10棟、63H=99棟。アイホンQ49-023GのBCDとは異なる。
  assert.equal(P.encodeBuilding(10), 0x0A);
  assert.equal(P.encodeBuilding(99), 0x63);
  assert.equal(P.decodeBuilding(0x0A), 10);
  assert.equal(P.decodeBuilding(0x63), 99);
  assert.throws(() => P.decodeBuilding(0x64), /予備領域/);
  assert.throws(() => P.encodeBuilding(100), /0～99/);
});

test("住戸番号は下位4bitがBCD、上位4bitがヒストリー種別", function () {
  assert.deepEqual(P.encodeDwelling(101, 0), [0x00, 0x01, 0x00, 0x01]);
  assert.deepEqual(P.encodeDwelling(1201, 3), [0x31, 0x32, 0x30, 0x31]);
  assert.deepEqual(P.encodeDwelling(9999, 15), [0xF9, 0xF9, 0xF9, 0xF9]);
  const decoded = P.decodeDwelling([0x31, 0x32, 0x30, 0x31]);
  assert.equal(decoded.roomNo, 1201);
  assert.equal(decoded.historyNumber, 3);
  // 4byteでヒストリー種別が食い違う電文は受け付けない。
  assert.throws(() => P.decodeDwelling([0x31, 0x22, 0x30, 0x31]), /ヒストリー種別が一致/);
  assert.throws(() => P.decodeDwelling([0x0A, 0x00, 0x00, 0x00]), /BCDではありません/);
});

test("HPCの警報電文を組み立てて読み戻せる", function () {
  const frame = P.buildFrame({ protocol: "hpc", type: 0x00, infoBits: [0], buildingNo: 1, roomNo: 101 });
  assert.deepEqual(frame, [0x02, 0x37, 0x00, 0x01, 0x01, 0x00, 0x01, 0x00, 0x01, 0x03, 0x3E]);
  const parsed = P.parse(frame, { protocol: "hpc" });
  assert.equal(parsed.typeLabel, "警報情報１");
  assert.equal(parsed.info, 0x01);
  assert.equal(parsed.buildingNo, 1);
  assert.equal(parsed.roomNo, 101);
  assert.equal(parsed.historyNumber, 0);
  assert.equal(parsed.request, false);
  // BCCはSTXの次からETXまでの加算（桁上がり無視）。
  assert.equal(P.calculateBCC(frame.slice(0, 10)), 0x3E);
  assert.equal(P.verifyBCC(frame), true);
  const broken = frame.slice();
  broken[10] = (broken[10] + 1) & 0xFF;
  assert.equal(P.verifyBCC(broken), false);
  assert.equal(P.validate(broken, { protocol: "hpc" }), false);
  assert.throws(() => P.parse(broken, { protocol: "hpc" }), /BCCが一致しません/);
});

test("STX形式の電文長・STX・データ長・ETXを厳格に検証する", function () {
  const frame = P.buildFrame({ protocol: "tss", type: 0x00, infoBits: [0], buildingNo: 1, roomNo: 101 });
  assert.equal(frame.length, P.BLOCK_LENGTH);
  assert.throws(() => P.parse(frame.slice(0, 10), { protocol: "tss" }), /11byteちょうど/);
  const badStx = frame.slice(); badStx[0] = 0x01;
  assert.throws(() => P.parse(badStx, { protocol: "tss" }), /STXが02Hではありません/);
  const badSize = frame.slice(); badSize[1] = 0x36;
  assert.throws(() => P.parse(badSize, { protocol: "tss" }), /データ長が37Hではありません/);
  const badEtx = frame.slice(); badEtx[9] = 0x04;
  assert.throws(() => P.parse(badEtx, { protocol: "tss" }), /ETXが03Hではありません/);
});

test("要求電文の固定値を守らせる", function () {
  // ヒストリー要求は棟番号・住戸番号・警報情報がすべて00。
  const request = P.buildFrame({ protocol: "hpc", type: 0x30 });
  assert.deepEqual(request, [0x02, 0x37, 0x30, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x03, 0x6A]);
  assert.equal(P.parse(request, { protocol: "hpc" }).request, true);
  assert.throws(() => P.buildFrame({ protocol: "hpc", type: 0x30, buildingNo: 1 }), /棟番号・住戸番号は00固定/);
  assert.throws(() => P.buildFrame({ protocol: "hpc", type: 0x30, info: 0x01 }), /警報情報は00H固定/);
  // 住戸情報要求は警報情報だけが00H固定で、対象住戸は指定する。
  const dwelling = P.buildFrame({ protocol: "hpc", type: 0x10, buildingNo: 2, roomNo: 305 });
  assert.equal(P.parse(dwelling, { protocol: "hpc" }).roomNo, 305);
  assert.throws(() => P.buildFrame({ protocol: "hpc", type: 0x10, info: 0x01 }), /警報情報は00H固定/);
});

test("ヒストリー番号はHPCの警報電文でだけ使える", function () {
  const frame = P.buildFrame({ protocol: "hpc", type: 0x01, infoBits: [7], buildingNo: 2, roomNo: 1201, historyNumber: 3 });
  assert.equal(P.parse(frame, { protocol: "hpc" }).historyNumber, 3);
  assert.throws(() => P.buildFrame({ protocol: "tss", type: 0x00, historyNumber: 1 }), /ヒストリー応答はありません/);
  assert.throws(() => P.buildFrame({ protocol: "hpc", type: 0x30, historyNumber: 1 }), /要求電文にヒストリー番号は設定できません/);
  // 新TSSでヒストリー種別付きの電文を受けたら仕様違反として扱う。
  assert.throws(() => P.parse(frame, { protocol: "tss" }), /ヒストリー応答はありません/);
});

// -------------------------------------------------------------- 大興／リモート

test("警報No.台帳の件数と割付が別表どおり", function () {
  assert.equal(P.alarmNumbers("daiko").length, 28);
  assert.equal(P.alarmNumbers("remote").length, 29);
  // 03/04は大興が「非常／防犯(代表)」、リモートが「防犯(代表)／非常」で入れ替わる。
  assert.equal(P.findAlarmNumber("daiko", 3).label, "非常");
  assert.equal(P.findAlarmNumber("daiko", 4).label, "防犯(代表)");
  assert.equal(P.findAlarmNumber("remote", 3).label, "防犯(代表)");
  assert.equal(P.findAlarmNumber("remote", 4).label, "非常");
  // 宅配登録･削除(40)はリモートだけにある。
  assert.equal(P.findAlarmNumber("daiko", 40), null);
  assert.equal(P.findAlarmNumber("remote", 40).label, "宅配登録･削除");
  assert.throws(() => P.alarmNumbers("hpc"), /警報No.を持ちません/);
});

test("モードの意味は警報No.で変わる", function () {
  assert.equal(P.modeLabel("daiko", 1, "N"), "異常発生");
  assert.equal(P.modeLabel("daiko", 1, "F"), "異常復旧");
  // 防犯セット／リセット情報はモードN=セット、モードF=リセット。
  assert.equal(P.modeLabel("daiko", 30, "N"), "セット");
  assert.equal(P.modeLabel("daiko", 34, "F"), "リセット");
  // 宅配登録／削除情報はモードN=登録、モードF=削除。
  assert.equal(P.modeLabel("remote", 40, "N"), "登録");
  assert.equal(P.modeLabel("remote", 40, "F"), "削除");
  assert.throws(() => P.resolveMode("X"), /モードはN（異常発生）またはF（異常復旧）/);
});

test("大興のレコード電文を組み立てて読み戻せる", function () {
  const frame = P.buildFrame({
    protocol: "daiko",
    records: [
      { mode: "N", buildingNo: 1, roomNo: 101, alarmNo: 1 },
      { mode: "F", buildingNo: 1, roomNo: 101, alarmNo: 1 },
    ],
  });
  assert.equal(ascii(frame), "SND" + "N01010101\x03" + "F01010101\x03" + "03A2" + "\r");
  const parsed = P.parse(frame, { protocol: "daiko" });
  assert.equal(parsed.kind, "alarm");
  assert.equal(parsed.recordCount, 2);
  assert.equal(parsed.records[0].alarmLabel, "火災");
  assert.equal(parsed.records[0].modeLabel, "異常発生");
  assert.equal(parsed.records[1].modeLabel, "異常復旧");
  // 1レコードは10byte（モード+棟2+住戸4+警報No2+ETX）。
  assert.equal(parsed.records[0].bytes.length, P.RECORD_LENGTH);
});

test("チェックサムは仕様書のアンサーバック例と一致する", function () {
  // SNDOK009A：加算対象は"OK"（4FH+4BH=9AH）だけ。
  assert.equal(ascii(P.buildAnswerback({ protocol: "daiko" })), "SNDOK009A\r");
  assert.equal(ascii(P.buildAnswerback({ protocol: "remote" })), "SNDOK009A\r");
  // TRSOK009A：定時送信のアンサーバック。
  assert.equal(ascii(P.buildAnswerback({ protocol: "remote", scheduled: true })), "TRSOK009A\r");
  assert.equal(ascii(P.buildAnswerback({ protocol: "daiko", accepted: false })), "NG\r");
  assert.equal(P.calculateChecksum([0x4F, 0x4B]), 0x9A);
  assert.equal(P.checksumText(0x9A), "009A");
  // 大興に定時送信はない。
  assert.throws(() => P.buildAnswerback({ protocol: "daiko", scheduled: true }), /定時送信はありません/);
  const ack = P.parse(P.buildAnswerback({ protocol: "daiko" }), { protocol: "daiko" });
  assert.equal(ack.kind, "ack");
  assert.equal(P.parse(P.buildAnswerback({ protocol: "daiko", accepted: false }), { protocol: "daiko" }).kind, "nak");
});

test("リモートの定時送信を組み立てて読み戻せる", function () {
  const frame = P.buildScheduledFrame({ protocol: "remote", propertyCode: "12345" });
  // チェックサムは［!］～［ETX］のASCII加算。
  assert.equal(ascii(frame), "TRS!712345\x03015A\r");
  const parsed = P.parse(frame, { protocol: "remote" });
  assert.equal(parsed.kind, "scheduled");
  assert.equal(parsed.propertyCode, "12345");
  assert.throws(() => P.buildScheduledFrame({ protocol: "daiko" }), /定時送信はありません/);
});

test("レコード電文の異常を検出する", function () {
  const frame = P.buildFrame({ protocol: "daiko", records: [{ mode: "N", buildingNo: 1, roomNo: 101, alarmNo: 1 }] });
  // CR欠落
  assert.throws(() => P.parse(frame.slice(0, -1), { protocol: "daiko" }), /CRで終わっていません/);
  // チェックサム異常
  const badSum = frame.slice();
  badSum[badSum.length - 2] = "0".charCodeAt(0);
  assert.throws(() => P.parse(badSum, { protocol: "daiko" }), /チェックサムが一致しません/);
  // レコード長が10byteの倍数でない
  const ragged = Array.from("SNDN01010101\x03X0000\r", (character) => character.charCodeAt(0));
  assert.throws(() => P.parse(ragged, { protocol: "daiko" }), /10byteの倍数ではありません/);
  // 1レコードにも満たない長さ
  const short = Array.from("SNDN010\x030000\r", (character) => character.charCodeAt(0));
  assert.throws(() => P.parse(short, { protocol: "daiko" }), /長さが足りません/);
  // レコードがETXで終わっていない
  const noEtx = Array.from("SNDN01010101X0000\r", (character) => character.charCodeAt(0));
  assert.throws(() => P.parse(noEtx, { protocol: "daiko" }), /ETXで終わっていません|チェックサムが一致しません/);
  // 別表にない警報No.は組み立て時に弾く
  assert.throws(() => P.buildFrame({ protocol: "daiko", records: [{ mode: "N", buildingNo: 1, roomNo: 101, alarmNo: 40 }] }),
    /大興の別表に警報No.40 はありません/);
  // 最大10レコード
  const many = Array.from({ length: 11 }, () => ({ mode: "N", buildingNo: 1, roomNo: 101, alarmNo: 1 }));
  assert.throws(() => P.buildFrame({ protocol: "daiko", records: many }), /最大10レコード/);
  assert.throws(() => P.buildFrame({ protocol: "daiko", records: [] }), /1件以上/);
});

// ------------------------------------------------------------------ ヒストリー

test("ヒストリーは現状から1つ前へ進み、保持件数でリングになる", function () {
  const history = new P.PanasonicHistory({ protocol: "hpc" });
  assert.equal(history.empty, true);
  assert.equal(history.nextFrame(), null);
  // 古い順に記録すると、現状(=0)が最新イベントになる。
  for (const roomNo of [101, 102, 103]) {
    history.record({ type: 0x00, infoBits: [0], buildingNo: 1, roomNo });
  }
  assert.equal(history.size, 3);
  assert.equal(history.peek().roomNo, 103);
  // 1回目の要求は「1つ前」、2回目は「2つ前」、3回目で現状へ戻る。
  const rooms = [history.next(), history.next(), history.next()].map((entry) => entry.roomNo);
  assert.deepEqual(rooms, [102, 101, 103]);
  const frame = history.nextFrame();
  assert.equal(P.parse(frame, { protocol: "hpc" }).historyNumber, 1);
  // 新規イベントはポインタを先頭へ戻す。
  history.record({ type: 0x00, infoBits: [1], buildingNo: 1, roomNo: 201 });
  assert.equal(history.pointer, 0);
  assert.equal(history.next().roomNo, 103);
});

test("ヒストリーは15件を超えると古い情報を捨てる", function () {
  const history = new P.PanasonicHistory({ protocol: "hpc" });
  for (let index = 1; index <= 20; index += 1) {
    history.record({ type: 0x00, infoBits: [0], buildingNo: 1, roomNo: index });
  }
  assert.equal(history.size, P.HISTORY_LIMIT);
  assert.equal(history.peek().roomNo, 20);
  assert.equal(history.toArray()[P.HISTORY_LIMIT - 1].roomNo, 6);
  // 住戸情報要求はポインタを動かさず、指定住戸の最新状態を返す。
  history.next();
  const pointer = history.pointer;
  const frame = history.dwellingFrame(1, 12);
  assert.equal(P.parse(frame, { protocol: "hpc" }).roomNo, 12);
  assert.equal(P.parse(frame, { protocol: "hpc" }).historyNumber, 0);
  assert.equal(history.pointer, pointer);
  assert.equal(history.dwellingFrame(9, 99), null);
  // 要求電文は記録できない。
  assert.throws(() => history.record({ type: 0x30 }), /要求電文はヒストリーに記録できません/);
  assert.throws(() => new P.PanasonicHistory({ protocol: "tss" }), /ヒストリー応答はありません/);
});

// ---------------------------------------------------------------- 受信の境界

test("panasonicBlockはBCCがSTXと同値でも11byteで切り出す", function () {
  const reader = new FrameReader("panasonicBlock");
  // BCCが02H(STX)になる組み合わせを作り、途中で再同期しないことを確かめる。
  const frame = P.buildFrame({ protocol: "hpc", type: 0x00, info: 0xC8, buildingNo: 0, roomNo: 0 });
  assert.equal(frame[10], 0x02);
  const events = reader.push(frame);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].bytes, frame);
  // 分割して届いても同じ結果になる。
  const split = new FrameReader("panasonicBlock");
  assert.equal(split.push(frame.slice(0, 5)).length, 0);
  assert.deepEqual(split.push(frame.slice(5))[0].bytes, frame);
});

test("panasonicRecordはCRで区切り、1byteずつ届いても連結されても同じ結果になる", function () {
  const alarm = P.buildFrame({ protocol: "daiko", records: [{ mode: "N", buildingNo: 1, roomNo: 101, alarmNo: 1 }] });
  const ack = P.buildAnswerback({ protocol: "daiko" });
  const nak = P.buildAnswerback({ protocol: "daiko", accepted: false });
  const stream = alarm.concat(ack, nak);

  const bulk = new FrameReader("panasonicRecord").push(stream).filter((event) => event.type === "frame");
  assert.deepEqual(bulk.map((event) => ascii(event.bytes)), [ascii(alarm), ascii(ack), ascii(nak)]);

  const drip = new FrameReader("panasonicRecord");
  const dripped = [];
  for (const byte of stream) dripped.push(...drip.push([byte]).filter((event) => event.type === "frame"));
  assert.deepEqual(dripped.map((event) => ascii(event.bytes)), bulk.map((event) => ascii(event.bytes)));

  // レコード区切りのETXでは切らない。
  assert.equal(bulk[0].bytes.filter((byte) => byte === 0x03).length, 1);
  // ヘッダが仕様外なら受信データとして捨て、次のCRを待たない。
  const garbage = new FrameReader("panasonicRecord").push(Array.from("SNX!!\r", (character) => character.charCodeAt(0)));
  assert.equal(garbage[0].type, "error");
});

test("FrameReaderのプロファイル一覧にパナソニックが含まれる", function () {
  assert.ok(FrameReader.PROFILES.includes("panasonicBlock"));
  assert.ok(FrameReader.PROFILES.includes("panasonicRecord"));
});

console.log("=== " + passed + " panasonic tests passed ===");
