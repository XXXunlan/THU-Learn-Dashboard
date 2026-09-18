/**
 * _csrf 令牌解析。
 *
 * 站点自己对 /b/... 的请求都会带一个 `_csrf=<uuid>` 查询参数（同一个会话内固定）。
 * 但它从哪里来，无法从前端缓存里 100% 确认（站点把 handleUrlWithCsrf 的实现藏在
 * 压缩/字节码里，旁边出现的字符串是 `_csrf=`、`csrf_token`、`XSRF-TOKEN`）。
 * 所以这里不赌一种来源，而是按可靠性依次尝试，并且**最终以“能不能调通接口”为准**
 * —— 调用方拿到 token 后先探一次，失败就当作没有 token 再试一次。
 */

import { ORIGIN } from '../api/endpoints.js';
import { createLogger } from '../common/logger.js';

const log = createLogger('csrf');

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const COOKIE_NAMES = ['XSRF-TOKEN', 'csrf_token', 'CSRF-TOKEN', '_csrf', 'csrfToken', 'X-CSRF-TOKEN'];
const STORAGE_NAMES = ['_csrf', 'csrf_token', 'csrfToken', 'XSRF-TOKEN', 'csrf'];

const cache = { token: '', at: 0, source: '' };
const TTL = 10 * 60 * 1000;

export function cachedToken() {
  if (cache.token && Date.now() - cache.at < TTL) return cache.token;
  return '';
}

export function rememberToken(token, source) {
  if (!token) return '';
  cache.token = token;
  cache.at = Date.now();
  cache.source = source || 'unknown';
  log.info(`_csrf 已获取（来源：${cache.source}）`);
  return token;
}

export function clearToken() {
  cache.token = '';
  cache.at = 0;
  cache.source = '';
}

export function tokenSource() {
  return cache.source;
}

/** 策略 1：让某个已打开的网络学堂标签页里的内容脚本去问站点自己 */
async function fromOpenTab() {
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({ url: `${ORIGIN}/*` });
  } catch {
    return '';
  }
  for (const tab of tabs.slice(0, 3)) {
    try {
      const res = await chrome.tabs.sendMessage(tab.id, { target: 'content', type: 'getCsrf' });
      if (res && res.token) return { token: res.token, source: `tab:${res.via || 'page'}` };
    } catch {
      /* 该标签页没有内容脚本（未注入/已刷新），换下一个 */
    }
  }
  return '';
}

/** 策略 2：直接扫页面 HTML（有些模板会把 token 渲染在页面里） */
async function fromPageHtml() {
  try {
    const res = await fetch(`${ORIGIN}/f/wlxt/index/course/student/`, {
      credentials: 'include',
      redirect: 'follow',
    });
    const html = await res.text();
    const patterns = [
      /name=["']_csrf["'][^>]*content=["']([^"']+)["']/i,
      /content=["']([^"']+)["'][^>]*name=["']_csrf["']/i,
      /["']_csrf["']\s*[:=]\s*["']([^"']+)["']/i,
      /_csrf["']?\s*[:=]\s*["']([^"']+)["']/i,
      /csrf_token["']?\s*[:=]\s*["']([^"']+)["']/i,
    ];
    for (const re of patterns) {
      const m = html.match(re);
      if (m && m[1] && m[1].length >= 8) return { token: m[1], source: 'page-html' };
    }
    const u = html.match(UUID_RE);
    if (u && /csrf/i.test(html.slice(Math.max(0, u.index - 200), u.index + 200))) {
      return { token: u[0], source: 'page-html-uuid' };
    }
  } catch (err) {
    log.debug('扫描页面 HTML 取 token 失败', err && err.message);
  }
  return '';
}

/**
 * 依次尝试各策略。找不到就返回空串 —— 调用方会退化为“不带 token 直接请求”。
 */
export async function resolveCsrf({ force = false } = {}) {
  if (!force) {
    const hit = cachedToken();
    if (hit) return hit;
  }
  const strategies = [fromOpenTab, fromPageHtml];
  for (const fn of strategies) {
    try {
      const got = await fn();
      if (got && got.token) return rememberToken(got.token, got.source);
    } catch (err) {
      log.debug('csrf 策略失败', err && err.message);
    }
  }
  log.warn('未能取得 _csrf，将先尝试不带 token 请求');
  return '';
}

export const csrfCandidates = { COOKIE_NAMES, STORAGE_NAMES, UUID_RE };
