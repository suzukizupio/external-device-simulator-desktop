"use strict";

const { contextBridge, ipcRenderer } = require("electron");
const MAX_WRITE_BYTES = 4096;

function subscribe(channel, callback) {
  if (typeof callback !== "function") throw new TypeError("callback must be a function");
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

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
