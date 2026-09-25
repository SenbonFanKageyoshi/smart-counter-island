'use strict';
/**
 * 玻璃实验室窗口（--glass-lab 或配置页「预览」打开）：
 * 屏幕中央一块无边框置顶窗口，里面并排渲染多张「同一张桌面截图」的玻璃对照卡，
 * 让老师直接肉眼比：真实模糊（现状）/ 液态玻璃（现状）/ 液态玻璃 + 边缘色散（候选）。
 *
 * 背景图流程与灵动岛一致：desktopCapturer 截屏 → 按窗口区域裁剪 → dataURL 推给渲染层。
 * 窗口自身 setContentProtection(true)，不会被自己截进去。
 */
const { BrowserWindow, screen, desktopCapturer } = require('electron');
const path = require('path');
const settings = require('./settings');

let win = null;
let timer = null;
let live = false;
let capturing = false;
let loaded = false;

const LAB_W = 1020;
const LAB_H = 620;
const MARGIN = 60; // 外扩采样余量（与岛的 --glass-gap 一致）

function preload() {
  return path.join(__dirname, '..', 'preload', 'glass-lab-preload.js');
}

function isOpen() {
  return !!(win && !win.isDestroyed());
}

function isLoaded() {
  return loaded;
}

function getWindow() {
  return isOpen() ? win : null;
}

/** 截当前显示器整屏并按窗口区域裁剪（含外扩余量），返回给渲染层的数据 */
async function grab() {
  if (!isOpen() || capturing) return null;
  capturing = true;
  try {
    const b = win.getBounds();
    const disp = screen.getDisplayMatching(b);
    const physW = disp.size ? disp.size.width : Math.round(disp.bounds.width * (disp.scaleFactor || 1));
    const physH = disp.size ? disp.size.height : Math.round(disp.bounds.height * (disp.scaleFactor || 1));
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: physW, height: physH } });
    const src = sources.find((s) => String(s.display_id) === String(disp.id)) || sources[0];
    if (!src) return null;
    const img = src.thumbnail;
    if (img.isEmpty()) return null;
    const size = img.getSize();
    const rx = size.width / disp.bounds.width;
    const ry = size.height / disp.bounds.height;
    const x = Math.max(0, Math.round((b.x - disp.bounds.x - MARGIN) * rx));
    const y = Math.max(0, Math.round((b.y - disp.bounds.y - MARGIN) * ry));
    const w = Math.min(size.width - x, Math.round((b.width + MARGIN * 2) * rx));
    const h = Math.min(size.height - y, Math.round((b.height + MARGIN * 2) * ry));
    if (!(w > 8 && h > 8)) return null;
    const cropped = img.crop({ x, y, width: w, height: h });
    return {
      dataUrl: cropped.toDataURL(),
      // 渲染层按 DIP 铺放：图是物理像素，所以要换算成 DIP 尺寸
      dispW: Math.round((w / rx) * 100) / 100,
      dispH: Math.round((h / ry) * 100) / 100,
      offX: Math.round((b.x - disp.bounds.x - MARGIN) * -1),
      offY: Math.round((b.y - disp.bounds.y - MARGIN) * -1),
    };
  } catch (e) {
    console.error('[glass-lab] 截屏失败:', e && e.message);
    return null;
  } finally {
    capturing = false;
  }
}

/**
 * 重新取屏：**先把窗口隐藏再截**，截完恢复显示。
 * setContentProtection 在透明窗口上挡不住桌面复制（实测会把自己的卡片拍进去 →
 * 卡片里套卡片无限递归），所以必须真的隐藏一帧再截。
 */
async function refresh(reason) {
  if (!isOpen()) return false;
  const wasVisible = win.isVisible();
  try {
    win.hide();
  } catch (e) {
    /* ignore */
  }
  await new Promise((r) => setTimeout(r, 150));
  const g = await grab();
  if (wasVisible) {
    try {
      win.showInactive();
    } catch (e) {
      /* ignore */
    }
  }
  if (g) {
    try {
      win.webContents.send('lab:bg', g);
    } catch (e) {
      /* ignore */
    }
  }
  if (reason) console.log('[glass-lab] 取屏', reason, g ? 'OK' : '失败');
  return !!g;
}

/** 实时背景（可选）：每 2.2 秒隐藏-截图-显示一次。默认关闭（冻结背景更适合逐像素对比） */
function setLive(on) {
  live = !!on;
  if (live) {
    stopLoop();
    timer = setInterval(() => refresh('live').catch(() => {}), 2200);
    if (timer.unref) timer.unref();
  } else {
    stopLoop();
  }
  return live;
}

function startLoop() {
  stopLoop();
  if (!live) return;
  timer = setInterval(() => {
    if (!isOpen()) return stopLoop();
    refresh('live').catch(() => {});
  }, 2200);
  if (timer.unref) timer.unref();
}

function stopLoop() {
  if (timer) clearInterval(timer);
  timer = null;
}

function open() {
  if (isOpen()) {
    win.show();
    win.focus();
    refresh('reopen').catch(() => {});
    return;
  }
  const disp = screen.getPrimaryDisplay();
  const wa = disp.workArea;
  // 按工作区裁剪：1020×620 在小屏（如 1366×768）上会横竖都顶到边，
  // 居中后左右/上下都会被推出屏幕外，只能看到局部。
  const labW = Math.min(LAB_W, Math.max(640, wa.width - 60));
  const labH = Math.min(LAB_H, Math.max(420, wa.height - 60));
  const x = Math.round(wa.x + (wa.width - labW) / 2);
  const y = Math.round(wa.y + (wa.height - labH) / 2);
  win = new BrowserWindow({
    x,
    y,
    width: labW,
    height: labH,
    show: false,
    frame: false,
    transparent: true,
    resizable: true,
    skipTaskbar: false,
    hasShadow: false,
    alwaysOnTop: true,
    backgroundColor: '#00000000',
    title: '玻璃效果预览',
    webPreferences: {
      preload: preload(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      spellcheck: false,
    },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  try {
    win.setContentProtection(true); // 截屏排除自身（否则会把实验室自己拍进去）
  } catch (e) {
    /* ignore */
  }
  win.webContents.on('did-finish-load', async () => {
    loaded = true;
    // 先在隐藏状态取一张底图（此时窗口还没上屏，不会拍到自己），再显示
    await refresh('open').catch(() => {});
    win.show();
    win.focus();
    startLoop();
  });
  win.on('closed', () => {
    stopLoop();
    win = null;
    loaded = false;
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'glass-lab', 'index.html')).catch((e) => {
    console.error('[glass-lab] 加载失败:', e && e.message);
  });
}

function close() {
  stopLoop();
  if (isOpen()) win.close();
}

/** 把实验室里调好的参数写进设置（供「应用到小岛」按钮用） */
function applyParams(p) {
  const a = p || {};
  const patch = { ui: {} };
  const clamp = (v, lo, hi, d) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d;
  };
  if (a.refractWidth != null) patch.ui.refractWidth = Math.round(clamp(a.refractWidth, 3, 64, 0));
  if (a.maxRefract != null) patch.ui.maxRefract = Math.round(clamp(a.maxRefract, 2, 18, 0));
  if (a.bleedOpacity != null) patch.ui.bleedOpacity = Math.round(clamp(a.bleedOpacity, 0, 100, 70));
  if (a.glow != null) patch.ui.glassGlow = Math.round(clamp(a.glow, 0, 300, 100));
  if (a.aberration != null) patch.ui.glassAberration = Math.round(clamp(a.aberration, 0, 12, 0));
  settings.update(patch);
  return settings.load().ui;
}

module.exports = { open, close, isOpen, isLoaded, getWindow, refresh, setLive, applyParams, grab };
