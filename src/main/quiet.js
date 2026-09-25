'use strict';
/**
 * 安静模式：自检 / 诊断 / 截图这些**非用户场景**下，窗口一律不可见 ——
 * 否则跑一次自检，用户的桌面上会反复闪出小岛、配置页、盖板，很打扰。
 *
 * 用 `setOpacity(0)` 而不是 `show: false`：
 * 窗口必须保持"已显示"状态，渲染器才会正常布局与绘制 ——
 * 几何断言（getBoundingClientRect / getBounds）、executeJavaScript、
 * capturePage 截图全都依赖这一点。
 */
const ARGV = process.argv;
const QUIET =
  ARGV.includes('--test') ||
  ARGV.includes('--diag-press') ||
  ARGV.includes('--glass-lab') ||
  ARGV.some((x) => String(x).startsWith('--shot'));

/** 把窗口设为不可见（安静模式下）。原样返回窗口，方便链式使用。 */
function quiet(win) {
  if (!QUIET || !win) return win;
  try {
    if (typeof win.isDestroyed === 'function' && win.isDestroyed()) return win;
    win.setOpacity(0);
    // 顺带别抢焦点、别出现在任务栏（配置页/实验室窗口会跳任务栏）
    if (typeof win.setSkipTaskbar === 'function') win.setSkipTaskbar(true);
  } catch (e) {
    /* 个别平台不支持就忽略，不影响功能 */
  }
  return win;
}

module.exports = { QUIET, quiet };
