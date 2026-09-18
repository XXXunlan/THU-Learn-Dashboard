/**
 * 从「站点自己的真实请求」里学出可重放的模板。
 *
 * 背景：这些 pageList 接口是 DataTables 风格的服务端分页，参数名在压缩代码里
 * 无法确认，靠猜参数的结果是 10 门课全部退回页面兜底（真实数据）。
 * 而站点渲染列表时**必然要发那个请求** —— 嗅探器把它记下来，这里把它变成模板：
 * 下次只要把 wlkcid 换掉、_csrf 换成当前会话的令牌，就能直接重放。
 *
 * 纯函数，可单测。
 */

/** 会随每次请求变化、重放时必须重新生成的参数 */
const VOLATILE = new Set(['_', 'timestamp', 'sEcho', 'ts', 't', 'rnd', 'callback']);

/** 参数名里带这些词的，值就是课程 id */
const WLKCID_KEY = /wlkcid|kcid|kc_id|courseid|course_id/i;

/** 可能以 JSON 形式携带检索条件的参数名 */
const CONDITION_KEY = /^(defaultSearchCondition|searchCondition|conditions?|queryCondition)$/i;

/** 这些接口才是我们要学的（列表类） */
export const LEARNABLE = /\/b\/(?:wlxt\/kcgg|wlxt\/kc|kc)\/[^?]*?(pageList[a-zA-Z]*|xspageList|[a-zA-Z]*pageList[a-zA-Z]*)(\?|$)/i;

/**
 * 把一条被嗅探到的请求改造成“换一门课也能用”的模板。
 * @param {{url:string, method?:string, body?:string}} raw
 * @param {string} wlkcid 目标课程 id
 * @param {string} csrf 当前会话的 _csrf 令牌（没有就删掉该参数）
 * @returns {null|{url:string, method:string, body:string}} 无法改造时返回 null
 */
export function retargetRequest(raw, wlkcid, csrf = '') {
  if (!raw || !raw.url) return null;
  const rawUrl = String(raw.url).trim();
  // 必须是绝对地址或站内路径。注意不能只靠 new URL 抛错来判断 ——
  // new URL('not a url', base) 会把它当相对路径解析成功，于是脏输入会静默通过。
  if (!/^(https?:\/\/|\/)/i.test(rawUrl) || /[\s]/.test(rawUrl)) return null;

  let url;
  try {
    url = new URL(rawUrl, 'https://learn.tsinghua.edu.cn');
  } catch {
    return null;
  }
  if (!/learn\.tsinghua\.edu\.cn$/i.test(url.hostname)) return null;

  // 课程 id 也可能出现在**路径**里（例如 /loadCourseBySemesterId/2026-2027-1000000001/zh），
  // 只换查询参数的话会一直请求同一门课。
  url.pathname = url.pathname.replace(/\/\d{4}-\d{4}-\d{6,}(?=\/|$)/g, `/${wlkcid}`);

  for (const key of [...url.searchParams.keys()]) {
    if (VOLATILE.has(key)) { url.searchParams.delete(key); continue; }
    if (key === '_csrf') {
      if (csrf) url.searchParams.set(key, csrf);
      else url.searchParams.delete(key);
      continue;
    }
    const value = url.searchParams.get(key) || '';
    if (WLKCID_KEY.test(key)) { url.searchParams.set(key, wlkcid); continue; }
    if (CONDITION_KEY.test(key)) {
      url.searchParams.set(key, retargetConditionJson(value, wlkcid));
      continue;
    }
    // 值本身就是课程 id 的情况
    if (/^\d{4}-\d{4}-\d{7,}$/.test(value)) {
      url.searchParams.set(key, wlkcid);
    }
  }
  // 原请求没带 _csrf 时也要补上，否则重放会被当成跨站请求拒掉
  if (csrf && !url.searchParams.has('_csrf')) url.searchParams.set('_csrf', csrf);

  // body 里带着检索条件。实测站点的真实格式是 **DataTables 1.9 的 aoData**：
  //   aoData=[{"name":"sEcho","value":1},...,{"name":"wlkcid","value":"2026-2027-…"}]
  // 之前只认 defaultSearchCondition，导致 body 里的课程 id 从没被替换过 ——
  // 模板会一直请求同一门课的数据，这正是“内容重复”的来源之一。
  const body = retargetBody(raw.body || '', wlkcid);

  return { url: url.href, method: (raw.method || 'GET').toUpperCase(), body };
}

/** 改造请求体：支持 aoData（DataTables 1.9）与 defaultSearchCondition 两种真实形态 */
export function retargetBody(bodyText, wlkcid) {
  if (!bodyText) return '';
  const eq = bodyText.indexOf('=');
  if (eq < 0) return bodyText;
  const key = bodyText.slice(0, eq);
  const rawValue = bodyText.slice(eq + 1);
  const decoded = safeDecode(rawValue);

  if (/^aoData$/i.test(key)) {
    return `${key}=${encodeURIComponent(retargetAoData(decoded, wlkcid))}`;
  }
  if (CONDITION_KEY.test(key)) {
    return `${key}=${encodeURIComponent(retargetConditionJson(decoded, wlkcid))}`;
  }
  return bodyText;
}

function safeDecode(text) {
  try { return decodeURIComponent(String(text).replace(/\+/g, ' ')); } catch { return String(text); }
}

export { safeDecode };

/**
 * 改造 DataTables 的 aoData：它是一个 {name, value} 数组，
 * 课程过滤就是其中 name 为 wlkcid 的那一项。找不到就补一项上去。
 */
export function retargetAoData(jsonText, wlkcid) {
  try {
    const arr = JSON.parse(jsonText);
    if (!Array.isArray(arr)) return jsonText;
    let found = false;
    for (const entry of arr) {
      if (entry && typeof entry === 'object' && typeof entry.name === 'string' && WLKCID_KEY.test(entry.name)) {
        entry.value = wlkcid;
        found = true;
      }
    }
    if (!found) arr.push({ name: 'wlkcid', value: wlkcid });
    return JSON.stringify(arr);
  } catch {
    return jsonText;
  }
}

/**
 * 把检索条件 JSON 里的课程 id 换成目标课程。
 *
 * 实测过的两种真实形态都要认：
 *   1) `[{"name":"wlkcid","value":"2026-2027-1000000001"}]` —— 站点用的就是这种
 *   2) `{"wlkcid":"..."}` 这类直接把课程 id 当字段名的
 */
export function retargetConditionJson(jsonText, wlkcid) {
  try {
    const parsed = JSON.parse(jsonText);
    const walk = (node) => {
      if (Array.isArray(node)) { node.forEach(walk); return; }
      if (!node || typeof node !== 'object') return;
      // 形态 1：{name, value} 描述一个检索字段
      if (typeof node.name === 'string' && WLKCID_KEY.test(node.name) && 'value' in node) {
        node.value = wlkcid;
        return;
      }
      for (const [k, v] of Object.entries(node)) {
        if (typeof v === 'string' && WLKCID_KEY.test(k) && v) node[k] = wlkcid;
        else if (typeof v === 'string' && k === 'value' && node.name === undefined && /^\d{4}-\d{4}-\d{7,}$/.test(v)) node[k] = wlkcid;
        else walk(v);
      }
    };
    walk(parsed);
    return JSON.stringify(parsed);
  } catch {
    return jsonText;
  }
}

/**
 * 从模板的 aoData 里读出**列定义**。
 *
 * 这是打通接口路径的关键：站点的响应是 DataTables 1.9 的 `aaData` 二维数组
 * （每一行是数组，不是对象），光看响应根本不知道哪一列是什么。
 * 但请求体里的 `mDataProp_0='bt'`、`mDataProp_1='fbr'`…… 正好按顺序给出了列名 ——
 * 于是「让站点自己告诉我们」这件事就闭环了：请求格式和列含义都是它说的。
 *
 * @returns {string[]} 形如 ['bt','fbr','fbsj','jzsj','function']
 */
export function columnsFromTemplate(template) {
  if (!template || !template.body) return [];
  try {
    const eq = String(template.body).indexOf('=');
    if (eq < 0) return [];
    const key = String(template.body).slice(0, eq);
    if (!/^aoData$/i.test(key)) return [];
    const arr = JSON.parse(safeDecode(String(template.body).slice(eq + 1)));
    if (!Array.isArray(arr)) return [];
    const indexed = [];
    for (const entry of arr) {
      if (!entry || typeof entry.name !== 'string') continue;
      const m = entry.name.match(/^mDataProp_(\d+)$/);
      if (m) indexed.push({ i: Number(m[1]), field: String(entry.value) });
    }
    indexed.sort((a, b) => a.i - b.i);
    return indexed.map((x) => x.field);
  } catch {
    return [];
  }
}

/** 二维数组行 + 列定义 -> 对象行 */
export function rowsFromArrays(arrays, columns) {
  if (!Array.isArray(arrays) || !arrays.length) return [];
  if (!Array.isArray(columns) || !columns.length) return [];
  return arrays
    .filter((row) => Array.isArray(row))
    .map((row) => {
      const out = {};
      columns.forEach((field, i) => { if (field) out[field] = row[i]; });
      return out;
    });
}

/** 给模板补上列定义，存起来备用 */
export function withColumns(template) {
  if (!template) return template;
  return { ...template, columns: columnsFromTemplate(template) };
}

/**
 * 从一批嗅探记录里挑出每个板块最适合当模板的那条。
 * @param {Array} records 嗅探到的请求
 * @returns {{notice?:object, file?:object, homework?:object}}
 */
export function pickTemplates(records) {
  const out = {};
  for (const r of records || []) {
    if (!r || !r.url || !LEARNABLE.test(r.url)) continue;
    const u = r.url.toLowerCase();
    let kind = '';
    if (u.includes('kcgg') || u.includes('ggb')) kind = 'notice';
    else if (u.includes('/kj/') || u.includes('kjxxb') || u.includes('wjwjb')) kind = 'file';
    else if (u.includes('xszy') || u.includes('/kczy/')) kind = 'homework';
    if (!kind) continue;
    // 带检索条件的优先（它明确说明了按什么字段过滤）；能读出列定义的更优先
    const cols = columnsFromTemplate(r);
    const score = (/defaultSearchCondition|searchCondition|aoData/i.test(r.url + (r.body || '')) ? 2 : 0)
      + (cols.length ? 2 : 0)
      + (r.status === 200 ? 1 : 0);
    if (!out[kind] || score > out[kind].score) out[kind] = { ...r, columns: cols, score };
  }
  return out;
}
