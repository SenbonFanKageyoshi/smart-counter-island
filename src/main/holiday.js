'use strict';
/**
 * 节假日倒计时（纯逻辑，依赖注入，便于自检）：
 *   - 从节假日表里挑出「下一个还没到的」
 *   - 按「还剩多长时间开启倒计时」（leadDays）判断该不该进计时坞
 * 节假日表由设置里的 items 提供（{ name, date }），日期用本地时区的 YYYY-MM-DD（当天 00:00 起算）。
 */

const DAY_MS = 86400000;

/** 解析日期：'YYYY-MM-DD' 或 'YYYY-MM-DDTHH:mm' → Date（本地时区）；非法返回 null */
function parseDate(s) {
  const str = String(s == null ? '' : s).trim();
  if (!str) return null;
  const m = str.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{2}))?/);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] || 0), Number(m[5] || 0), 0, 0);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** 距离目标还有几天（向上取整：不足一天算一天；已过返回负数） */
function daysLeft(target, now) {
  return Math.ceil((target.getTime() - now.getTime()) / DAY_MS);
}

/** 下一个还没到的节假日（按时间升序）；全过期返回 null */
function nextHoliday(items, now) {
  const t = now instanceof Date ? now : new Date();
  const list = (Array.isArray(items) ? items : [])
    .map((it) => ({ name: String((it && it.name) || '').trim(), at: parseDate(it && it.date) }))
    .filter((it) => it.name && it.at)
    .filter((it) => it.at.getTime() >= t.getTime() - 0) // 当天也算（0 点后仍在今天）
    .sort((a, b) => a.at - b.at);
  if (!list.length) return null;
  const h = list[0];
  return { name: h.name, at: h.at, days: daysLeft(h.at, t) };
}

/** 该不该进计时坞：开启了节假日倒计时，且下一个节假日进入 leadDays 窗口 */
function dueHoliday(st, now) {
  const cfg = (st && st.holidays) || {};
  if (cfg.enabled !== true) return null;
  const lead = Math.max(0, Math.min(3650, parseInt(cfg.leadDays, 10) || 0));
  const skip = Array.isArray(cfg.skipped) ? cfg.skipped : [];
  const list = (Array.isArray(cfg.items) ? cfg.items : []).filter((it) => !skip.includes(`${it && it.name}|${it && it.date}`));
  const h = nextHoliday(list, now);
  if (!h) return null;
  if (h.days < 0) return null;
  if (lead > 0 && h.days > lead) return null; // 还早 → 不进坞
  return h;
}

/** 计时坞文案：{ title: '距离 春节', num: '12', unit: '天', date: '2027-02-06' } */
function dockText(h) {
  if (!h) return null;
  const p = (n) => String(n).padStart(2, '0');
  const at = h.at;
  return {
    title: `距离 ${h.name}`,
    num: String(Math.max(0, h.days)),
    unit: '天',
    date: `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())}`,
  };
}

module.exports = { DAY_MS, parseDate, daysLeft, nextHoliday, dueHoliday, dockText };
