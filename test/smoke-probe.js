"use strict";
// npm run test:smoke 専用。Electronメインプロセスから読み込まれ、実描画された画面を検査する。
// 配布物には含めない（package.json の files に test/ を入れていない）。

const MansionController = require("../protocol/mansion-controller");
const Telegram2 = require("../protocol/locker2");
const Telegram4 = require("../protocol/locker4");
const NoncontactKey = require("../protocol/noncontact-key");

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
      modules: ["serialAPI", "Telegram2", "Telegram4", "Locker4Receiver", "NoncontactKey", "MansionController", "StreamDecoder", "FrameReader", "ElevatorProtocol", "AlarmProtocol", "HandshakeProtocol", "FaultEngine", "AutoResponder", "ReceiveInspector"]
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

async function run({ window, app, sendToRenderer }) {
  try {
    const initial = await window.webContents.executeJavaScript(PROBE_SCRIPT);
    if (initial.title !== "外部疑似装置 Next" || initial.views !== 10 || initial.modules.length || initial.previewErrors.length || !initial.ready) {
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

    const receiveMonitor = await verifyReceiveMonitors({ window, sendToRenderer });
    const layoutScroll = await verifyLayoutScroll({ window, sendToRenderer });

    console.log(`electron-smoke: OK ${JSON.stringify({ ...initial, locker, streamParsed: receiver.parsed, rxFrames: receiver.rxFrames, logUi, alarm, receiveMonitor, layoutScroll })}`);
    app.quit();
  } catch (error) {
    console.error(`electron-smoke: ${error && error.stack || error}`);
    app.exit(1);
  }
}

module.exports = { run };
