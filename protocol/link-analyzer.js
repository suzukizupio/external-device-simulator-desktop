// 受信データから「通信条件（ボーレート・パリティ等）が合っていない」兆候を読み取る。
//
// ボーレートが違うまま受信すると、UARTはスタートビットを誤った位置で拾い、
// 1ビットを何度もサンプリングしたり読み飛ばしたりする。その結果、受信バイト列には
// 次の偏りが出る（本実装はUARTのシミュレーションで実測して閾値を決めている）。
//   ・設定が実際より速い … 同じ値が長く続くため、1byteあたりのビット遷移が減り、
//                          00Hの割合が増える。受信バイト数は実際の電文より多くなる。
//   ・設定が実際より遅い … 複数ビットが1つに潰れるため遷移が増え、バイト数は減る。
// ここで分かるのは「条件が合っていない疑いと、ずれの向き」までで、正確なボーレートは
// 実際にその条件で開いて受信してみる（スキャン）以外に確定できない。
// Browser: window.LinkAnalyzer / Node: require("./protocol/link-analyzer.js")
(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.LinkAnalyzer = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";

  // 対象アプリが扱う機器で使われる標準的なボーレート。
  const STANDARD_BAUD_RATES = Object.freeze([300, 600, 1200, 2400, 4800, 9600, 19200, 38400]);

  const VERDICT = Object.freeze({
    MATCH: "match",         // 偏りがなく、条件は合っていそう
    TOO_FAST: "tooFast",    // 設定が実際より速い
    TOO_SLOW: "tooSlow",    // 設定が実際より遅い
    UNKNOWN: "unknown",     // 判断材料が足りない
  });

  const VERDICT_TEXT = Object.freeze({
    [VERDICT.MATCH]: "通信条件のずれを示す偏りはありません",
    [VERDICT.TOO_FAST]: "設定しているボーレートが相手より速い可能性があります",
    [VERDICT.TOO_SLOW]: "設定しているボーレートが相手より遅い可能性があります",
    [VERDICT.UNKNOWN]: "判断できるだけの受信データがありません",
  });

  // 判定に足りるだけの標本数。短すぎる受信では偏りを論じない。
  const MIN_BYTES = 6;

  function toBytes(input) {
    if (input == null) return [];
    if (typeof input.length !== "number") throw new TypeError("受信データはバイト配列で指定してください");
    return Array.from(input, function (value) {
      const byte = Number(value);
      if (!Number.isInteger(byte) || byte < 0 || byte > 0xFF) throw new RangeError("受信データに0～255以外の値が含まれています");
      return byte;
    });
  }

  // 1byteあたりのビット遷移回数。ボーレートが速すぎると同じ値が続き、この値が下がる。
  function transitionsPerByte(bytes) {
    if (bytes.length === 0) return 0;
    let transitions = 0;
    for (const byte of bytes) {
      for (let index = 1; index < 8; index += 1) {
        if (((byte >> index) & 1) !== ((byte >> (index - 1)) & 1)) transitions += 1;
      }
    }
    return transitions / bytes.length;
  }

  function ratioOf(bytes, predicate) {
    if (bytes.length === 0) return 0;
    return bytes.filter(predicate).length / bytes.length;
  }

  function round(value, digits) {
    const factor = Math.pow(10, digits);
    return Math.round(value * factor) / factor;
  }

  // 現在の設定と推定倍率から、標準的なボーレートの候補を挙げる。
  function baudCandidates(baudRate, ratio) {
    if (!baudRate || !ratio || !Number.isFinite(ratio) || ratio <= 0) return [];
    const estimated = baudRate / ratio;
    return STANDARD_BAUD_RATES
      .map(function (candidate) {
        return { baudRate: candidate, error: Math.abs(candidate - estimated) / estimated };
      })
      // 受信が電文の途中で切れていると比がぶれるため、幅を持たせて複数挙げる。
      // ここで出るのはあくまで目安で、確定には実際にその条件で開いて受信する必要がある。
      .filter(function (item) { return item.error <= 0.35; })
      .sort(function (a, b) { return a.error - b.error; })
      .slice(0, 3)
      .map(function (item) { return item.baudRate; });
  }

  function analyze(input, options) {
    const opts = options || {};
    const bytes = toBytes(input);
    const baudRate = Number(opts.baudRate) || null;
    const expectedLength = Number(opts.expectedLength) || null;

    const transitions = transitionsPerByte(bytes);
    const zeroRatio = ratioOf(bytes, function (byte) { return byte === 0x00; });
    const ffRatio = ratioOf(bytes, function (byte) { return byte === 0xFF; });
    const printableRatio = ratioOf(bytes, function (byte) { return byte >= 0x20 && byte <= 0x7E; });

    const metrics = {
      byteLength: bytes.length,
      transitionsPerByte: round(transitions, 2),
      zeroRatio: round(zeroRatio, 3),
      ffRatio: round(ffRatio, 3),
      printableRatio: round(printableRatio, 3),
      lengthRatio: expectedLength ? round(bytes.length / expectedLength, 2) : null,
    };

    if (bytes.length < MIN_BYTES) {
      return finish(VERDICT.UNKNOWN, metrics, [`受信が${bytes.length}バイトしかなく、偏りを判断できません`], []);
    }

    const reasons = [];
    let verdict = VERDICT.MATCH;

    // 設定が速すぎるときの特徴：遷移が減り、00Hが増える。
    if (transitions < 0.8 && zeroRatio >= 0.30) {
      verdict = VERDICT.TOO_FAST;
      reasons.push(`1バイトあたりのビット変化が${metrics.transitionsPerByte}回と少なく、00Hが${Math.round(zeroRatio * 100)}%を占めます`);
    } else if (transitions < 0.5) {
      verdict = VERDICT.TOO_FAST;
      reasons.push(`1バイトあたりのビット変化が${metrics.transitionsPerByte}回しかありません`);
    } else if (zeroRatio >= 0.5) {
      verdict = VERDICT.TOO_FAST;
      reasons.push(`受信データの${Math.round(zeroRatio * 100)}%が00Hです`);
    } else if (transitions > 2.4 && expectedLength && bytes.length < expectedLength) {
      // 設定が遅すぎるときの特徴：複数ビットが潰れて遷移が増え、電文より短くなる。
      verdict = VERDICT.TOO_SLOW;
      reasons.push(`ビット変化が${metrics.transitionsPerByte}回と多いのに、受信が${bytes.length}バイトと電文長${expectedLength}バイトに足りません`);
    }

    // 電文長との比が分かる場合は、ずれの向きの裏付けにする。
    if (metrics.lengthRatio != null) {
      if (metrics.lengthRatio >= 1.5) {
        if (verdict === VERDICT.MATCH) verdict = VERDICT.TOO_FAST;
        reasons.push(`${expectedLength}バイトの電文に対して${bytes.length}バイト受信しており、約${metrics.lengthRatio}倍に伸びています`);
      } else if (metrics.lengthRatio <= 0.7) {
        if (verdict === VERDICT.MATCH) verdict = VERDICT.TOO_SLOW;
        reasons.push(`${expectedLength}バイトの電文に対して${bytes.length}バイトしか受信しておらず、約${metrics.lengthRatio}倍に縮んでいます`);
      }
    }

    // 倍率が分かるのは電文長を比較できたときだけ。分からない場合は向きだけを示す。
    const ratio = metrics.lengthRatio;
    const candidates = verdict === VERDICT.MATCH || !ratio ? [] : baudCandidates(baudRate, ratio);
    return finish(verdict, metrics, reasons, candidates);
  }

  function finish(verdict, metrics, reasons, candidates) {
    return {
      verdict: verdict,
      suspicious: verdict === VERDICT.TOO_FAST || verdict === VERDICT.TOO_SLOW,
      text: VERDICT_TEXT[verdict],
      reasons: reasons,
      // 候補が出せるのは電文長と突き合わせられたときだけ。確定には実際に開いて試す必要がある。
      baudCandidates: candidates,
      metrics: metrics,
    };
  }

  return Object.freeze({
    VERDICT: VERDICT,
    VERDICT_TEXT: VERDICT_TEXT,
    STANDARD_BAUD_RATES: STANDARD_BAUD_RATES,
    MIN_BYTES: MIN_BYTES,
    transitionsPerByte: transitionsPerByte,
    baudCandidates: baudCandidates,
    analyze: analyze,
  });
});
