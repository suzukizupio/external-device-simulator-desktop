"use strict";

const { contextBridge, ipcRenderer } = require("electron");
const MAX_WRITE_BYTES = 4096;

function subscribe(channel, callback) {
  if (typeof callback !== "function") throw new TypeError("callback must be a function");
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

// 警報変換の送信側に使う2本目の回線。受信側のserialAPIとは独立している。
contextBridge.exposeInMainWorld("bridgeAPI", Object.freeze({
  status: () => ipcRenderer.invoke("bridge:status"),
  open: (options) => ipcRenderer.invoke("bridge:open", options),
  write: (bytes) => {
    const payload = Array.from(bytes);
    if (payload.length === 0 || payload.length > MAX_WRITE_BYTES) throw new RangeError(`送信データは1～${MAX_WRITE_BYTES}byteで指定してください`);
    return ipcRenderer.invoke("bridge:write", { bytes: payload });
  },
  close: () => ipcRenderer.invoke("bridge:close"),
  onData: (callback) => subscribe("bridge:data", (event) => callback(event.bytes, event)),
  onWrite: (callback) => subscribe("bridge:tx", callback),
  onStatus: (callback) => subscribe("bridge:status", callback),
  onError: (callback) => subscribe("bridge:error", (event) => callback(event.message, event)),
}));

// 3本目の回線。宅配と非接触キーを同時に中継するとき、2台目の装置を受ける。
contextBridge.exposeInMainWorld("auxAPI", Object.freeze({
  status: () => ipcRenderer.invoke("aux:status"),
  open: (options) => ipcRenderer.invoke("aux:open", options),
  write: (bytes) => {
    const payload = Array.from(bytes);
    if (payload.length === 0 || payload.length > MAX_WRITE_BYTES) throw new RangeError(`送信データは1～${MAX_WRITE_BYTES}byteで指定してください`);
    return ipcRenderer.invoke("aux:write", { bytes: payload });
  },
  close: () => ipcRenderer.invoke("aux:close"),
  onData: (callback) => subscribe("aux:data", (event) => callback(event.bytes, event)),
  onWrite: (callback) => subscribe("aux:tx", callback),
  onStatus: (callback) => subscribe("aux:status", callback),
  onError: (callback) => subscribe("aux:error", (event) => callback(event.message, event)),
}));

contextBridge.exposeInMainWorld("appAPI", Object.freeze({
  info: () => ipcRenderer.invoke("app:info"),
}));

contextBridge.exposeInMainWorld("serialAPI", Object.freeze({
  list: () => ipcRenderer.invoke("serial:list"),
  status: () => ipcRenderer.invoke("serial:status"),
  open: (options) => ipcRenderer.invoke("serial:open", options),
  write: (bytes) => {
    const payload = Array.from(bytes);
    if (payload.length === 0 || payload.length > MAX_WRITE_BYTES) throw new RangeError(`送信データは1～${MAX_WRITE_BYTES}byteで指定してください`);
    return ipcRenderer.invoke("serial:write", { bytes: payload });
  },
  close: () => ipcRenderer.invoke("serial:close"),
  scan: (options) => ipcRenderer.invoke("serial:scan", options),
  onScan: (callback) => subscribe("serial:scan", callback),
  getSignals: () => ipcRenderer.invoke("serial:signals:get"),
  setSignals: (signals) => ipcRenderer.invoke("serial:signals:set", signals),
  flush: () => ipcRenderer.invoke("serial:flush"),
  onData: (callback) => subscribe("serial:data", (event) => callback(event.bytes, event)),
  onWrite: (callback) => subscribe("serial:tx", callback),
  onStatus: (callback) => subscribe("serial:status", callback),
  onError: (callback) => subscribe("serial:error", (event) => callback(event.message, event)),
  onClosed: (callback) => subscribe("serial:status", (state) => {
    if (state.status === "closed") callback(state);
  }),
}));
