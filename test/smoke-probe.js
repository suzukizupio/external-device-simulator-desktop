"use strict";
// npm run test:smoke 専用。Electronメインプロセスから読み込まれ、実描画された画面を検査する。
// 配布物には含めない（package.json の files に test/ を入れていない）。

const MansionController = require("../protocol/mansion-controller");

// 宅配2線式・4線式は送信登録が0件だとプレビューできないため、ここでは対象外にして
// LOCKER_UI_SCRIPT で登録操作込みの検査を行う。
const PROBE_SCRIPT = `
  new Promise((resolve) => setTimeout(() => {
    const buttons = ["keyPreviewButton", "mcPreviewButton", "elevatorPreviewButton", "alarmPreviewButton"];
    buttons.forEach((id) => document.getElementById(id).click());
    setTimeout(() => resolve({
      title: document.title,
      views: document.querySelectorAll(".view").length,
      scripts: Array.from(document.scripts).length,
      ready: document.getElementById("communicationLog").textContent.includes("READY"),
      previewErrors: ["keyPreview", "mcPreview", "elevatorPreview", "alarmPreview"]
        .filter((id) => document.getElementById(id).textContent.startsWith("ERROR") || document.getElementById(id).textContent === "—"),
      modules: ["serialAPI", "Telegram2", "Telegram4", "Locker4Receiver", "NoncontactKey", "MansionController", "StreamDecoder", "FrameReader", "ElevatorProtocol", "AlarmProtocol", "HandshakeProtocol", "FaultEngine", "AutoResponder"]
        .filter((name) => !window[name])
    }), 50);
  }, 750))
`;

// ロッカー表は動的生成のため、実DOM上で一括設定と送信登録を往復させる。
const LOCKER_UI_SCRIPT = `
  new Promise((resolve) => {
    const rowsOf = (id) => Array.from(document.getElementById(id).querySelectorAll("tr"));
    const numbersOf = (tr) => Array.from(tr.querySelectorAll("input[type=number]")).map((input) => input.value).join("-");
    const initialRows = rowsOf("locker4Body").length;
    const initialRows2 = rowsOf("locker2Body").length;

    document.getElementById("locker4BulkBuilding").value = "1";
    document.getElementById("locker4BulkRoom").value = "101";
    document.getElementById("locker4BulkFrom").value = "1";
    document.getElementById("locker4BulkTo").value = "3";
    document.getElementById("locker4BulkApply").click();
    const assigned = rowsOf("locker4Body").slice(0, 3).map(numbersOf);

    rowsOf("locker4Body")[0].querySelector("input[type=checkbox]").click();
    const registered = document.getElementById("locker4Selected").textContent;
    document.getElementById("locker4PreviewButton").click();

    document.getElementById("locker2Building").value = "1";
    document.getElementById("locker2Room").value = "101";
    document.getElementById("locker2Address").value = "1";
    document.getElementById("locker2BulkFrom").value = "1";
    document.getElementById("locker2BulkTo").value = "3";
    document.getElementById("locker2BulkApply").click();
    const assigned2 = rowsOf("locker2Body").slice(0, 3).map(numbersOf);

    rowsOf("locker2Body")[0].querySelector("input[type=checkbox]").click();
    rowsOf("locker2Body")[1].querySelector("input[type=checkbox]").click();
    const registered2 = document.getElementById("locker2Selected").textContent;
    document.getElementById("locker2PreviewButton").click();

    setTimeout(() => {
      // 表示選択を「送信登録のみ」に切り替えると、登録した行だけが残る。
      const filter = document.getElementById("locker4Filter");
      filter.value = "selected";
      filter.dispatchEvent(new Event("change"));
      const filteredRows = rowsOf("locker4Body").length;
      filter.value = "all";
      filter.dispatchEvent(new Event("change"));
      resolve({
        initialRows,
        assigned,
        registered,
        filteredRows,
        restoredRows: rowsOf("locker4Body").length,
        visible: document.getElementById("locker4Visible").textContent,
        preview: document.getElementById("locker4Preview").textContent,
        initialRows2,
        assigned2,
        registered2,
        visible2: document.getElementById("locker2Visible").textContent,
        limit2: document.getElementById("locker2Limit").textContent,
        preview2: document.getElementById("locker2Preview").textContent,
      });
    }, 60);
  })
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

    const locker = await window.webContents.executeJavaScript(LOCKER_UI_SCRIPT);
    if (locker.initialRows !== 100 || locker.visible !== "100" || locker.restoredRows !== 100) {
      throw new Error(`locker table was not rendered: ${JSON.stringify(locker)}`);
    }
    if (locker.assigned.join(",") !== "1-101,1-102,1-103") {
      throw new Error(`bulk room assignment failed: ${JSON.stringify(locker)}`);
    }
    if (locker.registered !== "1" || locker.filteredRows !== 1) {
      throw new Error(`locker registration failed: ${JSON.stringify(locker)}`);
    }
    if (!locker.preview.startsWith("#1 02 ")) {
      throw new Error(`locker preview failed: ${JSON.stringify(locker)}`);
    }
    if (locker.initialRows2 !== 100 || locker.visible2 !== "100" || locker.limit2 !== "上限 100 件") {
      throw new Error(`locker2 table was not rendered: ${JSON.stringify(locker)}`);
    }
    if (locker.assigned2.join(",") !== "1-101-1,1-102-2,1-103-3") {
      throw new Error(`locker2 bulk assignment failed: ${JSON.stringify(locker)}`);
    }
    if (locker.registered2 !== "2" || !locker.preview2.startsWith("#1 02 ") || !locker.preview2.includes("#2 02 ")) {
      throw new Error(`locker2 registration failed: ${JSON.stringify(locker)}`);
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

    console.log(`electron-smoke: OK ${JSON.stringify({ ...initial, locker, streamParsed: receiver.parsed, rxFrames: receiver.rxFrames, logUi })}`);
    app.quit();
  } catch (error) {
    console.error(`electron-smoke: ${error && error.stack || error}`);
    app.exit(1);
  }
}

module.exports = { run };
