"use strict";
// npm run test:smoke 専用。Electronメインプロセスから読み込まれ、実描画された画面を検査する。
// 配布物には含めない（package.json の files に test/ を入れていない）。

const MansionController = require("../protocol/mansion-controller");
const Telegram2 = require("../protocol/locker2");
const Telegram4 = require("../protocol/locker4");
const NoncontactKey = require("../protocol/noncontact-key");
const PanasonicAlarm = require("../protocol/panasonic-alarm");
const PanasonicElevator = require("../protocol/panasonic-elevator");
const AlarmProtocol = require("../protocol/alarm");
const { version: packageVersion } = require("../package.json");

// 宅配2線式・4線式は送信登録が0件だとプレビューできないため、ここでは対象外にして
// LOCKER_UI_SCRIPT で登録操作込みの検査を行う。
const PROBE_SCRIPT = `
  new Promise((resolve) => setTimeout(() => {
    const buttons = ["keyPreviewButton", "mcPreviewButton", "elevatorPreviewButton", "alarmPreviewButton", "panaPreviewButton", "pevPreviewButton"];
    buttons.forEach((id) => document.getElementById(id).click());
    setTimeout(() => resolve({
      title: document.title,
      views: document.querySelectorAll(".view").length,
      scripts: Array.from(document.scripts).length,
      ready: document.getElementById("communicationLog").textContent.includes("READY"),
      versionLine: document.getElementById("appVersionLine").textContent,
      versionBadge: document.getElementById("appVersionBadge").textContent,
      versionValue: document.getElementById("appVersionValue").textContent,
      buildValue: document.getElementById("appBuildValue").textContent,
      runtimeValue: document.getElementById("appRuntimeValue").textContent,
      readyLog: document.getElementById("communicationLog").textContent.includes("v" + "${packageVersion}"),
      previewErrors: ["keyPreview", "mcPreview", "elevatorPreview", "alarmPreview", "panaPreview", "pevPreview"]
        .filter((id) => document.getElementById(id).textContent.startsWith("ERROR") || document.getElementById(id).textContent === "—"),
      modules: ["serialAPI", "Telegram2", "Telegram4", "Locker4Receiver", "NoncontactKey", "MansionController", "StreamDecoder", "FrameReader", "ElevatorProtocol", "AlarmProtocol", "PanasonicAlarm", "PanasonicElevator", "AlarmIdentifier", "LinkAnalyzer", "AlarmBridge", "DeviceBridge", "HandshakeProtocol", "FaultEngine", "AutoResponder", "ReceiveInspector"]
        .filter((name) => !window[name])
    }), 50);
  }, 750))
`;

// ロッカー表は動的生成のため、実DOM上で一括設定と送信登録を往復させる。
const LOCKER_UI_SCRIPT = `
  new Promise((resolve) => {
   try {
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

    // 階番号インクリメントで101→201→301になることを確かめる。
    document.getElementById("locker2Building").value = "1";
    document.getElementById("locker2Room").value = "101";
    document.getElementById("locker2Increment").value = "floor";
    document.getElementById("locker2BulkFrom").value = "1";
    document.getElementById("locker2BulkTo").value = "3";
    document.getElementById("locker2BulkApply").click();
    const assignedFloor = rowsOf("locker2Body").slice(0, 3).map(numbersOf);

    document.getElementById("locker2Increment").value = "room";
    document.getElementById("locker2BulkApply").click();
    const assigned2 = rowsOf("locker2Body").slice(0, 3).map(numbersOf);

    rowsOf("locker2Body")[0].querySelector("input[type=checkbox]").click();
    rowsOf("locker2Body")[1].querySelector("input[type=checkbox]").click();
    const registered2 = document.getElementById("locker2Selected").textContent;

    // 「切替」で登録済みの行だけ取出しへ変えると、ボックス数が0になる。
    document.getElementById("locker2SwitchCommand").value = "19";
    document.getElementById("locker2SwitchApply").click();
    const boxesAfterSwitch = document.getElementById("locker2Boxes").textContent;
    document.getElementById("locker2SwitchCommand").value = "17";
    document.getElementById("locker2SwitchApply").click();
    const boxes2 = document.getElementById("locker2Boxes").textContent;

    // 送信範囲を旧版互換にすると、未登録ロッカーも3FH埋めで巡回送信される。
    const scope = document.getElementById("locker2Scope");
    scope.value = "all";
    document.getElementById("locker2PreviewButton").click();
    const previewText = document.getElementById("locker2Preview").textContent;
    const scopeAllLines = (previewText.match(/#[0-9]+ /g) || []).length;
    const scopeAllThird = (previewText.match(/#3 [0-9A-F ]+/) || [""])[0].trim();
    scope.value = "registered";
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
        assignedFloor,
        registered2,
        boxes2,
        boxesAfterSwitch,
        scopeAllLines,
        scopeAllThird,
        visible2: document.getElementById("locker2Visible").textContent,
        limit2: document.getElementById("locker2Limit").textContent,
        preview2: document.getElementById("locker2Preview").textContent,
      });
    }, 60);
   } catch (error) {
     resolve({ scriptError: String(error && error.stack || error) });
   }
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

// 受信モニタが実DOMへ描画された内容を読み出す。フィールド名→表示値の対で返し、
// 「どの桁が何と解釈されたか」を実描画から検証する。
const RECEIVE_MONITOR_SCRIPT = (prefix) => `
  (() => {
    const text = (id) => {
      const element = document.getElementById(id);
      return element ? element.textContent.trim() : null;
    };
    const rows = (id) => Array.from(document.querySelectorAll("#" + id + " tr"))
      .filter((tr) => !tr.classList.contains("receive-empty"));
    const fields = {};
    const fieldStatus = {};
    for (const tr of rows("${prefix}Fields")) {
      const cells = tr.querySelectorAll("td");
      if (cells.length < 4) continue;
      const label = cells[1].textContent.trim();
      fields[label] = (cells[3].querySelector(".receive-value") || cells[3]).textContent.trim();
      fieldStatus[label] = tr.className.replace("receive-row", "").trim();
    }
    return {
      verdict: text("${prefix}Verdict"),
      verdictClass: (document.getElementById("${prefix}Verdict") || {}).className || "",
      summary: text("${prefix}Summary"),
      hex: text("${prefix}Hex"),
      badges: Array.from(document.querySelectorAll("#${prefix}Badges .receive-badge")).map((node) => node.textContent.trim()),
      notes: Array.from(document.querySelectorAll("#${prefix}Notes .receive-note")).map((node) => node.textContent.trim()),
      fields,
      fieldStatus,
      lockers: rows("${prefix}Lockers").map((tr) => Array.from(tr.querySelectorAll("td")).map((td) => td.textContent.trim())),
      historyCount: text("${prefix}HistoryCount"),
      historyItems: Array.from(document.querySelectorAll("#${prefix}History .receive-history-item")).map((node) => node.textContent.trim()),
    };
  })()
`;

function formatTime(at) {
  const date = new Date(at);
  const pad = (value, width = 2) => String(value).padStart(width, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

// 通信ログが伸びても3列レイアウトの行高が固定されたままで、
// 画面下部までスクロールできることを確認する回帰テスト。
// .layout に grid-template-rows / min-height:0 が無いと行が max-content になり、
// ログ件数の分だけ各列が縦に膨らんで .content のスクロールが失われる。
const LAYOUT_SCROLL_SCRIPT = `(() => {
  const layout = document.querySelector(".layout");
  const content = document.querySelector(".content");
  const logList = document.querySelector(".log-list");
  content.scrollTop = content.scrollHeight;
  const cards = Array.from(document.querySelector(".view.active").querySelectorAll(".card"));
  const last = cards[cards.length - 1];
  const lastBottom = last ? last.getBoundingClientRect().bottom : 0;
  return {
    narrowMode: window.matchMedia("(max-width: 1050px)").matches,
    viewportHeight: window.innerHeight,
    layoutHeight: Math.round(layout.getBoundingClientRect().height),
    contentHeight: Math.round(content.getBoundingClientRect().height),
    logListHeight: Math.round(logList.getBoundingClientRect().height),
    logListScrollable: logList.scrollHeight - logList.clientHeight,
    logEntries: document.querySelectorAll(".log-list > *").length,
    bottomReachable: !last || lastBottom <= window.innerHeight + 2,
  };
})()`;

async function verifyLayoutScroll({ window, sendToRenderer }) {
  await window.webContents.executeJavaScript(`document.querySelector('[data-view="locker4"]').click()`);
  await new Promise((resolve) => setTimeout(resolve, 120));
  // ログを大量に積み、ログ枠が列高を押し広げないことを確かめる。
  const frame = [0x02, 0x30, 0x31, 0x30, 0x30, 0x31, 0x30, 0x31, 0x30, 0x30, 0x30, 0x03, 0x02];
  for (let index = 0; index < 40; index += 1) {
    sendToRenderer("serial:data", { sessionId: 998, sequence: 2000 + index, timestamp: Date.now(), bytes: frame });
  }
  await new Promise((resolve) => setTimeout(resolve, 600));
  const result = await window.webContents.executeJavaScript(LAYOUT_SCROLL_SCRIPT);
  if (result.logEntries < 40) {
    throw new Error(`log entries were not accumulated: ${JSON.stringify(result)}`);
  }
  if (result.narrowMode) {
    // 狭幅時はページ全体スクロールなので、ログ枠が無制限に伸びないことだけを見る。
    if (result.logListScrollable <= 0) throw new Error(`log list did not scroll internally: ${JSON.stringify(result)}`);
    return result;
  }
  // 3列レイアウトではレイアウト高がビューポートを超えてはならない。
  if (result.layoutHeight > result.viewportHeight) {
    throw new Error(`layout row grew past the viewport: ${JSON.stringify(result)}`);
  }
  if (result.contentHeight > result.viewportHeight) {
    throw new Error(`content column grew past the viewport: ${JSON.stringify(result)}`);
  }
  if (result.logListScrollable <= 0) {
    throw new Error(`log list did not scroll internally: ${JSON.stringify(result)}`);
  }
  if (!result.bottomReachable) {
    throw new Error(`view bottom is unreachable after traffic: ${JSON.stringify(result)}`);
  }
  return result;
}

// 受信モニタは「受信 → 解析 → 描画 → 反映」まで実DOMで確認する。
// 実際のシリアル受信と同じ serial:data 経路へ電文を流し込む。
async function verifyReceiveMonitors({ window, sendToRenderer }) {
  const $ = (id) => `document.getElementById("${id}")`;
  const click = (id) => window.webContents.executeJavaScript(`${$(id)}.click()`);
  const navigate = (view) => window.webContents.executeJavaScript(`document.querySelector('[data-view="${view}"]').click()`);
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  let sequence = 1000;
  const send = async (bytes) => {
    sequence += 1;
    sendToRenderer("serial:data", { sessionId: 999, sequence, timestamp: Date.now(), bytes: Array.from(bytes) });
    await wait(90);
  };
  const monitorOf = (prefix) => window.webContents.executeJavaScript(RECEIVE_MONITOR_SCRIPT(prefix));

  // ---------------------------------------------- 非接触キー：13byte + BCC異常
  await navigate("key");
  // 自動ACK/NAKは受信モニタとは独立の機能なので、ここでは切っておく。
  await window.webContents.executeJavaScript(`${$("keyAutoResponse")}.checked = false`);
  const keyFrame = NoncontactKey.buildTelegram({
    format: NoncontactKey.FORMAT.WITH_PERSON, gateNo: 2, buildingNo: 1, roomNo: 101, personNo: 3,
  });
  // 分割受信でも1件として解析されることを確かめる。
  await send(keyFrame.slice(0, 5));
  await send(keyFrame.slice(5));
  const key = await monitorOf("keyRx");
  if (key.verdict !== "検証OK" || !key.verdictClass.includes("ok")) {
    throw new Error(`key receive verdict failed: ${JSON.stringify(key)}`);
  }
  if (key.fields["ゲートNo"] !== "02番ゲート" || key.fields["棟番号"] !== "1棟"
      || key.fields["部屋番号"] !== "0101（101号室）" || key.fields["個人番号"] !== "003（3番）") {
    throw new Error(`key field decode failed: ${JSON.stringify(key.fields)}`);
  }
  if (!key.fields["BCC"].includes("一致") || !key.notes.some((note) => note.includes("応答: ACK"))) {
    throw new Error(`key BCC/response hint failed: ${JSON.stringify(key)}`);
  }
  if (key.historyCount !== "1件") throw new Error(`key history failed: ${JSON.stringify(key)}`);

  await send(NoncontactKey.corruptBCC(keyFrame));
  const keyBad = await monitorOf("keyRx");
  if (keyBad.verdict !== "検証NG" || keyBad.fieldStatus["BCC"] !== "error") {
    throw new Error(`key bad BCC not reported: ${JSON.stringify(keyBad)}`);
  }
  // BCCが壊れていても各桁は読めていること。
  if (keyBad.fields["部屋番号"] !== "0101（101号室）") {
    throw new Error(`key bad BCC lost field decode: ${JSON.stringify(keyBad.fields)}`);
  }
  if (!keyBad.notes.some((note) => note.includes("応答: NAK")) || keyBad.historyCount !== "2件") {
    throw new Error(`key bad BCC hints failed: ${JSON.stringify(keyBad)}`);
  }

  // 受信内容の送信フォームへの取り込み。
  await window.webContents.executeJavaScript(`${$("keyRxFollow")}.checked = false`);
  await window.webContents.executeJavaScript(
    `Array.from(document.querySelectorAll("#keyRxHistory .receive-history-item")).pop().click()`
  );
  await click("keyRxApply");
  await wait(60);
  const keyForm = await window.webContents.executeJavaScript(`({
    gate: ${$("keyGate")}.value, building: ${$("keyBuilding")}.value,
    room: ${$("keyRoom")}.value, person: ${$("keyPerson")}.value,
  })`);
  if (keyForm.gate !== "2" || keyForm.building !== "1" || keyForm.room !== "0101" || keyForm.person !== "3") {
    throw new Error(`key apply-to-form failed: ${JSON.stringify(keyForm)}`);
  }

  // ------------------------------------------------------ 4線式：情報応答
  await navigate("locker4");
  await window.webContents.executeJavaScript(`${$("locker4Action")}.value = "request"`);
  const locker4Frame = Telegram4.buildResponseTelegram({
    packageNo: 0,
    modelNo: 1,
    lockers: [
      { state: Telegram4.STATE.PARCEL, lockerNo: 1, buildingNo: 1, roomNo: 101 },
      { state: Telegram4.STATE.EMPTY, lockerNo: 2, buildingNo: 1, roomNo: 102 },
    ],
  });
  await send(locker4Frame);
  const l4 = await monitorOf("locker4Rx");
  if (l4.verdict !== "検証OK" || l4.lockers.length !== 2) {
    throw new Error(`locker4 receive failed: ${JSON.stringify(l4)}`);
  }
  if (l4.fields["発信ID"] !== "37H 宅配ボックス" || l4.fields["着信ID"] !== "38H 集合住宅システム") {
    throw new Error(`locker4 ID decode failed: ${JSON.stringify(l4.fields)}`);
  }
  if (l4.fields["パッケージNO"] !== "00（最終パケット）") {
    throw new Error(`locker4 package decode failed: ${JSON.stringify(l4.fields)}`);
  }
  // 状態・ロッカーNO・住戸NOが内訳表に出ていること。
  if (!l4.lockers[0][2].includes("荷物あり") || l4.lockers[0][3] !== "001" || l4.lockers[0][5] !== "0101") {
    throw new Error(`locker4 locker breakdown failed: ${JSON.stringify(l4.lockers)}`);
  }
  if (!l4.lockers[1][2].includes("荷物なし")) {
    throw new Error(`locker4 second locker failed: ${JSON.stringify(l4.lockers)}`);
  }

  // 受信状態をロッカー一覧の現在状態へ反映する。
  await click("locker4RxApply");
  await wait(80);
  const l4Rows = await window.webContents.executeJavaScript(`
    Array.from(document.querySelectorAll("#locker4Body tr")).slice(0, 2)
      .map((tr) => tr.querySelector(".locker-current").textContent.trim())
  `);
  if (l4Rows[0] !== "荷物あり" || l4Rows[1] !== "荷物なし") {
    throw new Error(`locker4 apply-to-table failed: ${JSON.stringify(l4Rows)}`);
  }

  // ------------------------------------------------------ 2線式：着荷電文
  await navigate("locker2");
  const locker2Frame = Telegram2.buildTelegram({
    command: Telegram2.CMD.STAY, buildingNo: 2, roomNo: 305, address: 4,
  });
  await send(locker2Frame);
  const l2 = await monitorOf("locker2Rx");
  if (l2.verdict !== "検証OK") throw new Error(`locker2 receive failed: ${JSON.stringify(l2)}`);
  if (l2.fields["コマンド"] !== "12H 滞留" || l2.fields["住戸番号"] !== "305号室"
      || l2.fields["棟No"] !== "2棟" || !l2.fields["住戸アドレス"].startsWith("4")) {
    throw new Error(`locker2 field decode failed: ${JSON.stringify(l2.fields)}`);
  }
  // 2線式は単方向なので、応答を促す注記を出さない。
  if (l2.notes.some((note) => note.includes("応答"))) {
    throw new Error(`locker2 must not suggest a response: ${JSON.stringify(l2.notes)}`);
  }
  await click("locker2RxApply");
  await wait(80);
  const l2Row = await window.webContents.executeJavaScript(`
    (() => {
      const tr = document.querySelectorAll("#locker2Body tr")[3];
      return {
        command: tr.querySelector("select").value,
        numbers: Array.from(tr.querySelectorAll("input[type=number]")).map((input) => input.value),
      };
    })()
  `);
  if (l2Row.command !== "18" || l2Row.numbers.join("-") !== "2-305") {
    throw new Error(`locker2 apply-to-table failed: ${JSON.stringify(l2Row)}`);
  }

  // 旧版は全ロッカーを連続送信するため、登録済みの電文が未登録ロッカーに
  // 押し出されて見えなくなる。住戸別の集計が履歴の保持件数を超えて残ることを確かめる。
  await send(Telegram2.buildTelegram({ command: Telegram2.CMD.ARRIVE, buildingNo: 1, roomNo: 101, address: 1 }));
  for (let address = 5; address <= 130; address += 1) {
    await send(Telegram2.buildVacantTelegram(address));
  }
  const inbox = await window.webContents.executeJavaScript(`
    (() => {
      const rows = Array.from(document.querySelectorAll("#locker2InboxBody tr"))
        .map((tr) => Array.from(tr.querySelectorAll("td")).map((td) => td.textContent));
      return {
        rows,
        count: document.getElementById("locker2InboxCount").textContent,
        stats: document.getElementById("locker2InboxStats").textContent,
        historyCount: document.getElementById("locker2RxHistoryCount").textContent,
      };
    })()
  `);
  // 受信履歴は上限100件で古い順に捨てられるが、集計側は登録済み2件を保持し続ける。
  if (inbox.count !== "2件" || inbox.rows.length !== 2) {
    throw new Error(`locker2 inbox lost registered lockers: ${JSON.stringify(inbox)}`);
  }
  if (inbox.rows[0][0] !== "1" || inbox.rows[0][2] !== "101号室" || inbox.rows[0][3] !== "着荷(お届け)") {
    throw new Error(`locker2 inbox row 1 wrong: ${JSON.stringify(inbox.rows[0])}`);
  }
  if (inbox.rows[1][0] !== "4" || inbox.rows[1][2] !== "305号室" || inbox.rows[1][3] !== "滞留") {
    throw new Error(`locker2 inbox row 2 wrong: ${JSON.stringify(inbox.rows[1])}`);
  }
  if (!inbox.stats.includes("登録済み 2件") || !inbox.stats.includes("未登録 126件")) {
    throw new Error(`locker2 inbox stats wrong: ${inbox.stats}`);
  }
  if (inbox.historyCount !== "100件") {
    throw new Error(`locker2 history should stay capped: ${inbox.historyCount}`);
  }

  // 集計した住戸をまとめて登録一覧へ書き戻せること。
  await click("locker2InboxApply");
  await wait(120);
  const inboxApplied = await window.webContents.executeJavaScript(`
    (() => {
      const rows = document.querySelectorAll("#locker2Body tr");
      const read = (index) => ({
        command: rows[index].querySelector("select").value,
        numbers: Array.from(rows[index].querySelectorAll("input[type=number]")).map((input) => input.value),
      });
      return { first: read(0), fourth: read(3) };
    })()
  `);
  if (inboxApplied.first.command !== "17" || inboxApplied.first.numbers.join("-") !== "1-101") {
    throw new Error(`locker2 inbox bulk apply failed: ${JSON.stringify(inboxApplied)}`);
  }

  // ------------------------------- パナソニック：プロトコルを変えて読み直す
  await navigate("panasonic");
  // 自動アンサーバックは未接続では送れないので、ここでは受信解析だけを見る。
  await window.webContents.executeJavaScript(`${$("panaAutoAnswerback")}.checked = false`);
  await window.webContents.executeJavaScript(`${$("panaAutoResponse")}.checked = false`);
  await window.webContents.executeJavaScript(
    `(() => { const s = ${$("panaProtocol")}; s.value = "hpc"; s.dispatchEvent(new Event("change")); })()`
  );
  const hpcFrame = PanasonicAlarm.buildFrame({ protocol: "hpc", type: 0x01, infoBits: [7], buildingNo: 2, roomNo: 1201, historyNumber: 3 });
  // 分割で届いても1件として解析されること。
  await send(hpcFrame.slice(0, 4));
  await send(hpcFrame.slice(4));
  const panaHpc = await monitorOf("panaRx");
  if (panaHpc.verdict !== "検証OK" || panaHpc.fields["棟番号"] !== "2棟"
      || !panaHpc.fields["住戸番号"].includes("1201号室（ヒストリー3の応答）")
      || !panaHpc.fields["警報情報"].includes("住戸電源断")) {
    throw new Error(`panasonic HPC receive decode failed: ${JSON.stringify(panaHpc)}`);
  }

  // 受信履歴はバイト列で保持しているため、TSSへ切り替えると同じ電文を別の割付で読み直す。
  await window.webContents.executeJavaScript(
    `(() => { const s = ${$("panaProtocol")}; s.value = "tss"; s.dispatchEvent(new Event("change")); })()`
  );
  await wait(60);
  const panaReread = await monitorOf("panaRx");
  if (panaReread.verdict !== "検証NG" || !panaReread.notes.some((note) => note.includes("ヒストリー応答はありません"))) {
    throw new Error(`panasonic protocol re-read failed: ${JSON.stringify(panaReread)}`);
  }

  // 大興：レコード列を受信し、1行ずつ意味付きで分解できること。
  await window.webContents.executeJavaScript(
    `(() => { const s = ${$("panaProtocol")}; s.value = "daiko"; s.dispatchEvent(new Event("change")); })()`
  );
  const daikoFrame = PanasonicAlarm.buildFrame({
    protocol: "daiko",
    records: [{ mode: "N", buildingNo: 1, roomNo: 101, alarmNo: 1 }, { mode: "F", buildingNo: 1, roomNo: 101, alarmNo: 31 }],
  });
  await send(daikoFrame);
  const panaDaiko = await monitorOf("panaRx");
  if (panaDaiko.verdict !== "検証OK" || !panaDaiko.fields["レコード1"].includes("警報No.01 火災")
      || !panaDaiko.fields["レコード2"].includes("防犯１ｾｯﾄ/ﾘｾｯﾄ") || !panaDaiko.fields["レコード2"].includes("リセット")) {
    throw new Error(`panasonic daiko receive decode failed: ${JSON.stringify(panaDaiko)}`);
  }

  // 受信したレコードを送信フォームへ取り込めること。
  await click("panaRxApply");
  await wait(60);
  const panaApplied = await window.webContents.executeJavaScript(`({
    state: ${$("panaRecordState")}.textContent,
    rows: ${$("panaRecordRows")}.querySelectorAll("tr").length,
  })`);
  if (panaApplied.state !== "2/10レコード" || panaApplied.rows !== 2) {
    throw new Error(`panasonic record apply failed: ${JSON.stringify(panaApplied)}`);
  }
  // 選択中のプロトコルが違っても、電文から一意に決まれば自動で切り替わる。
  await window.webContents.executeJavaScript(
    `(() => { const s = ${$("panaProtocol")}; s.value = "daiko"; s.dispatchEvent(new Event("change")); })()`
  );
  await window.webContents.executeJavaScript(`${$("panaAutoDetect")}.checked = true`);
  // 汎用警報情報(05H)はHPCにしかない（30HはアイホンQ49-023Gにもあるため絞れない）。
  await send(PanasonicAlarm.buildFrame({ protocol: "hpc", type: 0x05, infoBits: [0], buildingNo: 1, roomNo: 101 }));
  await wait(80);
  const detected = await window.webContents.executeJavaScript(`({
    protocol: ${$("panaProtocol")}.value,
    verdict: ${$("panaRxVerdict")}.textContent,
    notes: Array.from(document.querySelectorAll("#panaRxNotes .receive-note")).map((node) => node.textContent),
  })`);
  if (detected.protocol !== "hpc" || !detected.notes.some((note) => note.includes("HPCの電文と判定"))) {
    throw new Error(`panasonic protocol auto-detect failed: ${JSON.stringify(detected)}`);
  }

  // 判定が一意にならない電文では切り替えず、候補と読みの違いを示す。
  await window.webContents.executeJavaScript(
    `(() => { const s = ${$("panaProtocol")}; s.value = "daiko"; s.dispatchEvent(new Event("change")); })()`
  );
  await send(PanasonicAlarm.buildFrame({ protocol: "daiko", records: [{ mode: "N", buildingNo: 1, roomNo: 101, alarmNo: 3 }] }));
  await wait(80);
  const ambiguous = await window.webContents.executeJavaScript(`({
    protocol: ${$("panaProtocol")}.value,
    notes: Array.from(document.querySelectorAll("#panaRxNotes .receive-note")).map((node) => node.textContent),
  })`);
  if (ambiguous.protocol !== "daiko"
      || !ambiguous.notes.some((note) => note.includes("いずれとしても成立します"))
      || !ambiguous.notes.some((note) => note.includes("大興なら「N01-0101：非常」"))) {
    throw new Error(`panasonic ambiguous protocol handling failed: ${JSON.stringify(ambiguous)}`);
  }

  // 自動判定を切れば、選択中のプロトコルのまま「成立しない」と示す。
  await window.webContents.executeJavaScript(`${$("panaAutoDetect")}.checked = false`);
  await send(PanasonicAlarm.buildFrame({ protocol: "tss", type: 0x44, infoBits: [0], buildingNo: 1, roomNo: 101 }));
  await wait(80);
  const kept = await window.webContents.executeJavaScript(`({
    protocol: ${$("panaProtocol")}.value,
    verdict: ${$("panaRxVerdict")}.textContent,
    notes: Array.from(document.querySelectorAll("#panaRxNotes .receive-note")).map((node) => node.textContent),
  })`);
  if (kept.protocol !== "daiko" || !kept.notes.some((note) => note.includes("選択中の大興では成立しません"))) {
    throw new Error(`panasonic auto-detect opt-out failed: ${JSON.stringify(kept)}`);
  }

  // アイホンQ49-023Gの電文は外形が同じでも判別でき、切り替えずに画面を案内する。
  await window.webContents.executeJavaScript(`${$("panaAutoDetect")}.checked = true`);
  await window.webContents.executeJavaScript(
    `(() => { const s = ${$("panaProtocol")}; s.value = "hpc"; s.dispatchEvent(new Event("change")); })()`
  );
  // 管理室からの発報はパナソニックのBCD住戸番号として成立しない。
  await send(AlarmProtocol.buildFrame({ type: 0x00, infoBits: [1], buildingNo: 1, managementNo: 1 }));
  await wait(80);
  const aiphoneDetected = await window.webContents.executeJavaScript(`({
    protocol: ${$("panaProtocol")}.value,
    notes: Array.from(document.querySelectorAll("#panaRxNotes .receive-note")).map((node) => node.textContent),
  })`);
  if (aiphoneDetected.protocol !== "hpc"
      || !aiphoneDetected.notes.some((note) => note.includes("アイホン Q49-023Gの電文と判定"))
      || !aiphoneDetected.notes.some((note) => note.includes("「警報（アイホン）」画面で送受信できます"))) {
    throw new Error(`aiphone alarm detection failed: ${JSON.stringify(aiphoneDetected)}`);
  }

  await click("panaRecordClear");
  await click("panaRxClear");

  // ------------------------- パナソニックEV：18byte電文と付加コードの意味づけ
  await navigate("panasonicElevator");
  // 自動応答は未接続では送れないため、ここでは受信解析だけを見る。
  await window.webContents.executeJavaScript(`${$("pevAutoResponse")}.checked = false`);
  await window.webContents.executeJavaScript(
    `(() => { const s = ${$("pevDirection")}; s.value = "fromElevator"; s.dispatchEvent(new Event("change")); })()`
  );
  const pevFrame = PanasonicElevator.buildFrame({ command: "IK", lbNo: 3, extraCode: "01" });
  // 分割で届いても1件として解析されること。
  await send(pevFrame.slice(0, 7));
  await send(pevFrame.slice(7));
  const pevRx = await monitorOf("pevRx");
  if (pevRx.verdict !== "検証OK" || pevRx.fields["CMD"] !== "IK 共同玄関解錠"
      || pevRx.fields["付加コード"] !== "01 管理室による共同玄関解錠"
      || pevRx.fields["LB番号"] !== "03番" || !pevRx.fields["BCC"].includes("一致")) {
    throw new Error(`panasonic elevator receive decode failed: ${JSON.stringify(pevRx)}`);
  }

  // 使えない桁に値が入っていれば仕様違反として示す。
  const pevBadRoom = pevFrame.slice();
  pevBadRoom[10] = "1".charCodeAt(0);
  pevBadRoom.splice(16, 2, ...PanasonicElevator.calculateBCC(pevBadRoom.slice(0, 16)));
  await send(pevBadRoom);
  const pevViolation = await monitorOf("pevRx");
  if (pevViolation.verdict !== "検証NG" || !pevViolation.notes.some((note) => note.includes("住戸番号は0000固定"))) {
    throw new Error(`panasonic elevator fixed-field check failed: ${JSON.stringify(pevViolation)}`);
  }

  // 受信内容を送信フォームへ取り込むと、動作側とコマンドまで揃う。
  await window.webContents.executeJavaScript(`${$("pevRxFollow")}.checked = false`);
  await window.webContents.executeJavaScript(
    `Array.from(document.querySelectorAll("#pevRxHistory .receive-history-item")).pop().click()`
  );
  await click("pevRxApply");
  await wait(60);
  const pevForm = await window.webContents.executeJavaScript(`({
    direction: ${$("pevDirection")}.value,
    command: ${$("pevCommand")}.value,
    extra: ${$("pevExtra")}.value,
    lb: ${$("pevLb")}.value,
  })`);
  if (pevForm.direction !== "toElevator" || pevForm.command !== "IK" || pevForm.extra !== "01" || pevForm.lb !== "3") {
    throw new Error(`panasonic elevator apply failed: ${JSON.stringify(pevForm)}`);
  }
  await window.webContents.executeJavaScript(`${$("pevRxFollow")}.checked = true`);
  await click("pevRxClear");

  // ------------------------------- 警報変換：受信した電文を別メーカー形式へ
  await navigate("bridge");
  await window.webContents.executeJavaScript(`${$("bridgeAuto")}.checked = false`);
  await window.webContents.executeJavaScript(`
    (() => {
      const set = (id, value) => { const s = document.getElementById(id); s.value = value; s.dispatchEvent(new Event("change")); };
      set("bridgeFrom", "aiphone");
      set("bridgePattern", "standard");
      set("bridgeTo", "daiko");
    })()
  `);
  // アイホンの火災＋非常（住戸101・1棟）
  await send(AlarmProtocol.buildFrame({ type: 0x00, infoBits: [1, 2], buildingNo: 1, roomNo: 101 }));
  await wait(90);
  const bridged = await window.webContents.executeJavaScript(`({
    verdict: ${$("bridgeVerdict")}.textContent,
    summary: ${$("bridgeSummary")}.textContent,
    preview: ${$("bridgePreview")}.textContent,
    rows: ${$("bridgeFrames")}.querySelectorAll("tr").length,
    badge: ${$("bridgeSpecBadge")}.textContent,
  })`);
  if (bridged.verdict !== "変換OK" || !bridged.summary.includes("火災＋非常")
      || !bridged.preview.startsWith("SNDN01010101<03>N01010103<03>")) {
    throw new Error(`alarm bridge conversion failed: ${JSON.stringify(bridged)}`);
  }
  if (bridged.badge !== "アイホン → 大興" || bridged.rows !== 1) {
    throw new Error(`alarm bridge result view failed: ${JSON.stringify(bridged)}`);
  }

  // 相手に枠がない警報は、落とした理由まで示す。
  await window.webContents.executeJavaScript(`
    (() => { const s = document.getElementById("bridgeFrom"); s.value = "hpc"; s.dispatchEvent(new Event("change")); })()
  `);
  await window.webContents.executeJavaScript(`
    (() => { const s = document.getElementById("bridgeTo"); s.value = "aiphone"; s.dispatchEvent(new Event("change")); })()
  `);
  // HPCの「水漏れ／コール」はアイホンの標準割付に枠がない。
  await send(PanasonicAlarm.buildFrame({ protocol: "hpc", type: 0x00, infoBits: [3], buildingNo: 1, roomNo: 101 }));
  await wait(90);
  const dropped = await window.webContents.executeJavaScript(`({
    verdict: ${$("bridgeVerdict")}.textContent,
    notes: Array.from(document.querySelectorAll("#bridgeNotes .receive-note")).map((node) => node.textContent),
    badges: Array.from(document.querySelectorAll("#bridgeBadges .receive-badge")).map((node) => node.textContent),
  })`);
  if (dropped.verdict !== "送れる警報がありません"
      || !dropped.notes.some((note) => note.includes("「水漏れ」はアイホンに対応する枠がないため送れません"))
      || !dropped.badges.some((badge) => badge.includes("送れない: 水漏れ"))) {
    throw new Error(`alarm bridge drop reporting failed: ${JSON.stringify(dropped)}`);
  }

  // 変換表は変換先に枠がない項目を数えて示す。
  const mapping = await window.webContents.executeJavaScript(`({
    note: ${$("bridgeTableNote")}.textContent,
    rows: ${$("bridgeMapping")}.querySelectorAll("tr").length,
  })`);
  if (!mapping.note.includes("HPC → アイホン") || !/項目は変換先に枠がありません/.test(mapping.note) || mapping.rows < 5) {
    throw new Error(`alarm bridge mapping table failed: ${JSON.stringify(mapping)}`);
  }
  // 宅配4線式 → マンションコントローラ。仕様の枠に沿って読み替えられること。
  await window.webContents.executeJavaScript(`
    (() => {
      const set = (id, value) => { const s = document.getElementById(id); s.value = value; s.dispatchEvent(new Event("change")); };
      set("bridgeMode", "device");
      set("bridgeDeviceFrom", "locker4");
      set("bridgeMcVersion", "3");
    })()
  `);
  await send(Telegram4.buildResponseTelegram({
    packageNo: 0, modelNo: 1,
    lockers: [
      { state: Telegram4.STATE.PARCEL, lockerNo: 5, buildingNo: 1, roomNo: 101 },
      { state: 0x32, lockerNo: 7, buildingNo: 1, roomNo: 103 },
    ],
  }));
  await wait(120);
  const device = await window.webContents.executeJavaScript(`({
    verdict: ${$("bridgeVerdict")}.textContent,
    summary: ${$("bridgeSummary")}.textContent,
    preview: ${$("bridgePreview")}.textContent,
    notes: Array.from(document.querySelectorAll("#bridgeNotes .receive-note")).map((node) => node.textContent),
    badge: ${$("bridgeSpecBadge")}.textContent,
    reverseHidden: ${$("bridgeReverseField")}.hidden,
    mappingNote: ${$("bridgeTableNote")}.textContent,
  })`);
  // 荷物あり(31H)は着荷状態へ、集荷預り(32H)は対応がないため落ちる。
  if (!device.summary.includes("ICボックス情報 1件（1件は送れません）")
      || !device.notes.some((note) => note.includes("ロッカー007の「集荷預かり」は送れません"))) {
    throw new Error(`device bridge conversion failed: ${JSON.stringify(device)}`);
  }
  if (device.verdict !== "変換OK（一部を送れません）" || !device.preview.startsWith("02 31 37 36 43 30 30 30 30 31 31")) {
    throw new Error(`device bridge frame failed: ${JSON.stringify(device)}`);
  }
  // 装置→MCは一方向のため、逆向き中継の選択は隠す。
  if (!device.reverseHidden || !device.mappingNote.includes("宅配ボックス 4線式(B方式) → マンションコントローラ")) {
    throw new Error(`device bridge form failed: ${JSON.stringify(device)}`);
  }

  // 非接触キーはゲート・住戸・個人番号がそのままキー情報へ載る。
  await window.webContents.executeJavaScript(
    `(() => { const s = document.getElementById("bridgeDeviceFrom"); s.value = "key"; s.dispatchEvent(new Event("change")); })()`
  );
  await send(NoncontactKey.buildTelegram({
    format: NoncontactKey.FORMAT.WITH_PERSON, gateNo: 2, buildingNo: 1, roomNo: 101, personNo: 3,
  }));
  await wait(120);
  const keyDevice = await window.webContents.executeJavaScript(`({
    verdict: ${$("bridgeVerdict")}.textContent,
    summary: ${$("bridgeSummary")}.textContent,
  })`);
  if (keyDevice.verdict !== "変換OK" || !keyDevice.summary.includes("ICキー情報-2（ゲート02 / B1B101 / 個人003）")) {
    throw new Error(`device bridge key conversion failed: ${JSON.stringify(keyDevice)}`);
  }

  // 警報モードへ戻す。
  await window.webContents.executeJavaScript(
    `(() => { const s = document.getElementById("bridgeMode"); s.value = "alarm"; s.dispatchEvent(new Event("change")); })()`
  );

  // 送信ポートは受信ポートとは別に開く。未接続のまま送ろうとしたら理由を出す。
  const bridgePort = await window.webContents.executeJavaScript(`
    (() => {
      const $ = (id) => document.getElementById(id);
      const before = { text: $("bridgePortText").textContent, connectDisabled: $("bridgePortConnect").disabled, disconnectDisabled: $("bridgePortDisconnect").disabled };
      // 変換先の規定に合わせる設定では、通信条件の欄は自動で埋まり編集できない。
      const set = (id, value) => { const s = $(id); s.value = value; s.dispatchEvent(new Event("change")); };
      set("bridgeTo", "daiko");
      set("bridgePortPreset", "auto");
      const auto = { baud: $("bridgeBaud").value, parity: $("bridgeParity").value, disabled: $("bridgeBaud").disabled, hint: $("bridgePortHint").textContent };
      set("bridgePortPreset", "custom");
      const manual = { disabled: $("bridgeBaud").disabled };
      set("bridgePortPreset", "auto");
      $("bridgePortConnect").click();
      return { before, auto, manual, rxPort: $("bridgeRxPort").value };
    })()
  `);
  // 大興は1200,N,8,1。変換先を選べば送信ポートの条件が自動で入る。
  if (bridgePort.auto.baud !== "1200" || bridgePort.auto.parity !== "none" || !bridgePort.auto.disabled) {
    throw new Error(`bridge port auto preset failed: ${JSON.stringify(bridgePort.auto)}`);
  }
  if (bridgePort.manual.disabled) {
    throw new Error(`bridge port manual entry failed: ${JSON.stringify(bridgePort.manual)}`);
  }
  if (!bridgePort.auto.hint.includes("送信ポートは大興の規定 1200,N,8,1 で開きます")) {
    throw new Error(`bridge port hint failed: ${JSON.stringify(bridgePort.auto.hint)}`);
  }
  if (bridgePort.before.text !== "送信ポート未接続" || bridgePort.before.connectDisabled || !bridgePort.before.disconnectDisabled) {
    throw new Error(`bridge port initial state failed: ${JSON.stringify(bridgePort.before)}`);
  }
  await new Promise((resolve) => setTimeout(resolve, 120));
  const bridgePortError = await window.webContents.executeJavaScript(
    `document.getElementById("communicationLog").textContent.includes("送信ポートのCOMポートを選択してください")`
  );
  if (!bridgePortError) throw new Error("bridge port without selection did not report a reason");

  await click("bridgeClearButton");

  // ------------------------------------- フレーム不成立でも受信内容を残す
  await navigate("key");
  // 先の履歴選択で追従を切っているため、最新表示へ戻してから受信させる。
  await window.webContents.executeJavaScript(`${$("keyRxFollow")}.checked = true`);
  await send([0x02, 0x41, 0x42, 0x03, 0x00]);
  const keyError = await monitorOf("keyRx");
  if (keyError.verdict !== "検証NG" || !keyError.badges.includes("フレーム不成立")) {
    throw new Error(`frame error was not surfaced: ${JSON.stringify(keyError)}`);
  }

  // 履歴消去で初期表示へ戻ること。
  await click("keyRxClear");
  await wait(60);
  const cleared = await monitorOf("keyRx");
  if (cleared.verdict !== "未受信" || cleared.historyCount !== "0件" || cleared.hex !== "—") {
    throw new Error(`receive monitor clear failed: ${JSON.stringify(cleared)}`);
  }

  return {
    key: key.summary,
    keyBad: keyBad.verdict,
    keyForm,
    locker4: l4.summary,
    locker4Applied: l4Rows,
    locker2: l2.summary,
    locker2Applied: l2Row,
    panasonic: panaHpc.summary,
    panasonicReread: panaReread.verdict,
    panasonicDaiko: panaDaiko.summary,
    panasonicElevator: pevRx.summary,
    panasonicElevatorViolation: pevViolation.verdict,
    frameError: keyError.badges,
    cleared: cleared.verdict,
  };
}

// 警報の発信情報ビットが実DOMで割付どおりに描画され、チェックとHEXが双方向に
// 同期し、発信種別に応じて選べる割付が切り替わることを確認する。
const ALARM_UI_SCRIPT = `
  (() => {
    const $ = (id) => document.getElementById(id);
    const boxes = () => Array.from($("alarmInfoBits").querySelectorAll("input[type=checkbox]"));
    const labels = () => boxes().map((box) => box.closest("label").querySelector("span").textContent);
    const change = (element, value) => {
      element.value = value;
      element.dispatchEvent(new Event("change"));
    };

    document.querySelector('[data-view="alarm"]').click();
    change($("alarmRole"), "intercom");
    change($("alarmType"), "00");
    change($("alarmBitPattern"), "standard");
    const standardLabels = labels();

    // 標準割付でbit1（火災）をONにするとHEXが01Hになる。
    const fire = boxes()[0];
    fire.checked = true;
    fire.dispatchEvent(new Event("change", { bubbles: true }));
    const fireHex = $("alarmInfo").value;
    const firePreview = (() => {
      $("alarmPreviewButton").click();
      return $("alarmPreview").textContent;
    })();

    // パターン１へ切り替えるとbit6・bit7に警戒情報が現れる。
    change($("alarmBitPattern"), "pattern1");
    const pattern1Labels = labels();

    // HEX側から30Hを入れるとbit5とbit6がONになる（仕様書5.5⑥）。
    $("alarmInfo").value = "30";
    $("alarmInfo").dispatchEvent(new Event("input"));
    const fromHex = boxes().map((box) => box.checked);
    const hint = $("alarmInfoHint").textContent;

    // 警戒設定情報には標準割付がないため、標準は選べずパターンへ寄せられる。
    change($("alarmType"), "04");
    const securityPattern = $("alarmBitPattern").value;
    const standardDisabled = Array.from($("alarmBitPattern").options)
      .find((option) => option.value === "standard").disabled;
    const securityLabels = labels();

    // ヒストリー要求は発信情報を持たないのでビット選択ごと無効になる。
    change($("alarmType"), "30");
    const requestDisabled = boxes().every((box) => box.disabled) && $("alarmBitPattern").disabled;
    const requestHint = $("alarmInfoHint").textContent;

    // 全bit OFFボタンで復旧電文（00H）に戻せる。
    change($("alarmType"), "00");
    $("alarmInfoClearButton").click();
    const clearedHex = $("alarmInfo").value;
    const clearedHint = $("alarmInfoHint").textContent;

    // チェックボックスが素の大きさで並んでいるか。width:100%が効くとラベルが
    // 1文字幅へ潰れて縦書きになるため、実測値で崩れを検出する。
    const firstBox = boxes()[0];
    const layout = {
      boxWidth: firstBox.offsetWidth,
      labelHeight: firstBox.closest("label").offsetHeight,
    };

    return {
      standardLabels,
      fireHex,
      firePreview,
      pattern1Labels,
      fromHex,
      hint,
      securityPattern,
      standardDisabled,
      securityLabels,
      requestDisabled,
      requestHint,
      clearedHex,
      clearedHint,
      layout,
    };
  })()
`;

// パナソニックは1画面で電文形式・通信条件・入力欄が入れ替わるため、
// 実DOM上でプロトコルを往復させて追従を確かめる。
const PANASONIC_UI_SCRIPT = `
  (() => {
    const $ = (id) => document.getElementById(id);
    const boxes = () => Array.from($("panaInfoBits").querySelectorAll("input[type=checkbox]"));
    const labels = () => boxes().map((box) => box.closest("label").querySelector("span").textContent);
    const change = (element, value) => {
      element.value = value;
      element.dispatchEvent(new Event("change"));
    };
    const preview = () => { $("panaPreviewButton").click(); return $("panaPreview").textContent; };

    document.querySelector('[data-view="panasonic"]').click();

    // HPC：STX形式のフォームと1200,E,8,1。
    change($("panaProtocol"), "hpc");
    change($("panaRole"), "ifu");
    change($("panaType"), "00");
    const hpc = {
      blockHidden: $("panaBlockForm").hidden,
      recordHidden: $("panaRecordForm").hidden,
      badge: $("panaSpecBadge").textContent,
      labels: labels(),
      historyHidden: $("panaHistoryField").hidden,
      historyDrawn: $("panaHistoryField").offsetHeight > 0,
      scheduledHidden: $("panaScheduledButton").hidden,
      scheduledDrawn: $("panaScheduledButton").offsetHeight > 0,
      typeCount: $("panaType").options.length,
    };

    // bit0（火災）をONにするとHEXが01Hになる。
    const fire = boxes()[0];
    fire.checked = true;
    fire.dispatchEvent(new Event("change", { bubbles: true }));
    $("panaBuilding").value = "1";
    $("panaRoom").value = "0101";
    const hpcHex = $("panaInfo").value;
    const hpcPreview = preview();

    // TSSは同じ00Hでもbit3以降の割付が違う。
    change($("panaProtocol"), "tss");
    const tss = {
      labels: labels(),
      types: Array.from($("panaType").options).map((option) => option.value),
      historyHidden: $("panaHistoryField").hidden,
      historyDrawn: $("panaHistoryField").offsetHeight > 0,
    };

    // HPCのヒストリー要求は警報情報・棟番号・住戸番号が00固定。
    change($("panaProtocol"), "hpc");
    change($("panaRole"), "peer");
    change($("panaType"), "30");
    const request = {
      infoValue: $("panaInfo").value,
      infoDisabled: $("panaInfo").disabled,
      buildingDisabled: $("panaBuilding").disabled,
      hint: $("panaInfoHint").textContent,
      preview: preview(),
    };

    // 大興：レコード形式へ入れ替わり、パリティなしの1200,N,8,1になる。
    change($("panaProtocol"), "daiko");
    change($("panaRole"), "ifu");
    const daiko = {
      blockHidden: $("panaBlockForm").hidden,
      recordHidden: $("panaRecordForm").hidden,
      badge: $("panaSpecBadge").textContent,
      alarmCount: $("panaAlarmNo").options.length,
      third: $("panaAlarmNo").options[2].textContent,
      scheduledHidden: $("panaScheduledButton").hidden,
      ackHidden: $("panaAckButton").hidden,
      propertyDrawn: $("panaPropertyField").offsetHeight > 0,
    };

    // レコードを2件積んで送信電文を組み立てる。
    $("panaRecordClear").click();
    change($("panaMode"), "N");
    change($("panaAlarmNo"), "01");
    $("panaRecordBuilding").value = "1";
    $("panaRecordRoom").value = "0101";
    $("panaRecordAdd").click();
    change($("panaMode"), "F");
    $("panaRecordAdd").click();
    const record = {
      rows: $("panaRecordRows").querySelectorAll("tr").length,
      state: $("panaRecordState").textContent,
      preview: preview(),
    };

    // リモート：警報No.が29件になり、定時送信が使える。03/04は大興と入れ替わる。
    change($("panaProtocol"), "remote");
    const remote = {
      alarmCount: $("panaAlarmNo").options.length,
      third: $("panaAlarmNo").options[2].textContent,
      hasDelivery: Array.from($("panaAlarmNo").options).some((option) => option.value === "40"),
      scheduledHidden: $("panaScheduledButton").hidden,
      propertyHidden: $("panaPropertyField").hidden,
      propertyDrawn: $("panaPropertyField").offsetHeight > 0,
      scheduledDrawn: $("panaScheduledButton").offsetHeight > 0,
    };

    $("panaRecordClear").click();
    change($("panaProtocol"), "hpc");
    return { hpc, hpcHex, hpcPreview, tss, request, daiko, record, remote };
  })()
`;

// パナソニックのエレベータ連動は、付加コードによって使える桁が変わる。
// 実DOM上でコマンドを往復させ、入力欄の有効・無効まで確かめる。
const PANASONIC_ELEVATOR_UI_SCRIPT = `
  (() => {
    const $ = (id) => document.getElementById(id);
    const change = (element, value) => {
      element.value = value;
      element.dispatchEvent(new Event("change"));
    };
    const preview = () => { $("pevPreviewButton").click(); return $("pevPreview").textContent; };
    const usage = () => ({
      building: !$("pevBuilding").disabled,
      room: !$("pevRoom").disabled,
      lb: !$("pevLb").disabled,
      hint: $("pevHint").textContent,
    });

    document.querySelector('[data-view="panasonicElevator"]').click();
    const badge = document.querySelector("#view-panasonicElevator .spec-badge").textContent;

    // IFU→エレベータでは4コマンド、エレベータ→IFUはヘルスチェック応答だけ。
    change($("pevDirection"), "toElevator");
    const toElevator = Array.from($("pevCommand").options).map((option) => option.value);
    change($("pevDirection"), "fromElevator");
    const fromElevator = Array.from($("pevCommand").options).map((option) => option.value);
    const health = { extras: Array.from($("pevExtra").options).map((option) => option.textContent), usage: usage() };

    // 住戸でのエレベータコールは棟・住戸だけを使う。
    change($("pevDirection"), "toElevator");
    change($("pevCommand"), "IE");
    $("pevBuilding").value = "1";
    $("pevRoom").value = "0101";
    const call = { usage: usage(), preview: preview() };

    // 共同玄関解錠は付加コードで住戸を特定できるかが変わる。
    change($("pevCommand"), "IK");
    change($("pevExtra"), "00");
    $("pevLb").value = "3";
    const unlockByRoom = { usage: usage(), preview: preview() };
    change($("pevExtra"), "01");
    const unlockByAdmin = { usage: usage(), preview: preview() };

    // ヘルスチェックは全桁が固定値。
    change($("pevCommand"), "IH");
    const healthRequest = { usage: usage(), preview: preview() };

    // 非接触キーID情報は付加コードの規定がないため直接入力になる。
    change($("pevCommand"), "SB");
    const keyInfo = {
      extraFreeHidden: $("pevExtraFreeField").hidden,
      extraFreeDrawn: $("pevExtraFreeField").offsetHeight > 0,
      usage: usage(),
    };

    change($("pevCommand"), "IE");
    return { badge, toElevator, fromElevator, health, call, unlockByRoom, unlockByAdmin, healthRequest, keyInfo };
  })()
`;

async function run({ window, app, sendToRenderer }) {
  try {
    const initial = await window.webContents.executeJavaScript(PROBE_SCRIPT);
    // 配布EXEの版を画面から特定できること。開発実行ではその旨が出る。
    if (!initial.versionLine.includes(`v${packageVersion}`) || initial.versionBadge !== `v${packageVersion}` ||
        !initial.versionValue.includes(`v${packageVersion}`) || !initial.readyLog) {
      throw new Error(`app version was not surfaced: ${JSON.stringify({
        line: initial.versionLine, badge: initial.versionBadge, value: initial.versionValue, readyLog: initial.readyLog,
      })}`);
    }
    if (!initial.buildValue.includes("開発実行") || !initial.runtimeValue.includes("Electron ")) {
      throw new Error(`build stamp was not surfaced: ${JSON.stringify({ build: initial.buildValue, runtime: initial.runtimeValue })}`);
    }
    if (initial.title !== "外部疑似装置 Next" || initial.views !== 14 || initial.modules.length || initial.previewErrors.length || !initial.ready) {
      throw new Error(`unexpected renderer state: ${JSON.stringify(initial)}`);
    }

    const locker = await window.webContents.executeJavaScript(LOCKER_UI_SCRIPT);
    if (locker.scriptError) throw new Error(`locker UI script failed: ${locker.scriptError}`);
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
    if (locker.assigned2.join(",") !== "1-101,1-102,1-103" || locker.assignedFloor.join(",") !== "1-101,1-201,1-301") {
      throw new Error(`locker2 bulk assignment failed: ${JSON.stringify(locker)}`);
    }
    if (locker.registered2 !== "2" || !locker.preview2.startsWith("#1 02 ") || !locker.preview2.includes("#2 02 ")) {
      throw new Error(`locker2 registration failed: ${JSON.stringify(locker)}`);
    }
    // 取り出しはボックス数に数えず、着荷へ戻すと登録2件がそのまま数えられる。
    if (locker.boxesAfterSwitch !== "0" || locker.boxes2 !== "2") {
      throw new Error(`locker2 box count failed: ${JSON.stringify(locker)}`);
    }
    // 旧版互換の巡回送信は全100件で、未登録の3件目は3FH埋めになる。
    if (locker.scopeAllLines !== 100 || locker.scopeAllThird !== "#3 02 3F 3F 3F 3F 3F 3F 30 30 33 03") {
      throw new Error(`locker2 full-scan scope failed: ${JSON.stringify({ lines: locker.scopeAllLines, third: locker.scopeAllThird })}`);
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

    const alarm = await window.webContents.executeJavaScript(ALARM_UI_SCRIPT);
    if (alarm.standardLabels[0] !== "bit1 火災、遠隔試験" || alarm.standardLabels[5] !== "bit6（未割付）") {
      throw new Error(`alarm standard bit labels failed: ${JSON.stringify(alarm.standardLabels)}`);
    }
    if (alarm.fireHex !== "01" || alarm.firePreview !== "02 37 00 01 00 00 01 00 01 03 3D") {
      throw new Error(`alarm bit-to-hex sync failed: ${JSON.stringify(alarm)}`);
    }
    if (alarm.pattern1Labels[5] !== "bit6 外出警戒◇" || alarm.pattern1Labels[6] !== "bit7 在宅警戒◇") {
      throw new Error(`alarm pattern1 labels failed: ${JSON.stringify(alarm.pattern1Labels)}`);
    }
    if (alarm.fromHex.join(",") !== "false,false,false,false,true,true,false,false") {
      throw new Error(`alarm hex-to-bit sync failed: ${JSON.stringify(alarm.fromHex)}`);
    }
    if (!alarm.hint.includes("防犯(侵入)＋外出警戒")) {
      throw new Error(`alarm info hint failed: ${alarm.hint}`);
    }
    if (alarm.securityPattern !== "pattern1" || !alarm.standardDisabled || alarm.securityLabels[0] !== "bit1 警戒設定◇") {
      throw new Error(`alarm security-set pattern fallback failed: ${JSON.stringify(alarm)}`);
    }
    if (!alarm.requestDisabled || !alarm.requestHint.includes("00H固定")) {
      throw new Error(`alarm history-request lockout failed: ${JSON.stringify(alarm)}`);
    }
    if (alarm.clearedHex !== "00" || !alarm.clearedHint.includes("全復旧")) {
      throw new Error(`alarm all-clear button failed: ${JSON.stringify(alarm)}`);
    }
    if (alarm.layout.boxWidth > 30 || alarm.layout.labelHeight > 40) {
      throw new Error(`alarm bit checkbox layout collapsed: ${JSON.stringify(alarm.layout)}`);
    }

    const pana = await window.webContents.executeJavaScript(PANASONIC_UI_SCRIPT);
    if (pana.hpc.blockHidden || !pana.hpc.recordHidden || pana.hpc.badge !== "1200,E,8,1" || pana.hpc.typeCount !== 7) {
      throw new Error(`panasonic HPC form failed: ${JSON.stringify(pana.hpc)}`);
    }
    if (pana.hpc.labels[0] !== "bit0 火災" || pana.hpc.labels[3] !== "bit3 水漏れ／コール" || pana.hpc.labels[7] !== "bit7 防犯(代表)") {
      throw new Error(`panasonic HPC bit labels failed: ${JSON.stringify(pana.hpc.labels)}`);
    }
    // hidden属性だけでなく、実際に描画から消えているかまで確かめる。
    if (pana.hpc.historyHidden || !pana.hpc.historyDrawn || !pana.hpc.scheduledHidden || pana.hpc.scheduledDrawn) {
      throw new Error(`panasonic HPC optional controls failed: ${JSON.stringify(pana.hpc)}`);
    }
    if (pana.hpcHex !== "01" || pana.hpcPreview !== "02 37 00 01 01 00 01 00 01 03 3E") {
      throw new Error(`panasonic bit-to-hex sync failed: ${JSON.stringify(pana)}`);
    }
    // TSSでは同じbit3が「水漏れ」、bit4が「コール」に分かれ、ヒストリーもない。
    if (pana.tss.labels[3] !== "bit3 水漏れ" || pana.tss.labels[4] !== "bit4 コール" || !pana.tss.historyHidden || pana.tss.historyDrawn) {
      throw new Error(`panasonic TSS bit labels failed: ${JSON.stringify(pana.tss)}`);
    }
    if (pana.tss.types.join(",") !== "00,01,02,04,44") {
      throw new Error(`panasonic TSS transmission types failed: ${JSON.stringify(pana.tss.types)}`);
    }
    if (pana.request.infoValue !== "00" || !pana.request.infoDisabled || !pana.request.buildingDisabled ||
        pana.request.preview !== "02 37 30 00 00 00 00 00 00 03 6A") {
      throw new Error(`panasonic history-request lockout failed: ${JSON.stringify(pana.request)}`);
    }
    if (!pana.daiko.blockHidden || pana.daiko.recordHidden || pana.daiko.badge !== "1200,N,8,1" ||
        pana.daiko.alarmCount !== 28 || pana.daiko.third !== "03 非常" || !pana.daiko.scheduledHidden ||
        pana.daiko.ackHidden || pana.daiko.propertyDrawn) {
      throw new Error(`panasonic daiko form failed: ${JSON.stringify(pana.daiko)}`);
    }
    if (pana.record.rows !== 2 || pana.record.state !== "2/10レコード" ||
        !pana.record.preview.startsWith("SNDN01010101<03>F01010101<03>")) {
      throw new Error(`panasonic record table failed: ${JSON.stringify(pana.record)}`);
    }
    if (pana.remote.alarmCount !== 29 || pana.remote.third !== "03 防犯(代表)" || !pana.remote.hasDelivery ||
        pana.remote.scheduledHidden || pana.remote.propertyHidden ||
        !pana.remote.propertyDrawn || !pana.remote.scheduledDrawn) {
      throw new Error(`panasonic remote form failed: ${JSON.stringify(pana.remote)}`);
    }

    // 通信条件の判別UI。COMポート未選択のまま押しても、理由を出して止まること。
    const scan = await window.webContents.executeJavaScript(`
      (() => {
        const $ = (id) => document.getElementById(id);
        document.querySelector('[data-view="settings"]').click();
        const initial = { state: $("scanState").value, rows: $("scanResults").textContent.trim(), applyDisabled: $("scanApply").disabled };
        const scopes = Array.from($("scanScope").options).map((option) => option.value);
        $("scanStart").click();
        return { initial, scopes, dwell: $("scanDwell").value };
      })()
    `);
    if (scan.initial.state !== "未実行" || scan.initial.rows !== "未実行" || !scan.initial.applyDisabled) {
      throw new Error(`link scan initial state failed: ${JSON.stringify(scan.initial)}`);
    }
    if (scan.scopes.join(",") !== "known,wide" || scan.dwell !== "3000") {
      throw new Error(`link scan options failed: ${JSON.stringify(scan)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 120));
    const scanBlocked = await window.webContents.executeJavaScript(`({
      state: document.getElementById("scanState").value,
      startDisabled: document.getElementById("scanStart").disabled,
      log: document.getElementById("communicationLog").textContent.includes("COMポートを選択してください"),
    })`);
    // ポート未選択なら失敗として扱い、ボタンは押せる状態へ戻す。
    if (!scanBlocked.log || scanBlocked.startDisabled) {
      throw new Error(`link scan without port failed: ${JSON.stringify(scanBlocked)}`);
    }

    const help = await window.webContents.executeJavaScript(`
      (() => {
        const $ = (id) => document.getElementById(id);
        // 各画面の見出しへ「使い方」ボタンが入っていること。
        const views = ["terminal", "locker4", "locker2", "key", "mansion", "elevator",
          "panasonicElevator", "alarm", "panasonic", "bridge", "faults", "settings"];
        const missing = views.filter((view) => !document.querySelector("#view-" + view + " .page-heading .help-open"));

        // 宅配4線式の「使い方」を押すと、説明画面のその節へ移動する。
        document.querySelector("#view-locker4 .page-heading .help-open").click();
        const opened = document.getElementById("view-help").classList.contains("active");
        const navActive = document.querySelector('.nav-item[data-view="help"]').classList.contains("active");
        const toc = $("helpToc").querySelectorAll("[data-help-jump]").length;
        const sections = document.querySelectorAll("#view-help .help-section").length;
        // 目次の項目がすべて実在する節を指していること。
        const brokenLinks = Array.from($("helpToc").querySelectorAll("[data-help-jump]"))
          .map((button) => button.dataset.helpJump)
          .filter((id) => !document.getElementById(id));
        return { missing, opened, navActive, toc, sections, brokenLinks, badge: $("helpVersionBadge").textContent };
      })()
    `);
    if (help.missing.length) throw new Error(`help buttons missing on: ${help.missing.join(", ")}`);
    if (!help.opened || !help.navActive) throw new Error(`help screen did not open: ${JSON.stringify(help)}`);
    if (help.brokenLinks.length) throw new Error(`help table of contents points to missing sections: ${help.brokenLinks.join(", ")}`);
    if (help.toc < 16 || help.sections < 15) throw new Error(`help content is incomplete: ${JSON.stringify(help)}`);
    if (!/^v[0-9]+\.[0-9]+\.[0-9]+$/.test(help.badge)) throw new Error(`help version badge failed: ${help.badge}`);

    const pev = await window.webContents.executeJavaScript(PANASONIC_ELEVATOR_UI_SCRIPT);
    if (pev.badge !== "9600,E,8,1" || pev.toElevator.join(",") !== "IE,IK,IH,SB" || pev.fromElevator.join(",") !== "SH") {
      throw new Error(`panasonic elevator command table failed: ${JSON.stringify(pev)}`);
    }
    // ヘルスチェック応答の付加コードは運行状態を表す。
    if (pev.health.extras.join(" / ") !== "00 正常運行中 / 01 点検中") {
      throw new Error(`panasonic elevator health extras failed: ${JSON.stringify(pev.health)}`);
    }
    // 住戸でのエレベータコールは棟・住戸だけを使い、LB番号は00固定。
    if (!pev.call.usage.building || !pev.call.usage.room || pev.call.usage.lb ||
        !pev.call.preview.startsWith("02 49 45 20 4E 30 31 30 31 30 31 30 30 30 30 03 45 32")) {
      throw new Error(`panasonic elevator call failed: ${JSON.stringify(pev.call)}`);
    }
    // 付加コード00は住戸を特定でき、01（管理室）では棟・住戸が固定値になる。
    if (!pev.unlockByRoom.usage.room || !pev.unlockByRoom.usage.lb) {
      throw new Error(`panasonic elevator unlock-by-room failed: ${JSON.stringify(pev.unlockByRoom)}`);
    }
    if (pev.unlockByAdmin.usage.building || pev.unlockByAdmin.usage.room || !pev.unlockByAdmin.usage.lb ||
        !pev.unlockByAdmin.usage.hint.includes("棟番号00・住戸番号0000")) {
      throw new Error(`panasonic elevator unlock-by-admin failed: ${JSON.stringify(pev.unlockByAdmin)}`);
    }
    // 管理室解錠でも棟・住戸は0で送る。
    if (!pev.unlockByAdmin.preview.startsWith("02 49 4B 20 4E 30 30 30 30 30 30 30 33 30 31 03")) {
      throw new Error(`panasonic elevator unlock-by-admin telegram failed: ${JSON.stringify(pev.unlockByAdmin.preview)}`);
    }
    if (pev.healthRequest.usage.building || pev.healthRequest.usage.room || pev.healthRequest.usage.lb ||
        !pev.healthRequest.preview.startsWith("02 49 48 20 4E 30 30 30 30 30 30 30 30 30 30 03 45 32")) {
      throw new Error(`panasonic elevator health request failed: ${JSON.stringify(pev.healthRequest)}`);
    }
    // 付加コードの規定がないSBだけ、2桁の直接入力欄が出る。
    if (pev.keyInfo.extraFreeHidden || !pev.keyInfo.extraFreeDrawn || !pev.keyInfo.usage.lb) {
      throw new Error(`panasonic elevator key-info form failed: ${JSON.stringify(pev.keyInfo)}`);
    }

    // 接続したまま画面を移ったときに通信条件の食い違いを警告するか。
    const presetWarning = await window.webContents.executeJavaScript(`
      (() => {
        const $ = (id) => document.getElementById(id);
        const read = () => ({ hidden: $("presetWarning").hidden, text: $("presetWarning").textContent });
        const go = (view) => document.querySelector('[data-view="' + view + '"]').click();

        // 未接続なら出さない。
        go("mansion");
        const disconnected = read();

        // 警報(1200)で接続したまま、マンションコントローラ(4800)へ移った状態を作る。
        applyConnectionState({ status: "open", sessionId: 1, options: { path: "COM_TEST", baudRate: 1200, dataBits: 8, stopBits: 1, parity: "even", flowControl: "none" } });
        go("alarm");
        const matched = read();
        go("mansion");
        const mismatched = read();

        // 規定どおりの条件で開き直せば消える。
        applyConnectionState({ status: "open", sessionId: 2, options: { path: "COM_TEST", baudRate: 4800, dataBits: 8, stopBits: 1, parity: "even", flowControl: "none" } });
        const fixed = read();
        applyConnectionState({ status: "closed" });
        const closed = read();
        return { disconnected, matched, mismatched, fixed, closed };
      })()
    `);
    if (!presetWarning.disconnected.hidden || !presetWarning.closed.hidden) {
      throw new Error(`preset warning must stay hidden while disconnected: ${JSON.stringify(presetWarning)}`);
    }
    if (!presetWarning.matched.hidden) {
      throw new Error(`preset warning must stay hidden when settings match: ${JSON.stringify(presetWarning.matched)}`);
    }
    if (presetWarning.mismatched.hidden
        || !presetWarning.mismatched.text.includes("4800,E,8,1")
        || !presetWarning.mismatched.text.includes("1200,E,8,1")) {
      throw new Error(`preset mismatch not reported: ${JSON.stringify(presetWarning.mismatched)}`);
    }
    if (!presetWarning.fixed.hidden) {
      throw new Error(`preset warning must clear once reopened correctly: ${JSON.stringify(presetWarning.fixed)}`);
    }

    // Q48-008I 6章のメッセージ定義から入力欄を組み立て、電文になるか。
    const mcPayload = await window.webContents.executeJavaScript(`
      (() => {
        const $ = (id) => document.getElementById(id);
        const set = (id, value) => { $(id).value = value; $(id).dispatchEvent(new Event("change")); };
        document.querySelector('[data-view="mansion"]').click();
        set("mcVersion", "3");
        set("mcRole", "IC");
        set("mcTopology", "standard");

        // 初期化要求：ROKはVer3の2値だけが出る。
        set("mcKind", "30");
        set("mcCommand", "41");
        const rok = $("mcField_ROK");
        const rokOptions = Array.from(rok.options).map((option) => option.textContent);
        rok.value = "52"; // 0x34 宅配通知無し（Ver3専用）
        $("mcPreviewButton").click();
        const initPreview = $("mcPreview").textContent;

        // 警報変化情報：ADDR + KH_INF。KH_INFはVer3で40bit。
        set("mcAddressType", "room");
        $("mcBuilding").value = "BB";
        $("mcAddressNumber").value = "101";
        set("mcKind", "35");
        set("mcCommand", "41");
        const note = $("mcPayloadNote").textContent;
        const boxes = Array.from($("mcAlarmBits").querySelectorAll("input[type=checkbox]"));
        const labels = boxes.map((box) => box.closest("label").querySelector("span").textContent);
        const reserved = boxes.filter((box) => box.disabled).length;
        const fire = boxes.find((box) => box.dataset.label === "火災");
        fire.checked = true;
        fire.dispatchEvent(new Event("change", { bubbles: true }));
        const alarmSummary = $("mcAlarmSummary").textContent;
        $("mcPreviewButton").click();
        const alarmPreview = $("mcPreview").textContent;

        // Ver1へ落とすと割付そのものが変わる（火災の隣がガス漏れになる）。
        set("mcVersion", "1");
        const v1Labels = Array.from($("mcAlarmBits").querySelectorAll("input[type=checkbox]"))
          .map((box) => box.closest("label").querySelector("span").textContent);
        set("mcVersion", "3");

        // 定義を使わない設定にすると入力欄が消え、生MESGへ戻る。
        $("mcUseSchema").checked = false;
        $("mcUseSchema").dispatchEvent(new Event("change"));
        const rawMode = { hidden: $("mcPayload").hidden === false && $("mcUseSchema").checked === false };
        $("mcUseSchema").checked = true;
        $("mcUseSchema").dispatchEvent(new Event("change"));

        // 宅配ボックス：ICボックス情報は 残PKT + PKT NO + STS + ADDR。
        set("mcKind", "36");
        set("mcCommand", "43");
        const boxNote = $("mcPayloadNote").textContent;
        const boxFields = Array.from($("mcPayloadFields").querySelectorAll("input,select")).map((element) => element.id);
        $("mcField_残PKT").value = "0";
        $("mcField_STS").value = "49"; // 0x31 着荷状態
        $("mcPreviewButton").click();
        const boxPreview = $("mcPreview").textContent;

        // 非接触キー：ICキー情報-1は ゲート + ADDR、-2は個人番号が付く。
        set("mcKind", "37");
        set("mcCommand", "61");
        $("mcField_ゲート").value = "2";
        $("mcPreviewButton").click();
        const keyPreview = $("mcPreview").textContent;
        set("mcCommand", "62");
        $("mcField_ゲート").value = "2";
        $("mcField_個人").value = "3";
        $("mcPreviewButton").click();
        const keyPersonPreview = $("mcPreview").textContent;
        const keyNote = $("mcPayloadNote").textContent;

        return { rokOptions, initPreview, note, labels, reserved, alarmSummary, alarmPreview, v1Labels, rawMode, boxNote, boxFields, boxPreview, keyPreview, keyPersonPreview, keyNote };
      })()
    `);
    if (mcPayload.rokOptions.length !== 2 || !mcPayload.rokOptions[0].includes("Ver3")) {
      throw new Error(`ROK options must be limited to the selected version: ${JSON.stringify(mcPayload.rokOptions)}`);
    }
    if (mcPayload.initPreview !== "02 30 36 30 41 34 03 40") {
      throw new Error(`initialization request payload wrong: ${mcPayload.initPreview}`);
    }
    if (!mcPayload.note.includes("ADDR + KH_INF")) {
      throw new Error(`payload note wrong: ${mcPayload.note}`);
    }
    // Ver3のKH_INFは10byte×4bit＝40、うち未使用は3つ（f・l・m）。
    if (mcPayload.labels.length !== 40 || mcPayload.reserved !== 3) {
      throw new Error(`KH_INF layout wrong: ${mcPayload.labels.length} bits / ${mcPayload.reserved} reserved`);
    }
    if (mcPayload.labels[0] !== "火災" || mcPayload.labels[1] !== "遠隔試験" || mcPayload.labels[32] !== "防犯１発報") {
      throw new Error(`KH_INF Ver3 labels wrong: ${JSON.stringify(mcPayload.labels.slice(0, 4))}`);
    }
    if (!mcPayload.alarmSummary.includes("10byte 31 30 30 30 30 30 30 30 30 30") || !mcPayload.alarmSummary.includes("火災")) {
      throw new Error(`KH_INF summary wrong: ${mcPayload.alarmSummary}`);
    }
    if (mcPayload.alarmPreview !== "02 32 31 35 41 42 42 42 31 30 31 31 30 30 30 30 30 30 30 30 30 03 07") {
      throw new Error(`alarm change telegram wrong: ${mcPayload.alarmPreview}`);
    }
    // Ver1は割付が別物（2番目がガス漏れ）。Verを変えたら並べ直すこと。
    if (mcPayload.v1Labels.length !== 24 || mcPayload.v1Labels[1] !== "ガス漏れ") {
      throw new Error(`KH_INF Ver1 layout wrong: ${JSON.stringify(mcPayload.v1Labels.slice(0, 3))}`);
    }
    if (!mcPayload.boxNote.includes("残PKT + PKT NO + STS + ADDR")) {
      throw new Error(`locker payload note wrong: ${mcPayload.boxNote}`);
    }
    if (mcPayload.boxFields.join(",") !== "mcField_残PKT,mcField_PKT NO,mcField_STS") {
      throw new Error(`locker payload fields wrong: ${JSON.stringify(mcPayload.boxFields)}`);
    }
    if (mcPayload.boxPreview !== "02 31 37 36 43 30 30 30 30 31 31 42 42 42 31 30 31 03 02") {
      throw new Error(`IC box telegram wrong: ${mcPayload.boxPreview}`);
    }
    if (mcPayload.keyPreview !== "02 31 33 37 61 30 32 42 42 42 31 30 31 03 27") {
      throw new Error(`IC key telegram wrong: ${mcPayload.keyPreview}`);
    }
    if (mcPayload.keyPersonPreview !== "02 31 36 37 62 30 32 42 42 42 31 30 31 30 30 33 03 12") {
      throw new Error(`IC key telegram with person wrong: ${mcPayload.keyPersonPreview}`);
    }
    if (!mcPayload.keyNote.includes("ゲート + ADDR + 個人")) {
      throw new Error(`key payload note wrong: ${mcPayload.keyNote}`);
    }

    const receiveMonitor = await verifyReceiveMonitors({ window, sendToRenderer });
    const layoutScroll = await verifyLayoutScroll({ window, sendToRenderer });

    console.log(`electron-smoke: OK ${JSON.stringify({ ...initial, locker, streamParsed: receiver.parsed, rxFrames: receiver.rxFrames, logUi, alarm, presetWarning, mcPayload, receiveMonitor, layoutScroll })}`);
    app.quit();
  } catch (error) {
    console.error(`electron-smoke: ${error && error.stack || error}`);
    app.exit(1);
  }
}

module.exports = { run };
