'use strict';
/* 教学助手「大脑」：纯函数，不碰窗口/网络，便于单测。
   职责：
     1) decidePetAction —— 现在该做什么（发呆/走动/睡觉/说话/上课静默/隐藏）
     2) canPetSpeak     —— 现在允许它开口吗（上课只答课表与倒计时、免打扰、配额）
     3) pickPresetAnswer—— 离线兜底：老师预置问答的关键词匹配
     4) guardAnswer     —— 面向学生的内容护栏（长度截断 + 敏感词）
     5) buildSystemPrompt —— 教学场景人设与规则
   时间相关输入都由调用方传入（now / idleMs / msSinceInteract），因此行为可确定性测试。 */

/** 行为枚举：hidden(全屏授课彻底隐藏) | quiet(上课静默) | sleep | idle | walk | talk
    外加三个"瞬态反应"（由事件触发、很短，优先于常态行为）：
    jump(被点击→跳一下) | review(思考/等待回答中→审视) | fail(答错/断网→失败) */
const ACTIONS = ['hidden', 'quiet', 'sleep', 'idle', 'walk', 'talk', 'jump', 'review', 'fail', 'perch'];

/** 常态行为权重（安静档：课堂不抢注意力）。cfg.weights 可覆盖。
    ⚠️ 这里只有"随时可以发生"的行为：sleep 不进抽签 —— 否则会正上着课突然睡 2~4 分钟。
    睡觉只由「久无人互动」（sinceInteractMs ≥ sleepSec）触发，见 nextAction 第 2 步。 */
const DEFAULT_WEIGHTS = { idle: 65, walk: 20, talk: 8 };

/** 每个行为的持续时长区间（毫秒）：到点才重新决定 —— 旧版每秒重掷，看着就是"乱动" */
const HOLD_MS = {
  idle: [4000, 9000],
  walk: [6000, 10000],
  talk: [2500, 4000],
  sleep: [120000, 240000],
  quiet: [3000, 3000],
  hidden: [1000, 1000],
  jump: [900, 1300],
  review: [1500, 3000],
  fail: [1500, 2500],
  perch: [25000, 60000], // 趴在小岛倒计时数字上：一次趴半分钟到一分钟
};

/** 取某个行为的持续时长（同 seed 结果固定，测试可复现） */
function holdMs(action, seed) {
  const r = HOLD_MS[action] || [3000, 6000];
  return Math.round(r[0] + (r[1] - r[0]) * rand01(seed * 0.31 + action.length * 7.3));
}

/** 组装一次决策：走动方向在整段内保持不变（旧版每拍重掷 → 忽左忽右） */
function makeChoice(action, now, seed, prevDir) {
  const dir = action === 'walk' ? prevDir || (rand01(seed * 1.7) < 0.5 ? -1 : 1) : 0;
  return { action, dir, until: now + holdMs(action, seed) };
}

/** 加权抽签（安静档默认值；cfg.weights 里的键覆盖）。
    只抽"随时可发生"的行为：sleep/hidden/quiet 由各自的硬条件触发，不参与抽签 */
function pickWeighted(weights, seed) {
  const raw = Object.assign({}, DEFAULT_WEIGHTS, weights || {});
  const w = {};
  for (const k of Object.keys(raw)) {
    if (k === 'sleep' || k === 'hidden' || k === 'quiet') continue;
    w[k] = raw[k];
  }
  let total = 0;
  for (const k of Object.keys(w)) total += Math.max(0, Number(w[k]) || 0);
  if (total <= 0) return 'idle';
  let r = rand01(seed * 0.37) * total;
  for (const k of Object.keys(w)) {
    r -= Math.max(0, Number(w[k]) || 0);
    if (r < 0) return k;
  }
  return 'idle';
}

/**
 * 决定"现在该做什么"，并给出这一段的持续时长（新 API；旧 decidePetAction 是它的兼容壳）。
 * input 同上，另加：
 *   now        当前时间（ms，必传，用于算 until）
 *   jump / review / fail   三个瞬态反应的触发标志（事件驱动，优先级最高）
 * state：上一次的决策结果 { action, dir, until }（连同 until 一起回传，下次原样传回来）
 * 返回 { action, dir, until }：until 之前不允许换行为（除非被更高优先级打断）。
 */
function nextAction(input, state) {
  const i = input || {};
  const cfg = i.cfg || {};
  // ⚠️ 兜底取当前时间：调用方漏传 now 时 until 会算成「0+时长」（远古时间戳）→
  // 「一段行为持续时长」彻底失效、每秒重掷（实测 brainState.until=7153 就是这么来的）。
  const now = Number(i.now) || Date.now();
  const seed = Number(i.seed) || 0;
  const cur = state && state.action && state.until ? state : null;
  const prevDir = cur && cur.dir ? cur.dir : 0;

  // 1) 硬优先级（逐拍判断，随时打断）
  if (i.hidden || i.fullscreen) return makeChoice('hidden', now, seed, 0);
  if (i.jump) return makeChoice('jump', now, seed, 0);
  if (i.review) return makeChoice('review', now, seed, prevDir);
  if (i.fail) return makeChoice('fail', now, seed, prevDir);
  if (i.talking) return makeChoice('talk', now, seed, 0);
  if (i.perch) return makeChoice('perch', now, seed, 0); // 趴到小岛倒计时上（趴着也是安静的，上课也允许）
  // ⚠️ 上课时间不再直接返回 quiet 站住：配置页那句是「只答课表与倒计时」（不闲聊、不打扰），
  // 不是「不许走动」。照常发呆/走动，只是不主动说话（说话由 canPetSpeak 管）。

  // 2) 久无人互动 → 睡觉
  const sleepSec = Math.max(10, Number(cfg.sleepSec) || 300);
  if ((i.sinceInteractMs || 0) >= sleepSec * 1000) return makeChoice('sleep', now, seed, 0);

  // 3) 这一段还没走完 → 保持（不再每秒重掷）
  if (cur && cur.until > now) return { action: cur.action, dir: cur.dir, until: cur.until };

  // 4) 走完一段后先站一会儿（走→停→再决定，避免"刚走两步又走"）
  if (cur && cur.action === 'walk') return makeChoice('idle', now, seed, 0);

  // 5) 加权抽签
  return makeChoice(pickWeighted(cfg.weights, seed), now, seed, 0);
}

/** 确定性伪随机（同一 seed 结果固定，测试可复现） */
function rand01(seed) {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

/**
 * 决定这一拍做什么。
 * input = {
 *   now, idleMs,                    // 系统层面：用户闲置多久没操作（GetLastInputInfo）
 *   fullscreen, inClass,            // 全屏授课中 / 课表上正处于上课时间
 *   hidden,                         // 用户手动隐藏了教学助手
 *   talking,                        // 正在说话/等待回答
 *   sinceInteractMs,                // 距上次和教学助手互动（点它/问它）多久
 *   seed,                           // 随机种子（一般传 now/1000）
 *   cfg: { idleSec, walkSec, sleepSec }   // 行为节奏
 * }
 * 返回 { action, dir }：dir 只在 walk 时有意义（-1 向左 / 1 向右）
 */
function decidePetAction(input, state) {
  const i = input || {};
  // 兼容旧调用：没给 now 时按"此刻"算（自检里传固定 seed/now 可复现）
  if (!i.now) i.now = Date.now();
  return nextAction(i, state);
}

/**
 * 现在允许教学助手开口吗？
 * input = { inClass, question, dnd, quotaLeftMin, quotaLeftDay, aiReady, presetOnly }
 * 返回 { allowed, mode: 'ai'|'preset'|'refuse'|'quota', reason }
 *   mode='refuse'/'quota' 时，调用方直接把 reason 念出来（例如「上课时间先专心听课」）
 */
function canPetSpeak(input) {
  const i = input || {};
  const q = String(i.question || '');
  const isScheduleQ = /课|上课|下课|第几节|几点|倒计时|还有几天|高考|中考|期末|考试|放假/.test(q);
  if (i.inClass && !isScheduleQ) {
    return { allowed: false, mode: 'refuse', reason: '上课时间先专心听课，下课再来找我聊～' };
  }
  if (i.dnd) {
    return { allowed: false, mode: 'refuse', reason: '现在是免打扰时间，我先安静一会儿' };
  }
  if (!i.aiReady || i.presetOnly) {
    return { allowed: true, mode: 'preset', reason: '' }; // 离线/仅预置：只答预置问答
  }
  if ((i.quotaLeftMin || 0) <= 0) {
    return { allowed: false, mode: 'quota', reason: '我问得太快啦，歇一分钟再问吧' };
  }
  if ((i.quotaLeftDay || 0) <= 0) {
    return { allowed: false, mode: 'quota', reason: '今天的提问额度用完了，明天再来～' };
  }
  return { allowed: true, mode: 'ai', reason: '' };
}

/**
 * 离线/预置问答：关键词命中（老师自己写的条目）
 * qa = [{ q:'作业交到哪', a:'交给课代表', keys:['作业','交'] }]
 * 命中规则：keys 任一命中（不区分大小写/空白），或问题里包含 q 的核心片段；取命中 key 最长者
 */
function pickPresetAnswer(question, qaList) {
  const q = String(question || '').trim().toLowerCase();
  if (!q) return null;
  let best = null;
  for (const item of Array.isArray(qaList) ? qaList : []) {
    if (!item || !item.a) continue;
    const keys = (Array.isArray(item.keys) && item.keys.length ? item.keys : [item.q]).filter(Boolean).map((k) => String(k).toLowerCase().trim());
    for (const k of keys) {
      if (k && q.indexOf(k) >= 0 && (!best || k.length > best.hit.length)) best = { answer: String(item.a), hit: k, item };
    }
  }
  return best;
}

/**
 * 内容护栏：截断过长回答 + 命中敏感词直接换成安全兜底
 * cfg = { maxChars, blocked: ['词1','词2'] }
 */
function guardAnswer(text, cfg) {
  const c = cfg || {};
  const maxChars = Math.max(20, parseInt(c.maxChars, 10) || 120);
  let out = String(text == null ? '' : text).trim();
  // 去掉 markdown 代码块/表格（面向大屏，纯文本更稳）
  out = out.replace(/```[\s\S]*?```/g, '').replace(/\|/g, ' ');
  const blocked = (Array.isArray(c.blocked) ? c.blocked : []).filter(Boolean);
  for (const w of blocked) {
    if (out.indexOf(w) >= 0) {
      return { text: c.fallback || '这个问题我们换个说法聊聊吧～', blocked: true, word: w };
    }
  }
  let truncated = false;
  if (out.length > maxChars) {
    out = out.slice(0, maxChars).replace(/[，,。.、；;：:！!？?）)]*$/, '') + '…';
    truncated = true;
  }
  return { text: out, blocked: false, truncated };
}

/** 教学人设与规则（system prompt） */
function buildSystemPrompt(ctx) {
  const c = ctx || {};
  const lines = [
    '你是教室大屏上的桌面宠物「小岛」，面对的是中学生，回答不超过 60 字，口吻亲切、口语化。',
    '规则：',
    '1) 只做思路提示和引导，不直接给作业/考试题的最终答案。',
    '2) 不输出 Markdown、代码块、表格，最多 1 个 emoji。',
    '3) 暴力、色情、政治敏感、个人隐私、充值诱导一律礼貌拒绝，并转回学习话题。',
    '4) 上课时间不闲聊，只回答课表与倒计时相关问题。',
  ];
  const ctxBits = [];
  if (c.now) ctxBits.push(`现在 ${c.now}`);
  if (c.nextClass) ctxBits.push(`下一节：${c.nextClass}${c.nextInMin != null ? `（${c.nextInMin} 分钟后）` : ''}`);
  if (c.currentClass) ctxBits.push(`正在上：${c.currentClass}`);
  if (c.countdown) ctxBits.push(`倒计时：${c.countdown}`);
  if (c.inClass) ctxBits.push('当前处于上课时间');
  if (ctxBits.length) lines.push('', '班级信息：' + ctxBits.join('；'));
  if (c.extra) lines.push('补充要求：' + String(c.extra).slice(0, 300));
  return lines.join('\n');
}

/** 组装一次问答的 messages（OpenAI 兼容） */
function buildMessages(question, ctx) {
  return [
    { role: 'system', content: buildSystemPrompt(ctx) },
    { role: 'user', content: String(question || '').slice(0, 500) },
  ];
}

module.exports = {
  ACTIONS,
  DEFAULT_WEIGHTS,
  HOLD_MS,
  rand01,
  holdMs,
  pickWeighted,
  nextAction,
  decidePetAction,
  canPetSpeak,
  pickPresetAnswer,
  guardAnswer,
  buildSystemPrompt,
  buildMessages,
};
