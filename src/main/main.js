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
const schMod = require('./schedule');
const weather = require('./weather');
const { Pet, registerPetIpc } = require('./pet');
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
if (process.argv.includes('--test') || process.argv.includes('--shot') || process.argv.includes('--shot-strip') || process.argv.includes('--shot-init') || process.argv.includes('--shot-collapse') || process.argv.includes('--shot-weather') || process.argv.includes('--shot-config') || process.argv.includes('--shot-lab') || process.argv.includes('--glass-lab') || process.argv.includes('--gpu') || process.argv.includes('--smoke') || process.argv.includes('--perf')) {
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
let pet = null;       // 桌宠（懒创建）

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
  if (pet) pet.destroy();
  if (probe) probe.stop();
});
app.on('quit', () => {
  if (probe) probe.stop();
});

// 兜底：主进程里未捕获的异常/未处理的 Promise 拒绝不要弹「崩溃框」，
// 记到 %TEMP%\sci-crash-last.log 后继续跑（退出时的 EPIPE 之类不该打断老师上课）。
function logCrash(kind, err) {
  const text = `[${new Date().toISOString()}] ${kind}: ${(err && (err.stack || err.message)) || err}\n`;
  try {
    fs.appendFileSync(path.join(os.tmpdir(), 'sci-crash-last.log'), text, 'utf8');
  } catch (e) {
    /* ignore */
  }
  if (process.env.DSH_LGC_DEBUG) console.error(text.trim());
}
process.on('uncaughtException', (e) => logCrash('uncaughtException', e));
process.on('unhandledRejection', (e) => logCrash('unhandledRejection', e));

async function main() {
  app.setAppUserModelId('com.smartcounter.island');
  perf.mark('main-entry');

  probe = new Probe();

  island.init({
    probe,
    openConfig: () => config.open(),
  });

  registerIpc();
  // 自检模式下不建托盘图标：避免误点托盘右键菜单里的「退出」打断测试（托盘菜单模板本身照常可测）
  if (!process.argv.includes('--test')) {
    createTray();
    perf.mark('tray-created');
  }
  applyAutoStart();

  // 先建窗口（首帧越早出现越好），探针启动放到窗口显示之后
  try {
    await island.create();
  } catch (e) {
    console.error('[main] 灵动岛创建失败:', e);
  }
  perf.mark('island-created');
  // 挖孔盖板：窗口一建好就补一次（冷启动没有别的路径会建它；tick 里的自愈最快要 350ms 后）
  try {
    island.syncSensorCover();
  } catch (e) {
    console.error('[main] 传感器盖板创建失败:', e && e.message);
  }

  // PowerShell 探针冷启动较重（进程创建 + 脚本编译），放到窗口显示后再拉起，
  // 避免与首帧渲染争抢 CPU/磁盘。窗口创建后到首次采样前的状态机用探针空缺数据运行
  // （tick 对 probe.last 为 null 已做保护），影响仅为 1 秒内不判定全屏/输入。
  probe.start();
  perf.mark('probe-spawned');

  // 诊断：--quit-after=<秒> 到点走正常退出链路（before-quit → 探针 stop），
  // 用于验证退出时不会因为已关闭的管道（EPIPE）弹「主进程崩溃」框。
  const qa = process.argv.find((a) => a.startsWith('--quit-after='));
  if (qa) {
    const sec = Math.max(1, Math.min(600, parseInt(qa.split('=')[1], 10) || 8));
    setTimeout(() => app.quit(), sec * 1000);
  }

  // 提醒检查：每 20 秒一次
  //  1) 计划任务（定时提醒 / 定时关机 / 运行命令）—— 老师手配的条目
  //  2) 课堂提醒（课前 N 分钟 / 上课 / 下课前 N 分钟 / 下课）—— 由时间表自动驱动
  //  两套都匹配到「分钟」，20 秒粒度足够，且各自有同分钟去重
  setInterval(() => {
    try {
      tasks.checkTasks(new Date());
    } catch (e) {
      console.error('[tasks] 检查失败:', e.message);
    }
    try {
      // 课堂提醒：通知弹窗 + 桌宠出面念一遍（桌宠未启用时 announce 内部会跳过）
      tasks.checkClassReminders(new Date(), (r) => {
        island.showNotification(r.title, r.body, { alert: true, keywords: ['上课', '下课'] });
        if (pet) pet.announce(r);
      });
    } catch (e) {
      console.error('[class-remind] 检查失败:', e.message);
    }
    try {
      // 天气提醒（天气页独立规则表）：到点弹横幅；雨雪时整条岛播特效；关键词红色高亮
      const wcfg = settings.load().weather || {};
      weather.checkReminders(new Date(), (r) => {
        island.showNotification(r.title, r.body, {
          alert: true,
          keywords: r.keywords && r.keywords.length ? r.keywords : wcfg.alertKeywords || [],
          weather: wcfg.anim === false ? '' : r.anim,
        });
      });
    } catch (e) {
      console.error('[weather-remind] 检查失败:', e.message);
    }
  }, 20000);

  // —— 桌宠：独立舞台窗口 + 行为拍（每秒一次）+ 环境同步（全屏授课 / 上课中 / 免打扰）——
  pet = new Pet(settings, probe);
  registerPetIpc(pet);
  pet.applySettings();
  // 环境来源集中在这里：全屏授课（island 判定）、上课中（时间表）、免打扰
  pet.envSource = () => {
    const st = settings.load();
    return {
      fullscreen: !!island.fullscreen,
      inClass: !!(st.schedule && st.schedule.enabled && schMod.periodAt(st.schedule, new Date())),
      dnd: island.inDnd ? island.inDnd() : false,
    };
  };
  setInterval(() => {
    try {
      if (pet) pet.tick();
    } catch (e) {
      console.error('[pet] 行为拍失败:', e.message);
    }
  }, 1000);

  // 天气：启动先拉一次，之后每 60 秒看一眼（内部按刷新间隔决定是否真的拉取，失败退避 3 倍间隔）
  const weatherTick = () => {
    weather
      .refreshIfDue()
      .then((r) => {
        if (r && !r.skipped) island.pushWeather(); // pushWeather 按签名去重，内容没变就不重发
      })
      .catch((e) => console.error('[weather] 刷新失败:', e && e.message));
  };
  weatherTick();
  setInterval(weatherTick, 60000);

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
  else if (argv.includes('--shot-init')) runShotInit();
  else if (argv.includes('--shot-config')) runShotConfig();
  else if (argv.includes('--glass-lab')) runGlassLab();
  else if (argv.includes('--shot-lab')) runShotLab();
  else if (argv.includes('--shot-collapse')) runShotCollapse();
  else if (argv.includes('--shot-weather')) runShotWeather();
  else if (argv.includes('--gpu')) runGpuDiag();
  else if (argv.some((a) => a === '--gl-lag' || a.indexOf('--gl-lag=') === 0)) runGlLag();
  else if (argv.includes('--smoke')) runSmoke();
  else if (argv.includes('--demo-notify')) runDemoNotify();
  else if (argv.some((a) => a.startsWith('--diag'))) runDiag();
}

// ---------------- 天气视觉检查（--shot-weather） ----------------
// 注入一份固定预报（不联网）→ 横幅天气 chip + 图标动画 → 天气提醒 + 整岛雨雪特效 →
// 配置页天气 tab，各截一张窗口自身截图（capturePage），供人眼复核观感。
// 产物：shots/island-weather.png、island-weather-notify.png、config-weather.png
async function runShotWeather() {
  try {
    await shootWeather();
    app.exit(0);
  } catch (e) {
    console.log('[shot-weather] ERROR', e && e.stack ? e.stack : String(e));
    app.exit(1);
  }
}

async function shootWeather() {
  const outDir = app.isPackaged ? path.join(app.getPath('temp'), 'sci-shots') : path.join(__dirname, '..', '..', 'shots');
  fs.mkdirSync(outDir, { recursive: true });
  island.setPaused(true);
  const wxMod = require('./weather');
  const pad = (n) => String(n).padStart(2, '0');
  const base = new Date();
  const hp = (off) => {
    const d = new Date(base.getTime() + off * 3600000);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:00`;
  };
  const dp = (off) => {
    const d = new Date(base.getTime() + off * 86400000);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  };
  const fixture = {
    latitude: 34.75778,
    longitude: 113.66546,
    timezone: 'Asia/Shanghai',
    current: { time: hp(0), temperature_2m: 18.6, relative_humidity_2m: 72, apparent_temperature: 17.9, weather_code: 63, wind_speed_10m: 9.1 },
    hourly: { time: [hp(-1), hp(1), hp(2)], temperature_2m: [18, 18.4, 18.9], weather_code: [61, 63, 3], precipitation_probability: [60, 85, 20] },
    daily: {
      time: [dp(0), dp(1), dp(2), dp(3), dp(4), dp(5), dp(6)],
      weather_code: [63, 71, 2, 0, 1, 3, 61],
      temperature_2m_max: [21.2, 12.4, 22, 24.5, 25.1, 23.3, 20.8],
      temperature_2m_min: [14, 3.1, 13.2, 14.4, 15, 13.9, 12.6],
      precipitation_probability_max: [85, 60, 20, 5, 10, 30, 70],
    },
  };
  const snap = wxMod.parseForecast(fixture, { city: '郑州 · 河南 · 中国', updatedAt: Date.now() });
  wxMod.saveCache({ snapshot: snap, error: null });
  settings.update({ weather: { enabled: true, city: '郑州', resolvedName: '郑州 · 河南 · 中国', lat: 34.8, lon: 113.7, showInIsland: 'banner', anim: true, animIntensity: 100, unit: 'c' } });
  settings.upsertEvent({ id: null, name: '高考', date: '2099-06-07T00:00:00', emoji: '🎓', color: '#4f7cff', enabled: true });
  island.applySettings(); // 把事件推给渲染层（否则横幅是空态）
  island.manualState('expanded', 60000);
  island.pushWeather(true);
  await new Promise((r) => setTimeout(r, 2200)); // 等渲染层就绪 + 图标动画进入可见相位
  island.pushWeather(true); // 渲染层就绪后再推一次（首推可能早于 renderer ready）
  await new Promise((r) => setTimeout(r, 600));
  const before = await island.win.webContents.executeJavaScript('window.__wxState ? window.__wxState() : null');
  console.log('[shot-weather] renderer=', JSON.stringify(before));
  const chip = await island.win.webContents.executeJavaScript(`(() => {
    const w = document.getElementById('wx');
    if (!w) return null;
    const b = w.getBoundingClientRect();
    const sky = w.querySelector('.wx-sky');
    const drops = w.querySelectorAll('.wx-drop');
    const vis = (el) => el ? getComputedStyle(el).display !== 'none' : false;
    return {
      anim: w.dataset.anim, tone: w.dataset.tone,
      temp: (w.querySelector('.wx-temp') || {}).textContent, text: (w.querySelector('.wx-text') || {}).textContent,
      rect: [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)],
      sky: sky ? Math.round(sky.getBoundingClientRect().width) + 'x' + Math.round(sky.getBoundingClientRect().height) : 'n/a',
      dropsVisible: Array.prototype.filter.call(drops, vis).length,
      animName: sky ? getComputedStyle(w.querySelector('.wx-cloud') || sky).animationName : '',
    };
  })()`);
  console.log('[shot-weather] chip=', JSON.stringify(chip));
  fs.writeFileSync(path.join(outDir, 'island-weather.png'), (await island.win.webContents.capturePage()).toPNG());
  // 常驻细条：weather.showInIsland='always' + 挖孔开启 → 细条右缘挂紧凑 chip（只图标+温度）
  settings.update({ weather: { showInIsland: 'always' }, ui: { cameraNotch: { enabled: true, preset: 'center' } } });
  island.applySettings();
  island.manualState('strip', 60000);
  island.pushWeather(true);
  await new Promise((r) => setTimeout(r, 1200));
  const stripWx = await island.win.webContents.executeJavaScript(`(() => {
    const p = document.getElementById('pill');
    const w = document.getElementById('wx');
    const pr = p.getBoundingClientRect();
    const b = w ? w.getBoundingClientRect() : null;
    return { pill: Math.round(pr.width), chip: !!w, compact: w ? w.dataset.compact === '1' : false, temp: w ? ((w.querySelector('.wx-temp') || {}).textContent || '') : '', textShown: w ? getComputedStyle(w.querySelector('.wx-text') || w).display !== 'none' : null, rect: b ? [Math.round(b.left), Math.round(b.right)] : null };
  })()`);
  console.log('[shot-weather] strip=', JSON.stringify(stripWx));
  fs.writeFileSync(path.join(outDir, 'island-weather-strip.png'), (await island.win.webContents.capturePage()).toPNG());
  // 天气位置 = 盖板上：截盖板窗口自己（它是独立置顶窗口，得单独 capturePage）
  settings.update({ ui: { cameraNotch: { enabled: true, preset: 'center', text: { template: '还有 {days}{unit}', size: 12 } } }, weather: { showInIsland: 'always', pos: 'cover' } });
  island.applySettings();
  island.syncSensorCover();
  island.pushWeather(true);
  await new Promise((r) => setTimeout(r, 1400));
  const coverShot = require('./sensor-cover');
  const coverW = coverShot.win;
  if (coverW && !coverW.isDestroyed()) {
    const coverDom = await coverW.webContents.executeJavaScript(`(() => { const w = document.getElementById('wx'); const t = document.getElementById('wx-temp'); return { on: w ? w.classList.contains('on') : null, temp: t ? t.textContent : '', anim: document.documentElement.dataset.anim || '', size: [window.innerWidth, window.innerHeight] }; })()`);
    console.log('[shot-weather] cover=', JSON.stringify(coverDom));
    fs.writeFileSync(path.join(outDir, 'island-weather-cover.png'), (await coverW.webContents.capturePage()).toPNG());
  }
  settings.update({ ui: { cameraNotch: { enabled: false } }, weather: { pos: 'right' } });
  island.showNotification('降雨提醒', '未来 6 小时内可能下雨：15:00 前后 中雨（降水概率 85%）', { alert: true, keywords: ['雨'], weather: 'rain' });
  await new Promise((r) => setTimeout(r, 600));
  const fx = await island.win.webContents.executeJavaScript(`(() => {
    const f = document.getElementById('wx-fx');
    return f ? { fx: f.dataset.fx, hidden: f.hidden, kids: f.children.length, first: f.children[0] ? getComputedStyle(f.children[0]).animationName : '' } : null;
  })()`);
  console.log('[shot-weather] fx=', JSON.stringify(fx));
  fs.writeFileSync(path.join(outDir, 'island-weather-notify.png'), (await island.win.webContents.capturePage()).toPNG());
  config.open();
  await new Promise((r) => setTimeout(r, 1500));
  const cw = config.getWindow();
  if (cw) {
    await cw.webContents.executeJavaScript(`(() => { const t = document.querySelector('#tabs .tab[data-tab="weather"]'); if (t) t.click(); })()`);
    await new Promise((r) => setTimeout(r, 600));
    const state = await cw.webContents.executeJavaScript(`(() => ({
      active: !!document.querySelector('#tab-weather.active'),
      city: (document.getElementById('wxCity') || {}).value,
      status: (document.getElementById('wx-status') || {}).textContent,
      rules: document.querySelectorAll('#wx-rules .wx-rule').length,
      anim: (document.getElementById('wxAnim') || {}).checked,
    }))()`);
    console.log('[shot-weather] config=', JSON.stringify(state));
    fs.writeFileSync(path.join(outDir, 'config-weather.png'), (await cw.webContents.capturePage()).toPNG());
  }
  console.log('[shot-weather] files→', outDir);
}

// ---------------- 玻璃实验室（--glass-lab 打开窗口 / --shot-lab 截图后退出） ----------------
async function runGlassLab() {
  const lab = require('./glass-lab');
  lab.open();
  console.log('[glass-lab] 窗口已打开（关闭窗口即退出）');
}

async function runShotLab() {
  const lab = require('./glass-lab');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const outDir = app.isPackaged ? path.join(app.getPath('temp'), 'sci-shots') : path.join(__dirname, '..', '..', 'shots');
  fs.mkdirSync(outDir, { recursive: true });
  // GUI 子系统里 console 不可靠 → 诊断一律落盘（与 --shot-init 同一约定）
  const report = path.join(os.tmpdir(), 'sci-lab-report.txt');
  const log = (s) => {
    try {
      fs.appendFileSync(report, `${new Date().toISOString()} ${s}\n`);
    } catch (e) {
      /* ignore */
    }
  };
  try {
    fs.writeFileSync(report, `[shot-lab] start ${new Date().toISOString()}\n`);
  } catch (e) {
    /* ignore */
  }
  lab.open();
  let w = null;
  const dl = Date.now() + 12000;
  while (Date.now() < dl) {
    w = lab.getWindow();
    if (w && !w.webContents.isLoading()) {
      const ready = await w.webContents.executeJavaScript(`!!document.getElementById('g-ab2')`).catch(() => false);
      if (ready) break;
    }
    await sleep(150);
  }
  log(`window=${!!w} isLoading=${w ? w.webContents.isLoading() : 'n/a'}`);
  if (!w) {
    app.exit(1);
    return;
  }
  // 等截图到货 + 滤镜算完（每张卡都要跑一遍 SDF 位移图，给足时间）
  let info = null;
  const dl2 = Date.now() + 20000;
  while (Date.now() < dl2) {
    info = await w.webContents.executeJavaScript(`(() => {
      const g = (id) => document.getElementById(id);
      const filterOf = (id) => (g(id) ? g(id).style.filter || '' : '');
      const svg = (id) => document.getElementById(id + '-svg');
      const countDisp = (id) => { const s = svg(id); return s ? s.querySelectorAll('feDisplacementMap').length : 0; };
      return {
        bg: (g('g-liquid') || {}).style ? String(g('g-liquid').style.backgroundImage || '').slice(0, 24) : '',
        bgState: (document.getElementById('bgState') || {}).textContent || '',
        err: (document.getElementById('errbox') || {}).textContent || '',
        fCapture: filterOf('g-capture').slice(0, 40),
        fLiquid: filterOf('g-liquid').slice(0, 40),
        fAb2: filterOf('g-ab2').slice(0, 40),
        dispLiquid: countDisp('lab-liquid'),
        dispAb2: countDisp('lab-ab2'),
        dispAb5: countDisp('lab-ab5'),
        cards: document.querySelectorAll('.card').length,
      };
    })()`).catch((e) => ({ err: String((e && e.message) || e) }));
    log(`probe=${JSON.stringify(info)}`);
    if (info && /data:image\//.test(info.bg) && info.dispAb2 >= 3) break;
    await sleep(600);
  }
  fs.writeFileSync(path.join(outDir, 'glass-lab.png'), (await w.webContents.capturePage()).toPNG());
  // 再截一张「色散调到 0」的对照（证明 0 = 与现状完全一致：滤镜链回到单个 feDisplacementMap）
  await w.webContents.executeJavaScript(`(() => { const a = document.getElementById('aberration'); a.value = '0'; a.dispatchEvent(new Event('input')); return true; })()`).catch(() => false);
  await sleep(1500);
  const info0 = await w.webContents.executeJavaScript(`(() => {
    const svg = document.getElementById('lab-ab2-svg');
    return { dispAb2: svg ? svg.querySelectorAll('feDisplacementMap').length : 0 };
  })()`).catch((e) => ({ err: String((e && e.message) || e) }));
  log(`aberration=0 → ${JSON.stringify(info0)}`);
  fs.writeFileSync(path.join(outDir, 'glass-lab-ab0.png'), (await w.webContents.capturePage()).toPNG());
  lab.close();
  log(`files→ ${outDir}`);
  app.exit(0);
}

// ---------------- 设置页设计走查（--shot-config） ----------------
// 依次打开每个标签页截图（capturePage 只含页面本身，不含系统亚克力底），
// 外加一张搜索命中态，用于人眼复核布局与玻璃质感。
async function runShotConfig() {
  const outDir = app.isPackaged ? path.join(app.getPath('temp'), 'sci-shots') : path.join(__dirname, '..', '..', 'shots');
  fs.mkdirSync(outDir, { recursive: true });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  config.open();
  let cw = null;
  const dl = Date.now() + 8000;
  while (Date.now() < dl) {
    cw = config.getWindow();
    if (cw && !cw.webContents.isLoading()) {
      const ready = await cw.webContents.executeJavaScript(`!!document.querySelector('#tabs .tab[data-tab="events"]')`);
      if (ready) break;
    }
    await sleep(150);
  }
  if (!cw) {
    console.log('[shot-config] 配置窗口未就绪');
    app.exit(1);
    return;
  }
  const errNow = await cw.webContents.executeJavaScript(`(document.getElementById('errbox')||{}).textContent || ''`).catch((e) => 'probe-failed:' + e.message);
  fs.writeFileSync(path.join(os.tmpdir(), 'sci-config-err.txt'), `errbox=${JSON.stringify(errNow)}
`);
  const tabs = ['events', 'schedule', 'tasks', 'weather', 'display', 'wallpaper', 'pet', 'smart', 'advanced', 'about'];
  for (const t of tabs) {
    await cw.webContents.executeJavaScript(`(() => { const b = document.querySelector('#tabs .tab[data-tab="${t}"]'); if (b) b.click(); const m = document.querySelector('main'); if (m) m.scrollTop = 0; return !!b; })()`);
    await sleep(320);
    const info = await cw.webContents.executeJavaScript(`(() => { const m = document.querySelector('main'); return { active: !!document.querySelector('#tab-${t}.active'), fields: document.querySelectorAll('#tab-${t} .field').length, scrollH: m ? m.scrollHeight : 0 }; })()`);
    console.log(`[shot-config] tab=${t}`, JSON.stringify(info));
    fs.writeFileSync(path.join(outDir, `config-${t}.png`), (await cw.webContents.capturePage()).toPNG());
  }
  // 搜索命中态
  const searchInfo = await cw.webContents.executeJavaScript(`(() => {
    const b = document.getElementById('setSearch');
    b.value = '玻璃';
    b.dispatchEvent(new Event('input'));
    return true;
  })()`);
  await sleep(500);
  const searchState = await cw.webContents.executeJavaScript(`(() => ({
    activeTab: (document.querySelector('.tabpage.active') || {}).id || '',
    hits: document.querySelectorAll('.field.search-hit').length,
    misses: document.querySelectorAll('.field.search-miss').length,
    navHint: (document.getElementById('navHint') || {}).textContent || '',
  }))()`);
  console.log('[shot-config] search=', JSON.stringify(searchInfo), JSON.stringify(searchState));
  cw.webContents.executeJavaScript(`document.querySelector('main').scrollTop = 0`);
  await sleep(200);
  fs.writeFileSync(path.join(outDir, 'config-search.png'), (await cw.webContents.capturePage()).toPNG());
  config.close();
  console.log('[shot-config] files→', outDir);
  app.exit(0);
}

// ---------------- 初始化快照（--shot-init） ----------------
// 不干预状态机：自然启动后打印小岛/盖板几何 + 「文字为何看不见」相关的全部样式
// （含 CSS 动画真实状态 getAnimations），再复现一次「展开大窗口 → 收起」做对照。
// 产物：shots/init-before-expand.png、shots/init-after-expand.png
async function runShotInit() {
  const outDir = app.isPackaged ? path.join(app.getPath('temp'), 'sci-shots') : path.join(__dirname, '..', '..', 'shots');
  fs.mkdirSync(outDir, { recursive: true });
  // GUI 子系统进程的 stdout 在本机不可靠 → 诊断结论同时落盘（和自检日志同一套做法）
  const reportFile = path.join(os.tmpdir(), 'sci-init-report.txt');
  const log = (...parts) => {
    const line = parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ');
    console.log(line);
    try {
      fs.appendFileSync(reportFile, line + '\n', 'utf8');
    } catch (e) {
      /* ignore */
    }
  };
  try {
    fs.writeFileSync(reportFile, `[init] ${new Date().toISOString()} version=${app.getVersion()}\n`, 'utf8');
  } catch (e) {
    /* ignore */
  }
  const icover = require('./sensor-cover');
  /** 抓帧像素统计：不透明像素数 + 亮像素数（白字画出来时 bright 明显 > 0） */
  const stat = (img) => {
    const bmp = img.toBitmap();
    const sw = img.getSize().width;
    const sh = img.getSize().height;
    let n = 0;
    let brightN = 0;
    for (let y = 0; y < sh; y += 1) {
      for (let x = 0; x < sw; x += 1) {
        const i = (y * sw + x) * 4;
        const b = bmp[i];
        const g = bmp[i + 1];
        const r = bmp[i + 2];
        const a = bmp[i + 3];
        if (a > 40) n += 1;
        if (a > 40 && r > 180 && g > 180 && b > 180) brightN += 1;
      }
    }
    return { opaque: n, bright: brightN, size: `${sw}x${sh}`, png: img.toPNG() };
  };
  /** 深度样式快照：字看得见/看不见相关的每一项，重点看动画是否卡在 opacity:0 */
  const wxSnap = () =>
    island.win.webContents.executeJavaScript(`(() => {
      const row = document.querySelector('.s-row') || document.querySelector('.e-row') || document.querySelector('.z-wrap') || document.querySelector('.empty-wrap');
      const content = document.getElementById('content');
      const pill = document.getElementById('pill');
      const el = document.querySelector('.s-num') || document.querySelector('.s-emoji') || document.querySelector('.e-name');
      const cs = (n) => (n ? getComputedStyle(n) : null);
      const anims = row && row.getAnimations ? row.getAnimations().map((a) => ({ name: a.animationName, play: a.playState, t: a.currentTime, fill: a.effect && a.effect.getTiming ? a.effect.getTiming().fill : '' })) : [];
      // 谁盖住了文字：在文字的屏幕位置上问「最上层元素是谁」
      const probe = document.querySelector('.s-num') || document.querySelector('.s-emoji') || document.querySelector('.e-name');
      const pb = probe ? probe.getBoundingClientRect() : null;
      const at = pb ? document.elementFromPoint(Math.round(pb.left + pb.width / 2), Math.round(pb.top + pb.height / 2)) : null;
      const layer = (id) => {
        const n = document.getElementById(id);
        if (!n) return null;
        const c = getComputedStyle(n);
        const b = n.getBoundingClientRect();
        return { display: c.display, opacity: c.opacity, z: c.zIndex, vis: c.visibility, filter: (c.filter || '').slice(0, 18), rect: [Math.round(b.width), Math.round(b.height)], bgLen: (n.style.backgroundImage || '').length };
      };
      const rel = (n) => {
        const p = document.getElementById('pill');
        if (!n || !p) return null;
        const b = n.getBoundingClientRect();
        const pr = p.getBoundingClientRect();
        return [Math.round(b.left - pr.left), Math.round(b.right - pr.left), Math.round(b.width)];
      };
      const rowEl = document.querySelector('.s-row') || document.querySelector('.e-row');
      const rootVar = (k) => getComputedStyle(document.documentElement).getPropertyValue(k).trim();
      const geom = rowEl
        ? {
            row: rel(rowEl),
            rowOverflow: rowEl.scrollWidth - rowEl.clientWidth,
            l: rel(document.querySelector('.nb-l')),
            gap: rel(document.querySelector('.nb-gap')),
            r: rel(document.querySelector('.nb-r')),
            emoji: rel(document.querySelector('.s-emoji')),
            num: rel(document.querySelector('.s-num')),
            unit: rel(document.querySelector('.s-unit')),
            vars: { gap: rootVar('--notch-gap'), sl: rootVar('--notch-slot-l'), sr: rootVar('--notch-slot-r'), cx: rootVar('--notch-cx'), zoneW: rootVar('--notch-zone-w') },
          }
        : null;
      return {
        state: document.body.dataset.state,
        geom,
        notch: document.body.dataset.notch || '', layout: document.body.dataset.notchLayout || '',
        glass: document.body.dataset.glass || '', stripStyle: document.body.dataset.strip || '',
        topAtText: at ? at.id || at.className || at.tagName : null,
        layers: { glass: layer('glass'), gl: layer('glass-gl'), tint: layer('glass-tint'), noise: layer('noise'), content: layer('content') },
        rowTag: row ? row.className : null,
        rowOpacity: cs(row) ? cs(row).opacity : null,
        rowAnim: cs(row) ? cs(row).animationName + '/' + cs(row).animationPlayState + '/' + cs(row).animationFillMode : null,
        anims,
        contentOpacity: cs(content) ? cs(content).opacity : null,
        contentVisibility: cs(content) ? cs(content).visibility : null,
        contentColor: cs(content) ? cs(content).color : null,
        elFillColor: cs(el) ? cs(el).webkitTextFillColor : null,
        elOpacity: cs(el) ? cs(el).opacity : null,
        elColor: cs(el) ? cs(el).color : null,
        pillOpacity: cs(pill) ? cs(pill).opacity : null,
        pillW: pill ? Math.round(pill.getBoundingClientRect().width) : null,
        text: content ? content.textContent : '',
        fonts: document.fonts ? document.fonts.status : 'n/a',
      };
    })()`);
  for (const t of [1000, 2000, 3000, 4000]) {
    await new Promise((r) => setTimeout(r, 1000));
    console.log(`[shot-init] t≈${t}ms cover=`, icover.win ? JSON.stringify(icover.win.getBounds()) : 'none', '| state=', island.state);
  }
  const snapA = await wxSnap();
  const shotA = stat(await island.win.webContents.capturePage());
  log('[shot-init] 启动时 快照=', JSON.stringify(snapA));
  log('[shot-init] 启动时 像素=', JSON.stringify({ opaque: shotA.opaque, bright: shotA.bright, size: shotA.size }));
  log('[shot-init] win=', JSON.stringify(island.win.getBounds()), 'visible=', island.win.isVisible(), 'cover=', icover.win ? JSON.stringify(icover.win.getBounds()) : 'none', 'zone=', JSON.stringify((island.notchSpec() || {}).zone || null));
  fs.writeFileSync(path.join(outDir, 'init-before-expand.png'), shotA.png);
  // 复现用户的操作：展开大窗口 → 收起 → 再量一次（对照）
  island.manualState('zoom', 4000);
  await new Promise((r) => setTimeout(r, 1400));
  island.manualState('strip', 20000);
  await new Promise((r) => setTimeout(r, 1400));
  const snapB = await wxSnap();
  const shotB = stat(await island.win.webContents.capturePage());
  log('[shot-init] 展开收起后 快照=', JSON.stringify(snapB));
  log('[shot-init] 展开收起后 像素=', JSON.stringify({ opaque: shotB.opaque, bright: shotB.bright, size: shotB.size }));
  fs.writeFileSync(path.join(outDir, 'init-after-expand.png'), shotB.png);
  const diff = {};
  for (const k of Object.keys(snapA)) if (JSON.stringify(snapA[k]) !== JSON.stringify(snapB[k])) diff[k] = [snapA[k], snapB[k]];
  log('[shot-init] 差异=', JSON.stringify(diff));
  app.exit(0);
}

// ---------------- 收缩回灵动岛诊断（--shot-collapse） ----------------
// 复现「横幅 → 灵动岛」收缩的那一下：动画中途密集采样 DOM，
// 看两瓣内容是否还在可视区内（曾经因为用旧窗口坐标算让位而整块消失）。
async function runShotCollapse() {
  const outDir = app.isPackaged ? path.join(app.getPath('temp'), 'sci-shots') : path.join(__dirname, '..', '..', 'shots');
  fs.mkdirSync(outDir, { recursive: true });
  settings.update({ ui: { cameraNotch: { enabled: true, preset: 'center' } } });
  const d = new Date(Date.now() + 12 * 86400000);
  const p2 = (n) => String(n).padStart(2, '0');
  settings.update({
    events: [{ id: 'collapse-1', name: '期末考', emoji: '📘', color: '#4f7cff', date: `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T08:30:00`, enabled: true }],
  });
  island.applySettings();
  await new Promise((r) => setTimeout(r, 900));
  const read = () =>
    island.win.webContents.executeJavaScript(`(() => {
      const p = document.getElementById('pill');
      const pr = p.getBoundingClientRect();
      const row = document.querySelector('.s-row');
      const l = document.querySelector('.nb-l');
      const r2 = document.querySelector('.nb-r');
      const inner = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return [Math.round(b.left - pr.left), Math.round(b.right - pr.left)]; };
      const content = document.getElementById('content');
      const visible = (() => {
        if (!row) return false;
        const els = row.querySelectorAll('.s-emoji, .s-num, .s-unit');
        return Array.prototype.some.call(els, (el) => {
          const b = el.getBoundingClientRect();
          return b.width > 0 && b.height > 0 && b.right > pr.left && b.left < pr.right;
        });
      })();
      return {
        state: document.body.dataset.state, layout: document.body.dataset.notchLayout || '',
        pillW: Math.round(pr.width), winW: Math.round(window.innerWidth),
        gap: getComputedStyle(document.documentElement).getPropertyValue('--notch-gap').trim(),
        rowW: row ? Math.round(row.getBoundingClientRect().width) : 0,
        left: inner(l), right: inner(r2), text: content ? content.textContent : '', visible,
      };
    })()`);
  island.manualState('expanded', 60000);
  await new Promise((r) => setTimeout(r, 1200));
  const before = await read();
  island.manualState('strip', 60000);
  const samples = [];
  for (let i = 0; i < 14; i += 1) {
    await new Promise((r) => setTimeout(r, 60));
    samples.push(await read());
  }
  const after = samples[samples.length - 1];
  const lost = samples.filter((s) => !s.visible);
  console.log('[shot-collapse] before=', JSON.stringify(before));
  console.log('[shot-collapse] samples=', JSON.stringify(samples.map((s) => `${s.pillW}/${s.gap}/${s.text ? 'txt' : '空'}${s.visible ? '' : '❗丢'}`)));
  console.log('[shot-collapse] after=', JSON.stringify(after), '| 丢失帧数=', lost.length);
  if (lost.length) console.log('[shot-collapse] 首个丢失帧=', JSON.stringify(lost[0]));
  fs.writeFileSync(path.join(outDir, 'collapse-strip.png'), (await island.win.webContents.capturePage()).toPNG());
  app.exit(lost.length ? 1 : 0);
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
  for (const st of ['strip', 'expanded', 'zoom', 'dock', 'progress']) {
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

  // 课表预览（配置页显示「当前/下一节」与提醒文案预览）
  ipcMain.handle('schedule:preview', () => {
    const now = new Date();
    const pv = tasks.classPreview(now);
    const st = settings.load();
    const cfg = (st.schedule && st.schedule.notify) || {};
    const sample = { n: 3, subject: '数学', label: '第 3 节 数学', min: cfg.beforeStart || 3, time: '09:40' };
    return {
      now: `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`,
      ...pv,
      templates: {
        start: schMod.fillTemplate(cfg.templateStart, sample),
        atStart: schMod.fillTemplate(cfg.templateAtStart, sample),
        beforeEnd: schMod.fillTemplate(cfg.templateBeforeEnd, sample),
        atEnd: schMod.fillTemplate(cfg.templateAtEnd, sample),
      },
    };
  });

  // —— 天气（Open-Meteo，免密钥）——
  // 状态：给配置页显示当前天气摘要、是否过期、上次错误、下一条提醒
  ipcMain.handle('weather:status', () => weather.preview(new Date()));
  // 立即刷新（老师手动触发；失败也返回可读原因，不抛）
  ipcMain.handle('weather:refresh', async () => {
    const r = await weather.refresh({ force: true });
    island.pushWeather(true);
    return { ...weather.preview(new Date()), ok: r.ok, error: r.error || '' };
  });
  // 一键自动定位（按公网 IP；仅点击时执行，不做后台定位）
  ipcMain.handle('weather:locate', async () => {
    try {
      const hit = await weather.locateByIp();
      const label = [hit.city, hit.admin, hit.country].filter(Boolean).join(' · ');
      settings.update({ weather: { city: hit.city || (settings.load().weather || {}).city, resolvedName: label, lat: hit.lat, lon: hit.lon } });
      const r = await weather.refresh({ force: true });
      island.pushWeather(true);
      config.broadcastChanged();
      return { ok: r.ok, error: r.error || '', located: hit, label };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  });
  // 城市解析预览（不写设置，只回显「城市 · 省/州 · 国家」让老师确认）
  ipcMain.handle('weather:preview', async (_e, patch) => {
    try {
      const cur = settings.load().weather || {};
      const city = patch && patch.city ? patch.city : cur.city;
      const hit = await weather.resolveCity(city);
      return { ok: true, ...hit, label: [hit.name, hit.admin, hit.country].filter(Boolean).join(' · ') };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  });
  // 试一条：立即弹一条示例（用缓存数据），用来确认文案与动画效果
  ipcMain.handle('weather:test-reminder', (_e, kind) => {
    const cfg = settings.load().weather || {};
    const snap = weather.loadCache().snapshot;
    const k = kind || 'today';
    const s = snap ? weather.summarize(snap, k, { weather: cfg }) : null;
    if (!s) return { ok: false, error: snap ? '这个类型当前没有可播报的内容（例如未来几小时没有降雨）' : '还没有天气数据，请先点「立即刷新」' };
    island.showNotification(s.title, s.body, {
      alert: true,
      keywords: (s.keywords || []).concat(cfg.alertKeywords || []),
      weather: cfg.anim === false ? '' : weather.animOf(snap, k),
    });
    return { ok: true, title: s.title, body: s.body };
  });

  // 盖板自定义内容：变量清单（配置页提示用）+ 预览（按当前真实数据渲染模板）
  ipcMain.handle('config:cover-vars', () => require('./cover-text').VARS);
  ipcMain.handle('config:cover-preview', (_e, tpl) => island.coverTextPreview(String(tpl || '').slice(0, 200)));

  // 玻璃实验室窗口：截图推送 / 重新取屏 / 关闭 / 参数写回设置
  ipcMain.handle('lab:refresh', () => require('./glass-lab').refresh('ipc'));
  ipcMain.handle('lab:live', (_e, on) => require('./glass-lab').setLive(on));
  ipcMain.handle('lab:close', () => require('./glass-lab').close());
  ipcMain.handle('lab:apply', (_e, params) => {
    const ui = require('./glass-lab').applyParams(params);
    if (island && island.applySettings) island.applySettings();
    config.broadcastChanged();
    return ui;
  });
  ipcMain.handle('config:open-glass-lab', () => {
    require('./glass-lab').open();
    return true;
  });

  ipcMain.handle('config:update', (_e, patch) => {
    const next = settings.update(patch);
    island.applySettings();
    if (pet) pet.applySettings(); // 桌宠开关/尺寸/透明度即时生效
    applyAutoStart(); // 开机自启变化即时生效
    if (patch && patch.weather) {
      // 天气设置变化：先按新配置推一次状态（城市/显示/动画开关立刻见效），启用后异步拉数据
      island.pushWeather(true);
      if (next.weather && next.weather.enabled) {
        weather
          .refresh({ force: true })
          .then(() => island.pushWeather(true))
          .catch(() => {});
      }
    }
    config.broadcastChanged();
    return next;
  });

  // 桌宠：状态自检（配置页显示用）
  ipcMain.handle('pet:status', async () => {
    if (!pet) return { enabled: false };
    const st = settings.load();
    const c = pet.cfg();
    return {
      enabled: c.enabled,
      visible: !!pet.visible,
      classMode: !!pet.env.inClass,
      fullscreen: !!pet.env.fullscreen,
      model: c.ai.model,
      modelForced: c.ai.modelForced,
      hasKey: !!c.ai.apiKey,
      presetOnly: c.ai.presetOnly,
      qaCount: (c.qa || []).length,
      stats: pet.statsView(),
      scheduleEnabled: !!(st.schedule && st.schedule.enabled),
    };
  });
  ipcMain.handle('pet:check-ai', async () => (pet ? pet.checkConnection() : { ok: false, reason: '桌宠未初始化' }));
  ipcMain.handle('pet:test-say', async () => {
    if (pet) pet.say('你好，我是班级小助手，课间可以来找我聊天～', { alert: false });
    return true;
  });

  ipcMain.handle('config:close', () => config.close());
  // 无边框窗口的自绘标题栏：最小化 + 拖动
  ipcMain.handle('config:minimize', () => config.minimize());
  ipcMain.handle('config:toggle-maximize', () => config.toggleMaximize());
  ipcMain.handle('config:drag', (_e, p) => {
    const a = p || {};
    if (a.phase === 'start') return config.dragStart(a.x, a.y);
    if (a.phase === 'move') return config.dragMove(a.x, a.y);
    return config.dragEnd();
  });

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
  // 加速模式（--test-fast）：等待/动画/tick 一起压短，断言一条不少，整轮跑得快得多
  const FAST = process.argv.includes('--test-fast');
  const SCALE = FAST ? 0.35 : 1;
  if (FAST) {
    process.env.SCI_ANIM_MS = '60'; // 状态切换动画（150ms / 避让 550ms）→ 60ms
    process.env.SCI_TICK_MS = '120'; // 状态机 tick 350ms → 120ms
    process.env.SCI_TEST_FAST = '1'; // 探针采样也更密
  }
  // 便携版（NSIS 包装）的控制台输出拿不到，自检结果同时写入
  // %TEMP%\sci-test-last.log，便于排查失败项
  const testLog = path.join(os.tmpdir(), 'sci-test-last.log');
  try {
    fs.writeFileSync(testLog, `[test] start ${new Date().toISOString()} version=${app.getVersion()} fast=${FAST}\n`, 'utf8');
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
  const sleep = (ms) => new Promise((r) => setTimeout(r, FAST ? Math.max(30, Math.round(ms * SCALE)) : ms));

  (async () => {
    try {
      if (FAST) {
        // 加速模式下把避让动画也压短（这条设置只影响本次自检）
        settings.update({ ui: { cameraNotch: { animMs: 60 } } });
      }
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
        state: 'strip', expandedSinceMs: 0, // 横幅模式已去掉：闲置直接进大窗口
      };
      ok('T2 有操作→灵动岛', island.decideState(base) === 'strip');
      ok('T2 闲置5s→直接放大到大窗口（无横幅中间态）', island.decideState({ ...base, idleMs: 5000 }) === 'zoom');
      ok('T2 闲置不足 expandIdleSec→维持灵动岛', island.decideState({ ...base, idleMs: 3000 }) === 'strip');
      ok('T2 两个闲置门槛取较大值（zoomIdleSec=15 时闲置 5s 不放大）', island.decideState({ ...base, zoomIdleSec: 15, idleMs: 5000 }) === 'strip');
      ok('T2 闲置 15s（达两个门槛）→大窗口', island.decideState({ ...base, zoomIdleSec: 15, idleMs: 15000 }) === 'zoom');
      ok('T2 已在大屏且继续闲置→保持大屏', island.decideState({ ...base, zoomIdleSec: 15, state: 'zoom', idleMs: 99999 }) === 'zoom');
      ok('T2 大屏有操作→收回细条', island.decideState({ ...base, state: 'zoom', idleMs: 100 }) === 'strip');
      ok('T2 关闭大屏→闲置不放大（维持灵动岛）', island.decideState({ ...base, zoomIdleSec: 15, zoomAllowed: false, idleMs: 99999 }) === 'strip');
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
      ok('T2 操作后冷却期内不自动弹大屏（维持灵动岛）', island.decideState({ ...base, zoomIdleSec: 15, zoomCooldown: true, idleMs: 99999 }) === 'strip');
      ok('T2 手动保持期→保持现状', island.decideState({ ...base, holding: true, idleMs: 99999 }) === null);
      ok('T2 关闭智能→保持现状', island.decideState({ ...base, smart: false, idleMs: 99999 }) === null);
      ok('T2 窗口最大化→保持灵动岛', island.decideState({ ...base, maximized: true, idleMs: 99999 }) === 'strip');

      // —— T3 配置窗口生命周期（核心 bug 复现）——
      config.open();
      // 等页面真的加载完（加速模式下固定 sleep 会太短）
      const t3ddl = Date.now() + 8000;
      while (!config.isLoaded() && Date.now() < t3ddl) await sleep(100);
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
      // 轮询等窗口就绪：fast 模式下 sleep 被压到 ~1/3，固定等待在忙碌机器上会偶发不够
      let t3ready = false;
      const t3dl = Date.now() + 6000;
      while (Date.now() < t3dl) {
        if (config.isOpen() && config.isLoaded()) {
          t3ready = true;
          break;
        }
        await sleep(120);
      }
      ok(`T3 重新打开正常 (open=${config.isOpen()} loaded=${config.isLoaded()})`, t3ready);
      config.close();
      await sleep(400);

      // —— T4 事件 CRUD ——
      settings.upsertEvent({ id: null, name: '测试事件', date: '2099-01-01T00:00:00', emoji: '🎯', color: '#ff0000', enabled: true });
      const added = settings.events().find((e) => e.name === '测试事件');
      ok('T4 事件添加', !!added);
      settings.removeEvent(added.id);
      ok('T4 事件删除', !settings.events().some((e) => e.id === added.id));

      // —— T5 探针、圆角区域与截屏排除 ——
      let probeOk5 = false;
      const dl5 = Date.now() + 6000;
      while (Date.now() < dl5) {
        if (probe.ready && !!probe.last) {
          probeOk5 = true;
          break;
        }
        await sleep(150);
      }
      ok(`T5 系统探针就绪 (ready=${probe.ready} hasLast=${!!probe.last})`, probeOk5);
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
      // 探针停止时管道已关（探针先自己退出/被关）不能抛 EPIPE：
      // 挂过 stdin error + 只写可写管道，退出应用时才不会弹「主进程崩溃」框
      {
        const stdinHasErrHandler = !!(probe.child && probe.child.stdin && probe.child.stdin.listenerCount('error') > 0);
        const holder = probe.child;
        let threw = null;
        probe.child = { killed: false, kill() {}, stdin: { destroyed: true, writable: false, write() { throw new Error('EPIPE'); } } };
        try {
          probe.stop();
        } catch (e) {
          threw = e && e.message;
        }
        probe.child = holder;
        probe.stopped = false;
        ok(
          `T5 探针停止不因 EPIPE 崩主进程 (stdin 挂 error=${stdinHasErrHandler}，管道已关时抛出=${threw || '无'}，全局兜底=${process.listenerCount('uncaughtException') > 0})`,
          stdinHasErrHandler && !threw && process.listenerCount('uncaughtException') > 0
        );
      }
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
      island.manualState('strip', 0); // 用户刚把它收起（冷却期从这一刻开始）
      island.animating = false;
      island.lastAutoSwitch = 0;
      island.tick();
      ok(`T9 操作后冷却期内不自动弹大屏（收成灵动岛）(state=${island.state}, cooldown=${island.zoomCooldownUntil > Date.now()})`, island.state === 'strip');
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
      // 屏蔽期是「gesture 后 400ms 内忽略 tap」：显式把时间基准钉在"刚刚拖放过"，
      // 不再依赖 sleep 的实际耗时（机器负载高时 sleep 会被拉长到 400ms 之外 → 偶发误判）
      island.gestureAt = Date.now();
      island.onAction({ type: 'tap' }); // gesture 后误触 tap 应被忽略
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
      // 等通知真的渲染出来（加速模式下固定 sleep 会太短）
      const nKeyRead = () =>
        island.win.webContents.executeJavaScript(`({ key: !!document.querySelector('.n-key'), keyText: (document.querySelector('.n-key')||{}).textContent, btn: (document.querySelector('#dnd-bar .n-btn')||{}).textContent, bodyAnim: document.querySelector('.n-body') ? getComputedStyle(document.querySelector('.n-body')).animationName : 'none', titleAnim: getComputedStyle(document.querySelector('.n-title')).animationName })`);
      let nKeyDom = await nKeyRead();
      const nKeyDdl = Date.now() + 6000;
      while (nKeyDom.btn !== '取消关机' && Date.now() < nKeyDdl) {
        await sleep(150);
        nKeyDom = await nKeyRead();
      }
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
      // 连续采样直到看到两个不同标题（轮播周期 2s；窗口按实际时间给足，加速模式下也成立）
      const heads = new Set();
      const t13ddl = Date.now() + 9000;
      while (heads.size < 2 && Date.now() < t13ddl) {
        const h = await island.win.webContents.executeJavaScript(`(document.querySelector('.z-label')||{}).textContent || ''`);
        if (h) heads.add(h);
        await sleep(400);
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
      // 等细条截屏推送 + 滤镜重建到位（截屏/滤镜是异步链路，用轮询代替固定等待）
      let sg = await readStripGlass();
      const sgDdl = Date.now() + 9000;
      while ((sg.display !== 'block' || !String(sg.filter).includes('lg-filter') || !(sg.bgLen > 0)) && Date.now() < sgDdl) {
        await sleep(150);
        sg = await readStripGlass();
      }
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
      // 取流是异步的（getDisplayMedia + 首帧），轮询等它真的起来
      const gl16ddl = Date.now() + 12000;
      while (!island.glActive && Date.now() < gl16ddl) await sleep(200);
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
      // 渲染层从视频帧算亮度（统计回传有周期，等它到再断言）
      const brDdl16 = Date.now() + 9000;
      while (typeof (island.glStats || {}).brightnessComputed !== 'number' && Date.now() < brDdl16) await sleep(300);
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
      // 切回 CPU 液态玻璃：视频流应停止、截屏循环恢复（截屏按需触发，等它来一次）
      settings.update({ ui: { glassMode: 'liquid' } });
      island.applySettings();
      await sleep(2500);
      const cap16c = island.perfCapture.s.calls;
      const capDdl16 = Date.now() + 9000;
      while (island.perfCapture.s.calls === cap16c && Date.now() < capDdl16) await sleep(300);
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
      // GPU 取流是异步的：等它真起来再读参数
      let o100 = await readOpts();
      const o100ddl = Date.now() + 12000;
      while (!o100 && Date.now() < o100ddl) {
        await sleep(200);
        o100 = await readOpts();
      }
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
      // 等 GPU 链路真的生效（取流异步），否则「不再截屏」的前提不成立
      const gl22ddl = Date.now() + 12000;
      while (!island.glStreamActive() && Date.now() < gl22ddl) await sleep(200);
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

      // —— T28 桌宠素材包（目录 + pet.json → 渲染层帧；三种写法都支持）——
      const packMod = require('./pet-pack');
      const tmpPack = path.join(os.tmpdir(), `sci-pet-pack-${process.pid}`);
      fs.rmSync(tmpPack, { recursive: true, force: true });
      const gen28 = packMod.ensureSamplePack(tmpPack);
      const read28 = packMod.readPack(tmpPack);
      ok(
        `T28 示例素材包生成与读取 (新建 ${gen28.created.length} 个文件，状态=${read28.summary})`,
        gen28.created.length >= 10 && read28.ok === true && !!read28.states.walk && read28.states.walk.files.length === 4 && read28.states.idle.files.length === 3
      );
      const pay28 = packMod.packToPayload(tmpPack);
      ok(
        `T28 打包成 data URL (状态=${Object.keys(pay28.states).join(',')}，idle=${pay28.states.idle.frames.length} 帧 fps=${pay28.states.idle.fps}，首帧前缀=${String(pay28.states.idle.frames[0]).slice(0, 24)})`,
        pay28.ok === true && pay28.states.idle.frames.length === 3 && String(pay28.states.idle.frames[0]).startsWith('data:image/svg+xml;base64,')
      );
      // 精灵图 / 动图两种写法
      fs.writeFileSync(path.join(tmpPack, 'walk.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
      fs.writeFileSync(path.join(tmpPack, 'idle.webp'), Buffer.from([0x52, 0x49, 0x46, 0x46, 0x00, 0x00]));
      fs.writeFileSync(path.join(tmpPack, 'pet.json'), JSON.stringify({ name: '写法测试', states: { idle: { file: 'idle.webp', fps: 12 }, walk: { sheet: 'walk.png', frames: 6, cols: 6, fps: 10 } } }), 'utf8');
      const read28b = packMod.readPack(tmpPack);
      const pay28b = packMod.packToPayload(tmpPack);
      ok(
        `T28 精灵图/动图写法 (walk=${read28b.states.walk.kind}/${read28b.states.walk.count} 帧，idle=${read28b.states.idle.kind}，载荷 sheet=${JSON.stringify(pay28b.states.walk.sheet)})`,
        read28b.ok === true && read28b.states.walk.kind === 'sheet' && read28b.states.idle.kind === 'anim' && pay28b.states.walk.sheet.cols === 6 && pay28b.states.walk.frames.length === 1
      );
      // 素材缺失 / 坏 JSON 都要有明确报错，不能崩
      fs.writeFileSync(path.join(tmpPack, 'pet.json'), JSON.stringify({ states: { idle: { frames: ['nope.png'] } } }), 'utf8');
      const read28c = packMod.readPack(tmpPack);
      fs.writeFileSync(path.join(tmpPack, 'pet.json'), '{ 坏 json', 'utf8');
      const read28d = packMod.readPack(tmpPack);
      ok(
        `T28 素材缺失/坏清单有报错不崩 (缺失 ok=${read28c.ok} ${JSON.stringify((read28c.errors || [])[0])}，坏 JSON reason=${read28d.reason})`,
        read28c.ok === false && /找不到文件/.test((read28c.errors || [])[0] || '') && read28d.reason === 'bad-json'
      );
      // 真实加载：切到示例包 → 渲染层拿到帧；切到空目录 → 回落占位小人
      packMod.ensureSamplePack(tmpPack);
      const empty28 = path.join(os.tmpdir(), `sci-pet-empty-${process.pid}`);
      fs.rmSync(empty28, { recursive: true, force: true });
      fs.mkdirSync(empty28, { recursive: true });
      settings.update({ pet: { enabled: true, pack: tmpPack } });
      pet.applySettings();
      await sleep(1500);
      const pw28 = pet.win;
      // 注意：__petState 里带函数（alphaAt/hitAt），executeJavaScript 不能整对象回传 → 只取可序列化字段
      const pick28 = `(() => { const s = window.__petState(); return { spriteStates: s.spriteStates, spriteFrames: s.spriteFrames, usingSprite: s.usingSprite, x: s.x, y: s.y, alpha: s.alphaAt(s.x, s.y - 6) }; })()`;
      const sprite28 = await pw28.webContents.executeJavaScript(pick28);
      settings.update({ pet: { pack: empty28 } });
      pet.loadPack();
      await sleep(600);
      const fallback28 = await pw28.webContents.executeJavaScript(pick28);
      ok(
        `T28 渲染层用素材包画帧 (状态=${(sprite28.spriteStates || []).join(',')}，帧数=${JSON.stringify(sprite28.spriteFrames)}，正在用素材=${sprite28.usingSprite})`,
        (sprite28.spriteStates || []).includes('walk') && (sprite28.spriteFrames || {}).walk >= 4 && (sprite28.spriteFrames || {}).idle >= 3
      );
      ok(
        `T28 没有素材时回落内置占位小人 (状态数=${(fallback28.spriteStates || []).length}，正在用素材=${fallback28.usingSprite}，像素不透明=${fallback28.alpha > 25})`,
        (fallback28.spriteStates || []).length === 0 && fallback28.usingSprite === false && fallback28.alpha > 25
      );
      fs.rmSync(tmpPack, { recursive: true, force: true });
      fs.rmSync(empty28, { recursive: true, force: true });
      settings.update({ pet: { enabled: false, pack: '' } });
      await sleep(200);

      // —— T26 桌宠大脑与 AI 层（纯逻辑，不碰窗口/网络）——
      const brain = require('./pet-brain');
      const aiMod = require('./ai');
      ok(
        `T26 行为决策 (全屏→${brain.decidePetAction({ fullscreen: true }).action}，上课→${brain.decidePetAction({ inClass: true }).action}，说话→${brain.decidePetAction({ talking: true }).action}，久闲→${brain.decidePetAction({ sinceInteractMs: 10 * 60 * 1000 }).action})`,
        brain.decidePetAction({ fullscreen: true }).action === 'hidden' &&
          brain.decidePetAction({ inClass: true }).action === 'quiet' &&
          brain.decidePetAction({ talking: true }).action === 'talk' &&
          brain.decidePetAction({ sinceInteractMs: 10 * 60 * 1000 }).action === 'sleep'
      );
      const actSeq = [0, 1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000].map((s) => brain.decidePetAction({ seed: s, cfg: { walkSec: 3, idleSec: 3 } }).action);
      ok(`T26 走动/发呆交替且可复现 (${actSeq.join(',')})`, actSeq.includes('walk') && actSeq.includes('idle') && brain.decidePetAction({ seed: 7 }).action === brain.decidePetAction({ seed: 7 }).action);
      ok(
        `T26 开口规则 (上课问作业→${brain.canPetSpeak({ inClass: true, question: '这题怎么做' }).mode}，上课问课表→${brain.canPetSpeak({ inClass: true, question: '下节课是什么', aiReady: true, quotaLeftMin: 5, quotaLeftDay: 5 }).mode}，无 key→${brain.canPetSpeak({ question: '作业交到哪', aiReady: false }).mode}，超额→${brain.canPetSpeak({ question: '你好', aiReady: true, quotaLeftMin: 0, quotaLeftDay: 5 }).mode})`,
        brain.canPetSpeak({ inClass: true, question: '这题怎么做' }).mode === 'refuse' &&
          brain.canPetSpeak({ inClass: true, question: '下节课是什么', aiReady: true, quotaLeftMin: 5, quotaLeftDay: 5 }).mode === 'ai' &&
          brain.canPetSpeak({ question: '作业交到哪', aiReady: false }).mode === 'preset' &&
          brain.canPetSpeak({ question: '你好', aiReady: true, quotaLeftMin: 0, quotaLeftDay: 5 }).mode === 'quota'
      );
      const qa26 = [{ q: '作业交到哪', keys: ['作业'], a: '交给课代表' }, { q: '值日表', keys: ['值日', '打扫'], a: '贴在后墙' }];
      ok(
        `T26 预置问答匹配 (${JSON.stringify((brain.pickPresetAnswer('今天的作业交到哪？', qa26) || {}).answer)} / ${JSON.stringify((brain.pickPresetAnswer('我该打扫哪里', qa26) || {}).answer)} / 未命中=${brain.pickPresetAnswer('量子力学', qa26)})`,
        (brain.pickPresetAnswer('今天的作业交到哪？', qa26) || {}).answer === '交给课代表' &&
          (brain.pickPresetAnswer('我该打扫哪里', qa26) || {}).answer === '贴在后墙' &&
          brain.pickPresetAnswer('量子力学', qa26) === null
      );
      const long26 = brain.guardAnswer('啊'.repeat(300), { maxChars: 50 });
      ok(
        `T26 输出护栏 (超长→${long26.text.length} 字/截断=${long26.truncated}，敏感词→${brain.guardAnswer('说说充值', { blocked: ['充值'] }).blocked}，代码块清除=${brain.guardAnswer('```js\nlet a=1\n```', {}).text.indexOf('```') < 0})`,
        long26.text.length <= 52 && long26.truncated === true && brain.guardAnswer('说说充值', { blocked: ['充值'] }).blocked === true
      );
      const req26 = aiMod.buildRequest('下节课是什么', { now: '10:00', nextClass: '数学' }, { apiKey: 'k' });
      const forced26 = aiMod.normalizeConfig({ model: 'deepseek-reasoner' });
      ok(
        `T26 永不开启思考 (请求 thinking=${JSON.stringify(req26.body.thinking)}，reasoner 被改成 ${forced26.model}/${forced26.modelForced}，URL=${req26.url})`,
        req26.body.thinking.type === 'disabled' && forced26.model === 'deepseek-chat' && forced26.modelForced === true && req26.url === 'https://api.deepseek.com/chat/completions'
      );
      const qk26 = { day: 'd1', minute: 'm1' };
      ok(
        `T26 配额与缓存 (每分钟上限=${aiMod.checkQuota({ minuteKey: 'm1', minuteCount: 2, dayKey: 'd1', dayCount: 0 }, { perMinute: 2, perDay: 9 }, qk26).reason}，每日上限=${aiMod.checkQuota({ minuteKey: 'm1', minuteCount: 0, dayKey: 'd1', dayCount: 9 }, { perMinute: 9, perDay: 9 }, qk26).reason}，跨分钟重置=${aiMod.checkQuota({ minuteKey: 'm0', minuteCount: 99, dayKey: 'd1', dayCount: 1 }, { perMinute: 2, perDay: 9 }, qk26).ok}，缓存键一致=${aiMod.cacheKey(' 你好 ', 'd1') === aiMod.cacheKey('你好', 'd1')})`,
        aiMod.checkQuota({ minuteKey: 'm1', minuteCount: 2, dayKey: 'd1', dayCount: 0 }, { perMinute: 2, perDay: 9 }, qk26).reason === 'per-minute' &&
          aiMod.checkQuota({ minuteKey: 'm1', minuteCount: 0, dayKey: 'd1', dayCount: 9 }, { perMinute: 9, perDay: 9 }, qk26).reason === 'per-day' &&
          aiMod.cacheKey(' 你好 ', 'd1') === aiMod.cacheKey('你好', 'd1')
      );
      ok(
        `T26 SSE 解析 (增量=${JSON.stringify((aiMod.parseSseLine('data: {"choices":[{"delta":{"content":"你"}}]}') || {}).delta)}，思考内容可识别=${JSON.stringify((aiMod.parseSseLine('data: {"choices":[{"delta":{"reasoning_content":"嗯"}}]}') || {}).reasoning)}，结束=${(aiMod.parseSseLine('data: [DONE]') || {}).done})`,
        (aiMod.parseSseLine('data: {"choices":[{"delta":{"content":"你"}}]}') || {}).delta === '你' &&
          (aiMod.parseSseLine('data: {"choices":[{"delta":{"reasoning_content":"嗯"}}]}') || {}).reasoning === '嗯' &&
          (aiMod.parseSseLine('data: [DONE]') || {}).done === true
      );

      // —— T27 桌宠窗口与问答链路（真实窗口 + 打桩的 AI 流）——
      settings.update({ schedule: { enabled: false } }); // 先确保"不在上课时间"，避免闲聊被静默规则拦掉
      settings.update({
        pet: {
          enabled: true,
          scale: 100,
          speed: 100,
          opacity: 0.9,
          hideOnFullscreen: true,
          quietInClass: true,
          announceClass: true,
          ai: { enabled: true, apiKey: '', perMinute: 2, perDay: 20, cacheMinutes: 10 },
          qa: qa26,
        },
      });
      if (pet) pet.applySettings();
      const petDeadline = Date.now() + 8000;
      while (pet && !pet.ready && Date.now() < petDeadline) await sleep(150);
      const pw = pet && pet.win;
      const petWin = await (async () => {
        if (!pw || pw.isDestroyed()) return null;
        return pw.webContents.executeJavaScript(`(() => { const s = window.__petState ? window.__petState() : null; return s ? { w: s.w, h: s.h, x: s.x, y: s.y, action: s.action, center: s.alphaAt(s.x, s.y - 6), corner: s.alphaAt(4, 4), hitCenter: s.hitAt(s.x, s.y - 6), hitCorner: s.hitAt(4, 4) } : null; })()`);
      })();
      ok(
        `T27 桌宠窗口：透明置顶 + 舞台内移动 (窗口=${pw && !pw.isDestroyed() ? 'ok' : '无'}，置顶=${pw && pw.isAlwaysOnTop()}，舞台=${petWin && petWin.w}/${petWin && petWin.h}，位置=${petWin && petWin.x},${petWin && petWin.y})`,
        !!petWin && !!pw && pw.isAlwaysOnTop() && petWin.w > 200 && petWin.h > 150 && petWin.x > 0 && petWin.y > 0
      );
      ok(
        `T27 逐像素命中（身上可点、空白穿透）：身上 alpha=${petWin && petWin.center}（命中=${petWin && petWin.hitCenter}），角落 alpha=${petWin && petWin.corner}（命中=${petWin && petWin.hitCorner}）`,
        !!petWin && petWin.center > 25 && petWin.hitCenter === true && petWin.corner <= 25 && petWin.hitCorner === false
      );
      // 舞台平移 + 位置持久化（先让桌宠进入上课静默，免得它自己走动把平移量搅乱）
      pet.envSource = () => ({ inClass: true, fullscreen: false, dnd: false });
      pet.sinceInteract = Date.now();
      pet.tick();
      await sleep(300);
      const pb27 = pw.getBounds();
      pet.moveStage(-80, 0);
      await sleep(200);
      const pa27 = pw.getBounds();
      const pend27 = pet._pendingPos ? { ...pet._pendingPos } : null; // 防抖中的待写位置
      pet.flushPos();
      ok(
        `T27 舞台平移并记住位置（位置写盘防抖） (x ${pb27.x}→${pa27.x}，待写=${JSON.stringify(pend27)} 落盘后 x=${settings.load().pet.x})`,
        Math.abs(pa27.x - (pb27.x - 80)) <= 2 && !!pend27 && pend27.x === pa27.x && settings.load().pet.x === pa27.x
      );
      // 移到工作区边界外：必须被夹住，并返回**实际**位移（渲染层按实际值补偿，否则贴边会来回抽搐）
      const wa27 = require('electron').screen.getPrimaryDisplay().workArea;
      const edgeBefore27 = pw.getBounds();
      const edgeFar27 = pet.moveStage(100000, 0);
      const edgeAfter27 = pw.getBounds();
      const edgeFar27b = pet.moveStage(100000, 0); // 已经在边上：应当原地不动
      ok(
        `T27 平移被工作区夹住并回报实际位移 (请求 +100000 → 实际 dx=${edgeFar27.dx}，窗口 x=${edgeAfter27.x} ≤ ${wa27.x + wa27.width - 60}；再推一次 moved=${edgeFar27b.moved})`,
        edgeAfter27.x === wa27.x + wa27.width - 60 &&
          edgeFar27.dx === edgeAfter27.x - edgeBefore27.x &&
          edgeFar27.dx < 100000 &&
          edgeFar27b.moved === false &&
          edgeFar27b.dx === 0
      );
      pet.flushPos();
      // 行为：上课静默 / 全屏隐藏
      pet.envSource = () => ({ inClass: true, fullscreen: false, dnd: false }); // 固定环境，避免被每秒的自动同步覆盖
      pet.sinceInteract = Date.now();
      pet.tick();
      await sleep(300);
      const quiet27 = await pw.webContents.executeJavaScript(`window.__petState().action`);
      pet.envSource = () => ({ inClass: false, fullscreen: true, dnd: false });
      pet.tick();
      await sleep(300);
      const hidden27 = pw.isVisible();
      ok(`T27 上课静默 / 全屏隐藏 (上课动作=${quiet27}，全屏可见=${hidden27})`, quiet27 === 'quiet' && hidden27 === false);
      pet.envSource = () => ({ inClass: false, fullscreen: false, dnd: false });
      pet.tick();
      await sleep(200);
      // 说话气泡
      pet.say('你好，我是班级小助手');
      await sleep(400);
      const said27 = await pw.webContents.executeJavaScript(`(() => { const s = window.__petState(); return { bubble: s.bubble, text: s.text }; })()`);
      ok(
        `T27 说话气泡 (气泡=${said27.bubble} 文本=${JSON.stringify(said27.text.slice(0, 12))})`,
        said27.bubble === true && said27.text.indexOf('小助手') >= 0
      );
      // 预置问答命中（无 key → 只答预置）
      const askPreset27 = await pet.ask('今天的作业交到哪？');
      await sleep(300);
      const presetText27 = await pw.webContents.executeJavaScript(`window.__petState().text`);
      ok(
        `T27 预置问答（离线可用）：mode=${askPreset27 && askPreset27.mode}，气泡=${JSON.stringify(String(presetText27).slice(0, 12))}`,
        askPreset27 && askPreset27.mode === 'preset' && String(presetText27).indexOf('课代表') >= 0
      );
      // 未命中预置且无 key → 友好兜底
      const askMiss27 = await pet.ask('量子纠缠是什么');
      ok(`T27 未命中预置且未配置 Key → 兜底话术 (${askMiss27 && askMiss27.mode})`, askMiss27 && askMiss27.mode === 'preset-miss');
      // 打桩 AI 流：验证流式 → 气泡、缓存命中、每分钟配额
      const realAsk = aiMod.askStream;
      let aiCalls27 = 0;
      aiMod.askStream = async (q, ctx, cfg, opts) => {
        aiCalls27 += 1;
        const text = '天空是蓝色的，因为空气把蓝光散射得更多。';
        for (const ch of text) {
          if (opts && opts.onDelta) opts.onDelta(ch);
        }
        return { ok: true, text, firstMs: 12, totalMs: 34, usage: { prompt_tokens: 100, completion_tokens: 20 }, servedModel: 'stub', reasoningLen: 0 };
      };
      settings.update({ pet: { ai: { apiKey: 'test-key', perMinute: 2, perDay: 20, cacheMinutes: 10 } } });
      const askAi27 = await pet.ask('为什么天是蓝的');
      await sleep(300);
      const aiText27 = await pw.webContents.executeJavaScript(`window.__petState().text`);
      const askCache27 = await pet.ask('为什么天是蓝的'); // 同问题 → 走缓存，不再调 AI
      const askQuota27 = await pet.ask('换个问题吧');      // 第 2 次真实调用用满每分钟额度
      const askQuota27b = await pet.ask('再换一个');       // 第 3 次应被每分钟配额拦住
      aiMod.askStream = realAsk;
      ok(
        `T27 流式问答链路 (mode=${askAi27 && askAi27.mode} 首字=${askAi27 && askAi27.firstMs}ms，气泡=${JSON.stringify(String(aiText27).slice(0, 10))}，缓存命中=${askCache27 && askCache27.mode}，AI 调用次数=${aiCalls27})`,
        askAi27 && askAi27.mode === 'ai' && String(aiText27).indexOf('蓝') >= 0 && askCache27 && askCache27.mode === 'cache' && aiCalls27 === 2
      );
      ok(
        `T27 每分钟配额熔断 (第 2 次 mode=${askQuota27 && askQuota27.mode}，第 3 次 mode=${askQuota27b && askQuota27b.mode})`,
        askQuota27 && askQuota27.mode === 'ai' && askQuota27b && askQuota27b.mode === 'quota'
      );
      // 上课时间拒绝闲聊
      pet.envSource = () => ({ inClass: true, fullscreen: false, dnd: false });
      const askClass27 = await pet.ask('讲个笑话吧');
      pet.envSource = () => ({ inClass: false, fullscreen: false, dnd: false });
      ok(`T27 上课时间拒绝闲聊 (mode=${askClass27 && askClass27.mode})`, askClass27 && askClass27.mode === 'refuse');
      // 课堂提醒联动：桌宠出面念一遍
      const before27 = await pw.webContents.executeJavaScript(`window.__petState().text`);
      pet.announce({ title: '上课', body: '上课时间到 · 第 3 节 数学' });
      await sleep(300);
      const after27 = await pw.webContents.executeJavaScript(`window.__petState().text`);
      ok(
        `T27 课堂提醒由桌宠播报 (前=${JSON.stringify(String(before27).slice(0, 8))} → 后=${JSON.stringify(String(after27).slice(0, 12))})`,
        String(after27).indexOf('上课时间到') >= 0
      );
      // 关闭桌宠：窗口隐藏
      settings.update({ pet: { enabled: false } });
      pet.applySettings();
      await sleep(400);
      ok(`T27 关闭后窗口隐藏 (可见=${pw.isVisible()})`, pw.isVisible() === false);
      pet.envSource = null; // 交还给主进程的自动环境同步
      settings.update({ pet: { enabled: false, x: null, y: null, ai: { apiKey: '' }, qa: [] } });
      await sleep(200);

      // —— T25 课表统一模型 + 课堂提醒（由时间表自动驱动）——
      const schedMod = require('./schedule');
      const at25 = (mins, sec) => {
        const d = new Date();
        d.setHours(Math.floor(mins / 60) % 24, mins % 60, sec || 0, 0);
        return d;
      };
      const wd25 = (new Date().getDay() + 6) % 7;
      const mkWeek25 = () => new Array(7).fill(null).map(() => ({ periods: [] }));
      const week25 = mkWeek25();
      week25[wd25] = {
        periods: [
          { start: '09:40', end: '10:25', name: '数学' },
          { start: '10:35', end: '11:20', name: '英语' },
        ],
      };
      const sch25 = { enabled: true, cycleWeeks: 1, restWeek: 0, weeks: [week25] };
      const l25 = schedMod.dayPeriods(sch25, at25(600));
      ok(
        `T25 课表模型（节次/科目/排序）：${l25.map((p) => `第${p.index}节 ${p.start}-${p.end}${p.name ? ' ' + p.name : ''}`).join('，')}`,
        l25.length === 2 && l25[0].index === 1 && l25[0].name === '数学' && l25[1].index === 2 && l25[1].name === '英语'
      );
      const pAt25 = schedMod.periodAt(sch25, at25(600)); // 10:00 正在上第 1 节
      const nxt25 = schedMod.nextPeriod(sch25, at25(600));
      ok(
        `T25 当前/下一节（10:00 当前=${pAt25 && pAt25.index}，课间 10:30 当前=${schedMod.periodAt(sch25, at25(630))}，下一节=第${nxt25 && nxt25.index}节 ${nxt25 && schedMod.fmtHM(nxt25.startAt)}）`,
        pAt25 && pAt25.index === 1 && schedMod.periodAt(sch25, at25(630)) === null && nxt25 && nxt25.index === 2 && nxt25.startAt === 635
      );
      const ccfg = { enabled: true, beforeStart: 3, atStart: true, beforeEnd: 2, atEnd: true, templateStart: '还有 {min} 分钟上课 · {label}', templateAtStart: '上课时间到 · {label}', templateBeforeEnd: '还有 {min} 分钟下课', templateAtEnd: '下课时间到' };
      const r25 = (mins) => schedMod.classReminders(at25(mins), sch25, ccfg);
      ok(
        `T25 四种课堂提醒触发点（课前=${JSON.stringify((r25(632)[0] || {}).body)}，上课=${r25(635)[0] && r25(635)[0].kind}，下课前=${r25(623)[0] && r25(623)[0].kind}，下课=${r25(625)[0] && r25(625)[0].kind}）`,
        r25(632).length === 1 && r25(632)[0].kind === 'beforeStart' && r25(632)[0].body === '还有 3 分钟上课 · 第 2 节 英语' &&
          r25(635).length === 1 && r25(635)[0].kind === 'atStart' &&
          r25(623).length === 1 && r25(623)[0].kind === 'beforeEnd' &&
          r25(625).length === 1 && r25(625)[0].kind === 'atEnd' &&
          r25(610).length === 0
      );
      // 去重 + 注入执行（不真弹通知）
      settings.update({ schedule: { ...sch25, notify: ccfg } });
      tasks.resetClassReminders();
      const fired25a = [];
      const fired25b = [];
      tasks.checkClassReminders(at25(635, 20), (r) => fired25a.push(r));
      tasks.checkClassReminders(at25(635, 50), (r) => fired25b.push(r));
      tasks.resetClassReminders();
      ok(
        `T25 课堂提醒去重（同一分钟两次检查：第一次 ${fired25a.length} 条，第二次 ${fired25b.length} 条）`,
        fired25a.length === 1 && fired25b.length === 0 && fired25a[0].body === '上课时间到 · 第 2 节 英语'
      );
      // 关闭课堂提醒 / 关闭时间表 → 都不触发
      settings.update({ schedule: { notify: { ...ccfg, enabled: false } } });
      tasks.resetClassReminders();
      const off25 = tasks.checkClassReminders(at25(635, 20), () => {});
      settings.update({ schedule: { enabled: false, notify: ccfg } });
      tasks.resetClassReminders();
      const off25b = tasks.checkClassReminders(at25(635, 20), () => {});
      ok(`T25 关掉课堂提醒/时间表后不触发 (提醒关=${off25.length}，时间表关=${off25b.length})`, off25.length === 0 && off25b.length === 0);
      // 免打扰跟随课表：正在上课 → 到本节课下课；不在课时 → 45 分钟兜底
      const now25 = new Date();
      const cur25 = now25.getHours() * 60 + now25.getMinutes();
      const hm25 = (m) => `${String(Math.floor((((m % 1440) + 1440) % 1440) / 60)).padStart(2, '0')}:${String((((m % 1440) + 1440) % 1440) % 60).padStart(2, '0')}`;
      // 课时不能跨零点（跨零点属于「昨天那一节」，凌晨跑测试时会被正确判成不在课时），
      // 所以把「正在上的这一节」夹在当天之内；期望值同步夹住
      const start25 = Math.max(0, cur25 - 20);
      const end25 = Math.min(1439, cur25 + 25);
      const inClass = mkWeek25();
      inClass[wd25] = { periods: [{ start: hm25(start25), end: hm25(end25), name: '数学' }] };
      settings.update({ schedule: { enabled: true, cycleWeeks: 1, restWeek: 0, weeks: [inClass], notify: ccfg } });
      const dnd25 = island.computeDndUntil();
      // 不在课时：挑一个确定不含「现在」的时段（凌晨/白天/傍晚三个候选里选第一个）
      const gaps25 = [[60, 105], [780, 825], [1320, 1365]];
      const gap25 = gaps25.find(([a, b]) => cur25 < a || cur25 > b) || [60, 105];
      const noClass = mkWeek25();
      noClass[wd25] = { periods: [{ start: hm25(gap25[0]), end: hm25(gap25[1]) }] };
      settings.update({ schedule: { weeks: [noClass] } });
      const dnd25b = island.computeDndUntil();
      // 期望值：本节课下课时间（与实现同样先归零小时再 setMinutes，否则 setMinutes 会在当前小时上叠加）
      const endOfPeriod = new Date(now25);
      endOfPeriod.setHours(0, 0, 0, 0);
      endOfPeriod.setMinutes(end25);
      ok(
        `T25 免打扰跟随课表（现在 ${now25.toTimeString().slice(0, 5)}；本节 ${hm25(start25)}-${hm25(end25)} 上课中→${new Date(dnd25).toTimeString().slice(0, 5)} 期望 ${endOfPeriod.toTimeString().slice(0, 5)}；非课时（${hm25(gap25[0])}-${hm25(gap25[1])}）→${Math.round((dnd25b - Date.now()) / 60000)} 分钟后＝45 分钟兜底）`,
        Math.abs(dnd25 - endOfPeriod.getTime()) <= 60000 && Math.abs(dnd25b - (Date.now() + 45 * 60000)) <= 60000
      );
      // 配置页：快速排课 / 科目与节次 / 导入导出 / 预览 / 课堂提醒设置
      config.open();
      const t25dl = Date.now() + 6000;
      while (!config.getWindow() && Date.now() < t25dl) await sleep(120);
      const cw25 = config.getWindow();
      let qf25 = null;
      if (cw25) {
        const ready25 = Date.now() + 6000;
        while (cw25.webContents.isLoading() && Date.now() < ready25) await sleep(120);
        const js25 = (code) => cw25.webContents.executeJavaScript(code);
        await js25(`document.querySelector('[data-tab="schedule"]').click()`);
        await js25(`(() => {
          const v = (id, val) => { const el = document.getElementById(id); el.value = val; el.dispatchEvent(new Event('change', { bubbles: true })); };
          v('qfStart', '08:00'); v('qfLen', '45'); v('qfBreak', '10'); v('qfCount', '4');
          document.getElementById('schedQuickFill').click();
        })()`);
        const quickVisible = await js25(`!document.getElementById('schedQuickBox').hidden`);
        await js25(`document.getElementById('qfApply').click()`);
        await sleep(700);
        qf25 = await js25(`(() => {
          const days = document.querySelectorAll('#schedule-list .sched-week')[0].querySelectorAll('.sched-day');
          const rows = days[0].querySelectorAll('.sched-row');
          const times = Array.from(rows).map((r) => r.querySelector('.sched-start').value + '-' + r.querySelector('.sched-end').value);
          const nos = Array.from(rows).map((r) => (r.querySelector('.sched-no') || {}).textContent || '');
          const names = Array.from(rows).map((r) => !!r.querySelector('.sched-name'));
          return { mon: rows.length, sat: days[5].querySelectorAll('.sched-row').length, times, nos, hasName: names.length > 0 && names.every(Boolean), preview: (document.getElementById('schedPreview') || {}).textContent || '' };
        })()`);
        if (qf25) qf25.quickVisible = quickVisible;
        // 导出一份 JSON，再导入回来（幂等）
        const io25 = await js25(`(async () => {
          document.getElementById('schedExport').click();
          const json = document.getElementById('schedIo').value;
          const parsed = JSON.parse(json);
          document.getElementById('schedIoApply').click();
          return { len: json.length, periods: (parsed.weeks[0][0].periods || []).length, rows: document.querySelectorAll('#schedule-list .sched-row').length };
        })()`);
        qf25.io = io25;
        // 课堂提醒设置持久化
        const cn25 = await js25(`(async () => {
          const el = document.getElementById('classBeforeStart'); el.value = '5'; el.dispatchEvent(new Event('change', { bubbles: true }));
          document.getElementById('classAtEnd').checked = true; document.getElementById('classAtEnd').dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        })()`);
        qf25.cn = cn25;
      }
      ok(
        `T25 配置页快速排课（面板=${qf25 && qf25.quickVisible}，周一 ${qf25 && qf25.mon} 节：${qf25 && (qf25.times || []).join(' ')}，周六 ${qf25 && qf25.sat} 节，节次标签=${JSON.stringify((qf25 && qf25.nos && qf25.nos[0]) || '')}，有科目输入=${qf25 && qf25.hasName}，预览=${JSON.stringify(((qf25 && qf25.preview) || '').slice(0, 28))}）`,
        !!qf25 && qf25.quickVisible === true && qf25.mon === 4 && qf25.sat === 0 &&
          qf25.times[0] === '08:00-08:45' && qf25.times[1] === '08:55-09:40' && qf25.times[3] === '10:45-11:30' &&
          qf25.nos[0] === '第 1 节' && qf25.hasName === true && qf25.preview.indexOf('下一节') >= 0
      );
      ok(
        `T25 时间表导入导出 (导出 ${qf25 && qf25.io && qf25.io.len} 字，含 ${qf25 && qf25.io && qf25.io.periods} 节，导入后行数 ${qf25 && qf25.io && qf25.io.rows})`,
        !!qf25 && qf25.io && qf25.io.len > 100 && qf25.io.periods === 4 && qf25.io.rows >= 4
      );
      await sleep(500);
      const cnSaved = settings.load().schedule.notify;
      ok(
        `T25 课堂提醒设置持久化 (课前=${cnSaved.beforeStart} 分钟，下课提醒=${cnSaved.atEnd}，模板=${JSON.stringify(cnSaved.templateStart)})`,
        cnSaved.beforeStart === 5 && cnSaved.atEnd === true && typeof cnSaved.templateStart === 'string'
      );
      if (config.getWindow()) config.close();
      tasks.resetClassReminders();
      settings.update({ schedule: { enabled: false, weeks: [mkWeek25()], notify: undefined } });
      await sleep(300);

      // —— T24 全屏授课的三种行为（隐藏 / 右上角角落卡片 / 顶部进度条）——
      const fsBase = {
        idleMs: 99999, occluded: true, maximized: false, overPill: true, state: 'strip', mode: 'auto', smart: true,
        hideOnMaximized: true, expandIdleSec: 4, zoomIdleSec: 15, zoomAllowed: true, zoomCooldown: false,
        holding: false, hasCountdown: true, expandedSinceMs: 0,
      };
      ok(
        `T24 全屏授课形态决策 (灵动岛→${island.decideState({ ...fsBase, fullscreenState: 'strip' })}，进度条→${island.decideState({ ...fsBase, fullscreenState: 'progress' })}，角落卡片（内部状态·用户入口已移除）→${island.decideState({ ...fsBase, fullscreenState: 'corner' })}，无事件→${island.decideState({ ...fsBase, fullscreenState: 'progress', hasCountdown: false })})`,
        island.decideState({ ...fsBase, fullscreenState: 'strip' }) === 'strip' &&
          island.decideState({ ...fsBase, fullscreenState: 'progress' }) === 'progress' &&
          island.decideState({ ...fsBase, fullscreenState: 'corner' }) === 'corner' &&
          island.decideState({ ...fsBase, fullscreenState: 'progress', hasCountdown: false }) === 'strip'
      );
      // 旧配置迁移：hideOnFullscreen(布尔) → fullscreenMode(枚举)（纯函数，直接构造磁盘对象断言）
      const migA = {};
      const migB = {};
      const migC = { fullscreenMode: 'corner' };
      const okA = settings.migrateFullscreenMode({ hideOnFullscreen: false }, migA);
      const okB = settings.migrateFullscreenMode({ hideOnFullscreen: true }, migB);
      const okC = settings.migrateFullscreenMode({ hideOnFullscreen: false, fullscreenMode: 'corner' }, migC);
      ok(
        `T24 旧设置迁移 (false→${migA.fullscreenMode}/${okA}，true→${migB.fullscreenMode}/${okB}，已有新键不覆盖=${migC.fullscreenMode}/${okC})`,
        okA === true && migA.fullscreenMode === 'strip' && okB === true && migB.fullscreenMode === 'hide' && okC === false && migC.fullscreenMode === 'corner'
      );

      // 真实切到「右上角角落卡片」：窗口贴住工作区右上角、鼠标穿透、DOM 是角落布局
      settings.update({ smart: { fullscreenMode: 'corner' }, ui: { opacity: { corner: 0.8 } } });
      island.applySettings();
      island.manualState('strip', 0);
      island.animating = false;
      await sleep(400);
      const d24 = island.islandDisplay();
      const db24 = d24.bounds;
      const wa24 = d24.workArea;
      island.probe.last = {
        ...island.probe.last,
        fgClass: 'Sci_Fullscreen', vis: true, pid: 4242, li: 999999900, tick: 1000000000, cx: 5, cy: 5, toasts: null,
        rect: { l: db24.x, t: db24.y, r: db24.x + db24.width, b: db24.y + db24.height },
      };
      island.lastAutoSwitch = 0;
      island.lastLi = 999999900;
      island.zoomCooldownUntil = 0;
      island.probe.frozen = true; // 注入的全屏授课画面不被真实采样覆盖
      island.tick();
      await sleep(1400);
      const bCorner = island.win.getBounds();
      const domCorner = await island.win.webContents.executeJavaScript(
        `({ state: document.body.dataset.state, hasCz: !!document.querySelector('.cz-num'), opacity: document.getElementById('pill').style.opacity })`
      );
      ok(
        `T24 角落卡片贴右上角 + 鼠标穿透 (状态=${island.state} 卡片右边缘=${bCorner.x + bCorner.width} 工作区右=${wa24.x + wa24.width} 上边缘=${bCorner.y}/${wa24.y} 角落布局=${domCorner.hasCz} 透明度=${domCorner.opacity})`,
        island.state === 'corner' &&
          bCorner.x + bCorner.width === wa24.x + wa24.width &&
          bCorner.y === wa24.y &&
          domCorner.state === 'corner' &&
          domCorner.hasCz === true &&
          domCorner.opacity === '0.8' &&
          island.mousePT === true
      );
      // 形状逐像素验证：抓一帧窗口位图（左上/右下内凹=透明，右上=屏幕角不透明，左下外凸=透明）
      const shot24 = await island.win.webContents.capturePage();
      const bmp24 = shot24.getBitmap();
      const sz24 = shot24.getSize();
      const alpha24 = (x, y) => bmp24[(y * sz24.width + x) * 4 + 3];
      const i24 = 2;
      const shape24 = {
        TL: alpha24(i24, i24),
        TR: alpha24(sz24.width - 1 - i24, i24),
        BR: alpha24(sz24.width - 1 - i24, sz24.height - 1 - i24),
        BL: alpha24(i24, sz24.height - 1 - i24),
        midL: alpha24(i24, Math.floor(sz24.height / 2)),
        midT: alpha24(Math.floor(sz24.width / 2), i24),
        midB: alpha24(Math.floor(sz24.width / 2), sz24.height - 1 - i24),
        midR: alpha24(sz24.width - 1 - i24, Math.floor(sz24.height / 2)),
      };
      const clip24 = await island.win.webContents.executeJavaScript(
        `(() => {
           const pills = document.getElementById('pill');
           const w = pills.clientWidth, h = pills.clientHeight;
           const inPill = (x, y) => { const el = document.elementFromPoint(x, y); return !!(el && pills.contains(el)); };
           return {
             shape: pills.dataset.cornerShape || '',
             clip: (getComputedStyle(pills).clipPath || '').slice(0, 20),
             name: !!document.querySelector('.cz-name'),
             num: (document.querySelector('.cz-num') || {}).textContent || '',
             hitTL: inPill(2, 2), hitTR: inPill(w - 3, 2), hitBR: inPill(w - 3, h - 3), hitBL: inPill(2, h - 3),
             hitT: inPill(Math.round(w / 2), 2), hitR: inPill(w - 3, Math.round(h / 2)), hitB: inPill(Math.round(w / 2), h - 3), hitL: inPill(2, Math.round(h / 2)),
           };
         })()`
      );
      // 注：截取透明窗口时 bitmap 的 alpha 整体偏暗（受窗口透明度与 DWM 合成影响），
      // 所以只用「0 / 非 0」判断该点是否属于卡片
      ok(
        `T24 角落卡片外形（左上/右下为内凹圆角）：像素 左上=${shape24.TL} 右上=${shape24.TR} 右下=${shape24.BR} 左下=${shape24.BL} 四边中点=${shape24.midT}/${shape24.midR}/${shape24.midB}/${shape24.midL}；命中测试 左上=${clip24.hitTL} 右上=${clip24.hitTR} 右下=${clip24.hitBR} 左下=${clip24.hitBL} 四边=${clip24.hitT}/${clip24.hitR}/${clip24.hitB}/${clip24.hitL}；尺寸=${clip24.shape} clip=${clip24.clip} 仅剩余时间=${!clip24.name} 数值=${JSON.stringify(clip24.num)}`,
        shape24.TL === 0 &&
          shape24.BR === 0 &&
          shape24.BL === 0 &&
          shape24.TR >= 8 &&
          shape24.midT >= 8 &&
          shape24.midR >= 8 &&
          shape24.midB >= 8 &&
          shape24.midL >= 8 &&
          clip24.hitTL === false &&
          clip24.hitTR === true &&
          clip24.hitBR === false &&
          clip24.hitBL === false &&
          clip24.hitT === true &&
          clip24.hitR === true &&
          clip24.hitB === true &&
          clip24.hitL === true &&
          /^w\d+ h\d+ r\d+$/.test(clip24.shape) &&
          clip24.clip.indexOf('path(') === 0 &&
          clip24.name === false
      );
      // 切到「顶部进度条」：整宽贴顶，透明度按设置生效
      settings.update({ smart: { fullscreenMode: 'progress', progressTotalDays: 100 }, ui: { opacity: { progress: 0.4 } } });
      island.applySettings();
      island.lastAutoSwitch = 0;
      island.animating = false;
      island.tick();
      await sleep(1400);
      const bBar = island.win.getBounds();
      const domBar = await island.win.webContents.executeJavaScript(
        `(() => { const f = document.querySelector('.pb-fill'); const p = document.getElementById('pill'); return { state: document.body.dataset.state, fill: f ? f.style.width : '', opacity: p.style.opacity, label: (document.querySelector('.pb-name') || {}).textContent || '' }; })()`
      );
      ok(
        `T24 顶部进度条整宽贴顶 + 透明度可调 (状态=${island.state} 宽=${bBar.width}/${wa24.width} 顶=${bBar.y}/${wa24.y} 填充=${domBar.fill} 透明度=${domBar.opacity} 文本=${JSON.stringify(domBar.label)})`,
        island.state === 'progress' &&
          bBar.width === wa24.width &&
          bBar.y === wa24.y &&
          domBar.state === 'progress' &&
          /%$/.test(domBar.fill) &&
          domBar.opacity === '0.4'
      );
      // 退出全屏：回到普通形态并取消穿透
      island.probe.frozen = false; // 解冻：退出全屏由采样驱动
      island.probe.last = {
        ...island.probe.last,
        fgClass: 'Sci_App', rect: { l: db24.x, t: db24.y, r: db24.x + Math.round(db24.width / 2), b: db24.y + Math.round(db24.height / 2) },
      };
      island.lastAutoSwitch = 0;
      island.animating = false;
      island.tick();
      await sleep(900);
      ok(
        `T24 退出全屏回到普通形态 (状态=${island.state} 穿透=${island.mousePT})`,
        island.state !== 'corner' && island.state !== 'progress' && island.mousePT === false
      );
      settings.update({ smart: { fullscreenMode: 'hide', progressTotalDays: 365 }, ui: { opacity: { corner: 0.9, progress: 0.55 } } });
      island.applySettings();
      island.manualState('strip', 0);
      island.animating = false;
      await sleep(300);

      // —— T23 大窗口圆角：CSS 圆角过渡期间不能把圆角矩形 SDF 退化成圆/胶囊 ——
      process.env.SCI_GL_NO_GEOM_CHECK = '1';
      settings.update({ ui: { glassMode: 'webgl' } });
      island.applySettings();
      island.manualState('expanded', 60000); // 先处在胶囊状态（border-radius: 999px）
      island.animating = false;
      // GPU 取流异步：等它生效，否则拿到的 gl 一直是 null
      const gl23ddl = Date.now() + 12000;
      while (!island.glStreamActive() && Date.now() < gl23ddl) await sleep(200);
      const readPill = () =>
        island.win.webContents.executeJavaScript(
          `(() => {
             const p = document.getElementById('pill');
             const r = p.getBoundingClientRect();
             const cs = getComputedStyle(p);
             const s = window.SCIRadius ? window.SCIRadius.settled(p, Math.min(r.width, r.height) / 2) : null;
             const gl = window.GlassWebGL && window.GlassWebGL.isActive() ? window.GlassWebGL.stats().rectRadius : null;
             let anims = [];
             try { anims = (p.getAnimations ? p.getAnimations() : []).map((a) => (a.transitionProperty || a.animationName || a.constructor.name) + '/' + a.playState); } catch (e) { anims = ['ERR:' + e.message]; }
             return { state: document.body.dataset.state, css: cs.borderRadius, pill: Math.round(r.width) + 'x' + Math.round(r.height), settled: s, gl, anims };
           })()`
        );
      const pillExpanded = await readPill();
      // 切到大窗口：CSS 圆角开始 999px → 42px 的 0.24s 过渡，全程逐帧取样，
      // 任何时刻都不该出现「被夹到半高半宽」的退化圆角（本机大窗口约 128px）
      island.manualState('zoom', 60000);
      island.animating = false;
      const radiusSamples = [];
      for (let i = 0; i < 16; i++) {
        await sleep(45);
        const s = await readPill();
        radiusSamples.push({ gl: s.gl, settled: s.settled });
      }
      const pillZoom = await readPill();
      const degenerate = radiusSamples.filter((x) => (typeof x.gl === 'number' && x.gl > 60) || (typeof x.settled === 'number' && x.settled > 60));
      ok(
        `T23 大窗口圆角过渡期间不塌成圆 (胶囊 ${pillExpanded.pill} css=${pillExpanded.css} gl=${pillExpanded.gl}；过渡全程 gl=[${radiusSamples.map((x) => x.gl).join(',')}] settled=[${radiusSamples.map((x) => x.settled).join(',')}]；稳定后 css=${pillZoom.css} settled=${pillZoom.settled} gl=${pillZoom.gl})`,
        degenerate.length === 0 && pillZoom.gl === 42 && pillZoom.settled === 42 && pillZoom.state === 'zoom'
      );
      settings.update({ ui: { glassMode: 'liquid' } });
      island.applySettings();
      const pillCpu = await readPill();
      ok(
        `T23 CPU 链路同样取稳定圆角 (css=${pillCpu.css} settled=${pillCpu.settled})`,
        typeof pillCpu.settled === 'number' && pillCpu.settled === 42
      );
      delete process.env.SCI_GL_NO_GEOM_CHECK;
      settings.update({ manual: { mode: 'auto' }, ui: { glassMode: 'auto' } });
      island.applySettings();
      island.manualState('strip', 0);
      island.animating = false;
      await sleep(400);

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
          island.decideState({ ...baseZoom, zoomAllowed: false }) === 'strip'
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
      let notchCfg = null; // 挖孔参数表单（T29 断言；复用这次打开的配置窗口，不重复开关）
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
        notchCfg = await cfgWin.webContents.executeJavaScript(`(() => {
          const tab = document.querySelector('#tabs .tab[data-tab="display"]');
          if (tab) tab.click();
          const g = (id) => { const el = document.getElementById(id); return el ? (el.type === 'checkbox' ? el.checked : el.value) : null; };
          return {
            tab: !!tab,
            active: !!document.querySelector('#tab-display.active'),
            enabled: g('notchEnabled'), preset: g('notchPreset'), presetOptions: document.querySelectorAll('#notchPreset option').length,
            presetLabel: (document.querySelector('#notchPreset option') || {}).textContent || '',
            debug: g('notchDebug'),
            sensors: g('notchSensors'), zoneMode: g('notchZoneMode'),
            zoneX: g('notchZoneX'), zoneY: g('notchZoneY'), zoneW: g('notchZoneW'), zoneH: g('notchZoneH'),
            margin: g('notchMargin'), layout: g('notchLayout'), radius: g('notchRadius'),
            slotLeft: g('notchSlotLeft'), slotRight: g('notchSlotRight'), slotBelow: g('notchSlotBelow'),
            animMs: g('notchAnimMs'),
            advHidden: !!(document.getElementById('notch-adv') || {}).hidden,
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

      // —— T29 传感器避让（纯黑胶囊盖板 + 内容绕开）——
      const sensorsMod = require('./sensors');
      const sensorCover = require('./sensor-cover');
      const notchDef29 = require('./settings').DEFAULTS.ui.cameraNotch;
      const nDef29 = settings.load().ui.cameraNotch || {};
      ok(
        `T29 默认规格就绪 (预设=${notchDef29.preset} 传感器="${notchDef29.sensors}" 槽位=${notchDef29.slotLeft}/${notchDef29.slotRight} 时长=${notchDef29.animMs} 运行值=${nDef29.animMs} 预设表=${Object.keys(sensorsMod.PRESETS).join(',')})`,
        notchDef29.enabled === false &&
          notchDef29.preset === 'center' &&
          notchDef29.sensors === sensorsMod.PRESETS.center.sensors &&
          notchDef29.slotLeft === 14 &&
          notchDef29.slotRight === 12 &&
          notchDef29.animMs === 550 &&
          Object.keys(sensorsMod.PRESETS).join() === 'center' &&
          // 运行时按设置生效（加速模式会把它改小）
          (nDef29.animMs === 550 || nDef29.animMs === 60)
      );
      ok(
        `T29 配置页接线 (启用=${notchCfg && notchCfg.enabled} 位置=${notchCfg && notchCfg.preset}/${notchCfg && notchCfg.presetLabel} 选项数=${notchCfg && notchCfg.presetOptions} 调试=${notchCfg && notchCfg.debug} 高级区默认隐藏=${notchCfg && notchCfg.advHidden} err=${JSON.stringify((notchCfg && notchCfg.err) || '')})`,
        !!notchCfg &&
          notchCfg.tab &&
          notchCfg.active &&
          notchCfg.enabled === false &&
          notchCfg.preset === 'center' &&
          notchCfg.presetLabel === '中置传感器' &&
          notchCfg.presetOptions === 1 &&
          notchCfg.debug === false &&
          notchCfg.advHidden === true &&
          !notchCfg.err
      );

      // 位置预设只有一个「中置传感器」：写上预设名会展开成它的传感器列表 + 禁区
      settings.update({ ui: { cameraNotch: { enabled: true, preset: 'center' } } });
      const pre29 = settings.load().ui.cameraNotch;
      ok(
        `T29 预设「中置传感器」展开 (传感器="${pre29.sensors}" 禁区=${JSON.stringify(pre29.zone)} 启用=${pre29.enabled})`,
        pre29.enabled === true &&
          pre29.sensors === sensorsMod.PRESETS.center.sensors &&
          JSON.stringify(pre29.zone) === JSON.stringify(sensorsMod.PRESETS.center.zone)
      );
      // 旧配置里的其它预设名（punch/left/right/island3）一律回落到中置传感器
      settings.update({ ui: { cameraNotch: { preset: 'island3' } } });
      const legacy29 = settings.load().ui.cameraNotch;
      ok(
        `T29 旧预设名回落中置传感器 (写成 island3 → ${legacy29.preset}，传感器=${legacy29.sensors === sensorsMod.PRESETS.center.sensors})`,
        legacy29.preset === 'center' && legacy29.sensors === sensorsMod.PRESETS.center.sensors
      );
      // 高级区里能改成自定义传感器列表（预设转 custom）
      settings.update({ ui: { cameraNotch: { enabled: true, preset: 'custom', sensors: '60,14,40' } } });
      const one29 = settings.load().ui.cameraNotch;
      ok(
        `T29 高级区自定义传感器列表生效 (预设=${one29.preset} 传感器="${one29.sensors}" 启用=${one29.enabled})`,
        one29.enabled === true && one29.preset === 'custom' && one29.sensors === '60,14,40'
      );

      // 纯几何：传感器 → 禁区 → 布局（用中置传感器那组三传感器）
      const sen29 = sensorsMod.parseSensors(sensorsMod.DEFAULT_SENSORS);
      const zone29 = sensorsMod.sensorsZone(sen29, 6);
      ok(
        `T29 传感器并集算出禁区 (${sen29.length} 颗 → x=${zone29 && zone29.x} y=${zone29 && zone29.y} ${zone29 && zone29.w}×${zone29 && zone29.h})`,
        sen29.length === 3 && zone29.x === -44.5 && zone29.y === 11 && zone29.w === 86.5 && zone29.h === 26
      );
      const top29 = sensorsMod.belowTop(zone29, 8);
      ok(
        `T29 below 起线 = 禁区底边 - 黑底顶边 (${top29}，规格参考 34=${sensorsMod.belowTop({ x: -39, y: 18, w: 92, h: 28 }, 12)})`,
        top29 === 29 && sensorsMod.belowTop({ x: -39, y: 18, w: 92, h: 28 }, 12) === 34
      );
      ok(
        `T29 布局自动选择 (细条→${sensorsMod.pickLayout('auto', 'strip', 26, top29)}，横幅→${sensorsMod.pickLayout('auto', 'expanded', 64, top29)}，大卡片→${sensorsMod.pickLayout('auto', 'zoom', 274, top29)}，手动 split→${sensorsMod.pickLayout('split', 'expanded', 64, top29)})`,
        sensorsMod.pickLayout('auto', 'strip', 26, top29) === 'split' &&
          sensorsMod.pickLayout('auto', 'progress', 16, top29) === 'split' &&
          sensorsMod.pickLayout('auto', 'expanded', 64, top29) === 'below' &&
          sensorsMod.pickLayout('auto', 'zoom', 274, top29) === 'below' &&
          sensorsMod.pickLayout('split', 'expanded', 64, top29) === 'split'
      );

      // 中置传感器：小岛仍在屏幕正中；细条左右分栏（内容紧挨传感器两侧），横幅/大卡片长到下方
      settings.update({ ui: { cameraNotch: { preset: 'center' } } });
      const d29 = island.islandDisplay();
      const spec29 = island.notchSpec();
      const zw29 = Math.round(spec29.zone.w);
      const slots29 = spec29.slotLeft + spec29.slotRight;
      const depth29 = Math.ceil(spec29.zone.y + spec29.zone.h - spec29.blackTop);
      const strip29 = island.pillSize('strip', d29);
      const exp29 = island.pillSize('expanded', d29);
      const tgt29 = island.computeBounds('strip', d29);
      const center29 = d29.workArea.x + (d29.workArea.width - tgt29.width) / 2;
      ok(
        `T29 细条左右分栏、横幅长到下方 (细条 116→${strip29.w}×${strip29.h} = 116+禁区${zw29}+槽位${slots29}，横幅 ${exp29.w}×${exp29.h} = 禁区深${depth29}+空隙+64，黑底顶=${spec29.blackTop})`,
        spec29.on === true &&
          strip29.w === 116 + zw29 + slots29 &&
          strip29.h >= depth29 &&
          exp29.w === 420 &&
          exp29.h === depth29 + spec29.slotBelow + 64 &&
          spec29.blackTop >= d29.workArea.y &&
          spec29.blackTop <= d29.workArea.y + 8
      );
      ok(
        `T29 小岛仍在原位（顶部居中） (目标 x=${tgt29.x} 期望=${Math.round(center29)}，禁区中心=${Math.round(spec29.zone.x + spec29.zone.w / 2)} 屏幕中心=${Math.round(d29.workArea.x + d29.workArea.width / 2)})`,
        Math.abs(tgt29.x - center29) <= 1 &&
          Math.abs(spec29.zone.x + spec29.zone.w / 2 - (d29.workArea.x + d29.workArea.width / 2)) <= 4
      );
      ok(
        `T29 大卡片不加宽、只往下长 (zoom ${island.pillSize('zoom', d29).w}×${island.pillSize('zoom', d29).h}，原 ${island.zoomSize(d29).w}×${island.zoomSize(d29).h})`,
        island.pillSize('zoom', d29).w === island.zoomSize(d29).w &&
          island.pillSize('zoom', d29).h === depth29 + spec29.slotBelow + island.zoomSize(d29).h
      );

      // 窗口命中区域：只按圆角矩形，不再挖洞（黑底留着，镜头那块不显示内容）
      const scale29 = d29.scaleFactor;
      const origSetRegion29 = probe.setRegion.bind(probe);
      let cap29 = null;
      probe.setRegion = (...a) => {
        cap29 = a;
        return origSetRegion29(...a);
      };
      island.manualState('strip', 20000); // 固定形态，避免 tick 自动切换打乱断言
      await sleep(900); // 等黑底伸缩落位再量
      cap29 = null;
      island.applyRegion();
      probe.setRegion = origSetRegion29;
      const b29 = island.win.getBounds();
      ok(
        `T29 命中区域=圆角矩形（不挖洞） (参数=${cap29 ? cap29.length : 0} 个：${JSON.stringify(cap29 && cap29.slice(1))} 窗口=${b29.width}×${b29.height} 期望=${strip29.w + 16})`,
        !!cap29 && cap29.length === 6 && cap29[3] === Math.round((strip29.w + 6) * scale29) && Math.abs(b29.width - (strip29.w + 16)) <= 1
      );

      // 渲染层：内容绕开禁区（那块黑由独立的传感器盖板窗口负责）
      settings.upsertEvent({ id: null, name: '传感器演练', date: '2099-01-01T00:00:00', emoji: '🎯', color: '#4f7cff', enabled: true });
      const ev29 = settings.events().find((e) => e.name === '传感器演练');
      island.manualState('strip', 20000);
      island.applySettings();
      await sleep(1000); // 等黑底伸缩落位后再量禁区与内容
      // 传感器盖板：纯黑胶囊窗口（位置/大小只由禁区决定，永不移动）
      const cov29 = sensorCover.win && !sensorCover.win.isDestroyed() ? sensorCover.win : null;
      const covCap29 = cov29
        ? await cov29.webContents.executeJavaScript(`(() => {
            const c = document.getElementById('cap');
            const cs = c ? getComputedStyle(c) : null;
            return { bg: cs ? cs.backgroundColor : '', radius: cs ? cs.borderRadius : '', w: c ? Math.round(c.getBoundingClientRect().width) : -1, h: c ? Math.round(c.getBoundingClientRect().height) : -1 };
          })()`)
        : null;
      // 盖板必须落在小岛黑底里面（两块黑要重合，不能各占一块）
      const pill29 = {
        x: b29.x + 8,
        y: b29.y + 8,
        r: b29.x + b29.width - 8,
        b: b29.y + b29.height - 8,
      };
      const covB29 = cov29 ? cov29.getBounds() : null;
      // 贴屏幕边的部分会被裁掉（窗口显示不到屏幕外），期望值同样裁一下
      const covExp29 = {
        x: Math.round(spec29.zone.x),
        y: Math.max(d29.workArea.y, Math.round(spec29.zone.y)),
        w: Math.round(spec29.zone.w),
        h:
          Math.min(d29.workArea.y + d29.workArea.height, Math.round(spec29.zone.y + spec29.zone.h)) -
          Math.max(d29.workArea.y, Math.round(spec29.zone.y)),
      };
      const covered29 =
        !!covB29 &&
        covB29.x >= pill29.x - 1 &&
        covB29.y >= pill29.y - 1 &&
        covB29.x + covB29.width <= pill29.r + 1 &&
        covB29.y + covB29.height <= pill29.b + 1;
      ok(
        `T29 传感器盖板：纯黑胶囊且与小岛黑底重合 (窗口=${covB29 ? covB29.width + 'x' + covB29.height + '@' + covB29.x + ',' + covB29.y : '无'} 期望=${JSON.stringify(covExp29)} 黑底=${JSON.stringify(pill29)} 重合=${covered29} 置顶=${cov29 && cov29.isAlwaysOnTop()} 尺寸锁定=${cov29 && !cov29.isResizable() && !cov29.isMovable()} 颜色=${covCap29 && covCap29.bg} 圆角=${covCap29 && covCap29.radius})`,
        !!cov29 &&
          covB29.x === covExp29.x &&
          covB29.y === covExp29.y &&
          covB29.width === covExp29.w &&
          covB29.height === covExp29.h &&
          covered29 &&
          cov29.isAlwaysOnTop() &&
          cov29.isVisible() &&
          !cov29.isResizable() &&
          !cov29.isMovable() &&
          !!covCap29 &&
          covCap29.bg === 'rgb(0, 0, 0)' &&
          covCap29.w === covExp29.w
      );
      // 盖板钉死在原地：小岛切换形态、隐藏、动来动去都不影响它
      const covBefore29 = cov29 ? cov29.getBounds() : null;
      island.manualState('expanded', 30000);
      await sleep(700);
      island.manualState('zoom', 30000);
      await sleep(800);
      island.win.hide();
      await sleep(300);
      const covAfter29 = cov29 ? cov29.getBounds() : null;
      island.win.showInactive();
      await sleep(200);
      island.manualState('strip', 20000);
      await sleep(700);
      ok(
        `T29 盖板位置/大小永不移动 (切换形态+隐藏前 ${JSON.stringify(covBefore29)} → 后 ${JSON.stringify(covAfter29)}，小岛隐藏时仍可见=${cov29 ? cov29.isVisible() : false})`,
        !!covBefore29 && !!covAfter29 && JSON.stringify(covBefore29) === JSON.stringify(covAfter29)
      );
      // 冷启动自愈：盖板被销毁（或从没被创建过）时，下一次 tick 必须按同一几何重建
      sensorCover.destroy();
      island.tick();
      await sleep(200);
      const covRebuilt29 = sensorCover.bounds();
      ok(
        `T29 盖板缺失时 tick 自愈重建 (销毁后 tick → ${JSON.stringify(covRebuilt29)} 期望=${JSON.stringify(covAfter29)}，可见=${sensorCover.win ? sensorCover.win.isVisible() : false})`,
        !!covRebuilt29 && JSON.stringify(covRebuilt29) === JSON.stringify(covAfter29) && !!sensorCover.win && sensorCover.win.isVisible()
      );
      // 收缩回灵动岛时文字不能消失：动画期间的让位必须按「目标窗口几何」算。
      // 曾经用动画中的实时窗口坐标算 → 中间空隙按横幅宽度铺开，两瓣被推出可视区（叠 overflow:hidden 整块不见）。
      const ztgt29 = island.cameraNotch('strip', { state: 'strip' });
      const btgt29 = island.computeBounds('strip', island.islandDisplay());
      const zoneScr29 = island.notchSpec().zone;
      ok(
        `T29 收缩用目标几何算让位 (目标窗口 x=${btgt29.x} 禁区相对 x=${ztgt29 && ztgt29.zx} 期望=${Math.round((zoneScr29.x - btgt29.x) * 10) / 10})`,
        !!ztgt29 && Math.abs(ztgt29.zx - (zoneScr29.x - btgt29.x)) < 0.6 && ztgt29.zw === Math.round(zoneScr29.w * 10) / 10
      );
      island.manualState('expanded', 30000);
      await sleep(900);
      const tiny29 = [];
      const readTiny29 = () =>
        island.win.webContents.executeJavaScript(`(() => {
          const p = document.getElementById('pill');
          const pr = p.getBoundingClientRect();
          const els = document.querySelectorAll('.s-emoji, .s-num, .s-unit');
          return Array.prototype.some.call(els, (el) => {
            const b = el.getBoundingClientRect();
            return b.width > 0 && b.height > 0 && b.right > pr.left + 1 && b.left < pr.right - 1;
          });
        })()`);
      island.setState('strip');
      for (let i = 0; i < 12; i += 1) {
        await sleep(80);
        tiny29.push(await readTiny29());
      }
      ok(
        `T29 收缩回灵动岛全程文字可见 (采样 ${tiny29.length} 帧，丢失 ${tiny29.filter((v) => !v).length} 帧：${tiny29.map((v) => (v ? '●' : '○')).join('')})`,
        tiny29.every((v) => v === true)
      );

      const ns29 = await island.win.webContents.executeJavaScript(`window.__notchState()`);
      const zr29 = ns29.rect || { x: 0, y: 0, w: 0, h: 0 };
      const dom29 = await island.win.webContents.executeJavaScript(`(() => {
        const p = document.getElementById('pill');
        const pr = p.getBoundingClientRect();
        const left = document.querySelector('.nb-l');
        const right = document.querySelector('.nb-r');
        const row = document.querySelector('.s-row');
        const zone = { l: ${zr29.x}, t: ${zr29.y}, r: ${zr29.x + zr29.w}, b: ${zr29.y + zr29.h} };
        const bad = [];
        document.querySelectorAll('#content *').forEach((el) => {
          if (el.children.length) return;
          if (el.classList.contains('nb-gap')) return; // 中间那条空隙本来就横跨禁区
          const r = el.getBoundingClientRect();
          if (r.width < 1 || r.height < 1) return;
          const l = r.left - pr.left, t = r.top - pr.top, rr = r.right - pr.left, b = r.bottom - pr.top;
          if (Math.min(rr, zone.r) - Math.max(l, zone.l) > 1 && Math.min(b, zone.b) - Math.max(t, zone.t) > 1) bad.push((el.className || el.tagName) + '@' + Math.round(l) + ',' + Math.round(t));
        });
        const gap = document.querySelector('.nb-gap');
        return {
          state: document.body.dataset.state,
          bodyNotch: document.body.dataset.notch || '',
          layout: document.body.dataset.notchLayout || '',
          hasNotchZoneEl: !!document.getElementById('notch-zone'),
          justify: row ? getComputedStyle(row).justifyContent : '',
          gapW: gap ? Math.round(gap.getBoundingClientRect().width) : -1,
          padLeft: row ? getComputedStyle(row).paddingLeft : '',
          padRight: row ? getComputedStyle(row).paddingRight : '',
          hasLeft: !!left, hasRight: !!right,
          emojiLeft: !!(left && left.querySelector('.s-emoji')),
          // 去掉图标后：左瓣改放事件名（填空 + 左右平衡），这里断言"左瓣有文字内容"
          nameLeftText: left ? String((left.textContent || '')).trim() : '',
          daysRight: !!(right && right.querySelector('[data-role="days"]')),
          bad,
          shift: document.documentElement.style.getPropertyValue('--notch-shift'),
        };
      })()`);
      ok(
        `T29 内容绕开禁区（小岛内不再画那块黑） (state=${dom29.state} layout=${dom29.layout} 块元素=${dom29.hasNotchZoneEl} 禁区=${JSON.stringify(zr29)} 屏幕=${JSON.stringify(ns29.screen)} 期望屏幕=(${Math.round(spec29.zone.x)},${Math.round(spec29.zone.y)}) 左瓣=${JSON.stringify(dom29.nameLeftText)}（旧图标=${dom29.emojiLeft}） 右数字=${dom29.daysRight})`,
        dom29.state === 'strip' &&
          dom29.bodyNotch === '1' &&
          dom29.layout === 'split' &&
          dom29.hasNotchZoneEl === false &&
          !!ns29.screen &&
          Math.abs(ns29.screen.x - spec29.zone.x) <= 1 &&
          Math.abs(ns29.screen.y - spec29.zone.y) <= 1 &&
          ns29.zone.w === Math.round(spec29.zone.w) &&
          dom29.hasLeft &&
          dom29.hasRight &&
          dom29.nameLeftText.length > 0 &&   // 左瓣被事件名填满（不再靠图标占位）
          dom29.emojiLeft === false &&        // 图标已全部去掉
          dom29.daysRight
      );
      ok(
        `T29 split 硬约束：中间禁区带内无内容、左右两瓣紧挨传感器 (居中=${dom29.justify} 空隙=${dom29.gapW}px 期望=${zw29 + slots29} 越界=${JSON.stringify(dom29.bad)} 禁区带=${zr29.x}~${zr29.x + zr29.w})`,
        dom29.justify === 'center' &&
          dom29.gapW === zw29 + slots29 &&
          Array.isArray(dom29.bad) &&
          dom29.bad.length === 0
      );
      // 布局稳定性：两瓣必须保住内容宽度（曾被 flex-shrink 压成 11px/0px → 数字整块被裁，
      // 表现为"刚启动没文字，展开大窗口再收起才有"）
      const parts29 = await island.win.webContents.executeJavaScript(`(() => {
        const w = (s) => { const n = document.querySelector(s); return n ? Math.round(n.getBoundingClientRect().width) : -1; };
        const flexOf = (s) => { const n = document.querySelector(s); return n ? getComputedStyle(n).flex : ''; };
        const num = document.querySelector('.s-num');
        const b = num ? num.getBoundingClientRect() : null;
        const hit = b ? document.elementFromPoint(Math.round(b.left + b.width / 2), Math.round(b.top + b.height / 2)) : null;
        const l = document.querySelector('.nb-l');
        return { l: w('.nb-l'), r: w('.nb-r'), gap: w('.nb-gap'), lFlex: flexOf('.nb-l'), rFlex: flexOf('.nb-r'), numW: b ? Math.round(b.width) : 0, hit: hit ? String(hit.className || hit.id || hit.tagName) : '', state: document.body.dataset.state, row: document.querySelector('.s-row') ? 's-row' : document.querySelector('.e-row') ? 'e-row' : 'none', lHtml: l ? String(l.innerHTML).slice(0, 40) : '' };
      })()`);
      // 不变量：两瓣是 flex:0 0 auto（**永不压缩**，这是"启动没文字"的根因），数字在可视区内且能被命中。
      // 不断言左瓣像素宽度：emoji 字形宽度受字体就绪时间影响（偶发 0），那是环境波动不是缺陷。
      ok(
        `T29 split 两瓣永不压缩（flex 契约）+ 数字在可视区内 (state=${parts29.state} row=${parts29.row} 左瓣 flex=${parts29.lFlex} 宽 ${parts29.l}；右瓣 flex=${parts29.rFlex} 宽 ${parts29.r}；空隙 ${parts29.gap} 数字宽 ${parts29.numW} 命中=${parts29.hit})`,
        parts29.lFlex === '0 0 auto' && parts29.rFlex === '0 0 auto' && parts29.r >= 20 && parts29.gap > 0 && parts29.numW >= 8 && parts29.hit.indexOf('s-num') >= 0
      );
      // 端到端：白字必须真的画出来（这正是"刚启动没文字"的用户可见症状；只查 DOM 会漏掉）
      await sleep(300);
      const img29 = await island.win.webContents.capturePage();
      const bmp29 = img29.toBitmap();
      let bright29 = 0;
      for (let i = 0; i < bmp29.length; i += 4) {
        if (bmp29[i + 3] > 40 && bmp29[i + 2] > 180 && bmp29[i + 1] > 180 && bmp29[i] > 180) bright29 += 1;
      }
      ok(`T29 细条白字真的绘制出来了（亮像素 ${bright29} > 0）`, bright29 > 0);

      // below 布局：内容退到禁区下方（规格 below.top）
      island.manualState('zoom', 30000);
      await sleep(1100);
      const ns29z = await island.win.webContents.executeJavaScript(`window.__notchState()`);
      const zrz29 = ns29z.rect || { x: 0, y: 0, w: 0, h: 0 };
      const dom29z = await island.win.webContents.executeJavaScript(`(() => {
        const p = document.getElementById('pill');
        const c = document.getElementById('content');
        const pr = p.getBoundingClientRect();
        const zone = { l: ${zrz29.x}, t: ${zrz29.y}, r: ${zrz29.x + zrz29.w}, b: ${zrz29.y + zrz29.h} };
        const bad = [];
        document.querySelectorAll('#content *').forEach((el) => {
          if (el.children.length) return;
          const r = el.getBoundingClientRect();
          if (r.width < 1 || r.height < 1) return;
          const l = r.left - pr.left, t = r.top - pr.top, rr = r.right - pr.left, b = r.bottom - pr.top;
          if (Math.min(rr, zone.r) - Math.max(l, zone.l) > 1 && Math.min(b, zone.b) - Math.max(t, zone.t) > 1) bad.push((el.className || el.tagName) + '@' + Math.round(l) + ',' + Math.round(t));
        });
        const cs = getComputedStyle(c);
        const wrap = document.querySelector('.z-wrap');
        return {
          state: document.body.dataset.state,
          layout: document.body.dataset.notchLayout || '',
          padT: parseFloat(cs.paddingTop) || 0,
          wrapTop: wrap ? Math.round(wrap.getBoundingClientRect().top - pr.top) : -1,
          zoneBottom: zone.b,
          bad,
        };
      })()`);
      ok(
        `T29 below 硬约束：内容 top ≥ 禁区底边 (padding=${dom29z.padT} 内容顶=${dom29z.wrapTop} ≥ 禁区底=${dom29z.zoneBottom} 越界=${JSON.stringify(dom29z.bad)})`,
        dom29z.state === 'zoom' && dom29z.layout === 'below' && dom29z.padT > 0 && dom29z.wrapTop >= dom29z.zoneBottom && dom29z.bad.length === 0
      );

      // 调试层：传感器彩色圆点 + 禁区虚线框（规格 interaction.toggle_sensor）
      settings.update({ ui: { cameraNotch: { preset: 'center', debug: true } } });
      island.applySettings();
      await sleep(700);
      const dom29dbg = await island.win.webContents.executeJavaScript(`(() => {
        const box = document.getElementById('sensor-debug');
        const dots = box ? Array.from(box.querySelectorAll('.sd-dot')) : [];
        const zbox = box ? box.querySelector('.sd-zone') : null;
        return {
          shown: !!box && getComputedStyle(box).display !== 'none',
          dots: dots.length,
          sizes: dots.map((d) => Math.round(d.getBoundingClientRect().width)),
          colors: dots.map((d) => getComputedStyle(d).backgroundColor),
          dash: zbox ? getComputedStyle(zbox).borderTopStyle : '',
        };
      })()`);
      ok(
        `T29 调试层：${dom29dbg.dots} 个传感器圆点 ${JSON.stringify(dom29dbg.sizes)} + 禁区${dom29dbg.dash}框`,
        dom29dbg.shown &&
          dom29dbg.dots === 3 &&
          dom29dbg.sizes.join(',') === '13,10,14' &&
          dom29dbg.dash === 'dashed' &&
          new Set(dom29dbg.colors).size === 3
      );
      settings.update({ ui: { cameraNotch: { preset: 'center', debug: false } } });

      // 内容出场动画 + 黑底伸缩时长（规格 animation；加速模式下时长会压短）
      const animCfg29 = island.notchSpec().animMs;
      ok(
        `T29 动画规格 (黑底 ${animCfg29}ms ${island.notchSpec().animEase})`,
        (animCfg29 === 550 || animCfg29 === 60) && island.notchSpec().animEase === 'cubic-bezier(.32,.72,.28,1)'
      );
      island.manualState('strip', 20000);
      await sleep(900);
      island.perfAnim.reset();
      island.manualState('expanded', 20000);
      await sleep(1000);
      const anim29 = island.perfAnim.report();
      ok(
        `T29 黑底伸缩按设置时长 (实测 ${anim29.avgDurationMs}ms，设置 ${animCfg29}ms)`,
        anim29.animations >= 1 && anim29.avgDurationMs >= animCfg29 * 0.5 && anim29.avgDurationMs <= animCfg29 * 2 + 120
      );
      island.manualState('strip', 20000);
      await sleep(700);

      island.manualState('progress', 20000);
      const readPb29 = () =>
        island.win.webContents.executeJavaScript(`(() => {
          const el = document.querySelector('.pb-label');
          if (!el) return null;
          const cs = getComputedStyle(el);
          return {
            state: document.body.dataset.state,
            pos: cs.position,
            left: cs.left,
            cx: document.documentElement.style.getPropertyValue('--notch-cx'),
            half: document.documentElement.style.getPropertyValue('--notch-half'),
          };
        })()`);
      let dom29c = await readPb29();
      const pbDdl29 = Date.now() + 6000;
      while ((!dom29c || dom29c.state !== 'progress' || dom29c.pos !== 'absolute') && Date.now() < pbDdl29) {
        await sleep(150);
        dom29c = await readPb29();
      }
      const leftExp29 = dom29c ? parseFloat(dom29c.cx) + parseFloat(dom29c.half) + 10 : NaN;
      ok(
        `T29 顶部进度条文字让到禁区右侧 (position=${dom29c && dom29c.pos} left=${dom29c && dom29c.left} 期望≈${leftExp29}px)`,
        !!dom29c && dom29c.pos === 'absolute' && Math.abs(parseFloat(dom29c.left) - leftExp29) < 1.5
      );

      settings.update({ ui: { cameraNotch: { enabled: false } } });
      island.manualState('strip', 20000);
      island.applySettings();
      const offDdl29 = Date.now() + 6000;
      let dom29d = null;
      const readOff29 = () =>
        island.win.webContents.executeJavaScript(`(() => {
          const p = document.getElementById('pill');
          return {
            state: document.body.dataset.state,
            bodyNotch: document.body.dataset.notch || '',
            layout: document.body.dataset.notchLayout || '',
            pillNotch: p.dataset.notch || '',
            mask: p.style.maskImage || '',
            clip: p.style.clipPath || '',
            split: !!document.querySelector('.nb-l'),
            width: Math.round(p.getBoundingClientRect().width),
          };
        })()`);
      dom29d = await readOff29();
      while ((dom29d.state !== 'strip' || dom29d.width !== 116 || dom29d.bodyNotch || dom29d.layout || sensorCover.win) && Date.now() < offDdl29) {
        await sleep(150);
        dom29d = await readOff29();
      }
      ok(
        `T29 关闭后：盖板销毁、内容恢复单行居中 (宽=${dom29d.width} 盖板=${sensorCover.win ? '在' : '已销毁'} 黑底/布局已清=${!dom29d.bodyNotch && !dom29d.layout && dom29d.mask === '' && dom29d.clip === ''} 仍分栏=${dom29d.split})`,
        dom29d.state === 'strip' &&
          !dom29d.bodyNotch &&
          !dom29d.layout &&
          !dom29d.pillNotch &&
          dom29d.mask === '' &&
          dom29d.clip === '' &&
          !sensorCover.win &&
          dom29d.split === false &&
          dom29d.width === 116
      );
      if (ev29) settings.removeEvent(ev29.id);
      island.holdUntil = 0;

      // —— T30 天气系统（WMO 映射 / 解析 / 文案 / 触发去重 / 过期 / 离线降级 / 岛内显示 / 特效 / 配置接线 / 几何保护）——
      const wxMod = require('./weather');
      const sch30 = require('./schedule');
      const wxPrev30 = wxMod.loadCache(); // 记下原缓存，跑完还原（别把自检数据留在真实缓存里）
      const wxKeep30 = JSON.parse(JSON.stringify(settings.load().weather || {}));

      // 1) WMO 全码映射
      const codes30 = [0, 1, 2, 3, 45, 48, 51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 71, 73, 75, 77, 80, 81, 82, 85, 86, 95, 96, 99];
      const bad30 = codes30.filter((c) => {
        const d = wxMod.describeCode(c);
        return !d.text || !d.icon || !d.anim || !d.tone;
      });
      ok(
        `T30 WMO 全码映射完整 (${codes30.length} 码，缺字段=${bad30.length}；0→${wxMod.describeCode(0).text}/${wxMod.describeCode(0).anim}，63→${wxMod.describeCode(63).text}，75→${wxMod.describeCode(75).icon}，95→${wxMod.describeCode(95).anim})`,
        bad30.length === 0 && wxMod.describeCode(0).icon === 'sun' && wxMod.describeCode(75).anim === 'snow' && wxMod.describeCode(95).anim === 'thunder'
      );
      const unk30 = wxMod.describeCode(999);
      ok(
        `T30 未知天气码兜底不抛 (999→${unk30.text}/${unk30.anim}，null→${wxMod.describeCode(null).text}，dow(2026-09-21)=${wxMod.dowOf('2026-09-21')})`,
        unk30.code === 999 && unk30.anim === 'none' && wxMod.describeCode(null).code === null && wxMod.dowOf('2026-09-21') === '周一'
      );

      // 2) 预报解析（逐小时锚在「现在」附近，保证降雨前瞻可测且与运行日期无关）
      const now30 = new Date();
      const pad30 = (n) => String(n).padStart(2, '0');
      const hp30 = (off) => {
        const d = new Date(now30.getTime() + off * 3600000);
        return `${d.getFullYear()}-${pad30(d.getMonth() + 1)}-${pad30(d.getDate())}T${pad30(d.getHours())}:00`;
      };
      const dp30 = (off) => {
        const d = new Date(now30.getTime() + off * 86400000);
        return `${d.getFullYear()}-${pad30(d.getMonth() + 1)}-${pad30(d.getDate())}`;
      };
      const fx30 = {
        latitude: 34.75778,
        longitude: 113.66546,
        timezone: 'Asia/Shanghai',
        current: { time: hp30(0), temperature_2m: 21.4, relative_humidity_2m: 62, apparent_temperature: 20.1, weather_code: 61, wind_speed_10m: 8.3 },
        hourly: { time: [hp30(-1), hp30(1), hp30(2)], temperature_2m: [20.9, 22, 22.6], weather_code: [61, 63, 3], precipitation_probability: [70, 80, 20] },
        daily: {
          time: [dp30(0), dp30(1), dp30(2)],
          weather_code: [61, 71, 0],
          temperature_2m_max: [24.2, 12.5, 26],
          temperature_2m_min: [16.1, 5.2, 15],
          precipitation_probability_max: [80, 60, 5],
        },
      };
      const snap30 = wxMod.parseForecast(fx30, { city: '郑州 · 河南 · 中国', updatedAt: Date.now() });
      ok(
        `T30 预报解析 (当前=${snap30.current.text} ${snap30.current.temp}℃ 湿度=${snap30.current.humidity}%，天=${snap30.days.length} 首日=${snap30.days[0].dow} ${snap30.days[0].tMin}~${snap30.days[0].tMax}℃ 降水=${snap30.days[0].pop}%，次日图标=${snap30.days[1].icon}，小时=${snap30.hours.length})`,
        !!snap30 &&
          snap30.current.temp === 21.4 &&
          snap30.current.text === '小雨' &&
          snap30.current.icon === 'rain' &&
          snap30.days.length === 3 &&
          snap30.days[0].tMax === 24.2 &&
          snap30.days[0].pop === 80 &&
          snap30.days[1].icon === 'snow' &&
          snap30.hours.length === 3 &&
          snap30.hours[1].pop === 80
      );
      const bad30b = wxMod.parseForecast({ current: {}, daily: { time: [dp30(0)] } }, {});
      ok(
        `T30 缺字段/空响应不崩 (缺 current→${wxMod.parseForecast({ daily: { time: [] } })}，空对象→${wxMod.parseForecast({})}，坏值 temp=${bad30b.current.temp} tMax=${bad30b.days[0].tMax})`,
        wxMod.parseForecast({ daily: { time: [] } }) === null && wxMod.parseForecast({}) === null && bad30b.current.temp === null && bad30b.days[0].tMax === null
      );

      // 3) 地理编码
      const geo30 = wxMod.parseGeocode({ results: [{ name: '郑州', admin1: '河南', country: '中国', latitude: 34.75778, longitude: 113.66546 }] }, '郑州');
      let geoErr30 = '';
      let geoErr31 = '';
      try {
        wxMod.parseGeocode({ results: [] }, '不存在市');
      } catch (e) {
        geoErr30 = e.message;
      }
      try {
        wxMod.parseGeocode(null, '郑州');
      } catch (e) {
        geoErr31 = e.message;
      }
      ok(
        `T30 地理编码解析与报错 (${geo30.name} · ${geo30.admin} · ${geo30.country} @ ${geo30.lat},${geo30.lon}；空结果→${JSON.stringify(geoErr30.slice(0, 20))})`,
        geo30.lat === 34.8 && geo30.lon === 113.7 && geoErr30.includes('没有找到城市') && geoErr31.includes('没有找到城市')
      );

      // 4) 文案与关键词高亮
      const cfgW30 = { weather: { ...wxKeep30 } };
      const sNow30 = wxMod.summarize(snap30, 'now', cfgW30);
      const sToday30 = wxMod.summarize(snap30, 'today', cfgW30);
      const sTmr30 = wxMod.summarize(snap30, 'tomorrow', cfgW30);
      const sRain30 = wxMod.summarize(snap30, 'rain', cfgW30);
      const sHot30 = wxMod.summarize(snap30, 'temp', { weather: { ...wxKeep30, hotC: 20 } });
      const sCold30 = wxMod.summarize(snap30, 'temp', { weather: { ...wxKeep30, hotC: 40, coldDropC: 5 } });
      ok(
        `T30 五种提醒文案 (当前「${sNow30.body}」／今日「${sToday30.body}」／明日「${sTmr30.body}」／降雨「${sRain30.body}」)`,
        sNow30.title === '当前天气' &&
          sNow30.body.includes('21') &&
          sNow30.keywords.includes('雨') &&
          sToday30.body.includes('今天') &&
          sToday30.keywords.includes('雨') &&
          sTmr30.body.includes('明天') &&
          sTmr30.keywords.includes('雪') &&
          !!sRain30 &&
          sRain30.title === '降雨提醒' &&
          sRain30.keywords.includes('雨')
      );
      ok(
        `T30 高温/降温阈值与无话可说 (hotC=20→${sHot30.title}，hotC=40+降温5→${sCold30.title}，无雨→${wxMod.summarize({ ...snap30, hours: [] }, 'rain', cfgW30)}，无数据→${wxMod.summarize(null, 'today', cfgW30)})`,
        sHot30.title === '高温提醒' &&
          sHot30.keywords.includes('高温') &&
          sCold30.title === '降温提醒' &&
          sCold30.keywords.includes('降温') &&
          wxMod.summarize({ ...snap30, hours: [] }, 'rain', cfgW30) === null &&
          wxMod.summarize(null, 'today', cfgW30) === null
      );

      // 5) 触发与去重（纯函数 + 轮询两层）
      const r1t30 = sch30.fmtHM(7 * 60);
      const rules30 = [
        { id: 'r1', time: r1t30, days: 'daily', kind: 'today', enabled: true },
        { id: 'r2', time: '20:00', days: 'daily', kind: 'rain', enabled: true },
        { id: 'r3', time: r1t30, days: [0], kind: 'today', enabled: true }, // 周一（(getDay()+6)%7）
        { id: 'r4', time: r1t30, days: 'daily', kind: 'today', enabled: false },
      ];
      const at30 = (d, h, m) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m, 30);
      const mon30 = new Date(2026, 8, 21); // 2026-09-21 周一
      const tue30 = new Date(2026, 8, 22);
      const due30a = wxMod.dueReminders(snap30, rules30, at30(mon30, 7, 0), cfgW30).map((r) => r.rule.id).sort();
      const due30b = wxMod.dueReminders(snap30, rules30, at30(tue30, 7, 0), cfgW30).map((r) => r.rule.id).sort();
      const due30c = wxMod.dueReminders(snap30, rules30, at30(mon30, 7, 1), cfgW30);
      ok(
        `T30 提醒触发：同分钟+星期筛选+停用跳过 (周一 07:00→${due30a.join(',')}；周二 07:00→${due30b.join(',')}；07:01→${due30c.length} 条)`,
        due30a.join(',') === 'r1,r3' && due30b.join(',') === 'r1' && due30c.length === 0
      );
      settings.update({
        weather: {
          enabled: true,
          city: '郑州',
          reminders: [
            { id: 'w1', time: r1t30, days: 'daily', kind: 'today', enabled: true },
            { id: 'w2', time: r1t30, days: 'once', kind: 'today', enabled: true },
          ],
        },
      });
      wxMod.saveCache({ snapshot: snap30, error: null });
      wxMod.resetReminders();
      const fired30a = wxMod.checkReminders(at30(mon30, 7, 0), () => {});
      const fired30b = wxMod.checkReminders(at30(mon30, 7, 0), () => {});
      const rest30 = settings.load().weather.reminders;
      ok(
        `T30 轮询去重+一次性自删 (第一次 ${fired30a.length} 条 / 第二次 ${fired30b.length} 条，剩余规则=${rest30.map((r) => r.id).join(',') || '无'})`,
        fired30a.length === 2 && fired30b.length === 0 && rest30.length === 1 && rest30[0].id === 'w1'
      );
      settings.update({ weather: { enabled: false } });
      ok(
        `T30 关掉天气后不再触发 (${wxMod.checkReminders(at30(mon30, 7, 0), () => {}).length} 条)`,
        wxMod.checkReminders(at30(mon30, 7, 0), () => {}).length === 0
      );

      // 6) 过期判定 + 离线降级（注入会失败的 fetch，验证「报错但不抛、保留旧数据」）
      const off30 = await wxMod.refresh({ force: true, deps: { fetchJson: () => Promise.reject(new Error('断网测试')) } });
      const cached30 = wxMod.loadCache();
      ok(
        `T30 离线降级：报错不抛、保留旧数据 (ok=${off30.ok} error=${JSON.stringify(String(off30.error || '').slice(0, 12))} 快照还在=${!!cached30.snapshot})`,
        off30.ok === false && !!off30.error && !!cached30.snapshot
      );
      ok(
        `T30 过期判定（30 分钟刷新：刚更新=${wxMod.isStale(snap30, new Date(), 30)}，10 小时后=${wxMod.isStale(snap30, new Date(Date.now() + 10 * 3600000), 30)}，无数据=${wxMod.isStale(null, new Date(), 30)}）`,
        wxMod.isStale(snap30, new Date(), 30) === false &&
          wxMod.isStale(snap30, new Date(Date.now() + 10 * 3600000), 30) === true &&
          wxMod.isStale(null, new Date(), 30) === true
      );

      // 7) 默认值 + 岛内载荷
      const def30 = require('./settings').DEFAULTS.weather;
      ok(
        `T30 天气默认值 (启用=${def30.enabled} 城市=${def30.city} 间隔=${def30.refreshMin} 单位=${def30.unit} 岛内=${def30.showInIsland} 动画=${def30.anim}/${def30.animIntensity} 出厂提醒=${def30.reminders.length} 条)`,
        def30.enabled === false &&
          def30.showInIsland === 'always' &&
          def30.anim === true &&
          def30.animIntensity === 100 &&
          def30.refreshMin === 30 &&
          Array.isArray(def30.reminders) &&
          def30.reminders.length === 0
      );
      settings.update({ weather: { enabled: true, city: '郑州', showInIsland: 'banner', anim: true, animIntensity: 100, unit: 'c' } });
      wxMod.saveCache({ snapshot: snap30, error: null });
      const wPay30 = island.getStatePayload().weather;
      ok(
        `T30 岛内载荷 (显示=${wPay30 && wPay30.show} 模式=${wPay30 && wPay30.mode} ${wPay30 && wPay30.text} ${wPay30 && wPay30.temp}° 图标=${wPay30 && wPay30.icon} 动画=${wPay30 && wPay30.anim} 强度=${wPay30 && wPay30.intensity})`,
        !!wPay30 &&
          wPay30.show === true &&
          wPay30.mode === 'banner' &&
          wPay30.icon === 'rain' &&
          wPay30.anim === 'rain' &&
          wPay30.temp === 21.4 &&
          wPay30.animEnabled === true &&
          wPay30.intensity === 100
      );

      // 8) 岛内 DOM：细条不显示（几何保护）、横幅显示且动画正确、关掉动画→静态图标
      settings.upsertEvent({ id: null, name: '天气自检', date: '2099-01-01T00:00:00', emoji: '⏰', color: '#4f7cff', enabled: true });
      const ev30 = settings.events().find((e) => e.name === '天气自检');
      const readWx30 = () =>
        island.win.webContents.executeJavaScript(`(() => { try {
          const w = document.getElementById('wx');
          const fx = document.getElementById('wx-fx');
          const pill = document.getElementById('pill');
          const nb = (s) => { const n = document.querySelector(s); return n ? n.getBoundingClientRect() : null; };
          const chip = w ? w.getBoundingClientRect() : null;
          let zone = null;
          try { zone = window.__notchState ? window.__notchState().rect || null : null; } catch (e) { zone = null; }
          const right = nb('.nb-r');
          return {
            state: document.body.dataset.state,
            has: !!w,
            hidden: w ? (w.hidden || getComputedStyle(w).display === 'none') : null,
            compact: w ? w.dataset.compact === '1' : false,
            anim: w ? w.dataset.anim || '' : '',
            tone: w ? w.dataset.tone || '' : '',
            temp: w ? ((w.querySelector('.wx-temp') || {}).textContent || '') : '',
            text: w ? ((w.querySelector('.wx-text') || {}).textContent || '') : '',
            fxHidden: fx ? (fx.hidden || getComputedStyle(fx).display === 'none') : null,
            fxFx: fx ? fx.dataset.fx || '' : '',
            fxCount: fx ? fx.children.length : 0,
            width: pill ? Math.round(pill.getBoundingClientRect().width) : 0,
            chipL: chip ? Math.round(chip.left) : null,
            chipR: chip ? Math.round(chip.right) : null,
            textShown: w ? getComputedStyle(w.querySelector('.wx-text') || w).display !== 'none' : false,
            zoneR: zone ? Math.round(zone.x + zone.w) : null,
            rightR: right ? Math.round(right.right) : null,
          };
        } catch (e) { return { err: String((e && e.message) || e) }; } })()`);
      island.manualState('strip', 30000);
      await sleep(700);
      let dom30 = await readWx30();
      ok(`T30 showInIsland=banner 时细条不显示天气（几何保护：细条宽 ${dom30.width} 期望 116）`, dom30.state === 'strip' && dom30.has === false && dom30.width === 116);
      // 常驻模式：细条也显示天气 chip（紧凑态：只图标+温度），且几何留了天气槽、不与禁区/右瓣重叠
      settings.update({ ui: { cameraNotch: { enabled: true, preset: 'center' } }, weather: { showInIsland: 'always' } });
      island.applySettings();
      island.pushWeather(true);
      await sleep(1100);
      const spec30 = island.notchSpec(); // 必须在这之后读：上面刚把挖孔打开，才有 zone
      dom30 = await readWx30();
      const wxSlot30 = 88;
      const expectStrip30 = spec30 && spec30.zone ? 116 + Math.round(spec30.zone.w) + spec30.slotLeft + spec30.slotRight + wxSlot30 : -1;
      ok(
        `T30 天气常驻细条（宽 ${dom30.width} 期望 ${expectStrip30}；chip=${dom30.has} 紧凑=${dom30.compact} 只图标+温度=${!dom30.textShown} ${dom30.temp}；chip ${dom30.chipL}~${dom30.chipR} 右瓣右缘=${dom30.rightR} 禁区右缘=${dom30.zoneR} err=${JSON.stringify(dom30.err || '')}）`,
        dom30.state === 'strip' &&
          dom30.has === true &&
          dom30.compact === true &&
          dom30.textShown === false &&
          dom30.width === expectStrip30 &&
          dom30.chipL >= dom30.rightR &&
          dom30.chipL >= dom30.zoneR
      );
      // 还原：后面的用例按「无挖孔 + banner」跑
      settings.update({ ui: { cameraNotch: { enabled: false } }, weather: { showInIsland: 'banner' } });
      island.applySettings();
      island.pushWeather(true);
      await sleep(600);
      // 天气位置：左侧 / 盖板上（画在传感器盖板窗口里，细条不占位）
      settings.update({ weather: { showInIsland: 'always', pos: 'left' } });
      island.applySettings();
      island.pushWeather(true);
      await sleep(900);
      const posLeft30 = await readWx30();
      ok(
        `T30 天气位置=左侧 (chip ${posLeft30.chipL}~${posLeft30.chipR} 宽 ${posLeft30.width}；贴左缘=${posLeft30.chipL <= 16})`,
        posLeft30.has === true && posLeft30.chipL <= 16 && posLeft30.chipR < posLeft30.width / 2
      );
      // 盖板上：细条让位（不占位、不画），天气由盖板窗口自己画 —— 必须先开挖孔，盖板窗口才存在
      settings.update({ ui: { cameraNotch: { enabled: true, preset: 'center' } }, weather: { pos: 'cover' } });
      island.applySettings();
      island.syncSensorCover();
      island.pushWeather(true);
      await sleep(1200);
      const posCover30 = await readWx30();
      const coverWin30 = require('./sensor-cover').win;
      const coverWx30 = coverWin30 && !coverWin30.isDestroyed()
        ? await coverWin30.webContents.executeJavaScript(`(() => { const w = document.getElementById('wx'); const t = document.getElementById('wx-temp'); return { on: w ? w.classList.contains('on') : null, temp: t ? t.textContent : '', anim: document.documentElement.dataset.anim || '' }; })()`)
        : null;
      ok(
        `T30 天气位置=盖板上（细条让位：has=${posCover30.has} 宽 ${posCover30.width} 期望 229；盖板上 chip=${JSON.stringify(coverWx30)}）`,
        posCover30.has === false && posCover30.width === 229 && !!coverWx30 && coverWx30.on === true && coverWx30.temp.includes('21') && coverWx30.anim === 'rain'
      );
      settings.update({ ui: { cameraNotch: { enabled: false } }, weather: { pos: 'right' } });
      island.applySettings();
      island.pushWeather(true);
      await sleep(500);
      island.manualState('expanded', 30000);
      await sleep(900);
      dom30 = await readWx30();
      ok(
        `T30 横幅显示天气 chip 且图标动画正确 (state=${dom30.state} ${dom30.text} ${dom30.temp} anim=${dom30.anim} tone=${dom30.tone})`,
        dom30.state === 'expanded' && dom30.hidden === false && dom30.anim === 'rain' && dom30.tone === 'wet' && dom30.text === '小雨' && dom30.temp.includes('21')
      );
      settings.update({ weather: { anim: false } });
      island.pushWeather(true);
      await sleep(700);
      dom30 = await readWx30();
      ok(`T30 关掉动画→静态图标 (anim=${dom30.anim})`, dom30.anim === 'none');
      settings.update({ weather: { anim: true } });
      island.pushWeather(true);
      await sleep(700);
      // 没有倒计时事件时也要有天气（空态不再吞掉天气 chip）
      if (ev30) settings.removeEvent(ev30.id);
      island.applySettings();
      island.pushWeather(true);
      await sleep(900);
      dom30 = await readWx30();
      ok(`T30 无倒计时事件时仍显示天气 (state=${dom30.state} has=${dom30.has} ${dom30.text} ${dom30.temp} anim=${dom30.anim})`,
        dom30.state === 'expanded' && dom30.has === true && dom30.anim === 'rain' && dom30.temp.includes('21'));

      // 9) 提醒时整条岛的天气特效
      island.showNotification('降雨提醒', '未来 6 小时内可能下雨（降水概率 80%）', { alert: true, keywords: ['雨'], weather: 'rain' });
      await sleep(900);
      dom30 = await readWx30();
      ok(
        `T30 提醒时整条岛天气特效 (state=${dom30.state} fx=${dom30.fxFx} 显示=${dom30.fxHidden === false} 层数=${dom30.fxCount})`,
        dom30.state === 'notify' && dom30.fxFx === 'rain' && dom30.fxHidden === false && dom30.fxCount > 0
      );
      island.dismissNotify();
      await sleep(800);
      dom30 = await readWx30();
      ok(`T30 收起通知后特效撤掉 (fx=${JSON.stringify(dom30.fxFx)} 隐藏=${dom30.fxHidden})`, dom30.fxFx === '' || dom30.fxHidden === true);

      // 10) 配置页天气页接线（新开窗口 → init 按当前设置回填）
      settings.update({ weather: { enabled: true, city: '郑州', reminders: [{ id: 'wcfg1', time: '07:00', days: 'daily', kind: 'today', enabled: true }] } });
      config.open();
      let cfgWin30 = null;
      const cfgDdl30 = Date.now() + 8000;
      while (Date.now() < cfgDdl30) {
        cfgWin30 = config.getWindow();
        if (cfgWin30 && !cfgWin30.webContents.isLoading()) {
          const probe30 = await cfgWin30.webContents.executeJavaScript(`(() => {
            const c = document.getElementById('wxCity');
            return { ready: !!document.querySelector('#tabs .tab[data-tab="weather"]'), city: c ? c.value : null };
          })()`);
          if (probe30 && probe30.ready && probe30.city === '郑州') break;
        }
        await sleep(150);
      }
      let wxCfg30 = null;
      if (cfgWin30) {
        wxCfg30 = await cfgWin30.webContents.executeJavaScript(`(() => {
          const tab = document.querySelector('#tabs .tab[data-tab="weather"]');
          if (tab) tab.click();
          const g = (id) => { const el = document.getElementById(id); return el ? (el.type === 'checkbox' ? el.checked : el.value) : null; };
          return {
            tab: !!tab,
            active: !!document.querySelector('#tab-weather.active'),
            enabled: g('wxEnabled'), city: g('wxCity'), unit: g('wxUnit'), show: g('wxShow'), pos: g('wxPos'),
            anim: g('wxAnim'), intensity: g('wxIntensity'), refresh: g('wxRefresh'),
            rules: document.querySelectorAll('#wx-rules .wx-rule').length,
            status: (document.getElementById('wx-status') || {}).textContent || '',
            err: (document.getElementById('err') || {}).textContent || '',
          };
        })()`);
      }
      ok(
        `T30 配置页天气 tab 接线 (标签=${!!(wxCfg30 && wxCfg30.tab)} 激活=${!!(wxCfg30 && wxCfg30.active)} 启用=${wxCfg30 && wxCfg30.enabled} 城市=${wxCfg30 && wxCfg30.city} 单位=${wxCfg30 && wxCfg30.unit} 岛内=${wxCfg30 && wxCfg30.show} 动画=${wxCfg30 && wxCfg30.anim}/${wxCfg30 && wxCfg30.intensity} 间隔=${wxCfg30 && wxCfg30.refresh} 规则=${wxCfg30 && wxCfg30.rules} 状态=${JSON.stringify(((wxCfg30 && wxCfg30.status) || '').slice(0, 16))} err=${JSON.stringify((wxCfg30 && wxCfg30.err) || '')})`,
        !!wxCfg30 &&
          wxCfg30.tab &&
          wxCfg30.active &&
          wxCfg30.enabled === true &&
          wxCfg30.city === '郑州' &&
          wxCfg30.unit === 'c' &&
          wxCfg30.show === 'always' &&
          wxCfg30.pos === 'right' &&
          wxCfg30.anim === true &&
          Number(wxCfg30.intensity) === 100 &&
          Number(wxCfg30.refresh) === 30 &&
          wxCfg30.rules === 1 &&
          !wxCfg30.err
      );
      const add30 = cfgWin30
        ? await cfgWin30.webContents.executeJavaScript(`(() => {
            const t = document.getElementById('wxRuleTime'); if (t) t.value = '06:30';
            const k = document.getElementById('wxRuleKind'); if (k) k.value = 'rain';
            const d = document.getElementById('wxRuleDays'); if (d) d.value = 'daily';
            const b = document.getElementById('btn-add-wx-rule'); if (b) b.click();
            return true;
          })()`)
        : false;
      await sleep(1000);
      const rows30 = cfgWin30 ? await cfgWin30.webContents.executeJavaScript(`document.querySelectorAll('#wx-rules .wx-rule').length`) : 0;
      const saved30 = settings.load().weather.reminders || [];
      ok(
        `T30 配置页加一条天气提醒并持久化 (行数=${rows30} 保存=${saved30.length} 条：${saved30.map((r) => `${r.time}/${r.kind}`).join(',')})`,
        !!add30 && rows30 === 2 && saved30.length === 2 && saved30.some((r) => r.time === '06:30' && r.kind === 'rain')
      );
      const test30 = cfgWin30
        ? await cfgWin30.webContents.executeJavaScript(`(async () => {
            const b = document.getElementById('btn-wx-test');
            if (!b) return { ok: false, note: 'no-button' };
            b.click();
            await new Promise((r) => setTimeout(r, 1500));
            return { ok: true, note: (document.getElementById('wx-test-note') || {}).textContent || '' };
          })()`)
        : null;
      ok(
        `T30 配置页「试一条」走通 IPC 并弹示例 (${JSON.stringify(((test30 && test30.note) || '').slice(0, 26))})`,
        !!test30 && test30.ok === true && /已弹出示例/.test((test30 && test30.note) || '')
      );

      // 11) 收尾：撤通知、关配置窗、设置与缓存还原
      island.dismissNotify();
      config.close();
      settings.update({
        weather: {
          enabled: wxKeep30.enabled,
          city: wxKeep30.city,
          lat: wxKeep30.lat,
          lon: wxKeep30.lon,
          resolvedName: wxKeep30.resolvedName,
          reminders: wxKeep30.reminders,
          anim: wxKeep30.anim,
          animIntensity: wxKeep30.animIntensity,
          showInIsland: wxKeep30.showInIsland,
          unit: wxKeep30.unit,
        },
      });
      wxMod.saveCache({ snapshot: wxPrev30.snapshot, error: wxPrev30.error });
      wxMod.resetReminders();
      wxMod.__test.setFailCount(0);
      island.pushWeather(true);
      if (ev30) settings.removeEvent(ev30.id);
      island.holdUntil = 0;
      await sleep(400);

      // —— T31 盖板自定义内容（模板 + 程序变量；纯函数 + 盖板窗口实测）——
      const ct31 = require('./cover-text');
      const now31 = new Date(2026, 8, 21, 8, 30, 7); // 2026-09-21 周一 08:30:07
      const ev31 = [
        { id: 'a', name: '高考', emoji: '🎓', date: '2027-06-07T09:00:00', enabled: true },
        { id: 'b', name: '期末考', emoji: '📘', date: '2026-09-25T08:00:00', enabled: true, pinned: true },
      ];
      const ctx31 = ct31.buildContext({
        settings: { events: ev31, ui: { dayRounding: 'down', showPast: false }, schedule: {} },
        now: now31,
        curPeriod: { period: { name: '数学' }, index: 3 },
        nxtPeriod: { period: { name: '语文' }, index: 4, startAt: 8 * 60 + 55, isTomorrow: false },
        periodLabel: (i, n) => n,
        weatherSnap: { city: '郑州', current: { temp: 18.6, text: '中雨' } },
      });
      ok(
        `T31 变量上下文 (置顶优先=${ctx31.name} emoji=${ctx31.emoji} 天数=${ctx31.days}${ctx31.unit} 小单位=${ctx31.sub} 目标=${ctx31.date} 事件数=${ctx31.count} 时间=${ctx31.time}:${ctx31.sec} ${ctx31.week} 当前节=${ctx31.subject} 下一节=${ctx31.next} 还有=${ctx31.min}分 天气=${ctx31.temp}°/${ctx31.weather}/${ctx31.city})`,
        ctx31.name === '期末考' &&
          ctx31.emoji === '📘' &&
          ctx31.days === '3' &&
          ctx31.unit === '天' &&
          ctx31.date === '2026-09-25 08:00' &&
          ctx31.count === '2' &&
          ctx31.time === '08:30' &&
          ctx31.sec === '07' &&
          ctx31.week === '周一' &&
          ctx31.subject === '数学' &&
          ctx31.next === '语文' &&
          ctx31.min === '25' &&
          ctx31.temp === '19' &&
          ctx31.weather === '中雨' &&
          ctx31.city === '郑州'
      );
      const r31 = ct31.renderTemplate('{name} 还有 {days}{unit}', ctx31);
      const r31b = ct31.renderTemplate('{time} {temp}° {weather} · 距 {next} {min} 分', ctx31);
      const r31c = ct31.renderTemplate('{unknown}{oops}', ctx31);
      const r31d = ct31.renderTemplate('', ctx31);
      const r31e = ct31.renderTemplate('{name} {days}', {});
      ok(
        `T31 模板渲染 (「${r31}」／「${r31b}」／未知变量→${JSON.stringify(r31c)} 空模板→${JSON.stringify(r31d)} 缺上下文→${JSON.stringify(r31e)})`,
        r31 === '期末考 还有 3天' && r31b === '08:30 19° 中雨 · 距 语文 25 分' && r31c === '' && r31d === '' && r31e === ' '
      );
      ok(
        `T31 变量清单可枚举 (${ct31.VARS.length} 个：${ct31.VARS.slice(0, 4).map((v) => `{${v.key}}`).join(' ')} …)`,
        ct31.VARS.length >= 12 && ct31.VARS.every((v) => v.key && v.desc && v.sample != null)
      );
      const ct31days = [0, 1, 2, 7].map((d) => `${ct31.roundDays(d * 86400000, 'down')}/${ct31.roundDays(d * 86400000, 'up')}/${ct31.roundDays(d * 86400000, 'round')}`);
      ok(
        `T31 天数取整与渲染层同语义 (下/上/四舍五入：${ct31days.join(' ')})`,
        ct31.roundDays(0, 'up') === 1 && ct31.roundDays(0.4 * 86400000, 'round') === 0 && ct31.roundDays(1.6 * 86400000, 'down') === 1
      );
      ok(
        `T31 主时间单位降级 (25 时→${ct31.timeUnits(25 * 3600000, 'down').num}${ct31.timeUnits(25 * 3600000, 'down').unit}，90 分→${ct31.timeUnits(90 * 60000, 'down').unit}，45 秒→${ct31.timeUnits(45000, 'down').unit}，过期→${ct31.timeUnits(-5000, 'down').num}${ct31.timeUnits(-5000, 'down').unit})`,
        ct31.timeUnits(25 * 3600000, 'down').num === 1 &&
          ct31.timeUnits(25 * 3600000, 'down').unit === '天' &&
          ct31.timeUnits(90 * 60000, 'down').unit === '时' &&
          ct31.timeUnits(45000, 'down').unit === '秒' &&
          ct31.timeUnits(-5000, 'down').num === 0
      );
      const pick31 = ct31.pickPrimary(ev31, now31, false);
      const pick31b = ct31.pickPrimary([{ id: 'p', name: '已过', date: '2020-01-01T00:00:00', enabled: true }], now31, false);
      const pick31c = ct31.pickPrimary([{ id: 'x', name: '停用', date: '2099-01-01T00:00:00', enabled: false }], now31, false);
      ok(
        `T31 主事件挑选（与渲染层同规则）(置顶→${pick31 && pick31.name}；全过期→${pick31b && pick31b.name}；全停用→${pick31c})`,
        !!pick31 && pick31.name === '期末考' && !!pick31b && pick31b.name === '已过' && pick31c === null
      );
      // 端到端：模板写进设置 → 盖板窗口真的画出这行字（与天气 chip 并存）
      const cnKeep31 = JSON.parse(JSON.stringify(settings.load().ui.cameraNotch || {}));
      const wxKeep31 = JSON.parse(JSON.stringify(settings.load().weather || {}));
      settings.update({
        ui: { cameraNotch: { enabled: true, preset: 'center', text: { template: '还有 {days}{unit}', size: 12 } } },
        weather: { enabled: true, showInIsland: 'always', pos: 'cover', anim: true, city: '郑州', unit: 'c' },
      });
      wxMod.saveCache({ snapshot: snap30, error: null });
      island.applySettings();
      island.syncSensorCover();
      island.pushCoverContent(true);
      await sleep(900);
      const coverWin31 = require('./sensor-cover').win;
      const coverDom31 = coverWin31 && !coverWin31.isDestroyed()
        ? await coverWin31.webContents.executeJavaScript(`(() => {
            const t = document.getElementById('txt');
            const w = document.getElementById('wx');
            return { text: t ? t.textContent : null, size: t ? getComputedStyle(t).fontSize : '', weatherOn: w ? w.classList.contains('on') : false, temp: (document.getElementById('wx-temp') || {}).textContent || '' };
          })()`)
        : null;
      const expectTxt31 = ct31.renderTemplate('还有 {days}{unit}', island.coverContext());
      ok(
        `T31 盖板端到端：自定义文字（有文字时不挤天气 chip） (文字=${JSON.stringify(coverDom31 && coverDom31.text)} 期望=${JSON.stringify(expectTxt31)} 字号=${coverDom31 && coverDom31.size} 天气 chip=${coverDom31 && coverDom31.weatherOn})`,
        !!coverDom31 && !!expectTxt31 && coverDom31.text === expectTxt31 && /还有/.test(coverDom31.text) && coverDom31.size === '12px' && coverDom31.weatherOn === false
      );
      // 模板留空 → 盖板上自动显示天气 chip（原来的行为）
      settings.update({ ui: { cameraNotch: { text: { template: '' } } } });
      island.pushCoverContent(true);
      await sleep(600);
      const coverDom31b = coverWin31 && !coverWin31.isDestroyed()
        ? await coverWin31.webContents.executeJavaScript(`(() => { const w = document.getElementById('wx'); const t = document.getElementById('txt'); return { weatherOn: w ? w.classList.contains('on') : false, temp: (document.getElementById('wx-temp') || {}).textContent || '', text: t ? t.textContent : null }; })()`)
        : null;
      ok(
        `T31 盖板端到端：模板留空则只画天气 chip (天气=${coverDom31b && coverDom31b.weatherOn}/${coverDom31b && coverDom31b.temp}，文字=${JSON.stringify(coverDom31b && coverDom31b.text)})`,
        !!coverDom31b && coverDom31b.weatherOn === true && (coverDom31b.temp || '').includes('°') && coverDom31b.text === ''
      );
      settings.update({ ui: { cameraNotch: { text: { template: '还有 {days}{unit}', size: 12 } } } });
      island.pushCoverContent(true);
      await sleep(400);
      const prev31 = island.coverTextPreview('{time} {temp}°');
      ok(
        `T31 配置页预览走通 IPC (模板「{time} {temp}°」→ ${JSON.stringify(prev31 && prev31.text)})`,
        !!prev31 && prev31.ok === true && /^\d{2}:\d{2}/.test(prev31.text || '')
      );
      const coverShot31 = require('./sensor-cover');
      if (coverShot31.win && !coverShot31.win.isDestroyed()) {
        fs.writeFileSync(path.join(os.tmpdir(), 'sci-cover-text.png'), (await coverShot31.win.webContents.capturePage()).toPNG());
      }
      settings.update({
        ui: { cameraNotch: { enabled: cnKeep31.enabled, text: cnKeep31.text } },
        weather: { enabled: wxKeep31.enabled, showInIsland: wxKeep31.showInIsland, pos: wxKeep31.pos || 'right' },
      });
      island.applySettings();
      island.pushWeather(true);
      await sleep(300);

      // —— T32 设置页外壳（液态玻璃 / 侧栏布局 / 自绘标题栏拖动 / 设置搜索）——
      config.open();
      let cfg32 = null;
      const dl32 = Date.now() + 8000;
      while (Date.now() < dl32) {
        cfg32 = config.getWindow();
        if (cfg32 && !cfg32.webContents.isLoading()) {
          const ready32 = await cfg32.webContents.executeJavaScript(`!!document.querySelector('#titlebar') && !!document.querySelector('#setSearch')`);
          if (ready32) break;
        }
        await sleep(150);
      }
      const shell32 = cfg32
        ? await cfg32.webContents.executeJavaScript(`(() => {
            const nav = document.getElementById('tabs');
            const cs = getComputedStyle(nav);
            const tabs = Array.from(nav.querySelectorAll('.tab'));
            const bar = document.getElementById('titlebar');
            const cards = Array.from(document.querySelectorAll('#tab-display .field'));
            const glass = cards.length ? getComputedStyle(cards[0]) : null;
            return {
              cols: cs.gridTemplateColumns || '', dir: cs.flexDirection, caps: nav.querySelectorAll('.nav-cap').length,
              tabs: tabs.length, icons: tabs.filter((t) => t.querySelector('.ico')).length,
              navDot: !!document.querySelector('.nav-foot .dot'),
              searchIco: !!document.querySelector('.search-wrap .search-ico'),
              coverTextField: !!document.getElementById('coverText'),
              coverTextVisible: (() => { const f = document.getElementById('coverText'); if (!f) return false; const w = f.closest('.field'); if (!w) return false; return !w.closest('[hidden]'); })(),
              barBg: bar ? getComputedStyle(bar).backgroundColor : '', barBlur: bar ? (getComputedStyle(bar).backdropFilter || getComputedStyle(bar).webkitBackdropFilter || '') : '',
              fieldCols: glass ? glass.gridTemplateColumns : '', fieldBlur: glass ? (glass.backdropFilter || '') : '',
              radius: glass ? glass.borderRadius : '',
              hasMinBtn: !!document.getElementById('btn-min'), hasCloseBtn: !!document.getElementById('btn-close'),
              coverPreview: (document.getElementById('coverPreview') || {}).textContent || '',
            };
          })()`)
        : null;
      ok(
        `T32 设置页外壳：侧栏导航 + 玻璃面板 + 无多余图标 (导航=${shell32 && shell32.dir} 分组=${shell32 && shell32.caps} 标签=${shell32 && shell32.tabs} 装饰图标=${shell32 && shell32.icons} 状态点=${shell32 && shell32.navDot} 搜索图标=${shell32 && shell32.searchIco}；标题栏玻璃=${JSON.stringify(shell32 && shell32.barBg)}/${JSON.stringify(shell32 && shell32.barBlur)}；字段两列=${JSON.stringify(shell32 && shell32.fieldCols)} 圆角=${shell32 && shell32.radius})`,
        !!shell32 &&
          shell32.dir === 'column' &&
          shell32.caps >= 3 &&
          shell32.tabs === 11 &&
          shell32.icons === 0 &&
          shell32.navDot === false &&
          shell32.searchIco === false &&
          /rgba?\(/.test(shell32.barBg || '') &&
          /blur/.test(shell32.barBlur || '') &&
          /px/.test(shell32.fieldCols || '') &&
          shell32.radius !== '0px'
      );
      ok(
        `T32 盖板内容设置项可见（不在「显示高级参数」折叠区里）(字段存在=${shell32 && shell32.coverTextField} 可见=${shell32 && shell32.coverTextVisible} 预览=${JSON.stringify((shell32 && shell32.coverPreview) || '')})`,
        !!shell32 && shell32.coverTextField === true && shell32.coverTextVisible === true && /预览|留空/.test((shell32 && shell32.coverPreview) || '')
      );
      // 无边框窗口：自绘标题栏拖动（主进程按屏幕坐标搬窗口）
      const dragB0 = cfg32 ? cfg32.getBounds() : null;
      if (cfg32) {
        config.dragStart(200, 200);
        config.dragMove(260, 240);
        config.dragEnd();
        await sleep(200);
      }
      const dragB1 = cfg32 ? cfg32.getBounds() : null;
      ok(
        `T32 无边框窗口拖动 (${dragB0 ? `${dragB0.x},${dragB0.y}` : '无'} → ${dragB1 ? `${dragB1.x},${dragB1.y}` : '无'}，期望 +60,+40；frame=${cfg32 ? cfg32.isResizable() : false})`,
        !!dragB0 && !!dragB1 && dragB1.x === dragB0.x + 60 && dragB1.y === dragB0.y + 40
      );
      // 设置搜索：命中高亮 + 未命中隐藏 + 自动跳到含该词的页；清空后恢复
      const search32 = cfg32
        ? await cfg32.webContents.executeJavaScript(`(async () => {
            document.querySelector('#tabs .tab[data-tab="events"]').click();
            const b = document.getElementById('setSearch');
            b.value = '玻璃';
            b.dispatchEvent(new Event('input'));
            await new Promise((r) => setTimeout(r, 350));
            const hit = document.querySelectorAll('.field.search-hit').length;
            const miss = document.querySelectorAll('.field.search-miss').length;
            const active = (document.querySelector('.tabpage.active') || {}).id || '';
            const titleHidden = Array.from(document.querySelectorAll('#tab-display .sec-title')).filter((t) => t.classList.contains('search-miss')).length;
            b.value = '';
            b.dispatchEvent(new Event('input'));
            await new Promise((r) => setTimeout(r, 200));
            return { hit, miss, active, titleHidden, afterHit: document.querySelectorAll('.field.search-hit').length, afterMiss: document.querySelectorAll('.field.search-miss').length };
          })()`)
        : null;
      ok(
        `T32 设置搜索过滤 (命中=${search32 && search32.hit} 隐藏=${search32 && search32.miss} 自动跳到=${search32 && search32.active} 空标题也隐藏=${search32 && search32.titleHidden}；清空后 命中=${search32 && search32.afterHit}/隐藏=${search32 && search32.afterMiss})`,
        !!search32 && search32.hit >= 2 && search32.miss > 20 && search32.active === 'tab-display' && search32.afterHit === 0 && search32.afterMiss === 0
      );
      config.close();
      await sleep(300);

      // —— T33 玻璃实验室窗口（--glass-lab / 设置页「预览玻璃效果」）+ 边缘色散 ——
      const lab33 = require('./glass-lab');
      lab33.open();
      let labW = null;
      const dl33 = Date.now() + 10000;
      while (Date.now() < dl33) {
        labW = lab33.getWindow();
        if (labW && !labW.webContents.isLoading()) {
          const r33 = await labW.webContents.executeJavaScript(`!!document.getElementById('g-ab2')`).catch(() => false);
          if (r33) break;
        }
        await sleep(150);
      }
      ok(`T33 玻璃实验室窗口打开 (窗口=${!!labW} loaded=${lab33.isLoaded()})`, !!labW && lab33.isLoaded());
      // 顶部控件必须可点：拖动区（-webkit-app-region: drag）会吞掉子元素点击，控件要显式 no-drag
      const labCtrl = await labW.webContents.executeJavaScript(`window.__labControls()`).catch(() => null);
      ok(
        `T33 实验室顶部控件可点（no-drag）(${JSON.stringify(labCtrl)})`,
        !!labCtrl && ['live', 'refresh', 'apply', 'close'].every((k) => labCtrl[k] && labCtrl[k].clickable === true)
      );
      const probe33 = `(() => {
        const g = (id) => document.getElementById(id);
        const svg = (id) => document.getElementById(id + '-svg');
        const disp = (id) => { const s = svg(id); return s ? s.querySelectorAll('feDisplacementMap').length : 0; };
        return {
          bg: String((g('g-liquid') || {}).style ? g('g-liquid').style.backgroundImage || '' : '').slice(0, 20),
          bgState: (document.getElementById('bgState') || {}).textContent || '',
          cards: document.querySelectorAll('.card').length,
          fCapture: (g('g-capture') ? g('g-capture').style.filter || '' : '').slice(0, 30),
          fLiquid: (g('g-liquid') ? g('g-liquid').style.filter || '' : '').slice(0, 30),
          dispLiquid: disp('lab-liquid'), dispAb2: disp('lab-ab2'), dispAb5: disp('lab-ab5'),
        };
      })()`;
      let labInfo = null;
      const dl33b = Date.now() + 22000;
      while (Date.now() < dl33b) {
        labInfo = await labW.webContents.executeJavaScript(probe33).catch((e) => ({ err: String((e && e.message) || e) }));
        if (labInfo && /data:image/.test(labInfo.bg || '') && labInfo.dispAb2 >= 3) break;
        await sleep(500);
      }
      ok(
        `T33 四张对照卡 + 隐藏取屏 (卡片=${labInfo && labInfo.cards} 背景=${/data:image/.test((labInfo && labInfo.bg) || '')} ${JSON.stringify((labInfo && labInfo.bgState) || '').slice(0, 34)}；真实模糊=${labInfo && labInfo.fCapture}；液态=${labInfo && labInfo.fLiquid}；位移次数 现状=${labInfo && labInfo.dispLiquid}/色散2=${labInfo && labInfo.dispAb2}/色散5=${labInfo && labInfo.dispAb5})`,
        !!labInfo && labInfo.cards === 4 && /data:image/.test(labInfo.bg || '') && /blur/.test(labInfo.fCapture || '') && /取屏时窗口已隐藏/.test(labInfo.bgState || '') && labInfo.dispLiquid === 1 && labInfo.dispAb2 === 3 && labInfo.dispAb5 === 3
      );
      // 色散=0 → 回到单次位移（= 与现状完全同一条滤镜链，可随时关掉）
      await labW.webContents.executeJavaScript(`(() => { const a = document.getElementById('aberration'); a.value = '0'; a.dispatchEvent(new Event('input')); return true; })()`).catch(() => false);
      await sleep(1300);
      const ab0 = await labW.webContents.executeJavaScript(`(() => { const s = document.getElementById('lab-ab2-svg'); return { disp: s ? s.querySelectorAll('feDisplacementMap').length : 0, filter: (document.getElementById('g-ab2').style.filter || '').slice(0, 20) }; })()`).catch((e) => ({ err: String((e && e.message) || e) }));
      ok(`T33 色散=0 回到现状同一条滤镜链 (位移次数=${ab0 && ab0.disp} filter=${ab0 && ab0.filter})`, !!ab0 && ab0.disp === 1 && /lab-ab2/.test(ab0.filter || ''));
      // 参数写回设置（实验室 → 小岛）
      const uiKeep33 = settings.load().ui.glassMode;
      const applied33 = lab33.applyParams({ maxRefract: 9, refractWidth: 26, bleedOpacity: 60, glow: 130, aberration: 3 });
      const ui33 = settings.load().ui;
      ok(
        `T33 参数写回设置 (折射=${ui33.maxRefract} 带宽=${ui33.refractWidth} 渗色=${ui33.bleedOpacity} 高光=${ui33.glassGlow} 色散=${ui33.glassAberration})`,
        !!ui33 && ui33.maxRefract === 9 && ui33.refractWidth === 26 && ui33.bleedOpacity === 60 && ui33.glassGlow === 130 && ui33.glassAberration === 3 && !!applied33
      );
      // 小岛真的用上了这组参数：液态模式下岛滤镜出现色散链（3 次位移），关掉色散回到 1 次
      // 注意：① 直接 settings.update 不走 config:update 的 applySettings，要显式通知岛
      //      ② 状态变化后渲染层会「等新截图到达」才重挂滤镜（glassWaiting）→ 轮询等它自己生效
      //         （这里不要自己去 captureOnce，那会抢掉岛自己排的那次截屏，反而一直等不到新图）
      settings.update({ ui: { glassMode: 'liquid' } });
      island.applySettings();
      island.manualState('expanded', 20000);
      let islAb33 = null;
      const dl33c = Date.now() + 10000;
      while (Date.now() < dl33c) {
        await sleep(500);
        islAb33 = await island.win.webContents.executeJavaScript(`(() => {
          const s = document.getElementById('lg-svg');
          return {
            svg: !!s, disp: s ? s.querySelectorAll('feDisplacementMap').length : 0,
            dataAb: s ? s.getAttribute('data-ab') : null,
            filter: (document.getElementById('glass').style.filter || '').slice(0, 20),
            rui: (typeof ui !== 'undefined' && ui) ? ui.glassAberration : 'n/a',
            glassState: document.body.dataset.glass || '',
            shown: (document.getElementById('glass').style.display || '') ,
          };
        })()`).catch((e) => ({ err: String((e && e.message) || e) }));
        if (islAb33 && islAb33.disp === 3) break;
      }
      ok(
        `T33 小岛用上色散参数 (glassAberration=${settings.load().ui.glassAberration} 渲染层拿到=${islAb33 && islAb33.rui} data-ab=${islAb33 && islAb33.dataAb} 岛滤镜=${islAb33 && islAb33.filter} 位移次数=${islAb33 && islAb33.disp} 玻璃态=${islAb33 && islAb33.glassState} 显示=${islAb33 && islAb33.shown})`,
        !!islAb33 && islAb33.svg === true && islAb33.disp === 3 && /lg-filter/.test(islAb33.filter || '')
      );
      settings.update({ ui: { glassMode: uiKeep33, maxRefract: 0, refractWidth: 0, bleedOpacity: 70, glassGlow: 100, glassAberration: 0 } });
      island.applySettings();
      let islAb0 = null;
      const dl33d = Date.now() + 10000;
      while (Date.now() < dl33d) {
        await sleep(500);
        islAb0 = await island.win.webContents.executeJavaScript(`(() => { const s = document.getElementById('lg-svg'); return { disp: s ? s.querySelectorAll('feDisplacementMap').length : 0, dataAb: s ? s.getAttribute('data-ab') : null }; })()`).catch(() => null);
        if (islAb0 && islAb0.disp === 1) break;
      }
      ok(`T33 色散参数清零后小岛回到单次位移（与现状一致）(位移次数=${islAb0 && islAb0.disp} data-ab=${islAb0 && islAb0.dataAb})`, !!islAb0 && islAb0.disp === 1);
      // 新模式「液态玻璃·色散版」：CPU 链路 + 固定 2px 色散（不受 ui.glassAberration 影响）
      settings.update({ ui: { glassMode: 'liquid-ab', glassAberration: 0 } });
      island.applySettings();
      let islAbMode = null;
      const dl33e = Date.now() + 10000;
      while (Date.now() < dl33e) {
        await sleep(500);
        islAbMode = await island.win.webContents.executeJavaScript(`(() => { const s = document.getElementById('lg-svg'); return { mode: document.body.dataset.glass || '', disp: s ? s.querySelectorAll('feDisplacementMap').length : 0, dataAb: s ? s.getAttribute('data-ab') : null }; })()`).catch(() => null);
        if (islAbMode && islAbMode.disp === 3) break;
      }
      ok(
        `T33 新模式「液态玻璃（色散版）」= CPU 链路 + 固定色散 (模式=${islAbMode && islAbMode.mode} 位移次数=${islAbMode && islAbMode.disp} data-ab=${islAbMode && islAbMode.dataAb}，设置里色散=${settings.load().ui.glassAberration})`,
        !!islAbMode && islAbMode.mode === 'liquid-ab' && islAbMode.disp === 3 && islAbMode.dataAb !== '0'
      );
      settings.update({ ui: { glassMode: uiKeep33 } });
      island.applySettings();
      await sleep(600);
      lab33.close();
      await sleep(300);

      // —— T34 计时坞 + 节假日倒计时 + 盖板联动 + 角落卡片移除 ——
      const hd34 = require('./holiday');
      const now34 = new Date(2026, 8, 23, 10, 0, 0); // 2026-09-23
      const items34 = [
        { name: '国庆节', date: '2026-10-01' },   // 8 天后
        { name: '元旦', date: '2027-01-01' },     // 100 天后
        { name: '去年的节', date: '2025-01-01' }, // 已过
      ];
      const nx34 = hd34.nextHoliday(items34, now34);
      const due34a = hd34.dueHoliday({ holidays: { enabled: true, leadDays: 30, items: items34 } }, now34);
      const due34b = hd34.dueHoliday({ holidays: { enabled: true, leadDays: 5, items: items34 } }, now34);
      const due34c = hd34.dueHoliday({ holidays: { enabled: false, leadDays: 30, items: items34 } }, now34);
      const txt34 = hd34.dockText(due34a);
      ok(
        `T34 节假日挑选与窗口期 (下一个=${nx34 && nx34.name}/${nx34 && nx34.days}天；窗口30天→${due34a && due34a.name}；窗口5天→${due34b}；未启用→${due34c}；文案=${JSON.stringify(txt34)})`,
        !!nx34 && nx34.name === '国庆节' && nx34.days === 8 &&
          !!due34a && due34a.name === '国庆节' && due34b === null && due34c === null &&
          txt34.title === '距离 国庆节' && txt34.num === '8' && txt34.unit === '天' && txt34.date === '2026-10-01'
      );
      // 手动「计时坞」模式：状态机与渲染层
      const modeKeep34 = settings.load().manual.mode;
      const hdKeep34 = JSON.parse(JSON.stringify(settings.load().holidays || {}));
      settings.update({ holidays: { enabled: true, leadDays: 30, items: items34 } });
      island.applySettings();
      await sleep(1400); // 等动画结束
      island.tick(); // 算 dockOn
      const dockState34 = island.decideState({
        idleMs: 0, occluded: false, maximized: false, overPill: false, mode: 'auto', smart: true, hideOnMaximized: true,
        expandIdleSec: 4, zoomIdleSec: 0, zoomAllowed: true, zoomCooldown: false, holding: false, hasCountdown: true,
        state: 'strip', dockOn: island.dockOn,
      });
      settings.update({ manual: { mode: 'dock' } });
      island.applySettings();
      await sleep(1500);   // 等几何动画结束：tick 在 animating 期间会直接返回
      island.lastAutoSwitch = 0; // 清掉自动切换去抖（否则 1 秒内不会进新状态）
      island.tick();
      await sleep(600);
      // 渲染层单独验证：直接切到计时坞形态（自动/手动时序已经在上一行 tick 里断言过 dockOn 置位）
      island.manualState('dock', 20000);
      await sleep(1200);
      const dockDom34 = await island.win.webContents.executeJavaScript(`(() => {
        const w = document.querySelector('.dk-wrap');
        const n = document.querySelector('.dk-num');
        const p = document.getElementById('pill');
        return { state: document.body.dataset.state, hasWrap: !!w, num: n ? n.textContent : '', title: (document.querySelector('.dk-title') || {}).textContent || '', pillBg: p ? getComputedStyle(p).backgroundColor : '', radius: p ? getComputedStyle(p).borderRadius : '' };
      })()`);
      ok(
        `T34 计时坞形态（黑底白字，效果同通知）(状态机=${dockState34} 节假日到点置位 dockOn=${island.dockOn} 渲染层=${dockDom34.state} 标题=${JSON.stringify(dockDom34.title)} 数字=${JSON.stringify(dockDom34.num)} 底=${dockDom34.pillBg} 圆角=${dockDom34.radius})`,
        dockState34 === 'dock' && island.dockOn === true &&
          dockDom34.state === 'dock' && dockDom34.hasWrap === true &&
          /国庆节/.test(dockDom34.title) && dockDom34.num === '8' && /rgb\(0, 0, 0\)/.test(dockDom34.pillBg)
      );
      // 盖板联动：大窗口展开时盖板不显示任何内容；收回细条内容回来
      settings.update({ manual: { mode: 'auto' }, ui: { cameraNotch: { enabled: true, preset: 'center', text: { template: '还有 {days}{unit}', size: 12 } } }, weather: { enabled: true, showInIsland: 'always', pos: 'cover' } });
      island.applySettings();
      island.manualState('zoom', 20000);
      await sleep(1200);
      const coverZoom34 = island.coverContent();
      island.manualState('strip', 0);
      await sleep(1000);
      const coverStrip34 = island.coverContent();
      ok(
        `T34 盖板联动：大窗口展开时盖板无内容 (大窗口=${JSON.stringify({ text: coverZoom34.text, weather: coverZoom34.weather })}；收回细条后=${JSON.stringify({ text: coverStrip34.text.slice(0, 12), hasWeather: !!coverStrip34.weather })})`,
        coverZoom34.text === '' && coverZoom34.weather === null && (coverStrip34.text.length > 0 || !!coverStrip34.weather)
      );
      // 角落卡片已去掉：状态机不再返回 corner、PILL 里没有它、配置页也没有该选项
      config.open();
      let cfgWin34 = null;
      const dl34c = Date.now() + 8000;
      while (Date.now() < dl34c) {
        cfgWin34 = config.getWindow();
        if (cfgWin34 && !cfgWin34.webContents.isLoading()) {
          const ready34 = await cfgWin34.webContents.executeJavaScript(`!!document.getElementById('hdEnabled')`).catch(() => false);
          if (ready34) break;
        }
        await sleep(150);
      }
      const cfgDom34 = cfgWin34
        ? await cfgWin34.webContents.executeJavaScript(`(() => ({
            cornerOpt: !!document.querySelector('option[value="corner"]'),
            dockRadio: !!document.querySelector('input[name="manualMode"][value="dock"]'),
            hdEnabled: !!document.getElementById('hdEnabled'),
            hdList: !!document.getElementById('hd-list'),
            hdTab: !!document.querySelector('#tabs .tab[data-tab="holiday"]'),
            manualModes: Array.from(document.querySelectorAll('input[name="manualMode"]')).map((i) => i.value),
          }))()`)
        : null;
      ok(
        `T34 角落卡片已去掉 + 配置页新增计时坞/节假日 (corner 选项=${cfgDom34 && cfgDom34.cornerOpt} 计时坞单选=${cfgDom34 && cfgDom34.dockRadio} 节假日开关=${cfgDom34 && cfgDom34.hdEnabled} 列表=${cfgDom34 && cfgDom34.hdList} 分类页=${cfgDom34 && cfgDom34.hdTab} 手动模式=${JSON.stringify(cfgDom34 && cfgDom34.manualModes)}；迁移 corner→${settings.migrateFullscreenMode({ hideOnFullscreen: false, fullscreenMode: 'corner' }, { fullscreenMode: 'corner' }) ? 'x' : 'strip'}）`,
        !!cfgDom34 && cfgDom34.cornerOpt === false && cfgDom34.dockRadio === true && cfgDom34.hdEnabled && cfgDom34.hdList && cfgDom34.hdTab &&
          (cfgDom34.manualModes || []).includes('dock') &&
          // 旧配置里的 corner 会被迁移掉（用户入口已移除；内部状态仅供几何自检）
          settings.load().smart.fullscreenState !== 'corner'
      );
      settings.update({ manual: { mode: modeKeep34 }, holidays: hdKeep34 });
      island.applySettings();
      await sleep(300);

      const failed = results.some(([c]) => !c);
      const verdict = failed ? 'TEST_FAIL' : 'TEST_OK';
      console.log(verdict);
      // 便携版（NSIS 包装）拿不到控制台输出：结论也写进日志，读文件即可判定
      try {
        fs.appendFileSync(testLog, `[test] ${verdict} total=${results.length} failed=${results.filter(([c]) => !c).length}\n`, 'utf8');
      } catch (e) {
        /* ignore */
      }
      app.exit(failed ? 1 : 0);
    } catch (e) {
      const msg = e && e.stack ? e.stack : String(e);
      console.error('TEST_ERROR', msg);
      // 自检异常也必须落盘：GUI 子系统进程的 stdout 在部分启动方式下拿不到
      try {
        fs.appendFileSync(testLog, `[test] ERROR ${msg}\n[test] TEST_ERROR\n`, 'utf8');
      } catch (err) {
        /* ignore */
      }
      app.exit(1);
    }
  })();
}
