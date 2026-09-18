/**
 * 极简 HTTP 取文本工具（后台专用）。
 *
 * 只做一件事：拿一个页面的 HTML，并**自己处理字符集**。
 * 站点历史上出现过 GBK 页面，`fetch().text()` 只信响应头，遇到乱码就全废了；
 * 这里在乱码偏多时用 meta 声明或 GBK 再解一次。
 */

import { createLogger } from '../common/logger.js';

const log = createLogger('http');

const REPLACEMENT = /\ufffd/g;

function decodeBuffer(buf, contentType) {
  const head = new TextDecoder('utf-8').decode(buf.slice(0, 4096));
  const charset =
    (contentType.match(/charset\s*=\s*["']?([\w-]+)/i) || [])[1] ||
    (head.match(/<meta[^>]+charset\s*=\s*["']?([\w-]+)/i) || [])[1] ||
    'utf-8';

  const tryDecode = (cs) => {
    try { return new TextDecoder(cs, { fatal: false }).decode(buf); } catch { return null; }
  };

  let text = tryDecode(charset) || tryDecode('utf-8') || '';
  const bad = (text.match(REPLACEMENT) || []).length;
  if (bad > 8) {
    const alt = tryDecode('gbk');
    if (alt && (alt.match(REPLACEMENT) || []).length < bad) text = alt;
  }
  return text;
}

/**
 * @returns {Promise<{ok:boolean, status:number, url:string, html:string, charset:string, redirected:boolean}>}
 */
export async function fetchText(url, { timeoutMs = 20000, retries = 1, headers = {} } = {}) {
  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'GET',
        credentials: 'include',
        redirect: 'follow',
        cache: 'no-store',
        signal: controller.signal,
        headers: {
          Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
          'Accept-Language': 'zh-CN,zh;q=0.9',
          ...headers,
        },
      });
      const contentType = res.headers.get('content-type') || '';
      const buf = await res.arrayBuffer();
      const html = decodeBuffer(buf, contentType);
      clearTimeout(timer);
      return { ok: res.ok, status: res.status, url: res.url || url, html, contentType, redirected: res.redirected };
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      const aborted = err && err.name === 'AbortError';
      if (aborted) log.warn(`请求超时：${url}`);
      if (aborted && attempt === retries) break;
    }
  }
  throw new Error(
    /Failed to fetch/i.test((lastErr && lastErr.message) || '')
      ? `无法访问 ${url}`
      : `请求失败：${(lastErr && lastErr.message) || '未知错误'}`,
  );
}
