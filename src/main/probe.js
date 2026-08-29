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
const NEUTRAL_LAST = { ok: true, vis: true, rect: null, pid: 4, cx: -9999, cy: -9999, li: 999999900, tick: 1000000000 };

/** 圆角区域命令文件（探针子进程轮询此文件执行 SetWindowRgn） */
const REGION_FILE = () => path.join(os.tmpdir(), 'sci-region-cmd.txt');
/** 截屏排除命令文件（探针子进程轮询此文件执行 SetWindowDisplayAffinity） */
const EXCLUDE_FILE = () => path.join(os.tmpdir(), 'sci-exclude-cmd.txt');
/** 鼠标穿透命令文件（内容 "hwnd 0|1"，探针执行 WS_EX_TRANSPARENT 切换） */
const PASSTHROUGH_FILE = () => path.join(os.tmpdir(), 'sci-transparent-cmd.txt');

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
        { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, LGC_PID: String(process.pid) } }
      );
    } catch (e) {
      console.error('[probe] 启动失败:', e.message);
      this.scheduleRestart();
      return;
    }
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => {
      this.buf += chunk;
      let idx;
      while ((idx = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, idx).trim();
        this.buf = this.buf.slice(idx + 1);
        if (!line) continue;
        try {
          this.last = JSON.parse(line);
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

  /** 请求一次采样（节流由调用方控制） */
  request() {
    if (!this.child || this.child.killed || this.pending) return;
    this.pending = true;
    this.child.stdin.write('probe\n', () => {
      this.pending = false;
    });
  }

  /**
   * 给小岛窗口设置圆角命中区域：写入命令文件，探针子进程会在下一次循环中执行。
   * 返回是否成功写入（探针是否存活）。
   */
  setRegion(hwnd, x, y, w, h, r) {
    if (!this.child || this.child.killed) return false;
    try {
      fs.writeFileSync(REGION_FILE(), `${hwnd} ${x} ${y} ${w} ${h} ${r}`, 'utf8');
      return true;
    } catch (e) {
      return false;
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
    if (this.child && !this.child.killed) {
      try {
        this.child.stdin.write('quit\n');
      } catch (e) {
        /* ignore */
      }
      setTimeout(() => {
        if (this.child && !this.child.killed) this.child.kill();
      }, 300);
    }
  }
}

module.exports = { Probe };
