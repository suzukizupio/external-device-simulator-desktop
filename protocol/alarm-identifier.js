// 受信した警報電文が、どのメーカー・どのプロトコルのものかを判定する。
//   アイホン Q49-023G Ver.1.22
//   パナソニック HPC／TSS／大興／リモート
// アイホンQ49-023GとパナソニックHPC／TSSは、STX＋データ長37H＋データ7byte＋ETX＋
// 加算BCCという外形がまったく同じで、長さやBCCでは見分けられない。発信種別の台帳、
// 棟番号の符号化（アイホンはBCD、パナソニックはバイナリ）、発報元の割付（アイホンだけが
// 管理室・集合玄関・共用部を持つ）といった中身の規定から、成立するものを絞り込む。
// Browser: window.AlarmIdentifier / Node: require("./protocol/alarm-identifier.js")
(function (root, factory) {
  "use strict";
  if (typeof module !== "undefined" && module.exports) {
    module.exports = factory(require("./alarm.js"), require("./panasonic-alarm.js"));
  } else {
    root.AlarmIdentifier = factory(root.AlarmProtocol, root.PanasonicAlarm);
  }
})(typeof window !== "undefined" ? window : globalThis, function (AlarmProtocol, PanasonicAlarm) {
  "use strict";

  if (!AlarmProtocol || !PanasonicAlarm) {
    throw new Error("AlarmIdentifier requires AlarmProtocol and PanasonicAlarm");
  }

  const VENDOR = Object.freeze({ AIPHONE: "aiphone", PANASONIC: "panasonic" });
  const AIPHONE_ID = "aiphone";

  const SOURCE_TEXT = Object.freeze({
    none: "発報元なし",
    dwelling: "住戸",
    management: "管理室",
    entrance: "集合玄関",
    common: "共用部",
  });

  // alarm.js の例外は英語のため、判定の決め手として示す文言はここで作る。
  const AIPHONE_TYPE_LABEL = Object.freeze({
    0x00: "警報情報①",
    0x01: "警報情報②",
    0x04: "警戒設定",
    0x44: "警戒解除",
    0x30: "ヒストリー要求",
  });

  function hexByte(value) {
    return Number(value).toString(16).toUpperCase().padStart(2, "0");
  }

  // アイホンとして成立しなかった理由を、パナソニックとの違いが分かる日本語で返す。
  function aiphoneRejectReason(bytes, error) {
    const frame = Array.from(bytes || []);
    // まず全プロトコル共通の外形。ここで外れる場合は判別の決め手にはならない。
    if (frame.length !== 11) return "電文が11byteではありません";
    if (frame[0] !== AlarmProtocol.CODE.STX) return "STXが02Hではありません";
    if (frame[1] !== AlarmProtocol.SIZE) return "データ長が37Hではありません";
    if (frame[9] !== AlarmProtocol.CODE.ETX) return "ETXが03Hではありません";
    if (!AlarmProtocol.verifyBCC(frame)) return "BCCが一致しません";
    const type = frame[2];
    if (!AlarmProtocol.TYPE_NAME[type]) return "発信種別 " + hexByte(type) + "H は台帳にありません";
    // 棟番号はアイホンだけがBCD。0AH～0FHのような値はここで外れる。
    try { AlarmProtocol.decodeBCD(frame[4]); } catch (_error) { return "棟番号 " + hexByte(frame[4]) + "H がBCDではありません"; }
    // 発報元は住戸／管理室(0C)／集合玄関(0D)／共用部の割付を持つ。
    try { AlarmProtocol.decodeSource(frame.slice(5, 9)); } catch (_error) { return "発報元4byteの割付が仕様に合いません"; }
    return String(error && error.message || error);
  }

  // 判定対象。アイホンはビット割付がパターン依存のため、読みの比較でだけパターンを使う。
  const TARGETS = Object.freeze([
    Object.freeze({
      id: AIPHONE_ID,
      vendor: VENDOR.AIPHONE,
      label: "アイホン Q49-023G",
      short: "アイホン",
      style: PanasonicAlarm.STYLE.BLOCK,
      view: "alarm",
    }),
  ].concat(PanasonicAlarm.PROTOCOL_NAMES.map(function (protocol) {
    const info = PanasonicAlarm.protocolInfo(protocol);
    return Object.freeze({
      id: protocol,
      vendor: VENDOR.PANASONIC,
      label: "パナソニック " + info.label,
      short: info.label,
      style: info.style,
      view: "panasonic",
      protocol: protocol,
    });
  })));

  const TARGET_IDS = Object.freeze(TARGETS.map(function (target) { return target.id; }));

  function findTarget(id) {
    const name = String(id == null ? "" : id);
    return TARGETS.find(function (target) { return target.id === name; }) || null;
  }

  function parseWith(target, bytes) {
    if (target.vendor === VENDOR.AIPHONE) return AlarmProtocol.parseFrame(bytes);
    return PanasonicAlarm.parseFrame(bytes, { protocol: target.protocol });
  }

  // 別表にない警報No.を含むレコードは、そのプロトコルの電文とは認めない。
  // （受信解析では読み取れた桁を残すため通すが、判定では絞り込みの根拠に使う）
  function unknownAlarmNumbers(parsed) {
    if (!parsed || parsed.kind !== "alarm" || !Array.isArray(parsed.records)) return [];
    return parsed.records.filter(function (record) { return !record.known; });
  }

  function identify(value, options) {
    const opts = options || {};
    const results = TARGETS.map(function (target) {
      try {
        const parsed = parseWith(target, value);
        const unknown = unknownAlarmNumbers(parsed);
        if (unknown.length) {
          const numbers = unknown.map(function (record) { return String(record.alarmNo).padStart(2, "0"); });
          return {
            id: target.id, target: target, style: target.style, accepted: false,
            reason: "警報No." + numbers.join("・") + " が別表にありません",
          };
        }
        return { id: target.id, target: target, style: target.style, accepted: true, parsed: parsed, reason: null };
      } catch (error) {
        return {
          id: target.id, target: target, style: target.style, accepted: false,
          reason: target.vendor === VENDOR.AIPHONE
            ? aiphoneRejectReason(value, error)
            : String(error && error.message || error),
        };
      }
    });

    const accepted = results.filter(function (item) { return item.accepted; });
    const style = accepted.length ? accepted[0].style : null;
    return {
      candidates: accepted.map(function (item) { return item.id; }),
      targets: accepted.map(function (item) { return item.target; }),
      id: accepted.length === 1 ? accepted[0].id : null,
      target: accepted.length === 1 ? accepted[0].target : null,
      style: style,
      // 候補すべてが同じ画面で扱えるかどうか（分かれるなら画面の移動を促せる）。
      views: Array.from(new Set(accepted.map(function (item) { return item.target.view; }))),
      results: results,
      // 形式そのものが違うものを外した理由は自明なので、決め手は同じ形式の中だけから示す。
      rejected: results.filter(function (item) { return !item.accepted && item.style === style; }),
      differences: describeDifferences(accepted, opts),
    };
  }

  // 同じバイト列でも、プロトコルが違えば読みが変わる。候補が複数残るときはその違いを挙げる。
  function describeDifferences(accepted, options) {
    if (accepted.length < 2) return [];
    const readings = accepted.map(function (item) {
      return { label: item.target.short, text: readingOf(item, options) };
    }).filter(function (item) { return item.text !== null; });
    if (readings.length < 2) return [];
    if (new Set(readings.map(function (item) { return item.text; })).size <= 1) return [];
    return [readings.map(function (item) { return item.label + "なら「" + item.text + "」"; }).join("、")];
  }

  function readingOf(item, options) {
    const parsed = item.parsed;
    if (item.target.vendor === VENDOR.AIPHONE) {
      const detail = AlarmProtocol.describeInfo(parsed.info, {
        type: parsed.type,
        pattern: options.aiphonePattern,
      });
      const kind = parsed.source.kind;
      const source = kind === AlarmProtocol.SOURCE_KIND.DWELLING
        ? "住戸" + String(parsed.source.number).padStart(4, "0")
        : kind === AlarmProtocol.SOURCE_KIND.MANAGEMENT || kind === AlarmProtocol.SOURCE_KIND.ENTRANCE
          ? SOURCE_TEXT[kind] + String(parsed.source.number).padStart(3, "0")
          : SOURCE_TEXT[kind];
      const typeLabel = AIPHONE_TYPE_LABEL[parsed.type] || parsed.typeName;
      return typeLabel + "：" + detail.summary + "／" + parsed.buildingNo + "棟 " + source;
    }
    if (item.style === PanasonicAlarm.STYLE.BLOCK) {
      const detail = PanasonicAlarm.describeInfo(item.target.protocol, parsed.type, parsed.info);
      return parsed.typeLabel + "：" + detail.summary + "／" + parsed.buildingNo + "棟 "
        + String(parsed.roomNo).padStart(4, "0") + "号室";
    }
    if (parsed.kind !== "alarm") return null;
    return parsed.records.map(function (record) {
      return record.mode + String(record.buildingNo).padStart(2, "0") + "-"
        + String(record.roomNo).padStart(4, "0") + "：" + (record.alarmLabel || "別表になし");
    }).join("、");
  }

  return Object.freeze({
    VENDOR: VENDOR,
    TARGETS: TARGETS,
    TARGET_IDS: TARGET_IDS,
    AIPHONE_ID: AIPHONE_ID,
    findTarget: findTarget,
    identify: identify,
  });
});
