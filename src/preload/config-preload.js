'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('config', {
  get: () => ipcRenderer.invoke('config:get'),
  update: (patch) => ipcRenderer.invoke('config:update', patch),
  autoStart: () => ipcRenderer.invoke('config:autostart'),
  schedulePreview: () => ipcRenderer.invoke('schedule:preview'),
  close: () => ipcRenderer.invoke('config:close'),
  minimize: () => ipcRenderer.invoke('config:minimize'),
  toggleMaximize: () => ipcRenderer.invoke('config:toggle-maximize'),
  // 无边框窗口拖动：主进程按屏幕坐标搬窗口（比 -webkit-app-region 更跟手、也不吃点击）
  drag: (phase, x, y) => ipcRenderer.invoke('config:drag', { phase, x, y }),
  // 盖板自定义内容：变量清单 + 按当前真实数据渲染的预览
  coverVars: () => ipcRenderer.invoke('config:cover-vars'),
  coverPreview: (tpl) => ipcRenderer.invoke('config:cover-preview', tpl),
  // 玻璃效果预览（玻璃实验室窗口）
  openGlassLab: () => ipcRenderer.invoke('config:open-glass-lab'),
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
  pet: {
    status: () => ipcRenderer.invoke('pet:status'),
    checkAi: () => ipcRenderer.invoke('pet:check-ai'),
    testSay: () => ipcRenderer.invoke('pet:test-say'),
    packStatus: () => ipcRenderer.invoke('pet:pack-status'),
    packOpen: () => ipcRenderer.invoke('pet:pack-open'),
    packSample: () => ipcRenderer.invoke('pet:pack-sample'),
    packReload: () => ipcRenderer.invoke('pet:pack-reload'),
    packPick: () => ipcRenderer.invoke('pet:pack-pick'),
    // 素材库：清单 / 下载 / 使用 / 删除 / 全量下载 / 进度
    libList: () => ipcRenderer.invoke('pet:lib-list'),
    libUse: (id) => ipcRenderer.invoke('pet:lib-use', id),
    libDownload: (id) => ipcRenderer.invoke('pet:lib-download', id),
    libDownloadAll: () => ipcRenderer.invoke('pet:lib-all'),
    libCancel: () => ipcRenderer.invoke('pet:lib-cancel'),
    libRemove: (id) => ipcRenderer.invoke('pet:lib-remove', id),
    libOpenDir: () => ipcRenderer.invoke('pet:lib-open'),
    onLibProgress: (cb) => ipcRenderer.on('pet:lib-progress', (_e, d) => cb(d)),
  },
  // 天气：状态 / 手动刷新 / 一键定位 / 城市解析预览 / 试一条提醒
  weather: {
    status: () => ipcRenderer.invoke('weather:status'),
    refresh: () => ipcRenderer.invoke('weather:refresh'),
    locate: () => ipcRenderer.invoke('weather:locate'),
    preview: (patch) => ipcRenderer.invoke('weather:preview', patch),
    testReminder: (kind) => ipcRenderer.invoke('weather:test-reminder', kind),
  },
});
