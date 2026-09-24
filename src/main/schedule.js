'use strict';
/* 课表计算（唯一数据源）：时间表相关的所有数学都放这里，供
     - 配置页预览（当前/下一节）
     - 免打扰截止时间（island.computeDndUntil）
     - 课堂提醒（tasks.checkClassReminders）
   使用，避免各处各写一套解析逻辑。

   数据结构：schedule = {
     enabled, cycleWeeks, restWeek,
     weeks: [ [ {periods:[{start:'HH:MM', end:'HH:MM', name?:'数学'}] } ×7 ] ],
     notify: { enabled, beforeStart, atStart, beforeEnd, atEnd, template* }
   }
   周索引：0 = 周一 … 6 = 周日（与配置页一致） */

/** 'HH:MM' → 当日分钟数；非法返回 null */
function parseHM(s) {
  const m = String(s || '').match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** 分钟数 → 'HH:MM'（自动跨天取模） */
function fmtHM(min) {
  const t = ((Math.round(min) % 1440) + 1440) % 1440;
  return String(Math.floor(t / 60)).padStart(2, '0') + ':' + String(t % 60).padStart(2, '0');
}

/** 本地日期键 YYYY-MM-DD */
function localDate(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** ISO 周号（用于几周一休循环） */
function isoWeek(d) {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  return Math.ceil(((date - yearStart) / 86400000 + 1) / 7);
}

/** 周一=0 … 周日=6 */
function weekdayIndex(d) {
  return (d.getDay() + 6) % 7;
}

/** 该日期落在循环里的第几套周课表（0-based） */
function cycleWeekIndex(sched, d) {
  const cycle = Math.max(1, parseInt(sched && sched.cycleWeeks, 10) || 1);
  return ((isoWeek(d) - 1) % cycle + cycle) % cycle;
}

/** 该日期是否为「休息周」（休息周只是少排课，不改变解析规则） */
function isRestWeek(sched, d) {
  const rest = parseInt(sched && sched.restWeek, 10) || 0;
  return rest > 0 && cycleWeekIndex(sched, d) === rest - 1;
}

/**
 * 某天的课表（按开始时间排序，附 1-based 节次与跨午夜后的绝对结束分钟）
 * 返回 [{ index, start, end, startMin, endMin, name }]，endMin 可能 > 1440（跨午夜）
 */
function dayPeriods(sched, d) {
  if (!sched || !sched.enabled) return [];
  const weeks = Array.isArray(sched.weeks) ? sched.weeks : [];
  if (!weeks.length) return [];
  const week = weeks[cycleWeekIndex(sched, d)] || weeks[0];
  const day = Array.isArray(week) ? week[weekdayIndex(d)] : null;
  const list = day && Array.isArray(day.periods) ? day.periods : [];
  const out = [];
  for (const p of list) {
    const s = parseHM(p && p.start);
    const e = parseHM(p && p.end);
    if (s == null || e == null) continue;
    out.push({ start: p.start, end: p.end, startMin: s, endMin: e <= s ? e + 1440 : e, name: String((p && p.name) || '').trim() });
  }
  out.sort((a, b) => a.startMin - b.startMin);
  out.forEach((p, i) => {
    p.index = i + 1;
  });
  return out;
}

/** 当前正在上的那一节（含跨午夜）→ { period, index, endAt } | null */
function periodAt(sched, d) {
  const cur = d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60;
  // 今天的课
  for (const p of dayPeriods(sched, d)) {
    if (cur >= p.startMin && cur < p.endMin) return { period: p, index: p.index, endAt: p.endMin };
  }
  // 昨天的跨午夜课（例如 23:30→00:01）
  const y = new Date(d.getTime() - 86400000);
  for (const p of dayPeriods(sched, y)) {
    if (p.endMin > 1440 && cur + 1440 >= p.startMin && cur + 1440 < p.endMin) {
      return { period: p, index: p.index, endAt: p.endMin - 1440 };
    }
  }
  return null;
}

/** 下一节课（今天剩下的；没有则 null）→ { period, index, startAt, isTomorrow } */
function nextPeriod(sched, d) {
  const cur = d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60;
  const today = dayPeriods(sched, d).filter((p) => p.startMin > cur);
  if (today.length) return { period: today[0], index: today[0].index, startAt: today[0].startMin, isTomorrow: false };
  // 往后找 7 天内的第一节（跳过休息日/空课表）
  for (let i = 1; i <= 7; i++) {
    const nd = new Date(d.getTime() + i * 86400000);
    const list = dayPeriods(sched, nd);
    if (list.length) return { period: list[0], index: list[0].index, startAt: list[0].startMin, isTomorrow: true, inDays: i };
  }
  return null;
}

/** 节次标签：「第 3 节 数学」/「第 3 节」 */
function periodLabel(index, name) {
  const n = String(name || '').trim();
  return n ? `第 ${index} 节 ${n}` : `第 ${index} 节`;
}

/** 模板填充：{n} 节次 / {subject} 科目 / {label} 第N节+科目 / {min} 分钟 / {time} 时刻 */
function fillTemplate(tpl, vars) {
  return String(tpl == null ? '' : tpl)
    .replace(/\{n\}/g, String(vars.n == null ? '' : vars.n))
    .replace(/\{subject\}/g, String(vars.subject || ''))
    .replace(/\{label\}/g, String(vars.label || ''))
    .replace(/\{min\}/g, String(vars.min == null ? '' : vars.min))
    .replace(/\{time\}/g, String(vars.time || ''))
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * 某个时刻应该弹出的课堂提醒（纯函数，不含去重状态）
 * cfg = schedule.notify；返回 [{ kind, index, period, subject, min, at, title, body, dayKey }]
 *   kind: beforeStart | atStart | beforeEnd | atEnd
 *   min ：before* 的提前分钟数（模板里用 {min}）
 */
function classReminders(d, sched, cfg) {
  const c = cfg || {};
  if (!sched || !sched.enabled || c.enabled === false) return [];
  const cur = d.getHours() * 60 + d.getMinutes();
  const dayKey = localDate(d);
  const out = [];
  const push = (kind, p, min, title, tpl) => {
    out.push({
      kind,
      index: p.index,
      period: p,
      subject: p.name,
      min,
      at: kind === 'beforeStart' || kind === 'atStart' ? p.startMin : p.endMin,
      title,
      body: fillTemplate(tpl, { n: p.index, subject: p.name, label: periodLabel(p.index, p.name), min, time: fmtHM(kind === 'beforeStart' || kind === 'atStart' ? p.startMin : p.endMin) }),
      dayKey,
    });
  };
  const beforeStart = Math.max(0, parseInt(c.beforeStart, 10) || 0);
  const beforeEnd = Math.max(0, parseInt(c.beforeEnd, 10) || 0);
  // 今天：开始相关的提醒 + 当天结束的提醒
  for (const p of dayPeriods(sched, d)) {
    if (beforeStart > 0 && cur === p.startMin - beforeStart) push('beforeStart', p, beforeStart, '快上课了', c.templateStart);
    if (c.atStart === true && cur === p.startMin) push('atStart', p, 0, '上课', c.templateAtStart);
    if (p.endMin <= 1440) {
      if (beforeEnd > 0 && cur === p.endMin - beforeEnd) push('beforeEnd', p, beforeEnd, '快下课了', c.templateBeforeEnd);
      if (c.atEnd === true && cur === p.endMin) push('atEnd', p, 0, '下课', c.templateAtEnd);
    }
  }
  // 昨天的跨午夜课：只在今天凌晨补下课提醒（dayKey 仍记昨天，避免重复）
  const y = new Date(d.getTime() - 86400000);
  const yKey = localDate(y);
  for (const p of dayPeriods(sched, y)) {
    if (p.endMin <= 1440) continue;
    const endToday = p.endMin - 1440;
    if (beforeEnd > 0 && cur === endToday - beforeEnd) {
      out.push({
        kind: 'beforeEnd', index: p.index, period: p, subject: p.name, min: beforeEnd, at: endToday,
        title: '快下课了',
        body: fillTemplate(c.templateBeforeEnd, { n: p.index, subject: p.name, min: beforeEnd, time: fmtHM(endToday) }),
        dayKey: yKey,
      });
    }
    if (c.atEnd === true && cur === endToday) {
      out.push({
        kind: 'atEnd', index: p.index, period: p, subject: p.name, min: 0, at: endToday,
        title: '下课',
        body: fillTemplate(c.templateAtEnd, { n: p.index, subject: p.name, min: 0, time: fmtHM(endToday) }),
        dayKey: yKey,
      });
    }
  }
  return out;
}

/** 去重键：同一天同一节同一触发点只提醒一次 */
function reminderKey(r) {
  return `${r.dayKey}|${r.kind}|p${r.index}`;
}

module.exports = {
  parseHM,
  fmtHM,
  localDate,
  isoWeek,
  weekdayIndex,
  cycleWeekIndex,
  isRestWeek,
  dayPeriods,
  periodAt,
  nextPeriod,
  periodLabel,
  fillTemplate,
  classReminders,
  reminderKey,
};
