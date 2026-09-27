'use strict';
/**
 * 教学助手素材库：内置清单 + **按需下载**。
 *
 * 为什么不做成内置：awesome-codex-pet 有 258 个素材、图集合计约 500MB，且其中 33 个没有标注
 * 再分发许可（另有一批写着"仅个人使用"）—— 随安装包公开发行既有体积问题也有版权风险。
 * 所以：仓库里只放清单（pets-catalog.json，元数据），图集下载到 <userData>/pets/<id>/。
 * 下载后按本程序的包格式生成 pet.json（含作者/许可/尺寸），并写入 LICENSE.txt 保留署名。
 *
 * 图集规格（官方 animation-rows.md）：8 列，每格 192×208；
 *   v1 = 1536×1872（9 行，72 格）；v2 = 1536×2288（11 行，88 格，最后两行是 16 个环视方向）。
 *   前 9 行语义两版一致：0 idle / 1 向右跑 / 2 向左跑 / 3 挥手 / 4 跳 / 5 失败 / 6 等待 / 7 原地跑 / 8 审视。
 *   本程序用到：idle→行0、walk→行1、talk→行3（挥手）、sleep→行6（等待）。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const REPO = 'legeling/awesome-codex-pet';
const CATALOG = path.join(__dirname, '..', '..', 'assets', 'pets-catalog.json');
const COLS = 8;
const CELL_W = 192;
const CELL_H = 208;
/** 状态 → 图集行/帧数/帧率（fps 取官方 durations 的近似；本程序只支持单帧率） */
const ROWS = {
  idle: { row: 0, frames: 6, fps: 6 },
  walk: { row: 1, frames: 8, fps: 8 }, // 官方「向右跑」，向左由渲染层自动镜像
  talk: { row: 3, frames: 4, fps: 7 }, // 挥手
  jump: { row: 4, frames: 5, fps: 7 }, // 跳（被点击）
  fail: { row: 5, frames: 8, fps: 7 }, // 失败（答错/断网）
  sleep: { row: 6, frames: 6, fps: 6 }, // 等待
  review: { row: 8, frames: 6, fps: 6 }, // 审视（思考中）
};

/** 读内置清单（纯读文件；坏数据当成空清单，不让配置页崩） */
function readCatalog(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file || CATALOG, 'utf8'));
    const pets = Array.isArray(j.pets) ? j.pets.filter((p) => p && p.id) : [];
    return { source: String(j.source || REPO), ref: String(j.ref || 'main'), generatedAt: String(j.generatedAt || ''), count: pets.length, pets };
  } catch (e) {
    return { source: REPO, generatedAt: '', count: 0, pets: [], error: String((e && e.message) || e) };
  }
}

/** 素材包目录：<userData>/pets */
function petsDir(userData) {
  return path.join(userData, 'pets');
}

/** 某个素材的本地目录 */
function packDir(userData, id) {
  return path.join(petsDir(userData), String(id).replace(/[^\w.@-]/g, '_'));
}

/** 已下载的素材（有 pet.json 就算装好）：{ id: { dir, name, author, license, bytes } } */
function listLocal(userData) {
  const out = {};
  const root = petsDir(userData);
  let names = [];
  try {
    names = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch (e) {
    return out;
  }
  for (const n of names) {
    const dir = path.join(root, n);
    const f = path.join(dir, 'pet.json');
    if (!fs.existsSync(f)) continue;
    try {
      const j = JSON.parse(fs.readFileSync(f, 'utf8'));
      const st = j.states && j.states.idle ? 1 : 0;
      if (!st) continue;
      out[j.id || n] = { id: j.id || n, dir, name: j.name || n, author: j.author || '', license: j.license || '', builtin: !!j.builtin };
    } catch (e) { /* 坏包跳过 */ }
  }
  return out;
}

/** 清单 + 本地状态 → 配置页要的列表（纯函数，便于自检） */
function mergeList(catalog, local) {
  const rows = [];
  const seen = new Set();
  for (const p of catalog.pets || []) {
    seen.add(p.id);
    rows.push({
      id: p.id,
      name: p.name || p.id,
      author: p.author || '',
      license: p.license || '',
      category: p.category || '',
      version: p.version || 1,
      bytes: p.bytes || 0,
      installed: !!local[p.id],
      dir: local[p.id] ? local[p.id].dir : '',
      builtin: false,
    });
  }
  // 本地有、清单没有的（老师自己画的 / 清单更新前的旧素材）也列出来
  for (const [id, v] of Object.entries(local)) {
    if (seen.has(id)) continue;
    rows.push({ id, name: v.name || id, author: v.author || '', license: v.license || '', category: '', version: 0, bytes: 0, installed: true, dir: v.dir, builtin: false });
  }
  return rows;
}

/** 生成包清单：图集总格数按版本算（v1 9 行 72 格、v2 11 行 88 格） */
function packManifest(entry) {
  const cells = COLS * ((entry && entry.version === 2) ? 11 : 9);
  const states = {};
  for (const [name, r] of Object.entries(ROWS)) {
    states[name] = {
      fps: r.fps,
      sheet: 'spritesheet.webp',
      frames: r.frames,
      cols: COLS,
      cells,
      start: r.row * COLS,
    };
  }
  return {
    id: entry.id,
    name: (entry.name || entry.id) + ' · 教学助手',
    author: entry.author || '',
    license: entry.license || '',
    source: 'https://github.com/' + REPO,
    scale: 55,
    anchorY: 0,
    fps: 6,
    states,
  };
}

/** 许可/署名文本（跟着素材包一起落盘，转发给别人时署名不丢） */
function licenseText(entry) {
  return [
    (entry.name || entry.id) + ' · 教学助手素材',
    '='.repeat(36),
    '',
    '作者：' + (entry.author || '未标注'),
    '许可：' + (entry.license || '未标注'),
    '来源：https://github.com/' + REPO + '  →  pets/' + entry.id,
    '',
    '说明：本素材由上述作者投稿到 awesome-codex-pet 仓库，本程序只做下载与格式转换，',
    '      不主张任何权利。使用与再分发请遵循上面的许可条款；若许可是非商业性使用，',
    '      请勿用于商业用途。同人角色形象的相关知识产权归原权利方所有。',
    '',
    '图集：spritesheet.webp ' + (entry.version === 2 ? '1536×2288（8×11）' : '1536×1872（8×9）') + '，每格 ' + CELL_W + '×' + CELL_H,
    '      本程序用到：idle→行0、walk→行1、talk→行3（挥手）、sleep→行6（等待）。',
    '',
  ].join('\r\n');
}

/** 校验下载到的图集：sha256 + 字节数（清单里有就查） */
function verifyBuffer(buf, entry) {
  if (!buf || !buf.length) return { ok: false, reason: '空文件' };
  if (entry.sha256) {
    const h = crypto.createHash('sha256').update(buf).digest('hex');
    if (h !== entry.sha256) return { ok: false, reason: 'sha256 不匹配（下载被截断或源已更新）' };
  }
  if (entry.bytes && buf.length !== entry.bytes) return { ok: false, reason: '字节数不符（期望 ' + entry.bytes + '，实得 ' + buf.length + '）' };
  const riff = buf.slice(0, 4).toString('latin1');
  const webp = buf.slice(8, 12).toString('latin1');
  if (riff !== 'RIFF' || webp !== 'WEBP') return { ok: false, reason: '不是 WebP 图集' };
  return { ok: true, sha256: crypto.createHash('sha256').update(buf).digest('hex') };
}

/**
 * 下载用的 fetch：**优先 Electron 的 net.fetch** —— 它走 Chromium 网络栈，会跟随系统代理/PAC。
 * 实测（2026-09-27，国内网络 + 本地代理）：Node 的全局 fetch 直连 raw/jsDelivr 全部失败
 * （DNS 被代理接管成 127.0.0.1，Node 不走代理 → fetch failed），而 Chromium 那条路是通的。
 */
function httpFetch(url, opts) {
  try {
    const electron = require('electron');
    if (electron && electron.net && typeof electron.net.fetch === 'function') return electron.net.fetch(url, opts);
  } catch (e) {
    /* 非 Electron 环境（纯 node 脚本/自检）→ 退回全局 fetch */
  }
  return fetch(url, opts);
}

/** 下载源（按序回退，成功后粘住上一次可用的那个）：raw 与 jsDelivr 在不同网络下会被挡 */
function assetUrls(entry, ref) {
  const r = ref || 'main';
  const p = 'pets/' + entry.id + '/spritesheet.webp';
  const raw = 'https://raw.githubusercontent.com/' + REPO + '/' + r + '/' + p;
  return [
    raw,
    'https://cdn.jsdelivr.net/gh/' + REPO + '@' + r + '/' + p,
    'https://fastly.jsdelivr.net/gh/' + REPO + '@' + r + '/' + p,
    'https://gcore.jsdelivr.net/gh/' + REPO + '@' + r + '/' + p,
    'https://ghproxy.net/' + raw,
    'https://gh-proxy.com/' + raw,
    'https://ghfast.top/' + raw,
    'https://cdn.statically.io/gh/' + REPO + '@' + r + '/' + p,
  ];
}

/** 上一次成功的源（模块级）：批量下载时先试它，避免每个素材都从第一个源开始白等 */
let stickySource = 0;
let stickyFile = '';

/** 从 <userData>/pets/.source 恢复上次可用的源（跨启动生效：被墙的源只白等一次） */
function loadSticky(userData) {
  // 路径总是记住（哪怕文件还不存在）—— 否则第一次成功下载后 saveSticky() 无处可写，
  // 「记住可用源」永远不生效，每次启动都白等一遍被墙的源。
  stickyFile = path.join(petsDir(userData), '.source');
  try {
    if (!fs.existsSync(stickyFile)) return;
    const n = parseInt(fs.readFileSync(stickyFile, 'utf8'), 10);
    if (Number.isFinite(n) && n >= 0) stickySource = n;
  } catch (e) {
    /* ignore */
  }
}

function saveSticky() {
  if (!stickyFile) return;
  try {
    fs.writeFileSync(stickyFile, String(stickySource));
  } catch (e) {
    /* ignore */
  }
}

/** 拉一个素材的图集（返回 Buffer；每个源都失败才抛） */
async function fetchAtlas(entry, ref, timeoutMs) {
  const errs = [];
  const all = assetUrls(entry, ref);
  const urls = all.slice(stickySource).concat(all.slice(0, stickySource));
  for (const url of urls) {
    const ac = new AbortController();
    // 单个源最多等 20s：被墙的源常常是「连上不动」而不是快速报错（实测 raw 会吊满超时），
    // 有 .source 记忆后这个等待只在第一台机器上出现一次
    const timer = setTimeout(() => ac.abort(), Math.max(2000, timeoutMs || 20000));
    try {
      const r = await httpFetch(url, { signal: ac.signal, headers: { 'user-agent': 'sci-pet-lib' } });
      if (!r.ok) { errs.push(url.slice(0, 40) + ' HTTP ' + r.status); continue; }
      const buf = Buffer.from(await r.arrayBuffer());
      const v = verifyBuffer(buf, entry);
      if (!v.ok) { errs.push(url.slice(0, 40) + ' ' + v.reason); continue; }
      stickySource = all.indexOf(url);
      return { buf, sha256: v.sha256, url };
    } catch (e) {
      errs.push(url.slice(0, 40) + ' ' + String((e && e.message) || e));
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error('下载失败：' + errs.join('；'));
}

/** 下载并安装一个素材：<userData>/pets/<id>/{spritesheet.webp, pet.json, LICENSE.txt} */
async function downloadOne(entry, userData, ref) {
  const dir = packDir(userData, entry.id);
  fs.mkdirSync(dir, { recursive: true });
  loadSticky(userData);
  const got = await fetchAtlas(entry, ref);
  saveSticky();
  const tmp = path.join(dir, 'spritesheet.webp.tmp');
  fs.writeFileSync(tmp, got.buf);
  fs.renameSync(tmp, path.join(dir, 'spritesheet.webp'));
  fs.writeFileSync(path.join(dir, 'pet.json'), JSON.stringify(packManifest(entry), null, 2), 'utf8');
  fs.writeFileSync(path.join(dir, 'LICENSE.txt'), licenseText(entry), 'utf8');
  return { ok: true, id: entry.id, dir, bytes: got.buf.length, sha256: got.sha256 };
}

/** 删除已下载素材（只删 <userData>/pets 下的目录） */
function removeOne(userData, id) {
  const dir = packDir(userData, id);
  const root = petsDir(userData);
  if (!dir.startsWith(root)) return { ok: false, reason: '路径越界' };
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    return { ok: true, id, dir };
  } catch (e) {
    return { ok: false, reason: String((e && e.message) || e) };
  }
}

module.exports = {
  REPO,
  COLS,
  CELL_W,
  CELL_H,
  ROWS,
  readCatalog,
  petsDir,
  packDir,
  listLocal,
  mergeList,
  packManifest,
  licenseText,
  verifyBuffer,
  assetUrls,
  httpFetch,
  loadSticky,
  fetchAtlas,
  downloadOne,
  removeOne,
};
