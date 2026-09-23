'use strict';
/**
 * 传感器盖板（sensor cover）
 *
 * 一块**纯黑胶囊形**的小窗口，永久盖在传感器（挖孔摄像头）上面：
 *   - 位置与大小只由禁区算出，创建后**永不移动、永不缩放**（小岛怎么变都不影响它）；
 *   - `screen-saver` 置顶 + 鼠标穿透 + 不参与截屏（不会被小岛自己的玻璃拍进去）；
 *   - 小岛收缩 / 自动隐藏 / 全屏授课时它都还在，镜头那一块始终是黑的。
 *
 * 这样小岛侧就只需要「内容绕开禁区」，不用再自己画那块黑。
 */
const { BrowserWindow } = require('electron');
const path = require('path');

/** 传感器盖板：由 island.applySettings()/notchSpec 驱动 */
class SensorCover {
  constructor() {
    this.win = null;
    this.key = ''; // 当前几何（避免每 tick 重复 setBounds）
    this.zone = null;
    this.weather = null; // 兼容旧字段（天气载荷）
    this.content = null; // 盖板内容载荷：{ weather, text, textSize }
  }

  /** 与小岛上一样的置顶断言（小岛每 tick 抢顶层，盖板要跟着一起抢） */
  /** 与小岛上一样的置顶断言（小岛每 tick 抢顶层，盖板要跟着一起抢；顺手补齐显示） */
  reassert() {
    if (!this.win || this.win.isDestroyed()) return;
    try {
      this.win.setAlwaysOnTop(true, 'screen-saver');
      if (!this.win.isVisible()) this.win.showInactive();
    } catch (e) {
      /* ignore */
    }
  }

  /**
   * 同步盖板：zone = 屏幕坐标（DIP）的禁区矩形；null = 关掉盖板。
   * 只在几何真的变化时才 setBounds（位置/大小固定不动，改设置才会重建）。
   */
  sync(zone) {
    if (!zone || !(zone.w > 0) || !(zone.h > 0)) {
      this.destroy();
      return;
    }
    const x = Math.round(zone.x);
    const y = Math.round(zone.y);
    const width = Math.max(8, Math.round(zone.w));
    const height = Math.max(8, Math.round(zone.h));
    const key = `${x},${y},${width},${height}`;
    if (this.win && !this.win.isDestroyed()) {
      if (key !== this.key) {
        this.key = key;
        try {
          this.win.setBounds({ x, y, width, height });
        } catch (e) {
          /* ignore */
        }
      }
      if (!this.win.isVisible()) this.win.showInactive();
      this.reassert();
      return;
    }
    this.key = key;
    this.zone = { x, y, width, height };
    // 无边框透明窗口 + 页面里一块 #cap（纯黑、圆角=窗口高的一半 = 胶囊）
    // show: true 直接显示：盖板不抢焦点（focusable:false），不需要等页面加载完再 show，
    // 否则冷启动/切屏那几百毫秒里会「有时看不到」。
    const win = new BrowserWindow({
      x,
      y,
      width,
      height,
      show: true,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      focusable: false,
      hasShadow: false,
      alwaysOnTop: true,
      backgroundColor: '#00000000',
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload', 'sensor-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
        spellcheck: false,
      },
    });
    this.win = win;
    win.setAlwaysOnTop(true, 'screen-saver');
    // 鼠标穿透：盖板只负责遮，不接任何点击
    win.setIgnoreMouseEvents(true);
    // 不参与屏幕捕获：小岛的玻璃采样要拍到桌面，不能被这块黑挡住
    try {
      win.setContentProtection(true);
    } catch (e) {
      /* ignore */
    }
    win.on('closed', () => {
      if (this.win === win) this.win = null;
    });
    win.webContents.on('did-finish-load', () => {
      this.reassert();
      if (this.content) this.setContent(this.content); // 盖板重建后补推内容（天气 + 自定义文字）
    });
    win.loadFile(path.join(__dirname, '..', 'renderer', 'sensor', 'index.html')).then(() => {
      if (!this.win || this.win.isDestroyed()) return;
      this.reassert();
      this.reassert();
    }).catch((e) => {
      console.error('[sensor-cover] 页面加载失败:', e && e.message);
    });
  }

  bounds() {
    if (!this.win || this.win.isDestroyed()) return null;
    return this.win.getBounds();
  }

  /** 可选：把内容画在盖板上（天气 chip + 自定义文字）。payload = { weather, text, textSize } */
  setContent(payload) {
    this.content = payload || null;
    if (!this.win || this.win.isDestroyed()) return false;
    try {
      this.win.webContents.send('cover:content', this.content);
      return true;
    } catch (e) {
      return false;
    }
  }

  /** 兼容旧入口：只更新天气那部分 */
  setWeather(payload) {
    return this.setContent({ ...(this.content || {}), weather: payload || null });
  }

  destroy() {
    this.key = '';
    this.zone = null;
    if (this.win && !this.win.isDestroyed()) {
      const w = this.win;
      this.win = null;
      try {
        w.destroy();
      } catch (e) {
        /* ignore */
      }
    }
  }
}

module.exports = new SensorCover();
