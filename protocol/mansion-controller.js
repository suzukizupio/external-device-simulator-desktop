// Q48-008I マンションコントローラ通信仕様 Ver.3.12 共通 codec / 定義
// Browser: window.MansionController / Node: require("./mansion-controller.js")
(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.MansionController = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";

  const CODE = Object.freeze({
    NULL: 0x00,
    STX: 0x02,
    ETX: 0x03,
    ENQ: 0x05,
    ACK: 0x06,
    NAK: 0x15,
  });

  const VERSION = Object.freeze({ V1: 1, V2: 2, V3: 3 });
  const TOPOLOGY = Object.freeze({
    STANDARD: "standard",
    MULTI_BUILDING: "multi-building",
    SINGLE_BUILDING_MULTI_CONTROLLER: "single-building-multi-controller",
  });
  const ADDRESS_TYPE = Object.freeze({
    RESIDENCE: "residence",
    MANAGEMENT_STATION: "management-station",
    ENTRANCE_STATION: "entrance-station",
    GROUP: "group",
    FLOOR: "floor",
    COMMON_AREA: "common-area",
  });
  const DIRECTION = Object.freeze({
    IC_TO_MC: "IC_TO_MC",
    MC_TO_IC: "MC_TO_IC",
    BIDIRECTIONAL: "BIDIRECTIONAL",
  });
  const ROLE = Object.freeze({ IC: "IC", MC: "MC" });
  const COMMAND_TYPE = Object.freeze({
    REQUEST: "request",
    RESPONSE: "response",
    COMPLETION: "completion",
    NOTIFICATION: "notification",
  });
  const KIND = Object.freeze({
    INITIALIZATION: 0x30,
    IC_TO_MC_CALL: 0x31,
    RESIDENCE_ALL_INFORMATION: 0x32,
    MC_TO_IC_CALL: 0x33,
    SECURITY: 0x34,
    ALARM: 0x35,
    DELIVERY_BOX: 0x36,
    NONCONTACT_KEY: 0x37,
    MESSAGE: 0x38,
    STILL_IMAGE: 0x39,
    HEALTH_CHECK: 0x3A,
    RESIDENCE_GROUP: 0x3B,
  });

  const KIND_NAMES = Object.freeze({
    0x30: "初期化",
    0x31: "ICからMCへの呼出・通話・解錠",
    0x32: "住戸全情報取得",
    0x33: "MCからICへの呼出・通話",
    0x34: "防犯確認と警戒設定",
    0x35: "警報出力",
    0x36: "宅配ボックス制御",
    0x37: "非接触キー制御",
    0x38: "メッセージ通知情報",
    0x39: "静止画通知情報",
    0x3A: "ヘルスチェック",
    0x3B: "住戸グループ情報",
  });

  class MansionProtocolError extends Error {
    constructor(code, message, details) {
      super(message);
      this.name = "MansionProtocolError";
      this.code = code;
      if (details !== undefined) this.details = details;
    }
  }

  function fail(code, message, details) {
    throw new MansionProtocolError(code, message, details);
  }

  function byteHex(value) {
    return "0x" + value.toString(16).toUpperCase().padStart(2, "0");
  }

  function assertByte(value, name) {
    if (!Number.isInteger(value) || value < 0 || value > 0xFF) {
      fail("INVALID_BYTE", `${name} は0～255の整数で指定してください`, { name, value });
    }
    return value;
  }

  function toBytes(value, name) {
    const label = name || "bytes";
    let source;
    if (typeof value === "string") {
      source = Array.from(value, (character) => character.charCodeAt(0));
    } else if (Array.isArray(value) || (ArrayBuffer.isView(value) && !(value instanceof DataView))) {
      source = Array.from(value);
    } else {
      fail("INVALID_BYTES", `${label} は文字列、配列、またはTypedArrayで指定してください`, { name: label });
    }
    return source.map((byte, index) => assertByte(byte, `${label}[${index}]`));
  }

  function assertPrintableAscii(bytes, name) {
    for (let index = 0; index < bytes.length; index += 1) {
      const byte = bytes[index];
      if (byte < 0x20 || byte > 0x7E) {
        fail("INVALID_ASCII", `${name}[${index}] は印字可能ASCIIではありません`, {
          name,
          index,
          value: byte,
        });
      }
    }
    return bytes;
  }

  function asciiText(bytes) {
    return String.fromCharCode(...bytes);
  }

  function normalizeVersion(value, required) {
    if (value === undefined) {
      if (required) fail("VERSION_REQUIRED", "version (1, 2, 3) は必須です");
      return null;
    }
    if (value !== VERSION.V1 && value !== VERSION.V2 && value !== VERSION.V3) {
      fail("INVALID_VERSION", "version は1、2、3のいずれかで指定してください", { value });
    }
    return value;
  }

  function normalizeTopology(value) {
    if (!Object.values(TOPOLOGY).includes(value)) {
      fail("INVALID_TOPOLOGY", "topology が未指定、または未対応です", { value });
    }
    return value;
  }

  function normalizeCommandByte(value, name) {
    if (typeof value === "string" && value.length === 1 && value.charCodeAt(0) <= 0x7F) {
      return value.charCodeAt(0);
    }
    return assertByte(value, name);
  }

  const ALL_VERSIONS = Object.freeze([1, 2, 3]);
  const V1_V2 = Object.freeze([1, 2]);
  const V2_ONLY = Object.freeze([2]);
  const V3_ONLY = Object.freeze([3]);

  function spec(kind, command, name, direction, type, versions, extra) {
    return [kind, command, name, direction, type, versions || ALL_VERSIONS, extra || null];
  }

  const RAW_COMMAND_SPECS = [
    spec(0x30, 0x41, "初期化要求", DIRECTION.IC_TO_MC, COMMAND_TYPE.REQUEST),
    spec(0x30, 0x42, "初期化完了", DIRECTION.MC_TO_IC, COMMAND_TYPE.COMPLETION, ALL_VERSIONS, { responseTo: 0x41 }),
    spec(0x30, 0x43, "通信接続開始", DIRECTION.IC_TO_MC, COMMAND_TYPE.NOTIFICATION),

    spec(0x31, 0x41, "MC呼出開始要求", DIRECTION.IC_TO_MC, COMMAND_TYPE.REQUEST),
    spec(0x31, 0x61, "MC呼出開始応答", DIRECTION.MC_TO_IC, COMMAND_TYPE.RESPONSE, ALL_VERSIONS, { responseTo: 0x41 }),
    spec(0x31, 0x42, "MC呼出終了要求", DIRECTION.IC_TO_MC, COMMAND_TYPE.REQUEST),
    spec(0x31, 0x62, "MC呼出終了応答", DIRECTION.MC_TO_IC, COMMAND_TYPE.RESPONSE, ALL_VERSIONS, { responseTo: 0x42 }),
    spec(0x31, 0x43, "MC通話開始要求", DIRECTION.MC_TO_IC, COMMAND_TYPE.REQUEST),
    spec(0x31, 0x63, "MC通話開始応答", DIRECTION.IC_TO_MC, COMMAND_TYPE.RESPONSE, ALL_VERSIONS, { responseTo: 0x43 }),
    spec(0x31, 0x44, "MC通話終了要求", DIRECTION.BIDIRECTIONAL, COMMAND_TYPE.REQUEST),
    spec(0x31, 0x64, "MC通話終了応答", DIRECTION.BIDIRECTIONAL, COMMAND_TYPE.RESPONSE, ALL_VERSIONS, { responseTo: 0x44 }),
    spec(0x31, 0x45, "集玄解錠要求", DIRECTION.MC_TO_IC, COMMAND_TYPE.REQUEST),
    spec(0x31, 0x65, "集玄解錠応答", DIRECTION.IC_TO_MC, COMMAND_TYPE.RESPONSE, ALL_VERSIONS, { responseTo: 0x45 }),
    spec(0x31, 0x46, "MC終話警告要求", DIRECTION.IC_TO_MC, COMMAND_TYPE.REQUEST),
    spec(0x31, 0x66, "MC終話警告応答", DIRECTION.MC_TO_IC, COMMAND_TYPE.RESPONSE, ALL_VERSIONS, { responseTo: 0x46 }),

    spec(0x32, 0x41, "住戸全情報要求", DIRECTION.MC_TO_IC, COMMAND_TYPE.REQUEST),
    spec(0x32, 0x61, "住戸全情報応答", DIRECTION.IC_TO_MC, COMMAND_TYPE.RESPONSE, ALL_VERSIONS, { responseTo: 0x41 }),

    spec(0x33, 0x41, "IC呼出開始要求", DIRECTION.MC_TO_IC, COMMAND_TYPE.REQUEST),
    spec(0x33, 0x61, "IC呼出開始応答", DIRECTION.IC_TO_MC, COMMAND_TYPE.RESPONSE, ALL_VERSIONS, { responseTo: 0x41 }),
    spec(0x33, 0x42, "IC呼出終了要求", DIRECTION.BIDIRECTIONAL, COMMAND_TYPE.REQUEST),
    spec(0x33, 0x62, "IC呼出終了応答", DIRECTION.BIDIRECTIONAL, COMMAND_TYPE.RESPONSE, ALL_VERSIONS, { responseTo: 0x42 }),
    spec(0x33, 0x43, "IC通話開始要求", DIRECTION.IC_TO_MC, COMMAND_TYPE.REQUEST),
    spec(0x33, 0x63, "IC通話開始応答", DIRECTION.MC_TO_IC, COMMAND_TYPE.RESPONSE, ALL_VERSIONS, { responseTo: 0x43 }),
    spec(0x33, 0x44, "IC通話終了要求", DIRECTION.BIDIRECTIONAL, COMMAND_TYPE.REQUEST),
    spec(0x33, 0x64, "IC通話終了応答", DIRECTION.BIDIRECTIONAL, COMMAND_TYPE.RESPONSE, ALL_VERSIONS, { responseTo: 0x44 }),
    spec(0x33, 0x45, "IC終話警告要求", DIRECTION.IC_TO_MC, COMMAND_TYPE.REQUEST),
    spec(0x33, 0x65, "IC終話警告応答", DIRECTION.MC_TO_IC, COMMAND_TYPE.RESPONSE, ALL_VERSIONS, { responseTo: 0x45 }),

    spec(0x34, 0x41, "防犯変化情報", DIRECTION.IC_TO_MC, COMMAND_TYPE.NOTIFICATION),
    spec(0x34, 0x42, "防犯確認要求", DIRECTION.MC_TO_IC, COMMAND_TYPE.REQUEST),
    spec(0x34, 0x62, "防犯確認応答", DIRECTION.IC_TO_MC, COMMAND_TYPE.RESPONSE, ALL_VERSIONS, { responseTo: 0x42 }),
    spec(0x34, 0x43, "防犯変更要求", DIRECTION.MC_TO_IC, COMMAND_TYPE.REQUEST),
    spec(0x34, 0x63, "防犯変更応答", DIRECTION.IC_TO_MC, COMMAND_TYPE.RESPONSE, ALL_VERSIONS, { responseTo: 0x43 }),
    spec(0x34, 0x44, "全防犯情報要求", DIRECTION.MC_TO_IC, COMMAND_TYPE.REQUEST),
    spec(0x34, 0x64, "全防犯情報応答", DIRECTION.IC_TO_MC, COMMAND_TYPE.RESPONSE, ALL_VERSIONS, { responseTo: 0x44, bulk: true }),
    spec(0x34, 0x65, "全防犯情報完了", DIRECTION.IC_TO_MC, COMMAND_TYPE.COMPLETION, ALL_VERSIONS, { responseTo: 0x44, bulk: true }),
    spec(0x34, 0x46, "住戸電気錠確認要求", DIRECTION.MC_TO_IC, COMMAND_TYPE.REQUEST, V3_ONLY),
    spec(0x34, 0x66, "住戸電気錠確認応答", DIRECTION.IC_TO_MC, COMMAND_TYPE.RESPONSE, V3_ONLY, { responseTo: 0x46 }),
    spec(0x34, 0x47, "住戸電気錠施錠要求", DIRECTION.MC_TO_IC, COMMAND_TYPE.REQUEST, V3_ONLY),
    spec(0x34, 0x67, "住戸電気錠施錠応答", DIRECTION.IC_TO_MC, COMMAND_TYPE.RESPONSE, V3_ONLY, { responseTo: 0x47 }),

    spec(0x35, 0x41, "警報変化情報", DIRECTION.IC_TO_MC, COMMAND_TYPE.NOTIFICATION),
    spec(0x35, 0x42, "住戸警報音停止要求", DIRECTION.MC_TO_IC, COMMAND_TYPE.REQUEST),
    spec(0x35, 0x62, "住戸警報音停止応答", DIRECTION.IC_TO_MC, COMMAND_TYPE.RESPONSE, ALL_VERSIONS, { responseTo: 0x42 }),
    spec(0x35, 0x43, "管親警報音停止要求", DIRECTION.MC_TO_IC, COMMAND_TYPE.REQUEST),
    spec(0x35, 0x63, "管親警報音停止応答", DIRECTION.IC_TO_MC, COMMAND_TYPE.RESPONSE, ALL_VERSIONS, { responseTo: 0x43 }),
    spec(0x35, 0x44, "管親警報復旧要求", DIRECTION.MC_TO_IC, COMMAND_TYPE.REQUEST),
    spec(0x35, 0x64, "管親警報復旧応答", DIRECTION.IC_TO_MC, COMMAND_TYPE.RESPONSE, ALL_VERSIONS, { responseTo: 0x44 }),
    spec(0x35, 0x45, "住戸警報確認要求", DIRECTION.MC_TO_IC, COMMAND_TYPE.REQUEST),
    spec(0x35, 0x65, "住戸警報確認応答", DIRECTION.IC_TO_MC, COMMAND_TYPE.RESPONSE, ALL_VERSIONS, { responseTo: 0x45 }),
    spec(0x35, 0x46, "全警報情報要求", DIRECTION.MC_TO_IC, COMMAND_TYPE.REQUEST),
    spec(0x35, 0x66, "全警報情報応答", DIRECTION.IC_TO_MC, COMMAND_TYPE.RESPONSE, ALL_VERSIONS, { responseTo: 0x46, bulk: true }),
    spec(0x35, 0x67, "全警報情報完了", DIRECTION.IC_TO_MC, COMMAND_TYPE.COMPLETION, ALL_VERSIONS, { responseTo: 0x46, bulk: true }),
    spec(0x35, 0x48, "住戸警報復旧要求", DIRECTION.MC_TO_IC, COMMAND_TYPE.REQUEST, V3_ONLY),
    spec(0x35, 0x68, "住戸警報復旧応答", DIRECTION.IC_TO_MC, COMMAND_TYPE.RESPONSE, V3_ONLY, { responseTo: 0x48 }),

    spec(0x36, 0x41, "MCボックス情報", DIRECTION.MC_TO_IC, COMMAND_TYPE.NOTIFICATION, ALL_VERSIONS, { alsoResponseTo: 0x42, bulk: true }),
    spec(0x36, 0x42, "ボックス再送要求", DIRECTION.BIDIRECTIONAL, COMMAND_TYPE.REQUEST, ALL_VERSIONS, { directionDependsOn: "deliveryBoxAttachment" }),
    spec(0x36, 0x62, "ボックス再送完了", DIRECTION.BIDIRECTIONAL, COMMAND_TYPE.COMPLETION, ALL_VERSIONS, { responseTo: 0x42, bulk: true, directionDependsOn: "deliveryBoxAttachment" }),
    spec(0x36, 0x43, "ICボックス情報", DIRECTION.IC_TO_MC, COMMAND_TYPE.NOTIFICATION, ALL_VERSIONS, { alsoResponseTo: 0x42, bulk: true }),

    spec(0x37, 0x41, "MCキー情報-1", DIRECTION.MC_TO_IC, COMMAND_TYPE.NOTIFICATION),
    spec(0x37, 0x42, "MCキー情報-2", DIRECTION.MC_TO_IC, COMMAND_TYPE.NOTIFICATION, V3_ONLY),
    spec(0x37, 0x61, "ICキー情報-1", DIRECTION.IC_TO_MC, COMMAND_TYPE.NOTIFICATION),
    spec(0x37, 0x62, "ICキー情報-2", DIRECTION.IC_TO_MC, COMMAND_TYPE.NOTIFICATION),

    spec(0x38, 0x41, "メッセージ変化情報", DIRECTION.IC_TO_MC, COMMAND_TYPE.NOTIFICATION),
    spec(0x38, 0x42, "メッセージ変更要求", DIRECTION.MC_TO_IC, COMMAND_TYPE.REQUEST),
    spec(0x38, 0x62, "メッセージ変更応答", DIRECTION.IC_TO_MC, COMMAND_TYPE.RESPONSE, ALL_VERSIONS, { responseTo: 0x42 }),
    spec(0x38, 0x43, "メッセージ確認要求", DIRECTION.MC_TO_IC, COMMAND_TYPE.REQUEST),
    spec(0x38, 0x63, "メッセージ確認応答", DIRECTION.IC_TO_MC, COMMAND_TYPE.RESPONSE, ALL_VERSIONS, { responseTo: 0x43 }),
    spec(0x38, 0x44, "全メッセージ再送要求", DIRECTION.MC_TO_IC, COMMAND_TYPE.REQUEST),
    spec(0x38, 0x64, "全メッセージ報告", DIRECTION.IC_TO_MC, COMMAND_TYPE.RESPONSE, ALL_VERSIONS, { responseTo: 0x44, bulk: true }),
    spec(0x38, 0x65, "全メッセージ報告完了", DIRECTION.IC_TO_MC, COMMAND_TYPE.COMPLETION, ALL_VERSIONS, { responseTo: 0x44, bulk: true }),

    spec(0x39, 0x41, "静止画個別通知要求", DIRECTION.MC_TO_IC, COMMAND_TYPE.REQUEST),
    spec(0x39, 0x61, "静止画個別通知応答", DIRECTION.IC_TO_MC, COMMAND_TYPE.RESPONSE, ALL_VERSIONS, { responseTo: 0x41 }),
    spec(0x39, 0x62, "静止画個別通知終了", DIRECTION.IC_TO_MC, COMMAND_TYPE.COMPLETION, ALL_VERSIONS, { responseTo: 0x41 }),
    spec(0x39, 0x43, "静止画一斉通知要求", DIRECTION.MC_TO_IC, COMMAND_TYPE.REQUEST),
    spec(0x39, 0x63, "静止画一斉通知応答", DIRECTION.IC_TO_MC, COMMAND_TYPE.RESPONSE, ALL_VERSIONS, { responseTo: 0x43 }),
    spec(0x39, 0x64, "静止画一斉通知終了", DIRECTION.IC_TO_MC, COMMAND_TYPE.COMPLETION, ALL_VERSIONS, { responseTo: 0x43 }),
    spec(0x39, 0x45, "全静止画消去要求", DIRECTION.MC_TO_IC, COMMAND_TYPE.REQUEST),
    spec(0x39, 0x65, "全静止画消去応答", DIRECTION.IC_TO_MC, COMMAND_TYPE.RESPONSE, ALL_VERSIONS, { responseTo: 0x45 }),
    spec(0x39, 0x66, "全静止画消去異常応答", DIRECTION.IC_TO_MC, COMMAND_TYPE.RESPONSE, V1_V2, { responseTo: 0x45, bulk: true }),
    spec(0x39, 0x67, "全静止画消去終了", DIRECTION.IC_TO_MC, COMMAND_TYPE.COMPLETION, V1_V2, { responseTo: 0x45 }),
    spec(0x39, 0x48, "お知らせ録画取りこぼし情報クリア要求", DIRECTION.MC_TO_IC, COMMAND_TYPE.REQUEST, V2_ONLY),
    spec(0x39, 0x68, "お知らせ録画取りこぼし情報クリア応答", DIRECTION.IC_TO_MC, COMMAND_TYPE.RESPONSE, V2_ONLY, { responseTo: 0x48 }),
    spec(0x39, 0x49, "お知らせ録画取りこぼし情報確認要求", DIRECTION.MC_TO_IC, COMMAND_TYPE.REQUEST, V2_ONLY),
    spec(0x39, 0x69, "お知らせ録画取りこぼし情報確認応答", DIRECTION.IC_TO_MC, COMMAND_TYPE.RESPONSE, V2_ONLY, { responseTo: 0x49 }),
    spec(0x39, 0x4A, "全お知らせ録画取りこぼし情報確認要求", DIRECTION.MC_TO_IC, COMMAND_TYPE.REQUEST, V2_ONLY),
    spec(0x39, 0x6A, "全お知らせ録画取りこぼし情報確認応答", DIRECTION.IC_TO_MC, COMMAND_TYPE.RESPONSE, V2_ONLY, { responseTo: 0x4A, bulk: true }),
    spec(0x39, 0x6B, "全お知らせ録画取りこぼし情報確認完了", DIRECTION.IC_TO_MC, COMMAND_TYPE.COMPLETION, V2_ONLY, { responseTo: 0x4A, bulk: true }),
    spec(0x39, 0x4C, "確認機能付き静止画個別通知要求", DIRECTION.MC_TO_IC, COMMAND_TYPE.REQUEST, V3_ONLY),
    spec(0x39, 0x6C, "確認機能付き静止画個別通知応答", DIRECTION.IC_TO_MC, COMMAND_TYPE.RESPONSE, V3_ONLY, { responseTo: 0x4C }),
    spec(0x39, 0x6D, "確認機能付き静止画個別通知終了", DIRECTION.IC_TO_MC, COMMAND_TYPE.COMPLETION, V3_ONLY, { responseTo: 0x4C }),
    spec(0x39, 0x4E, "確認機能付き静止画一斉通知要求", DIRECTION.MC_TO_IC, COMMAND_TYPE.REQUEST, V3_ONLY),
    spec(0x39, 0x6E, "確認機能付き静止画一斉通知応答", DIRECTION.IC_TO_MC, COMMAND_TYPE.RESPONSE, V3_ONLY, { responseTo: 0x4E }),
    spec(0x39, 0x6F, "確認機能付き静止画一斉通知終了", DIRECTION.IC_TO_MC, COMMAND_TYPE.COMPLETION, V3_ONLY, { responseTo: 0x4E }),
    spec(0x39, 0x50, "確認機能付き静止画個別結果取得要求", DIRECTION.MC_TO_IC, COMMAND_TYPE.REQUEST, V3_ONLY),
    spec(0x39, 0x70, "確認機能付き静止画個別結果取得応答", DIRECTION.IC_TO_MC, COMMAND_TYPE.RESPONSE, V3_ONLY, { responseTo: 0x50 }),
    spec(0x39, 0x51, "確認機能付き静止画一斉結果取得要求", DIRECTION.MC_TO_IC, COMMAND_TYPE.REQUEST, V3_ONLY),
    spec(0x39, 0x71, "確認機能付き静止画一斉結果取得応答", DIRECTION.IC_TO_MC, COMMAND_TYPE.RESPONSE, V3_ONLY, { responseTo: 0x51, bulk: true }),
    spec(0x39, 0x72, "確認機能付き静止画一斉結果取得完了", DIRECTION.IC_TO_MC, COMMAND_TYPE.COMPLETION, V3_ONLY, { responseTo: 0x51, bulk: true }),
    spec(0x39, 0x53, "日時指定静止画消去要求", DIRECTION.MC_TO_IC, COMMAND_TYPE.REQUEST, V3_ONLY),
    spec(0x39, 0x73, "日時指定静止画消去応答", DIRECTION.IC_TO_MC, COMMAND_TYPE.RESPONSE, V3_ONLY, { responseTo: 0x53 }),
    spec(0x39, 0x54, "全住戸情報初期化要求", DIRECTION.MC_TO_IC, COMMAND_TYPE.REQUEST, V3_ONLY),
    spec(0x39, 0x74, "全住戸情報初期化応答", DIRECTION.IC_TO_MC, COMMAND_TYPE.RESPONSE, V3_ONLY, { responseTo: 0x54 }),

    spec(0x3A, 0x41, "ヘルスチェック要求", DIRECTION.BIDIRECTIONAL, COMMAND_TYPE.REQUEST),
    spec(0x3A, 0x61, "ヘルスチェック応答", DIRECTION.BIDIRECTIONAL, COMMAND_TYPE.RESPONSE, ALL_VERSIONS, { responseTo: 0x41 }),

    spec(0x3B, 0x41, "住戸グループ確認要求", DIRECTION.MC_TO_IC, COMMAND_TYPE.REQUEST, V3_ONLY),
    spec(0x3B, 0x61, "住戸グループ確認応答", DIRECTION.IC_TO_MC, COMMAND_TYPE.RESPONSE, V3_ONLY, { responseTo: 0x41 }),
    spec(0x3B, 0x42, "住戸グループ変更要求", DIRECTION.MC_TO_IC, COMMAND_TYPE.REQUEST, V3_ONLY),
    spec(0x3B, 0x62, "住戸グループ変更応答", DIRECTION.IC_TO_MC, COMMAND_TYPE.RESPONSE, V3_ONLY, { responseTo: 0x42 }),
    spec(0x3B, 0x43, "全グループ情報要求", DIRECTION.MC_TO_IC, COMMAND_TYPE.REQUEST, V3_ONLY),
    spec(0x3B, 0x63, "全グループ情報応答", DIRECTION.IC_TO_MC, COMMAND_TYPE.RESPONSE, V3_ONLY, { responseTo: 0x43, bulk: true }),
    spec(0x3B, 0x64, "全グループ情報完了", DIRECTION.IC_TO_MC, COMMAND_TYPE.COMPLETION, V3_ONLY, { responseTo: 0x43, bulk: true }),
  ];

  const COMMAND_REGISTRY = Object.freeze(RAW_COMMAND_SPECS.map((row) => {
    const [kind, command, name, direction, type, versions, extra] = row;
    return Object.freeze({
      key: `${byteHex(kind)}:${byteHex(command)}`,
      kind,
      kindName: KIND_NAMES[kind],
      command,
      name,
      direction,
      type,
      versions,
      ...(extra || {}),
    });
  }));

  const COMMAND_INDEX = new Map(COMMAND_REGISTRY.map((definition) => [
    (definition.kind << 8) | definition.command,
    definition,
  ]));

  function findCommandDefinition(kindValue, commandValue) {
    const kind = normalizeCommandByte(kindValue, "kind");
    const command = normalizeCommandByte(commandValue, "command");
    return COMMAND_INDEX.get((kind << 8) | command) || null;
  }

  function directionAllows(direction, from) {
    if (direction === DIRECTION.BIDIRECTIONAL) return true;
    if (from === ROLE.IC) return direction === DIRECTION.IC_TO_MC;
    if (from === ROLE.MC) return direction === DIRECTION.MC_TO_IC;
    return false;
  }

  function getCommandDefinition(kindValue, commandValue, options) {
    const kind = normalizeCommandByte(kindValue, "kind");
    const command = normalizeCommandByte(commandValue, "command");
    const definition = COMMAND_INDEX.get((kind << 8) | command);
    if (!definition) {
      fail("UNKNOWN_COMMAND", `未定義のKIND/CMDです: ${byteHex(kind)}/${byteHex(command)}`, { kind, command });
    }
    const opts = options || {};
    const version = normalizeVersion(opts.version, false);
    if (version !== null && !definition.versions.includes(version)) {
      fail("UNSUPPORTED_VERSION", `${definition.name} はVer.${version}では使用できません`, {
        kind,
        command,
        version,
        supportedVersions: definition.versions,
      });
    }
    if (opts.from !== undefined) {
      if (opts.from !== ROLE.IC && opts.from !== ROLE.MC) {
        fail("INVALID_ROLE", "from はICまたはMCで指定してください", { from: opts.from });
      }
      if (!directionAllows(definition.direction, opts.from)) {
        fail("INVALID_DIRECTION", `${definition.name} を${opts.from}から送信することはできません`, {
          from: opts.from,
          direction: definition.direction,
        });
      }
    }
    return definition;
  }

  function listCommandDefinitions(options) {
    const opts = options || {};
    const version = normalizeVersion(opts.version, false);
    if (opts.from !== undefined && opts.from !== ROLE.IC && opts.from !== ROLE.MC) {
      fail("INVALID_ROLE", "from はICまたはMCで指定してください", { from: opts.from });
    }
    return COMMAND_REGISTRY.filter((definition) => {
      if (version !== null && !definition.versions.includes(version)) return false;
      if (opts.from !== undefined && !directionAllows(definition.direction, opts.from)) return false;
      return true;
    });
  }

  function calculateBcc(frameWithoutBcc) {
    const bytes = toBytes(frameWithoutBcc, "frameWithoutBcc");
    if (bytes.length < 2 || bytes[0] !== CODE.STX || bytes[bytes.length - 1] !== CODE.ETX) {
      fail("INVALID_BCC_INPUT", "BCC計算対象はSTXで始まりETXで終わる必要があります");
    }
    let value = 0;
    for (let index = 1; index < bytes.length; index += 1) value ^= bytes[index];
    return value & 0xFF;
  }

  function verifyBcc(packet) {
    const bytes = toBytes(packet, "packet");
    if (bytes.length < 3 || bytes[0] !== CODE.STX || bytes[bytes.length - 2] !== CODE.ETX) return false;
    let value = 0;
    for (let index = 1; index < bytes.length; index += 1) value ^= bytes[index];
    return (value & 0xFF) === 0;
  }

  function validateFrame(packet, options) {
    const bytes = toBytes(packet, "packet");
    const opts = options || {};
    if (bytes.length < 7) fail("FRAME_TOO_SHORT", "フレームは最短7バイトです", { actual: bytes.length });
    if (bytes[0] !== CODE.STX) fail("INVALID_STX", "フレーム先頭がSTXではありません", { actual: bytes[0] });
    if (bytes[1] < 0x30 || bytes[1] > 0x39 || bytes[2] < 0x30 || bytes[2] > 0x39) {
      fail("INVALID_LEN_ENCODING", "LENはASCII数字2桁で指定してください", { bytes: bytes.slice(1, 3) });
    }
    const length = (bytes[1] - 0x30) * 10 + (bytes[2] - 0x30);
    if (length < 5 || length > 99) {
      fail("INVALID_LEN_RANGE", "LENは05～99の範囲です", { length });
    }
    const expectedTotal = length + 2;
    if (bytes.length !== expectedTotal) {
      fail("FRAME_LENGTH_MISMATCH", `LEN=${length}に対して総バイト数が一致しません`, {
        declaredLength: length,
        expectedTotal,
        actualTotal: bytes.length,
      });
    }
    if (bytes[length] !== CODE.ETX) {
      fail("INVALID_ETX", "LENで示された位置にETXがありません", { index: length, actual: bytes[length] });
    }
    const expectedBcc = calculateBcc(bytes.slice(0, length + 1));
    const actualBcc = bytes[length + 1];
    if (actualBcc !== expectedBcc) {
      fail("BCC_MISMATCH", `BCCが一致しません（expected=${byteHex(expectedBcc)}, actual=${byteHex(actualBcc)}）`, {
        expected: expectedBcc,
        actual: actualBcc,
      });
    }
    const kind = bytes[3];
    const command = bytes[4];
    const message = bytes.slice(5, length);
    assertPrintableAscii([kind], "kind");
    assertPrintableAscii([command], "command");
    assertPrintableAscii(message, "message");
    let commandDefinition = null;
    if (opts.validateCommand !== false) {
      commandDefinition = getCommandDefinition(kind, command, { version: opts.version, from: opts.from });
    }
    return Object.freeze({
      raw: Object.freeze(bytes.slice()),
      length,
      kind,
      command,
      cmd: command,
      message: Object.freeze(message),
      messageText: asciiText(message),
      bcc: actualBcc,
      commandDefinition,
    });
  }

  function buildFrame(options) {
    const opts = options || {};
    const kind = normalizeCommandByte(opts.kind, "kind");
    if (opts.command !== undefined && opts.cmd !== undefined && opts.command !== opts.cmd) {
      fail("CONFLICTING_ARGUMENTS", "command と cmd に異なる値が指定されています");
    }
    const commandValue = opts.command !== undefined ? opts.command : opts.cmd;
    const command = normalizeCommandByte(commandValue, "command");
    assertPrintableAscii([kind], "kind");
    assertPrintableAscii([command], "command");
    const message = assertPrintableAscii(toBytes(opts.message === undefined ? [] : opts.message, "message"), "message");
    const length = 5 + message.length;
    if (length > 99) {
      fail("MESSAGE_TOO_LONG", "MESGは最大94バイトです", { actual: message.length, maximum: 94 });
    }
    if (opts.validateCommand !== false) {
      getCommandDefinition(kind, command, { version: opts.version, from: opts.from });
    } else {
      normalizeVersion(opts.version, false);
    }
    const frame = [
      CODE.STX,
      0x30 + Math.floor(length / 10),
      0x30 + (length % 10),
      kind,
      command,
      ...message,
      CODE.ETX,
    ];
    frame.push(calculateBcc(frame));
    return frame;
  }

  function addressContext(options) {
    const opts = options || {};
    if (opts.vixusAdvance !== undefined && typeof opts.vixusAdvance !== "boolean") {
      fail("INVALID_BOOLEAN", "vixusAdvance はbooleanで指定してください", { value: opts.vixusAdvance });
    }
    return {
      version: normalizeVersion(opts.version, true),
      topology: normalizeTopology(opts.topology),
      vixusAdvance: opts.vixusAdvance === true,
    };
  }

  function parseBuildingCode(code, context) {
    if (typeof code !== "string" || code.length !== 2) {
      fail("INVALID_BUILDING", "棟番号は2文字で指定してください", { code });
    }
    let scope;
    let number = null;
    if (code === "BB") scope = "standard";
    else if (code === "FF") scope = "all";
    else if (/^B[1-9]$/.test(code)) {
      scope = "specific";
      number = Number(code[1]);
    } else if (/^[1-9][0-9]$/.test(code)) {
      scope = "specific";
      number = Number(code);
    } else {
      fail("INVALID_BUILDING", "棟番号はBB、FF、B1～B9、10～99の形式です", { code });
    }

    if (scope === "specific") {
      const maximum = context.version === VERSION.V3 ? 99 : 60;
      if (number < 1 || number > maximum) {
        fail("BUILDING_OUT_OF_RANGE", `Ver.${context.version}の棟番号範囲は1～${maximum}です`, { number });
      }
    }
    if (context.topology === TOPOLOGY.MULTI_BUILDING && scope === "standard") {
      fail("ADDRESS_TOPOLOGY_MISMATCH", "多棟システムでは棟番号BBを指定できません", { code });
    }
    if (context.topology !== TOPOLOGY.MULTI_BUILDING && scope !== "standard") {
      fail("ADDRESS_TOPOLOGY_MISMATCH", "標準／1棟多局システムの棟番号はBBです", { code });
    }
    return { code, scope, number };
  }

  function encodeBuildingCode(value, context) {
    let code;
    if (Number.isInteger(value)) {
      if (value < 1 || value > 99) fail("BUILDING_OUT_OF_RANGE", "棟番号は1～99です", { value });
      code = value < 10 ? `B${value}` : String(value);
    } else if (typeof value === "string") {
      code = value;
    } else {
      fail("BUILDING_REQUIRED", "building は棟番号、BB、FFのいずれかで指定してください", { value });
    }
    parseBuildingCode(code, context);
    return code;
  }

  function requiredInteger(value, name, minimum, maximum) {
    if (!Number.isInteger(value)) {
      fail("INVALID_INTEGER", `${name} は整数で指定してください`, { name, value });
    }
    if (value < minimum || value > maximum) {
      fail("VALUE_OUT_OF_RANGE", `${name} は${minimum}～${maximum}の範囲です`, { name, value, minimum, maximum });
    }
    return value;
  }

  function validateAddress(address, options) {
    const context = addressContext(options);
    const bytes = toBytes(address, "address");
    if (bytes.length !== 6) fail("ADDRESS_LENGTH", "ADDRは6バイトです", { actual: bytes.length });
    assertPrintableAscii(bytes, "address");
    const raw = asciiText(bytes);
    if (raw !== raw.toUpperCase()) fail("ADDRESS_FORMAT", "ADDRは大文字ASCIIで指定してください", { raw });
    const building = parseBuildingCode(raw.slice(0, 2), context);
    const suffix = raw.slice(2);
    let type;
    let number = null;
    let all = false;

    if (suffix === "CA00") {
      if (context.version !== VERSION.V3) {
        fail("ADDRESS_VERSION_MISMATCH", "共用部ADDRはVer.3専用です", { raw, version: context.version });
      }
      type = ADDRESS_TYPE.COMMON_AREA;
    } else if (suffix === "0000") {
      type = ADDRESS_TYPE.RESIDENCE;
      all = true;
      number = 0;
    } else if (/^B[0-9]{3}$/.test(suffix)) {
      number = Number(suffix.slice(1));
      if (number < 1 || number > 999) fail("RESIDENCE_OUT_OF_RANGE", "3桁住戸はB001～B999です", { raw });
      type = ADDRESS_TYPE.RESIDENCE;
    } else if (/^[1-9][0-9]{3}$/.test(suffix)) {
      number = Number(suffix);
      if (number < 1001 || number > 9999) fail("RESIDENCE_OUT_OF_RANGE", "4桁住戸は1001～9999です", { raw });
      type = ADDRESS_TYPE.RESIDENCE;
    } else if (/^C[0-9]{3}$/.test(suffix)) {
      number = Number(suffix.slice(1));
      const valid = context.vixusAdvance
        ? (number >= 1 && number <= 16) || number === 50
        : number >= 0 && number <= 9;
      if (!valid) fail("MANAGEMENT_STATION_OUT_OF_RANGE", "管親番号がシステム範囲外です", { raw, vixusAdvance: context.vixusAdvance });
      type = ADDRESS_TYPE.MANAGEMENT_STATION;
      all = number === 0;
    } else if (/^D[0-9]{3}$/.test(suffix)) {
      number = Number(suffix.slice(1));
      const valid = context.version === VERSION.V3
        ? number >= 1 && number <= 99
        : (number >= 1 && number <= 8) || (number >= 11 && number <= 998);
      if (!valid) fail("ENTRANCE_STATION_OUT_OF_RANGE", "集玄番号が通信仕様の範囲外です", { raw, version: context.version });
      type = ADDRESS_TYPE.ENTRANCE_STATION;
    } else if (/^E[0-9]{3}$/.test(suffix)) {
      if (context.version !== VERSION.V3) fail("ADDRESS_VERSION_MISMATCH", "グループADDRはVer.3専用です", { raw });
      number = Number(suffix.slice(1));
      if (number < 1 || number > 8) fail("GROUP_OUT_OF_RANGE", "グループ番号は001～008です", { raw });
      type = ADDRESS_TYPE.GROUP;
    } else if (/^F[0-9]{3}$/.test(suffix)) {
      if (context.version !== VERSION.V3) fail("ADDRESS_VERSION_MISMATCH", "階層ADDRはVer.3専用です", { raw });
      number = Number(suffix.slice(1));
      if (number < 0 || number > 99) fail("FLOOR_OUT_OF_RANGE", "階層番号は000～099です", { raw });
      type = ADDRESS_TYPE.FLOOR;
    } else {
      fail("ADDRESS_FORMAT", "ADDRの装置番号形式が不正です", { raw });
    }

    if (building.scope === "all" && type === ADDRESS_TYPE.FLOOR) {
      fail("ADDRESS_TOPOLOGY_MISMATCH", "全棟を表すFFでは階層指定できません", { raw });
    }
    if (building.scope === "all" && type === ADDRESS_TYPE.RESIDENCE && !all && !context.vixusAdvance) {
      fail("ADDRESS_TOPOLOGY_MISMATCH", "FFでの住戸個別指定はVIXUS Advanceの集中共用室に限られます", { raw });
    }

    return Object.freeze({
      raw,
      bytes: Object.freeze(bytes),
      version: context.version,
      topology: context.topology,
      building: Object.freeze(building),
      type,
      number,
      all,
    });
  }

  function buildAddressFromSuffix(options, suffix) {
    const context = addressContext(options);
    const building = encodeBuildingCode(options.building, context);
    const raw = building + suffix;
    validateAddress(raw, options);
    return raw;
  }

  function buildResidenceAddress(options) {
    const opts = options || {};
    if (opts.all !== undefined && typeof opts.all !== "boolean") {
      fail("INVALID_BOOLEAN", "all はbooleanで指定してください", { value: opts.all });
    }
    let suffix;
    if (opts.all === true) {
      if (opts.room !== undefined && opts.room !== 0) {
        fail("CONFLICTING_ARGUMENTS", "全住戸指定ではroomを指定できません", { room: opts.room });
      }
      suffix = "0000";
    } else {
      const room = requiredInteger(opts.room, "room", 1, 9999);
      if (room <= 999) suffix = "B" + String(room).padStart(3, "0");
      else {
        if (room < 1001) fail("RESIDENCE_OUT_OF_RANGE", "4桁住戸は1001からです", { room });
        suffix = String(room);
      }
    }
    return buildAddressFromSuffix(opts, suffix);
  }

  function buildManagementStationAddress(options) {
    const opts = options || {};
    const station = requiredInteger(opts.station, "station", 0, 999);
    return buildAddressFromSuffix(opts, "C" + String(station).padStart(3, "0"));
  }

  function buildEntranceStationAddress(options) {
    const opts = options || {};
    const station = requiredInteger(opts.station, "station", 0, 999);
    return buildAddressFromSuffix(opts, "D" + String(station).padStart(3, "0"));
  }

  function buildGroupAddress(options) {
    const opts = options || {};
    const group = requiredInteger(opts.group, "group", 0, 999);
    return buildAddressFromSuffix(opts, "E" + String(group).padStart(3, "0"));
  }

  function buildFloorAddress(options) {
    const opts = options || {};
    const floor = requiredInteger(opts.floor, "floor", 0, 999);
    return buildAddressFromSuffix(opts, "F" + String(floor).padStart(3, "0"));
  }

  function buildCommonAreaAddress(options) {
    return buildAddressFromSuffix(options || {}, "CA00");
  }

  function buildAddress(type, options) {
    switch (type) {
      case ADDRESS_TYPE.RESIDENCE: return buildResidenceAddress(options);
      case ADDRESS_TYPE.MANAGEMENT_STATION: return buildManagementStationAddress(options);
      case ADDRESS_TYPE.ENTRANCE_STATION: return buildEntranceStationAddress(options);
      case ADDRESS_TYPE.GROUP: return buildGroupAddress(options);
      case ADDRESS_TYPE.FLOOR: return buildFloorAddress(options);
      case ADDRESS_TYPE.COMMON_AREA: return buildCommonAreaAddress(options);
      default: fail("INVALID_ADDRESS_TYPE", "未対応のADDR種別です", { type });
    }
  }

  // ------------------------------------------------------------------
  // 6.共通定義 警報情報識別(KH_INF)
  // 各バイトは上位ニブルが0011固定で、下位4bitに警報4種を割り付ける。
  // 1バイト目が 0011DCBA なので、bit0=A、bit1=B、bit2=C、bit3=D の順。
  // Ver1/Ver2 と Ver3 では割付そのものが異なるため、別表として持つ。
  // ------------------------------------------------------------------
  const ALARM_INFO_V1 = [
    "火災", "ガス漏れ", "非常", "トイレコール",
    "バスコール", "火災障害", "ガス障害", "防犯１発報",
    null, "部屋コール", "防犯２発報", null,
    "一酸化炭素警報", "健康異変", "水不使用", "水連続使用",
    "水漏れ", "水予告", "水電池切れ", "システム予約",
    "汎用コール", "セルフチェック", "機器異常", "非常解錠",
  ];
  const ALARM_INFO_V2 = ALARM_INFO_V1.concat(["遠隔試験", "防犯３発報", null, null]);
  const ALARM_INFO_V3 = [
    "火災", "遠隔試験", "ガス漏れ", "火災感知器作動",
    "火災障害", "ガス障害", "電池切れ", "機器異常(1)",
    "非常", "トイレコール", "バスコール", "部屋コール",
    "汎用コール", "ワイヤレスコール", "救急", "システム予約",
    "生活異変", "健康異変", "水不使用", "水連続使用",
    "水漏れ", "水予告", "水電池切れ", "換気(一酸化炭素)",
    "セルフチェック", "AC断", "共用部", "非常解錠",
    "緊急", "機器異常(2)", "予備異常", null,
    "防犯１発報", "防犯２発報", "防犯３発報", "防犯４発報",
    "防犯５発報", null, null, "防犯異常",
  ];
  const ALARM_INFO_TABLE = Object.freeze({
    1: Object.freeze(ALARM_INFO_V1.slice()),
    2: Object.freeze(ALARM_INFO_V2.slice()),
    3: Object.freeze(ALARM_INFO_V3.slice()),
  });
  // Ver1は6byte(24bit)、Ver2は7byte(26bit＋2bit未使用)、Ver3は10byte(40bit)。
  const ALARM_INFO_BYTES = Object.freeze({ 1: 6, 2: 7, 3: 10 });

  function alarmInfoByteLength(version) {
    return ALARM_INFO_BYTES[normalizeVersion(version, true)];
  }

  // 画面がそのまま並べられるよう、bit位置・ラベル・未使用かどうかを返す。
  function alarmInfoLayout(version) {
    const resolved = normalizeVersion(version, true);
    const labels = ALARM_INFO_TABLE[resolved];
    const length = alarmInfoByteLength(resolved) * 4;
    const layout = [];
    for (let index = 0; index < length; index += 1) {
      layout.push(Object.freeze({
        index,
        byteIndex: Math.floor(index / 4),
        bit: index % 4,
        label: labels[index] || null,
        reserved: !labels[index],
      }));
    }
    return Object.freeze(layout);
  }

  function alarmInfoIndexOf(name, version) {
    const labels = ALARM_INFO_TABLE[normalizeVersion(version, true)];
    const index = labels.indexOf(name);
    if (index < 0) fail("ALARM_INFO_UNKNOWN", `警報「${name}」はVer${version}の割付にありません`, { name });
    return index;
  }

  // selected は割付の添字（0起点）か警報名の配列。未使用bitは0固定なので拒否する。
  function encodeAlarmInfo(selected, version) {
    const resolved = normalizeVersion(version, true);
    const layout = alarmInfoLayout(resolved);
    const bytes = new Array(alarmInfoByteLength(resolved)).fill(0x30);
    for (const item of Array.from(selected || [])) {
      const index = typeof item === "number" ? item : alarmInfoIndexOf(item, resolved);
      if (!Number.isInteger(index) || index < 0 || index >= layout.length) {
        fail("ALARM_INFO_RANGE", `警報ビットの指定が範囲外です: ${item}`, { item });
      }
      if (layout[index].reserved) {
        fail("ALARM_INFO_RESERVED", `bit${index}は未使用（０固定）です`, { index });
      }
      bytes[layout[index].byteIndex] |= 1 << layout[index].bit;
    }
    return bytes;
  }

  function decodeAlarmInfo(bytes, version) {
    const resolved = normalizeVersion(version, true);
    const raw = toBytes(bytes, "KH_INF");
    const expected = alarmInfoByteLength(resolved);
    if (raw.length !== expected) {
      fail("ALARM_INFO_LENGTH", `KH_INFはVer${resolved}では${expected}バイトです`, { actual: raw.length });
    }
    const layout = alarmInfoLayout(resolved);
    const active = [];
    const violations = [];
    raw.forEach((byte, position) => {
      if ((byte & 0xF0) !== 0x30) {
        fail("ALARM_INFO_FORMAT", `KH_INF ${position + 1}バイト目の上位ニブルは0011固定です`, { byte });
      }
    });
    for (const entry of layout) {
      if ((raw[entry.byteIndex] & (1 << entry.bit)) === 0) continue;
      if (entry.reserved) violations.push(entry.index);
      else active.push(entry.label);
    }
    return { version: resolved, bytes: raw, active, violations };
  }

  // ------------------------------------------------------------------
  // メッセージ（ペイロード）定義。仕様書「6.メッセージ詳細」の記載を写す。
  // 画面はこの定義から入力欄を組み立てる。
  // ------------------------------------------------------------------
  const FIELD = Object.freeze({
    ADDRESS: "address",       // ADDR 6byte
    ALARM_INFO: "alarmInfo",  // KH_INF Ver別 6/7/10byte
    ENUM: "enum",             // 1byteの列挙
    DIGITS: "digits",         // ASCII数字の固定桁
    RAW: "raw",               // 定義未整備のコマンド用
  });

  function field(name, type, extra) {
    return Object.freeze(Object.assign({ name, type }, extra || null));
  }

  // 35H系で共通の処理結果。31Hはコマンドで意味が変わるため個別に上書きする。
  function answerField(overrides) {
    return field("ANS", FIELD.ENUM, {
      bytes: 1,
      label: "処理結果",
      values: Object.freeze(Object.assign({
        0x30: "OK",
        0x39: "住戸NO異常(電源OFF/NO不一致)",
        0x40: "通信パラメータ異常",
        0x45: "機能なし",
        0x50: "要求中（同時処理無効）",
      }, overrides || null)),
    });
  }

  const ADDRESS_FIELD = field("ADDR", FIELD.ADDRESS, { bytes: 6, label: "住戸NO" });
  // 6.7 ボックス状態識別。1パケットへ最大3件入るが、画面は1件だけ扱う。
  const BOX_STATUS_FIELD = field("STS", FIELD.ENUM, {
    bytes: 1,
    label: "ボックス状態識別",
    values: Object.freeze({ 0x30: "取出し状態", 0x31: "着荷状態", 0x32: "滞留状態" }),
  });
  const PACKET_COUNT_FIELD = field("PKT NO", FIELD.ENUM, {
    bytes: 1,
    label: "1パケット内の件数",
    values: Object.freeze({ 0x31: "1件" }),
  });
  const ALARM_INFO_FIELD = field("KH_INF", FIELD.ALARM_INFO, { label: "警報情報識別" });

  const MESSAGE_SCHEMAS = Object.freeze({
    // 6.1 初期化
    "30,41": Object.freeze([field("ROK", FIELD.ENUM, {
      bytes: 1,
      label: "IC宅配送信情報",
      // 値そのものがVerを表す。画面は仕様Verに合う値だけ出す。
      values: Object.freeze({
        0x30: "宅配通知無し（Ver1専用）",
        0x31: "宅配通知有り（Ver1専用）",
        0x32: "宅配通知無し（Ver2専用）",
        0x33: "宅配通知有り（Ver2専用）",
        0x34: "宅配通知無し（Ver3専用）",
        0x35: "宅配通知有り（Ver3専用）",
      }),
      versionValues: Object.freeze({ 1: [0x30, 0x31], 2: [0x32, 0x33], 3: [0x34, 0x35] }),
    })]),
    "30,42": Object.freeze([]),
    "30,43": Object.freeze([]),

    // 6.6 警報出力関係
    "35,41": Object.freeze([ADDRESS_FIELD, ALARM_INFO_FIELD]),
    "35,42": Object.freeze([ADDRESS_FIELD]),
    "35,62": Object.freeze([ADDRESS_FIELD, answerField({ 0x31: "火災障害以外の火災警報音とガス漏れ警報音は停止不可" })]),
    "35,43": Object.freeze([]),
    "35,63": Object.freeze([answerField()]),
    "35,44": Object.freeze([ADDRESS_FIELD]),
    "35,64": Object.freeze([ADDRESS_FIELD, ALARM_INFO_FIELD, answerField({ 0x31: "警報音のみ停止（警報発報中）" })]),
    "35,45": Object.freeze([ADDRESS_FIELD]),
    "35,65": Object.freeze([ADDRESS_FIELD, ALARM_INFO_FIELD, answerField()]),
    "35,46": Object.freeze([]),
    "35,47": Object.freeze([]),
    "35,48": Object.freeze([ADDRESS_FIELD, ALARM_INFO_FIELD]),
    "35,68": Object.freeze([ADDRESS_FIELD, answerField({ 0x31: "復旧指示警報が遠隔復旧不可" })]),

    // 6.7 宅配ボックス制御。ボックス情報は1パケットに最大3件だが、
    // 画面からは状態変化1件の通知（PKT NO=1）に絞って組み立てる。
    "36,41": Object.freeze([
      field("残PKT", FIELD.DIGITS, { bytes: 3, label: "残りパケット数", default: 0 }),
      PACKET_COUNT_FIELD,
      field("ボックスNO", FIELD.DIGITS, { bytes: 3, label: "ボックス番号 001～999", default: 1 }),
      BOX_STATUS_FIELD,
      ADDRESS_FIELD,
    ]),
    "36,43": Object.freeze([
      field("残PKT", FIELD.DIGITS, { bytes: 4, label: "残りパケット数", default: 0 }),
      PACKET_COUNT_FIELD,
      BOX_STATUS_FIELD,
      ADDRESS_FIELD,
    ]),
    "36,42": Object.freeze([]),
    "36,62": Object.freeze([]),
  });

  // 定義済みならフィールド配列、未整備ならnull（画面は生MESGへ退避する）。
  function messageSchema(kind, command) {
    const key = `${assertByte(kind, "kind").toString(16)},${assertByte(command, "command").toString(16)}`;
    return MESSAGE_SCHEMAS[key] || null;
  }

  function fieldByteLength(entry, version) {
    if (entry.type === FIELD.ALARM_INFO) return alarmInfoByteLength(version);
    return entry.bytes;
  }

  // values は { ADDR: [...], KH_INF: [...], ANS: 0x30, ... } のフィールド名→値。
  function buildMessage(kind, command, options) {
    const opts = options || {};
    const version = normalizeVersion(opts.version, true);
    const schema = messageSchema(kind, command);
    if (!schema) fail("MESSAGE_SCHEMA_MISSING", "このコマンドのメッセージ定義は未整備です", { kind, command });
    const values = opts.values || {};
    const message = [];
    for (const entry of schema) {
      const value = values[entry.name];
      if (entry.type === FIELD.ALARM_INFO) {
        message.push(...encodeAlarmInfo(value || [], version));
        continue;
      }
      if (entry.type === FIELD.ADDRESS) {
        if (value == null) fail("MESSAGE_FIELD_REQUIRED", `${entry.name}は必須です`, { field: entry.name });
        const bytes = toBytes(value, entry.name);
        if (bytes.length !== 6) fail("ADDRESS_LENGTH", "ADDRは6バイトです", { actual: bytes.length });
        message.push(...bytes);
        continue;
      }
      if (entry.type === FIELD.ENUM) {
        const code = assertByte(value, entry.name);
        if (!Object.prototype.hasOwnProperty.call(entry.values, code)) {
          fail("MESSAGE_FIELD_VALUE", `${entry.name}に${byteHex(code)}は定義されていません`, { field: entry.name, code });
        }
        message.push(code);
        continue;
      }
      if (entry.type === FIELD.DIGITS) {
        const width = entry.bytes;
        const limit = Math.pow(10, width) - 1;
        const number = requiredInteger(
          value == null ? (entry.default == null ? 0 : entry.default) : Number(value),
          entry.name, 0, limit,
        );
        const text = String(number).padStart(width, "0");
        message.push(...Array.from(text, (character) => character.charCodeAt(0)));
        continue;
      }
      const bytes = toBytes(value == null ? [] : value, entry.name);
      const expected = fieldByteLength(entry, version);
      if (expected != null && bytes.length !== expected) {
        fail("MESSAGE_FIELD_LENGTH", `${entry.name}は${expected}バイトです`, { field: entry.name, actual: bytes.length });
      }
      message.push(...bytes);
    }
    return message;
  }

  function buildInitializationRequest(options) {
    const opts = options || {};
    const version = normalizeVersion(opts.version, true);
    if (typeof opts.deliveryNotification !== "boolean") {
      fail("BOOLEAN_REQUIRED", "deliveryNotification はbooleanで指定してください");
    }
    const base = version === VERSION.V1 ? 0x30 : version === VERSION.V2 ? 0x32 : 0x34;
    return buildFrame({
      kind: KIND.INITIALIZATION,
      command: 0x41,
      message: [base + (opts.deliveryNotification ? 1 : 0)],
      version,
      from: ROLE.IC,
    });
  }

  function buildInitializationComplete(options) {
    const opts = options || {};
    return buildFrame({ kind: KIND.INITIALIZATION, command: 0x42, version: opts.version, from: ROLE.MC });
  }

  function buildConnectionStart(options) {
    const opts = options || {};
    return buildFrame({ kind: KIND.INITIALIZATION, command: 0x43, version: opts.version, from: ROLE.IC });
  }

  function buildHealthCheckRequest(options) {
    const opts = options || {};
    return buildFrame({ kind: KIND.HEALTH_CHECK, command: 0x41, version: opts.version, from: opts.from });
  }

  function buildHealthCheckResponse(options) {
    const opts = options || {};
    return buildFrame({ kind: KIND.HEALTH_CHECK, command: 0x61, version: opts.version, from: opts.from });
  }

  function toHex(bytes) {
    return toBytes(bytes, "bytes").map((byte) => byte.toString(16).toUpperCase().padStart(2, "0")).join(" ");
  }

  const address = Object.freeze({
    build: buildAddress,
    residence: buildResidenceAddress,
    managementStation: buildManagementStationAddress,
    entranceStation: buildEntranceStationAddress,
    group: buildGroupAddress,
    floor: buildFloorAddress,
    commonArea: buildCommonAreaAddress,
    validate: validateAddress,
  });

  return Object.freeze({
    CODE,
    VERSION,
    TOPOLOGY,
    ADDRESS_TYPE,
    DIRECTION,
    ROLE,
    COMMAND_TYPE,
    KIND,
    KIND_NAMES,
    COMMAND_REGISTRY,
    MansionProtocolError,
    toBytes,
    toHex,
    calculateBcc,
    calcBCC: calculateBcc,
    verifyBcc,
    verifyBCC: verifyBcc,
    buildFrame,
    parseFrame: validateFrame,
    validateFrame,
    findCommandDefinition,
    getCommandDefinition,
    validateCommand: getCommandDefinition,
    listCommandDefinitions,
    buildAddress,
    buildResidenceAddress,
    buildManagementStationAddress,
    buildEntranceStationAddress,
    buildGroupAddress,
    buildFloorAddress,
    buildCommonAreaAddress,
    validateAddress,
    address,
    FIELD,
    ALARM_INFO_TABLE,
    alarmInfoByteLength,
    alarmInfoLayout,
    encodeAlarmInfo,
    decodeAlarmInfo,
    messageSchema,
    buildMessage,
    buildInitializationRequest,
    buildInitializationComplete,
    buildConnectionStart,
    buildHealthCheckRequest,
    buildHealthCheckResponse,
  });
});
