// 警報電文をメーカー間で読み替える変換ブリッジ。
//   アイホン Q49-023G ←→ パナソニック HPC／TSS／大興／リモート
//
// 【重要】この対応付けは通信仕様書に書かれていない。各仕様書が定める警報名
// （火災・非常・ガス漏れ…）が一致することだけを根拠に、こちらで決めた変換表である。
// そのため次の方針で扱う。
//   ・変換できた項目と、相手側に対応する枠がなく落とした項目を必ず両方報告する
//   ・1つのビットに複数の意味がまとめられている桁（アイホンの「ガス障害、火災障害」、
//     HPCの「水漏れ／コール」）は、取りこぼしを避けるため対応する全ての枠を立て、
//     その旨を注記として残す
//   ・発報元が住戸以外（管理室・集合玄関・共用部）の電文は、パナソニック側に
//     受け皿がないため変換しない
// Browser: window.AlarmBridge / Node: require("./protocol/alarm-bridge.js")
(function (root, factory) {
  "use strict";
  if (typeof module !== "undefined" && module.exports) {
    module.exports = factory(require("./alarm.js"), require("./panasonic-alarm.js"), require("./alarm-identifier.js"));
  } else {
    root.AlarmBridge = factory(root.AlarmProtocol, root.PanasonicAlarm, root.AlarmIdentifier);
  }
})(typeof window !== "undefined" ? window : globalThis, function (AlarmProtocol, PanasonicAlarm, AlarmIdentifier) {
  "use strict";

  if (!AlarmProtocol || !PanasonicAlarm || !AlarmIdentifier) {
    throw new Error("AlarmBridge requires AlarmProtocol, PanasonicAlarm and AlarmIdentifier");
  }

  const AIPHONE = AlarmIdentifier.AIPHONE_ID;

  // 変換の共通語彙。仕様書の警報名をこの語彙へ寄せ、相手側の枠へ配り直す。
  const TERMS = Object.freeze({
    fire: "火災",
    emergency: "非常",
    gas: "ガス漏れ",
    water: "水漏れ",
    call: "コール",
    call1: "コール１", call2: "コール２", call3: "コール３", call4: "コール４",
    co: "CO",
    security: "防犯（代表）",
    security1: "防犯１", security2: "防犯２", security3: "防犯３", security4: "防犯４",
    security5: "防犯５",
    fireFault: "火災回路断",
    gasFault: "ガス機器異常",
    powerFailure: "住戸電源断",
    commFault: "住戸通信異常",
    externalFault: "外部機器異常",
    general: "汎用警報（代表）",
    general1: "汎用警報１", general2: "汎用警報２", general3: "汎用警報３", general4: "汎用警報４",
    securitySet: "警戒設定", securityClear: "警戒解除",
    awayGuard: "外出警戒", homeGuard: "在宅警戒",
    wirelessFault: "ワイヤレス機器異常", wirelessBattery: "ワイヤレス電池切れ",
    deliveryRegister: "宅配登録・削除",
  });

  // 仕様書の警報名 → 共通語彙。複数を指すラベルは配列で持つ。
  const LABEL_TERMS = Object.freeze({
    "火災": ["fire"],
    "火災、遠隔試験": ["fire"],
    "非常": ["emergency"],
    "ガス": ["gas"],
    "ガス漏れ": ["gas"],
    "水漏れ": ["water"],
    "コール": ["call"],
    // 1つの桁に2つの意味がまとめられている。取りこぼさないよう両方へ配る。
    "水漏れ／コール": ["water", "call"],
    "ガス障害、火災障害": ["gasFault", "fireFault"],
    "コール１": ["call1"], "コール２": ["call2"], "コール３": ["call3"], "コール４": ["call4"],
    "CO": ["co"],
    "防犯(侵入)": ["security"],
    "防犯(代表)": ["security"],
    "防犯１": ["security1"], "防犯２": ["security2"], "防犯３": ["security3"],
    "防犯４": ["security4"], "防犯５": ["security5"],
    "火災回路断": ["fireFault"],
    "火災断線": ["fireFault"],
    "ガス機器異常": ["gasFault"],
    "住戸電源断": ["powerFailure"],
    "住戸通信異常": ["commFault"],
    "外部機器異常": ["externalFault"],
    "汎用警報(代表)": ["general"],
    "汎用警報１": ["general1"], "汎用警報２": ["general2"],
    "汎用警報３": ["general3"], "汎用警報４": ["general4"],
    "警戒設定": ["securitySet"],
    "警戒解除": ["securityClear"],
    "防犯ｾｯﾄ": ["securitySet"],
    "防犯ﾘｾｯﾄ": ["securityClear"],
    "外出警戒": ["awayGuard"], "外出警戒設定": ["awayGuard"], "外出警戒解除": ["awayGuard"],
    "在宅警戒": ["homeGuard"], "在宅警戒設定": ["homeGuard"], "在宅警戒解除": ["homeGuard"],
    "ﾜｲﾔﾚｽ機器異常": ["wirelessFault"], "ﾜｲﾔﾚｽ電池切れ": ["wirelessBattery"],
    "宅配登録･削除": ["deliveryRegister"],
    // セット／リセットは状態変化であり、発報そのものとは別に扱う。
    "防犯(代表)ｾｯﾄ/ﾘｾｯﾄ": ["securitySet"],
    "防犯１ｾｯﾄ/ﾘｾｯﾄ": ["securitySet"], "防犯２ｾｯﾄ/ﾘｾｯﾄ": ["securitySet"],
    "防犯３ｾｯﾄ/ﾘｾｯﾄ": ["securitySet"], "防犯４ｾｯﾄ/ﾘｾｯﾄ": ["securitySet"],
  });

  function termsOfLabel(label) {
    if (label == null) return [];
    return LABEL_TERMS[label] ? LABEL_TERMS[label].slice() : [];
  }

  function termLabel(term) {
    return TERMS[term] || term;
  }

  // ------------------------------------------------------------------
  // 各プロトコルが持つ「警報を置ける枠」の一覧
  // ------------------------------------------------------------------

  // アイホンは発信種別とビット割付パターンで枠が変わる。
  function aiphoneSlots(pattern) {
    const slots = [];
    for (const type of [0x00, 0x01, 0x04, 0x44]) {
      const row = AlarmProtocol.bitAssignments(type, pattern);
      if (!row) continue;
      row.forEach(function (cell, index) {
        for (const term of termsOfLabel(cell.label)) {
          slots.push({ term: term, type: type, bit: index + 1, label: cell.label });
        }
      });
    }
    return slots;
  }

  function panasonicBlockSlots(protocol) {
    const slots = [];
    for (const entry of PanasonicAlarm.blockTypes(protocol)) {
      if (!entry.bits) continue;
      entry.bits.forEach(function (cell, index) {
        for (const term of termsOfLabel(cell.label)) {
          slots.push({ term: term, type: entry.code, bit: index, label: cell.label });
        }
      });
    }
    return slots;
  }

  function panasonicRecordSlots(protocol) {
    return PanasonicAlarm.alarmNumbers(protocol).reduce(function (list, entry) {
      for (const term of termsOfLabel(entry.label)) {
        list.push({ term: term, alarmNo: entry.no, label: entry.label });
      }
      return list;
    }, []);
  }

  function slotsOf(target) {
    if (target.id === AIPHONE) return aiphoneSlots(target.pattern);
    return PanasonicAlarm.styleOf(target.id) === PanasonicAlarm.STYLE.BLOCK
      ? panasonicBlockSlots(target.id)
      : panasonicRecordSlots(target.id);
  }

  function resolveTarget(value) {
    const spec = typeof value === "string" ? { id: value } : (value || {});
    const id = String(spec.id == null ? "" : spec.id);
    const target = AlarmIdentifier.findTarget(id);
    if (!target) throw new RangeError("変換先が不明です: " + (id || "(指定なし)"));
    // patternは文字列（両方に同じ割付）でも { alarm, guard }（5.2.3／5.2.4を別々）でもよい。
    return { id: id, pattern: spec.pattern == null ? AlarmProtocol.BIT_PATTERN.STANDARD : spec.pattern, target: target };
  }

  // ------------------------------------------------------------------
  // 受信電文 → 共通語彙
  // ------------------------------------------------------------------

  function readAiphone(frame, pattern) {
    const parsed = AlarmProtocol.parseFrame(frame);
    if (parsed.type === AlarmProtocol.TYPE.HISTORY_REQUEST) {
      throw new Error("ヒストリー要求は警報の内容を持たないため変換できません");
    }
    const detail = AlarmProtocol.describeInfo(parsed.info, { type: parsed.type, pattern: pattern });
    const terms = [];
    const unreadable = [];
    const expanded = [];
    for (const bit of detail.bits) {
      if (!bit.on) continue;
      const mapped = termsOfLabel(bit.label);
      if (mapped.length === 0) unreadable.push(bit.label || `bit${bit.bit}`);
      if (mapped.length > 1) expanded.push({ label: bit.label, terms: mapped.slice() });
      for (const term of mapped) if (terms.indexOf(term) === -1) terms.push(term);
    }
    return {
      terms: terms,
      unreadable: unreadable,
      expanded: expanded,
      buildingNo: parsed.buildingNo,
      roomNo: parsed.source.kind === AlarmProtocol.SOURCE_KIND.DWELLING ? parsed.source.number : null,
      sourceKind: parsed.source.kind,
      restore: detail.bits.every(function (bit) { return !bit.on; }),
    };
  }

  function readPanasonic(frame, protocol) {
    const style = PanasonicAlarm.styleOf(protocol);
    if (style === PanasonicAlarm.STYLE.BLOCK) {
      const parsed = PanasonicAlarm.parseBlockFrame(frame, { protocol: protocol });
      if (parsed.request) throw new Error(parsed.typeLabel + "は警報の内容を持たないため変換できません");
      const detail = PanasonicAlarm.describeInfo(protocol, parsed.type, parsed.info);
      const terms = [];
      const unreadable = [];
      const expanded = [];
      for (const bit of detail.bits) {
        if (!bit.on) continue;
        const mapped = termsOfLabel(bit.label);
        if (mapped.length === 0) unreadable.push(bit.label || `bit${bit.bit}`);
        if (mapped.length > 1) expanded.push({ label: bit.label, terms: mapped.slice() });
        for (const term of mapped) if (terms.indexOf(term) === -1) terms.push(term);
      }
      return {
        terms: terms,
        unreadable: unreadable,
        expanded: expanded,
        buildingNo: parsed.buildingNo,
        roomNo: parsed.roomNo,
        sourceKind: AlarmProtocol.SOURCE_KIND.DWELLING,
        restore: terms.length === 0,
      };
    }

    const parsed = PanasonicAlarm.parseRecordFrame(frame, { protocol: protocol });
    if (parsed.kind !== "alarm") throw new Error("警報データ以外は変換できません");
    const terms = [];
    const unreadable = [];
    const expanded = [];
    let buildingNo = null;
    let roomNo = null;
    let restore = true;
    for (const record of parsed.records) {
      if (buildingNo == null) { buildingNo = record.buildingNo; roomNo = record.roomNo; }
      // 住戸をまたぐレコードは1つの電文へまとめられない。
      if (record.buildingNo !== buildingNo || record.roomNo !== roomNo) {
        throw new Error("住戸が異なるレコードが混在しているため1件へ変換できません");
      }
      if (record.mode === PanasonicAlarm.MODE.OCCUR) restore = false;
      const mapped = termsOfLabel(record.alarmLabel);
      if (mapped.length === 0) unreadable.push(record.alarmLabel || `警報No.${record.alarmNo}`);
      if (mapped.length > 1) expanded.push({ label: record.alarmLabel, terms: mapped.slice() });
      // 復旧レコードは「その警報が解けた」ことを表すので、立てる側には含めない。
      if (record.mode !== PanasonicAlarm.MODE.OCCUR) continue;
      for (const term of mapped) if (terms.indexOf(term) === -1) terms.push(term);
    }
    return {
      terms: terms,
      unreadable: unreadable,
      expanded: expanded,
      buildingNo: buildingNo || 0,
      roomNo: roomNo || 0,
      sourceKind: AlarmProtocol.SOURCE_KIND.DWELLING,
      restore: restore,
    };
  }

  function read(frame, source) {
    const spec = resolveTarget(source);
    const content = spec.id === AIPHONE ? readAiphone(frame, spec.pattern) : readPanasonic(frame, spec.id);
    return Object.assign({ source: spec }, content);
  }

  // ------------------------------------------------------------------
  // 共通語彙 → 送信電文
  // ------------------------------------------------------------------

  function buildAiphone(content, spec) {
    const slots = aiphoneSlots(spec.pattern);
    const byType = new Map();
    const placed = [];
    const dropped = [];
    for (const term of content.terms) {
      const slot = slots.find(function (item) { return item.term === term; });
      if (!slot) { dropped.push(term); continue; }
      if (!byType.has(slot.type)) byType.set(slot.type, []);
      byType.get(slot.type).push(slot.bit);
      placed.push({ term: term, type: slot.type, bit: slot.bit, label: slot.label });
    }
    // 全復旧はビットを落とした電文1件で表す。
    if (byType.size === 0 && content.restore) byType.set(AlarmProtocol.TYPE.ALARM_1, []);

    const frames = [];
    for (const [type, bits] of byType) {
      frames.push(AlarmProtocol.buildFrame({
        type: type,
        infoBits: bits,
        buildingNo: content.buildingNo || 0,
        source: content.roomNo == null ? AlarmProtocol.sourceNone() : AlarmProtocol.sourceDwelling(content.roomNo),
      }));
    }
    return { frames: frames, placed: placed, dropped: dropped };
  }

  function buildPanasonicBlock(content, spec) {
    const slots = panasonicBlockSlots(spec.id);
    const byType = new Map();
    const placed = [];
    const dropped = [];
    for (const term of content.terms) {
      const slot = slots.find(function (item) { return item.term === term; });
      if (!slot) { dropped.push(term); continue; }
      if (!byType.has(slot.type)) byType.set(slot.type, []);
      byType.get(slot.type).push(slot.bit);
      placed.push({ term: term, type: slot.type, bit: slot.bit, label: slot.label });
    }
    if (byType.size === 0 && content.restore) byType.set(0x00, []);

    const frames = [];
    for (const [type, bits] of byType) {
      frames.push(PanasonicAlarm.buildFrame({
        protocol: spec.id,
        type: type,
        infoBits: bits,
        buildingNo: content.buildingNo || 0,
        roomNo: content.roomNo == null ? 0 : content.roomNo,
      }));
    }
    return { frames: frames, placed: placed, dropped: dropped };
  }

  function buildPanasonicRecord(content, spec) {
    const slots = panasonicRecordSlots(spec.id);
    const records = [];
    const placed = [];
    const dropped = [];
    for (const term of content.terms) {
      const slot = slots.find(function (item) { return item.term === term; });
      if (!slot) { dropped.push(term); continue; }
      records.push({
        mode: PanasonicAlarm.MODE.OCCUR,
        buildingNo: content.buildingNo || 0,
        roomNo: content.roomNo == null ? 0 : content.roomNo,
        alarmNo: slot.alarmNo,
      });
      placed.push({ term: term, alarmNo: slot.alarmNo, label: slot.label });
    }
    if (records.length === 0) return { frames: [], placed: placed, dropped: dropped };

    // 1電文に載るのは最大10レコード。超えるぶんは電文を分ける。
    const frames = [];
    for (let index = 0; index < records.length; index += PanasonicAlarm.MAX_RECORDS) {
      frames.push(PanasonicAlarm.buildFrame({
        protocol: spec.id,
        records: records.slice(index, index + PanasonicAlarm.MAX_RECORDS),
      }));
    }
    return { frames: frames, placed: placed, dropped: dropped };
  }

  function build(content, target) {
    const spec = resolveTarget(target);
    if (spec.id === AIPHONE) return Object.assign({ target: spec }, buildAiphone(content, spec));
    return Object.assign({ target: spec }, PanasonicAlarm.styleOf(spec.id) === PanasonicAlarm.STYLE.BLOCK
      ? buildPanasonicBlock(content, spec)
      : buildPanasonicRecord(content, spec));
  }

  // ------------------------------------------------------------------
  // 変換
  // ------------------------------------------------------------------

  function convert(frame, source, target) {
    const from = resolveTarget(source);
    const to = resolveTarget(target);
    if (from.id === to.id) throw new Error("変換元と変換先が同じです");

    const content = read(frame, from);
    const notes = [];

    // 住戸以外からの発報は、パナソニック側に受け皿がない。
    if (to.id !== AIPHONE && content.sourceKind !== AlarmProtocol.SOURCE_KIND.DWELLING) {
      throw new Error(`発報元が住戸ではないため（${content.sourceKind}）、${to.target.short}へ変換できません`);
    }
    for (const label of content.unreadable) {
      notes.push(`「${label}」は変換表にないため読み替えられません`);
    }

    const built = build(content, to);
    for (const term of built.dropped) {
      notes.push(`「${termLabel(term)}」は${to.target.short}に対応する枠がないため送れません`);
    }
    // 大興／リモートは1レコード1警報のため、どの警報が復旧したか分からないと
    // モードFのレコードを組み立てられない。
    if (built.frames.length === 0 && content.restore && to.id !== AIPHONE
        && PanasonicAlarm.styleOf(to.id) === PanasonicAlarm.STYLE.RECORD) {
      notes.push(`復旧（全bit OFF）は、どの警報が復旧したかを電文から特定できないため、${to.target.short}のレコードへ変換できません`);
    }
    // 1つの桁が複数の意味を持つ場合は、取りこぼしを避けて全て立てたことを伝える。
    for (const item of content.expanded || []) {
      const sent = item.terms.filter(function (term) { return built.dropped.indexOf(term) === -1; });
      notes.push(`「${item.label}」は1つの桁に複数の意味があるため、`
        + (sent.length ? sent.map(termLabel).join("・") + "として送ります" : "対応する枠が見つかりませんでした"));
    }

    return {
      from: from.target,
      to: to.target,
      terms: content.terms.map(function (term) { return { term: term, label: termLabel(term) }; }),
      buildingNo: content.buildingNo,
      roomNo: content.roomNo,
      restore: content.restore,
      frames: built.frames,
      placed: built.placed,
      dropped: built.dropped.map(function (term) { return { term: term, label: termLabel(term) }; }),
      unreadable: content.unreadable.slice(),
      expanded: (content.expanded || []).slice(),
      notes: notes,
      // 落とした項目がなく、警報が1つ以上載ったかどうか。
      complete: built.dropped.length === 0 && content.unreadable.length === 0 && built.frames.length > 0,
    };
  }

  // 変換表そのものを画面へ出すための一覧。
  function mappingTable(source, target) {
    const from = resolveTarget(source);
    const to = resolveTarget(target);
    const fromSlots = slotsOf(from);
    const toSlots = slotsOf(to);
    const seen = new Set();
    const rows = [];
    for (const slot of fromSlots) {
      if (seen.has(slot.term)) continue;
      seen.add(slot.term);
      const match = toSlots.find(function (item) { return item.term === slot.term; });
      rows.push({
        term: slot.term,
        label: termLabel(slot.term),
        from: slot,
        to: match || null,
      });
    }
    return rows;
  }

  return Object.freeze({
    TERMS: TERMS,
    LABEL_TERMS: LABEL_TERMS,
    termLabel: termLabel,
    termsOfLabel: termsOfLabel,
    slotsOf: slotsOf,
    read: read,
    build: build,
    convert: convert,
    mappingTable: mappingTable,
  });
});
