'use strict';
/* ===== 灵动岛渲染逻辑 =====
   状态：strip(细条·默认) / expanded(放大版灵动岛) / zoom(最大窗口) / notify(系统通知)
   交互：单击 展开/收起 · 双击 配置 · 按住上下拖拽 放大/缩小 · 通知上/左/右滑收起 */

const $ = (s) => document.querySelector(s);

let state = 'strip';
let events = [];
let notify = null; // { title, body }
let ui = { showSeconds: true, showPast: false, dayRounding: 'floor', cycleEnabled: false, cycleSec: 6, classical: false, stripStyle: 'black', notifyShake: true };

const ESC = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ---------- 文言文（可选） ---------- */

function t(s) {
  if (!ui.classical) return s;
  return s
    .replace(/距离/g, '距')
    .replace(/还有/g, '尚有')
    .replace(/已结束/g, '已畢')
    .replace(/已过/g, '已逾')
    .replace(/剩余/g, '餘')
    .replace(/暂无倒计时事件（托盘图标 → 配置）/g, '無倒計時之事，請於托盤配置')
    .replace(/天/g, '日')
    .replace(/时/g, '時')
    .replace(/秒/g, '秒');
}

/* ---------- 主进程事件 ---------- */

/** GPU 玻璃：把主进程下发的窗口/显示器几何交给 WebGL 模块（含胶囊在窗口内的偏移） */
function applyGeom(g) {
  if (!g || !window.GlassWebGL) return;
  const pr = $('#pill').getBoundingClientRect();
  window.GlassWebGL.setGeom(Object.assign({}, g, { padX: pr.left, padY: pr.top }));
}

window.island.onState((s) => {
  state = s.state;
  document.body.dataset.state = state;
  $('#pill').style.opacity = s.opacity;
  // GPU 玻璃需要窗口/显示器几何（画布像素 ↔ 屏幕物理像素的映射）
  applyGeom(s.geom);
  updateGlassVisibility();
  render();
});

// 窗口移动/缩放时主进程增量推送几何 → 立即按新位置重绘（不需要等下一次视频帧）
window.island.onGeom((g) => {
  applyGeom(g);
  if (document.body.dataset.glass === 'webgl' && window.GlassWebGL && window.GlassWebGL.isActive()) {
    window.GlassWebGL.redraw();
  }
});

window.island.onEvents((e) => {
  events = e.events || [];
  ui = { ...ui, ...(e.ui || {}) };
  // 细条样式：black（黑底白字）| glass（跟随玻璃效果）
  const strip = ui.stripStyle === 'glass' ? 'glass' : 'black';
  const stripChanged = strip !== document.body.dataset.strip;
  document.body.dataset.strip = strip;
  // 玻璃高光强度（%）：写入 CSS 变量供「表面光影」缩放，并通知两条链路按同一系数重算
  //（折射/渗色的基色不变，只影响高光那一层）
  const glowK = Math.max(0, Math.min(2, (typeof ui.glassGlow === 'number' ? ui.glassGlow : 100) / 100));
  document.documentElement.style.setProperty('--glow-k', String(glowK));
  if (window.GlassWebGL) {
    window.GlassWebGL.setGlowK(glowK);
    // GPU 玻璃帧率（只对 webgl 模式生效；CPU 链路用「背景刷新间隔」控制）
    window.GlassWebGL.setFps(typeof ui.gpuGlassFps === 'number' ? ui.gpuGlassFps : 30);
    // 高级设置：GPU 玻璃的边缘高光 / 底部阴影 / 折射强度 / 折射范围（100% = 默认）
    window.GlassWebGL.setTune({
      edgeGlow: pctK(ui.glEdgeGlow),
      bottomShade: pctK(ui.glBottomShade),
      refract: pctK(ui.glRefract),
      band: pctK(ui.glBand),
    });
  }
  scheduleLiquidGlass();
  // 细条切换到玻璃样式：当前手上只有旧几何的图（或没有图），
  // 先进入"等新图"再显示，避免闪出一帧错位的旧截图（主进程 250ms 内会推送新图）
  if (stripChanged && state === 'strip' && strip === 'glass') setGlassWaiting(true);
  updateGlassVisibility();
  render();
});

window.island.onNotify((d) => {
  notify = {
    title: d.title || '系统通知',
    body: d.body || '',
    keywords: Array.isArray(d.keywords) ? d.keywords : [],
    btn: d.btn || null,
    alert: !!d.alert, // 提醒类：文字高频模糊抖动
  };
  render();
});

/** 正文关键词红色高亮（如"关机"），仅对已转义文本中的纯关键词生效 */
function highlightKeywords(text) {
  let out = text;
  for (const kw of notify.keywords) {
    if (!kw) continue;
    const escKw = ESC(kw);
    if (!escKw) continue;
    out = out.split(escKw).join('<span class="n-key">' + escKw + '</span>');
  }
  return out;
}

window.island.onGlass((g) => {
  const el = $('#glass');
  el.style.display = 'block';
  el.style.backgroundImage = `url(${g.dataUrl})`;
  // 玻璃图 = 窗口覆盖区域裁剪（含外扩采样余量）。按主进程给出的屏幕 DIP 尺寸
  // 铺放，并用实际偏移定位——窗口贴屏幕边缘时外扩区被裁掉，偏移不为 0，
  // 否则整幅背景会错位（表现为"看到的不是屏幕下方原画"）。
  el.style.backgroundSize = `${g.dispW || 0}px ${g.dispH || 0}px`;
  el.style.backgroundPosition = `${g.offX || 0}px ${g.offY || 0}px`;
  // 新截屏到达：解除"动画后等待新图"状态（该帧画面与当前窗口位置匹配），
  // 并重新评估显示——关键：这里必须走 updateGlassVisibility 才会挂上液态滤镜
  //（否则玻璃一直以 CSS 兜底 blur 显示，折射/渗色/高光全部不生效）
  if (glassWaiting) {
    glassWaiting = false;
    clearTimeout(glassWaitingTimer);
    updateGlassVisibility();
  }
});

// 动画/尺寸变化后、新截屏到达前的等待标记：期间不显示旧位置玻璃图（避免错位"方形模糊"帧）
let glassWaiting = false;
let glassWaitingTimer = null;

function setGlassWaiting(waiting) {
  glassWaiting = waiting;
  clearTimeout(glassWaitingTimer);
  if (waiting) {
    // 兜底：若长时间收不到新截屏（截屏源不可用等），超时后恢复显示旧图，避免玻璃永久缺失
    glassWaitingTimer = setTimeout(() => {
      glassWaiting = false;
      updateGlassVisibility();
    }, 800);
  }
}

let glStatsTimer = null;
let glNoGeomCheck = false; // 测试环境：跳过画布/窗口几何一致性自检

/** 启动 GPU 液态玻璃取流 + 着色器（采集精度在取流时确定，所以改精度要重开） */
function startGlassStream() {
  return window.GlassWebGL.start(document.getElementById('glass-gl'), {
    onBrightness: (b) => {
      applyBrightness(b);
      // 同步回主进程：诊断/测试需要读到真实亮度（webgl 模式下主进程已不再截屏）
      if (window.island.reportGlass) window.island.reportGlass({ type: 'brightness', brightness: b });
    },
    noGeomCheck: glNoGeomCheck,
    fps: typeof ui.gpuGlassFps === 'number' ? ui.gpuGlassFps : 30,
    onFallback: (reason) => {
      console.warn('[glass-webgl] 回退到 CPU 液态玻璃:', reason);
      if (window.island.reportGlass) window.island.reportGlass({ type: 'fallback', reason: String(reason) });
    },
  }).then((okStream) => {
    if (!okStream) return;
    updateGlassVisibility();
    window.GlassWebGL.redraw();
    if (window.island.reportGlass) window.island.reportGlass({ type: 'started' });
    // 周期性回传运行统计（--perf / --diag 用）
    clearInterval(glStatsTimer);
    glStatsTimer = setInterval(() => {
      if (!window.GlassWebGL || !window.GlassWebGL.isActive()) return;
      if (window.island.reportGlass) window.island.reportGlass({ type: 'stats', stats: window.GlassWebGL.stats() });
    }, 5000);
  });
}

window.island.onGlassMode((m) => {
  const mode = m.mode || 'fake';
  document.body.dataset.glass = mode;
  glNoGeomCheck = !!m.noGeomCheck;
  // GPU 液态玻璃：启动屏幕视频流 + WebGL 着色器；其它模式确保停掉取流
  if (window.GlassWebGL) {
    if (mode === 'webgl') {
      startGlassStream();
    } else if (window.GlassWebGL.isActive()) {
      clearInterval(glStatsTimer);
      window.GlassWebGL.stop();
      if (window.island.reportGlass) window.island.reportGlass({ type: 'stopped' });
    }
  }
  updateGlassVisibility();
});

// 窗口尺寸动画信号：动画期间隐藏真实玻璃层（液态滤镜/合成层会逃逸 CSS 圆角
// 裁剪，在放大/缩小时露出方形模糊边）。动画结束不立即恢复显示——旧截图与
// 新窗口位置错位会闪出"方形模糊"帧；改为等待主进程推送新截屏（onGlass）后显示。
// GPU 路径不需要等新图（视频流是连续的），动画结束直接重绘即可。
window.island.onAnim((d) => {
  document.body.dataset.anim = d && d.on ? '1' : '0';
  if (!(d && d.on)) {
    if (document.body.dataset.glass === 'webgl' && window.GlassWebGL) {
      updateGlassVisibility();
      window.GlassWebGL.redraw();
      return;
    }
    // 动画结束：窗口尺寸已稳定；若当前应显示玻璃，进入"等新图"状态（新截图由
    // 主进程在动画结束后立即抓取推送），同时重建滤镜资源
    const showGlass = glassShown();
    if (showGlass) setGlassWaiting(true);
    updateGlassVisibility();
    scheduleLiquidGlass();
  }
});

/** 当前状态是否应显示玻璃（GPU 液态玻璃 webgl / CPU 液态 liquid / 真实模糊 capture）。
    横幅/倒计时窗口始终显示；细条（灵动岛）只在「细条样式=玻璃」时显示；
    通知形态是黑底白字弹窗，从不显示玻璃。 */
function glassShown() {
  const m = document.body.dataset.glass;
  if (m !== 'capture' && m !== 'liquid' && m !== 'webgl') return false;
  if (state === 'expanded' || state === 'zoom') return true;
  if (state === 'strip') return document.body.dataset.strip === 'glass';
  return false;
}

function updateGlassVisibility() {
  // 玻璃按状态显示：横幅/倒计时窗口；细条仅当「细条样式=玻璃」；通知形态不显示
  const showGlass = glassShown();
  const mode = document.body.dataset.glass;
  const gpu = mode === 'webgl' && window.GlassWebGL && window.GlassWebGL.isActive();
  const gpuCanvas = document.getElementById('glass-gl');
  if (gpuCanvas) gpuCanvas.style.display = showGlass && gpu ? 'block' : 'none';
  // CPU 路径：等新图期间保持隐藏（避免旧图与窗口错位的方形模糊帧）
  const display = showGlass && !gpu && !glassWaiting ? 'block' : 'none';
  $('#glass').style.display = display;
  // 高光层与玻璃同步显示（黑底形态不叠加高光）
  const tint = $('#glass-tint');
  if (tint) tint.style.display = showGlass && (gpu || display === 'block') ? 'block' : 'none';
  if (showGlass && (gpu || display === 'block')) {
    if (gpu) window.GlassWebGL.redraw();
    else scheduleLiquidGlass();
  }
}

/* ---------- 液态玻璃滤镜（liquid 模式专属：折射位移 + 渗色 + 镜面高光） ---------- */

let glassFilterTimer = null;

/** 依据当前窗口/pill 几何重建滤镜资源。
    liquid 模式 → 挂载液态 SVG 滤镜；capture 模式 → 清掉内联滤镜，回退 CSS blur。 */
function rebuildLiquidGlass() {
  const g = document.getElementById('glass');
  if (!g || !window.LiquidGlass) return;
  if (document.body.dataset.glass !== 'liquid') {
    g.style.filter = '';
    return;
  }
  const p = document.getElementById('pill');
  if (!p) return;
  const gr = g.getBoundingClientRect();
  const pr = p.getBoundingClientRect();
  if (gr.width < 4 || gr.height < 4) return;
  const cs = getComputedStyle(p);
  const radius = Math.min(parseFloat(cs.borderRadius) || 0, Math.min(pr.width, pr.height) / 2);
  const rect = {
    x: pr.left - gr.left,
    y: pr.top - gr.top,
    w: pr.width,
    h: pr.height,
    r: Math.max(1, radius),
  };
  const ok = window.LiquidGlass.apply(window.LiquidGlass.FILTER_ID, rect, { glowK: glowFactor() });
  // 失败（环境不支持等）：清掉内联滤镜，回退 CSS 兜底
  if (!ok) g.style.filter = '';
}

/** 玻璃高光强度系数（0–2，1 = 默认）：由「玻璃高光强度」设置驱动 */
function glowFactor() {
  const pct = typeof ui.glassGlow === 'number' ? ui.glassGlow : 100;
  return Math.max(0, Math.min(2, pct / 100));
}

/** 高级设置里的百分比 → 系数（0–3，1 = 默认；非法值按默认处理） */
function pctK(v) {
  return typeof v === 'number' && isFinite(v) ? Math.max(0, Math.min(3, v / 100)) : 1;
}

/** 状态/尺寸变化后延迟重建（窗口缩放动画中多次触发，合并为一次） */
function scheduleLiquidGlass() {
  clearTimeout(glassFilterTimer);
  glassFilterTimer = setTimeout(rebuildLiquidGlass, 80);
}

window.addEventListener('resize', scheduleLiquidGlass);

let bgDark = false; // 白边状态（滞回记忆，防闪烁）
let inkDark = false; // 深色文字状态（滞回记忆：亮暗背景在阈值附近波动时不反复闪字）

/** 背景亮度 → 文字色/描边适配（CPU 路径由主进程推送，GPU 路径由 WebGL 模块回传） */
function applyBrightness(b) {
  if (typeof b !== 'number') return;
  // 文字颜色滞回：亮背景（>0.62）→ 深色文字；暗背景（<0.48）→ 白色文字；中间区间保持原样
  if (inkDark) {
    if (b < 0.48) inkDark = false;
  } else if (b > 0.62) {
    inkDark = true;
  }
  document.body.dataset.ink = inkDark ? 'dark' : 'light';
  // 无效果模式：仅在背景「几乎全黑」（亮度 < 0.15）时加细白边；
  // 滞回：退出阈值 0.25，防止亮度在阈值附近时白边闪烁
  if (b < 0.15) bgDark = true;
  else if (b > 0.25) bgDark = false;
  document.body.dataset.bg = bgDark ? 'dark' : 'light';
}

window.island.onBrightness((data) => applyBrightness(data && data.brightness));

/* ---------- 倒计时计算 ---------- */

function remaining(ev) {
  return new Date(ev.date).getTime() - Date.now();
}

function fmtHMS(ms) {
  const t = Math.max(0, ms);
  const p = (n) => String(n).padStart(2, '0');
  return {
    h: p(Math.floor(t / 3600000) % 24),
    m: p(Math.floor(t / 60000) % 60),
    s: p(Math.floor(t / 1000) % 60),
    d: Math.floor(t / 86400000),
    hh: Math.floor(t / 3600000) % 24,
    mm: Math.floor(t / 60000) % 60,
    ss: Math.floor(t / 1000) % 60,
  };
}

/** 日期（天数）估算方式：向上取整 / 四舍五入 / 向下取整（默认） */
function roundDays(ms, mode) {
  const d = Math.max(0, ms) / 86400000;
  if (mode === 'ceil') return Math.ceil(d);
  if (mode === 'round') return Math.round(d);
  return Math.floor(d);
}

/**
 * 主时间单位：所有状态共用 —— 从「天」开始逐级下降，取第一个「够一个单位」的时间单位。
 *   · 不足 1 天 → 主单位换成「时」，不足 1 小时 → 「分」，不足 1 分钟 → 「秒」
 *   · 天数按「日期估算方式」取整后判断，因此向上取整时不足一天也算一天（仍显示天）
 *   · sub = 比主单位更小的两级单位文本（如 ['20分','30秒']），供副行显示
 */
function timeUnits(ms, dayMode) {
  const t0 = Math.max(0, ms);
  const z = fmtHMS(t0);
  const days = roundDays(t0, dayMode);
  if (days >= 1) return { num: days, unit: '天', sub: [`${z.h}时`, `${z.m}分`, `${z.s}秒`] };
  if (z.hh >= 1) return { num: z.hh, unit: '时', sub: [`${z.m}分`, `${z.s}秒`] };
  if (z.mm >= 1) return { num: z.mm, unit: '分', sub: [`${z.s}秒`] };
  return { num: z.ss, unit: '秒', sub: [] };
}

function sortedEvents() {
  let list = (events || []).filter((e) => e.enabled !== false);
  if (!ui.showPast) {
    const future = list.filter((e) => remaining(e) > 0);
    if (future.length) list = future;
  }
  return list.slice().sort((a, b) => new Date(a.date) - new Date(b.date));
}

function primaryIndex(list) {
  if (!list.length) return 0;
  if (ui.cycleEnabled && state === 'zoom' && list.length > 1) {
    return Math.floor(Date.now() / (ui.cycleSec * 1000)) % list.length;
  }
  // 置顶事件（在配置页设置）：固定显示在灵动岛/横幅上（仍受启用与过期过滤约束，见 sortedEvents）
  const pin = list.findIndex((e) => e.pinned);
  if (pin !== -1) return pin;
  const idx = list.findIndex((e) => remaining(e) > 0);
  return idx === -1 ? 0 : idx;
}

function fmtDateCN(iso) {
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/* ---------- 渲染（结构重建 + 每秒文本更新分离，降低卡顿） ---------- */

function currentInfo() {
  const list = sortedEvents();
  const idx = primaryIndex(list);
  const primary = list[idx] || null;
  if (!primary) return null;
  const ms = remaining(primary);
  const hms = fmtHMS(ms);
  return {
    primary,
    days: roundDays(ms, ui.dayRounding),
    hms,
    units: timeUnits(ms, ui.dayRounding),
    past: ms <= 0,
    list,
    idx,
  };
}

let shownPrimaryId = null; // 当前 DOM 展示的事件 id（轮播切换检测用）
let shownUnit = ''; // 当前主时间单位（跨单位时需重建 DOM 以增删副行节点）

function render() {
  const box = $('#content');

  // 系统通知优先渲染（不依赖倒计时事件是否存在）；操作按钮在弹窗下方 #dnd-bar
  if (state === 'notify') {
    const bodyHtml = notify && notify.body ? highlightKeywords(ESC(notify.body)) : '';
    box.innerHTML = `
      <div class="n-wrap">
        <div class="n-title">${ESC(notify ? notify.title : '系统通知')}</div>
        ${bodyHtml ? `<div class="n-body ${ui.notifyShake !== false ? 'n-shake' : ''}">${bodyHtml}</div>` : ''}
      </div>`;
    // 弹窗下方按钮：自定义按钮（如「取消关机」）或默认「免打扰至下课」
    const bar = $('#dnd-bar');
    bar.innerHTML = notify && notify.btn
      ? `<button class="n-btn" data-act="${ESC(notify.btn.act || '')}">${ESC(notify.btn.label || '取消')}</button><span class="n-hint">滑动收起</span>`
      : '<button class="n-btn" data-act="dnd">🔕 免打扰至下课</button><span class="n-hint">滑动收起</span>';
    scheduleNotifyMeasure();
    return;
  }

  const info = currentInfo();
  shownPrimaryId = info ? info.primary.id : null;

  if (state === 'strip') {
    // 细条：没有计时时间（无有效事件）时只显示纯黑胶囊，不渲染任何内容
    if (!info) {
      box.innerHTML = '';
      return;
    }
    const { primary, units, past } = info;
    const emoji = ESC(primary.emoji || '⏰');
    shownUnit = past ? '' : units.unit;
    box.innerHTML = `
      <div class="s-row">
        <span class="s-emoji">${emoji}</span>
        <span class="s-num" data-role="days">${past ? t('已过') : units.num}</span>
        ${past ? '' : `<span class="s-unit" data-role="unit">${t(units.unit)}</span>`}
      </div>`;
    return;
  }

  if (!info) {
    box.innerHTML = `<div class="empty">${t('暂无倒计时事件（托盘图标 → 配置）')}</div>`;
    return;
  }
  const { primary, units, past, list, idx } = info;
  const emoji = ESC(primary.emoji || '⏰');
  const name = ESC(primary.name || '事件');

  if (state === 'expanded') {
    // 放大版灵动岛：事件名 + 主时间单位（不足一天自动降级为时/分/秒）+ 更小单位
    shownUnit = past ? '' : units.unit;
    box.innerHTML = `
      <div class="e-row">
        <span class="e-emoji">${emoji}</span>
        <span class="e-name">${t('距')} ${name}</span>
        <span class="e-num" data-role="days">${past ? t('已过') : units.num}</span>
        ${past ? '' : `<span class="e-unit" data-role="unit">${t(units.unit)}</span>`}
        ${ui.showSeconds && !past ? `<span class="e-time" data-role="time">${t(subText(units))}</span>` : ''}
      </div>`;
    return;
  }

  // zoom 倒计时窗口（正方形 = 屏幕高 1/4；事件名在上方，中部突出主单位，副行更小单位）
  if (state === 'zoom') {
    const pillH = ($('#pill').offsetHeight || 300);
    const st = document.documentElement.style;
    st.setProperty('--z-num', Math.round(pillH * 0.45) + 'px');
    st.setProperty('--z-unit', Math.round(pillH * 0.13) + 'px');
    st.setProperty('--z-time', Math.round(pillH * 0.12) + 'px');
    st.setProperty('--z-head', Math.round(pillH * 0.11) + 'px');
    st.setProperty('--z-emoji', Math.round(pillH * 0.15) + 'px');
  }
  shownUnit = past ? '' : units.unit;
  box.innerHTML = `
    <div class="z-wrap">
      <div class="z-head">
        <span class="z-emoji">${emoji}</span>
        <span class="z-label">${t('距离')}${name}${t('还有')}</span>
      </div>
      <div class="z-mid">
        <div class="z-row1">
          <span class="z-num" data-role="days">${past ? t('已过') : units.num}</span>
          ${past ? '' : `<span class="z-unit" data-role="unit">${t(units.unit)}</span>`}
        </div>
        ${ui.showSeconds && !past && units.sub.length ? `<div class="z-row2"><span class="z-time" data-role="time">${t(subText(units))}</span></div>` : ''}
      </div>
    </div>`;
  scheduleZoomMeasure();
}

/** 副行文本：天单位用「时:分:秒」钟表样式（保持原有观感），
    主单位降级为时/分/秒时用「20分30秒」带单位样式（更明确） */
function subText(units) {
  if (units.unit === '天') return units.sub.map((x) => x.replace(/[时分秒]/g, '')).join(':');
  return units.sub.join('');
}

/* ---------- 通知展示框自适应：按字体与字数测量，上报主进程调整窗口尺寸 ---------- */

let notifyMeasureTimer = null;

function scheduleNotifyMeasure() {
  clearTimeout(notifyMeasureTimer);
  notifyMeasureTimer = setTimeout(measureNotify, 30);
}

/* ---------- 倒计时窗口宽度自适应：按文字内容测量，上报主进程调整宽度 ---------- */

let zoomMeasureTimer = null;

function scheduleZoomMeasure() {
  clearTimeout(zoomMeasureTimer);
  // 延迟到窗口动画（110ms）结束后再测量：字号按最终窗口高度计算，避免测到动画中间值
  zoomMeasureTimer = setTimeout(measureZoom, 250);
}

function measureZoom() {
  if (state !== 'zoom') return;
  const head = $('.z-head');
  const mid = $('.z-mid');
  if (!head || !mid) return;
  // 动画已结束：用最终窗口高度重设字号变量（render 时窗口可能还在动画中，高度是中间值）
  const pillH = ($('#pill').offsetHeight || 300);
  const st = document.documentElement.style;
  st.setProperty('--z-num', Math.round(pillH * 0.45) + 'px');
  st.setProperty('--z-unit', Math.round(pillH * 0.13) + 'px');
  st.setProperty('--z-time', Math.round(pillH * 0.12) + 'px');
  st.setProperty('--z-head', Math.round(pillH * 0.11) + 'px');
  st.setProperty('--z-emoji', Math.round(pillH * 0.15) + 'px');
  // 隐藏测量：复用 .z-head/.z-mid 的样式测两行内容的自然宽度（含 gap）
  const m = document.createElement('div');
  m.style.cssText = 'position:fixed;left:-10000px;top:0;visibility:hidden;display:inline-flex;align-items:center;white-space:nowrap;';
  document.body.appendChild(m);
  m.className = 'z-head';
  m.innerHTML = head.innerHTML;
  const hw = m.getBoundingClientRect().width;
  m.className = 'z-mid';
  m.innerHTML = mid.innerHTML;
  const mw = m.getBoundingClientRect().width;
  m.remove();
  // 宽度 = 两行较宽者 + 左右 padding（22×2）
  const w = Math.round(Math.max(hw, mw) + 44);
  window.island.zoomWidth(w);
}

function measureNotify() {
  if (state !== 'notify') return;
  const title = (notify && notify.title) || '系统通知';
  const body = (notify && notify.body) || '';
  // 与 island.css 通知样式保持一致（固定 px 行高，改了 CSS 需同步这里）
  const TITLE_H = 24; // 17px 行高 24px
  const BODY_LH = 22; // 15px 行高 22px
  const PAD_X = 32; // 弹窗左右 padding 16×2
  const PAD_T = 12;
  const PAD_B = 10;
  const WIN_TOP = 8; // 弹窗距窗口顶部
  const GAP = 6; // 弹窗与免打扰按钮的间隙
  const DND_H = 24; // 按钮行高
  const WIN_BOTTOM = 8; // 按钮距窗口底部
  const MAX_W = 560;
  const MIN_W = 240;
  // 隐藏测量：复用 .n-title/.n-body 的字体样式，测单行宽度
  const m = document.createElement('div');
  m.style.cssText = 'position:fixed;left:-10000px;top:0;visibility:hidden;display:block;white-space:nowrap;';
  document.body.appendChild(m);
  m.className = 'n-title';
  m.textContent = title;
  const tw = m.getBoundingClientRect().width;
  m.className = 'n-body';
  m.textContent = body;
  const bw = body ? m.getBoundingClientRect().width : 0;
  m.remove();
  // 宽度：标题与正文最长者决定，240–560 之间
  const w = Math.min(Math.max(Math.max(tw, bw) + PAD_X, MIN_W), MAX_W);
  // 正文在可用宽度内换行，最多 2 行
  let bodyLines = 0;
  if (body) {
    const m2 = document.createElement('div');
    m2.className = 'n-body';
    m2.style.cssText = `position:fixed;left:-10000px;top:0;visibility:hidden;display:block;width:${Math.floor(w - PAD_X)}px;`;
    m2.textContent = body;
    document.body.appendChild(m2);
    bodyLines = Math.max(1, Math.min(2, Math.round(m2.getBoundingClientRect().height / BODY_LH)));
    m2.remove();
  }
  // 弹窗高度 = 上边距 + 标题行 + (正文 margin+行数) + 下边距
  const pillH = PAD_T + TITLE_H + (bodyLines ? 5 + bodyLines * BODY_LH : 0) + PAD_B;
  // 窗口高度 = 顶部边距 + 弹窗 + 间隙 + 免打扰按钮行 + 底部边距
  const h = WIN_TOP + pillH + GAP + DND_H + WIN_BOTTOM;
  window.island.notifySize({ w: Math.round(w), h: Math.round(h) });
}

/** 每秒更新数字/时间文本（不重建 DOM，减少开销）；
    轮播/事件过期导致主事件切换时重建一次（标题/图标随事件变化） */
function tickUpdate() {
  if (state === 'notify') return; // 通知展示期间不轮播、不重建
  const info = currentInfo();
  if (!info) {
    // 事件过期/被移除后没有计时时间：重建一次，细条清空为纯黑、其余状态显示空提示
    if ($('#content').innerHTML !== '') render();
    return;
  }
  if (info.primary.id !== shownPrimaryId) {
    render(); // 轮播切到下一个事件 / 主事件变化：重建 DOM 更新标题
    return;
  }
  // 主单位可能随时间下降（天→时→分→秒，三种状态通用）：单位变化时重建 DOM
  // （副行单位个数随主单位变化，纯文本更新不足以增删节点）
  if (info.past) return;
  if (info.units.unit !== shownUnit) {
    render();
    return;
  }
  const numEl = $('[data-role="days"]');
  if (numEl && numEl.firstChild) numEl.firstChild.textContent = info.units.num;
  const unitEl = $('[data-role="unit"]');
  if (unitEl) unitEl.textContent = t(info.units.unit);
  const timeEl = $('[data-role="time"]');
  if (timeEl && ui.showSeconds && info.units.sub.length) {
    timeEl.textContent = t(subText(info.units));
  }
}

setInterval(tickUpdate, 1000);

/* ---------- 触摸/鼠标交互：单击 / 双击 / 按住上下拖拽 ---------- */

const pill = $('#pill');
let drag = null;
let tapTimer = null;
let lastTap = 0;

pill.addEventListener('pointerdown', (e) => {
  if (e.target.closest('button')) return;
  drag = { x: e.clientX, y: e.clientY, id: e.pointerId, moved: false, dx: 0, dy: 0 };
  try {
    pill.setPointerCapture(e.pointerId);
  } catch (err) {
    /* ignore */
  }
});

pill.addEventListener('pointermove', (e) => {
  if (!drag || e.pointerId !== drag.id) return;
  const dx = e.clientX - drag.x;
  const dy = e.clientY - drag.y;
  if (!drag.moved && (Math.abs(dy) > 6 || Math.abs(dx) > 6)) drag.moved = true;
  if (drag.moved) {
    drag.dx = dx;
    drag.dy = dy;
  }
});

function endPointer(e) {
  if (!drag || e.pointerId !== drag.id) return;
  const d = drag;
  drag = null;
  if (d.moved) {
    if (state === 'notify') {
      // 通知形态：上滑/左滑/右滑（任意方向滑动）收起
      window.island.action({ type: 'dismiss', dx: d.dx, dy: d.dy });
    } else {
      // 按住拖拽：向下 = 放大（倒计时窗口），向上 = 收起；灵动岛上滑 = 暂时收起（到时自动展开）
      window.island.action({ type: 'gesture', dy: d.dy });
    }
    return;
  }
  // 单击 / 双击（含触屏双击）
  const now = Date.now();
  if (now - lastTap < 320) {
    lastTap = 0;
    clearTimeout(tapTimer);
    window.island.action({ type: 'doubleTap' });
  } else {
    lastTap = now;
    clearTimeout(tapTimer);
    tapTimer = setTimeout(() => {
      lastTap = 0;
      window.island.action({ type: 'tap' });
    }, 300);
  }
}

pill.addEventListener('pointerup', endPointer);
pill.addEventListener('pointercancel', endPointer);

pill.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  window.island.action({ type: 'menu' });
});

$('#buttons').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  window.island.action({ type: btn.dataset.act });
});

// 通知内容中的按钮（免打扰至下课）
$('#content').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  window.island.action({ type: btn.dataset.act });
});

// 弹窗下方的免打扰按钮（独立于弹窗本体）
$('#dnd-bar').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  window.island.action({ type: btn.dataset.act });
});

/* ---------- 启动 ---------- */
window.island.ready();
