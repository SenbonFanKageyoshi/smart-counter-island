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
  onAnim: (cb) => ipcRenderer.on('island:anim', (_e, d) => cb(d)),
  onGeom: (cb) => ipcRenderer.on('island:geom', (_e, g) => cb(g)),
  // 渲染层 → 主进程
  ready: () => ipcRenderer.send('island:ready'),
  action: (a) => ipcRenderer.invoke('island:action', a),
  getState: () => ipcRenderer.invoke('island:get-state'),
  notifySize: (s) => ipcRenderer.send('island:notify-size', s),
  // 细条/横幅：左右两瓣实测宽度（主进程据此把窗口宽度按内容自适应）
  stripSize: (s) => ipcRenderer.send('island:strip-size', s),
  zoomWidth: (w) => ipcRenderer.send('island:zoom-width', w),
  // GPU 玻璃链路回报：亮度（渲染进程自己从视频帧算）/ 取流失败回退 / 运行统计
  reportGlass: (d) => ipcRenderer.send('island:gl-report', d),
});
