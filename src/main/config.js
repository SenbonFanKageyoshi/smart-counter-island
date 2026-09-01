'use strict';
const { BrowserWindow } = require('electron');
const path = require('path');
const settings = require('./settings');
const island = require('./island');

let win = null;
let loaded = false;
let opening = false; // 防止并发 open() 产生多个窗口

function preload() {
  return path.join(__dirname, '..', 'preload', 'config-preload.js');
}

function open() {
  if (win && !win.isDestroyed()) {
    // 已存在：显示并聚焦
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    return;
  }
  if (opening) return; // 正在创建中，忽略重复请求
  opening = true;
  loaded = false;
  win = new BrowserWindow({
    width: 660,
    height: 780,
    minWidth: 560,
    minHeight: 620,
    title: 'Smart Counter Island · 配置',
    autoHideMenuBar: true,
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    show: false, // 加载完成后再显示，避免白屏闪现
    webPreferences: {
      preload: preload(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  win.setMenuBarVisibility(false);
  // 配置窗口不置顶（用户反馈置顶烦人）；小岛放大态可能盖住它，从托盘/小岛双击仍可重新打开
  win.webContents.on('did-finish-load', () => {
    loaded = true;
    opening = false;
    win.show();
    win.focus();
  });
  win.webContents.on('did-fail-load', (_e, code, desc) => {
    console.error('[config] 页面加载失败:', code, desc);
    opening = false;
  });
  win.webContents.on('render-process-gone', (_e, d) => {
    console.error('[config] 渲染进程异常退出:', d.reason);
  });
  win.on('closed', () => {
    win = null;
    opening = false;
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'config', 'index.html')).catch((e) => {
    console.error('[config] loadFile 失败:', e);
    opening = false;
  });
}

function close() {
  if (win && !win.isDestroyed()) win.close();
}

function isOpen() {
  return !!(win && !win.isDestroyed());
}

function isLoaded() {
  return loaded;
}

function getWindow() {
  return win && !win.isDestroyed() ? win : null;
}

/** 推送设置变更给配置窗口（实时同步，防止页面状态过期） */
function broadcastChanged() {
  if (win && !win.isDestroyed()) {
    win.webContents.send('config:changed');
  }
}

module.exports = { open, close, isOpen, isLoaded, getWindow, broadcastChanged };
