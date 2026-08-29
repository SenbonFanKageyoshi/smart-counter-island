'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('island', {
  // 主进程 → 渲染层
  onState: (cb) => ipcRenderer.on('island:state', (_e, s) => cb(s)),
  onEvents: (cb) => ipcRenderer.on('island:events', (_e, e) => cb(e)),
  onGlass: (cb) => ipcRenderer.on('island:glass', (_e, g) => cb(g)),
  onGlassMode: (cb) => ipcRenderer.on('island:glassmode', (_e, m) => cb(m)),
  onBrightness: (cb) => ipcRenderer.on('island:brightness', (_e, d) => cb(d)),
  onNotify: (cb) => ipcRenderer.on('island:notify', (_e, d) => cb(d)),
  // 渲染层 → 主进程
  ready: () => ipcRenderer.send('island:ready'),
  action: (a) => ipcRenderer.invoke('island:action', a),
  getState: () => ipcRenderer.invoke('island:get-state'),
  notifySize: (s) => ipcRenderer.send('island:notify-size', s),
  zoomWidth: (w) => ipcRenderer.send('island:zoom-width', w),
});
