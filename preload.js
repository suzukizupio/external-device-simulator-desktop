// レンダラーへ安全にシリアルAPIを公開(contextIsolation下のブリッジ)
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("serialAPI", {
  list: () => ipcRenderer.invoke("serial:list"),
  open: (opts) => ipcRenderer.invoke("serial:open", opts),
  write: (dataArray) => ipcRenderer.invoke("serial:write", dataArray),
  close: () => ipcRenderer.invoke("serial:close"),
  onData: (cb) => ipcRenderer.on("serial:data", (_e, data) => cb(data)),
  onError: (cb) => ipcRenderer.on("serial:error", (_e, msg) => cb(msg)),
  onClosed: (cb) => ipcRenderer.on("serial:closed", () => cb()),
});
