"use strict";

const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const { pathToFileURL } = require("url");
const { SerialPort } = require("serialport");
const { SerialSession } = require("./lib/serial-session");

let mainWindow = null;
const smokeMode = process.env.EXTERNAL_SIMULATOR_SMOKE_TEST === "1";
const rendererUrl = pathToFileURL(path.join(__dirname, "index.html")).href;
let quitAfterSerialClose = false;

const serialSession = new SerialSession({
  SerialPortCtor: SerialPort,
  listPorts: () => SerialPort.list(),
});

function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    show: !smokeMode,
    width: 1440,
    height: 920,
    minWidth: 1080,
    minHeight: 720,
    backgroundColor: "#0b1020",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.setMenuBarVisibility(false);
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
  mainWindow.webContents.on("did-finish-load", async () => {
    sendToRenderer("serial:status", serialSession.snapshot());
    if (!smokeMode) return;
    try {
      const initial = await mainWindow.webContents.executeJavaScript(`
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
          modules: ["serialAPI", "Telegram2", "Telegram4", "Locker4Receiver", "NoncontactKey", "MansionController", "StreamDecoder", "ElevatorProtocol", "AlarmProtocol", "HandshakeProtocol", "FaultEngine"]
            .filter((name) => !window[name])
          }), 50);
        }, 750))
      `);
      if (initial.title !== "外部疑似装置 Next" || initial.views !== 10 || initial.modules.length || initial.previewErrors.length || !initial.ready) {
        throw new Error(`unexpected renderer state: ${JSON.stringify(initial)}`);
      }
      await mainWindow.webContents.executeJavaScript(`document.querySelector('[data-view="mansion"]').click()`);
      const MansionController = require("./protocol/mansion-controller");
      const frame = MansionController.buildHealthCheckRequest({ version: 3, from: MansionController.ROLE.IC });
      sendToRenderer("serial:data", { sessionId: 999, sequence: 1, timestamp: Date.now(), bytes: [0x06, ...frame.slice(0, 3)] });
      sendToRenderer("serial:data", { sessionId: 999, sequence: 2, timestamp: Date.now(), bytes: [...frame.slice(3), 0x04] });
      const receiver = await mainWindow.webContents.executeJavaScript(`new Promise((resolve) => setTimeout(() => resolve({ parsed: document.getElementById("communicationLog").textContent.includes("MC KIND=3A CMD=41") }), 100))`);
      if (!receiver.parsed) throw new Error(`renderer stream path failed: ${JSON.stringify(receiver)}`);
      const result = { ...initial, streamParsed: receiver.parsed };
      console.log(`electron-smoke: OK ${JSON.stringify(result)}`);
      app.quit();
    } catch (error) {
      console.error(`electron-smoke: ${error && error.stack || error}`);
      app.exit(1);
    }
  });
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
