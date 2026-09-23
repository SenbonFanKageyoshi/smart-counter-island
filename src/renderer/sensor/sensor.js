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

function renderContent(p) {
  const c = p || {};
  // —— 天气 ——
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
  // —— 自定义文字 ——
  const t = String(c.text == null ? '' : c.text);
  txt.textContent = t;
  txt.style.fontSize = `${Math.max(9, Math.min(18, Number(c.textSize) || 11))}px`;
  document.getElementById('cap').dataset.hasText = t ? '1' : '0';
}

if (window.cover && typeof window.cover.onContent === 'function') {
  window.cover.onContent(renderContent);
} else {
  renderContent(null);
}
