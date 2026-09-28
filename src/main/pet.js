'use strict';
/* 教学助手：独立透明「舞台窗口」+ 窗口内自由走动（60fps）+ 逐像素命中 + 说话气泡 + AI 问答。
   设计要点（都来自 spike 的实测结论）：
     - 不要逐帧 setBounds（实测 1.4–2.7ms/次、只能跑到 ~21/32 fps）：改成舞台窗口，
       教学助手在窗口内部自由移动，只有走到舞台边缘才整窗平移一格（约 1 次/秒）
     - 透明区域必须鼠标穿透：1/2 分辨率遮罩画布读 alpha → setIgnoreMouseEvents 只在状态翻转时调用
     - 授课/全屏时彻底隐藏（沿用 island 的全屏判定），上课时间静默站立、不闲聊
     - AI 永不开启思考模式（见 ai.js），未填 key / 断网 / 超配额自动降级到老师预置问答 */

const { BrowserWindow, screen, ipcMain, app, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const brain = require('./pet-brain');
const ai = require('./ai');
const scheduleMod = require('./schedule');
const petPack = require('./pet-pack');

const DEFAULT_STAGE = { w: 360, h: 300 };

class Pet {
  constructor(settings, probe) {
    this.settings = settings;
    this.probe = probe;
    this.win = null;
    this.ready = false;
    this.enabled = false;
    this.visible = false;
    this.env = { fullscreen: false, inClass: false, dnd: false };
    this.action = 'idle';
    this.dir = 1;
    this.talking = false;
    this.sinceInteract = Date.now();
    this.quota = { minuteKey: '', minuteCount: 0, dayKey: '', dayCount: 0 };
    this.cache = new Map(); // key -> { text, at }
    this.busy = false;
    this.lastError = '';
    this.stats = { asks: 0, aiCalls: 0, presetHits: 0, refused: 0, errors: 0, firstMs: [], totalMs: [] };
    this.logFile = () => path.join(require('electron').app.getPath('userData'), 'pet-ai-log.jsonl');
  }

  // ---------------- 配置 ----------------

  cfg() {
    const st = this.settings.load();
    const p = st.pet || {};
    return {
      enabled: p.enabled === true,
      stage: { w: Math.max(200, Math.min(800, (p.stage && p.stage.w) || DEFAULT_STAGE.w)), h: Math.max(160, Math.min(800, (p.stage && p.stage.h) || DEFAULT_STAGE.h)) },
      scale: Math.max(0.5, Math.min(2, (typeof p.scale === 'number' ? p.scale : 100) / 100)),
      opacity: Math.max(0.2, Math.min(1, typeof p.opacity === 'number' ? p.opacity : 0.95)),
      speed: Math.max(0.2, Math.min(4, typeof p.speed === 'number' ? p.speed : 1)),
      pos: { x: p.x, y: p.y },
      hideOnFullscreen: p.hideOnFullscreen !== false,
      quietInClass: p.quietInClass !== false,
      ai: ai.normalizeConfig(p.ai || {}),
      qa: Array.isArray(p.qa) ? p.qa : [],
      pack: String(p.pack || '').trim(), // 素材包目录（留空 = 默认目录 <userData>/pets/示例）
      guard: { maxChars: (p.guard && p.guard.maxChars) || 120, blocked: (p.guard && p.guard.blocked) || [] },
      announceClass: p.announceClass !== false,
    };
  }

  /** 素材包目录（留空用默认目录） */
  packDir() {
    const c = this.cfg();
    return c.pack || petPack.defaultPackDir(app.getPath('userData'));
  }

  /** 读取素材包并推给渲染层；返回状态（配置页显示用） */
  loadPack(forceSample) {
    const dir = this.packDir();
    if (forceSample) petPack.ensureSamplePack(dir);
    let payload;
    try {
      payload = petPack.packToPayload(dir);
    } catch (e) {
      payload = { ok: false, reason: String((e && e.message) || e), errors: [], dir };
    }
    this.packState = { dir, ok: !!payload.ok, summary: payload.summary || '', errors: payload.errors || [], reason: payload.reason || '', name: payload.name || '' };
    this.send('pet:pack', payload);
    return this.packState;
  }

  /** 应用设置变化：启用/禁用、尺寸、透明度 */
  applySettings() {
    const c = this.cfg();
    this.enabled = c.enabled;
    if (!c.enabled) {
      this.setVisible(false);
      return;
    }
    const win = this.ensureWindow();
    if (!win) return;
    // 自检/截图等安静模式下必须保持不可见（直接 setOpacity 会把 quiet 的 0 覆盖掉）
    require('./quiet').setOpacity(win, c.opacity);
    const b = win.getBounds();
    if (b.width !== c.stage.w || b.height !== c.stage.h) {
      win.setBounds({ x: b.x, y: b.y, width: c.stage.w, height: c.stage.h });
    }
    this.send('pet:config', { scale: c.scale, speed: c.speed });
    this.loadPack(); // 素材包（没有就回落内置占位小人）
    this.setVisible(true);
  }

  // ---------------- 窗口 ----------------

  ensureWindow() {
    if (this.win && !this.win.isDestroyed()) return this.win;
    const c = this.cfg();
    const d = screen.getPrimaryDisplay();
    const wa = d.workArea;
    const defX = Math.round(wa.x + wa.width - c.stage.w - 24); // 默认右下角，不压任务栏
    const defY = Math.round(wa.y + wa.height - c.stage.h - 8);
    const x = Number.isFinite(c.pos.x) ? Math.max(wa.x - c.stage.w + 80, Math.min(c.pos.x, wa.x + wa.width - 80)) : defX;
    const y = Number.isFinite(c.pos.y) ? Math.max(wa.y, Math.min(c.pos.y, wa.y + wa.height - 60)) : defY;
    const win = require('./quiet').quiet(new BrowserWindow({
      width: c.stage.w,
      height: c.stage.h,
      x,
      y,
      frame: false,
      transparent: true,
      resizable: false,
      maximizable: false,
      minimizable: false,
      skipTaskbar: true,
      hasShadow: false,
      focusable: true,
      show: false,
      backgroundColor: '#00000000',
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload', 'pet-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
      },
    }));
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setIgnoreMouseEvents(true, { forward: true }); // 默认穿透，指针落在教学助手身上才可点
    win.loadFile(path.join(__dirname, '..', 'renderer', 'pet', 'index.html'));
    win.webContents.on('did-finish-load', () => {
      this.ready = true;
      this.applySettings();
      this.loadPack(); // 渲染层就绪后推一次素材包（applySettings 时可能还没加载完）
      // 排除自身截屏：否则小岛的玻璃会把教学助手当成桌面内容拍进去（重影）
      try {
        const buf = win.getNativeWindowHandle();
        const hwnd = buf.readBigUInt64LE ? buf.readBigUInt64LE(0).toString() : String(buf.readUInt32LE(0));
        if (this.probe && this.probe.setExcludeFromCapture) this.probe.setExcludeFromCapture(hwnd);
      } catch (e) {
        /* ignore */
      }
    });
    win.on('closed', () => {
      this.win = null;
      this.ready = false;
      this.visible = false;
    });
    this.win = win;
    return win;
  }

  setVisible(v) {
    const win = this.win;
    if (!win || win.isDestroyed()) {
      if (v) this.ensureWindow();
      return;
    }
    if (v && !win.isVisible()) {
      win.showInactive();
      this.nudgePaint(); // 软件合成下不重绘就不上屏
      this.visible = true;
    } else if (!v && win.isVisible()) {
      win.hide();
      this.visible = false;
    }
  }

  send(channel, payload) {
    if (!this.win || this.win.isDestroyed() || !this.ready) return;
    try {
      this.win.webContents.send(channel, payload);
    } catch (e) {
      /* ignore */
    }
  }

  /** 主进程把舞台窗口在屏幕坐标上平移（拖动 / 走到边缘时用），并记住位置。
      返回实际位移 dx/dy —— 贴到工作区边缘时会被夹住，渲染层必须按**实际值**补偿自身坐标，
      否则它会以为窗口移了 120px 而回退 120px → 到屏幕边缘就来回抽搐。
      位置写盘做防抖：走路每 1-2 秒就平移一次，逐次写设置既费磁盘又没意义。 */
  moveStage(dx, dy) {
    const win = this.win;
    if (!win || win.isDestroyed()) return { ok: false };
    const b = win.getBounds();
    // 多显示器：按窗口当前所在的那块屏算工作区（曾经固定用主屏 → 副屏上的教学助手会被拉回主屏）
    let wa;
    try {
      wa = screen.getDisplayMatching(b).workArea;
    } catch (e) {
      wa = screen.getPrimaryDisplay().workArea;
    }
    const nx = Math.round(Math.max(wa.x - b.width + 60, Math.min(b.x + (dx || 0), wa.x + wa.width - 60)));
    const ny = Math.round(Math.max(wa.y, Math.min(b.y + (dy || 0), wa.y + wa.height - 40)));
    const adx = nx - b.x;
    const ady = ny - b.y;
    if (adx || ady) {
      win.setBounds({ x: nx, y: ny, width: b.width, height: b.height });
      this.savePosSoon(nx, ny);
    }
    return { ok: true, x: nx, y: ny, dx: adx, dy: ady, moved: !!(adx || ady) };
  }

  /** 位置写盘防抖：连续平移只在停稳 1.2 秒后写一次（退出时由 flushPos 兜底） */
  savePosSoon(x, y) {
    this._pendingPos = { x, y };
    if (this._posTimer) clearTimeout(this._posTimer);
    this._posTimer = setTimeout(() => {
      this._posTimer = null;
      this.flushPos();
    }, 1200);
    if (this._posTimer.unref) this._posTimer.unref();
  }

  /** 立刻把待写位置落盘（退出前 / 自检断言用） */
  flushPos() {
    const p = this._pendingPos;
    this._pendingPos = null;
    if (this._posTimer) {
      clearTimeout(this._posTimer);
      this._posTimer = null;
    }
    if (p) this.settings.update({ pet: { x: p.x, y: p.y } });
    return p || null;
  }

  // ---------------- 环境 / 行为 ----------------

  /** 由主进程每秒喂一次：全屏授课 / 上课中 / 免打扰（直接调用方式，测试可用） */
  setEnvironment(env) {
    this.env = Object.assign({}, this.env, env || {});
  }

  /** 环境来源函数（main.js 注入：由 island 全屏判定 + 时间表推导）；测试可替换以固定环境 */
  readEnv() {
    if (typeof this.envSource === 'function') {
      try {
        this.env = Object.assign({}, this.env, this.envSource() || {});
      } catch (e) {
        /* ignore */
      }
    }
    return this.env;
  }

  /** 现在是否处于上课时间（行为静默、闲聊被拒） */
  inClassNow() {
    const c = this.cfg();
    return !!(c.quietInClass && this.env.inClass);
  }

  /** 环境是否要求隐藏教学助手 */
  shouldHide() {
    const c = this.cfg();
    if (!c.enabled) return true;
    if (c.hideOnFullscreen && this.env.fullscreen) return true;
    return false;
  }

  /** 把窗口"上屏"：软件合成（GPU 被虚拟显示驱动顶掉）时，透明窗口 showInactive() 之后
      常常不呈现第一帧 —— 窗口 isVisible()=true、渲染层也真画了，屏幕上看不见。
      对照实验（2026-09-27，四角四种配置）：show:true 可见、每 0.4s invalidate() 也可见。
      这里 invalidate + 轻微抖一次 opacity（强制分层窗口重新合成，肉眼不可见）。 */
  nudgePaint() {
    const poke = () => {
      if (!this.win || this.win.isDestroyed()) return;
      try { this.win.webContents.invalidate(); } catch (e) { /* ignore */ }
      try { const o = this.win.getOpacity(); this.win.setOpacity(Math.max(0.05, o - 0.002)); this.win.setOpacity(o); } catch (e) { /* ignore */ }
    };
    poke();
    setTimeout(poke, 250);
    setTimeout(poke, 1200);
    clearInterval(this._paintTick);
    this._paintTick = setInterval(() => {
      if (!this.win || this.win.isDestroyed() || !this.win.isVisible()) { clearInterval(this._paintTick); this._paintTick = null; return; }
      poke();
    }, 2000);
  }

  /** 把舞台窗口搬到"教学助手正好落在锚点上"：窗口中心对准锚点 x，脚底留 ~130px。
      小岛贴在屏幕顶部、舞台默认在右下角 —— 不搬窗口它根本走不到锚点（舞台只有 360×300）。 */

  /** 把舞台窗口搬到「教学助手正好落在锚点上」：窗口中心对准锚点 x，脚底留 ~130px。
      小岛贴在屏幕顶部、舞台默认在右下角 —— 不搬窗口它根本走不到锚点（舞台只有 360×300）。 */
  /** 现在想不想趴到小岛倒计时上（每拍问一次）：有锚点 + 开关开 + 到点了 → 顺手把舞台搬过去 */
  perchWanted() {
    const a = typeof this.perchSource === 'function' ? this.perchSource() : null;
    this._perchAnchor = a;
    const pc = this.cfg().perch || {};
    const now = Date.now();
    if (!a || pc.enabled === false) return false;
    if (now >= (this.perchAskUntil || 0) && now < (this.nextPerchAt || 0)) return false;
    this.perchAskUntil = 0;
    this.nextPerchAt = now + Math.max(30, Number(pc.autoSec) || 120) * 1000;
    this.alignStageForPerch(a);
    return true;
  }

  alignStageForPerch(a) {
    if (!a || !this.win || this.win.isDestroyed()) return;
    const b = this.win.getBounds();
    const dx = Math.round(a.x - b.width / 2 - b.x);
    const dy = Math.round(a.y - 130 - b.y);
    if (dx || dy) this.moveStage(dx, dy);
  }

  /** 行为节奏：安静档权重（课堂不抢注意力）+ 睡觉门槛；可在设置里覆盖 */
  brainCfg() {
    const b = this.cfg().behavior || {};
    return {
      sleepSec: Number(b.sleepSec) || 300,
      weights: b.weights && typeof b.weights === 'object' ? b.weights : undefined,
    };
  }

  /** 行为拍：算出现在该做什么，交给渲染层执行 */
  tick() {
    const c = this.cfg();
    if (!c.enabled) {
      this.setVisible(false);
      return null;
    }
    this.readEnv();
    if (this.shouldHide()) {
      this.setVisible(false);
      return { action: 'hidden' };
    }
    this.setVisible(true);
    const now = Date.now();
    const inClass = this.inClassNow();
    // 带状态的决策：until 之前保持同一行为（旧版每秒重掷 → 看着乱动、忽左忽右）
    const decided = brain.nextAction(
      {
        now, // 必须传：否则 until 会算成 0+时长，持续时长失效（见 pet-brain 注释）
        hidden: false,
        fullscreen: false,
        inClass,
        talking: this.talking,
        sinceInteractMs: now - this.sinceInteract,
        seed: Math.floor(now / 1000),
        perch: this.perchWanted(), // 趴到小岛倒计时上（有锚点 + 到点了才想上去）
        cfg: this.brainCfg(),
      },
      this.brainState
    );
    this.brainState = { action: decided.action, dir: decided.dir, until: decided.until };
    this.action = decided.action;
    this.dir = decided.dir || this.dir;
    this.send('pet:state', {
      action: this.action,
      dir: this.dir,
      inClass: !!inClass,
      dnd: !!this.env.dnd,
      // 趴着时把锚点一起发下去（数字每秒变宽窄、小岛会移动 → 渲染层平滑跟随）
      perch: decided.action === 'perch' && this._perchAnchor ? { x: this._perchAnchor.x, y: this._perchAnchor.y } : null,
    });
    return decided;
  }

  // ---------------- 说话 ----------------

  /** 直接让教学助手说一句（气泡），用于课堂提醒 / 主动招呼 */
  say(text, opts) {
    const o = opts || {};
    const t = String(text || '').trim();
    if (!t) return;
    this.talking = true;
    this.sinceInteract = Date.now();
    this.send('pet:say', { text: t, alert: !!o.alert, meta: o.meta || '' });
    const holdMs = Math.min(9000, Math.max(1800, t.length * 110));
    clearTimeout(this._talkTimer);
    this._talkTimer = setTimeout(() => {
      this.talking = false;
    }, holdMs);
  }

  /** 上课铃/下课提醒：教学助手负责"露脸 + 说出来"，通知弹窗由 island 负责 */
  announce(reminder) {
    const c = this.cfg();
    if (!c.announceClass) return;
    if (this.shouldHide()) return; // 全屏授课时不打扰
    this.say(reminder.body || reminder.title, { alert: true, meta: '课堂提醒' });
  }

  // ---------------- 问答 ----------------

  /** 组装当前班级上下文（系统提示用） */
  buildContext() {
    this.readEnv();
    const now = new Date();
    const st = this.settings.load();
    const p2 = (n) => String(n).padStart(2, '0');
    const cur = scheduleMod.periodAt(st.schedule, now);
    const nxt = scheduleMod.nextPeriod(st.schedule, now);
    const ev = (st.events || []).filter((e) => e.enabled !== false).map((e) => ({ e, ms: new Date(e.date).getTime() - Date.now() })).filter((x) => x.ms > 0).sort((a, b) => a.ms - b.ms)[0];
    return {
      now: `${p2(now.getHours())}:${p2(now.getMinutes())}`,
      currentClass: cur ? scheduleMod.periodLabel(cur.index, cur.period.name) : '',
      nextClass: nxt ? scheduleMod.periodLabel(nxt.index, nxt.period.name) : '',
      nextInMin: nxt && !nxt.isTomorrow ? Math.max(0, Math.round(nxt.startAt - (now.getHours() * 60 + now.getMinutes()))) : null,
      countdown: ev ? `${ev.e.name} 还有 ${Math.max(0, Math.ceil(ev.ms / 86400000))} 天` : '',
      inClass: this.inClassNow(),
      extra: (st.pet && st.pet.ai && st.pet.ai.persona) || '',
    };
  }

  /** 问答主入口：护栏 → 预置 → AI（带配额/缓存）→ 护栏 → 气泡 + 朗读 */
  async ask(question) {
    this.stats.asks += 1;
    this.sinceInteract = Date.now();
    const c = this.cfg();
    const ctx = this.buildContext();
    const dayKey = ai.timeKeys(new Date()).day;
    const gate = brain.canPetSpeak({
      inClass: this.inClassNow(),
      question,
      dnd: this.env.dnd,
      aiReady: !!(c.ai.enabled && c.ai.apiKey),
      presetOnly: c.ai.presetOnly,
      quotaLeftMin: Math.max(0, c.ai.perMinute - this.quota.minuteCount),
      quotaLeftDay: Math.max(0, c.ai.perDay - this.quota.dayCount),
    });
    if (!gate.allowed) {
      this.stats.refused += 1;
      this.say(gate.reason, { meta: gate.mode === 'quota' ? '额度' : '规则' });
      return { mode: gate.mode, reason: gate.reason };
    }
    // 1) 老师预置问答优先（离线可用、零成本）
    const preset = brain.pickPresetAnswer(question, c.qa);
    if (preset) {
      this.stats.presetHits += 1;
      const g = brain.guardAnswer(preset.answer, c.guard);
      this.say(g.text, { meta: '预置问答' });
      this.log({ q: question, a: g.text, mode: 'preset', hit: preset.hit });
      return { mode: 'preset', text: g.text };
    }
    if (gate.mode === 'preset') {
      this.say('这个问题我还答不上来，等联网了再问我，或者去问老师吧～', { meta: '离线' });
      return { mode: 'preset-miss' };
    }
    // 2) 缓存：同一个问题短时间内不重复花钱
    const key = ai.cacheKey(question, dayKey);
    const hit = c.ai.cacheMinutes > 0 ? this.cache.get(key) : null;
    if (hit && Date.now() - hit.at < c.ai.cacheMinutes * 60000) {
      this.say(hit.text, { meta: '刚回答过' });
      return { mode: 'cache', text: hit.text };
    }
    // 3) 配额
    const keys = ai.timeKeys(new Date());
    const q = ai.checkQuota(this.quota, c.ai, keys);
    if (!q.ok) {
      this.stats.refused += 1;
      this.say(q.reason === 'per-minute' ? '我问得太快啦，歇一分钟再问吧' : '今天的提问额度用完了，明天再来～', { meta: '额度' });
      return { mode: 'quota', reason: q.reason };
    }
    if (this.busy) {
      this.say('我正在回答上一个问题，稍等一下～', { meta: '排队' });
      return { mode: 'busy' };
    }
    this.busy = true;
    this.talking = true;
    this.send('pet:ask-start', { question });
    let streamed = '';
    try {
      this.quota = ai.bumpQuota(this.quota, keys);
      this.stats.aiCalls += 1;
      const r = await ai.askStream(question, ctx, c.ai, {
        onDelta: (d) => {
          streamed += d;
          this.send('pet:delta', d);
        },
      });
      if (!r.ok) {
        this.stats.errors += 1;
        this.lastError = r.error;
        this.send('pet:ask-end', { ok: false, error: r.error });
        this.say('我这边连不上网，先记下来等会儿再问我～', { meta: '连接失败' });
        this.log({ q: question, mode: 'error', error: r.error });
        return { mode: 'error', error: r.error };
      }
      const g = brain.guardAnswer(r.text, c.guard);
      this.stats.firstMs.push(r.firstMs);
      this.stats.totalMs.push(r.totalMs);
      this.cache.set(key, { text: g.text, at: Date.now() });
      this.send('pet:ask-end', { ok: true, text: g.text, firstMs: r.firstMs, totalMs: r.totalMs, truncated: !!g.truncated, servedModel: r.servedModel, reasoningLen: r.reasoningLen || 0 });
      if (r.reasoningLen) console.warn(`[pet] 本次返回了 ${r.reasoningLen} 字思考内容（thinking 未关闭？）`);
      this.log({ q: question, a: g.text, mode: 'ai', first: r.firstMs, total: r.totalMs, usage: r.usage, model: r.servedModel, blocked: g.blocked });
      const holdMs = Math.min(12000, Math.max(2500, g.text.length * 120));
      clearTimeout(this._talkTimer);
      this._talkTimer = setTimeout(() => {
        this.talking = false;
      }, holdMs);
      return { mode: 'ai', text: g.text, firstMs: r.firstMs, totalMs: r.totalMs };
    } finally {
      this.busy = false;
    }
  }

  log(entry) {
    try {
      fs.appendFileSync(this.logFile(), JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n', 'utf8');
    } catch (e) {
      /* ignore */
    }
  }

  /** 连接自检：验证 baseUrl/key/模型可用（不显示给客户端的回答内容） */
  async checkConnection() {
    const c = this.cfg();
    if (!c.ai.apiKey) return { ok: false, reason: '未填写 API Key' };
    try {
      const r = await ai.askStream('在吗', { now: '自检' }, { ...c.ai, maxTokens: 8 }, {});
      return r.ok ? { ok: true, model: r.servedModel, firstMs: r.firstMs, reasoningLen: r.reasoningLen || 0 } : { ok: false, reason: r.error };
    } catch (e) {
      return { ok: false, reason: String((e && e.message) || e) };
    }
  }

  statsView() {
    const avg = (a) => (a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : 0);
    return { ...this.stats, avgFirstMs: avg(this.stats.firstMs), avgTotalMs: avg(this.stats.totalMs), lastError: this.lastError };
  }

  destroy() {
    clearTimeout(this._talkTimer);
    this.flushPos(); // 退出前把最后位置落盘（否则防抖中的那次写入会丢）
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    this.win = null;
    this.ready = false;
    this.visible = false;
  }
}

/** 注册教学助手渲染层用到的 IPC（main.js 在启动时调用一次） */
function registerPetIpc(pet) {
  ipcMain.handle('pet:ask', async (_e, question) => pet.ask(String(question || '').slice(0, 200)));
  ipcMain.handle('pet:hit', (_e, over) => {
    const win = pet.win;
    if (win && !win.isDestroyed()) win.setIgnoreMouseEvents(!over, { forward: true });
    return true;
  });
  ipcMain.handle('pet:move', (_e, d) => pet.moveStage((d && d.dx) || 0, (d && d.dy) || 0));
  ipcMain.handle('pet:interact', () => {
    pet.sinceInteract = Date.now();
    return true;
  });
  ipcMain.handle('pet:env', () => pet.env);
  ipcMain.handle('pet:stats', () => pet.statsView());
  ipcMain.handle('pet:check', () => pet.checkConnection());
  ipcMain.handle('pet:say', (_e, text) => {
    pet.say(String(text || ''), {});
    return true;
  });
  // —— 素材包：状态 / 打开目录 / 生成示例 / 重新加载 / 选择目录 ——
  ipcMain.handle('pet:pack-status', () => pet.packState || pet.loadPack());
  ipcMain.handle('pet:pack-open', async () => {
    try {
      const dir = pet.packDir();
      fs.mkdirSync(dir, { recursive: true });
      const err = await shell.openPath(dir);
      return err ? { ok: false, reason: err, dir } : { ok: true, dir };
    } catch (e) {
      return { ok: false, reason: String((e && e.message) || e) };
    }
  });
  ipcMain.handle('pet:pack-sample', () => {
    const r = petPack.ensureSamplePack(pet.packDir());
    pet.loadPack();
    return { ok: true, ...r, state: pet.packState };
  });
  ipcMain.handle('pet:pack-reload', () => ({ ok: true, state: pet.loadPack() }));
  ipcMain.handle('pet:pack-pick', async () => {
    const r = await dialog.showOpenDialog({ title: '选择教学助手素材包目录（里面要有 pet.json）', properties: ['openDirectory'] });
    if (r.canceled || !r.filePaths.length) return { ok: false };
    pet.settings.update({ pet: { pack: r.filePaths[0] } });
    const state = pet.loadPack();
    return { ok: !!state.ok, dir: r.filePaths[0], state };
  });

  // —— 素材库：内置清单 + 按需下载 ——
  // 图集不随安装包发行（258 个共约 500MB，且有 33 个没标再分发许可），
  // 所以这里是「清单在包里、素材下到用户目录」，原因见 pet-library.js 顶部说明。
  const petLib = require('./pet-library');
  const libState = { busy: false, cancel: false, done: 0, total: 0, current: '', failed: [] };
  const userDataDir = () => app.getPath('userData');
  const libNotify = () => {
    const w = require('./config').getWindow();
    if (w && !w.isDestroyed()) w.webContents.send('pet:lib-progress', Object.assign({}, libState));
  };
  const libRows = () => {
    const c = petLib.readCatalog();
    const rows = petLib.mergeList(c, petLib.listLocal(userDataDir()));
    // 内置素材（随包发行的那一个）在列表里也要显示成"已装"，否则用户会以为还得下一遍
    const builtinDir = petPack.bundledDefaultPack();
    if (builtinDir) {
      const id = path.basename(builtinDir);
      for (const r of rows) {
        if (r.id !== id) continue;
        r.installed = true;
        r.builtin = true;
        if (!r.dir) r.dir = builtinDir;
      }
    }
    return { ok: true, source: c.source, generatedAt: c.generatedAt, count: c.count, rows, dir: petLib.petsDir(userDataDir()), busy: libState.busy, done: libState.done, total: libState.total, current: libState.current };
  };
  ipcMain.handle('pet:lib-list', () => libRows());
  ipcMain.handle('pet:lib-open', async () => {
    const dir = petLib.petsDir(userDataDir());
    fs.mkdirSync(dir, { recursive: true });
    const err = await shell.openPath(dir);
    return err ? { ok: false, reason: err, dir } : { ok: true, dir };
  });
  ipcMain.handle('pet:lib-use', (_e, id) => {
    const row = libRows().rows.find((x) => x.id === String(id || ''));
    if (!row || !row.dir) return { ok: false, reason: '这个素材还没下载' };
    // 点「使用」就是要用它：顺手把总开关打开（否则点了没反应）
    pet.settings.update({ pet: { pack: row.dir, enabled: true } });
    const state = pet.loadPack();
    return { ok: !!state.ok, dir: row.dir, state };
  });
  ipcMain.handle('pet:lib-download', async (_e, id) => {
    const c = petLib.readCatalog();
    const entry = c.pets.find((x) => x.id === String(id || ''));
    if (!entry) return { ok: false, reason: '清单里没有这个素材' };
    try {
      const r = await petLib.downloadOne(entry, userDataDir(), c.ref);
      pet.loadPack(); // 装完刷新（若正是当前用的那个，立刻生效）
      return Object.assign({ ok: true }, r);
    } catch (e) {
      return { ok: false, reason: String((e && e.message) || e).slice(0, 200) };
    }
  });
  ipcMain.handle('pet:lib-remove', (_e, id) => {
    const r = petLib.removeOne(userDataDir(), String(id || ''));
    if (r.ok && pet.cfg().pack === r.dir) pet.settings.update({ pet: { pack: '' } }); // 删的是当前素材 → 回落内置
    pet.loadPack();
    return r;
  });
  ipcMain.handle('pet:lib-cancel', () => {
    libState.cancel = true;
    return { ok: true };
  });
  ipcMain.handle('pet:lib-all', async () => {
    if (libState.busy) return { ok: false, reason: '已经在下载了' };
    const c = petLib.readCatalog();
    const local = petLib.listLocal(userDataDir());
    const todo = c.pets.filter((p) => !local[p.id]);
    libState.busy = true;
    libState.cancel = false;
    libState.done = 0;
    libState.total = todo.length;
    libState.failed = [];
    libNotify();
    for (const p of todo) {
      if (libState.cancel) break;
      libState.current = p.name || p.id;
      libNotify();
      try {
        await petLib.downloadOne(p, userDataDir(), c.ref);
        libState.done += 1;
      } catch (e) {
        libState.failed.push(p.id + '：' + String((e && e.message) || e).slice(0, 80));
        // 连续失败说明网络/源整体不通：立刻停，别让用户对着 258 个素材干等
        if (libState.failed.length >= 3) break;
      }
      libNotify();
    }
    libState.busy = false;
    libState.current = '';
    libNotify();
    pet.loadPack();
    return { ok: true, done: libState.done, total: libState.total, canceled: !!libState.cancel, failed: libState.failed.slice(0, 10) };
  });
}

module.exports = { Pet, registerPetIpc, DEFAULT_STAGE };
