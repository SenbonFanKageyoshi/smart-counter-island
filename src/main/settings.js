'use strict';
const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const sensors = require('./sensors');

/** 默认设置（深合并到用户配置上） */
function defaultEvent() {
  // 默认事件：下一个 6 月 7 日（高考）
  const now = new Date();
  let year = now.getFullYear();
  let target = new Date(year, 5, 7, 9, 0, 0);
  if (target.getTime() <= now.getTime()) {
    year += 1;
    target = new Date(year, 5, 7, 9, 0, 0);
  }
  return {
    id: 'gaokao',
    name: '高考',
    emoji: '🎓',
    color: '#4f7cff',
    date: fmtDate(target),
    enabled: true,
  };
}

function fmtDate(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 一种状态窗口的位置配置 */
function defaultPosition() {
  return { mode: 'top-center', x: null, y: null };
}

const DEFAULTS = {
  version: 3,
  events: [defaultEvent()],
  ui: {
    // 玻璃效果: 'auto'(真实截屏模糊,失败自动回退) | 'fake'(纯 CSS 模拟) | 'off'(关闭,黑底白字)
    glassMode: 'auto',
    // 玻璃高光强度（百分比）：100 = 默认观感；0 = 完全无高光（只留折射与边线）；可上调到 200
    glassGlow: 100,
    // 液态玻璃 CPU 链路的观感（0 = 按玻璃高度自适应；玻璃实验室窗口里调好可直接写回这里）
    refractWidth: 0,      // 边缘折射带宽度（px，3–64；0 = 自适应 ≈20% 高）
    maxRefract: 0,        // 边缘最大折射位移（px，2–18；0 = 自适应 ≈7% 高）
    bleedOpacity: 70,     // 边缘渗色不透明度（百分比，0 = 无渗色）
    glassAberration: 0,   // 边缘色散（px，0 = 关闭；>0 时 R/G/B 三次折射错位合成，岛默认 0）
    // 计时坞暂停：{ key, leftMs, at }（key = 'kind:name|date'，leftMs = 暂停时剩余毫秒）
    dockPaused: null,
    // GPU 液态玻璃的刷新帧率（1–60）：只对「液态玻璃（GPU 加速）」生效；
    // CPU 链路用 smart.bgRefreshSec（秒）控制刷新，两条链路互不影响
    gpuGlassFps: 30,
    // GPU 液态玻璃的观感微调（百分比，100 = 默认；只作用于「液态玻璃（GPU 加速）」着色器）
    glEdgeGlow: 100,      // 边缘高光强度
    glBottomShade: 100,   // 底部阴影强度
    glRefract: 100,       // 边缘折射强度（最大位移量）
    glBand: 100,          // 边缘折射范围（折射带宽）
   // 壁纸功能：把用户提供的壁纸图片加一行励志语后设为桌面壁纸，可按频率自动轮换、可恢复原壁纸
    wallpaper: {
      enabled: false,
      source: 'folder',     // 'folder'（使用指定文件夹里的图片，推荐）| 'gradient'（内置渐变底纹兜底）
      folder: '',           // 图片文件夹（留空 = 用程序目录下的 wallpapers\source）
      fit: 'cover',         // 图片填充方式：'cover' 铺满裁剪 | 'contain' 完整显示（留边）
      dim: 0.32,            // 图片整体压暗（0–0.7，保证文字可读）
      scrim: true,          // 励志语后面加一层柔和暗色底衬（图片再花也读得清）
      quotes: '',           // 自定义励志语（一行一条，追加在内置语录之后）
      useBuiltinQuotes: true,
      school: '',           // 右下角落款（学校/班级）
      subline: '',          // 左下角小字（如班级口号）
      position: 'center',   // 'center' | 'bottom-left' | 'bottom-right' | 'top-center'
      scale: 100,           // 文字缩放（40–250，%）
      autoDaily: true,      // 自动轮换开关
      intervalMin: 1440,    // 轮换频率（分钟）：1440 = 每天；0 = 每次启动换一次
      order: 'seq',         // 轮换顺序：'seq' 按文件名顺序 | 'reverse' 倒序 | 'random' 随机
      original: '',         // 启用前的原壁纸路径（用于「恢复原壁纸」）
      lastDate: '',         // 最近一次轮换日期
      lastRotateAt: 0,      // 最近一次轮换时刻（按分钟计频用）
      lastFile: '',         // 最近一次生成的壁纸文件
      lastQuote: '',        // 最近一次使用的励志语（配置页回显）
      lastSource: '',       // 最近一次使用的图片文件名
      lastIndex: -1,        // 最近一次使用的图片下标（轮换顺序用）
      quoteIndex: 0,        // 语录计数器
    },
    // 传感器避让：传感器（摄像头）位置固定，黑色背景把它整个裹住，内容绕开它。
    //   细条左右分栏（图标 | 传感器 | 数字），横幅/大卡片长到传感器下方。
    cameraNotch: {
      enabled: false,
      preset: sensors.DEFAULT_PRESET, // 位置预设（只保留「中置传感器」）
      radius: 30,          // 胶囊圆角
      debug: false,        // 显示传感器彩色圆点 + 禁区虚线框
      sensors: sensors.PRESETS[sensors.DEFAULT_PRESET].sensors, // 一行一个：dx,y,直径（dx 相对屏幕水平中心）
      zoneMode: 'auto',    // 'auto' 由传感器并集 + 空隙算出 | 'manual' 用下面的矩形
      zone: { ...sensors.PRESETS[sensors.DEFAULT_PRESET].zone },
      margin: 6,           // 禁区在传感器并集外再外扩（px）
      slotLeft: 14,        // 内容与禁区之间的空隙（左，规格 left_slot.offset）
      slotRight: 12,       // 内容与禁区之间的空隙（右，规格 right_slot.offset）
      slotBelow: 4,        // below 布局里内容再往下让出的额外空隙（px）
      layout: 'auto',      // 内容布局：'auto' | 'split' | 'below' | 'none'
      animMs: 550,         // 黑色背景伸缩时长（规格 0.55s）
      animEase: 'cubic-bezier(.32,.72,.28,1)',
      // 盖板自定义内容：画在中那块传感器盖板窗口上的文字（模板 + 程序变量，见 main/cover-text.js）
      text: {
        template: '',      // 例：'{name} 还有 {days}{unit}' / '{time} {temp}°'；空 = 不显示
        size: 11,          // 字号（9-18px；盖板窗口只有禁区那么大，太长会省略号截断）
      },
    },
    // 位置模式（兼容旧版配置；新配置按 positions 分状态设置）
    position: 'top-center',
    // 所在显示器: 'cursor' | 'primary' | 'index'
    display: 'cursor',
    displayIndex: 0,
    // 三种状态窗口各自的独立位置
    positions: {
      strip: defaultPosition(),     // 细条（默认形态）
      expanded: defaultPosition(),  // 放大版灵动岛（操作时展开）
      zoom: defaultPosition(),      // 最大窗口
    },
    customPos: null, // 旧版拖动位置（仅迁移用）
    // 细条样式：'black' 黑底白字（无效果） | 'glass' 跟随玻璃效果
    stripStyle: 'black',
    opacity: { strip: 0.6, expanded: 0.9, zoom: 0.96, corner: 0.9, progress: 0.55 },
    alwaysOnTop: true,
    showSeconds: true,
    // 灵动岛日期估算方式：'ceil' 向上取整（不足一天算一天） | 'round' 四舍五入 | 'floor' 向下取整
    dayRounding: 'floor',
    showPast: false,
    // 可选：文言文显示
    classical: false,
    // 配置窗口暗色模式
    darkMode: false,
    // 开机自启
    autoStart: false,
  },
  smart: {
    enabled: true,          // 总开关（智能隐藏/透明度/放大）
    // 全屏授课时（真全屏，不含窗口最大化）的行为：
    fullscreenMode: 'hide',
    progressTotalDays: 365, // 进度条总量（天）：填充比例 = (总量 - 剩余天数) / 总量
    hideOnMaximized: true,  // 前台窗口最大化时保持细条（不展开遮挡）
    expandIdleSec: 4,       // 无操作多少秒后放宽（横幅模式已去掉：直接进大窗口）
    // 自动弹出大窗口的额外门槛，**默认 0 = 不自动弹**。
    // 理由：大窗口会盖住桌面内容，而且它是鼠标穿透的（点不到、也关不掉），
    // "只要十几秒不碰键鼠就自己冒出来"在授课场景里是纯打扰。
    // 想要自动弹出的用户可显式设成 > 0（届时闲置到 max(expandIdleSec, 本值) 才进大窗口）。
    zoomIdleSec: 0,
    zoomEnabled: true,      // 允许大屏（手动/拖拽/自动）
    cycleEnabled: false,    // 放大时轮播多个事件
    cycleSec: 6,
    // 系统通知接管
    notifyEnabled: true,    // 检测系统通知并在小岛显示
    notifyShowSec: 8,       // 通知显示时长（秒）
    // 系统通知的最小间隔（秒）：探针每 0.35~0.7 秒采一次，聊天软件刷屏会不停触发接管。
    // 设一个间隔把连续消息合并成一条，避免灵动岛一直闪；0 = 不节流。
    notifyMinGapSec: 5,
    // 高级设置
    animFps: 60,            // 窗口动画帧率（20-120；受系统定时器精度影响，>60 提升有限）
    animEnabled: true,      // 状态切换窗口动画开关（关闭 = 瞬间切换，低配友好）
    notifyShake: true,      // 通知正文开头 0.2s 震动特效
    bgRefreshSec: 1.6,      // 背景亮度/毛玻璃刷新间隔（秒；灵动岛自动用约 1.6 倍）
    hoverMargin: 30,        // 鼠标悬停保护范围（px）：光标在此范围内不因闲置展开
  },
  schedule: {
    enabled: false,         // 时间表（上下课时间）总开关
    cycleWeeks: 1,          // 几周一个循环（1 = 每周相同；2 = 单双周）
    restWeek: 0,            // 循环中第几周休息（0 = 不休；如 cycleWeeks=2, restWeek=2 → 双周休息）
    weeks: [                // cycleWeeks 套周课表；每套 7 天（周一~周日）
      [                     // 每节：{ start:'HH:MM', end:'HH:MM', name?:'数学'（科目，可留空） }
        { periods: [] }, { periods: [] }, { periods: [] },
        { periods: [] }, { periods: [] }, { periods: [] }, { periods: [] },
      ],
    ],
    // 课堂提醒：由时间表自动驱动（课前/上课/下课前/下课），不需要手动一条条配；
    // 与「系统通知的免打扰」互不影响 —— 课堂提醒属于教学刚需，必须弹出来
    notify: {
      enabled: true,
      beforeStart: 3,       // 课前 N 分钟提醒（0 = 关）
      atStart: true,        // 上课提醒
      beforeEnd: 2,         // 下课前 N 分钟提醒（0 = 关）
      atEnd: false,         // 下课提醒
      templateStart: '还有 {min} 分钟上课 · {label}',
      templateAtStart: '上课时间到 · {label}',
      templateBeforeEnd: '还有 {min} 分钟下课',
      templateAtEnd: '下课时间到',
    },
  },
  manual: {
    mode: 'auto', // 'auto' | 'pinned'(固定显示) | 'hidden'(强制隐藏成细条)
  },
  // 桌宠：教学助手（课间互动 / 提醒上课 / 答疑）。AI 可选，离线也能用（预置问答）
  pet: {
    enabled: false,            // 总开关（默认关，老师自己开）
    stage: { w: 360, h: 300 }, // 舞台窗口尺寸：桌宠在窗口内自由走动，走到边缘才整窗平移一格
    pack: '',                  // 素材包目录（留空 = <userData>/pets/示例，可点「生成示例素材包」）
    scale: 100,                // 桌宠大小（%）
    speed: 100,                // 走动速度（%）
    opacity: 0.95,             // 整体透明度
    x: null,                   // 舞台窗口位置（拖动后记住）
    y: null,
    hideOnFullscreen: true,    // 全屏授课/看视频时彻底隐藏
    quietInClass: true,        // 上课时间静默站立、不闲聊（只答课表与倒计时）
    announceClass: true,       // 上课/下课提醒时桌宠也出面念一遍
    // AI：OpenAI 兼容接口。**永不开启思考模式**（ai.js 里有硬性防呆）
    ai: {
      enabled: true,
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-chat',  // 非思考档；填 reasoner 之类会被强制改回
      apiKey: '',
      persona: '',             // 追加在系统提示后的班级要求（如"多鼓励、少用网络梗"）
      temperature: 0.7,
      maxTokens: 300,
      perMinute: 6,            // 每分钟最多问几次
      perDay: 200,             // 每天最多问几次
      cacheMinutes: 10,        // 同一个问题多久内复用答案（省钱）
      presetOnly: false,       // 只答老师的预置问答，不联网
    },
    guard: { maxChars: 120, blocked: [] }, // 输出护栏：长度上限 + 敏感词
    qa: [],                    // 老师预置问答：[{ q, a, keys: [] }]
  },
  // 节假日倒计时：到「还剩 leadDays 天」时自动用计时坞显示（黑底白字，效果同通知）
  // 农历节日（春节/端午/中秋）每年日期不同，需要老师按当年公历日期自己加一条
  holidays: {
    enabled: false,          // 开关
    leadDays: 30,            // 还剩多少天时开始进计时坞（0 = 一直显示）
    skipped: [],             // 已取消的节假日（'name|date'）—— 计时坞里点「取消」时写入
    items: [                 // { name, date: 'YYYY-MM-DD' }
      { name: '元旦', date: '2027-01-01' },
      { name: '劳动节', date: '2027-05-01' },
      { name: '国庆节', date: '2027-10-01' },
    ],
  },
  // 天气（Open-Meteo，免密钥）：预报展示 + 指定时间提醒 + 岛内动画
  weather: {
    enabled: false,          // 总开关（默认关，老师自己开）
    city: '北京',            // 城市名（自动地理编码成经纬度）
    resolvedName: '',        // 地理编码结果（展示给老师确认：城市 · 省/州 · 国家）
    lat: null,               // 经纬度（解析一次后缓存，避免反复请求）
    lon: null,
    refreshMin: 30,          // 刷新间隔（分钟；实际最小 10）
    timeoutMs: 8000,         // 单次请求超时（毫秒）
    unit: 'c',               // 温度单位 'c' | 'f'
    forecastDays: 7,         // 取几天预报（1-16）
    // 岛内显示：'always' 细条/横幅/大卡片都显示（常驻） | 'banner' 只在横幅/大卡片 | 'off' 不显示
    showInIsland: 'always',
    // 细条上天气的位置：'right' 右端（默认） | 'left' 左端 | 'cover' 盖板上（中间的传感器窗口）
    pos: 'right',
    anim: true,              // 天气动画（图标动画 + 提醒时整岛雨雪特效）
    animIntensity: 100,      // 动画强度（0-200；低配机可调低或关）
    alertKeywords: ['雨', '雪', '大风', '降温', '高温'], // 正文里这些词红色高亮
    rainLookaheadH: 6,       // 「降雨提醒」看未来几小时
    hotC: 35,                // 高温提醒阈值（℃）
    coldDropC: 8,            // 明天比今天低多少度就提醒添衣（℃）
    // 天气提醒规则表（独立于「定时任务」）：
    // { id, time:'HH:MM', days:'daily'|'once'|[0-6], kind:'now'|'today'|'tomorrow'|'rain'|'temp', enabled }
    reminders: [],
  },
  tasks: [], // 计划任务：{ id, type:'shutdown'|'boot'|'command'|'remind', time:'HH:MM', days:'daily'|'once'|[0-6], command, message, enabled }
};

let cache = null;
let filePath = null;

function settingsPath() {
  if (!filePath) {
    filePath = path.join(app.getPath('userData'), 'settings.json');
    // 旧版目录迁移：项目曾用名 LiquidGlassCounter，首次以新名启动时把旧设置搬过来
    if (!fs.existsSync(filePath)) {
      const oldPath = path.join(app.getPath('appData'), 'LiquidGlassCounter', 'settings.json');
      if (fs.existsSync(oldPath)) {
        try {
          fs.mkdirSync(path.dirname(filePath), { recursive: true });
          fs.copyFileSync(oldPath, filePath);
          console.log('[settings] 已从旧目录迁移设置:', oldPath);
        } catch (e) {
          console.error('[settings] 旧设置迁移失败:', e.message);
        }
      }
    }
  }
  return filePath;
}

function deepMerge(base, patch) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const k of Object.keys(patch || {})) {
    const pv = patch[k];
    const bv = out[k];
    if (pv && typeof pv === 'object' && !Array.isArray(pv) && bv && typeof bv === 'object' && !Array.isArray(bv)) {
      out[k] = deepMerge(bv, pv);
    } else {
      out[k] = pv;
    }
  }
  return out;
}

/** 全屏行为迁移（纯函数，便于单测）：
    旧版 smart.hideOnFullscreen（布尔）→ smart.fullscreenMode（枚举）。
    只在「磁盘上写了旧键 + 没有新键」时生效，返回是否发生了迁移。 */
function migrateFullscreenMode(diskSmart, cacheSmart) {
  if (!diskSmart || !cacheSmart) return false;
  if (diskSmart.hideOnFullscreen == null || diskSmart.fullscreenMode != null) return false;
  cacheSmart.fullscreenMode = diskSmart.hideOnFullscreen === false ? 'strip' : 'hide';
  return true;
}

/** 读取全部设置（含默认值） */
function load() {
  if (cache) return cache;
  let disk = {};
  try {
    if (fs.existsSync(settingsPath())) {
      disk = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
    }
  } catch (e) {
    console.error('[settings] 读取失败，使用默认设置:', e.message);
    disk = {};
  }
  cache = deepMerge(DEFAULTS, disk);
  let migrated = false;
  // —— 全屏行为迁移：旧版 hideOnFullscreen(布尔) → fullscreenMode(枚举) ——
  // 仅当磁盘上确实写着旧键、且没有新键时才迁移（默认值里的 fullscreenMode 不能当成"已设置"）
  if (cache.smart && migrateFullscreenMode(disk.smart, cache.smart)) migrated = true;
  if (cache.smart && cache.smart.hideOnFullscreen != null) {
    delete cache.smart.hideOnFullscreen;
    migrated = true;
  }
  // 新形态的透明度默认值（旧配置没有这两个键）
  if (cache.ui && cache.ui.opacity) {
    if (cache.ui.opacity.corner == null) cache.ui.opacity.corner = 0.9;
    if (cache.ui.opacity.progress == null) cache.ui.opacity.progress = 0.55;
  }
  // —— 废弃键清理 ——
  // ① weather.announcePet（天气语音/桌宠播报已按需求去掉）② pet.voice（更早版本的语音合成残留，无人读取）
  if (cache.weather && cache.weather.announcePet != null) {
    delete cache.weather.announcePet;
    migrated = true;
  }
  if (cache.pet && cache.pet.voice != null) {
    delete cache.pet.voice;
    migrated = true;
  }
  // —— 角落卡片已去掉：旧配置里的 fullscreenState='corner' 迁移到 'strip' ——
  if (cache.smart && cache.smart.fullscreenState === 'corner') {
    cache.smart.fullscreenState = 'strip';
    migrated = true;
  }
  // —— 「计时坞」不再是可常驻的手动模式 ——
  // 之前长按灵动岛进入坞时会写成 manual.mode = 'dock' 并被持久化，
  // 于是以后每次启动都直接停在计时坞（用户反馈："程序初始状态应该是灵动岛，不是计时坞"）。
  // 现在计时坞只在长按交互期间显示（由 dockEdit/dockMenu 驱动），所以把遗留值迁回自动。
  if (cache.manual && cache.manual.mode === 'dock') {
    cache.manual.mode = 'auto';
    migrated = true;
  }
  // 事件列表**允许为空**：用户在配置页删光之后就是真正的空态
  // （渲染层已有「暂无倒计时事件（托盘图标 → 配置）」提示，托盘也留着入口）。
  // 原先这里无条件补一条默认事件，导致用户删掉最后一个事件后，下次启动它又自己回来
  // —— 表现为「删除不生效」，很伤信任。改成只在**首次运行**（磁盘上从没写过 events 键）给一条示例。
  if (!disk || disk.events === undefined) {
    cache.events = [defaultEvent()];
  } else if (!Array.isArray(cache.events)) {
    cache.events = [];
  }
  // 修复历史坏数据：曾因 id 展开顺序错误产生 id 为 null 的事件，补一个唯一 id
  if (Array.isArray(cache.events) && cache.events.length) {
    cache.events = cache.events.map((e) => {
      if (!e || !e.id) {
        migrated = true;
        return { ...e, id: `ev_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}` };
      }
      return e;
    });
  }
  // —— 旧版配置迁移 ——
  // v3 起默认窗口固定为放大版（不可更改），旧 defaultState 字段不再使用
  if (cache.ui.defaultState != null) {
    delete cache.ui.defaultState;
    migrated = true;
  }
  if (!cache.ui.positions) {
    cache.ui.positions = { strip: defaultPosition(), expanded: defaultPosition(), zoom: defaultPosition() };
    migrated = true;
  }
  // v2 的 bar 状态 → expanded（放大版灵动岛）
  if (cache.ui.positions.bar && !cache.ui.positions.expanded) {
    cache.ui.positions.expanded = cache.ui.positions.bar;
    migrated = true;
  }
  delete cache.ui.positions.bar;
  // 已移除的 compact（灵动岛）位置 → expanded（放大版灵动岛）
  if (cache.ui.positions.compact) {
    if (!cache.ui.positions.expanded || cache.ui.positions.expanded.mode === 'top-center') {
      cache.ui.positions.expanded = cache.ui.positions.compact;
    }
    delete cache.ui.positions.compact;
    migrated = true;
  }
  if (cache.ui.customPos) {
    const cp = cache.ui.customPos;
    if (cache.ui.positions.expanded && cache.ui.positions.expanded.mode !== 'custom') {
      cache.ui.positions.expanded = { mode: 'custom', x: cp.x, y: cp.y };
      migrated = true;
    }
    cache.ui.customPos = null;
  }
  if (cache.ui.position && cache.ui.position !== 'top-center') {
    for (const key of Object.keys(cache.ui.positions)) {
      const p = cache.ui.positions[key];
      if (!p || (p.mode === 'top-center' && p.x == null)) {
        cache.ui.positions[key] = { mode: cache.ui.position, x: null, y: null };
        migrated = true;
      }
    }
  }
  // v2 透明度 bar → expanded；已移除的 compact 透明度 → expanded
  if (cache.ui.opacity && cache.ui.opacity.bar != null && cache.ui.opacity.expanded == null) {
    cache.ui.opacity.expanded = cache.ui.opacity.bar;
    migrated = true;
  }
  delete cache.ui.opacity.bar;
  if (cache.ui.opacity && cache.ui.opacity.compact != null && cache.ui.opacity.expanded == null) {
    cache.ui.opacity.expanded = cache.ui.opacity.compact;
    migrated = true;
  }
  delete cache.ui.opacity.compact;
  // —— 时间表结构迁移：旧版（单周 7 天带 name）→ 新版（多周循环，每天仅 periods）——
  if (cache.schedule) {
    const oldWeeks = cache.schedule.weeks;
    if (Array.isArray(oldWeeks) && oldWeeks.length === 7 && oldWeeks[0] && oldWeeks[0].name != null) {
      cache.schedule.weeks = [oldWeeks.map((d) => ({ periods: Array.isArray(d.periods) ? d.periods.map((p) => ({ start: p.start, end: p.end })) : [] }))];
      if (cache.schedule.cycleWeeks == null) cache.schedule.cycleWeeks = 1;
      if (cache.schedule.restWeek == null) cache.schedule.restWeek = 0;
      migrated = true;
    }
    // 旧版课程名 label 移除（仅保留 start/end）
    for (const week of cache.schedule.weeks || []) {
      for (const day of week || []) {
        if (Array.isArray(day.periods)) {
          day.periods = day.periods.map((p) => ({ start: p && p.start, end: p && p.end }));
        }
      }
    }
    if (cache.schedule.cycleWeeks == null) cache.schedule.cycleWeeks = 1;
    if (cache.schedule.restWeek == null) cache.schedule.restWeek = 0;
    if (!Array.isArray(cache.schedule.weeks) || cache.schedule.weeks.length === 0) {
      cache.schedule.weeks = [new Array(7).fill(null).map(() => ({ periods: [] }))];
      migrated = true;
    }
  }
  if (migrated) save();
  return cache;
}

/** 深合并保存补丁，返回新设置 */
function update(patch) {
  const cur = load();
  cache = deepMerge(cur, patch);
  normalizeCameraNotch(cache, patch);
  save();
  return cache;
}

/**
 * 传感器避让的归一化（纯数据整理，就地改 cache）：
 *   - 写预设名（非 custom）→ 展开成传感器列表 + 禁区矩形；
 *   - 位置预设只保留「中置传感器」，旧配置里的其它预设名一律回落到它。
 */
function normalizeCameraNotch(cfg, patch) {
  const c = cfg && cfg.ui && cfg.ui.cameraNotch;
  if (!c) return;
  const p = patch && patch.ui && patch.ui.cameraNotch;
  const presetKey = p && p.preset;
  if (presetKey && presetKey !== 'custom') {
    Object.assign(c, sensors.applyPreset(presetKey));
  } else if (!c.preset || (c.preset !== 'custom' && !sensors.PRESETS[c.preset])) {
    c.preset = sensors.DEFAULT_PRESET;
    if (!p || p.sensors == null) Object.assign(c, sensors.applyPreset(sensors.DEFAULT_PRESET));
  }
}

function save() {
  try {
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    fs.writeFileSync(settingsPath(), JSON.stringify(cache, null, 2), 'utf8');
  } catch (e) {
    console.error('[settings] 保存失败:', e.message);
  }
}

function events() {
  return load().events || [];
}

function upsertEvent(ev) {
  const list = events();
  const i = list.findIndex((x) => x.id === ev.id);
  if (i >= 0) list[i] = { ...list[i], ...ev };
  // 注意展开顺序：先 ev 后 id，避免 ev.id 为 null 时覆盖新生成的 id
  else list.push({ ...ev, id: ev.id || `ev_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}` });
  update({ events: list });
}

function removeEvent(id) {
  update({ events: (events() || []).filter((x) => x.id !== id) });
}

module.exports = { load, update, save, events, upsertEvent, removeEvent, defaultEvent, fmtDate, migrateFullscreenMode, DEFAULTS };
