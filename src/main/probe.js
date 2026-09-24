'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { app } = require('electron');

// 自检模式：真实桌面状态会被固定成中性快照，避免自动 tick(350ms) 用真实前台/光标数据随机干扰断言
const TEST_MODE =
  process.argv.includes('--test') || process.argv.includes('--shot') || process.argv.includes('--smoke');
// 中性快照：无遮挡、光标远离、最后输入时间很近（= 有操作）→ 新逻辑下有操作 → 细条，
// 自动 tick(350ms) 稳定落在细条，不干扰断言
const NEUTRAL_LAST = { ok: true, vis: true, rect: null, pid: 4, cx: -9999, cy: -9999, li: 999999900, tick: 1000000000, fgClass: 'Sci_Neutral' };

/** 圆角区域命令文件（探针子进程轮询此文件执行 SetWindowRgn） */
const REGION_FILE = () => path.join(os.tmpdir(), 'sci-region-cmd.txt');
/** 截屏排除命令文件（探针子进程轮询此文件执行 SetWindowDisplayAffinity） */
const EXCLUDE_FILE = () => path.join(os.tmpdir(), 'sci-exclude-cmd.txt');
/** 截屏排除回读结果文件（探针写回 GetWindowDisplayAffinity 的值：17=已排除） */
const EXCLUDE_RESULT_FILE = () => path.join(os.tmpdir(), 'sci-exclude-result.txt');
/** 鼠标穿透命令文件（内容 "hwnd 0|1"，探针执行 WS_EX_TRANSPARENT 切换） */
const PASSTHROUGH_FILE = () => path.join(os.tmpdir(), 'sci-transparent-cmd.txt');
/** 桌面壁纸命令文件（内容 = 图片绝对路径，探针执行 SystemParametersInfo(SPI_SETDESKWALLPAPER)） */
const WALLPAPER_FILE = () => path.join(os.tmpdir(), 'sci-wallpaper-cmd.txt');
/** 壁纸设置回读结果文件（探针写回 "set=True path=..."） */
const WALLPAPER_RESULT_FILE = () => path.join(os.tmpdir(), 'sci-wallpaper-result.txt');

/**
 * 系统探针：常驻 PowerShell 子进程。
 * 每收到一行 "probe" 就返回前台窗口矩形 + 光标位置 + 最后输入时间（JSON 一行）。
 * 失败时自动重启；完全不可用时 last 保持 null，上层降级为「始终紧凑显示」。
 */
class Probe {
  constructor() {
    this.child = null;
    this.last = null;
    this.buf = '';
    this.pending = false;
    this.stopped = false;
    this.restartTimer = null;
    this.startedAt = 0;
    this.ready = false;
  }

  get helperPath() {
    // 打包后：resources/win-probe.ps1（extraResources）；开发时：项目内脚本
    const candidates = [
      process.resourcesPath ? path.join(process.resourcesPath, 'win-probe.ps1') : null,
      path.join(__dirname, 'win-probe.ps1'),
    ];
    for (const p of candidates) {
      if (p && fs.existsSync(p)) return p;
    }
    return candidates[candidates.length - 1];
  }

  start() {
    if (this.stopped) return;
    const script = this.helperPath;
    if (!fs.existsSync(script)) {
      console.error('[probe] 找不到探针脚本:', script);
      return;
    }
    this.startedAt = Date.now();
    this.ready = false;
    try {
      this.child = spawn(
        'powershell.exe',
        ['-Sta', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script],
        {
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
          // LGC_FAST：自检加速模式下让探针用更短的采样间隔
          env: { ...process.env, LGC_PID: String(process.pid), LGC_FAST: process.env.SCI_TEST_FAST || '' },
        }
      );
    } catch (e) {
      console.error('[probe] 启动失败:', e.message);
      this.scheduleRestart();
      return;
    }
    this.child.stdout.setEncoding('utf8');
    // 探针被关掉/自己退出后再往 stdin 写会抛 EPIPE：必须挂上 error 处理，
    // 否则这个异步错误会变成主进程未捕获异常（Electron 会弹出崩溃框）。
    if (this.child.stdin) this.child.stdin.on('error', () => {});
    this.child.stdout.on('data', (chunk) => {
      this.buf += chunk;
      let idx;
      while ((idx = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, idx).trim();
        this.buf = this.buf.slice(idx + 1);
        if (!line) continue;
        try {
          const parsed = JSON.parse(line);
          // frozen：自检/诊断注入的画面状态不被真实采样覆盖（否则测试等一个动画就被冲掉）
          if (this.frozen) {
            this.ready = true;
            continue;
          }
          this.last = parsed;
          this.ready = true;
          if (TEST_MODE) this.last = { ...NEUTRAL_LAST }; // 忽略真实桌面状态
        } catch (e) {
          /* 忽略非 JSON 输出 */
        }
      }
    });
    this.child.stderr.on('data', (d) => {
      // Add-Type 首次编译会输出少量警告，忽略
      if (process.env.DSH_LGC_DEBUG) console.error('[probe:stderr]', String(d).trim());
    });
    this.child.on('exit', (code) => {
      this.child = null;
      this.ready = false;
      if (!this.stopped) {
        if (process.env.DSH_LGC_DEBUG) console.error('[probe] 退出 code=', code, '，准备重启');
        this.scheduleRestart();
      }
    });
    this.child.on('error', (err) => {
      console.error('[probe] 子进程错误:', err.message);
      this.child = null;
      if (!this.stopped) this.scheduleRestart();
    });
  }

  scheduleRestart() {
    if (this.stopped || this.restartTimer) return;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.start();
    }, 2000);
  }

  /** 请求一次采样（节流由调用方控制）
      lite = true 时用轻量探测：跳过通知枚举（全屏隐藏期间不需要），
      PowerShell 侧每次采样省掉一轮窗口枚举，CPU 占用显著下降。 */
  request(lite) {
    if (!this.child || this.child.killed || this.pending) return;
    this.pending = true;
    this.child.stdin.write(lite ? 'probe-lite\n' : 'probe\n', () => {
      this.pending = false;
    });
  }

  /** 给小岛窗口设置圆角命中区域：写入命令文件，探针子进程会在下一次循环中执行。
      返回是否成功写入（探针是否存活）。 */
  setRegion(hwnd, x, y, w, h, r) {
    if (!this.child || this.child.killed) return false;
    try {
      fs.writeFileSync(REGION_FILE(), `${hwnd} ${x} ${y} ${w} ${h} ${r}`, 'utf8');
      return true;
    } catch (e) {
      return false;
    }
  }

  /** 读回最近一次写入的区域命令内容（测试用） */
  readRegionCommand() {
    try {
      return fs.readFileSync(REGION_FILE(), 'utf8').trim();
    } catch (e) {
      return '';
    }
  }

  /** 圆角命令文件是否已被探针消费（测试用） */
  regionFileConsumed() {
    return !fs.existsSync(REGION_FILE());
  }

  /** 设置截屏排除（WDA_EXCLUDEFROMCAPTURE）：屏幕截屏不再包含小岛自身 */
  setExcludeFromCapture(hwnd) {
    if (!this.child || this.child.killed) return false;
    try {
      fs.writeFileSync(EXCLUDE_FILE(), String(hwnd), 'utf8');
      return true;
    } catch (e) {
      return false;
    }
  }

  /** 截屏排除命令是否已被探针消费（测试用） */
  excludeFileConsumed() {
    return !fs.existsSync(EXCLUDE_FILE());
  }

  /**
   * 设置桌面壁纸（SPI_SETDESKWALLPAPER）：写入命令文件，探针子进程在下一次循环执行。
   * 内容为图片绝对路径。返回是否成功写入命令文件。
   */
  setWallpaper(path) {
    if (!this.child || this.child.killed) return false;
    try {
      fs.writeFileSync(WALLPAPER_FILE(), String(path || ''), 'utf8');
      return true;
    } catch (e) {
      return false;
    }
  }

  /** 壁纸命令文件是否已被探针消费（测试用） */
  wallpaperFileConsumed() {
    return !fs.existsSync(WALLPAPER_FILE());
  }

  /** 读回壁纸设置结果：内容 "set=True path=..." */
  readWallpaperResult() {
    try {
      return fs.readFileSync(WALLPAPER_RESULT_FILE(), 'utf8').trim();
    } catch (e) {
      return '';
    }
  }

  /** 读回截屏排除结果：内容 "set=True aff=17" 表示设置成功且回读为已排除 */
  readExcludeResult() {
    try {
      const f = EXCLUDE_RESULT_FILE();
      if (!fs.existsSync(f)) return null;
      const raw = fs.readFileSync(f, 'utf8').trim();
      fs.unlinkSync(f);
      const aff = parseInt((raw.match(/aff=(\d+)/) || [])[1], 10);
      return Number.isFinite(aff) ? aff : null;
    } catch (e) {
      return null;
    }
  }

  /** 读回原始排除结果文本（诊断用） */
  readExcludeResultRaw() {
    try {
      const f = EXCLUDE_RESULT_FILE();
      if (!fs.existsSync(f)) return null;
      const raw = fs.readFileSync(f, 'utf8').trim();
      return raw;
    } catch (e) {
      return null;
    }
  }

  /** 设置鼠标穿透（WS_EX_TRANSPARENT）：true = 点击穿透（全屏遮挡时用），false = 恢复正常交互 */
  setMousePassthrough(hwnd, on) {
    if (!this.child || this.child.killed) return false;
    try {
      fs.writeFileSync(PASSTHROUGH_FILE(), `${hwnd} ${on ? '1' : '0'}`, 'utf8');
      return true;
    } catch (e) {
      return false;
    }
  }

  /** 鼠标穿透命令是否已被探针消费（测试用） */
  passthroughFileConsumed() {
    return !fs.existsSync(PASSTHROUGH_FILE());
  }

  stop() {
    this.stopped = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    const child = this.child;
    this.child = null; // 先摘掉引用：exit 回调里不会再触发重启
    if (!child) return;
    // 先礼后兵：试着让它自己退出，然后立刻杀掉 —— 应用马上要退了，
    // 不能等 300ms 定时器（那时进程已经结束，定时器永远不会跑，探针会变成孤儿占 CPU）。
    try {
      const stdin = child.stdin;
      if (stdin && !stdin.destroyed && stdin.writable) stdin.write('quit\n');
    } catch (e) {
      /* EPIPE 等：忽略，下面照样 kill */
    }
    try {
      if (!child.killed) child.kill();
    } catch (e) {
      /* ignore */
    }
  }
}

module.exports = { Probe };
