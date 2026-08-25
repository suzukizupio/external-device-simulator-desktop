"use strict";

const assert = require("assert");
const Inspector = require("../protocol/receive-inspector");
const Telegram2 = require("../protocol/locker2");
const Telegram4 = require("../protocol/locker4");
const Key = require("../protocol/noncontact-key");

const fieldOf = (result, label) => result.fields.find((field) => field.label === label);

// ---------------------------------------------------------------- 対象範囲
assert.deepStrictEqual(Inspector.PROFILES.slice().sort(), ["key", "locker2", "locker4", "panasonic", "panasonicElevator"]);
assert.strictEqual(Inspector.supports("locker4"), true);
assert.strictEqual(Inspector.supports("mansion"), false);
const unsupported = Inspector.inspect("mansion", [0x02, 0x03]);
assert.strictEqual(unsupported.valid, false);
assert.match(unsupported.error, /未対応/);

// -------------------------------------------------------- 4線式 情報応答
const response = Telegram4.buildResponseTelegram({
  packageNo: 1,
  modelNo: 1,
  lockers: [
    { state: Telegram4.STATE.PARCEL, lockerNo: 5, buildingNo: 1, roomNo: 101 },
    { state: Telegram4.STATE.EMPTY, lockerNo: 6, buildingNo: 1, roomNo: 102 },
  ],
});
const r4 = Inspector.inspect("locker4", response, { expectedType: "response" });
assert.strictEqual(r4.valid, true, `expected valid: ${r4.error}`);
assert.strictEqual(r4.profile, "locker4");
assert.strictEqual(r4.parsed.type, "response");
assert.strictEqual(r4.parsed.packageNo, 1);
assert.strictEqual(r4.parsed.modelNo, 1);
assert.strictEqual(r4.lockers.length, 2);
assert.strictEqual(r4.expectedResponse, "ACK");
assert.deepStrictEqual(r4.warnings, []);
assert.strictEqual(fieldOf(r4, "発信ID").value, "37H 宅配ボックス");
assert.strictEqual(fieldOf(r4, "着信ID").value, "38H 集合住宅システム");
assert.strictEqual(fieldOf(r4, "パッケージNO").value, "01（この後さらに1パケット続きます）");
assert.match(fieldOf(r4, "BCC").value, /一致$/);
// 位置は仕様書と同じ1バイト目起点。
assert.strictEqual(fieldOf(r4, "STX").range, "1");
assert.strictEqual(fieldOf(r4, "データ長").range, "4–6");
assert.strictEqual(r4.lockers[0].stateLabel, "荷物あり");
assert.strictEqual(r4.lockers[0].lockerNo, 5);
assert.strictEqual(r4.lockers[0].buildingNo, 1);
assert.strictEqual(r4.lockers[0].roomNo, 101);
assert.strictEqual(r4.lockers[0].data2Text, "空白(20H)");
assert.strictEqual(r4.lockers[1].stateLabel, "荷物なし");
assert.ok(r4.summary.includes("2件のロッカー情報"), r4.summary);

// 方向が想定と逆なら警告のみで、電文自体は正常扱い。
const r4Direction = Inspector.inspect("locker4", response, { expectedType: "request" });
assert.strictEqual(r4Direction.valid, true);
assert.strictEqual(r4Direction.warnings.length, 1);
assert.match(r4Direction.warnings[0], /情報要求を受信する想定/);

// -------------------------------------------------------- 4線式 情報要求
const request = Telegram4.buildRequestTelegram({});
const r4Request = Inspector.inspect("locker4", request, { expectedType: "request" });
assert.strictEqual(r4Request.valid, true, `expected valid: ${r4Request.error}`);
assert.strictEqual(r4Request.parsed.type, "request");
assert.strictEqual(r4Request.lockers.length, 0);
assert.strictEqual(fieldOf(r4Request, "機種NO").value, "20H×3（機種指定なし）");
assert.strictEqual(fieldOf(r4Request, "要求データ").value, "ロッカー情報要求の固定データ");
assert.ok(r4Request.summary.includes("ロッカー情報要求"), r4Request.summary);

// ---------------------------------------------------- 4線式 BCC異常/長さ
const badBcc = response.slice();
badBcc[badBcc.length - 1] ^= 0xFF;
const r4Bad = Inspector.inspect("locker4", badBcc, {});
assert.strictEqual(r4Bad.valid, false);
assert.match(r4Bad.error, /BCC/);
// BCCが違ってもロッカー内容は読み取れる。
assert.strictEqual(r4Bad.lockers.length, 2);
assert.strictEqual(r4Bad.lockers[0].roomNo, 101);
assert.strictEqual(fieldOf(r4Bad, "BCC").status, Inspector.STATUS.ERROR);

const tooShort = Inspector.inspect("locker4", [0x02, 0x37, 0x38, 0x03], {});
assert.strictEqual(tooShort.valid, false);
assert.match(tooShort.error, /23バイト未満/);
assert.strictEqual(tooShort.fields.length, 1);

// データ長だけを壊すと、実測値との差が示される。
const badLength = response.slice();
badLength[3] = 0x39;
badLength[4] = 0x39;
badLength[5] = 0x39;
const r4Length = Inspector.inspect("locker4", badLength, {});
assert.match(r4Length.error, /データ長999と実データ長/);
assert.match(fieldOf(r4Length, "データ長").note, /実測は25バイト/);

// 未定義状態のロッカーは、その1件だけがエラーになる。
const unknownState = response.slice();
unknownState[11] = 0x39;
const r4State = Inspector.inspect("locker4", unknownState, {});
assert.match(r4State.error, /1件目/);
assert.strictEqual(r4State.lockers[0].status, Inspector.STATUS.ERROR);
assert.strictEqual(r4State.lockers[1].status, Inspector.STATUS.OK);

// --------------------------------------------------------------- 2線式
const locker2 = Telegram2.buildTelegram({ command: Telegram2.CMD.ARRIVE, buildingNo: 1, roomNo: 101, address: 3 });
const r2 = Inspector.inspect("locker2", locker2, { maxBuilding: 8 });
assert.strictEqual(r2.valid, true, `expected valid: ${r2.error}`);
assert.strictEqual(r2.parsed.command, Telegram2.CMD.ARRIVE);
assert.strictEqual(r2.parsed.buildingNo, 1);
assert.strictEqual(r2.parsed.roomNo, 101);
assert.strictEqual(r2.parsed.address, 3);
assert.strictEqual(r2.expectedResponse, null, "2線式は単方向で応答しない");
assert.strictEqual(fieldOf(r2, "コマンド").value, "11H 着荷(お届け)");
assert.strictEqual(fieldOf(r2, "住戸番号").value, "101号室");
assert.strictEqual(fieldOf(r2, "住戸アドレス").value, "3（ロッカー番号3）");
assert.ok(r2.badges.some((item) => item.label.includes("BCCなし")), "単方向であることを示す");

// 棟番号なし(3FH)は棟No 0として読む。
const noBuilding = Telegram2.buildTelegram({ command: Telegram2.CMD.STAY, buildingNo: 0, roomNo: 9999, address: 800 });
const r2NoBuilding = Inspector.inspect("locker2", noBuilding, {});
assert.strictEqual(r2NoBuilding.valid, true, r2NoBuilding.error);
assert.strictEqual(r2NoBuilding.parsed.buildingNo, 0);
assert.strictEqual(fieldOf(r2NoBuilding, "棟No").value, "3FH（棟番号なし＝棟No 0）");

// 対象システムの上限超過は警告で示し、電文自体は正常扱い。
const patmoOver = Inspector.inspect("locker2", locker2, { maxBuilding: 0 });
assert.strictEqual(patmoOver.valid, true);
assert.match(patmoOver.warnings[0], /上限0/);

// 未登録ロッカー（旧版互換の3FH埋め）
const vacant = Telegram2.buildVacantTelegram(7);
const r2Vacant = Inspector.inspect("locker2", vacant, {});
assert.strictEqual(r2Vacant.valid, true, r2Vacant.error);
assert.strictEqual(r2Vacant.parsed.vacant, true);
assert.strictEqual(r2Vacant.parsed.address, 7);
assert.ok(r2Vacant.summary.includes("未登録ロッカー"), r2Vacant.summary);

// 未定義コマンドでも住戸番号とアドレスは読める。
const badCommand = locker2.slice();
badCommand[1] = 0x20;
const r2BadCommand = Inspector.inspect("locker2", badCommand, {});
assert.strictEqual(r2BadCommand.valid, false);
assert.match(r2BadCommand.error, /コマンド20H/);
assert.strictEqual(r2BadCommand.parsed.roomNo, 101);
assert.strictEqual(r2BadCommand.parsed.address, 3);

const r2Length = Inspector.inspect("locker2", locker2.slice(0, 10), {});
assert.strictEqual(r2Length.valid, false);
assert.match(r2Length.error, /11バイトではありません/);

// ------------------------------------------------------------ 非接触キー
const key13 = Key.buildTelegram({ format: Key.FORMAT.WITH_PERSON, gateNo: 2, buildingNo: 1, roomNo: 101, personNo: 3 });
const rKey = Inspector.inspect("key", key13, { buildingMax: 9, personMax: 999, systemLabel: "その他のシステム" });
assert.strictEqual(rKey.valid, true, `expected valid: ${rKey.error}`);
assert.strictEqual(rKey.parsed.format, Key.FORMAT.WITH_PERSON);
assert.strictEqual(rKey.parsed.gateNo, 2);
assert.strictEqual(rKey.parsed.buildingNo, 1);
assert.strictEqual(rKey.parsed.roomNo, 101);
assert.strictEqual(rKey.parsed.personNo, 3);
assert.strictEqual(rKey.parsed.roomNo5, "10101");
assert.strictEqual(rKey.expectedResponse, "ACK");
assert.strictEqual(fieldOf(rKey, "ゲートNo").value, "02番ゲート");
assert.strictEqual(fieldOf(rKey, "棟番号").value, "1棟");
assert.strictEqual(fieldOf(rKey, "部屋番号").value, "0101（101号室）");
assert.strictEqual(fieldOf(rKey, "個人番号").value, "003（3番）");

// 10バイト形式には個人番号フィールドを作らない。
const key10 = Key.buildTelegram({ format: Key.FORMAT.ROOM_ONLY, gateNo: 1, roomNo5: "00101" });
const rKey10 = Inspector.inspect("key", key10, {});
assert.strictEqual(rKey10.valid, true, rKey10.error);
assert.strictEqual(rKey10.parsed.personNo, null);
assert.strictEqual(fieldOf(rKey10, "個人番号"), undefined);
assert.strictEqual(fieldOf(rKey10, "棟番号").value, "0（棟番号なし＝標準）");
assert.ok(rKey10.summary.includes("個人番号なし"), rKey10.summary);

// BCC異常でも各桁は読め、仕様上の応答はNAKになる。
const rKeyBad = Inspector.inspect("key", Key.corruptBCC(key13), {});
assert.strictEqual(rKeyBad.valid, false);
assert.match(rKeyBad.error, /BCC/);
assert.strictEqual(rKeyBad.expectedResponse, "NAK");
assert.strictEqual(rKeyBad.parsed.roomNo, 101);

// システム別制約の超過は警告として示す。
const rKeyLimited = Inspector.inspect("key", key13, { buildingMax: 0, personMax: 8, systemLabel: "PATMOα" });
assert.strictEqual(rKeyLimited.valid, true);
assert.strictEqual(rKeyLimited.warnings.length, 1);
assert.match(rKeyLimited.warnings[0], /PATMOα/);

// 仕様外の長さでも読める範囲は読む。
const rKeyLength = Inspector.inspect("key", key13.slice(0, 12), {});
assert.strictEqual(rKeyLength.valid, false);
assert.match(rKeyLength.error, /10／13バイトではありません/);
assert.strictEqual(rKeyLength.parsed.gateNo, 2);

const rKeyTiny = Inspector.inspect("key", [0x02, 0x30], {});
assert.strictEqual(rKeyTiny.valid, false);
assert.strictEqual(rKeyTiny.fields.length, 1);

// --------------------------------------------------- フレーム不成立の記録
const frameError = Inspector.errorResult("key", [0x02, 0x41, 0x42], "フレーム長またはヘッダが仕様に合いません");
assert.strictEqual(frameError.valid, false);
assert.strictEqual(frameError.profile, "key");
assert.match(frameError.title, /非接触キー/);
assert.match(frameError.summary, /3バイト/);
assert.ok(frameError.badges.some((item) => item.label === "フレーム不成立"));

// ------------------------------------------------- 警報（パナソニック）
const Panasonic = require("../protocol/panasonic-alarm.js");

// HPC：STX形式は9項目へ分解し、住戸番号はヒストリー種別まで読む。
const rHpc = Inspector.inspect("panasonic",
  Panasonic.buildFrame({ protocol: "hpc", type: 0x00, infoBits: [0, 1], buildingNo: 1, roomNo: 101 }),
  { protocol: "hpc" });
assert.strictEqual(rHpc.valid, true);
assert.match(rHpc.title, /HPC/);
assert.match(rHpc.summary, /警報情報１ \/ 1棟 0101号室 \/ 火災＋非常/);
assert.strictEqual(rHpc.expectedResponse, "ACK");
assert.strictEqual(fieldOf(rHpc, "データ長").value, "37H（データ部7バイト）");
assert.match(fieldOf(rHpc, "住戸番号").value, /0101号室（イベント通知／要求）/);
assert.strictEqual(rHpc.parsed.buildingNo, 1);

const rHpcHistory = Inspector.inspect("panasonic",
  Panasonic.buildFrame({ protocol: "hpc", type: 0x01, infoBits: [7], buildingNo: 2, roomNo: 1201, historyNumber: 3 }),
  { protocol: "hpc" });
assert.match(fieldOf(rHpcHistory, "住戸番号").value, /ヒストリー3の応答/);

// 同じ電文でもTSSの割付で読むと意味が変わり、ヒストリー種別は仕様違反になる。
const rTssMisread = Inspector.inspect("panasonic",
  Panasonic.buildFrame({ protocol: "hpc", type: 0x01, infoBits: [7], buildingNo: 2, roomNo: 1201, historyNumber: 3 }),
  { protocol: "tss" });
assert.strictEqual(rTssMisread.valid, false);
assert.ok(rTssMisread.problems.some((problem) => /ヒストリー応答はありません/.test(problem)));

// BCC異常でも読み取れた桁は必ず残す。
const panaBadBcc = Panasonic.buildFrame({ protocol: "hpc", type: 0x00, infoBits: [0], buildingNo: 1, roomNo: 101 });
panaBadBcc[panaBadBcc.length - 1] = (panaBadBcc[panaBadBcc.length - 1] + 1) & 0xFF;
const rBadBcc = Inspector.inspect("panasonic", panaBadBcc, { protocol: "hpc" });
assert.strictEqual(rBadBcc.valid, false);
assert.strictEqual(rBadBcc.expectedResponse, "NAK");
assert.strictEqual(fieldOf(rBadBcc, "棟番号").value, "1棟");

// 予備bitはHEX直接入力で立てられるため、仕様違反ではなく注意にする。
const rReserved = Inspector.inspect("panasonic",
  Panasonic.buildFrame({ protocol: "hpc", type: 0x02, info: 0x10, buildingNo: 1, roomNo: 101 }),
  { protocol: "hpc" });
assert.strictEqual(rReserved.valid, true);
assert.ok(rReserved.warnings.some((warning) => /予備です/.test(warning)));

// 大興：レコードは1行ずつ意味付きで並べる。
const rDaiko = Inspector.inspect("panasonic", Panasonic.buildFrame({
  protocol: "daiko",
  records: [{ mode: "N", buildingNo: 1, roomNo: 101, alarmNo: 1 }, { mode: "F", buildingNo: 1, roomNo: 101, alarmNo: 31 }],
}), { protocol: "daiko" });
assert.strictEqual(rDaiko.valid, true);
assert.match(rDaiko.summary, /警報データ 2件/);
assert.match(fieldOf(rDaiko, "レコード1").value, /N（異常発生）.*01棟 0101号室.*警報No\.01 火災/);
assert.match(fieldOf(rDaiko, "レコード2").value, /F（リセット）.*警報No\.31 防犯１ｾｯﾄ\/ﾘｾｯﾄ/);
assert.strictEqual(fieldOf(rDaiko, "CR").value, "送信データ終了 0DH");

// アンサーバックと定時送信も同じ枠組みで読む。
const rAck = Inspector.inspect("panasonic", Panasonic.buildAnswerback({ protocol: "daiko" }), { protocol: "daiko" });
assert.match(rAck.summary, /ACKアンサーバック/);
assert.strictEqual(rAck.expectedResponse, null);
const rNak = Inspector.inspect("panasonic", Panasonic.buildAnswerback({ protocol: "daiko", accepted: false }), { protocol: "daiko" });
assert.match(rNak.summary, /NAKアンサーバック/);
const rScheduled = Inspector.inspect("panasonic",
  Panasonic.buildScheduledFrame({ protocol: "remote", propertyCode: "12345" }), { protocol: "remote" });
assert.strictEqual(rScheduled.parsed.propertyCode, "12345");
assert.match(fieldOf(rScheduled, "定時送信データ").value, /物件コード「12345」/);

// チェックサム異常は仕様違反として残す。
const badSum = Panasonic.buildFrame({ protocol: "daiko", records: [{ mode: "N", buildingNo: 1, roomNo: 101, alarmNo: 1 }] });
badSum[badSum.length - 2] = "0".charCodeAt(0);
const rBadSum = Inspector.inspect("panasonic", badSum, { protocol: "daiko" });
assert.strictEqual(rBadSum.valid, false);
assert.ok(rBadSum.problems.some((problem) => /チェックサムが一致しません/.test(problem)));

// --------------------------------------- エレベータ連動（パナソニック）
const PanasonicElevator = require("../protocol/panasonic-elevator.js");

const rPev = Inspector.inspect("panasonicElevator",
  PanasonicElevator.buildFrame({ command: "IE", buildingNo: 1, roomNo: 101 }), { direction: "toElevator" });
assert.strictEqual(rPev.valid, true);
assert.match(rPev.title, /エレベータ連動（パナソニック）/);
assert.match(rPev.summary, /住戸でのエレベータコール \/ 1棟 0101号室/);
assert.strictEqual(fieldOf(rPev, "CMD").value, "IE 住戸でのエレベータコール");
assert.strictEqual(fieldOf(rPev, "予備").value, "20H（スペース）");
assert.strictEqual(fieldOf(rPev, "モード").value, "N");
assert.strictEqual(fieldOf(rPev, "住戸番号").value, "0101（101号室）");
assert.match(fieldOf(rPev, "BCC").value, /一致$/);
assert.strictEqual(rPev.expectedResponse, "ACK");

// 付加コードで住戸を特定できるかが変わる。
const rPevAdmin = Inspector.inspect("panasonicElevator",
  PanasonicElevator.buildFrame({ command: "IK", lbNo: 3, extraCode: "01" }), { direction: "toElevator" });
assert.strictEqual(rPevAdmin.valid, true);
assert.strictEqual(fieldOf(rPevAdmin, "付加コード").value, "01 管理室による共同玄関解錠");
assert.strictEqual(fieldOf(rPevAdmin, "LB番号").value, "03番");
assert.strictEqual(fieldOf(rPevAdmin, "住戸番号").value, "0000（指定なし）");

// 固定値の桁に値が入っていれば仕様違反として示し、桁自体は読める。
const pevViolation = PanasonicElevator.buildFrame({ command: "IK", lbNo: 3, extraCode: "01" });
pevViolation[10] = "1".charCodeAt(0);
pevViolation.splice(16, 2, ...PanasonicElevator.calculateBCC(pevViolation.slice(0, 16)));
const rPevViolation = Inspector.inspect("panasonicElevator", pevViolation, {});
assert.strictEqual(rPevViolation.valid, false);
assert.ok(rPevViolation.problems.some((problem) => /住戸番号は0000固定です/.test(problem)));
assert.strictEqual(fieldOf(rPevViolation, "LB番号").value, "03番");
// NAKを持たない機種なので、異常時の応答は無応答になる。
assert.match(rPevViolation.expectedResponse, /無応答/);

// 方向の食い違いは注意として示し、電文自体は正常扱い。
const rPevDirection = Inspector.inspect("panasonicElevator",
  PanasonicElevator.buildFrame({ command: "SH", extraCode: "01" }), { direction: "toElevator" });
assert.strictEqual(rPevDirection.valid, true);
assert.strictEqual(fieldOf(rPevDirection, "付加コード").value, "01 点検中");
assert.ok(rPevDirection.warnings.some((warning) => /エレベータ→IFUの電文です/.test(warning)));

// BCC異常でも各桁は読み取れる。
const pevBadBcc = PanasonicElevator.buildFrame({ command: "IE", buildingNo: 1, roomNo: 101 });
pevBadBcc[pevBadBcc.length - 1] ^= 0x01;
const rPevBadBcc = Inspector.inspect("panasonicElevator", pevBadBcc, {});
assert.strictEqual(rPevBadBcc.valid, false);
assert.strictEqual(fieldOf(rPevBadBcc, "住戸番号").value, "0101（101号室）");
assert.strictEqual(fieldOf(rPevBadBcc, "BCC").status, Inspector.STATUS.ERROR);

// ------------------------------------------------------------- 入力検査
assert.throws(() => Inspector.inspect("key", [0x02, 300]), /0～255/);
assert.throws(() => Inspector.inspect("key", 5), /バイト配列/);
assert.strictEqual(Inspector.inspect("key", null).byteLength, 0);

console.log("receive-inspector: OK");
