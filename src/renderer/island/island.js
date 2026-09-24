'use strict';
/* ===== 灵动岛渲染逻辑 =====
   状态：strip(细条·默认) / expanded(放大版灵动岛) / zoom(最大窗口) / notify(系统通知)
   交互：单击 展开/收起 · 双击 配置 · 按住上下拖拽 放大/缩小 · 通知上/左/右滑收起 */

const $ = (s) => document.querySelector(s);

let state = 'strip';
let events = [];
let notify = null; // { title, body }
let weather = null; // 主进程下发的天气载荷（null = 未启用 / 无数据）：横幅/大卡片的天气 chip 与图标动画
let wxFxKind = '';
let dock = null; // 计时坞文案载荷
let dockEdit = false; // 计时坞快捷添加态
let dockMenu = false; // 计时坞操作页（倒计时进行中长按）
let lastDockSig = ''; // 计时坞渲染签名：相同就不重建 DOM（防闪）
/* 长按灵动岛（默认 700ms）：启动计时坞并进入快捷添加态 */
let longPressTimer = null;
let longPressFired = false;
const LONG_PRESS_MS = 700;
/* 长按反馈：只把整块稍微放大（不要进度条）。
   on = 按住中（放大一点点）；fired = 触发瞬间（再大一点，随后自然回落） */
/* 诊断用：长按链路各阶段计数（window.__pressDbg()）——
   用真实输入事件驱动时，能看出到底是"窗口没收到按下" 还是"计时器被取消了" */
const pressDbg = { downs: 0, moves: 0, ups: 0, cancels: 0, fired: 0, lastTarget: '', lastType: '' };
window.__pressDbg = () => ({ ...pressDbg, hasTimer: !!longPressTimer, fired: longPressFired });

function pressFeedback(on) {
  if (!document.body) return;
  document.body.classList.toggle('pressing', !!on);
}
function pressFired() {
  document.body.classList.add('pressing', 'press-fired');
  setTimeout(() => {
    document.body.classList.remove('press-fired');
    document.body.classList.remove('pressing');
  }, 220);
}  // 本次通知的天气特效类型（'' = 无特效）
let ui = { showSeconds: true, showPast: false, dayRounding: 'floor', cycleEnabled: false, cycleSec: 6, classical: false, stripStyle: 'black', notifyShake: true };

const ESC = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ---------- 圆角半径（两条玻璃链路的共用取值） ---------- */

/**
 * #pill 的 border-radius 带 0.24s 过渡（expanded 是胶囊 = 999px，zoom 只有 42px）。
 * 过渡期间 getComputedStyle 读到的是中间值（例如 400px），再被「不超过半高半宽」一夹，
 * 圆角矩形 SDF 就退化成圆/胶囊 —— 大窗口刚展开时边缘折射看起来是圆的，就是这个原因。
 * 所以：过渡进行中改用「本状态上一次稳定后的半径」，还没有稳定值时用与 CSS 同步的兜底表。
 */
window.SCIRadius = (() => {
  const FALLBACK = { strip: 13, zoom: 42, notify: 24, expanded: null }; // null = 胶囊（= 半高）
  const cache = {};

  function transitioning(pill) {
    try {
      if (typeof pill.getAnimations !== 'function') return false;
      // Chromium 把 border-radius 过渡记成四个圆角长属性（border-top-left-radius …），
      // 不是 "border-radius"，这里按包含 radius 判断
      return pill.getAnimations().some((a) => a && typeof a.transitionProperty === 'string' && a.transitionProperty.indexOf('radius') >= 0);
    } catch (e) {
      return false;
    }
  }

  /** pill 当前应使用的 CSS 半径（已按「不超过半高半宽」夹过） */
  function settled(pill, maxR) {
    const st = document.body.dataset.state || 'strip';
    const raw = parseFloat(getComputedStyle(pill).borderRadius);
    const val = isFinite(raw) ? Math.min(raw, maxR) : 0;
    if (!transitioning(pill)) {
      cache[st] = val;
      return val;
    }
    if (typeof cache[st] === 'number') return Math.min(cache[st], maxR);
    const fb = FALLBACK[st];
    return fb == null ? maxR : Math.min(fb, maxR);
  }

  return { settled };
})();

/** 圆角过渡结束后用稳定值重算一次（两条链路都要） */
(function watchRadiusTransition() {
  const pill = document.getElementById('pill');
  if (!pill) return;
  const onDone = (e) => {
    // 过渡结束时事件名是四个圆角长属性（border-top-left-radius 等）
    if (!e || typeof e.propertyName !== 'string' || e.propertyName.indexOf('radius') < 0) return;
    scheduleLiquidGlass();
    if (window.GlassWebGL && window.GlassWebGL.isActive()) window.GlassWebGL.redraw();
  };
  pill.addEventListener('transitionend', onDone);
  pill.addEventListener('transitioncancel', onDone);
})();

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
  if (!g) return;
  lastGeom = g; // 挖孔形状要在窗口移动/缩放后用最新几何重算
  if (!window.GlassWebGL) return;
  const pr = $('#pill').getBoundingClientRect();
  window.GlassWebGL.setGeom(Object.assign({}, g, { padX: pr.left, padY: pr.top }));
}

window.island.onState((s) => {
  state = s.state;
  weather = s.weather || null; // 天气载荷（chip 与图标动画；细条不渲染 chip，保持 116 宽几何）
  // 先记下禁区规格：render() 里的内容布局要用它（applyCameraNotch 里再算黑底与禁区矩形）
  notchData = s.notch && s.notch.zw > 0 ? s.notch : null;
  dock = s.dock || null; // 计时坞文案（节假日倒计时）
  const dockMenuChanged = dockMenu !== !!s.dockMenu;
  dockMenu = !!s.dockMenu; // 计时坞操作页（暂停/继续/取消）
  const dockEditChanged = dockEdit !== !!s.dockEdit;
  dockEdit = !!s.dockEdit; // 计时坞快捷添加态（长按灵动岛进入）
  if (dockEditChanged || dockMenuChanged) setTimeout(() => { try { render(); } catch (e) { /* ignore */ } }, 0);
  document.body.dataset.state = state;
  $('#pill').style.opacity = s.opacity;
  // GPU 玻璃需要窗口/显示器几何（画布像素 ↔ 屏幕物理像素的映射）
  applyGeom(s.geom);
  updateGlassVisibility();
  applyCornerClip(); // 角落卡片的形状要按新尺寸重算
  applyCameraNotch(s.notch); // 传感器避让：算出黑底与内容布局，render() 依赖它
  render();
  guardNotchContent(); // 布局兜底：内容绝不允许压进禁区
  if (state !== 'notify') setWxEffect(''); // 离开通知形态：撤掉整条岛的天气特效
});

// 窗口移动/缩放时主进程增量推送几何 → 立即按新位置重绘（不需要等下一次视频帧）
window.island.onGeom((g) => {
  applyGeom(g);
  // 禁区是屏幕上的固定位置（传感器不动）：窗口动过之后黑底与内容布局都要用新几何重算
  if (notchData) {
    const before = notchVisible;
    applyCameraNotch(notchData);
    if (before !== notchVisible) render();
    guardNotchContent();
  }
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
  wxFxKind = d.weather || ''; // 天气提醒：整条岛的雨雪/晴空特效
  render();
  setWxEffect(wxFxKind);
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
  if (state === 'dock') return false; // 计时坞固定黑底白字（效果同通知），不挂玻璃
  if (m !== 'capture' && m !== 'liquid' && m !== 'liquid-ab' && m !== 'webgl') return false;
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
  const gm = document.body.dataset.glass;
  if (gm !== 'liquid' && gm !== 'liquid-ab') {
    g.style.filter = '';
    return;
  }
  // 「液态玻璃·色散版」= CPU 链路 + 固定 2px 色散（不跟随「边缘色散」设置项，保证开箱即用的观感一致）
  const abFixed = gm === 'liquid-ab' ? 2 : null;
  const p = document.getElementById('pill');
  if (!p) return;
  const gr = g.getBoundingClientRect();
  const pr = p.getBoundingClientRect();
  if (gr.width < 4 || gr.height < 4) return;
  const cs = getComputedStyle(p);
  const maxR = Math.min(pr.width, pr.height) / 2;
  const radius = window.SCIRadius ? window.SCIRadius.settled(p, maxR) : Math.min(parseFloat(cs.borderRadius) || 0, maxR);
  const rect = {
    x: pr.left - gr.left,
    y: pr.top - gr.top,
    w: pr.width,
    h: pr.height,
    r: Math.max(1, radius),
  };
  const ok = window.LiquidGlass.apply(window.LiquidGlass.FILTER_ID, rect, {
    glowK: glowFactor(),
    // 参数化观感（0/缺省 = 按玻璃高度自适应，行为与旧版一致）：
    // 这几个值可以在「玻璃实验室」窗口里实时调，满意后一键写回设置
    refractWidth: typeof ui.refractWidth === 'number' ? ui.refractWidth : 0,
    maxRefract: typeof ui.maxRefract === 'number' ? ui.maxRefract : 0,
    bleedOpacity: typeof ui.bleedOpacity === 'number' ? Math.max(0, Math.min(1, ui.bleedOpacity / 100)) : undefined,
    aberration: abFixed != null ? abFixed : typeof ui.glassAberration === 'number' ? ui.glassAberration : 0,
  });
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

/* ---------- 传感器避让（灵动岛 · 传感器避让规格） ---------- */

let notchData = null; // 主进程下发的禁区规格（含屏幕坐标 sx/sy）
let notchVisible = false; // 禁区是否真的落在小岛上（内容让位 / 黑底包住都看它）
let notchLayout = 'none'; // 当前状态用哪种内容布局：'split' | 'below' | 'none'
let lastGeom = null; // 最近一次窗口/显示器几何（窗口动过之后重算禁区用）

/**
 * 挖孔在 pill 局部坐标系里的位置与可见性。
 * 窗口会随状态移动/缩放，所以每次都用「屏幕坐标 - 当前窗口坐标 - pill 偏移」重算，
 * 不能沿用主进程下发时的窗口相对坐标（那是上一帧的窗口位置）。
 */
function notchLocal() {
  const n = notchData;
  const p = $('#pill');
  if (!n || !p) return null;
  const pr = p.getBoundingClientRect();
  const w = lastGeom && lastGeom.win ? lastGeom.win : { x: 0, y: 0 };
  const winX = typeof n.sx === 'number' ? n.sx - w.x : n.zx;
  const winY = typeof n.sy === 'number' ? n.sy - w.y : n.zy;
  const zw = Math.max(1, n.zw || 1);
  const zh = Math.max(1, n.zh || 1);
  const zx = winX - pr.left;
  const zy = winY - pr.top;
  const visible = zx + zw > 0 && zx < pr.width && zy + zh > 0 && zy < pr.height;
  return {
    zx,
    zy,
    zw,
    zh,
    cx: zx + zw / 2,
    cy: zy + zh / 2,
    layout: n.layout === 'split' || n.layout === 'below' ? n.layout : 'none',
    debug: !!n.debug,
    islandTop: Number(n.islandTop) || 0,
    slotLeft: Math.max(0, Number(n.slotLeft) || 0),
    slotRight: Math.max(0, Number(n.slotRight) || 0),
    slotBelow: Math.max(0, Number(n.slotBelow) || 0),
    belowTop: Math.max(0, Number(n.belowTop) || 0),
    sensors: (n.sensors || []).map((s) => ({
      id: s.id,
      x: (typeof s.sx === 'number' ? s.sx - w.x : 0) - pr.left,
      y: (typeof s.sy === 'number' ? s.sy - w.y : 0) - pr.top,
      d: Math.max(2, Number(s.d) || 0),
    })),
    visible,
    pillW: Math.max(1, pr.width),
    pillH: Math.max(1, pr.height),
  };
}


/**
 * 传感器避让（规格硬约束：传感器坐标永不改变；黑色背景可以覆盖传感器，内容不行）。
 * 禁区一律画成不透明黑的圆角矩形，盖在玻璃与内容之上 —— 内容算错位也绝不会盖住传感器；
 * 内容布局只有两种（规格 layout_rules）：split 左右分栏 / below 退到禁区下方。
 * 小岛窗口位置不受影响：镜头在哪由传感器坐标决定，黑底只负责把它包住。
 */
function applyCameraNotch(notch) {
  notchData = notch && notch.zw > 0 ? notch : null;
  const p = $('#pill');
  if (!p) return;
  const loc = notchLocal();
  const on = !!loc && loc.visible;
  notchVisible = on;
  notchLayout = on ? loc.layout : 'none';
  const st = document.documentElement.style;
  const zeros = ['--notch-gap', '--notch-half', '--notch-pad-t', '--notch-pad-b', '--notch-pad-l', '--notch-pad-r', '--notch-shift', '--notch-sink', '--notch-slot-l', '--notch-slot-r'];
  if (!on) {
    for (const k of zeros) st.setProperty(k, '0px');
    st.setProperty('--notch-cx', '50%');
    p.style.maskImage = '';
    p.style.webkitMaskImage = '';
    if (state !== 'corner') p.style.clipPath = '';
    delete p.dataset.notch;
    delete document.body.dataset.notch;
    delete document.body.dataset.notchLayout;
    renderSensorDebug(null);
    return;
  }
  document.body.dataset.notch = '1';
  document.body.dataset.notchLayout = loc.layout;
  // 禁区尺寸与位置（px）：黑底、内容让位、进度条文字都以它为准
  st.setProperty('--notch-zone-w', Math.round(loc.zw) + 'px');
  st.setProperty('--notch-zone-h', Math.round(loc.zh) + 'px');
  st.setProperty('--notch-gap', Math.round(loc.zw) + 'px');
  st.setProperty('--notch-half', Math.round(loc.zw / 2) + 'px');
  st.setProperty('--notch-cx', Math.round(loc.cx) + 'px');
  st.setProperty('--notch-cy', Math.round(loc.cy) + 'px');
  st.setProperty('--notch-shift', Math.round(loc.cx - loc.pillW / 2) + 'px');
  st.setProperty('--notch-slot-l', loc.slotLeft + 'px');
  st.setProperty('--notch-slot-r', loc.slotRight + 'px');
  // below 布局：内容 top ≥ 禁区底边 + 额外空隙（规格 below.top）
  const belowPad = Math.max(0, Math.ceil(loc.zy + loc.zh + loc.slotBelow));
  st.setProperty('--notch-pad-t', (loc.layout === 'below' ? belowPad : 0) + 'px');
  st.setProperty('--notch-pad-b', '0px');
  st.setProperty('--notch-pad-l', '0px');
  st.setProperty('--notch-pad-r', '0px');
  // 大卡片内容被往下推时，整窗高度要多留出这么多（渲染层测完尺寸回传主进程）
  st.setProperty('--notch-sink', loc.layout === 'below' ? belowPad + 'px' : '0px');
  // 那块黑交给独立的「传感器盖板」窗口（纯黑胶囊、永久置顶、永不移动），
  // 小岛这边只负责把内容让开禁区（下面的 --notch-* 变量）。
  renderSensorDebug(loc);
  p.style.maskImage = '';
  p.style.webkitMaskImage = '';
  if (state !== 'corner') p.style.clipPath = '';
  p.dataset.notch = `${Math.round(loc.zx)},${Math.round(loc.zy)} ${Math.round(loc.zw)}x${Math.round(loc.zh)}`;
}

/** 调试模式：画传感器彩色圆点 + 禁区虚线框（规格 interaction.toggle_sensor） */
function renderSensorDebug(loc) {
  const box = $('#sensor-debug');
  if (!box) return;
  if (!loc || !loc.debug) {
    box.style.display = 'none';
    box.innerHTML = '';
    return;
  }
  const palette = ['#ff5f57', '#febc2e', '#28c840', '#4f7cff', '#c061ff'];
  box.style.display = 'block';
  box.innerHTML =
    `<span class="sd-zone" style="left:${Math.round(loc.zx)}px;top:${Math.round(loc.zy)}px;width:${Math.round(loc.zw)}px;height:${Math.round(loc.zh)}px"></span>` +
    loc.sensors
      .map((s, i) => {
        const d = Math.max(4, Math.round(s.d));
        return `<span class="sd-dot" style="left:${Math.round(s.x - d / 2)}px;top:${Math.round(s.y - d / 2)}px;width:${d}px;height:${d}px;background:${palette[i % palette.length]}"></span>`;
      })
      .join('');
}

/**
 * 内容让位（规格 layout_rules）：
 *   split → 内容放传感器左右两侧（左槽 anchor left + offset，右槽 anchor right + offset），
 *           中间 [zoneLeft, zoneRight] 不放任何内容
 *   below → 内容从禁区底边下方开始（不分栏，靠 --notch-pad-t 推下来）
 * 未启用 / 禁区不在小岛上：原样返回（单行居中）。
 */
function notchRow(left, right) {
  if (!notchVisible || notchLayout !== 'split') return left + right;
  return `<span class="nb-l">${left}</span><span class="nb-gap"></span><span class="nb-r">${right}</span>`;
}

/**
 * 布局兜底（硬约束：内容 rect 与禁区不相交）：
 * split 布局下内容紧挨禁区两侧，正常不会压进去；万一字号/内容异常导致压入，
 * 就按禁区边界把对应那一瓣夹住（宁可裁一点，也不许盖住传感器）。
 */
function guardNotchContent() {
  const loc = notchLocal();
  const p = $('#pill');
  if (!loc || !loc.visible || notchLayout !== 'split' || !p) return;
  const pr = p.getBoundingClientRect();
  const zx = loc.zx;
  const zr = loc.zx + loc.zw;
  document.querySelectorAll('.nb-l').forEach((el) => {
    const r = el.getBoundingClientRect();
    const left = r.left - pr.left;
    if (r.right - pr.left > zx - loc.slotLeft && left < zx) {
      el.style.maxWidth = Math.max(0, Math.floor(zx - loc.slotLeft - left)) + 'px';
      el.style.overflow = 'hidden';
    }
  });
  document.querySelectorAll('.nb-r').forEach((el) => {
    const r = el.getBoundingClientRect();
    if (r.left - pr.left < zr + loc.slotRight) {
      el.style.maxWidth = Math.max(0, Math.floor(pr.width - zr - loc.slotRight)) + 'px';
      el.style.overflow = 'hidden';
    }
  });
}

/** 自检/诊断钩子：禁区在屏幕上的位置与布局（主进程 --test 用） */
window.__notchState = () => {
  const loc = notchLocal();
  const p = $('#pill');
  const pr = p ? p.getBoundingClientRect() : null;
  const w = lastGeom && lastGeom.win ? lastGeom.win : { x: 0, y: 0 };
  return {
    visible: notchVisible,
    layout: notchLayout,
    zone: loc ? { w: Math.round(loc.zw), h: Math.round(loc.zh) } : null,
    rect: loc ? { x: Math.round(loc.zx), y: Math.round(loc.zy), w: Math.round(loc.zw), h: Math.round(loc.zh) } : null,
    screen: loc && pr ? { x: w.x + pr.left + loc.zx, y: w.y + pr.top + loc.zy } : null,
    sensors: loc ? loc.sensors.map((s) => ({ id: s.id, x: s.x, y: s.y, d: s.d })) : [],
    band: loc ? { left: loc.zx, right: loc.zx + loc.zw } : null,
  };
};

/** 自检/诊断钩子：渲染层看到的天气载荷与 chip 状态（主进程 --shot-weather / --test 用） */
window.__wxState = () => {
  const w = document.getElementById('wx');
  const fx = document.getElementById('wx-fx');
  const vis = (el) => (el ? el.hidden || getComputedStyle(el).display === 'none' : null);
  return {
    state,
    payload: weather,
    hasChip: !!w,
    chipHidden: vis(w),
    chipAnim: w ? w.dataset.anim || '' : '',
    chipText: w ? (w.querySelector('.wx-text') || {}).textContent || '' : '',
    chipTemp: w ? (w.querySelector('.wx-temp') || {}).textContent || '' : '',
    fx: fx ? fx.dataset.fx || '' : '',
    fxHidden: vis(fx),
    fxKids: fx ? fx.children.length : 0,
  };
};

/** 状态/尺寸变化后延迟重建（窗口缩放动画中多次触发，合并为一次） */
function scheduleLiquidGlass() {
  clearTimeout(glassFilterTimer);
  glassFilterTimer = setTimeout(rebuildLiquidGlass, 80);
}

window.addEventListener('resize', () => {
  scheduleLiquidGlass();
  applyCornerClip(); // 角落卡片形状随尺寸重算
  if (notchData) {
    applyCameraNotch(notchData); // 禁区形状随尺寸重算
    guardNotchContent();
  }
});

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
    ms,
    days: roundDays(ms, ui.dayRounding),
    hms,
    units: timeUnits(ms, ui.dayRounding),
    past: ms <= 0,
    list,
    idx,
  };
}

/* ---------- 天气 chip 与整岛天气特效 ---------- */

/**
 * 天气 chip（横幅 / 大卡片内联显示）。
 * 细条不渲染：细条宽度是 116 + 禁区宽 + 槽位（T29 几何契约），加东西会破契约。
 * 动画关闭或强度 0 时只出静态图标（图标形状由 data-anim 决定，CSS keyframes 负责动）。
 */
function wxChipHtml() {
  if (!weather || weather.show === false) return '';
  // 「天气位置 = 盖板上」：天气已经在中间那块盖板上显示 → 岛内任何形态（含大窗口）都不再画，
  // 否则同一份天气会出现两次（盖板一次、大窗口又一次）
  if (weather.pos === 'cover') return '';
  // 常驻（always）= 细条也显示；'banner' 只在横幅/大卡片显示（细条保持极简）
  if (weather.mode !== 'always' && state !== 'expanded' && state !== 'zoom') return '';
  const iv = Math.max(0, Math.min(200, Number(weather.intensity) || 0)) / 100;
  // 动画关闭或强度 0 → 静态图标（data-anim=none 时不挂 keyframes，省电也便于断言）
  const anim = weather.animEnabled === false || iv === 0 ? 'none' : weather.anim || 'none';
  const unit = weather.unit === 'f' ? '°F' : '°';
  const temp = weather.temp == null ? '--' : `${Math.round(weather.temp)}${unit}`;
  const tip = `${weather.city || ''} ${weather.text || ''}${weather.stale ? '（数据已过期）' : ''}`.trim();
  // 细条空间紧：只出图标 + 温度（紧凑态），文字留给横幅/大卡片
  const compact = state === 'strip';
  const side = compact && weather.pos === 'left' ? ' data-side="left"' : '';
  // 去掉所有图标内容：不再渲染 .wx-sky（图标形状与动画），只留温度 + 天气文字
  return (
    `<span class="wx${weather.stale ? ' wx-stale' : ''}" id="wx" data-anim="${ESC(anim)}" data-tone="${ESC(weather.tone || 'cool')}"${compact ? ' data-compact="1"' : ''}${side}` +
    ` style="--wx-i:${iv.toFixed(2)}" title="${ESC(tip)}">` +
    `<b class="wx-temp">${ESC(temp)}</b><em class="wx-text">${ESC(weather.text || '')}</em>` +
    '</span>'
  );
}

/** 通知形态的整条岛天气特效：雨丝 / 雪花 / 晴空 / 云影 / 雷闪 / 雾带（层数按动画强度缩放） */
function setWxEffect(kind) {
  const fx = $('#wx-fx');
  if (!fx) return;
  const on = !!kind && kind !== 'none' && (!weather || weather.animEnabled !== false);
  fx.hidden = !on;
  fx.dataset.fx = on ? kind : '';
  if (!on) {
    fx.innerHTML = '';
    return;
  }
  const iv = Math.max(0, Math.min(200, Number(weather && weather.intensity) || 0)) / 100;
  const base = kind === 'snow' ? 10 : kind === 'rain' || kind === 'thunder' ? 12 : 6;
  const n = Math.round(base * iv);
  fx.innerHTML = Array.from({ length: n }, (_x, i) => `<i style="--i:${i}"></i>`).join('');
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
    // 挖孔避让造成中间一条禁区带，两侧本来各有一瓣。去掉图标后左瓣空着很难看
    // → 把**事件名**填进左瓣（右瓣是天数），左右各占一侧，视觉平衡、也不浪费那块黑。
    // 名字超长会省略号截断，并且按最大宽度夹住：左右瓣宽度差会被"整行居中"放大，
    // 差太多会让某一瓣顶进禁区带（有兜底裁切，但会难看），所以这里限宽。
    const evName = String(primary.name || '').trim();
    const sLeft = evName ? `<span class="s-name" title="${ESC(evName)}">${ESC(evName)}</span>` : `<span class="s-name s-noicon"></span>`;
    const sRight = `<span class="s-num" data-role="days">${past ? t('已过') : units.num}</span>${past ? '' : `<span class="s-unit" data-role="unit">${t(units.unit)}</span>`}`;
    // 天气常驻：紧凑 chip 挂在细条右缘（绝对定位，不参与整行居中 → 两瓣与禁区的相对位置不变）
    box.innerHTML = `<div class="s-row">${notchRow(sLeft, sRight)}</div>${wxChipHtml()}`;
    return;
  }

  if (state === 'dock') {
    // 计时坞（对标 iOS 倒计时）：环形进度 + 超大等宽数字 + 极小标签 + 细线性进度条
    const d = dock || { title: '距离 节假日', num: '--', unit: '天', date: '', pct: 0, at: 0 };
    const pct = Math.max(0, Math.min(1, Number(d.pct) || 0));
    const p2n = (n) => String(n).padStart(2, '0');
    // 防闪：内容签名没变就不重建 DOM（每秒重建就是窗口一闪一闪的原因）
    const sig0 = `${d.key || ''}|${d.num}|${d.unit}|${d.title}|${d.paused ? 1 : 0}|${dockEdit ? 1 : 0}|${dockMenu ? 1 : 0}|${pct.toFixed(3)}|${d.at ? 1 : 0}`;
    if (sig0 === lastDockSig && box.querySelector('.dk-wrap')) return;
    const leftMs = typeof d.leftMs === 'number' ? d.leftMs : d.at ? d.at - Date.now() : 0;
    let num = d.num;
    let unit = d.paused ? '天' : d.unit;
    if (d.paused) {
      // 暂停：显示冻结值，不走秒
      num = d.num;
      unit = '天';
    } else if (d.at && !d.paused && leftMs <= 86400000 && leftMs > -1000) {
      const sec = Math.max(0, Math.floor(leftMs / 1000));
      num = `${p2n(Math.floor(sec / 3600))}:${p2n(Math.floor((sec % 3600) / 60))}:${p2n(sec % 60)}`;
      unit = '';
    }
    const R = 21;
    const C = 2 * Math.PI * R;
    const ring =
      `<svg class="dk-ring" viewBox="0 0 52 52" aria-hidden="true">` +
      `<circle cx="26" cy="26" r="${R}" class="dk-ring-track"/>` +
      `<circle cx="26" cy="26" r="${R}" class="dk-ring-bar" stroke-dasharray="${C.toFixed(1)}" stroke-dashoffset="${(C * (1 - pct)).toFixed(1)}"/>` +
      `</svg>`;
    let chips = '';
    if (dockMenu) {
      // 倒计时进行中长按 → 这一页：暂停/继续 + 取消 + 返回
      chips =
        '<div class="dk-edit">' +
        (d.paused
          ? '<button class="dk-chip done" data-act="dockResume">继续</button>'
          : '<button class="dk-chip done" data-act="dockPause">暂停</button>') +
        '<button class="dk-chip danger" data-act="dockCancel">取消倒计时</button>' +
        '<button class="dk-chip ghost" data-act="dockMenuClose">返回</button>' +
        '</div>';
    } else if (dockEdit) {
      chips =
        '<div class="dk-edit">' +
        '<button class="dk-chip" data-act="dockAdd" data-days="1">+1 天</button>' +
        '<button class="dk-chip" data-act="dockAdd" data-days="3">+3 天</button>' +
        '<button class="dk-chip" data-act="dockAdd" data-days="7">+7 天</button>' +
        '<button class="dk-chip" data-act="dockAdd" data-days="30">+30 天</button>' +
        '<button class="dk-chip ghost" data-act="config">自定义…</button>' +
        '<button class="dk-chip done" data-act="dockDone">完成</button>' +
        '</div>';
    }
    box.innerHTML =
      '<div class="dk-wrap">' +
      '<div class="dk-main">' +
      ring +
      '<div class="dk-text">' +
      `<div class="dk-row"><span class="dk-num" data-dock-num>${ESC(num)}</span>${unit ? `<span class="dk-unit" data-dock-unit>${ESC(unit)}</span>` : ''}</div>` +
      `<div class="dk-title">${ESC(d.title)}${d.paused ? '（已暂停）' : ''}</div>` +
      '</div>' +
      (d.date ? `<div class="dk-date">${ESC(d.date)}</div>` : '') +
      '</div>' +
      '<div class="dk-bar"><i style="width:${(pct * 100).toFixed(1)}%"></i></div>' +
      chips +
      '</div>';
    lastDockSig = sig0;
    return;
  }



  if (!info) {
    // 没有倒计时事件也照常显示天气（教室只想要天气时不该被空态吞掉）
    const chip = wxChipHtml();
    box.innerHTML = chip
      ? `<div class="empty-wrap"><div class="empty">${t('暂无倒计时事件（托盘图标 → 配置）')}</div>${chip}</div>`
      : `<div class="empty">${t('暂无倒计时事件（托盘图标 → 配置）')}</div>`;
    return;
  }
  const { primary, units, past, list, idx } = info;
  const emoji = ESC(primary.emoji || '⏰');
  const name = ESC(primary.name || '事件');

  // 全屏授课：屏幕顶部倒计时进度条（贴顶整宽，填充比例 = 已过 / 总量）
  if (state === 'progress') {
    const pct = progressPercent(info);
    box.innerHTML = `
      <div class="pb-wrap">
        <div class="pb-fill" data-role="fill" style="width:${pct}%"></div>
        <div class="pb-label">
          <span class="pb-name">${t('距')} ${name}</span>
          <span class="pb-num" data-role="days">${past ? t('已过') : units.num}${past ? '' : t(units.unit)}</span>
          ${ui.showSeconds && !past ? `<span class="pb-time" data-role="time">${t(subText(units))}</span>` : ''}
        </div>
      </div>`;
    shownUnit = past ? '' : units.unit;
    return;
  }

  // 全屏授课：右上角角落卡片（贴住屏幕右上角，只显示倒计时剩余时间）

  if (state === 'corner') {
    shownUnit = past ? '' : units.unit;
    box.innerHTML = `
      <div class="cz-wrap">
        <div class="cz-mid">
          <span class="cz-num" data-role="days">${past ? t('已过') : units.num}</span>
          ${past ? '' : `<span class="cz-unit" data-role="unit">${t(units.unit)}</span>`}
        </div>
        ${ui.showSeconds && !past ? `<div class="cz-time" data-role="time">${t(subText(units))}</div>` : ''}
      </div>`;
    applyCornerClip();
    return;
  }

  if (state === 'expanded') {
    // 放大版灵动岛：事件名 + 主时间单位（不足一天自动降级为时/分/秒）+ 更小单位
    shownUnit = past ? '' : units.unit;
    // 挖孔避让：图标+事件名一瓣，数字/单位/时间一瓣
    const eLeft = `<span class="e-name">${t('距')} ${name}</span>`;
    const eRight = `<span class="e-num" data-role="days">${past ? t('已过') : units.num}</span>${past ? '' : `<span class="e-unit" data-role="unit">${t(units.unit)}</span>`}${ui.showSeconds && !past ? `<span class="e-time" data-role="time">${t(subText(units))}</span>` : ''}${wxChipHtml()}`;
    box.innerHTML = `<div class="e-row">${notchRow(eLeft, eRight)}</div>`;
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
        <span class="z-label">${t('距离')}${name}${t('还有')}</span>${wxChipHtml()}
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

/** 顶部进度条填充比例（%）：已过 / 总量；总量 = 设置里的天数（默认 365） */
function progressPercent(info) {
  const total = Math.max(1, typeof ui.progressTotalDays === 'number' ? ui.progressTotalDays : 365);
  const remainDays = info.past ? 0 : Math.max(0, Math.ceil(info.ms / 86400000));
  const done = Math.max(0, Math.min(total, total - remainDays));
  return Math.max(0, Math.min(100, Math.round((done / total) * 100)));
}

/**
 * 右上角角落卡片的形状路径：卡片贴在屏幕右上角，所以
 *   左上、右下 = **内凹**圆角（与屏幕边缘平滑相接，"反着的圆角"）
 *   左下       = 普通外凸圆角
 *   右上       = 方角（就是屏幕角本身）
 * border-radius 做不出内凹圆角，所以用 clip-path: path() 精确画出来。
 */
function cornerClipPath(w, h, r) {
  const rr = Math.max(0, Math.min(r, Math.floor(Math.min(w, h) / 2)));
  if (rr < 1) return `M 0 0 L ${w} 0 L ${w} ${h} L 0 ${h} Z`;
  return [
    `M ${rr} 0`, // 顶边从左上内凹圆角结束处开始
    `L ${w} 0`, // 顶边（贴屏幕顶）
    `L ${w} ${h - rr}`, // 右边（贴屏幕右）
    `A ${rr} ${rr} 0 0 0 ${w - rr} ${h}`, // 右下：内凹圆角
    `L ${rr} ${h}`, // 底边
    `A ${rr} ${rr} 0 0 1 0 ${h - rr}`, // 左下：普通外凸圆角
    `L 0 ${rr}`,
    `A ${rr} ${rr} 0 0 0 ${rr} 0`, // 左上：内凹圆角
    'Z',
  ].join(' ');
}

/** 按当前 pill 尺寸重算角落卡片裁剪路径（只有 corner 形态用；其它形态清掉） */
function applyCornerClip() {
  const p = $('#pill');
  if (!p) return;
  if (state !== 'corner') {
    p.style.clipPath = '';
    return;
  }
  const w = Math.max(1, p.clientWidth || p.offsetWidth || 0);
  const h = Math.max(1, p.clientHeight || p.offsetHeight || 0);
  // 圆角随尺寸自适应：小卡片别被圆角吃掉，大卡片保持"平滑长上去"的观感
  const r = Math.max(8, Math.min(30, Math.round(Math.min(w, h) * 0.34)));
  p.style.clipPath = `path('${cornerClipPath(w, h, r)}')`;
  p.dataset.cornerShape = `w${w} h${h} r${r}`;
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
  // （挖孔避让给禁区留出的深度由主进程 pillSize 统一加上，这里不重复加）
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
  pressDbg.downs += 1;
  pressDbg.lastType = e.pointerType || '';
  pressDbg.lastTarget = (e.target && (e.target.id || e.target.className || e.target.tagName)) || '';
  if (e.target.closest('button')) return;
  drag = { x: e.clientX, y: e.clientY, id: e.pointerId, moved: false, dx: 0, dy: 0, pointerType: e.pointerType || 'mouse' };
  // 长按：不动 700ms → 启动计时坞（快捷添加倒计时）；滑动/抬起则取消
  clearTimeout(longPressTimer);
  longPressFired = false;
  pressFeedback(true);
  longPressTimer = setTimeout(() => {
    longPressFired = true;
    pressDbg.fired += 1;
    pressFired();
    // 计时坞里长按 → 切到操作页（暂停/继续/取消）；其他形态长按 → 启动计时坞快捷添加
    window.island.action(state === 'dock' ? { type: 'dockMenu' } : { type: 'longPress' });
  }, LONG_PRESS_MS);
  try {
    pill.setPointerCapture(e.pointerId);
  } catch (err) {
    /* ignore */
  }
});

pill.addEventListener('pointermove', (e) => {
  pressDbg.moves += 1;
  if (!drag || e.pointerId !== drag.id) return;
  const dx = e.clientX - drag.x;
  const dy = e.clientY - drag.y;
  // 长按与滑动手势的冲突处理：
  //   只要真的移动了（>8px）就当作"想滑"→ 立刻取消长按；
  //   尤其竖直方向（下滑=放大到大窗口）只要 >6px 就取消，
  //   否则会出现"长按先触发了计时坞、抬手又触发一次放大"的双动作。
  const vIntent = Math.abs(dy) > 6 && Math.abs(dy) >= Math.abs(dx);
  if (!drag.moved && (Math.abs(dy) > 6 || Math.abs(dx) > 6)) {
    drag.moved = true;
    if (vIntent || Math.abs(dy) > 8 || Math.abs(dx) > 8) {
      pressDbg.cancels += 1;
      clearTimeout(longPressTimer);
      longPressTimer = null;
      pressFeedback(false);
    }
  }
  if (drag.moved) {
    drag.dx = dx;
    drag.dy = dy;
  }
});

function endPointer(e) {
  if (!drag || e.pointerId !== drag.id) return;
  const d = drag;
  drag = null;
  pressDbg.ups += 1;
  clearTimeout(longPressTimer); // 抬起 → 消取长按（已触发的话 longPressFired=true 会跳过单击）
  longPressTimer = null;
  pressFeedback(false);
  if (d.moved) {
    if (longPressFired) {
      // 这次按住已经当作长按处理过：抬手不再补一次滑动手势（否则计时坞+放大双动作）
      longPressFired = false;
      pressFeedback(false);
      return;
    }
    if (state === 'notify') {
      // 通知形态：上滑/左滑/右滑（任意方向滑动）收起
      window.island.action({ type: 'dismiss', dx: d.dx, dy: d.dy });
    } else {
      // 按住拖拽：向下 = 放大（倒计时窗口），向上 = 收起；灵动岛上滑 = 暂时收起（到时自动展开）
      window.island.action({ type: 'gesture', dy: d.dy });
    }
    return;
  }
  if (longPressFired) {
    // 长按已经触发过（启动计时坞）：抬起时不再当作单击
    longPressFired = false;
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

// 计时坞快捷添加芯片：点一下就新建对应天数的倒计时（不用打字）
$('#content').addEventListener('click', (e) => {
  const chip = e.target.closest('.dk-chip');
  if (!chip) return;
  if (chip.dataset.days) window.island.action({ type: 'dockAdd', days: Number(chip.dataset.days) });
  else window.island.action({ type: chip.dataset.act });
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

/* 计时坞末段逐秒：**只改数字节点的文本**，绝不重建 DOM；
   原来每秒重画整块会让窗口一闪一闪的（内容被整块换掉）。 */
setInterval(function () {
  if (state !== 'dock' || !dock || !dock.at || dock.paused) return;
  var left = dock.at - Date.now();
  if (left > 86400000 || left < -1000) return;
  var el = document.querySelector('[data-dock-num]');
  if (!el) return;
  var sec = Math.max(0, Math.floor(left / 1000));
  var p = function (n) { return String(n).padStart(2, '0'); };
  var txt = p(Math.floor(sec / 3600)) + ':' + p(Math.floor((sec % 3600) / 60)) + ':' + p(sec % 60);
  if (el.textContent !== txt) el.textContent = txt;
  var bar = document.querySelector('.dk-bar > i');
  if (bar) bar.style.width = (Math.max(0, Math.min(1, 1 - left / 86400000)) * 100).toFixed(1) + '%';
}, 1000);
