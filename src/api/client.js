/**
 * 网络学堂 JSON 客户端（运行在 Service Worker 里）。
 *
 * 两个现实约束：
 *  1) 这些 pageList 接口是 DataTables 风格的服务端分页，参数名继承自 jQuery DataTables 1.9。
 *     我们没法从压缩代码里 100% 还原它到底读哪些参数，所以这里**发一个超集**：
 *     1.9 与 1.10 两代命名都带上，再叠加站点自己的 defaultSearchCondition。
 *  2) 响应外壳是站点自定的 {message, resultList}，但不同接口/版本不完全一致，
 *     因此 extractRows 会在常见字段名里深挖第一个对象数组，而不是写死一条路径。
 */

import { ORIGIN } from './endpoints.js';
import { retargetRequest, columnsFromTemplate, rowsFromArrays } from './learned.js';
import { createLogger } from '../common/logger.js';

const log = createLogger('api');

/** DataTables 服务端分页参数的“超集” */
export function dtParams({ start = 0, length = 200, wlkcid = '', echo = 1, columns = 12 } = {}) {
  const p = {
    sEcho: String(echo),
    iDisplayStart: String(start),
    iDisplayLength: String(length),
    iColumns: String(columns),
    sColumns: new Array(columns).fill('').join(','),
    iSortingCols: '0',
    iSortCol_0: '0',
    sSortDir_0: 'asc',
    sSearch: '',
    bRegex: 'false',
    _: String(Date.now()),
    v: '1',
  };
  for (let i = 0; i < columns; i++) {
    p[`mDataProp_${i}`] = String(i);
    p[`sSearch_${i}`] = '';
    p[`bRegex_${i}`] = 'false';
    p[`bSearchable_${i}`] = 'true';
    p[`bSortable_${i}`] = 'true';
  }
  if (wlkcid) {
    p.defaultSearchCondition = JSON.stringify([{ name: 'wlkcid', value: String(wlkcid) }]);
    // 有些版本把课程过滤直接作为普通参数发送，一并带上，多余参数服务端会忽略
    p.wlkcid = String(wlkcid);
  }
  return p;
}

function buildUrl(path, params) {
  const url = new URL(path.startsWith('http') ? path : ORIGIN + path);
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    url.searchParams.set(k, String(v));
  }
  return url.href;
}

/**
 * 从任意响应外壳里挖出“对象数组”，并说明是命中了哪个约定的字段名。
 *
 * matchedKey 存在是很有意义的信息：它说明**服务端确实按我们期望的形状回答了**
 * （哪怕数组是空的）。没有它才需要怀疑是参数不对、该走兜底路径。
 *
 * 真实观测到的外壳不止一种，所以除了常见字段名，最后还会**兜底深挖所有键**：
 *   - `{message:'success', resultList:[...]}`
 *   - `{result:true, msg:'success', object:{...}}`   ← 站点实际用的
 *   - DataTables 1.9：`{sEcho, iTotalRecords, aaData:[[...]]}`
 */
export function extractRowsDetailed(json) {
  const seen = new WeakSet();
  const KEYS = [
    'resultList', 'aaData', 'data', 'rows', 'list', 'records', 'items',
    'content', 'results', 'pageData', 'totalList',
    // 站点真实外壳里数据挂在 object 上
    'object', 'obj', 'body', 'payload',
  ];
  function walk(node, depth) {
    if (!node || typeof node !== 'object' || depth > 4) return null;
    if (Array.isArray(node)) {
      if (node.length === 0) return { rows: [], matchedKey: '@array' };
      if (typeof node[0] === 'object' && node[0] !== null) {
        // DataTables 1.9 的 aaData 是**二维数组**（行是数组），也照样返回，
        // 由调用方用从模板学到的列定义还原成对象
        return { rows: node, matchedKey: Array.isArray(node[0]) ? '@array-of-arrays' : '@array' };
      }
      return null;
    }
    if (seen.has(node)) return null;
    seen.add(node);

    for (const k of KEYS) {
      if (k in node) {
        const r = walk(node[k], depth + 1);
        // 用 '>' 串起整条路径，这样“命中的是二维数组”这类信息不会在包装层丢掉
        if (r) return { rows: r.rows, matchedKey: `${k}>${r.matchedKey}` };
      }
    }
    // 兜底：不认识的外壳也要能挖出来，否则站点换个包装就整个失效
    for (const k of Object.keys(node)) {
      if (KEYS.includes(k)) continue;
      const r = walk(node[k], depth + 1);
      if (r) return { rows: r.rows, matchedKey: `*${k}>${r.matchedKey}` };
    }
    return null;
  }
  const found = walk(json, 0);
  return found || { rows: [], matchedKey: '' };
}

export function extractRows(json) {
  return extractRowsDetailed(json).rows;
}

export function extractTotal(json) {
  if (!json || typeof json !== 'object') return 0;
  for (const k of ['iTotalDisplayRecords', 'iTotalRecords', 'total', 'totalCount', 'count', 'totalNum']) {
    const v = json[k];
    if (typeof v === 'number') return v;
    if (typeof v === 'string' && /^\d+$/.test(v)) return Number(v);
  }
  return 0;
}

async function rawFetch(url, { method = 'GET', body, csrf }) {
  const finalUrl = csrf
    ? `${url}${url.includes('?') ? '&' : '?'}_csrf=${encodeURIComponent(csrf)}`
    : url;
  const res = await fetch(finalUrl, {
    method,
    body,
    credentials: 'include',
    redirect: 'follow',
    cache: 'no-store',
    headers: {
      Accept: 'application/json, text/javascript, */*; q=0.01',
      'X-Requested-With': 'XMLHttpRequest',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' } : {}),
    },
  });
  const text = await res.text();
  return { status: res.status, ok: res.ok, url: res.url || finalUrl, text, finalUrl };
}

/**
 * 请求一个列表接口。
 * @returns {Promise<{ok:boolean, rows:Array, total:number, status:number, url:string, reason:string}>}
 */
export async function apiList(path, { wlkcid = '', start = 0, length = 200, csrf = '', extra = {} } = {}) {
  const params = { ...dtParams({ start, length, wlkcid }), ...extra };
  const url = buildUrl(path, params);
  const attempts = [
    { label: 'GET+csrf', method: 'GET', body: undefined, csrf },
    // 没有令牌时不要重复发同一个请求
    ...(csrf ? [{ label: 'GET', method: 'GET', body: undefined, csrf: '' }] : []),
    { label: 'POST', method: 'POST', body: new URLSearchParams(params).toString(), csrf: '' },
  ];

  let lastReason = '未尝试';
  for (const a of attempts) {
    try {
      const res = await rawFetch(url, a);
      const text = res.text || '';
      const looksHtml = /^\s*<(!doctype|html)/i.test(text);
      if (looksHtml) {
        lastReason = '返回的是 HTML（很可能未登录，或接口已改版）';
        continue;
      }
      let json = null;
      try { json = JSON.parse(text); } catch { /* 继续尝试 */ }
      if (!json) {
        lastReason = `响应不是 JSON（前 80 字：${text.slice(0, 80)}）`;
        continue;
      }
      const rows = extractRows(json);
      const total = extractTotal(json);
      const detail = extractRowsDetailed(json);
      const trusted = !!detail.matchedKey;
      if (!rows.length) {
        lastReason = json.message
          ? `接口返回 message=${json.message}，无数据`
          : (trusted ? '接口正常应答但记录数为 0' : '响应里没有找到预期的列表字段');
        // 只有“服务端按约定形状回答了”才认为空是真的空；否则交给兜底路径再试
        return { ok: trusted, rows: [], total: 0, trusted, status: res.status, url: res.finalUrl, reason: lastReason, via: a.label };
      }
      log.info(`${path} 取到 ${rows.length} 条（${a.label}）`);
      return { ok: true, rows, total, trusted, status: res.status, url: res.finalUrl, reason: '', via: a.label };
    } catch (err) {
      lastReason = err && err.message ? err.message : String(err);
    }
  }
  log.warn(`${path} 请求失败：${lastReason}`);
  return { ok: false, rows: [], total: 0, status: 0, url, reason: lastReason, via: '' };
}

/**
 * 用**学到的模板**请求列表：把站点自己发过的那个请求重放一次，只把课程 id 换掉。
 *
 * 这是接口层的首选路径 —— 参数是站点的原话，不需要我们猜。
 * 模板来自 content/sniffer.js 的实际观测（见 api/learned.js）。
 *
 * 注意响应可能是 DataTables 1.9 的 `aaData` **二维数组**（行是数组不是对象），
 * 这时用模板里学到的列定义把它转成对象行 —— 列定义同样来自站点自己的请求。
 */
export async function apiListViaTemplate(template, { wlkcid = '', csrf = '' } = {}) {
  const retargeted = retargetRequest(template, wlkcid, csrf);
  if (!retargeted) return { ok: false, rows: [], trusted: false, via: 'template', reason: '模板无法改造' };
  const columns = template.columns && template.columns.length ? template.columns : columnsFromTemplate(template);
  const attempts = [
    { label: '模板GET', method: 'GET', body: undefined },
    ...(retargeted.method === 'POST' ? [{ label: '模板POST', method: 'POST', body: retargeted.body }] : []),
  ];
  let lastReason = '';
  for (const a of attempts) {
    try {
      // 模板 URL 里已经带好了 _csrf，这里不要再追加一次
      const res = await rawFetch(retargeted.url, { ...a, csrf: '' });
      const text = res.text || '';
      if (/^\s*</.test(text)) { lastReason = '模板重放返回 HTML'; continue; }
      let json = null;
      try { json = JSON.parse(text); } catch { lastReason = '模板重放返回的不是 JSON'; continue; }
      const detail = extractRowsDetailed(json);
      if (!detail.matchedKey) {
        lastReason = `模板重放的响应里没有预期的列表字段（顶层键：${Object.keys(json).slice(0, 8).join(',')}）`;
        continue;
      }
      let rows = detail.rows;
      if (rows.length && Array.isArray(rows[0])) {
        // 二维数组：用学到的列定义还原成对象
        const mapped = rowsFromArrays(rows, columns);
        if (!mapped.length) {
          lastReason = `响应是二维数组，但模板里没有列定义（columns=${columns.length}）`;
          continue;
        }
        rows = mapped;
      }
      log.info(`模板重放成功：${rows.length} 条（${a.label}，列定义 ${columns.length} 个）`);
      return { ok: true, rows, total: extractTotal(json), trusted: true, via: `template:${a.label}`, reason: '' };
    } catch (err) {
      lastReason = (err && err.message) || String(err);
    }
  }
  return { ok: false, rows: [], trusted: false, via: 'template', reason: lastReason || '模板重放失败' };
}

/** 请求一个返回 JSON 的普通接口 */
export async function apiJson(path, { csrf = '', params = {} } = {}) {
  const url = buildUrl(path, params);
  for (const token of [csrf, '']) {
    try {
      const res = await rawFetch(url, { method: 'GET', csrf: token });
      if (/^\s*</.test(res.text || '')) continue;
      return { ok: true, json: JSON.parse(res.text), url: res.finalUrl, status: res.status };
    } catch (err) {
      if (token === '') {
        return { ok: false, json: null, url, status: 0, reason: err.message };
      }
    }
  }
  return { ok: false, json: null, url, status: 0, reason: '响应不是 JSON' };
}

/** 有没有登录：接口返回 HTML（登录页）就说明会话失效 */
export async function probeSession() {
  const res = await apiJson('/b/kc/zhjw_v_code_xnxq/getCurrentAndNextSemester', {});
  if (res.ok) return { loggedIn: true, json: res.json };
  return { loggedIn: false, reason: res.reason };
}

/**
 * 会话探测专用的接口请求。
 *
 * 与 apiJson 的区别有两点，都很关键：
 *  1) **不跟随重定向**（redirect: 'manual'）。「这个接口到底有没有被重定向」
 *     本身就是判断登录态最硬的证据 —— 已登录的会话不会把 /b/ 接口重定向到登录页，
 *     而未登录一定会。
 *  2) 把结果明确分成 json / redirect / html / error 四类，交给上层决策，
 *     而不是把“没拿到 JSON”揉成一句模糊的 reason。
 */
export async function probeJson(path, { csrf = '', timeoutMs = 12000 } = {}) {
  const url = buildUrl(path, { _: String(Date.now()) });
  const target = csrf ? `${url}&_csrf=${encodeURIComponent(csrf)}` : url;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(target, {
      method: 'GET',
      credentials: 'include',
      redirect: 'manual',
      cache: 'no-store',
      signal: controller.signal,
      headers: {
        Accept: 'application/json, text/javascript, */*; q=0.01',
        'X-Requested-With': 'XMLHttpRequest',
        'Accept-Language': 'zh-CN,zh;q=0.9',
      },
    });
    if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) {
      return { kind: 'redirect', status: res.status || 0, url: target };
    }
    const text = await res.text();
    let json = null;
    if (!/^\s*</.test(text)) {
      try { json = JSON.parse(text); } catch { json = null; }
    }
    if (!json) {
      return { kind: 'html', status: res.status, url: res.url || target, snippet: text.slice(0, 160) };
    }
    return { kind: 'json', status: res.status, url: res.url || target, json };
  } catch (err) {
    return { kind: 'error', status: 0, url: target, reason: (err && err.message) || String(err) };
  } finally {
    clearTimeout(timer);
  }
}
