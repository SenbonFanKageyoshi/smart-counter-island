'use strict';
/* ===== 壁纸功能 =====
   在教室大屏上把「倒数日 + 励志语」做成壁纸，并可选每天自动更换。

   零原生模块：图片在隐藏窗口里用 Canvas 画好（背景图/渐变 + 励志语 + 倒计时 + 落款），
   再由常驻 PowerShell 探针调用 SystemParametersInfo(SPI_SETDESKWALLPAPER) 设置到桌面；
   首次启用前会先记录当前壁纸路径，随时可「恢复原壁纸」。

   产物落在 %APPDATA%\SmartCounterIsland\wallpapers\。
*/
const fs = require('fs');
const path = require('path');
const { BrowserWindow, app, screen } = require('electron');

/** 内置励志语（可被配置页里的自定义语录覆盖/追加） */
const BUILTIN_QUOTES = [
  '今天的努力，是明天的底气',
  '每一道题，都是通往更好学校的台阶',
  '你现在的每一分钟，都在决定未来的录取通知书',
  '把简单的事做到极致，就是不简单',
  '不必比别人快，只要比昨天的自己强',
  '别人休息时你多走一步，考场就多一分从容',
  '静下来，沉下去，答案自然会浮现',
  '所有的逆袭，都是有备而来',
  '现在的苦，是将来选择权的价格',
  '越努力，越幸运',
  '汗水不会说谎，分数不会辜负',
  '你只管努力，剩下的交给时间',
  '把每一次考试都当成练习，把每一次练习都当成考试',
  '目标定得高一点，脚步就不会太慢',
  '慢慢来，比较快',
  '与其临渊羡鱼，不如退而结网',
  '读书是为了拥有选择的权利',
  '不怕慢，只怕站',
  '今日事，今日毕',
  '积累就是复利，坚持就是答案',
  '你未来的样子，藏在你现在的努力里',
  '考场上没有奇迹，只有熟练',
  '每一次坚持，都在悄悄拉开差距',
  '先完成，再完美',
  '把目标写下来，它就不再是幻想',
  '自律的程度，决定人生的高度',
  '眼下的困难，是成长的入场券',
  '努力到无能为力，拼搏到感动自己',
  '不为失败找理由，只为成功找方法',
  '所有的优秀，都是自律的产物',
  '每天进步一点点，一年就是奇迹',
  '时间会给坚持的人最好的回报',
  '咬牙坚持的每一天，都在改变结局',
  '心静则智生，心乱则愚起',
  '路虽远，行则将至',
  '事虽难，做则必成',
  '把简单的事做到极致，就是不平凡',
  '未来可期，你也是',
  '相信自己，你比想象中更强大',
  '所有的焦虑，都来源于不够努力',
];

/** 内置渐变底纹（按索引取，无需任何素材文件） */
const GRADIENT_PRESETS = [
  ['#0f2027', '#203a43', '#2c5364'],
  ['#141e30', '#243b55', '#3a6186'],
  ['#1a2a6c', '#2a4d8f', '#11324d'],
  ['#232526', '#2c3e50', '#414345'],
  ['#0b486b', '#16536f', '#3b7a9e'],
  ['#1f1c2c', '#28273c', '#35113f'],
  ['#2b5876', '#3f6f9c', '#4e4376'],
  ['#0f1a2b', '#1b2f4a', '#2c4a70'],
];

/** 依据日期/序号稳定取一条语录（同一天结果固定，便于"每天一张"语义） */
function pickQuote(seedIndex, custom, useBuiltin) {
  const customList = String(custom || '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  let list = [];
  if (useBuiltin !== false) list = list.concat(BUILTIN_QUOTES);
  list = list.concat(customList);
  if (!list.length) return '';
  const i = Math.abs(Math.round(seedIndex)) % list.length;
  return list[i];
}

/** 列出图片文件夹里的可用壁纸（jpg/png/webp/bmp） */
function listImages(folder) {
  try {
    if (!folder || !fs.existsSync(folder)) return [];
    const exts = ['.jpg', '.jpeg', '.png', '.webp', '.bmp'];
    return fs
      .readdirSync(folder)
      .filter((f) => exts.includes(path.extname(f).toLowerCase()))
      .map((f) => path.join(folder, f));
  } catch (e) {
    return [];
  }
}

/** 读取当前桌面壁纸路径（注册表；失败返回空串） */
function readCurrentWallpaper() {
  try {
    const { execFileSync } = require('child_process');
    const out = execFileSync('reg', ['query', 'HKCU\\Control Panel\\Desktop', '/v', 'WallPaper'], { encoding: 'utf8' });
    const m = out.match(/WallPaper\s+REG_SZ\s+(.+)/);
    return m ? m[1].trim() : '';
  } catch (e) {
    return '';
  }
}

/** 生成任务用的隐藏渲染窗口（复用同一个窗口，避免反复创建） */
class WallpaperMaker {
  constructor(settings, probe) {
    this.settings = settings;
    this.probe = probe;
    this.win = null;
    this.busy = false;
    this.rotatedThisRun = false; // 「每次启动换一次」用：同一次运行只换一次
    this.outDir = path.join(app.getPath('userData'), 'wallpapers');
    this.sourceDir = path.join(this.outDir, 'source');
  }

  /** 用户放壁纸图片的默认文件夹（留空 folder 时使用）；顺手写一份说明文件 */
  defaultFolder() {
    try {
      fs.mkdirSync(this.sourceDir, { recursive: true });
      const readme = path.join(this.sourceDir, '把壁纸图片放在这里.txt');
      if (!fs.existsSync(readme)) {
        fs.writeFileSync(
          readme,
          ['把壁纸图片（jpg/png/webp/bmp）放进这个文件夹，程序会在上面加上励志语并设为桌面壁纸。', '', '· 建议尺寸与屏幕分辨率一致或更大（程序会按「铺满裁剪」或「完整显示」处理）', '· 多张图片会按日期自动轮换；「立即更换」会切到下一张', '· 文案内容在「配置 → 壁纸」里设置', ''].join('\r\n'),
          'utf8'
        );
      }
    } catch (e) {
      /* ignore */
    }
    return this.sourceDir;
  }

  /** 实际使用的图片文件夹 */
  resolveFolder() {
    const w = (this.settings.load().ui.wallpaper || {});
    const f = String(w.folder || '').trim();
    return f || this.defaultFolder();
  }

  ensureWindow() {
    if (this.win && !this.win.isDestroyed()) return this.win;
    this.win = new BrowserWindow({
      width: 480,
      height: 320,
      show: false,
      frame: false,
      skipTaskbar: true,
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload', 'wallpaper-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
      },
    });
    this.win.loadFile(path.join(__dirname, '..', 'renderer', 'wallpaper', 'index.html'));
    return this.win;
  }

  /** 只渲染，返回 base64 PNG（配置页预览用，不落盘、不改桌面） */
  async renderToBase64(job) {
    const win = this.ensureWindow();
    if (win.webContents.isLoading()) {
      await new Promise((r) => win.webContents.once('did-finish-load', r));
    }
    const b64 = await win.webContents.executeJavaScript(`window.Wallpaper.render(${JSON.stringify(job)})`);
    if (typeof b64 !== 'string' || b64.length < 100) throw new Error('渲染失败');
    return b64;
  }

  /** 渲染并存成 PNG 文件，返回文件路径（rotate 用） */
  async render(job) {
    const b64 = await this.renderToBase64(job);
    fs.mkdirSync(this.outDir, { recursive: true });
    const file = path.join(this.outDir, `wallpaper-${Date.now()}.png`);
    fs.writeFileSync(file, Buffer.from(b64, 'base64'));
    // 只保留最近 12 张，避免长期占用空间
    try {
      const files = fs
        .readdirSync(this.outDir)
        .filter((f) => f.startsWith('wallpaper-') && f.endsWith('.png'))
        .map((f) => ({ f, t: fs.statSync(path.join(this.outDir, f)).mtimeMs }))
        .sort((a, b) => b.t - a.t);
      for (const it of files.slice(12)) fs.unlinkSync(path.join(this.outDir, it.f));
    } catch (e) {
      /* ignore */
    }
    return file;
  }

  /** 组装一次更换：选底图 + 选语录 + 画 + 设置，并写入状态 */
  async rotate(opts) {
    if (this.busy) return { ok: false, reason: 'busy' };
    this.busy = true;
    try {
      const st = this.settings.load();
      const w = (st.ui && st.ui.wallpaper) || {};
      const disp = screen.getPrimaryDisplay();
      const size = disp.size || { width: 1920, height: 1080 };
      if (!w.original) {
        const cur = readCurrentWallpaper();
        if (cur) this.settings.update({ ui: { wallpaper: { original: cur } } });
      }
      // 底图：优先用用户文件夹里的图片（在上面加文字），没有则用内置渐变兜底
      const folder = this.resolveFolder();
      const images = listImages(folder);
      const idx = nextIndex(images.length, w);
      const pick = idx >= 0 ? images[idx] : '';
      let bgImage = null;
      if (pick) {
        try {
          const ext = path.extname(pick).toLowerCase();
          const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : ext === '.bmp' ? 'image/bmp' : 'image/jpeg';
          bgImage = `data:${mime};base64,` + fs.readFileSync(pick).toString('base64');
        } catch (e) {
          bgImage = null;
        }
      }
      // 励志语：每次轮换前进一条（顺序）或随机取一条；顺序时不会与上一条重复
      const qSeed = w.order === 'random' ? Math.floor(Math.random() * 1e9) : w.quoteIndex || 0;
      const quote = pickQuote(qSeed, w.quotes, w.useBuiltinQuotes !== false);
      const file = await this.render({
        width: size.width,
        height: size.height,
        quote,
        bgType: bgImage ? 'image' : 'gradient',
        bgColor: GRADIENT_PRESETS[Math.abs(idx >= 0 ? idx : 0) % GRADIENT_PRESETS.length],
        bgImage,
        fit: w.fit === 'contain' ? 'contain' : 'cover',
        dim: typeof w.dim === 'number' ? Math.max(0, Math.min(0.7, w.dim)) : 0.32,
        scrim: w.scrim !== false,
        school: w.school || '',
        position: w.position || 'center',
        scale: w.scale || 100,
        subline: w.subline || '',
      });
      const setOk = this.apply(file);
      this.settings.update({
        ui: {
          wallpaper: {
            lastDate: todayKey(),
            lastRotateAt: Date.now(),
            lastFile: file,
            lastQuote: quote,
            lastSource: pick ? path.basename(pick) : '',
            lastIndex: images.length ? idx : -1,
            quoteIndex: (w.quoteIndex || 0) + 1,
            original: (this.settings.load().ui.wallpaper || {}).original || '',
          },
        },
      });
      return {
        ok: true,
        file,
        quote,
        set: setOk,
        source: pick ? path.basename(pick) : '内置渐变',
        index: images.length ? idx + 1 : 0,
        total: images.length,
      };
    } catch (e) {
      return { ok: false, reason: String(e && e.message ? e.message : e) };
    } finally {
      this.busy = false;
    }
  }

  /** 把图片设为桌面壁纸（交给常驻探针执行 SP I_SETDESKWALLPAPER） */
  apply(file) {
    if (!file || !fs.existsSync(file)) return false;
    if (!this.probe) return false;
    return this.probe.setWallpaper(file);
  }

  /** 恢复为「启用壁纸功能之前的桌面壁纸」 */
  restore() {
    const w = (this.settings.load().ui.wallpaper || {});
    const orig = w.original || readCurrentWallpaper();
    if (!orig) return { ok: false, reason: 'no-original' };
    const ok = this.apply(orig);
    return { ok, file: orig };
  }

  /** 到点就换一张（启动后与之后的定时检查各调一次；只有「该换」时才真的动壁纸） */
  maybeRotate() {
    const w = (this.settings.load().ui.wallpaper || {});
    if (!w.enabled || w.autoDaily === false) return null;
    const interval = typeof w.intervalMin === 'number' ? w.intervalMin : DEFAULT_INTERVAL_MIN;
    if (interval <= 0) {
      // 0 = 每次启动换一次（同一次运行只换一次）
      if (this.rotatedThisRun) return null;
      this.rotatedThisRun = true;
      return this.rotate();
    }
    if (interval >= DEFAULT_INTERVAL_MIN) {
      // 每天（或更久）：按日期判断，重启也不会在同一天重复换
      return w.lastDate === todayKey() ? null : this.rotate();
    }
    // 按分钟计频：从「上次更换时刻」起算（点过「立即更换」会自动顺延）
    const last = w.lastRotateAt || 0;
    return Date.now() - last >= interval * 60000 ? this.rotate() : null;
  }

  /** 距离下次自动轮换还有多少毫秒（-1 = 不自动；0 = 每次启动） */
  nextRotateIn() {
    const w = (this.settings.load().ui.wallpaper || {});
    if (!w.enabled || w.autoDaily === false) return -1;
    const interval = typeof w.intervalMin === 'number' ? w.intervalMin : DEFAULT_INTERVAL_MIN;
    if (interval <= 0) return 0;
    if (interval >= DEFAULT_INTERVAL_MIN) {
      const d = new Date();
      d.setHours(24, 0, 0, 0); // 明天 0 点
      return w.lastDate === todayKey() ? Math.max(0, d.getTime() - Date.now()) : 0;
    }
    const last = w.lastRotateAt || 0;
    return Math.max(0, last + interval * 60000 - Date.now());
  }

  destroy() {
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    this.win = null;
  }
}

function todayKey() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 默认轮换频率：1440 分钟 = 每天 */
const DEFAULT_INTERVAL_MIN = 1440;

/**
 * 下一张要用的底图下标（-1 = 没有图片，用内置渐变兜底）。
 * 顺序：按文件名排好后逐张前进；倒序：反向前进；随机：随机取一张且不与上一张相同。
 */
function nextIndex(count, w) {
  if (!count) return -1;
  const last = typeof w.lastIndex === 'number' ? w.lastIndex : -1;
  if (w.order === 'random') {
    if (count === 1) return 0;
    let i = last;
    while (i === last) i = Math.floor(Math.random() * count);
    return i;
  }
  const step = w.order === 'reverse' ? -1 : 1;
  if (last < 0 || last >= count) return step > 0 ? 0 : count - 1;
  return (((last + step) % count) + count) % count;
}

module.exports = {
  WallpaperMaker,
  BUILTIN_QUOTES,
  GRADIENT_PRESETS,
  DEFAULT_INTERVAL_MIN,
  pickQuote,
  listImages,
  readCurrentWallpaper,
  nextIndex,
  todayKey,
};
