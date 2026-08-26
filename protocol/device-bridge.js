// 宅配ボックス4線式・非接触キーの電文を、マンションコントローラの電文へ読み替える。
//   Q48-005F 宅配ボックス4線式(B方式) → Q48-008I 6.7 宅配ボックス制御(36H)
//   Q48-006F 非接触キー              → Q48-008I 6.8 非接触キー制御(37H)
//
// 警報のメーカー間変換と違い、こちらは対応する枠が Q48-008I 側に定義されている。
// 非接触キーはゲート番号・住戸・個人番号がそのまま 37H のフィールドへ収まる。
// 宅配ボックスはボックス状態識別(STS)へ読み替えるが、Q48-008Iが持つのは
// 取出し／着荷／滞留の3状態だけで、Q48-005Fの集荷・食配・書留・宅配ロボには
// 対応する状態がない。送れないものは理由を付けて必ず報告する。
// Browser: window.DeviceBridge / Node: require("./protocol/device-bridge.js")
(function (root, factory) {
  "use strict";
  if (typeof module !== "undefined" && module.exports) {
    module.exports = factory(
      require("./locker4.js"),
      require("./noncontact-key.js"),
      require("./mansion-controller.js")
    );
  } else {
    root.DeviceBridge = factory(root.Telegram4, root.NoncontactKey, root.MansionController);
  }
})(typeof window !== "undefined" ? window : globalThis, function (Telegram4, NoncontactKey, MansionController) {
  "use strict";

  if (!Telegram4 || !NoncontactKey || !MansionController) {
    throw new Error("DeviceBridge requires Telegram4, NoncontactKey and MansionController");
  }

  const SOURCE = Object.freeze({ LOCKER4: "locker4", KEY: "key" });
  const SOURCE_LABEL = Object.freeze({
    [SOURCE.LOCKER4]: "宅配ボックス 4線式(B方式)",
    [SOURCE.KEY]: "非接触キー",
  });

  // Q48-005F のロッカー状態 → Q48-008I 6.7 のボックス状態識別。
  // 値も意味も一致するのは「荷物なし＝取出し」「荷物あり＝着荷」の2つだけ。
  const BOX_STATUS = Object.freeze({
    [Telegram4.STATE.EMPTY]: 0x30,   // 荷物なし → 取出し状態
    [Telegram4.STATE.PARCEL]: 0x31,  // 荷物あり → 着荷状態
  });
  const BOX_STATUS_LABEL = Object.freeze({ 0x30: "取出し状態", 0x31: "着荷状態", 0x32: "滞留状態" });

  function stateLabel(state) {
    return Telegram4.STATE_LABEL[state] || `状態${state.toString(16).toUpperCase()}H`;
  }

  function asciiBytes(text) {
    return Array.from(String(text), function (character) { return character.charCodeAt(0); });
  }

  // 装置側の棟番号（0～9）をQ48-008IのADDRへ載せる。棟番号なし(0)は標準システムの
  // 「BB」、1以上は多棟システムの棟コードになるため、構成も合わせて決める。
  function addressOf(buildingNo, roomNo, options) {
    const opts = options || {};
    const multi = buildingNo > 0;
    const address = MansionController.address.residence({
      building: multi ? buildingNo : "BB",
      room: roomNo,
      version: opts.version,
      topology: multi ? "multi-building" : "standard",
      vixusAdvance: opts.vixusAdvance === true,
    });
    return { text: address, bytes: asciiBytes(address), topology: multi ? "multi-building" : "standard" };
  }

  function resolveSource(value) {
    const name = String(value == null ? "" : value);
    if (name !== SOURCE.LOCKER4 && name !== SOURCE.KEY) {
      throw new RangeError("変換元は宅配4線式か非接触キーで指定してください");
    }
    return name;
  }

  // ------------------------------------------------------------------
  // 非接触キー → 6.8 非接触キー制御(37H)
  // ------------------------------------------------------------------

  function convertKey(frame, options) {
    const opts = options || {};
    const parsed = NoncontactKey.parseTelegram(frame);
    const notes = [];
    // 個人番号を持つ13byte形式はキー情報-2(62H)、10byte形式はキー情報-1(61H)。
    const command = parsed.personNo == null ? 0x61 : 0x62;
    const commandLabel = command === 0x61 ? "ICキー情報-1" : "ICキー情報-2";
    const address = addressOf(parsed.buildingNo, parsed.roomNo, opts);
    const values = { "ゲート": parsed.gateNo, "ADDR": address.bytes };
    if (command === 0x62) values["個人"] = parsed.personNo;

    const message = MansionController.buildMessage(0x37, command, { version: opts.version, values: values });
    const built = MansionController.buildFrame({
      kind: 0x37, command: command, message: message, version: opts.version, from: "IC",
    });
    if (parsed.buildingNo > 0) {
      notes.push(`棟番号${parsed.buildingNo}のため、多棟システムのADDR「${address.text}」として送ります`);
    }
    return {
      frames: [built],
      records: [{
        label: `ゲート${String(parsed.gateNo).padStart(2, "0")} / ${address.text}`
          + `${parsed.personNo == null ? "" : ` / 個人${String(parsed.personNo).padStart(3, "0")}`}`,
        command: command,
        commandLabel: commandLabel,
        address: address.text,
      }],
      dropped: [],
      notes: notes,
      summary: `${commandLabel}（ゲート${String(parsed.gateNo).padStart(2, "0")} / ${address.text}`
        + `${parsed.personNo == null ? "" : ` / 個人${String(parsed.personNo).padStart(3, "0")}`}）`,
    };
  }

  // ------------------------------------------------------------------
  // 宅配ボックス4線式 → 6.7 宅配ボックス制御(36H)
  // ------------------------------------------------------------------

  // ロッカー状態をQ48-008I 6.7のボックス情報詳細へ読み替える。
  // 送れないものは理由を添えて dropped へ回す。
  function boxRecords(lockers, options) {
    const opts = options || {};
    const records = [];
    const dropped = [];
    for (const locker of lockers) {
      const status = BOX_STATUS[locker.state];
      if (status == null) {
        dropped.push({
          lockerNo: locker.lockerNo,
          state: locker.state,
          label: stateLabel(locker.state),
          reason: "Q48-008Iのボックス状態識別（取出し／着荷／滞留）に対応する値がありません",
        });
        continue;
      }
      if (locker.roomNo === 0) {
        dropped.push({
          lockerNo: locker.lockerNo,
          state: locker.state,
          label: stateLabel(locker.state),
          reason: "住戸番号が0000のため、住戸ADDRを組み立てられません",
        });
        continue;
      }
      const address = addressOf(locker.buildingNo, locker.roomNo, opts);
      records.push({
        lockerNo: locker.lockerNo,
        status: status,
        statusLabel: BOX_STATUS_LABEL[status],
        stateLabel: stateLabel(locker.state),
        address: address.text,
        addressBytes: address.bytes,
        label: `ロッカー${String(locker.lockerNo).padStart(3, "0")} / ${BOX_STATUS_LABEL[status]} / ${address.text}`,
      });
    }
    return { records: records, dropped: dropped };
  }

  // 1パケット1件で組み立て、残PKTで残数を示す（Q48-008I 6.7）。
  // ICボックス情報(43H)はボックスNOを持たず、MCボックス情報(41H)は持つ。
  function boxInfoFrames(records, options) {
    const opts = options || {};
    const role = opts.role === "MC" ? "MC" : "IC";
    const command = role === "MC" ? 0x41 : 0x43;
    return records.map(function (record, index) {
      const values = {
        "残PKT": records.length - index - 1,
        "PKT NO": 0x31,
        "STS": record.status,
        "ADDR": record.addressBytes,
      };
      if (command === 0x41) values["ボックスNO"] = record.lockerNo;
      const message = MansionController.buildMessage(0x36, command, { version: opts.version, values: values });
      return MansionController.buildFrame({
        kind: 0x36, command: command, message: message, version: opts.version, from: role,
      });
    });
  }
  function convertLocker4(frame, options) {
    const opts = options || {};
    const parsed = Telegram4.parseTelegram(frame);
    if (parsed.type !== "response") throw new Error("ロッカー情報を持つ情報応答／変化通知だけを変換できます");
    if (parsed.lockers.length === 0) throw new Error("ロッカーデータがありません");

    const converted = boxRecords(parsed.lockers, opts);
    const records = converted.records;
    const dropped = converted.dropped;
    const frames = boxInfoFrames(records, opts);
    const notes = [];

    for (const item of dropped) {
      notes.push(`ロッカー${String(item.lockerNo).padStart(3, "0")}の「${item.label}」は送れません：${item.reason}`);
    }
    if (records.length > 1) {
      notes.push(`${records.length}件のロッカー情報を、1件ずつ${records.length}電文へ分けて送ります（残PKTで残数を示します）`);
    }
    return {
      frames: frames,
      records: records,
      dropped: dropped,
      notes: notes,
      summary: `ICボックス情報 ${records.length}件`
        + `${dropped.length ? `（${dropped.length}件は送れません）` : ""}`,
    };
  }

  function convert(frame, options) {
    const opts = options || {};
    const source = resolveSource(opts.from);
    const result = source === SOURCE.KEY ? convertKey(frame, opts) : convertLocker4(frame, opts);
    return Object.assign({
      from: source,
      fromLabel: SOURCE_LABEL[source],
      to: "mansion",
      toLabel: "マンションコントローラ Q48-008I",
      complete: result.dropped.length === 0 && result.frames.length > 0,
    }, result);
  }

  // 画面へ出すための対応表。
  function mappingTable(source) {
    const name = resolveSource(source);
    if (name === SOURCE.KEY) {
      return [
        { from: "ゲートNo（2桁）", to: "6.8 ゲート番号（2byte）", note: "01～99をそのまま載せます" },
        { from: "棟番号（1桁）＋部屋番号（4桁）", to: "6.8 ADDR（6byte）", note: "棟0は標準システムのBB、棟1～9は多棟システムのB1～B9" },
        { from: "個人番号（3桁）", to: "6.8 個人番号（3byte）", note: "13byte形式のみ。10byte形式はキー情報-1(61H)で送ります" },
      ];
    }
    return [
      { from: "状態 30H 荷物なし", to: "6.7 STS 30H 取出し状態", note: "" },
      { from: "状態 31H 荷物あり", to: "6.7 STS 31H 着荷状態", note: "" },
      { from: "状態 32H 集荷預り", to: "（対応なし）", note: "Q48-008Iの滞留状態とは意味が異なるため変換しません" },
      { from: "状態 33H～35H・40H～42H", to: "（対応なし）", note: "集荷回収・食配・書留・宅配ロボに対応する状態がありません" },
      { from: "棟NO（1桁）＋住戸NO（4桁）", to: "6.7 ADDR（6byte）", note: "棟0は標準システムのBB、棟1～9は多棟システムのB1～B9" },
      { from: "ロッカーNO（3桁）", to: "（ICボックス情報では送りません）", note: "43Hはボックス番号を持ちません（41Hにはあります）" },
    ];
  }

  return Object.freeze({
    SOURCE: SOURCE,
    SOURCE_LABEL: SOURCE_LABEL,
    BOX_STATUS: BOX_STATUS,
    BOX_STATUS_LABEL: BOX_STATUS_LABEL,
    addressOf: addressOf,
    boxRecords: boxRecords,
    boxInfoFrames: boxInfoFrames,
    convert: convert,
    mappingTable: mappingTable,
  });
});
