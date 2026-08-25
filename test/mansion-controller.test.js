"use strict";

const assert = require("node:assert/strict");
const M = require("../protocol/mansion-controller.js");

let passed = 0;
let failed = 0;

function test(name, callback) {
  try {
    callback();
    console.log("  OK   " + name);
    passed += 1;
  } catch (error) {
    console.error("  NG   " + name);
    console.error(error.stack || error);
    failed += 1;
  }
}

function expectProtocolError(callback, code) {
  assert.throws(callback, (error) => {
    assert.equal(error.name, "MansionProtocolError");
    assert.equal(error.code, code);
    return true;
  });
}

const standardV3 = { version: M.VERSION.V3, topology: M.TOPOLOGY.STANDARD, building: "BB" };
const standardV2 = { version: M.VERSION.V2, topology: M.TOPOLOGY.STANDARD, building: "BB" };

console.log("=== Q48-008I frame codec ===");

test("制御コードにEOTを定義しない", () => {
  assert.deepEqual(M.CODE, { NULL: 0x00, STX: 0x02, ETX: 0x03, ENQ: 0x05, ACK: 0x06, NAK: 0x15 });
  assert.equal(Object.hasOwn(M.CODE, "EOT"), false);
});

test("Ver3・宅配通知なし初期化要求が仕様ベクトルと一致", () => {
  assert.deepEqual(
    M.buildInitializationRequest({ version: 3, deliveryNotification: false }),
    [0x02, 0x30, 0x36, 0x30, 0x41, 0x34, 0x03, 0x40],
  );
});

test("初期化要求ROKはバージョンと宅配通知有無を厳密に表す", () => {
  assert.equal(M.parseFrame(M.buildInitializationRequest({ version: 1, deliveryNotification: false }), { version: 1 }).message[0], 0x30);
  assert.equal(M.parseFrame(M.buildInitializationRequest({ version: 1, deliveryNotification: true }), { version: 1 }).message[0], 0x31);
  assert.equal(M.parseFrame(M.buildInitializationRequest({ version: 2, deliveryNotification: false }), { version: 2 }).message[0], 0x32);
  assert.equal(M.parseFrame(M.buildInitializationRequest({ version: 2, deliveryNotification: true }), { version: 2 }).message[0], 0x33);
  assert.equal(M.parseFrame(M.buildInitializationRequest({ version: 3, deliveryNotification: true }), { version: 3 }).message[0], 0x35);
});

test("初期化完了・通信接続開始・health応答builderのKIND/CMDと方向", () => {
  const initialized = M.parseFrame(M.buildInitializationComplete({ version: 3 }), { version: 3, from: M.ROLE.MC });
  const connected = M.parseFrame(M.buildConnectionStart({ version: 3 }), { version: 3, from: M.ROLE.IC });
  const health = M.parseFrame(M.buildHealthCheckResponse({ version: 3, from: M.ROLE.MC }), { version: 3, from: M.ROLE.MC });
  assert.deepEqual([initialized.kind, initialized.command], [0x30, 0x42]);
  assert.deepEqual([connected.kind, connected.command], [0x30, 0x43]);
  assert.deepEqual([health.kind, health.command], [0x3A, 0x61]);
});

test("最小LEN=05のhealth要求をbuild/parseできる", () => {
  const frame = M.buildHealthCheckRequest({ version: 3, from: M.ROLE.IC });
  assert.deepEqual(frame, [0x02, 0x30, 0x35, 0x3A, 0x41, 0x03, 0x7D]);
  const parsed = M.validateFrame(Buffer.from(frame), { version: 3, from: M.ROLE.IC });
  assert.equal(parsed.length, 5);
  assert.equal(parsed.kind, M.KIND.HEALTH_CHECK);
  assert.equal(parsed.command, 0x41);
  assert.deepEqual(parsed.message, []);
  assert.equal(parsed.commandDefinition.name, "ヘルスチェック要求");
});

test("LENはLEN先頭からETXまでを数える", () => {
  const frame = M.buildFrame({ kind: 0x37, command: 0x41, message: "01BBB101", version: 3 });
  assert.deepEqual(frame.slice(1, 3), [0x31, 0x33]);
  assert.equal(M.parseFrame(frame, { version: 3 }).length, 13);
});

test("BCCはSTXを除くLEN～ETXのXOR", () => {
  const frame = M.buildFrame({ kind: 0x37, command: 0x41, message: "01BBB101", version: 3 });
  assert.equal(frame.at(-1), M.calculateBcc(frame.slice(0, -1)));
  assert.equal(M.verifyBcc(frame), true);
  const corrupt = frame.slice();
  corrupt[corrupt.length - 1] ^= 0x01;
  assert.equal(M.verifyBCC(corrupt), false);
  expectProtocolError(() => M.validateFrame(corrupt, { version: 3 }), "BCC_MISMATCH");
});

test("MESG最大94バイト（LEN=99）を許可し、95バイトは拒否", () => {
  const maximum = M.buildFrame({ kind: 0x3A, command: 0x41, message: "A".repeat(94), version: 3 });
  assert.deepEqual(maximum.slice(1, 3), [0x39, 0x39]);
  assert.equal(maximum.length, 101);
  expectProtocolError(
    () => M.buildFrame({ kind: 0x3A, command: 0x41, message: "A".repeat(95), version: 3 }),
    "MESSAGE_TOO_LONG",
  );
});

test("印字可能ASCII以外のMESGは補正せず拒否", () => {
  expectProtocolError(() => M.buildFrame({ kind: 0x3A, command: 0x41, message: [0x1F], version: 3 }), "INVALID_ASCII");
  expectProtocolError(() => M.buildFrame({ kind: 0x3A, command: 0x41, message: "あ", version: 3 }), "INVALID_BYTE");
});

test("LENの非数字・範囲外・実長不一致を区別して拒否", () => {
  const frame = M.buildHealthCheckRequest({ version: 3 });
  const nonDigit = frame.slice();
  nonDigit[1] = 0x41;
  expectProtocolError(() => M.validateFrame(nonDigit, { version: 3 }), "INVALID_LEN_ENCODING");

  const belowMinimum = frame.slice();
  belowMinimum[1] = 0x30;
  belowMinimum[2] = 0x34;
  expectProtocolError(() => M.validateFrame(belowMinimum, { version: 3 }), "INVALID_LEN_RANGE");

  const mismatch = frame.slice();
  mismatch[2] = 0x36;
  expectProtocolError(() => M.validateFrame(mismatch, { version: 3 }), "FRAME_LENGTH_MISMATCH");
});

test("LEN位置のETX欠落を拒否", () => {
  const frame = M.buildHealthCheckRequest({ version: 3 });
  frame[5] = 0x20;
  expectProtocolError(() => M.validateFrame(frame, { version: 3 }), "INVALID_ETX");
});

test("未定義KIND/CMDは既定で拒否し、明示時のみraw frameを扱える", () => {
  expectProtocolError(() => M.buildFrame({ kind: 0x30, command: 0x44 }), "UNKNOWN_COMMAND");
  const raw = M.buildFrame({ kind: 0x30, command: 0x44, validateCommand: false });
  expectProtocolError(() => M.parseFrame(raw), "UNKNOWN_COMMAND");
  assert.equal(M.parseFrame(raw, { validateCommand: false }).command, 0x44);
  expectProtocolError(() => M.buildFrame({ kind: 0x00, command: 0x44, validateCommand: false }), "INVALID_ASCII");
});

console.log("\n=== 全KIND/CMD registry ===");

test("全110 KIND/CMDを重複なく登録", () => {
  assert.equal(M.COMMAND_REGISTRY.length, 110);
  assert.equal(new Set(M.COMMAND_REGISTRY.map((entry) => entry.key)).size, 110);
  assert.deepEqual(
    [...new Set(M.COMMAND_REGISTRY.map((entry) => entry.kind))],
    Object.values(M.KIND),
  );
});

test("全KIND/CMDを対応Version・方向でbuild/parseし、非対応Versionを拒否", () => {
  for (const definition of M.COMMAND_REGISTRY) {
    const from = definition.direction === M.DIRECTION.MC_TO_IC ? M.ROLE.MC : M.ROLE.IC;
    for (const version of definition.versions) {
      const frame = M.buildFrame({ kind: definition.kind, command: definition.command, version, from });
      const parsed = M.parseFrame(frame, { version, from });
      assert.equal(parsed.commandDefinition, definition);
    }
    for (const version of [1, 2, 3].filter((value) => !definition.versions.includes(value))) {
      expectProtocolError(
        () => M.getCommandDefinition(definition.kind, definition.command, { version }),
        "UNSUPPORTED_VERSION",
      );
    }
  }
});

test("要求・応答・完了とbulk関係を保持", () => {
  const request = M.getCommandDefinition(0x34, 0x44, { version: 3 });
  const response = M.getCommandDefinition(0x34, 0x64, { version: 3 });
  const completion = M.getCommandDefinition(0x34, 0x65, { version: 3 });
  assert.equal(request.type, M.COMMAND_TYPE.REQUEST);
  assert.equal(response.type, M.COMMAND_TYPE.RESPONSE);
  assert.equal(response.responseTo, 0x44);
  assert.equal(response.bulk, true);
  assert.equal(completion.type, M.COMMAND_TYPE.COMPLETION);
  assert.equal(completion.responseTo, 0x44);
});

test("宅配接続先で方向が変わるコマンドを明示", () => {
  const resend = M.getCommandDefinition(0x36, 0x42, { version: 3 });
  assert.equal(resend.direction, M.DIRECTION.BIDIRECTIONAL);
  assert.equal(resend.directionDependsOn, "deliveryBoxAttachment");
});

test("Ver2専用とVer3専用コマンドを相互に拒否", () => {
  assert.equal(M.getCommandDefinition(0x39, 0x4A, { version: 2 }).versions.length, 1);
  expectProtocolError(() => M.getCommandDefinition(0x39, 0x4A, { version: 3 }), "UNSUPPORTED_VERSION");
  assert.equal(M.getCommandDefinition(0x39, 0x4C, { version: 3 }).versions.length, 1);
  expectProtocolError(() => M.getCommandDefinition(0x39, 0x4C, { version: 2 }), "UNSUPPORTED_VERSION");
  expectProtocolError(() => M.getCommandDefinition(0x3B, 0x41, { version: 1 }), "UNSUPPORTED_VERSION");
});

test("VIXUS Advanceは仕様で認められた静止画4コマンドだけを許可", () => {
  const allowed = M.listCommandDefinitions({ version: 3, product: M.PRODUCT.VIXUS_ADVANCE })
    .filter((definition) => definition.kind === M.KIND.STILL_IMAGE)
    .map((definition) => definition.command);
  assert.deepEqual(allowed, [0x45, 0x65, 0x54, 0x74]);
  assert.equal(
    M.getCommandDefinition(0x39, 0x45, { version: 3, product: M.PRODUCT.VIXUS_ADVANCE }).name,
    "全静止画消去要求",
  );
  expectProtocolError(
    () => M.buildFrame({ kind: 0x39, command: 0x41, version: 3, from: M.ROLE.MC, product: M.PRODUCT.VIXUS_ADVANCE }),
    "UNSUPPORTED_PRODUCT",
  );
  const generic = M.buildFrame({ kind: 0x39, command: 0x41, version: 3, from: M.ROLE.MC });
  expectProtocolError(
    () => M.parseFrame(generic, { version: 3, from: M.ROLE.MC, product: M.PRODUCT.VIXUS_ADVANCE }),
    "UNSUPPORTED_PRODUCT",
  );
});

test("versionの文字列化やnullを黙って受け入れない", () => {
  expectProtocolError(() => M.getCommandDefinition(0x30, 0x41, { version: "3" }), "INVALID_VERSION");
  expectProtocolError(() => M.getCommandDefinition(0x30, 0x41, { version: null }), "INVALID_VERSION");
});

test("コマンド送信方向を検証", () => {
  assert.equal(M.getCommandDefinition(0x31, 0x41, { from: M.ROLE.IC }).direction, M.DIRECTION.IC_TO_MC);
  expectProtocolError(() => M.getCommandDefinition(0x31, 0x41, { from: M.ROLE.MC }), "INVALID_DIRECTION");
  assert.equal(M.getCommandDefinition(0x3A, 0x41, { from: M.ROLE.MC }).direction, M.DIRECTION.BIDIRECTIONAL);
});

console.log("\n=== ADDR builder / validator ===");

test("標準システムの住戸・全住戸ADDR", () => {
  assert.equal(M.buildResidenceAddress({ ...standardV3, room: 1 }), "BBB001");
  assert.equal(M.address.residence({ ...standardV3, room: 101 }), "BBB101");
  assert.equal(M.buildResidenceAddress({ ...standardV3, room: 1001 }), "BB1001");
  assert.equal(M.buildResidenceAddress({ ...standardV3, all: true }), "BB0000");
  assert.equal(M.validateAddress("BBB101", standardV3).number, 101);
  assert.equal(M.validateAddress("BB0000", standardV3).all, true);
});

test("住戸0001～0999の4桁表現と1000を拒否", () => {
  expectProtocolError(() => M.validateAddress("BB0101", standardV3), "ADDRESS_FORMAT");
  expectProtocolError(() => M.buildResidenceAddress({ ...standardV3, room: 1000 }), "RESIDENCE_OUT_OF_RANGE");
});

test("多棟のB1～B9・10～99・FFを構築", () => {
  const multi = { version: 3, topology: M.TOPOLOGY.MULTI_BUILDING };
  assert.equal(M.buildResidenceAddress({ ...multi, building: 5, room: 1001 }), "B51001");
  assert.equal(M.buildResidenceAddress({ ...multi, building: 10, room: 101 }), "10B101");
  assert.equal(M.buildResidenceAddress({ ...multi, building: "FF", all: true }), "FF0000");
});

test("Ver1/2は棟60まで、Ver3は棟99まで", () => {
  const multiV2 = { version: 2, topology: M.TOPOLOGY.MULTI_BUILDING };
  const multiV3 = { version: 3, topology: M.TOPOLOGY.MULTI_BUILDING };
  assert.equal(M.buildResidenceAddress({ ...multiV2, building: 60, room: 1 }), "60B001");
  expectProtocolError(() => M.buildResidenceAddress({ ...multiV2, building: 61, room: 1 }), "BUILDING_OUT_OF_RANGE");
  assert.equal(M.buildResidenceAddress({ ...multiV3, building: 99, room: 1 }), "99B001");
});

test("標準と多棟の棟コード混在を拒否", () => {
  expectProtocolError(
    () => M.buildResidenceAddress({ version: 3, topology: M.TOPOLOGY.STANDARD, building: 1, room: 1 }),
    "ADDRESS_TOPOLOGY_MISMATCH",
  );
  expectProtocolError(
    () => M.buildResidenceAddress({ version: 3, topology: M.TOPOLOGY.MULTI_BUILDING, building: "BB", room: 1 }),
    "ADDRESS_TOPOLOGY_MISMATCH",
  );
});

test("管親・管理センターADDRとVIXUS Advance拡張", () => {
  assert.equal(M.buildManagementStationAddress({ ...standardV3, station: 2 }), "BBC002");
  assert.equal(M.buildManagementStationAddress({ ...standardV3, station: 9 }), "BBC009");
  expectProtocolError(() => M.buildManagementStationAddress({ ...standardV3, station: 50 }), "MANAGEMENT_STATION_OUT_OF_RANGE");
  assert.equal(M.buildManagementStationAddress({ ...standardV3, station: 50, vixusAdvance: true }), "BBC050");
  assert.equal(M.buildManagementStationAddress({ ...standardV3, station: 16, vixusAdvance: true }), "BBC016");
  expectProtocolError(() => M.buildManagementStationAddress({ ...standardV3, station: 0, vixusAdvance: true }), "MANAGEMENT_STATION_OUT_OF_RANGE");
});

test("集玄番号のVer1/2とVer3範囲差", () => {
  assert.equal(M.buildEntranceStationAddress({ ...standardV2, station: 8 }), "BBD008");
  expectProtocolError(() => M.buildEntranceStationAddress({ ...standardV2, station: 9 }), "ENTRANCE_STATION_OUT_OF_RANGE");
  assert.equal(M.buildEntranceStationAddress({ ...standardV2, station: 11 }), "BBD011");
  assert.equal(M.buildEntranceStationAddress({ ...standardV2, station: 998 }), "BBD998");
  expectProtocolError(() => M.buildEntranceStationAddress({ ...standardV2, station: 999 }), "ENTRANCE_STATION_OUT_OF_RANGE");
  assert.equal(M.buildEntranceStationAddress({ ...standardV3, station: 99 }), "BBD099");
  expectProtocolError(() => M.buildEntranceStationAddress({ ...standardV3, station: 100 }), "ENTRANCE_STATION_OUT_OF_RANGE");
});

test("Ver3のグループ・階層・共用部ADDR", () => {
  assert.equal(M.buildGroupAddress({ ...standardV3, group: 3 }), "BBE003");
  assert.equal(M.buildFloorAddress({ ...standardV3, floor: 0 }), "BBF000");
  assert.equal(M.buildFloorAddress({ ...standardV3, floor: 99 }), "BBF099");
  assert.equal(M.buildCommonAreaAddress(standardV3), "BBCA00");
  assert.equal(M.validateAddress(Buffer.from("BBCA00", "ascii"), standardV3).type, M.ADDRESS_TYPE.COMMON_AREA);
});

test("FF全棟指定で階層および通常住戸の個別指定を拒否", () => {
  const multi = { version: 3, topology: M.TOPOLOGY.MULTI_BUILDING, building: "FF" };
  expectProtocolError(() => M.buildFloorAddress({ ...multi, floor: 4 }), "ADDRESS_TOPOLOGY_MISMATCH");
  expectProtocolError(() => M.buildResidenceAddress({ ...multi, room: 101 }), "ADDRESS_TOPOLOGY_MISMATCH");
  assert.equal(M.buildResidenceAddress({ ...multi, room: 101, vixusAdvance: true }), "FFB101");
});

test("Ver1/2でグループ・階層・共用部を拒否", () => {
  expectProtocolError(() => M.buildGroupAddress({ ...standardV2, group: 1 }), "ADDRESS_VERSION_MISMATCH");
  expectProtocolError(() => M.buildFloorAddress({ ...standardV2, floor: 1 }), "ADDRESS_VERSION_MISMATCH");
  expectProtocolError(() => M.buildCommonAreaAddress(standardV2), "ADDRESS_VERSION_MISMATCH");
});

test("ADDR範囲外や小文字を黙って補正しない", () => {
  expectProtocolError(() => M.buildGroupAddress({ ...standardV3, group: 9 }), "GROUP_OUT_OF_RANGE");
  expectProtocolError(() => M.buildFloorAddress({ ...standardV3, floor: 100 }), "FLOOR_OUT_OF_RANGE");
  expectProtocolError(() => M.validateAddress("bbb101", standardV3), "ADDRESS_FORMAT");
  expectProtocolError(() => M.validateAddress("BBB01", standardV3), "ADDRESS_LENGTH");
  expectProtocolError(() => M.buildResidenceAddress({ ...standardV3, room: "101" }), "INVALID_INTEGER");
  expectProtocolError(() => M.buildResidenceAddress({ ...standardV3, room: 101, all: "false" }), "INVALID_BOOLEAN");
  expectProtocolError(() => M.buildResidenceAddress({ ...standardV3, room: 101, vixusAdvance: 1 }), "INVALID_BOOLEAN");
});

console.log("\n========================================");
console.log(`  結果: ${passed} 件成功 / ${failed} 件失敗`);
console.log("========================================");
if (failed) process.exitCode = 1;
