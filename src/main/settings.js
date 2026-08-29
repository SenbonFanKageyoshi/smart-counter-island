'use strict';
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

/** 默认设置（深合并到用户配置上） */
function defaultEvent() {
  // 默认事件：下一个 6 月 7 日（高考）
  const now = new Date();
  let year = now.getFullYear();
  let target = new Date(year, 5, 7, 9, 0, 0);
  if (target.getTime() <= now.getTime()) {
    year += 1;
    target = new Date(year, 5, 7, 9, 0, 0);
  }
  return {
    id: 'gaokao',
    name: '高考',
    emoji: '🎓',
    color: '#4f7cff',
    date: fmtDate(target),
    enabled: true,
  };
}

function fmtDate(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 一种状态窗口的位置配置 */
function defaultPosition() {
  return { mode: 'top-center', x: null, y: null };
}

const DEFAULTS = {
  version: 3,
  events: [defaultEvent()],
  ui: {
    // 玻璃效果: 'auto'(真实截屏模糊,失败自动回退) | 'fake'(纯 CSS 模拟) | 'off'(关闭,黑底白字)
    glassMode: 'auto',
    // 位置模式（兼容旧版配置；新配置按 positions 分状态设置）
    position: 'top-center',
    // 所在显示器: 'cursor' | 'primary' | 'index'
    display: 'cursor',
    displayIndex: 0,
    // 三种状态窗口各自的独立位置
    positions: {
      strip: defaultPosition(),     // 细条（默认形态）
      expanded: defaultPosition(),  // 放大版灵动岛（操作时展开）
      zoom: defaultPosition(),      // 最大窗口
    },
    customPos: null, // 旧版拖动位置（仅迁移用）
    // 细条样式：'black' 黑底白字（无效果） | 'glass' 跟随玻璃效果
    stripStyle: 'black',
    opacity: { strip: 0.6, expanded: 0.9, zoom: 0.96 },
    alwaysOnTop: true,
    showSeconds: true,
    showPast: false,
    // 可选：文言文显示
    classical: false,
    // 配置窗口暗色模式
    darkMode: false,
  },
  smart: {
    enabled: true,          // 总开关（智能隐藏/透明度/放大）
    hideOnFullscreen: true, // 全屏授课时自动收成细条
    hideOnMaximized: true,  // 前台窗口最大化时保持细条（不展开遮挡）
    expandIdleSec: 4,       // 无操作多少秒后变为放大版（默认窗口）
    zoomIdleSec: 12,        // （保留字段，兼容旧配置）
    zoomEnabled: true,      // 允许最大窗口（手动/拖拽）
    cycleEnabled: false,    // 放大时轮播多个事件
    cycleSec: 6,
    // 系统通知接管
    notifyEnabled: true,    // 检测系统通知并在小岛显示
    notifyShowSec: 8,       // 通知显示时长（秒）
  },
  schedule: {
    enabled: false,         // 时间表（上下课时间）总开关
    cycleWeeks: 1,          // 几周一个循环（1 = 每周相同；2 = 单双周）
    restWeek: 0,            // 循环中第几周休息（0 = 不休；如 cycleWeeks=2, restWeek=2 → 双周休息）
    weeks: [                // cycleWeeks 套周课表；每套 7 天（周一~周日），每天为时间段列表（仅起止时间）
      [
        { periods: [] }, { periods: [] }, { periods: [] },
        { periods: [] }, { periods: [] }, { periods: [] }, { periods: [] },
      ],
    ],
  },
  manual: {
    mode: 'auto', // 'auto' | 'pinned'(固定显示) | 'hidden'(强制隐藏成细条)
  },
};

let cache = null;
let filePath = null;

function settingsPath() {
  if (!filePath) {
    filePath = path.join(app.getPath('userData'), 'settings.json');
    // 旧版目录迁移：项目曾用名 LiquidGlassCounter，首次以新名启动时把旧设置搬过来
    if (!fs.existsSync(filePath)) {
      const oldPath = path.join(app.getPath('appData'), 'LiquidGlassCounter', 'settings.json');
      if (fs.existsSync(oldPath)) {
        try {
          fs.mkdirSync(path.dirname(filePath), { recursive: true });
          fs.copyFileSync(oldPath, filePath);
          console.log('[settings] 已从旧目录迁移设置:', oldPath);
        } catch (e) {
          console.error('[settings] 旧设置迁移失败:', e.message);
        }
      }
    }
  }
  return filePath;
}

function deepMerge(base, patch) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const k of Object.keys(patch || {})) {
    const pv = patch[k];
    const bv = out[k];
    if (pv && typeof pv === 'object' && !Array.isArray(pv) && bv && typeof bv === 'object' && !Array.isArray(bv)) {
      out[k] = deepMerge(bv, pv);
    } else {
      out[k] = pv;
    }
  }
  return out;
}

/** 读取全部设置（含默认值） */
function load() {
  if (cache) return cache;
  let disk = {};
  try {
    if (fs.existsSync(settingsPath())) {
      disk = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
    }
  } catch (e) {
    console.error('[settings] 读取失败，使用默认设置:', e.message);
    disk = {};
  }
  cache = deepMerge(DEFAULTS, disk);
  let migrated = false;
  // 事件必须至少有一个
  if (!Array.isArray(cache.events) || cache.events.length === 0) {
    cache.events = [defaultEvent()];
  } else {
    // 修复历史坏数据：曾因 id 展开顺序错误产生 id 为 null 的事件，补一个唯一 id
    cache.events = cache.events.map((e) => {
      if (!e || !e.id) {
        migrated = true;
        return { ...e, id: `ev_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}` };
      }
      return e;
    });
  }
  // —— 旧版配置迁移 ——
  // v3 起默认窗口固定为放大版（不可更改），旧 defaultState 字段不再使用
  if (cache.ui.defaultState != null) {
    delete cache.ui.defaultState;
    migrated = true;
  }
  if (!cache.ui.positions) {
    cache.ui.positions = { strip: defaultPosition(), expanded: defaultPosition(), zoom: defaultPosition() };
    migrated = true;
  }
  // v2 的 bar 状态 → expanded（放大版灵动岛）
  if (cache.ui.positions.bar && !cache.ui.positions.expanded) {
    cache.ui.positions.expanded = cache.ui.positions.bar;
    migrated = true;
  }
  delete cache.ui.positions.bar;
  // 已移除的 compact（灵动岛）位置 → expanded（放大版灵动岛）
  if (cache.ui.positions.compact) {
    if (!cache.ui.positions.expanded || cache.ui.positions.expanded.mode === 'top-center') {
      cache.ui.positions.expanded = cache.ui.positions.compact;
    }
    delete cache.ui.positions.compact;
    migrated = true;
  }
  if (cache.ui.customPos) {
    const cp = cache.ui.customPos;
    if (cache.ui.positions.expanded && cache.ui.positions.expanded.mode !== 'custom') {
      cache.ui.positions.expanded = { mode: 'custom', x: cp.x, y: cp.y };
      migrated = true;
    }
    cache.ui.customPos = null;
  }
  if (cache.ui.position && cache.ui.position !== 'top-center') {
    for (const key of Object.keys(cache.ui.positions)) {
      const p = cache.ui.positions[key];
      if (!p || (p.mode === 'top-center' && p.x == null)) {
        cache.ui.positions[key] = { mode: cache.ui.position, x: null, y: null };
        migrated = true;
      }
    }
  }
  // v2 透明度 bar → expanded；已移除的 compact 透明度 → expanded
  if (cache.ui.opacity && cache.ui.opacity.bar != null && cache.ui.opacity.expanded == null) {
    cache.ui.opacity.expanded = cache.ui.opacity.bar;
    migrated = true;
  }
  delete cache.ui.opacity.bar;
  if (cache.ui.opacity && cache.ui.opacity.compact != null && cache.ui.opacity.expanded == null) {
    cache.ui.opacity.expanded = cache.ui.opacity.compact;
    migrated = true;
  }
  delete cache.ui.opacity.compact;
  // —— 时间表结构迁移：旧版（单周 7 天带 name）→ 新版（多周循环，每天仅 periods）——
  if (cache.schedule) {
    const oldWeeks = cache.schedule.weeks;
    if (Array.isArray(oldWeeks) && oldWeeks.length === 7 && oldWeeks[0] && oldWeeks[0].name != null) {
      cache.schedule.weeks = [oldWeeks.map((d) => ({ periods: Array.isArray(d.periods) ? d.periods.map((p) => ({ start: p.start, end: p.end })) : [] }))];
      if (cache.schedule.cycleWeeks == null) cache.schedule.cycleWeeks = 1;
      if (cache.schedule.restWeek == null) cache.schedule.restWeek = 0;
      migrated = true;
    }
    // 旧版课程名 label 移除（仅保留 start/end）
    for (const week of cache.schedule.weeks || []) {
      for (const day of week || []) {
        if (Array.isArray(day.periods)) {
          day.periods = day.periods.map((p) => ({ start: p && p.start, end: p && p.end }));
        }
      }
    }
    if (cache.schedule.cycleWeeks == null) cache.schedule.cycleWeeks = 1;
    if (cache.schedule.restWeek == null) cache.schedule.restWeek = 0;
    if (!Array.isArray(cache.schedule.weeks) || cache.schedule.weeks.length === 0) {
      cache.schedule.weeks = [new Array(7).fill(null).map(() => ({ periods: [] }))];
      migrated = true;
    }
  }
  if (migrated) save();
  return cache;
}

/** 深合并保存补丁，返回新设置 */
function update(patch) {
  const cur = load();
  cache = deepMerge(cur, patch);
  save();
  return cache;
}

function save() {
  try {
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    fs.writeFileSync(settingsPath(), JSON.stringify(cache, null, 2), 'utf8');
  } catch (e) {
    console.error('[settings] 保存失败:', e.message);
  }
}

function events() {
  return load().events || [];
}

function upsertEvent(ev) {
  const list = events();
  const i = list.findIndex((x) => x.id === ev.id);
  if (i >= 0) list[i] = { ...list[i], ...ev };
  // 注意展开顺序：先 ev 后 id，避免 ev.id 为 null 时覆盖新生成的 id
  else list.push({ ...ev, id: ev.id || `ev_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}` });
  update({ events: list });
}

function removeEvent(id) {
  update({ events: (events() || []).filter((x) => x.id !== id) });
}

module.exports = { load, update, save, events, upsertEvent, removeEvent, defaultEvent, fmtDate, DEFAULTS };
