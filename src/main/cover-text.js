'use strict';
/**
 * 盖板自定义内容：把「模板字符串 + 程序变量」渲染成一行文字，画在传感器盖板窗口上。
 * 纯函数 + 依赖注入（不直接 require electron/settings），自检可直接调。
 *
 * 变量写法 `{名称}`；未知变量渲染成空串（不报错、不留花括号）。
 * 变量清单见 VARS（配置页提示与自检都用它）。
 */

/** 支持的变量（order 用于配置页提示的排序） */
const VARS = [
  { key: 'emoji', desc: '主事件图标', sample: '🎓' },
  { key: 'name', desc: '主事件名称', sample: '高考' },
  { key: 'days', desc: '主事件剩余数（按「日期估算方式」取整）', sample: '12' },
  { key: 'unit', desc: '主事件单位（天/时/分/秒）', sample: '天' },
  { key: 'sub', desc: '主事件更小单位（如 05时20分）', sample: '05时20分' },
  { key: 'date', desc: '主事件目标时间', sample: '2027-06-07 09:00' },
  { key: 'count', desc: '启用中的事件数', sample: '2' },
  { key: 'time', desc: '当前时间 HH:MM', sample: '08:30' },
  { key: 'sec', desc: '当前秒（两位）', sample: '07' },
  { key: 'week', desc: '星期几', sample: '周一' },
  { key: 'subject', desc: '当前节次名', sample: '数学' },
  { key: 'next', desc: '下一节次名', sample: '语文' },
  { key: 'min', desc: '距下一节还有几分钟', sample: '5' },
  { key: 'temp', desc: '当前温度（数字）', sample: '19' },
  { key: 'weather', desc: '天气文案', sample: '小雨' },
  { key: 'city', desc: '城市', sample: '郑州' },
];

const DAY_MS = 86400000;

/** HH:MM（两位） */
function fmtHM(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 周几：周一…周日 */
function dow(d) {
  return '周' + '日一二三四五六'[d.getDay()];
}

/** 天数取整（与渲染层 ui.dayRounding 语义一致：up 不足一天算一天 / round 四舍五入 / 其他向下取整） */
function roundDays(ms, mode) {
  const days = Math.max(0, ms) / DAY_MS;
  if (mode === 'up') return Math.max(1, Math.ceil(days));
  if (mode === 'round') return Math.round(days);
  return Math.floor(days);
}

/** 主时间单位 + 更小单位（与渲染层 timeUnits 一致） */
function timeUnits(ms, dayMode) {
  const t = Math.max(0, ms);
  const totalSec = Math.floor(t / 1000);
  const hh = Math.floor(totalSec / 3600);
  const mm = Math.floor((totalSec % 3600) / 60);
  const ss = totalSec % 60;
  const p = (n) => String(n).padStart(2, '0');
  const sub = [`${p(hh)}时`, `${p(mm)}分`, `${p(ss)}秒`];
  const days = roundDays(t, dayMode);
  if (days >= 1) return { num: days, unit: '天', sub: [`${p(hh)}时`, `${p(mm)}分`, `${p(ss)}秒`] };
  if (hh >= 1) return { num: hh, unit: '时', sub: [`${p(mm)}分`, `${p(ss)}秒`] };
  if (mm >= 1) return { num: mm, unit: '分', sub: [`${p(ss)}秒`] };
  return { num: ss, unit: '秒', sub: [] };
}

/**
 * 主事件挑选（与渲染层 sortedEvents/primaryIndex 同规则）：
 * 只取启用中的；showPast=false 且存在未过期的就先用未过期的；按目标时间升序；
 * 置顶优先；否则取第一个未过期的，全过期则取第一个。
 */
function pickPrimary(events, now, showPast) {
  const ms = (e) => new Date(e.date).getTime() - now.getTime();
  let list = (Array.isArray(events) ? events : []).filter((e) => e && e.enabled !== false);
  if (showPast === false) {
    const future = list.filter((e) => ms(e) > 0);
    if (future.length) list = future;
  }
  list = list.slice().sort((a, b) => new Date(a.date) - new Date(b.date));
  if (!list.length) return null;
  const pin = list.findIndex((e) => e.pinned);
  if (pin !== -1) return list[pin];
  const idx = list.findIndex((e) => ms(e) > 0);
  return list[idx === -1 ? 0 : idx] || null;
}

/**
 * 组装变量表。依赖全部注入：
 *   settings  完整设置（st.events / st.ui / st.schedule 等）
 *   now       当前时间（Date）
 *   curPeriod periodAt() 的结果 | null
 *   nxtPeriod nextPeriod() 的结果 | null
 *   periodLabel(index, name) → 显示名（可选）
 *   weatherSnap weather.loadCache().snapshot | null
 */
function buildContext(deps) {
  const o = deps || {};
  const st = o.settings || {};
  const ui = st.ui || {};
  const now = o.now instanceof Date ? o.now : new Date();
  const events = Array.isArray(st.events) ? st.events : [];
  const primary = pickPrimary(events, now, ui.showPast);
  const remainMs = primary ? new Date(primary.date).getTime() - now.getTime() : null;
  const units = remainMs == null ? null : timeUnits(remainMs, ui.dayRounding);
  const snap = o.weatherSnap || null;
  const cur = o.curPeriod || null;
  const nxt = o.nxtPeriod || null;
  const label = typeof o.periodLabel === 'function' ? o.periodLabel : (i, n) => n || '';
  const curMin = now.getHours() * 60 + now.getMinutes();
  const p = (n) => String(n).padStart(2, '0');
  return {
    emoji: primary ? primary.emoji || '⏰' : '',
    name: primary && primary.name ? String(primary.name) : '',
    days: units ? String(units.num) : '',
    unit: units ? units.unit : '',
    sub: units && units.sub.length ? units.sub[0] : '',
    date: primary && primary.date ? String(primary.date).slice(0, 16).replace('T', ' ') : '',
    count: String(events.filter((e) => e && e.enabled !== false).length),
    time: fmtHM(now),
    sec: p(now.getSeconds()),
    week: dow(now),
    subject: cur ? label(cur.index, cur.period && cur.period.name) : '',
    next: nxt ? label(nxt.index, nxt.period && nxt.period.name) : '',
    min: nxt && !nxt.isTomorrow && typeof nxt.startAt === 'number' ? String(Math.max(0, Math.round(nxt.startAt - curMin))) : '',
    temp: snap && snap.current && snap.current.temp != null ? String(Math.round(snap.current.temp)) : '',
    weather: snap && snap.current ? String(snap.current.text || '') : '',
    city: snap ? String(snap.city || '') : '',
  };
}

/** 渲染模板：{变量} → 值；未知变量 → 空串；空模板 → 空串 */
function renderTemplate(tpl, ctx) {
  const s = String(tpl == null ? '' : tpl);
  if (!s) return '';
  return s.replace(/\{(\w+)\}/g, (_m, k) => {
    const v = ctx ? ctx[k] : null;
    return v == null ? '' : String(v);
  });
}

module.exports = { VARS, fmtHM, dow, roundDays, timeUnits, pickPrimary, buildContext, renderTemplate };
