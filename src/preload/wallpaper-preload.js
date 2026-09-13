'use strict';
/* 壁纸生成窗口的 preload：目前渲染页只需 executeJavaScript 调用，
   这里留出最小接口便于以后扩展（不暴露任何 Node 能力）。 */
const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('wallpaperHost', {
  ping: () => 'ok',
});
