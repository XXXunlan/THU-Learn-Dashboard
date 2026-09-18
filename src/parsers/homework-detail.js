/**
 * 作业详情页解析：抽出「作业说明」与「作业附件」。
 *
 * 背景：作业列表接口（zyListWj / zyListYjwg / zyListYpg）返回的是表格行，
 * 按站点自己的列定义，里面**只有标题、状态、截止时间、成绩**这些字段，
 * 没有作业说明，也没有附件清单 —— 那两样在详情页上。
 *
 * 详情页（viewZy / viewTj / viewCj）是服务端渲染的 JSP，所以可以直接抓 HTML 再解析，
 * 不需要开标签页。
 *
 * 解析原则：**按页面上的标签文字去找，而不是赌 class 名**。
 * 找不到就返回空 —— 面板不显示，也绝不编造内容。
 */

import { textOf, textOfExcluding } from './dom-text.js';
import { squash, truncate, absolutize, fileKind } from '../common/utils.js';

/** 作业说明的标签文字 */
const DESC_LABELS = ['作业说明', '作业内容', '作业要求', '题目要求', '作业题目要求', '内容要求', '任务说明', '实验要求', '说明'];
/** 附件区域的标签文字 */
const ATTACH_LABELS = ['作业附件', '附件', '相关附件', '参考附件', '附件下载'];
/**
 * 说明文本的**结束边界**。
 *
 * 详情页是一串字段排下来的（作业题目 / 截止时间 / 作业说明 / … / 作业附件），
 * 只从「作业说明」往后一路收，会把附件区乃至批阅、成绩一起吞进说明里。
 *
 * 但边界词本身也会出现在正常行文里（「…，提交 PDF。」「只有说明没有附件。」），
 * 所以**两种判据分开**：
 *   - 元素判据：某个短元素的文字以边界词开头（说明它是标签，不是句子）
 *   - 文本判据：边界词后面紧跟冒号（`作业附件：`），那才是字段标签
 * 直接按词出现就切会把正文切碎 —— 这是被测试抓出来的。
 */
const DESC_STOP_LABELS = [...ATTACH_LABELS, '批阅', '成绩', '提交', '操作', '教师评语', '评语', '返回'];
/** 明显不是正文的容器 */
const NOISE = 'script,style,nav,header,footer,.nav,.menu,.navlef,.droppanel,.breadcrumb,.pagination,.footer,.header,.tabs,.tab-nav';

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 这个元素自身是不是某个边界**标签**（短、且以边界词开头） */
function isStopLabel(el, stopLabels) {
  if (!el || el.nodeType !== 1) return false;
  const t = textOf(el);
  if (!t || t.length > 8) return false;   // 长文本是句子，不是标签
  return stopLabels.some((label) => t.startsWith(label));
}

/** 把一段文本在第一个「边界词 + 冒号」处截断（字段标签形态才切） */
function cutAtStopLabel(text, stopLabels) {
  const out = String(text || '');
  let cut = out.length;
  for (const label of stopLabels) {
    const m = out.match(new RegExp(`${escapeRe(label)}\\s*[:：]`));
    if (m && m.index < cut) cut = m.index;
  }
  return out.slice(0, cut);
}

/**
 * 取元素的文本，但**保留块级元素之间的换行**。
 *
 * 作业说明里大量使用 `<p>` / `<ol><li>` / `<br>`，如果像 textContent 那样全部拼成一行，
 * 面板上两行截断出来的就是一团读不通的文字。保留换行后，前两行才有意义，
 * 悬停展开的全文也可读。
 */
const BLOCK_TAGS = new Set([
  'P', 'DIV', 'LI', 'UL', 'OL', 'TR', 'TD', 'TH', 'SECTION', 'ARTICLE',
  'TABLE', 'DT', 'DD', 'PRE', 'BLOCKQUOTE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
]);

function textWithBreaks(el) {
  if (!el) return '';
  const parts = [];
  const walk = (node) => {
    if (node.nodeType === 3) { parts.push(node.textContent || ''); return; }
    if (node.nodeType !== 1) return;
    const tag = node.tagName;
    if (tag === 'SCRIPT' || tag === 'STYLE') return;
    if (tag === 'BR') { parts.push('\n'); return; }
    const block = BLOCK_TAGS.has(tag);
    if (block) parts.push('\n');
    for (const child of node.childNodes) walk(child);
    if (block) parts.push('\n');
  };
  walk(el);
  return normalizeDesc(parts.join(''));
}

/** 折叠空白但**保留换行**（连续换行压成一个，面板是紧凑列表，空行只是浪费行高） */
function normalizeDesc(text) {
  return String(text || '')
    .replace(/[\u00a0\u2000-\u200b\u3000]/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n+/g, '\n')
    .trim();
}

/** 从某个标签元素往后，收集它所在容器里「标签之后、下一个边界标签之前」的文本 */
function textAfterLabel(labelEl, stopLabels = []) {
  const parts = [];
  let node = labelEl.nextSibling;
  while (node) {
    if (isStopLabel(node, stopLabels)) break;   // 撞到「作业附件」就停
    const t = node.nodeType === 1 ? textWithBreaks(node) : (node.textContent || '');
    if (t && t.trim()) {
      // 同一个节点里也可能写着「说明… 作业附件…」，同样要截断
      parts.push(cutAtStopLabel(t, stopLabels));
    }
    node = node.nextSibling;
  }
  // 标签本身就在容器里、后面没有兄弟节点时，退到「容器整体文本减去标签」
  if (!parts.filter((x) => x.trim()).length && labelEl.parentElement) {
    const whole = textWithBreaks(labelEl.parentElement);
    const label = textOf(labelEl);
    if (whole && whole !== label) parts.push(cutAtStopLabel(whole.replace(label, '').trim(), stopLabels));
  }
  return normalizeDesc(parts.join('\n'));
}

/**
 * 说明里不该出现的「其它字段名」。
 * 要求它是**开头的一个独立词**（后面跟冒号或空白），这样
 * 「作业标题 第一次作业」会被认出来，而「作业附件里的模板请自行下载」这种正文不会。
 */
const OTHER_FIELD_RE = /^(作业标题|作业说明|作业附件|答案说明|答案附件|截止时间|发布对象|完成方式|批阅教师|成绩)(?:\s*[:：]|\s|$)/;
/** 区块标题（实测两种写法都出现过）——它们不是字段标签，是包着所有字段的小标题 */
const SECTION_HEADER_RE = /^(作业内容及要求|作业要求及内容|作业内容与要求|作业内容与要求说明)\s*[:：]?/;

/**
 * 按标签文字找一段内容。
 *
 * 两级匹配，语义很明确：**只要「作业说明」这个字段的内容**。
 *
 * 1) 精确匹配：元素文字**就是**标签（真实页面是 `<div class="left">作业说明</div>`）。
 *    找到就返回；**内容为空也直接返回空** —— 那说明这个字段本来就是空的，
 *    绝不能因此退到别的字段去抓（真出过这个 bug：作业说明为空时，
 *    区块标题「作业要求及内容：」被当成标签，把整页内容都当成说明了）。
 *
 * 2) 宽松匹配：标签与内容写在一起（`作业说明：xxx`）。此时**标签后面必须紧跟
 *    冒号或空白** —— 「作业要求及内容：」这种区块标题，`作业要求` 后面是「及」，
 *    直接排除掉，否则就会被误当成标签。
 */
function findByLabels(doc, labels, stopLabels = []) {
  const all = Array.from(doc.querySelectorAll('td,th,dt,dd,label,span,div,p,strong,b,h1,h2,h3,h4,h5,li'));

  for (const label of labels) {
    // 文字恰好等于标签的元素可能有多个（包着它的容器在内容为空时也会等于标签），
    // **必须取最“小”的那个** —— 否则会从父容器的位置开始取，把后面的字段全吞进来。
    const exacts = all.filter((el) => textOf(el) === label);
    if (exacts.length) {
      exacts.sort((a, b) => (a.children ? a.children.length : 0) - (b.children ? b.children.length : 0));
      const exact = exacts[0];
      const text = textAfterLabel(exact, stopLabels);
      // 找到了字段：有内容就用，没内容就认它是空的（不再去找别的字段）
      return { text, label, empty: !text, matched: exacts.length };
    }
  }

  for (const label of labels) {
    const loose = all.find((el) => {
      const t = textOf(el);
      if (!t.startsWith(label)) return false;
      const rest = t.slice(label.length);
      if (!/^[\s:：]/.test(rest)) return false;      // 后面不是冒号/空白 → 是区块标题，不是字段标签
      if (rest.replace(/^[\s:：]+/, '').length < 2) return false;
      if (t.length > 20000) return false;
      return true;
    });
    if (loose) {
      const t = squash(textOfExcluding(loose, NOISE));
      const rest = normalizeDesc(cutAtStopLabel(t.slice(label.length), stopLabels).replace(/^[:：\s]+/, ''));
      if (rest) return { text: rest, label };
    }
  }
  return null;
}

/**
 * 抓到的是「字段之上的容器」吗？
 *
 * **只看开头**，而且要求那里确实是一个字段标签或区块标题。
 * 不能按全文去数「作业附件」「截止时间」这些词 —— 正文里正常提到它们太常见了
 * （「请从本窗口作业附件中下载模板」「截止时间：9月22日」），那样会把正常说明误杀。
 */
export function looksLikeContainer(description) {
  const head = String(description || '').trimStart().slice(0, 60);
  if (!head) return false;
  if (SECTION_HEADER_RE.test(head)) return true;      // 「作业内容及要求：…」
  if (OTHER_FIELD_RE.test(head)) return true;         // 「作业标题：…」
  return false;
}

/** 从链接里抠出「这是哪个文件」的标识，用于合并同一条附件的多个链接 */
function attachmentKey(href) {
  try {
    const u = new URL(href, 'https://learn.tsinghua.edu.cn');
    const p = (k) => u.searchParams.get(k) || u.searchParams.get(k.toUpperCase()) || '';
    const byParam = p('fileId') || p('wjid') || p('fjid') || p('fileid');
    if (byParam) return byParam;
    // downloadFile/<wlkcid>/<fileid> 形态
    const m = u.pathname.match(/downloadfile\/([^/]+)\/([^/]+)/i);
    if (m) return m[2];
  } catch { /* 解析不了就退化成用整条 URL 当 key */ }
  return href;
}

/** 取「真正能直接下载」的地址：openNewWindow 会把真实下载地址放在 downloadUrl 参数里 */
function directDownloadUrl(href) {
  try {
    const u = new URL(href, 'https://learn.tsinghua.edu.cn');
    const embedded = u.searchParams.get('downloadUrl') || u.searchParams.get('downloadurl');
    if (embedded) return absolutize(decodeURIComponent(embedded), 'https://learn.tsinghua.edu.cn');
    if (/downloadfile|download/i.test(u.pathname)) return u.href;
  } catch { /* ignore */ }
  return '';
}

const GENERIC_NAME = /^(下载|附件|查看|预览|下载附件|查看附件|下载文件|打开)$/;

/**
 * 收集附件。
 *
 * 判据（任一成立即算附件）：链接里带 downloadFile / wjid / fileId / attachment，
 * 或链接文字像文件名。同一个文件的「文件名链接」和「下载按钮」会被**合并成一条**
 * —— 真实页面上一个附件往往有两个链接，不合并就会显示成两个附件。
 */
export function collectAttachments(doc, baseUrl) {
  const byKey = new Map();
  for (const a of doc.querySelectorAll('a[href]')) {
    const raw = a.getAttribute('href') || '';
    if (!raw || /^javascript:/i.test(raw) || raw === '#') continue;
    const href = absolutize(raw, baseUrl);
    if (!href) continue;

    const text = squash(textOf(a) || a.getAttribute('title') || '');
    const looksFile = /\.(pdf|docx?|pptx?|xlsx?|zip|rar|7z|txt|md|csv|png|jpe?g|gif|mp4|py|cpp|c|java|ipynb|m|r|tex)$/i.test(text);
    const isDownloadApi = /downloadfile|opennewwindow|[?&](wjid|fjid|fileid|fileId)=/i.test(href);
    if (!looksFile && !isDownloadApi) continue;
    if (!text && !isDownloadApi) continue;

    const key = attachmentKey(href);
    const direct = directDownloadUrl(href);
    const prev = byKey.get(key);
    const isGeneric = GENERIC_NAME.test(text);

    if (!prev) {
      byKey.set(key, {
        name: isGeneric ? '' : text,
        url: direct || href,
        altUrl: direct ? href : '',
        ext: '', kind: 'file',
        genericName: isGeneric,
      });
    } else {
      // 同一条附件：优先保留「像文件名」的名字，以及「能直接下载」的地址
      if ((!prev.name || prev.genericName) && !isGeneric) { prev.name = text; prev.genericName = false; }
      if (direct && !/downloadfile/i.test(prev.url)) { prev.altUrl = prev.url; prev.url = direct; }
    }
  }

  const out = [];
  for (const item of byKey.values()) {
    const name = item.name || item.altUrl || item.url;
    if (!name) continue;
    const fk = fileKind(name, item.url);
    out.push({ name, url: item.url, ext: fk.ext, kind: fk.kind });
  }
  return out;
}

/**
 * 兜底：正文里最长的一段文本（用于页面没有「作业说明」标签的情况）。
 * 同样会在「作业附件」这类边界处截断，避免把附件区的东西当说明。
 */
function longestBodyText(doc, stopLabels = []) {
  const candidates = Array.from(doc.querySelectorAll('div,td,section,article,p'))
    .filter((el) => !el.closest(NOISE))
    .map((el) => ({ el, t: normalizeDesc(cutAtStopLabel(textWithBreaks(el), stopLabels)) }))
    .filter(({ t }) => t.length >= 12 && t.length <= 4000)
    .filter(({ t }) => !/^(首页|课程列表|公告|文件|作业|讨论|答疑|问卷|退出|登录)$/.test(t));
  if (!candidates.length) return '';
  candidates.sort((a, b) => b.t.length - a.t.length);
  return candidates[0].t;
}

/**
 * @param {Document} doc 详情页 HTML
 * @param {string} url    该页真实地址
 * @returns {{description:string, descriptionSource:string, attachments:Array, title:string}}
 */
export function parseHomeworkDetail(doc, url) {
  // 只取「作业说明」这个字段的内容
  const desc = findByLabels(doc, DESC_LABELS, DESC_STOP_LABELS);
  let description = '';
  let descriptionSource = '';

  if (desc && !desc.empty) {
    description = desc.text.slice(0, 4000);
    descriptionSource = `label:${desc.label}`;
  } else if (desc && desc.empty) {
    // 字段存在但内容为空：这是「这门作业没写说明」，不是「换个字段去找」
    descriptionSource = `empty:${desc.label}`;
  } else {
    // 页面上根本没有「作业说明」这个字段，才退到正文里最长的一段
    const body = longestBodyText(doc, DESC_STOP_LABELS);
    if (body) { description = body.slice(0, 4000); descriptionSource = 'longest-block'; }
  }

  // 兜底抓到的可能是「字段之上的容器」（开头就是别的字段名）—— 那宁可不要
  if (description && looksLikeContainer(description)) {
    description = '';
    descriptionSource = `${descriptionSource}:rejected-container`;
  }

  const attachments = collectAttachments(doc, url);

  const heading = doc.querySelector('h1,h2,h3,.title,[class*="title"]');
  return {
    description: normalizeDesc(description),
    descriptionSource,
    attachments,
    title: heading ? squash(textOf(heading)).slice(0, 200) : '',
  };
}

export { DESC_LABELS, ATTACH_LABELS, DESC_STOP_LABELS };
