/** 通用小工具（后台 / offscreen / UI / 测试 共用，不依赖任何浏览器 API）。 */

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 把可能是相对路径的 url 解析成绝对地址 */
export function absolutize(url, base) {
  if (!url) return '';
  try {
    return new URL(url, base).href;
  } catch {
    return url;
  }
}

export function sameOrigin(a, b) {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

/** 压缩空白，去掉 \u00a0 与零宽字符 */
export function squash(text) {
  return String(text == null ? '' : text)
    .replace(/[\u00a0\u2000-\u200b\u3000]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function truncate(text, n) {
  const s = String(text == null ? '' : text);
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

/** 稳定 id：优先用业务 id，否则退化为标题+链接的哈希 */
export function hashString(str) {
  let h = 5381;
  const s = String(str);
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

export function makeId(...parts) {
  const key = parts.filter(Boolean).join('|');
  return key.length <= 80 && /^[\w|.\-:/=?&]+$/.test(key) ? key : hashString(key);
}

export function uniqBy(list, keyFn) {
  const seen = new Set();
  const out = [];
  for (const it of list) {
    const k = keyFn(it);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(it);
  }
  return out;
}

export function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** 简单并发池：限制同时进行的任务数，保持结果顺序 */
export async function mapLimit(items, limit, worker) {
  const list = Array.from(items);
  const results = new Array(list.length);
  let cursor = 0;
  const n = Math.max(1, Math.min(limit || 1, list.length || 1));
  const runners = new Array(n).fill(0).map(async () => {
    for (;;) {
      const i = cursor++;
      if (i >= list.length) return;
      try {
        results[i] = await worker(list[i], i);
      } catch (err) {
        results[i] = { __error: err && err.message ? err.message : String(err) };
      }
    }
  });
  await Promise.all(runners);
  return results;
}

export function parseUrlParams(url) {
  const out = {};
  try {
    const u = new URL(url);
    for (const [k, v] of u.searchParams.entries()) out[k.toLowerCase()] = v;
  } catch { /* ignore */ }
  return out;
}

/** 从 URL 中提取课程标识：wlkcid / courseId / kcid / id */
export function extractCourseKey(url) {
  const p = parseUrlParams(url);
  return {
    wlkcid: p.wlkcid || p.wlkc_id || p.kcid || '',
    courseId: p.courseid || p.course_id || '',
    raw: p.id || '',
    semester: p.semester || p.xnxq || '',
  };
}

/** 扩展名 -> 大致分类，用于文件图标与配色 */
export function fileKind(name, url = '') {
  const m = String(name || url).match(/\.([A-Za-z0-9]{1,6})(?:$|[?#])/);
  const ext = m ? m[1].toLowerCase() : '';
  const map = {
    pdf: 'pdf', doc: 'doc', docx: 'doc', wps: 'doc', odt: 'doc', rtf: 'doc',
    ppt: 'ppt', pptx: 'ppt', dps: 'ppt',
    xls: 'xls', xlsx: 'xls', csv: 'xls', et: 'xls',
    zip: 'zip', rar: 'zip', '7z': 'zip', tar: 'zip', gz: 'zip',
    png: 'img', jpg: 'img', jpeg: 'img', gif: 'img', bmp: 'img', webp: 'img', svg: 'img',
    mp4: 'video', avi: 'video', mkv: 'video', mov: 'video', flv: 'video',
    mp3: 'audio', wav: 'audio', m4a: 'audio',
    txt: 'txt', md: 'txt', c: 'code', cpp: 'code', h: 'code', java: 'code',
    py: 'code', js: 'code', ts: 'code', ipynb: 'code', m: 'code', r: 'code',
    tex: 'code', html: 'code', css: 'code', json: 'code', sql: 'code',
  };
  return { ext, kind: map[ext] || 'file' };
}

/** 人类可读的剩余时间 */
export function humanizeRemaining(ms) {
  const abs = Math.abs(ms);
  const d = Math.floor(abs / 86400000);
  const h = Math.floor((abs % 86400000) / 3600000);
  const m = Math.floor((abs % 3600000) / 60000);
  let core;
  if (d > 0) core = `${d} 天${h > 0 ? ` ${h} 小时` : ''}`;
  else if (h > 0) core = `${h} 小时${m > 0 ? ` ${m} 分` : ''}`;
  else core = `${Math.max(m, 0)} 分钟`;
  return ms < 0 ? `已逾期 ${core}` : `剩 ${core}`;
}

export function formatDateTime(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function formatDate(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function relativeDay(ms, now = Date.now()) {
  if (!ms) return '';
  const diff = ms - now;
  const days = Math.round(diff / 86400000);
  if (Math.abs(days) <= 0) return '今天';
  if (days === 1) return '明天';
  if (days === -1) return '昨天';
  if (days > 1 && days <= 7) return `${days} 天后`;
  if (days < -1 && days >= -7) return `${-days} 天前`;
  return '';
}

export function formatBytes(n) {
  if (!n && n !== 0) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = Number(n);
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

/** 从任意文本里猜文件大小，例如 "1.2 MB" / "345KB" */
export function parseSize(text) {
  const m = String(text || '').match(/([\d.]+)\s*(B|KB|MB|GB|TB)\b/i);
  if (!m) return null;
  const mult = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3, tb: 1024 ** 4 };
  return Math.round(parseFloat(m[1]) * mult[m[2].toLowerCase()]);
}

/** 稳定排序：先按截止时间升序，无截止的排最后 */
export function sortByDeadlineThenDate(items) {
  return items.slice().sort((a, b) => {
    const ad = a.deadline || 0;
    const bd = b.deadline || 0;
    if (ad && bd) return ad - bd;
    if (ad) return -1;
    if (bd) return 1;
    return (b.date || 0) - (a.date || 0);
  });
}
