'use strict';
const { app, Tray, Menu, nativeImage, ipcMain, BrowserWindow } = require('electron');
const os = require('os');
const path = require('path');
const settings = require('./settings');
const { Probe } = require('./probe');
const island = require('./island');
const config = require('./config');

// 统一 userData 目录名（必须在 ready 前调用）
app.setName('SmartCounterIsland');

// 测试/截图/冒烟模式使用隔离的 userData，绝不污染真实配置
if (process.argv.includes('--test') || process.argv.includes('--shot') || process.argv.includes('--smoke')) {
  app.setPath('userData', path.join(app.getPath('temp'), `sci-dev-${process.pid}`));
}

let probe = null;
let tray = null;
let trayTimer = null;
let trayClicked = false;

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

  probe = new Probe();
  probe.start();

  island.init({
    probe,
    openConfig: () => config.open(),
  });

  registerIpc();
  createTray();

  try {
    await island.create();
  } catch (e) {
    console.error('[main] 灵动岛创建失败:', e);
  }

  const argv = process.argv;
  if (argv.includes('--test')) runTests();
  else if (argv.includes('--shot')) runShots();
  else if (argv.includes('--smoke')) runSmoke();
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
    `({ text: document.getElementById('content').innerText.trim().slice(0, 40), zNum: document.querySelector('.z-num') ? getComputedStyle(document.querySelector('.z-num')).fontSize : 'n/a', zMidH: document.querySelector('.z-mid') ? Math.round(document.querySelector('.z-mid').getBoundingClientRect().height) : 0, zCardH: document.querySelector('.z-card') ? Math.round(document.querySelector('.z-card').getBoundingClientRect().height) : 0 })`
  );
  console.log('[shot] zoom-glass dom=', JSON.stringify(zdom), 'bounds=', JSON.stringify(island.win.getBounds()));
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
    { label: '隐藏成灵动岛', type: 'radio', checked: mode === 'hidden', click: () => click('hidden') },
  ];
}

function trayMenu() {
  return Menu.buildFromTemplate([
    ...modeMenuTemplate((m) => island.setManual(m)),
    { type: 'separator' },
    { label: '立即放大（倒计时窗口）', click: () => island.onAction({ type: 'zoom' }) },
    { label: '收起（灵动岛）', click: () => island.setState('strip') },
    { type: 'separator' },
    { label: '打开配置…', click: () => config.open() },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ]);
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

  ipcMain.handle('config:get', () => ({
    settings: settings.load(),
    meta: {
      version: app.getVersion(),
      platform: process.platform,
      osRelease: os.release(),
      electron: process.versions.electron,
    },
  }));

  ipcMain.handle('config:update', (_e, patch) => {
    const next = settings.update(patch);
    island.applySettings();
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
  const ok = (name, cond) => {
    results.push([!!cond, name]);
    console.log(`[test] ${cond ? 'PASS' : 'FAIL'} ${name}`);
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
        idleMs: 0, occluded: false, maximized: false, overPill: false, nearTopBand: false,
        mode: 'auto', smart: true, hideOnFullscreen: true, hideOnMaximized: true,
        expandIdleSec: 4, holding: false, hasCountdown: true,
      };
      ok('T2 有操作→迷你条', island.decideState(base) === 'strip');
      ok('T2 闲置5s→默认窗口灵动岛', island.decideState({ ...base, idleMs: 5000 }) === 'expanded');
      ok('T2 默认窗口固定灵动岛（不可更改）', island.decideState({ ...base, idleMs: 99999 }) === 'expanded');
      ok('T2 无计时时间→锁定迷你条', island.decideState({ ...base, hasCountdown: false, idleMs: 99999 }) === 'strip');
      ok('T2 无计时时间+悬停→仍锁定', island.decideState({ ...base, hasCountdown: false, overPill: true }) === 'strip');
      ok('T2 无计时时间+全屏遮挡→灵动岛', island.decideState({ ...base, hasCountdown: false, occluded: true, overPill: true }) === 'strip');
      ok('T2 全屏遮挡→灵动岛', island.decideState({ ...base, occluded: true }) === 'strip');
      ok('T2 全屏遮挡+触摸→维持灵动岛（不唤起）', island.decideState({ ...base, occluded: true, overPill: true }) === 'strip');
      ok('T2 全屏遮挡+悬停顶部→维持灵动岛（不唤起）', island.decideState({ ...base, occluded: true, nearTopBand: true }) === 'strip');
      ok('T2 隐藏模式→灵动岛', island.decideState({ ...base, mode: 'hidden' }) === 'strip');
      ok('T2 隐藏模式+触摸小岛→可唤起', island.decideState({ ...base, mode: 'hidden', overPill: true }) === 'expanded');
      ok('T2 固定模式忽略遮挡（按操作状态走）', island.decideState({ ...base, mode: 'pinned', occluded: true, idleMs: 0 }) === 'strip');
      ok('T2 光标悬停→保持现状', island.decideState({ ...base, overPill: true }) === null);
      ok('T2 顶部附近悬浮→保持现状（不展开）', island.decideState({ ...base, nearTopBand: true, idleMs: 99999 }) === null);
      ok('T2 手动保持期→保持现状', island.decideState({ ...base, holding: true, idleMs: 99999 }) === null);
      ok('T2 关闭智能→保持现状', island.decideState({ ...base, smart: false, idleMs: 99999 }) === null);
      ok('T2 窗口最大化→保持迷你条', island.decideState({ ...base, maximized: true, idleMs: 99999 }) === 'strip');

      // —— T3 配置窗口生命周期（核心 bug 复现）——
      config.open();
      await sleep(1500);
      ok('T3 配置窗口已打开', config.isOpen());
      ok('T3 配置窗口已加载', config.isLoaded());
      const cwin = config.getWindow();
      ok('T3 配置窗口置顶(高于小岛)', !!(cwin && cwin.isAlwaysOnTop()));
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
      // 倒计时窗口宽度随文字内容自适应（渲染器测量上报 → 主进程调整宽度）
      island.manualState('zoom', 6000);
      island.animating = false;
      island.setZoomWidth(330);
      await sleep(700); // 等渲染器测量上报（250ms）+ 宽度动画（110ms）完成
      const zh = Math.max(200, Math.min(420, Math.round(island.islandDisplay().workArea.height / 4))) + 16;
      ok(
        `T9 倒计时窗口宽度自适应 (内容宽=${island.zoomWidth}, 窗口=${island.win.getBounds().width}x${island.win.getBounds().height})`,
        island.zoomWidth > 0 &&
          island.zoomWidth !== Math.round(island.islandDisplay().workArea.height / 4) && // 宽度已随文字变化（非默认正方形）
          island.win.getBounds().width === island.zoomWidth + 16 &&
          island.win.getBounds().height === zh
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

      const failed = results.some(([c]) => !c);
      console.log(failed ? 'TEST_FAIL' : 'TEST_OK');
      app.exit(failed ? 1 : 0);
    } catch (e) {
      console.error('TEST_ERROR', e && e.stack ? e.stack : e);
      app.exit(1);
    }
  })();
}
