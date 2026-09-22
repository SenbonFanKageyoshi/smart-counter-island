'use strict';
/* 天气预报系统（Open-Meteo，免密钥）
   - 数据：地理编码 geocoding-api.open-meteo.com + 预报 api.open-meteo.com（current/hourly/daily，timezone=auto）
   - 只用 Node 内置 https（零运行时依赖）；超时、重试退避、磁盘缓存、离线降级都在这里
   - 纯函数（WMO 映射 / 解析 / 文案 / 触发判定）与副作用（抓取 / 缓存 / 设置写入）分离，
     前者给主进程与 --test 断言共用，后者允许注入 fetchJson/now 以便离线测试
   - 时间一律走 ./schedule 的 localDate/parseHM/fmtHM，与课堂提醒、定时任务同源，
     避免跨午夜/时区各写一套解析 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const settings = require('./settings');
const sched = require('./schedule');

const GEOCODE_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const CACHE_FILE = 'weather-cache.json';
/** HTTP User-Agent：带真实版本（从 package.json 读，避免每次发版留一个过期硬编码） */
function ua() {
  let v = '';
  try {
    v = require('../../package.json').version || '';
  } catch (e) {
    v = '';
  }
  return `SmartCounterIsland${v ? '/' + v : ''} (+https://github.com/SenbonFanKageyoshi/smart-counter-island)`;
}

/* ---------------- WMO 天气码 → 文案 / 图标 / 动画 / 色调 ---------------- */
/* 图标 icon: sun|partly|cloud|fog|drizzle|rain|sleet|snow|thunder
   动画 anim: sun|cloud|fog|rain|snow|thunder|none（渲染层按它挂 CSS 动画）
   色调 tone: warm|cool|wet|cold|storm（渲染层按它选配色） */
const WMO = {
  0: { text: '晴', icon: 'sun', anim: 'sun', tone: 'warm' },
  1: { text: '晴间多云', icon: 'partly', anim: 'sun', tone: 'warm' },
  2: { text: '局部多云', icon: 'partly', anim: 'cloud', tone: 'cool' },
  3: { text: '阴', icon: 'cloud', anim: 'cloud', tone: 'cool' },
  45: { text: '有雾', icon: 'fog', anim: 'fog', tone: 'cool' },
  48: { text: '冻雾', icon: 'fog', anim: 'fog', tone: 'cold' },
  51: { text: '小毛毛雨', icon: 'drizzle', anim: 'rain', tone: 'wet' },
  53: { text: '毛毛雨', icon: 'drizzle', anim: 'rain', tone: 'wet' },
  55: { text: '大毛毛雨', icon: 'drizzle', anim: 'rain', tone: 'wet' },
  56: { text: '冻毛毛雨', icon: 'sleet', anim: 'rain', tone: 'cold' },
  57: { text: '强冻毛毛雨', icon: 'sleet', anim: 'rain', tone: 'cold' },
  61: { text: '小雨', icon: 'rain', anim: 'rain', tone: 'wet' },
  63: { text: '中雨', icon: 'rain', anim: 'rain', tone: 'wet' },
  65: { text: '大雨', icon: 'rain', anim: 'rain', tone: 'wet' },
  66: { text: '冻雨', icon: 'sleet', anim: 'rain', tone: 'cold' },
  67: { text: '强冻雨', icon: 'sleet', anim: 'rain', tone: 'cold' },
  71: { text: '小雪', icon: 'snow', anim: 'snow', tone: 'cold' },
  73: { text: '中雪', icon: 'snow', anim: 'snow', tone: 'cold' },
  75: { text: '大雪', icon: 'snow', anim: 'snow', tone: 'cold' },
  77: { text: '米雪', icon: 'snow', anim: 'snow', tone: 'cold' },
  80: { text: '阵雨', icon: 'rain', anim: 'rain', tone: 'wet' },
  81: { text: '强阵雨', icon: 'rain', anim: 'rain', tone: 'wet' },
  82: { text: '暴雨', icon: 'rain', anim: 'rain', tone: 'storm' },
  85: { text: '小阵雪', icon: 'snow', anim: 'snow', tone: 'cold' },
  86: { text: '大阵雪', icon: 'snow', anim: 'snow', tone: 'cold' },
  95: { text: '雷阵雨', icon: 'thunder', anim: 'thunder', tone: 'storm' },
  96: { text: '雷阵雨伴小冰雹', icon: 'thunder', anim: 'thunder', tone: 'storm' },
  99: { text: '雷阵雨伴大冰雹', icon: 'thunder', anim: 'thunder', tone: 'storm' },
};

const FALLBACK_CODE = { text: '未知天气', icon: 'cloud', anim: 'none', tone: 'cool' };

/** 天气码 → { code, text, icon, anim, tone }（未知码给安全兜底，不抛；null/'' 也算未知） */
function describeCode(code) {
  const n = code === null || code === undefined || code === '' ? NaN : Number(code);
  const hit = Number.isFinite(n) ? WMO[n] : null;
  const base = hit || FALLBACK_CODE;
  return { code: Number.isFinite(n) ? n : null, ...base };
}

/** 抓到的数字统一压成 1 位小数；非数字/空值 → null（下游一律判 null，避免 null 被当成 0） */
function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 10) / 10 : null;
}

/** 'YYYY-MM-DD' → 周几（中文本地化；不依赖系统 locale） */
const DOW_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
function dowOf(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(dateStr || ''));
  if (!m) return '';
  return DOW_NAMES[new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getDay()];
}

/** 星期匹配（与定时任务同语义）：'daily' | 'once' | [0-6]（周一=0） */
function dayMatch(days, now) {
  if (days === 'daily' || days === 'once') return true;
  if (Array.isArray(days)) return days.includes((now.getDay() + 6) % 7);
  return true;
}

/* ---------------- 解析层（纯函数，喂进 JSON 出结构） ---------------- */

/** 地理编码响应 → { name, admin, country, lat, lon }；没有结果抛可读错误 */
function parseGeocode(json, name) {
  const hit = json && Array.isArray(json.results) ? json.results[0] : null;
  if (!hit || hit.latitude == null || hit.longitude == null) {
    throw new Error(`没有找到城市「${String(name || '').trim()}」，换个写法试试（如「郑州」或「Zhengzhou」）`);
  }
  return {
    name: hit.name || String(name || '').trim(),
    admin: hit.admin1 || hit.admin2 || '',
    country: hit.country || '',
    lat: num(hit.latitude),
    lon: num(hit.longitude),
  };
}

/** 预报响应 → 归一化快照；关键字段缺失返回 null（调用方按「无数据」处理） */
function parseForecast(json, meta) {
  const m = meta || {};
  if (!json || !json.current || !json.daily || !Array.isArray(json.daily.time) || json.daily.time.length === 0) return null;
  const cur = json.current;
  const c = describeCode(cur.weather_code);
  const dailyCode = Array.isArray(json.daily.weather_code) ? json.daily.weather_code : [];
  const days = json.daily.time.map((date, i) => {
    const d = describeCode(dailyCode[i]);
    return {
      date,
      dow: dowOf(date),
      code: d.code,
      text: d.text,
      icon: d.icon,
      anim: d.anim,
      tone: d.tone,
      tMax: num(json.daily.temperature_2m_max && json.daily.temperature_2m_max[i]),
      tMin: num(json.daily.temperature_2m_min && json.daily.temperature_2m_min[i]),
      pop: num(json.daily.precipitation_probability_max && json.daily.precipitation_probability_max[i]),
    };
  });
  const hourly = json.hourly || {};
  const hours = Array.isArray(hourly.time)
    ? hourly.time.map((time, i) => {
        const d = describeCode(hourly.weather_code && hourly.weather_code[i]);
        return {
          time,
          temp: num(hourly.temperature_2m && hourly.temperature_2m[i]),
          code: d.code,
          text: d.text,
          anim: d.anim,
          pop: num(hourly.precipitation_probability && hourly.precipitation_probability[i]),
        };
      })
    : [];
  return {
    city: m.city || '',
    lat: num(m.lat != null ? m.lat : json.latitude),
    lon: num(m.lon != null ? m.lon : json.longitude),
    timezone: json.timezone || '',
    updatedAt: m.updatedAt || Date.now(),
    source: 'open-meteo',
    current: {
      temp: num(cur.temperature_2m),
      feels: num(cur.apparent_temperature),
      humidity: num(cur.relative_humidity_2m),
      wind: num(cur.wind_speed_10m),
      code: c.code,
      text: c.text,
      icon: c.icon,
      anim: c.anim,
      tone: c.tone,
    },
    days,
    hours,
  };
}

/** 把一天/当前的结构压成一行短文案（岛内 chip 与提醒共用） */
function briefOf(x) {
  if (!x) return '—';
  const t = x.temp != null ? `${Math.round(x.temp)}°` : `${x.tMin != null ? Math.round(x.tMin) : '?'}~${x.tMax != null ? Math.round(x.tMax) : '?'}°`;
  const pop = x.pop != null && x.pop >= 30 ? ` 降水${Math.round(x.pop)}%` : '';
  return `${x.text} ${t}${pop}`;
}

/** 未来 N 小时内的最强降雨（无雨返回 null） */
function rainAhead(snapshot, hours, now) {
  if (!snapshot || !Array.isArray(snapshot.hours) || snapshot.hours.length === 0) return null;
  const from = now ? now.getTime() : Date.now();
  let best = null;
  for (const h of snapshot.hours) {
    const at = new Date(String(h.time || '').replace('T', ' ').replace(/-/g, '/')).getTime();
    if (!Number.isFinite(at)) continue;
    if (at < from - 30 * 60000) continue; // 已过去的整点不算
    if (at > from + hours * 3600000) break;
    const wet = (h.pop != null && h.pop >= 40) || (h.anim === 'rain' && h.pop !== 0);
    if (!wet) continue;
    if (!best || (h.pop || 0) > (best.pop || 0)) best = h;
  }
  return best ? { hour: String(best.time || '').slice(11, 16), pop: best.pop, text: best.text } : null;
}

/** 提醒文案（纯函数）：kind = now|today|tomorrow|rain|temp；无话可说返回 null */
function summarize(snapshot, kind, cfg) {
  if (!snapshot) return null;
  const c = (cfg && cfg.weather) || cfg || {};
  const cur = snapshot.current || {};
  const days = snapshot.days || [];
  const today = days[0] || null;
  const tomorrow = days[1] || null;
  const kw = [];
  const pushKw = (body) => {
    for (const w of ['雨', '雪', '雾', '雷', '冰雹', '大风', '降温', '高温']) {
      if (String(body).includes(w) && !kw.includes(w)) kw.push(w);
    }
    return body;
  };
  const city = snapshot.city ? `${snapshot.city} · ` : '';
  switch (kind) {
    case 'now': {
      const body = `${city}${cur.text || '—'} ${cur.temp != null ? `${Math.round(cur.temp)}℃` : '--'}${cur.feels != null ? ` · 体感 ${Math.round(cur.feels)}℃` : ''}${cur.humidity != null ? ` · 湿度 ${Math.round(cur.humidity)}%` : ''}`;
      return { title: '当前天气', body: pushKw(body), keywords: kw };
    }
    case 'tomorrow': {
      if (!tomorrow) return null;
      const body = `${city}明天（${tomorrow.dow}）${briefOf(tomorrow)}`;
      return { title: '明日天气', body: pushKw(body), keywords: kw };
    }
    case 'rain': {
      const ahead = rainAhead(snapshot, Math.max(1, Number(c.rainLookaheadH) || 6), null);
      if (!ahead) return null;
      const body = `${city}未来 ${Math.max(1, Number(c.rainLookaheadH) || 6)} 小时内可能下雨：${ahead.hour} 前后 ${ahead.text}${ahead.pop != null ? `（降水概率 ${Math.round(ahead.pop)}%）` : ''}`;
      return { title: '降雨提醒', body: pushKw(body), keywords: kw };
    }
    case 'temp': {
      const hotC = Number(c.hotC);
      const dropC = Number(c.coldDropC);
      const hot = today && today.tMax != null && Number.isFinite(hotC) && today.tMax >= hotC;
      if (hot) {
        const body = `${city}今天最高 ${Math.round(today.tMax)}℃（≥ ${hotC}℃），高温注意防暑`;
        return { title: '高温提醒', body: pushKw(body), keywords: kw };
      }
      if (today && tomorrow && today.tMax != null && tomorrow.tMax != null && Number.isFinite(dropC) && today.tMax - tomorrow.tMax >= dropC) {
        const body = `${city}明天比今天低 ${Math.round(today.tMax - tomorrow.tMax)}℃（${Math.round(today.tMax)}℃ → ${Math.round(tomorrow.tMax)}℃），降温明显记得添衣`;
        return { title: '降温提醒', body: pushKw(body), keywords: kw };
      }
      return null;
    }
    case 'today':
    default: {
      if (!today) return null;
      const body = `${city}今天${today.dow ? `（${today.dow}）` : ''}${briefOf(today)}`;
      return { title: '今日天气', body: pushKw(body), keywords: kw };
    }
  }
}

/** 提醒动画：雨雪天提示雨雪，高温晴天提示太阳，其余按当天图标 */
function animOf(snapshot, kind) {
  if (!snapshot) return 'none';
  const days = snapshot.days || [];
  if (kind === 'rain') return 'rain';
  if (kind === 'temp') {
    const t = days[0];
    return t && t.anim === 'snow' ? 'snow' : 'sun';
  }
  const day = kind === 'tomorrow' ? days[1] : days[0];
  if (day && day.anim) return day.anim;
  return (snapshot.current && snapshot.current.anim) || 'none';
}

/**
 * 到点该弹的天气提醒（纯函数）：规则 = { id, time:'HH:MM', days, kind, enabled }
 * 去重键由调用方加日期，这里只按「同一分钟 + 同一规则 + 同一内容」判重
 */
function dueReminders(snapshot, rules, now, cfg) {
  if (!snapshot || !Array.isArray(rules)) return [];
  const hm = sched.fmtHM(now.getHours() * 60 + now.getMinutes());
  const out = [];
  for (const rule of rules) {
    if (!rule || rule.enabled === false) continue;
    if (rule.time !== hm) continue;
    if (!dayMatch(rule.days, now)) continue;
    const kind = rule.kind || 'today';
    const s = summarize(snapshot, kind, cfg);
    if (!s) continue;
    out.push({
      rule,
      kind,
      key: `${sched.localDate(now)} ${rule.id || rule.time} ${kind}`,
      title: s.title,
      body: s.body,
      keywords: s.keywords,
      anim: animOf(snapshot, kind),
    });
  }
  return out;
}

/** 数据是否过期（超过刷新间隔的 1.5 倍算过期，用于状态行与岛内提示） */
function isStale(snapshot, now, refreshMin) {
  if (!snapshot || !snapshot.updatedAt) return true;
  const min = Math.max(1, Number(refreshMin) || 30);
  return (now ? now.getTime() : Date.now()) - snapshot.updatedAt > min * 60000 * 1.5;
}

/* ---------------- 网络层（零依赖 https，含超时/重定向/友好错误） ---------------- */

function friendlyNetError(e) {
  const code = (e && e.code) || '';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return new Error('无法解析天气服务器地址（可能没联网）');
  if (code === 'ECONNREFUSED') return new Error('天气服务器拒绝连接（可能被防火墙拦截）');
  if (code === 'ETIMEDOUT' || /timeout/i.test(String((e && e.message) || ''))) return new Error('天气服务器连接超时（网络慢或被拦截）');
  if (code === 'ECONNRESET') return new Error('天气连接被重置（网络不稳定）');
  return new Error(`天气请求失败：${String((e && e.message) || e)}`);
}

/** GET JSON：超时 + 最多 3 次重定向 + 体积上限；错误信息面向老师（不暴露堆栈） */
function fetchJsonImpl(url, opts) {
  const o = opts || {};
  const timeoutMs = Math.max(1000, Number(o.timeoutMs) || 8000);
  const redirects = Number(o.redirects) || 0;
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (err, val) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve(val);
    };
    let req;
    try {
      req = https.get(
        url,
        { headers: { 'user-agent': ua(), accept: 'application/json', 'accept-language': 'zh-CN,zh;q=0.9' } },
        (res) => {
          const code = res.statusCode || 0;
          if ([301, 302, 303, 307, 308].includes(code) && res.headers.location && redirects < 3) {
            res.resume();
            const next = res.headers.location.startsWith('http') ? res.headers.location : new URL(res.headers.location, url).toString();
            fetchJsonImpl(next, { ...o, redirects: redirects + 1 }).then((v) => done(null, v), (e) => done(e));
            return;
          }
          if (code !== 200) {
            res.resume();
            done(new Error(`天气服务返回 HTTP ${code}`));
            return;
          }
          let raw = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => {
            raw += chunk;
            if (raw.length > 4000000) {
              req.destroy();
              done(new Error('天气响应过大，已放弃'));
            }
          });
          res.on('end', () => {
            try {
              done(null, JSON.parse(raw));
            } catch (e) {
              done(new Error('天气响应不是合法 JSON'));
            }
          });
        }
      );
    } catch (e) {
      done(friendlyNetError(e));
      return;
    }
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error('天气服务器连接超时（网络慢或被拦截）'));
    });
    req.on('error', (e) => done(friendlyNetError(e)));
  });
}

/** 城市名 → 经纬度（取第一个结果，展示「城市 · 省/州 · 国家」让老师确认） */
function resolveCity(name, fetchJson) {
  const keyword = String(name == null ? '' : name).trim();
  if (!keyword) return Promise.reject(new Error('请先填写城市名（如「郑州」）'));
  const url = `${GEOCODE_URL}?name=${encodeURIComponent(keyword)}&count=5&language=zh&format=json`;
  return (fetchJson || fetchJsonImpl)(url, { timeoutMs: 8000 }).then((json) => parseGeocode(json, keyword));
}

/** 一键自动定位：公开 IP 接口依次尝试（仅用户点击时执行，不做后台定位） */
const IP_PROVIDERS = [
  {
    name: 'ipwho.is',
    url: 'https://ipwho.is/',
    pick: (j) => (j && j.success !== false && j.latitude != null && j.longitude != null ? { city: j.city || '', admin: j.region || '', country: j.country || '', lat: num(j.latitude), lon: num(j.longitude) } : null),
  },
  {
    name: 'ipapi.co',
    url: 'https://ipapi.co/json/',
    pick: (j) => (j && j.latitude != null && j.longitude != null ? { city: j.city || '', admin: j.region || '', country: j.country_name || '', lat: num(j.latitude), lon: num(j.longitude) } : null),
  },
  {
    name: 'ip-api.com',
    url: 'http://ip-api.com/json/?lang=zh-CN',
    pick: (j) => (j && j.status === 'success' ? { city: j.city || '', admin: j.regionName || '', country: j.country || '', lat: num(j.lat), lon: num(j.lon) } : null),
  },
];

async function locateByIp(deps) {
  const fetchJson = (deps && deps.fetchJson) || fetchJsonImpl;
  const errors = [];
  for (const provider of IP_PROVIDERS) {
    try {
      const json = await fetchJson(provider.url, { timeoutMs: 5000 });
      const hit = provider.pick(json);
      if (hit && hit.lat != null && hit.lon != null) return { ...hit, provider: provider.name };
      errors.push(`${provider.name}：没返回定位字段`);
    } catch (e) {
      errors.push(`${provider.name}：${String(e.message || e)}`);
    }
  }
  const err = new Error(`自动定位失败（${errors.join('；')}）`);
  err.attempts = errors;
  throw err;
}

/** 预报 URL：current + hourly(24h) + daily(7d)，timezone=auto 让日期按当地算 */
function forecastUrl(lat, lon, cfg) {
  const c = cfg || {};
  const days = Math.max(1, Math.min(16, Number(c.forecastDays) || 7));
  const params = [
    `latitude=${encodeURIComponent(lat)}`,
    `longitude=${encodeURIComponent(lon)}`,
    'current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m',
    'hourly=temperature_2m,weather_code,precipitation_probability',
    'daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max',
    `forecast_days=${days}`,
    'timezone=auto',
  ];
  if (c.unit === 'f') params.push('temperature_unit=fahrenheit');
  return `${FORECAST_URL}?${params.join('&')}`;
}

/* ---------------- 缓存与刷新 ---------------- */

let cache = null; // { snapshot, error, at }
let failCount = 0;
let inflight = null;

function cachePath() {
  try {
    const { app } = require('electron');
    return path.join(app.getPath('userData'), CACHE_FILE);
  } catch (e) {
    return path.join(__dirname, '..', '..', CACHE_FILE);
  }
}

function loadCache() {
  if (cache) return cache;
  try {
    const raw = fs.readFileSync(cachePath(), 'utf8');
    const parsed = JSON.parse(raw);
    cache = { snapshot: parsed && parsed.snapshot ? parsed.snapshot : null, error: (parsed && parsed.error) || null, at: (parsed && parsed.at) || 0 };
  } catch (e) {
    cache = { snapshot: null, error: null, at: 0 };
  }
  return cache;
}

function saveCache(next) {
  cache = { snapshot: (next && next.snapshot) || null, error: (next && next.error) || null, at: Date.now() };
  try {
    fs.writeFileSync(cachePath(), JSON.stringify(cache));
  } catch (e) {
    /* 写不进去不影响内存态（只读磁盘/权限问题） */
  }
  return cache;
}

/** 天气签名：只有内容变了才让岛重绘（避免 60s 轮询把渲染层刷爆） */
function signatureOf(s) {
  if (!s) return '';
  return [s.city, s.updatedAt, s.temp, s.icon, s.text, s.show === false ? 'hide' : 'show', s.animEnabled === false ? 'still' : 'anim', s.stale ? 'stale' : 'fresh', s.error || ''].join('|');
}

/**
 * 刷新一次（永不向外抛）：成功写缓存；失败保留旧快照并记录错误（离线降级）
 * deps 可注入：{ fetchJson, now }（--test 用假网络，不真的联网）
 */
async function refresh(opts) {
  const o = opts || {};
  const deps = o.deps || {};
  const now = deps.now ? deps.now() : Date.now();
  const fetchJson = deps.fetchJson || fetchJsonImpl;
  const st = settings.load();
  const cfg = (st && st.weather) || {};
  if (cfg.enabled === false && !o.force) return { ok: false, skipped: true, snapshot: loadCache().snapshot, error: null };
  const prev = loadCache();
  try {
    let lat = num(cfg.lat);
    let lon = num(cfg.lon);
    let label = cfg.resolvedName || cfg.city || '';
    if (lat == null || lon == null) {
      const hit = await resolveCity(cfg.city, fetchJson);
      lat = hit.lat;
      lon = hit.lon;
      label = [hit.name, hit.admin, hit.country].filter(Boolean).join(' · ');
    }
    const json = await fetchJson(forecastUrl(lat, lon, cfg), { timeoutMs: Math.max(1000, Number(cfg.timeoutMs) || 8000) });
    const snapshot = parseForecast(json, { city: label, lat, lon, updatedAt: now });
    if (!snapshot) throw new Error('天气数据格式不符合预期（可能是接口变更）');
    saveCache({ snapshot, error: null });
    failCount = 0;
    if (num(cfg.lat) !== lat || num(cfg.lon) !== lon || cfg.resolvedName !== label) {
      try {
        settings.update({ weather: { lat, lon, resolvedName: label } });
      } catch (e) {
        /* 设置写入失败不影响本次数据 */
      }
    }
    return { ok: true, snapshot, error: null, city: { lat, lon, label } };
  } catch (e) {
    failCount += 1;
    const message = String((e && e.message) || e);
    saveCache({ snapshot: prev ? prev.snapshot : null, error: message });
    return { ok: false, snapshot: prev ? prev.snapshot : null, error: message, stale: true };
  }
}

/**
 * 到期才刷新（60 秒轮询调它）：失败后退避到 3 倍间隔，避免断网时反复重试
 * 返回 { ok, cached?, skipped? , snapshot, error }
 */
function refreshIfDue(nowMs) {
  const st = settings.load();
  const cfg = (st && st.weather) || {};
  if (cfg.enabled === false) return Promise.resolve({ ok: false, skipped: true, snapshot: loadCache().snapshot, error: null });
  const cur = loadCache();
  const now = nowMs || Date.now();
  const interval = Math.max(10, Number(cfg.refreshMin) || 30) * 60000;
  const wait = failCount > 0 ? interval * 3 : interval;
  if (cur && cur.snapshot && now - cur.snapshot.updatedAt < wait) {
    return Promise.resolve({ ok: !cur.error, cached: true, snapshot: cur.snapshot, error: cur.error || null });
  }
  if (inflight) return inflight;
  inflight = refresh({}).then(
    (r) => {
      inflight = null;
      return r;
    },
    (e) => {
      inflight = null;
      return { ok: false, snapshot: loadCache().snapshot, error: String((e && e.message) || e) };
    }
  );
  return inflight;
}

/** 给灵动岛的最小载荷（null = 未启用，渲染层隐藏天气 chip） */
function snapshotForIsland(nowMs) {
  const st = settings.load();
  const cfg = (st && st.weather) || {};
  if (cfg.enabled === false) return null;
  const cur = loadCache();
  const snap = cur && cur.snapshot ? cur.snapshot : null;
  const intensityRaw = Number(cfg.animIntensity);
  const base = {
    show: cfg.showInIsland !== 'off',
    mode: cfg.showInIsland || 'always',
    pos: cfg.pos === 'left' || cfg.pos === 'cover' ? cfg.pos : 'right', // 细条上的天气位置
    animEnabled: cfg.anim !== false,
    intensity: Number.isFinite(intensityRaw) ? Math.max(0, Math.min(200, intensityRaw)) : 100,
    stale: true,
    error: (cur && cur.error) || null,
    city: cfg.resolvedName || cfg.city || '',
    unit: cfg.unit === 'f' ? 'f' : 'c',
  };
  if (!snap) {
    return { ...base, temp: null, text: '—', icon: 'cloud', anim: 'none', tone: 'cool', updatedAt: 0, days: [] };
  }
  const d = describeCode(snap.current && snap.current.code);
  return {
    ...base,
    stale: isStale(snap, nowMs ? new Date(nowMs) : new Date(), cfg.refreshMin),
    city: snap.city || base.city,
    temp: snap.current ? snap.current.temp : null,
    text: (snap.current && snap.current.text) || d.text,
    icon: (snap.current && snap.current.icon) || d.icon,
    anim: (snap.current && snap.current.anim) || d.anim,
    tone: (snap.current && snap.current.tone) || d.tone,
    updatedAt: snap.updatedAt,
    days: (snap.days || []).slice(0, 3).map((x) => ({ dow: x.dow, text: x.text, icon: x.icon, anim: x.anim, tMax: x.tMax, tMin: x.tMin, pop: x.pop })),
  };
}

/* ---------------- 提醒轮询 ---------------- */

let firedMinute = '';
let firedKeys = new Set();

/**
 * 到点检查并执行天气提醒。execFn 可注入（测试用）：(r) => void
 * 与定时任务同语义：同一分钟只触发一次；days:'once' 的规则触发后自删
 * 返回本次触发的提醒列表
 */
function checkReminders(now, execFn) {
  const st = settings.load();
  const cfg = (st && st.weather) || {};
  if (cfg.enabled === false) return [];
  const minKey = `${sched.localDate(now)} ${sched.fmtHM(now.getHours() * 60 + now.getMinutes())}`;
  if (minKey !== firedMinute) {
    firedMinute = minKey;
    firedKeys = new Set();
  }
  const rules = Array.isArray(cfg.reminders) ? cfg.reminders : [];
  const due = dueReminders(loadCache().snapshot, rules, now, cfg);
  const out = [];
  const onceIds = [];
  for (const r of due) {
    if (firedKeys.has(r.key)) continue;
    firedKeys.add(r.key);
    out.push(r);
    if (r.rule && r.rule.days === 'once') onceIds.push(r.rule.id);
    if (execFn) execFn(r);
  }
  if (onceIds.length) {
    const rest = rules.filter((r) => !onceIds.includes(r.id));
    settings.update({ weather: { reminders: rest } });
  }
  return out;
}

/** 清空提醒去重状态（测试用） */
function resetReminders() {
  firedMinute = '';
  firedKeys = new Set();
}

/** 配置页预览：当前天气摘要 + 未来三天 + 下一条提醒（只返回可序列化数据） */
function preview(now) {
  const at = now || new Date();
  const st = settings.load();
  const cfg = (st && st.weather) || {};
  const cur = loadCache();
  const snap = cur && cur.snapshot ? cur.snapshot : null;
  const rules = (cfg.reminders || []).filter((r) => r && r.enabled !== false);
  const hm = sched.fmtHM(at.getHours() * 60 + at.getMinutes());
  const upcoming = rules
    .filter((r) => dayMatch(r.days, at))
    .map((r) => ({ ...r, minutes: (sched.parseHM(r.time) == null ? 99999 : sched.parseHM(r.time)) - (sched.parseHM(hm) || 0) }))
    .filter((r) => r.minutes >= 0)
    .sort((a, b) => a.minutes - b.minutes)[0];
  return {
    enabled: cfg.enabled !== false,
    city: (snap && snap.city) || cfg.resolvedName || cfg.city || '',
    unit: cfg.unit === 'f' ? 'f' : 'c',
    resolvedName: cfg.resolvedName || '',
    lat: cfg.lat,
    lon: cfg.lon,
    updatedAt: snap ? snap.updatedAt : 0,
    stale: snap ? isStale(snap, at, cfg.refreshMin) : true,
    error: (cur && cur.error) || null,
    current: snap && snap.current ? { ...snap.current, brief: briefOf({ ...snap.current, pop: null }) } : null,
    days: snap ? (snap.days || []).slice(0, 3).map((d) => ({ ...d, brief: briefOf(d) })) : [],
    nextReminder: upcoming ? { id: upcoming.id, time: upcoming.time, kind: upcoming.kind, inMin: upcoming.minutes } : null,
    rules,
  };
}

module.exports = {
  GEOCODE_URL,
  FORECAST_URL,
  CACHE_FILE,
  WMO,
  IP_PROVIDERS,
  describeCode,
  dowOf,
  dayMatch,
  parseGeocode,
  parseForecast,
  briefOf,
  rainAhead,
  summarize,
  animOf,
  dueReminders,
  isStale,
  fetchJson: fetchJsonImpl,
  resolveCity,
  locateByIp,
  forecastUrl,
  cachePath,
  loadCache,
  saveCache,
  refresh,
  refreshIfDue,
  snapshotForIsland,
  signatureOf,
  checkReminders,
  resetReminders,
  preview,
  __test: {
    setFailCount: (n) => {
      failCount = n;
    },
    getFailCount: () => failCount,
    setCache: (next) => {
      cache = next;
    },
    setInflight: (p) => {
      inflight = p;
    },
  },
};
