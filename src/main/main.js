'use strict';
const { app, Tray, Menu, nativeImage, ipcMain, BrowserWindow } = require('electron');
const os = require('os');
const path = require('path');
const fs = require('fs');
const settings = require('./settings');
const { Probe } = require('./probe');
const island = require('./island');
const config = require('./config');
const tasks = require('./tasks');
const perf = require('./perf');
const { WallpaperMaker, listImages, pickQuote, nextIndex, BUILTIN_QUOTES } = require('./wallpaper');

if (process.argv.includes('--perf')) perf.enable();
perf.mark('main-module-loaded');

// 控制台管道被关闭时（例如从 cmd 重定向运行后关闭窗口）写 stdout 会抛 EPIPE，
// 未处理时会弹“A JavaScript error occurred in the main process”崩溃窗。挂上空监听即可静默。
for (const stream of [process.stdout, process.stderr]) {
  if (stream && typeof stream.on === 'function') {
    stream.on('error', () => {});
  }
}

// 统一 userData 目录名（必须在 ready 前调用）
app.setName('SmartCounterIsland');

// 测试/截图/冒烟/性能采集模式使用隔离的 userData，绝不污染真实配置。
// 必须先把旧目录删掉：目录名带 PID，PID 会被系统复用，上一次运行留下的
// settings.json（例如某个用例改过的值）会污染下一次自检
if (process.argv.includes('--test') || process.argv.includes('--shot') || process.argv.includes('--shot-strip') || process.argv.includes('--gpu') || process.argv.includes('--smoke') || process.argv.includes('--perf')) {
  const isoDir = path.join(app.getPath('temp'), `sci-dev-${process.pid}`);
  try {
    fs.rmSync(isoDir, { recursive: true, force: true });
  } catch (e) {
    /* ignore */
  }
  app.setPath('userData', isoDir);
}
// 显式指定配置目录（性能 A/B 等场景用，优先级最高）：SCI_USER_DATA=<dir>
// 这样外部测量脚本无需触碰用户真实配置
if (process.env.SCI_USER_DATA) {
  app.setPath('userData', process.env.SCI_USER_DATA);
}

let probe = null;
let tray = null;
let trayTimer = null;
let trayClicked = false;
let wallpaper = null; // 壁纸功能（懒创建）

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => config.open());
  app.whenReady().then(main);
}

// 关闭所有窗口不退出（常驻托盘）
app.on('window-all-closed', () => {});
app.on('before-quit', () => {
  island.destroy();
  if (probe) probe.stop();
});
app.on('quit', () => {
  if (probe) probe.stop();
});

async function main() {
  app.setAppUserModelId('com.smartcounter.island');
  perf.mark('main-entry');

  probe = new Probe();

  island.init({
    probe,
    openConfig: () => config.open(),
  });

  registerIpc();
  createTray();
  perf.mark('tray-created');
  applyAutoStart();

  // 先建窗口（首帧越早出现越好），探针启动放到窗口显示之后
  try {
    await island.create();
  } catch (e) {
    console.error('[main] 灵动岛创建失败:', e);
  }
  perf.mark('island-created');

  // PowerShell 探针冷启动较重（进程创建 + 脚本编译），放到窗口显示后再拉起，
  // 避免与首帧渲染争抢 CPU/磁盘。窗口创建后到首次采样前的状态机用探针空缺数据运行
  // （tick 对 probe.last 为 null 已做保护），影响仅为 1 秒内不判定全屏/输入。
  probe.start();
  perf.mark('probe-spawned');

  // 计划任务检查：每 30 秒检查一次（时间匹配到分钟即可）
  setInterval(() => {
    try {
      tasks.checkTasks(new Date());
    } catch (e) {
      console.error('[tasks] 检查失败:', e.message);
    }
  }, 30000);

  // 壁纸功能：启动后检查一次「该不该换」，之后每 60 秒看一眼（轮换频率最低到 10 分钟）
  wallpaper = new WallpaperMaker(settings, probe);
  setTimeout(() => {
    try {
      wallpaper.maybeRotate();
    } catch (e) {
      console.error('[wallpaper] 初始化更换失败:', e.message);
    }
  }, 4000);
  setInterval(() => {
    try {
      wallpaper.maybeRotate();
    } catch (e) {
      /* ignore */
    }
  }, 60 * 1000);

  const argv = process.argv;
  if (argv.includes('--test')) runTests();
  else if (argv.includes('--perf')) runPerf();
  else if (argv.includes('--shot')) runShots();
  else if (argv.includes('--shot-strip')) runShotStrip();
  else if (argv.includes('--gpu')) runGpuDiag();
  else if (argv.some((a) => a === '--gl-lag' || a.indexOf('--gl-lag=') === 0)) runGlLag();
  else if (argv.includes('--smoke')) runSmoke();
  else if (argv.includes('--demo-notify')) runDemoNotify();
  else if (argv.some((a) => a.startsWith('--diag'))) runDiag();
}

// ---------------- 灵动岛（细条）玻璃渲染检查（--shot-strip） ----------------
// 用「细条样式=黑底」「细条样式=玻璃」「横幅（对照）」各渲染一次，输出窗口自身截图
// （webContents.capturePage，不依赖桌面截屏）与关键 DOM/样式事实，用于排查细条状态
// 下的玻璃显示问题。产物：shots/island-strip-black.png、island-strip-glass.png 等。

async function runShotStrip() {
  const fs = require('fs');
  // 打包后 main.js 在 app.asar 内，asar 里不能创建目录 → 输出到临时目录
  const outDir = app.isPackaged ? path.join(app.getPath('temp'), 'sci-shots') : path.join(__dirname, '..', '..', 'shots');
  fs.mkdirSync(outDir, { recursive: true });
  island.setPaused(true);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // 放一个 12 天后的测试事件，细条/横幅上能看到数字与单位
  const d = new Date(Date.now() + 12 * 86400000 + 3 * 3600000);
  const p2 = (n) => String(n).padStart(2, '0');
  settings.update({
    events: [
      {
        id: 'shot-strip-1',
        name: '期末考',
        emoji: '📘',
        color: '#4f7cff',
        date: `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T08:30:00`,
        enabled: true,
      },
    ],
  });
  const cases = [
    { name: 'strip-black', stripStyle: 'black' },
    { name: 'strip-glass', stripStyle: 'glass' },
    { name: 'expanded-glass', stripStyle: 'black', state: 'expanded' },
  ];
  for (const c of cases) {
    settings.update({ ui: { glassMode: 'liquid', stripStyle: c.stripStyle } });
    island.applySettings();
    island.manualState(c.state || 'strip', 60000); // 保持形态（60 秒）
    island.animating = false;
    await sleep(2200); // 等截屏推送 + 液态滤镜重建
    const dom = await island.win.webContents.executeJavaScript(`(() => {
      const g = document.getElementById('glass');
      const tint = document.getElementById('glass-tint');
      const p = document.getElementById('pill');
      const c2 = document.getElementById('content');
      return {
        state: document.body.dataset.state,
        glass: document.body.dataset.glass,
        strip: document.body.dataset.strip,
        glassDisplay: getComputedStyle(g).display,
        glassBgLen: (g.style.backgroundImage || '').length,
        glassFilter: (g.style.filter || '').slice(0, 40),
        glassClip: getComputedStyle(g).clipPath,
        tintDisplay: getComputedStyle(tint).display,
        pillBg: getComputedStyle(p).backgroundColor,
        pillRadius: getComputedStyle(p).borderRadius,
        pillSize: Math.round(p.getBoundingClientRect().width) + 'x' + Math.round(p.getBoundingClientRect().height),
        ink: document.body.dataset.ink,
        text: c2 ? c2.innerText : '',
        textColor: c2 ? getComputedStyle(c2).color : '',
      };
    })()`);
    console.log('[shot-strip]', c.name, JSON.stringify(dom));
    // 模拟亮桌面（data-ink=dark）：读取 --ink 变量本身（不读 color，避免 0.2s 过渡还没走完）
    const inkProbe = await island.win.webContents.executeJavaScript(`(() => {
      const prev = document.body.dataset.ink;
      const read = () => {
        const v = getComputedStyle(document.body).getPropertyValue('--ink').trim();
        const el = document.querySelector('.s-num') || document.querySelector('.e-num');
        return v + ' | 字号元素色=' + (el ? getComputedStyle(el).color : 'n/a');
      };
      document.body.dataset.ink = 'dark';
      const dark = read();
      document.body.dataset.ink = 'light';
      const light = read();
      document.body.dataset.ink = prev;
      return 'ink=dark -> ' + dark + ' ;; ink=light -> ' + light;
    })()`);
    console.log('[shot-strip]', c.name, inkProbe);
    const img = await island.win.webContents.capturePage();
    const file = path.join(outDir, `island-${c.name}.png`);
    fs.writeFileSync(file, img.toPNG());
    console.log('[shot-strip] png=', file);
  }
  app.exit(0);
}

// ---------------- GPU / 渲染加速诊断（--gpu） ----------------
// 输出：Chromium 各特性的加速状态（getGPUFeatureStatus）、GPU 设备信息、
// 渲染进程是否在用 GPU 光栅化（compositing / rasterization / webgl）。
// 用于确认机器是否被 Chromium 拉黑降级为软件渲染（此时合成、模糊、滤镜
// 全在 CPU 上跑，表现为 CPU 占用高、动画掉帧）。
// 运行：SmartCounterIsland.exe --gpu（结果打印到控制台并写入 %TEMP%\sci-gpu-<pid>.json）

async function runGpuDiag() {
  const out = { version: app.getVersion(), electron: process.versions.electron };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  try {
    out.featureStatus = app.getGPUFeatureStatus();
    try {
      const info = await app.getGPUInfo('basic');
      out.gpuDevice = info && info.gpuDevice ? info.gpuDevice : null;
      out.auxAttributes = info && info.auxAttributes ? { glRenderer: info.auxAttributes.glRenderer, glVendor: info.auxAttributes.glVendor, glVersion: info.auxAttributes.glVersion, isSoftwareRendering: info.auxAttributes.softwareRendering, directComposition: info.auxAttributes.directComposition } : null;
    } catch (e) {
      out.gpuInfoError = e.message;
    }
    out.commandLineSwitches = app.commandLine.getSwitchValue ? { disableGpu: app.commandLine.getSwitchValue('disable-gpu'), disableGpuCompositing: app.commandLine.getSwitchValue('disable-gpu-compositing'), useAngle: app.commandLine.getSwitchValue('use-angle') } : null;
    // 渲染进程侧：WebGL 是否可用、合成层是否走 GPU、SVG 滤镜是否被 GPU 光栅化
    if (island.win && !island.win.isDestroyed()) {
      await sleep(600);
      out.renderer = await island.win.webContents.executeJavaScript(`(() => {
        const c = document.createElement('canvas');
        const gl = c.getContext('webgl') || c.getContext('experimental-webgl');
        let glRenderer = null;
        if (gl) {
          const dbg = gl.getExtension('WEBGL_debug_renderer_info');
          glRenderer = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
        }
        const pill = document.getElementById('pill');
        const glass = document.getElementById('glass');
        return {
          webgl: !!gl,
          glRenderer,
          devicePixelRatio: window.devicePixelRatio,
          pillWillChange: pill ? getComputedStyle(pill).willChange : null,
          glassFilter: glass ? getComputedStyle(glass).filter : null,
          glassDisplay: glass ? getComputedStyle(glass).display : null,
        };
      })()`);
    }
  } catch (e) {
    out.error = e && e.message ? e.message : String(e);
  }
  console.log(JSON.stringify(out, null, 2));
  try {
    fs.writeFileSync(path.join(os.tmpdir(), `sci-gpu-${process.pid}.json`), JSON.stringify(out, null, 2), 'utf8');
  } catch (e) {
    /* ignore */
  }
  app.exit(0);
}

// ---------------- 性能采集（--perf） ----------------
// 运行：SmartCounterIsland.exe --perf
// 采集启动里程碑、内存/CPU、状态切换动画帧率、截屏管线开销，
// 写入 %TEMP%\sci-perf-<pid>.json 后退出。零依赖、可重复对比不同版本。

async function runPerf() {
  const fs = require('fs');
  const out = { version: app.getVersion(), electron: process.versions.electron, marks: [], mem: [], anim: [], capture: null };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const memSnapshot = () => {
    const metrics = app.getAppMetrics();
    let ws = 0;
    let cpu = 0;
    const procs = [];
    for (const m of metrics) {
      ws += m.memory.workingSetSize; // KB
      cpu += m.cpu.percentCPUUsage;
      procs.push({ type: m.type, wsMB: +(m.memory.workingSetSize / 1024).toFixed(1), cpu: +m.cpu.percentCPUUsage.toFixed(2) });
    }
    return { totalMB: +(ws / 1024).toFixed(1), cpuPercent: +cpu.toFixed(2), procs, mainRssMB: +(process.memoryUsage().rss / 1048576).toFixed(1) };
  };

  try {
    await sleep(5000);
    out.mem.push(Object.assign({ at: '5s' }, memSnapshot()));
    // —— 动画性能：连续状态切换，统计实际帧间隔与跳过帧 ——
    if (island.perfAnim) island.perfAnim.reset();
    const seq = ['expanded', 'zoom', 'strip', 'expanded', 'zoom', 'strip', 'expanded'];
    for (const s of seq) {
      island.animating = false;
      island.manualState(s, 0);
      const dl = Date.now() + 2000;
      while (island.animating && Date.now() < dl) await sleep(20);
      await sleep(120);
    }
    if (island.perfAnim) out.anim = island.perfAnim.report();
    // —— 同尺寸重复切换（模拟拖拽/反复收起）：验证圆角区域复用是否生效 ——
    if (island.perfAnim) island.perfAnim.reset();
    for (let i = 0; i < 5; i++) {
      island.animating = false;
      island.manualState('strip', 0);
      const dl2 = Date.now() + 1500;
      while (island.animating && Date.now() < dl2) await sleep(20);
      await sleep(80);
    }
    out.animRepeatSame = island.perfAnim ? island.perfAnim.report() : null;
    // 截屏管线在「横幅 + 液态玻璃」态测量：该状态需要玻璃背景图
    // （含整屏截取、位图指纹、PNG 编码与 IPC）
    island.animating = false;
    settings.update({ ui: { glassMode: 'liquid' } });
    island.glassFailed = false;
    island.glassFail = 0;
    island.applySettings();
    island.manualState('expanded', 20000);
    await sleep(1500);
    out.effectiveGlassMode = island.effectiveGlassMode();
    // —— 截屏管线开销：8 秒内的抓取次数 / 总耗时 / 跳过次数 ——
    if (island.perfCapture) island.perfCapture.reset();
    if (island.perfProbe) island.perfProbe.reset();
    await sleep(8000);
    if (island.perfCapture) out.capture = island.perfCapture.report();
    if (island.perfProbe) out.probe = island.perfProbe.report();
    out.mem.push(Object.assign({ at: '20s' }, memSnapshot()));
    out.marks = perf.getMarks();
    const file = path.join(os.tmpdir(), `sci-perf-${process.pid}.json`);
    fs.writeFileSync(file, JSON.stringify(out, null, 2), 'utf8');
    console.log('[perf] written:', file);
    console.log(JSON.stringify({ marks: out.marks, mem: out.mem, anim: out.anim, animRepeatSame: out.animRepeatSame, capture: out.capture, probe: out.probe }));
  } catch (e) {
    console.error('[perf] 采集失败:', e && e.stack ? e.stack : e);
  }
  app.exit(0);
}

// ---------------- 玻璃链路诊断（真机排查用） ----------------
// 运行：SmartCounterIsland.exe --diag（先退出正在运行的程序，单实例锁会挡）
// 等待数秒后把玻璃模式/截屏/渲染层各环节状态写入 %TEMP%\sci-diag-<pid>.json 并退出

async function runDiag() {
  const fs = require('fs');
  console.log('[diag] start（等待玻璃循环运行…）');
  // 诊断玻璃模式：--diag=liquid 诊断液态，--diag=webgl 诊断 GPU 液态玻璃，否则 capture
  const diagArg = process.argv.find((a) => a.startsWith('--diag'));
  const diagGlass = diagArg && diagArg.includes('webgl') ? 'webgl' : diagArg && diagArg.includes('liquid') ? 'liquid' : 'capture';
  settings.update({ ui: { glassMode: diagGlass } });
  island.applyGlass();
  await new Promise((r) => setTimeout(r, 2500));
  // 强制切到横幅（玻璃应显示的状态）等待截屏推送，再采集
  try {
    island.setPaused(true);
    island.manualState('expanded', 8000);
    island.animating = false;
    await new Promise((r) => setTimeout(r, 1500));
    island.animating = false;
  } catch (e) {
    console.error('[diag] 切横幅失败:', e.message);
  }
  const out = {};
  // 采样若干次窗口尺寸与渲染层视口，确认两者是否一致（不一致会导致玻璃映射错位）
  const samples = [];
  for (let i = 0; i < 5; i++) {
    const b = island.win && !island.win.isDestroyed() ? island.win.getBounds() : null;
    const vp = island.win && !island.win.isDestroyed() ? await island.win.webContents.executeJavaScript('[window.innerWidth, window.innerHeight]') : null;
    samples.push({ at: i * 300, bounds: b ? [b.width, b.height] : null, viewport: vp });
    await new Promise((r) => setTimeout(r, 300));
  }
  out.sizeSamples = samples;
  out.pid = process.pid;
  out.version = app.getVersion();
  out.settings_glassMode = settings.load().ui.glassMode;
  out.smart_zoomEnabled = settings.load().smart.zoomEnabled;
  try {
    out.effectiveGlassMode = island.effectiveGlassMode();
    out.glassFailed = island.glassFailed;
    out.glassFailCount = island.glassFail;
    out.state = island.state;
    out.lastBrightness = island.lastBrightness;
    out.regionApplied = island.regionApplied;
    out.excludeApplied = island.excludeApplied;
    out.glActive = island.glActive;
    out.glFallback = island.glFallback;
    out.glError = island.glError;
    out.glStats = island.glStats;
    out.hwnd = island.getHwnd ? String(island.getHwnd()) : 'n/a';
    out.bounds = island.win ? island.win.getBounds() : null;
    out.contentBounds = island.win ? island.win.getContentBounds() : null;
    out.dispScale = island.islandDisplay ? island.islandDisplay().scaleFactor : null;
  } catch (e) {
    out.mainErr = String(e);
  }
  try {
    const dom = await island.win.webContents.executeJavaScript(`(() => {
      const g = document.getElementById('glass');
      const t = document.getElementById('glass-tint');
      const p = document.getElementById('pill');
      const r = (el) => el ? Math.round(el.getBoundingClientRect().width) + 'x' + Math.round(el.getBoundingClientRect().height) : 'no-el';
      return {
        dataGlass: document.body.dataset.glass,
        dataState: document.body.dataset.state,
        dataAnim: document.body.dataset.anim,
        hasLiquidGlass: !!window.LiquidGlass,
        glassDisplay: g ? getComputedStyle(g).display : 'no-el',
        glassRect: r(g),
        glassBgLen: g ? (g.style.backgroundImage || '').length : 0,
        glassFilter: g ? (g.style.filter || getComputedStyle(g).filter || '') : '',
        glassClip: g ? getComputedStyle(g).clipPath : '',
        tintDisplay: t ? getComputedStyle(t).display : 'no-el',
        hasLgSvg: !!document.getElementById('lg-svg'),
        dispHrefLen: (document.getElementById('lg-disp') && document.getElementById('lg-disp').getAttribute('href') || '').length,
        bleedHrefLen: (document.getElementById('lg-bleed') && document.getElementById('lg-bleed').getAttribute('href') || '').length,
        specHrefLen: (document.getElementById('lg-spec') && document.getElementById('lg-spec').getAttribute('href') || '').length,
        pillRect: p ? (() => { const b = p.getBoundingClientRect(); return [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)]; })() : null,
        glassTag: g ? g.tagName : 'no-el',
        glassCssSize: g ? (g.style.width || '') + '/' + (g.style.height || '') : '',
        glassBacking: g && g.tagName === 'CANVAS' ? g.width + 'x' + g.height : 'n/a',
        pillCss: p ? (() => { const cs = getComputedStyle(p); return { position: cs.position, left: cs.left, top: cs.top, right: cs.right, bottom: cs.bottom, radius: cs.borderRadius, offsetParent: p.offsetParent ? p.offsetParent.id || p.offsetParent.tagName : 'none' }; })() : null,
        viewport: [window.innerWidth, window.innerHeight],
        clientSize: [document.documentElement.clientWidth, document.documentElement.clientHeight],
        visualScale: window.visualViewport ? window.visualViewport.scale : 'n/a',
        screenSize: [window.screen.width, window.screen.height],
        dpr: window.devicePixelRatio,
        glActive: !!(window.GlassWebGL && window.GlassWebGL.isActive()),
        glStats: window.GlassWebGL && window.GlassWebGL.isActive() ? window.GlassWebGL.stats() : null,
        glCanvas: (() => {
          const c = document.getElementById('glass-gl');
          if (!c) return null;
          const b = c.getBoundingClientRect();
          return { display: getComputedStyle(c).display, backing: c.width + 'x' + c.height, css: Math.round(b.width) + 'x' + Math.round(b.height), offset: [Math.round(b.left), Math.round(b.top)] };
        })(),
      };
    })()`);
    out.dom = dom;
  } catch (e) {
    out.domErr = String(e && e.stack ? e.stack : e);
  }
  const file = path.join(os.tmpdir(), `sci-diag-${process.pid}.json`);
  try {
    fs.writeFileSync(file, JSON.stringify(out, null, 2), 'utf8');
    console.log('[diag] 结果已写入:', file);
  } catch (e) {
    console.error('[diag] 写文件失败:', e.message);
  }
  console.log('[diag]', JSON.stringify(out));
  app.exit(0);
}

// ---------------- 通知演示模式（只测通知，延长显示时间便于观察抖动特效） ----------------

async function runDemoNotify() {
  console.log('[demo] 通知演示：将连续显示 3 条通知（各顺延 30 秒），可随时滑动收起');
  // 拉长通知显示时长便于观察
  settings.update({ smart: { notifyShowSec: 30 } });
  island.applySettings();
  await new Promise((r) => setTimeout(r, 1500));
  island.showNotification('测试应用', '这是一条测试通知内容，观察文字的左右震动与拖泥带水的模糊感');
  await new Promise((r) => setTimeout(r, 9000));
  island.showNotification('测试应用', '第二条通知：内容变化后同样生效，震动与拖影更明显');
  await new Promise((r) => setTimeout(r, 9000));
  island.showNotification('定时提醒', '提醒类通知：关键词【关机】红色显示', { keywords: ['关机'] });
  await new Promise((r) => setTimeout(r, 14000));
  console.log('[demo] 演示结束');
  app.exit(0);
}

/** 开机自启：直接读写 HKCU\...\Run（可读回真实状态，配置页勾选框据此显示）。
    便携版运行时被 NSIS 解压到 %TEMP% 随机目录执行，process.execPath 指向
    临时路径，注册了也起不来；electron-builder 为便携版注入
    PORTABLE_EXECUTABLE_FILE（原始 exe 路径），自启应指向它。 */
const AUTOSTART_VALUE = 'SmartCounterIsland';
// 旧版本用 Electron 原生 API 写入的项名（关闭时一并清理，避免残留）
const AUTOSTART_LEGACY = ['smart-counter-island', 'Smart Counter Island', 'Liquid Glass Counter'];
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const RUN_APPROVED_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run';

function autoStartExe() {
  return process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
}

function reg(args) {
  const { execFileSync } = require('child_process');
  return execFileSync('reg', args, { encoding: 'utf8', windowsHide: true });
}

/** 读回真实的自启状态：注册表里有项且没被「任务管理器 → 启动」禁用 */
function readAutoStart() {
  const expected = autoStartExe();
  const out = { enabled: false, path: '', expected, matches: false, blocked: false };
  try {
    const txt = reg(['query', RUN_KEY]);
    for (const line of String(txt).split(/\r?\n/)) {
      const m = line.match(/^\s{2,}(\S.*?)\s{4,}REG_SZ\s{4,}(.*)$/);
      if (!m) continue;
      const name = m[1].trim();
      if (name !== AUTOSTART_VALUE && !AUTOSTART_LEGACY.includes(name)) continue;
      const value = m[2].trim().replace(/^"|"$/g, '');
      if (!value) continue;
      out.path = value;
      out.enabled = true;
    }
  } catch (e) {
    /* 键不存在 → 未启用 */
  }
  if (out.enabled) {
    try {
      const txt = reg(['query', RUN_APPROVED_KEY]);
      for (const line of String(txt).split(/\r?\n/)) {
        const m = line.match(/^\s{2,}(\S.*?)\s{4,}REG_BINARY\s{4,}([0-9A-Fa-f ]+)/);
        if (!m) continue;
        const name = m[1].trim();
        if (name !== AUTOSTART_VALUE && !AUTOSTART_LEGACY.includes(name)) continue;
        const flag = parseInt(m[2].trim().split(/\s+/)[0], 16);
        if (flag === 3) {
          out.blocked = true;
          out.enabled = false;
        }
      }
    } catch (e) {
      /* 无该项 = 未被禁用 */
    }
  }
  out.matches = out.enabled && out.path.toLowerCase() === expected.toLowerCase();
  return out;
}

function removeAutoStartValue(name) {
  try {
    reg(['delete', RUN_KEY, '/v', name, '/f']);
  } catch (e) {
    /* 不存在 */
  }
  try {
    reg(['delete', RUN_APPROVED_KEY, '/v', name, '/f']);
  } catch (e) {
    /* 不存在 */
  }
}

/** 写字册表项；返回写入后的真实状态 */
function writeAutoStart(on) {
  const names = [AUTOSTART_VALUE].concat(AUTOSTART_LEGACY);
  try {
    if (on) {
      names.forEach((n) => {
        if (n !== AUTOSTART_VALUE) removeAutoStartValue(n);
      });
      reg(['add', RUN_KEY, '/v', AUTOSTART_VALUE, '/t', 'REG_SZ', '/d', `"${autoStartExe()}"`, '/f']);
      // 清掉「任务管理器 → 启动」里的禁用标记，否则系统会继续拦着
      try {
        reg(['delete', RUN_APPROVED_KEY, '/v', AUTOSTART_VALUE, '/f']);
      } catch (e) {
        /* 没有该标记 */
      }
    } else {
      names.forEach(removeAutoStartValue);
      try {
        app.setLoginItemSettings({ openAtLogin: false });
      } catch (e) {
        /* ignore */
      }
    }
  } catch (e) {
    console.error('[main] 开机自启设置失败:', e.message);
  }
  return readAutoStart();
}

/** 启动/设置变化时对齐真实状态（只在需要时动注册表） */
function applyAutoStart() {
  const wanted = !!settings.load().ui.autoStart;
  const cur = readAutoStart();
  if (wanted === cur.enabled && (wanted === false || cur.matches)) return cur;
  return writeAutoStart(wanted);
}

// ---------------- GPU 玻璃「跟手」诊断 ----------------

/** 大窗口（zoom）下采样 GPU 玻璃的绘制节奏与每帧成本，用真实设置但不改设置 */
async function runGlLag() {
  const secs = 12;
  const label = island.effectiveGlassMode();
  console.log(`[gl-lag] 玻璃模式=${label} 帧率设置=${settings.load().ui.gpuGlassFps}fps 显示器=${JSON.stringify(island.islandDisplay().size)} 缩放=${island.islandDisplay().scaleFactor}`);
  if (label !== 'webgl') console.log('[gl-lag] 当前不是 GPU 液态玻璃（把「玻璃效果」改成液态玻璃（GPU 加速）再跑）');
  island.manualState('zoom', (secs + 4) * 1000);
  let prev = null;
  for (let t = 2; t <= secs; t += 2) {
    await new Promise((r) => setTimeout(r, 2000));
    const s = island.glStats || {};
    const dDraws = prev ? s.draws - prev.draws : s.draws;
    const dFrames = prev ? s.frames - prev.frames : s.frames;
    prev = { draws: s.draws, frames: s.frames };
    console.log(
      `[gl-lag] t=${t}s 2秒内 流=${dFrames} 画=${dDraws}(${Math.round(dDraws / 2)}fps) 跳=${s.skips || 0} ` +
        `上传=${s.uploadMs}ms 着色=${s.drawMs}ms 采集帧率=${s.arrivalFps}fps 节流=${s.minIntervalMs}ms(目标${s.targetFps}fps) 帧间隔=${s.gapMs}/${s.gapMaxMs}ms 采集=${s.videoW}x${s.videoH} 裁剪=${s.crop} 画布=${s.backing} ` +
        `窗口宽=${island.win ? island.win.getBounds().width : 0} 宽度重设=${island.zoomWidthChanges || 0} 动画=${island.perfAnim ? island.perfAnim.s.animations : 'n/a'} 主进程截屏=${island.perfCapture ? island.perfCapture.s.calls : 'n/a'}`
    );
  }
  const s = island.glStats || {};
  const perFrame = (s.uploadMs || 0) + (s.drawMs || 0);
  console.log(
    `[gl-lag] 结论：每帧自算成本≈${perFrame.toFixed(2)}ms（上传 ${s.uploadMs} + 着色 ${s.drawMs}），` +
      `采集下发 ${s.arrivalFps}fps，实际绘制间隔 ${s.gapMs}ms（最大 ${s.gapMaxMs}ms）；` +
      (perFrame < 3 ? '自算成本可忽略 → 瓶颈在屏幕采集下发帧率' : '自算成本偏高 → 瓶颈在着色/上传')
  );
  app.exit(0);
}

// ---------------- 界面截图（开发验证用） ----------------

async function runShots() {
  const fs = require('fs');
  const { screen } = require('electron');
  const d = screen.getPrimaryDisplay();
  console.log('[shot] display bounds=', JSON.stringify(d.bounds), 'workArea=', JSON.stringify(d.workArea), 'scale=', d.scaleFactor);
  console.log('[shot] probe=', JSON.stringify(probe.last));
  const outDir = path.join(__dirname, '..', 'shots');
  fs.mkdirSync(outDir, { recursive: true });
  island.setPaused(true); // 冻结状态机，避免 tick 抢占状态
  await new Promise((r) => setTimeout(r, 1500)); // 等渲染器就绪
  for (const st of ['strip', 'expanded', 'zoom']) {
    island.setState(st);
    await new Promise((r) => setTimeout(r, 300));
    console.log('[shot:mid]', st, 'state=' + island.state, 'bounds=' + JSON.stringify(island.win.getBounds()));
    await new Promise((r) => setTimeout(r, 400));
    const b = island.win.getBounds();
    const dom = await island.win.webContents.executeJavaScript(
      `({ state: document.body.dataset.state, text: document.getElementById('content').innerText.trim(), btnOpacity: getComputedStyle(document.getElementById('buttons')).opacity, glassDisplay: getComputedStyle(document.getElementById('glass')).display, glassBg: (document.getElementById('glass').style.backgroundImage||'').slice(0,30), zNum: document.querySelector('.z-num') ? getComputedStyle(document.querySelector('.z-num')).fontSize : 'n/a', zMidH: document.querySelector('.z-mid') ? Math.round(document.querySelector('.z-mid').getBoundingClientRect().height) : 0, zCardH: document.querySelector('.z-card') ? Math.round(document.querySelector('.z-card').getBoundingClientRect().height) : 0 })`
    );
    console.log('[shot]', st, 'state=' + island.state, 'bounds=' + JSON.stringify(b), 'dom=', JSON.stringify(dom));
    const img = await island.win.webContents.capturePage();
    fs.writeFileSync(path.join(outDir, `island-${st}.png`), img.toPNG());
  }
  // 真实玻璃 + 大窗口（保持暂停，等一次截屏模糊刷新）
  settings.upsertEvent({ id: 'shot-gaokao', name: '高考', date: '2099-06-07T00:00:00', emoji: '🎓', color: '#4f7cff', enabled: true });
  island.broadcastEvents();
  island.manualState('zoom', 6000);
  await new Promise((r) => setTimeout(r, 2200));
  const img2 = await island.win.webContents.capturePage();
  fs.writeFileSync(path.join(outDir, 'island-zoom-glass.png'), img2.toPNG());
  const zdom = await island.win.webContents.executeJavaScript(
    `({ text: document.getElementById('content').innerText.trim().slice(0, 40), zNum: document.querySelector('.z-num') ? getComputedStyle(document.querySelector('.z-num')).fontSize : 'n/a', zMidH: document.querySelector('.z-mid') ? Math.round(document.querySelector('.z-mid').getBoundingClientRect().height) : 0, zCardH: document.querySelector('.z-card') ? Math.round(document.querySelector('.z-card').getBoundingClientRect().height) : 0, glassParent: (document.getElementById('glass').parentElement || {}).id, glassDisp: getComputedStyle(document.getElementById('glass')).display, tintDisp: getComputedStyle(document.getElementById('glass-tint')).display, pillOverflow: getComputedStyle(document.getElementById('pill')).overflow, pillRadius: getComputedStyle(document.getElementById('pill')).borderRadius, glassImg: (document.getElementById('glass').style.backgroundImage || '').slice(0, 40), lgFilter: (document.getElementById('glass').style.filter || '').slice(0, 40), lgSvg: !!document.getElementById('lg-svg') })`
  );
  console.log('[shot] zoom-glass dom=', JSON.stringify(zdom), 'bounds=', JSON.stringify(island.win.getBounds()));
  // 液态玻璃滤镜构造验证（不依赖桌面截屏源）：强制调用 apply 并检查 SVG 滤镜是否就位
  const lgdom = await island.win.webContents.executeJavaScript(`(() => {
    if (!window.LiquidGlass) return { err: 'no module' };
    const g = document.getElementById('glass');
    const p = document.getElementById('pill');
    // 本机无桌面截屏源 → 玻璃未激活(display:none)；先强制显示再量尺寸
    g.style.display = 'block';
    document.body.dataset.glass = 'capture';
    const gr = g.getBoundingClientRect();
    const pr = p.getBoundingClientRect();
    const cs = getComputedStyle(p);
    const radius = Math.min(parseFloat(cs.borderRadius) || 0, Math.min(pr.width, pr.height) / 2);
    const rect = { x: pr.left - gr.left, y: pr.top - gr.top, w: pr.width, h: pr.height, r: Math.max(1, radius) };
    const ok = window.LiquidGlass.apply('lg-filter', rect);
    const svg = document.getElementById('lg-svg');
    const disp = document.getElementById('lg-disp');
    return { ok, rect: JSON.stringify(rect), glassRect: gr.width + 'x' + gr.height, hasSvg: !!svg, svgHtml: svg ? svg.outerHTML.slice(0, 260) : '', filter: g.style.filter, clipPath: getComputedStyle(g).clipPath, dispHref: disp ? (disp.getAttribute('href') || '').slice(0, 30) : '' };
  })()`);
  console.log('[shot] liquid-glass dom=', JSON.stringify(lgdom));
  // 系统通知渲染验证
  island.showNotification('测试应用', '这是一条测试通知内容');
  await new Promise((r) => setTimeout(r, 600));
  const ndom = await island.win.webContents.executeJavaScript(
    `({ state: document.body.dataset.state, text: document.getElementById('content').innerText.trim(), btn: !!document.querySelector('.n-btn') })`
  );
  console.log('[shot] notify dom=', JSON.stringify(ndom));
  // 输出通知各元素实测尺寸，验证「按钮 ≤ 正文、展示框随内容自适应」
  const nsize = await island.win.webContents.executeJavaScript(`(() => {
    const r = (el) => el ? Math.round(el.getBoundingClientRect().width) + 'x' + Math.round(el.getBoundingClientRect().height) : 'n/a';
    return {
      title: r(document.querySelector('.n-title')),
      body: r(document.querySelector('.n-body')),
      btn: r(document.querySelector('.n-btn')),
      hint: r(document.querySelector('.n-hint')),
      wrap: r(document.querySelector('.n-wrap')),
    };
  })()`);
  console.log('[shot] notify sizes=', JSON.stringify(nsize));
  const ncss = await island.win.webContents.executeJavaScript(`(() => {
    const g = (el, p) => el ? getComputedStyle(el)[p] : 'n/a';
    const b = document.querySelector('.n-body');
    const t = document.querySelector('.n-title');
    const btn = document.querySelector('.n-btn');
    return {
      body: g(b,'fontSize') + '/' + g(b,'lineHeight') + '/' + g(b,'display') + '/' + g(b,'fontFamily').slice(0,20),
      title: g(t,'fontSize') + '/' + g(t,'lineHeight'),
      btn: g(btn,'fontSize') + '/' + g(btn,'lineHeight') + '/' + g(btn,'height') + '/' + g(btn,'padding'),
      wrap: g(document.querySelector('.n-wrap'),'height'),
    };
  })()`);
  console.log('[shot] notify css=', JSON.stringify(ncss));
  // 验证免打扰按钮独立在弹窗下方（坐标分离）
  const ngeo = await island.win.webContents.executeJavaScript(`(() => {
    const r = (el) => { const b = el.getBoundingClientRect(); return [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)]; };
    return { pill: r(document.getElementById('pill')), dnd: r(document.getElementById('dnd-bar')), btn: r(document.querySelector('.n-btn')) };
  })()`);
  console.log('[shot] notify geo=', JSON.stringify(ngeo));
  const nimg = await island.win.webContents.capturePage();
  fs.writeFileSync(path.join(outDir, 'island-notify.png'), nimg.toPNG());
  // 长文本通知：验证宽度上限 560 与正文 2 行截断
  island.showNotification('这是一个非常长的应用名称通知标题标题标题', '这是一条非常长的通知正文内容，用于验证展示框随字数自动变化，超过两行会被截断显示省略号，宽度最大到 560 像素左右。');
  await new Promise((r) => setTimeout(r, 600));
  const nlong = await island.win.webContents.executeJavaScript(`(() => {
    const r = (el) => el ? Math.round(el.getBoundingClientRect().width) + 'x' + Math.round(el.getBoundingClientRect().height) : 'n/a';
    return { title: r(document.querySelector('.n-title')), body: r(document.querySelector('.n-body')), wrap: r(document.querySelector('.n-wrap')) };
  })()`);
  console.log('[shot] notify long sizes=', JSON.stringify(nlong), 'bounds=', JSON.stringify(island.win.getBounds()));
  // —— 方形遮罩像素诊断：检查圆角外（窗口角落）是否泄漏非透明内容 ——
  const cornerCheck = async (label, w, h) => {
    const img = await island.win.webContents.capturePage();
    const bmp = img.toBitmap();
    const sw = img.getSize().width;
    const sh = img.getSize().height;
    const px = (x, y) => {
      const i = (y * sw + x) * 4;
      return [bmp[i], bmp[i + 1], bmp[i + 2], bmp[i + 3]]; // BGRA
    };
    // 窗口内四角附近（pill 内缩 8px，圆角外区域应全透明 alpha=0）
    const pts = [
      ['TL', 3, 3], ['TR', w - 4, 3], ['BL', 3, h - 4], ['BR', w - 4, h - 4],
      ['topEdge', Math.floor(w / 2), 3],
      ['leftEdge', 3, Math.floor(h / 2)],
    ];
    const out = { label, size: sw + 'x' + sh };
    for (const [n, x, y] of pts) out[n] = px(Math.max(0, Math.min(sw - 1, x)), Math.max(0, Math.min(sh - 1, y)));
    return out;
  };
  // 回到 expanded（胶囊），玻璃强制可见后检查角落
  island.manualState('expanded', 4000);
  await new Promise((r) => setTimeout(r, 200));
  island.animating = false;
  await island.win.webContents.executeJavaScript(`(() => {
    const g = document.getElementById('glass');
    if (g) { g.style.display = 'block'; g.style.backgroundImage = 'linear-gradient(45deg, #ff0000, #00ff00, #0000ff)'; }
    document.body.dataset.glass = 'capture';
    document.body.dataset.state = 'expanded';
    // 走真实液态滤镜路径（region 限定后应无方形外溢）
    if (window.LiquidGlass) {
      const p = document.getElementById('pill');
      const gr = g.getBoundingClientRect();
      const pr = p.getBoundingClientRect();
      const cs = getComputedStyle(p);
      const radius = Math.min(parseFloat(cs.borderRadius) || 0, Math.min(pr.width, pr.height) / 2);
      window.LiquidGlass.apply('lg-filter', { x: pr.left - gr.left, y: pr.top - gr.top, w: pr.width, h: pr.height, r: Math.max(1, radius) });
    }
    return true;
  })()`);
  await new Promise((r) => setTimeout(r, 600));
  const eb = island.win.getBounds();
  const expCorner = await cornerCheck('expanded-capsule', eb.width, eb.height);
  console.log('[shot] corner-expanded=', JSON.stringify(expCorner));
  const expCss = await island.win.webContents.executeJavaScript(`({
    clip: getComputedStyle(document.getElementById('glass')).clipPath,
    pillOverflow: getComputedStyle(document.getElementById('pill')).overflow,
    pillRadius: getComputedStyle(document.getElementById('pill')).borderRadius,
  })`);
  console.log('[shot] corner-expanded-css=', JSON.stringify(expCss));
  // —— 动画中间帧捕获：从 expanded 放大到 zoom，动画中途截屏检查方形 ——
  island.manualState('expanded', 0);
  await new Promise((r) => setTimeout(r, 150));
  island.animating = false;
  island.setState('zoom'); // 触发动画
  await new Promise((r) => setTimeout(r, 70)); // 动画中段
  const midB = island.win.getBounds();
  const midImg = await island.win.webContents.capturePage();
  const mbmp = midImg.toBitmap();
  const msw = midImg.getSize().width;
  const msh = midImg.getSize().height;
  const mpx = (x, y) => {
    const i = (Math.max(0, Math.min(msh - 1, y)) * msw + Math.max(0, Math.min(msw - 1, x))) * 4;
    return [mbmp[i], mbmp[i + 1], mbmp[i + 2], mbmp[i + 3]];
  };
  const midPts = {};
  for (const [n, dx, dy] of [['TL', 3, 3], ['TR', midB.width - 4, 3], ['BL', 3, midB.height - 4], ['BR', midB.width - 4, midB.height - 4], ['topEdge', Math.floor(midB.width / 2), 3], ['leftEdge', 3, Math.floor(midB.height / 2)], ['center', Math.floor(midB.width / 2), Math.floor(midB.height / 2)]]) {
    midPts[n] = mpx(dx, dy);
  }
  console.log('[shot] mid-anim bounds=', JSON.stringify(midB), 'corner=', JSON.stringify(midPts));
  const midCss = await island.win.webContents.executeJavaScript(`({
    state: document.body.dataset.state,
    pill: (() => { const p = document.getElementById('pill').getBoundingClientRect(); return [Math.round(p.x), Math.round(p.y), Math.round(p.width), Math.round(p.height)]; })(),
    glassClip: getComputedStyle(document.getElementById('glass')).clipPath,
    pillRadius: getComputedStyle(document.getElementById('pill')).borderRadius,
    glassRect: (() => { const g = document.getElementById('glass').getBoundingClientRect(); return [Math.round(g.x), Math.round(g.y), Math.round(g.width), Math.round(g.height)]; })(),
    glassDisp: getComputedStyle(document.getElementById('glass')).display,
  })`);
  console.log('[shot] mid-anim css=', JSON.stringify(midCss));
  await new Promise((r) => setTimeout(r, 300)); // 等动画结束
  island.animating = false;
  app.exit(0);
}

// ---------------- 托盘 ----------------

function trayIconPath() {
  return path.join(__dirname, '..', 'assets', 'tray.ico');
}

function modeMenuTemplate(click) {
  const st = settings.load();
  const mode = st.manual.mode;
  return [
    { label: '自动模式（智能隐藏/放大）', type: 'radio', checked: mode === 'auto', click: () => click('auto') },
    { label: '固定显示（始终可见）', type: 'radio', checked: mode === 'pinned', click: () => click('pinned') },
    { label: '大窗口驻留显示（常显倒计时窗口）', type: 'radio', checked: mode === 'zoom', click: () => click('zoom') },
    { label: '隐藏成灵动岛', type: 'radio', checked: mode === 'hidden', click: () => click('hidden') },
  ];
}

/** 最近一次构建的托盘菜单模板（供自检断言菜单项；不参与运行逻辑） */
let lastTrayTemplate = null;

/** 壁纸动作（托盘与配置页共用）：rotate = 立即更换，restore = 恢复原壁纸 */
async function wallpaperAction(action, payload) {
  if (!wallpaper) return { ok: false, reason: 'not-ready' };
  try {
    if (action === 'rotate') {
      const r = await wallpaper.rotate(payload);
      console.log('[wallpaper] 更换结果:', JSON.stringify(r));
      return r;
    }
    if (action === 'restore') {
      const r = wallpaper.restore();
      console.log('[wallpaper] 恢复结果:', JSON.stringify(r));
      return r;
    }
  } catch (e) {
    return { ok: false, reason: String(e && e.message ? e.message : e) };
  }
  return { ok: false, reason: 'unknown-action' };
}

function trayMenu() {
  // 壁纸未启用时只给一个入口（避免误点直接把桌面壁纸换掉）
  const wpOn = settings.load().ui.wallpaper.enabled === true;
  const template = [
    ...modeMenuTemplate((m) => island.setManual(m)),
    { type: 'separator' },
    { label: '立即放大（倒计时窗口）', click: () => island.onAction({ type: 'zoom' }) },
    { label: '收起（灵动岛）', click: () => island.setState('strip') },
    { type: 'separator' },
    ...(wpOn
      ? [
          { label: '更换壁纸（壁纸功能）', click: () => wallpaperAction('rotate') },
          { label: '恢复原壁纸', click: () => wallpaperAction('restore') },
        ]
      : [{ label: '启用壁纸功能…（配置页·壁纸）', click: () => config.open() }]),
    { type: 'separator' },
    { label: '打开配置…', click: () => config.open() },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ];
  lastTrayTemplate = template;
  return Menu.buildFromTemplate(template);
}

function createTray() {
  const img = nativeImage.createFromPath(trayIconPath());
  tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img);
  tray.setToolTip('Smart Counter Island · 单击显示/隐藏 · 双击打开配置');
  // 单击：显示/隐藏；双击：打开配置窗口（用延时区分）
  tray.on('click', () => {
    trayClicked = true;
    clearTimeout(trayTimer);
    trayTimer = setTimeout(() => {
      if (trayClicked) island.toggleVisible();
      trayClicked = false;
    }, 280);
  });
  tray.on('double-click', () => {
    trayClicked = false;
    clearTimeout(trayTimer);
    config.open();
  });
  tray.on('right-click', () => trayMenu().popup());
}

// ---------------- IPC ----------------

function registerIpc() {
  ipcMain.on('island:ready', () => {
    island.broadcastEvents();
    island.sendState();
    island.applyGlass();
  });

  ipcMain.handle('island:action', (_e, action) => {
    island.onAction(action);
  });

  ipcMain.handle('island:get-state', () => island.getStatePayload());

  // 通知展示框自适应：渲染器按内容测量后上报尺寸
  ipcMain.on('island:notify-size', (_e, size) => {
    island.setNotifySize(size);
  });

  // 倒计时窗口宽度自适应：渲染器按文字内容测量后上报
  ipcMain.on('island:zoom-width', (_e, w) => {
    island.setZoomWidth(w);
  });

  // GPU 液态玻璃链路回报（视频流状态 / 亮度 / 失败回退 / 统计）
  ipcMain.on('island:gl-report', (_e, d) => {
    island.handleGlReport(d);
  });

  // —— 壁纸：立即更换 / 恢复原壁纸 / 选择图片文件夹 / 取一张预览 ——
  ipcMain.handle('wallpaper:rotate', (_e, payload) => wallpaperAction('rotate', payload));
  ipcMain.handle('wallpaper:restore', () => wallpaperAction('restore'));
  ipcMain.handle('wallpaper:pick-folder', async () => {
    const { dialog } = require('electron');
    const win = config.getWindow();
    const r = await dialog.showOpenDialog(win || undefined, { title: '选择壁纸图片文件夹', properties: ['openDirectory'] });
    if (r.canceled || !r.filePaths.length) return { ok: false };
    settings.update({ ui: { wallpaper: { folder: r.filePaths[0] } } });
    return { ok: true, folder: r.filePaths[0], count: listImages(r.filePaths[0]).length };
  });
  // 打开用户放壁纸图片的文件夹（未配置时用程序默认目录，并写一份说明文件）
  ipcMain.handle('wallpaper:open-folder', async () => {
    try {
      const { shell } = require('electron');
      const folder = wallpaper ? wallpaper.resolveFolder() : app.getPath('userData');
      const err = await shell.openPath(folder);
      return err ? { ok: false, reason: err, folder } : { ok: true, folder };
    } catch (e) {
      return { ok: false, reason: String(e && e.message ? e.message : e) };
    }
  });
  ipcMain.handle('wallpaper:preview', async (_e, override) => {
    // 用当前设置（可带临时覆盖）生成一张缩略图给配置页预览，不改桌面
    try {
      const st = settings.load();
      const w = Object.assign({}, st.ui.wallpaper, override || {});
      const disp = require('electron').screen.getPrimaryDisplay();
      const size = disp.size || { width: 1920, height: 1080 };
      const dayIndex = Math.floor(Date.now() / 86400000);
      // 与 rotate() 保持一致：folder 留空时用默认图片文件夹；预览只回传 base64，不落盘、不改桌面
      const folder = String(w.folder || '').trim();
      const useFolder = w.source !== 'gradient' ? folder || wallpaper.resolveFolder() : '';
      const images = listImages(useFolder);
      // 预览 = 「现在点立即更换会得到的那一张」：底图与语录都按轮换顺序取下一张
      const previewIdx = nextIndex(images.length, w);
      const pick = previewIdx >= 0 ? images[previewIdx] : '';
      let bgImage = null;
      if (pick) {
        const ext = path.extname(pick).toLowerCase();
        const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : ext === '.bmp' ? 'image/bmp' : 'image/jpeg';
        bgImage = `data:${mime};base64,` + fs.readFileSync(pick).toString('base64');
      }
      const qSeed = w.order === 'random' ? Math.floor(Math.random() * 1e9) : w.quoteIndex || 0;
      const previewQuote = w.quotes && w.quotes.trim() ? pickQuote(qSeed, w.quotes, w.useBuiltinQuotes !== false) : pickQuote(qSeed, '', w.useBuiltinQuotes !== false);
      const b64 = await wallpaper.renderToBase64({
        width: Math.min(1280, size.width),
        height: Math.round((Math.min(1280, size.width) * size.height) / size.width),
        quote: previewQuote,
        bgType: bgImage ? 'image' : 'gradient',
        bgColor: require('./wallpaper').GRADIENT_PRESETS[Math.abs(previewIdx >= 0 ? previewIdx : dayIndex) % require('./wallpaper').GRADIENT_PRESETS.length],
        bgImage,
        fit: w.fit === 'contain' ? 'contain' : 'cover',
        dim: typeof w.dim === 'number' ? Math.max(0, Math.min(0.7, w.dim)) : 0.32,
        scrim: w.scrim !== false,
        school: w.school || '',
        position: w.position || 'center',
        scale: w.scale || 100,
        subline: w.subline || '',
      });
      const nextIn = wallpaper.nextRotateIn();
      return {
        ok: true,
        dataUrl: 'data:image/png;base64,' + b64,
        quote: previewQuote,
        source: pick ? 'folder' : 'gradient',
        count: images.length,
        index: previewIdx >= 0 ? previewIdx + 1 : 0,
        nextIn,
      };
    } catch (e) {
      return { ok: false, reason: String(e && e.message ? e.message : e) };
    }
  });

  ipcMain.handle('config:get', () => ({
    settings: settings.load(),
    autoStart: readAutoStart(),
    meta: {
      version: app.getVersion(),
      platform: process.platform,
      osRelease: os.release(),
      electron: process.versions.electron,
    },
  }));

  ipcMain.handle('config:autostart', () => readAutoStart());

  ipcMain.handle('config:update', (_e, patch) => {
    const next = settings.update(patch);
    island.applySettings();
    applyAutoStart(); // 开机自启变化即时生效
    config.broadcastChanged();
    return next;
  });

  ipcMain.handle('config:close', () => config.close());

  ipcMain.handle('events:add', (_e, ev) => {
    settings.upsertEvent(ev);
    island.broadcastEvents();
    config.broadcastChanged();
    return settings.events();
  });

  ipcMain.handle('events:update', (_e, ev) => {
    settings.upsertEvent(ev);
    island.broadcastEvents();
    config.broadcastChanged();
    return settings.events();
  });

  ipcMain.handle('events:remove', (_e, id) => {
    settings.removeEvent(id);
    island.broadcastEvents();
    config.broadcastChanged();
    return settings.events();
  });
}

// ---------------- 冒烟测试 ----------------

function runSmoke() {
  const t0 = Date.now();
  const timer = setInterval(() => {
    if (probe.ready && probe.last) {
      console.log('[smoke] probe ok');
      clearInterval(timer);
      // 验证截屏毛玻璃链路（失败会自动回退模拟玻璃，不视为致命错误）
      setTimeout(() => {
        const t2 = Date.now();
        let glassState = 'ok';
        const g = setInterval(() => {
          if (island.glassFailed) glassState = 'fallback-fake';
          if (island.glassFailed || Date.now() - t2 > 6000) {
            clearInterval(g);
            console.log('[smoke] glass:', glassState);
            // 验证配置窗口可正常加载
            config.open();
            setTimeout(() => {
              const ok = config.isOpen() && config.isLoaded();
              console.log(ok ? '[smoke] config ok' : '[smoke] config FAIL');
              console.log('SMOKE_OK');
              app.exit(ok ? 0 : 1);
            }, 2500);
          }
        }, 500);
      }, 2500);
    } else if (Date.now() - t0 > 9000) {
      console.error('SMOKE_PROBE_FAIL');
      clearInterval(timer);
      app.exit(1);
    }
  }, 300);
}

// ---------------- 自动化测试 ----------------

function runTests() {
  const results = [];
  // 便携版（NSIS 包装）的控制台输出拿不到，自检结果同时写入
  // %TEMP%\sci-test-last.log，便于排查失败项
  const testLog = path.join(os.tmpdir(), 'sci-test-last.log');
  try {
    fs.writeFileSync(testLog, `[test] start ${new Date().toISOString()} version=${app.getVersion()}\n`, 'utf8');
  } catch (e) {
    /* ignore */
  }
  const ok = (name, cond) => {
    results.push([!!cond, name]);
    console.log(`[test] ${cond ? 'PASS' : 'FAIL'} ${name}`);
    try {
      fs.appendFileSync(testLog, `[test] ${cond ? 'PASS' : 'FAIL'} ${name}\n`, 'utf8');
    } catch (e) {
      /* ignore */
    }
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  (async () => {
    try {
      // —— T1 设置读写与位置配置 ——
      settings.update({ ui: { positions: { strip: { mode: 'top-left' } } } });
      ok('T1 位置配置写入', settings.load().ui.positions.strip.mode === 'top-left');
      settings.update({ ui: { positions: { strip: { mode: 'top-center' } } } });
      settings.update({ ui: { positions: { expanded: { mode: 'custom', x: 123, y: 45 } } } });
      ok('T1 自定义坐标写入', settings.load().ui.positions.expanded.x === 123 && settings.load().ui.positions.expanded.y === 45);
      settings.update({ ui: { positions: { expanded: { mode: 'top-center' } } } });
      settings.update({ ui: { classical: true } });
      ok('T1 文言文开关写入', settings.load().ui.classical === true);
      settings.update({ ui: { classical: false } });

      // —— T2 状态机决策（纯函数）——
      const base = {
        idleMs: 0, occluded: false, maximized: false, overPill: false,
        mode: 'auto', smart: true, hideOnMaximized: true,
        expandIdleSec: 4, zoomIdleSec: 0, zoomAllowed: true, zoomCooldown: false, holding: false, hasCountdown: true,
        state: 'expanded', expandedSinceMs: 0, // 当前处于横幅且刚展开（大屏计时从横幅展开后起算）
      };
      ok('T2 有操作→灵动岛', island.decideState(base) === 'strip');
      ok('T2 闲置5s→默认窗口横幅', island.decideState({ ...base, idleMs: 5000 }) === 'expanded');
      ok('T2 默认窗口固定横幅（不可更改）', island.decideState({ ...base, idleMs: 99999 }) === 'expanded');
      ok('T2 横幅展开15s后→自动弹出大屏', island.decideState({ ...base, zoomIdleSec: 15, idleMs: 15000, expandedSinceMs: 15000 }) === 'zoom');
      ok('T2 横幅刚展开不足15s→暂不弹大屏', island.decideState({ ...base, zoomIdleSec: 15, idleMs: 99999, expandedSinceMs: 5000 }) === 'expanded');
      ok('T2 细条闲置再久→先展开横幅（层级：横幅后大屏）', island.decideState({ ...base, zoomIdleSec: 15, state: 'strip', idleMs: 99999 }) === 'expanded');
      ok('T2 已在大屏且继续闲置→保持大屏', island.decideState({ ...base, zoomIdleSec: 15, state: 'zoom', idleMs: 99999 }) === 'zoom');
      ok('T2 大屏有操作→收回细条', island.decideState({ ...base, state: 'zoom', idleMs: 100 }) === 'strip');
      ok('T2 关闭大屏→闲置不弹大屏', island.decideState({ ...base, zoomIdleSec: 15, zoomAllowed: false, idleMs: 99999, expandedSinceMs: 99999 }) === 'expanded');
      ok('T2 全屏+闲置15s→仍锁定灵动岛', island.decideState({ ...base, zoomIdleSec: 15, idleMs: 99999, occluded: true }) === 'strip');
      ok('T2 最大化+闲置15s→保持灵动岛', island.decideState({ ...base, zoomIdleSec: 15, idleMs: 99999, maximized: true }) === 'strip');
      ok('T2 无计时时间→锁定灵动岛', island.decideState({ ...base, hasCountdown: false, idleMs: 99999 }) === 'strip');
      ok('T2 无计时时间+悬停→仍锁定', island.decideState({ ...base, hasCountdown: false, overPill: true }) === 'strip');
      ok('T2 全屏遮挡→灵动岛（无条件）', island.decideState({ ...base, occluded: true }) === 'strip');
      ok('T2 全屏+触摸→维持灵动岛（不唤起）', island.decideState({ ...base, occluded: true, overPill: true }) === 'strip');
      ok('T2 全屏+固定模式→仍锁定灵动岛', island.decideState({ ...base, mode: 'pinned', occluded: true, idleMs: 0 }) === 'strip');
      ok('T2 隐藏模式→灵动岛', island.decideState({ ...base, mode: 'hidden' }) === 'strip');
      ok('T2 隐藏模式+悬停→不唤起（悬浮不展开）', island.decideState({ ...base, mode: 'hidden', overPill: true }) === 'strip');
      ok('T2 全屏+隐藏模式→不唤起', island.decideState({ ...base, mode: 'hidden', occluded: true, overPill: true }) === 'strip');
      ok('T2 光标悬停→保持现状', island.decideState({ ...base, overPill: true }) === null);
      ok('T2 大屏悬停→不阻止收起（有操作回灵动岛）', island.decideState({ ...base, state: 'zoom', overPill: true, idleMs: 100 }) === 'strip');
      ok('T2 操作后冷却期内不自动弹大屏', island.decideState({ ...base, zoomIdleSec: 15, zoomCooldown: true, idleMs: 99999 }) === 'expanded');
      ok('T2 手动保持期→保持现状', island.decideState({ ...base, holding: true, idleMs: 99999 }) === null);
      ok('T2 关闭智能→保持现状', island.decideState({ ...base, smart: false, idleMs: 99999 }) === null);
      ok('T2 窗口最大化→保持灵动岛', island.decideState({ ...base, maximized: true, idleMs: 99999 }) === 'strip');

      // —— T3 配置窗口生命周期（核心 bug 复现）——
      config.open();
      await sleep(1500);
      ok('T3 配置窗口已打开', config.isOpen());
      ok('T3 配置窗口已加载', config.isLoaded());
      const cwin = config.getWindow();
      ok('T3 配置窗口不置顶（用户要求去掉）', !!cwin && !cwin.isAlwaysOnTop());
      const w1 = BrowserWindow.getAllWindows().length;
      ok(`T3 窗口数=2(小岛+配置) 实际=${w1}`, w1 === 2);
      config.open(); // 重复打开应复用
      await sleep(300);
      ok('T3 重复打开不新建窗口', BrowserWindow.getAllWindows().length === w1);
      config.close();
      await sleep(700);
      ok('T3 配置窗口可关闭', !config.isOpen());
      ok('T3 关闭后窗口数=1', BrowserWindow.getAllWindows().length === 1);
      config.open();
      await sleep(1500);
      ok('T3 重新打开正常', config.isOpen() && config.isLoaded());
      config.close();
      await sleep(400);

      // —— T4 事件 CRUD ——
      settings.upsertEvent({ id: null, name: '测试事件', date: '2099-01-01T00:00:00', emoji: '🎯', color: '#ff0000', enabled: true });
      const added = settings.events().find((e) => e.name === '测试事件');
      ok('T4 事件添加', !!added);
      settings.removeEvent(added.id);
      ok('T4 事件删除', !settings.events().some((e) => e.id === added.id));

      // —— T5 探针、圆角区域与截屏排除 ——
      ok('T5 系统探针就绪', probe.ready && !!probe.last);
      // 轮询等待命令文件被探针消费（安装版/低配机器探针循环可能较慢，避免偶发时序）
      const waitConsumed = async (fn, ms) => {
        const t0 = Date.now();
        while (!fn() && Date.now() - t0 < ms) await sleep(250);
        return fn();
      };
      island.applyRegion(); // 写入圆角区域命令（真实小岛窗口句柄）
      // 探针可能恰好已消费文件：写入后立即检查，若已消费则补写一次
      let regionWritten = !probe.regionFileConsumed();
      if (!regionWritten) {
        island.applyRegion();
        regionWritten = !probe.regionFileConsumed();
      }
      const regionConsumed = await waitConsumed(() => probe.regionFileConsumed(), 4000);
      ok('T5 圆角区域命令已写入并被探针执行', regionWritten && regionConsumed);
      // 截屏排除自身（WDA_EXCLUDEFROMCAPTURE）
      const hwnd = island.getHwnd();
      const exclWritten = !!hwnd && probe.setExcludeFromCapture(hwnd);
      const exclConsumed = await waitConsumed(() => probe.excludeFileConsumed(), 4000);
      ok('T5 截屏排除命令已写入并被探针执行', exclWritten && exclConsumed);
      // 鼠标穿透（WS_EX_TRANSPARENT）命令链路
      const ptOn = !!hwnd && probe.setMousePassthrough(hwnd, true);
      const ptConsumed = await waitConsumed(() => probe.passthroughFileConsumed(), 4000);
      ok('T5 鼠标穿透命令已写入并被探针执行', ptOn && ptConsumed);
      probe.setMousePassthrough(hwnd, false);
      // 圆角参数验证：CreateRoundRectRgn 需要「椭圆宽度 = 2×半径」，必须与 CSS border-radius 一致
      const origSetRegion = probe.setRegion.bind(probe);
      let captured = null;
      probe.setRegion = (h, x, y, w, hh, r) => {
        captured = { x, y, w, h: hh, r };
        return origSetRegion(h, x, y, w, hh, r);
      };
      island.setState('strip');
      await sleep(350); // 等动画完成（110ms）+ 余量，避免偶发时序
      const scale = island.islandDisplay().scaleFactor;
      // 显式重新应用一次区域并捕获：不依赖动画完成回调的时序（state 已稳定为 strip）
      captured = null;
      island.applyRegion();
      probe.setRegion = origSetRegion;
      ok(`T5 圆角参数=2×半径 (r=${captured && captured.r}, 期望=${Math.round(13 * 2 * scale)})`, captured && captured.r === Math.round(13 * 2 * scale));
      ok(`T5 圆角区域外扩防锯齿 (x=${captured && captured.x}, 期望=${Math.round((8 - 3) * scale)})`, captured && captured.x === Math.round((8 - 3) * scale));
      // 背景亮度感知
      await sleep(2000);
      ok(`T5 背景亮度感知已返回 (brightness=${island.lastBrightness.toFixed(2)})`, typeof island.lastBrightness === 'number');

      // —— T6 防跳舞：去抖 + overPill 滞回 ——
      await sleep(250); // 等窗口动画结束（animating 期间 tick 会跳过）
      island.animating = false;
      const b0 = island.win.getBounds();
      // 去抖：100ms 前刚自动切换过，此刻应拒绝再次自动切换
      island.lastAutoSwitch = Date.now() - 100;
      island.lastOverPill = false;
      island.probe.last = { ...island.probe.last, cx: b0.x - 60, cy: b0.y + 10, li: 0, tick: 30000 };
      const stateBefore = island.state;
      island.tick();
      ok('T6 去抖期内不自动切换', island.state === stateBefore);
      // 滞回：光标进入宽松边界（-9px）后，轻微移出（-3px）仍保持悬停
      island.lastAutoSwitch = 0;
      island.lastOverPill = false;
      island.probe.last = { ...island.probe.last, cx: b0.x - 9, cy: b0.y + 10 };
      island.tick();
      const h1 = island.lastOverPill;
      island.probe.last = { ...island.probe.last, cx: b0.x - 3, cy: b0.y + 10 };
      island.tick();
      ok('T6 overPill 滞回生效（边界抖动不翻转）', h1 === true && island.lastOverPill === true);

      // —— T7 配置编辑弹层开关（bug：点击取消无反应）——
      config.open();
      await sleep(1200);
      const cw = config.getWindow();
      const js = (code) => cw.webContents.executeJavaScript(code);
      const maskHidden0 = await js(`document.getElementById('editor-mask').hidden`);
      ok('T7 初始弹层隐藏', maskHidden0 === true);
      await js(`document.getElementById('btn-add-event').click()`);
      await sleep(200);
      const maskShown = await js(`!document.getElementById('editor-mask').hidden`);
      ok('T7 点添加事件弹出编辑框', maskShown === true);
      await js(`document.getElementById('btn-ev-cancel').click()`);
      await sleep(200);
      const maskHidden1 = await js(`document.getElementById('editor-mask').hidden`);
      ok('T7 点取消可关闭编辑框', maskHidden1 === true);
      // 填写后保存：应成功关闭编辑框
      await js(`document.getElementById('btn-add-event').click()`);
      await sleep(200);
      await js(`document.getElementById('ev-name').value='测试事件2'; document.getElementById('ev-date').value='2099-01-01T09:00'; document.getElementById('btn-ev-save').click()`);
      await sleep(600);
      const maskHidden2 = await js(`document.getElementById('editor-mask').hidden`);
      ok('T7 填写后保存并关闭编辑框', maskHidden2 === true);
      // 事件启用/停用后列表不消失（曾因 S 被赋成 {settings,meta} 导致列表清空）
      const itemsBefore = await js(`document.querySelectorAll('#event-list .event-item').length`);
      await js(`document.querySelector('#event-list [data-act="toggle"]')?.click()`);
      await sleep(800);
      const itemsAfter = await js(`document.querySelectorAll('#event-list .event-item').length`);
      const listHasName = await js(`document.getElementById('event-list').innerText.includes('测试事件2')`);
      ok(`T7 停用事件后列表不消失 (before=${itemsBefore}, after=${itemsAfter})`, itemsAfter === itemsBefore && itemsAfter >= 1 && listHasName);
      await js(`document.querySelector('#event-list [data-act="toggle"]')?.click()`);
      await sleep(500);
      // 暗色模式：设置切换后配置窗口 body.dark 生效
      settings.update({ ui: { darkMode: true } });
      config.broadcastChanged();
      await sleep(400);
      const darkOn = await js(`document.body.classList.contains('dark')`);
      ok('T7 暗色模式生效 (dark=' + darkOn + ')', darkOn === true);
      settings.update({ ui: { darkMode: false } });
      config.broadcastChanged();
      await sleep(400);
      const darkOff = await js(`!document.body.classList.contains('dark')`);
      ok('T7 关闭暗色模式恢复', darkOff === true);
      config.close();
      await sleep(400);

      // —— T8 文言文显示 + 无效果模式 + 亮度适配 ——
      settings.update({ ui: { classical: true } });
      island.broadcastEvents();
      await sleep(400);
      const classicalText = await island.win.webContents.executeJavaScript(`document.getElementById('content').innerText.trim()`);
      ok(`T8 文言文生效（日/時替换: ${JSON.stringify(classicalText.slice(0, 20))}）`, classicalText.includes('日') && !/天/.test(classicalText.replace('天','')));
      settings.update({ ui: { classical: false } });
      settings.update({ ui: { glassMode: 'off' } });
      island.applySettings();
      await sleep(400);
      const glassModeDom = await island.win.webContents.executeJavaScript(`document.body.dataset.glass`);
      ok(`T8 无效果模式生效 (data-glass=${glassModeDom})`, glassModeDom === 'off');
      const inkDom = await island.win.webContents.executeJavaScript(`document.body.dataset.ink`);
      ok(`T8 亮度适配生效 (data-ink=${inkDom})`, inkDom === 'light' || inkDom === 'dark');
      settings.update({ ui: { glassMode: 'auto' } });
      island.applySettings();
      await sleep(400);

      // —— T9 拖拽放大保持 + 防误触 ——
      // 桌面（Progman/WorkerW 壁纸窗口）不算全屏遮挡：闲置后应正常展开横幅
      const deskDisp = island.islandDisplay();
      const deskDb = deskDisp.bounds;
      const deskFixture = {
        ...island.probe.last,
        fgClass: 'Progman',
        rect: { l: deskDb.x, t: deskDb.y, r: deskDb.x + deskDb.width, b: deskDb.y + deskDb.height },
        pid: 1234, li: 1, tick: 1000000000,
        cx: deskDb.x + deskDb.width - 300, cy: deskDb.y + deskDb.height - 300,
      };
      /** 装好夹具（桌面前台 + 横幅已展开 30 秒）后推进一次状态机 */
      const t9Setup = () => {
        island.lastAutoSwitch = 0;
        island.animating = false;
        island.holdUntil = 0;
        island.lastLi = 1; // 吸收桌面测试数据的 li，避免输入检测误设冷却
        island.zoomCooldownUntil = 0; // 清冷却，验证桌面闲置可自动弹大屏
        island.lastOverPill = false;
        island.probe.last = { ...deskFixture };
        island.state = 'expanded';
        island.expandedAt = Date.now() - 30000; // 横幅已展开 30 秒（> zoomIdleSec）
        island.tick();
      };
      t9Setup();
      // 桌面不锁定：横幅已展示足够久 → 自动弹大屏（层级：横幅后大屏）
      // 真实桌面/探针采样或后台动画可能改写夹具（状态机带去抖与 60 秒冷却），
      // 因此按同一夹具重试若干次；只有「重试后仍不弹大屏」才算功能回归（避免环境抖动误报）
      let t9ok = island.state === 'zoom';
      for (let i = 0; i < 8 && !t9ok; i++) {
        await sleep(80);
        t9Setup();
        t9ok = island.state === 'zoom';
      }
      const t9pl = island.probe.last || {};
      const t9st = settings.load();
      const t9dbg =
        `idle=${t9pl.tick - t9pl.li} li=${t9pl.li} lastLi=${island.lastLi} mode=${t9st.manual.mode} ` +
        `smart=${t9st.smart.enabled} glass=${t9st.ui.glassMode} zoomAllowed=${island.zoomAllowed()} ` +
        `cd=${island.hasCountdown()} cooldownMs=${island.zoomCooldownUntil - Date.now()} zoomIdleSec=${t9st.smart.zoomIdleSec} ` +
        `anim=${island.animating} paused=${island.paused} drag=${island.dragging} holdMs=${island.holdUntil - Date.now()} ` +
        `lastOverPill=${island.lastOverPill}`;
      ok(`T9 桌面前台→不锁定（横幅展开后自动弹大屏，state=${island.state}｜${t9dbg}）`, t9ok);
      // 操作后冷却期内：闲置再大也不自动弹大屏（避免收起后马上又弹出）
      island.zoomCooldownUntil = Date.now() + 60000;
      island.animating = false;
      island.lastAutoSwitch = 0;
      island.tick();
      ok(`T9 操作后冷却期内不自动弹大屏 (state=${island.state}, cooldown=${island.zoomCooldownUntil > Date.now()})`, island.state === 'expanded');
      island.zoomCooldownUntil = 0;
      // 大屏展开后：有操作（光标在大屏上、非闲置）应收起为灵动岛
      island.manualState('zoom', 0);
      island.animating = false;
      const zb9 = island.win.getBounds();
      island.probe.last = {
        ...island.probe.last,
        fgClass: 'Sci_App',
        rect: null,
        pid: 9999, li: 0, tick: 100,
        cx: zb9.x + 40, cy: zb9.y + 40,
      };
      island.lastAutoSwitch = 0;
      island.tick();
      ok('T9 大屏有操作→自动收起', island.state === 'strip');
      island.manualState('strip', 0);
      await sleep(300);
      island.animating = false;
      island.gestureAt = 0;
      island.onAction({ type: 'gesture', dy: 60 }); // 向下拖 → 最大窗口
      await sleep(150); // 等动画结束
      ok('T9 向下拖拽→最大窗口', island.state === 'zoom');
      island.onAction({ type: 'tap' }); // gesture 后 150ms，屏蔽期内误触 tap 应被忽略
      ok('T9 拖放后误触 tap 被忽略（不收回）', island.state === 'zoom');
      island.animating = false;
      island.tick(); // 保持期内不应被自动切换
      ok('T9 保持期内保持最大窗口', island.state === 'zoom');
      // 保持期结束后：显式构造「最大化窗口」数据 → 应收回细条
      island.holdUntil = Date.now() - 100;
      island.lastAutoSwitch = 0;
      island.animating = false;
      const dbg = island.islandDisplay();
      const dbgDb = dbg.bounds;
      const dbgWa = dbg.workArea;
      island.probe.last = {
        ...island.probe.last,
        rect: { l: dbgDb.x - 8, t: dbgDb.y - 8, r: dbgDb.x + dbgDb.width + 8, b: dbgWa.y + dbgWa.height },
        li: 0, tick: 100,
        // 屏幕右下角：远离顶部区域与小岛（顶部附近悬浮现在会保持现状，不参与自动切换）
        cx: dbgDb.x + dbgDb.width - 300,
        cy: dbgDb.y + dbgDb.height - 300,
      };
      island.tick();
      ok('T9 保持期结束后自动收回（最大化→细条）', island.state === 'strip');

      // —— T9b 单击只收不放 + 全屏锁定 ——
      island.gestureAt = 0;
      island.animating = false;
      island.onAction({ type: 'tap' }); // 点击灵动岛：不展开横幅
      ok('T9 点击灵动岛不再展开横幅', island.state === 'strip');
      island.manualState('expanded', 0); // 手动展开横幅后再点：收起
      island.animating = false;
      island.onAction({ type: 'tap' });
      ok('T9 点击横幅→收起成灵动岛', island.state === 'strip');
      // 全屏状态下：下滑/菜单不允许放大（只能灵动岛）
      island.fullscreen = true;
      island.onAction({ type: 'gesture', dy: 60 });
      ok('T9 全屏下滑→不允许放大', island.state !== 'zoom');
      island.onAction({ type: 'zoom' }); // 菜单放大同样被全屏锁定
      ok('T9 全屏菜单放大→不允许', island.state !== 'zoom');
      island.fullscreen = false;
      // 上滑：从横幅收起成灵动岛
      island.manualState('expanded', 0);
      island.animating = false;
      island.onAction({ type: 'gesture', dy: -60 });
      ok('T9 上滑→收起成灵动岛', island.state === 'strip');
      // 大屏为纯展示：鼠标穿透（不可操作），收回后恢复交互
      const ignoreCalls = [];
      const origSetIgnore = island.win.setIgnoreMouseEvents.bind(island.win);
      island.win.setIgnoreMouseEvents = (v) => { ignoreCalls.push(v); return origSetIgnore(v); };
      island.manualState('zoom', 6000);
      island.animating = false;
      ok('T9 大屏鼠标穿透（不可操作）', ignoreCalls.length > 0 && ignoreCalls[ignoreCalls.length - 1] === true);
      island.manualState('strip', 0);
      island.animating = false;
      ok('T9 灵动岛恢复交互', ignoreCalls[ignoreCalls.length - 1] === false);
      island.win.setIgnoreMouseEvents = origSetIgnore;
      // 倒计时窗口宽度随文字内容自适应（渲染器测量上报 → 主进程调整宽度）
      island.manualState('zoom', 6000);
      island.animating = false;
      island.setZoomWidth(330);
      await sleep(700); // 等渲染器测量上报（250ms）+ 宽度动画（110ms）完成
      // 测量上报可能在动画后再次到达（如 402→403）触发二次宽度动画；
      // 等待动画彻底结束再读数，避免读到中间帧
      const t9Deadline = Date.now() + 3000;
      while (island.animating && Date.now() < t9Deadline) await sleep(30);
      const zh = Math.max(200, Math.min(420, Math.round(island.islandDisplay().workArea.height / 4))) + 16;
      const zb = island.win.getBounds();
      ok(
        `T9 倒计时窗口宽度自适应 (内容宽=${island.zoomWidth}, 窗口=${zb.width}x${zb.height})`,
        island.zoomWidth > 0 &&
          island.zoomWidth !== Math.round(island.islandDisplay().workArea.height / 4) && // 宽度已随文字变化（非默认正方形）
          Math.abs(zb.width - (island.zoomWidth + 16)) <= 2 && // DWM/物理像素舍入可能差 1px
          Math.abs(zb.height - zh) <= 2
      );

      // —— T10 系统通知接管 + 免打扰 + 时间表 ——
      settings.update({ smart: { notifyEnabled: true, notifyShowSec: 8 } });
      island.manualState('strip', 0);
      await sleep(300);
      island.animating = false;
      island.lastToasts = new Set();
      // 模拟新通知
      island.handleToasts({ toasts: ['111|测试应用|这是一条通知内容'] });
      await sleep(300);
      ok('T10 新通知→通知形态', island.state === 'notify');
      island.animating = false;
      island.tick(); // 通知期间 tick 不应干预
      ok('T10 通知期间保持', island.state === 'notify');
      island.onAction({ type: 'dismiss' }); // 滑动收起
      ok('T10 滑动收起通知', island.state === 'strip');
      // 再次通知 → 免打扰按钮
      island.handleToasts({ toasts: ['222|测试应用|第二条通知'] });
      await sleep(300);
      ok('T10 再次通知→通知形态', island.state === 'notify');
      island.onAction({ type: 'dnd' }); // 免打扰至下课
      ok('T10 免打扰→收起', island.state === 'strip');
      ok('T10 免打扰生效（inDnd）', island.inDnd());
      island.handleToasts({ toasts: ['333|测试应用|第三条通知'] });
      await sleep(300);
      ok('T10 免打扰期间通知被屏蔽', island.state === 'strip');
      // 免打扰结束 → 通知恢复
      island.notifyDndUntil = Date.now() - 1;
      island.handleToasts({ toasts: ['444|测试应用|第四条通知'] });
      await sleep(300);
      ok('T10 免打扰结束恢复通知', island.state === 'notify');
      island.onAction({ type: 'dismiss' });
      // 同一 hwnd 的文本变化 → 视为新通知（QQ NT 复用气泡窗口场景）。
      // 暂停状态机：自动 tick 会用空通知列表清空 lastToasts，导致时序竞态
      island.setPaused(true);
      island.handleToasts({ toasts: ['555|测试应用|第五条通知'] });
      await sleep(300);
      ok('T10 新窗口通知→通知形态', island.state === 'notify');
      island.onAction({ type: 'dismiss' });
      island.handleToasts({ toasts: ['555|测试应用|第五条通知'] });
      await sleep(300);
      ok('T10 同窗口同文本→不重复通知', island.state === 'strip');
      island.handleToasts({ toasts: ['555|测试应用|第五条通知·内容变了'] });
      await sleep(300);
      ok('T10 同窗口文本变化→视为新通知', island.state === 'notify');
      // 通知展示框随内容自适应：渲染器按内容测量上报 → 主进程按上报尺寸调整窗口
      // （窗口边界 = 胶囊尺寸 + PAD×2 = +16）
      await sleep(300);
      const ns = island.notifySize;
      ok(
        `T10 通知展示框自适应尺寸 (上报=${ns ? ns.w + 'x' + ns.h : 'n/a'}, 窗口=${island.win.getBounds().width}x${island.win.getBounds().height})`,
        !!ns &&
          island.win.getBounds().width === ns.w + 16 &&
          island.win.getBounds().height === ns.h + 16 &&
          (ns.w !== 500 || ns.h !== 104) // 已从默认 500x104 自适应
      );
      island.onAction({ type: 'dismiss' });
      island.setPaused(false);
      // 通知优先级最高：全屏（穿透中）与最大化时也能展开且可交互
      island.manualState('strip', 0);
      island.animating = false;
      island.lastAutoSwitch = 0;
      const disp10 = island.islandDisplay();
      const db10 = disp10.bounds;
      island.probe.last = {
        ...island.probe.last,
        fgClass: 'Sci_Fullscreen',
        rect: { l: db10.x, t: db10.y, r: db10.x + db10.width, b: db10.y + db10.height },
        pid: 8888, li: 1, tick: 100,
        cx: db10.x + 200, cy: db10.y + 200,
      };
      island.tick(); // 全屏 → 灵动岛 + 穿透开启
      ok('T10 全屏→灵动岛并开启穿透', island.state === 'strip' && island.mousePT === true);
      island.handleToasts({ toasts: ['666|测试应用|全屏时的通知'] });
      await sleep(300);
      ok('T10 全屏时通知优先展开并关闭穿透', island.state === 'notify' && island.mousePT === false);
      island.onAction({ type: 'dismiss' });
      // 最大化时通知同样可展开
      island.probe.last = {
        ...island.probe.last,
        fgClass: 'Sci_Max',
        rect: { l: db10.x, t: db10.y, r: db10.x + db10.width, b: db10.y + Math.round(db10.height * 0.95) },
        pid: 8888, li: 1, tick: 100,
        cx: db10.x + 200, cy: db10.y + 200,
      };
      island.lastAutoSwitch = 0;
      island.tick();
      ok('T10 最大化→保持灵动岛', island.state === 'strip');
      island.handleToasts({ toasts: ['777|测试应用|最大化时的通知'] });
      await sleep(300);
      ok('T10 最大化时通知可展开', island.state === 'notify');
      island.onAction({ type: 'dismiss' });
      // 恢复中性数据，进入时间表测试
      island.probe.last = { ...island.probe.last, fgClass: 'Sci_Neutral', rect: null, li: 999999900, tick: 1000000000 };
      island.lastAutoSwitch = 0;
      island.animating = false;
      island.tick();
      // 时间表下课时间计算（新结构：多周循环）
      island.notifyDndUntil = 0;
      const now10 = new Date();
      const curMin10 = now10.getHours() * 60 + now10.getMinutes();
      const fmt10 = (m) => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
      const start10 = fmt10(Math.max(0, curMin10 - 1));
      const end10 = fmt10(curMin10 + 30);
      const dow10 = (now10.getDay() + 6) % 7;
      const week10 = [];
      for (let i = 0; i < 7; i++) {
        week10.push({ periods: i === dow10 ? [{ start: start10, end: end10 }] : [] });
      }
      settings.update({ schedule: { enabled: true, cycleWeeks: 1, restWeek: 0, weeks: [week10] } });
      const until10 = island.computeDndUntil();
      const expected10 = new Date(now10);
      expected10.setHours(0, 0, 0, 0);
      expected10.setMinutes(curMin10 + 30); // 跨午夜（如 23:31+30→次日00:01）自动进位
      ok(`T10 下课时间计算 (until=${new Date(until10).toTimeString().slice(0, 5)}, 期望=${end10})`, Math.abs(until10 - expected10.getTime()) < 2000);
      // 第 N 周（休息周）也按该周课表计算下课时间（不是整周休息，只是可少排课）
      const isoW10 = island.getISOWeek(now10);
      settings.update({ schedule: { enabled: true, cycleWeeks: 2, restWeek: ((isoW10 - 1) % 2) + 1, weeks: [week10, week10] } });
      const weekUntil10 = island.computeDndUntil();
      ok('T10 第N周按课表计算下课（非整周休息）', Math.abs(weekUntil10 - expected10.getTime()) < 3000);
      settings.update({ schedule: { enabled: false } });

      // —— T11 配置窗口时间表 UI ——
      settings.update({ schedule: { enabled: true, cycleWeeks: 1, restWeek: 0, weeks: [week10] } });
      config.open();
      await sleep(1200);
      const cw11 = config.getWindow();
      const js11 = (code) => cw11.webContents.executeJavaScript(code);
      const schedDays = await js11(`document.querySelector('[data-tab="schedule"]').click(); document.querySelectorAll('#schedule-list .sched-day').length`);
      ok(`T11 时间表页渲染 7 天区块 (实际=${schedDays})`, schedDays === 7);
      await js11(`document.querySelector('.sched-add').click()`);
      await sleep(700); // 等防抖保存完成，避免竞态
      // 只数周一（第一个 .sched-day）的行数：week10 在今天的星期也预置了 1 个时段，
      // 全表计数会把其他天的行数混进来导致断言错误
      const rows11 = await js11(`document.querySelectorAll('.sched-day')[0].querySelectorAll('.sched-row').length`);
      ok(`T11 添加时间段成功 (rows=${rows11})`, rows11 >= 1);
      // 按日复制（两次点击：源天 → 目标天）：把周一复制到周二
      await js11(`document.querySelectorAll('.sched-day')[0].querySelector('.sched-copy-day').click()`);
      await js11(`document.querySelectorAll('.sched-day')[1].querySelector('.sched-day-target').click()`);
      await sleep(700);
      const tueRows = await js11(`document.querySelectorAll('.sched-day')[1].querySelectorAll('.sched-row').length`);
      ok(`T11 按日复制生效（周二时间段数=${tueRows}）`, tueRows === rows11);
      // 几周一休联动：2 → 2 套周课表，第 2 周标注「休息周」但仍显示课表（可少排课）
      await js11(`document.getElementById('restEveryWeeks').value='2'; document.getElementById('restEveryWeeks').dispatchEvent(new Event('change'))`);
      await sleep(700);
      const weekCount = await js11(`document.querySelectorAll('.sched-week').length`);
      const restLabel = await js11(`document.querySelectorAll('.sched-week')[1].querySelector('.sched-week-head').textContent.includes('休息周')`);
      const week2Days = await js11(`document.querySelectorAll('.sched-week')[1].querySelectorAll('.sched-day').length`);
      ok(`T11 几周一休=2 → 2 套课表+第2周休息标注且可编辑 (weeks=${weekCount}, rest=${restLabel}, 第2周天数=${week2Days})`, weekCount === 2 && restLabel && week2Days === 7);
      // 改为 3 周循环（第 1、2 周上课）测按周复制（两次点击：源周 → 目标周）
      await js11(`document.getElementById('restEveryWeeks').value='3'; document.getElementById('restEveryWeeks').dispatchEvent(new Event('change'))`);
      await sleep(700);
      await js11(`document.querySelectorAll('.sched-week')[0].querySelector('.sched-copy-week').click()`);
      await js11(`document.querySelectorAll('.sched-week')[1].querySelector('.sched-week-target').click()`);
      await sleep(700);
      const wk2Days = await js11(`document.querySelectorAll('.sched-week')[1].querySelectorAll('.sched-day').length`);
      ok(`T11 按周复制生效（第2周含 7 天=${wk2Days}）`, wk2Days === 7);
      // 一键复制第 1 周到所有周（4 周循环，第 4 周休息）
      await js11(`document.getElementById('restEveryWeeks').value='4'; document.getElementById('restEveryWeeks').dispatchEvent(new Event('change'))`);
      await sleep(700);
      await js11(`document.querySelector('.sched-copy-all').click()`);
      await sleep(700);
      const all2 = await js11(`document.querySelectorAll('.sched-week')[1].querySelectorAll('.sched-day').length`);
      const all3 = await js11(`document.querySelectorAll('.sched-week')[2].querySelectorAll('.sched-day').length`);
      ok(`T11 复制到所有周（第2周=${all2}, 第3周=${all3}）`, all2 === 7 && all3 === 7);
      config.close();
      await sleep(400);
      settings.update({ schedule: { enabled: false } });

      // —— T12 计划任务 + 开机自启 + 定时任务 UI ——
      const tasksMod = require('./tasks');
      const tNow12 = new Date();
      const hm12 = String(tNow12.getHours()).padStart(2, '0') + ':' + String(tNow12.getMinutes()).padStart(2, '0');
      // 「不该触发」的任务时间取下一分钟（写死 23:59 会让 23:59 跑的测试必失败）
      const hm12Next = (() => {
        const d = new Date(tNow12.getTime() + 60000);
        return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
      })();
      settings.update({
        tasks: [
          { id: 't1', type: 'remind', time: hm12, days: 'daily', message: '测试提醒', enabled: true },
          { id: 't2', type: 'remind', time: hm12Next, days: 'daily', message: '不该触发', enabled: true },
          { id: 't3', type: 'command', time: hm12, days: 'once', command: 'echo hi', enabled: true },
        ],
      });
      const fired12 = [];
      const executed12 = tasksMod.checkTasks(tNow12, (t) => fired12.push(t.id));
      ok(`T12 计划任务时间匹配执行 (fired=${fired12.join(',')})`, fired12.includes('t1') && fired12.includes('t3') && !fired12.includes('t2'));
      ok('T12 一次性任务执行后自动删除', !(settings.load().tasks || []).some((t) => t.id === 't3'));
      // 防重复：30 秒检查粒度下，同一分钟内第二次检查不重复触发（曾同一分钟提醒两次）
      settings.update({ tasks: [{ id: 'r1', type: 'remind', time: '09:55', days: 'daily', message: '防重复测试', enabled: true }] });
      const firedA = [];
      const firedB = [];
      tasksMod.checkTasks(new Date(2026, 0, 1, 9, 55, 10), (t) => firedA.push(t.id));
      tasksMod.checkTasks(new Date(2026, 0, 1, 9, 55, 40), (t) => firedB.push(t.id));
      ok(`T12 同一分钟不重复提醒 (第一次=${firedA.length}, 第二次=${firedB.length})`, firedA.length === 1 && firedB.length === 0);
      settings.update({ tasks: [] });
      // 周几匹配
      const dow12 = (tNow12.getDay() + 6) % 7;
      const otherDow = (dow12 + 1) % 7;
      const matchDow = tasksMod.trigger({ time: hm12, days: [dow12], enabled: true }, tNow12);
      const notMatchDow = tasksMod.trigger({ time: hm12, days: [otherDow], enabled: true }, tNow12);
      ok('T12 计划任务按周几匹配', matchDow === 'run' && notMatchDow === null);
      // 关机任务：提前提醒点与关机点
      const remindAt = tasksMod.trigger({ id: 's1', type: 'shutdown', time: '10:00', remindMin: 5, days: 'daily', enabled: true }, new Date(2026, 0, 1, 9, 55));
      const shutAt = tasksMod.trigger({ id: 's1', type: 'shutdown', time: '10:00', remindMin: 5, days: 'daily', enabled: true }, new Date(2026, 0, 1, 10, 0));
      const noTrigger = tasksMod.trigger({ id: 's1', type: 'shutdown', time: '10:00', remindMin: 5, days: 'daily', enabled: true }, new Date(2026, 0, 1, 9, 54));
      ok(`T12 关机任务提前提醒/关机触发点 (remind=${remindAt}, shut=${shutAt}, none=${noTrigger})`, remindAt === 'remind' && shutAt === 'shutdown' && noTrigger === null);
      // 取消关机：当天标记后不再触发；取消动作标记任务
      settings.update({ tasks: [{ id: 's1', type: 'shutdown', time: hm12, remindMin: 1, days: 'daily', enabled: true }] });
      island.onAction({ type: 'cancel-shutdown' });
      await sleep(300);
      const s1 = (settings.load().tasks || []).find((t) => t.id === 's1');
      ok(`T12 取消关机后当天不再触发 (cancelUntil=${s1 && s1.cancelUntil})`, !!s1 && s1.cancelUntil === tasksMod.localDate(new Date()));
      ok('T12 取消后 trigger 返回 null', tasksMod.trigger(s1, tNow12) === null);
      // 关机提醒通知：关键词红色高亮 + 取消按钮 + 正文抖动（标题不抖）
      island.showNotification('关机提醒', '电脑将在 5 分钟后自动关机（20:00）', {
        keywords: ['关机'],
        btn: { label: '取消关机', act: 'cancel-shutdown' },
      });
      await sleep(500);
      const nKeyDom = await island.win.webContents.executeJavaScript(`({ key: !!document.querySelector('.n-key'), keyText: (document.querySelector('.n-key')||{}).textContent, btn: (document.querySelector('#dnd-bar .n-btn')||{}).textContent, bodyAnim: document.querySelector('.n-body') ? getComputedStyle(document.querySelector('.n-body')).animationName : 'none', titleAnim: getComputedStyle(document.querySelector('.n-title')).animationName })`);
      ok(`T12 关键词高亮+取消按钮+正文抖动标题不抖 (key=${nKeyDom.keyText}, btn=${nKeyDom.btn}, body=${nKeyDom.bodyAnim}, title=${nKeyDom.titleAnim})`, nKeyDom.key === true && nKeyDom.keyText === '关机' && nKeyDom.btn === '取消关机' && nKeyDom.bodyAnim === 'n-alert-jitter' && nKeyDom.titleAnim === 'none');
      island.onAction({ type: 'dismiss' });
      // 开机自启设置读写
      settings.update({ ui: { autoStart: true } });
      ok('T12 开机自启设置写入', settings.load().ui.autoStart === true);
      settings.update({ ui: { autoStart: false } });
      // 开机自启注册表：真实状态可读回（勾选框按它显示），写开关后与设置一致
      const asBefore = readAutoStart();
      const asOn = writeAutoStart(true);
      const asOff = writeAutoStart(false);
      ok(
        `T12 开机自启读回注册表 (开启=${asOn.enabled}/指向本程序=${asOn.matches}/路径=${asOn.path ? path.basename(asOn.path) : '无'}，关闭=${asOff.enabled})`,
        asOn.enabled === true && asOn.matches === true && !!asOn.path && asOff.enabled === false
      );
      // 还原测试前的真实状态（测试不能在你的机器上留下自启项）
      if (asBefore.enabled && asBefore.path) {
        try {
          require('child_process').execFileSync('reg', ['add', RUN_KEY, '/v', AUTOSTART_VALUE, '/t', 'REG_SZ', '/d', `"${asBefore.path}"`, '/f'], { windowsHide: true });
        } catch (e) {
          /* ignore */
        }
      } else {
        removeAutoStartValue(AUTOSTART_VALUE);
      }
      const asRestored = readAutoStart();
      ok(`T12 开机自启状态已还原 (与测试前一致=${asRestored.enabled === asBefore.enabled})`, asRestored.enabled === asBefore.enabled);
      // 定时任务页 UI：添加 + 列表渲染
      config.open();
      await sleep(1000);
      const cw12 = config.getWindow();
      const js12 = (code) => cw12.webContents.executeJavaScript(code);
      // 开机自启勾选框必须按注册表真实状态显示（不是设置里的期望值）
      const asUi = await js12(
        `(() => ({ checked: document.getElementById('autoStart').checked, tag: (document.getElementById('autoStartState') || {}).textContent || '', path: (document.getElementById('autoStartPath') || {}).textContent || '' }))()`
      );
      const asReg = readAutoStart();
      ok(
        `T12 配置页开机自启显示真实状态 (勾选=${asUi.checked} 注册表=${asReg.enabled} 标签=${JSON.stringify(asUi.tag)} 指向=${JSON.stringify(asUi.path)})`,
        asUi.checked === asReg.enabled && ['未启用', '已启用', '已被系统禁用'].includes(asUi.tag)
      );
      await js12(`document.querySelector('[data-tab="tasks"]').click()`);
      await js12(`document.getElementById('taskType').value='remind'; document.getElementById('taskTime').value='08:00'; document.getElementById('taskDays').value='daily'; document.getElementById('taskMessage').value='早上好'; document.getElementById('btn-add-task').click()`);
      await sleep(700);
      const taskItems = await js12(`document.querySelectorAll('#task-list .task-item').length`);
      const taskText = await js12(`document.getElementById('task-list').innerText`);
      ok(`T12 定时任务页添加并渲染 (items=${taskItems})`, taskItems >= 1 && taskText.includes('定时提醒') && taskText.includes('08:00'));
      // 关机任务表单：显示提前提醒输入、隐藏提醒文字
      await js12(`document.getElementById('taskType').value='shutdown'; document.getElementById('taskType').dispatchEvent(new Event('change'))`);
      const remindRowHidden = await js12(`document.getElementById('taskRemindRow').hidden`);
      const msgHidden = await js12(`document.getElementById('taskMessage').hidden`);
      ok(`T12 关机任务表单（提前提醒显示=${!remindRowHidden}, 提醒文字隐藏=${msgHidden}）`, remindRowHidden === false && msgHidden === true);
      settings.update({ tasks: [] });
      config.close();
      await sleep(400);

      // —— T13 大窗口轮播切换标题 + 事件置顶 ——
      // 构造两个未来事件：甲（近）、乙（远）
      settings.update({
        events: [
          { id: 'ev-a', name: '事件甲', date: '2099-05-01T09:00:00', emoji: '🅰️', color: '#4f7cff', enabled: true, pinned: false },
          { id: 'ev-b', name: '事件乙', date: '2099-08-01T09:00:00', emoji: '🅱️', color: '#4f7cff', enabled: true, pinned: false },
        ],
      });
      island.broadcastEvents();
      // 轮播标题：开启轮播（2s），进大屏，标题应随事件切换
      const t13ZoomIdle = settings.load().smart.zoomIdleSec;
      settings.update({ smart: { cycleEnabled: true, cycleSec: 2, zoomIdleSec: 0 } });
      island.broadcastEvents();
      island.manualState('zoom', 8000);
      island.animating = false;
      await sleep(700);
      // 连续采样 3.2s（> cycleSec 2s 周期），轮播必然切到两个不同事件
      const heads = new Set();
      for (let i = 0; i < 4; i++) {
        const h = await island.win.webContents.executeJavaScript(`(document.querySelector('.z-label')||{}).textContent || ''`);
        if (h) heads.add(h);
        await sleep(800);
      }
      const headList = [...heads].join(' | ');
      ok(`T13 大窗口轮播切换标题 (看到 ${heads.size} 个: ${headList})`, heads.size >= 2);
      settings.update({ smart: { cycleEnabled: false, zoomIdleSec: t13ZoomIdle } });
      island.broadcastEvents();
      island.manualState('strip', 0);
      island.animating = false;
      // 置顶：乙（较远事件）置顶 → 灵动岛/横幅显示乙（不再显示更近的甲）
      settings.update({ events: [
        { id: 'ev-a', name: '事件甲', date: '2099-05-01T09:00:00', emoji: '🅰️', color: '#4f7cff', enabled: true, pinned: false },
        { id: 'ev-b', name: '事件乙', date: '2099-08-01T09:00:00', emoji: '🅱️', color: '#4f7cff', enabled: true, pinned: true },
      ] });
      island.broadcastEvents();
      island.manualState('expanded', 6000); // 保持期：避免 idle 状态机自动收回
      island.animating = false;
      await sleep(500);
      const pinName = await island.win.webContents.executeJavaScript(`(document.querySelector('.e-name')||{}).textContent || ''`);
      ok(`T13 置顶事件显示在横幅上 (name=${pinName})`, pinName.includes('事件乙'));
      island.manualState('strip', 0);
      island.animating = false;
      await sleep(300);
      // 配置页置顶按钮：点击后 settings 里该事件 pinned=true 且互斥（另一事件清空）
      config.open();
      await sleep(800);
      const cw13 = config.getWindow();
      const js13 = (code) => cw13.webContents.executeJavaScript(code);
      await js13(`document.querySelector('[data-tab="events"]').click()`);
      await sleep(300);
      const pinBtnText = await js13(`(document.querySelector('#event-list [data-act="pin"]')||{}).textContent || ''`);
      await js13(`document.querySelector('#event-list [data-act="pin"][data-id="ev-a"]')?.click()`);
      await sleep(600);
      const evA = settings.events().find((x) => x.id === 'ev-a');
      const evB = settings.events().find((x) => x.id === 'ev-b');
      ok(`T13 配置页置顶按钮生效并互斥 (btn=${pinBtnText}, A=${evA && evA.pinned}, B=${evB && evB.pinned})`, !!evA && evA.pinned === true && !!evB && evB.pinned !== true);
      config.close();
      await sleep(300);
      settings.update({ ui: { showPast: false } });

      // —— T14 日期估算方式 + 大窗口单位替换 ——
      // 用相对时间构造事件（避免绝对日期随构建时间失效；精确到秒，误差 < 1 秒）
      const mkDate = (ms) => {
        const d = new Date(Date.now() + ms);
        const p = (n) => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
      };
      const setT14 = async (ms, ui) => {
        settings.update({
          events: [{ id: 'ev-t14', name: '估算事件', date: mkDate(ms), emoji: '⏳', color: '#4f7cff', enabled: true, pinned: false }],
          ui: Object.assign({ showSeconds: true }, ui || {}),
        });
        island.broadcastEvents();
        await sleep(320);
      };
      const readDays = () =>
        island.win.webContents.executeJavaScript(`(document.querySelector('[data-role="days"]')||{}).textContent || ''`);
      island.manualState('strip', 0);
      island.animating = false;
      await sleep(300);
      // +2天5小时：向下=2、四舍五入=2、向上=3（区分向上取整）
      await setT14(2 * 86400000 + 5 * 3600000, { dayRounding: 'floor' });
      const rdFloor1 = await readDays();
      await setT14(2 * 86400000 + 5 * 3600000, { dayRounding: 'round' });
      const rdRound1 = await readDays();
      await setT14(2 * 86400000 + 5 * 3600000, { dayRounding: 'ceil' });
      const rdCeil1 = await readDays();
      ok(`T14 日期估算方式（+2天5小时：向下=${rdFloor1} 四舍五入=${rdRound1} 向上=${rdCeil1}）`, rdFloor1 === '2' && rdRound1 === '2' && rdCeil1 === '3');
      // +2天14小时：向下=2、四舍五入=3（区分四舍五入）
      await setT14(2 * 86400000 + 14 * 3600000, { dayRounding: 'floor' });
      const rdFloor2 = await readDays();
      await setT14(2 * 86400000 + 14 * 3600000, { dayRounding: 'round' });
      const rdRound2 = await readDays();
      ok(`T14 四舍五入满半天算一天（+2天14小时：向下=${rdFloor2} 四舍五入=${rdRound2}）`, rdFloor2 === '2' && rdRound2 === '3');
      settings.update({ ui: { dayRounding: 'floor' } });
      // 大窗口：不足一个单位 → 换成下一个单位（天→时→分→秒）
      island.manualState('zoom', 20000);
      island.animating = false;
      await sleep(400);
      const readZoom = () =>
        island.win.webContents.executeJavaScript(
          `((document.querySelector('[data-role="days"]')||{}).textContent||'')+'|'+` +
            `((document.querySelector('[data-role="unit"]')||{}).textContent||'')+'|'+` +
            `(document.querySelector('[data-role="time"]')? 'sub' : 'nosub')`
        );
      await setT14(3 * 3600000 + 20 * 60000 + 30000);
      const z3h = await readZoom();
      await setT14(20 * 60000 + 30000);
      const z20m = await readZoom();
      await setT14(45 * 1000);
      const z40s = await readZoom();
      ok(
        `T14 大窗口单位替换（3时20分→${z3h} 20分→${z20m} 45秒→${z40s}）`,
        z3h === '3|时|sub' && z20m === '20|分|sub' && /^\d+\|秒\|nosub$/.test(z40s)
      );
      await setT14(2 * 86400000 + 5 * 3600000, { dayRounding: 'floor' });
      const zDays = await readZoom();
      await setT14(3 * 3600000 + 20 * 60000, { dayRounding: 'ceil' });
      const zCeil = await readZoom();
      ok(`T14 大窗口天单位与估算方式联动（向下=${zDays} 向上=${zCeil}）`, zDays === '2|天|sub' && zCeil === '1|天|sub');
      settings.update({ ui: { dayRounding: 'floor' } });
      island.broadcastEvents();
      island.manualState('strip', 0);
      island.animating = false;
      await sleep(200);

      // —— T15 全状态单位降级 + 灵动岛（细条）玻璃样式 ——
      const readUnits = () =>
        island.win.webContents.executeJavaScript(
          `((document.querySelector('[data-role="days"]')||{}).textContent||'')+'|'+` +
            `((document.querySelector('[data-role="unit"]')||{}).textContent||'')+'|'+` +
            `((document.querySelector('[data-role="time"]')||{}).textContent||'')`
        );
      // 细条：不足一天 → 主单位换成「时」，不足一小时 → 「分」；细条没有副行文本
      island.manualState('strip', 30000);
      island.animating = false;
      await sleep(400);
      await setT14(3 * 3600000 + 20 * 60000 + 30000);
      const s3h = await readUnits();
      await setT14(20 * 60000 + 30000);
      const s20m = await readUnits();
      await setT14(45 * 1000);
      const s45s = await readUnits();
      ok(
        `T15 灵动岛单位降级（3时20分→${s3h} 20分→${s20m} 45秒→${s45s}）`,
        s3h === '3|时|' && s20m === '20|分|' && /^\d+\|秒\|$/.test(s45s)
      );
      // 横幅：主单位同样降级，副行显示更小单位（天用钟表样式，时/分/秒用带单位样式）
      island.manualState('expanded', 30000);
      island.animating = false;
      await sleep(400);
      await setT14(3 * 3600000 + 20 * 60000 + 30000);
      const e3h = await readUnits();
      await setT14(2 * 86400000 + 5 * 3600000 + 20 * 60000 + 30000, { dayRounding: 'floor' });
      const e2d = await readUnits();
      ok(
        `T15 横幅单位降级（3时20分→${e3h} 2天5小时→${e2d}）`,
        /^3\|时\|\d\d分\d\d秒$/.test(e3h) && /^2\|天\|\d\d:\d\d:\d\d$/.test(e2d)
      );
      // —— 灵动岛玻璃样式：细条也要真的显示玻璃层（历史 bug：细条被排除 → 只剩描边）——
      const readStripGlass = () =>
        island.win.webContents.executeJavaScript(`(() => {
          const g = document.getElementById('glass');
          const p = document.getElementById('pill');
          const n = document.querySelector('.s-num');
          const prev = document.body.dataset.ink;
          document.body.dataset.ink = 'dark';
          const numDark = n ? getComputedStyle(n).color : 'n/a';
          document.body.dataset.ink = 'light';
          const numLight = n ? getComputedStyle(n).color : 'n/a';
          document.body.dataset.ink = prev;
          return {
            strip: document.body.dataset.strip,
            display: getComputedStyle(g).display,
            filter: (g.style.filter || '').replace(/[()"]/g, '').slice(0, 20),
            bgLen: (g.style.backgroundImage || '').length,
            pillBg: getComputedStyle(p).backgroundColor,
            numDark, numLight,
          };
        })()`);
      island.manualState('strip', 30000);
      island.animating = false;
      settings.update({ ui: { glassMode: 'liquid', stripStyle: 'glass' } });
      island.applySettings();
      await sleep(1200); // 等细条截屏推送 + 滤镜重建
      const sg = await readStripGlass();
      ok(
        `T15 灵动岛玻璃样式显示玻璃层 (display=${sg.display} filter=${sg.filter} bg=${sg.bgLen}B pill=${sg.pillBg})`,
        sg.strip === 'glass' && sg.display === 'block' && sg.filter.includes('lg-filter') && sg.bgLen > 0 && sg.pillBg === 'rgba(0, 0, 0, 0)'
      );
      ok(
        `T15 灵动岛玻璃样式文字跟随背景亮度 (ink=dark→${sg.numDark} ink=light→${sg.numLight})`,
        sg.numDark === 'rgb(16, 32, 60)' && sg.numLight === 'rgb(255, 255, 255)'
      );
      // 黑底样式：细条是纯黑胶囊、不显示玻璃层，且文字恒为白色（亮背景下也不能变深色）
      settings.update({ ui: { stripStyle: 'black' } });
      island.applySettings();
      await sleep(900);
      const sb = await readStripGlass();
      ok(
        `T15 灵动岛黑底样式不显示玻璃且文字恒白 (display=${sb.display} pill=${sb.pillBg} ink=dark→${sb.numDark})`,
        sb.strip === 'black' && sb.display === 'none' && sb.pillBg === 'rgb(0, 0, 0)' && sb.numDark === 'rgb(255, 255, 255)'
      );
      settings.update({ ui: { glassMode: 'auto', stripStyle: 'black' } });
      island.applySettings();
      island.manualState('strip', 0);
      island.animating = false;
      await sleep(300);

      // —— T16 GPU 液态玻璃（屏幕视频流 + WebGL 着色器）——
      // 本机远程会话的页面布局不跟随窗口尺寸（innerWidth ≠ 窗口 DIP），
      // 会触发几何一致性回退 → 测试里显式跳过该检查以验证 GPU 链路本身。
      process.env.SCI_GL_NO_GEOM_CHECK = '1';
      settings.update({ ui: { glassMode: 'webgl' } });
      island.manualState('expanded', 30000);
      island.animating = false;
      island.applySettings();
      await sleep(3000);
      const mode16 = island.effectiveGlassMode();
      ok(`T16 GPU 液态玻璃取流成功 (mode=${mode16} glActive=${island.glActive} err=${island.glError || 'none'})`, mode16 === 'webgl' && island.glActive === true);
      const gl16 = await island.win.webContents.executeJavaScript(`(() => {
        const g = document.getElementById('glass-gl');
        if (!g || g.tagName !== 'CANVAS') return { err: 'not-canvas:' + (g ? g.tagName : 'null') };
        const gl = g.getContext('webgl') || g.getContext('experimental-webgl');
        if (!gl) return { err: 'no-gl-context' };
        const w = g.width, h = g.height;
        const buf = new Uint8Array(w * h * 4);
        gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
        let n = 0, minX = w, maxX = -1, minY = h, maxY = -1;
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            if (buf[(y * w + x) * 4 + 3] > 8) {
              n++;
              if (x < minX) minX = x;
              if (x > maxX) maxX = x;
              if (y < minY) minY = y;
              if (y > maxY) maxY = y;
            }
          }
        }
        const at = (x, y) => buf[(y * w + x) * 4 + 3];
        return {
          backing: w + 'x' + h,
          opaquePixels: n,
          bbox: [minX, minY, maxX, maxY],
          centerAlpha: at(Math.floor(w / 2), Math.floor(h / 2)),
          cornerAlpha: at(0, 0),
          rgbCenter: [buf[(Math.floor(h / 2) * w + Math.floor(w / 2)) * 4], buf[(Math.floor(h / 2) * w + Math.floor(w / 2)) * 4 + 1], buf[(Math.floor(h / 2) * w + Math.floor(w / 2)) * 4 + 2]],
          stats: window.GlassWebGL ? window.GlassWebGL.stats() : null,
        };
      })()`);
      const st16 = gl16.stats || {};
      const boxArea = (() => {
        const m = String(gl16.backing || '0x0').split('x');
        return (parseInt(m[0], 10) || 0) * (parseInt(m[1], 10) || 0);
      })();
      ok(
        `T16 WebGL 画布按物理像素绘制并渲染出玻璃 (backing=${gl16.backing} 不透明像素=${gl16.opaquePixels}/${boxArea} bbox=${(gl16.bbox || []).join(',')} 中心alpha=${gl16.centerAlpha} 角alpha=${gl16.cornerAlpha} draws=${st16.draws} video=${st16.videoW}x${st16.videoH})`,
        !gl16.err && gl16.centerAlpha > 200 && gl16.cornerAlpha === 0 && gl16.opaquePixels > 0.7 * boxArea && st16.draws > 0 && st16.videoW > 0
      );
      // GPU 模式下主进程完全不再截屏（省掉整条截屏/编码/IPC 管线）
      const cap16a = island.perfCapture.s.calls;
      const br16a = island.glBrightnessCount || 0;
      await sleep(3000);
      const cap16b = island.perfCapture.s.calls;
      const br16b = island.glBrightnessCount || 0;
      ok(`T16 GPU 模式主进程停止截屏 (3 秒内截屏次数 ${cap16a}→${cap16b})`, cap16b === cap16a);
      // 渲染层从视频帧算亮度（统计每 5 秒回传一次），主进程亮度应与之一致
      const glStats16 = island.glStats || {};
      const bc = glStats16.brightnessComputed;
      ok(
        `T16 亮度由渲染层从视频帧计算 (画布=${typeof bc === 'number' ? bc.toFixed(3) : 'n/a'} 主进程=${island.lastBrightness.toFixed(3)} 累计回报=${island.glBrightnessCount || 0})`,
        typeof bc === 'number' &&
          bc >= 0 &&
          bc <= 1 &&
          (island.glBrightnessCount || 0) > 0 &&
          island.lastBrightness >= 0 &&
          island.lastBrightness <= 1
      );
      // 切回 CPU 液态玻璃：视频流应停止、截屏循环恢复
      settings.update({ ui: { glassMode: 'liquid' } });
      island.applySettings();
      await sleep(2500);
      const cap16c = island.perfCapture.s.calls;
      await sleep(2000);
      ok(
        `T16 切回 CPU 模式后恢复截屏 (glActive=${island.glActive} 截屏 ${cap16c}→${island.perfCapture.s.calls})`,
        island.glActive === false && island.perfCapture.s.calls > cap16c
      );
      delete process.env.SCI_GL_NO_GEOM_CHECK;
      settings.update({ ui: { glassMode: 'auto' } });
      island.applySettings();
      island.manualState('strip', 0);
      island.animating = false;
      await sleep(300);

      // —— T17 玻璃高光强度（两条链路 + CSS 表面光影统一按系数缩放）——
      const readGlow = () =>
        island.win.webContents.executeJavaScript(`(() => {
          const tint = document.getElementById('glass-tint');
          return {
            k: getComputedStyle(document.documentElement).getPropertyValue('--glow-k').trim(),
            bg: tint ? getComputedStyle(tint).backgroundImage : '',
          };
        })()`);
      settings.update({ ui: { glassMode: 'liquid', glassGlow: 0 } });
      island.applySettings();
      island.manualState('expanded', 20000);
      island.animating = false;
      await sleep(1500);
      const glow0 = await readGlow();
      ok(
        `T17 高光强度 0 = 表面高光全关 (--glow-k=${glow0.k}, 白高光已消失=${!/rgba\(255, 255, 255, 0\.[0-9]+\)/.test(glow0.bg)})`,
        glow0.k === '0' && !/rgba\(255, 255, 255, 0\.[0-9]+\)/.test(glow0.bg)
      );
      settings.update({ ui: { glassGlow: 100 } });
      island.applySettings();
      await sleep(1200);
      const glow1 = await readGlow();
      ok(
        `T17 恢复 100 = 默认高光回来 (--glow-k=${glow1.k}, 含白高光=${/rgba\(255, 255, 255, 0\.[0-9]+\)/.test(glow1.bg)})`,
        glow1.k === '1' && /rgba\(255, 255, 255, 0\.[0-9]+\)/.test(glow1.bg)
      );
      settings.update({ ui: { glassMode: 'auto', glassGlow: 100 } });
      island.applySettings();
      island.manualState('strip', 0);
      island.animating = false;
      await sleep(300);

      // —— T18 GPU 玻璃帧率可调（CPU 链路不受影响，保持向下兼容）——
      process.env.SCI_GL_NO_GEOM_CHECK = '1';
      settings.update({ ui: { glassMode: 'webgl', gpuGlassFps: 15 } });
      island.applySettings();
      island.manualState('expanded', 40000);
      island.animating = false;
      await sleep(3000);
      const g18a = await island.win.webContents.executeJavaScript(
        `window.GlassWebGL ? { fps: window.GlassWebGL.fps(), min: window.GlassWebGL.minInterval(), draws: window.GlassWebGL.stats().draws, frames: window.GlassWebGL.stats().frames } : null`
      );
      await sleep(3000);
      const g18a2 = await island.win.webContents.executeJavaScript(`window.GlassWebGL ? window.GlassWebGL.stats() : null`);
      const draws15 = (g18a2 ? g18a2.draws : 0) - (g18a ? g18a.draws : 0);
      const frames15 = (g18a2 ? g18a2.frames : 0) - (g18a ? g18a.frames : 0);
      settings.update({ ui: { gpuGlassFps: 45 } });
      island.applySettings();
      await sleep(3500);
      const g18b = await island.win.webContents.executeJavaScript(
        `window.GlassWebGL ? { fps: window.GlassWebGL.fps(), min: window.GlassWebGL.minInterval(), draws: window.GlassWebGL.stats().draws, frames: window.GlassWebGL.stats().frames } : null`
      );
      await sleep(3000);
      const g18b2 = await island.win.webContents.executeJavaScript(`window.GlassWebGL ? window.GlassWebGL.stats() : null`);
      const draws45 = (g18b2 ? g18b2.draws : 0) - (g18b ? g18b.draws : 0);
      const frames45 = (g18b2 ? g18b2.frames : 0) - (g18b ? g18b.frames : 0);
      // 15fps 时绘制数应被节流卡在 ≤ ~15/s；45fps 时要么真的更快，要么是取流本身供不上（此时以流为准）
      ok(
        `T18 GPU 玻璃帧率可调（15fps→节流 ${g18a && g18a.min}ms，3秒 流${frames15}/绘${draws15}；45fps→节流 ${g18b && g18b.min}ms，3秒 流${frames45}/绘${draws45}）`,
        !!g18a &&
          g18a.fps === 15 &&
          g18a.min === 67 &&
          !!g18b &&
          g18b.fps === 45 &&
          g18b.min === 22 &&
          draws15 > 0 &&
          draws15 <= 15 * 3 * 1.5 &&
          (draws45 > draws15 * 1.2 || frames45 < 45 * 3 * 0.8)
      );
      // 切回 CPU 液态玻璃：GPU 链路停止，回到「背景刷新间隔」控制的兼容路径
      settings.update({ ui: { glassMode: 'liquid', gpuGlassFps: 30 } });
      island.applySettings();
      await sleep(2000);
      const back18 = await island.win.webContents.executeJavaScript(`window.GlassWebGL ? { active: window.GlassWebGL.isActive() } : null`);
      ok(`T18 切回 CPU 兼容模式后 GPU 链路停止 (glActive=${back18 && back18.active})`, !back18 || back18.active === false);
      delete process.env.SCI_GL_NO_GEOM_CHECK;
      settings.update({ ui: { glassMode: 'auto' } });
      island.applySettings();
      island.manualState('strip', 0);
      island.animating = false;
      await sleep(300);

      // —— T21 高级设置：GPU 玻璃观感四项（边缘高光 / 底部阴影 / 折射强度 / 折射范围）——
      process.env.SCI_GL_NO_GEOM_CHECK = '1';
      settings.update({ ui: { glassMode: 'webgl', glEdgeGlow: 100, glBottomShade: 100, glRefract: 100, glBand: 100 } });
      island.applySettings();
      island.manualState('expanded', 45000);
      island.animating = false;
      await sleep(2500);
      const readOpts = () =>
        island.win.webContents.executeJavaScript(
          `window.GlassWebGL && window.GlassWebGL.isActive() ? { opts: window.GlassWebGL.stats().opts, tune: window.GlassWebGL.tune() } : null`
        );
      const o100 = await readOpts();
      settings.update({ ui: { glEdgeGlow: 0 } });
      island.applySettings();
      await sleep(800);
      const oEdge0 = await readOpts();
      settings.update({ ui: { glEdgeGlow: 200, glBottomShade: 50, glRefract: 200, glBand: 50 } });
      island.applySettings();
      await sleep(800);
      const oTuned = await readOpts();
      ok(
        `T21 GPU 观感四项可调 (默认 spec=${o100 && o100.opts.spec}/shade=${o100 && o100.opts.bottomShade}/maxD=${Math.round((o100 && o100.opts.maxD) || 0)}/band=${Math.round((o100 && o100.opts.band) || 0)}；边缘高光调到 0 → spec=${oEdge0 && oEdge0.opts.spec}；高光200/阴影50/折射200/范围50 → spec=${oTuned && oTuned.opts.spec}/shade=${oTuned && oTuned.opts.bottomShade}/maxD=${Math.round((oTuned && oTuned.opts.maxD) || 0)}/band=${Math.round((oTuned && oTuned.opts.band) || 0)})`,
        !!o100 &&
          !!oEdge0 &&
          !!oTuned &&
          Math.abs(o100.opts.spec - 0.72) < 0.001 &&
          Math.abs(o100.opts.bottomShade - 0.2) < 0.001 &&
          o100.tune.edgeGlow === 1 &&
          oEdge0.opts.spec === 0 &&
          oEdge0.tune.edgeGlow === 0 &&
          Math.abs(oTuned.opts.spec - 1.44) < 0.01 &&
          Math.abs(oTuned.opts.bottomShade - 0.1) < 0.001 &&
          Math.abs(oTuned.opts.maxD - o100.opts.maxD * 2) < 0.5 &&
          oTuned.opts.band < o100.opts.band
      );
      // 这四项只作用于 GPU：共享的「玻璃高光强度」与 CPU 链路数值不受影响
      const shareGlow = await island.win.webContents.executeJavaScript(
        `getComputedStyle(document.documentElement).getPropertyValue('--glow-k').trim()`
      );
      ok(
        `T21 四项只影响 GPU 链路（共用高光系数 --glow-k=${JSON.stringify(shareGlow)} 未变，CPU 液态滤镜仍按原数值重建）`,
        shareGlow === '1' && !!island.win && !island.win.isDestroyed()
      );
      // 配置页高级标签回填：应显示当前设置值（此时是刚调过的 200/50/200/50）
      config.open();
      const advDeadline = Date.now() + 6000;
      while (!config.getWindow() && Date.now() < advDeadline) await sleep(120);
      let advForm = null;
      if (config.getWindow()) {
        const advReady = Date.now() + 6000;
        while (config.getWindow().webContents.isLoading() && Date.now() < advReady) await sleep(120);
        advForm = await config.getWindow().webContents.executeJavaScript(`(() => {
          const tab = document.querySelector('#tabs .tab[data-tab="advanced"]');
          if (tab) tab.click();
          const v = (id) => (document.getElementById(id) || {}).value;
          return { active: !!document.querySelector('#tab-advanced.active'), glow: v('glEdgeGlow'), shade: v('glBottomShade'), refract: v('glRefract'), band: v('glBand'), err: (document.getElementById('err') || {}).textContent || '' };
        })()`);
      }
      ok(
        `T21 高级页四项已接线并回填当前值 (激活=${!!(advForm && advForm.active)}, ${advForm && advForm.glow}/${advForm && advForm.shade}/${advForm && advForm.refract}/${advForm && advForm.band}, err=${JSON.stringify((advForm && advForm.err) || '')})`,
        !!advForm &&
          advForm.active &&
          advForm.glow === '200' &&
          advForm.shade === '50' &&
          advForm.refract === '200' &&
          advForm.band === '50' &&
          !advForm.err
      );
      if (config.getWindow()) config.close();
      settings.update({ ui: { glassMode: 'liquid', glEdgeGlow: 100, glBottomShade: 100, glRefract: 100, glBand: 100 } });
      island.applySettings();
      await sleep(1200);
      const back21 = await island.win.webContents.executeJavaScript(`window.GlassWebGL ? { active: window.GlassWebGL.isActive() } : null`);
      ok(`T21 改完四项切回 CPU 兼容模式仍正常 (glActive=${back21 && back21.active})`, !back21 || back21.active === false);
      delete process.env.SCI_GL_NO_GEOM_CHECK;
      settings.update({ ui: { glassMode: 'auto' } });
      island.applySettings();
      island.manualState('strip', 0);
      island.animating = false;
      await sleep(300);

      // —— T22 GPU 玻璃「跟手」相关：主进程不截屏 / 微调宽度不做动画 / 采集精度可设 ——
      process.env.SCI_GL_NO_GEOM_CHECK = '1';
      settings.update({ ui: { glassMode: 'webgl', gpuGlassFps: 60 } });
      island.applySettings();
      island.setManual('zoom'); // 大窗口驻留（跟着一起验证 zoom 状态）
      island.animating = false;
      await sleep(2500);
      // ① GPU 链路生效时主进程不应再抓屏（原来每次窗口变化都抓一次，是卡顿源）
      const cap22a = island.perfCapture.s.calls;
      await sleep(2200);
      const cap22b = island.perfCapture.s.calls;
      island.setZoomWidth(island.win.getBounds().width + 6); // 触发一次窗口尺寸变化
      await sleep(400);
      const cap22c = island.perfCapture.s.calls;
      ok(
        `T22 GPU 模式下主进程不再截屏 (截屏 ${cap22a}→${cap22b}→${cap22c}，GPU生效=${island.glStreamActive()})`,
        island.glStreamActive() === true && cap22b === cap22a && cap22c === cap22b
      );
      // ② 大窗口内容宽度微调：直接改尺寸，不触发窗口动画（动画会把玻璃隐藏 150ms）
      island.animating = false;
      const anim22a = island.perfAnim.s.animations;
      const w22a = island.win.getBounds().width;
      island.setZoomWidth(w22a + 6);
      await sleep(300);
      const w22b = island.win.getBounds().width;
      ok(
        `T22 大窗口宽度微调不走动画 (宽度 ${w22a}→${w22b}，动画次数 ${anim22a}→${island.perfAnim.s.animations})`,
        w22b !== w22a && island.perfAnim.s.animations === anim22a
      );
      // ③ 采集节奏与每帧成本：这两项决定"跟手"的实际上限（主进程只读，不改设置）
      const gl22 = island.glStats || {};
      ok(
        `T22 采集节奏与每帧成本可测 (采集帧率=${gl22.arrivalFps}fps 节流=${gl22.minIntervalMs}ms 实际绘制间隔=${gl22.gapMs}ms/最大${gl22.gapMaxMs}ms 上传=${gl22.uploadMs}ms 着色=${gl22.drawMs}ms)`,
        (gl22.arrivalFps || 0) > 0 && gl22.minIntervalMs > 0 && gl22.uploadMs != null
      );
      delete process.env.SCI_GL_NO_GEOM_CHECK;
      settings.update({ manual: { mode: 'auto' }, ui: { glassMode: 'auto' } });
      island.applySettings();
      island.manualState('strip', 0);
      island.animating = false;
      await sleep(600);

      // —— T19 托盘「大窗口驻留显示」——
      const baseZoom = {
        idleMs: 0, occluded: false, maximized: false, overPill: true, mode: 'zoom', smart: true, hideOnMaximized: true,
        expandIdleSec: 4, zoomIdleSec: 15, zoomAllowed: true, zoomCooldown: true, holding: false, hasCountdown: true,
        state: 'zoom', expandedSinceMs: 0,
      };
      ok(
        `T19 大窗口驻留：有操作/悬停/冷却期都不收回 (idle=0→${island.decideState(baseZoom)}, 悬停→${island.decideState({ ...baseZoom, overPill: true })}, 冷却→${island.decideState({ ...baseZoom, zoomCooldown: true })})`,
        island.decideState(baseZoom) === 'zoom' &&
          island.decideState({ ...baseZoom, overPill: true }) === 'zoom' &&
          island.decideState({ ...baseZoom, zoomCooldown: true }) === 'zoom'
      );
      ok(
        `T19 大窗口驻留的边界：全屏→${island.decideState({ ...baseZoom, occluded: true })}，无事件→${island.decideState({ ...baseZoom, hasCountdown: false })}，禁用大屏→${island.decideState({ ...baseZoom, zoomAllowed: false })}`,
        island.decideState({ ...baseZoom, occluded: true }) === 'strip' &&
          island.decideState({ ...baseZoom, hasCountdown: false }) === 'strip' &&
          island.decideState({ ...baseZoom, zoomAllowed: false }) === 'expanded'
      );
      // 托盘菜单项存在且点击生效
      trayMenu();
      const item19 = (lastTrayTemplate || []).find((i) => i.label && i.label.indexOf('大窗口驻留') === 0);
      settings.update({ smart: { zoomEnabled: true }, manual: { mode: 'auto' }, ui: { glassMode: 'liquid' } });
      island.applySettings();
      await sleep(400);
      if (item19 && item19.click) item19.click();
      await sleep(1200);
      ok(
        `T19 托盘菜单「大窗口驻留显示」点击生效 (菜单项=${!!item19}, mode=${settings.load().manual.mode}, state=${island.state}, 尺寸=${island.win.getBounds().width}x${island.win.getBounds().height})`,
        !!item19 && settings.load().manual.mode === 'zoom' && island.state === 'zoom' && island.win.getBounds().width > 200
      );
      // 驻留期间：模拟用户输入 + 多次 tick，状态不应被收回
      const li0 = island.lastLi;
      for (let i = 0; i < 3; i++) {
        island.probe.last = { ...island.probe.last, li: li0 + (i + 1) * 50, tick: li0 + (i + 1) * 50, fgClass: 'Sci_App', rect: null, pid: 4242, cx: 10, cy: 10 };
        island.animating = false;
        island.lastAutoSwitch = 0;
        island.tick();
        await sleep(120);
      }
      ok(`T19 驻留期间连续输入不收回 (state=${island.state}, mode=${settings.load().manual.mode})`, island.state === 'zoom');
      settings.update({ manual: { mode: 'auto' } });
      island.applySettings();
      island.manualState('strip', 0);
      island.animating = false;
      await sleep(300);

      // —— T20 壁纸功能（励志语 / 生成图片 / 探针设置 / 恢复原壁纸）——
      const wpMod = require('./wallpaper');
      // 语录轮换：同序号稳定、自定义追加在内置之后、纯自定义只用自己的
      const q0 = wpMod.pickQuote(7, '', true);
      const q0b = wpMod.pickQuote(7, '', true);
      const qBuildin = wpMod.pickQuote(0, '', true);
      const qCustomOnly = wpMod.pickQuote(3, '自定义甲\n自定义乙', false);
      ok(
        `T20 励志语轮换（同序号稳定=${q0 === q0b}，内置非空=${qBuildin.length > 0}，纯自定义=${qCustomOnly === '自定义乙' || qCustomOnly === '自定义甲'}）`,
        q0 === q0b && q0.length > 0 && qBuildin.length > 0 && ['自定义甲', '自定义乙'].includes(qCustomOnly)
      );
      // 轮换顺序：顺序逐张前进并回卷、倒序反向、随机不与上一张重复、无图片返回 -1
      const idxSeq = [wpMod.nextIndex(5, { order: 'seq', lastIndex: -1 }), wpMod.nextIndex(5, { order: 'seq', lastIndex: 0 }), wpMod.nextIndex(5, { order: 'seq', lastIndex: 4 })];
      const idxRev = [wpMod.nextIndex(5, { order: 'reverse', lastIndex: -1 }), wpMod.nextIndex(5, { order: 'reverse', lastIndex: 0 }), wpMod.nextIndex(5, { order: 'reverse', lastIndex: 1 })];
      let randOk = true;
      let randSeen = [];
      for (let i = 0; i < 20; i++) {
        const r = wpMod.nextIndex(3, { order: 'random', lastIndex: 1 });
        randSeen.push(r);
        if (r === 1 || r < 0 || r > 2) randOk = false;
      }
      const noneIdx = wpMod.nextIndex(0, { order: 'seq', lastIndex: -1 });
      ok(
        `T20 轮换顺序可设（顺序 ${idxSeq.join('→')}，倒序 ${idxRev.join('→')}，随机 20 次都不重复上一张=${randOk}，无图片=${noneIdx}）`,
        idxSeq.join() === '0,1,0' && idxRev.join() === '4,4,0' && randOk && noneIdx === -1
      );
      // 轮换频率：按分钟计频（到点才换）、每天（按日期）、每次启动（0）
      const fr = (patchW, ms) => {
        settings.update({ ui: { wallpaper: Object.assign({ enabled: true, autoDaily: true, intervalMin: 10, lastRotateAt: Date.now(), lastDate: wpMod.todayKey() }, patchW) } });
        return wallpaper.nextRotateIn();
      };
      const in10 = fr({}, 0);
      const overdue = fr({ lastRotateAt: Date.now() - 11 * 60000 }, 0);
      const dailyToday = fr({ intervalMin: 1440, lastRotateAt: Date.now() - 5 * 3600000, lastDate: wpMod.todayKey() }, 0);
      const startupMode = fr({ intervalMin: 0 }, 0);
      const offDisabled = (settings.update({ ui: { wallpaper: { enabled: false } } }), wallpaper.nextRotateIn());
      ok(
        `T20 轮换频率可设（10 分钟→剩余 ${Math.round(in10 / 1000)}s，过期→${overdue}，当天已换→顺延 ${Math.round(dailyToday / 60000)}min，每次启动→${startupMode}，未启用→${offDisabled}）`,
        in10 > 9 * 60000 && in10 <= 10 * 60000 && overdue === 0 && dailyToday > 0 && dailyToday <= 24 * 3600000 && startupMode === 0 && offDisabled === -1
      );
      settings.update({ ui: { wallpaper: { enabled: false, intervalMin: 1440, lastRotateAt: 0 } } });
      // 生成一张小尺寸壁纸（测试用 640×360，避免拖慢自检）
      const made = await wallpaper
        .render({
          width: 640,
          height: 360,
          quote: '测试励志语',
          bgType: 'gradient',
          bgColor: wpMod.GRADIENT_PRESETS[0],
          bgImage: null,
          school: '测试中学',
          position: 'center',
          scale: 100,
          subline: '今日事，今日毕',
        })
        .then((file) => ({ file, size: fs.statSync(file).size }))
        .catch((e) => ({ err: String(e && e.message ? e.message : e) }));
      ok(
        `T20 壁纸图片生成 (文件=${made.file ? path.basename(made.file) : 'n/a'}, 大小=${made.size || 0}B, err=${made.err || 'none'})`,
        !!made.file && made.size > 8000
      );
      // 用户素材路径：扫描图片文件夹（只认图片扩展名）+ 用真实图片当底图渲染，并验证 cover/压暗/底衬不报错
      const wpTmp = path.join(os.tmpdir(), `sci-wp-user-${process.pid}`);
      fs.mkdirSync(wpTmp, { recursive: true });
      const userImg = path.join(wpTmp, 'user-bg.png');
      fs.copyFileSync(made.file, userImg);
      fs.writeFileSync(path.join(wpTmp, '说明.txt'), 'not an image', 'utf8');
      const scanned = wpMod.listImages(wpTmp);
      ok(`T20 图片文件夹扫描 (命中=${scanned.length}，忽略非图片=${!scanned.some((f) => f.endsWith('.txt'))})`, scanned.length === 1 && path.basename(scanned[0]) === 'user-bg.png');
      const made2 = await wallpaper
        .render({
          width: 800,
          height: 450,
          quote: '用户素材底图测试',
          bgType: 'image',
          bgImage: 'data:image/png;base64,' + fs.readFileSync(userImg).toString('base64'),
          bgColor: wpMod.GRADIENT_PRESETS[1],
          fit: 'cover',
          dim: 0.4,
          scrim: true,
          school: '测试学校',
          subline: '今日事，今日毕',
          position: 'bottom-left',
          scale: 120,
        })
        .then((file) => ({ file, size: fs.statSync(file).size }))
        .catch((e) => ({ err: String(e && e.message ? e.message : e) }));
      ok(`T20 用户图片底图渲染 (大小=${made2.size || 0}B, err=${made2.err || 'none'})`, !!made2.file && made2.size > 8000);
      // 配置页「预览」：只回传 base64，不落盘、不改桌面（含 contain/压暗/无底衬/顶部居中）
      const wpOutDir = path.join(app.getPath('userData'), 'wallpapers');
      const filesBefore = fs.existsSync(wpOutDir) ? fs.readdirSync(wpOutDir).length : 0;
      const prevB64 = await wallpaper.renderToBase64({
        width: 480,
        height: 270,
        quote: '预览不落盘测试',
        bgType: 'image',
        bgImage: 'data:image/png;base64,' + fs.readFileSync(userImg).toString('base64'),
        bgColor: wpMod.GRADIENT_PRESETS[2],
        fit: 'contain',
        dim: 0.5,
        scrim: false,
        position: 'top-center',
        scale: 80,
      });
      const filesAfter = fs.existsSync(wpOutDir) ? fs.readdirSync(wpOutDir).length : 0;
      ok(
        `T20 预览只回传 base64 不落盘 (base64=${prevB64.length}B, 新增文件=${filesAfter - filesBefore})`,
        typeof prevB64 === 'string' && prevB64.length > 5000 && filesAfter === filesBefore
      );
      // 端到端轮换：3 张图 + 顺序模式，连点「立即更换」应依次取第 1/2/3 张（按文件名排序）
      ['a.png', 'b.png', 'c.png'].forEach((n) => fs.copyFileSync(userImg, path.join(wpTmp, n)));
      settings.update({
        ui: { wallpaper: { enabled: true, source: 'folder', folder: wpTmp, order: 'seq', lastIndex: -1, quoteIndex: 0, autoDaily: false } },
      });
      const seqPicks = [];
      for (let i = 0; i < 3; i++) {
        const r = await wallpaper.rotate();
        seqPicks.push(`${r && r.ok ? r.source : 'err'}(${r && r.index}/${r && r.total})`);
      }
      const afterIdx = (settings.load().ui.wallpaper || {}).lastIndex;
      ok(
        `T20 连续「立即更换」按顺序轮换 (共 4 张，依次=${seqPicks.join(' → ')}，记录下标=${afterIdx})`,
        seqPicks.join() === 'a.png(1/4),b.png(2/4),c.png(3/4)' && afterIdx === 2
      );
      // 倒序模式：从当前下标往回走
      settings.update({ ui: { wallpaper: { order: 'reverse' } } });
      const rev1 = await wallpaper.rotate();
      ok(
        `T20 倒序轮换生效 (上一张=3/4 → 本次=${rev1 && rev1.source}(${rev1 && rev1.index}/${rev1 && rev1.total}))`,
        !!rev1 && rev1.ok && rev1.index === 2
      );
      settings.update({ ui: { wallpaper: { order: 'seq', folder: '', enabled: false, lastIndex: -1, quoteIndex: 0, lastRotateAt: 0 } } });
      try {
        fs.rmSync(wpTmp, { recursive: true, force: true });
      } catch (e) {
        /* ignore */
      }
      // 交给探针设置壁纸：命令文件应被消费并回读结果
      const wpSet = probe.setWallpaper(made.file);
      const wpDeadline = Date.now() + 5000;
      while (!probe.wallpaperFileConsumed() && Date.now() < wpDeadline) await sleep(200);
      const wpResult = probe.readWallpaperResult();
      ok(
        `T20 探针执行壁纸设置 (写入=${wpSet}, 已消费=${probe.wallpaperFileConsumed()}, 回读=${wpResult.slice(0, 60)})`,
        wpSet && probe.wallpaperFileConsumed() && /set=(True|False)/.test(wpResult)
      );
      // 恢复原壁纸：先记录原值，再恢复（内容应等于记录的原壁纸路径）
      const origWp = wpMod.readCurrentWallpaper();
      settings.update({ ui: { wallpaper: { original: origWp || 'C:\\nonexistent-original.jpg', enabled: true, lastDate: '' } } });
      const rest = wallpaper.restore();
      const restDeadline = Date.now() + 5000;
      while (!probe.wallpaperFileConsumed() && Date.now() < restDeadline) await sleep(200);
      ok(
        `T20 恢复原壁纸 (记录原壁纸=${origWp ? path.basename(origWp) : '无'}, 结果=${JSON.stringify(rest).slice(0, 80)})`,
        !!rest && (rest.ok === true || rest.reason === 'no-original') && probe.wallpaperFileConsumed()
      );
      settings.update({ ui: { wallpaper: { enabled: false, lastDate: '' } } });
      // 托盘菜单：未启用壁纸时不给「更换壁纸」（避免误点换掉桌面），启用后才出现两项
      trayMenu();
      const trayWpOff = (lastTrayTemplate || []).filter((i) => i.label && i.label.indexOf('更换壁纸') === 0).length;
      settings.update({ ui: { wallpaper: { enabled: true } } });
      trayMenu();
      const trayWpOn = (lastTrayTemplate || []).filter(
        (i) => i.label && (i.label.indexOf('更换壁纸') === 0 || i.label.indexOf('恢复原壁纸') === 0)
      ).length;
      ok(`T20 托盘壁纸菜单随开关变化 (关闭=${trayWpOff}项, 启用=${trayWpOn}项)`, trayWpOff === 0 && trayWpOn === 2);
      // 配置页「壁纸」标签接线：能切页，且预览用的表单读取包含 填充方式/压暗/底衬
      config.open();
      const cfgDeadline = Date.now() + 6000;
      while (!config.getWindow() && Date.now() < cfgDeadline) await sleep(120);
      const cfgWin = config.getWindow();
      let wpForm = null;
      if (cfgWin) {
        const readyDeadline = Date.now() + 6000;
        while (cfgWin.webContents.isLoading() && Date.now() < readyDeadline) await sleep(120);
        wpForm = await cfgWin.webContents.executeJavaScript(`(() => {
          const tab = document.querySelector('#tabs .tab[data-tab="wallpaper"]');
          if (tab) tab.click();
          const form = typeof currentWallpaperForm === 'function' ? currentWallpaperForm() : null;
          return {
            tab: !!tab,
            active: !!document.querySelector('#tab-wallpaper.active'),
            fit: form ? form.fit : null,
            dim: form ? form.dim : null,
            scrim: form ? form.scrim : null,
            interval: (document.getElementById('wpInterval') || {}).value || '',
            order: (document.getElementById('wpOrder') || {}).value || '',
            hasCountdown: !!document.getElementById('wpCountdown'),
            err: (document.getElementById('err') || {}).textContent || '',
          };
        })()`);
      }
      ok(
        `T20 配置页壁纸标签接线 (标签=${!!(wpForm && wpForm.tab)}, 激活=${!!(wpForm && wpForm.active)}, 表单回填 fit=${wpForm && wpForm.fit}/dim=${wpForm && wpForm.dim}/scrim=${wpForm && wpForm.scrim}, 频率=${wpForm && wpForm.interval}, 顺序=${wpForm && wpForm.order}, 倒计时项已移除=${!(wpForm && wpForm.hasCountdown)}, err=${JSON.stringify((wpForm && wpForm.err) || '')})`,
        !!wpForm &&
          wpForm.tab &&
          wpForm.active &&
          wpForm.fit === 'cover' &&
          Math.abs(wpForm.dim - 0.32) < 0.001 &&
          wpForm.scrim === true &&
          wpForm.interval === '1440' &&
          wpForm.order === 'seq' &&
          wpForm.hasCountdown === false &&
          !wpForm.err
      );
      config.close();
      settings.update({ ui: { wallpaper: { enabled: false, lastDate: '' } } });

      const failed = results.some(([c]) => !c);
      console.log(failed ? 'TEST_FAIL' : 'TEST_OK');
      app.exit(failed ? 1 : 0);
    } catch (e) {
      console.error('TEST_ERROR', e && e.stack ? e.stack : e);
      app.exit(1);
    }
  })();
}
