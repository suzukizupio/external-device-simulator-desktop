"use strict";

const $ = (id) => document.getElementById(id);
const CONTROL_NAMES = Object.freeze({ 0x02: "STX", 0x03: "ETX", 0x04: "EOT", 0x05: "ENQ", 0x06: "ACK", 0x15: "NAK" });
const DEFAULT_LOG_LIMIT = 20000;
const PROFILE_STORAGE_KEY = "external-device-simulator-next.profile.v1";

const state = {
  appInfo: null,
  connected: false,
  sessionId: 0,
  currentView: "overview",
  logs: [],
  filter: "all",
  txCount: 0,
  rxCount: 0,
  rxFrames: 0,
  errorCount: 0,
  search: "",
  logLimit: DEFAULT_LOG_LIMIT,
  controlWaiters: [],
  locker2Run: null,
  faultPlan: null,
  faultSignature: "",
  frameReader: null,
  frameReaderView: null,
  inboundLink: false,
  receiveTimer: null,
  alarmHistory: null,
  alarmHistoryPending: null,
  // パナソニックはプロトコルごとにヒストリーを持ち、切り替えても取り違えない。
  panaHistories: {},
  panaHistoryPending: null,
  panaRecords: [],
  // 大興／リモートのアンサーバックは伝送制御ではなく電文で届くため、
  // 制御コード待ちとは別の待ち行列で受け取る。
  panaAnswerWaiters: [],
  activeTransaction: null,
  lastIoAt: 0,
  manualReceiveStage: null,
  pendingFrameValid: null,
  locker4Inbound: null,
  locker4Series: null,
  locker4Rows: [],
  locker2Rows: [],
  // 2線式は全ロッカーを連続送信するため、住戸アドレス単位で最新状態を集計する。
  locker2Inbox: new Map(),
  locker2InboxStats: { total: 0, vacant: 0 },
  // 接続中のポート設定と、画面の規定と食い違ったときの警告文。
  connectionOptions: null,
  presetWarning: "",
  // 受信モニタ：機種ごとに履歴と表示中の1件を保持する。
  receiveMonitors: {},
};

// 受信モニタの対象機種と、画面ID接頭辞・履歴保持件数。
// 履歴は試験中に見返す範囲だけを保持し、全件は通信ログ側で担保する。
const RECEIVE_MONITORS = Object.freeze({
  locker4: { prefix: "locker4Rx", historyLimit: 50 },
  locker2: { prefix: "locker2Rx", historyLimit: 100 },
  key: { prefix: "keyRx", historyLimit: 100 },
  panasonic: { prefix: "panaRx", historyLimit: 100 },
  panasonicElevator: { prefix: "pevRx", historyLimit: 100 },
});

// Q55-001D 2.基本機能：住戸アドレスはMAX800（登録数の上限）。
// ボックス数（着荷・滞留の住戸数）は標準100、PATMOα40。
const LOCKER2_LIMITS = Object.freeze({
  standard: { maxBoxes: 100, maxBuilding: 8 },
  patmo: { maxBoxes: 40, maxBuilding: 1 },
});
const LOCKER2_STORED_COMMANDS = Object.freeze([0x11, 0x12]);
const MAX_LOCKER2_ROWS = 800;
const DEFAULT_LOCKER2_COUNT = 100;

// Q48-005F 4.3.4-5②：状態32H～35H・40H～42Hはdearis向け。
const LOCKER4_BASIC_STATES = Object.freeze([0x30, 0x31]);
const LOCKER4_DEARIS_STATES = Object.freeze([0x30, 0x31, 0x32, 0x33, 0x34, 0x35, 0x40, 0x41, 0x42]);
const LOCKER4_ROBOT_STATES = Object.freeze([0x40, 0x41, 0x42]);
const DEFAULT_LOCKER_COUNT = 100;

// Q48-006F 4.5：システム別の棟番号・個人番号制約。
const KEY_PROFILES = Object.freeze({
  other: { label: "その他のシステム", buildingMax: 9, personMax: 999 },
  vFine: { label: "V-fine", buildingMax: 6, personMax: 8 },
  dashVhx: { label: "Dash-VHX", buildingMax: 9, personMax: 8 },
  dashWism: { label: "DASHWISM", buildingMax: 9, personMax: 8 },
  fagus: { label: "FAGUS", buildingMax: 9, personMax: 8 },
  vixusAdvance: { label: "VIXUSAdvance", buildingMax: 8, personMax: 999 },
  patmoAlpha: { label: "PATMOα", buildingMax: 0, personMax: 999 },
});

function requireApi(name) {
  const api = window[name];
  if (!api) throw new Error(`${name} のプロトコルモジュールを読み込めません`);
  return api;
}

// ---------------------------------------------------------------- バージョン
// 試験の記録と不具合報告で「どの版で起きたか」を特定できるようにする。
// ビルド情報は tools/build-stamp.js がビルド時に埋め込むため、
// 開発実行ではその旨を表示する。
function formatBuildStamp(info) {
  if (!info.packaged) return "開発実行（npm start）";
  const at = info.builtAt && Number.isFinite(Date.parse(info.builtAt))
    ? `${formatDate(Date.parse(info.builtAt))} ${formatTime(Date.parse(info.builtAt)).slice(0, 8)}`
    : "ビルド日時不明";
  return info.commit ? `${at}（${info.commit}）` : at;
}

function versionSummary(info) {
  return `${info.name} v${info.version} / ${formatBuildStamp(info)}`
    + ` / Electron ${info.electron} / Chromium ${info.chrome} / Node ${info.node} / ${info.platform}`;
}

async function applyAppVersion() {
  const line = $("appVersionLine");
  if (!window.appAPI) {
    line.textContent = "通信仕様準拠シミュレータ（バージョン取得不可）";
    $("appVersionValue").textContent = "取得できません";
    $("appBuildValue").textContent = "—";
    $("appRuntimeValue").textContent = "—";
    return null;
  }
  const info = await window.appAPI.info();
  state.appInfo = info;
  line.textContent = `通信仕様準拠シミュレータ v${info.version}`;
  line.title = versionSummary(info);
  $("appVersionBadge").textContent = `v${info.version}`;
  $("appVersionValue").textContent = `${info.name} v${info.version}`;
  $("appBuildValue").textContent = formatBuildStamp(info);
  $("appRuntimeValue").textContent = `Electron ${info.electron} / Chromium ${info.chrome} / Node ${info.node} / ${info.platform}`;
  return info;
}

function toHex(bytes) {
  return Array.from(bytes || [], (byte) => Number(byte).toString(16).toUpperCase().padStart(2, "0")).join(" ");
}

function toAscii(bytes) {
  return Array.from(bytes || [], (byte) => {
    if (CONTROL_NAMES[byte]) return `<${CONTROL_NAMES[byte]}>`;
    return byte >= 0x20 && byte <= 0x7E ? String.fromCharCode(byte) : ".";
  }).join("");
}

function pad(value, width = 2) {
  return String(value).padStart(width, "0");
}

// ログ行には時刻だけを出し、日付は日付セパレータ行と保存ファイルで担保する。
function formatTime(at) {
  const date = new Date(at);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

function formatDate(at) {
  const date = new Date(at);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

let toastTimer = null;
function toast(message, error = false) {
  const element = $("toast");
  element.textContent = message;
  element.className = error ? "show error" : "show";
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { element.className = ""; }, 2800);
}

// atはシリアルイベントの発生時刻(epoch ms)。描画時刻ではなく実際の送受信時刻を記録する。
function addLog(kind, label, bytes, detail, at) {
  const occurredAt = Number.isFinite(at) ? at : Date.now();
  const previous = state.logs[state.logs.length - 1];
  const entry = {
    at: occurredAt,
    time: formatTime(occurredAt),
    kind,
    label,
    bytes: bytes == null ? null : Array.from(bytes),
    detail: detail || "",
  };
  state.logs.push(entry);
  while (state.logs.length > state.logLimit) state.logs.shift();

  const list = $("communicationLog");
  if (!previous || formatDate(previous.at) !== formatDate(occurredAt)) {
    const separator = document.createElement("div");
    separator.className = "log-date";
    separator.textContent = formatDate(occurredAt);
    list.append(separator);
  }

  const row = document.createElement("div");
  row.className = `log-entry ${kind}`;
  row.dataset.kind = kind;
  const meta = document.createElement("div");
  meta.className = "log-meta";
  const time = document.createElement("span");
  time.textContent = entry.time;
  const direction = document.createElement("span");
  direction.className = "log-dir";
  direction.textContent = label;
  meta.append(time, direction);
  row.append(meta);
  const hexText = entry.bytes ? toHex(entry.bytes) : "";
  const asciiText = entry.bytes ? toAscii(entry.bytes) : "";
  if (entry.bytes) {
    const hex = document.createElement("div");
    hex.className = "log-hex";
    hex.textContent = hexText;
    const ascii = document.createElement("div");
    ascii.className = "log-ascii";
    ascii.textContent = asciiText;
    row.append(hex, ascii);
  }
  if (entry.detail) {
    const info = document.createElement("div");
    info.className = "log-ascii";
    info.textContent = entry.detail;
    row.append(info);
  }
  row.dataset.search = `${label} ${hexText} ${asciiText} ${entry.detail}`.toLowerCase();

  list.append(row);
  while (list.childElementCount > state.logLimit) list.firstElementChild.remove();
  applyLogFilter(row);
  $("logCount").textContent = `${state.logs.length}件`;
  if ($("autoScroll").checked) list.scrollTop = list.scrollHeight;
}

function applyLogFilter(row) {
  const kind = row.dataset.kind;
  const matchesKind = state.filter === "all" || kind === state.filter ||
    (state.filter === "info" && ["info", "warn", "error"].includes(kind)) ||
    (state.filter === "fault" && ["warn", "error"].includes(kind));
  const matchesSearch = !state.search || (row.dataset.search || "").includes(state.search);
  row.classList.toggle("hidden", !(matchesKind && matchesSearch));
}

function refreshLogFilter() {
  document.querySelectorAll(".log-entry").forEach(applyLogFilter);
}

function logError(error, context) {
  state.errorCount += 1;
  updateMetrics();
  const message = String(error && error.message || error);
  addLog("error", "ERROR", null, context ? `${context}: ${message}` : message);
  toast(message, true);
}

function updateMetrics() {
  $("metricConnection").textContent = state.connected ? "接続中" : "未接続";
  $("metricTx").textContent = String(state.txCount);
  $("metricRx").textContent = String(state.rxFrames);
  $("metricRxDetail").textContent = `${state.rxCount}チャンク受信`;
  $("metricErrors").textContent = String(state.errorCount);
}

function setSequence(text) {
  $("sequenceState").textContent = text;
}

function parseHex(text) {
  const source = String(text || "").trim();
  if (!source) return [];
  if (/^[0-9a-fA-F]+$/.test(source) && source.length > 2) {
    if (source.length % 2 !== 0) throw new RangeError("連続HEXは偶数桁で入力してください");
    return source.match(/.{2}/g).map((token) => Number.parseInt(token, 16));
  }
  const tokens = source.split(/[\s,]+/).filter(Boolean);
  return tokens.map((token, index) => {
    if (!/^(?:0x)?[0-9a-fA-F]{2}$/.test(token)) throw new RangeError(`HEX ${index + 1}個目「${token}」が不正です`);
    return Number.parseInt(token.replace(/^0x/i, ""), 16);
  });
}

function parseHexByte(text, name) {
  const value = String(text || "").trim();
  if (!/^(?:0x)?[0-9a-fA-F]{2}$/.test(value)) throw new RangeError(`${name}は2桁HEXで入力してください`);
  return Number.parseInt(value.replace(/^0x/i, ""), 16);
}

function latin1(text, name = "ASCII") {
  return Array.from(String(text || ""), (character) => {
    const code = character.charCodeAt(0);
    if (code > 0xFF) throw new RangeError(`${name}には1byteで表せない文字「${character}」があります`);
    return code;
  });
}

function integerValue(id, name, min, max) {
  const value = Number($(id).value);
  if (!Number.isInteger(value) || value < min || value > max) throw new RangeError(`${name}は${min}～${max}で入力してください`);
  return value;
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function withTransaction(name, operation) {
  if (state.activeTransaction) throw new Error(`${state.activeTransaction}の通信処理が実行中です`);
  state.activeTransaction = name;
  try {
    return await operation();
  } finally {
    state.activeTransaction = null;
  }
}

// 相手機器が送信し続けると回線が空かないため、待機そのものにも上限を設ける。
async function waitForBusIdle(milliseconds, timeoutMs = Math.max(milliseconds * 20, 3000)) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const remaining = milliseconds - (Date.now() - state.lastIoAt);
    if (remaining <= 0) return true;
    const left = deadline - Date.now();
    if (left <= 0) {
      addLog("warn", "IDLE", null, `${milliseconds}msの回線空き待ちが${timeoutMs}msで上限に達したため送信を継続します`);
      return false;
    }
    await sleep(Math.min(remaining, left));
  }
}

function serialOptions() {
  const path = $("serialPort").value;
  if (!path) throw new RangeError("COMポートを選択してください");
  return {
    path,
    baudRate: integerValue("serialBaud", "ボーレート", 50, 4_000_000),
    dataBits: Number($("serialDataBits").value),
    stopBits: Number($("serialStopBits").value),
    parity: $("serialParity").value,
    flowControl: $("serialFlow").value,
  };
}

const SERIAL_PRESETS = Object.freeze({
  locker: { baudRate: 4800, dataBits: 8, stopBits: 1, parity: "even", flowControl: "none" },
  key: { baudRate: 9600, dataBits: 8, stopBits: 1, parity: "even", flowControl: "none" },
  elevator: { baudRate: 1200, dataBits: 8, stopBits: 1, parity: "even", flowControl: "none" },
  alarm: { baudRate: 1200, dataBits: 8, stopBits: 1, parity: "even", flowControl: "none" },
  // 大興／リモートはパリティビットを持たず、チェックサムだけで誤りを検出する。
  panasonicRecord: { baudRate: 1200, dataBits: 8, stopBits: 1, parity: "none", flowControl: "none" },
  panasonicElevator: { baudRate: 9600, dataBits: 8, stopBits: 1, parity: "even", flowControl: "none" },
});

// 画面ごとに通信仕様が定める条件が違うため、対応するプリセットを引けるようにする。
const VIEW_PRESETS = Object.freeze({
  locker2: "locker",
  locker4: "locker",
  mansion: "locker",
  key: "key",
  elevator: "elevator",
  alarm: "alarm",
  panasonicElevator: "panasonicElevator",
});

// パナソニックだけは1画面で4プロトコルを扱い、HPC／TSSが1200,E,8,1、
// 大興／リモートが1200,N,8,1と条件が分かれるため、選択中の値から引く。
function viewPreset(view) {
  if (view !== "panasonic") return VIEW_PRESETS[view] || null;
  return panasonicStyle() === requireApi("PanasonicAlarm").STYLE.BLOCK ? "alarm" : "panasonicRecord";
}

function presetLabel(preset) {
  return `${preset.baudRate},${preset.parity === "even" ? "E" : preset.parity === "odd" ? "O" : "N"},${preset.dataBits},${preset.stopBits}`;
}

// 接続したまま画面を移ると通信条件が前の機種のまま残る。ボーレート違いは
// 受信が化けるだけで気づきにくいので、接続中の実設定と突き合わせて警告する。
function hidePresetWarning(element) {
  element.hidden = true;
  element.textContent = "";
  element.title = "";
  state.presetWarning = "";
}

function updatePresetWarning() {
  const element = $("presetWarning");
  if (!element) return;
  const expected = SERIAL_PRESETS[viewPreset(state.currentView)];
  const actual = state.connectionOptions;
  if (!state.connected || !expected || !actual) {
    hidePresetWarning(element);
    return;
  }
  const differs = ["baudRate", "dataBits", "stopBits", "parity"].some((key) => actual[key] !== expected[key]);
  if (!differs) {
    hidePresetWarning(element);
    return;
  }
  const message = `通信条件が違います：この画面は ${presetLabel(expected)}／接続中は ${presetLabel(actual)}`;
  element.hidden = false;
  element.textContent = `⚠ ${presetLabel(expected)} で接続してください（現在 ${presetLabel(actual)}）`;
  element.title = message + "。切断してプリセットを選び直してください。";
  // 同じ警告をログへ何度も積まない。
  if (state.presetWarning !== message) {
    state.presetWarning = message;
    addLog("warn", "PRESET", null, message);
  }
}

function applySerialPreset(name) {
  const preset = SERIAL_PRESETS[name];
  if (!preset) return;
  $("serialBaud").value = preset.baudRate;
  $("serialDataBits").value = preset.dataBits;
  $("serialStopBits").value = preset.stopBits;
  $("serialParity").value = preset.parity;
  $("serialFlow").value = preset.flowControl;
}

async function refreshPorts() {
  if (!window.serialAPI) return;
  try {
    const previous = $("serialPort").value;
    const ports = await window.serialAPI.list();
    $("serialPort").replaceChildren();
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = ports.length ? "COMポートを選択" : "利用可能なポートなし";
    $("serialPort").append(placeholder);
    for (const port of ports) {
      const option = document.createElement("option");
      option.value = port.path;
      const label = port.friendlyName || port.manufacturer;
      option.textContent = label ? `${port.path} — ${label}` : port.path;
      $("serialPort").append(option);
    }
    if (previous && ports.some((port) => port.path === previous)) $("serialPort").value = previous;
    addLog("info", "PORT", null, `${ports.length}件のポートを検出`);
  } catch (error) {
    logError(error, "ポート一覧取得");
  }
}

function applyConnectionState(snapshot) {
  const status = snapshot && snapshot.status || "closed";
  state.connected = status === "open";
  state.sessionId = snapshot && snapshot.sessionId || 0;
  $("connectionDot").className = status;
  const labels = { closed: "未接続", opening: "接続中…", open: "接続済み", error: "接続エラー" };
  $("connectionText").textContent = labels[status] || status;
  $("connectButton").disabled = status === "opening" || status === "open";
  $("disconnectButton").disabled = !["open", "opening", "error"].includes(status);
  $("serialPort").disabled = status === "opening" || status === "open";
  document.querySelectorAll(".requires-connection").forEach((button) => { button.disabled = !state.connected; });
  $("metricPort").textContent = snapshot && snapshot.options ? `${snapshot.options.path} / ${snapshot.options.baudRate}` : "—";
  state.connectionOptions = state.connected && snapshot ? snapshot.options || null : null;
  updatePresetWarning();
  if (!state.connected) {
    rejectControlWaiters(new Error("シリアル接続が切断されました"));
    rejectPanasonicAnswerWaiters(new Error("シリアル接続が切断されました"));
    resetFrameReader();
    state.inboundLink = false;
    state.manualReceiveStage = null;
    state.pendingFrameValid = null;
    resetLocker4Inbound();
    state.lastIoAt = 0;
    clearReceiveTimer();
    if (keyReceiver) keyReceiver.reset();
  }
  updateMetrics();
}

async function connect() {
  try {
    const snapshot = await window.serialAPI.open(serialOptions());
    state.lastIoAt = Date.now();
    applyConnectionState(snapshot);
    addLog("info", "OPEN", null, `${snapshot.options.path} ${snapshot.options.baudRate},${snapshot.options.parity},${snapshot.options.dataBits},${snapshot.options.stopBits}`);
  } catch (error) {
    logError(error, "接続");
  }
}

async function disconnect() {
  try {
    const snapshot = await window.serialAPI.close();
    applyConnectionState(snapshot);
    addLog("info", "CLOSE", null, "シリアルポートを切断");
  } catch (error) {
    logError(error, "切断");
  }
}

function faultConfiguration() {
  return {
    preset: $("faultPreset").value,
    target: $("faultTarget").value,
    occurrence: $("faultOccurrence").value,
    delayMs: Number($("faultDelay").value),
  };
}

function currentFaultPlan() {
  const config = faultConfiguration();
  const signature = JSON.stringify(config);
  if (state.faultPlan && signature === state.faultSignature) return state.faultPlan;
  const Fault = requireApi("FaultEngine");
  const occurrence = config.occurrence === "every" ? "every" : Number(config.occurrence);
  const target = config.target === "all" ? "*" : config.target;
  const actions = Fault.ACTION;
  let rules = [];
  if (config.preset === "bad-bcc") rules = [{ phase: "frame", occurrence, action: actions.CORRUPT_LAST, note: "BCC異常" }];
  else if (config.preset === "missing-bcc") rules = [{ phase: "frame", occurrence, action: actions.OMIT_LAST, note: "BCC欠落" }];
  else if (config.preset === "delay") rules = [{ phase: target, direction: "tx", occurrence, action: actions.DELAY, delayMs: config.delayMs, note: "送信遅延" }];
  else if (config.preset === "drop") rules = [{ phase: target, direction: "tx", occurrence, action: actions.DROP, note: "無送信" }];
  else if (config.preset === "duplicate-stx") rules = [{ phase: "frame", occurrence, action: actions.DUPLICATE_STX, note: "STX重複" }];
  state.faultPlan = new Fault.FaultPlan(rules);
  state.faultSignature = signature;
  return state.faultPlan;
}

async function transmit(bytes, phase = "frame") {
  if (!state.connected) throw new Error("シリアルポートが未接続です");
  const result = currentFaultPlan().apply({ bytes, phase, direction: "tx" });
  if (result.applied) addLog("warn", "FAULT", result.bytes, `${result.note || result.action} (${result.ruleId}, ${result.count}回目)`);
  if (result.delayMs > 0) await sleep(result.delayMs);
  if (result.bytes == null) return { dropped: true };
  const written = await window.serialAPI.write(result.bytes);
  state.lastIoAt = Date.now();
  return written;
}

function createControlWaiter(timeoutMs, acceptedCodes = [0x05, 0x06, 0x15]) {
  let waiter;
  const promise = new Promise((resolve, reject) => {
    waiter = { resolve, reject, timer: null, acceptedCodes: new Set(acceptedCodes), done: false };
    state.controlWaiters.push(waiter);
  });
  promise.catch(() => undefined);
  return {
    promise,
    arm() {
      if (waiter.done || waiter.timer) return;
      waiter.timer = setTimeout(() => {
        const index = state.controlWaiters.indexOf(waiter);
        if (index !== -1) state.controlWaiters.splice(index, 1);
        waiter.done = true;
        waiter.reject(new Error("ACK待ちタイムアウト"));
      }, timeoutMs);
    },
    cancel() {
      const index = state.controlWaiters.indexOf(waiter);
      if (index !== -1) state.controlWaiters.splice(index, 1);
      waiter.done = true;
      clearTimeout(waiter.timer);
    },
  };
}

function dispatchControl(bytes) {
  if (state.controlWaiters.length === 0 || bytes.length !== 1) return false;
  const value = bytes[0];
  if (![0x05, 0x06, 0x15].includes(value)) return false;
  const waiter = state.controlWaiters[0];
  if (!waiter.acceptedCodes.has(value)) return false;
  state.controlWaiters.shift();
  waiter.done = true;
  clearTimeout(waiter.timer);
  waiter.resolve(value);
  return true;
}

function rejectControlWaiters(error) {
  for (const waiter of state.controlWaiters.splice(0)) {
    waiter.done = true;
    clearTimeout(waiter.timer);
    waiter.reject(error);
  }
}

function viewUsesHandshake(view) {
  // パナソニックはHPC／TSSだけがENQ–ACK–TEXT–ACKの手順を持つ。
  // 大興／リモートのアンサーバックは伝送制御コードではなく電文で返す。
  if (view === "panasonic") return panasonicStyle() === requireApi("PanasonicAlarm").STYLE.BLOCK;
  return ["locker4", "mansion", "elevator", "alarm", "panasonicElevator"].includes(view);
}

function clearReceiveTimer() {
  if (state.receiveTimer) clearTimeout(state.receiveTimer);
  state.receiveTimer = null;
}

function resetLocker4Inbound() {
  state.locker4Inbound = null;
  if (state.locker4Series) state.locker4Series.abort();
}

function receiveTimeoutFor(view, stage) {
  if (view === "locker4") return stage === "link" ? 5_000 : 60_000;
  // パナソニックはテキスト待ち（HPC 1秒／TSS 2秒）と
  // アンサーバック待ち（大興・リモート 5秒）を仕様値どおりに使う。
  if (view === "panasonic") {
    const info = panasonicInfo();
    return info.style === requireApi("PanasonicAlarm").STYLE.BLOCK ? info.textWaitMs : info.answerbackTimeoutMs;
  }
  // パナソニックのエレベータ連動は、ACK送出後5秒でEOT／次データが来なければ相手の送信終了とみなす。
  if (view === "panasonicElevator") return requireApi("PanasonicElevator").TIMING.idleAfterAckMs;
  if (["mansion", "elevator", "alarm"].includes(view)) return 6_000;
  return null;
}

function armReceiveTimer(view, stage = "frame") {
  const timeoutMs = receiveTimeoutFor(view, stage);
  if (!timeoutMs) return;
  const shouldRestart = stage === "link" || (view === "locker4" && stage === "frame");
  if (state.receiveTimer && !shouldRestart) return;
  clearReceiveTimer();
  state.receiveTimer = setTimeout(() => {
    const partial = [];
    if (state.frameReader) {
      for (const event of state.frameReader.flush()) partial.push(...event.bytes);
    }
    state.inboundLink = false;
    state.receiveTimer = null;
    resetLocker4Inbound();
    addLog("warn", "RX-TIMEOUT", partial.length ? partial : null, `受信完了タイムアウト (${timeoutMs / 1000}秒)`);
    setSequence("受信タイムアウト");
  }, timeoutMs);
}

// 伝送制御コードは機種で違う。パナソニックのエレベータ連動は正常応答が10H／30Hで、
// NAKに相当する応答を持たないため、異常時は無応答のまま相手の再送を待つ。
function transportCodes(view) {
  if (view !== "panasonicElevator") return { ack: 0x06, nak: 0x15 };
  return { ack: panasonicElevatorAckCode(), nak: null };
}

function isTransportAck(view, control) {
  if (control == null) return false;
  if (view === "panasonicElevator") return requireApi("PanasonicElevator").isAck(control);
  return control === transportCodes(view).ack;
}

// 30Hは'0'と同値のため、ログのASCII表示では制御コード名にしない（CONTROL_NAMESへ入れない）。
function controlName(view, code) {
  if (view === "panasonicElevator" && window.PanasonicElevator && window.PanasonicElevator.isAck(code)) return "ACK";
  return CONTROL_NAMES[code] || `${Number(code).toString(16).toUpperCase().padStart(2, "0")}H`;
}

async function sendAutomaticResponse(valid, stage) {
  const mode = $("autoTransportResponse").value;
  if (mode === "manual") return null;
  if (mode === "drop") {
    addLog("warn", "AUTO", null, `${stage}への応答を抑止`);
    return null;
  }
  const delay = Number($("autoResponseDelay").value);
  if (!Number.isFinite(delay) || delay < 0 || delay > 60000) throw new RangeError("自動応答遅延は0～60000msで指定してください");
  if (delay) await sleep(delay);
  const view = state.currentView;
  const codes = transportCodes(view);
  const control = mode === "ack" ? codes.ack : mode === "nak" ? codes.nak : (valid ? codes.ack : codes.nak);
  if (control == null) {
    addLog("warn", "AUTO", null, `${stage}へ応答しません（この機種にNAKはなく、相手の再送を待ちます）`);
    return null;
  }
  await transmit([control], "response");
  addLog(isTransportAck(view, control) ? "info" : "warn", "AUTO", [control], `${stage}へ${controlName(view, control)}`);
  return control;
}

function handleInboundControl(bytes, consumedBySender) {
  if (consumedBySender || !viewUsesHandshake(state.currentView) || bytes.length !== 1) return;
  if (bytes[0] === 0x04 && state.currentView === "locker4") {
    clearReceiveTimer();
    let completed = null;
    try { completed = state.locker4Series.finish(); } catch (_error) { /* logged below */ }
    addLog(completed ? "info" : "warn", "EOT", bytes, completed ? `4線式 ${completed.packetCount}パケット受信完了` : "パケット列が未完了のままEOTを受信");
    state.locker4Inbound = null;
    state.inboundLink = false;
    state.manualReceiveStage = null;
    setSequence(completed ? "EOT受信・完了" : "EOT受信・パケット不足");
    return;
  }
  if (bytes[0] === 0x04 && state.currentView === "panasonicElevator") {
    clearReceiveTimer();
    state.inboundLink = false;
    addLog("info", "EOT", bytes, "相手装置の送信終了");
    setSequence("EOT受信・完了");
    return;
  }
  if (bytes[0] !== 0x05) return;
  state.inboundLink = false;
  if ($("autoTransportResponse").value === "manual") {
    state.manualReceiveStage = "link-response";
    setSequence("ENQへ手動ACK/NAK待ち");
    return;
  }
  sendAutomaticResponse(true, "ENQ").then((control) => {
    state.inboundLink = isTransportAck(state.currentView, control);
    if (state.inboundLink) {
      armReceiveTimer(state.currentView, "link");
      setSequence("受信電文待ち");
    }
  }).catch((error) => logError(error, "ENQ自動応答"));
}

function handleCompletedInboundFrame(valid) {
  clearReceiveTimer();
  if (!valid && state.currentView === "locker4") resetLocker4Inbound();
  if (!state.inboundLink || !viewUsesHandshake(state.currentView)) return Promise.resolve(null);
  state.inboundLink = false;
  if ($("autoTransportResponse").value === "manual") {
    state.manualReceiveStage = "frame-response";
    state.pendingFrameValid = valid;
    setSequence(`電文へ手動ACK/NAK待ち (${valid ? "検証OK" : "検証NG"})`);
    return Promise.resolve(null);
  }
  return sendAutomaticResponse(valid, "電文").then((control) => {
    if (control === 0x06 && state.currentView === "locker4" && state.locker4Inbound) {
      armReceiveTimer("locker4", "link");
      setSequence(state.locker4Inbound.expectedPackage < 0 ? "ACK送信・EOT待ち" : `ACK送信・package ${state.locker4Inbound.expectedPackage}待ち`);
    } else {
      setSequence(isTransportAck(state.currentView, control) ? "受信完了" : control == null ? "応答なし" : "受信異常");
    }
    return control;
  }).catch((error) => {
    logError(error, "電文自動応答");
    return null;
  });
}

async function runHandshake(packets, options) {
  const H = requireApi("HandshakeProtocol");
  const opts = options || {};
  const fsm = new H.SendHandshakeFSM({
    packets,
    maxRetries: opts.maxRetries == null ? 5 : opts.maxRetries,
    sendEot: opts.sendEot !== false,
    textRetryMode: opts.textRetryMode || "restart",
  });
  const queue = fsm.start();
  setSequence("ENQ送信");

  while (queue.length) {
    const event = queue.shift();
    if (event.type === "retry") {
      addLog("warn", "RETRY", null, `${event.reason} / ${event.retriesUsed}/${event.maxRetries}`);
      continue;
    }
    if (event.type === "failed") {
      setSequence("失敗");
      throw new Error(`再送上限に到達しました (${event.reason})`);
    }
    if (event.type === "complete") {
      setSequence("完了");
      addLog("info", "SEQ", null, `正常完了 / 再送${event.retriesUsed}回`);
      return event;
    }
    if (event.type !== "send") continue;

    if (event.kind === "EOT") {
      setSequence("EOT送信");
      await transmit(event.bytes, "eot");
      continue;
    }

    if (event.kind === "ENQ" && opts.idleBeforeEnqMs) await waitForBusIdle(opts.idleBeforeEnqMs);
    const timeout = event.kind === "ENQ" ? (opts.linkTimeoutMs || 1000) : (opts.textTimeoutMs || 1000);
    setSequence(event.kind === "ENQ" ? "リンクACK待ち" : `電文ACK待ち ${event.packetIndex + 1}/${event.packetCount}`);
    const waiter = createControlWaiter(timeout);
    try {
      await transmit(event.bytes, event.kind === "TEXT" ? "frame" : "enq");
      waiter.arm();
      const control = await waiter.promise;
      if (control === H.CODE.ENQ) {
        if (opts.priority) {
          queue.push(...fsm.timeout("collision-priority"));
        } else {
          state.inboundLink = true;
          armReceiveTimer(state.currentView, "link");
          try {
            await transmit([H.CODE.ACK], "response");
          } catch (error) {
            state.inboundLink = false;
            clearReceiveTimer();
            throw error;
          }
          fsm.cancel("collision-yield");
          setSequence("衝突・受信へ譲渡");
          addLog("warn", "COLLISION", [H.CODE.ENQ], "相手機器へ送信権を譲り、受信電文を待機");
          return { type: "yielded" };
        }
      } else {
        queue.push(...fsm.receiveControl(control));
      }
    } catch (error) {
      waiter.cancel();
      if (/ACK待ちタイムアウト/.test(String(error.message))) queue.push(...fsm.timeout("timeout"));
      else throw error;
    }
  }
  throw new Error("送信シーケンスが完了せず終了しました");
}

function terminalFrame() {
  let bytes = $("terminalMode").value === "hex" ? parseHex($("terminalPayload").value) : latin1($("terminalPayload").value);
  if ($("terminalStx").checked) bytes.unshift(0x02);
  if ($("terminalEtx").checked) bytes.push(0x03);
  const method = $("terminalBcc").value;
  if (method !== "none") {
    let value = 0;
    const start = bytes[0] === 0x02 ? 1 : 0;
    for (let index = start; index < bytes.length; index += 1) value = method === "xor" ? value ^ bytes[index] : (value + bytes[index]) & 0xFF;
    if ($("terminalBadBcc").checked) value ^= 0x01;
    bytes.push(value & 0xFF);
  }
  if (bytes.length === 0) throw new RangeError("送信データが空です");
  return bytes;
}

function locker2Limits() {
  return LOCKER2_LIMITS[$("locker2Profile").value] || LOCKER2_LIMITS.standard;
}

// 住戸アドレスは登録順の連番そのものなので、行の no をそのまま使う。
function createLocker2Row(no) {
  return { no, command: 0x11, buildingNo: 0, roomNo: 0, selected: false };
}

function createLocker2Rows(count) {
  return Array.from({ length: count }, (_unused, index) => createLocker2Row(index + 1));
}

function locker2SelectedRows() {
  const rows = state.locker2Rows.filter((row) => row.selected);
  if (rows.length === 0) throw new RangeError("送信する住戸を1件以上「送信」列で登録してください");
  return rows;
}

function updateLocker2Counts(visible) {
  if (visible != null) $("locker2Visible").textContent = String(visible);
  const selected = state.locker2Rows.filter((row) => row.selected);
  const boxes = selected.filter((row) => LOCKER2_STORED_COMMANDS.includes(row.command)).length;
  const limit = locker2Limits().maxBoxes;
  $("locker2Selected").textContent = String(selected.length);
  $("locker2Boxes").textContent = String(boxes);
  $("locker2Limit").textContent = boxes > limit ? `上限 ${limit} 件を超えています` : `上限 ${limit} 件`;
  $("locker2Limit").className = boxes > limit ? "limit-over" : "";
}

function locker2RowElement(row, api, maxBuilding) {
  const tr = document.createElement("tr");

  const selectCell = document.createElement("td");
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.checked = row.selected;
  checkbox.setAttribute("aria-label", `${row.no}行目を送信登録`);
  checkbox.addEventListener("change", () => {
    row.selected = checkbox.checked;
    updateLocker2Counts();
  });
  selectCell.append(checkbox);

  const noCell = document.createElement("td");
  noCell.className = "locker-no";
  noCell.textContent = String(row.no).padStart(3, "0");

  const commandCell = document.createElement("td");
  const command = document.createElement("select");
  for (const value of [0x11, 0x12, 0x13]) {
    const option = document.createElement("option");
    option.value = String(value);
    option.textContent = `${value.toString(16).toUpperCase()}H ${api.CMD_LABEL[value]}`;
    command.append(option);
  }
  command.value = String(row.command);
  command.addEventListener("change", () => {
    row.command = Number(command.value);
    updateLocker2Counts();
  });
  commandCell.append(command);

  const buildingCell = document.createElement("td");
  const building = document.createElement("input");
  building.type = "number";
  building.min = "0";
  building.max = String(maxBuilding);
  building.value = String(row.buildingNo);
  building.addEventListener("input", () => { row.buildingNo = Number(building.value); });
  buildingCell.append(building);

  const roomCell = document.createElement("td");
  const room = document.createElement("input");
  room.type = "number";
  room.min = "0";
  room.max = "9999";
  room.value = String(row.roomNo);
  room.addEventListener("input", () => { row.roomNo = Number(room.value); });
  roomCell.append(room);

  tr.append(selectCell, noCell, commandCell, buildingCell, roomCell);
  return tr;
}

function renderLocker2Table() {
  const api = requireApi("Telegram2");
  const filter = $("locker2Filter").value;
  const maxBuilding = locker2Limits().maxBuilding;
  const fragment = document.createDocumentFragment();
  let visible = 0;
  for (const row of state.locker2Rows) {
    if (filter === "selected" && !row.selected) continue;
    visible += 1;
    fragment.append(locker2RowElement(row, api, maxBuilding));
  }
  $("locker2Body").replaceChildren(fragment);
  updateLocker2Counts(visible);
}

function applyLocker2Count() {
  const count = integerValue("locker2Count", "登録行数", 1, MAX_LOCKER2_ROWS);
  const rows = state.locker2Rows;
  if (count < rows.length) rows.length = count;
  else while (rows.length < count) rows.push(createLocker2Row(rows.length + 1));
  renderLocker2Table();
}

// 旧VB6版の「居室番号デフォルト」と同じく、ロッカー番号の範囲へ居室番号を割り当てる。
// 部屋番号インクリメントは+1、階番号インクリメントは+100（101→201→301）。
function applyLocker2Bulk() {
  const total = state.locker2Rows.length;
  const from = integerValue("locker2BulkFrom", "開始ロッカー番号", 1, total);
  const to = integerValue("locker2BulkTo", "終了ロッカー番号", from, total);
  const command = Number($("locker2Command").value);
  const buildingNo = integerValue("locker2Building", "棟No", 0, locker2Limits().maxBuilding);
  const startRoom = integerValue("locker2Room", "初期居室番号", 1, 9999);
  const step = $("locker2Increment").value === "floor" ? 100 : 1;
  let roomNo = startRoom;
  for (let lockerNo = from; lockerNo <= to; lockerNo += 1) {
    const row = state.locker2Rows[lockerNo - 1];
    row.command = command;
    row.buildingNo = buildingNo;
    row.roomNo = roomNo;
    if (roomNo + step <= 9999) roomNo += step;
  }
  renderLocker2Table();
  toast(`ロッカー${from}～${to}へ居室番号${startRoom}からの番号を設定しました`);
}

// 旧VB6版の「切替」。登録済みの行だけ状態をまとめて変える。
function applyLocker2Switch() {
  const rows = state.locker2Rows.filter((row) => row.selected);
  if (rows.length === 0) throw new RangeError("状態を変更する行を「送信」列で登録してください");
  const command = Number($("locker2SwitchCommand").value);
  for (const row of rows) row.command = command;
  renderLocker2Table();
  toast(`登録済み${rows.length}件の状態を変更しました`);
}

function resetLocker2Rows() {
  for (const row of state.locker2Rows) {
    row.buildingNo = 0;
    row.roomNo = 0;
  }
  renderLocker2Table();
  toast("全行の棟No・居室番号を消去しました");
}

function setLocker2Selection(selected) {
  for (const row of state.locker2Rows) row.selected = selected;
  renderLocker2Table();
}

function buildLocker2Frames() {
  const api = requireApi("Telegram2");
  const limits = locker2Limits();
  const entries = locker2SelectedRows().map((row) => ({
    command: row.command,
    buildingNo: row.buildingNo,
    roomNo: row.roomNo,
    address: row.no,
  }));
  const allowedBuildingNos = Array.from({ length: limits.maxBuilding + 1 }, (_unused, index) => index);
  const normalized = api.validateRegistrationList(entries, {
    maxEntries: MAX_LOCKER2_ROWS,
    maxBoxes: limits.maxBoxes,
    allowedBuildingNos,
  });
  const registered = new Map(normalized.map((entry) => [entry.address, api.buildTelegram(entry)]));
  if ($("locker2Scope").value !== "all") return Array.from(registered.values());
  // 旧VB6版互換：登録の有無にかかわらず全ロッカーを巡回し、未登録は3FHで埋める。
  return state.locker2Rows.map((row) => registered.get(row.no) || api.buildVacantTelegram(row.no));
}

function locker4State(value, index) {
  const stateByte = parseHexByte(value, `状態(${index + 1}行)`);
  const allowed = [0x30, 0x31, 0x32, 0x33, 0x34, 0x35, 0x40, 0x41, 0x42];
  if (!allowed.includes(stateByte)) throw new RangeError(`状態(${index + 1}行)が仕様範囲外です`);
  const profile = $("locker4Profile").value;
  if (profile === "adapter2" && ![0x30, 0x31].includes(stateByte)) throw new RangeError("2方向アダプターは30/31Hのみ対応です");
  if (profile !== "dearis" && ![0x30, 0x31].includes(stateByte)) throw new RangeError("32～35H・40～42Hはdearisプロファイル専用です");
  return stateByte;
}

function locker4ModelNo() {
  const text = $("locker4Model").value.trim();
  return text === "" ? undefined : Number(text);
}

function locker4AllowedStates() {
  return $("locker4Profile").value === "dearis" ? LOCKER4_DEARIS_STATES : LOCKER4_BASIC_STATES;
}

function createLocker4Row(lockerNo) {
  return { lockerNo, buildingNo: 0, roomNo: 0, currentState: 0x30, sendState: 0x30, selected: false };
}

function createLocker4Rows(count) {
  return Array.from({ length: count }, (_unused, index) => createLocker4Row(index + 1));
}

// 宅配ロボ状態のロッカーNoは000固定（Q48-005F）。
function locker4EffectiveLockerNo(row, stateByte) {
  return LOCKER4_ROBOT_STATES.includes(stateByte) ? 0 : row.lockerNo;
}

function locker4SelectedRows() {
  const rows = state.locker4Rows.filter((row) => row.selected);
  if (rows.length === 0) throw new RangeError("送信するロッカーを1件以上「送信」列で登録してください");
  return rows;
}

function locker4Lockers() {
  return locker4SelectedRows().map((row) => ({
    state: row.sendState,
    lockerNo: locker4EffectiveLockerNo(row, row.sendState),
    buildingNo: row.buildingNo,
    roomNo: row.roomNo,
  }));
}

// 情報要求への応答は、これから送る状態ではなく装置が保持している現在状態を報告する。
function locker4CurrentLockers() {
  return state.locker4Rows.filter((row) => row.selected).map((row) => ({
    state: row.currentState,
    lockerNo: locker4EffectiveLockerNo(row, row.currentState),
    buildingNo: row.buildingNo,
    roomNo: row.roomNo,
  }));
}

function updateLocker4Counts(visible) {
  if (visible != null) $("locker4Visible").textContent = String(visible);
  $("locker4Selected").textContent = String(state.locker4Rows.filter((row) => row.selected).length);
}

function locker4RowElement(row, allowed, api) {
  const tr = document.createElement("tr");

  const selectCell = document.createElement("td");
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.checked = row.selected;
  checkbox.setAttribute("aria-label", `ロッカー${row.lockerNo}を送信登録`);
  checkbox.addEventListener("change", () => {
    row.selected = checkbox.checked;
    updateLocker4Counts();
  });
  selectCell.append(checkbox);

  const noCell = document.createElement("td");
  noCell.className = "locker-no";
  const renderNo = () => {
    noCell.textContent = String(locker4EffectiveLockerNo(row, row.sendState)).padStart(3, "0");
  };
  renderNo();

  const buildingCell = document.createElement("td");
  const building = document.createElement("input");
  building.type = "number";
  building.min = "0";
  building.max = "9";
  building.value = String(row.buildingNo);
  building.addEventListener("input", () => { row.buildingNo = Number(building.value); });
  buildingCell.append(building);

  const roomCell = document.createElement("td");
  const room = document.createElement("input");
  room.type = "number";
  room.min = "0";
  room.max = "9999";
  room.value = String(row.roomNo);
  room.addEventListener("input", () => { row.roomNo = Number(room.value); });
  roomCell.append(room);

  const currentCell = document.createElement("td");
  currentCell.className = "locker-current";
  currentCell.textContent = api.STATE_LABEL[row.currentState] || "—";

  const sendCell = document.createElement("td");
  const select = document.createElement("select");
  for (const value of allowed) {
    const option = document.createElement("option");
    option.value = String(value);
    option.textContent = `${value.toString(16).toUpperCase()}H ${api.STATE_LABEL[value]}`;
    select.append(option);
  }
  select.value = String(row.sendState);
  select.addEventListener("change", () => {
    row.sendState = Number(select.value);
    renderNo();
  });
  sendCell.append(select);

  tr.append(selectCell, noCell, buildingCell, roomCell, currentCell, sendCell);
  return tr;
}

function renderLocker4Table() {
  const api = requireApi("Telegram4");
  const allowed = locker4AllowedStates();
  const filter = $("locker4Filter").value;
  const fragment = document.createDocumentFragment();
  let visible = 0;
  for (const row of state.locker4Rows) {
    if (!allowed.includes(row.sendState)) row.sendState = allowed[0];
    if (filter === "selected" && !row.selected) continue;
    if (filter === "stored" && row.currentState === 0x30) continue;
    visible += 1;
    fragment.append(locker4RowElement(row, allowed, api));
  }
  $("locker4Body").replaceChildren(fragment);
  updateLocker4Counts(visible);
}

function applyLocker4Count() {
  const count = integerValue("locker4Count", "ロッカー数", 1, 999);
  const rows = state.locker4Rows;
  if (count < rows.length) rows.length = count;
  else while (rows.length < count) rows.push(createLocker4Row(rows.length + 1));
  renderLocker4Table();
}

// VB6版の「部屋番号設定」と同じく、ロッカーNoの範囲へ居室番号を連番で割り当てる。
function applyLocker4Bulk() {
  const total = state.locker4Rows.length;
  const from = integerValue("locker4BulkFrom", "開始ロッカーNo", 1, total);
  const to = integerValue("locker4BulkTo", "終了ロッカーNo", from, total);
  const buildingNo = integerValue("locker4BulkBuilding", "棟番号", 0, 9);
  const startRoom = integerValue("locker4BulkRoom", "開始居室番号", 0, 9999);
  let roomNo = startRoom;
  for (let lockerNo = from; lockerNo <= to; lockerNo += 1) {
    const row = state.locker4Rows[lockerNo - 1];
    row.buildingNo = buildingNo;
    row.roomNo = roomNo;
    if (roomNo < 9999) roomNo += 1;
  }
  renderLocker4Table();
  toast(`ロッカー${from}～${to}へ棟${buildingNo}・居室${startRoom}からの連番を設定しました`);
}

function resetLocker4Rooms() {
  for (const row of state.locker4Rows) {
    row.buildingNo = 0;
    row.roomNo = 0;
  }
  renderLocker4Table();
  toast("全ロッカーの棟番号・居室番号を消去しました");
}

function setLocker4Selection(selected) {
  const filter = $("locker4Filter").value;
  for (const row of state.locker4Rows) {
    if (!selected) {
      row.selected = false;
      continue;
    }
    if (filter === "stored" && row.currentState === 0x30) continue;
    row.selected = true;
  }
  renderLocker4Table();
}

// 送信できた分だけ現在状態へ反映する。実機の状態遷移と同じ扱いにする。
function commitLocker4Send(rows) {
  for (const row of rows) row.currentState = row.sendState;
  renderLocker4Table();
}

function buildLocker4Packets() {
  const api = requireApi("Telegram4");
  const modelNo = locker4ModelNo();
  if ($("locker4Action").value === "request") return [api.buildRequestTelegram({ modelNo })];
  return api.buildResponsePackets({
    modelNo,
    packetSize: Number($("locker4PacketSize").value),
    lockers: locker4Lockers(),
  });
}

function keyProfile() {
  return KEY_PROFILES[$("keyProfile").value] || KEY_PROFILES.other;
}

function syncKeyForm() {
  const api = requireApi("NoncontactKey");
  const profile = keyProfile();
  const building = $("keyBuilding");
  const person = $("keyPerson");
  const withPerson = $("keyFormat").value === api.FORMAT.WITH_PERSON;
  building.max = String(profile.buildingMax);
  person.max = String(profile.personMax);
  person.disabled = !withPerson;
  if (Number(building.value) > profile.buildingMax) building.value = String(profile.buildingMax);
  if (Number(person.value) > profile.personMax) person.value = String(profile.personMax);
  const buildingRange = profile.buildingMax === 0 ? "棟番号 0（標準）のみ" : `棟番号 0–${profile.buildingMax}（0は標準）`;
  const personRange = withPerson ? `個人番号 000–${String(profile.personMax).padStart(3, "0")}` : "個人番号なし";
  $("keyConstraintHint").textContent = `${profile.label}：${buildingRange}／部屋番号 0001–9999／${personRange}`;
}

function buildKeyFrame() {
  const api = requireApi("NoncontactKey");
  const profile = keyProfile();
  const roomText = $("keyRoom").value.trim();
  if (!/^\d{4}$/.test(roomText)) throw new Error("部屋番号は4桁の数字で入力してください（例：0101）");
  const options = {
    format: $("keyFormat").value,
    gateNo: integerValue("keyGate", "ゲートNo", 1, 99),
    buildingNo: integerValue("keyBuilding", "棟番号", 0, profile.buildingMax),
    buildingMax: profile.buildingMax,
    roomNo: Number(roomText),
    personMax: profile.personMax,
  };
  if (options.roomNo < 1) throw new Error("部屋番号は0001～9999で入力してください");
  if (options.format === api.FORMAT.WITH_PERSON) options.personNo = integerValue("keyPerson", "個人番号", 0, profile.personMax);
  let frame = api.buildTelegram(options);
  if ($("keyBadBcc").checked) frame = api.corruptBCC(frame);
  return frame;
}

function buildElevatorFrame() {
  const api = requireApi("ElevatorProtocol");
  const command = $("elevatorCommand").value;
  const meta = api.COMMAND_META[command];
  const profile = $("elevatorProfile").value;
  const options = { command, profile, direction: $("elevatorDirection").value };
  options.gate = meta.gate ? { buildingNo: Number($("elevatorGateBuilding").value), id: Number($("elevatorGateId").value) } : "0000";
  options.room = meta.room ? { buildingNo: Number($("elevatorRoomBuilding").value), roomNo: Number($("elevatorRoom").value) } : "000000";
  options.person = meta.person ? $("elevatorPerson").value.trim() : "000";
  return api.buildFrame(options);
}

// Q49-023G 5.2.2／5.2.3／5.2.4：発信情報の各bitが何を指すかは割付パターンで変わる。
const ALARM_BIT_PATTERN_NOTE = Object.freeze({
  standard: "5.2.2 初期値警報ビット割付",
  pattern1: "5.2.3／5.2.4 パターン１",
  pattern2: "5.2.3／5.2.4 パターン２",
  pattern3: "5.2.3／5.2.4 パターン３",
});

function alarmInfoCheckboxes() {
  return Array.from($("alarmInfoBits").querySelectorAll("input[type=checkbox]"));
}

// 選択中の割付が対象の発信種別に存在しないとき（警戒設定／解除に標準割付はない）は
// パターン１として読む。受信電文の桁を読めないまま捨てないための保険。
function alarmBitPatternFor(type) {
  const api = requireApi("AlarmProtocol");
  const pattern = $("alarmBitPattern").value;
  return api.bitAssignments(type, pattern) ? pattern : api.BIT_PATTERN.PATTERN_1;
}

function alarmInfoDetail(info, type) {
  return requireApi("AlarmProtocol").describeInfo(info, { type, pattern: alarmBitPatternFor(type) });
}

// 発信情報はHEX欄を唯一の値とし、チェックボックスは選択中の割付でそれを読み書きする窓にする。
function syncAlarmInfoForm(source = "hex") {
  const api = requireApi("AlarmProtocol");
  const type = parseHexByte($("alarmType").value, "発信種別");
  const patternSelect = $("alarmBitPattern");
  const isRequest = type === api.TYPE.HISTORY_REQUEST;
  // 警戒設定／解除は受注対応の3パターンだけで、標準割付を持たない。
  const standardOption = Array.from(patternSelect.options).find((option) => option.value === api.BIT_PATTERN.STANDARD);
  const hasStandard = !isRequest && api.bitAssignments(type, api.BIT_PATTERN.STANDARD) !== null;
  standardOption.disabled = !hasStandard;
  if (!hasStandard && patternSelect.value === api.BIT_PATTERN.STANDARD) patternSelect.value = api.BIT_PATTERN.PATTERN_1;
  patternSelect.disabled = isRequest;

  const boxes = alarmInfoCheckboxes();
  if (source === "bits") {
    const checked = boxes.reduce((list, box, index) => (box.checked ? list.concat(index + 1) : list), []);
    $("alarmInfo").value = api.encodeInfo(checked).toString(16).toUpperCase().padStart(2, "0");
  }

  let detail = null;
  try {
    detail = alarmInfoDetail(parseHexByte($("alarmInfo").value, "発信情報"), type);
  } catch (_error) {
    detail = null;
  }

  boxes.forEach((box, index) => {
    const label = box.closest("label");
    const text = label.querySelector("span");
    const entry = detail ? detail.bits[index] : null;
    const bitNo = index + 1;
    if (!entry) {
      text.textContent = `bit${bitNo}`;
      box.disabled = true;
      label.classList.add("bit-unassigned");
      return;
    }
    text.textContent = entry.label == null
      ? `bit${bitNo}（${entry.extensible ? "未割付" : "未使用"}）`
      : `bit${bitNo} ${entry.label}${entry.locked ? "◇" : ""}`;
    box.checked = entry.on;
    // ×（追加も変更もできないbit）はチェックさせない。HEX欄からは送れるので注意として残す。
    box.disabled = isRequest || (entry.label == null && !entry.extensible);
    label.classList.toggle("bit-unassigned", entry.label == null);
  });

  const hint = $("alarmInfoHint");
  if (isRequest) hint.textContent = "ヒストリー要求は発報元の情報を持たないため、発信情報は00H固定で送信します（5.2.5）";
  else if (!detail) hint.textContent = "発信情報は2桁HEXで入力してください";
  else {
    const violation = detail.violations.length ? `／注意: bit${detail.violations.join("・")}は仕様上未使用です` : "";
    hint.textContent = `${ALARM_BIT_PATTERN_NOTE[detail.pattern] || detail.pattern}：${detail.hex}H = ${detail.summary}${violation}`;
  }
}

function buildAlarmFrame() {
  const api = requireApi("AlarmProtocol");
  const type = parseHexByte($("alarmType").value, "発信種別");
  if (($("alarmRole").value === "intercom" && type === api.TYPE.HISTORY_REQUEST) ||
      ($("alarmRole").value === "alarm" && type !== api.TYPE.HISTORY_REQUEST)) {
    throw new Error("選択した動作側からはこの発信種別を送信できません");
  }
  if (type === api.TYPE.HISTORY_REQUEST) return api.buildFrame({ type, info: 0, buildingNo: 0, source: api.sourceNone(), historyNumber: 0 });
  const sourceType = $("alarmSource").value;
  const number = Number($("alarmSourceNumber").value);
  const source = sourceType === "room" ? api.sourceDwelling(number)
    : sourceType === "manager" ? api.sourceManagement(number)
      : sourceType === "entrance" ? api.sourceEntrance(number)
        : sourceType === "common" ? api.sourceCommon() : api.sourceNone();
  return api.buildFrame({
    type,
    info: parseHexByte($("alarmInfo").value, "発信情報"),
    buildingNo: Number.parseInt($("alarmBuilding").value, 10),
    source,
    historyNumber: integerValue("alarmHistory", "履歴番号", 0, 15),
  });
}

function updateAlarmHistoryStatus(detail) {
  if (!state.alarmHistory) return;
  $("alarmHistoryState").textContent = `保持 ${state.alarmHistory.size}/15件${detail ? ` — ${detail}` : ""}`;
}

function recordAlarmHistory(frame = buildAlarmFrame()) {
  const api = requireApi("AlarmProtocol");
  const parsed = api.parseFrame(frame);
  state.alarmHistory.record(frame);
  state.alarmHistoryPending = null;
  updateAlarmHistoryStatus(`${parsed.typeName} / 棟${String(parsed.buildingNo).padStart(2, "0")} を記録`);
  addLog("info", "HISTORY", frame, `警報履歴へ記録 (${state.alarmHistory.size}/15件)`);
  return frame;
}

function prepareNextAlarmHistory() {
  const api = requireApi("AlarmProtocol");
  const frame = state.alarmHistory.nextFrame();
  const parsed = api.parseFrame(frame);
  state.alarmHistoryPending = frame;
  $("alarmPreview").textContent = toHex(frame);
  updateAlarmHistoryStatus(parsed.info === 0 && parsed.source.kind === api.SOURCE_KIND.NONE ? "履歴なし応答を準備" : `履歴${parsed.historyNumber}を準備`);
  return frame;
}

async function sendNextAlarmHistory(forceHandshake = false) {
  if ($("alarmRole").value !== "intercom") throw new Error("履歴応答は集合インターホン側から送信します");
  const frame = state.alarmHistoryPending || prepareNextAlarmHistory();
  state.alarmHistoryPending = null;
  if (!forceHandshake && $("alarmTransport").value === "direct") await transmit(frame, "frame");
  else await runHandshake([frame], { sendEot: false, textRetryMode: "sameText", maxRetries: 255, priority: true });
  updateAlarmHistoryStatus("履歴応答を送信");
}

// 自動応答は受信処理の途中で呼ばれるため、送信は次のタスクへ逃がして
// 受信バイトの処理と送信手順が同じスタックで絡まないようにする。
function scheduleAutoResponse(name, run) {
  setTimeout(() => {
    withTransaction(name, run).catch((error) => logError(error, name));
  }, 0);
}

// 仕様だけでは応答内容が決まらない要求は、黙って無視せず理由を残す。
function logUnsupportedAutoResponse(result) {
  if (!result || result.type !== "unsupported") return false;
  addLog("warn", "AUTO", null, `自動応答なし: ${result.reason}`);
  return true;
}

function handleApplicationFrame(view, frame, transportResponse, valid) {
  // 大興／リモートはACK/NAKを伝送制御ではなく電文で返すため、
  // 制御コードの送出結果ではなく電文の検証結果で判断する。
  if (view === "panasonic" && !panasonicIsBlock()) {
    try { handlePanasonicRecordFrame(frame, valid); } catch (error) { logError(error, "アンサーバック処理"); }
    return;
  }
  if (!isTransportAck(view, transportResponse)) return;
  try {
    if (view === "alarm") handleAlarmRequest(frame);
    else if (view === "panasonic") handlePanasonicRequest(frame);
    else if (view === "panasonicElevator") handlePanasonicElevatorRequest(frame);
    else if (view === "locker4") handleLocker4Request(frame);
    else if (view === "mansion") handleMansionRequest(frame);
    else if (view === "elevator") handleElevatorRequest(frame);
  } catch (error) {
    logError(error, "自動応答の準備");
  }
}

function handleAlarmRequest(frame) {
  if (!$("alarmAutoHistoryResponse").checked) return;
  const api = requireApi("AlarmProtocol");
  const parsed = api.parseFrame(frame);
  if (parsed.type !== api.TYPE.HISTORY_REQUEST || $("alarmRole").value !== "intercom") return;
  scheduleAutoResponse("警報履歴自動応答", () => sendNextAlarmHistory(true));
}

// ------------------------------------------------------- 警報（パナソニック）
// 1画面で4プロトコルを切り替える。HPC／TSSはSTX形式でENQ–ACK–TEXT–ACKの
// 手順を持ち、大興／リモートはASCIIレコードを送ってアンサーバック電文を待つ。

function panasonicApi() {
  return requireApi("PanasonicAlarm");
}

function panasonicProtocol() {
  return $("panaProtocol").value;
}

function panasonicInfo() {
  return panasonicApi().protocolInfo(panasonicProtocol());
}

function panasonicStyle() {
  return panasonicInfo().style;
}

function panasonicIsBlock() {
  return panasonicStyle() === panasonicApi().STYLE.BLOCK;
}

// ヒストリーはプロトコルごとに独立させ、切り替えで他方の履歴が混ざらないようにする。
function panasonicHistory() {
  const api = panasonicApi();
  const protocol = panasonicProtocol();
  if (!api.protocolInfo(protocol).history) return null;
  if (!state.panaHistories[protocol]) state.panaHistories[protocol] = new api.PanasonicHistory({ protocol });
  return state.panaHistories[protocol];
}

function panasonicHexByte(value) {
  return Number(value).toString(16).toUpperCase().padStart(2, "0");
}

function panasonicRoomValue(id, name = "住戸番号") {
  const text = String($(id).value).trim();
  if (!/^\d{1,4}$/.test(text)) throw new RangeError(`${name}は0～9999の数字で入力してください`);
  return Number(text);
}

function panasonicInfoCheckboxes() {
  return Array.from($("panaInfoBits").querySelectorAll("input[type=checkbox]"));
}

// 制御コードは画面上で位置が分かるよう<03>の形で見せる。
function panasonicPreviewText(frame) {
  if (panasonicIsBlock()) return toHex(frame);
  const text = panasonicApi().toAscii(frame).replace(/[\x00-\x1F]/g, (character) => `<${panasonicHexByte(character.charCodeAt(0))}>`);
  return `${text}    ${toHex(frame)}`;
}

function refreshPanasonicTypes() {
  if (!panasonicIsBlock()) return;
  const select = $("panaType");
  const previous = select.value;
  const options = panasonicApi().blockTypes(panasonicProtocol()).map((entry) => {
    const option = document.createElement("option");
    option.value = panasonicHexByte(entry.code);
    option.textContent = `${option.value} ${entry.label}`;
    return option;
  });
  select.replaceChildren(...options);
  if (options.some((option) => option.value === previous)) select.value = previous;
}

function refreshPanasonicAlarmNumbers() {
  if (panasonicIsBlock()) return;
  const select = $("panaAlarmNo");
  const previous = select.value;
  const options = panasonicApi().alarmNumbers(panasonicProtocol()).map((entry) => {
    const option = document.createElement("option");
    option.value = entry.code;
    option.textContent = `${entry.code} ${entry.label}`;
    return option;
  });
  select.replaceChildren(...options);
  if (options.some((option) => option.value === previous)) select.value = previous;
}

// 警報情報はHEX欄を唯一の値とし、チェックボックスは選択中の割付でそれを読み書きする窓にする。
function syncPanasonicInfoForm(source = "hex") {
  const api = panasonicApi();
  if (!panasonicIsBlock()) return;
  const protocol = panasonicProtocol();
  let entry = null;
  try { entry = api.findBlockType(protocol, parseHexByte($("panaType").value, "発信種別")); } catch (_error) { entry = null; }
  const boxes = panasonicInfoCheckboxes();
  const fixedZero = !entry || entry.bits === null;

  if (source === "bits" && !fixedZero) {
    const checked = boxes.reduce((list, box, index) => (box.checked ? list.concat(index) : list), []);
    $("panaInfo").value = panasonicHexByte(api.encodeInfo(checked));
  }
  if (fixedZero) $("panaInfo").value = "00";
  $("panaInfo").disabled = fixedZero;

  // 要求電文のうちヒストリー要求は棟番号・住戸番号も00固定。
  const addressed = !entry || !entry.request || entry.addressed !== false;
  $("panaBuilding").disabled = !addressed;
  $("panaRoom").disabled = !addressed;
  const info = panasonicInfo();
  $("panaHistoryField").hidden = !info.history;
  $("panaHistory").disabled = !info.history || (entry ? Boolean(entry.request) : false);

  let detail = null;
  if (entry && !fixedZero) {
    try { detail = api.describeInfo(protocol, entry.code, parseHexByte($("panaInfo").value, "警報情報")); } catch (_error) { detail = null; }
  }

  boxes.forEach((box, index) => {
    const label = box.closest("label");
    const text = label.querySelector("span");
    const cell = detail ? detail.bits[index] : null;
    if (!cell) {
      text.textContent = `bit${index}`;
      box.checked = false;
      box.disabled = true;
      label.classList.add("bit-unassigned");
      return;
    }
    text.textContent = cell.label == null ? `bit${index}（予備）` : `bit${index} ${cell.label}`;
    box.checked = cell.on;
    // 予備bitはチェックさせない。HEX欄からは送れるので注意として残す。
    box.disabled = cell.reserved;
    label.classList.toggle("bit-unassigned", cell.reserved);
  });

  const hint = $("panaInfoHint");
  if (!entry) hint.textContent = "発信種別を選び直してください";
  else if (fixedZero) hint.textContent = `${entry.label}の警報情報は00H固定です${entry.addressed === false ? "（棟番号・住戸番号も00）" : "（棟番号・住戸番号で対象を指定します）"}`;
  else if (!detail) hint.textContent = "警報情報は2桁HEXで入力してください";
  else {
    const violation = detail.violations.length ? `／注意: bit${detail.violations.join("・")}は仕様上の予備です` : "";
    hint.textContent = `${info.label} ${entry.label}：${detail.hex}H = ${detail.summary}${violation}`;
  }
}

function renderPanasonicRecords() {
  const api = panasonicApi();
  const body = $("panaRecordRows");
  const protocol = panasonicProtocol();
  if (state.panaRecords.length === 0) {
    body.replaceChildren(emptyReceiveRow(7, "レコードがありません。入力して「レコードへ追加」を押すか、そのまま送信すると入力中の1件を送ります"));
  } else {
    const fragment = document.createDocumentFragment();
    state.panaRecords.forEach((record, index) => {
      const row = document.createElement("tr");
      const check = document.createElement("input");
      check.type = "checkbox";
      check.checked = Boolean(record.selected);
      check.setAttribute("aria-label", `${index + 1}件目を選択`);
      check.addEventListener("change", () => { record.selected = check.checked; });
      const first = document.createElement("td");
      first.append(check);
      row.append(first);
      const entry = api.findAlarmNumber(protocol, record.alarmNo);
      const cells = [
        String(index + 1),
        `${record.mode}（${api.modeLabel(protocol, record.alarmNo, record.mode)}）`,
        String(record.buildingNo).padStart(2, "0"),
        String(record.roomNo).padStart(4, "0"),
        String(record.alarmNo).padStart(2, "0"),
        entry ? entry.label : "別表に該当なし",
      ];
      for (const text of cells) {
        const cell = document.createElement("td");
        cell.textContent = text;
        row.append(cell);
      }
      if (!entry) row.classList.add("receive-row", "error");
      fragment.append(row);
    });
    body.replaceChildren(fragment);
  }
  $("panaRecordState").textContent = `${state.panaRecords.length}/${api.MAX_RECORDS}レコード`;
  $("panaRecordSelectAll").checked = state.panaRecords.length > 0 && state.panaRecords.every((record) => record.selected);
}

function panasonicRecordDraft() {
  return {
    mode: $("panaMode").value,
    buildingNo: integerValue("panaRecordBuilding", "棟番号", 0, 99),
    roomNo: panasonicRoomValue("panaRecordRoom"),
    alarmNo: Number($("panaAlarmNo").value),
    selected: false,
  };
}

function addPanasonicRecord() {
  const api = panasonicApi();
  if (state.panaRecords.length >= api.MAX_RECORDS) throw new Error(`1回の送信は最大${api.MAX_RECORDS}レコードです`);
  const record = panasonicRecordDraft();
  // 追加時点で別表と桁を検証し、送信直前まで誤りを持ち越さない。
  api.encodeRecord(panasonicProtocol(), record);
  state.panaRecords.push(record);
  renderPanasonicRecords();
}

function buildPanasonicBlockFrame() {
  const api = panasonicApi();
  const protocol = panasonicProtocol();
  const entry = api.findBlockType(protocol, parseHexByte($("panaType").value, "発信種別"));
  const role = $("panaRole").value;
  // 要求は他社通報機からIFUへ、警報データはIFUから他社通報機への一方向。
  if (entry.request && role !== "peer") throw new Error("要求電文は他社通報機（受信側）から送信します");
  if (!entry.request && role !== "ifu") throw new Error("警報データはﾊﾟﾅｿﾆｯｸIFU（送信側）から送信します");
  const addressed = !entry.request || entry.addressed !== false;
  return api.buildFrame({
    protocol,
    type: entry.code,
    info: entry.bits === null ? 0 : parseHexByte($("panaInfo").value, "警報情報"),
    buildingNo: addressed ? integerValue("panaBuilding", "棟番号", 0, 99) : 0,
    roomNo: addressed ? panasonicRoomValue("panaRoom") : 0,
    historyNumber: panasonicInfo().history && !entry.request ? integerValue("panaHistory", "ヒストリー番号", 0, 15) : 0,
  });
}

function buildPanasonicRecordFrame() {
  if ($("panaRole").value !== "ifu") throw new Error("警報データはﾊﾟﾅｿﾆｯｸIFU（送信側）から送信します");
  const records = state.panaRecords.length ? state.panaRecords : [panasonicRecordDraft()];
  return panasonicApi().buildFrame({ protocol: panasonicProtocol(), records });
}

function buildPanasonicFrame() {
  return panasonicIsBlock() ? buildPanasonicBlockFrame() : buildPanasonicRecordFrame();
}

// 大興／リモートのアンサーバックは電文で届くため、制御コード待ちとは別に受け取る。
function createPanasonicAnswerWaiter(timeoutMs) {
  let waiter;
  const promise = new Promise((resolve, reject) => {
    waiter = { resolve, reject, timer: null, done: false };
    state.panaAnswerWaiters.push(waiter);
  });
  promise.catch(() => undefined);
  return {
    promise,
    arm() {
      if (waiter.done || waiter.timer) return;
      waiter.timer = setTimeout(() => {
        const index = state.panaAnswerWaiters.indexOf(waiter);
        if (index !== -1) state.panaAnswerWaiters.splice(index, 1);
        waiter.done = true;
        waiter.reject(new Error("アンサーバック待ちタイムアウト"));
      }, timeoutMs);
    },
    cancel() {
      const index = state.panaAnswerWaiters.indexOf(waiter);
      if (index !== -1) state.panaAnswerWaiters.splice(index, 1);
      waiter.done = true;
      clearTimeout(waiter.timer);
    },
  };
}

function dispatchPanasonicAnswer(parsed) {
  const waiter = state.panaAnswerWaiters.shift();
  if (!waiter) return false;
  clearTimeout(waiter.timer);
  waiter.done = true;
  waiter.resolve(parsed);
  return true;
}

function rejectPanasonicAnswerWaiters(error) {
  const waiters = state.panaAnswerWaiters.splice(0, state.panaAnswerWaiters.length);
  for (const waiter of waiters) {
    clearTimeout(waiter.timer);
    waiter.done = true;
    waiter.reject(error);
  }
}

async function sendPanasonicBlock(frame, forceHandshake = false) {
  const info = panasonicInfo();
  if (!forceHandshake && $("panaTransport").value === "direct") return transmit(frame, "frame");
  // 仕様上の上限は256回だが、送信FSMが扱えるのは255回まで。
  const specRetries = $("panaRole").value === "ifu" ? info.ifuRetries : info.peerRetries;
  const maxRetries = Math.min(specRetries, 255);
  if (specRetries > maxRetries) {
    addLog("info", "SEQ", null, `再送上限は仕様の${specRetries}回に対し${maxRetries}回で試験します`);
  }
  return runHandshake([frame], {
    sendEot: false,
    textRetryMode: "sameText",
    maxRetries,
    linkTimeoutMs: info.linkTimeoutMs,
    textTimeoutMs: info.textTimeoutMs,
    // ENQ衝突時はIFUが優先する。
    priority: $("panaRole").value === "ifu",
  });
}

// アンサーバックがNAK、または5秒間ない場合はリトライ送信（計3回）を行う。
async function sendPanasonicRecord(frame, label = "警報データ") {
  const info = panasonicInfo();
  if ($("panaTransport").value === "direct") return transmit(frame, "frame");
  const attempts = info.sendAttempts;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    setSequence(`${label}送信 ${attempt}/${attempts}`);
    const waiter = createPanasonicAnswerWaiter(info.answerbackTimeoutMs);
    try {
      await transmit(frame, "frame");
    } catch (error) {
      waiter.cancel();
      throw error;
    }
    waiter.arm();
    try {
      const answer = await waiter.promise;
      if (answer.kind === "ack") {
        setSequence("完了");
        addLog("info", "SEQ", null, `アンサーバックACK受信 / 送信${attempt}回`);
        return answer;
      }
      addLog("warn", "RETRY", null, `アンサーバックNAK / ${attempt}/${attempts}`);
    } catch (error) {
      waiter.cancel();
      if (!/アンサーバック待ちタイムアウト/.test(String(error.message))) throw error;
      addLog("warn", "RETRY", null, `アンサーバック無応答 ${info.answerbackTimeoutMs}ms / ${attempt}/${attempts}`);
    }
  }
  setSequence("失敗");
  throw new Error(`アンサーバックを受信できず、リトライ上限（計${attempts}回）に達しました`);
}

async function sendPanasonicFrame(frame, label) {
  return panasonicIsBlock() ? sendPanasonicBlock(frame) : sendPanasonicRecord(frame, label);
}

// 大興／リモートはASCIIが読めないと桁を追えないため、専用のプレビューを使う。
function previewPanasonic() {
  try {
    const frame = buildPanasonicFrame();
    $("panaPreview").textContent = panasonicPreviewText(frame);
    return frame;
  } catch (error) {
    $("panaPreview").textContent = `ERROR: ${error.message}`;
    throw error;
  }
}

async function sendPanasonic() {
  const frame = previewPanasonic();
  await sendPanasonicFrame(frame);
  if (!panasonicIsBlock() || !$("panaAutoRecord").checked) return;
  const history = panasonicHistory();
  if (!history) return;
  const parsed = panasonicApi().parseBlockFrame(frame, { protocol: panasonicProtocol() });
  if (!parsed.request) recordPanasonicHistory(frame);
}

function updatePanasonicHistoryStatus(detail) {
  const element = $("panaHistoryState");
  if (!element) return;
  const history = panasonicHistory();
  if (!history) {
    element.textContent = `${panasonicInfo().label}プロトコルにヒストリー処理はありません`;
    return;
  }
  element.textContent = `ヒストリー ${history.size}/${panasonicApi().HISTORY_LIMIT}件${detail ? ` — ${detail}` : ""}`;
}

function requirePanasonicHistory() {
  const history = panasonicHistory();
  if (!history) throw new Error(`${panasonicInfo().label}プロトコルにヒストリー処理はありません`);
  return history;
}

function recordPanasonicHistory(frame = buildPanasonicBlockFrame()) {
  const api = panasonicApi();
  const history = requirePanasonicHistory();
  const parsed = api.parseBlockFrame(frame, { protocol: panasonicProtocol() });
  history.record(frame);
  state.panaHistoryPending = null;
  updatePanasonicHistoryStatus(`${parsed.typeLabel} / ${parsed.buildingNo}棟 ${String(parsed.roomNo).padStart(4, "0")}号室 を記録`);
  addLog("info", "HISTORY", frame, `パナソニックヒストリーへ記録 (${history.size}/${api.HISTORY_LIMIT}件)`);
  return frame;
}

function prepareNextPanasonicHistory() {
  const api = panasonicApi();
  const history = requirePanasonicHistory();
  const frame = history.nextFrame();
  // ヒストリー情報がない場合の要求に対しては、仕様上NAKを返す。
  if (!frame) throw new Error("ヒストリー情報がありません（仕様上はNAKを返します）");
  const parsed = api.parseBlockFrame(frame, { protocol: panasonicProtocol() });
  state.panaHistoryPending = frame;
  $("panaPreview").textContent = panasonicPreviewText(frame);
  updatePanasonicHistoryStatus(parsed.historyNumber === 0 ? "現状を準備" : `ヒストリー${parsed.historyNumber}を準備`);
  return frame;
}

async function sendNextPanasonicHistory(forceHandshake = false) {
  if ($("panaRole").value !== "ifu") throw new Error("ヒストリー応答はﾊﾟﾅｿﾆｯｸIFU（送信側）から送信します");
  const frame = state.panaHistoryPending || prepareNextPanasonicHistory();
  state.panaHistoryPending = null;
  await sendPanasonicBlock(frame, forceHandshake);
  updatePanasonicHistoryStatus("ヒストリー応答を送信");
}

// HPCの要求電文への自動応答。応答内容が仕様と手元の記録で確定するものだけ送る。
function handlePanasonicRequest(frame) {
  if (!$("panaAutoResponse").checked || $("panaRole").value !== "ifu") return;
  const api = panasonicApi();
  const parsed = api.parseBlockFrame(frame, { protocol: panasonicProtocol() });
  if (!parsed.request) return;
  const history = panasonicHistory();
  if (parsed.typeName === "historyRequest") {
    if (!history || history.empty) {
      addLog("warn", "AUTO", null, "自動応答なし: ヒストリー情報がありません（仕様上はNAK）");
      return;
    }
    scheduleAutoResponse("ヒストリー自動応答", () => sendNextPanasonicHistory(true));
    return;
  }
  if (parsed.typeName !== "dwellingRequest") return;
  const response = history ? history.dwellingFrame(parsed.buildingNo, parsed.roomNo) : null;
  if (!response) {
    addLog("warn", "AUTO", null, `自動応答なし: ${parsed.buildingNo}棟 ${String(parsed.roomNo).padStart(4, "0")}号室の送信済みイベントがありません`);
    return;
  }
  // 住戸情報要求ではヒストリーのポインタを先頭へ戻さない。
  scheduleAutoResponse("住戸情報自動応答", () => sendPanasonicBlock(response, true));
}

// 大興／リモートは伝送制御を使わないため、受信電文そのものでACK/NAKを判断する。
function handlePanasonicRecordFrame(frame, valid) {
  const api = panasonicApi();
  const protocol = panasonicProtocol();
  let parsed = null;
  try { parsed = api.parseRecordFrame(frame, { protocol }); } catch (_error) { parsed = null; }

  if (parsed && (parsed.kind === "ack" || parsed.kind === "nak")) {
    if (!dispatchPanasonicAnswer(parsed)) {
      addLog("info", "PANA", null, `アンサーバック${parsed.kind === "ack" ? "ACK" : "NAK"}を受信（送信待ちなし）`);
    }
    return;
  }
  if (!$("panaAutoAnswerback").checked || $("panaRole").value !== "peer") return;
  const accepted = valid !== false && parsed !== null;
  const scheduled = parsed !== null && parsed.kind === "scheduled";
  scheduleAutoResponse("パナソニックアンサーバック", async () => {
    await transmit(api.buildAnswerback({ protocol, accepted, scheduled }), "response");
    addLog(accepted ? "info" : "warn", "AUTO", null, `受信電文へ${accepted ? "ACK" : "NAK"}アンサーバック`);
  });
}

function applyReceivedPanasonic(result) {
  const parsed = result.parsed;
  if (!parsed) throw new Error("反映できる解析結果がありません");
  if (panasonicIsBlock()) {
    if (parsed.type == null) throw new Error("発信種別を読み取れませんでした");
    $("panaType").value = panasonicHexByte(parsed.type);
    if (parsed.info != null) $("panaInfo").value = panasonicHexByte(parsed.info);
    if (parsed.buildingNo != null) $("panaBuilding").value = String(parsed.buildingNo);
    if (parsed.roomNo != null) $("panaRoom").value = String(parsed.roomNo).padStart(4, "0");
    if (parsed.historyNumber != null) $("panaHistory").value = String(parsed.historyNumber);
    syncPanasonicInfoForm();
    toast("受信電文を送信フォームへ取り込みました");
    return;
  }
  if (parsed.kind !== "alarm" || !parsed.records.length) throw new Error("取り込める警報レコードがありません");
  state.panaRecords = parsed.records.map((record) => ({
    mode: record.mode,
    buildingNo: record.buildingNo,
    roomNo: record.roomNo,
    alarmNo: record.alarmNo,
    selected: false,
  }));
  renderPanasonicRecords();
  toast(`受信した${state.panaRecords.length}レコードを取り込みました`);
}

// プロトコル切替は電文形式・通信条件・受信リーダーまで変わるため、まとめて追従させる。
function syncPanasonicForm() {
  const api = panasonicApi();
  const info = panasonicInfo();
  const block = panasonicIsBlock();
  $("panaBlockForm").hidden = !block;
  $("panaRecordForm").hidden = block;
  $("panaSpecNote").textContent = `${info.document}：${block
    ? "STX＋データ長37H＋データ7byte＋ETX＋BCC（加算）"
    : `SND＋レコード（最大${api.MAX_RECORDS}）＋チェックサム4桁＋CR`}`;
  const preset = SERIAL_PRESETS[viewPreset("panasonic")];
  if (preset) $("panaSpecBadge").textContent = presetLabel(preset);

  refreshPanasonicTypes();
  refreshPanasonicAlarmNumbers();

  $("panaRecordHistoryButton").hidden = !info.history;
  $("panaNextButton").hidden = !info.history;
  $("panaHistorySendButton").hidden = !info.history;
  $("panaHistoryClearButton").hidden = !info.history;
  $("panaScheduledButton").hidden = !info.scheduled;
  $("panaAckButton").hidden = block;
  $("panaNakButton").hidden = block;
  $("panaPropertyField").hidden = !info.scheduled;

  if (block) syncPanasonicInfoForm();
  else renderPanasonicRecords();
  updatePanasonicHistoryStatus();

  // 受信リーダーと解析条件が変わるので、途中まで溜めた受信は破棄して読み直す。
  resetFrameReader();
  state.frameReaderView = null;
  if (state.currentView === "panasonic") updatePresetWarning();
  renderReceiveMonitor("panasonic");
}

// ------------------------------------------- エレベータ連動（パナソニック）
// 18byte固定・ENQ–ACK–DATA–ACK–EOT。正常応答が10H／30Hの2種類で、NAKに相当する
// 応答がないため、異常時は無応答のまま相手の再送を待つ点がアイホンQ46-005Jと違う。

function panasonicElevatorApi() {
  return requireApi("PanasonicElevator");
}

function panasonicElevatorDirection() {
  return $("pevDirection").value;
}

function panasonicElevatorAckCode() {
  const value = Number($("pevAckCode").value);
  return panasonicElevatorApi().isAck(value) ? value : panasonicElevatorApi().CODE.ACK;
}

function panasonicElevatorCommand() {
  return panasonicElevatorApi().findCommand($("pevCommand").value);
}

// 付加コードが規定されているコマンドは選択、規定のないSBは2桁を直接入力させる。
function panasonicElevatorExtraCode() {
  const entry = panasonicElevatorCommand();
  if (entry.extras) return $("pevExtra").value;
  const text = String($("pevExtraFree").value).trim();
  if (!/^\d{2}$/.test(text)) throw new RangeError("付加コードは2桁の数字で指定してください");
  return text;
}

function refreshPanasonicElevatorCommands() {
  const api = panasonicElevatorApi();
  const select = $("pevCommand");
  const previous = select.value;
  const options = api.commands(panasonicElevatorDirection()).map((entry) => {
    const option = document.createElement("option");
    option.value = entry.code;
    option.textContent = `${entry.code} ${entry.label}`;
    return option;
  });
  select.replaceChildren(...options);
  if (options.some((option) => option.value === previous)) select.value = previous;
}

function refreshPanasonicElevatorExtras() {
  const entry = panasonicElevatorCommand();
  const select = $("pevExtra");
  const previous = select.value;
  const options = (entry.extras || []).map((item) => {
    const option = document.createElement("option");
    option.value = item.code;
    option.textContent = `${item.code} ${item.label}`;
    return option;
  });
  select.replaceChildren(...options);
  if (options.some((option) => option.value === previous)) select.value = previous;
  select.disabled = options.length <= 1;
}

// 付加コードで住戸を特定できるかが変わるため、使えない桁は入力させない。
function syncPanasonicElevatorForm() {
  const api = panasonicElevatorApi();
  refreshPanasonicElevatorCommands();
  refreshPanasonicElevatorExtras();
  const entry = panasonicElevatorCommand();
  const hasExtraTable = Boolean(entry.extras);
  $("pevExtraFreeField").hidden = hasExtraTable;

  let extraCode = null;
  try { extraCode = panasonicElevatorExtraCode(); } catch (_error) { extraCode = null; }
  const usage = api.fieldUsage(entry, extraCode);
  const matched = api.findExtra(entry, extraCode);
  $("pevBuilding").disabled = !usage.building;
  $("pevRoom").disabled = !usage.room;
  $("pevLb").disabled = !usage.lb;

  const fixed = [];
  if (!usage.building) fixed.push("棟番号00");
  if (!usage.room) fixed.push("住戸番号0000");
  if (!usage.lb) fixed.push("LB番号00");
  const label = matched && entry.extras && entry.extras.length > 1 ? `${entry.label}／${matched.label}` : entry.label;
  $("pevHint").textContent = fixed.length
    ? `${label}：${fixed.join("・")}が仕様上の固定値です`
    : `${label}：棟番号・住戸番号・LB番号を指定します`;

  if (state.currentView === "panasonicElevator") updatePresetWarning();
  renderReceiveMonitor("panasonicElevator");
}

function buildPanasonicElevatorFrame() {
  const api = panasonicElevatorApi();
  const entry = panasonicElevatorCommand();
  if (entry.direction !== panasonicElevatorDirection()) {
    throw new Error(`${entry.code}は${entry.direction === api.DIRECTION.TO_ELEVATOR ? "ﾊﾟﾅｿﾆｯｸIFU" : "エレベータ"}側から送信します`);
  }
  const extraCode = panasonicElevatorExtraCode();
  const usage = api.fieldUsage(entry, extraCode);
  return api.buildFrame({
    command: entry.code,
    extraCode,
    buildingNo: usage.building ? integerValue("pevBuilding", "棟番号", 0, 99) : 0,
    roomNo: usage.room ? panasonicRoomValue("pevRoom") : 0,
    lbNo: usage.lb ? integerValue("pevLb", "LB番号", 0, 99) : 0,
  });
}

function previewPanasonicElevator() {
  try {
    const frame = buildPanasonicElevatorFrame();
    $("pevPreview").textContent = `${toHex(frame)}    [${panasonicElevatorApi().toAscii(frame).replace(/[\x00-\x1F]/g, (character) => `<${Number(character.charCodeAt(0)).toString(16).toUpperCase().padStart(2, "0")}>`)}]`;
    return frame;
  } catch (error) {
    $("pevPreview").textContent = `ERROR: ${error.message}`;
    throw error;
  }
}

// ENQ→ACK→DATA→ACK→EOT を1回分行う。成立すればイベントを返し、
// 再送が要るときはnullを返して呼び出し側の試行ループへ戻る。
async function panasonicElevatorExchange(frame, attempt, attempts) {
  const api = panasonicElevatorApi();
  const accepted = [api.CODE.ENQ].concat(api.ACK_CODES);
  const timeout = api.TIMING.ackTimeoutMs;

  setSequence(`ENQ送信 ${attempt}/${attempts}`);
  const linkWaiter = createControlWaiter(timeout, accepted);
  try {
    await transmit([api.CODE.ENQ], "enq");
  } catch (error) {
    linkWaiter.cancel();
    throw error;
  }
  linkWaiter.arm();
  let control;
  try {
    control = await linkWaiter.promise;
  } catch (error) {
    linkWaiter.cancel();
    if (!/ACK待ちタイムアウト/.test(String(error.message))) throw error;
    addLog("warn", "RETRY", null, `ENQへの応答がありません（${timeout}ms） / ${attempt}/${attempts}`);
    return null;
  }

  // ENQ衝突。仕様どおり自分のENQを捨て、相手へ送信権を渡してから待ち時間を空ける。
  // 待ち時間はエレベータ1秒・パナソニック2秒と差をつけ、再送時の衝突を避ける。
  if (control === api.CODE.ENQ) {
    const backoff = api.TIMING.collisionBackoffMs[panasonicElevatorDirection()];
    state.inboundLink = true;
    armReceiveTimer("panasonicElevator", "link");
    await transmit([panasonicElevatorAckCode()], "response");
    addLog("warn", "COLLISION", [api.CODE.ENQ], `ENQ衝突。送信権を相手へ渡し、${backoff}ms後に再送します`);
    setSequence("衝突・受信へ譲渡");
    await sleep(backoff);
    return null;
  }

  setSequence(`電文ACK待ち ${attempt}/${attempts}`);
  const textWaiter = createControlWaiter(timeout, accepted);
  try {
    await transmit(frame, "frame");
  } catch (error) {
    textWaiter.cancel();
    throw error;
  }
  textWaiter.arm();
  try {
    const answer = await textWaiter.promise;
    if (!api.isAck(answer)) {
      addLog("warn", "RETRY", null, `電文への応答が${controlName("panasonicElevator", answer)}でした / ${attempt}/${attempts}`);
      return null;
    }
  } catch (error) {
    textWaiter.cancel();
    if (!/ACK待ちタイムアウト/.test(String(error.message))) throw error;
    addLog("warn", "RETRY", null, `電文への応答がありません（${timeout}ms） / ${attempt}/${attempts}`);
    return null;
  }

  setSequence("EOT送信");
  await transmit([api.CODE.EOT], "eot");
  setSequence("完了");
  addLog("info", "SEQ", null, `正常完了 / 送信${attempt}回`);
  return { type: "complete", attempts: attempt };
}

async function sendPanasonicElevatorFrame(frame, forceHandshake = false) {
  const api = panasonicElevatorApi();
  if (!forceHandshake && $("pevTransport").value === "direct") return transmit(frame, "frame");
  const attempts = api.TIMING.sendAttempts;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = await panasonicElevatorExchange(frame, attempt, attempts);
    if (result) return result;
  }
  setSequence("失敗");
  throw new Error(`ACKを受信できず、リトライ上限（計${attempts}回）に達しました`);
}

async function sendPanasonicElevator() {
  const frame = previewPanasonicElevator();
  return sendPanasonicElevatorFrame(frame);
}

// ヘルスチェック(IH)へは、エレベータ側として運行状態を載せた応答(SH)を返す。
function handlePanasonicElevatorRequest(frame) {
  if (!$("pevAutoResponse").checked) return;
  const api = panasonicElevatorApi();
  if (panasonicElevatorDirection() !== api.DIRECTION.FROM_ELEVATOR) return;
  const response = api.healthResponse(frame, { inspection: $("pevCarState").value === "inspection" });
  if (!response) return;
  scheduleAutoResponse("ヘルスチェック応答", () => sendPanasonicElevatorFrame(response, true));
}

function applyReceivedPanasonicElevator(result) {
  const parsed = result.parsed;
  if (!parsed || !parsed.command) throw new Error("コマンドを読み取れませんでした");
  // 受信電文と同じ向きへ送信側を合わせないと、そのコマンドを選べない。
  $("pevDirection").value = parsed.direction;
  refreshPanasonicElevatorCommands();
  $("pevCommand").value = parsed.command;
  refreshPanasonicElevatorExtras();
  const entry = panasonicElevatorCommand();
  if (entry.extras) {
    if (Array.from($("pevExtra").options).some((option) => option.value === parsed.extraCode)) {
      $("pevExtra").value = parsed.extraCode;
    }
  } else {
    $("pevExtraFree").value = parsed.extraCode;
  }
  if (parsed.buildingNo != null) $("pevBuilding").value = String(parsed.buildingNo);
  if (parsed.roomNo != null) $("pevRoom").value = String(parsed.roomNo).padStart(4, "0");
  if (parsed.lbNo != null) $("pevLb").value = String(parsed.lbNo);
  syncPanasonicElevatorForm();
  toast("受信電文を送信フォームへ取り込みました");
}

// Q48-005F：宅配側として動作しているときだけ、情報要求へ現在のロッカーデータで応答する。
function handleLocker4Request(frame) {
  if (!$("locker4AutoResponse").checked || $("locker4Action").value !== "response") return;
  const result = requireApi("AutoResponder").locker4Response(frame, {
    lockers: locker4CurrentLockers(),
    modelNo: locker4ModelNo(),
    packetSize: Number($("locker4PacketSize").value),
  });
  if (!result || logUnsupportedAutoResponse(result)) return;
  scheduleAutoResponse("4線式自動応答", async () => {
    addLog("info", "AUTO", null, `情報要求へ${result.frames.length}パケットで応答`);
    if ($("locker4Transport").value === "direct") {
      for (const packet of result.frames) await transmit(packet, "frame");
    } else {
      await runHandshake(result.frames, {
        sendEot: true,
        textRetryMode: "restart",
        linkTimeoutMs: 5000,
        textTimeoutMs: 5000,
      });
    }
  });
}

// Q48-008I：KIND/CMD台帳で応答コマンドが確定する要求にだけ応答する。
function handleMansionRequest(frame) {
  if (!$("mcAutoResponse").checked) return;
  const api = requireApi("MansionController");
  const result = requireApi("AutoResponder").mansionResponse(frame, {
    version: Number($("mcVersion").value),
    topology: mcTopology(api),
    role: $("mcRole").value,
    message: $("mcResponseMessage").value,
  });
  if (!result || logUnsupportedAutoResponse(result)) return;
  scheduleAutoResponse("MC自動応答", async () => {
    addLog("info", "AUTO", result.frame, `${result.request.name}へ${result.definition.name}を送信`);
    if ($("mcTransport").value === "direct") await transmit(result.frame, "frame");
    else await runHandshake([result.frame], { sendEot: false, textRetryMode: "sameText", priority: $("mcRole").value === "IC" });
  });
}

// Q46-005J 4.5.1：EV側として動作しているとき、ECALLへ動作中／停止中情報を返す。
function handleElevatorRequest(frame) {
  const api = requireApi("ElevatorProtocol");
  if (!$("elevatorAutoResponse").checked || $("elevatorDirection").value !== api.DIRECTION.FROM_ELEVATOR) return;
  const result = requireApi("AutoResponder").elevatorResponse(frame, {
    profile: $("elevatorProfile").value,
    moving: $("elevatorCarState").value === "moving",
  });
  if (!result || logUnsupportedAutoResponse(result)) return;
  scheduleAutoResponse("EV自動応答", async () => {
    addLog("info", "AUTO", result.frame, `ECALLへ${result.command}を送信`);
    if ($("elevatorTransport").value === "direct") await transmit(result.frame, "frame");
    else await runHandshake([result.frame], { sendEot: false, textRetryMode: "sameText", priority: false });
  });
}

function mcTopology(api) {
  const value = $("mcTopology").value;
  return value === "standard" ? api.TOPOLOGY.STANDARD
    : value === "multiStation" ? api.TOPOLOGY.SINGLE_BUILDING_MULTI_CONTROLLER
      : api.TOPOLOGY.MULTI_BUILDING;
}

function mcAddressHelper(api) {
  const type = $("mcAddressType").value;
  if (type === "none") return "";
  const topology = mcTopology(api);
  const number = Number($("mcAddressNumber").value);
  const options = {
    version: Number($("mcVersion").value),
    topology,
    building: $("mcBuilding").value.trim(),
  };
  const addressType = type === "room" ? api.ADDRESS_TYPE.RESIDENCE
    : type === "manager" ? api.ADDRESS_TYPE.MANAGEMENT_STATION
      : type === "entrance" ? api.ADDRESS_TYPE.ENTRANCE_STATION
        : type === "group" ? api.ADDRESS_TYPE.GROUP
          : type === "floor" ? api.ADDRESS_TYPE.FLOOR : api.ADDRESS_TYPE.COMMON_AREA;
  if (type === "room") options.room = number;
  else if (type === "manager" || type === "entrance") options.station = number;
  else if (type === "group") options.group = number;
  else if (type === "floor") options.floor = number;
  if (typeof api.buildAddress === "function") return api.buildAddress(addressType, options);
  if (typeof api.formatAddress === "function") return api.formatAddress({ type, ...options });
  throw new Error("ADDRヘルパAPIを利用できません");
}

// Q48-008I 6章のメッセージ定義に従って入力欄を組み立てる。
// 定義が未整備のコマンドは生MESGへ退避する。
function mcSchema() {
  const api = window.MansionController;
  if (!api || !api.messageSchema) return null;
  try {
    return api.messageSchema(parseHexByte($("mcKind").value, "KIND"), parseHexByte($("mcCommand").value, "CMD"));
  } catch (_error) {
    return null;
  }
}

function mcSchemaActive() {
  return Boolean($("mcUseSchema").checked && mcSchema());
}

function mcAlarmCheckboxes() {
  return Array.from($("mcAlarmBits").querySelectorAll("input[type=checkbox]"));
}

function mcSelectedAlarms() {
  return mcAlarmCheckboxes().filter((box) => box.checked).map((box) => Number(box.dataset.index));
}

// KH_INFはVerで割付そのものが変わるため、Verを変えたら並べ直す。
function renderMcAlarmBits() {
  const api = requireApi("MansionController");
  const version = Number($("mcVersion").value);
  const container = $("mcAlarmBits");
  const previous = new Set(mcAlarmCheckboxes().filter((box) => box.checked).map((box) => box.dataset.label));
  const fragment = document.createDocumentFragment();
  for (const entry of api.alarmInfoLayout(version)) {
    const label = document.createElement("label");
    const box = document.createElement("input");
    box.type = "checkbox";
    box.dataset.index = String(entry.index);
    box.dataset.label = entry.label || "";
    // 未使用bitは0固定なので触らせない。
    box.disabled = entry.reserved;
    if (!entry.reserved && previous.has(entry.label)) box.checked = true;
    const text = document.createElement("span");
    text.textContent = entry.reserved ? `${entry.index + 1}（未使用）` : entry.label;
    label.classList.toggle("bit-unassigned", entry.reserved);
    label.append(box, text);
    fragment.append(label);
  }
  container.replaceChildren(fragment);
}

function updateMcAlarmSummary() {
  const api = requireApi("MansionController");
  const version = Number($("mcVersion").value);
  const selected = mcSelectedAlarms();
  const bytes = api.encodeAlarmInfo(selected, version);
  const names = mcAlarmCheckboxes().filter((box) => box.checked).map((box) => box.dataset.label);
  $("mcAlarmSummary").textContent = `${api.alarmInfoByteLength(version)}byte ${toHex(bytes)}`
    + `／${names.length ? names.join("＋") : "全復旧（全bit OFF）"}`;
}

// 列挙フィールドはselect、ADDRはADDRヘルパへ委譲する。
function renderMcPayload() {
  const api = window.MansionController;
  const picker = $("mcPayload");
  const schema = mcSchema();
  if (!api || !schema) {
    picker.hidden = true;
    $("mcAlarmPicker").hidden = true;
    $("mcPayloadFields").replaceChildren();
    return;
  }
  picker.hidden = false;
  const version = Number($("mcVersion").value);
  const fragment = document.createDocumentFragment();
  let needsAddress = false;
  let hasAlarm = false;

  for (const entry of schema) {
    if (entry.type === api.FIELD.ADDRESS) { needsAddress = true; continue; }
    if (entry.type === api.FIELD.ALARM_INFO) { hasAlarm = true; continue; }
    if (entry.type === api.FIELD.DIGITS) {
      const digits = document.createElement("label");
      digits.textContent = `${entry.name}（${entry.label}）`;
      const input = document.createElement("input");
      input.id = `mcField_${entry.name}`;
      input.type = "number";
      input.min = String(entry.min == null ? 0 : entry.min);
      input.max = String(Math.pow(10, entry.bytes) - 1);
      input.value = String(entry.default == null ? 0 : entry.default);
      digits.append(input);
      fragment.append(digits);
      continue;
    }
    if (entry.type !== api.FIELD.ENUM) continue;
    const label = document.createElement("label");
    label.textContent = `${entry.name}（${entry.label}）`;
    const select = document.createElement("select");
    select.id = `mcField_${entry.name}`;
    const allowed = entry.versionValues ? entry.versionValues[version] : null;
    for (const [code, text] of Object.entries(entry.values)) {
      const value = Number(code);
      if (allowed && !allowed.includes(value)) continue;
      const option = document.createElement("option");
      option.value = String(value);
      option.textContent = `${value.toString(16).toUpperCase().padStart(2, "0")}H ${text}`;
      select.append(option);
    }
    label.append(select);
    fragment.append(label);
  }
  $("mcPayloadFields").replaceChildren(fragment);

  $("mcAlarmPicker").hidden = !hasAlarm;
  if (hasAlarm) {
    renderMcAlarmBits();
    updateMcAlarmSummary();
  }

  const parts = schema.map((entry) => entry.name);
  const addressNote = needsAddress
    ? ($("mcAddressType").value === "none" ? "／ADDRヘルパで住戸NOを指定してください" : "")
    : "";
  $("mcPayloadNote").textContent = parts.length
    ? `構成: ${parts.join(" + ")}${addressNote}`
    : "このコマンドはパラメータ無しです";
}

// 定義に沿ってMESGを組み立てる。ADDRはADDRヘルパの値を使う。
function mcSchemaMessage(api) {
  const schema = mcSchema();
  const version = Number($("mcVersion").value);
  const values = {};
  for (const entry of schema) {
    if (entry.type === api.FIELD.ADDRESS) {
      const text = mcAddressHelper(api);
      if (!text) throw new Error(`${entry.name}が必要です。ADDRヘルパで住戸NOを指定してください`);
      values[entry.name] = text;
      continue;
    }
    if (entry.type === api.FIELD.ALARM_INFO) {
      values[entry.name] = mcSelectedAlarms();
      continue;
    }
    if (entry.type === api.FIELD.ENUM || entry.type === api.FIELD.DIGITS) {
      const element = $(`mcField_${entry.name}`);
      if (!element) throw new Error(`${entry.name}の入力欄が見つかりません`);
      values[entry.name] = Number(element.value);
    }
  }
  return api.buildMessage(
    parseHexByte($("mcKind").value, "KIND"),
    parseHexByte($("mcCommand").value, "CMD"),
    { version, values },
  );
}

function buildMcFrame() {
  const api = requireApi("MansionController");
  const kind = parseHexByte($("mcKind").value, "KIND");
  const command = parseHexByte($("mcCommand").value, "CMD");
  const topology = mcTopology(api);
  // 仕様定義があるコマンドは定義から組み立て、無いものは従来どおり生MESGを使う。
  const message = mcSchemaActive()
    ? mcSchemaMessage(api)
    : latin1(`${mcAddressHelper(api)}${$("mcMessage").value}`, "MESG");
  const options = {
    kind,
    command,
    cmd: command,
    message,
    version: Number($("mcVersion").value),
    from: $("mcRole").value,
    topology,
  };
  const builder = api.buildFrame || api.buildTelegram || api.build;
  if (typeof builder !== "function") throw new Error("MCフレームビルダーを利用できません");
  return builder.call(api, options);
}

function refreshMcCommands() {
  const api = window.MansionController;
  if (!api) return;
  const previous = $("mcCommand").value;
  const kind = parseHexByte($("mcKind").value, "KIND");
  const definitions = api.listCommandDefinitions({
    version: Number($("mcVersion").value),
    from: $("mcRole").value,
  }).filter((definition) => definition.kind === kind);
  $("mcCommand").replaceChildren();
  for (const definition of definitions) {
    const option = document.createElement("option");
    option.value = definition.command.toString(16).toUpperCase().padStart(2, "0");
    option.textContent = `${option.value} ${definition.name}`;
    $("mcCommand").append(option);
  }
  if (definitions.some((definition) => definition.command.toString(16).toUpperCase().padStart(2, "0") === previous)) $("mcCommand").value = previous;
  renderMcPayload();
}

async function preview(id, builder, multiple = false) {
  try {
    const result = builder();
    $(id).textContent = multiple ? result.map((frame, index) => `#${index + 1} ${toHex(frame)}`).join("\n") : toHex(result);
    return result;
  } catch (error) {
    $(id).textContent = `ERROR: ${error.message}`;
    throw error;
  }
}

async function sendKey() {
  const api = requireApi("NoncontactKey");
  const frame = await preview("keyPreview", buildKeyFrame);
  if ($("keyWaitAck").value === "direct") {
    await transmit(frame, "frame");
    return;
  }
  const sender = new api.NoncontactSender({ maxRetries: 5 });
  let action = sender.start(frame);
  while (action.type === "send") {
    setSequence(`非接触キー ACK待ち ${action.attempt}/6`);
    const waiter = createControlWaiter(5000, [api.CODE.ACK, api.CODE.NAK]);
    try {
      await transmit(action.packet, "frame");
      waiter.arm();
      const control = await waiter.promise;
      action = sender.onControl(control);
      if (action.type === "ignored") continue;
    } catch (error) {
      waiter.cancel();
      if (/ACK待ちタイムアウト/.test(String(error && error.message))) action = sender.onTimeout();
      else throw error;
    }
  }
  if (action.type === "complete") {
    setSequence("完了");
    addLog("info", "SEQ", null, `ACK受信 / ${action.attempts}回目`);
  } else {
    setSequence("失敗");
    throw new Error(action.reason === "timeout" ? "5秒以内に応答がありません" : "NAK再送上限に到達しました");
  }
}

async function sendControlByte(value) {
  if (state.activeTransaction) throw new Error(`${state.activeTransaction}の通信中は手動byteを割り込ませられません`);
  await transmit([value], "control");
  if ($("autoTransportResponse").value !== "manual") return;
  if (state.manualReceiveStage === "link-response") {
    if (value === 0x06) {
      state.inboundLink = true;
      state.manualReceiveStage = "frame";
      armReceiveTimer(state.currentView, "link");
      setSequence("手動ACK送信・受信電文待ち");
    } else if (value === 0x15) {
      state.manualReceiveStage = null;
      setSequence("手動NAK送信");
    }
  } else if (state.manualReceiveStage === "frame-response" && [0x06, 0x15].includes(value)) {
    state.manualReceiveStage = null;
    state.pendingFrameValid = null;
    if (value === 0x06 && state.currentView === "locker4" && state.locker4Inbound) {
      armReceiveTimer("locker4", "link");
      setSequence(state.locker4Inbound.expectedPackage < 0 ? "手動ACK・EOT待ち" : `手動ACK・package ${state.locker4Inbound.expectedPackage}待ち`);
    } else {
      if (value === 0x15 && state.currentView === "locker4") resetLocker4Inbound();
      setSequence(value === 0x06 ? "手動ACK送信・受信完了" : "手動NAK送信・受信破棄");
    }
  }
}

async function sendLocker2() {
  const frames = await preview("locker2Preview", buildLocker2Frames, true);
  const token = { cancelled: false };
  state.locker2Run = token;
  $("locker2StopButton").disabled = false;
  const cycle = $("locker2Repeat").value === "cycle";
  try {
    do {
      for (let offset = 0; offset < frames.length && !token.cancelled; offset += 5) {
        const group = frames.slice(offset, offset + 5);
        setSequence(`2線式 ${offset + 1}～${offset + group.length}/${frames.length}`);
        for (const frame of group) await transmit(frame, "frame");
        if (!token.cancelled && (cycle || offset + 5 < frames.length)) await sleep(1000);
      }
    } while (cycle && !token.cancelled);
    setSequence(token.cancelled ? "反復停止" : "完了");
  } finally {
    if (state.locker2Run === token) state.locker2Run = null;
    $("locker2StopButton").disabled = true;
  }
}

// フレーム境界の検出は protocol/frame-reader.js に集約している。
// マンションコントローラはStreamDecoderへ委譲され、LEN範囲・早すぎるETX・
// 再同期の記録まで実通信経路で効く。
// パナソニックは1画面でフレーム形式が変わるため、画面名ではなく
// 選択中のプロトコルに対応するリーダーを引く。
function frameReaderProfile() {
  if (state.currentView !== "panasonic") return state.currentView;
  return panasonicStyle() === requireApi("PanasonicAlarm").STYLE.BLOCK ? "panasonicBlock" : "panasonicRecord";
}

function currentFrameReader() {
  const profile = frameReaderProfile();
  if (!state.frameReader || state.frameReaderView !== profile) {
    const Reader = requireApi("FrameReader");
    // KIND/CMDの方向・Version検証は describeFrame 側で行うため、ここでは長さとBCCだけを見る。
    state.frameReader = new Reader(profile, { validateCommand: false });
    state.frameReaderView = profile;
  }
  return state.frameReader;
}

function resetFrameReader() {
  if (state.frameReader) state.frameReader.reset();
}

function trackLocker4Packet(value) {
  state.locker4Inbound = state.locker4Series.accept(value);
}

// ---------------------------------------------------------------- 受信モニタ
// 受信電文の解析は protocol/receive-inspector.js に集約し、ここでは
// 「現在の画面設定を解析条件へ渡す」「結果を描画する」だけを行う。
// 検証NGでも読み取れた範囲は必ず表示し、何が仕様と違うのかを画面に残す。

function receiveMonitorState(view) {
  if (!RECEIVE_MONITORS[view]) return null;
  if (!state.receiveMonitors[view]) {
    const summary = $(`${RECEIVE_MONITORS[view].prefix}Summary`);
    state.receiveMonitors[view] = {
      history: [],
      shownId: null,
      nextId: 1,
      // 機種ごとの初期メッセージはindex.html側に書いてあるので、それを保持する。
      placeholder: summary ? summary.textContent : "",
    };
  }
  return state.receiveMonitors[view];
}

// 解析条件は送信フォームと同じ設定から作る。方向・機種制約の食い違いを
// 「異常」ではなく「注意」として示すため、インスペクタへ渡して判定させる。
function receiveInspectOptions(view) {
  if (view === "locker4") {
    return { expectedType: $("locker4Action").value === "request" ? "response" : "request" };
  }
  if (view === "locker2") {
    return { maxBuilding: locker2Limits().maxBuilding };
  }
  if (view === "key") {
    const profile = keyProfile();
    return { buildingMax: profile.buildingMax, personMax: profile.personMax, systemLabel: profile.label };
  }
  if (view === "panasonic") {
    return { protocol: $("panaProtocol").value };
  }
  if (view === "panasonicElevator") {
    // 電文の向きは電文自身が決めるため、選択中の動作側は注意の判定にだけ使う。
    return { direction: $("pevDirection").value === "toElevator" ? "fromElevator" : "toElevator" };
  }
  return {};
}

function receiveElement(view, suffix) {
  const config = RECEIVE_MONITORS[view];
  return config ? $(`${config.prefix}${suffix}`) : null;
}

// 履歴には受信バイト列だけを残し、解析は描画時に行う。こうすると
// 対象システムや動作側を切り替えたときに、過去の受信電文もその条件で
// 読み直せる（受信データ自体は書き換えない）。
function recordReceiveEntry(view, bytes, at, frameError) {
  const monitor = receiveMonitorState(view);
  if (!monitor || !window.ReceiveInspector) return null;
  const config = RECEIVE_MONITORS[view];
  const entry = {
    id: monitor.nextId,
    at: Number.isFinite(at) ? at : Date.now(),
    bytes: Array.from(bytes || []),
    frameError: frameError || null,
  };
  monitor.nextId += 1;
  monitor.history.push(entry);
  while (monitor.history.length > config.historyLimit) monitor.history.shift();
  if (view === "locker2") updateLocker2Inbox(entry);
  const follow = receiveElement(view, "Follow");
  if (!follow || follow.checked || monitor.shownId == null) monitor.shownId = entry.id;
  renderReceiveMonitor(view);
  return entry;
}

// フレームとして成立した受信電文。
function recordReceivedFrame(view, bytes, at) {
  return recordReceiveEntry(view, bytes, at, null);
}

// フレーム境界の検出段階で失敗した受信データも同じ枠組みで残す。
function recordReceiveError(view, bytes, message, at) {
  return recordReceiveEntry(view, bytes, at, message || "受信データを解釈できません");
}

function inspectReceiveEntry(view, entry) {
  const api = window.ReceiveInspector;
  if (!entry || !api) return null;
  return entry.frameError
    ? api.errorResult(view, entry.bytes, entry.frameError)
    : api.inspect(view, entry.bytes, receiveInspectOptions(view));
}

function shownReceiveEntry(view) {
  const monitor = receiveMonitorState(view);
  if (!monitor || monitor.history.length === 0) return null;
  return monitor.history.find((entry) => entry.id === monitor.shownId) || monitor.history[monitor.history.length - 1];
}

function receiveVerdictOf(result) {
  if (!result) return { text: "未受信", tone: "" };
  if (!result.valid) return { text: "検証NG", tone: "error" };
  if (result.warnings.length) return { text: "検証OK（注意あり）", tone: "warn" };
  return { text: "検証OK", tone: "ok" };
}

function renderReceiveNotes(view, result) {
  const container = receiveElement(view, "Notes");
  if (!container) return;
  const fragment = document.createDocumentFragment();
  for (const problem of result ? result.problems : []) {
    const item = document.createElement("p");
    item.className = "receive-note error";
    item.textContent = `仕様違反: ${problem}`;
    fragment.append(item);
  }
  for (const warning of result ? result.warnings : []) {
    const item = document.createElement("p");
    item.className = "receive-note warn";
    item.textContent = `注意: ${warning}`;
    fragment.append(item);
  }
  if (result && result.expectedResponse) {
    const item = document.createElement("p");
    item.className = "receive-note info";
    item.textContent = `仕様上この電文へ返す応答: ${result.expectedResponse}`;
    fragment.append(item);
  }
  container.replaceChildren(fragment);
}

function renderReceiveBadges(view, result) {
  const container = receiveElement(view, "Badges");
  if (!container) return;
  const fragment = document.createDocumentFragment();
  for (const item of result ? result.badges : []) {
    const chip = document.createElement("span");
    chip.className = `receive-badge ${item.tone}`;
    chip.textContent = item.label;
    fragment.append(chip);
  }
  container.replaceChildren(fragment);
}

function emptyReceiveRow(columns, text) {
  const row = document.createElement("tr");
  row.className = "receive-empty";
  const cell = document.createElement("td");
  cell.colSpan = columns;
  cell.textContent = text;
  row.append(cell);
  return row;
}

function renderReceiveFields(view, result) {
  const body = receiveElement(view, "Fields");
  if (!body) return;
  if (!result || result.fields.length === 0) {
    body.replaceChildren(emptyReceiveRow(4, "受信待ち"));
    return;
  }
  const fragment = document.createDocumentFragment();
  for (const field of result.fields) {
    const row = document.createElement("tr");
    row.className = `receive-row ${field.status}`;
    const position = document.createElement("td");
    position.className = "receive-pos";
    position.textContent = field.range;
    const label = document.createElement("td");
    label.className = "receive-label";
    label.textContent = field.label;
    const raw = document.createElement("td");
    raw.className = "receive-raw";
    raw.textContent = field.raw || "—";
    const meaning = document.createElement("td");
    const value = document.createElement("div");
    value.className = "receive-value";
    value.textContent = field.value;
    meaning.append(value);
    if (field.note) {
      const note = document.createElement("div");
      note.className = "receive-hint";
      note.textContent = field.note;
      meaning.append(note);
    }
    row.append(position, label, raw, meaning);
    fragment.append(row);
  }
  body.replaceChildren(fragment);
}

// ロッカーデータ内訳は4線式だけが持つ。
function renderReceiveLockers(view, result) {
  const body = receiveElement(view, "Lockers");
  if (!body) return;
  const count = receiveElement(view, "LockerCount");
  const lockers = result ? result.lockers : [];
  if (count) count.textContent = `${lockers.length}件`;
  if (lockers.length === 0) {
    body.replaceChildren(emptyReceiveRow(8, result ? "この電文にロッカーデータはありません" : "受信待ち"));
    return;
  }
  const fragment = document.createDocumentFragment();
  for (const locker of lockers) {
    const row = document.createElement("tr");
    row.className = `receive-row ${locker.status}`;
    const cells = [
      String(locker.index),
      locker.range,
      `${locker.stateHex} ${locker.stateLabel}`,
      locker.lockerText,
      locker.buildingText,
      locker.roomText,
      locker.data2Text,
      locker.note || "—",
    ];
    for (const text of cells) {
      const cell = document.createElement("td");
      cell.textContent = text;
      row.append(cell);
    }
    fragment.append(row);
  }
  body.replaceChildren(fragment);
}

function renderReceiveHistory(view) {
  const container = receiveElement(view, "History");
  if (!container) return;
  const monitor = receiveMonitorState(view);
  const count = receiveElement(view, "HistoryCount");
  if (count) count.textContent = `${monitor.history.length}件`;
  if (monitor.history.length === 0) {
    const empty = document.createElement("p");
    empty.className = "receive-empty-text";
    empty.textContent = "受信履歴はありません";
    container.replaceChildren(empty);
    return;
  }
  const fragment = document.createDocumentFragment();
  // 直近の受信を上に置き、試験中に最新の電文をすぐ確認できるようにする。
  for (const entry of monitor.history.slice().reverse()) {
    const result = inspectReceiveEntry(view, entry);
    const button = document.createElement("button");
    const verdict = receiveVerdictOf(result);
    button.className = `receive-history-item ${verdict.tone}`;
    button.classList.toggle("active", entry.id === monitor.shownId);
    const time = document.createElement("span");
    time.className = "receive-history-time";
    time.textContent = formatTime(entry.at);
    const summary = document.createElement("span");
    summary.className = "receive-history-summary";
    summary.textContent = result ? result.summary : `${entry.bytes.length}バイト受信`;
    button.append(time, summary);
    button.addEventListener("click", () => {
      monitor.shownId = entry.id;
      renderReceiveMonitor(view);
    });
    fragment.append(button);
  }
  container.replaceChildren(fragment);
}

function renderReceiveMonitor(view) {
  if (!RECEIVE_MONITORS[view]) return;
  const entry = shownReceiveEntry(view);
  const result = inspectReceiveEntry(view, entry);
  const verdict = receiveVerdictOf(result);
  const verdictElement = receiveElement(view, "Verdict");
  if (verdictElement) {
    verdictElement.textContent = verdict.text;
    verdictElement.className = `receive-verdict ${verdict.tone}`;
  }
  const summary = receiveElement(view, "Summary");
  if (summary) {
    summary.textContent = result
      ? `${formatTime(entry.at)} 受信 — ${result.summary}`
      : receiveMonitorState(view).placeholder;
  }
  const hex = receiveElement(view, "Hex");
  if (hex) hex.textContent = result && result.bytes.length ? `${toHex(result.bytes)}\n${toAscii(result.bytes)}` : "—";
  renderReceiveBadges(view, result);
  renderReceiveNotes(view, result);
  renderReceiveFields(view, result);
  renderReceiveLockers(view, result);
  if (view === "locker2") renderLocker2Inbox();
  renderReceiveHistory(view);
}

function clearReceiveMonitor(view) {
  const monitor = receiveMonitorState(view);
  if (!monitor) return;
  monitor.history.length = 0;
  monitor.shownId = null;
  if (view === "locker2") {
    state.locker2Inbox.clear();
    state.locker2InboxStats = { total: 0, vacant: 0 };
  }
  renderReceiveMonitor(view);
  toast("受信履歴を消去しました");
}

// 受信した内容を送信側の設定へ取り込む。実機の状態をそのまま引き継いで
// 折り返し試験を行えるようにするための操作で、通信そのものは行わない。
function applyReceivedLocker4(result) {
  if (!result.lockers.length) throw new Error("反映できるロッカーデータが受信電文にありません");
  let applied = 0;
  const missing = [];
  for (const locker of result.lockers) {
    if (locker.lockerNo == null || locker.state == null) continue;
    // 宅配ロボ状態はロッカーNO 000固定のため、対応する行を特定できない。
    if (locker.lockerNo === 0) {
      missing.push("000（宅配ロボ状態）");
      continue;
    }
    const row = state.locker4Rows.find((item) => item.lockerNo === locker.lockerNo);
    if (!row) {
      missing.push(String(locker.lockerNo).padStart(3, "0"));
      continue;
    }
    row.currentState = locker.state;
    if (locker.buildingNo != null) row.buildingNo = locker.buildingNo;
    if (locker.roomNo != null) row.roomNo = locker.roomNo;
    applied += 1;
  }
  if (applied === 0) throw new Error("受信したロッカーNOに一致する行がロッカー一覧にありません");
  renderLocker4Table();
  const detail = missing.length ? `（一覧にないロッカーNO: ${missing.join(", ")}）` : "";
  addLog("info", "RX-APPLY", null, `受信した${applied}件のロッカー状態を一覧へ反映${detail}`);
  toast(`${applied}件のロッカー状態を一覧へ反映しました${detail}`);
}

// Q55-001D：旧版は全ロッカーを連続送信するため、受信履歴（保持100件）だけでは
// 登録済みの住戸が未登録ロッカーに押し出されて見えなくなる。
// 住戸アドレス単位で最新状態を集計し、履歴の保持件数に関係なく残す。
function updateLocker2Inbox(entry) {
  state.locker2InboxStats.total += 1;
  const parsed = (inspectReceiveEntry("locker2", entry) || {}).parsed;
  if (!parsed || parsed.address == null || parsed.vacant) {
    if (parsed && parsed.vacant) state.locker2InboxStats.vacant += 1;
    return;
  }
  const previous = state.locker2Inbox.get(parsed.address);
  state.locker2Inbox.set(parsed.address, {
    address: parsed.address,
    buildingNo: parsed.buildingNo,
    roomNo: parsed.roomNo,
    command: parsed.command,
    commandLabel: parsed.commandLabel,
    at: entry.at,
    count: previous ? previous.count + 1 : 1,
  });
}

function locker2InboxRows() {
  return Array.from(state.locker2Inbox.values()).sort((left, right) => left.address - right.address);
}

function renderLocker2Inbox() {
  const body = $("locker2InboxBody");
  if (!body) return;
  const rows = locker2InboxRows();
  const stats = state.locker2InboxStats;
  $("locker2InboxCount").textContent = `${rows.length}件`;
  $("locker2InboxStats").textContent = stats.total === 0
    ? "未受信"
    : `受信 ${stats.total}件（登録済み ${stats.total - stats.vacant}件 / 未登録 ${stats.vacant}件）`;

  if (rows.length === 0) {
    const empty = document.createElement("tr");
    empty.className = "receive-empty";
    const cell = document.createElement("td");
    cell.colSpan = 6;
    cell.textContent = stats.total === 0 ? "受信待ち" : "登録済みロッカーの電文をまだ受信していません";
    empty.append(cell);
    body.replaceChildren(empty);
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const row of rows) {
    const line = document.createElement("tr");
    for (const text of [
      String(row.address),
      row.buildingNo == null ? "—" : `${row.buildingNo}棟`,
      row.roomNo == null ? "—" : `${row.roomNo}号室`,
      row.commandLabel || (row.command == null ? "—" : `${toHex([row.command])}H`),
      formatTime(row.at),
      `${row.count}回`,
    ]) {
      const cell = document.createElement("td");
      cell.textContent = text;
      line.append(cell);
    }
    fragment.append(line);
  }
  body.replaceChildren(fragment);
}

// 表示中の1件ではなく、集計した住戸をまとめて登録一覧へ書き戻す。
function applyLocker2Inbox() {
  const rows = locker2InboxRows();
  if (rows.length === 0) throw new Error("反映できる受信内容がありません");
  const missing = [];
  let applied = 0;
  for (const row of rows) {
    const target = state.locker2Rows.find((item) => item.no === row.address);
    if (!target) { missing.push(row.address); continue; }
    target.command = row.command;
    if (row.buildingNo != null) target.buildingNo = row.buildingNo;
    if (row.roomNo != null) target.roomNo = row.roomNo;
    applied += 1;
  }
  renderLocker2Table();
  const note = missing.length ? `（登録行なし: 住戸アドレス${missing.join("・")}）` : "";
  addLog("info", "RX-APPLY", null, `住戸別の受信状況${applied}件を登録一覧へ反映${note}`);
  toast(`${applied}件を登録一覧へ反映しました${missing.length ? `／${missing.length}件は登録行がありません` : ""}`);
}

function applyReceivedLocker2(result) {
  const parsed = result.parsed;
  if (!parsed || parsed.address == null) throw new Error("住戸アドレスを読み取れないため反映できません");
  if (parsed.vacant) throw new Error("未登録ロッカーの電文は反映できません");
  if (parsed.command == null || parsed.roomNo == null) throw new Error("コマンドまたは住戸番号を読み取れないため反映できません");
  const row = state.locker2Rows.find((item) => item.no === parsed.address);
  if (!row) throw new Error(`住戸アドレス${parsed.address}に対応する登録行がありません。登録行数を増やしてください`);
  row.command = parsed.command;
  row.buildingNo = parsed.buildingNo == null ? row.buildingNo : parsed.buildingNo;
  row.roomNo = parsed.roomNo;
  renderLocker2Table();
  addLog("info", "RX-APPLY", null, `受信内容を住戸アドレス${parsed.address}の登録行へ反映`);
  toast(`住戸アドレス${parsed.address}の登録行へ反映しました`);
}

function applyReceivedKey(result) {
  const parsed = result.parsed;
  if (!parsed || parsed.gateNo == null || parsed.roomNo == null) throw new Error("ゲートNoまたは部屋番号を読み取れないため反映できません");
  const api = requireApi("NoncontactKey");
  $("keyFormat").value = parsed.format === api.FORMAT.WITH_PERSON ? api.FORMAT.WITH_PERSON : api.FORMAT.ROOM_ONLY;
  $("keyGate").value = String(parsed.gateNo);
  if (parsed.buildingNo != null) $("keyBuilding").value = String(parsed.buildingNo);
  $("keyRoom").value = String(parsed.roomNo).padStart(4, "0");
  if (parsed.personNo != null) $("keyPerson").value = String(parsed.personNo);
  // 対象システム制約は変更しないため、上限超過はここで丸められる。
  syncKeyForm();
  preview("keyPreview", buildKeyFrame).catch(() => undefined);
  addLog("info", "RX-APPLY", null, `受信内容を送信フォームへ取り込み（ゲート${parsed.gateNo} / ${String(parsed.roomNo).padStart(4, "0")}）`);
  toast("受信内容を送信フォームへ取り込みました");
}

function applyReceiveMonitor(view) {
  const result = inspectReceiveEntry(view, shownReceiveEntry(view));
  if (!result) throw new Error("反映できる受信電文がありません");
  if (view === "locker4") return applyReceivedLocker4(result);
  if (view === "locker2") return applyReceivedLocker2(result);
  if (view === "key") return applyReceivedKey(result);
  if (view === "panasonic") return applyReceivedPanasonic(result);
  if (view === "panasonicElevator") return applyReceivedPanasonicElevator(result);
  throw new Error("この画面には反映機能がありません");
}

function describeFrame(view, frame) {
  if (view === "locker2") {
    const api = requireApi("Telegram2");
    const value = api.parseTelegram(frame);
    if (value.vacant) return `2線式 未登録ロッカー addr=${value.address}`;
    const limits = locker2Limits();
    api.validateRegistrationList([value], {
      maxEntries: MAX_LOCKER2_ROWS,
      allowedBuildingNos: Array.from({ length: limits.maxBuilding + 1 }, (_unused, index) => index),
    });
    return `2線式 状態=${value.command.toString(16).toUpperCase()} 棟=${value.buildingNo} 住戸=${value.roomNo} addr=${value.address}`;
  }
  if (view === "locker4") {
    const value = requireApi("Telegram4").parseTelegram(frame);
    const expectedType = $("locker4Action").value === "request" ? "response" : "request";
    if (value.type !== expectedType) throw new Error(`現在の動作側では${value.type}電文を受信できません`);
    value.lockers.forEach((locker, index) => {
      locker4State(locker.state.toString(16).padStart(2, "0"), index);
      if ([0x40, 0x41, 0x42].includes(locker.state) && locker.lockerNo !== 0) {
        throw new Error("宅配ロボ状態のロッカーNoは000固定です");
      }
    });
    if (state.inboundLink) trackLocker4Packet(value);
    return `4線式 ${value.type} pkg=${value.packageNo} model=${value.modelNo == null ? "空白" : value.modelNo} ${value.lockers.length}件`;
  }
  if (view === "key") {
    const value = requireApi("NoncontactKey").parseTelegram(frame, {
      personMax: $("keyProfile").value === "limited8" ? 8 : 999,
    });
    return `非接触キー gate=${value.gateNo} room=${value.roomNo5} person=${value.personNo == null ? "なし" : value.personNo}`;
  }
  if (view === "elevator") {
    const api = requireApi("ElevatorProtocol");
    const incomingDirection = $("elevatorDirection").value === api.DIRECTION.TO_ELEVATOR
      ? api.DIRECTION.FROM_ELEVATOR : api.DIRECTION.TO_ELEVATOR;
    const value = api.parseFrame(frame, { profile: $("elevatorProfile").value, direction: incomingDirection });
    return `EV ${value.command} gate=${value.gate.raw} room=${value.room.raw}`;
  }
  if (view === "alarm") {
    const api = requireApi("AlarmProtocol");
    const value = api.parseFrame(frame);
    const localRole = $("alarmRole").value;
    if ((localRole === "intercom" && value.type !== api.TYPE.HISTORY_REQUEST) ||
        (localRole === "alarm" && value.type === api.TYPE.HISTORY_REQUEST)) {
      throw new Error("現在の動作側に対して送信方向が逆です");
    }
    const info = alarmInfoDetail(value.info, value.type);
    return `警報 ${value.typeName} info=${info.hex}（${info.summary}） source=${value.source.kind}`;
  }
  if (view === "panasonic") {
    const api = panasonicApi();
    const protocol = panasonicProtocol();
    const label = panasonicInfo().label;
    if (panasonicIsBlock()) {
      const value = api.parseBlockFrame(frame, { protocol });
      const detail = api.describeInfo(protocol, value.type, value.info);
      // 要求はIFUが受け、警報データは他社通報機が受ける。逆向きなら止める。
      const localRole = $("panaRole").value;
      if ((localRole === "ifu" && !value.request) || (localRole === "peer" && value.request)) {
        throw new Error("現在の動作側に対して送信方向が逆です");
      }
      const history = value.historyNumber ? ` ﾋｽﾄﾘｰ${value.historyNumber}` : "";
      return `パナソニック${label} ${value.typeLabel} info=${detail.hex}（${detail.summary}） 棟=${value.buildingNo} 住戸=${String(value.roomNo).padStart(4, "0")}${history}`;
    }
    const value = api.parseRecordFrame(frame, { protocol });
    if (value.kind === "ack") return `パナソニック${label} アンサーバックACK`;
    if (value.kind === "nak") return `パナソニック${label} アンサーバックNAK`;
    if (value.kind === "scheduled") return `パナソニック${label} 定時送信 物件コード=${value.propertyCode}`;
    const records = value.records
      .map((record) => `${record.mode}${String(record.buildingNo).padStart(2, "0")}-${String(record.roomNo).padStart(4, "0")}:${String(record.alarmNo).padStart(2, "0")}${record.alarmLabel ? `(${record.alarmLabel})` : ""}`)
      .join(" ");
    return `パナソニック${label} 警報データ ${value.recordCount}件 ${records}`;
  }
  if (view === "panasonicElevator") {
    const api = panasonicElevatorApi();
    const value = api.parseFrame(frame);
    const extra = value.extraLabel ? `（${value.extraLabel}）` : "";
    const room = value.usage.room ? ` 住戸=${String(value.roomNo).padStart(4, "0")}` : "";
    const building = value.usage.building ? ` 棟=${value.buildingNo}` : "";
    const lb = value.usage.lb ? ` LB=${String(value.lbNo).padStart(2, "0")}` : "";
    return `パナソニックEV ${value.command} ${value.commandLabel}${extra}${building}${room}${lb}`;
  }
  if (view === "mansion") {
    const api = requireApi("MansionController");
    const incomingRole = $("mcRole").value === api.ROLE.IC ? api.ROLE.MC : api.ROLE.IC;
    const value = (api.parseFrame || api.parseTelegram || api.parse).call(api, frame, {
      version: Number($("mcVersion").value),
      from: incomingRole,
    });
    return `MC KIND=${Number(value.kind).toString(16).toUpperCase()} CMD=${Number(value.command == null ? value.cmd : value.command).toString(16).toUpperCase()}`;
  }
  return "";
}

function inspectReceive(bytes, at) {
  const reader = currentFrameReader();
  const controls = [];
  for (const event of reader.push(bytes)) {
    if (event.type === "control") {
      controls.push(event.code);
      continue;
    }
    if (event.type === "error") {
      addLog("warn", "PARSE", event.bytes.length ? event.bytes : null, event.message);
      // フレームとして成立しなかった受信データも受信モニタへ残し、
      // 何バイト受けて何が足りなかったのかを画面で追えるようにする。
      recordReceiveError(state.currentView, event.bytes, event.message, at);
      handleCompletedInboundFrame(false);
      continue;
    }
    state.rxFrames += 1;
    updateMetrics();
    const view = state.currentView;
    // 受信モニタの記録は検証結果に依存させない。仕様違反の電文ほど
    // どの桁が想定と違うのかを確認したいので、必ず先に記録する。
    recordReceivedFrame(view, event.bytes, at);
    let valid = true;
    try {
      addLog("info", "PARSE", null, describeFrame(view, event.bytes));
    } catch (error) {
      logError(error, "受信電文検証");
      valid = false;
    }
    // 検証NGでも応答を返す機種があるため、判定結果を渡して処理は続ける。
    handleCompletedInboundFrame(valid).then((control) => handleApplicationFrame(view, event.bytes, control, valid));
  }
  // 未完のフレームが残っている間だけ受信完了タイマーを走らせる。
  if (reader.bufferedLength > 0) armReceiveTimer(state.currentView, "frame");
  return controls;
}

const keyReceiver = window.NoncontactKey ? new window.NoncontactKey.NoncontactReceiver() : null;
async function autoRespondKey(bytes) {
  if (state.currentView !== "key" || !keyReceiver || !$(`keyAutoResponse`).checked) return;
  const events = keyReceiver.push(bytes);
  for (const event of events) {
    if (event.type !== "frame") continue;
    addLog(event.accepted ? "info" : "warn", "KEY-RX", event.packet, event.error || "受信正常");
    try { await transmit([event.response], "response"); } catch (error) { logError(error, "非接触キー自動応答"); }
  }
}

function navigate(view) {
  if (state.activeTransaction && view !== state.currentView) {
    toast(`${state.activeTransaction}の通信中は画面を切り替えられません`, true);
    return;
  }
  state.currentView = view;
  resetFrameReader();
  state.inboundLink = false;
  resetLocker4Inbound();
  state.manualReceiveStage = null;
  clearReceiveTimer();
  if (keyReceiver) keyReceiver.reset();
  // 解析条件は画面の設定に依存するため、表示中の1件を現在の設定で描き直す。
  if (RECEIVE_MONITORS[view]) renderReceiveMonitor(view);
  document.querySelectorAll(".view").forEach((element) => element.classList.toggle("active", element.id === `view-${view}`));
  document.querySelectorAll(".nav-item").forEach((button) => button.classList.toggle("active", button.dataset.view === view));
  const preset = viewPreset(view);
  if (preset && !state.connected) {
    $("serialPreset").value = preset;
    applySerialPreset(preset);
  }
  // 接続中は勝手に切り替えられないので、食い違いを警告で知らせる。
  updatePresetWarning();
}

function bindPreview(buttonId, previewId, builder, multiple = false) {
  $(buttonId).addEventListener("click", () => preview(previewId, builder, multiple).catch((error) => logError(error, "プレビュー")));
}

function saveLogs() {
  if (state.logs.length === 0) return toast("保存するログがありません", true);
  const text = state.logs.map((entry) => `${formatDate(entry.at)} ${entry.time}\t${entry.label}\t${entry.bytes ? toHex(entry.bytes) : ""}\t${entry.detail}`).join("\r\n");
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const anchor = document.createElement("a");
  anchor.href = URL.createObjectURL(blob);
  anchor.download = `external-simulator-${new Date().toISOString().replace(/[:.]/g, "-")}.log.txt`;
  anchor.click();
  URL.revokeObjectURL(anchor.href);
}

function clearLogs() {
  state.logs.length = 0;
  $("communicationLog").replaceChildren();
  $("logCount").textContent = "0件";
}

// 長時間の通信試験では2000件では足りないため、保持件数を切り替えられるようにする。
function applyLogLimit() {
  const value = Number($("logLimit").value);
  state.logLimit = Number.isInteger(value) && value > 0 ? value : DEFAULT_LOG_LIMIT;
  while (state.logs.length > state.logLimit) state.logs.shift();
  const list = $("communicationLog");
  while (list.childElementCount > state.logLimit) list.firstElementChild.remove();
  $("logCount").textContent = `${state.logs.length}件`;
}

function collectProfile() {
  const values = {};
  document.querySelectorAll("input[id], select[id], textarea[id]").forEach((element) => {
    if (["serialPort", "profileImportFile", "logSearch"].includes(element.id) || element.type === "file") return;
    values[element.id] = element.type === "checkbox" ? { checked: element.checked } : { value: element.value };
  });
  return {
    format: "external-device-simulator-next-profile",
    version: 1,
    savedAt: new Date().toISOString(),
    values,
    locker4Rows: state.locker4Rows.map((row) => ({ ...row })),
    locker2Rows: state.locker2Rows.map((row) => ({ ...row })),
    panaRecords: state.panaRecords.map((row) => ({ ...row })),
  };
}

function applyProfile(profile) {
  if (!profile || profile.format !== "external-device-simulator-next-profile" || profile.version !== 1 || !profile.values) {
    throw new Error("対応していないプロファイル形式です");
  }
  const delayedCommand = profile.values.mcCommand;
  for (const [id, setting] of Object.entries(profile.values)) {
    if (id === "mcCommand") continue;
    const element = $(id);
    if (!element || !setting || typeof setting !== "object") continue;
    if (element.type === "checkbox" && typeof setting.checked === "boolean") element.checked = setting.checked;
    else if (typeof setting.value === "string") {
      if (element.tagName === "SELECT" && !Array.from(element.options).some((option) => option.value === setting.value)) continue;
      element.value = setting.value;
    }
  }
  // v1.0で保存した「ルーム5桁」は、棟番号と部屋番号へ分離して引き継ぐ。
  const legacyRoom = profile.values.keyRoom && profile.values.keyRoom.value;
  if (!profile.values.keyBuilding && typeof legacyRoom === "string" && /^\d{5}$/.test(legacyRoom)) {
    $("keyBuilding").value = legacyRoom[0];
    $("keyRoom").value = legacyRoom.slice(1);
  }
  const legacyKeyProfile = profile.values.keyProfile && profile.values.keyProfile.value;
  if (legacyKeyProfile === "general") $("keyProfile").value = "other";
  if (legacyKeyProfile === "limited8") $("keyProfile").value = "vFine";
  syncKeyForm();
  syncAlarmInfoForm();
  syncPanasonicForm();
  syncPanasonicElevatorForm();
  refreshMcCommands();
  if (delayedCommand && typeof delayedCommand.value === "string" && Array.from($("mcCommand").options).some((option) => option.value === delayedCommand.value)) {
    $("mcCommand").value = delayedCommand.value;
  }
  // ロッカー表は動的行のため、入力要素とは別に保存・復元する。
  if (Array.isArray(profile.locker4Rows) && profile.locker4Rows.length) {
    state.locker4Rows = profile.locker4Rows.map((row, index) => ({
      lockerNo: Number.isInteger(row.lockerNo) ? row.lockerNo : index + 1,
      buildingNo: Number(row.buildingNo) || 0,
      roomNo: Number(row.roomNo) || 0,
      currentState: Number(row.currentState) || 0x30,
      sendState: Number(row.sendState) || 0x30,
      selected: Boolean(row.selected),
    }));
    $("locker4Count").value = String(state.locker4Rows.length);
  }
  if (Array.isArray(profile.locker2Rows) && profile.locker2Rows.length) {
    state.locker2Rows = profile.locker2Rows.map((row, index) => ({
      no: Number.isInteger(row.no) ? row.no : index + 1,
      command: [0x11, 0x12, 0x13].includes(Number(row.command)) ? Number(row.command) : 0x11,
      buildingNo: Number(row.buildingNo) || 0,
      roomNo: Number(row.roomNo) || 0,
      selected: Boolean(row.selected),
    }));
    $("locker2Count").value = String(state.locker2Rows.length);
  }
  if (Array.isArray(profile.panaRecords)) {
    state.panaRecords = profile.panaRecords.slice(0, requireApi("PanasonicAlarm").MAX_RECORDS).map((row) => ({
      mode: row.mode === "F" ? "F" : "N",
      buildingNo: Number(row.buildingNo) || 0,
      roomNo: Number(row.roomNo) || 0,
      alarmNo: Number(row.alarmNo) || 0,
      selected: Boolean(row.selected),
    }));
    renderPanasonicRecords();
  }
  renderLocker4Table();
  renderLocker2Table();
}

function saveProfile() {
  localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(collectProfile()));
  toast("現在の設定を保存しました");
}

function exportProfile() {
  const blob = new Blob([JSON.stringify(collectProfile(), null, 2)], { type: "application/json;charset=utf-8" });
  const anchor = document.createElement("a");
  anchor.href = URL.createObjectURL(blob);
  anchor.download = `external-simulator-profile-${new Date().toISOString().slice(0, 10)}.json`;
  anchor.click();
  URL.revokeObjectURL(anchor.href);
}

async function importProfile(file) {
  if (!file || file.size > 1_000_000) throw new Error("プロファイルは1MB以下のJSONを指定してください");
  const profile = JSON.parse(await file.text());
  applyProfile(profile);
  localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(profile));
  toast("プロファイルを読み込みました");
}

function loadSavedProfile() {
  const source = localStorage.getItem(PROFILE_STORAGE_KEY);
  if (!source) return false;
  try {
    applyProfile(JSON.parse(source));
    return true;
  } catch (error) {
    localStorage.removeItem(PROFILE_STORAGE_KEY);
    logError(error, "保存プロファイル読込");
    return false;
  }
}

function bindEvents() {
  document.querySelectorAll(".nav-item").forEach((button) => button.addEventListener("click", () => navigate(button.dataset.view)));
  $("refreshPorts").addEventListener("click", refreshPorts);
  $("connectButton").addEventListener("click", connect);
  $("disconnectButton").addEventListener("click", disconnect);
  $("serialPreset").addEventListener("change", (event) => applySerialPreset(event.target.value));
  ["mcVersion", "mcRole", "mcKind"].forEach((id) => $(id).addEventListener("change", refreshMcCommands));
  ["mcCommand", "mcUseSchema", "mcAddressType"].forEach((id) => $(id).addEventListener("change", renderMcPayload));
  $("mcAlarmBits").addEventListener("change", updateMcAlarmSummary);
  $("mcAlarmClear").addEventListener("click", () => {
    mcAlarmCheckboxes().forEach((box) => { box.checked = false; });
    updateMcAlarmSummary();
  });
  ["keyFormat", "keyProfile"].forEach((id) => $(id).addEventListener("change", syncKeyForm));
  $("elevatorCommand").addEventListener("change", () => {
    const api = requireApi("ElevatorProtocol");
    const directions = api.COMMAND_META[$("elevatorCommand").value].directions;
    if (directions.length === 1) $("elevatorDirection").value = directions[0];
  });
  $("alarmRole").addEventListener("change", () => {
    $("alarmType").value = $("alarmRole").value === "intercom" ? "00" : "30";
    syncAlarmInfoForm();
  });
  ["alarmType", "alarmBitPattern"].forEach((id) => $(id).addEventListener("change", () => syncAlarmInfoForm()));
  $("alarmInfo").addEventListener("input", () => syncAlarmInfoForm());
  $("alarmInfoBits").addEventListener("change", () => syncAlarmInfoForm("bits"));
  $("alarmInfoClearButton").addEventListener("click", () => {
    $("alarmInfo").value = "00";
    syncAlarmInfoForm();
  });
  $("saveLog").addEventListener("click", saveLogs);
  $("clearLog").addEventListener("click", clearLogs);
  document.querySelectorAll(".log-filters button").forEach((button) => button.addEventListener("click", () => {
    state.filter = button.dataset.filter;
    document.querySelectorAll(".log-filters button").forEach((item) => item.classList.toggle("active", item === button));
    refreshLogFilter();
  }));
  $("logSearch").addEventListener("input", () => {
    state.search = $("logSearch").value.trim().toLowerCase();
    refreshLogFilter();
  });
  $("logLimit").addEventListener("change", applyLogLimit);

  bindPreview("terminalPreviewButton", "terminalPreview", terminalFrame);
  bindPreview("locker2PreviewButton", "locker2Preview", buildLocker2Frames, true);
  bindPreview("locker4PreviewButton", "locker4Preview", buildLocker4Packets, true);
  bindPreview("keyPreviewButton", "keyPreview", buildKeyFrame);
  bindPreview("mcPreviewButton", "mcPreview", buildMcFrame);
  bindPreview("elevatorPreviewButton", "elevatorPreview", buildElevatorFrame);
  bindPreview("alarmPreviewButton", "alarmPreview", buildAlarmFrame);

  $("terminalSendButton").addEventListener("click", () => withTransaction("汎用送信", async () => transmit(await preview("terminalPreview", terminalFrame), "frame")).catch((error) => logError(error, "送信")));
  document.querySelectorAll(".control-byte").forEach((button) => button.addEventListener("click", () => sendControlByte(Number(button.dataset.byte)).catch((error) => logError(error, "制御コード送信"))));
  $("locker2Count").addEventListener("change", () => { try { applyLocker2Count(); } catch (error) { logError(error, "登録行数"); } });
  $("locker2Filter").addEventListener("change", renderLocker2Table);
  $("locker2Profile").addEventListener("change", renderLocker2Table);
  $("locker2BulkApply").addEventListener("click", () => { try { applyLocker2Bulk(); } catch (error) { logError(error, "番号設定"); } });
  $("locker2SwitchApply").addEventListener("click", () => { try { applyLocker2Switch(); } catch (error) { logError(error, "状態の一括変更"); } });
  $("locker2BulkReset").addEventListener("click", resetLocker2Rows);
  $("locker2SelectVisible").addEventListener("click", () => setLocker2Selection(true));
  $("locker2ClearSelection").addEventListener("click", () => setLocker2Selection(false));
  $("locker2SendButton").addEventListener("click", () => withTransaction("2線式", sendLocker2).catch((error) => logError(error, "2線式送信")));
  $("locker2StopButton").addEventListener("click", () => { if (state.locker2Run) state.locker2Run.cancelled = true; });
  $("locker4Count").addEventListener("change", () => { try { applyLocker4Count(); } catch (error) { logError(error, "ロッカー数"); } });
  $("locker4Filter").addEventListener("change", renderLocker4Table);
  $("locker4Profile").addEventListener("change", renderLocker4Table);
  $("locker4BulkApply").addEventListener("click", () => { try { applyLocker4Bulk(); } catch (error) { logError(error, "部屋番号設定"); } });
  $("locker4BulkReset").addEventListener("click", resetLocker4Rooms);
  $("locker4SelectVisible").addEventListener("click", () => setLocker4Selection(true));
  $("locker4ClearSelection").addEventListener("click", () => setLocker4Selection(false));
  $("locker4SendButton").addEventListener("click", async () => {
    try { await withTransaction("4線式", async () => {
      const sending = $("locker4Action").value === "response" ? locker4SelectedRows() : [];
      const packets = await preview("locker4Preview", buildLocker4Packets, true);
      let delivered = true;
      if ($("locker4Transport").value === "direct") { for (const frame of packets) await transmit(frame, "frame"); }
      else {
        const outcome = await runHandshake(packets, { sendEot: true, textRetryMode: "restart", linkTimeoutMs: $("locker4Action").value === "request" ? 3000 : 5000, textTimeoutMs: 5000, priority: $("locker4Action").value === "request" });
        delivered = outcome.type === "complete";
      }
      if (delivered && sending.length) commitLocker4Send(sending);
    }); } catch (error) { logError(error, "4線式送信"); }
  });
  $("keySendButton").addEventListener("click", () => withTransaction("非接触キー", sendKey).catch((error) => logError(error, "非接触キー送信")));
  $("mcSendButton").addEventListener("click", async () => {
    try { await withTransaction("マンションコントローラ", async () => {
      const frame = await preview("mcPreview", buildMcFrame);
      if ($("mcTransport").value === "direct") await transmit(frame, "frame");
      else await runHandshake([frame], { sendEot: false, textRetryMode: "sameText", priority: $("mcRole").value === "IC", idleBeforeEnqMs: $("mcRole").value === "IC" ? 50 : 0 });
    }); } catch (error) { logError(error, "MC送信"); }
  });
  $("elevatorSendButton").addEventListener("click", async () => {
    try { await withTransaction("エレベータ", async () => {
      const frame = await preview("elevatorPreview", buildElevatorFrame);
      if ($("elevatorTransport").value === "direct") await transmit(frame, "frame");
      else await runHandshake([frame], { sendEot: false, textRetryMode: "sameText", priority: $("elevatorDirection").value === requireApi("ElevatorProtocol").DIRECTION.TO_ELEVATOR });
    }); } catch (error) { logError(error, "EV送信"); }
  });
  $("alarmSendButton").addEventListener("click", async () => {
    try { await withTransaction("警報（アイホン）", async () => {
      const frame = await preview("alarmPreview", buildAlarmFrame);
      if ($("alarmTransport").value === "direct") await transmit(frame, "frame");
      else await runHandshake([frame], { sendEot: false, textRetryMode: "sameText", maxRetries: 255, priority: $("alarmRole").value === "intercom" });
      const parsed = requireApi("AlarmProtocol").parseFrame(frame);
      if ($("alarmAutoRecord").checked && parsed.historyNumber === 0 && [0x00, 0x01].includes(parsed.type)) recordAlarmHistory(frame);
    }); } catch (error) { logError(error, "警報送信"); }
  });
  $("alarmRecordButton").addEventListener("click", () => { try { recordAlarmHistory(); } catch (error) { logError(error, "履歴記録"); } });
  $("alarmNextButton").addEventListener("click", () => { try { prepareNextAlarmHistory(); } catch (error) { logError(error, "履歴準備"); } });
  $("alarmHistorySendButton").addEventListener("click", () => withTransaction("警報履歴応答", sendNextAlarmHistory).catch((error) => logError(error, "履歴応答送信")));
  $("alarmClearButton").addEventListener("click", () => {
    state.alarmHistory.clear();
    state.alarmHistoryPending = null;
    updateAlarmHistoryStatus("消去しました");
  });

  // 警報（パナソニック）
  $("panaProtocol").addEventListener("change", () => { try { syncPanasonicForm(); } catch (error) { logError(error, "プロトコル切替"); } });
  $("panaRole").addEventListener("change", () => {
    // 動作側を変えると送れる電文が入れ替わるため、既定の発信種別も合わせる。
    if (panasonicIsBlock()) {
      const requestType = panasonicApi().blockTypes(panasonicProtocol()).find((entry) => entry.request);
      if ($("panaRole").value === "peer" && requestType) $("panaType").value = panasonicHexByte(requestType.code);
      if ($("panaRole").value === "ifu") $("panaType").value = "00";
      syncPanasonicInfoForm();
    }
  });
  $("panaType").addEventListener("change", () => syncPanasonicInfoForm());
  $("panaInfo").addEventListener("input", () => syncPanasonicInfoForm());
  $("panaInfoBits").addEventListener("change", () => syncPanasonicInfoForm("bits"));
  $("panaInfoClearButton").addEventListener("click", () => {
    $("panaInfo").value = "00";
    syncPanasonicInfoForm();
  });
  $("panaRecordAdd").addEventListener("click", () => { try { addPanasonicRecord(); } catch (error) { logError(error, "レコード追加"); } });
  $("panaRecordRemove").addEventListener("click", () => {
    const remaining = state.panaRecords.filter((record) => !record.selected);
    if (remaining.length === state.panaRecords.length) { toast("削除するレコードを選択してください", true); return; }
    state.panaRecords = remaining;
    renderPanasonicRecords();
  });
  $("panaRecordClear").addEventListener("click", () => { state.panaRecords = []; renderPanasonicRecords(); });
  $("panaRecordSelectAll").addEventListener("change", () => {
    const checked = $("panaRecordSelectAll").checked;
    state.panaRecords.forEach((record) => { record.selected = checked; });
    renderPanasonicRecords();
  });
  $("panaPreviewButton").addEventListener("click", () => { try { previewPanasonic(); } catch (error) { logError(error, "プレビュー"); } });
  $("panaSendButton").addEventListener("click", () => {
    withTransaction("警報（パナソニック）", sendPanasonic).catch((error) => logError(error, "パナソニック送信"));
  });
  $("panaRecordHistoryButton").addEventListener("click", () => { try { recordPanasonicHistory(); } catch (error) { logError(error, "ヒストリー記録"); } });
  $("panaNextButton").addEventListener("click", () => { try { prepareNextPanasonicHistory(); } catch (error) { logError(error, "ヒストリー準備"); } });
  $("panaHistorySendButton").addEventListener("click", () => {
    withTransaction("パナソニックヒストリー応答", () => sendNextPanasonicHistory()).catch((error) => logError(error, "ヒストリー応答送信"));
  });
  $("panaHistoryClearButton").addEventListener("click", () => {
    try { requirePanasonicHistory().reset(); } catch (error) { logError(error, "ヒストリー消去"); return; }
    state.panaHistoryPending = null;
    updatePanasonicHistoryStatus("消去しました");
  });
  $("panaScheduledButton").addEventListener("click", () => {
    withTransaction("定時送信", async () => {
      const frame = panasonicApi().buildScheduledFrame({ protocol: panasonicProtocol(), propertyCode: $("panaProperty").value });
      $("panaPreview").textContent = panasonicPreviewText(frame);
      await sendPanasonicRecord(frame, "定時送信");
    }).catch((error) => logError(error, "定時送信"));
  });
  $("panaAckButton").addEventListener("click", () => {
    withTransaction("アンサーバック", async () => {
      const frame = panasonicApi().buildAnswerback({ protocol: panasonicProtocol(), accepted: true });
      await transmit(frame, "response");
      addLog("info", "PANA", frame, "アンサーバックACKを手動送信");
    }).catch((error) => logError(error, "アンサーバック送信"));
  });
  $("panaNakButton").addEventListener("click", () => {
    withTransaction("アンサーバック", async () => {
      const frame = panasonicApi().buildAnswerback({ protocol: panasonicProtocol(), accepted: false });
      await transmit(frame, "response");
      addLog("warn", "PANA", frame, "アンサーバックNAKを手動送信");
    }).catch((error) => logError(error, "アンサーバック送信"));
  });

  // エレベータ連動（パナソニック）
  $("pevDirection").addEventListener("change", () => { try { syncPanasonicElevatorForm(); } catch (error) { logError(error, "動作側の切替"); } });
  $("pevCommand").addEventListener("change", () => { try { syncPanasonicElevatorForm(); } catch (error) { logError(error, "コマンド切替"); } });
  $("pevExtra").addEventListener("change", () => { try { syncPanasonicElevatorForm(); } catch (error) { logError(error, "付加コード切替"); } });
  $("pevExtraFree").addEventListener("input", () => { try { syncPanasonicElevatorForm(); } catch (error) { logError(error, "付加コード入力"); } });
  $("pevPreviewButton").addEventListener("click", () => { try { previewPanasonicElevator(); } catch (error) { logError(error, "プレビュー"); } });
  $("pevSendButton").addEventListener("click", () => {
    withTransaction("エレベータ（パナソニック）", sendPanasonicElevator).catch((error) => logError(error, "パナソニックEV送信"));
  });
  $("pevHealthButton").addEventListener("click", () => {
    withTransaction("ヘルスチェック", async () => {
      const api = panasonicElevatorApi();
      if (panasonicElevatorDirection() !== api.DIRECTION.TO_ELEVATOR) throw new Error("ヘルスチェックはﾊﾟﾅｿﾆｯｸIFU側から送信します");
      const frame = api.healthRequest();
      $("pevPreview").textContent = toHex(frame);
      await sendPanasonicElevatorFrame(frame);
    }).catch((error) => logError(error, "ヘルスチェック送信"));
  });
  $("pevAckButton").addEventListener("click", () => {
    withTransaction("ACK送出", async () => {
      const code = panasonicElevatorAckCode();
      await transmit([code], "response");
      addLog("info", "PEV", [code], `ACK(${code.toString(16).toUpperCase().padStart(2, "0")}H)を手動送出`);
    }).catch((error) => logError(error, "ACK送出"));
  });
  $("pevEotButton").addEventListener("click", () => {
    withTransaction("EOT送出", async () => {
      const code = panasonicElevatorApi().CODE.EOT;
      await transmit([code], "eot");
      addLog("info", "PEV", [code], "EOTを手動送出");
    }).catch((error) => logError(error, "EOT送出"));
  });

  // 受信モニタ：反映・消去は機種ごとに同じ操作体系でそろえる。
  for (const [view, config] of Object.entries(RECEIVE_MONITORS)) {
    $(`${config.prefix}Apply`).addEventListener("click", () => {
      try { applyReceiveMonitor(view); } catch (error) { logError(error, "受信内容の反映"); }
    });
    $(`${config.prefix}Clear`).addEventListener("click", () => clearReceiveMonitor(view));
  }
  $("locker2InboxApply").addEventListener("click", () => {
    try { applyLocker2Inbox(); } catch (error) { logError(error, "住戸別の受信状況の反映"); }
  });
  // 解析条件を変える設定は、表示中の受信電文にも即座に反映する。
  $("locker4Action").addEventListener("change", () => renderReceiveMonitor("locker4"));
  $("locker2Profile").addEventListener("change", () => renderReceiveMonitor("locker2"));
  ["keyFormat", "keyProfile"].forEach((id) => $(id).addEventListener("change", () => renderReceiveMonitor("key")));

  $("faultReset").addEventListener("click", () => { state.faultPlan = null; state.faultSignature = ""; toast("異常注入の適用回数をリセットしました"); });
  $("applySignals").addEventListener("click", async () => { try { $("signalState").textContent = JSON.stringify(await window.serialAPI.setSignals({ dtr: $("signalDtr").checked, rts: $("signalRts").checked })); } catch (error) { logError(error, "信号線設定"); } });
  $("readSignals").addEventListener("click", async () => { try { $("signalState").textContent = JSON.stringify(await window.serialAPI.getSignals()); } catch (error) { logError(error, "信号線取得"); } });
  $("flushSerial").addEventListener("click", async () => { try { await window.serialAPI.flush(); addLog("warn", "FLUSH", null, "入出力バッファを破棄"); } catch (error) { logError(error, "バッファ破棄"); } });
  $("copyVersionButton").addEventListener("click", async () => {
    if (!state.appInfo) { toast("バージョン情報をまだ取得できていません", true); return; }
    try {
      await navigator.clipboard.writeText(versionSummary(state.appInfo));
      toast("バージョン情報をコピーしました");
    } catch (error) {
      logError(error, "バージョン情報のコピー");
    }
  });
  $("saveProfile").addEventListener("click", saveProfile);
  $("exportProfile").addEventListener("click", exportProfile);
  $("importProfile").addEventListener("click", () => $("profileImportFile").click());
  $("profileImportFile").addEventListener("change", (event) => {
    importProfile(event.target.files[0]).catch((error) => logError(error, "プロファイル読込"));
    event.target.value = "";
  });
  $("resetProfile").addEventListener("click", () => {
    localStorage.removeItem(PROFILE_STORAGE_KEY);
    toast("保存設定を削除しました。次回起動時は初期値になります");
  });
}

async function initialize() {
  state.locker4Rows = createLocker4Rows(DEFAULT_LOCKER_COUNT);
  state.locker2Rows = createLocker2Rows(DEFAULT_LOCKER2_COUNT);
  bindEvents();
  // 版の表示はシリアル初期化を待たせない。取得できなくても起動は続ける。
  await applyAppVersion().catch((error) => logError(error, "バージョン取得"));
  const profileLoaded = loadSavedProfile();
  if (!profileLoaded) syncKeyForm();
  applyLogLimit();
  renderLocker4Table();
  renderLocker2Table();
  for (const view of Object.keys(RECEIVE_MONITORS)) renderReceiveMonitor(view);
  syncAlarmInfoForm();
  syncPanasonicForm();
  syncPanasonicElevatorForm();
  refreshMcCommands();
  state.alarmHistory = new (requireApi("AlarmProtocol").AlarmHistory)();
  state.locker4Series = new (requireApi("Locker4Receiver").PacketSeries)();
  updateAlarmHistoryStatus();
  if (!window.serialAPI) {
    applyConnectionState({ status: "error", error: "serialAPI unavailable" });
    return logError(new Error("ElectronのserialAPIを利用できません"), "初期化");
  }
  window.serialAPI.onStatus(applyConnectionState);
  window.serialAPI.onWrite((event) => {
    state.txCount += 1;
    updateMetrics();
    addLog("tx", "TX", event.bytes, `session=${event.sessionId} seq=${event.sequence}`, event.timestamp);
  });
  window.serialAPI.onData((bytes, event) => {
    state.lastIoAt = Number.isFinite(event.timestamp) ? event.timestamp : Date.now();
    state.rxCount += 1;
    updateMetrics();
    addLog("rx", "RX", bytes, `session=${event.sessionId} seq=${event.sequence}`, event.timestamp);
    const controls = inspectReceive(bytes, event.timestamp);
    for (const control of controls) {
      const packet = [control];
      const consumed = dispatchControl(packet);
      handleInboundControl(packet, consumed);
    }
    autoRespondKey(bytes);
  });
  window.serialAPI.onError((message) => logError(new Error(message), "シリアル"));
  applyConnectionState(await window.serialAPI.status());
  if (!profileLoaded) {
    $("serialPreset").value = "locker";
    applySerialPreset("locker");
  }
  await refreshPorts();
  updateMetrics();
  addLog("info", "READY", null, state.appInfo
    ? `${versionSummary(state.appInfo)} を初期化しました`
    : "外部疑似装置 Next を初期化しました");
}

initialize().catch((error) => logError(error, "初期化"));
