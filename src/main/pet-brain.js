'use strict';
/* 桌宠「大脑」：纯函数，不碰窗口/网络，便于单测。
   职责：
     1) decidePetAction —— 现在该做什么（发呆/走动/睡觉/说话/上课静默/隐藏）
     2) canPetSpeak     —— 现在允许它开口吗（上课只答课表与倒计时、免打扰、配额）
     3) pickPresetAnswer—— 离线兜底：老师预置问答的关键词匹配
     4) guardAnswer     —— 面向学生的内容护栏（长度截断 + 敏感词）
     5) buildSystemPrompt —— 教学场景人设与规则
   时间相关输入都由调用方传入（now / idleMs / msSinceInteract），因此行为可确定性测试。 */

/** 行为枚举：hidden(全屏授课彻底隐藏) | quiet(上课静默站立) | sleep | idle | walk | talk */
const ACTIONS = ['hidden', 'quiet', 'sleep', 'idle', 'walk', 'talk'];

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
 *   hidden,                         // 用户手动隐藏了桌宠
 *   talking,                        // 正在说话/等待回答
 *   sinceInteractMs,                // 距上次和桌宠互动（点它/问它）多久
 *   seed,                           // 随机种子（一般传 now/1000）
 *   cfg: { idleSec, walkSec, sleepSec }   // 行为节奏
 * }
 * 返回 { action, dir }：dir 只在 walk 时有意义（-1 向左 / 1 向右）
 */
function decidePetAction(input) {
  const i = input || {};
  const cfg = i.cfg || {};
  const idleSec = Math.max(0.5, Number(cfg.idleSec) || 3); // 一次走动持续多久后停下
  const walkSec = Math.max(0.5, Number(cfg.walkSec) || 6); // 一段走动持续多久
  const sleepSec = Math.max(10, Number(cfg.sleepSec) || 300); // 无人互动多久后睡觉

  if (i.hidden || i.action === 'hidden') return { action: 'hidden', dir: 0 };
  if (i.fullscreen) return { action: 'hidden', dir: 0 }; // 全屏授课：一律隐藏，不遮挡
  if (i.talking) return { action: 'talk', dir: 0 };
  if (i.inClass) return { action: 'quiet', dir: 0 }; // 上课时间：站着不动、不主动说话
  if ((i.sinceInteractMs || 0) >= sleepSec * 1000) return { action: 'sleep', dir: 0 };

  // 走动 / 发呆交替：用 seed 切成 walkSec+idleSec 的周期，前半段走、后半段停
  const cyc = walkSec + idleSec;
  const t = (rand01((i.seed || 0) * 0.017) * cyc + ((i.seed || 0) % cyc)) % cyc;
  if (t < walkSec) {
    const dir = rand01(Math.floor((i.seed || 0) / cyc)) < 0.5 ? -1 : 1;
    return { action: 'walk', dir };
  }
  return { action: 'idle', dir: 0 };
}

/**
 * 现在允许桌宠开口吗？
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
  rand01,
  decidePetAction,
  canPetSpeak,
  pickPresetAnswer,
  guardAnswer,
  buildSystemPrompt,
  buildMessages,
};
