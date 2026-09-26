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

/* ---- 盖板上的指针手势：与灵动岛完全一致 ----
   · 单击 → 收起      · 双击 → 打开配置
   · 按住上下拖（>25px）→ 下滑放大 / 上滑收起
   · 长按 700ms → 进计时坞（与长按灵动岛同一动作）
   ⚠️ 起点必须在 pointerdown 时重置：旧实现把起点惰性记在 document 上（this._sx）且从不清，
      第二次以后的长按会拿**上一次手势的起点**做比较 → 手指微动 8px 就误取消长按，
      表现就是「长按盖板没反应」。（灵动岛本体没有这个问题，指针逻辑就照它写。）
   ⚠️ 盖板只有 87×26，指针很快移出窗口 → 必须 setPointerCapture，否则收不到 move/up。 */
(function () {
  var LONG_PRESS_MS = 700;
  var drag = null;
  var longPressTimer = null;
  var longPressFired = false;
  var tapTimer = null;
  var lastTap = 0;

  function hint(on) {
    document.body.classList.toggle('pressing', !!on);
    // 灵动岛本体同步同一个反馈：视线通常在岛上，盖板这块小胶囊放大几像素看不出来
    try {
      window.cover.press(!!on);
    } catch (err) {
      /* ignore */
    }
  }
  function fired() {
    document.body.classList.add('press-fired');
    setTimeout(function () {
      document.body.classList.remove('press-fired');
    }, 220);
  }
  function clearLP() {
    clearTimeout(longPressTimer);
    longPressTimer = null;
  }
  function send(a) {
    try {
      window.cover.action(a);
    } catch (err) {
      /* ignore */
    }
  }

  document.addEventListener('pointerdown', function (e) {
    if (e.button != null && e.button !== 0) return;
    if (e.target && e.target.closest && e.target.closest('button')) return; // ✓/✗ 照常可点
    drag = { x: e.clientX, y: e.clientY, id: e.pointerId, moved: false, dx: 0, dy: 0 };
    clearLP();
    longPressFired = false;
    hint(true);
    longPressTimer = setTimeout(function () {
      longPressFired = true;
      hint(false);
      fired();
      send({ type: 'longPress' });
    }, LONG_PRESS_MS);
    try {
      if (e.target && e.target.setPointerCapture) e.target.setPointerCapture(e.pointerId);
    } catch (err) {
      /* ignore */
    }
  });

  document.addEventListener('pointermove', function (e) {
    if (!drag || e.pointerId !== drag.id) return;
    var dx = e.clientX - drag.x;
    var dy = e.clientY - drag.y;
    // 真的移动了（竖直 >6px 就算「想滑」）→ 立刻取消长按，避免「长按进坞 + 抬手又放大」双动作
    var vIntent = Math.abs(dy) > 6 && Math.abs(dy) >= Math.abs(dx);
    if (!drag.moved && (Math.abs(dy) > 6 || Math.abs(dx) > 6)) {
      drag.moved = true;
      if (vIntent || Math.abs(dy) > 8 || Math.abs(dx) > 8) {
        clearLP();
        hint(false);
      }
    }
    if (drag.moved) {
      drag.dx = dx;
      drag.dy = dy;
    }
  });

  function endPointer(e) {
    if (!drag || e.pointerId !== drag.id) return;
    var d = drag;
    drag = null;
    clearLP();
    hint(false);
    if (d.moved) {
      if (longPressFired) { longPressFired = false; return; }
      send({ type: 'gesture', dy: d.dy });
      return;
    }
    if (longPressFired) { longPressFired = false; return; }
    var now = Date.now();
    if (now - lastTap < 320) {
      lastTap = 0;
      clearTimeout(tapTimer);
      send({ type: 'doubleTap' });
    } else {
      lastTap = now;
      clearTimeout(tapTimer);
      tapTimer = setTimeout(function () {
        lastTap = 0;
        send({ type: 'tap' });
      }, 300);
    }
  }
  document.addEventListener('pointerup', endPointer);
  document.addEventListener('pointercancel', endPointer);
})();
