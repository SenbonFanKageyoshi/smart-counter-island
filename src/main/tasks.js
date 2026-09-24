'use strict';
/* 提醒与计划任务
   - 定时提醒 / 定时关机 / 运行命令：老师手动配的条目（30 秒粒度检查）
   - 课堂提醒：由「时间表」自动驱动（课前 N 分钟 / 上课 / 下课前 N 分钟 / 下课），
     不需要一条条配；与系统通知的免打扰互不影响（课堂提醒属于教学刚需，必须弹）
   两套提醒共用同一份课表计算（./schedule），避免各写一套解析 */
const { exec } = require('child_process');
const settings = require('./settings');
const sched = require('./schedule');

const TASK_NAMES = {
  shutdown: '定时关机',
  command: '运行命令',
  remind: '定时提醒',
};

const parseHM = sched.parseHM;
const fmtHM = sched.fmtHM;
const localDate = sched.localDate;

function dayMatch(days, now) {
  if (days === 'daily') return true;
  if (days === 'once') return true;
  if (Array.isArray(days)) {
    const dow = (now.getDay() + 6) % 7; // 周一=0
    return days.includes(dow);
  }
  return true;
}

/**
 * 任务在指定时刻的触发点：'run'（正常执行）| 'remind'（关机前提醒）| 'shutdown'（到点关机）| null（不触发）
 * 关机任务有两个触发点：提前 remindMin 分钟提醒、到点执行关机；当天已取消则整体跳过。
 */
function trigger(task, now) {
  if (!task || task.enabled === false) return null;
  const cur = now.getHours() * 60 + now.getMinutes();
  // 关机任务当天已取消：跳过（提醒与关机都不再触发）
  if (task.type === 'shutdown' && task.cancelUntil === localDate(now)) return null;
  if (!dayMatch(task.days, now)) return null;
  if (task.type === 'shutdown') {
    const shutMin = parseHM(task.time);
    if (shutMin == null) return null;
    const remindMin = ((shutMin - (parseInt(task.remindMin, 10) || 5)) % 1440 + 1440) % 1440; // 跨天取模
    if (cur === shutMin) return 'shutdown';
    if (cur === remindMin) return 'remind';
    return null;
  }
  const hm = fmtHM(cur);
  if (task.time !== hm) return null;
  return 'run';
}

// 防重复触发：检查粒度 30 秒 < 1 分钟，同一任务同一触发点在同一分钟内可能被检查两次
// （如 20:00:10 与 20:00:40），记录"已执行的分钟 + 触发点"，同分钟内只执行一次
let firedMinute = '';
const firedKeys = new Set();

/**
 * 检查并执行到期任务。execFn 可注入（测试用）：(task, trigger, now) => void
 * 返回本次触发列表：[{ task, trigger }]
 */
function checkTasks(now, execFn) {
  const minKey = `${localDate(now)} ${fmtHM(now.getHours() * 60 + now.getMinutes())}`;
  if (minKey !== firedMinute) {
    firedMinute = minKey;
    firedKeys.clear();
  }
  const st = settings.load();
  const list = Array.isArray(st.tasks) ? st.tasks : [];
  const executed = [];
  const changed = [];
  const doExec = execFn || defaultExec;
  for (const task of list) {
    const tr = trigger(task, now);
    if (!tr) continue;
    const key = `${task.id}:${tr}`;
    if (firedKeys.has(key)) continue; // 同一任务同一触发点在同一分钟内只执行一次
    firedKeys.add(key);
    executed.push({ task, trigger: tr });
    doExec(task, tr, now);
    // 一次性任务：在最终执行点删除（提醒类型在提醒时删除；关机类型在关机时删除）
    const finalPoint = task.type === 'shutdown' ? tr === 'shutdown' : tr === 'run';
    if (task.days === 'once' && finalPoint) changed.push(task.id);
  }
  if (changed.length) {
    settings.update({ tasks: list.filter((t) => !changed.includes(t.id)) });
  }
  return executed;
}

/** 默认执行动作 */
function defaultExec(task, triggerPoint, now) {
  const island = require('./island');
  switch (task.type) {
    case 'shutdown':
      if (triggerPoint === 'remind') {
        const min = parseInt(task.remindMin, 10) || 5;
        island.showNotification('关机提醒', `电脑将在 ${min} 分钟后自动关机（${task.time}）`, {
          alert: true, // 提醒类：文字高频模糊抖动
          keywords: ['关机'],
          btn: { label: '取消关机', act: 'cancel-shutdown' },
        });
      } else {
        // 到点关机：60 秒倒计时，期间仍可取消（shutdown /a）
        exec('shutdown /s /t 60', (err) => {
          if (err) island.showNotification('定时关机失败', String(err.message || err));
        });
        island.showNotification('自动关机', '电脑将于 60 秒后关机', {
          alert: true,
          keywords: ['关机'],
          btn: { label: '取消关机', act: 'cancel-shutdown' },
        });
      }
      break;
    case 'command':
      if (task.command) {
        exec(task.command, { windowsHide: true }, (err) => {
          if (err) island.showNotification('计划任务执行失败', task.command + '\n' + String(err.message || err));
        });
      }
      break;
    case 'remind':
      island.showNotification('定时提醒', task.message || '时间到', { alert: true });
      break;
    default:
      break;
  }
}

/** 取消自动关机：执行 shutdown /a 并标记所有关机任务当天取消（取消后当天不再提醒/关机） */
function cancelShutdowns() {
  const island = require('./island');
  exec('shutdown /a', (err) => {
    if (err && /没有要取消的关机|There is no shutdown/i.test(String(err.message || err))) {
      // 无待取消的关机：仍标记当天取消（防止提醒后未到点又重复触发）
    }
    island.showNotification('已取消', '本次自动关机已取消');
  });
  const st = settings.load();
  const today = localDate(new Date());
  const tasks = (st.tasks || []).map((t) => (t.type === 'shutdown' ? { ...t, cancelUntil: today } : t));
  settings.update({ tasks });
}

/* ---------------- 课堂提醒（时间表驱动） ---------------- */

let classFiredKeys = new Set();

/** 默认动作：弹一条提醒通知（教学刚需，不受系统通知免打扰影响） */
function defaultClassExec(r) {
  const island = require('./island');
  island.showNotification(r.title, r.body, { alert: true, keywords: ['上课', '下课'] });
}

/**
 * 检查并按需弹出课堂提醒。execFn 可注入（测试用）：(reminder) => void
 * 返回本次触发的提醒列表（已去重：同一天同一节同一触发点只提醒一次）
 */
function checkClassReminders(now, execFn) {
  const st = settings.load();
  const cfg = (st.schedule && st.schedule.notify) || {};
  if (cfg.enabled === false) return [];
  const fired = sched.classReminders(now, st.schedule, cfg);
  const out = [];
  for (const r of fired) {
    const key = sched.reminderKey(r);
    if (classFiredKeys.has(key)) continue;
    classFiredKeys.add(key);
    out.push(r);
    (execFn || defaultClassExec)(r);
  }
  // 换天清理去重表，避免无限增长
  if (classFiredKeys.size > 200) {
    const today = localDate(now);
    const yKey = localDate(new Date(now.getTime() - 86400000));
    for (const k of Array.from(classFiredKeys)) {
      if (!k.startsWith(today) && !k.startsWith(yKey)) classFiredKeys.delete(k);
    }
  }
  return out;
}

/** 清空课堂提醒去重状态（测试用） */
function resetClassReminders() {
  classFiredKeys = new Set();
}

/** 课表摘要（配置页预览用）：当前这节 + 下一节（只返回可序列化数据，IPC 不能传函数） */
function classPreview(now) {
  const st = settings.load();
  const s = st.schedule || {};
  const cur = sched.periodAt(s, now);
  const nxt = sched.nextPeriod(s, now);
  return {
    enabled: !!s.enabled,
    current: cur ? { label: sched.periodLabel(cur.index, cur.period.name), start: cur.period.start, end: cur.period.end } : null,
    next: nxt
      ? {
          label: sched.periodLabel(nxt.index, nxt.period.name),
          start: nxt.period.start,
          inMin: nxt.isTomorrow ? null : Math.max(0, Math.round(nxt.startAt - (now.getHours() * 60 + now.getMinutes()))),
          isTomorrow: !!nxt.isTomorrow,
        }
      : null,
  };
}

module.exports = {
  TASK_NAMES,
  parseHM,
  fmtHM,
  localDate,
  trigger,
  checkTasks,
  cancelShutdowns,
  checkClassReminders,
  resetClassReminders,
  classPreview,
  sched,
};
