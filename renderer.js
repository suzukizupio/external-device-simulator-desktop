"use strict";

const $ = (id) => document.getElementById(id);
const CONTROL_NAMES = Object.freeze({ 0x02: "STX", 0x03: "ETX", 0x04: "EOT", 0x05: "ENQ", 0x06: "ACK", 0x15: "NAK" });
const DEFAULT_LOG_LIMIT = 20000;
const PROFILE_STORAGE_KEY = "external-device-simulator-next.profile.v1";

const state = {
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
  activeTransaction: null,
  lastIoAt: 0,
  manualReceiveStage: null,
  pendingFrameValid: null,
  locker4Inbound: null,
  locker4Series: null,
  locker4Rows: [],
  locker2Rows: [],
};

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

function requireApi(name) {
  const api = window[name];
  if (!api) throw new Error(`${name} のプロトコルモジュールを読み込めません`);
  return api;
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
});

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
  if (!state.connected) {
    rejectControlWaiters(new Error("シリアル接続が切断されました"));
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
  return ["locker4", "mansion", "elevator", "alarm"].includes(view);
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
  const control = mode === "ack" ? 0x06 : mode === "nak" ? 0x15 : (valid ? 0x06 : 0x15);
  await transmit([control], "response");
  addLog(control === 0x06 ? "info" : "warn", "AUTO", [control], `${stage}へ${CONTROL_NAMES[control]}`);
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
  if (bytes[0] !== 0x05) return;
  state.inboundLink = false;
  if ($("autoTransportResponse").value === "manual") {
    state.manualReceiveStage = "link-response";
    setSequence("ENQへ手動ACK/NAK待ち");
    return;
  }
  sendAutomaticResponse(true, "ENQ").then((control) => {
    state.inboundLink = control === 0x06;
    if (control === 0x06) {
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
      setSequence(control === 0x06 ? "受信完了" : control === 0x15 ? "受信異常" : "応答なし");
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
  return normalized.map((entry) => api.buildTelegram(entry));
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

function buildKeyFrame() {
  const api = requireApi("NoncontactKey");
  const personMax = $("keyProfile").value === "limited8" ? 8 : 999;
  const options = {
    format: $("keyFormat").value,
    gateNo: integerValue("keyGate", "ゲートNo", 1, 99),
    roomNo5: $("keyRoom").value.trim(),
    personMax,
  };
  if (options.format === api.FORMAT.WITH_PERSON) options.personNo = integerValue("keyPerson", "個人番号", 0, personMax);
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

function handleApplicationFrame(view, frame, transportResponse) {
  if (transportResponse !== 0x06) return;
  try {
    if (view === "alarm") handleAlarmRequest(frame);
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

function buildMcFrame() {
  const api = requireApi("MansionController");
  const address = mcAddressHelper(api);
  const messageText = `${address}${$("mcMessage").value}`;
  const kind = parseHexByte($("mcKind").value, "KIND");
  const command = parseHexByte($("mcCommand").value, "CMD");
  const topology = mcTopology(api);
  const options = {
    kind,
    command,
    cmd: command,
    message: latin1(messageText, "MESG"),
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
function currentFrameReader() {
  if (!state.frameReader || state.frameReaderView !== state.currentView) {
    const Reader = requireApi("FrameReader");
    // KIND/CMDの方向・Version検証は describeFrame 側で行うため、ここでは長さとBCCだけを見る。
    state.frameReader = new Reader(state.currentView, { validateCommand: false });
    state.frameReaderView = state.currentView;
  }
  return state.frameReader;
}

function resetFrameReader() {
  if (state.frameReader) state.frameReader.reset();
}

function trackLocker4Packet(value) {
  state.locker4Inbound = state.locker4Series.accept(value);
}

function describeFrame(view, frame) {
  if (view === "locker2") {
    const api = requireApi("Telegram2");
    const value = api.parseTelegram(frame);
    const patmo = $("locker2Profile").value === "patmo";
    api.validateRegistrationList([value], {
      maxEntries: patmo ? 40 : 100,
      allowedBuildingNos: patmo ? [0, 1] : [0, 1, 2, 3, 4, 5, 6, 7, 8],
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
    return `警報 ${value.typeName} info=${value.info.toString(16).padStart(2, "0")} source=${value.source.kind}`;
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

function inspectReceive(bytes) {
  const reader = currentFrameReader();
  const controls = [];
  for (const event of reader.push(bytes)) {
    if (event.type === "control") {
      controls.push(event.code);
      continue;
    }
    if (event.type === "error") {
      addLog("warn", "PARSE", event.bytes.length ? event.bytes : null, event.message);
      handleCompletedInboundFrame(false);
      continue;
    }
    state.rxFrames += 1;
    updateMetrics();
    const view = state.currentView;
    try {
      addLog("info", "PARSE", null, describeFrame(view, event.bytes));
      handleCompletedInboundFrame(true).then((control) => handleApplicationFrame(view, event.bytes, control));
    } catch (error) {
      logError(error, "受信電文検証");
      handleCompletedInboundFrame(false);
    }
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
  document.querySelectorAll(".view").forEach((element) => element.classList.toggle("active", element.id === `view-${view}`));
  document.querySelectorAll(".nav-item").forEach((button) => button.classList.toggle("active", button.dataset.view === view));
  const preset = ["locker2", "locker4", "mansion"].includes(view) ? "locker" : view === "key" ? "key" : view === "elevator" ? "elevator" : view === "alarm" ? "alarm" : null;
  if (preset && !state.connected) {
    $("serialPreset").value = preset;
    applySerialPreset(preset);
  }
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
  $("elevatorCommand").addEventListener("change", () => {
    const api = requireApi("ElevatorProtocol");
    const directions = api.COMMAND_META[$("elevatorCommand").value].directions;
    if (directions.length === 1) $("elevatorDirection").value = directions[0];
  });
  $("alarmRole").addEventListener("change", () => {
    $("alarmType").value = $("alarmRole").value === "intercom" ? "00" : "30";
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
    try { await withTransaction("警報発信装置", async () => {
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

  $("faultReset").addEventListener("click", () => { state.faultPlan = null; state.faultSignature = ""; toast("異常注入の適用回数をリセットしました"); });
  $("applySignals").addEventListener("click", async () => { try { $("signalState").textContent = JSON.stringify(await window.serialAPI.setSignals({ dtr: $("signalDtr").checked, rts: $("signalRts").checked })); } catch (error) { logError(error, "信号線設定"); } });
  $("readSignals").addEventListener("click", async () => { try { $("signalState").textContent = JSON.stringify(await window.serialAPI.getSignals()); } catch (error) { logError(error, "信号線取得"); } });
  $("flushSerial").addEventListener("click", async () => { try { await window.serialAPI.flush(); addLog("warn", "FLUSH", null, "入出力バッファを破棄"); } catch (error) { logError(error, "バッファ破棄"); } });
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
  const profileLoaded = loadSavedProfile();
  applyLogLimit();
  renderLocker4Table();
  renderLocker2Table();
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
    const controls = inspectReceive(bytes);
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
  addLog("info", "READY", null, "外部疑似装置 Next を初期化しました");
}

initialize().catch((error) => logError(error, "初期化"));
