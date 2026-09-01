'use strict';
/* ===== 配置窗口逻辑 ===== */

const $ = (s) => document.querySelector(s);

let S = null; // 完整设置

/* ---------- 错误兜底显示（便于排查渲染层问题） ---------- */

function showErr(msg) {
  const box = $('#errbox');
  if (!box) return;
  box.hidden = false;
  box.textContent += (box.textContent ? '\n' : '') + msg;
}
window.addEventListener('error', (e) => showErr('[错误] ' + (e.message || String(e.error))));
window.addEventListener('unhandledrejection', (e) => showErr('[异步错误] ' + (e.reason && e.reason.message ? e.reason.message : String(e.reason))));
window.addEventListener('load', () => {
  if (!window.config) showErr('[致命] preload 未加载：window.config 不存在');
});

/* ---------- 工具 ---------- */

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg || '已保存';
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), 1200);
}

/** 局部更新（主进程深合并 + 立即生效） */
async function patch(p) {
  S = await window.config.update(p);
  toast();
}

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function daysLeft(iso) {
  const ms = new Date(iso).getTime() - Date.now();
  return { ms, d: Math.floor(ms / 86400000) };
}

function fmtDateCN(iso) {
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function localInputValue(iso) {
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/* ---------- 初始化 ---------- */

async function init() {
  const data = await window.config.get();
  S = data.settings;
  $('#ver').textContent = `v${data.meta.version} · ${data.meta.platform === 'win32' ? 'Windows' : data.meta.platform} ${data.meta.osRelease}`;
  $('#about-ver').textContent = `版本 v${data.meta.version} · Electron ${data.meta.electron}`;

  // 显示设置
  $('#glassMode').value = S.ui.glassMode;
  $('#stripStyle').value = S.ui.stripStyle === 'glass' ? 'glass' : 'black';
  $('#darkMode').checked = !!S.ui.darkMode;
  applyDarkMode(S.ui.darkMode);
  $('#display').value = S.ui.display;
  $('#displayIndex').value = S.ui.displayIndex ?? 0;
  $('#display-index-wrap').hidden = S.ui.display !== 'index';
  $('#opStrip').value = Math.round((S.ui.opacity.strip ?? 0.6) * 100);
  $('#opExpanded').value = Math.round((S.ui.opacity.expanded ?? 0.9) * 100);
  $('#opZoom').value = Math.round((S.ui.opacity.zoom ?? 0.96) * 100);
  $('#alwaysOnTop').checked = !!S.ui.alwaysOnTop;
  $('#showSeconds').checked = !!S.ui.showSeconds;
  $('#showPast').checked = !!S.ui.showPast;
  $('#classical').checked = !!S.ui.classical;

  // 三种状态的位置
  const states = ['strip', 'expanded', 'zoom'];
  for (const st of states) {
    const pos = (S.ui.positions || {})[st] || {};
    const mode = pos.mode || 'top-center';
    const modeEl = $(`#pos-${st}-mode`);
    const xEl = $(`#pos-${st}-x`);
    const yEl = $(`#pos-${st}-y`);
    if (modeEl) modeEl.value = mode;
    if (xEl) xEl.value = pos.x != null ? pos.x : '';
    if (yEl) yEl.value = pos.y != null ? pos.y : '';
    syncPosXY(st);
  }

  // 智能行为
  $('#smartEnabled').checked = !!S.smart.enabled;
  $('#notifyEnabled').checked = S.smart.notifyEnabled !== false;
  $('#notifyShowSec').value = S.smart.notifyShowSec ?? 8;
  $('#hideOnMaximized').checked = S.smart.hideOnMaximized !== false;
  $('#expandIdleSec').value = S.smart.expandIdleSec;
  $('#zoomIdleSec').value = S.smart.zoomIdleSec ?? 0;
  $('#zoomEnabled').checked = !!S.smart.zoomEnabled;
  $('#cycleEnabled').checked = !!S.smart.cycleEnabled;
  $('#cycleSec').value = S.smart.cycleSec;
  const mm = document.querySelector(`input[name="manualMode"][value="${S.manual.mode}"]`);
  if (mm) mm.checked = true;

  // 时间表
  $('#scheduleEnabled').checked = !!(S.schedule && S.schedule.enabled);
  renderSchedule();

  // 定时任务
  renderTasks();

  renderEvents();
}

/** 应用暗色模式（body.dark 驱动 CSS 变量覆盖） */
function applyDarkMode(on) {
  document.body.classList.toggle('dark', !!on);
}

/* ---------- 位置控件 ---------- */

function syncPosXY(st) {
  const modeEl = $(`#pos-${st}-mode`);
  const row = modeEl ? modeEl.closest('.pos-row') : null;
  if (!row) return;
  const custom = modeEl.value === 'custom';
  row.querySelectorAll('.pos-xy').forEach((el) => {
    el.style.visibility = custom ? 'visible' : 'hidden';
  });
}

['strip', 'expanded', 'zoom'].forEach((st) => {
  const modeEl = $(`#pos-${st}-mode`);
  if (modeEl) {
    modeEl.addEventListener('change', () => {
      syncPosXY(st);
      patch({ ui: { positions: { [st]: { mode: modeEl.value } } } });
    });
  }
  const xEl = $(`#pos-${st}-x`);
  const yEl = $(`#pos-${st}-y`);
  if (xEl) {
    xEl.addEventListener('input', () => patch({ ui: { positions: { [st]: { mode: 'custom', x: parseInt(xEl.value, 10) || 0 } } } }));
  }
  if (yEl) {
    yEl.addEventListener('input', () => patch({ ui: { positions: { [st]: { mode: 'custom', y: parseInt(yEl.value, 10) || 0 } } } }));
  }
});

/* ---------- 时间表管理 ---------- */

const DAY_NAMES = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

/** 复制模式：null 或 { type:'day'|'week', wi, di? } —— 两次点击完成复制（点源 → 点目标） */
let copyMode = null;

/** 立即保存时间表（添加/删除/复制等按钮操作不等防抖，减少被 onChanged 刷新覆盖的窗口期） */
function saveScheduleNow() {
  clearTimeout(scheduleChanged._t);
  patch({ schedule: S.schedule });
}

function isRestWeek(wi) {
  const rest = S.schedule && S.schedule.restWeek;
  return rest > 0 && wi === rest - 1;
}

/** 规范化时间表结构：确保 weeks 有 cycleWeeks 套、每套 7 天 */
function normSchedule(sched) {
  sched = sched || {};
  const cycle = Math.max(1, parseInt(sched.cycleWeeks, 10) || 1);
  const rest = parseInt(sched.restWeek, 10) || 0;
  const weeks = Array.isArray(sched.weeks) ? sched.weeks : [];
  const blankWeek = () => new Array(7).fill(null).map(() => ({ periods: [] }));
  while (weeks.length < cycle) weeks.push(blankWeek());
  for (let wi = 0; wi < cycle; wi++) {
    if (!Array.isArray(weeks[wi]) || weeks[wi].length !== 7) {
      weeks[wi] = wi === 0 ? blankWeek() : weeks[0].map((d) => ({ periods: (d.periods || []).map((p) => ({ ...p })) }));
    }
    for (let di = 0; di < 7; di++) {
      if (!weeks[wi][di] || !Array.isArray(weeks[wi][di].periods)) weeks[wi][di] = { periods: [] };
    }
  }
  sched.weeks = weeks;
  sched.cycleWeeks = cycle;
  sched.restWeek = rest;
  return sched;
}

function renderSchedule() {
  S.schedule = normSchedule(S.schedule);
  const cycle = S.schedule.cycleWeeks;
  const rest = S.schedule.restWeek;
  const elRest = $('#restEveryWeeks');
  if (elRest && elRest !== document.activeElement) elRest.value = cycle > 1 ? cycle : 0;
  const box = $('#schedule-list');
  if (!box) return;
  // 复制模式提示条（含取消）
  const hint = copyMode
    ? `<div class="sched-copy-hint">${
        copyMode.type === 'day'
          ? `正在复制「第 ${copyMode.wi + 1} 周 · ${DAY_NAMES[copyMode.di]}」→ 点击任意其他天完成`
          : `正在复制「第 ${copyMode.wi + 1} 周」→ 点击任意其他周完成`
      }<button class="btn sched-copy-cancel">✕ 取消</button></div>`
    : '';
  box.innerHTML =
    hint +
    S.schedule.weeks
      .slice(0, cycle)
      .map((week, wi) => {
        // 「几周一休」的第 N 周 = 休息周：仍显示完整课表，可少排课（休息时间由课表留白体现）
        const isRest = isRestWeek(wi);
        const isSrc = copyMode && copyMode.type === 'week' && copyMode.wi === wi;
        const isTgt = copyMode && copyMode.type === 'week' && copyMode.wi !== wi;
        return `
      <div class="sched-week ${isSrc ? 'is-source' : ''} ${isTgt ? 'is-target' : ''}">
        <div class="sched-week-head">第 ${wi + 1} 周${isRest ? '（休息周 · 可少排课）' : ''}
          <button class="btn sched-copy-week" data-wi="${wi}">${isSrc ? '选择目标周…' : '📋 复制此周'}</button>
          ${wi === 0 && cycle > 1 ? '<button class="btn sched-copy-all">📋 复制到所有周</button>' : ''}
        </div>
        ${week.map((day, di) => renderDay(wi, di)).join('')}
        ${isTgt ? `<div class="sched-week-target" data-wi="${wi}"></div>` : ''}
      </div>`;
      })
      .join('');
}

function renderDay(wi, di) {
  const day = S.schedule.weeks[wi][di];
  const periods = day.periods || [];
  const isSrc = copyMode && copyMode.type === 'day' && copyMode.wi === wi && copyMode.di === di;
  const isTgt = copyMode && copyMode.type === 'day' && !(copyMode.wi === wi && copyMode.di === di);
  return `
  <div class="sched-day ${isSrc ? 'is-source' : ''} ${isTgt ? 'is-target' : ''}">
    <div class="sched-head">${DAY_NAMES[di]}
      <button class="btn sched-copy-day" data-wi="${wi}" data-di="${di}">${isSrc ? '选择目标天…' : '📋 复制'}</button>
    </div>
    ${periods
      .map(
        (p, pi) => `
      <div class="sched-row" data-wi="${wi}" data-di="${di}" data-pi="${pi}">
        <input type="time" class="sched-start" value="${esc(p.start || '')}">
        <span class="sched-sep">—</span>
        <input type="time" class="sched-end" value="${esc(p.end || '')}">
        <button class="btn danger sched-del" title="删除">✕</button>
      </div>`
      )
      .join('')}
    <button class="btn sched-add" data-wi="${wi}" data-di="${di}">＋ 添加时间段</button>
    ${isTgt ? `<div class="sched-day-target" data-wi="${wi}" data-di="${di}"></div>` : ''}
  </div>`;
}

function scheduleChanged() {
  clearTimeout(scheduleChanged._t);
  scheduleChanged._t = setTimeout(() => {
    patch({ schedule: S.schedule });
  }, 500); // 稍长的防抖，避免快速编辑时先发的 patch 覆盖后编辑的数据
}

$('#schedule-list').addEventListener('input', (e) => {
  const row = e.target.closest('.sched-row');
  if (!row) return;
  const wi = parseInt(row.dataset.wi, 10);
  const di = parseInt(row.dataset.di, 10);
  const pi = parseInt(row.dataset.pi, 10);
  const period = S.schedule.weeks[wi][di].periods[pi];
  if (!period) return;
  if (e.target.classList.contains('sched-start')) period.start = e.target.value;
  else if (e.target.classList.contains('sched-end')) period.end = e.target.value;
  scheduleChanged();
});

$('#schedule-list').addEventListener('click', (e) => {
  // 取消复制模式
  const cancel = e.target.closest('.sched-copy-cancel');
  if (cancel) {
    copyMode = null;
    renderSchedule();
    return;
  }
  // 复制模式：点击目标天（覆盖层）完成按日复制（支持跨周）
  const dayTgt = e.target.closest('.sched-day-target');
  if (dayTgt && copyMode && copyMode.type === 'day') {
    const twi = parseInt(dayTgt.dataset.wi, 10);
    const tdi = parseInt(dayTgt.dataset.di, 10);
    const { wi, di } = copyMode;
    S.schedule.weeks[twi][tdi].periods = S.schedule.weeks[wi][di].periods.map((p) => ({ ...p }));
    copyMode = null;
    renderSchedule();
    saveScheduleNow();
    toast(`已复制到 第 ${twi + 1} 周 · ${DAY_NAMES[tdi]}`);
    return;
  }
  // 复制模式：点击目标周（覆盖层）完成按周复制
  const weekTgt = e.target.closest('.sched-week-target');
  if (weekTgt && copyMode && copyMode.type === 'week') {
    const twi = parseInt(weekTgt.dataset.wi, 10);
    const { wi } = copyMode;
    S.schedule.weeks[twi] = S.schedule.weeks[wi].map((d) => ({ periods: (d.periods || []).map((p) => ({ ...p })) }));
    copyMode = null;
    renderSchedule();
    saveScheduleNow();
    toast(`已复制到 第 ${twi + 1} 周`);
    return;
  }
  // 一键复制第 1 周到所有周（最高效：多周循环一次铺满）
  const copyAll = e.target.closest('.sched-copy-all');
  if (copyAll) {
    const cycle = S.schedule.cycleWeeks;
    for (let wi = 1; wi < cycle; wi++) {
      S.schedule.weeks[wi] = S.schedule.weeks[0].map((d) => ({ periods: (d.periods || []).map((p) => ({ ...p })) }));
    }
    renderSchedule();
    saveScheduleNow();
    toast('已复制第 1 周到所有周');
    return;
  }
  // 复制模式开关（再点源按钮 = 取消）
  const copyDayBtn = e.target.closest('.sched-copy-day');
  if (copyDayBtn) {
    const wi = parseInt(copyDayBtn.dataset.wi, 10);
    const di = parseInt(copyDayBtn.dataset.di, 10);
    if (copyMode && copyMode.type === 'day' && copyMode.wi === wi && copyMode.di === di) copyMode = null;
    else copyMode = { type: 'day', wi, di };
    renderSchedule();
    return;
  }
  const copyWeekBtn = e.target.closest('.sched-copy-week');
  if (copyWeekBtn) {
    const wi = parseInt(copyWeekBtn.dataset.wi, 10);
    if (copyMode && copyMode.type === 'week' && copyMode.wi === wi) copyMode = null;
    else copyMode = { type: 'week', wi };
    renderSchedule();
    return;
  }
  const add = e.target.closest('.sched-add');
  if (add) {
    const wi = parseInt(add.dataset.wi, 10);
    const di = parseInt(add.dataset.di, 10);
    S.schedule.weeks[wi][di].periods.push({ start: '', end: '' });
    renderSchedule();
    saveScheduleNow();
    return;
  }
  const del = e.target.closest('.sched-del');
  if (del) {
    const row = e.target.closest('.sched-row');
    const wi = parseInt(row.dataset.wi, 10);
    const di = parseInt(row.dataset.di, 10);
    const pi = parseInt(row.dataset.pi, 10);
    S.schedule.weeks[wi][di].periods.splice(pi, 1);
    renderSchedule();
    saveScheduleNow();
    return;
  }
});

// 几周一休：联动 cycleWeeks / restWeek
$('#restEveryWeeks').addEventListener('change', () => {
  const n = Math.max(0, parseInt($('#restEveryWeeks').value, 10) || 0);
  S.schedule = normSchedule(S.schedule);
  if (n <= 1) {
    S.schedule.cycleWeeks = 1;
    S.schedule.restWeek = 0;
  } else {
    S.schedule.cycleWeeks = n;
    S.schedule.restWeek = n; // 每 N 周的第 N 周休息
  }
  S.schedule = normSchedule(S.schedule);
  renderSchedule();
  scheduleChanged();
});

/* ---------- 定时任务管理 ---------- */

const TASK_TYPE_NAMES = { shutdown: '定时关机', command: '运行命令', remind: '定时提醒' };
const DOW_CN = '一二三四五六日';

function renderTasks() {
  const list = S.tasks || [];
  const box = $('#task-list');
  if (!list.length) {
    box.innerHTML = '<div class="event-empty">暂无定时任务：可添加定时提醒 / 定时关机 / 运行命令</div>';
    return;
  }
  box.innerHTML = list
    .map((t) => {
      const daysText =
        t.days === 'daily' ? '每天'
        : t.days === 'once' ? '仅一次'
        : Array.isArray(t.days) ? '周' + t.days.map((d) => DOW_CN[d] ?? (d + 1)).join('、')
        : '';
      const detail = t.type === 'command' ? esc(t.command || '')
        : t.type === 'remind' ? esc(t.message || '')
        : `提前 ${parseInt(t.remindMin, 10) || 5} 分钟提醒（固定文案）`;
      return `
      <div class="task-item ${t.enabled === false ? 'off' : ''}">
        <div class="task-info">
          <div class="task-name">${TASK_TYPE_NAMES[t.type] || t.type} · ${esc(t.time)} · ${daysText}</div>
          ${detail ? `<div class="task-detail">${detail}</div>` : ''}
        </div>
        <div class="task-ops">
          <button class="btn" data-act="toggle" data-id="${esc(t.id)}">${t.enabled === false ? '启用' : '停用'}</button>
          <button class="btn danger" data-act="del" data-id="${esc(t.id)}">删除</button>
        </div>
      </div>`;
    })
    .join('');
}

// 任务类型切换：定时关机显示「提前几分钟提醒」，隐藏提醒文字/命令输入
$('#taskType').addEventListener('change', () => {
  const isShutdown = $('#taskType').value === 'shutdown';
  $('#taskRemindRow').hidden = !isShutdown;
  $('#taskMessage').hidden = isShutdown;
  $('#taskCommand').hidden = isShutdown;
});

$('#task-list').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const id = btn.dataset.id;
  const list = (S.tasks || []).slice();
  const i = list.findIndex((t) => t.id === id);
  if (i < 0) return;
  if (btn.dataset.act === 'toggle') {
    list[i] = { ...list[i], enabled: list[i].enabled === false };
  } else if (btn.dataset.act === 'del') {
    list.splice(i, 1);
  } else {
    return;
  }
  S = await window.config.update({ tasks: list });
  renderTasks();
});

$('#btn-add-task').addEventListener('click', async () => {
  const type = $('#taskType').value;
  const time = $('#taskTime').value;
  const daysRaw = $('#taskDays').value;
  if (!time) return alert('请选择时间');
  const days = daysRaw.includes(',') ? daysRaw.split(',').map(Number) : daysRaw;
  const task = {
    id: `t_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`,
    type,
    time,
    days,
    command: type === 'command' ? $('#taskCommand').value.trim() : '',
    message: type === 'remind' ? $('#taskMessage').value.trim() : '',
    remindMin: type === 'shutdown' ? Math.max(1, parseInt($('#taskRemindMin').value, 10) || 5) : 0,
    enabled: true,
  };
  if (type === 'command' && !task.command) return alert('请填写要运行的命令');
  if (type === 'remind' && !task.message) return alert('请填写提醒文字');
  S = await window.config.update({ tasks: (S.tasks || []).concat(task) });
  renderTasks();
  $('#taskCommand').value = '';
  $('#taskMessage').value = '';
  toast('已添加定时任务');
});

/* ---------- 事件管理 ---------- */

function renderEvents() {
  const list = S.events || [];
  const box = $('#event-list');
  if (!list.length) {
    box.innerHTML = '<div class="event-empty">暂无事件，点击「添加事件」创建（如：高考、中考、期末考试）</div>';
    return;
  }
  box.innerHTML = list
    .map((e) => {
      const { ms, d } = daysLeft(e.date);
      const past = ms <= 0;
      return `
      <div class="event-item ${e.enabled === false ? 'off' : ''}">
        <div class="e-emoji">${esc(e.emoji || '⏰')}</div>
        <div class="e-info">
          <div class="e-name">${esc(e.name)}</div>
          <div class="e-date">${fmtDateCN(e.date)}</div>
        </div>
        <div class="e-days ${past ? 'past' : ''}">${past ? '已过 ' + d + ' 天' : '剩余 ' + d + ' 天'}</div>
        <div class="e-ops">
          <button class="btn" data-act="toggle" data-id="${esc(e.id)}">${e.enabled === false ? '启用' : '停用'}</button>
          <button class="btn" data-act="edit" data-id="${esc(e.id)}">编辑</button>
          <button class="btn danger" data-act="del" data-id="${esc(e.id)}">删除</button>
        </div>
      </div>`;
    })
    .join('');
}

$('#event-list').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const id = btn.dataset.id;
  const ev = (S.events || []).find((x) => x.id === id);
  if (!ev) return;
  if (btn.dataset.act === 'toggle') {
    await window.config.events.update({ ...ev, enabled: ev.enabled === false });
    S = (await window.config.get()).settings;
    renderEvents();
    toast();
  } else if (btn.dataset.act === 'del') {
    if (!confirm(`确定删除「${ev.name}」吗？`)) return;
    await window.config.events.remove(id);
    S = (await window.config.get()).settings;
    renderEvents();
    toast('已删除');
  } else if (btn.dataset.act === 'edit') {
    openEditor(ev);
  }
});

/* ---------- 编辑器 ---------- */

let editingId = null;

function openEditor(ev) {
  editingId = ev ? ev.id : null;
  $('#editor-title').textContent = ev ? '编辑事件' : '添加事件';
  $('#ev-name').value = ev ? ev.name : '';
  $('#ev-date').value = ev ? localInputValue(ev.date) : '';
  $('#ev-emoji').value = ev ? ev.emoji || '' : '';
  $('#ev-color').value = ev ? ev.color || '#4f7cff' : '#4f7cff';
  $('#ev-enabled').checked = ev ? ev.enabled !== false : true;
  $('#editor-mask').hidden = false;
}

function closeEditor() {
  $('#editor-mask').hidden = true;
  editingId = null;
}

$('#btn-add-event').addEventListener('click', () => openEditor(null));
$('#btn-ev-cancel').addEventListener('click', closeEditor);

$('#btn-ev-save').addEventListener('click', async () => {
  const name = $('#ev-name').value.trim();
  const date = $('#ev-date').value;
  if (!name) return alert('请填写事件名称');
  if (!date) return alert('请选择目标时间');
  const payload = {
    id: editingId,
    name,
    date: date + ':00',
    emoji: $('#ev-emoji').value.trim() || '⏰',
    color: $('#ev-color').value,
    enabled: $('#ev-enabled').checked,
  };
  if (editingId) await window.config.events.update(payload);
  else await window.config.events.add(payload);
  closeEditor();
  S = (await window.config.get()).settings;
  renderEvents();
  toast();
});

/* ---------- 表单绑定（改动即保存） ---------- */

function bind(id, build) {
  const el = $(id);
  if (!el) return;
  const handler = () => patch(build(el));
  el.addEventListener('change', handler);
  if (el.tagName === 'INPUT' && (el.type === 'number' || el.type === 'text' || el.type === 'datetime-local')) {
    el.addEventListener('input', () => clearTimeout(el._t) || (el._t = setTimeout(handler, 350)));
  }
}

bind('#glassMode', (el) => ({ ui: { glassMode: el.value } }));
bind('#display', (el) => {
  $('#display-index-wrap').hidden = el.value !== 'index';
  return { ui: { display: el.value } };
});
bind('#displayIndex', (el) => ({ ui: { displayIndex: Math.max(0, parseInt(el.value, 10) || 0) } }));
bind('#opStrip', (el) => ({ ui: { opacity: { strip: parseInt(el.value, 10) / 100 } } }));
bind('#opExpanded', (el) => ({ ui: { opacity: { expanded: parseInt(el.value, 10) / 100 } } }));
bind('#opZoom', (el) => ({ ui: { opacity: { zoom: parseInt(el.value, 10) / 100 } } }));
bind('#classical', (el) => ({ ui: { classical: el.checked } }));
bind('#darkMode', (el) => ({ ui: { darkMode: el.checked } }));
bind('#autoStart', (el) => ({ ui: { autoStart: el.checked } }));
bind('#stripStyle', (el) => ({ ui: { stripStyle: el.value } }));
bind('#alwaysOnTop', (el) => ({ ui: { alwaysOnTop: el.checked } }));
bind('#showSeconds', (el) => ({ ui: { showSeconds: el.checked } }));
bind('#showPast', (el) => ({ ui: { showPast: el.checked } }));
bind('#smartEnabled', (el) => ({ smart: { enabled: el.checked } }));
bind('#notifyEnabled', (el) => ({ smart: { notifyEnabled: el.checked } }));
bind('#notifyShowSec', (el) => ({ smart: { notifyShowSec: Math.max(2, parseInt(el.value, 10) || 8) } }));
bind('#hideOnMaximized', (el) => ({ smart: { hideOnMaximized: el.checked } }));
bind('#expandIdleSec', (el) => ({ smart: { expandIdleSec: Math.max(0, parseInt(el.value, 10) || 0) } }));
bind('#zoomIdleSec', (el) => ({ smart: { zoomIdleSec: Math.max(0, parseInt(el.value, 10) || 0) } }));
bind('#zoomEnabled', (el) => ({ smart: { zoomEnabled: el.checked } }));
bind('#cycleEnabled', (el) => ({ smart: { cycleEnabled: el.checked } }));
bind('#cycleSec', (el) => ({ smart: { cycleSec: Math.max(2, parseInt(el.value, 10) || 6) } }));
bind('#scheduleEnabled', (el) => ({ schedule: { enabled: el.checked } }));

document.querySelectorAll('input[name="manualMode"]').forEach((r) =>
  r.addEventListener('change', () => r.checked && patch({ manual: { mode: r.value } }))
);

/* ---------- 标签切换 ---------- */

document.querySelectorAll('#tabs .tab').forEach((t) =>
  t.addEventListener('click', () => {
    document.querySelectorAll('#tabs .tab').forEach((x) => x.classList.remove('active'));
    document.querySelectorAll('.tabpage').forEach((x) => x.classList.remove('active'));
    t.classList.add('active');
    $(`#tab-${t.dataset.tab}`).classList.add('active');
  })
);

/* ---------- 关闭窗口（标题栏被遮挡时也能关闭） ---------- */
$('#btn-close').addEventListener('click', () => window.config.close());

/* ---------- 每 5 秒刷新剩余天数 ---------- */
setInterval(() => {
  if (S) renderEvents();
}, 5000);

/* ---------- 主进程变更实时同步（重新拉取并刷新页面） ---------- */
window.config.onChanged(async () => {
  try {
    const data = await window.config.get();
    S = data.settings;
    $('#scheduleEnabled').checked = !!(S.schedule && S.schedule.enabled);
    applyDarkMode(S.ui.darkMode);
    renderSchedule();
    renderTasks();
    renderEvents();
  } catch (e) {
    showErr('[同步失败] ' + (e && e.message ? e.message : String(e)));
  }
});

init().catch((e) => showErr('[初始化失败] ' + (e && e.message ? e.message : String(e))));
