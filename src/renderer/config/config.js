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

/** 开机自启：勾选框按注册表真实状态显示（而不是设置里的期望值） */
function renderAutoStart(st) {
  if (!st) return;
  $('#autoStart').checked = !!st.enabled;
  const tag = $('#autoStartState');
  tag.textContent = st.enabled ? '已启用' : st.blocked ? '已被系统禁用' : '未启用';
  $('#autoStartPath').textContent = st.enabled && st.path ? (st.matches ? '' : `当前指向：${st.path}`) : '';
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
  renderAutoStart(data.autoStart);
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
  $('#glassGlow').value = typeof S.ui.glassGlow === 'number' ? S.ui.glassGlow : 100;
  $('#gpuGlassFps').value = typeof S.ui.gpuGlassFps === 'number' ? S.ui.gpuGlassFps : 30;
  $('#glEdgeGlow').value = typeof S.ui.glEdgeGlow === 'number' ? S.ui.glEdgeGlow : 100;
  $('#glBottomShade').value = typeof S.ui.glBottomShade === 'number' ? S.ui.glBottomShade : 100;
  $('#glRefract').value = typeof S.ui.glRefract === 'number' ? S.ui.glRefract : 100;
  $('#glBand').value = typeof S.ui.glBand === 'number' ? S.ui.glBand : 100;
 $('#dayRounding').value = S.ui.dayRounding === 'ceil' || S.ui.dayRounding === 'round' ? S.ui.dayRounding : 'floor';
  $('#showPast').checked = !!S.ui.showPast;
  $('#classical').checked = !!S.ui.classical;
  // 壁纸
  const wp = S.ui.wallpaper || {};
  if ($('#wpEnabled')) {
    $('#wpEnabled').checked = !!wp.enabled;
    $('#wpSource').value = wp.source === 'folder' ? 'folder' : 'gradient';
    $('#wpFolder').value = wp.folder || '';
    $('#wpBuiltin').checked = wp.useBuiltinQuotes !== false;
    $('#wpQuotes').value = wp.quotes || '';
    $('#wpPosition').value = wp.position || 'center';
    $('#wpScale').value = typeof wp.scale === 'number' ? wp.scale : 100;
    $('#wpSchool').value = wp.school || '';
    $('#wpSubline').value = wp.subline || '';
    $('#wpDaily').checked = wp.autoDaily !== false;
    $('#wpInterval').value = String(typeof wp.intervalMin === 'number' ? wp.intervalMin : 1440);
    $('#wpOrder').value = wp.order === 'reverse' || wp.order === 'random' ? wp.order : 'seq';
    $('#wpFit').value = wp.fit === 'contain' ? 'contain' : 'cover';
    $('#wpDim').value = Math.round((typeof wp.dim === 'number' ? wp.dim : 0.32) * 100);
    $('#wpScrim').checked = wp.scrim !== false;
    wpStatusText(wp);
  }

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
  $('#hideOnFullscreen').checked = S.smart.hideOnFullscreen !== false;
  $('#expandIdleSec').value = S.smart.expandIdleSec;
  $('#zoomIdleSec').value = S.smart.zoomIdleSec ?? 0;
  $('#zoomEnabled').checked = !!S.smart.zoomEnabled;
  $('#cycleEnabled').checked = !!S.smart.cycleEnabled;
  $('#cycleSec').value = S.smart.cycleSec;
  // 高级设置
  $('#animEnabled').checked = S.smart.animEnabled !== false;
  $('#animFps').value = S.smart.animFps ?? 60;
  $('#notifyShake').checked = S.smart.notifyShake !== false;
  $('#bgRefreshSec').value = S.smart.bgRefreshSec ?? 1.6;
  $('#hoverMargin').value = S.smart.hoverMargin ?? 30;
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
        <div class="sched-week-head">第 ${wi + 1} 周${isRest ? '（休息周）' : ''}
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
    box.innerHTML = '<div class="event-empty">暂无定时任务</div>';
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
        : `提前 ${parseInt(t.remindMin, 10) || 5} 分钟提醒`;
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
    box.innerHTML = '<div class="event-empty">暂无事件</div>';
    return;
  }
  box.innerHTML = list
    .map((e) => {
      const { ms, d } = daysLeft(e.date);
      const past = ms <= 0;
      return `
      <div class="event-item ${e.enabled === false ? 'off' : ''} ${e.pinned ? 'pinned' : ''}">
        <div class="e-emoji">${e.pinned ? '📌 ' : ''}${esc(e.emoji || '⏰')}</div>
        <div class="e-info">
          <div class="e-name">${esc(e.name)}</div>
          <div class="e-date">${fmtDateCN(e.date)}</div>
        </div>
        <div class="e-days ${past ? 'past' : ''}">${past ? '已过 ' + d + ' 天' : '剩余 ' + d + ' 天'}</div>
        <div class="e-ops">
          <button class="btn ${e.pinned ? 'primary' : ''}" data-act="pin" data-id="${esc(e.id)}" title="置顶：固定显示在灵动岛和横幅上">${e.pinned ? '取消置顶' : '置顶'}</button>
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
  } else if (btn.dataset.act === 'pin') {
    // 置顶互斥：只有一个事件置顶（决定灵动岛/横幅显示哪个事件）
    const next = (S.events || []).map((x) => ({ ...x, pinned: x.id === id && !ev.pinned }));
    S = await window.config.update({ events: next });
    renderEvents();
    toast(ev.pinned ? '已取消置顶' : '已置顶');
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
// 开机自启：写完注册表后按真实状态回填（写失败 / 被系统禁用时不会显示成"已勾上"）
const autoStartEl = $('#autoStart');
if (autoStartEl) {
  autoStartEl.addEventListener('change', async () => {
    await patch({ ui: { autoStart: autoStartEl.checked } });
    renderAutoStart(await window.config.autoStart());
  });
}
bind('#stripStyle', (el) => ({ ui: { stripStyle: el.value } }));
bind('#alwaysOnTop', (el) => ({ ui: { alwaysOnTop: el.checked } }));
bind('#showSeconds', (el) => ({ ui: { showSeconds: el.checked } }));
bind('#glassGlow', (el) => ({ ui: { glassGlow: Math.max(0, Math.min(200, parseInt(el.value, 10) || 0)) } }));
bind('#gpuGlassFps', (el) => ({ ui: { gpuGlassFps: Math.max(1, Math.min(60, parseInt(el.value, 10) || 30)) } }));
bind('#dayRounding', (el) => ({ ui: { dayRounding: el.value } }));
bind('#showPast', (el) => ({ ui: { showPast: el.checked } }));
bind('#smartEnabled', (el) => ({ smart: { enabled: el.checked } }));
bind('#notifyEnabled', (el) => ({ smart: { notifyEnabled: el.checked } }));
bind('#notifyShowSec', (el) => ({ smart: { notifyShowSec: Math.max(2, parseInt(el.value, 10) || 8) } }));
bind('#hideOnMaximized', (el) => ({ smart: { hideOnMaximized: el.checked } }));
bind('#hideOnFullscreen', (el) => ({ smart: { hideOnFullscreen: el.checked } }));
bind('#expandIdleSec', (el) => ({ smart: { expandIdleSec: Math.max(0, parseInt(el.value, 10) || 0) } }));
bind('#zoomIdleSec', (el) => ({ smart: { zoomIdleSec: Math.max(0, parseInt(el.value, 10) || 0) } }));
bind('#zoomEnabled', (el) => ({ smart: { zoomEnabled: el.checked } }));
bind('#cycleEnabled', (el) => ({ smart: { cycleEnabled: el.checked } }));
bind('#cycleSec', (el) => ({ smart: { cycleSec: Math.max(2, parseInt(el.value, 10) || 6) } }));
bind('#animFps', (el) => ({ smart: { animFps: Math.max(20, Math.min(120, parseInt(el.value, 10) || 60)) } }));
bind('#animEnabled', (el) => ({ smart: { animEnabled: el.checked } }));
bind('#notifyShake', (el) => ({ smart: { notifyShake: el.checked } }));
bind('#bgRefreshSec', (el) => ({ smart: { bgRefreshSec: Math.max(0.5, Math.min(10, parseFloat(el.value) || 1.6)) } }));
bind('#hoverMargin', (el) => ({ smart: { hoverMargin: Math.max(6, Math.min(120, parseInt(el.value, 10) || 30)) } }));
bind('#scheduleEnabled', (el) => ({ schedule: { enabled: el.checked } }));

/* ---------- 壁纸 ---------- */

bind('#wpEnabled', (el) => ({ ui: { wallpaper: { enabled: el.checked } } }));
bind('#wpSource', (el) => ({ ui: { wallpaper: { source: el.value } } }));
bind('#wpFolder', (el) => ({ ui: { wallpaper: { folder: el.value.trim() } } }));
bind('#wpBuiltin', (el) => ({ ui: { wallpaper: { useBuiltinQuotes: el.checked } } }));
bind('#wpQuotes', (el) => ({ ui: { wallpaper: { quotes: el.value } } }));
bind('#wpPosition', (el) => ({ ui: { wallpaper: { position: el.value } } }));
bind('#wpScale', (el) => ({ ui: { wallpaper: { scale: Math.max(40, Math.min(250, parseInt(el.value, 10) || 100)) } } }));
bind('#wpSchool', (el) => ({ ui: { wallpaper: { school: el.value } } }));
bind('#wpSubline', (el) => ({ ui: { wallpaper: { subline: el.value } } }));
bind('#wpDaily', (el) => ({ ui: { wallpaper: { autoDaily: el.checked } } }));
bind('#wpInterval', (el) => ({ ui: { wallpaper: { intervalMin: Math.max(0, parseInt(el.value, 10) || 0) } } }));
bind('#wpOrder', (el) => ({ ui: { wallpaper: { order: el.value } } }));
bind('#wpFit', (el) => ({ ui: { wallpaper: { fit: el.value } } }));
bind('#wpDim', (el) => ({ ui: { wallpaper: { dim: Math.max(0, Math.min(70, parseInt(el.value, 10) || 0)) / 100 } } }));
bind('#wpScrim', (el) => ({ ui: { wallpaper: { scrim: el.checked } } }));
bind('#glEdgeGlow', (el) => ({ ui: { glEdgeGlow: Math.max(0, Math.min(300, parseInt(el.value, 10) || 0)) } }));
bind('#glBottomShade', (el) => ({ ui: { glBottomShade: Math.max(0, Math.min(300, parseInt(el.value, 10) || 0)) } }));
bind('#glRefract', (el) => ({ ui: { glRefract: Math.max(0, Math.min(300, parseInt(el.value, 10) || 0)) } }));
bind('#glBand', (el) => ({ ui: { glBand: Math.max(0, Math.min(300, parseInt(el.value, 10) || 0)) } }));

function wpStatus(text) {
  const el = $('#wpStatus');
  if (el) el.textContent = text || '';
}

/** 状态行：最近一次更换 + 下一次自动轮换的时间 */
function wpStatusText(wp) {
  const freq = { 1440: '每天', 720: '每 12 小时', 360: '每 6 小时', 120: '每 2 小时', 60: '每 1 小时', 30: '每 30 分钟', 10: '每 10 分钟', 5: '每 5 分钟', 0: '每次启动' };
  const iv = typeof wp.intervalMin === 'number' ? wp.intervalMin : 1440;
  let next = '';
  if (wp.enabled && wp.autoDaily !== false) {
    if (iv === 0) next = ' · 下次：下次启动时';
    else if (iv >= 1440) next = ' · 下次：明天首次检查时';
    else {
      const t = (wp.lastRotateAt || 0) + iv * 60000;
      const d = new Date(Math.max(Date.now(), t));
      next = ` · 下次：${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    }
  }
  const last = wp.lastDate
    ? `最近更换：${wp.lastDate}${wp.lastSource ? ' · ' + wp.lastSource : ''}${wp.lastQuote ? ' · ' + wp.lastQuote : ''}`
    : '尚未更换过';
  wpStatus(last + (wp.enabled ? `（${freq[iv] || iv + ' 分钟'}）` : '') + next);
}

/** 重新读取设置并刷新壁纸状态行（更换/恢复后调用） */
async function refreshWallpaper() {
  try {
    const data = await window.config.get();
    S = data.settings;
    wpStatusText(S.ui.wallpaper || {});
  } catch (e) {
    /* ignore */
  }
}

const wpNowBtn = $('#wpNow');
if (wpNowBtn) {
  wpNowBtn.addEventListener('click', async () => {
    wpStatus('正在生成并设置壁纸…');
    const r = await window.config.wallpaper.rotate({ shift: 1 });
    wpStatus(
      r && r.ok
        ? `已更换（${r.source === 'folder' ? `图片文件夹 ${r.index}/${r.total}` : '内置底纹'}）· ${r.quote || ''}`
        : `更换失败：${(r && r.reason) || '未知原因'}`
    );
    await refreshWallpaper();
  });
}
const wpPickBtn = $('#wpPick');
if (wpPickBtn) {
  wpPickBtn.addEventListener('click', async () => {
    const r = await window.config.wallpaper.pickFolder();
    if (r && r.ok) {
      $('#wpFolder').value = r.folder;
      wpStatus(`已选择文件夹（${r.count} 张图片）`);
      patch({ ui: { wallpaper: { folder: r.folder } } });
    }
  });
}
const wpOpenBtn = $('#wpOpen');
if (wpOpenBtn) {
  wpOpenBtn.addEventListener('click', async () => {
    const r = await window.config.wallpaper.openFolder();
    wpStatus(r && r.ok ? `已打开：${r.folder}（把壁纸图片放进去即可）` : `打开失败：${(r && r.reason) || '未知原因'}`);
  });
}
const wpRestoreBtn = $('#wpRestore');
if (wpRestoreBtn) {
  wpRestoreBtn.addEventListener('click', async () => {
    const r = await window.config.wallpaper.restore();
    wpStatus(r && r.ok ? '已恢复为启用前的桌面壁纸' : `恢复失败：${(r && r.reason) || '未记录原壁纸'}`);
  });
}
const wpPreviewBtn = $('#wpPreview');
if (wpPreviewBtn) {
  wpPreviewBtn.addEventListener('click', async () => {
    wpStatus('正在生成预览…');
    const r = await window.config.wallpaper.preview(currentWallpaperForm());
    if (r && r.ok) {
      const img = $('#wpPreviewImg');
      img.src = r.dataUrl;
      img.style.display = 'block';
      wpStatus(`预览（${r.source === 'folder' ? `图片文件夹 · ${r.count} 张` : '内置底纹'} · 语录：${r.quote || ''}）`);
    } else {
      wpStatus(`预览失败：${(r && r.reason) || '未知原因'}`);
    }
  });
}

/** 取配置页表单上的壁纸设置（用于预览，不落盘） */
function currentWallpaperForm() {
  const g = (id) => {
    const el = $(id);
    return el ? (el.type === 'checkbox' ? el.checked : el.value) : undefined;
  };
  return {
    source: g('#wpSource'),
    folder: String(g('#wpFolder') || '').trim(),
    quotes: g('#wpQuotes'),
    useBuiltinQuotes: g('#wpBuiltin'),
    position: g('#wpPosition'),
    scale: parseInt(g('#wpScale'), 10) || 100,
    school: g('#wpSchool'),
    subline: g('#wpSubline'),
    fit: g('#wpFit') === 'contain' ? 'contain' : 'cover',
    dim: Math.max(0, Math.min(70, parseInt(g('#wpDim'), 10) || 0)) / 100,
    scrim: g('#wpScrim'),
  };
}

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
