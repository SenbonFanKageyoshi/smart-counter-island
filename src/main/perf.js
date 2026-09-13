'use strict';
/* ===== 性能采集（--perf 模式）=====
   零开销设计：未启用时不记录任何数据（mark 直接返回），启用后只做数组 push。
   记录「相对进程启动」的毫秒时间戳（process.uptime），因此覆盖 Electron 主进程
   从启动到各里程碑的耗时，用于启动速度对比。
   用法：SmartCounterIsland.exe --perf  → 结果写入 %TEMP%\sci-perf-<pid>.json */
const marks = [];
let enabled = false;

function enable() {
  enabled = true;
}
function isEnabled() {
  return enabled;
}
/** 记录里程碑（未启用时零成本） */
function mark(name) {
  if (!enabled) return;
  marks.push({ name, ms: Math.round(process.uptime() * 1000) });
}
function getMarks() {
  return marks.slice();
}

module.exports = { enable, isEnabled, mark, getMarks };
