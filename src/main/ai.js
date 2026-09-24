'use strict';
/* 桌宠 AI 层：OpenAI 兼容接口（DeepSeek / 通义 / 智谱 / 豆包…），零依赖（用全局 fetch）。
   硬性约束（教学场景）：
     1) **永不开启思考模式** —— 模型名带 reason/thinking 直接拒绝；请求体固定发 thinking:{type:'disabled'}
     2) 单并发 + 每分钟/每日配额 + 相同问题短时缓存，避免被学生连点刷爆额度
     3) 断网/超配额/未填 key → 自动降级到老师预置问答（离线也能用）
   纯逻辑（buildRequest / checkQuota / cacheKey）与网络分离，便于单测。 */

const brain = require('./pet-brain');

const DEFAULT_BASE = 'https://api.deepseek.com';
const DEFAULT_MODEL = 'deepseek-chat'; // 非思考档（当前映射 deepseek-flash）
const THINKING_MODEL_RE = /reason|thinking|r1|o1|o3/i;

/** 归一化配置：无效/思考模型一律回落，确保「永远不开思考」 */
function normalizeConfig(cfg) {
  const c = cfg || {};
  let model = String(c.model || DEFAULT_MODEL).trim() || DEFAULT_MODEL;
  let forced = false;
  if (THINKING_MODEL_RE.test(model)) {
    model = DEFAULT_MODEL;
    forced = true;
  }
  return {
    enabled: c.enabled !== false,
    baseUrl: String(c.baseUrl || DEFAULT_BASE).replace(/\/+$/, '') || DEFAULT_BASE,
    model,
    modelForced: forced, // true = 用户填的模型名被判为思考模型，已强制改回
    apiKey: String(c.apiKey || '').trim(),
    temperature: typeof c.temperature === 'number' ? Math.max(0, Math.min(1.5, c.temperature)) : 0.7,
    maxTokens: Math.max(32, Math.min(1024, parseInt(c.maxTokens, 10) || 300)),
    timeoutMs: Math.max(3000, Math.min(60000, parseInt(c.timeoutMs, 10) || 20000)),
    perMinute: Math.max(1, Math.min(60, parseInt(c.perMinute, 10) || 6)),
    perDay: Math.max(1, Math.min(2000, parseInt(c.perDay, 10) || 200)),
    cacheMinutes: Math.max(0, Math.min(240, parseInt(c.cacheMinutes, 10) || 10)),
    presetOnly: c.presetOnly === true, // 只用老师的预置问答，不连网
  };
}

/** 组装请求体（纯函数，测试断言 thinking 必须为 disabled） */
function buildRequest(question, ctx, cfg) {
  const c = normalizeConfig(cfg);
  return {
    url: `${c.baseUrl}/chat/completions`,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${c.apiKey}` },
    body: {
      model: c.model,
      messages: brain.buildMessages(question, ctx),
      stream: true,
      max_tokens: c.maxTokens,
      temperature: c.temperature,
      stream_options: { include_usage: true },
      // 官方文档：思考模式默认开启，必须显式关闭
      thinking: { type: 'disabled' },
    },
  };
}

/** 缓存键：同一天内相同问题（忽略空白/大小写）视为同一个问题 */
function cacheKey(question, dayKey) {
  const q = String(question || '').trim().toLowerCase().replace(/\s+/g, '');
  return `${dayKey}|${q}`;
}

/**
 * 配额检查（纯函数）
 * state = { minuteKey, minuteCount, dayKey, dayCount }
 * 返回 { ok, reason, next: 新的 state }
 */
function checkQuota(state, cfg, nowKey) {
  const c = normalizeConfig(cfg);
  const st = {
    minuteKey: state && state.minuteKey === nowKey.minute ? state.minuteKey : nowKey.minute,
    minuteCount: state && state.minuteKey === nowKey.minute ? state.minuteCount || 0 : 0,
    dayKey: state && state.dayKey === nowKey.day ? state.dayKey : nowKey.day,
    dayCount: state && state.dayKey === nowKey.day ? state.dayCount || 0 : 0,
  };
  if (st.minuteCount >= c.perMinute) return { ok: false, reason: 'per-minute', next: st };
  if (st.dayCount >= c.perDay) return { ok: false, reason: 'per-day', next: st };
  return { ok: true, reason: '', next: st };
}

function bumpQuota(state, nowKey) {
  const st = { ...(state || {}) };
  st.minuteKey = nowKey.minute;
  st.dayKey = nowKey.day;
  st.minuteCount = (st.minuteCount || 0) + 1;
  st.dayCount = (st.dayCount || 0) + 1;
  return st;
}

/** 时间键：分钟 / 天（本地时区） */
function timeKeys(d) {
  const p = (n) => String(n).padStart(2, '0');
  const day = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  return { day, minute: `${day} ${p(d.getHours())}:${p(d.getMinutes())}` };
}

/** 解析 SSE 增量（纯函数：喂一行，吐 {delta, usage, model, reasoning} | null） */
function parseSseLine(line) {
  const s = String(line || '').trim();
  if (!s || s.indexOf('data:') !== 0) return null;
  const payload = s.slice(5).trim();
  if (payload === '[DONE]') return { done: true };
  let j;
  try {
    j = JSON.parse(payload);
  } catch (e) {
    return null;
  }
  const d = j.choices && j.choices[0] && j.choices[0].delta ? j.choices[0].delta : null;
  return {
    delta: d && d.content ? d.content : '',
    reasoning: d && d.reasoning_content ? d.reasoning_content : '',
    usage: j.usage || null,
    model: j.model || '',
  };
}

/**
 * 真实流式问答（onDelta 逐字回调）。返回 { ok, text, firstMs, totalMs, usage, servedModel, reasoningLen, error }
 */
async function askStream(question, ctx, cfg, opts) {
  const c = normalizeConfig(cfg);
  const onDelta = (opts && opts.onDelta) || (() => {});
  const req = buildRequest(question, ctx, c);
  const t0 = Date.now();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), c.timeoutMs);
  try {
    const res = await fetch(req.url, { method: 'POST', headers: req.headers, body: JSON.stringify(req.body), signal: ctl.signal });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      clearTimeout(timer);
      return { ok: false, error: `HTTP ${res.status} ${String(txt).slice(0, 200)}`, text: '' };
    }
    let first = 0;
    let text = '';
    let reasoning = '';
    let usage = null;
    let servedModel = '';
    const reader = res.body.getReader();
    const dec = new TextDecoder('utf-8');
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        const ev = parseSseLine(line);
        if (!ev) continue;
        if (ev.usage) usage = ev.usage;
        if (ev.model) servedModel = ev.model;
        if (ev.reasoning) reasoning += ev.reasoning;
        if (ev.delta) {
          if (!first) first = Date.now() - t0;
          text += ev.delta;
          onDelta(ev.delta);
        }
      }
    }
    clearTimeout(timer);
    return {
      ok: true,
      text,
      firstMs: first,
      totalMs: Date.now() - t0,
      usage,
      servedModel: servedModel || c.model,
      reasoningLen: reasoning.length, // 正常应恒为 0（thinking=disabled）
    };
  } catch (e) {
    clearTimeout(timer);
    const msg = e && e.name === 'AbortError' ? `超时(${c.timeoutMs}ms)` : String((e && e.message) || e);
    return { ok: false, error: msg, text: '' };
  }
}

module.exports = {
  DEFAULT_BASE,
  DEFAULT_MODEL,
  THINKING_MODEL_RE,
  normalizeConfig,
  buildRequest,
  cacheKey,
  checkQuota,
  bumpQuota,
  timeKeys,
  parseSseLine,
  askStream,
};
