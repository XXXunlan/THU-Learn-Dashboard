/**
 * 通用 DOM 启发式抽取。
 *
 * 设计目标：网络学堂改版时，写死的选择器一定会失效，所以这里不赌单一选择器，
 * 而是“已知选择器优先 + 结构重复性兜底”，两者都产出候选，再按得分选最优的一组。
 * 解析结果会记录 method（命中了哪条策略），面板的“诊断”里能看到，便于定位问题。
 */

import { squash, absolutize, truncate, hashString, fileKind, parseSize } from '../common/utils.js';
import { extractDeadline, extractPublishDate, classifyStatus, findDates } from './date.js';
import { DONE_PATTERNS, PENDING_PATTERNS } from '../common/constants.js';

/** 结构上明显是导航/页眉/页脚的区域，抽取正文条目时忽略 */
const NOISE_SELECTOR = [
  'nav', 'header', 'footer', 'aside',
  '.navbar', '.nav', '.menu', '.sidebar', '.side-bar', '.breadcrumb', '.crumb',
  '.pagination', '.pager', '.page-nav', '.footer', '.header', '.top-bar', '.topbar',
  '.tabs', '.tab-nav', '.toolbar-tip', '.copyright',
  // 网络学堂自己的**导航**容器（名字来自它的前端代码）：
  //   .navlef  —— 左侧课程菜单（每门课的菜单里都列着所有课程）
  //   .droppanel —— 导航里的课程下拉面板
  //   .morebtn —— 展开按钮
  // 注意：.rtcon 是**右侧内容区外壳**，绝不能列进来 —— 把内容区当噪声会把
  // 真实列表一起过滤掉（这是被测试抓出来的）。
  '.navlef', '.droppanel', '.morebtn',
].join(',');

/**
 * 条目容器候选选择器。
 *
 * 顺序有讲究：**先站点自己的真实容器**（id 来自它的前端模板），再通用兜底。
 * 裸 `li` 与 `.row` 已被移除 —— 它们太宽，在真实页面上首先命中的永远是导航菜单。
 */
export const ITEM_SELECTOR_CANDIDATES = [
  // 站点自己的表格（公告 / 课件 / 作业 / 讨论 / 答疑 / 笔记 / 搜索页）
  '#ggalltable tbody tr', '#kjalltable tbody tr', '#zyalltable tbody tr',
  '#bbsalltable tbody tr', '#dyalltable tbody tr', '#bjalltable tbody tr',
  '#examplesearch tbody tr',
  'table.dataTable tbody tr', '.dataTable tbody tr',
  // 通用兜底
  '.homework-item', '.notice-item', '.file-item', '.gg-item', '.wj-item', '.sz-item',
  '.list-item', '.listItem', '.list_item', '.media-item', '.content-item',
  '.card', '.panel-item', '.item',
  'table tbody tr',
  'table tr',
  'ul.list > li',
  '.list > li',
  '.list-group > *',
  '[class*="-item"]',
  '[class*="list"] > *',
];

/**
 * 各板块条目的链接特征。
 *
 * 这是**比选择器可靠得多的判据**：一份真正的“作业列表”里，条目链接必然长成
 * /f/wlxt/kczy/zy/student/viewXxx 这样。如果解析出来的条目链接全都对不上，
 * 那它一定抓错了东西 —— 真实案例就是抓成了左侧课程导航。
 */
export const KIND_URL_PATTERN = {
  notice: /(\/f\/wlxt\/kcgg\/)|(\/b\/wlxt\/kcgg\/)/i,
  file: /(\/f\/wlxt\/kj\/)|(\/b\/wlxt\/kj\/)|([?&]wjid=)/i,
  homework: /(\/f\/wlxt\/kczy\/)|([?&]zyid=)|(\/b\/(?:wlxt\/kc|kc)\/)/i,
};

const BAD_ANCHOR_TEXT = /^(下载|查看|详情|更多|编辑|删除|提交|撤回|预览|附件|download|view|more|detail)$/i;
const DATE_ONLY = /^[\s\d年月日\-/.():：]*$/;

/**
 * DataTables 的“空表”占位行。
 *
 * 服务端分页没有数据时，它会在 tbody 里放一行 `<td class="dataTables_empty">没有您要搜索的内容</td>`。
 * 这一行**长得就像一条数据**（有 td、有文本），于是被当成条目收进了面板 ——
 * 用户就会看到某门课的作业里赫然写着「没有您要搜索的内容」「表中数据为空」。
 */
export const EMPTY_STATE_RE = /没有您要搜索的内容|表中数据为空|暂无数据|暂无记录|没有数据|没有相关|无数据|no\s+data\s+available|no\s+matching\s+records/i;

export function textOf(el) {
  if (!el) return '';
  return squash(el.textContent || '');
}

export function isNoise(el) {
  if (!el || el.nodeType !== 1) return false;
  if (el.closest && el.closest(NOISE_SELECTOR)) return true;
  return false;
}

function anchorsOf(el) {
  return Array.from(el.querySelectorAll ? el.querySelectorAll('a[href]') : []);
}

function isUsableHref(href) {
  if (!href) return false;
  const h = href.trim().toLowerCase();
  if (!h) return false;
  if (h.startsWith('javascript:') || h.startsWith('#') || h === 'about:blank') return false;
  return true;
}

/** 选一个“最能代表该条目”的链接：文本最长、且不是“下载/详情”这类操作词 */
export function primaryAnchor(el, baseUrl) {
  const anchors = anchorsOf(el).filter((a) => isUsableHref(a.getAttribute('href')));
  if (!anchors.length) return null;
  let best = null;
  let bestScore = -Infinity;
  for (const a of anchors) {
    const t = textOf(a);
    let score = t.length;
    if (BAD_ANCHOR_TEXT.test(t)) score -= 12;
    if (DATE_ONLY.test(t)) score -= 20;
    if (/\.(pdf|docx?|pptx?|xlsx?|zip|rar|7z|mp4|txt|md|csv)$/i.test(t)) score += 6;
    if (a.querySelector('img') && !t) score -= 5;
    if (score > bestScore) { bestScore = score; best = a; }
  }
  if (!best) return null;
  return {
    el: best,
    href: absolutize(best.getAttribute('href'), baseUrl),
    text: textOf(best),
    title: squash(best.getAttribute('title') || ''),
  };
}

/** 收集条目里全部有意义的链接，供 UI 提供“打开 / 下载” */
function collectLinks(el, baseUrl, limit = 8) {
  const seen = new Set();
  const out = [];
  for (const a of anchorsOf(el)) {
    const href = absolutize(a.getAttribute('href'), baseUrl);
    if (!isUsableHref(a.getAttribute('href')) || !href || seen.has(href)) continue;
    seen.add(href);
    out.push({ text: truncate(textOf(a), 40), href });
    if (out.length >= limit) break;
  }
  return out;
}

function looksLikeHeaderRow(el) {
  const cells = el.querySelectorAll ? el.querySelectorAll('th') : [];
  const tds = el.querySelectorAll ? el.querySelectorAll('td') : [];
  if (cells.length && !tds.length) return true;
  // DataTables 的空表占位行 / 页面上「暂无数据」这类提示，都不是数据
  if (el.querySelector && el.querySelector('.dataTables_empty, td[colspan]')) {
    const t = textOf(el);
    if (EMPTY_STATE_RE.test(t) || !anchorsOf(el).length) return true;
  }
  const t = textOf(el);
  if (EMPTY_STATE_RE.test(t) && t.length < 40) return true;
  return /^(序号|编号|名称|标题|文件名|作业|公告|操作|状态|发布时间|截止时间|附件|类型|大小)/.test(t) && t.length < 40 && !anchorsOf(el).length;
}

/**
 * 用表头定位列。
 *
 * 这一步很重要：站点列表页的表头写着「截止日期」「提交日期」，**行里只有光秃秃的日期**。
 * 如果只拿整行文本去猜，两个日期谁是截止就无从判断；有了列位置就完全确定了。
 * 顺序也有讲究——先认「截止」「提交」，剩下的才归入「发布/上传时间」，
 * 否则「提交日期」会被时间列的正则抢走。
 */
const COLUMN_RULES = [
  ['deadline', /截止/],
  ['submit', /提交日期|提交时间/],
  ['status', /状态/],
  ['date', /发布时间|发布日期|上传时间|创建时间|更新时间|时间|日期/],
  ['teacher', /批阅教师|教师/],
  ['grade', /成绩|得分/],
];

export function columnValues(el) {
  const tr = el && el.tagName === 'TR' ? el : (el && el.closest ? el.closest('tr') : null);
  if (!tr) return null;
  const table = tr.closest ? tr.closest('table') : null;
  if (!table) return null;

  let labels = Array.from(table.querySelectorAll('thead th, thead td'));
  if (!labels.length) {
    const firstRow = table.querySelector('tr');
    if (firstRow && firstRow !== tr) labels = Array.from(firstRow.children);
  }
  if (!labels.length) return null;

  const cells = Array.from(tr.children);
  const fields = {};
  const labeled = [];
  labels.forEach((labelEl, i) => {
    const label = squash(textOf(labelEl));
    if (!label || !cells[i]) return;
    const text = squash(textOf(cells[i]));
    labeled.push({ label, text });
    for (const [field, re] of COLUMN_RULES) {
      if (fields[field] === undefined && re.test(label)) {
        fields[field] = text;
        break;
      }
    }
  });
  if (!labeled.length) return null;
  return { fields, labeled };
}

/** 这些列里的日期都不是「截止」——用于在表头对不齐时排除干扰列 */
const NON_DEADLINE_COLUMN = /批阅|提交|发布|上传|创建|更新|生效|成绩|教师|状态/;

/**
 * 把单个候选元素转成条目。kind: 'notice' | 'file' | 'homework' | 'auto'
 */
export function buildItem(el, baseUrl, kind = 'auto', now = Date.now()) {
  if (!el || el.nodeType !== 1) return null;
  const anchor = primaryAnchor(el, baseUrl);
  let title = anchor ? (anchor.text || anchor.title) : '';
  if (!title) {
    const head = el.querySelector('h1,h2,h3,h4,h5,.title,[class*="title"],[class*="name"]');
    title = head ? textOf(head) : '';
  }
  if (!title) {
    const clone = el.cloneNode(true);
    for (const junk of clone.querySelectorAll('script,style')) junk.remove();
    title = textOf(clone).split(/[\n·|]/)[0] || '';
  }
  title = squash(title);
  const fullText = textOf(el);
  if (!title) title = truncate(fullText, 60);
  if (!title || title.length < 2) return null;
  if (looksLikeHeaderRow(el)) return null;
  // 标题整个就是「下载 / 详情」这类操作词 → 它是个按钮，不是一条数据
  if (BAD_ANCHOR_TEXT.test(title)) return null;
  // 「没有您要搜索的内容」这类 DataTables 空表占位，也不是数据
  if (EMPTY_STATE_RE.test(title)) return null;

  const href = anchor ? anchor.href : (collectLinks(el, baseUrl)[0] || {}).href || '';
  const cols = columnValues(el);

  // 有表头就用列位置定位，没有才退回整行文本。
  // 行里的「提交日期」和「截止日期」长得一样，只有列位置能区分开。
  let date = extractPublishDate(fullText, now);
  if (cols && cols.fields.date) date = extractPublishDate(cols.fields.date, now) || date;

  // 只有作业才谈得上截止时间；给文件/公告算一个「截止」是纯粹的噪声
  let deadlineInfo = kind === 'homework' ? extractDeadline(fullText, now) : { deadline: null, reason: 'n/a' };
  if (kind === 'homework' && cols) {
    if (cols.fields.deadline) {
      // 最可靠：表头写着「截止日期」的那一列
      const fromCol = extractDeadline(cols.fields.deadline, now);
      if (fromCol.deadline) deadlineInfo = { deadline: fromCol.deadline, reason: 'column:截止' };
    }
    if (deadlineInfo.reason !== 'column:截止') {
      // 表头对不齐时（行里字段顺序被打乱）退一步：按列名排除掉「提交/批阅/发布」这些
      // 明确不是截止的列，剩下唯一一个含日期的列就是截止时间
      const candidates = cols.labeled.filter((c) => !NON_DEADLINE_COLUMN.test(c.label) && findDates(c.text, now).length);
      if (candidates.length === 1) {
        const only = extractDeadline(candidates[0].text, now);
        if (only.deadline) deadlineInfo = { deadline: only.deadline, reason: `column-excluded:${candidates[0].label}` };
      }
    }
  }

  const statusText = (cols && cols.fields.status) ? `${fullText} ${cols.fields.status}` : fullText;
  const status = classifyStatus(statusText, { done: DONE_PATTERNS, pending: PENDING_PATTERNS });
  const links = collectLinks(el, baseUrl);
  const dl = links.find((l) => /下载|附件|download/i.test(l.text)) || null;

  const { ext, kind: fkind } = fileKind(title, href);

  return {
    id: hashString(`${title}|${href}`),
    title,
    url: href,
    links,
    downloadUrl: dl ? dl.href : '',
    date,
    deadline: deadlineInfo.deadline || null,
    deadlineReason: deadlineInfo.reason,
    deadlineInferred: String(deadlineInfo.reason || '').startsWith('inferred'),
    size: kind === 'file' ? parseSize(fullText) : null,
    ext,
    fileKind: fkind,
    status: status.status,
    statusEvidence: status.evidence,
    columns: cols || undefined,
    text: truncate(fullText, 400),
    source: 'dom',
  };
}

/** 结构签名：同一种列表里的兄弟节点签名相同 */
function signature(el) {
  const cls = (el.getAttribute && el.getAttribute('class')) || '';
  const main = cls.split(/\s+/).filter(Boolean).slice(0, 2).join('.');
  let depth = 0;
  let p = el.parentElement;
  while (p && depth < 60) { depth++; p = p.parentElement; }
  return `${el.tagName.toLowerCase()}.${main}@${depth}`;
}

/**
 * 兜底策略：找出“一族结构相同、且带链接的兄弟节点”里最像列表的一组。
 */
export function findRepeatedGroups(doc) {
  const all = Array.from(doc.body ? doc.body.querySelectorAll('*') : []);
  const groups = new Map();
  for (const el of all) {
    if (el.tagName === 'A' || el.tagName === 'SCRIPT' || el.tagName === 'STYLE') continue;
    if (el.querySelectorAll('a[href]').length === 0) continue;
    if (isNoise(el)) continue;
    const parent = el.parentElement;
    if (!parent) continue;
    const key = `${signature(el)}#${signature(parent)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(el);
  }
  const scored = [];
  for (const [key, els] of groups) {
    if (els.length < 2) continue;
    // 同一组里不应互相嵌套
    const flat = els.filter((e) => !els.some((o) => o !== e && o.contains(e)));
    if (flat.length < 2) continue;
    const withDate = flat.filter((e) => extractPublishDate(textOf(e))).length;
    const withAnchor = flat.filter((e) => primaryAnchor(e, 'https://x/')).length;
    const avgLen = flat.reduce((s, e) => s + textOf(e).length, 0) / flat.length;
    if (avgLen < 6 || avgLen > 1200) continue;
    const score = flat.length * (0.5 + withAnchor / flat.length) * (1 + (withDate / flat.length) * 0.8);
    scored.push({ key, elements: flat, score });
  }
  return scored.sort((a, b) => b.score - a.score);
}

/**
 * 把所有命中的候选选择器**都**返回，而不是只返回第一个。
 *
 * 原因：光看选择器无法判断“这组元素到底是不是本板块的列表”—— 那要靠链接特征
 * （见 KIND_URL_PATTERN）。所以这里把候选全部交出去，由 extractListItems 逐个打分，
 * 让“选错容器”有被纠正的机会，而不是第一个 ≥2 条的选择器就直接定终身。
 */
function pickAllBySelectors(doc, selectors, maxGroups = 8) {
  const groups = [];
  for (const sel of selectors) {
    let nodes;
    try { nodes = Array.from(doc.querySelectorAll(sel)); } catch { continue; }
    const usable = nodes.filter((el) => !isNoise(el) && !looksLikeHeaderRow(el));
    if (usable.length >= 1) groups.push({ selector: sel, elements: usable });
    if (groups.length >= maxGroups) break;
  }
  return groups;
}

/**
 * 抽取列表页条目。返回 {items, method, stats}
 * method 会写进诊断信息，方便判断是选择器命中还是兜底。
 *
 * 选哪一组候选不能只看条目数：`findRepeatedGroups` 会把「同一行里各自带链接的兄弟
 * <td>」也当成一族，一行两个链接就让条目数翻倍，反而盖过正确的 `table tbody tr`。
 * 所以改用「数量 × 质量比」打分 —— 质量比是有实质标题（≥4 字、不是“下载/详情”这类
 * 操作词）的条目占比，垃圾条目的组会被自然压下去。
 */
export function extractListItems(doc, baseUrl, { kind = 'auto', now = Date.now(), limit = 200 } = {}) {
  const attempts = [];
  const pattern = KIND_URL_PATTERN[kind];
  /** 标题像不像真数据（≥4 字、不是“下载/详情”这类操作词） */
  const quality = (items) => {
    if (!items.length) return 0;
    const good = items.filter((it) => it.title && it.title.length >= 4 && !BAD_ANCHOR_TEXT.test(it.title)).length;
    return good / items.length;
  };
  /** 链接像不像这个板块该有的链接 */
  const matchRatio = (items) => {
    if (!pattern || !items.length) return 1;
    const withUrl = items.filter((it) => it.url);
    if (!withUrl.length) return 0;
    return withUrl.filter((it) => pattern.test(it.url)).length / withUrl.length;
  };
  const push = (method, items) => {
    if (!items.length) return;
    const ratio = matchRatio(items);
    // 链接特征完全对不上 → 这不是本板块的列表，直接丢弃（不要靠数量把它抬上来）
    if (pattern && ratio === 0) return;
    attempts.push({ method, count: items.length, items, ratio, score: items.length * (0.35 + quality(items)) * (0.2 + ratio) });
  };

  for (const group of pickAllBySelectors(doc, ITEM_SELECTOR_CANDIDATES)) {
    push(`selector:${group.selector}`, group.elements.map((el) => buildItem(el, baseUrl, kind, now)).filter(Boolean));
  }

  for (const g of findRepeatedGroups(doc).slice(0, 3)) {
    push(`repeated:${g.key}`, g.elements.map((el) => buildItem(el, baseUrl, kind, now)).filter(Boolean));
  }

  const best = attempts.slice().sort((a, b) => b.score - a.score)[0];

  if (!best) {
    return {
      items: [],
      method: 'none',
      stats: { attempts: attempts.map((a) => `${a.method}=${a.count}`), rejected: '所有候选的链接特征都对不上本板块' },
    };
  }

  // 同一条目可能被抓到两次（容器嵌套），按 url+title 去重
  const seen = new Set();
  const items = [];
  for (const it of best.items) {
    const key = `${it.url}::${it.title}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(it);
    if (items.length >= limit) break;
  }

  return {
    items,
    method: best.method,
    stats: {
      attempts: attempts.map((a) => `${a.method}=${a.count}(score ${a.score.toFixed(1)})`),
      chosen: best.count,
    },
  };
}

/**
 * 在一张页面里找导航链接（公告 / 文件 / 作业 的入口）。
 * 返回 {notice, file, homework} 三个绝对 URL（找不到就是空串）。
 */
export function findSectionLinks(doc, baseUrl) {
  const RULES = [
    ['notice', /公告|通知|announcement|notice/i],
    ['file', /文件|课件|资源|资料|下载|file|resource|material/i],
    ['homework', /作业|实验|习题|homework|assignment|exercise/i],
  ];
  const out = { notice: '', file: '', homework: '' };
  const anchors = Array.from(doc.querySelectorAll('a[href]'));
  for (const [key, re] of RULES) {
    const hits = anchors.filter((a) => {
      if (!isUsableHref(a.getAttribute('href'))) return false;
      const t = textOf(a) || squash(a.getAttribute('title') || '');
      return t && t.length <= 24 && re.test(t);
    });
    if (hits.length) {
      // 取文本最短的那个：“作业”优于“我的作业列表及成绩”
      hits.sort((a, b) => textOf(a).length - textOf(b).length);
      out[key] = absolutize(hits[0].getAttribute('href'), baseUrl);
    }
  }
  return out;
}

/**
 * 找站点自己的“退出登录”链接 —— 同样不写死接口，让它自己告诉我们。
 */
export function findLogoutUrl(doc, baseUrl) {
  const anchors = Array.from(doc.querySelectorAll('a[href]'));
  for (const a of anchors) {
    const t = textOf(a);
    if (/^(退出|退出登录|注销|登出|安全退出|logout|sign\s*out)$/i.test(t)) {
      const href = absolutize(a.getAttribute('href'), baseUrl);
      if (href && !/^javascript:/i.test(href)) return href;
    }
  }
  return '';
}

/** 页面自述身份：返回 'login' | 'course-list' | 'notice' | 'file' | 'homework' | 'unknown' */
export function detectPageKind(doc, url) {
  const u = String(url || '').toLowerCase();
  const hasPassword = !!doc.querySelector('input[type="password"]');
  if (hasPassword && /(login|sso|auth|passport)/.test(u)) return 'login';
  if (hasPassword && /登录|用户名|密码/.test(textOf(doc.body || doc.documentElement)).slice(0, 600)) return 'login';

  // URL 分支必须覆盖站点真实路径：公告在 /f/wlxt/kcgg/、文件在 /f/wlxt/kj/、
  // 作业在 /f/wlxt/kczy/zy/ —— 只写 gg/notice 是匹配不到真实地址的
  if (/\/f\/wlxt\/(kcgg|gg)\b/.test(u)) return 'notice';
  if (/\/f\/wlxt\/(kj|wj|file)\b/.test(u)) return 'file';
  if (/\/f\/wlxt\/(kczy|sz|homework|zy)\b/.test(u)) return 'homework';
  if (/\/f\/wlxt\/index\/course\/student\b/.test(u)) return 'course-list';

  // 文本兜底：先用「截止」这类只有作业才有的强特征，再退到类别词；
  // 否则作业列表页只要导航里出现「公告」就会被误判成 notice
  const t = textOf(doc.body || doc.documentElement).slice(0, 600);
  if (/截止|提交作业|作业题目|未提交|已提交/.test(t)) return 'homework';
  if (/上传时间|文件大小|课件|下载/.test(t)) return 'file';
  if (/公告|通知/.test(t)) return 'notice';
  return 'unknown';
}
