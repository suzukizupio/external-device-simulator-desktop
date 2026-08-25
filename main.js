"use strict";

const { app, BrowserWindow, Menu, dialog, ipcMain } = require("electron");
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");
const { SerialPort } = require("serialport");
const { SerialSession } = require("./lib/serial-session");

let mainWindow = null;
const smokeMode = process.env.EXTERNAL_SIMULATOR_SMOKE_TEST === "1";
const rendererUrl = pathToFileURL(path.join(__dirname, "index.html")).href;
const appIcon = path.join(__dirname, "build", "icon.png");
let quitAfterSerialClose = false;

const serialSession = new SerialSession({
  SerialPortCtor: SerialPort,
  listPorts: () => SerialPort.list(),
});

function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

// 配布EXEがどの版かを画面から特定できるようにする。build-stamp.json は
// tools/build-stamp.js がビルド時に生成するため、開発実行では存在しない。
function readBuildStamp() {
  try {
    const stamp = JSON.parse(fs.readFileSync(path.join(__dirname, "build-stamp.json"), "utf8"));
    return {
      builtAt: typeof stamp.builtAt === "string" ? stamp.builtAt : null,
      commit: typeof stamp.commit === "string" ? stamp.commit : null,
    };
  } catch (_error) {
    return { builtAt: null, commit: null };
  }
}

function appInfo() {
  const stamp = readBuildStamp();
  return {
    name: app.getName(),
    version: app.getVersion(),
    packaged: app.isPackaged,
    builtAt: stamp.builtAt,
    commit: stamp.commit,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: `${process.platform}-${process.arch}`,
  };
}

// 試験中の誤操作で通信ログを失わないよう、リロード系のキーを無効化する。
function blockReloadKeys(webContents) {
  webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") return;
    const key = String(input.key || "").toLowerCase();
    if (key === "f5" || ((input.control || input.meta) && key === "r")) event.preventDefault();
  });
}

// 接続したままの終了は試験の中断を意味するため、明示的に確認する。
function confirmCloseWhileConnected(event) {
  if (smokeMode || quitAfterSerialClose) return;
  if (serialSession.status !== "open") return;
  const choice = dialog.showMessageBoxSync(mainWindow, {
    type: "warning",
    buttons: ["終了する", "キャンセル"],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
    title: "外部疑似装置 Next",
    message: "COMポートへ接続したままです。終了してよろしいですか。",
    detail: "終了すると画面上の通信ログは失われます。保存する場合はキャンセルしてください。",
  });
  if (choice !== 0) event.preventDefault();
}

function createWindow() {
  mainWindow = new BrowserWindow({
    show: !smokeMode,
    width: 1440,
    height: 920,
    minWidth: 1080,
    minHeight: 720,
    backgroundColor: "#0b1020",
    icon: appIcon,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.setMenuBarVisibility(false);
  blockReloadKeys(mainWindow.webContents);
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (url !== rendererUrl) event.preventDefault();
  });
  mainWindow.loadFile("index.html");
  mainWindow.webContents.on("did-fail-load", (_event, code, description) => {
    if (!smokeMode || code === -3) return;
    console.error(`electron-smoke: load failed (${code}) ${description}`);
    app.exit(1);
  });
  mainWindow.webContents.on("did-finish-load", () => {
    sendToRenderer("serial:status", serialSession.snapshot());
    if (!smokeMode) return;
    // スモーク検査は配布物に含めない test/ 配下へ分離している。
    require("./test/smoke-probe").run({ window: mainWindow, app, sendToRenderer });
  });
  mainWindow.on("close", confirmCloseWhileConnected);
  mainWindow.on("closed", () => { mainWindow = null; });
}

serialSession.on("status", (state) => sendToRenderer("serial:status", state));
serialSession.on("data", (event) => sendToRenderer("serial:data", event));
serialSession.on("write", (event) => sendToRenderer("serial:tx", event));
serialSession.on("serial-error", (event) => sendToRenderer("serial:error", event));

function registerTrustedHandler(channel, handler) {
  ipcMain.handle(channel, (event, ...args) => {
    const trusted = mainWindow && !mainWindow.isDestroyed() &&
      event.sender === mainWindow.webContents &&
      event.senderFrame === mainWindow.webContents.mainFrame &&
      event.senderFrame.url === rendererUrl;
    if (!trusted) throw new Error("untrusted IPC sender");
    return handler(...args);
  });
}

registerTrustedHandler("app:info", () => appInfo());
registerTrustedHandler("serial:list", () => serialSession.list());
registerTrustedHandler("serial:status", () => serialSession.snapshot());
registerTrustedHandler("serial:open", (options) => serialSession.open(options));
registerTrustedHandler("serial:write", (payload) => {
  const bytes = payload && !Array.isArray(payload) && payload.bytes ? payload.bytes : payload;
  return serialSession.write(bytes);
});
registerTrustedHandler("serial:close", () => serialSession.close());
registerTrustedHandler("serial:signals:get", () => serialSession.getSignals());
registerTrustedHandler("serial:signals:set", (signals) => serialSession.setSignals(signals));
registerTrustedHandler("serial:flush", () => serialSession.flush());

// 既定メニューを外すと Ctrl+R / Ctrl+Shift+R のアクセラレータも無効になる。
Menu.setApplicationMenu(null);
app.setAppUserModelId("jp.aiphone.external-device-simulator.next");

app.whenReady().then(createWindow);
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
app.on("before-quit", (event) => {
  if (quitAfterSerialClose) return;
  event.preventDefault();
  quitAfterSerialClose = true;
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error("serial close timed out")), 5_000));
  Promise.race([serialSession.close(), timeout])
    .catch((error) => console.error(`serial close on quit: ${error && error.message || error}`))
    .finally(() => app.exit(0));
});
