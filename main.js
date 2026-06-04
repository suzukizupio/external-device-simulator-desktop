// メインプロセス: ウィンドウ生成 + シリアル通信(node-serialport)をIPCで仲介
const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const { SerialPort } = require("serialport");

let win = null;
let port = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1140,
    height: 840,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.setMenuBarVisibility(false);
  win.loadFile("index.html");
}

app.whenReady().then(createWindow);
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

function sendToRenderer(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

// ===== シリアル通信 IPC =====

// ポート一覧
ipcMain.handle("serial:list", async () => {
  const ports = await SerialPort.list();
  return ports.map(p => ({
    path: p.path,
    manufacturer: p.manufacturer || "",
    friendlyName: p.friendlyName || "",
  }));
});

// オープン
ipcMain.handle("serial:open", async (_e, opts) => {
  if (port && port.isOpen) {
    await new Promise(res => port.close(() => res()));
  }
  return await new Promise((resolve, reject) => {
    port = new SerialPort({
      path: opts.path,
      baudRate: opts.baudRate,
      dataBits: opts.dataBits,
      stopBits: opts.stopBits,
      parity: opts.parity,
      rtscts: opts.flowControl === "hardware",
      autoOpen: true,
    }, (err) => {
      if (err) { reject(err); return; }
      resolve(true);
    });
    port.on("data", (chunk) => sendToRenderer("serial:data", Array.from(chunk)));
    port.on("error", (err) => sendToRenderer("serial:error", String(err && err.message || err)));
    port.on("close", () => sendToRenderer("serial:closed"));
  });
});

// 送信(バイト配列)
ipcMain.handle("serial:write", async (_e, dataArray) => {
  return await new Promise((resolve, reject) => {
    if (!port || !port.isOpen) { reject(new Error("ポートが開いていません")); return; }
    port.write(Buffer.from(dataArray), (err) => {
      if (err) { reject(err); return; }
      port.drain(() => resolve(true));
    });
  });
});

// クローズ
ipcMain.handle("serial:close", async () => {
  return await new Promise((resolve) => {
    if (port && port.isOpen) port.close(() => resolve(true));
    else resolve(true);
  });
});
