'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('config', {
  get: () => ipcRenderer.invoke('config:get'),
  update: (patch) => ipcRenderer.invoke('config:update', patch),
  autoStart: () => ipcRenderer.invoke('config:autostart'),
  close: () => ipcRenderer.invoke('config:close'),
  // 主进程推送设置变更 → 配置窗口实时刷新
  onChanged: (cb) => ipcRenderer.on('config:changed', () => cb()),
  events: {
    add: (ev) => ipcRenderer.invoke('events:add', ev),
    update: (ev) => ipcRenderer.invoke('events:update', ev),
    remove: (id) => ipcRenderer.invoke('events:remove', id),
  },
  wallpaper: {
    rotate: (payload) => ipcRenderer.invoke('wallpaper:rotate', payload),
    restore: () => ipcRenderer.invoke('wallpaper:restore'),
    pickFolder: () => ipcRenderer.invoke('wallpaper:pick-folder'),
    openFolder: () => ipcRenderer.invoke('wallpaper:open-folder'),
    preview: (override) => ipcRenderer.invoke('wallpaper:preview', override),
  },
});
