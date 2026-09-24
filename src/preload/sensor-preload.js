'use strict';
/**
 * 传感器盖板窗口的 preload。
 * 盖板做两件事：显示一块纯黑胶囊（盖住摄像头那块）+ 可选显示内容（天气 chip / 自定义文字）。
 * 窗口是 sandbox + contextIsolation，所以只暴露一个最小订阅接口。
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('cover', {
  // 长按盖板（与长按灵动岛同一个动作）：启动计时坞 + 快捷添加态
  longPress: () => ipcRenderer.invoke('cover:longpress'),
  onContent: (cb) => {
    ipcRenderer.on('cover:content', (_e, payload) => {
      try {
        cb(payload);
      } catch (err) {
        /* 渲染层异常不影响盖板本身 */
      }
    });
  },
});
