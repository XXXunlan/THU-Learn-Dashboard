/**
 * 日期 / 截止时间解析。纯函数，可在 Node 里直接单测。
 *
 * 网络学堂里出现的日期形态很杂（不同版本、不同课程的模板不一致），
 * 这里统一收敛成 epoch 毫秒，无法判断时返回 null —— 宁可空着也不要瞎猜。
 */

import { HOUR } from '../common/constants.js';

const CN_NUM = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 十一: 11, 十二: 12 };

export const DEADLINE_KEYWORDS = ['截止时间', '截止日期', '截止', 'deadline', 'due date', 'due', '提交截止', '最晚提交', '提交时间'];
export const PUBLISH_KEYWORDS = ['发布时间', '发布日期', '创建时间', '上传时间', '更新时间', '时间', '日期'];

function normalize(text) {
  return String(text == null ? '' : text)
    .replace(/[\u00a0\u2000-\u200b\u3000]/g, ' ')
    .replace(/\s+/g, ' ');
}

/** 该年该月该日是否真实存在（用于剔除 2024-02-31 这类脏数据） */
function isValidYmd(y, m, d) {
  if (!(y >= 1970 && y <= 2200)) return false;
  if (!(m >= 1 && m <= 12)) return false;
  if (!(d >= 1 && d <= 31)) return false;
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}

function mk(y, m, d, hh = 0, mm = 0, ss = 0) {
  return new Date(y, m - 1, d, hh, mm, ss, 0).getTime();
}

/**
 * 找出文本里所有日期，返回 [{ms, index, length, hasYear, hasTime, hasSeconds}]
 */
export function findDates(input, now = Date.now()) {
  const text = normalize(input);
  const out = [];
  const push = (m, y, mo, d, hh, mm, ss, hasYear, hasTime) => {
    let year = y;
    if (!hasYear) {
      const base = new Date(now);
      year = base.getFullYear();
      // 没写年份时按“离现在最近”理解：过去超过半年视为明年
      const guess = mk(year, mo, d, hh, mm, ss);
      if (guess - now > 180 * 24 * HOUR) year -= 1;
      else if (now - guess > 180 * 24 * HOUR) year += 1;
    }
    if (!isValidYmd(year, mo, d)) return;
    if (hh > 23 || mm > 59 || ss > 59) return;
    out.push({
      ms: mk(year, mo, d, hh, mm, ss),
      index: m.index,
      length: m[0].length,
      hasYear: !!hasYear,
      hasTime: !!hasTime,
      raw: m[0],
    });
  };

  // 1) 带年份：2024-03-01 / 2024/3/1 / 2024.3.1 / 2024年3月1日 [+ 时间]
  const reFull = /(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*日?(?:\s*(\d{1,2})\s*[:：时]\s*(\d{1,2})(?:\s*[:：分]\s*(\d{1,2}))?\s*秒?)?/g;
  let m;
  while ((m = reFull.exec(text))) {
    const hasTime = m[4] != null;
    push(m, +m[1], +m[2], +m[3], hasTime ? +m[4] : 0, hasTime ? +m[5] : 0, m[6] ? +m[6] : 0, true, hasTime);
  }

  // 2) 不带年份：03-01 23:59 / 3月1日
  //
  // 刻意不接受「数字.数字」这种点号分隔（例如 “1.2 MB” 会被读成 1 月 2 日），
  // 也不接受后面紧跟单位/百分号的数字（那是大小、进度、比例，不是日期）。
  const UNIT_AFTER = /^\s*(%|MB|KB|GB|TB|B|px|em|rem|倍|个|人|分|秒|页|条)/i;
  const reShort = /(?:^|[^\d.])(\d{1,2})\s*[-/月]\s*(\d{1,2})\s*日?(?:\s*(\d{1,2})\s*[:：时]\s*(\d{1,2}))?/g;
  while ((m = reShort.exec(text))) {
    const start = m.index + (m[0].length - m[0].replace(/^[^\d]*/, '').length);
    if (out.some((o) => start >= o.index && start < o.index + o.length)) continue;
    const tail = text.slice(m.index + m[0].length, m.index + m[0].length + 6);
    if (UNIT_AFTER.test(tail)) continue;
    const hasTime = m[3] != null;
    push({ 0: m[0], index: start }, NaN, +m[1], +m[2], hasTime ? +m[3] : 0, hasTime ? +m[4] : 0, 0, false, hasTime);
  }

  // 3) 相对日期：今天 / 明天 / 后天 / 昨天 [+ 时间]
  const reRel = /(今天|今日|明天|明日|后天|昨天|昨日)(?:\s*(\d{1,2})\s*[:：]\s*(\d{1,2}))?/g;
  while ((m = reRel.exec(text))) {
    const off = { 今天: 0, 今日: 0, 明天: 1, 明日: 1, 后天: 2, 昨天: -1, 昨日: -1 }[m[1]];
    const base = new Date(now + off * 24 * HOUR);
    const hasTime = m[2] != null;
    out.push({
      ms: mk(base.getFullYear(), base.getMonth() + 1, base.getDate(), hasTime ? +m[2] : 0, hasTime ? +m[3] : 0),
      index: m.index, length: m[0].length, hasYear: true, hasTime, raw: m[0],
    });
  }

  // 4) 中文数字日期：二〇二四年三月一日 —— 少见但见过，顺手支持
  const reCn = /([二〇零一二三四五六七八九]{4})\s*年\s*([一二三四五六七八九十]{1,3})\s*月\s*([一二三四五六七八九十]{1,3})\s*日/g;
  while ((m = reCn.exec(text))) {
    const year = +m[1].split('').map((c) => ({ 二: 2, 〇: 0, 零: 0, 一: 1, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }[c])).join('');
    const mo = CN_NUM[m[2]] || 0;
    const d = CN_NUM[m[3]] || 0;
    if (isValidYmd(year, mo, d)) {
      out.push({ ms: mk(year, mo, d), index: m.index, length: m[0].length, hasYear: true, hasTime: false, raw: m[0] });
    }
  }

  return out.sort((a, b) => a.index - b.index);
}

/** 单个日期：取第一个能解析的 */
export function parseDate(input, now = Date.now()) {
  const list = findDates(input, now);
  return list.length ? list[0].ms : null;
}

/**
 * 从一段文本里抽取截止时间。
 *
 * 策略：优先取「截止/截止时间/deadline」等关键词之后紧邻的日期。
 * 找不到关键词时**只在整段只有一个日期**的情况下才接受它 ——
 * 因为作业行里往往同时有「提交日期」和「截止日期」，随便挑第一个会把提交时间
 * 当成截止时间（这是被测试抓出来的真实缺陷）。宁可返回 null 让面板显示
 * “未标注截止时间”，也不要给一个看似合理其实错的日期。
 */
export function extractDeadline(input, now = Date.now()) {
  const text = normalize(input);
  if (!text) return { deadline: null, reason: 'empty' };
  const dates = findDates(text, now);
  if (!dates.length) return { deadline: null, reason: 'no-date' };

  const lower = text.toLowerCase();
  for (const kw of DEADLINE_KEYWORDS) {
    const idx = lower.indexOf(kw.toLowerCase());
    if (idx < 0) continue;
    const after = dates.filter((d) => d.index >= idx - 2);
    if (after.length) {
      // 关键词后面最近的那个；带时间的优先（截止时间几乎总带时分）
      const withTime = after.find((d) => d.hasTime);
      return { deadline: (withTime || after[0]).ms, reason: `keyword:${kw}` };
    }
    const before = dates.filter((d) => d.index < idx);
    if (before.length) return { deadline: before[before.length - 1].ms, reason: `keyword-before:${kw}` };
  }

  const withTime = dates.filter((d) => d.hasTime);
  if (withTime.length === 1) return { deadline: withTime[0].ms, reason: 'sole-datetime' };
  if (dates.length === 1) return { deadline: dates[0].ms, reason: 'sole-date' };

  // 行里有多个日期又没有「截止」字样（关键词写在表头里了）。
  // 直接取第一个会把「提交日期」当成截止时间；经验上截止时间总在提交日期之后，
  // 所以取最晚的那个，并且**明确标成推定**，让面板能提示用户这是猜的。
  const latest = dates.reduce((a, b) => (b.ms > a.ms ? b : a));
  return { deadline: latest.ms, reason: `inferred:latest-datetime(${dates.length})` };
}

/** 发布时间：取第一个日期，通常就是列表里的时间列 */
export function extractPublishDate(input, now = Date.now()) {
  const dates = findDates(input, now);
  if (!dates.length) return null;
  const byKeyword = PUBLISH_KEYWORDS.map((kw) => {
    const i = normalize(input).indexOf(kw);
    return i < 0 ? null : dates.find((d) => d.index >= i);
  }).find(Boolean);
  return (byKeyword || dates[0]).ms;
}

/** 把一段文本归到 done / pending / unknown */
export function classifyStatus(input, { done = [], pending = [] } = {}) {
  const text = normalize(input);
  if (!text) return { status: 'unknown', evidence: '' };
  // 先查“未提交”，否则“已提交”会被 "提交" 子串误判
  for (const p of pending) {
    if (text.includes(p)) return { status: 'pending', evidence: p };
  }
  for (const d of done) {
    if (text.includes(d)) return { status: 'done', evidence: d };
  }
  return { status: 'unknown', evidence: '' };
}
