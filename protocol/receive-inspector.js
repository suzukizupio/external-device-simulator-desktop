// 受信電文を「どの桁が何を意味するか」まで分解する表示専用インスペクタ。
// 判定を行うのは各プロトコルモジュールで、ここは仕様上のフィールド割付と
// 人が読める説明文の生成だけを担う。異常電文でも読み取れる範囲は必ず返し、
// 解釈できない箇所は理由付きで error / warning として示す。
//   Q48-005F 宅配ボックス4線式(B方式) Ver.1.24
//   Q55-001D 宅配ボックス2線式 V1.24
//   Q48-006F 非接触キー Ver.1.15
// Browser: window.ReceiveInspector / Node: require("./receive-inspector.js")
(function (root, factory) {
  "use strict";
  if (typeof module !== "undefined" && module.exports) {
    module.exports = factory(
      require("./locker2.js"),
      require("./locker4.js"),
      require("./noncontact-key.js"),
      require("./panasonic-alarm.js"),
      require("./panasonic-elevator.js"),
      require("./alarm-identifier.js")
    );
  } else {
    root.ReceiveInspector = factory(root.Telegram2, root.Telegram4, root.NoncontactKey, root.PanasonicAlarm, root.PanasonicElevator, root.AlarmIdentifier);
  }
})(typeof window !== "undefined" ? window : globalThis, function (Telegram2, Telegram4, NoncontactKey, PanasonicAlarm, PanasonicElevator, AlarmIdentifier) {
  "use strict";

  if (!Telegram2 || !Telegram4 || !NoncontactKey || !PanasonicAlarm || !PanasonicElevator || !AlarmIdentifier) {
    throw new Error("ReceiveInspector requires Telegram2, Telegram4, NoncontactKey, PanasonicAlarm, PanasonicElevator and AlarmIdentifier");
  }

  const STX = 0x02;
  const ETX = 0x03;
  const SP2 = 0x3F; // Q55-001D のスペースコード
  const SP4 = 0x20; // Q48-005F の空白コード

  const STATUS = Object.freeze({ OK: "ok", WARN: "warn", ERROR: "error", INFO: "info" });

  const PROFILE_TITLE = Object.freeze({
    locker4: "宅配ボックス 4線式(B方式)",
    locker2: "宅配ボックス 2線式",
    key: "非接触キー",
    panasonic: "警報（パナソニック）",
    panasonicElevator: "エレベータ連動（パナソニック）",
  });

  function toBytes(input) {
    if (input == null) return [];
    if (typeof input.length !== "number") throw new TypeError("受信データはバイト配列で指定してください");
    return Array.from(input, (value) => {
      const byte = Number(value);
      if (!Number.isInteger(byte) || byte < 0 || byte > 0xFF) throw new RangeError("受信データに0～255以外の値が含まれています");
      return byte;
    });
  }

  function hex(bytes) {
    return Array.from(bytes || [], (byte) => byte.toString(16).toUpperCase().padStart(2, "0")).join(" ");
  }

  function printable(bytes) {
    return Array.from(bytes || [], (byte) => (byte >= 0x20 && byte <= 0x7E ? String.fromCharCode(byte) : ".")).join("");
  }

  function hexByte(byte) {
    return byte == null ? "--" : `${byte.toString(16).toUpperCase().padStart(2, "0")}H`;
  }

  // ASCII数字だけで構成されていれば文字列、そうでなければ null。
  function digits(bytes) {
    if (!bytes || bytes.length === 0) return null;
    for (const byte of bytes) if (byte < 0x30 || byte > 0x39) return null;
    return String.fromCharCode(...bytes);
  }

  // 位置は仕様書と同じ1バイト目起点で表示する。
  function rangeLabel(offset, length) {
    if (length <= 0) return "—";
    if (length === 1) return String(offset + 1);
    return `${offset + 1}–${offset + length}`;
  }

  function makeField(label, offset, length, bytes, value, status, note) {
    const slice = (bytes || []).slice(offset, offset + length);
    return {
      label,
      offset,
      length,
      range: rangeLabel(offset, length),
      raw: hex(slice),
      ascii: printable(slice),
      value: value == null || value === "" ? "—" : String(value),
      status: status || STATUS.OK,
      note: note || "",
      missing: slice.length !== length,
    };
  }

  function rawDumpFields(bytes) {
    return [makeField("受信データ全体", 0, bytes.length, bytes, `${bytes.length}バイト`, STATUS.INFO, "仕様のフィールドへ割り付けられませんでした")];
  }

  function baseResult(profile, bytes) {
    return {
      profile,
      title: PROFILE_TITLE[profile] || profile,
      summary: "",
      valid: false,
      error: null,
      problems: [],
      warnings: [],
      badges: [],
      fields: [],
      lockers: [],
      byteLength: bytes.length,
      bytes,
      parsed: null,
      expectedResponse: null,
    };
  }

  function finalize(result) {
    result.error = result.problems.length ? result.problems.join(" / ") : null;
    result.valid = result.problems.length === 0;
    return result;
  }

  function badge(label, tone) {
    return { label, tone: tone || STATUS.INFO };
  }

  // STX/ETX/BCCのような共通フィールドは各機種で書式が違うため個別に組み立てる。

  // ---------------------------------------------------------------- 4線式
  const LOCKER4_ID_LABEL = Object.freeze({ 0x37: "宅配ボックス", 0x38: "集合住宅システム" });
  const LOCKER4_REQUEST_DATA = Object.freeze([0x32, 0x20, 0x30, 0x20, 0x20, 0x20, 0x20, 0x20, 0x20, 0x20]);

  function locker4Data2Text(byte) {
    if (byte === SP4) return "空白(20H)";
    if (byte >= 0x30 && byte <= 0x39) return `${String.fromCharCode(byte)}（付加情報）`;
    return `${hexByte(byte)} 仕様外`;
  }

  function inspectLocker4Lockers(payload, offsetBase, result) {
    const lockers = [];
    if (payload.length === 0) return lockers;
    const remainder = payload.length % 10;
    if (remainder !== 0) {
      result.problems.push(`ロッカーデータが10バイト単位ではありません（${payload.length}バイト）`);
    }
    const count = Math.floor(payload.length / 10);
    for (let index = 0; index < count; index += 1) {
      const data = payload.slice(index * 10, index * 10 + 10);
      const offset = offsetBase + index * 10;
      const stateByte = data[0];
      const stateLabel = Telegram4.STATE_LABEL[stateByte];
      const lockerText = digits(data.slice(2, 5));
      const buildingText = digits(data.slice(5, 6));
      const roomText = digits(data.slice(6, 10));
      const problems = [];
      if (!stateLabel) problems.push(`状態${hexByte(stateByte)}は未定義`);
      if (data[1] !== SP4 && (data[1] < 0x30 || data[1] > 0x39)) problems.push(`DATA2${hexByte(data[1])}は仕様外`);
      if (lockerText == null) problems.push("ロッカーNOがASCII数字ではありません");
      if (buildingText == null) problems.push("棟NOがASCII数字ではありません");
      if (roomText == null) problems.push("住戸NOがASCII数字ではありません");
      // 宅配ロボ状態(40H～42H)のロッカーNOは000固定。
      if ([0x40, 0x41, 0x42].includes(stateByte) && lockerText != null && Number(lockerText) !== 0) {
        problems.push("宅配ロボ状態のロッカーNOは000固定です");
      }
      lockers.push({
        index: index + 1,
        offset,
        range: rangeLabel(offset, 10),
        raw: hex(data),
        state: stateByte,
        stateHex: hexByte(stateByte),
        stateLabel: stateLabel || "未定義状態",
        data2: data[1],
        data2Text: locker4Data2Text(data[1]),
        lockerNo: lockerText == null ? null : Number(lockerText),
        lockerText: lockerText == null ? hex(data.slice(2, 5)) : lockerText,
        buildingNo: buildingText == null ? null : Number(buildingText),
        buildingText: buildingText == null ? hex(data.slice(5, 6)) : buildingText,
        roomNo: roomText == null ? null : Number(roomText),
        roomText: roomText == null ? hex(data.slice(6, 10)) : roomText,
        status: problems.length ? STATUS.ERROR : STATUS.OK,
        note: problems.join(" / "),
      });
      for (const problem of problems) result.problems.push(`ロッカーデータ${index + 1}件目: ${problem}`);
    }
    if (remainder !== 0) {
      const offset = offsetBase + count * 10;
      lockers.push({
        index: count + 1,
        offset,
        range: rangeLabel(offset, remainder),
        raw: hex(payload.slice(count * 10)),
        state: null,
        stateHex: "--",
        stateLabel: "端数データ",
        data2: null,
        data2Text: "—",
        lockerNo: null,
        lockerText: "—",
        buildingNo: null,
        buildingText: "—",
        roomNo: null,
        roomText: "—",
        status: STATUS.ERROR,
        note: `10バイトに満たない端数が${remainder}バイト残っています`,
      });
    }
    return lockers;
  }

  function inspectLocker4(bytes, options) {
    const result = baseResult("locker4", bytes);
    if (bytes.length < 23) {
      result.summary = `${bytes.length}バイト：4線式の最小長23バイトに達していません`;
      result.problems.push("電文長が23バイト未満です");
      result.fields = rawDumpFields(bytes);
      return finalize(result);
    }

    const etxIndex = bytes.length - 2;
    const srcId = bytes[1];
    const dstId = bytes[2];
    const lengthText = digits(bytes.slice(3, 6));
    const packageText = digits(bytes.slice(6, 8));
    const modelBytes = bytes.slice(8, 11);
    const payload = bytes.slice(11, etxIndex);

    result.fields.push(makeField("STX", 0, 1, bytes,
      bytes[0] === STX ? "電文開始 02H" : `${hexByte(bytes[0])}（STXではありません）`,
      bytes[0] === STX ? STATUS.OK : STATUS.ERROR));
    if (bytes[0] !== STX) result.problems.push("先頭がSTX(02H)ではありません");

    const srcLabel = LOCKER4_ID_LABEL[srcId];
    result.fields.push(makeField("発信ID", 1, 1, bytes,
      srcLabel ? `${hexByte(srcId)} ${srcLabel}` : `${hexByte(srcId)} 未定義ID`,
      srcLabel ? STATUS.OK : STATUS.ERROR, "37H=宅配ボックス／38H=集合住宅システム"));
    if (!srcLabel) result.problems.push(`発信ID${hexByte(srcId)}は仕様外です`);

    const dstLabel = LOCKER4_ID_LABEL[dstId];
    result.fields.push(makeField("着信ID", 2, 1, bytes,
      dstLabel ? `${hexByte(dstId)} ${dstLabel}` : `${hexByte(dstId)} 未定義ID`,
      dstLabel ? STATUS.OK : STATUS.ERROR));
    if (!dstLabel) result.problems.push(`着信ID${hexByte(dstId)}は仕様外です`);
    if (srcLabel && dstLabel && srcId === dstId) result.problems.push("発信IDと着信IDが同一です");

    const actualDataLength = etxIndex - 6;
    const lengthOk = lengthText != null && Number(lengthText) === actualDataLength;
    result.fields.push(makeField("データ長", 3, 3, bytes,
      lengthText == null ? "ASCII数字ではありません" : `${lengthText}（${Number(lengthText)}バイト）`,
      lengthOk ? STATUS.OK : STATUS.ERROR,
      `パッケージNO以降ETXまでの実測は${actualDataLength}バイト`));
    if (lengthText == null) result.problems.push("データ長がASCII数字ではありません");
    else if (!lengthOk) result.problems.push(`データ長${lengthText}と実データ長${actualDataLength}が一致しません`);

    const packageNo = packageText == null ? null : Number(packageText);
    result.fields.push(makeField("パッケージNO", 6, 2, bytes,
      packageText == null ? "ASCII数字ではありません"
        : packageNo === 0 ? `${packageText}（最終パケット）` : `${packageText}（この後さらに${packageNo}パケット続きます）`,
      packageText == null ? STATUS.ERROR : STATUS.OK,
      "残りパケット数を降順で示し、00で終了"));
    if (packageText == null) result.problems.push("パッケージNOがASCII数字ではありません");

    const modelBlank = modelBytes.every((byte) => byte === SP4);
    const modelText = digits(modelBytes);
    result.fields.push(makeField("機種NO", 8, 3, bytes,
      modelBlank ? "20H×3（機種指定なし）" : modelText == null ? "ASCII数字でも20H×3でもありません" : modelText,
      modelBlank || modelText != null ? STATUS.OK : STATUS.ERROR,
      "情報要求では20H×3も可"));
    if (!modelBlank && modelText == null) result.problems.push("機種NOが3桁ASCII数字でも20H×3でもありません");

    const isRequest = srcId === Telegram4.ID.SYSTEM && dstId === Telegram4.ID.LOCKER;
    const isResponse = srcId === Telegram4.ID.LOCKER && dstId === Telegram4.ID.SYSTEM;

    if (isRequest) {
      const fixedOk = hex(payload) === hex(LOCKER4_REQUEST_DATA);
      result.fields.push(makeField("要求データ", 11, payload.length, bytes,
        fixedOk ? "ロッカー情報要求の固定データ" : "固定データ(32 20 30 20×7)と一致しません",
        fixedOk ? STATUS.OK : STATUS.ERROR, "Q48-005F 4.3.4-5①"));
      if (!fixedOk) result.problems.push("情報要求の固定データが仕様と一致しません");
      if (packageNo !== null && packageNo !== 0) result.problems.push("情報要求のパッケージNOは00固定です");
    } else {
      result.lockers = inspectLocker4Lockers(payload, 11, result);
      const count = Math.floor(payload.length / 10);
      result.fields.push(makeField("ロッカーデータ", 11, payload.length, bytes,
        `${count}件（1件10バイト）`, count >= 1 && count <= 10 ? STATUS.OK : STATUS.ERROR,
        "内訳は下の一覧を参照"));
      if (count < 1) result.problems.push("ロッカーデータが1件もありません");
      if (count > 10) result.problems.push("1パケットのロッカーデータは最大10件です");
    }

    result.fields.push(makeField("ETX", etxIndex, 1, bytes,
      bytes[etxIndex] === ETX ? "電文終了 03H" : `${hexByte(bytes[etxIndex])}（ETXではありません）`,
      bytes[etxIndex] === ETX ? STATUS.OK : STATUS.ERROR));
    if (bytes[etxIndex] !== ETX) result.problems.push("ETX(03H)の位置が不正です");

    let expectedBcc = null;
    try { expectedBcc = Telegram4.calcBCC(bytes.slice(0, -1)); } catch (_error) { expectedBcc = null; }
    const bccByte = bytes[bytes.length - 1];
    const bccOk = expectedBcc != null && expectedBcc === bccByte;
    result.fields.push(makeField("BCC", bytes.length - 1, 1, bytes,
      bccOk ? `${hexByte(bccByte)} 一致` : `${hexByte(bccByte)}（計算値 ${expectedBcc == null ? "算出不可" : hexByte(expectedBcc)}）`,
      bccOk ? STATUS.OK : STATUS.ERROR, "STXの次からETXまでのXOR"));
    if (!bccOk) result.problems.push("BCCが一致しません");

    // 選択中の動作から見て、受信するはずのない方向かを注意として示す。
    const expectedType = options.expectedType;
    const type = isRequest ? "request" : isResponse ? "response" : null;
    if (expectedType && type && expectedType !== type) {
      result.warnings.push(expectedType === "request"
        ? "現在の動作設定では情報要求を受信する想定です（受信したのは情報応答／変化通知）"
        : "現在の動作設定では情報応答／変化通知を受信する想定です（受信したのは情報要求）");
    }
    if (!isRequest && !isResponse && srcLabel && dstLabel) result.problems.push("未定義の通信方向です");

    result.parsed = { type, packageNo, modelNo: modelText == null ? null : Number(modelText), lockers: result.lockers };
    result.badges.push(badge(isRequest ? "情報要求（システム→宅配）" : isResponse ? "情報応答／変化通知（宅配→システム）" : "方向不明", isRequest || isResponse ? STATUS.INFO : STATUS.ERROR));
    result.badges.push(badge(bccOk ? "BCC一致" : "BCC異常", bccOk ? STATUS.OK : STATUS.ERROR));
    if (packageNo != null) result.badges.push(badge(packageNo === 0 ? "最終パケット" : `残り${packageNo}パケット`, STATUS.INFO));
    result.expectedResponse = "ACK";

    const finished = finalize(result);
    finished.summary = isRequest
      ? `ロッカー情報要求 / 機種${modelBlank ? "指定なし" : modelText} / ${finished.valid ? "検証OK" : "検証NG"}`
      : `${result.lockers.length}件のロッカー情報 / 機種${modelText || "—"} / パッケージ${packageText || "--"} / ${finished.valid ? "検証OK" : "検証NG"}`;
    return finished;
  }

  // ---------------------------------------------------------------- 2線式
  function inspectLocker2(bytes, options) {
    const result = baseResult("locker2", bytes);
    if (bytes.length !== 11) {
      result.summary = `${bytes.length}バイト：2線式は11バイト固定です`;
      result.problems.push(`電文長が11バイトではありません（${bytes.length}バイト）`);
      result.fields = rawDumpFields(bytes);
      return finalize(result);
    }

    const commandByte = bytes[1];
    const buildingByte = bytes[2];
    const roomBytes = bytes.slice(3, 7);
    const addressBytes = bytes.slice(7, 10);
    const vacant = bytes.slice(1, 7).every((byte) => byte === SP2);

    result.fields.push(makeField("STX", 0, 1, bytes,
      bytes[0] === STX ? "電文開始 02H" : `${hexByte(bytes[0])}（STXではありません）`,
      bytes[0] === STX ? STATUS.OK : STATUS.ERROR));
    if (bytes[0] !== STX) result.problems.push("先頭がSTX(02H)ではありません");

    const commandLabel = Telegram2.CMD_LABEL[commandByte];
    if (vacant) {
      result.fields.push(makeField("コマンド", 1, 1, bytes, "3FH（未登録ロッカー）", STATUS.INFO, "旧版互換のスペースコード埋め"));
      result.fields.push(makeField("棟No", 2, 1, bytes, "3FH（未登録）", STATUS.INFO));
      result.fields.push(makeField("住戸番号", 3, 4, bytes, "3FH×4（未登録）", STATUS.INFO));
    } else {
      result.fields.push(makeField("コマンド", 1, 1, bytes,
        commandLabel ? `${hexByte(commandByte)} ${commandLabel}` : `${hexByte(commandByte)} 未定義コマンド`,
        commandLabel ? STATUS.OK : STATUS.ERROR, "11H=着荷／12H=滞留／13H=取り出し"));
      if (!commandLabel) result.problems.push(`コマンド${hexByte(commandByte)}は11H・12H・13Hのいずれでもありません`);

      let buildingNo = null;
      if (buildingByte === SP2) buildingNo = 0;
      else if (buildingByte >= 0x31 && buildingByte <= 0x38) buildingNo = buildingByte - 0x30;
      result.fields.push(makeField("棟No", 2, 1, bytes,
        buildingByte === SP2 ? "3FH（棟番号なし＝棟No 0）" : buildingNo == null ? `${hexByte(buildingByte)} 仕様外` : `${buildingNo}棟`,
        buildingNo == null ? STATUS.ERROR : STATUS.OK, "3FH、または31H～38H"));
      if (buildingNo == null) result.problems.push(`棟Noバイト${hexByte(buildingByte)}は3FHまたは31H～38Hではありません`);
      else if (options.maxBuilding != null && buildingNo > options.maxBuilding) {
        result.warnings.push(`棟No${buildingNo}は対象システムの上限${options.maxBuilding}を超えています`);
      }

      // 住戸番号は4桁右詰めで、空き桁は3FH。
      let roomText = "";
      let roomError = null;
      let seenDigit = false;
      for (const byte of roomBytes) {
        if (byte === SP2 && !seenDigit) continue;
        if (byte < 0x30 || byte > 0x39) { roomError = "先頭の3FHとASCII数字以外が含まれています"; break; }
        seenDigit = true;
        roomText += String.fromCharCode(byte);
      }
      const roomNo = roomError || roomText === "" ? null : Number(roomText);
      if (!roomError && (roomNo == null || roomNo < 1)) roomError = "住戸番号が空または0です";
      if (!roomError && hex(Telegram2.room4(roomNo)) !== hex(roomBytes)) roomError = "右詰め・3FH埋めの正規形式ではありません";
      result.fields.push(makeField("住戸番号", 3, 4, bytes,
        roomError ? `${printable(roomBytes)}（${roomError}）` : `${roomNo}号室`,
        roomError ? STATUS.ERROR : STATUS.OK, "4桁右詰め、空き桁は3FH"));
      if (roomError) result.problems.push(`住戸番号: ${roomError}`);
      result.parsed = { vacant: false, command: commandByte, commandLabel: commandLabel || null, buildingNo, roomNo };
    }

    const addressText = digits(addressBytes);
    const address = addressText == null ? null : Number(addressText);
    const addressOk = address != null && address >= 1 && address <= 800;
    result.fields.push(makeField("住戸アドレス", 7, 3, bytes,
      addressText == null ? "ASCII数字ではありません" : addressOk ? `${address}（ロッカー番号${address}）` : `${addressText}（001～800の範囲外）`,
      addressOk ? STATUS.OK : STATUS.ERROR, "登録順の連番（最大800）"));
    if (!addressOk) result.problems.push("住戸アドレスが001～800のASCII数字ではありません");

    result.fields.push(makeField("ETX", 10, 1, bytes,
      bytes[10] === ETX ? "電文終了 03H" : `${hexByte(bytes[10])}（ETXではありません）`,
      bytes[10] === ETX ? STATUS.OK : STATUS.ERROR, "2線式はBCCなし・単方向"));
    if (bytes[10] !== ETX) result.problems.push("11バイト目がETX(03H)ではありません");

    if (vacant) result.parsed = { vacant: true, command: null, commandLabel: null, buildingNo: null, roomNo: null };
    if (result.parsed) result.parsed.address = address;

    result.badges.push(badge(vacant ? "未登録ロッカー" : commandLabel || "コマンド不明", vacant ? STATUS.INFO : commandLabel ? STATUS.OK : STATUS.ERROR));
    if (address != null) result.badges.push(badge(`住戸アドレス ${address}`, STATUS.INFO));
    result.badges.push(badge("BCCなし・応答不要（単方向）", STATUS.INFO));
    result.expectedResponse = null;

    const finished = finalize(result);
    finished.summary = vacant
      ? `未登録ロッカー（住戸アドレス${address == null ? "--" : address}） / ${finished.valid ? "検証OK" : "検証NG"}`
      : `${commandLabel || "コマンド不明"} / ${result.parsed && result.parsed.buildingNo ? `${result.parsed.buildingNo}棟 ` : ""}${result.parsed && result.parsed.roomNo ? `${result.parsed.roomNo}号室` : "住戸番号不明"} / アドレス${address == null ? "--" : address} / ${finished.valid ? "検証OK" : "検証NG"}`;
    return finished;
  }

  // ------------------------------------------------------------ 非接触キー
  function inspectKey(bytes, options) {
    const result = baseResult("key", bytes);
    const length = bytes.length;
    const withPerson = length === 13;
    const knownLength = length === 10 || length === 13;

    if (!knownLength) {
      result.problems.push(`電文長が10／13バイトではありません（${length}バイト）`);
      if (length < 5) {
        result.summary = `${length}バイト：非接触キー電文として短すぎます`;
        result.fields = rawDumpFields(bytes);
        return finalize(result);
      }
    }

    const etxIndex = length - 2;
    result.fields.push(makeField("STX", 0, 1, bytes,
      bytes[0] === STX ? "電文開始 02H" : `${hexByte(bytes[0])}（STXではありません）`,
      bytes[0] === STX ? STATUS.OK : STATUS.ERROR));
    if (bytes[0] !== STX) result.problems.push("先頭がSTX(02H)ではありません");

    const gateBytes = bytes.slice(1, 3);
    const gateText = digits(gateBytes);
    const gateNo = gateText == null ? null : Number(gateText);
    const gateOk = gateNo != null && gateNo >= 1 && gateNo <= 99;
    result.fields.push(makeField("ゲートNo", 1, 2, bytes,
      gateText == null ? "ASCII数字ではありません" : gateOk ? `${gateText}番ゲート` : `${gateText}（01～99の範囲外）`,
      gateOk ? STATUS.OK : STATUS.ERROR, "01～99"));
    if (!gateOk) result.problems.push("ゲートNoが01～99のASCII数字ではありません");

    const buildingBytes = bytes.slice(3, 4);
    const buildingText = digits(buildingBytes);
    const buildingNo = buildingText == null ? null : Number(buildingText);
    result.fields.push(makeField("棟番号", 3, 1, bytes,
      buildingText == null ? "ASCII数字ではありません" : buildingNo === 0 ? "0（棟番号なし＝標準）" : `${buildingNo}棟`,
      buildingText == null ? STATUS.ERROR : STATUS.OK, "ルーム番号5桁の先頭1桁"));
    if (buildingText == null) result.problems.push("棟番号がASCII数字ではありません");
    else if (options.buildingMax != null && buildingNo > options.buildingMax) {
      result.warnings.push(`棟番号${buildingNo}は${options.systemLabel || "対象システム"}の上限${options.buildingMax}を超えています`);
    }

    const roomBytes = bytes.slice(4, 8);
    const roomText = digits(roomBytes);
    const roomNo = roomText == null ? null : Number(roomText);
    const roomOk = roomNo != null && roomNo >= 1 && roomNo <= 9999;
    result.fields.push(makeField("部屋番号", 4, 4, bytes,
      roomText == null ? "ASCII数字ではありません" : roomOk ? `${roomText}（${roomNo}号室）` : `${roomText}（0001～9999の範囲外）`,
      roomOk ? STATUS.OK : STATUS.ERROR, "ルーム番号5桁の下4桁"));
    if (!roomOk) result.problems.push("部屋番号が0001～9999のASCII数字ではありません");

    let personNo = null;
    if (withPerson) {
      const personBytes = bytes.slice(8, 11);
      const personText = digits(personBytes);
      personNo = personText == null ? null : Number(personText);
      result.fields.push(makeField("個人番号", 8, 3, bytes,
        personText == null ? "ASCII数字ではありません" : `${personText}（${personNo}番）`,
        personText == null ? STATUS.ERROR : STATUS.OK, "13バイト形式のみ"));
      if (personText == null) result.problems.push("個人番号がASCII数字ではありません");
      else if (options.personMax != null && personNo > options.personMax) {
        result.warnings.push(`個人番号${personText}は${options.systemLabel || "対象システム"}の上限${String(options.personMax).padStart(3, "0")}を超えています`);
      }
    }

    if (etxIndex >= 0) {
      result.fields.push(makeField("ETX", etxIndex, 1, bytes,
        bytes[etxIndex] === ETX ? "電文終了 03H" : `${hexByte(bytes[etxIndex])}（ETXではありません）`,
        bytes[etxIndex] === ETX ? STATUS.OK : STATUS.ERROR));
      if (bytes[etxIndex] !== ETX) result.problems.push("ETX(03H)の位置が不正です");
    }

    let expectedBcc = null;
    try { expectedBcc = NoncontactKey.calcBCC(bytes.slice(0, -1)); } catch (_error) { expectedBcc = null; }
    const bccByte = bytes[length - 1];
    const bccOk = NoncontactKey.verifyBCC(bytes);
    result.fields.push(makeField("BCC", length - 1, 1, bytes,
      bccOk ? `${hexByte(bccByte)} 一致` : `${hexByte(bccByte)}（計算値 ${expectedBcc == null ? "算出不可" : hexByte(expectedBcc)}）`,
      bccOk ? STATUS.OK : STATUS.ERROR, "STXの次からETXまでのXOR"));
    if (!bccOk) result.problems.push("BCCが一致しません");

    result.parsed = {
      format: withPerson ? NoncontactKey.FORMAT.WITH_PERSON : NoncontactKey.FORMAT.ROOM_ONLY,
      gateNo, buildingNo, roomNo, personNo,
      roomNo5: buildingText != null && roomText != null ? `${buildingText}${roomText}` : null,
    };
    result.badges.push(badge(knownLength ? NoncontactKey.FORMAT_LABEL[result.parsed.format] : `${length}バイト（仕様外）`, knownLength ? STATUS.INFO : STATUS.ERROR));
    result.badges.push(badge(bccOk ? "BCC一致" : "BCC異常", bccOk ? STATUS.OK : STATUS.ERROR));
    // Q48-006F：受信側はBCC正常でACK、異常でNAKを返す。
    result.expectedResponse = bccOk ? "ACK" : "NAK";
    result.badges.push(badge(`仕様上の応答 ${result.expectedResponse}`, bccOk ? STATUS.OK : STATUS.WARN));

    const finished = finalize(result);
    finished.summary = `ゲート${gateText || "--"} / ${buildingNo ? `${buildingNo}棟 ` : ""}${roomText || "----"}号室${withPerson ? ` / 個人${personNo == null ? "---" : String(personNo).padStart(3, "0")}` : " / 個人番号なし"} / ${finished.valid ? "検証OK" : "検証NG"}`;
    return finished;
  }

  // パナソニックは1画面で4プロトコルを切り替えるため、選択中のプロトコルを
  // 前提に分解する。形式(style)が違うと桁の意味が変わるので入口で振り分ける。
  function inspectPanasonic(bytes, options) {
    const protocolName = options.protocol == null ? PanasonicAlarm.PROTOCOL.HPC : String(options.protocol);
    const info = PanasonicAlarm.protocolInfo(protocolName);
    const result = baseResult("panasonic", bytes);
    result.title = `警報（パナソニック ${info.label}）`;
    result.badges.push(badge(`${info.label}プロトコル`, STATUS.INFO));
    const finished = info.style === PanasonicAlarm.STYLE.BLOCK
      ? inspectPanasonicBlock(result, bytes, protocolName, info)
      : inspectPanasonicRecord(result, bytes, protocolName, info);
    return annotatePanasonicIdentification(finished, bytes, protocolName, options);
  }

  // 選択中のプロトコルが実際の電文と違っていても分かるよう、受信バイト列だけから
  // 成立するプロトコルを判定して結果に添える。アイホンQ49-023GとパナソニックHPC／TSSは
  // 外形が同じなので、メーカーをまたいで候補に入れる。共通の発信種別や警報No.しか
  // 含まない電文は一意に決まらないため、その場合は候補と読みの違いを示す。
  function annotatePanasonicIdentification(result, bytes, selected, options) {
    const identified = AlarmIdentifier.identify(bytes, { aiphonePattern: (options || {}).aiphonePattern });
    const selectedLabel = PanasonicAlarm.protocolInfo(selected).label;
    const notes = [];

    if (identified.targets.length === 0) {
      result.identification = {
        id: null, candidates: [], matchesSelection: false, otherVendor: false,
        text: "アイホン・パナソニックのどの警報プロトコルとしても成立しません",
        notes: [], tone: "warn",
      };
      result.badges.push(badge("判定: 不成立", STATUS.ERROR));
      return result;
    }

    const matchesSelection = identified.candidates.indexOf(selected) !== -1;
    // 一意に決まったときは、同じ形式の他プロトコルを外した理由が決め手になる。
    for (const rejected of identified.rejected) {
      notes.push(`${rejected.target.short}では成立しません：${rejected.reason}`);
    }
    for (const difference of identified.differences) notes.push(difference);

    // この画面で扱えない候補（アイホン）が混じるときは、確認先の画面を案内する。
    const aiphone = identified.targets.some((target) => target.vendor === AlarmIdentifier.VENDOR.AIPHONE);
    if (aiphone) {
      notes.push(identified.target && identified.target.vendor === AlarmIdentifier.VENDOR.AIPHONE
        ? "アイホンの警報電文です。「警報（アイホン）」画面で送受信できます"
        : "アイホンの警報としても成立します。「警報（アイホン）」画面でも読めます");
    }

    const text = identified.target
      ? `${identified.target.label}の電文と判定しました`
      : `${identified.targets.map((target) => target.short).join(" / ")} のいずれとしても成立します（電文だけでは区別できません）`;

    result.identification = {
      id: identified.id,
      candidates: identified.candidates.slice(),
      matchesSelection,
      otherVendor: aiphone,
      text: matchesSelection ? text : `選択中の${selectedLabel}では成立しません。${text}`,
      notes,
      tone: matchesSelection ? "info" : "warn",
    };

    const summary = identified.target ? identified.target.short : identified.targets.map((target) => target.short).join(" / ");
    result.badges.push(badge(`判定: ${summary}`,
      matchesSelection ? (identified.target ? STATUS.OK : STATUS.INFO) : STATUS.WARN));
    return result;
  }

  // HPC／TSS：STX＋データ長37H＋データ7バイト＋ETX＋BCCの11バイト固定。
  function inspectPanasonicBlock(result, bytes, protocolName, info) {
    const length = bytes.length;
    const expected = PanasonicAlarm.BLOCK_LENGTH;
    if (length !== expected) result.problems.push(`電文長が${expected}バイトではありません（${length}バイト）`);

    result.fields.push(makeField("STX", 0, 1, bytes,
      bytes[0] === STX ? "電文開始 02H" : `${hexByte(bytes[0])}（STXではありません）`,
      bytes[0] === STX ? STATUS.OK : STATUS.ERROR));
    if (length >= 1 && bytes[0] !== STX) result.problems.push("先頭がSTX(02H)ではありません");

    const sizeOk = bytes[1] === PanasonicAlarm.SIZE;
    result.fields.push(makeField("データ長", 1, 1, bytes,
      sizeOk ? "37H（データ部7バイト）" : `${hexByte(bytes[1])}（37Hではありません）`,
      sizeOk ? STATUS.OK : STATUS.ERROR, "37H固定"));
    if (length >= 2 && !sizeOk) result.problems.push("データ長が37Hではありません");

    let typeEntry = null;
    try { typeEntry = PanasonicAlarm.findBlockType(protocolName, bytes[2]); } catch (_error) { typeEntry = null; }
    result.fields.push(makeField("発信種別", 2, 1, bytes,
      typeEntry ? `${hexByte(bytes[2])} ${typeEntry.label}` : `${hexByte(bytes[2])}（${info.label}に該当なし）`,
      typeEntry ? STATUS.OK : STATUS.ERROR, "データ1"));
    if (length >= 3 && !typeEntry) result.problems.push(`発信種別 ${hexByte(bytes[2])} は${info.label}の一覧にありません`);

    let detail = null;
    if (typeEntry && length >= 4) {
      detail = PanasonicAlarm.describeInfo(protocolName, typeEntry.code, bytes[3]);
      const zeroViolation = detail.fixedZero && bytes[3] !== 0;
      result.fields.push(makeField("警報情報", 3, 1, bytes,
        zeroViolation ? `${hexByte(bytes[3])}（${typeEntry.label}は00H固定）` : `${hexByte(bytes[3])} ${detail.summary}`,
        zeroViolation ? STATUS.ERROR : detail.violations.length ? STATUS.WARN : STATUS.OK, "データ2"));
      if (zeroViolation) result.problems.push(`${typeEntry.label}の警報情報は00H固定です`);
      if (detail.violations.length) {
        result.warnings.push(`bit${detail.violations.join("・")}は${info.label}の${typeEntry.label}では予備です`);
      }
    } else {
      result.fields.push(makeField("警報情報", 3, 1, bytes, hexByte(bytes[3]), STATUS.INFO, "データ2"));
    }

    let buildingNo = null;
    const buildingByte = bytes[4];
    const buildingReserved = buildingByte != null && buildingByte > 0x63;
    if (buildingByte != null && !buildingReserved) buildingNo = buildingByte;
    result.fields.push(makeField("棟番号", 4, 1, bytes,
      buildingByte == null ? "—"
        : buildingReserved ? `${hexByte(buildingByte)}（64H以降は予備）`
          : buildingNo === 0 ? "00H（単独棟設定:有り／要求時）" : `${buildingNo}棟`,
      buildingReserved ? STATUS.ERROR : STATUS.OK, "データ3／00H～63H"));
    if (buildingReserved) result.problems.push(`棟番号 ${hexByte(buildingByte)} は予備領域です`);

    let dwelling = null;
    if (length >= 9) {
      try { dwelling = PanasonicAlarm.decodeDwelling(bytes.slice(5, 9)); } catch (_error) { dwelling = null; }
    }
    const historyLabel = dwelling == null ? ""
      : dwelling.historyNumber === 0 ? "（イベント通知／要求）" : `（ヒストリー${dwelling.historyNumber}の応答）`;
    result.fields.push(makeField("住戸番号", 5, 4, bytes,
      dwelling == null ? "BCDとして読み取れません" : `${String(dwelling.roomNo).padStart(4, "0")}号室${historyLabel}`,
      dwelling == null ? STATUS.ERROR : STATUS.OK, "データ4～7／上位4bitはヒストリー種別"));
    if (length >= 9 && dwelling == null) result.problems.push("住戸番号がBCDではありません");
    if (dwelling && dwelling.historyNumber !== 0 && !info.history) {
      result.problems.push(`${info.label}プロトコルにヒストリー応答はありません`);
    }

    const etxIndex = expected - 2;
    result.fields.push(makeField("ETX", etxIndex, 1, bytes,
      bytes[etxIndex] === ETX ? "電文終了 03H" : `${hexByte(bytes[etxIndex])}（ETXではありません）`,
      bytes[etxIndex] === ETX ? STATUS.OK : STATUS.ERROR));
    if (length > etxIndex && bytes[etxIndex] !== ETX) result.problems.push("ETX(03H)の位置が不正です");

    let expectedBcc = null;
    try { expectedBcc = PanasonicAlarm.calculateBCC(bytes.slice(0, expected - 1)); } catch (_error) { expectedBcc = null; }
    const bccOk = length === expected && PanasonicAlarm.verifyBCC(bytes);
    result.fields.push(makeField("BCC", expected - 1, 1, bytes,
      bccOk ? `${hexByte(bytes[expected - 1])} 一致` : `${hexByte(bytes[expected - 1])}（計算値 ${expectedBcc == null ? "算出不可" : hexByte(expectedBcc)}）`,
      bccOk ? STATUS.OK : STATUS.ERROR, "STXの次からETXまでの加算"));
    if (!bccOk) result.problems.push("BCCが一致しません");

    result.parsed = {
      protocol: protocolName,
      type: typeEntry ? typeEntry.code : null,
      typeLabel: typeEntry ? typeEntry.label : null,
      info: bytes[3] == null ? null : bytes[3],
      buildingNo,
      roomNo: dwelling ? dwelling.roomNo : null,
      historyNumber: dwelling ? dwelling.historyNumber : null,
    };
    result.badges.push(badge(bccOk ? "BCC一致" : "BCC異常", bccOk ? STATUS.OK : STATUS.ERROR));
    if (typeEntry && typeEntry.request) result.badges.push(badge("要求電文", STATUS.INFO));
    // ENQ–ACK–TEXT–ACKの手順上、受信側は検証結果でACK／NAKを返す。
    result.expectedResponse = result.problems.length === 0 ? "ACK" : "NAK";
    result.badges.push(badge(`仕様上の応答 ${result.expectedResponse}`, result.problems.length === 0 ? STATUS.OK : STATUS.WARN));

    const finished = finalize(result);
    finished.summary = `${typeEntry ? typeEntry.label : "不明な発信種別"} / ${buildingNo == null ? "--" : `${buildingNo}棟`} ${dwelling ? String(dwelling.roomNo).padStart(4, "0") : "----"}号室${detail && !detail.fixedZero ? ` / ${detail.summary}` : ""} / ${finished.valid ? "検証OK" : "検証NG"}`;
    return finished;
  }

  // 大興／リモート："SND"／"TRS"／"NG"で始まりCRで終わるASCIIレコード列。
  function inspectPanasonicRecord(result, bytes, protocolName, info) {
    const length = bytes.length;
    const text = printable(bytes);
    if (length === 0) {
      result.problems.push("受信データがありません");
      return finalize(result);
    }

    const crOk = bytes[length - 1] === PanasonicAlarm.CODE.CR;
    if (!crOk) result.problems.push("電文がCR(0DH)で終わっていません");

    let parsed = null;
    let failure = null;
    try { parsed = PanasonicAlarm.parseRecordFrame(bytes, { protocol: protocolName }); } catch (error) { failure = String(error && error.message || error); }
    if (failure) result.problems.push(failure);

    const kind = parsed ? parsed.kind : text.startsWith("NG") ? "nak" : text.startsWith("TRS") ? "scheduled" : "alarm";
    const headLength = kind === "nak" ? 2 : 3;
    const head = text.slice(0, headLength);
    const headLabel = kind === "nak" ? "NAKアンサーバック"
      : kind === "ack" ? `${head} ACKアンサーバック`
        : kind === "scheduled" ? "TRS 定時送信"
          : "SND 警報データ";
    result.fields.push(makeField("ヘッダ", 0, headLength, bytes, `${head}（${headLabel}）`,
      /^(SND|TRS|NG)$/.test(head) ? STATUS.OK : STATUS.ERROR, "送信スタート信号"));
    if (!/^(SND|TRS|NG)$/.test(head)) result.problems.push("ヘッダがSND／TRS／NGではありません");

    let offset = headLength;
    if (kind === "alarm" && parsed) {
      parsed.records.forEach((record, index) => {
        const label = `${record.mode}（${record.modeLabel}） / ${String(record.buildingNo).padStart(2, "0")}棟 ${String(record.roomNo).padStart(4, "0")}号室 / 警報No.${String(record.alarmNo).padStart(2, "0")} ${record.alarmLabel || "別表に該当なし"}`;
        result.fields.push(makeField(`レコード${index + 1}`, offset, PanasonicAlarm.RECORD_LENGTH, bytes, label,
          record.known ? STATUS.OK : STATUS.WARN, "モード＋棟2桁＋住戸4桁＋警報No.2桁＋ETX"));
        if (!record.known) result.warnings.push(`警報No.${String(record.alarmNo).padStart(2, "0")}は${info.label}の別表にありません`);
        offset += PanasonicAlarm.RECORD_LENGTH;
      });
    } else if (kind === "ack") {
      result.fields.push(makeField("応答", offset, 2, bytes, "OK（正常受信）", STATUS.OK));
      offset += 2;
    } else if (kind === "scheduled" && parsed) {
      const payloadLength = 2 + parsed.propertyCode.length + 1;
      result.fields.push(makeField("定時送信データ", offset, payloadLength, bytes,
        `${PanasonicAlarm.SCHEDULED_MARK} + 物件コード「${parsed.propertyCode}」+ ETX`, STATUS.OK,
        "物件コードはリモート送信機で設定。IFUでは使用／参照しない"));
      offset += payloadLength;
    } else if (kind !== "nak") {
      // 解析に失敗しても、読み取れた範囲は必ず残す。
      const rest = Math.max(length - offset - (crOk ? 1 : 0), 0);
      if (rest > 0) result.fields.push(makeField("データ", offset, rest, bytes, printable(bytes.slice(offset, offset + rest)), STATUS.WARN, "仕様のレコードへ割り付けられませんでした"));
      offset += rest;
    }

    if (kind !== "nak" && parsed) {
      const received = text.slice(offset, offset + 4);
      result.fields.push(makeField("チェックサム", offset, 4, bytes, `${received} 一致`, STATUS.OK,
        kind === "scheduled" ? "［!］～［ETX］のASCII加算" : "モードから最後のETXまでのASCII加算"));
      offset += 4;
    }

    if (crOk) result.fields.push(makeField("CR", length - 1, 1, bytes, "送信データ終了 0DH", STATUS.OK));

    result.parsed = parsed;
    result.badges.push(badge(headLabel, kind === "nak" ? STATUS.WARN : STATUS.INFO));
    if (parsed && kind === "alarm") result.badges.push(badge(`${parsed.recordCount}／${PanasonicAlarm.MAX_RECORDS}レコード`, STATUS.INFO));
    // 警報データと定時送信にはアンサーバックを返す。ACK／NAK自体には返さない。
    if (kind === "alarm" || kind === "scheduled") {
      result.expectedResponse = result.problems.length === 0 ? "ACK" : "NAK";
      result.badges.push(badge(`仕様上の応答 ${result.expectedResponse}`, result.problems.length === 0 ? STATUS.OK : STATUS.WARN));
    }

    const finished = finalize(result);
    finished.summary = kind === "nak" ? "NAKアンサーバック（再送が必要）"
      : kind === "ack" ? `${head} ACKアンサーバック（正常受信）`
        : kind === "scheduled" ? `定時送信 / 物件コード ${parsed ? parsed.propertyCode : "--"} / ${finished.valid ? "検証OK" : "検証NG"}`
          : `警報データ ${parsed ? parsed.recordCount : 0}件 / ${finished.valid ? "検証OK" : "検証NG"}`;
    return finished;
  }

  // パナソニックのエレベータ連動：18byte固定。付加コードによって住戸を特定できるかが
  // 変わり、使えない桁は仕様上0固定なので、値が入っていれば仕様違反として示す。
  function inspectPanasonicElevator(bytes, options) {
    const P = PanasonicElevator;
    const result = baseResult("panasonicElevator", bytes);
    const length = bytes.length;
    if (length !== P.FRAME_LENGTH) result.problems.push(`電文長が${P.FRAME_LENGTH}バイトではありません（${length}バイト）`);

    result.fields.push(makeField("STX", P.FIELD.STX.offset, 1, bytes,
      bytes[0] === P.CODE.STX ? "電文開始 02H" : `${hexByte(bytes[0])}（STXではありません）`,
      bytes[0] === P.CODE.STX ? STATUS.OK : STATUS.ERROR));
    if (length >= 1 && bytes[0] !== P.CODE.STX) result.problems.push("先頭がSTX(02H)ではありません");

    const commandText = printable(bytes.slice(P.FIELD.COMMAND.offset, P.FIELD.COMMAND.offset + P.FIELD.COMMAND.length));
    let entry = null;
    try { entry = P.findCommand(commandText); } catch (_error) { entry = null; }
    result.fields.push(makeField("CMD", P.FIELD.COMMAND.offset, P.FIELD.COMMAND.length, bytes,
      entry ? `${entry.code} ${entry.label}` : `${commandText}（コマンド表にありません）`,
      entry ? STATUS.OK : STATUS.ERROR, "コマンド表"));
    if (length > P.FIELD.COMMAND.offset && !entry) result.problems.push(`コマンド${commandText}は仕様のコマンド表にありません`);

    const spare = bytes[P.FIELD.SPARE.offset];
    result.fields.push(makeField("予備", P.FIELD.SPARE.offset, 1, bytes,
      spare === P.CODE.SPACE ? "20H（スペース）" : `${hexByte(spare)}（20Hではありません）`,
      spare === P.CODE.SPACE ? STATUS.OK : STATUS.ERROR, "20H固定"));
    if (length > P.FIELD.SPARE.offset && spare !== P.CODE.SPACE) result.problems.push("予備が20H（スペース）ではありません");

    const mode = printable(bytes.slice(P.FIELD.MODE.offset, P.FIELD.MODE.offset + 1));
    result.fields.push(makeField("モード", P.FIELD.MODE.offset, 1, bytes,
      mode === P.MODE ? P.MODE : `${mode}（${P.MODE}ではありません）`,
      mode === P.MODE ? STATUS.OK : STATUS.ERROR, `${P.MODE}固定`));
    if (length > P.FIELD.MODE.offset && mode !== P.MODE) result.problems.push(`モードが${P.MODE}ではありません`);

    const extraText = printable(bytes.slice(P.FIELD.EXTRA.offset, P.FIELD.EXTRA.offset + P.FIELD.EXTRA.length));
    const matchedExtra = entry ? P.findExtra(entry, extraText) : null;
    const usage = entry ? P.fieldUsage(entry, extraText) : { building: true, room: true, lb: true, extra: null };
    const usageLabel = matchedExtra ? matchedExtra.label : (entry ? entry.label : "この電文");

    const buildingText = digits(bytes.slice(P.FIELD.BUILDING.offset, P.FIELD.BUILDING.offset + P.FIELD.BUILDING.length));
    const buildingNo = buildingText == null ? null : Number(buildingText);
    const buildingUnused = entry != null && !usage.building && buildingNo != null && buildingNo !== 0;
    result.fields.push(makeField("棟番号", P.FIELD.BUILDING.offset, P.FIELD.BUILDING.length, bytes,
      buildingText == null ? "2桁の数字ではありません"
        : buildingUnused ? `${buildingText}（この電文では00固定）`
          : buildingNo === 0 ? "00（指定なし）" : `${buildingNo}棟`,
      buildingText == null || buildingUnused ? STATUS.ERROR : STATUS.OK));
    if (buildingText == null && length >= P.FIELD.BUILDING.offset + P.FIELD.BUILDING.length) {
      result.problems.push("棟番号が2桁の数字ではありません");
    }
    if (buildingUnused) result.problems.push(`${usageLabel}の棟番号は00固定です`);

    const roomText = digits(bytes.slice(P.FIELD.ROOM.offset, P.FIELD.ROOM.offset + P.FIELD.ROOM.length));
    const roomNo = roomText == null ? null : Number(roomText);
    const roomUnused = entry != null && !usage.room && roomNo != null && roomNo !== 0;
    result.fields.push(makeField("住戸番号", P.FIELD.ROOM.offset, P.FIELD.ROOM.length, bytes,
      roomText == null ? "4桁の数字ではありません"
        : roomUnused ? `${roomText}（この電文では0000固定）`
          : roomNo === 0 ? "0000（指定なし）" : `${roomText}（${roomNo}号室）`,
      roomText == null || roomUnused ? STATUS.ERROR : STATUS.OK));
    if (roomText == null && length >= P.FIELD.ROOM.offset + P.FIELD.ROOM.length) {
      result.problems.push("住戸番号が4桁の数字ではありません");
    }
    if (roomUnused) result.problems.push(`${usageLabel}の住戸番号は0000固定です`);

    const lbText = digits(bytes.slice(P.FIELD.LB.offset, P.FIELD.LB.offset + P.FIELD.LB.length));
    const lbNo = lbText == null ? null : Number(lbText);
    const lbUnused = entry != null && !usage.lb && lbNo != null && lbNo !== 0;
    result.fields.push(makeField("LB番号", P.FIELD.LB.offset, P.FIELD.LB.length, bytes,
      lbText == null ? "2桁の数字ではありません"
        : lbUnused ? `${lbText}（この電文では00固定）`
          : lbNo === 0 ? "00（指定なし）" : `${lbText}番`,
      lbText == null || lbUnused ? STATUS.ERROR : STATUS.OK));
    if (lbText == null && length >= P.FIELD.LB.offset + P.FIELD.LB.length) {
      result.problems.push("LB番号が2桁の数字ではありません");
    }
    if (lbUnused) result.problems.push(`${usageLabel}のLB番号は00固定です`);

    const extraKnown = entry == null || entry.extras == null || matchedExtra != null;
    result.fields.push(makeField("付加コード", P.FIELD.EXTRA.offset, P.FIELD.EXTRA.length, bytes,
      matchedExtra ? `${extraText} ${matchedExtra.label}`
        : extraKnown ? extraText : `${extraText}（${entry.code}にこの付加コードはありません）`,
      extraKnown ? STATUS.OK : STATUS.ERROR));
    if (!extraKnown) result.problems.push(`${entry.code}に付加コード${extraText}はありません`);

    result.fields.push(makeField("ETX", P.FIELD.ETX.offset, 1, bytes,
      bytes[P.FIELD.ETX.offset] === P.CODE.ETX ? "電文終了 03H" : `${hexByte(bytes[P.FIELD.ETX.offset])}（ETXではありません）`,
      bytes[P.FIELD.ETX.offset] === P.CODE.ETX ? STATUS.OK : STATUS.ERROR));
    if (length > P.FIELD.ETX.offset && bytes[P.FIELD.ETX.offset] !== P.CODE.ETX) result.problems.push("ETX(03H)の位置が不正です");

    let expectedBcc = null;
    try { expectedBcc = printable(P.calculateBCC(bytes.slice(0, P.FIELD.BCC.offset))); } catch (_error) { expectedBcc = null; }
    const bccOk = length === P.FRAME_LENGTH && P.verifyBCC(bytes);
    const bccText = printable(bytes.slice(P.FIELD.BCC.offset, P.FIELD.BCC.offset + P.FIELD.BCC.length));
    result.fields.push(makeField("BCC", P.FIELD.BCC.offset, P.FIELD.BCC.length, bytes,
      bccOk ? `${bccText} 一致` : `${bccText}（計算値 ${expectedBcc == null ? "算出不可" : expectedBcc}）`,
      bccOk ? STATUS.OK : STATUS.ERROR, "CMDからETXまでの総和を16進2文字で表記"));
    if (!bccOk) result.problems.push("BCCが一致しません");

    // 方向は電文自身が決める。選択中の動作側と食い違うときは注意として示す。
    if (entry && options.direction != null && entry.direction !== options.direction) {
      result.warnings.push(`${entry.code}は${entry.direction === P.DIRECTION.TO_ELEVATOR ? "IFU→エレベータ" : "エレベータ→IFU"}の電文です`);
    }

    result.parsed = {
      command: entry ? entry.code : null,
      commandLabel: entry ? entry.label : null,
      direction: entry ? entry.direction : null,
      buildingNo, roomNo, lbNo,
      extraCode: extraText,
      extraLabel: matchedExtra ? matchedExtra.label : null,
    };
    result.badges.push(badge(entry ? entry.label : "コマンド不明", entry ? STATUS.INFO : STATUS.ERROR));
    result.badges.push(badge(bccOk ? "BCC一致" : "BCC異常", bccOk ? STATUS.OK : STATUS.ERROR));
    // 正常応答はACK(10H/30H)だけで、NAKは仕様にない。異常時は無応答で相手の再送を待つ。
    result.expectedResponse = result.problems.length === 0 ? "ACK" : "無応答（再送待ち）";
    result.badges.push(badge(`仕様上の応答 ${result.expectedResponse}`, result.problems.length === 0 ? STATUS.OK : STATUS.WARN));

    const finished = finalize(result);
    finished.summary = `${entry ? entry.label : "不明なコマンド"}`
      + `${matchedExtra && entry && entry.extras.length > 1 ? ` / ${matchedExtra.label}` : ""}`
      + ` / ${buildingNo == null ? "--" : `${buildingNo}棟`} ${roomText || "----"}号室`
      + `${lbNo ? ` / LB${lbText}` : ""} / ${finished.valid ? "検証OK" : "検証NG"}`;
    return finished;
  }

  const HANDLERS = Object.freeze({
    locker4: inspectLocker4,
    locker2: inspectLocker2,
    key: inspectKey,
    panasonic: inspectPanasonic,
    panasonicElevator: inspectPanasonicElevator,
  });

  function supports(profile) {
    return Object.prototype.hasOwnProperty.call(HANDLERS, profile);
  }

  function inspect(profile, input, options) {
    const bytes = toBytes(input);
    const key = String(profile == null ? "" : profile);
    if (!supports(key)) {
      const result = baseResult(key, bytes);
      result.title = "受信解析の対象外";
      result.summary = `${key || "指定なし"} は受信内容の分解表示に対応していません`;
      result.problems.push("受信解析に未対応のプロファイルです");
      result.fields = rawDumpFields(bytes);
      return finalize(result);
    }
    try {
      return HANDLERS[key](bytes, options || {});
    } catch (error) {
      const result = baseResult(key, bytes);
      result.summary = `解析中に例外が発生しました（${bytes.length}バイト）`;
      result.problems.push(String(error && error.message || error));
      result.fields = rawDumpFields(bytes);
      return finalize(result);
    }
  }

  // フレーム境界の検出段階で失敗した受信データも、同じ枠組みで表示できるようにする。
  function errorResult(profile, input, message) {
    const bytes = toBytes(input);
    const key = String(profile == null ? "" : profile);
    const result = baseResult(key, bytes);
    result.title = `${PROFILE_TITLE[key] || key} 受信エラー`;
    result.summary = `${message || "受信データを解釈できません"}（${bytes.length}バイト）`;
    result.problems.push(message || "受信データを解釈できません");
    result.badges.push(badge("フレーム不成立", STATUS.ERROR));
    result.fields = bytes.length ? rawDumpFields(bytes) : [];
    return finalize(result);
  }

  return Object.freeze({
    STATUS,
    PROFILE_TITLE,
    PROFILES: Object.freeze(Object.keys(HANDLERS)),
    supports,
    inspect,
    errorResult,
    toHex: hex,
    toAscii: printable,
  });
});
