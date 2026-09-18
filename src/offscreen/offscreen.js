/**
 * 离屏文档：唯一持有 DOMParser 的地方。
 * 只做“HTML 字符串 -> 结构化数据”的纯计算，不碰网络、不碰存储。
 */

import { createLogger } from '../common/logger.js';
import { PARSE, TARGET } from '../common/constants.js';
import { extractCourses, extractCoursesFromHtml } from '../parsers/course-list.js';
import { parseSectionPage, isEmptyListPage, findNextPage } from '../parsers/list-page.js';
import { analyzeLoginForm, looksLoggedIn } from '../parsers/login-form.js';
import { detectPageKind, textOf, findLogoutUrl, findSectionLinks } from '../parsers/heuristics.js';
import { parseHomeworkDetail } from '../parsers/homework-detail.js';
import { truncate } from '../common/utils.js';

const log = createLogger('offscreen');
let ready = false;

function parseDoc(html, url) {
  // text/html 交给浏览器自己的容错解析器，比任何手写 parser 都接近真实页面
  const doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
  if (url) {
    // DOMParser 不会记录来源地址，这里挂一个标记，解析器需要时可以读
    try { doc.__baseUrl = url; } catch { /* ignore */ }
  }
  return doc;
}

const HANDLERS = {
  [PARSE.PING]: () => ({ pong: true, ready }),

  [PARSE.COURSE_LIST]: ({ html, url }) => {
    const doc = parseDoc(html, url);
    const primary = extractCourses(doc, url);
    let courses = primary.courses;
    let method = primary.method;
    if (!courses.length) {
      // SPA：DOM 里没东西，直接扫原始 HTML 里的 wlkcid
      courses = extractCoursesFromHtml(String(html || ''), url);
      method = courses.length ? 'html:wlkcid-scan' : 'none';
    }
    return {
      courses,
      method,
      stats: primary.stats,
      pageKind: detectPageKind(doc, url),
      loggedIn: looksLoggedIn(doc, url),
      pageTitle: truncate(textOf(doc.querySelector('title')), 80),
      nextPageUrl: findNextPage(doc, url),
      bodyPreview: truncate(textOf(doc.body), 200),
    };
  },

  [PARSE.ITEM_LIST]: ({ html, url, kind = 'auto', now, maxItems = 200 }) => {
    const doc = parseDoc(html, url);
    const parsed = parseSectionPage(doc, url, kind, { now, maxItems });
    return {
      ...parsed,
      emptyHint: isEmptyListPage(doc),
      loggedIn: looksLoggedIn(doc, url),
    };
  },

  [PARSE.LOGIN_FORM]: ({ html, url }) => {
    const doc = parseDoc(html, url);
    return {
      form: analyzeLoginForm(doc, url),
      loggedIn: looksLoggedIn(doc, url),
      pageKind: detectPageKind(doc, url),
      title: truncate(textOf(doc.querySelector('title')), 80),
    };
  },

  [PARSE.HOMEWORK_DETAIL]: ({ html, url }) => {
    const doc = parseDoc(html, url);
    const parsed = parseHomeworkDetail(doc, url);
    return { ...parsed, pageKind: detectPageKind(doc, url), bodyLength: textOf(doc.body).length };
  },

  [PARSE.PAGE_KIND]: ({ html, url }) => {
    const doc = parseDoc(html, url);
    return {
      pageKind: detectPageKind(doc, url),
      loggedIn: looksLoggedIn(doc, url),
      title: truncate(textOf(doc.querySelector('title')), 80),
      logoutUrl: findLogoutUrl(doc, url),
      sectionLinks: findSectionLinks(doc, url),
      bodyPreview: truncate(textOf(doc.body), 300),
    };
  },
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.target !== TARGET.OFFSCREEN) return false;
  const handler = HANDLERS[msg.parse];
  if (!handler) {
    sendResponse({ ok: false, error: `未知的解析请求: ${msg.parse}` });
    return false;
  }
  try {
    const data = handler(msg);
    sendResponse({ ok: true, data });
  } catch (err) {
    log.error('解析失败', msg.parse, err);
    sendResponse({ ok: false, error: err && err.message ? err.message : String(err) });
  }
  return false; // 同步响应
});

ready = true;
log.info('离屏解析器就绪');
