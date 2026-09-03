'use strict';
/* 计划任务：定时关机 / 运行命令 / 定时提醒
   - 定时关机：提醒文案固定（不可自定义），可设置「关机前几分钟提醒」；
     提醒与关机时通知均带「取消关机」按钮，取消后当天不再触发
   - 程序运行期间由本模块定时检查执行（30 秒粒度） */
const { exec } = require('child_process');
const settings = require('./settings');

const TASK_NAMES = {
  shutdown: '定时关机',
  command: '运行命令',
  remind: '定时提醒',
};

function parseHM(s) {
  const m = String(s || '').match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

function fmtHM(min) {
  const t = ((Math.round(min) % 1440) + 1440) % 1440;
  return String(Math.floor(t / 60)).padStart(2, '0') + ':' + String(t % 60).padStart(2, '0');
}

function localDate(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

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

module.exports = { TASK_NAMES, parseHM, fmtHM, localDate, trigger, checkTasks, cancelShutdowns };
