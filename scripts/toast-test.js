'use strict';
/* 测试通知触发程序：运行后发送一条 Windows 系统 Toast 通知，
   用于验证 Smart Counter Island 的通知接管捕获。
   用法：node_modules\.bin\electron scripts\toast-test.js   （或双击 send-test-toast.cmd） */
const { app, Notification } = require('electron');

app.setAppUserModelId('com.smartcounter.island');

app.whenReady().then(() => {
  const now = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  const n = new Notification({
    title: '测试应用',
    body: `这是一条测试通知，时间 ${now}`,
  });
  n.show();
  // 3 秒后再发一条不同内容，验证同应用连续通知
  setTimeout(() => {
    const n2 = new Notification({
      title: '测试应用',
      body: `第二条测试通知，内容已变化 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`,
    });
    n2.show();
  }, 3000);
  setTimeout(() => app.quit(), 7000);
});
