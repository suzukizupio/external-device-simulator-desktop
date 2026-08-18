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
      require("./noncontact-key.js")
    );
  } else {
    root.ReceiveInspector = factory(root.Telegram2, root.Telegram4, root.NoncontactKey);
  }
})(typeof window !== "undefined" ? window : globalThis, function (Telegram2, Telegram4, NoncontactKey) {
  "use strict";

  if (!Telegram2 || !Telegram4 || !NoncontactKey) {
    throw new Error("ReceiveInspector requires Telegram2, Telegram4 and NoncontactKey");
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

  const HANDLERS = Object.freeze({
    locker4: inspectLocker4,
    locker2: inspectLocker2,
    key: inspectKey,
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
