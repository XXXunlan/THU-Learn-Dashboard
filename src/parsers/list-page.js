/**
 * 列表页解析：课程内的 公告 / 文件 / 作业 三个板块共用一套逻辑。
 *
 * 与 heuristics.js 的关系：这里负责“这一页是什么、条目属于哪一类、下一页在哪”，
 * 具体条目的抽取交给 heuristics 的多策略引擎。
 */

import { squash, absolutize, truncate, fileKind } from '../common/utils.js';
import { extractListItems, findSectionLinks, detectPageKind, textOf } from './heuristics.js';

export const KINDS = ['notice', 'file', 'homework'];

/** 用文本特征猜测条目类型（页面本身没说清时的兜底） */
export function guessKind(item) {
  const t = `${item.title} ${item.text || ''}`;
  if (/\.(pdf|docx?|pptx?|xlsx?|zip|rar|7z|mp4|pptx?|txt|md|csv|cpp|py|ipynb)\b/i.test(item.title)) return 'file';
  if (/截止|提交|作业|实验报告|习题|assignment|homework/i.test(t)) return 'homework';
  if (/公告|通知|关于|announcement|notice/i.test(t)) return 'notice';
  return 'notice';
}

/** 找“下一页” */
export function findNextPage(doc, baseUrl) {
  const candidates = Array.from(doc.querySelectorAll('a[href]'));
  for (const a of candidates) {
    const t = squash(textOf(a));
    if (/^(下一页|下页|next|›|»|>)$/i.test(t)) {
      const href = absolutize(a.getAttribute('href'), baseUrl);
      if (href && href !== baseUrl) return href;
    }
  }
  // 有些分页是 input/button + js，尽量从 class 里识别
  const next = doc.querySelector('.pagination .next:not(.disabled) a, .pager .next:not(.disabled) a, a[rel="next"]');
  if (next && next.getAttribute) {
    const href = absolutize(next.getAttribute('href'), baseUrl);
    if (href && href !== baseUrl) return href;
  }
  return '';
}

/** 页面上出现的课程名（用于课程名兜底） */
export function findPageTitle(doc) {
  const h = doc.querySelector('h1, h2, .course-name, [class*="courseName"], [class*="course-title"]');
  const t = h ? squash(textOf(h)) : '';
  if (t && t.length <= 40) return t;
  const title = doc.querySelector('title');
  const tt = title ? squash(textOf(title)) : '';
  return tt.replace(/[-–|].*$/, '').trim();
}

/**
 * @param {Document} doc 已经 DOMParser.parseFromString 过的文档
 * @param {string} url 该页的真实 URL（用于解析相对链接）
 * @param {'notice'|'file'|'homework'|'auto'} kind
 * @param {{now?:number, maxItems?:number}} opts
 */
export function parseSectionPage(doc, url, kind = 'auto', opts = {}) {
  const now = opts.now || Date.now();
  const detected = detectPageKind(doc, url);
  const effectiveKind = kind !== 'auto' ? kind : (KINDS.includes(detected) ? detected : 'auto');

  const { items, method, stats } = extractListItems(doc, url, {
    kind: effectiveKind,
    now,
    limit: opts.maxItems || 200,
  });

  const normalized = items.map((it) => {
    const k = effectiveKind === 'auto' ? guessKind(it) : effectiveKind;
    const fk = fileKind(it.title, it.url);
    return {
      ...it,
      section: k,
      ext: fk.ext,
      fileKind: fk.kind,
    };
  });

  return {
    kind: effectiveKind,
    detectedKind: detected,
    items: normalized,
    method,
    stats,
    nextPageUrl: findNextPage(doc, url),
    pageTitle: findPageTitle(doc),
    sections: findSectionLinks(doc, url),
    empty: normalized.length === 0,
  };
}

/**
 * 判断一个页面是不是“空列表”（没有条目但有“暂无数据”提示）
 */
export function isEmptyListPage(doc) {
  const t = squash(textOf(doc.body || doc.documentElement)).slice(0, 800);
  return /暂无数据|暂无记录|没有数据|还没有|无数据|no data/i.test(t);
}

export function summarizePage(parsed) {
  return {
    kind: parsed.kind,
    count: parsed.items.length,
    method: parsed.method,
    next: parsed.nextPageUrl ? truncate(parsed.nextPageUrl, 60) : '',
  };
}
