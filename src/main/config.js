'use strict';
const { BrowserWindow, screen } = require('electron');
const path = require('path');
const settings = require('./settings');
const island = require('./island');

let win = null;
let loaded = false;
let opening = false; // 防止并发 open() 产生多个窗口

function preload() {
  return path.join(__dirname, '..', 'preload', 'config-preload.js');
}

/** 配置窗口的理想尺寸（900×820）与最小值（660×560）。
    必须按**屏幕工作区**裁剪：1366×768 这类屏的工作区只有约 728 高，
    硬编码 820 会让窗口底部跑到屏幕外，最下面的设置项永远够不到。 */
function windowSize() {
  let wa = { width: 1280, height: 800 };
  try {
    wa = screen.getPrimaryDisplay().workAreaSize;
  } catch (e) {
    /* 取不到就用保守默认值 */
  }
  const width = Math.min(900, Math.max(480, wa.width - 60));
  const height = Math.min(820, Math.max(420, wa.height - 60));
  return {
    width,
    height,
    minWidth: Math.min(660, width),
    minHeight: Math.min(560, height),
  };
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
  win = require('./quiet').quiet(new BrowserWindow({
    ...windowSize(),
    title: 'Smart Counter Island · 配置',
    // 普通窗口：系统原生标题栏 + 不透明底色。
    // 原先是无边框 + 透明 + Win11 亚克力（拿背后真实桌面做模糊），观感花哨但不实用 ——
    // 拖动/关闭都要自绘，缩放边缘也容易误触。按用户要求改回「就是普通窗口」。
    frame: true,
    backgroundColor: '#f4f5f7',
    autoHideMenuBar: true,
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
  }));
  // 不再设置亚克力背景材质：普通窗口用不透明底色即可
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

/** 无边框窗口的最小化（自绘窗口按钮用；关闭走 close()） */
function minimize() {
  if (win && !win.isDestroyed()) win.minimize();
  return true;
}

/** 无边框窗口的最大化/还原（标题栏双击） */
function toggleMaximize() {
  if (!win || win.isDestroyed()) return false;
  if (win.isMaximized()) win.unmaximize();
  else win.maximize();
  return true;
}

/** 无边框窗口的拖动：让系统按鼠标位置自己搬窗口（比 CSS -webkit-app-region 更跟手） */
function dragStart(sx, sy) {
  if (!win || win.isDestroyed()) return false;
  try {
    const b = win.getBounds();
    win.__dragFrom = { x: b.x, y: b.y, sx: Number(sx) || 0, sy: Number(sy) || 0 };
    return true;
  } catch (e) {
    return false;
  }
}

function dragMove(sx, sy) {
  if (!win || win.isDestroyed() || !win.__dragFrom) return false;
  try {
    const d = win.__dragFrom;
    win.setBounds({ x: Math.round(d.x + (Number(sx) - d.sx)), y: Math.round(d.y + (Number(sy) - d.sy)), width: win.getBounds().width, height: win.getBounds().height });
    return true;
  } catch (e) {
    return false;
  }
}

function dragEnd() {
  if (win && !win.isDestroyed()) win.__dragFrom = null;
  return true;
}

module.exports = { open, close, isOpen, isLoaded, getWindow, broadcastChanged, minimize, toggleMaximize, dragStart, dragMove, dragEnd };
