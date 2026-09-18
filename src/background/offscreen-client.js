/**
 * 与离屏文档通信的客户端封装。
 *
 * MV3 里 DOMParser 只在普通文档里存在，所以这里负责：
 *  1) 按需创建离屏文档（并处理“已经存在一个”的竞态）
 *  2) 把 HTML 发过去、把结构化结果收回来
 *  3) 离屏文档被浏览器回收后自动重建重试一次
 */

import { PARSE, TARGET } from '../common/constants.js';
import { createLogger } from '../common/logger.js';

const log = createLogger('offscreen-client');
const OFFSCREEN_PATH = 'src/offscreen/offscreen.html';

let creatingPromise = null;

async function hasOffscreen() {
  if (chrome.offscreen && typeof chrome.offscreen.hasDocument === 'function') {
    try { return await chrome.offscreen.hasDocument(); } catch { return false; }
  }
  return false;
}

export async function ensureOffscreen() {
  if (!chrome.offscreen) {
    throw new Error('当前浏览器不支持 offscreen API（需要 Chrome/Edge 109+）');
  }
  if (await hasOffscreen()) return true;
  if (creatingPromise) return creatingPromise;

  creatingPromise = (async () => {
    try {
      await chrome.offscreen.createDocument({
        url: OFFSCREEN_PATH,
        reasons: ['DOM_PARSER'],
        justification: '解析网络学堂返回的 HTML，提取课程、公告、文件与作业信息。',
      });
      log.info('离屏文档已创建');
    } catch (err) {
      const msg = (err && err.message) || String(err);
      if (/single offscreen|already exists/i.test(msg)) {
        log.debug('离屏文档已存在，复用');
        return true;
      }
      throw err;
    }
    return true;
  })().finally(() => { creatingPromise = null; });

  return creatingPromise;
}

async function sendOnce(payload) {
  const res = await chrome.runtime.sendMessage({ target: TARGET.OFFSCREEN, ...payload });
  if (!res) throw new Error('离屏文档没有响应（可能刚被回收）');
  if (!res.ok) throw new Error(res.error || '解析失败');
  return res.data;
}

/**
 * @param {string} parse PARSE.*
 * @param {object} payload {html, url, kind, now, maxItems}
 */
export async function parseWith(parse, payload) {
  await ensureOffscreen();
  try {
    return await sendOnce({ parse, ...payload });
  } catch (err) {
    log.warn('首次解析失败，重建离屏文档后重试', err && err.message);
    try {
      if (chrome.offscreen && chrome.offscreen.closeDocument) {
        await chrome.offscreen.closeDocument().catch(() => {});
      }
    } catch { /* ignore */ }
    await ensureOffscreen();
    return sendOnce({ parse, ...payload });
  }
}

export const parseCourseList = (html, url) => parseWith(PARSE.COURSE_LIST, { html, url });
export const parseItemList = (html, url, kind, opts = {}) =>
  parseWith(PARSE.ITEM_LIST, { html, url, kind, ...opts });
export const parseLoginForm = (html, url) => parseWith(PARSE.LOGIN_FORM, { html, url });
export const parsePageInfo = (html, url) => parseWith(PARSE.PAGE_KIND, { html, url });
export const parseHomeworkDetail = (html, url) => parseWith(PARSE.HOMEWORK_DETAIL, { html, url });
export const pingOffscreen = () => parseWith(PARSE.PING, { html: '', url: '' });
