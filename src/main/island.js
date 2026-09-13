'use strict';
const { BrowserWindow, screen, desktopCapturer, Menu, app } = require('electron');
const path = require('path');
const settings = require('./settings');
const perf = require('./perf');

/** 窗口比灵动岛本体多出的透明边距（DIP） */
const PAD = 8;

/** 只要背景亮度（不需要玻璃背景图）时请求的缩略图宽度（像素）。
    整屏 1:1 缩略图是 1920×1080×4 ≈ 8MB，小图只要几十 KB —— 截屏拷贝开销降一个数量级。 */
const FAST_THUMB_W = 480;

/** 位图指纹（FNV-1a，采样遍历，避免整块哈希的开销）：用于判断玻璃背景是否变化 */
function bitmapHash(buf) {
  let h = 0x811c9dc5;
  const step = buf.length > 262144 ? 16 : 4;
  for (let i = 0; i < buf.length; i += step) {
    h ^= buf[i];
    h = (h * 0x01000193) >>> 0;
  }
  return (h ^ buf.length) >>> 0;
}

/** 各状态下的灵动岛本体尺寸（不含边距，DIP） */
const PILL = {
  strip: { w: 116, h: 26 },    // 细条（默认形态）
  expanded: { w: 420, h: 64 }, // 放大版灵动岛：事件名+天数+时分秒，胶囊形
  zoom: { w: 400, h: 400 },    // 倒计时窗口基准（实际按屏幕高 1/5 动态缩放，见 zoomSize）
  notify: { w: 500, h: 104 },  // 系统通知：标题+内容+免打扰按钮（黑底白字）
};

/** 各状态的圆角半径（DIP；strip/expanded 为胶囊 = 高度一半，与渲染层 CSS 一致） */
const REGION_RADIUS = { strip: 13, expanded: 32, zoom: 42, notify: 24 };

/** 各状态窗口的显示名称 */
const STATE_NAMES = {
  strip: '灵动岛',
  expanded: '横幅',
  zoom: '倒计时窗口',
  notify: '消息',
};

function easeOutCubic(t) {
  return 1 - Math.pow(1 - t, 3);
}

/* ---------- 性能计数器（--perf 模式；未启用时只是几个数字自增，开销可忽略） ---------- */

const perfAnim = {
  s: { animations: 0, frames: 0, dupFrames: 0, intervalSum: 0, intervalCount: 0, intervalMax: 0, durationSum: 0, durationMax: 0, regionCalls: 0, regionSkipped: 0, applySum: 0, applyMax: 0 },
  reset() {
    for (const k of Object.keys(this.s)) this.s[k] = 0;
  },
  report() {
    const s = this.s;
    return {
      ...s,
      avgFrameMs: s.intervalCount ? +(s.intervalSum / s.intervalCount).toFixed(2) : 0,
      avgDurationMs: s.animations ? +(s.durationSum / s.animations).toFixed(1) : 0,
      avgApplyMs: s.frames ? +(s.applySum / s.frames).toFixed(2) : 0,
    };
  },
};

const perfCapture = {
  s: { calls: 0, guardSkips: 0, fastFrames: 0, glassFrames: 0, encoded: 0, unchanged: 0, totalMs: 0, maxMs: 0, sourcesMs: 0, bitmapMs: 0, encodeMs: 0, ipcBytes: 0 },
  reset() {
    for (const k of Object.keys(this.s)) this.s[k] = 0;
  },
  report() {
    const s = this.s;
    return {
      ...s,
      avgMs: s.calls ? +(s.totalMs / s.calls).toFixed(1) : 0,
      avgSourcesMs: s.calls ? +(s.sourcesMs / s.calls).toFixed(1) : 0,
      avgBitmapMs: s.encoded ? +(s.bitmapMs / s.encoded).toFixed(1) : 0,
      avgEncodeMs: s.encoded ? +(s.encodeMs / s.encoded).toFixed(1) : 0,
      avgIpcKB: s.encoded ? +(s.ipcBytes / s.encoded / 1024).toFixed(1) : 0,
    };
  },
};

const perfProbe = {
  s: { requests: 0, lite: 0 },
  reset() {
    for (const k of Object.keys(this.s)) this.s[k] = 0;
  },
  report() {
    return { ...this.s };
  },
};

/**
 * 纯决策函数：由输入推导目标状态（可单测）。
 * 返回 null 表示「保持当前状态」（光标悬停/手动保持期内，避免频繁切换）。
 */
function decideState(input) {
  const {
    idleMs, occluded, maximized, overPill, state,
    mode, smart, hideOnMaximized,
    expandIdleSec, zoomIdleSec, zoomAllowed, zoomCooldown, holding, hasCountdown,
    expandedSinceMs = 0, // 横幅（expanded）已持续展示的毫秒数；非横幅状态为 0
  } = input;

  // 手动操作保持期：优先于一切（否则手动放大的大屏会被立刻拉回）
  if (holding) return null;

  // 没有计时时间（无有效事件）：锁定灵动岛，仅手动下滑手势可展开大屏
  if (!hasCountdown) return 'strip';

  // 全屏遮挡：无条件锁定灵动岛 + 鼠标穿透，不响应任何操作/不唤起（含手动隐藏、固定模式）
  if (occluded) {
    return 'strip';
  }

  // 手动隐藏：始终灵动岛，悬浮不唤起（避免"鼠标移上去就展开横幅"）
  if (mode === 'hidden') {
    return 'strip';
  }

  // 手动「大窗口驻留」：倒计时窗口常显，不因闲置/操作/悬停收回
  // （全屏遮挡已在上面拦截 → 仍然收成灵动岛并隐藏，不遮挡授课；无事件时同样收成灵动岛）
  if (mode === 'zoom') {
    // 「允许倒计时窗口」关闭时退化为横幅（保持可见，但不放大）
    return zoomAllowed ? 'zoom' : 'expanded';
  }

  // 光标悬停在小岛上：保持现状（不来回切换，按钮可点击）；
  // 大屏为纯展示态（鼠标穿透、不可操作）：悬停不阻止收起，有操作即回到灵动岛
  if (overPill && state !== 'zoom') return null;

  // 关闭智能：不自动切换，保持手动控制
  if (!smart) return null;

  // 前台窗口最大化：保持灵动岛（不展开遮挡教学/演示内容）
  if (mode !== 'pinned' && hideOnMaximized && maximized) {
    return 'strip';
  }

  // 非全屏、非最大化时可按闲置时间自动弹出大屏（0 = 不自动）。
  // 层级：先横幅（expanded），横幅已持续展示 zoomIdleSec 秒后才自动弹大屏；
  // 已在大屏（zoom）且继续闲置 → 保持大屏；操作后 zoomCooldown 期间不自动弹大屏
  // （避免"收起后又马上弹出"）
  if (zoomIdleSec > 0 && zoomAllowed && !zoomCooldown) {
    const zoomIdleMs = zoomIdleSec * 1000;
    if (state === 'zoom' && idleMs >= zoomIdleMs) return 'zoom';
    if (state === 'expanded' && expandedSinceMs >= zoomIdleMs && idleMs >= zoomIdleMs) return 'zoom';
  }

  // 无操作（闲置 expandIdleSec 秒）→ 横幅；有操作 → 灵动岛
  if (idleMs >= expandIdleSec * 1000) {
    return 'expanded';
  }
  return 'strip';
}

class Island {
  constructor() {
    this.win = null;
    this.probe = null;
    this.state = 'expanded'; // 默认窗口 = 横幅（固定，不可更改）
    this.currentOpacity = 0.9;
    this.notifySize = null;   // 通知展示框自适应尺寸（渲染器按内容测量上报）
    this.zoomWidth = 0;       // 倒计时窗口宽度（渲染器按文字内容测量上报；0 = 用默认宽度）
    this.fullscreen = false;  // 最近一次探针检测是否处于全屏遮挡（全屏锁定灵动岛）
    this.lastLi = 0;          // 最近一次探针报告的最后输入时刻（用于检测"有操作"）
    this.lastInputAt = 0;     // 本机感知到的输入时刻（探针采样节奏分档用）
    this.zoomCooldownUntil = 0; // 操作后 60 秒内不自动弹大屏
    this.dragging = false;
    this.animating = false;   // 动画进行中（暂停自动切换与截屏，防卡顿/打断）
    this.animTimer = null;
    this.tickTimer = null;
    this.glassTimer = null;
    this.glassOn = false;
    this.glassFail = 0;
    this.glassFailed = false;
    this.quitting = false;
    this.openConfig = null;   // 由 main 注入
    this.paused = false;      // 冻结状态机（截图/测试用）
    this.lastAutoSwitch = 0;  // 上次自动状态切换时刻（去抖，防止窗口"跳舞"）
    this.lastOverPill = false; // overPill 滞回记忆（光标在边界抖动时不反复切换）
    this.holdUntil = 0;       // 手动操作保持期截止时间（毫秒时间戳）
    this.expandedAt = 0;      // 最近一次进入横幅（expanded）的时刻（自动弹大屏从横幅展开后计时）
    this.gestureAt = 0;       // 上次拖放手势时刻（防触摸屏松手误触）
    this.capturing = false;   // 截屏防重入（防止并发截屏导致卡顿）
    this.lastBrightness = 0.5; // 最近一次背景亮度（0-1，文字颜色适配用）
    this.regionApplied = false; // 圆角区域是否已成功应用（探针就绪后重试）
    this.lastRegionKey = null;   // 最近一次已生效的圆角区域参数（相同则跳过重复设置）
    this.probeEveryMs = 350;     // 当前探针采样间隔（按活跃度自适应，见 tick）
    this.lastProbeAt = 0;
    this.lastBrightnessSent = -1; // 最近一次已下发的亮度（变化很小则不下发，省 IPC 与重绘）
    this.lastGlassHash = 0;       // 最近一次玻璃背景图指纹（未变化则不重复编码/下发）
    this.glActive = false;        // GPU 液态玻璃：渲染层视频流是否已就绪
    this.glFallback = false;      // GPU 取流/着色器失败后本次运行回退到 CPU 液态玻璃
    this.glStats = null;          // 渲染层回传的 GPU 玻璃统计（--perf / --diag 用）
    this.glError = '';            // 最近一次 GPU 取流失败原因
    this.lastGeomKey = '';        // 最近一次下发的窗口几何（移动时增量推送）
    this.excludeApplied = false; // 截屏排除自身是否已设置（探针就绪后重试）
    this.autoHidden = false;     // 智能隐藏：全屏时窗口是否已自动隐藏
    this.displaysBound = false;
    // 系统通知接管
    this.notifyPrevState = 'strip'; // 显示通知前的状态（收起后返回）
    this.notifyUntil = 0;           // 通知显示截止时间
    this.notifyData = null;         // { title, body }
    this.notifyDndUntil = 0;        // 免打扰截止时间（至下课）
    this.lastToasts = new Set();    // 最近一次探针报告的通知（hwnd 集合）
    this.lastToastSig = new Map();  // hwnd → 最近一次报告文本（文本变化 = 新通知，兼容复用窗口的 QQ NT）
    this.mousePT = false;           // 当前是否已开启鼠标穿透（全屏遮挡时）
  }

  setPaused(v) {
    this.paused = !!v;
  }

  init({ probe, openConfig }) {
    this.probe = probe;
    this.openConfig = openConfig;
  }

  // ---------------- 基础 ----------------

  send(channel, payload) {
    if (this.win && !this.win.isDestroyed()) {
      this.win.webContents.send(channel, payload);
    }
  }

  getStatePayload() {
    // 附带几何信息：GPU 液态玻璃（webgl 模式）需要把画布像素映射到屏幕/视频帧坐标
    const geom = this.geomPayload();
    return { state: this.state, opacity: this.currentOpacity, geom };
  }

  /** 渲染层做「画布 → 屏幕物理像素 → 视频帧」映射所需的几何（DIP + 缩放） */
  geomPayload() {
    if (!this.win || this.win.isDestroyed()) return null;
    try {
      const b = this.win.getBounds();
      const disp = this.islandDisplay();
      return {
        win: { x: b.x, y: b.y, width: b.width, height: b.height },
        disp: { x: disp.bounds.x, y: disp.bounds.y, w: disp.bounds.width, h: disp.bounds.height },
        scale: disp.scaleFactor || 1,
      };
    } catch (e) {
      return null;
    }
  }

  /** 小岛当前所在显示器（按窗口实际位置） */
  islandDisplay() {
    if (this.win && !this.win.isDestroyed()) {
      try {
        return screen.getDisplayMatching(this.win.getBounds());
      } catch (e) {
        /* fallthrough */
      }
    }
    return this.positionDisplay();
  }

  /** 位置锚定显示器：跟随光标 / 主屏 / 指定索引 */
  positionDisplay() {
    const st = settings.load();
    if (st.ui.display === 'index') {
      const d = screen.getAllDisplays()[st.ui.displayIndex];
      if (d) return d;
    }
    if (st.ui.display === 'primary') return screen.getPrimaryDisplay();
    if (this.probe && this.probe.last) {
      const p = this.probe.last;
      const s0 = screen.getPrimaryDisplay().scaleFactor;
      let d = screen.getDisplayNearestPoint({ x: p.cx / s0, y: p.cy / s0 });
      d = screen.getDisplayNearestPoint({ x: p.cx / d.scaleFactor, y: p.cy / d.scaleFactor });
      return d;
    }
    return screen.getPrimaryDisplay();
  }

  /** 光标所在显示器（两遍法处理混合 DPI） */
  cursorDisplay() {
    if (this.probe && this.probe.last) {
      const p = this.probe.last;
      const s0 = screen.getPrimaryDisplay().scaleFactor;
      let d = screen.getDisplayNearestPoint({ x: p.cx / s0, y: p.cy / s0 });
      d = screen.getDisplayNearestPoint({ x: p.cx / d.scaleFactor, y: p.cy / d.scaleFactor });
      return d;
    }
    return this.islandDisplay();
  }

  /** 倒计时窗口尺寸：高度 = 所在屏幕工作区高度的 1/4（上限 420，下限 200）；
      宽度随文字内容自适应（渲染器测量上报），默认与高度相同 */
  zoomSize(disp) {
    const h = Math.max(200, Math.min(420, Math.round((disp ? disp.workArea.height : 900) / 4)));
    const w = this.zoomWidth > 0 ? this.zoomWidth : h;
    return { w, h };
  }

  /** 倒计时窗口宽度随文字内容调整：渲染器测量后上报 */
  setZoomWidth(w) {
    if (!(w > 0)) return;
    const disp = this.islandDisplay();
    const maxW = Math.max(240, disp.workArea.width - 40);
    const nw = Math.max(240, Math.min(maxW, Math.round(w)));
    if (this.zoomWidth === nw) return;
    this.zoomWidth = nw;
    this.zoomWidthChanges = (this.zoomWidthChanges || 0) + 1;
    if (this.state === 'zoom' && this.win && !this.win.isDestroyed()) {
      const target = this.computeBounds('zoom', disp);
      // 内容宽度的微小变化直接改尺寸：走 150ms 动画的话玻璃会被隐藏一小会儿，
      // 每到整秒数字变化就闪一下，看起来就是"不跟手"
      const cur = this.win.getBounds();
      if (Math.abs(cur.width - target.width) <= 24 && Math.abs(cur.height - target.height) <= 24) {
        this.applyBoundsNow(target);
      } else {
        this.animateBounds(target);
      }
    }
  }

  /** 直接应用窗口边界（不做动画 → 玻璃不隐藏）：用于内容宽度的微小变化 */
  applyBoundsNow(target) {
    if (!this.win || this.win.isDestroyed()) return;
    try {
      this.win.setBounds(target);
    } catch (e) {
      return;
    }
    this.applyRegion();
    this.pushGeomIfChanged(true);
    this.send('island:anim', { on: false });
  }

  /** 按状态计算窗口边界（每种状态独立位置配置；通知形态尺寸随内容自适应） */
  computeBounds(state, disp) {
    let s;
    if (state === 'zoom') s = this.zoomSize(disp);
    else if (state === 'notify' && this.notifySize) s = this.notifySize;
    else s = PILL[state] || PILL.strip;
    const w = s.w + PAD * 2;
    const h = s.h + PAD * 2;
    const wa = disp.workArea;
    const st = settings.load();
    const pos = (st.ui.positions || {})[state] || {};
    let x, y;
    if (pos.mode === 'custom' && pos.x != null) {
      x = pos.x;
      y = pos.y;
    } else {
      const mode = pos.mode || st.ui.position || 'top-center';
      const cxm =
        mode === 'top-left'
          ? 16
          : mode === 'top-right'
            ? wa.width - w - 16
            : Math.round((wa.width - w) / 2);
      x = wa.x + cxm;
      y = wa.y + 8;
    }
    // 限制在显示器工作区内
    x = Math.max(wa.x - w + 40, Math.min(x, wa.x + wa.width - 40));
    y = Math.max(wa.y - 10, Math.min(y, wa.y + wa.height - 60));
    return { x, y, width: w, height: h };
  }

  /** 获取小岛窗口 HWND（十进制字符串，BigInt 精确转出，避免 Number 丢精度） */
  getHwnd() {
    if (!this.win || this.win.isDestroyed()) return null;
    try {
      const buf = this.win.getNativeWindowHandle();
      return buf.readBigUInt64LE ? buf.readBigUInt64LE(0).toString() : String(buf.readUInt32LE(0));
    } catch (e) {
      return null;
    }
  }

  /**
   * 把窗口命中区域裁剪成圆角胶囊（Win32 SetWindowRgn，物理像素）。
   * - SetWindowRgn 使用物理像素，而窗口 bounds 是 DIP，必须乘上缩放系数；
   * - 区域整体外扩 3px：Win32 区域边缘无抗锯齿（锯齿），外扩后锯齿边缘
   *   藏在 CSS 抗锯齿圆角边缘之外的透明区，视觉上圆角平滑无锯齿；
   * - 探针不可用时回退到 Electron setShape（矩形）。
   */
  applyRegion() {
    if (process.platform !== 'win32' || !this.win || this.win.isDestroyed()) return;
    const s =
      this.state === 'zoom'
        ? this.zoomSize(this.islandDisplay())
        : this.state === 'notify' && this.notifySize
          ? this.notifySize
          : PILL[this.state] || PILL.strip;
    // CSS border-radius 是「半径」；CreateRoundRectRgn 的第 5/6 参数是「椭圆宽度」（= 2×半径），必须翻倍
    const radius = (REGION_RADIUS[this.state] || 24) * 2;
    const scale = this.islandDisplay().scaleFactor;
    const hwnd = this.getHwnd();
    const gap = 3; // 外扩像素：让 Win32 锯齿边缘落在 CSS 平滑边缘之外的透明区
    const x = Math.round((PAD - gap) * scale);
    const y = Math.round((PAD - gap) * scale);
    const w = Math.round((s.w + gap * 2) * scale);
    const h = Math.round((s.h + gap * 2) * scale);
    // 尺寸/状态没变且上次已生效：跳过（避免每次动画结束都写一次命令文件 + SetWindowRgn）
    if (hwnd && this.probe && this.probe.setRegion(hwnd, x, y, w, h, Math.round(radius * scale))) {
      this.regionApplied = true;
      this.lastRegionKey = `${hwnd}|${x}|${y}|${w}|${h}|${Math.round(radius * scale)}`;
      perfAnim.s.regionCalls += 1;
      return;
    }
    // 探针未就绪或写入失败：标记未应用，tick 会持续重试；同时回退 Electron setShape
    this.regionApplied = false;
    try {
      this.win.setShape([{ x: PAD, y: PAD, width: s.w, height: s.h }]);
    } catch (e) {
      /* ignore */
    }
  }

  /** 动画结束时调用：区域参数与上次完全一致就跳过。
      连续切换状态（拖拽放大/缩小时每次动画结束都会来一次）时省掉一次
      命令文件写入 + 探针侧 SetWindowRgn，动画收尾更轻。 */
  applyRegionIfChanged() {
    if (process.platform !== 'win32' || !this.win || this.win.isDestroyed()) return;
    const s =
      this.state === 'zoom'
        ? this.zoomSize(this.islandDisplay())
        : this.state === 'notify' && this.notifySize
          ? this.notifySize
          : PILL[this.state] || PILL.strip;
    const radius = (REGION_RADIUS[this.state] || 24) * 2;
    const scale = this.islandDisplay().scaleFactor;
    const hwnd = this.getHwnd();
    const gap = 3;
    const key = `${hwnd}|${Math.round((PAD - gap) * scale)}|${Math.round((PAD - gap) * scale)}|${Math.round((s.w + gap * 2) * scale)}|${Math.round((s.h + gap * 2) * scale)}|${Math.round(radius * scale)}`;
    if (this.regionApplied && key === this.lastRegionKey) {
      perfAnim.s.regionSkipped += 1;
      return;
    }
    this.applyRegion();
  }

  /** 窗口尺寸变化后立即刷新玻璃背景图：动画期间 captureOnce 被 animating 跳过，
      若等常规循环（1.6s）或 setState 的 250ms 定时，玻璃会短暂显示旧尺寸/旧位置
      的截图（与窗口错位的"方形模糊"）。这里在尺寸稳定后立刻抓一次。 */
  refreshGlassAfterResize() {
    if (!this.win || this.win.isDestroyed()) return;
    this.send('island:anim', { on: false });
    // 延迟几毫秒等 setBounds/region 生效，再抓新位置截屏
    setTimeout(() => {
      if (this.quitting || !this.win || this.win.isDestroyed()) return;
      this.captureOnce().catch(() => {});
    }, 30);
  }

  animateBounds(target) {
    if (!this.win || this.win.isDestroyed()) return;
    const st = settings.load();
    // 动画期间隐藏真实玻璃层（液态滤镜/合成层在窗口缩放中会逃逸 CSS 圆角裁剪，
    // 露出方形模糊边）；pill 自带半透明渐变底，150ms 过渡观感干净，
    // 动画结束恢复玻璃并重建滤镜（island:anim 信号驱动渲染层）。
    this.send('island:anim', { on: true });
    // 高级设置：关闭动画 = 直接切换
    if (st.smart.animEnabled === false) {
      try {
        this.win.setBounds(target);
      } catch (e) {
        /* ignore */
      }
      this.animating = false;
      this.applyRegion();
      this.pushGeomIfChanged(true);
      this.refreshGlassAfterResize();
      return;
    }
    const cur = this.win.getBounds();
    if (this.animTimer) clearTimeout(this.animTimer);
    this.animating = true;
    // 动画期间用超大矩形占位（一次设置，不逐帧调用，避免卡顿）：
    // 无裁剪错位 → 不会出现旧区域裁剪导致的"白边/残影"；结束后再设圆角区域
    try {
      this.win.setShape([{ x: 0, y: 0, width: 10000, height: 10000 }]);
    } catch (e) {
      /* ignore */
    }
    // 帧率可调（高级设置 animFps）：目标帧间隔 = 1000/fps，总时长 150ms。
    // 注意：不能按「帧数 × 间隔」推算进度 —— Windows 定时器实际精度约 15.6ms，
    // 固定步进会让 150ms 的动画跑成 210ms+。这里用真实时间轴驱动：
    // 进度 = (now - t0) / dur，定时器只负责「尽快再来一帧」，因此
    // 无论机器快慢，动画时长都恰好是 dur，慢机器表现为帧数少而不是变慢。
    const fpsCfg = Math.max(20, Math.min(120, parseInt(st.smart.animFps, 10) || 60));
    const dur = 150;
    const interval = Math.max(8, Math.round(1000 / fpsCfg));
    let lastKey = ''; // 上一帧实际应用的尺寸：重复帧不再调用 setBounds（省一次合成器 resize）
    const t0 = process.uptime() * 1000;
    let lastTs = t0;
    let done = false;
    perfAnim.s.animations += 1;
    const finish = () => {
      if (done) return;
      done = true;
      this.animTimer = null;
      const elapsed = process.uptime() * 1000 - t0;
      perfAnim.s.durationSum += elapsed;
      if (elapsed > perfAnim.s.durationMax) perfAnim.s.durationMax = elapsed;
      this.animating = false;
      this.applyRegionIfChanged(); // 尺寸稳定后再设置圆角区域（物理像素，外扩防锯齿）
      this.pushGeomIfChanged(true); // 动画结束后补推最终几何（GPU 玻璃映射）
      this.refreshGlassAfterResize();
    };
    const step = () => {
      const frameStart = process.uptime() * 1000;
      const prog = Math.min(1, (frameStart - t0) / dur);
      const e = easeOutCubic(prog);
      const b = {
        x: Math.round(cur.x + (target.x - cur.x) * e),
        y: Math.round(cur.y + (target.y - cur.y) * e),
        width: Math.round(cur.width + (target.width - cur.width) * e),
        height: Math.round(cur.height + (target.height - cur.height) * e),
      };
      const key = `${b.x},${b.y},${b.width},${b.height}`;
      // 末帧必须应用（即使与上一帧取整后相同），否则窗口会停在离目标 1px 的位置
      if (prog >= 1 || key !== lastKey) {
        lastKey = key;
        const applyStart = process.uptime() * 1000;
        try {
          this.win.setBounds(b);
        } catch (err) {
          /* ignore */
        }
        const applyMs = process.uptime() * 1000 - applyStart;
        perfAnim.s.applySum += applyMs;
        if (applyMs > perfAnim.s.applyMax) perfAnim.s.applyMax = applyMs;
        perfAnim.s.frames += 1;
      } else {
        perfAnim.s.dupFrames += 1;
      }
      const now = process.uptime() * 1000;
      const dt = now - lastTs;
      lastTs = now;
      if (dt > 0) {
        perfAnim.s.intervalSum += dt;
        perfAnim.s.intervalCount += 1;
        if (dt > perfAnim.s.intervalMax) perfAnim.s.intervalMax = dt;
      }
      if (prog < 1) {
        // 扣除本帧耗时再定时，尽量贴目标帧间隔（定时器精度不足时退化为稍长间隔）
        this.animTimer = setTimeout(step, Math.max(0, interval - (now - frameStart)));
      } else {
        finish();
      }
    };
    step();
  }

  // ---------------- 状态机 ----------------

  setState(state) {
    if (this.dragging) return;
    const st = settings.load();
    const opacity = st.ui.opacity[state] ?? 0.92;
    const target = this.computeBounds(state, this.islandDisplay());
    this.state = state;
    if (state === 'expanded') this.expandedAt = Date.now(); // 横幅展开时刻（大屏计时起点）
    this.currentOpacity = opacity;
    this.animateBounds(target);
    this.applyRegion();
    this.sendState();
    // 大屏（纯展示）与完全透明的灵动岛：不拦截鼠标/触摸（穿透）
    const ignore = state === 'zoom' || (state === 'strip' && opacity <= 0.01);
    if (this.win && !this.win.isDestroyed()) this.win.setIgnoreMouseEvents(ignore);
    // 通知形态：优先级最高——即使全屏（穿透开启中）也要立即可交互，关闭 WS_EX_TRANSPARENT
    if (state === 'notify' && this.mousePT) {
      this.mousePT = false;
      const ptHwnd = this.getHwnd();
      if (ptHwnd && this.probe) this.probe.setMousePassthrough(ptHwnd, false);
    }
    // 状态切换后立即刷新背景感知（亮度/玻璃图），避免动画后短暂显示旧位置的模糊层或错误白边
    setTimeout(() => this.captureOnce().catch(() => {}), 250);
  }

  /** 手动切换状态并设置保持期（避免"点放大后立刻缩回"） */
  manualState(state, holdMs) {
    this.holdUntil = Date.now() + (holdMs || 0);
    this.setState(state);
  }

  /** 通知展示框随内容自适应：渲染器按字体与字数测量后上报，此处调整窗口尺寸 */
  setNotifySize(size) {
    if (!size || !(size.w > 0) || !(size.h > 0)) return;
    const w = Math.max(100, Math.min(560, Math.round(size.w)));
    const h = Math.max(60, Math.min(240, Math.round(size.h)));
    if (this.notifySize && this.notifySize.w === w && this.notifySize.h === h) return;
    this.notifySize = { w, h };
    if (this.state === 'notify' && this.win && !this.win.isDestroyed()) {
      this.animateBounds(this.computeBounds('notify', this.islandDisplay()));
    }
  }

  sendState() {
    this.send('island:state', this.getStatePayload());
  }

  /**
   * 按「活跃度」决定探针采样节奏 —— 探针是 PowerShell 子进程，每次采样都要
   * 枚举窗口/读光标，是静止时最大的 CPU 开销来源。分档：
   *   350ms  活跃：正在显示通知 / 拖拽中 / 光标在小岛上 / 3 秒内有过输入
   *   700ms  常规：默认（通知延迟 ≤0.7 秒，肉眼无感）
   *   1050ms 节能：全屏隐藏期间（用轻量探测，跳过通知枚举）或已关闭通知接管
   * 采样变慢只影响「发现输入/全屏/通知」的时延，不影响动画与渲染。
   */
  requestProbe() {
    if (!this.probe) return;
    const now = Date.now();
    const smart = settings.load().smart;
    const active = this.state === 'notify' || this.dragging || this.lastOverPill || now - this.lastInputAt < 3000;
    let every;
    let lite = false;
    if (this.autoHidden) {
      every = 1050;
      lite = true; // 隐藏期间不需要通知枚举
    } else if (active) {
      every = 350;
    } else if (smart.notifyEnabled === false) {
      every = 1050;
    } else {
      every = 700;
    }
    if (now - this.lastProbeAt < every) return;
    this.lastProbeAt = now;
    perfProbe.s.requests += 1;
    if (lite) perfProbe.s.lite += 1;
    this.probe.request(lite);
  }

  broadcastEvents() {
    const st = settings.load();
    this.send('island:events', {
      events: st.events,
      ui: {
        showSeconds: st.ui.showSeconds,
        showPast: st.ui.showPast,
        dayRounding: st.ui.dayRounding || 'floor',
        cycleEnabled: st.smart.cycleEnabled,
        cycleSec: st.smart.cycleSec,
        classical: !!st.ui.classical,
        stripStyle: st.ui.stripStyle === 'glass' ? 'glass' : 'black',
        notifyShake: st.smart.notifyShake !== false,
        // 玻璃高光强度（%）：CPU/GPU 两条链路与 CSS 表面光影统一按此系数缩放
        glassGlow: typeof st.ui.glassGlow === 'number' ? st.ui.glassGlow : 100,
        // GPU 液态玻璃刷新帧率（只对 webgl 模式生效）
        gpuGlassFps: typeof st.ui.gpuGlassFps === 'number' ? st.ui.gpuGlassFps : 30,
        // GPU 液态玻璃观感微调（%）：边缘高光 / 底部阴影 / 折射强度 / 折射范围（只影响 GPU 着色器）
        glEdgeGlow: typeof st.ui.glEdgeGlow === 'number' ? st.ui.glEdgeGlow : 100,
        glBottomShade: typeof st.ui.glBottomShade === 'number' ? st.ui.glBottomShade : 100,
        glRefract: typeof st.ui.glRefract === 'number' ? st.ui.glRefract : 100,
        glBand: typeof st.ui.glBand === 'number' ? st.ui.glBand : 100,
     },
    });
  }

  tick() {
    if (!this.win || this.win.isDestroyed() || this.dragging || this.paused || this.animating) return;
    this.requestProbe();
    this.pushGeomIfChanged(); // 窗口移动/缩放时给 GPU 玻璃增量推送几何
    const st = settings.load();
    const s = st.smart;
    const mode = st.manual.mode;
    const p = this.probe ? this.probe.last : null;
    const disp = this.islandDisplay(); // 小岛在哪块屏，就用哪块屏判断遮挡
    const wa = disp.workArea;
    const db = disp.bounds;
    const b = this.win.getBounds();

    // —— 全屏授课检测（真全屏盖住任务栏区域；最大化窗口不会）——
    let occluded = false;
    let maximized = false;
    // 桌面/外壳窗口（壁纸、任务栏等）不算全屏遮挡：否则桌面上会被误判为"全屏锁定"
    const fgClass = p && typeof p.fgClass === 'string' ? p.fgClass : '';
    const isDesktopShell = ['Progman', 'WorkerW', 'SHELLDLL_DefView', 'Shell_TrayWnd', 'Shell_SecondaryTrayWnd'].includes(fgClass);
    if (p && p.rect && p.pid && p.pid !== process.pid && !isDesktopShell) {
      const sc = disp.scaleFactor;
      const l = p.rect.l / sc;
      const t = p.rect.t / sc;
      const r = p.rect.r / sc;
      const bo = p.rect.b / sc;
      const wPx = r - l;
      const hPx = bo - t;
      // 边缘容差 4px：兼容电视过扫描/安全区黑边
      occluded =
        p.vis &&
        wPx >= db.width * 0.98 &&
        hPx >= db.height * 0.98 &&
        l <= db.x + 4 &&
        t <= db.y + 4 &&
        r >= db.x + db.width - 4 &&
        bo >= db.y + db.height - 4;
      // 最大化：覆盖工作区 ≥95% 且未达全屏（盖不住任务栏区域）
      maximized =
        !occluded &&
        p.vis &&
        wPx >= wa.width * 0.95 &&
        hPx >= wa.height * 0.95 &&
        wPx <= db.width * 1.05 &&
        hPx < db.height * 0.99;
    }
    this.fullscreen = occluded; // 全屏锁定：不允许横幅/倒计时窗口（仅灵动岛）

    // —— 智能隐藏：全屏授课/看视频/演示时彻底隐藏窗口（不只是收成小条），
    //    退出全屏自动恢复。窗口隐藏期间也跳过截屏循环（省资源）。
    //    可在配置页关闭该行为（关闭后仅收成小条 + 鼠标穿透）。
    const wantAutoHide = !!occluded && s.hideOnFullscreen !== false && mode !== 'pinned';
    if (wantAutoHide !== this.autoHidden) {
      this.autoHidden = wantAutoHide;
      if (this.win && !this.win.isDestroyed()) {
        try {
          if (wantAutoHide) {
            this.win.hide();
          } else {
            this.win.showInactive();
          }
          // 隐藏期间让渲染进程进入后台节流（定时器/重绘降频），省 CPU 与内存带宽；
          // 恢复显示时立刻关掉节流，保证动画与时钟更新即时
          if (this.win.webContents && !this.win.webContents.isDestroyed()) {
            this.win.webContents.setBackgroundThrottling(wantAutoHide);
          }
        } catch (e) {
          /* ignore */
        }
      }
    }
    // 注意：不在此处 return —— 状态机与鼠标穿透仍需正常运行
    //（采样由 captureOnce 内部根据 autoHidden 自行跳过）。

    // —— 光标：用光标所在显示器换算 DIP（混合 DPI 时更准确）——
    let cursorDIP = null;
    if (p) {
      const cdisp = this.cursorDisplay();
      cursorDIP = { x: p.cx / cdisp.scaleFactor, y: p.cy / cdisp.scaleFactor };
    }

    const cx = b.x + b.width / 2;
    // overPill 滞回：进入/退出范围可调（高级设置 hoverMargin），覆盖小岛附近悬浮
    const hm = Math.max(6, Math.min(120, parseInt(s.hoverMargin, 10) || 30));
    const overEnter =
      cursorDIP &&
      cursorDIP.x >= b.x - hm &&
      cursorDIP.x <= b.x + b.width + hm &&
      cursorDIP.y >= b.y - hm &&
      cursorDIP.y <= b.y + b.height + hm;
    const exitM = Math.max(2, Math.round(hm / 6));
    const overExit =
      cursorDIP &&
      cursorDIP.x >= b.x + exitM &&
      cursorDIP.x <= b.x + b.width - exitM &&
      cursorDIP.y >= b.y + exitM &&
      cursorDIP.y <= b.y + b.height - exitM;
    const overPill = overEnter || (this.lastOverPill && overExit);
    this.lastOverPill = !!overPill;

    // 顶边附近（贴近小岛横向范围）→ 顶出显示
    const nearTopBand =
      cursorDIP &&
      cursorDIP.y <= wa.y + 34 &&
      Math.abs(cursorDIP.x - cx) <= 160;

    // 闲置时间（GetLastInputInfo，触摸/键鼠都会刷新）：有操作 → 展开；闲置 → 收回细条
    const idleMs = p && p.li ? Math.max(0, p.tick - p.li) : 0;

    // 用户输入检测：任何输入（键/鼠/触摸）后 60 秒内不自动弹出大屏（避免"收起后又马上弹出"）
    if (p && p.li && p.li !== this.lastLi) {
      this.lastLi = p.li;
      this.zoomCooldownUntil = Date.now() + 60 * 1000;
      this.lastInputAt = Date.now(); // 记录本机看到的输入时刻（探针采样节奏用）
    }

    // —— 系统通知接管：检测新通知 / 通知显示保持 / 免打扰过期 ——
    this.handleToasts(p);
    if (this.notifyDndUntil && Date.now() > this.notifyDndUntil) this.notifyDndUntil = 0;

    if (this.state === 'notify') {
      // 通知显示期间不自动切换；超时后回到通知前的状态（鲁棒：异常则回细条）
      if (Date.now() > this.notifyUntil) {
        const back = this.notifyPrevState && this.notifyPrevState !== 'notify' ? this.notifyPrevState : 'strip';
        this.notifyPrevState = 'strip';
        this.setState(back);
      }
      return;
    }

    const holding = this.holdUntil > Date.now();
    const next = decideState({
      idleMs,
      occluded,
      maximized,
      overPill,
      state: this.state,
      mode,
      smart: s.enabled,
      hideOnMaximized: s.hideOnMaximized !== false,
      expandIdleSec: s.expandIdleSec,
      zoomIdleSec: s.zoomIdleSec || 0,
      zoomAllowed: this.zoomAllowed(),
      zoomCooldown: Date.now() < this.zoomCooldownUntil,
      holding,
      hasCountdown: this.hasCountdown(),
      expandedSinceMs: this.state === 'expanded' ? Math.max(0, Date.now() - this.expandedAt) : 0,
    });
    // 探针就绪后重试圆角区域（启动初期探针未就绪时曾回退为矩形，避免遮罩残留）
    if (!this.regionApplied && this.probe && this.probe.ready && this.probe.regionFileConsumed()) {
      this.applyRegion();
    }
    // 截屏排除自身：读回探针设置结果；未确认生效时每次 tick 重发命令
    this.checkExclude();
    if (!this.excludeApplied && this.probe && this.probe.ready) {
      this.applyExclude();
    }
    if (next && next !== this.state) {
      // 自动切换去抖：状态变化后 1 秒内不再自动切换，避免窗口"跳舞"
      const now = Date.now();
      if (now - this.lastAutoSwitch < 1000) return;
      this.lastAutoSwitch = now;
      this.setState(next);
    }

    // —— 全屏遮挡时鼠标穿透：灵动岛不挡全屏应用的触摸/点击（全屏无条件锁定，不可唤起） ——
    const wantPT = !!occluded && this.state === 'strip';
    if (wantPT !== this.mousePT) {
      this.mousePT = wantPT;
      const ptHwnd = this.getHwnd();
      if (ptHwnd && this.probe) this.probe.setMousePassthrough(ptHwnd, wantPT);
    }

    // —— 持续强制置顶：QQ 等应用的弹窗会周期性抢占顶层，每 tick 把小岛拉回最高层 ——
    if (this.win && !this.win.isDestroyed() && settings.load().ui.alwaysOnTop !== false) {
      try {
        this.win.setAlwaysOnTop(true, 'screen-saver');
      } catch (e) {
        /* ignore */
      }
    }
  }

  // ---------------- 系统通知接管 ----------------

  /** 解析 "HH:MM" → 当日分钟数；失败返回 null */
  parseHM(s) {
    try {
      const m = String(s || '').match(/^(\d{1,2}):(\d{2})$/);
      if (!m) return null;
      const h = parseInt(m[1], 10);
      const mi = parseInt(m[2], 10);
      if (h > 23 || mi > 59) return null;
      return h * 60 + mi;
    } catch (e) {
      return null;
    }
  }

  /** 当前是否在免打扰期（至下课） */
  inDnd() {
    return this.notifyDndUntil > Date.now();
  }

  /** 是否有可显示的倒计时（与渲染器 currentInfo 一致：启用中且未过期，或 showPast 时含过期） */
  hasCountdown() {
    const st = settings.load();
    let list = (st.events || []).filter((e) => e.enabled !== false);
    if (!st.ui.showPast) {
      const future = list.filter((e) => new Date(e.date).getTime() > Date.now());
      if (future.length) list = future;
    }
    return list.length > 0;
  }

  /** 当前日期的 ISO 周号（用于"几周一休"循环判定） */
  getISOWeek(d) {
    const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    const dayNum = date.getUTCDay() || 7;
    date.setUTCDate(date.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
    return Math.ceil(((date - yearStart) / 86400000 + 1) / 7);
  }

  /** 免打扰截止时间：当前时段的下课时间；无时间表/非课时 → 45 分钟后。
      多周循环按 ISO 周号取对应周课表（第 N 周是"休息周"也只代表可少排课，仍按该周课表计算） */
  computeDndUntil() {
    const st = settings.load();
    const sched = st.schedule;
    const now = new Date();
    if (sched && sched.enabled && Array.isArray(sched.weeks) && sched.weeks.length) {
      const cycle = Math.max(1, parseInt(sched.cycleWeeks, 10) || 1);
      const weekIdx = ((this.getISOWeek(now) - 1) % cycle + cycle) % cycle; // 0-based
      const week = sched.weeks[weekIdx] || sched.weeks[0];
      if (week && Array.isArray(week)) {
        const dow = (now.getDay() + 6) % 7; // 周一=0 ... 周日=6
        const day = week[dow];
        if (day && Array.isArray(day.periods) && day.periods.length) {
          const cur = now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60;
          for (const p of day.periods) {
            const s = this.parseHM(p && p.start);
            const e = this.parseHM(p && p.end);
            if (s == null || e == null) continue;
            const eAbs = e <= s ? e + 1440 : e; // 跨午夜时段（如 23:30→00:01）：结束时间在次日
            if (cur >= s && cur < eAbs) {
              const end = new Date(now);
              end.setHours(0, 0, 0, 0);
              end.setMinutes(eAbs); // 超过 1439 自动进位到次日
              return end.getTime();
            }
          }
        }
      }
    }
    return Date.now() + 45 * 60 * 1000; // 兜底：45 分钟
  }

  /** 检测探针报告中的新通知（ShellExperienceHost toast + 通用置顶小窗，如 QQ NT 气泡） */
  handleToasts(p) {
    const st = settings.load();
    if (!st.smart.notifyEnabled) return;
    const toasts = p && Array.isArray(p.toasts) ? p.toasts : [];
    const current = new Set();
    const fresh = [];
    for (const t of toasts) {
      if (typeof t !== 'string') continue;
      const hwnd = t.split('|')[0];
      if (!hwnd) continue;
      current.add(hwnd);
      // 同一 hwnd 的文本变化（QQ NT 复用气泡窗口）也视为新通知
      const known = this.lastToastSig.get(hwnd);
      if (!this.lastToasts.has(hwnd) || known !== t) fresh.push(t);
      this.lastToastSig.set(hwnd, t);
    }
    // 移除已消失的通知（同窗口再次出现时重新算新通知）
    for (const h of this.lastToasts) {
      if (!current.has(h)) {
        this.lastToasts.delete(h);
        this.lastToastSig.delete(h);
      }
    }
    for (const h of current) this.lastToasts.add(h);
    if (fresh.length) {
      const latest = fresh[fresh.length - 1];
      const parts = latest.split('|');
      const title = parts[1] || '系统通知';
      const body = parts.slice(2).join('|').trim();
      if (!this.inDnd()) this.showNotification(title, body);
    }
  }

  /** 显示系统通知（无样式黑底白字，保持一段时间）。优先级最高：全屏/最大化时也展开并可交互。
      opts: { keywords?: string[]（正文中这些词显示为红色）, btn?: {label, act}（底部操作按钮，替代免打扰按钮）, alert?: boolean（提醒类：文字高频模糊抖动） } */
  showNotification(title, body, opts) {
    const o = opts || {};
    const payload = {
      title,
      body: body || '',
      keywords: Array.isArray(o.keywords) ? o.keywords : [],
      btn: o.btn || null,
      alert: !!o.alert, // 提醒类（定时提醒/关机提醒）：文字高频模糊抖动，吸引注意
    };
    // 窗口隐藏时先恢复显示（鲁棒）
    if (this.win && !this.win.isDestroyed() && !this.win.isVisible()) this.win.show();
    const showSec = Math.max(2, settings.load().smart.notifyShowSec || 8) * 1000;
    if (this.state === 'notify') {
      // 通知显示中又来新通知：更新内容并顺延
      this.notifyUntil = Date.now() + showSec;
      this.notifyData = payload;
      this.send('island:notify', payload);
      return;
    }
    this.notifyPrevState = this.state;
    this.notifyUntil = Date.now() + showSec;
    this.notifyData = payload;
    this.send('island:notify', payload);
    this.setState('notify');
  }

  /** 收起通知，回到通知前的状态 */
  dismissNotify() {
    if (this.state !== 'notify') return;
    const back = this.notifyPrevState && this.notifyPrevState !== 'notify' ? this.notifyPrevState : 'strip';
    this.notifyPrevState = 'strip';
    this.setState(back);
  }

  // ---------------- 手动控制 ----------------

  setManual(mode) {
    settings.update({ manual: { mode } });
    // 大窗口驻留：立即切到倒计时窗口（全屏/无事件时状态机随后会拉回灵动岛）
    if (mode === 'zoom') {
      this.setState(this.zoomAllowed() && !this.fullscreen ? 'zoom' : 'expanded');
    } else {
      this.setState(mode === 'hidden' ? 'strip' : this.state === 'strip' ? 'expanded' : this.state);
    }
    this.sendState();
    this.broadcastEvents();
  }

  toggleVisible() {
    const mode = settings.load().manual.mode;
    this.setManual(mode === 'hidden' ? 'auto' : 'hidden');
  }

  onAction(a) {
    switch (a.type) {
      case 'gesture': {
        // 按住上下拖拽：向下 = 放大（倒计时窗口），向上 = 收起（灵动岛）
        const dy = a.dy || 0;
        if (dy >= 25) {
          // 全屏状态不允许其他窗口：不放大
          if (this.zoomAllowed() && !this.fullscreen) {
            this.gestureAt = Date.now(); // 拖放后短暂屏蔽 tap，防止触摸屏松手误触收回
            this.manualState('zoom', 6000);
          }
        } else if (dy <= -25) {
          this.gestureAt = Date.now();
          this.manualState('strip', 0);
        }
        break;
      }
      case 'tap':
        // 拖放手势后 400ms 内的误触 tap 忽略（希沃触摸屏松手可能产生残余点击）
        if (Date.now() - (this.gestureAt || 0) < 400) break;
        // 点击不再展开横幅：单击只收不放（横幅/倒计时窗口 → 灵动岛；灵动岛保持）
        if (this.state === 'zoom') this.manualState('strip', 0);
        else if (this.state === 'expanded') this.manualState('strip', 0);
        break;
      case 'doubleTap':
        // 双击：打开配置窗口
        if (this.openConfig) this.openConfig();
        break;
      case 'collapse':
        // ▲ 收起：回到灵动岛
        this.manualState('strip', 0);
        break;
      case 'zoom':
        // 全屏状态不允许其他窗口：不放大
        if (this.zoomAllowed() && !this.fullscreen) this.manualState('zoom', 6000);
        break;
      case 'strip':
        this.setState('strip');
        break;
      case 'dismiss':
        // 通知形态：上滑/左滑/右滑收起
        this.dismissNotify();
        break;
      case 'dnd':
        // 免打扰至下课
        this.notifyDndUntil = this.computeDndUntil();
        this.dismissNotify();
        break;
      case 'cancel-shutdown':
        // 取消自动关机（任务提醒/关机倒计时通知上的按钮）
        try {
          const tasksMod = require('./tasks');
          tasksMod.cancelShutdowns();
        } catch (e) {
          /* ignore */
        }
        break;
      case 'pin':
        this.setManual(settings.load().manual.mode === 'pinned' ? 'auto' : 'pinned');
        break;
      case 'hide':
        this.setManual('hidden');
        break;
      case 'config':
        if (this.openConfig) this.openConfig();
        break;
      case 'menu':
        this.showContextMenu();
        break;
      default:
        break;
    }
  }

  /** 最大窗口是否允许（无效果模式或用户关闭时禁用） */
  zoomAllowed() {
    const st = settings.load();
    return st.smart.zoomEnabled !== false && st.ui.glassMode !== 'off';
  }

  showContextMenu() {
    const st = settings.load();
    const mode = st.manual.mode;
    const menu = Menu.buildFromTemplate([
      { label: `当前状态：${STATE_NAMES[this.state] || this.state}`, enabled: false },
      { type: 'separator' },
      { label: '自动模式', type: 'radio', checked: mode === 'auto', click: () => this.setManual('auto') },
      { label: '固定显示', type: 'radio', checked: mode === 'pinned', click: () => this.setManual('pinned') },
      { label: '隐藏成灵动岛', type: 'radio', checked: mode === 'hidden', click: () => this.setManual('hidden') },
      { label: '大窗口驻留（常显倒计时窗口）', type: 'radio', checked: mode === 'zoom', click: () => this.setManual('zoom') },
      { type: 'separator' },
      { label: '立即放大（倒计时窗口）', enabled: this.zoomAllowed(), click: () => this.manualState('zoom', 6000) },
      { label: '收起（灵动岛）', click: () => this.setState('strip') },
      { type: 'separator' },
      { label: '打开配置…', click: () => this.openConfig && this.openConfig() },
      { type: 'separator' },
      { label: '退出', click: () => app.quit() },
    ]);
    if (this.win && !this.win.isDestroyed()) menu.popup({ window: this.win });
  }

  // ---------------- 背景感知（亮度 + 真实毛玻璃） ----------------

  effectiveGlassMode() {
    if (this.glassFailed) return 'fake';
    const m = settings.load().ui.glassMode;
    if (m === 'off') return 'off';
    if (m === 'fake') return 'fake';
    if (m === 'liquid') return 'liquid';
    // GPU 液态玻璃：渲染层取流失败/着色器编译失败 → 本次运行自动回退 CPU 液态玻璃
    if (m === 'webgl') return this.glFallback ? 'liquid' : 'webgl';
    return 'capture'; // auto / capture（模糊玻璃）
  }

  /** GPU 液态玻璃是否正在生效（渲染层取流成功且未回退） */
  glStreamActive() {
    return this.glActive === true && this.effectiveGlassMode() === 'webgl';
  }

  /**
   * 注册屏幕取流处理器：GPU 液态玻璃模式下，渲染层调用 getDisplayMedia() 时
   * 由主进程指定「小岛所在的那块显示器」作为视频源。
   */
  registerDisplayMedia() {
    if (!this.win || this.win.isDestroyed()) return;
    try {
      const ses = this.win.webContents.session;
      ses.setDisplayMediaRequestHandler(
        async (request, callback) => {
          try {
            const disp = this.islandDisplay();
            const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } });
            const src = sources.find((s) => String(s.display_id) === String(disp.id)) || sources[0];
            if (!src) {
              callback({});
              return;
            }
            callback({ video: src });
          } catch (e) {
            console.error('[island] 取流源选择失败:', e.message);
            callback({});
          }
        },
        { useSystemPicker: false }
      );
    } catch (e) {
      console.error('[island] setDisplayMediaRequestHandler 失败:', e.message);
    }
  }

  /** 亮度/截屏循环：始终运行（文字颜色自动适配 + 真实毛玻璃）。
      GPU 液态玻璃模式下渲染层自己从视频帧算亮度 → 主进程完全停止截屏（省掉整条管线）。 */
  startGlass() {
    if (this.glassTimer || !this.win) return;
    if (this.effectiveGlassMode() === 'webgl') return; // 交给渲染层，主进程不截屏
    this.glassOn = true;
    const loop = async () => {
      if (!this.glassOn || !this.win || this.win.isDestroyed()) {
        this.glassTimer = null;
        return;
      }
      if (this.effectiveGlassMode() === 'webgl') {
        // 切到 GPU 模式：停掉截屏循环（渲染层接管亮度）
        this.glassTimer = null;
        return;
      }
      try {
        await this.captureOnce();
      } catch (e) {
        this.glassFail += 1;
        if (this.glassFail >= 5) {
          this.glassFailed = true;
          this.send('island:glassmode', { mode: 'fake' });
        }
      }
      // 刷新间隔可调（高级设置 bgRefreshSec）；动画/拖拽期间加速到 800ms；灵动岛自动放宽约 1.6 倍省资源
      const baseMs = Math.max(0.4, Math.min(10, parseFloat(settings.load().smart.bgRefreshSec) || 1.6)) * 1000;
      this.glassTimer = setTimeout(
        loop,
        this.animating || this.dragging ? 800 : this.state === 'strip' ? Math.round(baseMs * 1.6) : Math.round(baseMs)
      );
    };
    loop();
  }

  stopGlass() {
    this.glassOn = false;
    if (this.glassTimer) clearTimeout(this.glassTimer);
    this.glassTimer = null;
  }

  async captureOnce() {
    if (this.capturing || this.dragging || this.animating) {
      perfCapture.s.guardSkips += 1;
      return;
    }
    if (this.autoHidden) {
      perfCapture.s.guardSkips += 1;
      return; // 智能隐藏期间（全屏）无需采样
    }
    // GPU 链路生效时截屏纯属浪费：玻璃与亮度都由渲染层从视频流里取，
    // 这里每抓一次都要主进程走一遍 desktopCapturer，窗口变化时会明显卡顿（"不跟手"）
    if (this.glStreamActive()) {
      perfCapture.s.guardSkips += 1;
      return;
    }
    this.capturing = true;
    const t0 = Date.now();
    perfCapture.s.calls += 1;
    try {
      const st = settings.load();
      const mode = this.effectiveGlassMode();
      const disp = this.islandDisplay();
      const bw = disp.bounds.width;
      const bh = disp.bounds.height;
      // 是否需要玻璃背景图：横幅/倒计时窗口需要；细条（灵动岛）在
      // 「细条样式=玻璃」时也需要（否则细条只剩描边、没有玻璃）。
      // 其余情况（黑底细条、通知、模拟/关闭）只需要背景亮度 →
      // 请求小尺寸缩略图（几十 KB 而非整屏 8MB），截屏/拷贝开销降低一个数量级。
      const stripGlass = this.state === 'strip' && st.ui.stripStyle === 'glass';
      const needGlass = (mode === 'capture' || mode === 'liquid') && (this.state === 'expanded' || this.state === 'zoom' || stripGlass);
      // 玻璃图需要「屏幕物理像素尺寸」= 1:1，保证玻璃背景与真实画面同样清晰
      // （若只请求半分辨率，放大后中心区域会发虚，看着就不像"原画"）
      const physW = disp.size ? disp.size.width : Math.round(bw * (disp.scaleFactor || 1));
      const physH = disp.size ? disp.size.height : Math.round(bh * (disp.scaleFactor || 1));
      const thumbW = needGlass ? Math.max(320, physW) : FAST_THUMB_W;
      const thumbH = needGlass ? Math.max(180, physH) : Math.round((FAST_THUMB_W * bh) / Math.max(1, bw));
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: thumbW, height: thumbH },
      });
      const tAfterSources = Date.now();
      perfCapture.s.sourcesMs += tAfterSources - t0;
      const src = sources.find((s) => String(s.display_id) === String(disp.id)) || sources[0];
      if (!src) return;
      const img = src.thumbnail;
      if (img.isEmpty()) return;
      const size = img.getSize();
      const b = this.win.getBounds();
      const rx = size.width / bw;
      const ry = size.height / bh;

      if (!needGlass) {
        // —— 快路径：只算亮度（小图） ——
        perfCapture.s.fastFrames += 1;
        const brightness = this.computeBrightness(img, b, disp, rx, ry);
        this.lastBrightness = brightness;
        this.sendBrightness(brightness);
        this.glassFail = 0;
        return;
      }

      // —— 玻璃路径：裁剪窗口区域（外扩 MARGIN 采样余量） ——
      const MARGIN = 60; // 外扩采样余量（DIP）：与 CSS --glass-gap 一致，#glass 相对窗口外扩这么多
      // #glass 元素在屏幕上的左上角（窗口左上再向左上外扩 MARGIN）
      const glassLeftDIP = b.x - MARGIN;
      const glassTopDIP = b.y - MARGIN;
      const sx0 = Math.floor((b.x - disp.bounds.x - MARGIN) * rx);
      const sy0 = Math.floor((b.y - disp.bounds.y - MARGIN) * ry);
      const sx1 = Math.ceil((b.x - disp.bounds.x + b.width + MARGIN) * rx);
      const sy1 = Math.ceil((b.y - disp.bounds.y + b.height + MARGIN) * ry);
      // 屏幕边缘处会被裁剪（窗口贴边时外扩区在屏幕外）→ 必须把实际裁剪起点
      // 回传给渲染层，否则图片按「完整外扩区」铺会产生整体错位
      const cx0 = Math.max(0, sx0);
      const cy0 = Math.max(0, sy0);
      const cx1 = Math.min(size.width, sx1);
      const cy1 = Math.min(size.height, sy1);
      if (cx1 <= cx0 || cy1 <= cy0) return;
      let cropped;
      try {
        cropped = img.crop({ x: cx0, y: cy0, width: cx1 - cx0, height: cy1 - cy0 });
      } catch (e) {
        cropped = null;
      }
      if (!cropped || cropped.isEmpty()) return;
      perfCapture.s.glassFrames += 1;
      // 亮度从裁剪图算（几百 KB），不再对整屏图 toBitmap（8MB 拷贝）
      const cropLeftDIP = cx0 / rx + disp.bounds.x;
      const cropTopDIP = cy0 / ry + disp.bounds.y;
      const cropDisp = { bounds: { x: cropLeftDIP, y: cropTopDIP } };
      const crx = cropped.getSize().width / ((cx1 - cx0) / rx);
      const cry = cropped.getSize().height / ((cy1 - cy0) / ry);
      const brightness = this.computeBrightness(cropped, b, cropDisp, crx, cry);
      this.lastBrightness = brightness;
      this.sendBrightness(brightness);

      // 背景没变就不重新编码/下发（PNG 编码 + 大字符串 IPC 是这条链路最贵的部分）。
      // 指纹取自裁剪图位图的首/中/尾采样 + 长度，桌面静止时命中率很高。
      const bmp = cropped.toBitmap();
      perfCapture.s.bitmapMs += Date.now() - tAfterSources;
      const hash = bitmapHash(bmp);
      if (hash === this.lastGlassHash) {
        perfCapture.s.unchanged += 1;
        this.glassFail = 0;
        return;
      }
      this.lastGlassHash = hash;
      perfCapture.s.encoded += 1;
      const encStart = Date.now();
      const dataUrl = cropped.toDataURL();
      perfCapture.s.encodeMs += Date.now() - encStart;
      perfCapture.s.ipcBytes += dataUrl.length;
      this.send('island:glass', {
        dataUrl,
        dispW: Math.round((cx1 - cx0) / rx),
        dispH: Math.round((cy1 - cy0) / ry),
        offX: Math.round(cropLeftDIP - glassLeftDIP),
        offY: Math.round(cropTopDIP - glassTopDIP),
      });
      this.glassFail = 0;
    } finally {
      perfCapture.s.totalMs += Date.now() - t0;
      const took = Date.now() - t0;
      if (took > perfCapture.s.maxMs) perfCapture.s.maxMs = took;
      this.capturing = false;
    }
  }

  /** 下发背景亮度：变化很小时跳过（文字颜色有滞回门限，微小抖动无意义，省 IPC 与重绘） */
  sendBrightness(brightness) {
    if (this.lastBrightnessSent >= 0 && Math.abs(brightness - this.lastBrightnessSent) < 0.012) return;
    this.lastBrightnessSent = brightness;
    this.send('island:brightness', { brightness });
  }

  /** 从缩略图计算小岛背后区域的平均亮度（0-1） */
  computeBrightness(img, b, disp, rx, ry) {
    try {
      const size = img.getSize();
      const bitmap = img.toBitmap(); // BGRA
      const x0 = Math.max(0, Math.floor((b.x - disp.bounds.x) * rx));
      const y0 = Math.max(0, Math.floor((b.y - disp.bounds.y) * ry));
      const w = Math.min(size.width - x0, Math.ceil(b.width * rx));
      const h = Math.min(size.height - y0, Math.ceil(b.height * ry));
      if (w <= 0 || h <= 0) return 0.5;
      let sum = 0;
      let n = 0;
      // 采样步长随区域大小自适应：小图（快路径亮度）逐像素，大图稀疏采样，
      // 采样点数量基本恒定（≈ 60×60），保证平均值稳定且开销可控
      const step = Math.max(1, Math.round(Math.max(w, h) / 60));
      for (let y = y0; y < y0 + h; y += step) {
        for (let x = x0; x < x0 + w; x += step) {
          const i = (y * size.width + x) * 4;
          if (i + 2 >= bitmap.length) continue;
          const bval = bitmap[i];
          const g = bitmap[i + 1];
          const r = bitmap[i + 2];
          sum += (0.299 * r + 0.587 * g + 0.114 * bval) / 255;
          n += 1;
        }
      }
      return n > 0 ? sum / n : 0.5;
    } catch (e) {
      return 0.5;
    }
  }

  applyGlass(deferMs) {
    const mode = this.effectiveGlassMode();
    this.glassFailed = false;
    this.send('island:glassmode', { mode, noGeomCheck: !!process.env.SCI_GL_NO_GEOM_CHECK });
    // GPU 液态玻璃：主进程完全不截屏（亮度由渲染层从视频帧算），停掉截屏循环
    if (mode === 'webgl') {
      this.stopGlass();
      return;
    }
    // 其它模式：亮度循环始终运行；deferMs > 0 时延后启动（启动阶段把 I/O 让给首帧渲染）
    if (deferMs > 0) {
      clearTimeout(this.glassStartTimer);
      this.glassStartTimer = setTimeout(() => {
        this.glassStartTimer = null;
        this.startGlass();
      }, deferMs);
    } else {
      this.startGlass();
    }
  }

  /** 渲染层 GPU 玻璃链路回报（亮度 / 取流状态 / 回退 / 统计） */
  handleGlReport(d) {
    if (!d || typeof d !== 'object') return;
    if (d.type === 'brightness') {
      if (typeof d.brightness === 'number') {
        this.lastBrightness = d.brightness;
        this.glBrightnessCount = (this.glBrightnessCount || 0) + 1;
      }
      return;
    }
    if (d.type === 'started') {
      this.glActive = true;
      this.glError = '';
      this.stopGlass(); // 渲染层接管：主进程不再截屏
      return;
    }
    if (d.type === 'stopped') {
      this.glActive = false;
      this.startGlass();
      return;
    }
    if (d.type === 'stats') {
      this.glStats = d.stats || null;
      return;
    }
    if (d.type === 'fallback') {
      this.glActive = false;
      this.glError = String(d.reason || 'unknown');
      if (this.effectiveGlassMode() !== 'liquid') {
        this.glFallback = true; // 本次运行回退 CPU 液态玻璃（不改用户设置）
        console.warn('[island] GPU 液态玻璃不可用，回退 CPU 液态玻璃:', this.glError);
        this.applyGlass();
        this.broadcastEvents();
      }
      return;
    }
  }

  /** 窗口移动/尺寸变化时增量推送几何（GPU 玻璃的画布→屏幕映射依赖它）。
      force=true 时忽略「模式/键值未变」的短路（动画结束后必须补推一次最终位置）。 */
  pushGeomIfChanged(force) {
    if (!this.win || this.win.isDestroyed()) return;
    if (!force && this.effectiveGlassMode() !== 'webgl') return;
    const g = this.geomPayload();
    if (!g) return;
    const key = `${g.win.x},${g.win.y},${g.win.width},${g.win.height},${g.disp.x},${g.disp.y},${g.scale}`;
    if (!force && key === this.lastGeomKey) return;
    this.lastGeomKey = key;
    this.send('island:geom', g);
  }

  // ---------------- 生命周期 ----------------

  applySettings() {
    const st = settings.load();
    if (this.win && !this.win.isDestroyed()) {
      // screen-saver = Electron 最高置顶层级：不被 QQ 等应用的窗口/弹窗盖住
      this.win.setAlwaysOnTop(st.ui.alwaysOnTop, 'screen-saver');
    }
    this.setState(this.state); // 重新计算位置/尺寸/透明度
    this.applyGlass();
    this.broadcastEvents();
  }

  bindDisplayEvents() {
    if (this.displaysBound) return;
    this.displaysBound = true;
    screen.on('display-added', () => this.applySettings());
    screen.on('display-removed', () => this.applySettings());
    screen.on('display-metrics-changed', () => this.applySettings());
  }

  async create() {
    const st = settings.load();
    const disp = this.positionDisplay();
    const bounds = this.computeBounds('expanded', disp); // 启动即放大版（默认窗口）
    this.expandedAt = Date.now(); // 窗口以横幅形态创建：大屏计时从此刻起
    this.win = new BrowserWindow({
      ...bounds,
      show: false,
      frame: false,
      transparent: true,
      resizable: false,
      movable: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      hasShadow: false,
      alwaysOnTop: st.ui.alwaysOnTop,
      focusable: false,
      backgroundColor: '#00000000',
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload', 'island-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
        spellcheck: false,   // 不加载拼写检查词典（省渲染进程内存）
        enableWebSQL: false,
        v8CacheOptions: 'code', // 预编译 JS 缓存：二次启动省去解析/编译
      },
    });
    this.win.setAlwaysOnTop(true, 'screen-saver');
    // 截屏排除自身：Electron 的 setContentProtection 在 Windows 上即
    // SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)，由主进程（窗口所属进程）
    // 调用才有效——探针子进程跨进程调用会失败。效果：本窗口在屏幕捕获中"消失"，
    // 截屏拍到的是窗口背后的真实像素。一次设置持续生效，无需每次截屏隐藏窗口，
    // 因此不会闪烁，也不会出现自己的重影。
    try {
      this.win.setContentProtection(true);
    } catch (e) {
      console.error('[island] setContentProtection 失败:', e.message);
    }
    this.win.on('show', () => {
      // 窗口重新 show 后重新断言（部分系统组合会重置该标志）
      try {
        this.win.setContentProtection(true);
      } catch (e) {
        /* ignore */
      }
    });
    this.win.on('closed', () => {
      this.win = null;
      if (!this.quitting) {
        setTimeout(() => this.create(), 1000);
      }
    });
    this.win.webContents.on('render-process-gone', () => {
      // 渲染进程崩溃：重建窗口（鲁棒性）
      if (!this.quitting && this.win) {
        this.win.destroy();
      }
    });
    // 等首帧真正绘制完成再显示窗口（避免先出现一个空白/半成品帧）。
    // 注意：不 await —— 显示时机不应拖慢主进程后续初始化（探针启动等）。
    let shown = false;
    const show = () => {
      if (shown) return;
      shown = true;
      perf.mark('first-shown');
      if (this.win && !this.win.isDestroyed()) this.win.showInactive();
    };
    this.win.once('ready-to-show', show);
    const showFallback = setTimeout(show, 500); // 兜底：ready-to-show 未触发也要显示
    this.win.once('closed', () => clearTimeout(showFallback));
    await this.win.loadFile(path.join(__dirname, '..', 'renderer', 'island', 'index.html'));
    perf.mark('did-finish-load');
    // 截屏排除自身（WDA_EXCLUDEFROMCAPTURE，Win10 2004+ 支持）
    this.applyExclude();
    this.applyRegion();
    this.broadcastEvents();
    this.sendState();
    this.tickTimer = setInterval(() => this.tick(), 350);
    // GPU 液态玻璃：渲染层 getDisplayMedia() 的取流源由主进程指定（小岛所在显示器）
    this.registerDisplayMedia();
    // 玻璃/亮度采样循环延后启动：首帧显示时不做整屏截屏（把启动 I/O 让给首帧）
    this.applyGlass(450);
    this.bindDisplayEvents();
  }

  /** 截屏排除自身由 Electron 的 win.setContentProtection(true) 在主进程内完成
      （见 create()）。探针子进程跨进程调用 SetWindowDisplayAffinity 会失败，
      故此处保留为兼容性空实现（历史调用点仍安全）。 */
  applyExclude() {
    if (!this.win || this.win.isDestroyed()) return;
    try {
      this.win.setContentProtection(true);
    } catch (e) {
      /* ignore */
    }
  }

  /** 由 Electron API 直接管理，无需回读；保留接口以兼容历史调用 */
  checkExclude() {
    this.excludeApplied = true;
  }

  destroy() {
    this.quitting = true;
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.glassStartTimer) clearTimeout(this.glassStartTimer);
    this.glassStartTimer = null;
    this.tickTimer = null;
    this.stopGlass();
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    this.win = null;
  }
}

const island = new Island();
island.decideState = decideState; // 供测试
island.perfAnim = perfAnim; // 供 --perf 采集
island.perfCapture = perfCapture;
island.perfProbe = perfProbe;
module.exports = island;
