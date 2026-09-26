'use strict';
/**
 * 传感器避让几何（纯函数，便于单测）
 *
 * 规格要点：
 *   - 传感器（挖孔摄像头）坐标物理固定，永不移动，内容是禁区外的客人；
 *   - 黑色背景可以覆盖传感器，内容不行（content rect ∩ forbidden_zone = ∅）；
 *   - split 布局：中间 [zone.x, zone.x + zone.w] 区间不放任何内容；
 *   - below 布局：内容 top ≥ zone.y + zone.h - islandTop（相对灵动岛）。
 *
 * 坐标：传感器用「dx 相对屏幕水平中心（右为正）, y 距屏幕顶边, 直径」，单位是屏幕 DIP。
 * 这样预设在任何分辨率/任何屏幕上都能用（小岛仍停在它自己的位置，只是内容绕开传感器）。
 */

/** 传感器一行一个：dx,y,直径 */
const DEFAULT_SENSORS = '-32,24,13; -7,26,10; 29,24,14';
/** 手动禁区默认矩形（相对屏幕水平中心） */
const DEFAULT_ZONE = { x: -39, y: 6, w: 92, h: 28 };

/**
 * 位置预设（只保留一个）：中置传感器 = iPhone 灵动岛那组三传感器
 * （红外镜头 / 点阵投影器 / 前置摄像头，屏幕宽按 390 折算成「相对屏幕水平中心」的偏移）。
 */
const PRESETS = {
  center: { sensors: '-32,24,13; -7,26,10; 29,24,14', zone: { x: -39, y: 6, w: 92, h: 28 } },
};
const DEFAULT_PRESET = 'center';

/** 读取预设（未知名字回落到中置传感器） */
function applyPreset(key) {
  const p = PRESETS[key] || PRESETS[DEFAULT_PRESET];
  return { preset: PRESETS[key] ? key : DEFAULT_PRESET, sensors: p.sensors, zone: { ...p.zone } };
}

/** 解析「dx,y,直径」列表（一行一个，逗号/空格分隔，也接受分号）——非法行直接忽略 */
function parseSensors(text) {
  const out = [];
  for (const raw of String(text == null ? '' : text).split(/[;\n\r]+/)) {
    const line = raw.trim();
    if (!line || line[0] === '#') continue;
    const p = line.split(/[,\s]+/).map((v) => parseFloat(v));
    if (p.length < 3 || !isFinite(p[0]) || !isFinite(p[1]) || !isFinite(p[2]) || p[2] <= 0) continue;
    out.push({ id: 's' + (out.length + 1), dx: p[0], y: p[1], d: p[2] });
  }
  return out;
}

/** 序列化回文本（改「直径/偏移/距顶」时用） */
function formatSensors(list) {
  return (list || []).map((s) => `${Math.round(s.dx)},${Math.round(s.y)},${Math.round(s.d)}`).join('; ');
}

/** 传感器并集 + 空隙 → 禁区矩形（相对屏幕水平中心） */
function sensorsZone(list, margin) {
  if (!list || !list.length) return null;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const s of list) {
    x0 = Math.min(x0, s.dx - s.d / 2);
    x1 = Math.max(x1, s.dx + s.d / 2);
    y0 = Math.min(y0, s.y - s.d / 2);
    y1 = Math.max(y1, s.y + s.d / 2);
  }
  const m = Math.max(0, Number(margin) || 0);
  const r10 = (v) => Math.round(v * 10) / 10;
  return { x: r10(x0 - m), y: r10(y0 - m), w: r10(x1 - x0 + 2 * m), h: r10(y1 - y0 + 2 * m) };
}

/** 规格 → 禁区矩形（相对屏幕水平中心） */
function resolveZone(cfg) {
  const c = cfg || {};
  if (c.zoneMode === 'manual') {
    const z = c.zone || DEFAULT_ZONE;
    return {
      x: Number(z.x) || 0,
      y: Number(z.y) || 0,
      w: Math.max(1, Number(z.w) || 0),
      h: Math.max(1, Number(z.h) || 0),
    };
  }
  return sensorsZone(parseSensors(c.sensors), c.margin) || null;
}

/** 禁区底边相对「黑底顶边」的距离（below 布局里内容至少要退到这条线以下） */
function belowTop(zone, islandTop) {
  if (!zone) return 0;
  return Math.max(0, Math.round((zone.y + zone.h - islandTop) * 10) / 10);
}

/**
 * 内容布局选择（规格 layout_rules）：
 *   'split' 左右布局（内容放禁区左右两侧，中间空出禁区）
 *   'below' 下方布局（内容从禁区底边下方开始 —— 横幅/大卡片都往传感器下方长）
 *   'none'  不显示内容（禁区不在小岛上，或该状态不需要内容）
 * 手动指定 split/below 时直接用；'auto' 时按状态判断：
 *   细条只能左右分（太薄，下方放不下），其余（横幅 / 倒计时窗口 / 通知）一律走下方布局。
 */
function pickLayout(want, state, pillH, top) {
  if (want === 'split' || want === 'below' || want === 'none') return want;
  if (state === 'strip') return 'split';
  return 'below';
}

module.exports = {
  DEFAULT_SENSORS,
  DEFAULT_ZONE,
  PRESETS,
  DEFAULT_PRESET,
  applyPreset,
  parseSensors,
  formatSensors,
  sensorsZone,
  resolveZone,
  belowTop,
  pickLayout,
};
