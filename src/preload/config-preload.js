'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('config', {
  get: () => ipcRenderer.invoke('config:get'),
  update: (patch) => ipcRenderer.invoke('config:update', patch),
  close: () => ipcRenderer.invoke('config:close'),
  // 主进程推送设置变更 → 配置窗口实时刷新
  onChanged: (cb) => ipcRenderer.on('config:changed', () => cb()),
  events: {
    add: (ev) => ipcRenderer.invoke('events:add', ev),
    update: (ev) => ipcRenderer.invoke('events:update', ev),
    remove: (id) => ipcRenderer.invoke('events:remove', id),
  },
});
