'use strict';
/* 桌宠渲染层
   - 舞台内 60fps 自由移动（窗口几乎不动，只有走到边缘才请主进程平移一格）
   - 逐像素命中：1/2 分辨率遮罩画布读 alpha，只有指针落在桌宠/气泡上才接收鼠标
   - 美术：默认内置占位小人（几何图形）；配了素材包则按帧序列绘制（见 drawSprite）
   - 行为：idle / walk / sleep / talk / quiet 由主进程 pet-brain 每秒下发 */

const cv = document.getElementById('pet');
const ctx = cv.getContext('2d');
const bubble = document.getElementById('bubble');
const textEl = document.getElementById('text');
const dots = document.getElementById('dots');
const metaEl = document.getElementById('meta');
const quickEl = document.getElementById('quick');
const askEl = document.getElementById('ask');
const badge = document.getElementById('badge');

// 命中遮罩（1/2 分辨率 + willReadFrequently，readback 便宜）
const MASK = 2;
const mask = document.createElement('canvas');
const mctx = mask.getContext('2d', { willReadFrequently: true });

const P = {
  w: 0,
  h: 0,
  x: 0,
  y: 0,
  dir: 1,
  speed: 0.9,
  action: 'idle',
  t: 0,
  blinking: false,
  talking: false,
  scale: 1,
  inClass: false,
  sprites: null, // 素材包：{ 状态: { frames:[Image], fps, sheet:{count,cols}|null } }（null = 用占位小人）
  frame: 0,
  lastTs: 0,     // 上一帧时间戳（按真实时间步进，帧率无关）
  restUntil: 0,  // 转身/撞墙后的停顿截止时间（performance.now()）
};

function resize() {
  P.w = window.innerWidth;
  P.h = window.innerHeight;
  cv.width = Math.round(P.w * devicePixelRatio);
  cv.height = Math.round(P.h * devicePixelRatio);
  ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  mask.width = Math.max(1, Math.round(P.w / MASK));
  mask.height = Math.max(1, Math.round(P.h / MASK));
  if (!P.x) {
    P.x = P.w * 0.5;
    P.y = P.h - 56;
  }
  P.x = Math.max(28, Math.min(P.x, P.w - 28));
  P.y = Math.max(48, Math.min(P.y, P.h - 30));
}

window.addEventListener('resize', resize);

/** 命中判定：遮罩画布该点 alpha > 25 视为"身上" */
function alphaAt(x, y) {
  try {
    const d = mctx.getImageData(Math.max(0, Math.round(x / MASK)), Math.max(0, Math.round(y / MASK)), 1, 1).data;
    return d[3];
  } catch (e) {
    return 0;
  }
}

function overBubble(x, y) {
  if (!bubble.classList.contains('show')) return false;
  const b = bubble.getBoundingClientRect();
  return x >= b.left - 4 && x <= b.right + 4 && y >= b.top - 4 && y <= b.bottom + 4;
}

/* ---------------- 绘制 ---------------- */

/** 取当前状态该用的素材帧（帧序列 / 精灵图 / 动图）；没有素材返回 null → 回落占位小人 */
function currentSprite() {
  if (!P.sprites) return null;
  const s = P.sprites[P.action] || (P.action === 'quiet' ? P.sprites.idle : null) || P.sprites.idle;
  if (!s || !s.frames || !s.frames.length) return null;
  const img = s.frames[P.frame % s.frames.length];
  if (!img || !img.complete || !img.naturalWidth) return null;
  return { s, img };
}

function drawSprite(g, scale, sp) {
  const { s, img } = sp;
  const cols = s.sheet ? s.sheet.cols : 1;
  const count = s.sheet ? s.sheet.count : 1;
  const fw = s.sheet ? img.naturalWidth / cols : img.naturalWidth;
  const rows = s.sheet ? Math.max(1, Math.ceil(count / cols)) : 1;
  const fh = s.sheet ? img.naturalHeight / rows : img.naturalHeight;
  const idx = s.sheet ? P.frame % count : 0;
  const sx = s.sheet ? (idx % cols) * fw : 0;
  const sy = s.sheet ? Math.floor(idx / cols) * fh : 0;
  const w = fw * P.scale;
  const h = fh * P.scale;
  const x = P.x - w / 2;
  const y = P.y - h + (P.anchorY || 0) * P.scale;
  g.save();
  g.scale(1 / scale, 1 / scale);
  if (P.dir < 0) {
    g.translate(P.x * 2, 0);
    g.scale(-1, 1);
  }
  g.drawImage(img, sx, sy, fw, fh, x, y, w, h);
  g.restore();
}

/** 内置占位小人（几何图形，不需要素材包就能跑） */
function drawPlaceholder(g, scale) {
  g.save();
  g.scale(1 / scale, 1 / scale);
  const { x, y } = P;
  const sc = P.scale;
  const bob = P.action === 'walk' ? Math.sin(P.t / 8) * 1.6 * sc : Math.sin(P.t / 22) * 0.8 * sc;
  const swing = P.action === 'walk' ? Math.sin(P.t / 7) * 9 * sc : 0;
  const eye = P.action === 'sleep' ? 0.14 : P.blinking ? 0.16 : 1;
  const body = P.inClass ? '#5b6b8c' : '#4c7dff';
  const head = P.inClass ? '#6f7f9e' : '#6f9bff';

  // 影子
  g.fillStyle = 'rgba(0,0,0,0.22)';
  g.beginPath();
  g.ellipse(x, y + 30 * sc, 26 * sc, 7 * sc, 0, 0, Math.PI * 2);
  g.fill();
  // 身体
  g.fillStyle = body;
  g.beginPath();
  g.roundRect(x - 24 * sc, y - 6 * sc + bob, 48 * sc, 40 * sc, 14 * sc);
  g.fill();
  // 手脚
  g.strokeStyle = body;
  g.lineWidth = 7 * sc;
  g.lineCap = 'round';
  g.beginPath();
  g.moveTo(x - 22 * sc, y + 8 * sc + bob);
  g.lineTo(x - 34 * sc, y + 22 * sc + bob + swing);
  g.moveTo(x + 22 * sc, y + 8 * sc + bob);
  g.lineTo(x + 34 * sc, y + 22 * sc + bob - swing);
  g.moveTo(x - 12 * sc, y + 32 * sc);
  g.lineTo(x - 12 * sc, y + 40 * sc + Math.max(0, swing * 0.4));
  g.moveTo(x + 12 * sc, y + 32 * sc);
  g.lineTo(x + 12 * sc, y + 40 * sc + Math.max(0, -swing * 0.4));
  g.stroke();
  // 头
  g.fillStyle = head;
  g.beginPath();
  g.arc(x, y - 30 * sc + bob, 26 * sc, 0, Math.PI * 2);
  g.fill();
  // 天线（说话时亮黄）
  g.strokeStyle = '#9fbcff';
  g.lineWidth = 3 * sc;
  g.beginPath();
  g.moveTo(x, y - 54 * sc + bob);
  g.lineTo(x, y - 66 * sc + bob);
  g.stroke();
  g.fillStyle = P.talking ? '#ffe066' : P.action === 'sleep' ? '#6b7a99' : '#b9ccff';
  g.beginPath();
  g.arc(x, y - 70 * sc + bob, 5 * sc, 0, Math.PI * 2);
  g.fill();
  // 眼睛
  g.fillStyle = '#101828';
  g.beginPath();
  g.ellipse(x - 9 * sc, y - 32 * sc + bob, 3.4 * sc, 4.6 * sc * eye, 0, 0, Math.PI * 2);
  g.ellipse(x + 9 * sc, y - 32 * sc + bob, 3.4 * sc, 4.6 * sc * eye, 0, 0, Math.PI * 2);
  g.fill();
  // 嘴
  g.fillStyle = P.talking ? '#3a2a2a' : '#2a3550';
  g.beginPath();
  const mh = P.talking ? (5 + Math.abs(Math.sin(P.t / 4)) * 3) * sc : 2.5 * sc;
  g.ellipse(x, y - 20 * sc + bob, 5.5 * sc, mh, 0, 0, Math.PI * 2);
  g.fill();
  // 腮红
  g.fillStyle = 'rgba(255,140,150,0.35)';
  g.beginPath();
  g.arc(x - 17 * sc, y - 24 * sc + bob, 4.5 * sc, 0, Math.PI * 2);
  g.arc(x + 17 * sc, y - 24 * sc + bob, 4.5 * sc, 0, Math.PI * 2);
  g.fill();
  g.restore();
}

function drawInto(g, scale) {
  const sp = currentSprite();
  if (sp) drawSprite(g, scale, sp);
  else drawPlaceholder(g, scale);
}

/* ---------------- 主循环 ---------------- */

function frame() {
  P.t++;
  if (P.t % 150 === 0) P.blinking = true;
  if (P.t % 150 === 9) P.blinking = false;
  // 帧推进：按当前状态的 fps（没有素材时不推进）
  if (P.sprites) {
    const s = P.sprites[P.action] || (P.action === 'quiet' ? P.sprites.idle : null) || P.sprites.idle;
    if (s && s.frames && s.frames.length > 1) {
      const fps = s.fps || 8;
      if (P.t % Math.max(1, Math.round(60 / fps)) === 0) P.frame = (P.frame + 1) % s.frames.length;
    }
  }

  // 舞台内移动（窗口不动，只有走到边缘才整窗平移）
  if (P.action === 'walk' && !P.restUntil) {
    // 按真实时间步进（原来用帧计数 × 交替 1/0.6 系数：帧率一变速度就变，
    // 而且隔帧减速看着一顿一顿）。速度 = speed × 48 px/s，与旧版手感一致。
    const now = performance.now();
    const dt = Math.min(80, Math.max(0, now - P.lastTs)); // 窗口被挂起后别一次跳很远
    P.lastTs = now;
    P.x += ((P.speed * 48 * P.dir * dt) / 1000);
    const pad = 30;
    if (P.x < pad) {
      P.dir = 1;
      requestShift(-120, 0, pad - P.x);
    } else if (P.x > P.w - pad) {
      P.dir = -1;
      requestShift(120, 0, P.x - (P.w - pad));
    }
  } else if (P.action === 'walk') {
    // 转身/撞墙后的短暂停顿（自然一点，也避免贴边抖动）
    P.lastTs = performance.now();
    if (performance.now() >= P.restUntil) P.restUntil = 0;
  } else if (P.action === 'idle' || P.action === 'quiet') {
    // 站着不动，只保留呼吸动画
    P.lastTs = performance.now();
  }

  ctx.clearRect(0, 0, P.w, P.h);
  drawInto(ctx, 1);
  mctx.clearRect(0, 0, mask.width, mask.height);
  drawInto(mctx, MASK);
  positionBubble();
  requestAnimationFrame(frame);
}

/** 走到舞台边缘：请主进程把窗口平移一格，并按**实际位移**补偿自身坐标（视觉连续）。
    贴到屏幕边缘时主进程会被工作区夹住（实际位移 < 请求值）—— 这时把请求值当实际值补偿
    就会让小人往回跳一下、并且一直贴着边缘反复抽搐；所以这里按返回的 dx/dy 补偿，
    窗口完全没动就直接转身 + 停一下。 */
let shifting = false;
async function requestShift(dx, dy, back) {
  if (shifting) return;
  shifting = true;
  const reqDx = dx || 0;
  const reqDy = dy || 0;
  try {
    const r = await window.pet.move(reqDx, reqDy);
    if (r && r.ok) {
      const adx = typeof r.dx === 'number' ? r.dx : reqDx;
      const ady = typeof r.dy === 'number' ? r.dy : reqDy;
      P.x -= adx;
      P.y -= ady;
      if (!adx && !ady) {
        // 窗口已经贴到屏幕边缘：转身走回去，并停一小会儿（别在原地抖）
        P.dir = -P.dir;
        P.restUntil = performance.now() + 320;
      }
    } else {
      P.dir = -P.dir;
      P.restUntil = performance.now() + 320;
    }
  } catch (e) {
    P.dir = -P.dir;
    P.restUntil = performance.now() + 320;
  }
  shifting = false;
}

function positionBubble() {
  const w = bubble.offsetWidth || 200;
  let left = P.x + 24;
  if (left + w > P.w - 6) left = P.w - 6 - w;
  if (left < 6) left = 6;
  bubble.style.left = left + 'px';
  bubble.style.top = Math.max(6, P.y - 118 - bubble.offsetHeight * 0.3) + 'px';
}

/* ---------------- 交互 ---------------- */

let overPet = false;
window.addEventListener('mousemove', (e) => {
  const over = alphaAt(e.clientX, e.clientY) > 25 || overBubble(e.clientX, e.clientY);
  if (over !== overPet) {
    overPet = over;
    window.pet.hit(over);
  }
});

let drag = null;
window.addEventListener('mousedown', (e) => {
  if (overBubble(e.clientX, e.clientY)) return;
  if (alphaAt(e.clientX, e.clientY) > 25) drag = { sx: e.screenX, sy: e.screenY, moved: false };
});
window.addEventListener('mousemove', (e) => {
  if (!drag) return;
  const dx = e.screenX - drag.sx;
  const dy = e.screenY - drag.sy;
  if (Math.abs(dx) + Math.abs(dy) > 3) {
    drag.moved = true;
    window.pet.move(dx, dy);
    drag.sx = e.screenX;
    drag.sy = e.screenY;
  }
});
window.addEventListener('mouseup', (e) => {
  const wasDrag = drag && drag.moved;
  drag = null;
  if (!wasDrag && alphaAt(e.clientX, e.clientY) > 25) {
    window.pet.interact();
    toggleBubble();
  }
});

/* ---------------- 气泡 ---------------- */

const QUICK = [
  ['下节课是什么', '下节课是什么？还有多久上课？'],
  ['距离高考还有几天', '距离高考还有多少天？'],
  ['讲个笑话', '讲一个和学习有关的小笑话'],
  ['背单词老忘怎么办', '背单词老是忘，有什么好办法？'],
];

function buildQuick() {
  if (quickEl.childElementCount) return;
  for (const [label, q] of QUICK) {
    const b = document.createElement('button');
    b.textContent = label;
    b.addEventListener('click', () => send(q));
    quickEl.appendChild(b);
  }
}

function toggleBubble(force) {
  const show = force !== undefined ? force : !bubble.classList.contains('show');
  bubble.classList.toggle('show', show);
  if (show) buildQuick();
  window.pet.hit(show);
}

function send(question) {
  const q = String(question || '').trim();
  if (!q) return;
  window.pet.interact();
  toggleBubble(true);
  textEl.textContent = '';
  metaEl.textContent = '';
  dots.classList.add('on');
  window.pet.ask(q);
}

document.getElementById('send').addEventListener('click', () => {
  const q = askEl.value.trim();
  if (q) {
    askEl.value = '';
    send(q);
  }
});
askEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const q = askEl.value.trim();
    if (q) {
      askEl.value = '';
      send(q);
    }
  }
});

/* ---------------- 主进程事件 ---------------- */

window.pet.onPack((pack) => {
  if (!pack || !pack.ok) {
    P.sprites = null;
    return;
  }
  P.anchorY = pack.anchorY || 0;
  if (pack.scale) P.packScale = pack.scale;
  const sprites = {};
  for (const [name, st] of Object.entries(pack.states || {})) {
    sprites[name] = { fps: st.fps, sheet: st.sheet || null, frames: (st.frames || []).map((url) => { const im = new Image(); im.src = url; return im; }) };
  }
  P.sprites = Object.keys(sprites).length ? sprites : null;
});

window.pet.onConfig((c) => {
  P.scale = Math.max(0.4, Math.min(2.5, c.scale || 1));
  if (typeof c.speed === 'number') P.speed = Math.max(0.2, Math.min(4, c.speed));
});

window.pet.onState((s) => {
  P.action = s.action || 'idle';
  if (s.dir) P.dir = s.dir;
  P.inClass = !!s.inClass;
  badge.classList.toggle('on', P.inClass);
  if (P.action === 'sleep' && bubble.classList.contains('show')) toggleBubble(false);
});

window.pet.onSay((d) => {
  textEl.textContent = d.text || '';
  metaEl.textContent = d.meta || '';
  dots.classList.remove('on');
  P.talking = true;
  toggleBubble(true);
  clearTimeout(window.__talkEnd);
  window.__talkEnd = setTimeout(() => {
    P.talking = false;
  }, Math.min(9000, Math.max(1800, (d.text || '').length * 110)));
});

window.pet.onAskStart(() => {
  textEl.textContent = '';
  metaEl.textContent = '';
  dots.classList.add('on');
  P.talking = true;
  toggleBubble(true);
});

window.pet.onDelta((chunk) => {
  if (dots.classList.contains('on')) dots.classList.remove('on');
  textEl.textContent += chunk;
});

window.pet.onAskEnd((d) => {
  dots.classList.remove('on');
  if (!d || !d.ok) {
    if (!textEl.textContent) textEl.textContent = '（连接失败）';
    metaEl.textContent = (d && d.error) || '';
    P.talking = false;
    return;
  }
  textEl.textContent = d.text || textEl.textContent;
  metaEl.textContent = `首字 ${d.firstMs}ms · 整段 ${d.totalMs}ms${d.truncated ? ' · 已截断' : ''}`;
  clearTimeout(window.__talkEnd);
  window.__talkEnd = setTimeout(() => {
    P.talking = false;
  }, Math.min(12000, Math.max(2500, (d.text || '').length * 120)));
});

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') toggleBubble(false);
});

resize();
requestAnimationFrame(frame);

// 自检/诊断钩子（主进程 --test 用）：读桌宠实时状态与逐像素命中
window.__petState = () => ({
  ready: true,
  x: Math.round(P.x),
  y: Math.round(P.y),
  w: P.w,
  h: P.h,
  action: P.action,
  scale: P.scale,
  inClass: P.inClass,
  bubble: bubble.classList.contains('show'),
  text: textEl.textContent,
  meta: metaEl.textContent,
  usingSprite: !!currentSprite(),
  spriteStates: P.sprites ? Object.keys(P.sprites) : [],
  spriteFrames: P.sprites ? Object.fromEntries(Object.entries(P.sprites).map(([k, v]) => [k, (v.frames || []).length])) : {},
  frame: P.frame,
  alphaAt: (x, y) => alphaAt(x, y),
  hitAt: (x, y) => alphaAt(x, y) > 25,
});
