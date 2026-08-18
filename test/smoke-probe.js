"use strict";
// npm run test:smoke 専用。Electronメインプロセスから読み込まれ、実描画された画面を検査する。
// 配布物には含めない（package.json の files に test/ を入れていない）。

const MansionController = require("../protocol/mansion-controller");

const PROBE_SCRIPT = `
  new Promise((resolve) => setTimeout(() => {
    const buttons = ["locker2PreviewButton", "locker4PreviewButton", "keyPreviewButton", "mcPreviewButton", "elevatorPreviewButton", "alarmPreviewButton"];
    buttons.forEach((id) => document.getElementById(id).click());
    setTimeout(() => resolve({
      title: document.title,
      views: document.querySelectorAll(".view").length,
      scripts: Array.from(document.scripts).length,
      ready: document.getElementById("communicationLog").textContent.includes("READY"),
      previewErrors: ["locker2Preview", "locker4Preview", "keyPreview", "mcPreview", "elevatorPreview", "alarmPreview"]
        .filter((id) => document.getElementById(id).textContent.startsWith("ERROR") || document.getElementById(id).textContent === "—"),
      modules: ["serialAPI", "Telegram2", "Telegram4", "Locker4Receiver", "NoncontactKey", "MansionController", "StreamDecoder", "FrameReader", "ElevatorProtocol", "AlarmProtocol", "HandshakeProtocol", "FaultEngine", "AutoResponder"]
        .filter((name) => !window[name])
    }), 50);
  }, 750))
`;

const RECEIVER_SCRIPT = `
  new Promise((resolve) => setTimeout(() => {
    const log = document.getElementById("communicationLog");
    const rxRows = Array.from(log.querySelectorAll(".log-entry.rx"));
    const last = rxRows[rxRows.length - 1];
    resolve({
      parsed: log.textContent.includes("MC KIND=3A CMD=41"),
      lastRxTime: last ? last.querySelector(".log-meta span").textContent : null,
      rxFrames: document.getElementById("metricRx").textContent,
      dateSeparators: log.querySelectorAll(".log-date").length,
    });
  }, 100))
`;

// ログの絞り込みはUIの操作結果でしか壊れ方が見えないため、実DOM上で往復させる。
const LOG_UI_SCRIPT = `
  new Promise((resolve) => {
    const log = document.getElementById("communicationLog");
    const rows = () => Array.from(log.querySelectorAll(".log-entry"));
    const visible = () => rows().filter((row) => !row.classList.contains("hidden")).length;
    const search = document.getElementById("logSearch");
    const initial = visible();

    document.querySelector('.log-filters button[data-filter="fault"]').click();
    const faultRows = rows().filter((row) => !row.classList.contains("hidden"));
    const faultOnly = faultRows.every((row) => ["warn", "error"].includes(row.dataset.kind));
    document.querySelector('.log-filters button[data-filter="all"]').click();

    search.value = "存在しない検索語zzz";
    search.dispatchEvent(new Event("input"));
    const noMatch = visible();
    search.value = "";
    search.dispatchEvent(new Event("input"));

    resolve({
      faultOnly,
      noMatch,
      restored: visible() === initial,
      logLimit: document.getElementById("logLimit").value,
    });
  })
`;

function formatTime(at) {
  const date = new Date(at);
  const pad = (value, width = 2) => String(value).padStart(width, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

async function run({ window, app, sendToRenderer }) {
  try {
    const initial = await window.webContents.executeJavaScript(PROBE_SCRIPT);
    if (initial.title !== "外部疑似装置 Next" || initial.views !== 10 || initial.modules.length || initial.previewErrors.length || !initial.ready) {
      throw new Error(`unexpected renderer state: ${JSON.stringify(initial)}`);
    }

    // 分割受信したMCフレームが復元されること、およびログが描画時刻ではなく
    // シリアルイベントの発生時刻を記録することを、過去の時刻を渡して確認する。
    await window.webContents.executeJavaScript(`document.querySelector('[data-view="mansion"]').click()`);
    const frame = MansionController.buildHealthCheckRequest({ version: 3, from: MansionController.ROLE.IC });
    const occurredAt = Date.now() - 3_600_000;
    sendToRenderer("serial:data", { sessionId: 999, sequence: 1, timestamp: occurredAt, bytes: [0x06, ...frame.slice(0, 3)] });
    sendToRenderer("serial:data", { sessionId: 999, sequence: 2, timestamp: occurredAt, bytes: [...frame.slice(3), 0x04] });
    const receiver = await window.webContents.executeJavaScript(RECEIVER_SCRIPT);
    if (!receiver.parsed) throw new Error(`renderer stream path failed: ${JSON.stringify(receiver)}`);
    if (receiver.lastRxTime !== formatTime(occurredAt)) {
      throw new Error(`log timestamp is not the serial event time: ${JSON.stringify({ ...receiver, expected: formatTime(occurredAt) })}`);
    }
    if (receiver.rxFrames !== "1") throw new Error(`unexpected received frame count: ${receiver.rxFrames}`);
    if (receiver.dateSeparators < 1) throw new Error("date separator was not rendered");

    const logUi = await window.webContents.executeJavaScript(LOG_UI_SCRIPT);
    if (!logUi.faultOnly || logUi.noMatch !== 0 || !logUi.restored || logUi.logLimit !== "20000") {
      throw new Error(`log filter contract failed: ${JSON.stringify(logUi)}`);
    }

    console.log(`electron-smoke: OK ${JSON.stringify({ ...initial, streamParsed: receiver.parsed, rxFrames: receiver.rxFrames, logUi })}`);
    app.quit();
  } catch (error) {
    console.error(`electron-smoke: ${error && error.stack || error}`);
    app.exit(1);
  }
}

module.exports = { run };
