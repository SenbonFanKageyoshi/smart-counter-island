'use strict';
/* 玻璃实验室渲染层：
   - 主进程按窗口区域裁剪桌面截图推下来（lab:bg）→ 铺到每张卡的玻璃层上
   - 四张卡共用同一张截图，分别走：真实模糊 / 液态玻璃（现状）/ ＋色散 2px / ＋色散 5px＋强折射
   - 参数改动实时重算滤镜；「把这组参数用到小岛」把参数写回设置（ui.*）
   注意：液态玻璃滤镜模块是岛用的同一份 liquid-glass.js（多实例靠 root/glassSel/svgHost 区分）。 */

const cards = {
  capture: { el: document.getElementById('g-capture') },
  liquid: { el: document.getElementById('g-liquid'), filter: 'lab-liquid', rectScale: 1, ab: 0 },
  ab2: { el: document.getElementById('g-ab2'), filter: 'lab-ab2', rectScale: 1, ab: null },
  ab5: { el: document.getElementById('g-ab5'), filter: 'lab-ab5', rectScale: 1.6, ab: null },
};

const ctrl = {
  maxRefract: document.getElementById('maxRefract'),
  refractWidth: document.getElementById('refractWidth'),
  bleedOpacity: document.getElementById('bleedOpacity'),
  glow: document.getElementById('glow'),
  aberration: document.getElementById('aberration'),
  blur: document.getElementById('blur'),
};

let bg = null;      // { dataUrl, dispW, dispH, offX, offY }
let rendered = 0;

function val(el) {
  return Number(el.value);
}

function showLabels() {
  document.getElementById('o-maxRefract').textContent = `${val(ctrl.maxRefract)}px`;
  document.getElementById('o-refractWidth').textContent = `${val(ctrl.refractWidth)}px`;
  document.getElementById('o-bleedOpacity').textContent = `${val(ctrl.bleedOpacity)}%`;
  document.getElementById('o-glow').textContent = `${val(ctrl.glow)}%`;
  document.getElementById('o-aberration').textContent = `${val(ctrl.aberration)}px`;
  document.getElementById('o-blur').textContent = `${val(ctrl.blur)}px`;
}

/** 把截图铺到一张卡的玻璃层（与岛一致：物理像素图按 DIP 尺寸铺 + 实际偏移） */
function paintBg(card) {
  if (!bg) return;
  card.el.style.backgroundImage = `url(${bg.dataUrl})`;
  card.el.style.backgroundSize = `${bg.dispW}px ${bg.dispH}px`;
  card.el.style.backgroundPosition = `${bg.offX}px ${bg.offY}px`;
}

/** 玻璃盒在页面里的位置（滤镜的 rect 用：让折射带贴着卡片圆角走）。
    与岛一致：rect 是「内容盒相对玻璃元素盒」的坐标（#glass 比内容盒外扩 2px） */
function rectOf(el) {
  const gr = el.getBoundingClientRect();
  const st = el.parentElement.getBoundingClientRect();
  return { x: Math.round(st.left - gr.left), y: Math.round(st.top - gr.top), w: Math.round(st.width), h: Math.round(st.height), r: 14 };
}

function paintAll() {
  if (!bg) return;
  const base = {
    maxRefract: val(ctrl.maxRefract),
    refractWidth: val(ctrl.refractWidth),
    bleedOpacity: val(ctrl.bleedOpacity) / 100,
    glowK: val(ctrl.glow) / 100,
  };
  // ① 真实模糊（现状 capture）：整块高斯模糊 + 提色，无折射
  const c = cards.capture;
  paintBg(c);
  c.el.style.filter = `blur(${val(ctrl.blur)}px) saturate(1.4)`;
  // ②③④ 液态玻璃：同一模块，三档色散（0 / 滑杆值 / 滑杆值×2 且折射更强）
  const variants = [
    ['liquid', 0, 1],
    ['ab2', val(ctrl.aberration), 1],
    ['ab5', val(ctrl.aberration) * 2, 1.6],
  ];
  for (const [key, ab, boost] of variants) {
    const card = cards[key];
    paintBg(card);
    const rect = rectOf(card.el);
    const opts = Object.assign({}, base, {
      root: card.el.parentElement.parentElement, // .card（容器）
      glassSel: `#${card.el.id}`,
      svgHost: document.body,
      aberration: ab,
      maxRefract: Math.min(18, base.maxRefract * boost),
      refractWidth: Math.min(64, Math.round(base.refractWidth * boost)),
    });
    const ok = window.LiquidGlass.apply(card.filter, rect, opts);
    if (!ok) card.el.style.filter = `blur(${Math.max(4, val(ctrl.blur) / 2)}px) saturate(1.4)`;
    rendered += 1;
  }
}

document.getElementById('bgState').textContent = '正在取屏…';
window.lab.onBg((g) => {
  bg = g;
  document.getElementById('bgState').textContent = `背景：${new Date().toLocaleTimeString('zh-CN', { hour12: false })} 取屏 · ${g.dispW}×${g.dispH}（取屏时窗口已隐藏）`;
  paintAll();
});
if (document.getElementById('live')) {
  document.getElementById('live').addEventListener('change', (e) => window.lab.live(e.target.checked));
}

for (const el of Object.values(ctrl)) {
  el.addEventListener('input', () => {
    showLabels();
    paintAll();
  });
}
window.addEventListener('resize', () => paintAll());

document.getElementById('refresh').addEventListener('click', () => window.lab.refresh());
document.getElementById('close').addEventListener('click', () => window.lab.close());
document.getElementById('apply').addEventListener('click', async () => {
  const r = await window.lab.apply({
    maxRefract: val(ctrl.maxRefract),
    refractWidth: val(ctrl.refractWidth),
    bleedOpacity: val(ctrl.bleedOpacity),
    glow: val(ctrl.glow),
    aberration: val(ctrl.aberration),
  });
  const note = document.getElementById('note');
  note.textContent = `已写入设置：折射 ${r.maxRefract}px / 带宽 ${r.refractWidth}px / 渗色 ${r.bleedOpacity}% / 高光 ${r.glassGlow}% / 色散 ${r.glassAberration}px（小岛立刻生效；细条要开「细条样式=玻璃」才看得到）`;
  note.style.color = '#a9c4ff';
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') window.lab.close();
});

// 自检用：报告顶部控件是否可点（拖动区里的子元素必须 -webkit-app-region: no-drag，否则点击被吞）
window.__labControls = () => {
  const ids = ['live', 'refresh', 'apply', 'close'];
  const out = {};
  for (const id of ids) {
    const el = document.getElementById(id);
    if (!el) {
      out[id] = 'missing';
      continue;
    }
    const cs = getComputedStyle(el);
    const region = cs.webkitAppRegion || cs.getPropertyValue('-webkit-app-region') || '';
    out[id] = { region: region.trim(), clickable: region.trim() === 'no-drag' };
    if (el.tagName === 'LABEL') {
      const box = el.querySelector('input');
      const r2 = box ? (getComputedStyle(box).webkitAppRegion || box.getPropertyValue('-webkit-app-region') || '') : '';
      out[id].input = r2.trim();
      out[id].clickable = out[id].clickable && r2.trim() === 'no-drag';
    }
  }
  return out;
};

showLabels();
