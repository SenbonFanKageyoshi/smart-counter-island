'use strict';
/* 桌宠素材包：目录 + pet.json 清单 → 主进程读成 data URL 交给渲染层。
   支持三种写法（可混用）：
     1) 帧序列：{ "fps": 6, "frames": ["idle_1.png", "idle_2.png"] }
     2) 精灵图：{ "fps": 10, "sheet": "walk.png", "frames": 6, "cols": 6 }   // 从左到右按格切
     3) 单个动图：{ "file": "idle.webp", "fps": 12 } 或直接写字符串 "idle.webp"（GIF/WebP/APNG 自动播放）
   清单示例见 ensureSamplePack() 生成的 示例 素材包。
   路径一律相对素材包目录；只读取白名单里的图片扩展名。 */

const fs = require('fs');
const path = require('path');

const PACK_FILE = 'pet.json';
const IMG_EXT = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.svg'];
const STATE_NAMES = ['idle', 'walk', 'sleep', 'talk', 'quiet']; // quiet 缺省回落到 idle

/** 素材包内的说明文件（老师照着改即可） */
const PACK_README = [
  '桌宠素材包说明',
  '================',
  '',
  '这个文件夹里放两样东西：pet.json（清单）+ 图片文件。程序按清单把图切成帧来播放。',
  '',
  '【状态】程序会在这些状态里切换，至少要提供 idle：',
  '  idle   站着发呆（默认/待机）',
  '  walk   走动（左右自动翻转）',
  '  sleep  久无人互动时睡觉',
  '  talk   说话中',
  '  quiet  上课时间静默站立（可省，省了用 idle）',
  '',
  '【三种写法，可以混用】',
  '',
  '1) 帧序列（最直观，一帧一个文件）：',
  '   "idle": { "fps": 4, "frames": ["idle_1.png", "idle_2.png", "idle_3.png"] }',
  '',
  '2) 精灵图（一张长图切成 N 格，最省文件、最推荐）：',
  '   "walk": { "fps": 10, "sheet": "walk.png", "frames": 6, "cols": 6 }',
  '   // frames = 总帧数，cols = 每行几格；图片按「从左到右、从上到下」切',
  '',
  '3) 动图（GIF / 动态 WebP，浏览器自己播）：',
  '   "idle": { "file": "idle.webp", "fps": 12 }',
  '',
  '【清单顶层可选项】',
  '  "name":   素材包名字（配置页显示）',
  '  "scale":  默认大小百分比，100 = 原始像素大小',
  '  "anchorY": 脚底相对图片底部的偏移（px，正数往上抬），用来对齐"站在地面上"的位置',
  '  "fps":    没给状态单独写 fps 时的默认值',
  '',
  '【尺寸建议】',
  '  像素风：32×32 或 48×48 一帧；插画风：96×96 ~ 160×160 一帧',
  '  帧数：idle 2-4、walk 4-8、talk 2-4、sleep 2 就够',
  '  透明背景 PNG（或带 alpha 的 WebP）；左右朝向只需画一个方向（程序自动镜像）',
  '',
  '【去哪儿找素材 / 画素材】',
  '  · 免费可商用（CC0，最省心）：Kenney.nl、OpenGameArt（筛 CC0）、itch.io（筛 Free + CC0）',
  '  · 关键词：pixel art character sprite sheet / desktop pet sprite / 2d character sprite walk cycle',
  '  · 自己画：Aseprite、Piskel（网页版免费）、Krita；学校美术社团画一套最贴合校园风格',
  '  · AI 生成：生成"像素风角色 4 个走路姿势、透明背景"，再手动切帧对齐',
  '  · 注意版权：微信表情包、动漫/游戏角色（原神、宝可梦等）都有版权，教室里公开使用有风险；',
  '    商用素材站（如爱给网、CraftPix）要看清授权条款；不确定就用 CC0 或自己画。',
  '',
  '改完图后在「配置 → 桌宠 → 素材包」点「重新加载」立即生效。',
  '',
].join('\r\n');

/** 素材包默认目录：<userData>/pets/示例 */
function defaultPackDir(userDataDir) {
  return path.join(userDataDir, 'pets', '示例');
}

function isImage(file) {
  return IMG_EXT.includes(path.extname(String(file || '')).toLowerCase());
}

/** 归一化单个状态的写法 → { fps, files:[], sheet, count, cols } */
function normalizeState(def, defaultFps) {
  const out = { fps: Math.max(1, Math.min(30, parseInt(defaultFps, 10) || 6)), files: [], sheet: '', count: 0, cols: 0, kind: '' };
  if (!def) return out;
  if (typeof def === 'string') {
    if (!isImage(def)) return out;
    const ext = path.extname(def).toLowerCase();
    if (ext === '.gif' || ext === '.webp') {
      out.kind = 'anim';
      out.files = [def];
    } else {
      out.kind = 'single';
      out.files = [def];
    }
    return out;
  }
  if (typeof def !== 'object') return out;
  if (typeof def.fps === 'number') out.fps = Math.max(1, Math.min(30, Math.round(def.fps)));
  if (def.file && isImage(def.file)) {
    out.kind = 'anim';
    out.files = [def.file];
    return out;
  }
  if (def.sheet && isImage(def.sheet)) {
    out.kind = 'sheet';
    out.sheet = def.sheet;
    out.count = Math.max(1, Math.min(120, parseInt(def.frames, 10) || 1));
    out.cols = Math.max(1, Math.min(60, parseInt(def.cols, 10) || out.count));
    return out;
  }
  const arr = Array.isArray(def.frames) ? def.frames.filter(isImage) : [];
  if (arr.length) {
    out.kind = 'seq';
    out.files = arr;
  }
  return out;
}

/** 解析清单（纯函数）：json 对象 + 文件是否存在由 existsFn 判断 */
function parseManifest(json, existsFn) {
  const exists = typeof existsFn === 'function' ? existsFn : () => true;
  const errors = [];
  const j = json && typeof json === 'object' ? json : {};
  const out = {
    ok: false,
    name: String(j.name || '未命名桌宠').slice(0, 30),
    scale: Math.max(30, Math.min(300, parseInt(j.scale, 10) || 100)),
    anchorY: Math.max(-200, Math.min(200, parseInt(j.anchorY, 10) || 0)),
    fps: Math.max(1, Math.min(30, parseInt(j.fps, 10) || 6)),
    states: {},
    errors,
  };
  const src = j.states && typeof j.states === 'object' ? j.states : {};
  for (const name of STATE_NAMES) {
    const def = src[name];
    if (!def) continue;
    const st = normalizeState(def, out.fps);
    const files = st.sheet ? [st.sheet] : st.files;
    for (const f of files) {
      if (!exists(f)) errors.push(`${name}: 找不到文件 ${f}`);
    }
    const usable = files.length > 0 && files.every((f) => exists(f));
    if (!usable) {
      if (!files.length) errors.push(`${name}: 没有可用帧（fps/frames/sheet/file 至少写一个）`);
      continue;
    }
    out.states[name] = st;
  }
  if (!Object.keys(out.states).length) errors.push('没有任何可用状态（至少要 idle）');
  out.ok = !!out.states.idle;
  return out;
}

/** 读取素材包目录 → 清单（不做 base64，便于测试与状态显示） */
function readPack(dir) {
  const file = path.join(dir, PACK_FILE);
  if (!fs.existsSync(file)) return { ok: false, reason: 'no-manifest', dir, errors: [`缺少 ${PACK_FILE}`], states: {} };
  let json;
  try {
    json = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return { ok: false, reason: 'bad-json', dir, errors: [`pet.json 解析失败: ${e.message}`], states: {} };
  }
  const parsed = parseManifest(json, (rel) => fs.existsSync(path.join(dir, String(rel))));
  const stat = Object.keys(parsed.states).map((k) => {
    const s = parsed.states[k];
    return `${k}${s.kind === 'sheet' ? `(${s.count}帧精灵图)` : s.kind === 'anim' ? '(动图)' : `(${s.files.length}帧)`}`;
  });
  return { ...parsed, dir, reason: parsed.ok ? '' : 'incomplete', summary: stat.join(' ') };
}

function mimeOf(file) {
  const e = path.extname(file).toLowerCase();
  if (e === '.png') return 'image/png';
  if (e === '.webp') return 'image/webp';
  if (e === '.gif') return 'image/gif';
  if (e === '.svg') return 'image/svg+xml';
  if (e === '.bmp') return 'image/bmp';
  return 'image/jpeg';
}

/** 读成渲染层能直接用的 data URL（IPC 传字符串最稳） */
function packToPayload(dir, maxBytesPerFile) {
  const p = readPack(dir);
  if (!p.ok) return { ok: false, reason: p.reason, errors: p.errors || [], dir };
  const limit = maxBytesPerFile || 3 * 1024 * 1024;
  const states = {};
  const errors = [];
  for (const [name, st] of Object.entries(p.states)) {
    const files = st.sheet ? [st.sheet] : st.files;
    const urls = [];
    for (const rel of files) {
      const abs = path.join(dir, rel);
      try {
        const buf = fs.readFileSync(abs);
        if (buf.length > limit) {
          errors.push(`${name}: ${rel} 超过 ${Math.round(limit / 1048576)}MB，跳过`);
          continue;
        }
        urls.push(`data:${mimeOf(rel)};base64,${buf.toString('base64')}`);
      } catch (e) {
        errors.push(`${name}: 读取失败 ${rel}`);
      }
    }
    if (!urls.length) continue;
    states[name] = { fps: st.fps, frames: urls, sheet: st.kind === 'sheet' ? { count: st.count, cols: st.cols } : null };
  }
  return { ok: !!states.idle, name: p.name, scale: p.scale, anchorY: p.anchorY, states, errors, dir, summary: p.summary };
}

/** 内置示例素材包：纯 SVG 帧（ASCII 内容），用来验证管线、也给老师当模板 */
function sampleFrames() {
  const body = (x, y, w, h, r, fill) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${fill}"/>`;
  const eye = (cx, cy, r) => `<circle cx="${cx}" cy="${cy}" r="${r}" fill="#101828"/>`;
  /** 一帧小人：armSwing / bob 控制手脚与上下浮动，speaking 时张嘴 */
  const frame = (opts) => {
    const o = Object.assign({ bob: 0, swing: 0, mouth: 1.4, eye: 2.6, antenna: '#b9ccff' }, opts || {});
    const cx = 32;
    const cy = 56 + o.bob;
    return [
      '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">',
      `<ellipse cx="${cx}" cy="58" rx="13" ry="3.4" fill="rgba(0,0,0,0.22)"/>`,
      `<path d="M${cx - 11} ${cy - 2} L${cx - 17} ${cy + 8 + o.swing}" stroke="#4c7dff" stroke-width="3.5" stroke-linecap="round"/>`,
      `<path d="M${cx + 11} ${cy - 2} L${cx + 17} ${cy + 8 - o.swing}" stroke="#4c7dff" stroke-width="3.5" stroke-linecap="round"/>`,
      body(cx - 12, cy - 4, 24, 20, 7, '#4c7dff'),
      `<path d="M${cx - 6} ${cy + 16} L${cx - 6} ${cy + 21 + Math.max(0, o.swing) * 0.4}" stroke="#4c7dff" stroke-width="3.5" stroke-linecap="round"/>`,
      `<path d="M${cx + 6} ${cy + 16} L${cx + 6} ${cy + 21 + Math.max(0, -o.swing) * 0.4}" stroke="#4c7dff" stroke-width="3.5" stroke-linecap="round"/>`,
      `<path d="M${cx} ${cy - 28} L${cx} ${cy - 33}" stroke="#9fbcff" stroke-width="1.6"/>`,
      `<circle cx="${cx}" cy="${cy - 35}" r="2.6" fill="${o.antenna}"/>`,
      `<circle cx="${cx}" cy="${cy - 15}" r="13" fill="#6f9bff"/>`,
      eye(cx - 4.5, cy - 16, o.eye),
      eye(cx + 4.5, cy - 16, o.eye),
      `<ellipse cx="${cx}" cy="${cy - 10}" rx="2.8" ry="${o.mouth}" fill="#2a3550"/>`,
      `<circle cx="${cx - 8.5}" cy="${cy - 12}" r="2.2" fill="rgba(255,140,150,0.35)"/>`,
      `<circle cx="${cx + 8.5}" cy="${cy - 12}" r="2.2" fill="rgba(255,140,150,0.35)"/>`,
      '</svg>',
    ].join('');
  };
  return {
    idle: [frame({}), frame({ bob: 1.2 }), frame({})],
    walk: [frame({ swing: 4, bob: 0.6 }), frame({ swing: 0, bob: 0 }), frame({ swing: -4, bob: 0.6 }), frame({ swing: 0, bob: 0 })],
    sleep: [frame({ eye: 0.5, mouth: 1, antenna: '#6b7a99', bob: 1.5 }), frame({ eye: 0.5, mouth: 1, antenna: '#6b7a99', bob: 2.2 })],
    talk: [frame({ mouth: 3.2, antenna: '#ffe066' }), frame({ mouth: 1.4, antenna: '#ffe066' }), frame({ mouth: 2.6, antenna: '#ffe066' }), frame({ mouth: 1.4, antenna: '#ffe066' })],
    quiet: [frame({ bob: 0.4 })],
  };
}

/**
 * 生成（或修复）示例素材包：写 pet.json + 各状态 SVG 帧。
 * 返回 { created:[], dir, files:n }
 */
function ensureSamplePack(dir) {
  const created = [];
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    return { created, dir, files: 0, error: String(e.message) };
  }
  const frames = sampleFrames();
  const states = {};
  for (const [name, list] of Object.entries(frames)) {
    const names = [];
    list.forEach((svg, i) => {
      const f = `${name}_${i + 1}.svg`;
      const abs = path.join(dir, f);
      if (!fs.existsSync(abs)) {
        fs.writeFileSync(abs, svg, 'utf8');
        created.push(f);
      }
      names.push(f);
    });
    states[name] = { fps: name === 'walk' ? 8 : name === 'talk' ? 7 : 4, frames: names };
  }
  const manifest = {
    name: '示例小岛（占位素材）',
    scale: 100,
    anchorY: 0,
    fps: 4,
    note: '把 idle_*.svg 换成你自己的图即可：帧序列 / 精灵图 / 动图三种写法见 README「桌宠素材包」',
    states,
  };
  const mf = path.join(dir, PACK_FILE);
  // 清单缺失 / 坏 JSON / 没有 idle 状态时都重写一份可用清单（不动用户自己的图片文件）
  let needManifest = true;
  if (fs.existsSync(mf)) {
    try {
      const j = JSON.parse(fs.readFileSync(mf, 'utf8'));
      needManifest = !(j && j.states && j.states.idle);
    } catch (e) {
      needManifest = true;
    }
  }
  if (needManifest) {
    fs.writeFileSync(mf, JSON.stringify(manifest, null, 2), 'utf8');
    created.push(PACK_FILE);
  }
  // 顺手放一份格式说明（老师照着改就行）
  const readme = path.join(dir, '素材包说明.txt');
  if (!fs.existsSync(readme)) {
    fs.writeFileSync(readme, PACK_README, 'utf8');
    created.push('素材包说明.txt');
  }
  return { created, dir, files: created.length };
}

module.exports = {
  PACK_FILE,
  IMG_EXT,
  STATE_NAMES,
  defaultPackDir,
  isImage,
  normalizeState,
  parseManifest,
  readPack,
  packToPayload,
  sampleFrames,
  ensureSamplePack,
  mimeOf,
};
