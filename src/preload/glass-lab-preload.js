'use strict';
/** 玻璃实验室窗口 preload：截图推送 + 关闭 + 把参数写回设置 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('lab', {
  onBg: (cb) => ipcRenderer.on('lab:bg', (_e, g) => cb(g)),
  refresh: () => ipcRenderer.invoke('lab:refresh'),
  live: (on) => ipcRenderer.invoke('lab:live', on),
  close: () => ipcRenderer.invoke('lab:close'),
  apply: (params) => ipcRenderer.invoke('lab:apply', params),
});
