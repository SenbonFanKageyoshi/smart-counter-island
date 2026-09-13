'use strict';
/* 给打包后的 exe 写入图标与版本信息（signAndEditExecutable:false 时 rcedit 不自动执行）
   用法: node scripts/rcedit-exe.js [exe路径] */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const RCEDIT = path.join(ROOT, 'build', 'rcedit-x64.exe');
const ICON = path.join(ROOT, 'build', 'icon.ico');

function main() {
  const exe =
    process.argv[2] ||
    path.join(ROOT, 'release', 'win-unpacked', 'SmartCounterIsland.exe');
  if (!fs.existsSync(RCEDIT)) {
    console.warn('[rcedit] 缺少工具（build/rcedit-x64.exe），跳过图标写入（不影响打包）。');
    return;
  }
  if (!fs.existsSync(exe)) {
    console.error('找不到目标 exe:', exe);
    process.exit(1);
  }
  const pkg = require(path.join(ROOT, 'package.json'));
  const ver = `${pkg.version}.0`; // 版本资源用四段式
  execFileSync(RCEDIT, [
    exe,
    '--set-icon', ICON,
    '--set-version-string', 'ProductName', 'Smart Counter Island',
    '--set-version-string', 'FileDescription', 'Smart Counter Island - 高考/中考倒数日 灵动岛悬浮窗',
    '--set-version-string', 'CompanyName', 'Smart Counter Island',
    '--set-version-string', 'LegalCopyright', 'MIT',
    '--set-file-version', ver,
    '--set-product-version', ver,
  ], { stdio: 'inherit' });
  console.log(`[rcedit] 已写入图标与版本信息 (${ver}):`, exe);
}

main();
