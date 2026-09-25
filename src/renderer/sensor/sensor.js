'use strict';
/**
 * 传感器盖板渲染层：平时只是一块纯黑胶囊。
 * 主进程推内容下来时（'cover:content'），在盖板上画：
 *   ① 天气 chip（配置「天气位置 = 盖板上」）—— 图标 + 温度
 *   ② 自定义文字（模板 + 程序变量，见 main/cover-text.js）—— 主进程已渲染好，这里只填文本
 * 两者同时存在时并排显示（天气在左、文字在右）。
 */
const wx = document.getElementById('wx');
const wxTemp = document.getElementById('wx-temp');
const txt = document.getElementById('txt');
const capEl = document.getElementById('cap');
const cvTime = document.getElementById('cv-time');

/** 剩余时间文本：mm:ss / h:mm:ss（等宽数字，和灵动岛上的秒表同一格式） */
function fmtLeft(ms) {
  const sec = Math.max(0, Math.floor((ms || 0) / 1000));
  const p = (n) => String(n).padStart(2, '0');
  if (sec >= 3600) return `${Math.floor(sec / 3600)}:${p(Math.floor((sec % 3600) / 60))}:${p(sec % 60)}`;
  return `${p(Math.floor(sec / 60))}:${p(sec % 60)}`;
}

/** 盖板很窄，时长用紧凑写法（"45 分" / "2 时 30" / "3 小时"） */
function fmtMinutesShort(m) {
  const v = Math.max(1, Math.round(m || 0));
  if (v < 60) return `${v} 分`;
  const h = Math.floor(v / 60);
  const mm = v % 60;
  return mm ? `${h} 时 ${mm}` : `${h} 小时`;
}

/** 与灵动岛一致的完整写法（用于开始计时时的 label） */
function fmtMinutes(m) {
  const v = Math.max(1, Math.round(m || 0));
  if (v < 60) return `${v} 分钟`;
  const h = Math.floor(v / 60);
  const mm = v % 60;
  return mm ? `${h} 小时 ${mm} 分` : `${h} 小时`;
}

let lastPickMinutes = 10; // 创建页当前选中的时长（由主进程推下来，供 ✓ 按钮使用）

function renderContent(p) {
  const c = p || {};
  const mode = c.mode === 'timer' || c.mode === 'set' ? c.mode : 'normal';
  capEl.dataset.mode = mode;

  // —— 计时进行中：盖板显示剩余时间（非灵动岛形态下盖板清空的唯一例外）——
  if (mode === 'timer') {
    cvTime.textContent = fmtLeft(c.timer && c.timer.leftMs);
    return;
  }
  // —— 创建页（正在设时长）：左边时间、右边确认 / 放弃 ——
  if (mode === 'set') {
    lastPickMinutes = Math.max(1, Math.min(1440, Number(c.pickMinutes) || 10));
    cvTime.textContent = fmtMinutesShort(lastPickMinutes);
    return;
  }

  // —— 日常：天气 chip + 自定义文字 ——
  const w = c.weather || null;
  const wOn = !!(w && w.show !== false && w.cover);
  document.documentElement.dataset.anim = wOn ? w.anim || 'none' : 'none';
  if (wOn) {
    const unit = w.unit === 'f' ? '°F' : '°';
    wxTemp.textContent = w.temp == null ? '--' : `${Math.round(w.temp)}${unit}`;
    wx.title = `${w.city || ''} ${w.text || ''}`.trim();
    wx.classList.add('on');
  } else {
    wxTemp.textContent = '';
    wx.title = '';
    wx.classList.remove('on');
  }
  const t = String(c.text == null ? '' : c.text);
  txt.textContent = t;
  txt.style.fontSize = `${Math.max(9, Math.min(18, Number(c.textSize) || 11))}px`;
  document.getElementById('cap').dataset.hasText = t ? '1' : '0';
}

// 盖板上的 ✓ / ✗：与计时坞创建页的「开始 / 取消」完全同一组动作
(function () {
  const ok = document.getElementById('cv-ok');
  const no = document.getElementById('cv-no');
  if (ok) {
    ok.addEventListener('click', function (e) {
      e.stopPropagation();
      try {
        window.cover.action({ type: 'timerStart', ms: lastPickMinutes * 60000, label: fmtMinutes(lastPickMinutes) });
      } catch (err) {
        /* ignore */
      }
    });
  }
  if (no) {
    no.addEventListener('click', function (e) {
      e.stopPropagation();
      try {
        window.cover.action({ type: 'dockDone' });
      } catch (err) {
        /* ignore */
      }
    });
  }
})();

if (window.cover && typeof window.cover.onContent === 'function') {
  window.cover.onContent(renderContent);
} else {
  renderContent(null);
}

/* ---- 长按盖板→启动计时坞（与长按灵动岛同一动作）----
   盖板是一块很小的黑胶囊，反馈就用一条底部进度条长出来。 */
(function () {
  var LONG_PRESS_MS = 700;
  var timer = null;
  var fired = false;
  var root = document.getElementById('root') || document.body;
  function hint(on) {
    // 只做"稍微放大"，不再画进度条
    document.body.classList.toggle('pressing', !!on);
  }
  function clear() {
    clearTimeout(timer);
    timer = null;
    hint(false);
  }
  document.addEventListener('pointerdown', function (e) {
    if (e.button != null && e.button !== 0) return;
    clear();
    hint(true);
    timer = setTimeout(function () {
      fired = true;
      document.body.classList.add('press-fired');
      try {
        window.cover.longPress();
      } catch (err) {
        /* ignore */
      }
      setTimeout(function () {
        document.body.classList.remove('press-fired');
        hint(false);
      }, 220);
    }, LONG_PRESS_MS);
  });
  document.addEventListener('pointermove', function (e) {
    if (!timer || !e) return;
    // 移动超过 8px 就当作"想滑/想拖"→ 取消长按（避免与其他手势冲突）
    if (!this._sx) {
      this._sx = e.clientX;
      this._sy = e.clientY;
      return;
    }
    if (Math.abs(e.clientX - this._sx) > 8 || Math.abs(e.clientY - this._sy) > 8) {
      this._sx = 0;
      clear();
    }
  });
  document.addEventListener('pointerup', function () {
    clear();
  });
  document.addEventListener('pointercancel', function () {
    clear();
  });
})();
