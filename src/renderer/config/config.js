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

/* ---------- 节假日倒计时（计时坞） ---------- */
function renderHolidays() {
  const hd = (S && S.holidays) || {};
  const now = Date.now(); // 提到块外：下面列表与"下一个"两处都要用（之前在 else 块里声明 → 出块未定义）
  if ($('#hdEnabled')) $('#hdEnabled').checked = hd.enabled === true;
  if ($('#hdLeadDays')) $('#hdLeadDays').value = typeof hd.leadDays === 'number' ? hd.leadDays : 30;
  const box = $('#hd-list');
  if (!box) return;
  const items = Array.isArray(hd.items) ? hd.items : [];
  if (!items.length) {
    box.innerHTML = '<div class="event-empty">还没有节假日，上面加一条（如 春节 2027-02-06）</div>';
  } else {
    const rows = items
      .map((it, i) => {
        const at = new Date(`${it.date}T00:00:00`).getTime();
        const left = Math.ceil((at - now) / 86400000);
        const past = left < 0;
        return `<div class="event-item${past ? ' off' : ''}"><div class="e-info"><div class="e-name">${esc(it.name)}</div>` +
          `<div class="e-date">${esc(it.date)}</div></div>` +
          `<div class="e-days${past ? ' past' : ''}">${past ? '已过' : `${left} 天`}</div>` +
          `<div class="e-ops"><button class="btn danger" data-hd-del="${i}">删除</button></div></div>`;
      })
      .join('');
    box.innerHTML = rows;
  }
  const nextEl = $('#hd-next');
  if (nextEl) {
    const up = items
      .map((it) => ({ it, at: new Date(`${it.date}T00:00:00`).getTime() }))
      .filter((x) => x.at >= now - 86400000)
      .sort((a, b) => a.at - b.at)[0];
    nextEl.textContent = up ? `下一个：${up.it.name}（${up.it.date}）` : '后面没有节假日了';
  }
}

function bindHolidays() {
  if ($('#hdEnabled')) {
    $('#hdEnabled').addEventListener('change', (e) => patch({ holidays: { enabled: e.target.checked } }));
  }
  if ($('#hdLeadDays')) {
    $('#hdLeadDays').addEventListener('change', (e) => patch({ holidays: { leadDays: Math.max(0, Math.min(3650, parseInt(e.target.value, 10) || 0)) } }));
  }
  if ($('#btn-hd-add')) {
    $('#btn-hd-add').addEventListener('click', () => {
      const name = ($('#hdName') || {}).value ? $('#hdName').value.trim() : '';
      const date = ($('#hdDate') || {}).value || '';
      if (!name || !date) {
        toast('名称和日期都要填');
        return;
      }
      const items = ((S && S.holidays && S.holidays.items) || []).concat([{ name, date }]);
      patch({ holidays: { items } });
      $('#hdName').value = '';
      $('#hdDate').value = '';
    });
  }
  if ($('#hd-list')) {
    $('#hd-list').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-hd-del]');
      if (!btn) return;
      const i = parseInt(btn.dataset.hdDel, 10);
      const before = (((S && S.holidays && S.holidays.items) || [])).slice();
      const items = before.filter((_, idx) => idx !== i);
      patch({ holidays: { items } }, { silent: true });
      toastUndo(`已删除「${(before[i] && before[i].name) || '节假日'}」`, () =>
        patch({ holidays: { items: before } }, { silent: true })
      );
    });
  }
}

/* ---------- 起手：窗口按钮 + 拖动 + 设置搜索 ---------- */
(function initShell() {
  // 无边框窗口：自绘标题栏（拖动交给主进程按屏幕坐标搬，跟手且不吃点击）
  const bar = $('#titlebar');
  if (bar && window.config.drag) {
    let dragging = false;
    bar.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button, input, select, a')) return; // 按钮/输入框不触发拖动
      dragging = true;
      bar.setPointerCapture && bar.setPointerCapture(e.pointerId);
      window.config.drag('start', e.screenX, e.screenY);
    });
    bar.addEventListener('pointermove', (e) => {
      if (dragging) window.config.drag('move', e.screenX, e.screenY);
    });
    const stop = () => {
      if (!dragging) return;
      dragging = false;
      window.config.drag('end');
    };
    bar.addEventListener('pointerup', stop);
    bar.addEventListener('pointercancel', stop);
    // 双击标题栏 = 最大化/还原（系统惯例）
    bar.addEventListener('dblclick', (e) => {
      if (e.target.closest('button, input, select, a')) return;
      window.config.drag('end');
      if (window.config.toggleMaximize) window.config.toggleMaximize();
    });
  }
  if ($('#btn-close')) $('#btn-close').addEventListener('click', () => window.config.close());
  if ($('#btn-min')) $('#btn-min').addEventListener('click', () => window.config.minimize && window.config.minimize());
  // 玻璃效果预览：打开玻璃实验室窗口（同一张桌面截图并排对照 + 参数滑块）
  if ($('#btn-glass-lab')) {
    $('#btn-glass-lab').addEventListener('click', () => {
      if (window.config.openGlassLab) window.config.openGlassLab();
    });
  }

  // 设置搜索：先在当前页过滤，当前页没有命中就跨页找第一个命中项
  const box = $('#setSearch');
  const clearBtn = $('#setSearchClear');
  if (!box) return;
  const allPages = () => Array.from(document.querySelectorAll('.tabpage'));
  function fieldsOf(page) {
    return Array.from(page.querySelectorAll('.field'));
  }
  function textOf(el) {
    return (el.textContent || '').toLowerCase();
  }
  function runSearch() {
    const q = box.value.trim().toLowerCase();
    if (clearBtn) clearBtn.hidden = !q;
    for (const p of allPages()) for (const f of fieldsOf(p)) f.classList.remove('search-hit', 'search-miss');
    document.querySelectorAll('.sec-title, .group-title').forEach((t) => t.classList.remove('search-miss'));
    if (!q) return;
    let firstHitPage = null;
    for (const p of allPages()) {
      let hit = 0;
      for (const f of fieldsOf(p)) {
        const ok = textOf(f).indexOf(q) >= 0;
        f.classList.add(ok ? 'search-hit' : 'search-miss');
        if (ok) hit += 1;
      }
      if (hit && !firstHitPage) firstHitPage = p;
      // 分组标题：它后面（到下一个标题之前）一个命中都没有 → 一起藏掉，别留孤零零的标题
      const kids = Array.from(p.children);
      kids.forEach((el, i) => {
        if (!el.matches('.sec-title, .group-title')) return;
        let any = false;
        for (let j = i + 1; j < kids.length; j += 1) {
          if (kids[j].matches('.sec-title, .group-title')) break;
          if (kids[j].classList.contains('search-hit')) {
            any = true;
            break;
          }
        }
        if (!any) el.classList.add('search-miss');
      });
    }
    const cur = document.querySelector('.tabpage.active');
    const curHas = cur && fieldsOf(cur).some((f) => f.classList.contains('search-hit'));
    if (!curHas && firstHitPage) {
      const tab = document.querySelector(`#tabs .tab[data-tab="${firstHitPage.id.replace(/^tab-/, '')}"]`);
      if (tab) tab.click(); // 当前页没命中 → 跳到第一个命中的页
    }
  }
  box.addEventListener('input', runSearch);
  box.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      box.value = '';
      runSearch();
    }
  });
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      box.value = '';
      runSearch();
      box.focus();
    });
  }
})();

/* ---------- 工具 ---------- */

function toast(msg) {
  const t = $('#toast');
  t.classList.remove('undoable');
  t.textContent = msg || '已保存';
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), 1200);
}

/* 可撤销提示：删除/整体覆盖类操作后，5 秒内可点「撤销」还原。
   人因研究：对破坏性操作，「可撤销」优于「确认弹窗」—— 不打断流程，误删也救得回来。
   注意要清掉 toast() 的普通提示时序，并把 pointer-events 打开（见 .toast.undoable）。 */
let undoFn = null;

function toastUndo(msg, undo) {
  const t = $('#toast');
  t.textContent = '';
  const span = document.createElement('span');
  span.textContent = msg;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'toast-undo';
  btn.textContent = '撤销';
  btn.addEventListener('click', () => {
    clearTimeout(toast._t);
    t.classList.remove('show', 'undoable');
    const fn = undoFn;
    undoFn = null;
    if (!fn) return;
    Promise.resolve()
      .then(fn)
      .then(() => toast('已撤销'))
      .catch(() => toast('撤销失败'));
  });
  t.appendChild(span);
  t.appendChild(btn);
  t.classList.add('show', 'undoable');
  clearTimeout(toast._t);
  undoFn = undo;
  toast._t = setTimeout(() => {
    t.classList.remove('show', 'undoable');
    undoFn = null;
  }, 5000);
}

/** 局部更新（主进程深合并 + 立即生效）；opts.silent = 不弹「已保存」（改由 toastUndo 接管提示） */
async function patch(p, opts) {
  S = await window.config.update(p);
  if (!opts || opts.silent !== true) toast();
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
  $('#opCorner').value = Math.round((S.ui.opacity.corner ?? 0.9) * 100);
  $('#opProgress').value = Math.round((S.ui.opacity.progress ?? 0.55) * 100);
  $('#alwaysOnTop').checked = !!S.ui.alwaysOnTop;
  $('#showSeconds').checked = !!S.ui.showSeconds;
  $('#glassGlow').value = typeof S.ui.glassGlow === 'number' ? S.ui.glassGlow : 100;
  $('#gpuGlassFps').value = typeof S.ui.gpuGlassFps === 'number' ? S.ui.gpuGlassFps : 30;
  $('#glEdgeGlow').value = typeof S.ui.glEdgeGlow === 'number' ? S.ui.glEdgeGlow : 100;
  $('#glBottomShade').value = typeof S.ui.glBottomShade === 'number' ? S.ui.glBottomShade : 100;
  $('#glRefract').value = typeof S.ui.glRefract === 'number' ? S.ui.glRefract : 100;
  $('#glBand').value = typeof S.ui.glBand === 'number' ? S.ui.glBand : 100;
  // 传感器避让：预设 + 直径/偏移/距顶三个数 = 单孔；高级区放原始传感器列表与禁区参数
  const nt = S.ui.cameraNotch || {};
  if ($('#notchPreset')) {
    renderNotchForm(nt);
  }
  renderHolidays(); // 节假日倒计时（计时坞）表单
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
  $('#notifyMinGapSec').value = S.smart.notifyMinGapSec ?? 5;
  $('#hideOnMaximized').checked = S.smart.hideOnMaximized !== false;
  $('#fullscreenMode').value = ['corner', 'progress', 'strip'].includes(S.smart.fullscreenMode) ? S.smart.fullscreenMode : 'hide';
  $('#progressTotalDays').value = typeof S.smart.progressTotalDays === 'number' ? S.smart.progressTotalDays : 365;
  $('#progressDaysRow').hidden = $('#fullscreenMode').value !== 'progress';
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
  // 手动模式：'dock' 已不再是可常驻模式（计时坞由长按灵动岛打开），这里兜底回落到「自动」，
  // 避免设置里残留旧值导致单选项一个都不选中。
  const modeForUi = S.manual && S.manual.mode === 'dock' ? 'auto' : (S.manual || {}).mode;
  const mm = document.querySelector(`input[name="manualMode"][value="${modeForUi}"]`);
  if (mm) mm.checked = true;

  // 时间表
  $('#scheduleEnabled').checked = !!(S.schedule && S.schedule.enabled);
  // 课堂提醒（时间表驱动）
  const cn = (S.schedule && S.schedule.notify) || {};
  $('#classNotifyEnabled').checked = cn.enabled !== false;
  $('#classBeforeStart').value = typeof cn.beforeStart === 'number' ? cn.beforeStart : 3;
  $('#classAtStart').checked = cn.atStart !== false;
  $('#classBeforeEnd').value = typeof cn.beforeEnd === 'number' ? cn.beforeEnd : 2;
  $('#classAtEnd').checked = cn.atEnd === true;
  $('#classTplStart').value = cn.templateStart || '还有 {min} 分钟上课 · {label}';
  $('#classTplAtStart').value = cn.templateAtStart || '上课时间到 · {label}';
  $('#classTplBeforeEnd').value = cn.templateBeforeEnd || '还有 {min} 分钟下课';
  $('#classTplAtEnd').value = cn.templateAtEnd || '下课时间到';
  renderSchedule();
  updateSchedPreview();

  // 桌宠
  const petCfg = S.pet || {};
  const pai = petCfg.ai || {};
  $('#petEnabled').checked = petCfg.enabled === true;
  $('#petScale').value = typeof petCfg.scale === 'number' ? petCfg.scale : 100;
  $('#petSpeed').value = typeof petCfg.speed === 'number' ? petCfg.speed : 100;
  $('#petOpacity').value = Math.round((typeof petCfg.opacity === 'number' ? petCfg.opacity : 0.95) * 100);
  $('#petHideFullscreen').checked = petCfg.hideOnFullscreen !== false;
  $('#petQuietClass').checked = petCfg.quietInClass !== false;
  $('#petAnnounceClass').checked = petCfg.announceClass !== false;
  $('#petAiEnabled').checked = pai.enabled !== false;
  $('#petAiBase').value = pai.baseUrl || 'https://api.deepseek.com';
  $('#petAiModel').value = pai.model || 'deepseek-chat';
  $('#petAiKey').value = pai.apiKey || '';
  $('#petAiPersona').value = pai.persona || '';
  $('#petAiPerMin').value = typeof pai.perMinute === 'number' ? pai.perMinute : 6;
  $('#petAiPerDay').value = typeof pai.perDay === 'number' ? pai.perDay : 200;
  $('#petAiMaxChars').value = (petCfg.guard && petCfg.guard.maxChars) || 120;
  $('#petAiPresetOnly').checked = pai.presetOnly === true;
  $('#petQa').value = (petCfg.qa || []).map((x) => `${(x.keys && x.keys[0]) || x.q || ''} | ${x.a || ''}`).join('\n');
  $('#petPack').value = petCfg.pack || '';
  refreshPetStatus();
  refreshPackStatus();

  // 定时任务
  renderTasks();

  // 天气
  const wxCfg = S.weather || {};
  $('#wxEnabled').checked = wxCfg.enabled === true;
  $('#wxCity').value = wxCfg.city || '';
  $('#wxRefresh').value = typeof wxCfg.refreshMin === 'number' ? wxCfg.refreshMin : 30;
  $('#wxUnit').value = wxCfg.unit === 'f' ? 'f' : 'c';
  $('#wxShow').value = wxCfg.showInIsland || 'always';
  // 天气位置已固定为「盖板上」，不再有细条位置可选（见 config.html 的说明）
  $('#wxAnim').checked = wxCfg.anim !== false;
  $('#wxIntensity').value = typeof wxCfg.animIntensity === 'number' ? wxCfg.animIntensity : 100;
  $('#wxHot').value = typeof wxCfg.hotC === 'number' ? wxCfg.hotC : 35;
  $('#wxDrop').value = typeof wxCfg.coldDropC === 'number' ? wxCfg.coldDropC : 8;
  $('#wxAhead').value = typeof wxCfg.rainLookaheadH === 'number' ? wxCfg.rainLookaheadH : 6;
  $('#wxKeywords').value = (wxCfg.alertKeywords || []).join(',');
  renderWxRules();
  refreshWxStatus();

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
        <span class="sched-no">第 ${pi + 1} 节</span>
        <input type="time" class="sched-start" value="${esc(p.start || '')}">
        <span class="sched-sep">—</span>
        <input type="time" class="sched-end" value="${esc(p.end || '')}">
        <input type="text" class="sched-name" maxlength="12" placeholder="科目" value="${esc(p.name || '')}">
        <button class="btn danger sched-del" title="删除">✕</button>
      </div>`
      )
      .join('')}
    <button class="btn sched-add" data-wi="${wi}" data-di="${di}">＋ 添加一节课</button>
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
  else if (e.target.classList.contains('sched-name')) period.name = e.target.value;
  scheduleChanged();
  updateSchedPreview();
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
    // 这是**整体覆盖**（第 2 周起全被第 1 周替换），先留一份原样供撤销
    const before = JSON.parse(JSON.stringify(S.schedule.weeks || []));
    for (let wi = 1; wi < cycle; wi++) {
      S.schedule.weeks[wi] = S.schedule.weeks[0].map((d) => ({ periods: (d.periods || []).map((p) => ({ ...p })) }));
    }
    renderSchedule();
    saveScheduleNow();
    toastUndo('已用第 1 周覆盖其余各周', () => {
      S.schedule.weeks = before;
      renderSchedule();
      saveScheduleNow();
    });
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
    // 可撤销：课表是手工录入的数据，误点代价高；但用确认弹窗会在连续排课时反复打断。
    const removed = S.schedule.weeks[wi][di].periods.splice(pi, 1)[0];
    renderSchedule();
    saveScheduleNow();
    toastUndo('已删除这节课', () => {
      S.schedule.weeks[wi][di].periods.splice(Math.max(0, pi), 0, removed);
      renderSchedule();
      saveScheduleNow();
    });
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

/* ---------- 时间表：快速排课 / 导入导出 / 预览 ---------- */

/** 节次时间推算：第 1 节开始 + 每节时长 + 课间 */
function quickPeriods(start, len, gap, count) {
  const [h, m] = String(start || '08:00').split(':').map((x) => parseInt(x, 10) || 0);
  let cur = h * 60 + m;
  const out = [];
  for (let i = 0; i < count; i++) {
    const s = cur;
    const e = cur + len;
    const f = (x) => String(Math.floor((x % 1440) / 60)).padStart(2, '0') + ':' + String(x % 60).padStart(2, '0');
    out.push({ start: f(s), end: f(e) });
    cur = e + gap;
  }
  return out;
}

const qfBox = $('#schedQuickBox');
const ioBox = $('#schedIoBox');
const qf = (id) => $('#' + id);

$('#schedQuickFill').addEventListener('click', () => {
  if (qfBox) qfBox.hidden = !qfBox.hidden;
  if (ioBox) ioBox.hidden = true;
});
$('#qfApply').addEventListener('click', () => {
  const periods = quickPeriods(qf('qfStart').value, Math.max(5, parseInt(qf('qfLen').value, 10) || 45), Math.max(0, parseInt(qf('qfBreak').value, 10) || 0), Math.max(1, Math.min(20, parseInt(qf('qfCount').value, 10) || 8)));
  const workdaysOnly = qf('qfWeekdays').checked;
  S.schedule = normSchedule(S.schedule);
  const days = workdaysOnly ? [0, 1, 2, 3, 4] : [0, 1, 2, 3, 4, 5, 6];
  for (const di of days) S.schedule.weeks[0][di].periods = periods.map((p) => ({ ...p }));
  if (qfWeekdays.checked) for (const di of [5, 6]) S.schedule.weeks[0][di].periods = [];
  S.schedule.enabled = true;
  $('#scheduleEnabled').checked = true;
  renderSchedule();
  saveScheduleNow();
  updateSchedPreview();
  toast(`已生成 ${periods.length} 节 × ${days.length} 天`);
});
$('#schedExport').addEventListener('click', () => {
  if (ioBox) ioBox.hidden = false;
  if (qfBox) qfBox.hidden = true;
  if ($('#schedIoLabel')) $('#schedIoLabel').textContent = '导出：时间表 JSON（复制走即可）';
  $('#schedIo').value = JSON.stringify(S.schedule, null, 2);
});
$('#schedImport').addEventListener('click', () => {
  if (ioBox) ioBox.hidden = false;
  if (qfBox) qfBox.hidden = true;
  if ($('#schedIoLabel')) $('#schedIoLabel').textContent = '导入：粘贴时间表 JSON';
  $('#schedIo').value = '';
  $('#schedIo').focus();
});
$('#schedIoApply').addEventListener('click', () => {
  try {
    const obj = JSON.parse($('#schedIo').value || '{}');
    if (!obj || !Array.isArray(obj.weeks)) throw new Error('缺少 weeks 字段');
    // 导入是**整体替换**（非增量合并），先留一份原课表与开关状态供撤销
    const before = JSON.parse(JSON.stringify(S.schedule || {}));
    const enabledBefore = $('#scheduleEnabled') ? $('#scheduleEnabled').checked : null;
    S.schedule = normSchedule({ ...S.schedule, ...obj, weeks: obj.weeks });
    if (obj.enabled != null) $('#scheduleEnabled').checked = !!obj.enabled;
    renderSchedule();
    saveScheduleNow();
    updateSchedPreview();
    toastUndo('时间表已导入（覆盖原课表）', () => {
      S.schedule = before;
      if (enabledBefore != null) $('#scheduleEnabled').checked = enabledBefore;
      renderSchedule();
      saveScheduleNow();
      updateSchedPreview();
    });
  } catch (e) {
    toast('导入失败：' + (e && e.message ? e.message : '格式不对'));
  }
});
$('#schedIoCopy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('#schedIo').value || '');
    toast('已复制到剪贴板');
  } catch (e) {
    $('#schedIo').select();
    toast('请按 Ctrl+C 复制');
  }
});
$('#schedIoClose').addEventListener('click', () => {
  if (ioBox) ioBox.hidden = true;
});

/** 课表预览：当前/下一节 + 提醒文案示例（主进程算，避免前后端两套逻辑） */
async function updateSchedPreview() {
  const el = $('#schedPreview');
  if (!el || !window.config.schedulePreview) return;
  try {
    const p = await window.config.schedulePreview();
    if (!p.enabled) {
      el.textContent = '时间表未启用';
      return;
    }
    const parts = [`现在 ${p.now}`];
    parts.push(p.current ? `正在上：${p.current.label}（${p.current.start}–${p.current.end}）` : '当前没课');
    if (p.next) parts.push(`下一节：${p.next.label} ${p.next.start}${p.next.inMin != null ? `（${p.next.inMin} 分钟后）` : '（次日）'}`);
    else parts.push('后面没有排课');
    el.textContent = parts.join(' · ');
    const tp = $('#classTplPreview');
    if (tp) tp.textContent = `预览：${p.templates.start}｜${p.templates.atStart}｜${p.templates.beforeEnd}｜${p.templates.atEnd}`;
  } catch (e) {
    /* ignore */
  }
}

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
  let removedTask = null;
  if (btn.dataset.act === 'toggle') {
    list[i] = { ...list[i], enabled: list[i].enabled === false };
  } else if (btn.dataset.act === 'del') {
    removedTask = list[i];
    list.splice(i, 1);
  } else {
    return;
  }
  S = await window.config.update({ tasks: list });
  renderTasks();
  if (removedTask) {
    const at = i;
    toastUndo(`已删除任务「${removedTask.name || removedTask.title || '定时任务'}」`, async () => {
      const cur = (S.tasks || []).slice();
      cur.splice(Math.max(0, at), 0, removedTask);
      S = await window.config.update({ tasks: cur });
      renderTasks();
    });
  }
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

/* ---------- 天气 ---------- */

const WX_KIND_NAMES = { now: '当前天气', today: '今日概况', tomorrow: '明日预报', rain: '降雨提醒', temp: '降温/高温' };

function renderWxRules() {
  const box = $('#wx-rules');
  if (!box) return;
  const list = (S.weather && S.weather.reminders) || [];
  if (!list.length) {
    box.innerHTML = '<div class="event-empty">还没有天气提醒（推荐加一条「每天 07:00 今日概况」）</div>';
    return;
  }
  box.innerHTML = list
    .map((r) => {
      const daysText =
        r.days === 'daily' ? '每天'
        : r.days === 'once' ? '仅一次'
        : Array.isArray(r.days) ? '周' + r.days.map((d) => DOW_CN[d] ?? (d + 1)).join('、')
        : '';
      return `
      <div class="wx-rule ${r.enabled === false ? 'off' : ''}">
        <div class="task-info">
          <div class="task-name">${esc(r.time)} · ${WX_KIND_NAMES[r.kind] || esc(r.kind || '')} · ${daysText}</div>
        </div>
        <div class="task-ops">
          <button class="btn" data-act="toggle" data-id="${esc(r.id)}">${r.enabled === false ? '启用' : '停用'}</button>
          <button class="btn danger" data-act="del" data-id="${esc(r.id)}">删除</button>
        </div>
      </div>`;
    })
    .join('');
}

/** 状态行：当前天气摘要 + 是否过期 + 上次错误 + 下一条提醒（主进程算好，渲染层只显示） */
async function refreshWxStatus() {
  const el = $('#wx-status');
  if (!el || !window.config.weather) return;
  try {
    const st = await window.config.weather.status();
    if (!st) return;
    if (st.enabled && st.current) {
      const t = st.updatedAt ? new Date(st.updatedAt) : null;
      const hm = t ? `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}` : '—';
      el.textContent =
        `${st.city || ''} · ${st.current.text} ${st.current.temp == null ? '--' : Math.round(st.current.temp) + '°'}` +
        ` · 更新 ${hm}${st.stale ? '（数据已过期，可能断网）' : ''}` +
        `${st.nextReminder ? ` · 下一条 ${st.nextReminder.time} ${WX_KIND_NAMES[st.nextReminder.kind] || ''}` : ''}`;
    } else if (st.enabled && st.error) {
      el.textContent = `还没取到天气：${st.error}`;
    } else {
      el.textContent = st.enabled ? '已启用，等待首次刷新…' : '未启用';
    }
  } catch (e) {
    el.textContent = `状态读取失败：${(e && e.message) || e}`;
  }
}

async function reloadSettings() {
  const data = await window.config.get();
  S = data.settings;
}

$('#wx-rules').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const id = btn.dataset.id;
  const list = ((S.weather && S.weather.reminders) || []).slice();
  const i = list.findIndex((r) => r.id === id);
  if (i < 0) return;
  let removedRule = null;
  if (btn.dataset.act === 'toggle') list[i] = { ...list[i], enabled: list[i].enabled === false };
  else if (btn.dataset.act === 'del') {
    removedRule = list[i];
    list.splice(i, 1);
  } else return;
  S = await window.config.update({ weather: { reminders: list } });
  renderWxRules();
  refreshWxStatus();
  if (removedRule) {
    const at = i;
    toastUndo('已删除这条天气提醒', async () => {
      const cur = ((S.weather && S.weather.reminders) || []).slice();
      cur.splice(Math.max(0, at), 0, removedRule);
      S = await window.config.update({ weather: { reminders: cur } });
      renderWxRules();
      refreshWxStatus();
    });
  }
});

$('#btn-add-wx-rule').addEventListener('click', async () => {
  const time = $('#wxRuleTime').value;
  if (!time) return alert('请选择时间');
  const daysRaw = $('#wxRuleDays').value;
  const days = daysRaw.includes(',') ? daysRaw.split(',').map(Number) : daysRaw;
  const rule = {
    id: `w_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`,
    time,
    days,
    kind: $('#wxRuleKind').value,
    enabled: true,
  };
  S = await window.config.update({ weather: { reminders: ((S.weather && S.weather.reminders) || []).concat(rule) } });
  renderWxRules();
  refreshWxStatus();
  toast('已添加天气提醒');
});

// 试一条：立即按所选类型弹一条示例（用缓存数据；没数据会提示先刷新）
$('#btn-wx-test').addEventListener('click', async () => {
  const note = $('#wx-test-note');
  note.textContent = '正在试播…';
  try {
    const r = await window.config.weather.testReminder($('#wxRuleKind').value);
    note.textContent = r && r.ok ? `已弹出示例：${r.title} — ${r.body}` : `没能试播：${(r && r.error) || '未知原因'}`;
  } catch (e) {
    note.textContent = `试播失败：${(e && e.message) || e}`;
  }
});

// 解析城市（只预览，不写设置）：确认「城市 · 省/州 · 国家」对不对
$('#btn-wx-resolve').addEventListener('click', async () => {
  const note = $('#wx-resolve');
  note.textContent = '正在解析…';
  try {
    const r = await window.config.weather.preview({ city: $('#wxCity').value.trim() });
    note.textContent = r && r.ok ? `解析到：${r.label}（${r.lat}, ${r.lon}）` : `解析失败：${(r && r.error) || '未知原因'}`;
  } catch (e) {
    note.textContent = `解析失败：${(e && e.message) || e}`;
  }
});

// 一键自动定位（按公网 IP，仅点击时执行）
$('#btn-wx-locate').addEventListener('click', async () => {
  const note = $('#wx-resolve');
  note.textContent = '正在按 IP 定位…';
  try {
    const r = await window.config.weather.locate();
    if (r && r.ok) {
      const l = r.located || {};
      note.textContent = `已定位：${[l.city, l.admin, l.country].filter(Boolean).join(' · ')}（来源 ${l.provider || 'IP'}）${r.error ? ` · 拉取天气失败：${r.error}` : ''}`;
      if (l.city) $('#wxCity').value = l.city;
      await reloadSettings();
      renderWxRules();
      await refreshWxStatus();
    } else {
      note.textContent = `定位失败：${(r && r.error) || '未知原因'}`;
    }
  } catch (e) {
    note.textContent = `定位失败：${(e && e.message) || e}`;
  }
});

$('#btn-wx-refresh').addEventListener('click', async () => {
  const note = $('#wx-resolve');
  note.textContent = '正在刷新…';
  try {
    const r = await window.config.weather.refresh();
    note.textContent = r && r.ok ? '已刷新' : `刷新失败：${(r && r.error) || '未知原因'}`;
    await refreshWxStatus();
  } catch (e) {
    note.textContent = `刷新失败：${(e && e.message) || e}`;
  }
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
    // 可撤销删除：替代原来的阻断式 confirm —— 撤销既少打断流程，误删也救得回来。
    const before = (S.events || []).slice();
    const idx = before.findIndex((x) => x.id === id);
    if (idx < 0) return;
    const removed = before[idx];
    const after = before.filter((x) => x.id !== id);
    S = await window.config.update({ events: after });
    renderEvents();
    toastUndo(`已删除「${removed.name || '事件'}」`, async () => {
      const cur = (S.events || []).slice();
      cur.splice(Math.max(0, idx), 0, removed); // 插回原来的位置，不改变其它事件顺序
      S = await window.config.update({ events: cur });
      renderEvents();
    });
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
bind('#opCorner', (el) => ({ ui: { opacity: { corner: parseInt(el.value, 10) / 100 } } }));
bind('#opProgress', (el) => ({ ui: { opacity: { progress: parseInt(el.value, 10) / 100 } } }));
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
bind('#notifyMinGapSec', (el) => ({ smart: { notifyMinGapSec: Math.max(0, Math.min(120, parseInt(el.value, 10) || 0)) } }));
bind('#hideOnMaximized', (el) => ({ smart: { hideOnMaximized: el.checked } }));
bind('#fullscreenMode', (el) => {
  $('#progressDaysRow').hidden = el.value !== 'progress';
  return { smart: { fullscreenMode: el.value } };
});
bind('#progressTotalDays', (el) => ({ smart: { progressTotalDays: Math.max(1, Math.min(10000, parseInt(el.value, 10) || 365)) } }));
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
// 课堂提醒：任何一项改动都合并写进 schedule.notify（主进程 20 秒轮询会立即用上新配置）
function patchClassNotify() {
  patch({
    schedule: {
      notify: {
        enabled: $('#classNotifyEnabled').checked,
        beforeStart: Math.max(0, Math.min(30, parseInt($('#classBeforeStart').value, 10) || 0)),
        atStart: $('#classAtStart').checked,
        beforeEnd: Math.max(0, Math.min(30, parseInt($('#classBeforeEnd').value, 10) || 0)),
        atEnd: $('#classAtEnd').checked,
        templateStart: $('#classTplStart').value.trim() || '还有 {min} 分钟上课 · {label}',
        templateAtStart: $('#classTplAtStart').value.trim() || '上课时间到 · {label}',
        templateBeforeEnd: $('#classTplBeforeEnd').value.trim() || '还有 {min} 分钟下课',
        templateAtEnd: $('#classTplAtEnd').value.trim() || '下课时间到',
      },
    },
  }).then(updateSchedPreview);
}
['#classNotifyEnabled', '#classAtStart', '#classAtEnd'].forEach((sel) =>
  $(sel).addEventListener('change', patchClassNotify)
);
['#classBeforeStart', '#classBeforeEnd', '#classTplStart', '#classTplAtStart', '#classTplBeforeEnd', '#classTplAtEnd'].forEach((sel) =>
  $(sel).addEventListener('change', patchClassNotify)
);

/* ---------- 桌宠 ---------- */

/** 把预置问答文本框（一行一条「关键词 | 回答」）解析成 qa 数组 */
function parseQa(text) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    const i = t.indexOf('|');
    if (i <= 0) continue;
    const keys = t
      .slice(0, i)
      .split(/[,，、;；]/)
      .map((x) => x.trim())
      .filter(Boolean);
    const a = t.slice(i + 1).trim();
    if (!keys.length || !a) continue;
    out.push({ q: keys[0], keys, a });
  }
  return out;
}

function patchPet() {
  const pet = {
    enabled: $('#petEnabled').checked,
    scale: Math.max(50, Math.min(200, parseInt($('#petScale').value, 10) || 100)),
    speed: Math.max(20, Math.min(400, parseInt($('#petSpeed').value, 10) || 100)),
    opacity: Math.max(0.2, Math.min(1, (parseInt($('#petOpacity').value, 10) || 95) / 100)),
    hideOnFullscreen: $('#petHideFullscreen').checked,
    quietInClass: $('#petQuietClass').checked,
    announceClass: $('#petAnnounceClass').checked,
    ai: {
      enabled: $('#petAiEnabled').checked,
      baseUrl: $('#petAiBase').value.trim() || 'https://api.deepseek.com',
      model: $('#petAiModel').value.trim() || 'deepseek-chat',
      apiKey: $('#petAiKey').value.trim(),
      persona: $('#petAiPersona').value.trim(),
      perMinute: Math.max(1, Math.min(60, parseInt($('#petAiPerMin').value, 10) || 6)),
      perDay: Math.max(1, Math.min(2000, parseInt($('#petAiPerDay').value, 10) || 200)),
      presetOnly: $('#petAiPresetOnly').checked,
    },
    guard: { maxChars: Math.max(30, Math.min(400, parseInt($('#petAiMaxChars').value, 10) || 120)), blocked: (S.pet && S.pet.guard && S.pet.guard.blocked) || [] },
    qa: parseQa($('#petQa').value),
  };
  patch({ pet }).then(() => {
    const forced = /reason|thinking|r1|o1|o3/i.test($('#petAiModel').value.trim());
    if ($('#petAiModelWarn')) $('#petAiModelWarn').textContent = forced ? '这个名字是思考模型，已强制改回 deepseek-chat' : '';
    refreshPetStatus();
  });
}

['#petEnabled', '#petScale', '#petSpeed', '#petOpacity', '#petHideFullscreen', '#petQuietClass', '#petAnnounceClass', '#petAiEnabled', '#petAiBase', '#petAiModel', '#petAiKey', '#petAiPersona', '#petAiPerMin', '#petAiPerDay', '#petAiMaxChars', '#petAiPresetOnly', '#petQa'].forEach((sel) => {
  const el = $(sel);
  if (!el) return;
  el.addEventListener('change', patchPet);
  if (el.tagName === 'INPUT' && el.type === 'text') el.addEventListener('input', () => clearTimeout(el._pt) || (el._pt = setTimeout(patchPet, 500)));
});

/** 桌宠状态行：开关 / 模型 / 用量统计 */
async function refreshPetStatus() {
  const el = $('#petStatus');
  if (!el || !window.config.pet) return;
  try {
    const s = await window.config.pet.status();
    if (!s.enabled) {
      el.textContent = '桌宠未启用';
      return;
    }
    const st = s.stats || {};
    el.textContent =
      `运行中 · 模型 ${s.model}${s.modelForced ? '（已强制改回）' : ''} · ` +
      `${s.hasKey ? '已配置 Key' : '未配置 Key（只答预置问答）'}${s.presetOnly ? ' · 仅预置模式' : ''} · ` +
      `预置 ${s.qaCount} 条 · ` +
      `提问 ${st.asks || 0} 次（AI ${st.aiCalls || 0} / 预置 ${st.presetHits || 0} / 拒绝 ${st.refused || 0}）` +
      `${st.avgFirstMs ? ` · 平均首字 ${st.avgFirstMs}ms` : ''}${s.classMode ? ' · 上课静默中' : ''}`;
  } catch (e) {
    el.textContent = '状态读取失败';
  }
}

const petCheckBtn = $('#petCheck');
if (petCheckBtn) {
  petCheckBtn.addEventListener('click', async () => {
    if ($('#petStatus')) $('#petStatus').textContent = '正在自检…';
    const r = await window.config.pet.checkAi();
    if ($('#petStatus')) {
      $('#petStatus').textContent = r && r.ok ? `连接正常：模型 ${r.model} · 首字 ${r.firstMs}ms${r.reasoningLen ? ' ⚠返回了思考内容' : ''}` : `连接失败：${(r && r.reason) || '未知原因'}`;
    }
  });
}
const petSayBtn = $('#petSayTest');
if (petSayBtn) {
  petSayBtn.addEventListener('click', async () => {
    await window.config.pet.testSay();
    if ($('#petStatus')) $('#petStatus').textContent = '已让它说一句（看屏幕右下角的气泡）';
  });
}

/* ---------- 桌宠素材包 ---------- */

/** 状态行：目录 / 清单是否可用 / 各状态帧数 / 错误 */
async function refreshPackStatus() {
  const el = $('#petPackStatus');
  if (!el || !window.config.pet || !window.config.pet.packStatus) return;
  try {
    const s = await window.config.pet.packStatus();
    const states = s.summary ? ` · ${s.summary}` : '';
    el.textContent = s.ok
      ? `已加载：${s.name || '素材包'}${states} · ${s.dir}`
      : `未加载（用内置占位小人）：${(s.errors && s.errors[0]) || s.reason || '缺少 pet.json'} · ${s.dir}`;
  } catch (e) {
    el.textContent = '素材包状态读取失败';
  }
}

const packBtn = (id, fn) => {
  const el = $(id);
  if (el) el.addEventListener('click', fn);
};
packBtn('#petPackOpen', async () => {
  const r = await window.config.pet.packOpen();
  if ($('#petPackStatus')) $('#petPackStatus').textContent = r && r.ok ? `已打开：${r.dir}（把 pet.json 和图片放进去，再点「重新加载」）` : `打开失败：${(r && r.reason) || ''}`;
});
packBtn('#petPackPick', async () => {
  const r = await window.config.pet.packPick();
  if (r && r.ok) {
    $('#petPack').value = r.dir;
    refreshPackStatus();
  } else {
    refreshPackStatus();
  }
});
packBtn('#petPackSample', async () => {
  if ($('#petPackStatus')) $('#petPackStatus').textContent = '正在生成示例素材包…';
  const r = await window.config.pet.packSample();
  if ($('#petPackStatus')) $('#petPackStatus').textContent = `已生成 ${r.files} 个文件到 ${r.dir}（可以直接改这些图，或按 README 换成自己的素材）`;
});
packBtn('#petPackReload', async () => {
  await window.config.pet.packReload();
  refreshPackStatus();
});
if ($('#petPack')) {
  $('#petPack').addEventListener('change', () => {
    patch({ pet: { pack: $('#petPack').value.trim() } }).then(refreshPackStatus);
  });
}

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
/* ---------- 传感器避让（位置只有「中置传感器」；高级参数在折叠区里） ---------- */

/** 按设置回填表单：启用、位置预设、校准开关、高级区 */
function renderNotchForm(nt) {
  $('#notchEnabled').checked = !!nt.enabled;
  $('#notchPreset').value = 'center';
  $('#notchDebug').checked = !!nt.debug;
  // 盖板自定义内容（模板 + 程序变量）
  const coverTxt = nt.text || {};
  $('#coverText').value = coverTxt.template || '';
  $('#coverTextSize').value = typeof coverTxt.size === 'number' ? coverTxt.size : 11;
  renderCoverVars();
  refreshCoverPreview();
  $('#notchSensors').value = typeof nt.sensors === 'string' ? nt.sensors : '';
  $('#notchZoneMode').value = nt.zoneMode === 'manual' ? 'manual' : 'auto';
  const z = nt.zone || {};
  $('#notchZoneX').value = Math.round(Number(z.x) || 0);
  $('#notchZoneY').value = Math.round(Number(z.y) || 0);
  $('#notchZoneW').value = Math.round(Number(z.w) || 1);
  $('#notchZoneH').value = Math.round(Number(z.h) || 1);
  $('#notchMargin').value = typeof nt.margin === 'number' ? nt.margin : 6;
  $('#notchLayout').value = ['split', 'below', 'none'].includes(nt.layout) ? nt.layout : 'auto';
  $('#notchRadius').value = typeof nt.radius === 'number' ? nt.radius : 30;
  $('#notchSlotLeft').value = typeof nt.slotLeft === 'number' ? nt.slotLeft : 14;
  $('#notchSlotRight').value = typeof nt.slotRight === 'number' ? nt.slotRight : 12;
  $('#notchSlotBelow').value = typeof nt.slotBelow === 'number' ? nt.slotBelow : 4;
  $('#notchAnimMs').value = typeof nt.animMs === 'number' ? nt.animMs : 550;
}

$('#notchAdvShow').addEventListener('change', () => {
  $('#notch-adv').hidden = !$('#notchAdvShow').checked;
});
bind('#notchEnabled', (el) => ({ ui: { cameraNotch: { enabled: el.checked } } }));
// 位置预设只有一个「中置传感器」：选中即写回它的传感器列表 + 禁区
bind('#notchPreset', (el) => ({ ui: { cameraNotch: { preset: el.value } } }));
bind('#notchSensors', (el) => ({ ui: { cameraNotch: { preset: 'custom', sensors: el.value } } }));
bind('#notchZoneMode', (el) => ({ ui: { cameraNotch: { zoneMode: el.value === 'manual' ? 'manual' : 'auto' } } }));
bind('#notchZoneX', (el) => ({ ui: { cameraNotch: { zone: { x: parseInt(el.value, 10) || 0 } } } }));
bind('#notchZoneY', (el) => ({ ui: { cameraNotch: { zone: { y: parseInt(el.value, 10) || 0 } } } }));
bind('#notchZoneW', (el) => ({ ui: { cameraNotch: { zone: { w: Math.max(1, parseInt(el.value, 10) || 1) } } } }));
bind('#notchZoneH', (el) => ({ ui: { cameraNotch: { zone: { h: Math.max(1, parseInt(el.value, 10) || 1) } } } }));
bind('#notchMargin', (el) => ({ ui: { cameraNotch: { margin: Math.max(0, Math.min(60, parseInt(el.value, 10) || 0)) } } }));
bind('#notchLayout', (el) => ({ ui: { cameraNotch: { layout: el.value } } }));
bind('#notchRadius', (el) => ({ ui: { cameraNotch: { radius: Math.max(0, Math.min(80, parseInt(el.value, 10) || 0)) } } }));
bind('#notchSlotLeft', (el) => ({ ui: { cameraNotch: { slotLeft: Math.max(0, Math.min(200, parseInt(el.value, 10) || 0)) } } }));
bind('#notchSlotRight', (el) => ({ ui: { cameraNotch: { slotRight: Math.max(0, Math.min(200, parseInt(el.value, 10) || 0)) } } }));
bind('#notchSlotBelow', (el) => ({ ui: { cameraNotch: { slotBelow: Math.max(0, Math.min(200, parseInt(el.value, 10) || 0)) } } }));
bind('#notchAnimMs', (el) => ({ ui: { cameraNotch: { animMs: Math.max(0, Math.min(2000, parseInt(el.value, 10) || 0)) } } }));
bind('#notchDebug', (el) => ({ ui: { cameraNotch: { debug: el.checked } } }));

// —— 盖板自定义内容：变量胶囊（点一下插到光标处）+ 实时预览（按当前真实数据渲染）——
let COVER_VARS = [];
async function renderCoverVars() {
  const box = $('#coverVars');
  if (!box || !window.config.coverVars) return;
  try {
    COVER_VARS = (await window.config.coverVars()) || [];
  } catch (e) {
    COVER_VARS = [];
  }
  box.innerHTML = COVER_VARS.map((v) => `<button type="button" class="btn var-chip" data-var="${esc(v.key)}" title="${esc(v.desc)}（例：${esc(v.sample)}）">{${esc(v.key)}}</button>`).join(' ');
}

async function refreshCoverPreview() {
  const el = $('#coverPreview');
  if (!el || !window.config.coverPreview) return;
  const tpl = $('#coverText').value;
  if (!tpl.trim()) {
    el.textContent = '（留空：盖板上不显示文字）';
    return;
  }
  try {
    const r = await window.config.coverPreview(tpl);
    el.textContent = r && r.ok ? `预览：${r.text || '（空）'}` : `预览失败：${(r && r.error) || '未知原因'}`;
  } catch (e) {
    el.textContent = `预览失败：${(e && e.message) || e}`;
  }
}

if ($('#coverVars')) {
  $('#coverVars').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-var]');
    if (!b) return;
    const input = $('#coverText');
    const token = `{${b.dataset.var}}`;
    const s = input.selectionStart == null ? input.value.length : input.selectionStart;
    const epos = input.selectionEnd == null ? s : input.selectionEnd;
    input.value = input.value.slice(0, s) + token + input.value.slice(epos);
    input.focus();
    input.setSelectionRange(s + token.length, s + token.length);
    bindCoverText.flush();
  });
}
// 输入即保存（防抖）+ 刷新预览
function bindCoverTextNow() {
  patch({ ui: { cameraNotch: { text: { template: $('#coverText').value } } } });
}
const bindCoverText = { flush: () => { clearTimeout(bindCoverText._t); bindCoverTextNow(); } };
$('#coverText').addEventListener('input', () => {
  clearTimeout(bindCoverText._t);
  bindCoverText._t = setTimeout(bindCoverTextNow, 400);
  clearTimeout(refreshCoverPreview._t);
  refreshCoverPreview._t = setTimeout(refreshCoverPreview, 450);
});
bind('#coverTextSize', (el) => ({ ui: { cameraNotch: { text: { size: Math.max(9, Math.min(18, parseInt(el.value, 10) || 11)) } } } }));

// 天气：改城市会清掉旧经纬度（下次刷新重新解析）；其余字段改动即存
bind('#wxEnabled', (el) => ({ weather: { enabled: el.checked } }));
bind('#wxCity', (el) => ({ weather: { city: el.value.trim(), lat: null, lon: null, resolvedName: '' } }));
bind('#wxRefresh', (el) => ({ weather: { refreshMin: Math.max(10, Math.min(720, parseInt(el.value, 10) || 30)) } }));
bind('#wxUnit', (el) => ({ weather: { unit: el.value === 'f' ? 'f' : 'c' } }));
bind('#wxShow', (el) => ({ weather: { showInIsland: ['banner', 'always', 'off'].includes(el.value) ? el.value : 'always' } }));
// 天气位置固定为盖板，不再绑定 pos
bind('#wxAnim', (el) => ({ weather: { anim: el.checked } }));
bind('#wxIntensity', (el) => ({ weather: { animIntensity: Math.max(0, Math.min(200, parseInt(el.value, 10) || 0)) } }));
bind('#wxHot', (el) => ({ weather: { hotC: Math.max(0, Math.min(50, parseInt(el.value, 10) || 35)) } }));
bind('#wxDrop', (el) => ({ weather: { coldDropC: Math.max(0, Math.min(30, parseInt(el.value, 10) || 8)) } }));
bind('#wxAhead', (el) => ({ weather: { rainLookaheadH: Math.max(1, Math.min(24, parseInt(el.value, 10) || 6)) } }));
bind('#wxKeywords', (el) => ({ weather: { alertKeywords: el.value.split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean) } }));

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
    renderWxRules();
    refreshWxStatus();
    renderEvents();
  } catch (e) {
    showErr('[同步失败] ' + (e && e.message ? e.message : String(e)));
  }
});

bindHolidays();
init().catch((e) => showErr('[初始化失败] ' + (e && e.message ? e.message : String(e))));
