/**
 * 网络学堂面板的测试入口：`node tests/run.mjs`（等价于 `npm test`）
 *
 * 只测“纯逻辑 + DOM 解析”那一层（parsers / api / common），
 * 依赖浏览器 API 的 background / dashboard / content 不在范围内。
 * DOM 那部分靠 tests/minidom.mjs（零依赖的极简 DOM）在 Node 里跑起来。
 *
 * 三条约定：
 *  1) 所有涉及“现在”的断言都显式传入固定的 now，永不依赖墙上时钟（UTC / America/New_York 下同样通过）；
 *  2) 输入全部来自 tests/fixtures/*.html，fixture 按站点真实形状写；
 *  3) 发现源码里可疑/明显出错的地方**不改源码**：能刻划成断言的放进最后一组
 *     “已知缺陷”，不好钉死的用 warn() 记下来，最后统一打印。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { parseHTML, decodeEntities } from './minidom.mjs';

import { parseDate, findDates, extractDeadline, extractPublishDate, classifyStatus } from '../src/parsers/date.js';
import { textOf, textOfSafe, textOfExcluding, attr } from '../src/parsers/dom-text.js';
import {
  extractListItems, buildItem, primaryAnchor, findSectionLinks, detectPageKind,
  findLogoutUrl, findRepeatedGroups,
} from '../src/parsers/heuristics.js';
import { parseSectionPage, findNextPage, findPageTitle, guessKind, isEmptyListPage } from '../src/parsers/list-page.js';
import { extractCourses, extractMeta, extractCoursesFromHtml } from '../src/parsers/course-list.js';
import { analyzeLoginForm, looksLoggedIn, pickLoginUrl } from '../src/parsers/login-form.js';
import {
  normalizeCourse, normalizeNotice, normalizeFile, normalizeHomework, toTime, pickSemester,
  idsFromHomeworkUrl, fromDomItem, fromScrapedItem,
} from '../src/api/normalize.js';
import { PAGE, API, homeworkUrl, guessSemester, abs, ORIGIN, FILE_CATEGORY_COLUMNS, extractSemester, neighborSemesters } from '../src/api/endpoints.js';
import { decideSession, classifyPageHtml } from '../src/background/auth.js';
import { retargetRequest, retargetConditionJson, pickTemplates, retargetBody, columnsFromTemplate, rowsFromArrays } from '../src/api/learned.js';
import { extractRowsDetailed } from '../src/api/client.js';
import { slimHtml, outline, summarizeRequests } from '../src/background/probe.js';
import { isSectionFailure } from '../src/background/crawler.js';
import { parseHomeworkDetail, looksLikeContainer } from '../src/parsers/homework-detail.js';
import { needsRenderedRetry, freshEntry } from '../src/background/enrich.js';
import { snapshotViaTab } from '../src/background/tab-scraper.js';
import { groupEndpoints, learnedHeaders } from '../src/background/yuketang.js';
import {
  yktTime, yktUrl, isYuketangUrl, pickClassroomList, normalizeYktClassroom,
  classroomIdsFromRecords, classroomIdsFromHtml, homeworkFromChapter,
  completionFromSchedule, courseKey, matchLearnCourse, toYktHomework, mergeYuketang,
  classroomListCandidates, LEAF_TYPE_HOMEWORK, YKT_COURSES_LIST_URL, apiError, leafTypeHistogram,
  harvestedCourseData,
} from '../src/parsers/yuketang.js';
import { squash, absolutize, fileKind, parseSize, hashString, truncate, extractCourseKey } from '../src/common/utils.js';
import { DONE_PATTERNS, PENDING_PATTERNS, DEFAULT_SETTINGS } from '../src/common/constants.js';

/* ------------------------------------------------------------ 断言框架 */

let current = null;
const sections = [];
const warnings = [];
let totalAssertions = 0;

function section(name, fn) {
  current = { name, passed: 0, failed: 0, messages: [] };
  sections.push(current);
  try {
    fn();
  } catch (err) {
    current.failed++;
    current.messages.push(`本组测试抛异常：${err && err.message ? err.message : String(err)}`);
  }
}

function ok(cond, msg) {
  totalAssertions++;
  if (cond) { current.passed++; return true; }
  current.failed++;
  current.messages.push(msg);
  return false;
}

function show(v) {
  if (v === undefined) return 'undefined';
  if (v === null) return 'null';
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try { return JSON.stringify(v); } catch { return String(v); }
}

function eq(actual, expected, msg) {
  return ok(Object.is(actual, expected), `${msg} —— 期望 ${show(expected)}，实际 ${show(actual)}`);
}

function deepEq(actual, expected, msg) {
  return ok(JSON.stringify(actual) === JSON.stringify(expected),
    `${msg} —— 期望 ${show(expected)}，实际 ${show(actual)}`);
}

function throws(fn, re, msg) {
  let err = null;
  try { fn(); } catch (e) { err = e; }
  return ok(err !== null && re.test(String(err.message)),
    `${msg} —— 期望抛出匹配 ${re} 的错误，实际 ${err ? `抛出 ${show(err.message)}` : '没有抛错'}`);
}

function warn(msg) {
  warnings.push(msg);
}

/* -------------------------------------------------------------- 工具 */

const FIXTURES = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => readFileSync(path.join(FIXTURES, 'fixtures', name), 'utf8');

/** 本地时间的 epoch 毫秒（与 date.js 的 mk() 一致，避免时区差异） */
const at = (y, mo, d, h = 0, mi = 0, s = 0) => new Date(y, mo - 1, d, h, mi, s, 0).getTime();

/** 固定“现在”，所有时间断言都基于它 */
const NOW = at(2026, 9, 15, 12, 0);        // 2026-09-15 12:00
const NOW_HW = at(2026, 10, 5, 12, 0);     // 2026-10-05 12:00

const W = '2026-2027-1000000001';
const COURSE_LIST_URL = `${ORIGIN}/f/wlxt/index/course/student/`;
const NOTICE_URL = `${ORIGIN}/f/wlxt/kcgg/wlkc_ggb/student/beforePageListXs?wlkcid=${W}&sfgk=0`;
const FILE_URL = `${ORIGIN}/f/wlxt/kj/wlkc_kjxxb/student/beforePageList?wlkcid=${W}&sfgk=0`;
const HW_URL = `${ORIGIN}/f/wlxt/kczy/zy/student/beforePageList?wlkcid=${W}`;
const LOGIN_URL = `${ORIGIN}/f/login`;
const IAAA_URL = 'https://id.tsinghua.edu.cn/do/off/ui/auth/login/for/learn';

const byTitle = (items, title) => items.find((i) => i.title === title);

/* ============================================================ 1. minidom 自检 */

section('minidom：隐式 tbody 与表格结构', () => {
  const doc = parseHTML('<table><tr><td>x</td></tr><tr><td>y</td></tr></table>');
  const table = doc.querySelector('table');
  ok(table !== null, 'table 能被解析出来');
  eq(table.children.length, 1, '真实浏览器会把 <tr> 放进隐式 <tbody>：table 的直接元素子节点只有 tbody');
  eq(table.children[0].tagName, 'TBODY', '隐式创建的 tbody 是 TABLE 的唯一元素子节点');
  eq(doc.querySelectorAll('table tbody tr').length, 2, 'table tbody tr 能找到隐式 tbody 里的行');
  eq(doc.querySelectorAll('table tr').length, 2, 'table tr 同样能找到（两个选择器都必须可用）');
  eq(doc.querySelectorAll('table > tr').length, 0, 'table > tr 不存在，与真实浏览器一致');
  eq(doc.querySelectorAll('table > tbody > tr').length, 2, 'table > tbody > tr 命中');

  const explicit = parseHTML('<table><thead><tr><th>h</th></tr></thead><tbody><tr><td>d</td></tr></tbody></table>');
  eq(explicit.querySelectorAll('thead tr').length, 1, '显式 thead 不被改写成 tbody');
  eq(explicit.querySelectorAll('tbody tr').length, 1, '显式 tbody 里的行仍能被找到');
});

section('minidom：raw text / RCDATA / 注释 / void 元素', () => {
  const doc = parseHTML('<div><script>var a = "<div id=evil>ev</div>";</script><style>.x{color:red}</style></div>');
  eq(doc.querySelectorAll('div').length, 1, 'script 里的 <div> 不能被当成元素解析');
  eq(doc.querySelectorAll('#evil').length, 0, 'script 里的 id=evil 不能出现在 DOM 里');
  eq(doc.querySelector('script').textContent, 'var a = "<div id=evil>ev</div>";',
    'script 是 raw text：textContent 原样保留、不解码实体');
  eq(doc.querySelector('style').textContent, '.x{color:red}', 'style 同样是 raw text');

  const ta = parseHTML('<textarea rows="3"><b>x</b></textarea>');
  eq(ta.querySelectorAll('b').length, 0, 'textarea 内部不解析标签');
  eq(ta.querySelector('textarea').textContent, '<b>x</b>', 'textarea 是 RCDATA：内容原样保留');
  eq(ta.querySelector('textarea').getAttribute('rows'), '3', 'RCDATA 元素自己的属性照常解析');

  const ti = parseHTML('<title>a &amp; b</title>');
  eq(ti.querySelector('title').textContent, 'a & b', 'title 是 RCDATA：不当标记解析，但要解码实体');

  const com = parseHTML('<div><!-- <span>不要</span> --><span>要</span></div>');
  eq(com.querySelectorAll('span').length, 1, '<!-- --> 里的内容被忽略，只剩 1 个 span');
  eq(com.querySelector('div').textContent, '要', '注释不影响 textContent');

  const v = parseHTML('<div>a<br>b<img src="x.png">c<input type="hidden" value="1">d<hr>e</div>');
  const div = v.querySelector('div');
  eq(div.children.map((e) => e.tagName).join(','), 'BR,IMG,INPUT,HR', 'void 元素不会被后面的兄弟节点吞掉');
  eq(div.textContent, 'abcde', 'void 元素没有文本，文本按顺序拼接');
  eq(v.querySelectorAll('br').length, 1, 'br 是 void 元素');
});

section('minidom：属性写法与实体解码', () => {
  const a = parseHTML('<a href="1" id=\'2\' class=3 data-flag title="">x</a>').querySelector('a');
  eq(a.getAttribute('href'), '1', '双引号属性值');
  eq(a.getAttribute('id'), '2', '单引号属性值');
  eq(a.getAttribute('class'), '3', '无引号属性值');
  eq(a.hasAttribute('data-flag'), true, '裸属性（无值）会被记录');
  eq(a.getAttribute('data-flag'), '', '裸属性的值为空串');
  eq(a.hasAttribute('missing'), false, '不存在的属性 hasAttribute 为 false');
  eq(a.getAttribute('missing'), null, '不存在的属性 getAttribute 返回 null（与真实 DOM 一致）');
  eq(a.getAttribute('title'), '', '空字符串属性值不会被当成缺失');

  const e = parseHTML('<p>&amp; &lt; &gt; &quot; &#39; &nbsp;end</p>').querySelector('p');
  eq(e.textContent, '& < > " \' \u00a0end', '文本节点里 6 个基础实体都被正确解码');
  eq(decodeEntities('&#x4e2d;&#25991;'), '中文', '十六进制与十进制数字实体都能解码');
  eq(parseHTML('<a href="/x?a=1&amp;b=2">x</a>').querySelector('a').getAttribute('href'), '/x?a=1&b=2',
    '属性值里的 &amp; 被解码（站点自己的链接就是这种写法）');
});

section('minidom：tag soup 容错', () => {
  const soup = parseHTML('<ul><li>a<li>b<li>c</ul><p>p1<p>p2<div>d');
  eq(soup.querySelectorAll('li').length, 3, '未闭合的 <li> 由下一个 <li> 自动闭合');
  eq(soup.querySelectorAll('li')[2].textContent, 'c', '第三个 li 的文本正确');
  eq(soup.querySelectorAll('p').length, 2, '未闭合的 <p> 由下一个 <p> 自动闭合');
  ok(soup.querySelector('div').textContent === 'd', '未闭合的 div 在文件结束时正常收尾');

  const un = parseHTML('<div class="a"><span>in');
  eq(un.querySelector('div.a span').textContent, 'in', '完全没闭合的标签仍然在树里');
  eq(parseHTML('<td>孤立单元格</td>').querySelector('td').textContent, '孤立单元格', '孤立的 td 不会崩溃');

  const dupEnd = parseHTML('<div>a</div></div><span>b</span>');
  eq(dupEnd.querySelectorAll('span').length, 1, '多余的结束标签被忽略，后续内容照常解析');

  const doc = parseHTML('<!DOCTYPE html><html lang="zh"><head><title>T</title></head><body class="b">B</body></html>');
  eq(doc.documentElement.tagName, 'HTML', 'DOCTYPE 与 html 标签');
  eq(doc.head.querySelector('title').textContent, 'T', 'document.head 指向 head');
  eq(doc.body.textContent.trim(), 'B', 'document.body 指向 body');
  eq(doc.body.getAttribute('class'), 'b', 'body 上的属性被保留');
  eq(doc.nodeType, 9, 'Document.nodeType 为 9');

  const lead = parseHTML('<script>var a=1;</script><div>y</div>');
  ok(lead.head.querySelector('script') !== null, '文档开头的 script 归到 head（与浏览器一致）');
  ok(lead.body.querySelector('div') !== null, '紧随其后的 div 归到 body');
  eq(lead.querySelectorAll('a[href]').length, 0, 'script 内容不会被当成标签，也就不会产生 <a>');
});

section('minidom：节点 API', () => {
  const doc = parseHTML(`<div id="root" class="wrap">
  <p class="a">1</p><p class="b" data-k="v1">2</p><p class="b extra" data-k="v2">3</p>
  <span>4</span>
  <div class="inner"><p>5</p></div>
</div>`);
  const root = doc.querySelector('#root');

  eq(root.tagName, 'DIV', 'tagName 为大写');
  eq(root.nodeName, 'DIV', '元素 nodeName 等于 tagName');
  eq(root.nodeType, 1, '元素 nodeType 为 1');
  eq(root.childNodes.filter((n) => n.nodeType === 3).length > 0, true, 'childNodes 里保留空白文本节点');
  eq(root.children.length, 5, 'children 只包含元素子节点');
  eq(root.children.every((c) => c.nodeType === 1), true, 'children 里全是元素');

  const a = doc.querySelector('.a');
  eq(a.parentElement.id, 'root', 'parentElement 指向父元素');
  eq(a.parentNode, root, 'parentNode 与 parentElement 一致（父节点是元素时）');
  eq(a.textContent, '1', '文本节点的 textContent 参与递归拼接');
  eq(root.textContent.replace(/\s+/g, ''), '12345', 'textContent 递归拼接所有后代文本');

  eq(root.contains(a), true, 'contains 判断后代');
  eq(a.contains(root), false, 'contains 不认为父元素是自己的后代');
  eq(root.contains(root), true, 'contains(自己) 为 true');

  eq(a.closest('#root'), root, 'closest 向上爬到匹配的祖先');
  eq(a.closest('.nope'), null, 'closest 找不到时返回 null');
  eq(a.closest('span, .inner'), null, 'closest 支持逗号分组，且不会匹配不相干的祖先');
  eq(doc.querySelector('.b.extra').closest('div').tagName, 'DIV', 'closest 支持 tag 选择器');

  eq(a.matches('p.a'), true, 'matches 判断自身是否匹配');
  eq(a.matches('p.b'), false, 'matches 对不匹配的选择器返回 false');
  eq(a.matches('div > p, span'), true, 'matches 支持逗号分组与子元素组合器');
  eq(doc.querySelector('span').matches(':not(p)'), true, ':not() 在 matches 里可用');

  eq(root.querySelectorAll('#root').length, 0, 'querySelectorAll 不含元素自身（与真实 DOM 一致）');
  eq(root.querySelector('#root'), null, 'querySelector 同样不含元素自身');
  eq(doc.querySelectorAll('p').length, 4, 'document 上的后代遍历覆盖整棵树');

  const clone = root.cloneNode(true);
  eq(clone.querySelectorAll('p').length, 4, 'cloneNode(true) 深拷贝子节点');
  eq(clone.getAttribute('class'), 'wrap', 'cloneNode 复制属性');
  clone.querySelector('.a').remove();
  eq(clone.querySelectorAll('p').length, 3, '克隆体上 remove() 生效');
  eq(root.querySelectorAll('p').length, 4, '删除克隆体的节点不影响原树（必须真正深拷贝）');
  const cloneShallow = root.cloneNode(false);
  eq(cloneShallow.childNodes.length, 0, 'cloneNode(false) 不复制子节点');

  eq(doc.createElement('div').tagName, 'DIV', 'document.createElement 产出大写 tagName');
  eq(doc.createElement('div').parentNode, null, 'createElement 的元素未挂载');
  const made = doc.createElement('p');
  made.textContent = 'hello';
  eq(made.textContent, 'hello', 'textContent setter 可用');
  eq(made.childNodes.length, 1, 'textContent setter 生成一个文本节点');
});

section('minidom：选择器子集', () => {
  const doc = parseHTML(`<div id="root" class="wrap">
  <p class="a">1</p><p class="b" data-k="v1">2</p><p class="b extra" data-k="v2">3</p>
  <span>4</span>
  <div class="inner"><p>5</p></div>
</div>`);
  const root = doc.querySelector('#root');

  eq(root.querySelectorAll('*').length, 6, '通配符 * 命中全部后代元素');
  eq(root.querySelectorAll('p').length, 4, 'tag 选择器');
  eq(root.querySelectorAll('.b').length, 2, '.class 选择器');
  eq(root.querySelectorAll('#root').length, 0, '#id 不会命中元素自身');
  eq(doc.querySelectorAll('#root').length, 1, '#id 在 document 上可用');
  eq(root.querySelectorAll('[data-k]').length, 2, '[attr] 选择器');
  eq(root.querySelectorAll('[data-k="v2"]').length, 1, '[attr="value"] 选择器');
  eq(root.querySelectorAll('[class*="extra"]').length, 1, '[attr*="value"] 选择器');
  eq(root.querySelectorAll('.a, span').length, 2, '逗号分组把多组结果合并');
  eq(root.querySelectorAll('#root .b').length, 2, '空格是后代组合器');
  eq(root.querySelectorAll('div > p').length, 4, '> 是子元素组合器（inner 也是 div，所以是 4 个）');
  eq(root.querySelectorAll('#root > .inner > p').length, 1, '嵌套子元素组合器');
  eq(root.querySelectorAll('#root > .inner p').length, 1, '子元素 + 后代混用');
  eq(root.querySelectorAll('p:not(.b)').length, 2, ':not(.class)');
  eq(root.querySelectorAll('#root > :not(p)').length, 2, ':not(tag)');
  eq(root.querySelectorAll('p:first-child').length, 2, ':first-child（p.a 与 inner 里的 p）');
  eq(root.querySelectorAll('.pagination .next:not(.disabled) a').length, 0,
    '组合选择器在没有匹配时安静地返回空集合');

  throws(() => root.querySelectorAll('a:hover'), /不支持的 CSS 选择器|不支持伪类/, '不支持的伪类必须抛错，而不是静默返回空');
  throws(() => root.querySelectorAll('p:nth-child(2)'), /不支持伪类/, '不支持 :nth-child，抛错');
  throws(() => root.querySelectorAll('p + span'), /不支持的 CSS 选择器/, '不支持相邻兄弟组合器 +，抛错');
  throws(() => root.querySelectorAll('p ~ span'), /不支持的 CSS 选择器/, '不支持通用兄弟组合器 ~，抛错');
  throws(() => root.querySelectorAll(''), /不支持的 CSS 选择器|空选择器/, '空选择器抛错');
});

/* ============================================================ 2. dom-text */

section('parsers/dom-text.js：抗 null、抗空白', () => {
  eq(textOf(null), '', 'textOf(null) 返回空串');
  eq(textOfSafe(undefined), '', 'textOfSafe(undefined) 返回空串');
  eq(textOf(parseHTML('<div>  a\u00a0\n\t b  </div>').querySelector('div')), 'a b',
    'textOf 压缩空白并把 \\u00a0 变成普通空格');
  eq(textOfSafe({ get textContent() { throw new Error('boom'); } }), '',
    'textContent 抛异常时 textOfSafe 仍然返回空串（解析真实页面时缺节点是常态）');
  eq(attr({ getAttribute: () => null }, 'href'), '', 'attr 对不存在的属性返回空串');
  eq(attr(null, 'href'), '', 'attr(null) 返回空串');

  const el = parseHTML('<p>正文<span class="dl">下载</span></p>').querySelector('p');
  eq(textOfExcluding(el, '.dl'), '正文', 'textOfExcluding 先删掉指定后代再取文本');
  eq(textOf(el), '正文下载', '原元素不受 textOfExcluding 影响');
});

/* ============================================================ 3. date.js */

section('parsers/date.js：parseDate / findDates', () => {
  eq(parseDate('2026-09-20 23:59', NOW), at(2026, 9, 20, 23, 59), '2026-09-20 23:59');
  eq(parseDate('2026/9/20', NOW), at(2026, 9, 20), '2026/9/20（斜杠分隔、无时间）');
  eq(parseDate('2026年9月20日 23:59', NOW), at(2026, 9, 20, 23, 59), '2026年9月20日 23:59');
  eq(parseDate('2026.9.20 8:05', NOW), at(2026, 9, 20, 8, 5), '2026.9.20 8:05（点分隔）');
  eq(parseDate('2026-09-20 23:59:30', NOW), at(2026, 9, 20, 23, 59, 30), '带秒的时间');
  eq(parseDate('2026-02-30', NOW), null, '2026-02-30 不存在的日期被剔除，返回 null');

  eq(parseDate('09-20 23:59', NOW), at(2026, 9, 20, 23, 59), '09-20 23:59：无年份时取“离 now 最近”的年份');
  eq(parseDate('09-20 23:59', at(2026, 9, 21, 0, 0)), at(2026, 9, 20, 23, 59),
    '同一天稍后的 now：仍取当年的 09-20（差值仅 1 小时）');
  eq(parseDate('01-05 08:00', NOW), at(2027, 1, 5, 8, 0),
    '01-05 相对 2026-09-15 已过去 253 天（>180 天），按“离现在最近”规则落到 2027 年');
  eq(parseDate('12-25', NOW), at(2026, 12, 25),
    '12-25 距今只有 101 天（<180 天），仍是 2026 年');
  eq(parseDate('03-01', NOW), at(2027, 3, 1),
    '03-01 相对 2026-09-15 已过去 198 天（>180 天），落到 2027 年');

  eq(parseDate('明天 23:59', NOW), at(2026, 9, 16, 23, 59), '明天 23:59（相对日期）');
  eq(parseDate('后天 09:00', NOW), at(2026, 9, 17, 9, 0), '后天 09:00');
  eq(parseDate('昨天', NOW), at(2026, 9, 14), '昨天（无时间时按 00:00）');

  eq(parseDate('二〇二六年九月十日', NOW), at(2026, 9, 10), '中文数字日期 二〇二六年九月十日');
  eq(parseDate('二〇二六年九月二十日', NOW), null,
    '【源码缺陷】二〇二六年九月二十日 解析为 null：date.js 的 CN_NUM 只有 一~十二，'
    + '"二十" 取不到值 -> 日=0 -> isValidYmd 剔除。若这条变成非 null，说明 CN_NUM 已扩展，请更新本断言');

  const many = findDates('公告 2026-09-01 10:30 / 截止 2026-09-20 23:59', NOW);
  eq(many.length, 2, 'findDates 找出两处日期');
  eq(many[0].ms, at(2026, 9, 1, 10, 30), '第一处日期顺序正确（按出现位置排序）');
  eq(many[0].hasTime, true, '第一处日期带时间');
  eq(many[1].ms, at(2026, 9, 20, 23, 59), '第二处日期');
  ok(many[0].index < many[1].index, 'findDates 结果按 index 升序');
  eq(findDates('没有任何日期', NOW).length, 0, '没有日期时返回空数组');
  eq(findDates('', NOW).length, 0, '空串返回空数组');
});

section('parsers/date.js：extractDeadline / extractPublishDate', () => {
  const mixed = '发布时间 2026-09-01 10:30 截止时间 2026-09-20 23:59';
  const d1 = extractDeadline(mixed, NOW);
  eq(d1.deadline, at(2026, 9, 20, 23, 59), '同时出现发布时间与截止时间时，必须取截止时间而不是第一个日期');
  eq(d1.reason, 'keyword:截止时间', '命中“截止时间”关键词');

  const d2 = extractDeadline('发布 2026-09-01 截止日期 2026-09-20 23:59', NOW);
  eq(d2.deadline, at(2026, 9, 20, 23, 59), '“截止日期”关键词同样优先于前面的发布日期');
  eq(d2.reason, 'keyword:截止日期', '命中“截止日期”关键词');

  const d3 = extractDeadline('提交截止 2026-09-20', NOW);
  eq(d3.deadline, at(2026, 9, 20), '“提交截止”关键词');

  const d4 = extractDeadline('2026-09-20 23:59', NOW);
  eq(d4.deadline, at(2026, 9, 20, 23, 59), '只有一处带时间的日期时接受它');
  eq(d4.reason, 'sole-datetime', '原因是 sole-datetime');

  const d5 = extractDeadline('2026-09-20', NOW);
  eq(d5.reason, 'sole-date', '只有一处不带时间的日期时原因是 sole-date');

  eq(extractDeadline('', NOW).deadline, null, '空文本没有截止时间');
  eq(extractDeadline('', NOW).reason, 'empty', '空文本原因是 empty');
  eq(extractDeadline('没有日期', NOW).reason, 'no-date', '没有日期时原因是 no-date');

  const p1 = extractPublishDate('发布者 李四 2026-09-01 10:30', NOW);
  eq(p1, at(2026, 9, 1, 10, 30), 'extractPublishDate 取第一个日期');
  eq(extractPublishDate('没有日期', NOW), null, '没有日期时 extractPublishDate 返回 null');
  eq(extractPublishDate('', NOW), null, '空串返回 null');
});

section('parsers/date.js：classifyStatus', () => {
  const opt = { done: DONE_PATTERNS, pending: PENDING_PATTERNS };
  eq(classifyStatus('已提交', opt).status, 'done', '已提交 -> done');
  eq(classifyStatus('待批阅', opt).status, 'done', '待批阅 -> done（已经交过了）');
  eq(classifyStatus('已批改', opt).status, 'done', '已批改 -> done');
  eq(classifyStatus('已评分', opt).status, 'done', '已评分 -> done');
  eq(classifyStatus('未提交', opt).status, 'pending', '未提交 -> pending');
  eq(classifyStatus('未交', opt).status, 'pending', '未交 -> pending');
  eq(classifyStatus('未提交', opt).evidence, '未提交', 'pending 判定先于 done，证据是“未提交”而不是“提交”');
  eq(classifyStatus('这是一段无关的文本', opt).status, 'unknown', '无关文本 -> unknown');
  eq(classifyStatus('', opt).status, 'unknown', '空文本 -> unknown');
  eq(classifyStatus('已提交', opt).evidence, '已提交', '证据字段记录命中的模式');
});

/* ============================================================ 4. common/utils + endpoints */

section('common/utils.js 与 common/constants.js', () => {
  // 调试/取证入口必须默认关闭 —— 它们会开标签页、连着打开几十个页面，不能默认露面
  eq(DEFAULT_SETTINGS.debugMode, false, '调试功能默认关闭');
  eq(DEFAULT_SETTINGS.yuketangHomework, true, '雨课堂作业默认跟随刷新一起抓');
  eq(DEFAULT_SETTINGS.showCompletedHomework, false, '已完成的作业默认隐藏');
  eq(DEFAULT_SETTINGS.tabFallback, true, '渲染兜底默认开启');
  eq(DEFAULT_SETTINGS.enrichHomework, true, '作业说明补全默认开启');
  eq(squash(' a\u00a0\n\t b '), 'a b', 'squash 压缩空白并去掉 \\u00a0');
  eq(squash(null), '', 'squash(null) 是空串');
  eq(truncate('abcdef', 4), 'abc…', 'truncate 超出长度时截断并加省略号');
  eq(truncate('ab', 4), 'ab', 'truncate 不超长时原样返回');
  eq(absolutize('/x', 'https://a.example.com/y'), 'https://a.example.com/x', 'absolutize 相对路径变绝对');
  eq(absolutize('', 'https://a.example.com/y'), '', 'absolutize 空串返回空串');
  eq(absolutize('not a url', 'not a base'), 'not a url', 'absolute 失败时原样返回');

  deepEq(fileKind('第1章 绪论.PDF'), { ext: 'pdf', kind: 'pdf' }, 'fileKind 识别扩展名并归类');
  deepEq(fileKind('课程幻灯片.zip'), { ext: 'zip', kind: 'zip' }, 'zip 归类为 zip');
  deepEq(fileKind('main.cpp'), { ext: 'cpp', kind: 'code' }, '代码文件归类为 code');
  deepEq(fileKind('没有扩展名'), { ext: '', kind: 'file' }, '没有扩展名时为 file');

  eq(parseSize('890 KB'), 911360, 'parseSize 解析 KB');
  eq(parseSize('1.2 MB'), 1258291, 'parseSize 解析小数 MB');
  eq(parseSize('没有大小'), null, 'parseSize 找不到大小返回 null');

  eq(hashString('abc'), hashString('abc'), 'hashString 稳定');
  ok(hashString('abc') !== hashString('abd'), 'hashString 对不同输入给出不同结果');

  deepEq(extractCourseKey(`${ORIGIN}/f/wlxt/course/index?wlkcid=1&courseId=2`), { wlkcid: '1', courseId: '2', raw: '', semester: '' },
    'extractCourseKey 从绝对 URL 里取课程标识（参数名大小写不敏感）');
  deepEq(extractCourseKey('/f/wlxt/course/index?wlkcid=1&courseId=2'), { wlkcid: '', courseId: '', raw: '', semester: '' },
    '【注意】extractCourseKey 传相对地址时拿不到任何东西：parseUrlParams 里的 new URL 需要绝对地址（见末尾 warn）');

  eq(DONE_PATTERNS.includes('已提交'), true, '常量表里有“已提交”');
  eq(PENDING_PATTERNS.includes('未提交'), true, '常量表里有“未提交”');
  eq(DONE_PATTERNS.includes('已批阅') && DONE_PATTERNS.includes('待批阅'), true, '已批阅/待批阅都算完成');
});

section('api/endpoints.js', () => {
  eq(abs('/f/x'), `${ORIGIN}/f/x`, 'abs 补全相对路径');
  eq(abs('b/x'), `${ORIGIN}/b/x`, 'abs 补全缺前导斜杠的路径');
  eq(abs('https://other.example/y'), 'https://other.example/y', 'abs 对绝对地址原样返回');
  eq(abs(''), '', 'abs 空值返回空串');

  eq(PAGE.noticeList('X'), '/f/wlxt/kcgg/wlkc_ggb/student/beforePageListXs?wlkcid=X&sfgk=0', 'PAGE.noticeList 与站点一致');
  eq(PAGE.fileList('X'), '/f/wlxt/kj/wlkc_kjxxb/student/beforePageList?wlkcid=X&sfgk=0', 'PAGE.fileList 与站点一致');
  eq(PAGE.homeworkList('X'), '/f/wlxt/kczy/zy/student/beforePageList?wlkcid=X', 'PAGE.homeworkList 与站点一致');
  eq(PAGE.noticeDetail('X', '9'), '/f/wlxt/kcgg/wlkc_ggb/student/beforeViewXs?wlkcid=X&id=9', 'PAGE.noticeDetail 与站点一致');
  eq(PAGE.homeworkSubmit('X', '2'), '/f/wlxt/kczy/zy/student/tijiao?wlkcid=X&xszyid=2', 'PAGE.homeworkSubmit 与站点一致');
  eq(API.homework, '/b/kc/v_xszy_search/student/pageList', 'API.homework 路径（注意它在 /b/kc/ 下）');

  eq(guessSemester(new Date(2026, 8, 15)), '2026-2027-1', '9 月属于秋季学期 2026-2027-1');
  eq(guessSemester(new Date(2026, 7, 1)), '2026-2027-1', '8 月属于秋季学期');
  eq(guessSemester(new Date(2026, 2, 1)), '2025-2026-2', '3 月属于春季学期 2025-2026-2');
  eq(guessSemester(new Date(2026, 0, 10)), '2025-2026-1', '1 月属于上一学年的秋季学期');

  const past = at(2026, 9, 20, 23, 59);
  eq(homeworkUrl({ wlkcid: 'W', zyid: '1', xszyid: '2', zt: '未交', pyzt: '', deadline: past, now: NOW_HW }),
    `${ORIGIN}/f/wlxt/kczy/zy/student/viewZy?wlkcid=W&sfgq=1&zyid=1&xszyid=2`,
    '未交 + 已过期 -> viewZy 且 sfgq=1');
  eq(homeworkUrl({ wlkcid: 'W', zyid: '3', xszyid: '4', zt: '已交', pyzt: '未批阅', deadline: past, now: NOW_HW }),
    `${ORIGIN}/f/wlxt/kczy/zy/student/viewTj?wlkcid=W&sfgq=1&zyid=3&xszyid=4`,
    '已交未批阅 -> viewTj，并带上过期标记');
  eq(homeworkUrl({ wlkcid: 'W', zyid: '9', xszyid: '10', zt: '已交', pyzt: '已批改', deadline: past, now: NOW_HW }),
    `${ORIGIN}/f/wlxt/kczy/zy/student/viewCj?wlkcid=W&zyid=9&xszyid=10`,
    '已批改 -> viewCj，且不带 sfgq');
  eq(homeworkUrl({ wlkcid: 'W', zyid: '11', xszyid: '12', zt: '已交', pyzt: '', deadline: at(2026, 10, 5, 23, 59), now: NOW_HW }),
    `${ORIGIN}/f/wlxt/kczy/zy/student/viewTj?wlkcid=W&sfgq=0&zyid=11&xszyid=12`,
    '未过期 -> sfgq=0');

  const ambiguous = homeworkUrl({ wlkcid: 'W', zyid: '1', xszyid: '2', zt: '未交', pyzt: '未批阅', deadline: past, now: NOW_HW });
  eq(ambiguous, `${ORIGIN}/f/wlxt/kczy/zy/student/viewZy?wlkcid=W&sfgq=1&zyid=1&xszyid=2`,
    '未交优先于 pyzt：zt=未交 + pyzt=未批阅 也落到 viewZy（站点原写法会因 && 优先级误判成 viewTj，见 endpoints.js 注释）');
});

/* ============================================================ 5. heuristics */

section('parsers/heuristics.js：primaryAnchor / buildItem', () => {
  const base = `${ORIGIN}/f/wlxt/kczy/zy/student/beforePageList?wlkcid=${W}`;
  const wrap = parseHTML(`<div class="row">
    <a href="/dl/1">下载</a>
    <a href="/f/wlxt/kczy/zy/student/viewZy?wlkcid=${W}&sfgq=0&zyid=1&xszyid=2" title="查看作业">第三章 树与二叉树.pdf</a>
    <a href="#top">回顶部</a>
    <a href="javascript:void(0)">展开</a>
  </div>`).querySelector('div');

  const pa = primaryAnchor(wrap, base);
  ok(pa !== null, 'primaryAnchor 在容器里选出一个链接');
  eq(pa.text, '第三章 树与二叉树.pdf', '选中的是标题链接而不是“下载”按钮');
  eq(pa.href, `${ORIGIN}/f/wlxt/kczy/zy/student/viewZy?wlkcid=${W}&sfgq=0&zyid=1&xszyid=2`, 'href 被解析成绝对地址');
  eq(pa.title, '查看作业', 'title 属性被带出来');
  eq(pa.el.tagName, 'A', 'el 指向被选中的锚元素');

  const onlyDl = parseHTML('<div><a href="/dl">下载</a></div>').querySelector('div');
  eq(primaryAnchor(onlyDl, base).text, '下载', '容器里只有操作词链接时也能选出来');
  eq(primaryAnchor(parseHTML('<div>纯文本</div>').querySelector('div'), base), null, '没有链接时返回 null');
  eq(primaryAnchor(parseHTML('<div><a href="#">#</a></div>').querySelector('div'), base), null, '# 之类的链接不算可用链接');

  const hwItem = buildItem(parseHTML(`<li class="homework-item">
      <a href="/f/wlxt/kczy/zy/student/viewZy?wlkcid=${W}&sfgq=0&zyid=1&xszyid=2">第一次作业</a>
      <span class="state">未提交</span>
      <span class="deadline">截止时间 2026-09-20 23:59</span>
    </li>`).querySelector('li'), base, 'homework', NOW_HW);
  eq(hwItem.title, '第一次作业', 'buildItem 标题来自最像标题的链接');
  eq(hwItem.status, 'pending', 'buildItem 用 constants 里的模式判定出 pending');
  eq(hwItem.statusEvidence, '未提交', 'buildItem 记录判定证据');
  eq(hwItem.deadline, at(2026, 9, 20, 23, 59), 'buildItem 从“截止时间”关键词取截止时间');
  eq(hwItem.deadlineReason, 'keyword:截止时间', 'buildItem 记录截止时间的判定依据');
  eq(hwItem.source, 'dom', 'buildItem 标注来源为 dom');
  ok(typeof hwItem.id === 'string' && hwItem.id.length > 0, 'buildItem 产出稳定 id');

  const noticeItem = buildItem(parseHTML(`<li class="notice-item">
      <a href="/f/wlxt/kcgg/wlkc_ggb/student/beforeViewXs?wlkcid=${W}&id=123">关于期中考试的通知</a>
      <span>2026-09-01 10:30</span>
    </li>`).querySelector('li'), base, 'notice', NOW);
  eq(noticeItem.deadline, null, 'kind=notice 时明确不算截止时间');
  eq(noticeItem.deadlineReason, 'n/a', 'kind=notice 的 deadlineReason 是 n/a');

  eq(buildItem(parseHTML('<td>x</td>').querySelector('td'), base, 'auto', NOW), null,
    '没有链接、文本长度 < 2 的节点返回 null');
  const bareText = buildItem(parseHTML('<td>纯文本</td>').querySelector('td'), base, 'auto', NOW);
  eq(bareText.title, '纯文本', '没有任何链接的节点会退化成“整段文本当标题”');
  eq(bareText.url, '', '退化成纯文本的条目 url 是空串（爬虫侧要能接受这种条目）');
  eq(buildItem({ nodeType: 3, textContent: 'x' }, base, 'auto', NOW), null, '非元素节点直接返回 null');
  eq(buildItem(null, base, 'auto', NOW), null, 'buildItem(null) 返回 null');

  const table = parseHTML(readFileSync(path.join(FIXTURES, 'fixtures', 'notice-list.html'), 'utf8'), NOTICE_URL);
  eq(buildItem(table.querySelector('thead tr'), NOTICE_URL, 'notice', NOW), null,
    '表头行（只有 th）被 looksLikeHeaderRow 排除，不产出条目');
});

section('parsers/heuristics.js：findSectionLinks / findLogoutUrl / detectPageKind', () => {
  const clHtml = fixture('course-list.html');
  const clDoc = parseHTML(clHtml, COURSE_LIST_URL);

  const sections = findSectionLinks(clDoc, COURSE_LIST_URL);
  eq(sections.notice, abs(PAGE.noticeList(W)), '课程列表页里找到的“公告”入口就是站点真实的公告列表页');
  eq(sections.file, abs(PAGE.fileList(W)), '“课件”入口是真实的文件列表页');
  eq(sections.homework, abs(PAGE.homeworkList(W)), '“作业”入口是真实的作业列表页');

  eq(findLogoutUrl(clDoc, COURSE_LIST_URL), `${ORIGIN}/f/j_spring_security_logout`,
    'findLogoutUrl 按锚文本找到站点自己的退出链接');
  eq(findLogoutUrl(parseHTML(fixture('notice-list.html'), NOTICE_URL), NOTICE_URL), '',
    '页面上没有“退出/注销”链接时返回空串');

  eq(detectPageKind(clDoc, COURSE_LIST_URL), 'course-list', '课程列表页识别为 course-list');
  eq(detectPageKind(parseHTML(fixture('notice-list.html'), NOTICE_URL), NOTICE_URL), 'notice',
    '公告列表页识别为 notice');
  eq(detectPageKind(parseHTML(fixture('file-list.html'), FILE_URL), FILE_URL), 'file',
    '文件列表页识别为 file');
  eq(detectPageKind(parseHTML(fixture('homework-list.html'), HW_URL), HW_URL), 'homework',
    '作业列表页识别为 homework');
  eq(detectPageKind(parseHTML(fixture('login.html'), LOGIN_URL), LOGIN_URL), 'login',
    '本地登录页识别为 login');
  eq(detectPageKind(parseHTML(fixture('login-captcha.html'), IAAA_URL), IAAA_URL), 'login',
    '统一身份认证页识别为 login');
  eq(detectPageKind(parseHTML('<html><body>一片空白</body></html>', 'https://x.example/y'), 'https://x.example/y'),
    'unknown', '没有任何线索时识别为 unknown');

  // 站点真实地址与 detectPageKind 的 URL 正则对不上 —— 记进 warn，不改源码
  const empty = parseHTML('<html><body></body></html>');
  const bare = {
    notice: detectPageKind(empty, NOTICE_URL),
    file: detectPageKind(empty, FILE_URL),
    homework: detectPageKind(empty, HW_URL),
  };
  if (bare.notice !== 'notice' || bare.file !== 'file' || bare.homework !== 'homework') {
    warn(`detectPageKind 的 URL 分支匹配不到 endpoints.js 里的真实列表页地址（空白页判定：`
      + `公告=${bare.notice}、文件=${bare.file}、作业=${bare.homework}）。`
      + `原因是正则写成 /\\/f\\/wlxt\\/(gg|notice)\\// 这类“紧跟 /f/wlxt/ 的短名”，`
      + `而真实路径是 /f/wlxt/kcgg/…、/f/wlxt/kj/…、/f/wlxt/kczy/…（见 src/parsers/heuristics.js:314-316）。`
      + `只剩文本兜底在工作。`);
  }

  const hwWithNoticeNav = fixture('homework-list.html').replace(
    '<h1 class="course-name">数据结构</h1>',
    `<h1 class="course-name">数据结构</h1><nav class="nav"><a href="${PAGE.noticeList(W)}">公告</a></nav>`,
  );
  const shadowed = detectPageKind(parseHTML(hwWithNoticeNav, HW_URL), HW_URL);
  if (shadowed !== 'homework') {
    warn(`作业列表页只要正文前 400 字里出现“公告”，detectPageKind 就会返回 ${shadowed}（期望 homework）：`
      + '文本兜底先判公告再判作业（src/parsers/heuristics.js:319-321），真实课程页导航几乎都带“公告”。');
  }

  eq(findRepeatedGroups(clDoc).length > 0, true, 'findRepeatedGroups 在课程列表页能找到重复结构组');
});

/* ============================================================ 6. list-page */

section('parsers/list-page.js：公告列表页', () => {
  const doc = parseHTML(fixture('notice-list.html'), NOTICE_URL);
  const p = parseSectionPage(doc, NOTICE_URL, 'notice', { now: NOW });

  eq(p.detectedKind, 'notice', 'detectPageKind 判定为 notice');
  eq(p.kind, 'notice', '显式传入的 kind 生效');
  eq(p.method, 'selector:#ggalltable tbody tr',
    '优先命中站点自己的容器 #ggalltable（此前会退到通用的 table tbody tr，最差时被裸 li 抓成左侧课程导航）');
  eq(p.items.length, 4, '四行公告全部被抽出来');
  eq(p.empty, false, '非空列表页 empty=false');
  eq(p.pageTitle, '数据结构', 'pageTitle 来自页面上的 h1.course-name');
  eq(p.nextPageUrl, '', '“下一页”是不可点的 span.next.disabled，所以没有下一页地址');
  eq(p.sections.notice, abs(PAGE.noticeList(W)), 'sections 里的公告入口正确');
  eq(p.items.every((i) => i.section === 'notice'), true, '所有条目都归属 notice 板块');

  const n1 = byTitle(p.items, '关于期中考试的通知');
  ok(n1 !== undefined, '抽到“关于期中考试的通知”');
  eq(n1.url, abs(PAGE.noticeDetail(W, '123')), '公告链接被还原成绝对地址（与站点自己的地址规则一致）');
  eq(n1.date, at(2026, 9, 1, 10, 30), '发布时间被解析成 epoch ms');
  eq(n1.deadline, null, '公告条目不产出截止时间');

  const n2 = byTitle(p.items, '关于国庆节放假安排的通知');
  eq(n2.date, at(2026, 9, 5, 14, 0), '时间列里的 &nbsp; 被当成普通空格，2026/9/5 14:00 照样解析');
  const n3 = byTitle(p.items, '课程网站使用说明');
  eq(n3.url, abs(PAGE.noticeDetail(W, '125')), 'href 里写成 &amp; 的查询串被正确解码');
  eq(n3.date, at(2026, 9, 10), '只有日期的行按当天 00:00 解析');
  const n4 = byTitle(p.items, '关于调整上课地点的通知');
  eq(n4.date, at(2026, 9, 12, 8, 0), '第四条公告的时间正确');

  eq(isEmptyListPage(doc), false, '有数据的列表页不是空列表页');

  const auto = parseSectionPage(doc, NOTICE_URL, 'auto', { now: NOW });
  eq(auto.kind, 'notice', 'kind=auto 时用 detectPageKind 的结果（notice）');
  eq(auto.items.length, 4, 'auto 模式下条目数量一致');
});

section('parsers/list-page.js：文件列表页', () => {
  const doc = parseHTML(fixture('file-list.html'), FILE_URL);
  const p = parseSectionPage(doc, FILE_URL, 'file', { now: NOW });

  eq(p.detectedKind, 'file', 'detectPageKind 判定为 file');
  eq(p.items.length, 4, '四行课件全部被抽出来');
  eq(p.items.every((i) => i.section === 'file'), true, '所有条目都归属 file 板块');

  const f1 = byTitle(p.items, '第1章 绪论.pdf');
  ok(f1 !== undefined, '抽到“第1章 绪论.pdf”');
  eq(f1.url, `${ORIGIN}/f/wlxt/kj/wlkc_kjxxb/student/beforeViewXs?wlkcid=${W}&wjid=501`, '课件链接是绝对地址');
  eq(f1.ext, 'pdf', '扩展名归一化为 pdf');
  eq(f1.fileKind, 'pdf', '文件分类为 pdf');
  eq(f1.size, 2097152, 'size 从行文本里的“2 MB”解析出来');
  eq(f1.date, at(2026, 9, 2, 9, 0), '上传时间被解析');
  eq(f1.links.some((l) => l.href === `${ORIGIN}/b/wlxt/kj/wlkc_kjxxb/student/downloadFile?sfgk=0&wjid=501`), true,
    'links 里带上了站点自己的下载接口（图标链接，文本为空）');
  eq(f1.ext, 'pdf', '扩展名不会被下载接口的查询串带偏');

  const f3 = byTitle(p.items, '实验指导书.docx');
  eq(f3.size, 916480, '第二条的“895 KB”也解析正确');
  eq(f3.fileKind, 'doc', 'docx 归类为 doc');

  eq(p.items.some((i) => i.deadline !== null), false, '文件条目不应带截止时间（那不是「截止」，是上传时间）');
});

section('parsers/list-page.js：作业列表页', () => {
  const doc = parseHTML(fixture('homework-list.html'), HW_URL);
  const p = parseSectionPage(doc, HW_URL, 'homework', { now: NOW_HW });

  eq(p.detectedKind, 'homework', 'detectPageKind 判定为 homework');
  eq(p.kind, 'homework', '请求的 kind 生效');
  eq(p.method, 'selector:#zyalltable tbody tr', '作业列表优先命中站点自己的容器 #zyalltable');
  eq(p.items.length, 4, '四行作业全部被抽出来（顺手抓到的卡片组不会盖过它）');
  eq(p.items.every((i) => i.section === 'homework'), true, '所有条目都归属 homework 板块');

  const attempts = p.stats.attempts.join(' ');
  ok(/repeated:div\.hw-card@\d+#div\.hw-cards@\d+=2/.test(attempts),
    `兜底路径 findRepeatedGroups 也能认出 div.hw-card 兄弟组（stats: ${attempts}）`);

  const h1 = byTitle(p.items, '第一次作业');
  ok(h1 !== undefined, '抽到“第一次作业”');
  eq(h1.url, `${ORIGIN}/f/wlxt/kczy/zy/student/viewZy?wlkcid=${W}&sfgq=0&zyid=1&xszyid=2`, '作业链接是站点自己的 viewZy 地址');
  eq(h1.deadline, at(2026, 9, 20, 23, 59), '截止时间 2026-09-20 23:59 解析正确');
  eq(h1.status, 'pending', '“未提交”判定为 pending（等价于 completed=false）');
  eq(h1.statusEvidence, '未提交', '证据是“未提交”三个字');
  eq(h1.date, h1.deadline, '作业行里第一个日期就是截止日期那一列');

  const h2 = byTitle(p.items, '第二次作业');
  eq(h2.deadline, at(2026, 10, 5, 23, 59), '第二条的截止时间正确');
  eq(h2.status, 'done', '“已提交”判定为 done（等价于 completed=true）');
  eq(h2.url, `${ORIGIN}/f/wlxt/kczy/zy/student/viewTj?wlkcid=${W}&sfgq=0&zyid=3&xszyid=4`, '已提交行指向 viewTj');

  const h3 = byTitle(p.items, '第三次作业（实验报告）');
  ok(h3 !== undefined, '抽到字段顺序被打乱的“第三次作业（实验报告）”');
  eq(h3.deadline, at(2026, 9, 25, 23, 59), '字段顺序被打乱后截止时间仍然取对（截止日期仍在提交日期前面）');
  eq(h3.status, 'done', '“已批改”判定为 done');
  eq(h3.url, `${ORIGIN}/f/wlxt/kczy/zy/student/viewCj?wlkcid=${W}&zyid=9&xszyid=10`, '已批改行指向 viewCj');

  const h4 = byTitle(p.items, '第四次作业');
  ok(h4 !== undefined, '抽到行内没有「截止」二字、只能靠列位置判断的“第四次作业”');
  eq(h4.status, 'done', '第四条的状态判定不受字段顺序影响');
  eq(h4.deadline, at(2026, 10, 8, 23, 59),
    '行内没有「截止」字样时，必须靠表头列位置取到截止日期，不能拿「提交日期」2026-09-30 09:10 顶上');

  const auto = parseSectionPage(doc, HW_URL, 'auto', { now: NOW_HW });
  eq(auto.kind, 'homework', 'kind=auto 时用 detectPageKind 的结果（homework）');
  eq(auto.items.length, 4, 'auto 模式下条目数量一致');
});

section('parsers/list-page.js：分页、guessKind、空列表', () => {
  const doc = parseHTML(fixture('pagination.html'), NOTICE_URL);
  eq(findNextPage(doc, NOTICE_URL), `${ORIGIN}/f/wlxt/kcgg/wlkc_ggb/student/beforePageListXs?page=2`,
    'findNextPage 通过“下一页”锚文本找到第 2 页并解析成绝对地址');
  const p = parseSectionPage(doc, NOTICE_URL, 'notice', { now: NOW });
  eq(p.items.length, 2, '分页页面的条目也照常解析');
  eq(p.nextPageUrl, `${ORIGIN}/f/wlxt/kcgg/wlkc_ggb/student/beforePageListXs?page=2`, 'parseSectionPage 带出 nextPageUrl');
  eq(p.pageTitle, '数据结构', '分页页面的 pageTitle');

  const iconDoc = parseHTML(`<div class="pagination">
      <span class="prev disabled"><a href="?page=0">上一页</a></span>
      <span class="next"><a href="?page=3"><i class="icon-next"></i></a></span>
    </div>`, NOTICE_URL);
  eq(findNextPage(iconDoc, NOTICE_URL), `${ORIGIN}/f/wlxt/kcgg/wlkc_ggb/student/beforePageListXs?page=3`,
    '没有文本的图标分页走 class 兜底：.pagination .next:not(.disabled) a（同时验证选择器引擎的 :not()）');

  const relDoc = parseHTML('<div class="pagination"><a rel="next" href="?page=7">7</a></div>', NOTICE_URL);
  eq(findNextPage(relDoc, NOTICE_URL), `${ORIGIN}/f/wlxt/kcgg/wlkc_ggb/student/beforePageListXs?page=7`,
    'a[rel="next"] 兜底路径可用');

  eq(findPageTitle(parseHTML('<html><head><title>公告列表 - 网络学堂</title></head><body><h1>数据结构</h1></body></html>')),
    '数据结构', 'findPageTitle 优先取 h1');
  eq(findPageTitle(parseHTML('<html><head><title>公告列表 - 网络学堂</title></head><body>x</body></html>')),
    '公告列表', '没有标题元素时退回到 <title> 并去掉后半段');

  eq(guessKind({ title: '第三次作业.pdf', text: '' }), 'file', '标题带扩展名 -> file');
  eq(guessKind({ title: '第一次作业', text: '截止 2026-09-20' }), 'homework', '文本里有“作业/截止” -> homework');
  eq(guessKind({ title: '关于期中考试的通知', text: '' }), 'notice', '“通知/关于” -> notice');
  eq(guessKind({ title: '课程网站使用说明', text: '' }), 'notice', '认不出时默认 notice');

  eq(isEmptyListPage(parseHTML('<html><body><p>暂无数据</p></body></html>')), true, '“暂无数据”会被识别为空列表页');
  eq(isEmptyListPage(parseHTML('<html><body><p>有数据</p></body></html>')), false, '有内容就不是空列表页');

  const doc2 = parseHTML(fixture('notice-list.html'), NOTICE_URL);
  const limited = parseSectionPage(doc2, NOTICE_URL, 'notice', { now: NOW, maxItems: 2 });
  eq(limited.items.length, 2, 'maxItems 限制生效');
});

section('parsers/heuristics.js：extractListItems 统计信息', () => {
  const doc = parseHTML(fixture('notice-list.html'), NOTICE_URL);
  const r = extractListItems(doc, NOTICE_URL, { kind: 'notice', now: NOW });
  eq(r.method, 'selector:#ggalltable tbody tr', 'method 记录命中的策略（站点自己的容器优先）');
  eq(r.stats.chosen, 4, 'stats.chosen 等于入选策略的条目数');
  ok(Array.isArray(r.stats.attempts) && r.stats.attempts.length > 0, 'stats.attempts 记录每条策略的结果，便于诊断');

  const empty = parseHTML('<html><body><p>暂无数据</p></body></html>');
  const er = extractListItems(empty, NOTICE_URL, { kind: 'notice', now: NOW });
  eq(er.method, 'none', '抓不到条目时 method 为 none');
  eq(er.items.length, 0, '抓不到条目时 items 为空');
  eq(er.stats.attempts.every((a) => a.includes('=0')), true, '抓不到条目时每条策略的计数都是 0');

  // 一行里有两个可点链接（标题 + 下载图标带文字）时，td 级的 repeated 组条目数会多于行级
  const tdHeavy = `<table><tbody>
      <tr><td><a href="/f/wlxt/kj/wlkc_kjxxb/student/beforeViewXs?wlkcid=${W}&wjid=601">第一章 数据结构绪论.pdf</a></td><td>PDF</td><td><a href="/b/wlxt/kj/wlkc_kjxxb/student/downloadFile?sfgk=0&wjid=601">下载</a></td></tr>
      <tr><td><a href="/f/wlxt/kj/wlkc_kjxxb/student/beforeViewXs?wlkcid=${W}&wjid=602">第二章 线性表与链表.pdf</a></td><td>PDF</td><td><a href="/b/wlxt/kj/wlkc_kjxxb/student/downloadFile?sfgk=0&wjid=602">下载</a></td></tr>
      <tr><td><a href="/f/wlxt/kj/wlkc_kjxxb/student/beforeViewXs?wlkcid=${W}&wjid=603">第三章 树与二叉树.pdf</a></td><td>PDF</td><td><a href="/b/wlxt/kj/wlkc_kjxxb/student/downloadFile?sfgk=0&wjid=603">下载</a></td></tr>
    </tbody></table>`;
  const tdRes = extractListItems(parseHTML(tdHeavy, FILE_URL), FILE_URL, { kind: 'file', now: NOW });
  if (tdRes.method !== 'selector:table tbody tr') {
    warn(`表格每行有两个可点链接时，extractListItems 选中了 ${tdRes.method}（${tdRes.items.length} 条），`
      + `而不是 table tbody tr（3 条）；结果里还会出现标题为“下载”的条目：`
      + `${show(tdRes.items.map((i) => i.title))}。`
      + 'best 只按条目数取最大（src/parsers/heuristics.js:241-243），而 findRepeatedGroups 把“同一父节点下、'
      + '各自含链接的兄弟 td”也当成一族（src/parsers/heuristics.js:172-199），一行两个链接就会让 td 组翻倍。');
  }
});

/* ============================================================ 7. course-list */

section('parsers/course-list.js：extractCourses（已渲染）', () => {
  const doc = parseHTML(fixture('course-list.html'), COURSE_LIST_URL);
  const r = extractCourses(doc, COURSE_LIST_URL);

  eq(r.method, 'anchor:course-href', 'method 说明是锚点反推');
  eq(r.courses.length, 4, '四门课全部解析出来（含没有教师节点的那门）');
  eq(r.stats.courses, 4, 'stats.courses 与 courses.length 一致');
  eq(r.stats.anchors, 19, 'stats.anchors 统计了所有带课程 id 的锚点');

  const byId = (id) => r.courses.find((c) => c.id === id);
  const c1 = byId(W);
  ok(c1 !== undefined, '课程 id 取的是 URL 里的 wlkcid');
  eq(c1.name, '数据结构', '课程名取自 a.title 而不是卡片里的其它文字');
  eq(c1.teacher, '张三', '教师从“授课教师：”标签里读出来');
  eq(c1.term, '2026-2027 学年 秋季学期', '学期从卡片文本里读出来');
  eq(c1.url, `${ORIGIN}/f/wlxt/course/index?wlkcid=${W}&courseId=1000000001`, '课程主页地址解析成绝对地址');

  const c2 = byId('2026-2027-1000000102');
  eq(c2.name, '高等数学', '第二门课的课程名正确');
  eq(c2.teacher, '李四', '任课教师：标签同样能读出来');
  eq(c2.url, `${ORIGIN}/f/wlxt/course/index?wlkcid=2026-2027-1000000102&courseId=1000000102`,
    'href 写成 &amp; 的课程链接也被正确解码');

  const c3 = byId('2026-2027-1000000103');
  eq(c3.name, '大学物理实验', '第三门课的课程名正确（它同时含“实验”二字，不能被当成“作业”链接）');
  eq(c3.teacher, '王五', '“主讲：”也算教师标签');

  const c4 = byId('2026-2027-1000000104');
  ok(c4 !== undefined, '没有教师节点的课程仍然被解析出来（缺字段不能整条丢掉）');
  eq(c4.name, '中国近现代史纲要', '缺教师节点的课程名正确');
  eq(c4.teacher, '', '缺教师节点时 teacher 是空串而不是抛错');

  eq(r.courses.every((c) => typeof c.id === 'string' && c.id.length > 0), true, '每门课都有 id');
  deepEq(c1.sectionLinks, {}, 'extractCourses 只产出课程骨架，sectionLinks 留空由爬虫阶段填充');
  deepEq(c1.errors, [], '课程骨架带着空的 errors / 列表字段');

  // 课程卡片里的文字超过 600 字时，courseContext 才会停在卡片这一层；
  // 一旦整页文字不足 600 字，所有课程都会读到“整页第一处教师标签”（见 warn）
  const twoCards = `<div class="dd" id="selfcourse">
      <div class="item">
        <a class="title" href="/f/wlxt/course/index?wlkcid=2026-2027-9000000001&courseId=1">课程甲</a>
        <p class="teacher">授课教师：甲老师</p>
      </div>
      <div class="item">
        <a class="title" href="/f/wlxt/course/index?wlkcid=2026-2027-9000000002&courseId=2">课程乙</a>
        <p class="teacher">授课教师：乙老师</p>
      </div>
    </div>`;
  const two = extractCourses(parseHTML(twoCards, COURSE_LIST_URL), COURSE_LIST_URL);
  eq(two.courses.length, 2, '两门课的短列表照样能解析出两门课');
  eq(two.courses.find((x) => x.id.endsWith('9000000001')).name, '课程甲', '短列表里第一门课的课程名正确');
  eq(two.courses.find((x) => x.id.endsWith('9000000002')).name, '课程乙', '短列表里第二门课的课程名正确');
  eq(two.courses.find((x) => x.id.endsWith('9000000001')).teacher, '甲老师', '短列表里第一门课的教师正确');
  const secondTeacher = two.courses.find((x) => x.id.endsWith('9000000002')).teacher;
  if (secondTeacher !== '乙老师') {
    warn(`短课程列表（整页文字不足 600 字）里第 2 门课读到的是第 1 门课的教师：${show(secondTeacher)}，应为 "乙老师"。`
      + 'courseContext 用原始（相对）href 调 courseKeyOf -> extractCourseKey -> parseUrlParams 里的 new URL，'
      + '相对地址解析失败就得到空 key，于是一路往上爬（src/parsers/course-list.js:48-53 与 src/common/utils.js:90-108）。'
      + '结果是“只有这一门课”的判断永远成立，唯一还能拦住它的只剩 textLen<=600，'
      + '所以卡片文字很多的正常课程列表恰好没事，短列表则会把整页第一处教师/学期/地点套到每门课上。');
  }
});

section('parsers/course-list.js：未渲染的模板页与 extractCoursesFromHtml', () => {
  const html = fixture('course-list-raw.html');
  const doc = parseHTML(html, COURSE_LIST_URL);

  const r = extractCourses(doc, COURSE_LIST_URL);
  eq(r.courses.length, 0, '未渲染的页面里 DOM 没有课程锚点，extractCourses 必然是 0 门（这是预期行为）');
  eq(r.method, 'none', '抽不到课程时 method 为 none');
  eq(doc.querySelectorAll('a[href]').length, 1, 'DOM 里只剩页头那个“退出”链接，没有课程链接');

  const fallback = extractCoursesFromHtml(html, COURSE_LIST_URL);
  eq(fallback.length, 4, 'extractCoursesFromHtml 从原始 HTML 的脚本数据里兜底找到 4 个课程 id');
  eq(fallback.map((c) => c.id).join(','),
    '2026-2027-1000000001,2026-2027-1000000102,2026-2027-1000000103,2026-2027-1000000104',
    '兜底拿到的四个 id 与 json 数据一致（{{value.kcid}} 占位符本身匹配不到，靠 json 里的字面量）');
  eq(fallback[0].url, `${ORIGIN}/f/wlxt/course/index?wlkcid=2026-2027-1000000001`, '兜底条目拼出课程主页地址');
  eq(fallback[0].incomplete, true, '兜底条目被标记 incomplete，提示还需要进一步抓取');
  eq(fallback[0].name, '', '兜底条目没有课程名');
});

section('parsers/course-list.js：extractMeta', () => {
  const meta = extractMeta('数据结构 授课教师：张三 2026-2027 学年 秋季学期 教学班：计62 课程号：2026-2027-1-30240001');
  eq(meta.teacher, '张三', 'extractMeta 读出教师');
  eq(meta.term, '2026-2027 学年 秋季学期', 'extractMeta 读出学期');
  eq(meta.klass, '计62', 'extractMeta 读出教学班');
  eq(meta.code, '2026-2027-1-30240001', 'extractMeta 读出课程号');

  const short = extractMeta('电气工程 2026-2027秋季学期');
  eq(short.term, '2026-2027秋季学期', '短学期写法也能识别');

  const none = extractMeta('（没有课程元信息的一段文字）');
  eq(none.teacher === '' && none.term === '' && none.klass === '' && none.code === '', true,
    '没有任何标签时四个字段都是空串');

  const bare = extractMeta('数据结构 张三 公告3 课件5 作业2');
  eq(bare.teacher, '', '只有裸姓名（<span class="teacherName">张三</span> 这种）时读不出教师：'
    + 'TEACHER_RE 要求“教师/老师/主讲”等标签在名字前面（src/parsers/course-list.js:13）');
});

/* ============================================================ 8. login-form */

section('parsers/login-form.js：本地登录表单', () => {
  const doc = parseHTML(fixture('login.html'), LOGIN_URL);
  const f = analyzeLoginForm(doc, LOGIN_URL);

  eq(f.found, true, '找到了带密码框的登录表单');
  eq(f.reason, 'ok', 'reason 为 ok');
  eq(f.allForms, 1, '页面上一共 1 个表单');
  eq(f.action, `${ORIGIN}/b/j_spring_security_check`, 'action 按站点自己的值解析成绝对地址');
  eq(f.method, 'post', 'method 取自表单');
  eq(f.usernameField, 'j_username', '靠字段名里的 user 语义认出账号框');
  eq(f.passwordField, 'j_password', '认出密码框');
  eq(f.passwordSelector, 'j_password', 'passwordSelector 可用于脚本填表');
  eq(f.submitField, 'submit', '认出提交按钮');
  eq(f.submitValue, '登录', '带出提交按钮的文案');
  eq(f.hasCaptcha, false, '这张表单没有验证码');
  eq(f.crossOrigin, '', '同源提交，crossOrigin 为空');
  eq(f.submittable, true, '账号 + 密码都识别到时 submittable 为 true');
  deepEq(f.fields.map((x) => x.name), ['_csrf', 'j_username', 'j_password', 'submit'],
    'fields 收集了全部带 name 的控件（含隐藏域 _csrf）');
  eq(f.fields[0].type, 'hidden', '隐藏域的类型被记录下来（csrf 要靠它）');
  eq(f.ssoLinks.includes('https://id.tsinghua.edu.cn/do/off/ui/auth/login/for/learn'), true,
    '带出页面自己的统一身份认证入口');

  eq(looksLoggedIn(doc, LOGIN_URL), false, '带密码框的页面不会被判成已登录');
});

section('parsers/login-form.js：统一身份认证 + 验证码', () => {
  const doc = parseHTML(fixture('login-captcha.html'), IAAA_URL);
  const f = analyzeLoginForm(doc, IAAA_URL);

  eq(f.found, true, '统一身份认证页也能识别出表单');
  eq(f.hasCaptcha, true, '识别出 captcha 字段 -> hasCaptcha=true');
  eq(f.captchaField, 'captcha', 'captchaField 指向 captcha 输入框');
  eq(f.captchaLikelyImage, true, 'captcha 输入框旁边有 <img>，判定为图形验证码');
  eq(f.usernameField, 'username', '账号框识别正确');
  eq(f.passwordField, 'password', '密码框识别正确');
  eq(f.action, IAAA_URL, 'action 是统一身份认证的地址');
  eq(f.crossOrigin, '', '页面地址与 action 同源时 crossOrigin 为空');
  eq(analyzeLoginForm(doc, LOGIN_URL).crossOrigin, 'https://id.tsinghua.edu.cn',
    '起点是 learn.tsinghua.edu.cn 时，指向 id.tsinghua.edu.cn 的 action 会被标记成跨域');
  eq(looksLoggedIn(doc, IAAA_URL), false, '统一身份认证的 /auth/login 地址不会被判成已登录');

  const noForm = analyzeLoginForm(parseHTML('<html><body><div>没有表单</div></body></html>'), LOGIN_URL);
  eq(noForm.found, false, '没有表单时 found=false');
  eq(noForm.reason.includes('没有 <form>'), true, 'reason 说明页面上没有 form');

  const noPwd = analyzeLoginForm(parseHTML('<html><body><form action="/x"><input name="q"></form></body></html>'), LOGIN_URL);
  eq(noPwd.found, false, '有表单但没有密码框时 found=false');
  eq(noPwd.reason.includes('没有密码输入框'), true, 'reason 说明没有密码框');

  eq(pickLoginUrl(['https://learn.tsinghua.edu.cn/x', IAAA_URL], 'https://learn.tsinghua.edu.cn/x'), IAAA_URL,
    'pickLoginUrl 优先挑统一身份认证地址');
  eq(pickLoginUrl([], LOGIN_URL), LOGIN_URL, '没有候选时回落到落地地址');

  const loggedIn = looksLoggedIn(parseHTML(fixture('course-list.html'), COURSE_LIST_URL), COURSE_LIST_URL);
  eq(loggedIn, true, '课程列表页（有“退出”链接、无密码框）判定为已登录');
});

/* ============================================================ 9. normalize */

section('api/normalize.js：toTime', () => {
  eq(toTime(1790000000000), 1790000000000, 'epoch 毫秒原样返回');
  eq(toTime(1790000000), 1790000000000, 'epoch 秒自动乘 1000');
  eq(toTime('1790000000000'), 1790000000000, '13 位数字字符串当作毫秒');
  eq(toTime('1790000000'), 1790000000000, '10 位数字字符串当作秒');
  eq(toTime('2026-09-20 23:59'), at(2026, 9, 20, 23, 59), '格式化字符串交给 parseDate');
  eq(toTime(' 2026-09-20 '), at(2026, 9, 20), '前后空白被裁掉后仍能解析');
  eq(toTime(''), null, '空串 -> null');
  eq(toTime(null), null, 'null -> null');
  eq(toTime(undefined), null, 'undefined -> null');
  eq(toTime(0), null, '0 当作缺失');
  eq(toTime(-5), null, '负数当作缺失');
  eq(toTime('不是时间'), null, '解析不了的字符串 -> null');
});

section('api/normalize.js：normalizeCourse / normalizeNotice / normalizeFile', () => {
  const c = normalizeCourse({
    kcid: W, name: '数据结构', teacherName: '张三', xnxq: '2026-2027-1',
    adress: '第六教学楼 6A216', kch: '30240001', ggundo: '3', kjundo: '5', zyundo: '2', cytls: '1',
  }, { origin: ORIGIN });
  eq(c.id, W, 'id 取自 kcid');
  eq(c.name, '数据结构', '课程名');
  eq(c.teacher, '张三', '教师名');
  eq(c.term, '2026-2027-1', '学期');
  eq(c.location, '第六教学楼 6A216', '上课地点（站点字段名是 adress）');
  eq(c.code, '30240001', '课程号');
  deepEq(c.counts, { notice: 3, file: 5, homework: 2, discuss: 1 }, '四个板块的未读/数量计数');
  eq(c.url, `${ORIGIN}${PAGE.homeworkList(W)}`, '没有 kcurl 时用 origin + 课程作业列表页兜底');
  eq(c.sectionLinks.notice, abs(PAGE.noticeList(W)), 'sectionLinks.notice 指向真实公告列表页');
  eq(c.sectionLinks.file, abs(PAGE.fileList(W)), 'sectionLinks.file 指向真实文件列表页');
  eq(c.sectionLinks.homework, abs(PAGE.homeworkList(W)), 'sectionLinks.homework 指向真实作业列表页');
  eq(normalizeCourse({ kcid: '9' }).name, '课程 9', '没有课程名时用“课程 <id>”兜底');
  eq(normalizeCourse({}), null, '没有课程 id 时返回 null');
  eq(normalizeCourse({ kcurl: '/f/wlxt/course/index?wlkcid=1' }), null, '没有课程 id 时即便有 kcurl 也返回 null');
  eq(normalizeCourse({ kcid: '1', kcurl: '/f/wlxt/course/index?wlkcid=1' }).url, `${ORIGIN}/f/wlxt/course/index?wlkcid=1`,
    '有 kcurl 时优先用它，并且补成绝对地址');

  const n = normalizeNotice({ bt: '关于期中考试的通知', fbr: '李四', fbsj: '2026-09-01 10:30', ggid: '123', sfqd: '1', ydsj: '' }, W, NOW);
  eq(n.id, `gg:${W}:123`, '公告 id 带课程前缀');
  eq(n.title, '关于期中考试的通知', '公告标题');
  eq(n.url, abs(PAGE.noticeDetail(W, '123')), '公告详情地址与站点一致');
  eq(n.date, at(2026, 9, 1, 10, 30), '发布时间');
  eq(n.author, '李四', '发布者');
  eq(n.pinned, true, 'sfqd=1 -> 置顶');
  eq(n.unread, true, 'ydsj 为空 -> 未读');
  eq(n.section, 'notice', 'section 标记为 notice');
  eq(n.fetchedAt, NOW, 'fetchedAt 用传入的 now');
  eq(normalizeNotice({ bt: 'x', ydsj: '2026-09-02 08:00' }, W, NOW).unread, false, '有阅读时间 -> 已读');
  eq(normalizeNotice({}, W, NOW), null, '没有标题的公告返回 null');

  const f = normalizeFile({ bt: '第1章 绪论.pdf', wjlx: 'PDF', wjdx: '1.2 MB', scsj: '2026-09-02 09:00', wjid: '501' }, W, NOW);
  eq(f.id, `wj:${W}:501`, '文件 id');
  eq(f.size, 1258291, 'size 从“1.2 MB”解析出来');
  eq(f.ext, 'pdf', '扩展名');
  eq(f.fileKind, 'pdf', '文件分类');
  eq(f.url, abs(PAGE.fileList(W)), '文件条目指回列表页');
  eq(f.downloadUrl, abs(PAGE.fileDownload('501')), 'downloadUrl 是站点自己的下载接口');
  eq(f.downloadBeforeUrl, abs(PAGE.fileDownloadBefore('501')), 'downloadBeforeUrl 是下载前确认接口');
  eq(f.date, at(2026, 9, 2, 9, 0), '上传时间');
  eq(normalizeFile({ bt: 'a.zip', wjdx: 2048 }, W, NOW).size, 2048, '接口直接给数字大小时原样使用');
  eq(normalizeFile({}, W, NOW), null, '没有标题的文件返回 null');
});

section('api/normalize.js：normalizeHomework 与站点链接规则', () => {
  const row = {
    bt: '第一次作业', zt: '未交', pyzt: '未批阅',
    jzsj: 1790000000000, jzsjStr: '2026-09-20 23:59',
    zyid: '1', xszyid: '2', zywcfs: '1',
  };
  const hw = normalizeHomework(row, W, NOW_HW);

  eq(hw.title, '第一次作业', '标题');
  eq(hw.id, `zy:${W}:2`, 'id 优先用 xszyid');
  eq(hw.deadline, 1790000000000, 'deadline 优先取 jzsj（毫秒时间戳）而不是 jzsjStr');
  eq(hw.deadlineText, '2026-09-20 23:59', 'deadlineText 保留站点给的显示文本');
  eq(hw.completed, false, 'zt=未交 -> completed=false');
  eq(hw.status, 'pending', 'zt=未交 -> status=pending');
  eq(hw.statusText, '未提交', '状态文案');
  eq(hw.mode, '个人', 'zywcfs=1 -> 个人');
  eq(hw.zt, '未交', '原始状态字段被保留');
  eq(hw.pyzt, '未批阅', '原始批阅状态字段被保留');
  eq(hw.submitUrl, abs(PAGE.homeworkSubmit(W, '2')), 'submitUrl 指向站点自己的提交页');
  eq(hw.listUrl, abs(PAGE.homeworkList(W)), 'listUrl 指向作业列表页');
  eq(hw.section, 'homework', 'section 标记为 homework');
  eq(hw.fetchedAt, NOW_HW, 'fetchedAt 用传入的 now');
  eq(hw.disabled === undefined, true, '没有多余的禁用字段');

  eq(hw.url, abs(homeworkUrl({
    wlkcid: W, zyid: '1', xszyid: '2', zt: '未交', pyzt: '未批阅',
    deadline: 1790000000000, now: NOW_HW,
  })), 'url 必须由 endpoints.homeworkUrl 这条“站点自己的规则”生成');
  eq(hw.url.includes('sfgq=1'), true, '截止时间已过（相对固定 now）-> sfgq=1');
  eq(hw.url.includes('viewZy'), true,
    'zt=未交 一律落到 viewZy（查看/提交作业），不受 pyzt 影响');

  const done = normalizeHomework({ bt: '第二次作业', zt: '已交', pyzt: '未批阅', jzsj: at(2026, 10, 5, 23, 59), zyid: '3', xszyid: '4' }, W, NOW_HW);
  eq(done.completed, true, 'zt=已交 -> completed=true');
  eq(done.status, 'done', 'zt=已交 -> status=done');
  eq(done.statusText, '已提交 · 待批阅', '已交未批阅的状态文案');
  eq(done.url, `${ORIGIN}/f/wlxt/kczy/zy/student/viewTj?wlkcid=${W}&sfgq=0&zyid=3&xszyid=4`,
    '已交待批阅 -> viewTj，且截止时间未到所以 sfgq=0');

  const graded = normalizeHomework({ bt: '第三次作业', zt: '已交', pyzt: '已批改', cj: '95', zyid: '9', xszyid: '10', jzsj: at(2026, 9, 25, 23, 59) }, W, NOW_HW);
  eq(graded.completed, true, '已批改也是 completed=true');
  eq(graded.statusText, '已提交 · 已批改', '已交已批改的状态文案');
  eq(graded.grade, '95', '成绩被保留');
  eq(graded.url, `${ORIGIN}/f/wlxt/kczy/zy/student/viewCj?wlkcid=${W}&zyid=9&xszyid=10`,
    'pyzt=已批改 -> viewCj，且地址里不带 sfgq');

  eq(normalizeHomework({ bt: '小组作业', zt: '未交', zywcfs: '2' }, W, NOW_HW).mode, '小组', 'zywcfs=2 -> 小组');
  eq(normalizeHomework({ zt: '未交' }, W, NOW_HW), null, '没有标题的作业返回 null');
  eq(normalizeHomework({ bt: '状态异常', zt: '什么鬼', pyzt: '' }, W, NOW_HW).status, 'unknown', '状态字段意外时 status=unknown');
  eq(normalizeHomework({ bt: '状态异常', zt: '什么鬼', pyzt: '' }, W, NOW_HW).statusText, '状态未知', '状态字段意外时的文案');
});

section('api/normalize.js：idsFromHomeworkUrl / fromDomItem / fromScrapedItem（DOM 兜底路径）', () => {
  deepEq(idsFromHomeworkUrl(`${ORIGIN}/f/wlxt/kczy/zy/student/viewZy?wlkcid=${W}&sfgq=0&zyid=1&xszyid=2`),
    { wlkcid: W, zyid: '1', xszyid: '2', view: 'viewZy' },
    'idsFromHomeworkUrl 从作业地址里同时抠出 wlkcid / zyid / xszyid 和“哪个详情页”');
  eq(idsFromHomeworkUrl(`${ORIGIN}/f/wlxt/kczy/zy/student/viewCj?wlkcid=${W}&zyid=9&xszyid=10`).view, 'viewCj',
    'viewCj 被识别出来（状态由站点自己的链接决定，不靠文本猜）');
  deepEq(idsFromHomeworkUrl(''), { wlkcid: '', zyid: '', xszyid: '', view: '' }, '空地址返回四个空字段');
  eq(idsFromHomeworkUrl('https://learn.tsinghua.edu.cn/f/wlxt/kczy/zy/student/tijiao?wlkcid=1&xszyid=7').view, 'tijiao',
    'tijiao（提交页）也被识别');

  // ------- fromDomItem：parseSectionPage 的条目 -> 统一模型 -------
  const hwParsed = parseSectionPage(parseHTML(fixture('homework-list.html'), HW_URL), HW_URL, 'homework', { now: NOW_HW });
  const hwMapped = hwParsed.items.map((it) => fromDomItem(it, 'homework', W, NOW_HW)).filter(Boolean);
  eq(hwMapped.length, 4, '四行作业都能映射成统一模型');

  const m1 = hwMapped.find((m) => m.title === '第一次作业');
  eq(m1.id, hwParsed.items.find((i) => i.title === '第一次作业').id,
    'id 沿用 DOM 条目自己的稳定 id（buildItem 的哈希，不是 API 路径的 zy:<wlkcid>:<xszyid> 形式）');
  eq(m1.zt, '未交', 'viewZy 链接被翻译成“未交”——链接本身就编码了状态');
  eq(m1.pyzt, '', 'viewZy 不带批阅状态');
  eq(m1.completed, false, '未交 -> completed=false（DOM 兜底路径也有这个字段）');
  eq(m1.status, 'pending', '未交 -> status=pending');
  eq(m1.statusText, '未提交', '状态文案');
  eq(m1.deadline, at(2026, 9, 20, 23, 59), '截止时间沿用 DOM 条目里已经解析好的 epoch ms');
  eq(m1.source, 'tab-dom', 'source 标记为 tab-dom');
  eq(m1.submitUrl, abs(PAGE.homeworkSubmit(W, '2')), 'submitUrl 指向站点自己的提交页');

  const m2 = hwMapped.find((m) => m.title === '第二次作业');
  eq(m2.zt, '已交', 'viewTj 链接 -> 已交');
  eq(m2.pyzt, '未批阅', 'viewTj -> 未批阅');
  eq(m2.completed, true, '已交 -> completed=true');
  eq(m2.statusText, '已提交 · 待批阅', '已交未批阅文案');

  const m3 = hwMapped.find((m) => m.title === '第三次作业（实验报告）');
  eq(m3.zt, '已交', 'viewCj 链接 -> 已交');
  eq(m3.pyzt, '已批改', 'viewCj -> 已批改');
  eq(m3.completed, true, '已批改 -> completed=true');
  eq(m3.statusText, '已提交 · 已批改', '已交已批改文案');
  eq(m3.url, `${ORIGIN}/f/wlxt/kczy/zy/student/viewCj?wlkcid=${W}&zyid=9&xszyid=10`, 'url 原样沿用站点地址');

  const fileParsed = parseSectionPage(parseHTML(fixture('file-list.html'), FILE_URL), FILE_URL, 'file', { now: NOW });
  const fm = fileParsed.items.map((it) => fromDomItem(it, 'file', W, NOW)).find((m) => m.title === '第1章 绪论.pdf');
  eq(fm.size, 2097152, '文件大小沿用 DOM 条目里解析好的字节数');
  eq(fm.ext, 'pdf', '扩展名');
  eq(fm.date, at(2026, 9, 2, 9, 0), '上传时间');
  eq(fm.url, abs(PAGE.fileList(W)), '文件条目指回列表页');
  eq(fm.section, 'file', 'section 标记');

  const noticeParsed = parseSectionPage(parseHTML(fixture('notice-list.html'), NOTICE_URL), NOTICE_URL, 'notice', { now: NOW });
  const nm = noticeParsed.items.map((it) => fromDomItem(it, 'notice', W, NOW)).find((m) => m.title === '关于期中考试的通知');
  eq(nm.url, abs(PAGE.noticeDetail(W, '123')), '公告条目沿用绝对化的详情地址');
  eq(nm.date, at(2026, 9, 1, 10, 30), '公告时间');
  eq(nm.section, 'notice', 'section 标记');
  eq(fromDomItem(null, 'notice', W, NOW), null, 'fromDomItem(null) 返回 null');
  eq(fromDomItem({ title: '' }, 'notice', W, NOW), null, '没有标题的 DOM 条目返回 null');

  // ------- fromScrapedItem：内容脚本按表头读到的行 -> 统一模型 -------
  const scrapedDone = fromScrapedItem({
    title: '第一次作业',
    url: `${ORIGIN}/f/wlxt/kczy/zy/student/viewZy?wlkcid=${W}&sfgq=0&zyid=1&xszyid=2`,
    cells: { title: '第一次作业', deadline: '2026-09-20 23:59', submit: '', teacher: '', grade: '', mode: '个人', status: '未提交' },
    rowText: '第一次作业 个人 未提交 2026-09-20 23:59',
  }, 'homework', W, NOW_HW);
  eq(scrapedDone.zt, '未交', '内容脚本路径同样用链接判断状态');
  eq(scrapedDone.completed, false, '未交 -> completed=false');
  eq(scrapedDone.deadline, at(2026, 9, 20, 23, 59), 'deadline 直接解析“截止日期”那一列的文本');
  eq(scrapedDone.deadlineText, '2026-09-20 23:59', 'deadlineText 保留原始显示文本');
  eq(scrapedDone.mode, '个人', '完成方式'); 
  eq(scrapedDone.source, 'tab-dom', 'source 标记为 tab-dom');

  const scrapedGraded = fromScrapedItem({
    title: '第三次作业',
    url: `${ORIGIN}/f/wlxt/kczy/zy/student/viewCj?wlkcid=${W}&zyid=9&xszyid=10`,
    cells: { deadline: '2026-09-25 23:59', grade: '95', teacher: '王五', mode: '小组' },
    rowText: '第三次作业 小组 2026-09-25 23:59 王五 95',
  }, 'homework', W, NOW_HW);
  eq(scrapedGraded.zt, '已交', 'viewCj -> 已交');
  eq(scrapedGraded.completed, true, '已批改 -> completed=true');
  eq(scrapedGraded.statusText, '已提交 · 已批改', '已批改文案');
  eq(scrapedGraded.grade, '95', '成绩');
  eq(scrapedGraded.teacher, '王五', '批阅教师');
  eq(scrapedGraded.mode, '小组', '完成方式含“小组” -> 小组');

  const scrapedFile = fromScrapedItem({
    title: '第1章 绪论.pdf',
    url: `${ORIGIN}/b/wlxt/kj/wlkc_kjxxb/student/downloadFile?sfgk=0&wjid=501`,
    cells: { type: 'PDF', size: '1.2 MB', date: '2026-09-02 09:00' },
    rowText: '第1章 绪论.pdf PDF 1.2 MB 2026-09-02 09:00',
  }, 'file', W, NOW);
  eq(scrapedFile.size, 1258291, '文件大小从“大小”列解析');
  eq(scrapedFile.ext, 'pdf', '扩展名');
  eq(scrapedFile.downloadUrl, `${ORIGIN}/b/wlxt/kj/wlkc_kjxxb/student/downloadFile?sfgk=0&wjid=501`, 'downloadUrl 就是行里那个下载链接');
  eq(scrapedFile.url, abs(PAGE.fileList(W)), 'url 指回列表页');
  eq(scrapedFile.date, at(2026, 9, 2, 9, 0), '上传时间');

  const scrapedNotice = fromScrapedItem({
    title: '关于期中考试的通知',
    url: `${ORIGIN}/f/wlxt/kcgg/wlkc_ggb/student/beforeViewXs?wlkcid=${W}&id=123`,
    cells: { author: '李四', date: '2026-09-01 10:30' },
    rowText: '关于期中考试的通知 李四 2026-09-01 10:30',
  }, 'notice', W, NOW);
  eq(scrapedNotice.author, '李四', '发布者');
  eq(scrapedNotice.date, at(2026, 9, 1, 10, 30), '发布时间');
  eq(scrapedNotice.section, 'notice', 'section 标记');
  eq(fromScrapedItem({}, 'notice', W, NOW), null, '没有标题的抓取行返回 null');
});

section('api/normalize.js：pickSemester', () => {
  eq(pickSemester([{ xnxq: '2026-2027-1', sfdq: '1' }, { xnxq: '2025-2026-2' }]), '2026-2027-1', '优先取 sfdq=1 的当前学期');
  eq(pickSemester([{ xnxq: '2025-2026-2' }, { xnxq: '2026-2027-1' }]), '2025-2026-2', '没有当前学期标记时取第一个');
  eq(pickSemester({ resultList: [{ xnxq: '2025-2026-2' }] }), '2025-2026-2', '支持 {resultList:[...]} 外壳');
  eq(pickSemester({ data: [{ code: '2026-2027-2' }] }), '2026-2027-2', '支持 {data:[...]} 外壳与 code 字段');
  eq(pickSemester([{ id: '2026-2027-1', current: true }]), '2026-2027-1', 'current=true 也算当前学期');
  eq(pickSemester(null, '兜底'), '兜底', '空值返回兜底值');
  eq(pickSemester([], '兜底'), '兜底', '空数组返回兜底值');
  eq(pickSemester([{ nope: 1 }], '兜底'), '兜底', '取不到学期码时返回兜底值');
});

/* ------------------------------------------------- 10. 回归：曾经的真实缺陷已修复 */

/**
 * 这一组最初是“刻划测试”，用来把子代理审查出的 9 个真实缺陷固定下来。
 * 缺陷修好之后，它被改写成**回归测试**：每条都断言修复后的正确行为，
 * 保证这些坑不会被重新踩回去。每条 msg 里都写了当初为什么会错。
 */
section('回归：曾被审查发现的缺陷已修复', () => {
  // 1) 站点真实列表页地址必须能被 detectPageKind 的 URL 正则认出来
  const blank = parseHTML('<html><body></body></html>');
  eq(detectPageKind(blank, NOTICE_URL), 'notice',
    '真实公告地址 /f/wlxt/kcgg/… 必须判为 notice（原正则只认 gg|notice）');
  eq(detectPageKind(blank, FILE_URL), 'file',
    '真实文件地址 /f/wlxt/kj/… 必须判为 file（原正则只认 wj|file）');
  eq(detectPageKind(blank, HW_URL), 'homework',
    '真实作业地址 /f/wlxt/kczy/zy/… 必须判为 homework（原正则只认 sz|homework|zy）');

  // 2) 作业页导航里有「公告」也不能被误判成公告页
  const hwWithNav = fixture('homework-list.html').replace(
    '<h1 class="course-name">数据结构</h1>',
    `<h1 class="course-name">数据结构</h1><nav class="nav"><a href="${PAGE.noticeList(W)}">公告</a></nav>`,
  );
  eq(detectPageKind(parseHTML(hwWithNav, HW_URL), HW_URL), 'homework',
    '作业页导航里出现「公告」也必须判为 homework（原实现先判公告）');

  // 3) 行里没有「截止」二字时取最晚的日期，并标记为推定
  const inf = extractDeadline('第四次作业 2026-09-30 09:10 2026-10-08 23:59', NOW_HW);
  eq(inf.deadline, at(2026, 10, 8, 23, 59),
    '提交日期排在前面时不能把提交时间当截止时间，取最晚的那个');
  eq(String(inf.reason).startsWith('inferred'), true, '推定出来的截止时间必须标成 inferred，面板会显示「推定」');

  // 4) 「1.2 MB」不能再被当成 1 月 2 日
  eq(parseDate('1.2 MB', NOW), null, '「1.2 MB」不是日期（原实现读成 1 月 2 日）');
  eq(extractPublishDate('第1章 绪论.pdf PDF 1.2 MB 2026-09-02 09:00', NOW), at(2026, 9, 2, 9, 0),
    '有小数大小时，上传时间仍要取到真正的日期');

  // 5) 每行两个链接时，必须选 table tbody tr 而不是 td 级 repeated 组
  const tdHeavy = `<table><tbody>
      <tr><td><a href="/f/wlxt/kj/wlkc_kjxxb/student/beforeViewXs?wlkcid=${W}&wjid=601">第一章 数据结构绪论.pdf</a></td><td>PDF</td><td><a href="/b/wlxt/kj/wlkc_kjxxb/student/downloadFile?sfgk=0&wjid=601">下载</a></td></tr>
      <tr><td><a href="/f/wlxt/kj/wlkc_kjxxb/student/beforeViewXs?wlkcid=${W}&wjid=602">第二章 线性表与链表.pdf</a></td><td>PDF</td><td><a href="/b/wlxt/kj/wlkc_kjxxb/student/downloadFile?sfgk=0&wjid=602">下载</a></td></tr>
      <tr><td><a href="/f/wlxt/kj/wlkc_kjxxb/student/beforeViewXs?wlkcid=${W}&wjid=603">第三章 树与二叉树.pdf</a></td><td>PDF</td><td><a href="/b/wlxt/kj/wlkc_kjxxb/student/downloadFile?sfgk=0&wjid=603">下载</a></td></tr>
    </tbody></table>`;
  const tdRes = extractListItems(parseHTML(tdHeavy, FILE_URL), FILE_URL, { kind: 'file', now: NOW });
  eq(tdRes.method.startsWith('selector:table tbody tr'), true,
    `必须选中行级候选而不是 td 级（实际选中 ${tdRes.method}）；选组要按“数量 × 质量”打分`);
  eq(tdRes.items.length, 3, '3 行就是 3 条，不能因为每行两个链接就翻倍成 6 条');
  eq(tdRes.items.filter((i) => i.title === '下载').length, 0,
    '「下载」是按钮不是数据，标题整个等于操作词的条目必须丢弃');

  // 6) 短课程列表里每门课必须拿到自己的教师
  const short = extractCourses(parseHTML(`<div class="dd" id="selfcourse">
      <div class="item"><a class="title" href="/f/wlxt/course/index?wlkcid=2026-2027-9000000001&courseId=1">课程甲</a><p class="teacher">授课教师：甲老师</p></div>
      <div class="item"><a class="title" href="/f/wlxt/course/index?wlkcid=2026-2027-9000000002&courseId=2">课程乙</a><p class="teacher">授课教师：乙老师</p></div>
    </div>`, COURSE_LIST_URL), COURSE_LIST_URL);
  eq(short.courses.find((x) => x.id.endsWith('9000000001')).teacher, '甲老师', '课程甲拿到甲老师');
  eq(short.courses.find((x) => x.id.endsWith('9000000002')).teacher, '乙老师',
    '课程乙必须拿到乙老师（原实现把相对 href 直接喂给 new URL 取 key，守卫失效后会继承第一张卡片）');

  // 7) 站点原样的 <span class="teacherName">张三</span>（前面没有「授课教师」标签）也要读得出教师
  const bare = extractCourses(parseHTML(`<div class="dd" id="selfcourse">
      <div class="item"><input class="wlkcid" type="hidden" value="2026-2027-1000000001">
        <a class="title" href="/f/wlxt/course/index?wlkcid=2026-2027-1000000001&courseId=9">数据结构</a>
        <span class="teacherName">张三</span></div>
    </div>`, COURSE_LIST_URL), COURSE_LIST_URL);
  eq(bare.courses[0] && bare.courses[0].teacher, '张三', '裸的 .teacherName 节点也要能被读到');
});

/* ------------------------------------------------- 11. 会话判定（登录态误判回归） */

/**
 * 这一组针对一个真实上报的问题：“登录之后面板仍然显示未登录”。
 * 根因有三个，全部在这里钉死：
 *   A. 旧实现把「课程列表页发生重定向」当成未登录，但站点对已登录的请求也会重定向
 *      （URL 重写 jsessionid / 追加 websiteShowLanguage 参数）；
 *   B. 旧实现用 /j_spring_security/ 当登录页标记，而它同样匹配
 *      /f/j_spring_security_logout —— 那恰恰是登录之后才出现的退出链接；
 *   C. 界面侧从不重新校验会话，只显示上次缓存的旧状态（在 UI 代码里，不在本组）。
 */
section('auth.js：会话判定（登录态误判回归）', () => {
  const apiJsonOk = { kind: 'json', status: 200, url: 'https://learn.tsinghua.edu.cn/b/kc/zhjw_v_code_xnxq/getCurrentAndNextSemester', json: { resultList: [] } };
  const apiRedirect = { kind: 'redirect', status: 0, url: 'https://learn.tsinghua.edu.cn/b/...' };
  const apiHtml = { kind: 'html', status: 200, url: 'https://learn.tsinghua.edu.cn/b/...', snippet: '<!DOCTYPE html><html>' };
  const apiError = { kind: 'error', status: 0, url: 'https://learn.tsinghua.edu.cn/b/...', reason: 'Failed to fetch' };

  // 接口返回 JSON 是“已登录”的权威证据
  eq(decideSession(apiJsonOk, null).loggedIn, true, '接口返回 JSON -> 已登录');
  eq(decideSession(apiJsonOk, null).via, 'api-json', '并且明确标注依据是 api-json');

  // 接口被重定向 / 返回 HTML 是“未登录”的权威证据
  eq(decideSession(apiRedirect, null).loggedIn, false, '接口被重定向 -> 未登录');
  eq(decideSession(apiHtml, null).loggedIn, false, '接口返回 HTML（登录页）-> 未登录');
  eq(decideSession(apiError, null).loggedIn, false, '接口网络错误且没有页面证据 -> 不能假装已登录');

  // 【缺陷 A 回归】接口不可用时，页面即使发生过重定向，只要有课程容器就算已登录
  const pageRedirectedButOk = { status: 200, redirected: true, finalUrl: `https://learn.tsinghua.edu.cn/f/wlxt/index/course/student/;jsessionid=ABC.wlxt20181?websiteShowLanguage=zh_CN`, hasPasswordInput: false, isLoginUrl: false, hasCourseShell: true };
  const dA = decideSession(apiError, pageRedirectedButOk);
  eq(dA.loggedIn, true, '【缺陷 A】课程列表页发生过重定向（URL 重写 jsessionid）也必须判为已登录');
  eq(dA.via, 'page-shell', '依据应为 page-shell（页面里有课程容器）');

  // 【缺陷 B 回归】页面上的“退出登录”链接不能被当成登录页特征
  const loggedInHtml = `<html><body><div id="selfcourse"><div class="item"><a class="title" href="/f/wlxt/course/index?wlkcid=X">数据结构</a></div></div>
    <a href="/f/j_spring_security_logout">退出登录</a></body></html>`;
  const clsB = classifyPageHtml(loggedInHtml, 'https://learn.tsinghua.edu.cn/f/wlxt/index/course/student/');
  eq(clsB.hasPasswordInput, false, '【缺陷 B】页面里有 /f/j_spring_security_logout 退出链接，也不能被当成登录页（旧实现用 /j_spring_security/ 前缀匹配，必然误判）');
  eq(clsB.hasCourseShell, true, '同时应当识别出课程容器这一正向证据');
  eq(decideSession(apiError, { status: 200, ...clsB }).loggedIn, true, '【缺陷 B】接口不可用时，凭退出链接+课程容器也要判为已登录');

  // 真正的登录页仍然要能判出来
  const loginHtml = `<html><body><form action="/b/j_spring_security_check" method="post">
      <input name="j_username"><input type="password" name="j_password"></form></body></html>`;
  const clsLogin = classifyPageHtml(loginHtml, 'https://learn.tsinghua.edu.cn/f/login');
  eq(clsLogin.hasPasswordInput, true, '真正的登录页仍要能识别（有密码输入框）');
  eq(clsLogin.marker.toLowerCase().includes('j_spring_security_check'), true, '登录页标记应命中 j_spring_security_check');
  eq(decideSession(apiError, { status: 200, ...clsLogin }).loggedIn, false, '真正的登录页 -> 未登录');
  eq(decideSession(apiError, { status: 200, ...clsLogin, isLoginUrl: true }).via, 'page-password', '密码框优先于 URL 判断');

  // 【缺陷 D 回归】后台 fetch 带不上 cookie 时，要采信标签页里的同源证据
  const tabLoggedIn = { ok: true, loggedIn: true, hasCourseShell: true, renderedCourses: 8, title: '网络学堂', href: 'https://learn.tsinghua.edu.cn/f/wlxt/index/course/student/' };
  const dD = decideSession(apiRedirect, null, tabLoggedIn);
  eq(dD.loggedIn, true, '【缺陷 D】后台接口被重定向、但标签页里课程已渲染 -> 应判为已登录（后台请求没带上 cookie，抓取会走页面兜底）');
  eq(dD.via, 'tab', '依据应为 tab');
  eq(dD.detail.includes('cookie'), true, '并且要提示这个矛盾，方便定位后台请求为何没带上 cookie');
  eq(decideSession(apiRedirect, null, { ok: true, loggedIn: true, hasCourseShell: false, renderedCourses: 0 }).loggedIn, false,
    '标签页在登录页上（没有课程容器）时不能采信');
  eq(decideSession(apiJsonOk, null, null).via, 'api-json', '接口有 JSON 时仍以接口为准');
});

/* ------------------------------------------------- 12. 导航菜单不得被当成列表内容 */

/**
 * 复现真实上报的现象：课程页左侧导航里列着**所有课程**（每门课的导航都一样），
 * 右侧才是真正的作业表。旧实现会退到裸 `li` 选择器，把整份导航当成作业列表 ——
 * 于是每门课都抓到同一份内容，面板上看就像“课程被重复列举了好多次”。
 */
section('真实场景：左侧课程导航不得被当成列表内容', () => {
  const navItems = Array.from({ length: 17 }, (_, i) =>
    `<li><a href="/f/wlxt/course/index?wlkcid=2026-2027-10000000${String(i).padStart(2, '0')}">课程${i}</a></li>`).join('');
  const table =
    `<table id="zyalltable" class="table zuoye dataTable">
      <thead><tr><th>作业题目</th><th>完成方式</th><th>状态</th><th>截止日期</th><th>提交日期</th></tr></thead>
      <tbody>
        <tr><td><a href="/f/wlxt/kczy/zy/student/viewZy?wlkcid=${W}&sfgq=0&zyid=1&xszyid=11">第一次作业</a></td><td>个人</td><td>未提交</td><td>2026-10-08 23:59</td><td></td></tr>
        <tr><td><a href="/f/wlxt/kczy/zy/student/viewZy?wlkcid=${W}&sfgq=0&zyid=2&xszyid=12">第二次作业</a></td><td>个人</td><td>未提交</td><td>2026-10-15 23:59</td><td></td></tr>
        <tr><td><a href="/f/wlxt/kczy/zy/student/viewZy?wlkcid=${W}&sfgq=0&zyid=3&xszyid=13">第三次作业</a></td><td>小组</td><td>未提交</td><td>2026-10-22 23:59</td><td></td></tr>
      </tbody></table>`;
  const page = `<html><body>
      <div class="navlef"><ul class="droppanel">${navItems}</ul></div>
      <div class="rtcon">${table}</div>
    </body></html>`;

  const r = extractListItems(parseHTML(page, HW_URL), HW_URL, { kind: 'homework', now: NOW_HW });
  eq(r.items.length, 3, '只应抽出 3 条真实作业，而不是 17 条导航项');
  eq(r.method, 'selector:#zyalltable tbody tr', '必须命中站点自己的作业表容器');
  eq(r.items.every((i) => /第一次作业|第二次作业|第三次作业/.test(i.title)), true, '抽出来的标题必须都是作业名');
  eq(r.items.some((i) => /^课程\d+$/.test(i.title)), false, '不能把课程导航项当成作业');
  eq(r.items.every((i) => i.deadline !== null), true, '三条作业都应解析出截止时间');
  eq(r.items[0].deadline, at(2026, 10, 8, 23, 59), '截止时间取的是「截止日期」列，而不是别的日期');

  // 更极端：页面上只有导航、没有真实列表 —— 宁可为空，也不能把导航当成作业
  const navOnly = `<html><body><div class="navlef"><ul class="droppanel">${navItems}</ul></div>
      <div class="rtcon"><p>暂无数据</p></div></body></html>`;
  const only = extractListItems(parseHTML(navOnly, HW_URL), HW_URL, { kind: 'homework', now: NOW_HW });
  eq(only.items.length, 0,
    '只有导航时应当返回 0 条（链接特征闸门会否掉所有候选）——这正是“每门课抓到同一份内容”的根治点');
});

/* ------------------------------------------------- 13. 学到的接口模板（重放） */

/**
 * 接口参数靠猜的结果是 10 门课全部退回页面兜底（真实数据）。
 * 所以改成“让站点自己告诉我们”：嗅探它渲染列表时发的请求，之后把课程 id 换掉重放。
 * 这里钉死“换得对不对”——换错就会拿 A 课的模板去请求 B 课的数据。
 */
section('api/learned.js：接口模板重放', () => {
  const captured = `https://learn.tsinghua.edu.cn/b/kc/v_xszy_search/student/pageList?v=1&sEcho=1&iDisplayStart=0&iDisplayLength=20&_=1789704024943&_csrf=00000000-21b9-4bd1-a631-de101a294c81&defaultSearchCondition=${encodeURIComponent('[{"name":"wlkcid","value":"2026-2027-1000000001"}]')}`;
  const r = retargetRequest({ url: captured, method: 'GET' }, '2026-2027-9999999999', 'NEW-CSRF');
  ok(r !== null, '能识别并改造网络学堂自己的请求');
  const u = new URL(r.url);
  eq(u.searchParams.get('_csrf'), 'NEW-CSRF', '_csrf 换成当前会话的令牌');
  eq(u.searchParams.get('_'), null, '去掉易变的 _ 时间戳参数');
  eq(u.searchParams.get('iDisplayLength'), '20', '无关参数原样保留');
  const cond = JSON.parse(u.searchParams.get('defaultSearchCondition'));
  eq(cond[0].value, '2026-2027-9999999999', '检索条件里的课程 id 被换成目标课程（换错就会拿到别的课的数据）');
  eq(cond[0].name, 'wlkcid', '检索条件名不动');

  // 普通参数形式的课程 id
  const plain = retargetRequest({ url: 'https://learn.tsinghua.edu.cn/b/wlxt/kcgg/wlkc_ggb/student/pageListXsSearch?v=1&wlkcid=2026-2027-1000000001' }, 'X2', 'C2');
  eq(new URL(plain.url).searchParams.get('wlkcid'), 'X2', 'URL 参数里的 wlkcid 也会被替换');
  eq(new URL(plain.url).searchParams.get('_csrf'), 'C2', '没有 _csrf 参数时会补上当前的');

  // 没有令牌时应当删掉，而不是留一个过期的
  const noCsrf = retargetRequest({ url: captured }, 'X3', '');
  eq(new URL(noCsrf.url).searchParams.get('_csrf'), null, '没有令牌时删除 _csrf，避免用过期令牌请求');

  // 不该碰的请求
  eq(retargetRequest({ url: 'https://example.com/b/wlxt/x/pageList' }, 'X', 'C'), null, '非网络学堂域名一律拒绝');
  eq(retargetRequest({ url: 'not a url' }, 'X', 'C'), null, '非法地址返回 null 而不是抛错');
  eq(retargetRequest(null, 'X', 'C'), null, '空输入返回 null');

  // 检索条件的 JSON 改造
  eq(JSON.parse(retargetConditionJson('[{"name":"wlkcid","value":"A"},{"name":"other","value":"A"}]', 'B'))[0].value, 'B',
    '条件数组里的课程 id 被替换');
  eq(JSON.parse(retargetConditionJson('[{"name":"wlkcid","value":"A"},{"name":"other","value":"A"}]', 'B'))[1].value, 'A',
    '非课程 id 字段绝不改动');
  eq(retargetConditionJson('不是 JSON', 'B'), '不是 JSON', '非法 JSON 原样返回，不抛错');

  // 模板归类
  const tpls = pickTemplates([
    { url: 'https://learn.tsinghua.edu.cn/b/wlxt/kcgg/wlkc_ggb/student/pageListXsSearch?v=1&defaultSearchCondition=%5B%5D', status: 200 },
    { url: 'https://learn.tsinghua.edu.cn/b/wlxt/kc/v_kjxxb_wjwjb_search/xspageList?v=1', status: 200 },
    { url: 'https://learn.tsinghua.edu.cn/b/kc/v_xszy_search/student/pageList?v=1&defaultSearchCondition=%5B%5D', status: 200 },
    { url: 'https://learn.tsinghua.edu.cn/f/wlxt/index/course/student/', status: 200 },
  ]);
  eq(!!tpls.notice, true, '公告模板被认出来（kcgg）');
  eq(!!tpls.file, true, '文件模板被认出来（kjxxb / wjwjb）');
  eq(!!tpls.homework, true, '作业模板被认出来（xszy）');
  eq(Object.keys(tpls).length, 3, '课程列表页不会被误当成列表接口');
  eq(pickTemplates([]).notice, undefined, '没有记录时不产生模板');
});

/* ------------------------------------------------- 14. 空表占位行 + aoData 重放 */

/**
 * 两条都来自真实诊断包：
 *  1) 某门课的作业里出现「没有您要搜索的内容」「表中数据为空」——
 *     那是 DataTables 在无数据时塞进 tbody 的占位行，长得和真数据一样。
 *  2) 站点的真实请求是 POST + `aoData=<JSON 数组>`（DataTables 1.9 格式），
 *     端点也不是 pageListXsSearch 而是 pageListXsbyWgq；
 *     旧实现只认 defaultSearchCondition，body 里的课程 id 从没被替换过。
 */
section('真实场景：空表占位行与 aoData 重放', () => {
  // 1) 空表占位行不能被当成条目
  const emptyTable = `<html><body><table id="zyalltable" class="table dataTable">
      <thead><tr><th>作业题目</th><th>截止日期</th></tr></thead>
      <tbody><tr class="odd"><td valign="top" colspan="2" class="dataTables_empty">没有您要搜索的内容</td></tr></tbody>
    </table></body></html>`;
  const empty = parseSectionPage(parseHTML(emptyTable, HW_URL), HW_URL, 'homework', { now: NOW_HW });
  eq(empty.items.length, 0, '「没有您要搜索的内容」不能被当成作业');
  eq(empty.items.some((i) => /搜索的内容|数据为空/.test(i.title)), false, '任何空表提示都不该出现在条目里');

  // 与真数据混在一页时，只留真数据
  const mixed = `<html><body>
    <table id="zyalltable" class="table dataTable">
      <thead><tr><th>作业题目</th><th>截止日期</th></tr></thead>
      <tbody>
        <tr><td><a href="/f/wlxt/kczy/zy/student/viewZy?wlkcid=${W}&zyid=1&xszyid=11">第一次作业</a></td><td>2026-10-08 23:59</td></tr>
        <tr><td class="dataTables_empty" colspan="2">表中数据为空</td></tr>
      </tbody>
    </table></body></html>`;
  const mix = parseSectionPage(parseHTML(mixed, HW_URL), HW_URL, 'homework', { now: NOW_HW });
  eq(mix.items.length, 1, '混排时只保留真实作业那一条');

  // 2) aoData 重放：真实抓到的请求体
  const aoDataBody = 'aoData=' + encodeURIComponent(JSON.stringify([
    { name: 'sEcho', value: 1 },
    { name: 'iColumns', value: 5 },
    { name: 'sColumns', value: ',,,,' },
    { name: 'iDisplayStart', value: 0 },
    { name: 'iDisplayLength', value: '30' },
    { name: 'mDataProp_0', value: 'bt' },
    { name: 'mDataProp_1', value: 'fbr' },
    { name: 'mDataProp_2', value: 'fbsj' },
    { name: 'mDataProp_3', value: 'jzsj' },
    { name: 'iSortingCols', value: 0 },
    { name: 'wlkcid', value: '2026-2027-1000000003' },
  ]));
  const real = retargetRequest({
    url: '/b/wlxt/kcgg/wlkc_ggb/student/pageListXsbyWgq?_csrf=OLD-TOKEN',
    method: 'POST',
    body: aoDataBody,
  }, 'TARGET-KC', 'NEW-TOKEN');

  ok(real !== null, '能改造站点的真实请求（POST + aoData）');
  eq(real.method, 'POST', '方法保持 POST');
  eq(new URL(real.url, 'https://learn.tsinghua.edu.cn').searchParams.get('_csrf'), 'NEW-TOKEN', 'URL 上的 _csrf 换成当前的');
  const sent = JSON.parse(decodeURIComponent(real.body.slice('aoData='.length)));
  eq(sent.find((x) => x.name === 'wlkcid').value, 'TARGET-KC',
    'aoData 里的课程 id 必须被替换（不换就会一直请求同一门课，造成内容重复）');
  eq(sent.find((x) => x.name === 'mDataProp_0').value, 'bt', '列映射参数原样保留');
  eq(sent.find((x) => x.name === 'iDisplayLength').value, '30', '分页参数原样保留');
  eq(sent.length, 11, '条目数不变（找到既有 wlkcid 时不追加新项）');

  // 原本没有 wlkcid 时补一项，而不是静默不动
  const noKc = retargetRequest({
    url: '/b/kc/v_xszy_search/student/pageList',
    method: 'POST',
    body: 'aoData=' + encodeURIComponent(JSON.stringify([{ name: 'sEcho', value: 1 }])),
  }, 'KC9', 'T9');
  const sent2 = JSON.parse(decodeURIComponent(noKc.body.slice('aoData='.length)));
  eq(sent2.find((x) => x.name === 'wlkcid').value, 'KC9', 'aoData 里没有课程过滤项时应当补上');

  // 非法 body 不能抛错
  eq(retargetBody('aoData=这不是JSON', 'K'), 'aoData=' + encodeURIComponent('这不是JSON'), '非法 aoData 原样返回，不抛错');
  eq(retargetBody('', 'K'), '', '空 body 返回空串');
  eq(retargetBody('other=1', 'K'), 'other=1', '无关参数不改动');

  // 课程 id 出现在路径里时也要替换（否则会一直请求同一门课）
  const inPath = retargetRequest({
    url: '/b/wlxt/kc/v_wlkc_xs_xkb_kcb_extend/student/loadCourseBySemesterId/2026-2027-1000000001/zh',
  }, '2026-2027-9999999999', 'C9');
  eq(inPath.url.includes('9999999999'), true, '路径中的课程 id 也要被替换');
  eq(inPath.url.includes('1000000001'), false, '旧的课程 id 不能残留');
  eq(inPath.url.includes('2026-2027-1/') || inPath.url.includes('/zh'), true, '路径其余部分保持完整');

  // 列定义：站点响应是 DataTables 1.9 的 aaData **二维数组**（行是数组），
  // 光看响应不知道哪列是什么；而请求体里的 mDataProp_0/1/2… 正好按顺序给出列名。
  const tpl = {
    url: '/b/wlxt/kcgg/wlkc_ggb/student/pageListXsbyWgq',
    method: 'POST',
    body: 'aoData=' + encodeURIComponent(JSON.stringify([
      { name: 'sEcho', value: 1 },
      { name: 'mDataProp_0', value: 'bt' },
      { name: 'bSortable_0', value: true },
      { name: 'mDataProp_1', value: 'fbr' },
      { name: 'mDataProp_2', value: 'fbsj' },
      { name: 'mDataProp_3', value: 'jzsj' },
      { name: 'wlkcid', value: 'X' },
    ])),
  };
  deepEq(columnsFromTemplate(tpl), ['bt', 'fbr', 'fbsj', 'jzsj'], '列名按 mDataProp_ 的下标顺序提取');
  eq(columnsFromTemplate({ body: 'other=1' }).length, 0, '非 aoData 请求体没有列定义');
  eq(columnsFromTemplate(null).length, 0, '空模板返回空列定义，不抛错');

  const mapped = rowsFromArrays([['教学日历', '教务处', '2026-09-01 10:00', ''],
    ['作业通知', '李四', '2026-09-05 08:00', '2026-09-20 23:59']], columnsFromTemplate(tpl));
  eq(mapped.length, 2, '两行二维数组 -> 两个对象');
  eq(mapped[0].bt, '教学日历', '第 0 列映射到 bt');
  eq(mapped[0].fbr, '教务处', '第 1 列映射到 fbr');
  eq(mapped[1].jzsj, '2026-09-20 23:59', '第 3 列映射到 jzsj');
  eq(mapped[0].jzsj, '', '空单元格保留为空串');
  eq(rowsFromArrays([['a']], []).length, 0, '没有列定义时宁可返回空，也不要造出无意义的字段');
  eq(pickTemplates([tpl]).notice.columns.length, 4, 'pickTemplates 会把列定义一起带出来');

  // 响应外壳：站点真实用的是 {result, msg, object}，不是 resultList/aaData。
  // 上一版只认少数几个字段名，导致"拿到了数据却解析不出来"。
  const envelope = { result: true, msg: 'success', object: { list: [{ bt: '教学日历', fbr: '教务处' }] } };
  const got = extractRowsDetailed(envelope);
  eq(got.rows.length, 1, 'object.list 这种外壳也要能挖出来');
  eq(got.rows[0].bt, '教学日历', '行内容正确');
  eq(got.matchedKey.startsWith('object'), true, 'matchedKey 记录命中的路径，便于诊断');

  // 完全不认识的外壳也要能兜底挖出来，否则站点换个包装就整个失效
  const weird = { foo: { bar: [{ bt: 'x' }] } };
  eq(extractRowsDetailed(weird).rows.length, 1, '不认识的嵌套外壳也能挖到数组');

  // DataTables 1.9 的二维数组
  const dt = extractRowsDetailed({ sEcho: 1, iTotalRecords: 2, aaData: [['a', 'b'], ['c', 'd']] });
  eq(dt.matchedKey.includes('@array-of-arrays'), true, '二维数组被识别出来（行需要靠列定义还原）');
  eq(dt.rows.length, 2, '两行');
  eq(extractRowsDetailed({ result: true, msg: 'success', object: {} }).rows.length, 0, '确实是空的时候返回空，不要瞎猜');
});

/* ------------------------------------------------- 15. 全面取证的纯函数 */

/**
 * 「全面取证」是这一轮新增的机制：一次点击把站点自己的请求/响应、页面结构骨架、
 * 候选接口原始返回全部打包，避免来回试。这里测它的三个纯函数 ——
 * 尤其是 slimHtml：它必须**去掉脚本但保留全部元素**，否则我拿到的东西看不出结构。
 */
section('background/probe.js：取证用的纯函数', () => {
  const page = `<html><head><style>.a{color:red}</style><script>var x=1;</script></head>
    <body><!--注释-->
      <table id="kjalltable" class="table biji dataTable">
        <thead><tr><th>标题</th><th>类型</th><th>大小</th></tr></thead>
        <tbody><tr><td><a href="/b/wlxt/kj/x?wjid=1">讲义.pdf</a></td><td>PDF</td><td>1.2 MB</td></tr></tbody>
      </table>
      <a onclick="tabchange(2)" class="more">更多</a>
    </body></html>`;

  const slim = slimHtml(page);
  eq(slim.includes('<script>var x=1;</script>'), false, 'slimHtml 去掉脚本内容');
  eq(slim.includes('color:red'), false, 'slimHtml 去掉样式内容');
  eq(slim.includes('注释'), false, 'slimHtml 去掉注释');
  eq(slim.includes('id="kjalltable"'), true, 'slimHtml 必须保留元素（否则看不出结构）');
  eq(slim.includes('讲义.pdf'), true, 'slimHtml 保留正文文本');

  const o = outline(page);
  eq(o.tables.length, 1, 'outline 找出一张表');
  eq(o.tables[0].id, 'kjalltable', '表 id 正确');
  deepEq(o.tables[0].heads, ['标题', '类型', '大小'], '表头文字被提取出来（判断列含义最有用）');
  eq(o.tables[0].rows, 1, '统计到 1 行数据');
  eq(o.tables[0].firstRowHtml.includes('wjid=1'), true, '带上首行 HTML，便于看清链接形态');
  eq(o.ids.includes('kjalltable'), true, 'id 清单里包含它');
  eq(o.tabLinks.length, 1, '识别出 tabchange 标签链接');
  eq(o.tabLinks[0].onclick, 'tabchange(2)', '标签的 onclick 被记下来');

  // 空表与空状态文本是定位“为什么这一栏是空的”的关键线索
  const emptyPage = `<table id="zyalltable"><tbody><tr><td class="dataTables_empty">没有您要搜索的内容</td></tr></tbody></table>`;
  const eo = outline(emptyPage);
  eq(eo.hasDataTablesEmpty, true, '识别出 DataTables 的空表占位');
  eq(eo.emptyStateTexts.length > 0, true, '把空状态文案列出来');

  const reqs = summarizeRequests([
    { method: 'POST', url: '/b/wlxt/kcgg/x/pageListXsbyWgq?_csrf=a', body: 'aoData=1', status: 200, responseSnippet: '{"result":true}' },
    { method: 'POST', url: '/b/wlxt/kcgg/x/pageListXsbyWgq?_csrf=b', body: 'aoData=2', status: 200, responseSnippet: '{"result":true}' },
    { method: 'GET', url: '/b/kc/v_xszy_search/student/pageList?v=1', status: 200, responseSnippet: '{"aaData":[]}' },
    { method: 'GET', url: 'https://other.example.com/x', status: 200 },
  ]);
  eq(reqs.length, 2, '按「方法+路径」去重，同一接口只留一条（否则一个页面几十条噪声）');
  eq(reqs.some((r) => r.url.includes('xszy')), true, '不同接口都保留');
  eq(reqs.every((r) => r.responseSnippet !== undefined), true, '每条都带响应体 —— 这是取证里最值钱的部分');
});

/* ------------------------------------------------- 16. 取证实测到的真实接口 */

/**
 * 这些端点和字段名**全部来自真实取证**（站点自己发出的请求 + 它返回的响应），
 * 不是推测。之前文件一栏始终为空，就是因为从来没有调用过正确的那个接口。
 */
section('取证实测到的真实接口与字段', () => {
  // 1) 文件：object 直接是对象数组，字段名与 normalizeFile 完全对应
  const filesResp = {
    result: 'success',
    msg: null,
    object: [{
      wlkcid: '2026-2027-1000000001',
      kjxxid: '26ef84e8a00ef07901a0a3acb7f41d5d',
      bt: '1-数据科学介绍2026',
      sfqd: 0,
      scsj: '2026-09-15 14:06',
      isNew: 0,
      fileSize: '10.0M',
      wjdx: 10831880,
      wjlx: 'pdf',
      llcs: 0,
      xzcs: 18,
      wjid: '2023310802_KJ_1789452400348718395b44a-66c3-07-835d-2ae12a0932d6',
      kjflid: 'INITWJ152230837',
    }],
  };
  const fdet = extractRowsDetailed(filesResp);
  eq(fdet.matchedKey.startsWith('object'), true, '文件响应的数据在 object 下');
  eq(fdet.rows.length, 1, '取到 1 个文件');
  const file = normalizeFile(fdet.rows[0], '2026-2027-1000000001', NOW);
  eq(file.title, '1-数据科学介绍2026', '标题字段 bt 解析正确');
  eq(file.size, 10831880, '大小字段 wjdx 解析正确');
  eq(file.ext, 'pdf', '类型字段 wjlx 解析正确');
  eq(file.downloadUrl.includes('wjid='), true, '生成下载链接');
  eq(file.date, at(2026, 9, 15, 14, 6), '上传时间 scsj 解析正确');

  // 2) 文件分类接口的响应是对象数组（object.rows）
  const cats = { result: 'success', msg: null, object: { page: 1, total: 1, records: 1, rows: [{ kjflid: 'INITWJ152230837', bt: '电子教案' }] } };
  eq(extractRowsDetailed(cats).rows.length, 1, '分类列表在 object.rows 下');

  // 3) 分类内文件是**二维数组**，靠位置化字段表还原
  const catFiles = {
    result: 'success',
    msg: null,
    object: [['26ef84e8a00ef07901a0a3acb7f41d5d', '1-数据科学介绍2026', 0, 'INITWJ152230837',
      '2026-2027-1000000001', null, '2026-09-15 14:06:40', '2023310802_KJ_x', 0, 10831880,
      '2026-09-15 14:05:00', '否', '否', 'pdf', null]],
  };
  const cdet = extractRowsDetailed(catFiles);
  eq(cdet.matchedKey.includes('@array-of-arrays'), true, '识别为二维数组');
  const restored = rowsFromArrays(cdet.rows, FILE_CATEGORY_COLUMNS);
  eq(restored[0].bt, '1-数据科学介绍2026', '位置 1 是标题');
  eq(restored[0].wjid, '2023310802_KJ_x', '位置 7 是 wjid');
  eq(restored[0].wjdx, 10831880, '位置 9 是文件大小');
  eq(restored[0].wjlx, 'pdf', '位置 13 是文件类型');
  eq(restored[0].scsj, '2026-09-15 14:06:40', '位置 6 是上传时间');
  eq(FILE_CATEGORY_COLUMNS.length, 15, '字段表长度与样本列数一致（多一列少一列都会错位）');

  // 4) 公告：简单 GET 的响应
  const noticeResp = { result: 'success', msg: null, object: { iTotalRecords: '1', aaData: [{ ggid: 'g1', bt: '课程微信群', fbr: '刘文瑄', fbsj: '2026-09-15 08:52', wlkcid: 'X' }] } };
  const ndet = extractRowsDetailed(noticeResp);
  eq(ndet.rows.length, 1, '公告数据在 object.aaData 下');
  const notice = normalizeNotice(ndet.rows[0], 'X', NOW);
  eq(notice.title, '课程微信群', '公告标题解析正确');
  eq(notice.url.includes('beforeViewXs?wlkcid=X&id=g1'), true, '公告详情链接正确');

  // 5) 作业：三个按状态分开的端点，响应同样是 object.aaData
  const hwResp = { result: 'success', msg: null, object: { iTotalRecords: '1', aaData: [{ bt: '第一次作业', zt: '未交', pyzt: '未批阅', jzsj: at(2026, 10, 8, 23, 59), zyid: '1', xszyid: '2' }] } };
  const hdet = extractRowsDetailed(hwResp);
  eq(hdet.rows.length, 1, '作业数据也在 object.aaData 下');
  const hw = normalizeHomework(hdet.rows[0], 'W', NOW);
  eq(hw.completed, false, '未交 -> completed=false');
  eq(hw.deadline, at(2026, 10, 8, 23, 59), '截止时间解析正确');

  // 6) 端点常量本身
  eq(API.filesBySize, '/b/wlxt/kj/wlkc_kjxxb/student/kjxxbByWlkcidAndSizeForStudent', '文件接口路径（取证实测值）');
  eq(API.noticesBySize, '/b/wlxt/kcgg/wlkc_ggb/student/kcggListXs', '公告接口路径（取证实测值）');
  eq(API.homeworkNotSubmitted, '/b/wlxt/kczy/zy/student/index/zyListWj', '未交作业接口路径（取证实测值）');
  eq(PAGE.courseHome('X').includes('/f/wlxt/index/course/student/course?wlkcid=X'), true, '课程主页地址（取证实测值）');
});

/* ------------------------------------------------- 17. 学期判定 */

/**
 * 站点那个「当前学期」接口实测返回不了可用值，所以不能再只靠它。
 * 现在的策略是：手动指定 > 接口（松解析）> 按日期推断 + **用课程清单反证**。
 */
section('学期判定：接口松解析 + 课程数据反证', () => {
  // 不按字段名找，直接在序列化结果里找学期码 —— 它包几层、字段叫什么都能捞出来
  eq(extractSemester('2026-2027-1'), '2026-2027-1', '字符串直接命中');
  eq(extractSemester({ xnxq: '2026-2027-1' }), '2026-2027-1', '字段名叫 xnxq 也能命中');
  eq(extractSemester({ data: { list: [{ code: '2025-2026-2' }] } }), '2025-2026-2', '嵌套多层也能命中');
  eq(extractSemester({ message: 'success', resultList: [] }), '', '空结果返回空串（实测接口就是这个样子）');
  eq(extractSemester(null), '', 'null 不抛错');
  eq(extractSemester({ foo: '没有学期码' }), '', '没有学期码时返回空串');

  // 猜错就换邻近学期再试
  deepEq(neighborSemesters('2026-2027-1'), ['2025-2026-2', '2026-2027-2'], '秋季学期的邻居是两个春季学期');
  deepEq(neighborSemesters('2026-2027-2'), ['2026-2027-1', '2025-2026-1'], '春季学期的邻居是两个秋季学期');
  deepEq(neighborSemesters('乱七八糟'), [], '非法输入返回空数组');

  // 按日期推断仍然要正确（8 月起算秋季学期）
  eq(guessSemester(new Date(2026, 8, 18)), '2026-2027-1', '9 月 -> 秋季学期');
  eq(guessSemester(new Date(2026, 1, 10)), '2025-2026-2', '2 月 -> 春季学期');
  eq(guessSemester(new Date(2026, 0, 10)), '2025-2026-1', '1 月仍算秋季学期');
});

/* ------------------------------------------------- 18. 未读标记与“空 ≠ 失败” */

/**
 * 两个真实反馈：
 *  1) 公告的 NEW 标记错乱 —— 前两条已读的公告一直挂着 NEW，读完刷新还在。
 *     根因是我用「发布日期在 3 天内」当未读判断，而站点其实给了权威字段
 *     `sfyd`（"是"/"否"）与 `ydsj`（阅读时间）。
 *  2) 面板弹「8 门课程有部分板块抓取失败」—— 那些课本来就没有作业/课件，
 *     接口正常应答了空数组，却被记成了错误。
 */
section('未读标记（sfyd）与「空 ≠ 失败」', () => {
  const base = { ggid: 'g1', bt: '课程微信群', fbr: '刘文瑄', fbrxm: '刘文瑄', fbsj: '2026-09-15 08:52' };

  eq(normalizeNotice({ ...base, sfyd: '是', ydsj: '2026-09-15' }, 'W', NOW).unread, false,
    'sfyd=是 -> 已读（这正是被误标 NEW 的那种公告）');
  eq(normalizeNotice({ ...base, sfyd: '否', ydsj: '' }, 'W', NOW).unread, true, 'sfyd=否 -> 未读');
  eq(normalizeNotice({ ...base, ydsj: '' }, 'W', NOW).unread, true, '没有 sfyd 时用 ydsj：空 -> 未读');
  eq(normalizeNotice({ ...base, ydsj: '2026-09-15' }, 'W', NOW).unread, false, '没有 sfyd 时用 ydsj：有日期 -> 已读');
  eq(normalizeNotice(base, 'W', NOW).unread, true, '两个字段都没有时保守判为未读');

  const n = normalizeNotice({ ...base, sfyd: '是', ggnrStr: '请大家及时加入微信群', ggnr: '6K+35aSn', fjmc: 'qrcode.png', sfqd: '1' }, 'W', NOW);
  eq(n.text, '请大家及时加入微信群', '正文取 ggnrStr（ggnr 是 base64，不能直接用）');
  eq(n.attachment, 'qrcode.png', '附件名解析出来');
  eq(n.pinned, true, 'sfqd=1 -> 置顶');
  eq(n.author, '刘文瑄', '发布者优先取 fbrxm');

  // DOM 兜底路径不许谎报“已读”
  const domNotice = fromDomItem({ title: '某公告', url: 'https://x/y', text: '正文' }, 'notice', 'W', NOW);
  eq(domNotice.unread, null, 'DOM 路径判断不了阅读状态时置 null（未知），不能谎报成已读');
  eq(fromDomItem({ title: '某公告', url: 'https://x/y', text: '未读 正文' }, 'notice', 'W', NOW).unread, true,
    'DOM 路径下能读到“未读”字样就标未读');

  // 空 ≠ 失败
  eq(isSectionFailure({ items: [], method: 'api:empty' }), false,
    '接口正常应答但确实没有内容 -> 不算失败（否则面板会无脑弹“部分内容可能不完整”）');
  eq(isSectionFailure({ items: [], method: 'failed' }), true, '真没走通 -> 算失败');
  eq(isSectionFailure({ items: [], method: 'none' }), true, '没找到任何候选 -> 算失败');
  eq(isSectionFailure({ items: [{}], method: 'failed' }), false, '有内容就不算失败');
  eq(isSectionFailure(null), false, '空输入不抛错');
});

/* ------------------------------------------------- 19. 作业详情：说明与附件 */

/**
 * 作业列表接口返回的是表格行，按站点自己的列定义只有标题/状态/截止时间/成绩，
 * **没有作业说明，也没有附件清单** —— 那两样在详情页上。
 * 这里测的就是从详情页 HTML 里把它们捞出来的能力。
 * 解析原则是「按页面上的标签文字找」，所以夹具写成真实的表格布局。
 */
section('作业详情解析：作业说明与作业附件', () => {
  const detail = `<html><body>
    <table class="table">
      <tr><th>作业题目</th><td>第一次作业：线性表与链表</td></tr>
      <tr><th>截止时间</th><td>2026-10-08 23:59</td></tr>
      <tr><th>作业说明</th><td>请完成教材第 3 章课后习题 1、3、5 题。<br>提交格式：PDF，命名「学号-姓名-第一次作业」。</td></tr>
    </table>
    <div class="attach">
      <span>作业附件</span>
      <a href="/b/wlxt/kczy/zy/student/downloadFile?wjid=AAA">习题模板.docx</a>
      <a href="/b/wlxt/kczy/zy/student/downloadFile?wjid=BBB">参考资料.pdf</a>
      <a href="javascript:void(0)">展开</a>
    </div>
  </body></html>`;

  const parsed = parseHomeworkDetail(parseHTML(detail, HW_URL), HW_URL);
  eq(parsed.description.includes('请完成教材第 3 章课后习题'), true, '按「作业说明」标签取到说明正文');
  eq(parsed.description.includes('提交格式'), true, '说明里换行后的内容也要一起取到');
  eq(parsed.descriptionSource, 'label:作业说明', '记录说明的来源，便于排查');
  eq(parsed.attachments.length, 2, '收集到两个附件');
  eq(parsed.attachments[0].name, '习题模板.docx', '附件名取链接文字');
  eq(parsed.attachments[0].url.includes('wjid=AAA'), true, '附件链接绝对化');
  eq(parsed.attachments[0].ext, 'docx', '附件扩展名解析出来');
  eq(parsed.attachments.some((a) => /javascript/.test(a.url)), false, 'javascript: 链接不是附件');

  // 「作业说明：xxx」写在同一行的形态
  const inline = '<html><body><div>作业说明：请阅读论文并写 500 字摘要。</div></body></html>';
  eq(parseHomeworkDetail(parseHTML(inline, HW_URL), HW_URL).description, '请阅读论文并写 500 字摘要。',
    '标签与内容写在一起时也能取到');

  // 没有标签时退到「正文里最长的一段」，但绝不为空页面编造内容
  const noLabel = '<html><body><div>这是一段比较长的正文内容，用来验证兜底策略能否取到它。</div></body></html>';
  const fallback = parseHomeworkDetail(parseHTML(noLabel, HW_URL), HW_URL);
  eq(fallback.description.includes('兜底策略'), true, '没有标签时退到最长文本块');
  eq(fallback.descriptionSource, 'longest-block', '标出来源是兜底');

  const empty = parseHomeworkDetail(parseHTML('<html><body></body></html>'), HW_URL);
  eq(empty.description, '', '空页面不编造说明');
  eq(empty.attachments.length, 0, '空页面没有附件');

  // 列表行里就已经带了说明/附件时，不该再花流量去抓详情
  const fromRow = normalizeHomework({ bt: 'X', zt: '未交', zyid: '1', xszyid: '2', nr: '列表里带来的说明', fjmc: 'u.pdf' }, 'W', NOW);
  eq(fromRow.description, '列表里带来的说明', '列表行里的说明字段也能识别（不同接口版本字段名不同）');
  eq(fromRow.attachments.length, 1, '列表行里的附件名也能识别');
  eq(fromRow.attachments[0].name, 'u.pdf', '附件名正确');
});

/* ------------------------------------------------- 20. 说明只取「说明」到「附件」之间 */

/**
 * 详情页是一串字段排下来的：作业题目 / 截止时间 / 作业说明 / … / 作业附件。
 * 只从「作业说明」往后一路收，会把附件区甚至后面的批阅、成绩一起吞进说明里。
 * 所以说明文本必须在「作业附件」这类边界处截断。
 */
section('作业说明只取「作业说明」至「作业附件」之间', () => {
  // 形态 1：连续兄弟节点（div 版）
  const divForm = `<html><body><div class="box">
    <div class="row"><span>作业题目</span><span>第三次作业</span></div>
    <div class="row"><span>截止时间</span><span>2026-10-08 23:59</span></div>
    <div class="row"><span>作业说明</span><span>请完成课后习题 1、3、5，提交 PDF。</span></div>
    <div class="row"><span>作业附件</span><a href="/b/wlxt/kczy/zy/student/downloadFile?wjid=A">模板.docx</a></div>
    <div class="row"><span>批阅教师</span><span>王五</span></div>
  </div></body></html>`;
  const d1 = parseHomeworkDetail(parseHTML(divForm, HW_URL), HW_URL);
  eq(d1.description, '请完成课后习题 1、3、5，提交 PDF。', 'div 形态：只取说明本身');
  eq(d1.description.includes('作业附件'), false, '不能把「作业附件」标签吞进说明');
  eq(d1.description.includes('模板.docx'), false, '不能把附件名吞进说明');
  eq(d1.description.includes('批阅教师'), false, '不能把说明之后的字段吞进说明');
  eq(d1.attachments.length, 1, '附件仍然正常收集');

  // 形态 2：表格行（th/td）
  const tableForm = `<html><body><table>
    <tr><th>作业说明</th><td>实现三种遍历并提交实验报告。</td></tr>
    <tr><th>作业附件</th><td><a href="/b/wlxt/kczy/zy/student/downloadFile?wjid=B">框架.zip</a></td></tr>
    <tr><th>成绩</th><td>未批阅</td></tr>
  </table></body></html>`;
  const d2 = parseHomeworkDetail(parseHTML(tableForm, HW_URL), HW_URL);
  eq(d2.description, '实现三种遍历并提交实验报告。', '表格形态：只取说明单元格');
  eq(d2.description.includes('框架.zip'), false, '不能把附件吞进说明');
  eq(d2.description.includes('未批阅'), false, '不能把成绩吞进说明');

  // 形态 3：整段文字写在一起（宽松匹配）也必须截断
  const inlineForm = '<html><body><div>作业说明：请阅读论文并写 500 字摘要。作业附件：论文.pdf</div></body></html>';
  const d3 = parseHomeworkDetail(parseHTML(inlineForm, HW_URL), HW_URL);
  eq(d3.description, '请阅读论文并写 500 字摘要。', '文字连写时在「作业附件」处截断');
  eq(d3.description.includes('论文.pdf'), false, '连写形态下也不能把附件名带进来');

  // 形态 4：说明后面直接跟「批阅/成绩」这类字段也要停
  const stopForm = '<html><body><div>作业要求：完成第 5 章全部习题。成绩：未批阅</div></body></html>';
  eq(parseHomeworkDetail(parseHTML(stopForm, HW_URL), HW_URL).description, '完成第 5 章全部习题。',
    '没有附件时也要在「成绩」处停下');

  // 边界：说明后面什么都没有
  const onlyDesc = '<html><body><div>作业说明：只有说明没有附件。</div></body></html>';
  eq(parseHomeworkDetail(parseHTML(onlyDesc, HW_URL), HW_URL).description, '只有说明没有附件。', '没有附件时取完整说明');
});

/* ------------------------------------------------- 21. 附件合并与换行保留 */

/**
 * 两件事都来自真实详情页：
 *  1) 一个附件在页面上有**两个链接**（文件名 + 旁边的「下载」按钮），
 *     不合并就会显示成两个附件。真实证据：
 *       <a href="/f/wlxt/kc/wj_wjb/student/openNewWindow?fileId=XXX&downloadUrl=/b/.../downloadFile/...">第1讲作业模板.docx</a>
 *       <a href="/b/wlxt/kczy/zy/student/downloadFile/.../XXX?_csrf=...">下载</a>
 *  2) 说明里大量用 <p>/<ol><li>，全部拼成一行的话，两行截断出来是一团读不通的字。
 */
section('附件合并与说明换行', () => {
  const real = `<html><body>
    <div class="list fujian clearfix">
      <div class="left fl">作业附件</div>
      <div class="right">
        <div class="wdhere docx">
          <div class="txt fl">
            <span class="ftitle"><a target="_blank" href="/f/wlxt/kc/wj_wjb/student/openNewWindow?fileId=0000000000_ZY_ABC&amp;roleType=student&amp;downloadUrl=/b/wlxt/kczy/zy/student/downloadFile/2026-2027-1000000005/0000000000_ZY_ABC?_csrf=T">示例作业模板.docx</a></span>
            <span><a href="/b/wlxt/kczy/zy/student/downloadFile/2026-2027-1000000005/0000000000_ZY_ABC?_csrf=T">下载</a></span>
          </div>
        </div>
      </div>
    </div>
  </body></html>`;
  const parsed = parseHomeworkDetail(parseHTML(real, HW_URL), HW_URL);
  eq(parsed.attachments.length, 1, '同一个附件的「文件名」与「下载」两个链接必须合并成一条');
  eq(parsed.attachments[0].name, '示例作业模板.docx', '保留像文件名的那个名字，而不是「下载」');
  eq(parsed.attachments[0].ext, 'docx', '扩展名来自文件名');
  eq(/downloadfile/i.test(parsed.attachments[0].url), true, '用能直接下载的地址（openNewWindow 里内嵌的 downloadUrl）');

  // 两个不同文件不应被合并
  const two = `<html><body>
    <a href="/b/wlxt/kczy/zy/student/downloadFile/W/ID1">甲.pdf</a>
    <a href="/b/wlxt/kczy/zy/student/downloadFile/W/ID2">乙.docx</a>
  </body></html>`;
  eq(parseHomeworkDetail(parseHTML(two, HW_URL), HW_URL).attachments.length, 2, '不同文件仍然各算一条');

  // 说明保留块级换行
  const blocks = `<html><body><div>
    <div class="left">作业说明</div>
    <div class="right"><p>第一段。</p><ol><li>第一条；</li><li>第二条。</li></ol></div>
    <div class="left">作业附件</div>
  </div></body></html>`;
  const b = parseHomeworkDetail(parseHTML(blocks, HW_URL), HW_URL);
  eq(b.description.includes('\n'), true, '说明里的块级元素之间要保留换行（否则两行截断出来读不通）');
  eq(b.description.startsWith('第一段。'), true, '第一段在最前');
  eq(b.description.includes('第一条；\n第二条。'), true, '列表项各自成行');
  eq(/\n{3,}/.test(b.description), false, '不产生多余空行');
});

/* ------------------------------------------------- 22. 区块标题不能被当成字段标签 */

/**
 * 真实页面上有个区块标题「作业内容及要求：」（实测；用户遇到的是「作业要求及内容：」同型）。
 * 旧的宽松匹配只看 startsWith，于是「作业内容」被当成标签、切掉后剩「及要求：」，
 * 而**字段之上的大容器**（.boxbox / .detail）文字正好以这个标题开头，
 * 结果整页内容都被当成作业说明。
 */
section('区块标题不能被当成「作业说明」字段', () => {
  // 关键：标签后面必须紧跟冒号/空白，否则「作业要求及内容：」会被误认
  eq(looksLikeContainer('作业标题 第一次作业 作业说明 请完成习题 截止时间'), true,
    '开头并排列着多个字段名 -> 是容器（应拒绝）');
  eq(looksLikeContainer('请从本窗口作业附件中下载作业模板，截止时间：9月22日'), false,
    '正文里正常提到「作业附件」「截止时间」不算容器（这条曾把正常说明误杀）');
  eq(looksLikeContainer('作业附件：模板.docx'), true, '开头就是字段名 -> 容器');
  eq(looksLikeContainer(''), false, '空串不抛错');

  // 页面只有区块标题、没有「作业说明」字段：宁可空，也不能把整页当成说明
  const headerOnly = `<html><body>
    <div class="ttee">作业内容及要求：</div>
    <div class="boxbox">
      <div class="list"><div class="left">作业标题</div><div class="right"><p>第一次作业</p></div></div>
      <div class="list"><div class="left">发布对象</div><div class="right"><p>全体学生</p></div></div>
      <div class="list"><div class="left">完成方式</div><div class="right"><p>独立完成</p></div></div>
    </div>
  </body></html>`;
  const a = parseHomeworkDetail(parseHTML(headerOnly, HW_URL), HW_URL);
  eq(a.description.includes('作业标题'), false, '不能从「作业内容及要求：」的「及要求：」开始取');
  eq(a.description.includes('发布对象'), false, '不能把后面的字段一起吞进来');
  eq(a.description, '', '没有「作业说明」字段时宁可留空，也不编造');

  // 区块标题 + 真正的「作业说明」字段：只取说明本身
  const withHeader = `<html><body>
    <div class="ttee">作业要求及内容：</div>
    <div class="boxbox">
      <div class="list"><div class="left">作业标题</div><div class="right"><p>第一次作业</p></div></div>
      <div class="list"><div class="left">作业说明</div><div class="right"><div id="zysm">请完成课后习题 1、3、5。</div></div></div>
      <div class="list"><div class="left">作业附件</div><div class="right"><a href="/b/wlxt/kczy/zy/student/downloadFile/W/ID1">模板.docx</a></div></div>
      <div class="list"><div class="left">发布对象</div><div class="right"><p>全体学生</p></div></div>
    </div>
  </body></html>`;
  const c = parseHomeworkDetail(parseHTML(withHeader, HW_URL), HW_URL);
  eq(c.descriptionSource, 'label:作业说明', '命中的是「作业说明」字段');
  eq(c.description, '请完成课后习题 1、3、5。', '只取说明本身，不带标题/附件/发布对象');
  eq(c.attachments.length, 1, '附件照常收集');

  // 「作业说明」存在但为空 -> 说明就是空，不许退到别的字段
  const emptyDesc = `<html><body>
    <div class="boxbox">
      <div class="list"><div class="left">作业标题</div><div class="right"><p>第1讲作业</p></div></div>
      <div class="list"><div class="left">作业说明</div><div class="right"><div class="c55"> </div></div></div>
      <div class="list"><div class="left">发布对象</div><div class="right"><p>全体学生</p></div></div>
    </div>
  </body></html>`;
  const e = parseHomeworkDetail(parseHTML(emptyDesc, HW_URL), HW_URL);
  eq(e.description, '', '字段存在但为空时说明就是空');
  eq(e.descriptionSource.startsWith('empty:'), true, '并标明“字段为空”，便于排查');
});

/* ------------------------------------------------- 23. 原始 HTML 取不到就改用渲染页 */

/**
 * 真实情况：作业详情页的「作业说明」是**页面 JS 填进去的**，
 * 服务端返回的原始 HTML 里那个容器是空的。于是：
 *   - 直接 fetch 原始 HTML 解析 → 什么都拿不到（“说明一条都没有”）
 *   - 更早那版会因此退到别的字段上 → 抓成「作业内容及要求」区块标题，把整页当成说明
 * 正确做法：原始 HTML 空 → 换成浏览器渲染后的页面再解析。
 */
section('说明取不到时改用渲染后的页面', () => {
  eq(needsRenderedRetry({ description: '', attachments: [], descriptionSource: 'empty:作业说明' }), true,
    '原始 HTML 里说明为空 -> 需要改用渲染页重试');
  eq(needsRenderedRetry({ description: '', attachments: [] }), true, '什么都没有 -> 需要重试');
  eq(needsRenderedRetry(null), true, '没解析出结果 -> 需要重试');
  eq(needsRenderedRetry({ description: '有说明', attachments: [] }), false, '有说明就不用重试');
  eq(needsRenderedRetry({ description: '   ', attachments: [] }), true, '只有空白也算空');

  // 【真实仪表数据】实测 raw = { htmlLength: 59370, len: 0, source: "empty:作业说明" }，
  // 而附件链接是服务端渲染的、原始 HTML 里就有。把「附件有」也算成功的话，
  // 这个最常见的组合就永远不会触发重试 —— renderedRetry 实测就是 0，说明一条都没出来。
  eq(needsRenderedRetry({ description: '', attachments: [{ name: '模板.docx' }], descriptionSource: 'empty:作业说明' }), true,
    '【关键】说明为空但附件有 -> 仍然必须重试（附件本来就来自原始 HTML）');
  eq(needsRenderedRetry({ description: '', attachments: [{ name: 'a.pdf' }, { name: 'b.pdf' }] }), true,
    '附件再多也不能代替说明');
});

/* ------------------------------------------------- 24. 收尾阶段不该“卡住” */

/**
 * 抓取最后会有一段「卡住」的感觉，两个来源：
 *  1) 详情页没有列表表格，旧的等待逻辑只能把超时耗满（每条作业白等 3 秒）；
 *     → 改成「等正文稳定」，并允许调用方指定 waitFor: 'settle'。
 *  2) 作业说明很少变，却每次刷新都重新渲染一遍 —— 20 条待交作业就是 30 秒。
 *     → 补全结果按作业 id 缓存 12 小时，命中就不必再开页面。
 */
section('收尾阶段不该卡住（等待策略与补全缓存）', () => {  eq(typeof snapshotViaTab, 'function', 'snapshotViaTab 导出可用');
  eq(snapshotViaTab.length >= 1, true, '接收选项参数');

  // 缓存新鲜度判断（12 小时）
  const now = Date.now();
  eq(freshEntry({ at: now - 1000 }), true, '刚刚补全过 -> 命中缓存');
  eq(freshEntry({ at: now - 11 * 3600 * 1000 }), true, '11 小时前 -> 仍可用');
  eq(freshEntry({ at: now - 13 * 3600 * 1000 }), false, '13 小时前 -> 过期，需要重新抓');
  eq(freshEntry({ at: 0 }), false, '没有时间戳 -> 不算命中');
  eq(freshEntry(null), false, '空条目不算命中');
});

/* ------------------------------------------------- 25. 雨课堂接口取证 */

/**
 * 雨课堂是独立账号体系的前端应用，接口只能靠**实机嗅探**拿到，
 * 不能猜（这个项目已经为此吃过太多亏）。
 * 这里测的是把嗅探记录整理成「接口清单」的那一步 —— 归类错了，清单就没法用。
 */
section('雨课堂取证：接口归类', () => {
  const records = [
    { method: 'GET', url: 'https://pro.yuketang.cn/api/v3/user/basic-info', status: 200, responseSnippet: '{"code":0,"data":{"name":"张三"}}' },
    { method: 'GET', url: 'https://pro.yuketang.cn/api/v3/user/basic-info', status: 200, responseSnippet: '{"code":0}' },
    { method: 'GET', url: 'https://pro.yuketang.cn/api/v3/user/basic-info', status: 200, responseSnippet: '{"code":0}' },
    { method: 'POST', url: 'https://pro.yuketang.cn/api/v3/lesson/list?page=1', body: 'a=1', status: 200, responseSnippet: '{"data":{"activities":[]}}', headerNames: ['content-type'] },
    { method: 'GET', url: 'https://pro.yuketang.cn/api/v3/lesson/list?page=2', status: 200, responseSnippet: '{"data":{"activities":[1]}}' },
    { method: 'GET', url: 'https://pro.yuketang.cn/api/v3/lesson/list?page=3', status: 200, responseSnippet: '{"data":{"activities":[2]}}' },
    { method: 'GET', url: '/relative/path', status: 200 },
    { method: 'GET', url: '', status: 0 },
  ];
  const eps = groupEndpoints(records);
  eq(eps.length, 4, '空 url 被跳过，其余各成一类（含相对地址那一类）');
  const basic = eps.find((e) => e.path === '/api/v3/user/basic-info');
  eq(basic.count, 3, '调用次数被累计');
  eq(basic.samples.length, 3, '样本最多留 3 份');
  eq(basic.samples[0].responseSnippet.includes('张三'), true, '响应体保留 —— 判断字段全靠它');

  const lessonGet = eps.find((e) => e.method === 'GET' && e.path === '/api/v3/lesson/list');
  const lessonPost = eps.find((e) => e.method === 'POST' && e.path === '/api/v3/lesson/list');
  eq(!!lessonGet && !!lessonPost, true, '同一路径的 GET 与 POST 分别成类（方法不同不算同一个接口）');
  eq(lessonGet.count, 2, '两条 GET 合成一类（不同查询串算同一个接口）');
  eq(lessonPost.count, 1, 'POST 单独计数');
  eq(eps.some((e) => e.path === '/relative/path'), true, '相对地址原样保留，不抛错');
  eq(eps[0].count >= eps[eps.length - 1].count, true, '按调用次数降序，最相关的接口排最前');

  eq(groupEndpoints([]).length, 0, '空输入返回空清单');
  eq(groupEndpoints(null).length, 0, 'null 不抛错');
  eq(groupEndpoints([{ method: 'GET' }]).length, 0, '没有 url 的记录被跳过');

  // 样本上限可调，且响应体不会无限大
  const capped = groupEndpoints(records, { maxSamples: 1, responseLimit: 5 });
  eq(capped.find((e) => e.path === '/api/v3/user/basic-info').samples.length, 1, 'maxSamples 生效');
  eq(capped.find((e) => e.path === '/api/v3/user/basic-info').samples[0].responseSnippet.length, 5, '响应体按上限截断');
});

/* ------------------------------------------------- 26. 雨课堂：抓作业并归类 */

/**
 * 下面这些响应体是**真实抓包**（yuketang-forensics 报告）里的原文，
 * 直接当夹具用 —— 这样测的就不是"我以为它长什么样"。
 */
const YKT_CLASSROOM_JSON = {
  errcode: 0,
  errmsg: 'Success',
  data: {
    id: 3000001,
    name: '2026秋-示例课程A(1)-5',
    short_name: null,
    course_id: '4000001',
    course_name: '示例课程A(1)',
    students_count: 168,
    teacher_name: '张老师',
    uv_id: 2598,
    user_role: 5,
    course_sign: 'testsign-001',
    class_start: 1788192000000,
    class_end: 1801411199000,
  },
};

/** 章节树原文（截取与作业相关的部分；leaf_type=8 是课件类叶子，不该被当成作业） */
const YKT_CHAPTER_JSON = {
  data: {
    course_id: 4000001,
    course_chapter: [
      {
        name: '未分类教学活动',
        id: 6000002,
        order: -1,
        section_leaf_list: [
          { name: '1-1实数与极限 - li', leaf_type: 8, id: 5000003, chapter_id: 6000002, leafinfo_id: 6085319, score_deadline: 1801411199000, is_score: true, is_assessed: false },
          { name: '1-2收敛列的性质', leaf_type: 8, id: 5000004, chapter_id: 6000002, leafinfo_id: 6088917, score_deadline: 1801411199000, is_score: true, is_assessed: false },
        ],
      },
      {
        name: '示例教材（上）',
        id: 6000001,
        order: 2,
        section_leaf_list: [
          { name: '第0次作业', leaf_type: 6, id: 5000001, chapter_id: 6000001, leafinfo_id: 6079337, score_deadline: 1790438399000, start_time: 1789370035000, is_score: true, is_assessed: false },
          { name: '第一周作业', leaf_type: 6, id: 5000002, chapter_id: 6000001, leafinfo_id: 6085754, score_deadline: 1790524799000, start_time: 1789539607000, is_score: true, is_assessed: false },
        ],
      },
    ],
  },
  success: true,
};

/** 完成度原文：标量 1 = 整片叶子已完成；{total,done} = 题目进度 */
const YKT_SCHEDULE_JSON = {
  data: { leaf_schedules: { 5000004: 1, 5000001: { total: 2, done: 2 }, 5000003: 1, 5000002: { total: 6, done: 0 } } },
  success: true,
};

section('雨课堂：时间与地址', () => {
  eq(yktTime(1790438399000), 1790438399000, '毫秒值原样保留');
  eq(yktTime(1789539607000.0), 1789539607000, '浮点毫秒取整');
  eq(yktTime(1790438399), 1790438399000, '秒级值补成毫秒');
  eq(yktTime('1790438399000'), 1790438399000, '字符串数字也能认');
  eq(yktTime(0), null, '0 不是合法时间');
  eq(yktTime(null), null, 'null -> null');
  eq(yktTime(undefined), null, 'undefined -> null');
  eq(yktTime('abc'), null, '非数字 -> null');

  // 这条 URL 是从抓包里逐字抄下来的，拼错一个参数作业页就打不开
  eq(
    yktUrl.homework('3000001', '5000001', '6000001'),
    'https://pro.yuketang.cn/ai-workspace/lms-graph/3000001/exercise/5000001?is_chapter=1&node_id=6000001',
    '作业页地址与抓包一致（node_id 就是 chapter_id）',
  );
  eq(
    yktUrl.chapter('3000001', 'testsign-001'),
    'https://pro.yuketang.cn/mooc-api/v1/lms/learn/course/chapter?cid=3000001&sign=testsign-001&classroom_id=3000001&show_unpublished=0',
    '章节树地址三个参数 cid/sign/classroom_id 都带上',
  );
  eq(yktUrl.classroom('3000002'), 'https://pro.yuketang.cn/v2/api/web/classrooms/3000002?role=5', '单课信息地址');

  eq(isYuketangUrl('https://pro.yuketang.cn/x'), true, 'pro 子域算雨课堂');
  eq(isYuketangUrl('https://tsinghua.yuketang.cn/x'), true, '另一个子域也算（跨子域架构）');
  eq(isYuketangUrl('https://learn.tsinghua.edu.cn/x'), false, '网络学堂不算');
  eq(isYuketangUrl('https://notyuketang.cn/x'), false, '后缀伪装的不算');
});

section('雨课堂：认课程列表', () => {
  const chapterRecord = {
    method: 'GET',
    url: 'https://pro.yuketang.cn/mooc-api/v1/lms/learn/course/chapter?cid=3000001',
    responseSnippet: JSON.stringify(YKT_CHAPTER_JSON),
  };
  const listRecord = {
    method: 'GET',
    url: 'https://pro.yuketang.cn/v2/api/web/classrooms?role=5',
    responseSnippet: JSON.stringify({ errcode: 0, data: [YKT_CLASSROOM_JSON.data, { ...YKT_CLASSROOM_JSON.data, id: 3000002, name: '2026秋-示例课程B-1' }] }),
  };

  const picked = pickClassroomList([chapterRecord, listRecord]);
  eq(picked.rows.length, 2, '从响应里认出课程列表（不是靠写死路径）');
  eq(picked.path, '/v2/api/web/classrooms', '并报告是哪一个接口给的');
  eq(picked.score >= 2, true, '命中课程专有字段，得分高');

  // 关键：章节树里也有 id 和 name，绝不能认成课程列表
  eq(pickClassroomList([chapterRecord]).rows.length, 0, '章节树不会被误认成课程列表');

  const single = { method: 'GET', url: 'https://pro.yuketang.cn/v2/api/web/classrooms/3000001?role=5', responseSnippet: JSON.stringify(YKT_CLASSROOM_JSON) };
  eq(pickClassroomList([single]).rows.length, 0, '「单个课程」的响应不是列表，不该被当成列表');

  eq(pickClassroomList([]).rows.length, 0, '空输入不抛错');
  eq(pickClassroomList(null).rows.length, 0, 'null 不抛错');
  eq(pickClassroomList([{ url: 'https://a/x', responseSnippet: '不是 JSON' }]).rows.length, 0, '响应不是 JSON 就跳过');
  eq(pickClassroomList([{ url: 'https://a/x', responseSnippet: '{"data":{"activities":[]}}' }]).rows.length, 0, '空数组不算候选');

  // 「认不出来」必须能说清是为什么 —— 否则线上出问题只能靠猜
  const debug = [];
  eq(classroomListCandidates([chapterRecord], debug).length, 0, '带过程的版本同样不认章节树');
  eq(debug.length > 0, true, '被拒的原因被记录下来');
  eq(debug.some((d) => /章节|叶子/.test(d.why)), true, '原因里说明是「章节/叶子结构」而不是含糊的"没认到"');
  eq(debug[0].path.includes('/mooc-api/'), true, '原因里带上具体是哪个接口');

  const debug2 = [];
  classroomListCandidates([{ url: 'https://pro.yuketang.cn/x', responseSnippet: '{"a":1}' }], debug2);
  eq(debug2[0].why.includes('没有对象数组'), true, '没有数组时也说清楚');

  const debug3 = [];
  classroomListCandidates([{ url: 'https://pro.yuketang.cn/x' }], debug3);
  eq(debug3[0].why.includes('没有响应体'), true, '只记到请求、没记到响应体时也说得出来');

  const debug4 = [];
  classroomListCandidates([listRecord], debug4);
  eq(debug4.length, 0, '认出来的候选不会出现在"被拒"清单里');
});

section('雨课堂：课程归一化与匹配', () => {
  const c = normalizeYktClassroom(YKT_CLASSROOM_JSON.data);
  eq(c.id, '3000001', '课程 id 转成字符串（后面要拼 URL）');
  eq(c.name, '2026秋-示例课程A(1)-5', '完整班级名');
  eq(c.courseName, '示例课程A(1)', '课程名——归类就靠它');
  eq(c.sign, 'testsign-001', 'course_sign 提出来了（章节树/完成度都要它）');
  eq(c.teacher, '张老师', '教师名');
  // 「教室 id」与 course_id 是两个不同的编号，取 sign 时两个都要能试
  eq(c.courseId, '4000001', 'course_id 单独留着（列表接口给的可能不是教室 id）');
  eq(c.id, '3000001', 'id 与 courseId 不同，不能被混淆');

  // 课程列表接口的条目里**没有** course_sign，这一点是实测的
  const fromList = normalizeYktClassroom({ id: 3000001, name: '2026秋-示例课程A(1)-5', course_name: '示例课程A(1)', course_id: '4000001' });
  eq(fromList.sign, '', '列表接口的条目没有 course_sign —— 所以必须单独再取一次');
  eq(fromList.courseName, '示例课程A(1)', '列表条目照样能取出课程名用于匹配');
  eq(YKT_COURSES_LIST_URL, 'https://pro.yuketang.cn/v2/api/web/courses/list', '学到的课程列表接口地址（来自实机抓包）');

  eq(normalizeYktClassroom({}), null, '没有 id 返回 null');
  eq(normalizeYktClassroom({ id: 1 }), null, '只有 id 没有名字也返回 null');
  eq(normalizeYktClassroom(null), null, 'null 不抛错');

  // 归一化：全角/空白/学期前缀/班号后缀/括号都要能被抹平
  eq(courseKey('2026秋-示例课程A(1)-5'), courseKey('示例课程A(1)'), '带学期前缀与班号的名字能对上课程名');
  eq(courseKey('2026秋-示例课程B-1'), courseKey('示例课程B'), '示例课程B');
  eq(courseKey('2026秋-示例课程C-2'), courseKey('示例课程C'), '示例课程C');
  eq(courseKey('  示例课程 A（1） '), courseKey('示例课程a(1)'), '空格、全角括号、大小写都不影响');
  eq(courseKey(''), '', '空名 -> 空键');

  const learn = [{ id: '1', name: '示例课程A(1)' }, { id: '2', name: '示例课程B' }, { id: '3', name: '大学英语' }];
  eq(matchLearnCourse({ name: '2026秋-示例课程A(1)-5', courseName: '示例课程A(1)' }, learn).id, '1', '按课程名精确匹配');
  eq(matchLearnCourse({ name: '2026秋-示例课程B-1', courseName: '示例课程B' }, learn).id, '2', '第二门也能匹配上');
  eq(matchLearnCourse({ name: '2026秋-示例课程K-3', courseName: '示例课程K' }, learn), null, '对不上就如实返回 null，不硬塞');
  eq(matchLearnCourse({ name: '', courseName: '' }, learn), null, '空名不匹配任何课程');
  eq(matchLearnCourse({ name: '2026秋-示例课程A(1)-5', courseName: '示例课程A(1)' }, []), null, '没有课程时不抛错');

  // 短名不做包含匹配，否则「英语」会匹配到「大学英语」这种不该匹配的
  eq(matchLearnCourse({ name: '英语', courseName: '英语' }, learn), null, '太短的名字不参与「包含」匹配，避免误配');
});

section('雨课堂：章节树 -> 作业 / 完成度', () => {
  const hw = homeworkFromChapter(YKT_CHAPTER_JSON);
  eq(hw.length, 2, '只挑出 leaf_type=6 的两个作业，课件类叶子(leaf_type=8)被排除');
  eq(LEAF_TYPE_HOMEWORK, 6, '作业的 leaf_type 常量是 6');
  eq(hw[0].leafId, '5000001', '第一条是第0次作业');
  eq(hw[0].title, '第0次作业', '标题来自 leaf.name');
  eq(hw[0].chapterId, '6000001', 'chapter_id 单独留着（拼作业页 URL 要用）');
  eq(hw[0].chapterName, '示例教材（上）', '所在章节名');
  eq(hw[0].deadline, 1790438399000, '截止时间 = score_deadline');
  eq(hw[0].publishTime, 1789370035000, '发布时间 = start_time');
  eq(hw[1].title, '第一周作业', '第二条');
  eq(hw[1].deadline, 1790524799000, '第二条截止时间');
  eq(hw.some((x) => x.title.includes('实数与极限')), false, '课件叶子没有混进来');

  eq(homeworkFromChapter(null).length, 0, 'null 不抛错');
  eq(homeworkFromChapter({ data: {} }).length, 0, '没有 course_chapter 时返回空');
  eq(homeworkFromChapter({ data: { course_chapter: 'x' } }).length, 0, 'course_chapter 不是数组时返回空');

  // 实测样本里章节是「平」的，但雨课堂本身支持「章 → 节 → 叶子」嵌套。
  // 扁平读法遇到嵌套会得到"一个叶子都没有"，而那和"这门课确实没内容"长得一模一样。
  const nested = {
    data: {
      course_chapter: [
        {
          name: '第一章',
          id: 100,
          section_list: [
            { name: '1.1 节', id: 101, section_leaf_list: [{ name: '嵌套作业A', leaf_type: 6, id: 9001, score_deadline: 1790438399000 }] },
            { name: '1.2 节', id: 102, section_leaf_list: [{ name: '嵌套课件', leaf_type: 8, id: 9002 }] },
          ],
        },
      ],
    },
  };
  const nestedHw = homeworkFromChapter(nested);
  eq(nestedHw.length, 1, '嵌套子节里的作业也能找到');
  eq(nestedHw[0].leafId, '9001', '嵌套作业的 id 正确');
  eq(nestedHw[0].title, '嵌套作业A', '嵌套作业的标题正确');

  // 叶子在 chapter_id 上回指章节时以它为准；没有就退回上下文
  const ctxTest = homeworkFromChapter({ data: { course_chapter: [{ name: '第二章', id: 200, section_list: [{ name: '2.1', id: 201, section_leaf_list: [{ name: 'X', leaf_type: 6, id: 9100 }] }] }] } });
  eq(ctxTest[0].chapterId, '201', '没有 chapter_id 时用所在节/章的 id（拼作业页 URL 要用）');

  // 同一个叶子出现两次只算一条（递归遍历有可能走到重复引用）
  const dup = { data: { course_chapter: [{ name: 'A', id: 1, section_leaf_list: [{ name: 'D', leaf_type: 6, id: 777 }], section_list: [{ name: 'B', id: 2, section_leaf_list: [{ name: 'D', leaf_type: 6, id: 777 }] }] }] } };
  eq(homeworkFromChapter(dup).length, 1, '同一个 leaf id 只算一条，不重复');

  const hist = leafTypeHistogram(YKT_CHAPTER_JSON);
  eq(hist.chapters, 2, '统计出 2 个章节');
  eq(hist.leaves, 4, '统计出 4 个叶子');
  eq(hist.dist['leaf_type=6'], 2, '其中 2 个是作业');
  eq(hist.dist['leaf_type=8'], 2, '其中 2 个是课件');
  const emptyHist = leafTypeHistogram({ data: { course_chapter: [] }, success: true });
  eq(emptyHist.leaves, 0, '空章节树统计出 0 个叶子（用于区分"真的没内容"和"接口形状变了"）');
  eq(emptyHist.chapters, 0, '空章节树的章节数也是 0');

  const comp = completionFromSchedule(YKT_SCHEDULE_JSON);
  eq(comp['5000001'].total, 2, '第0次作业共 2 题');
  eq(comp['5000001'].done, 2, '做完 2 题');
  eq(comp['5000001'].complete, true, 'done === total -> 完成');
  eq(comp['5000002'].complete, false, '第一周作业 0/6 -> 未完成');
  eq(comp['5000004'].complete, true, '标量 1 -> 该叶子已完成');
  eq(comp['9999999'], undefined, '没出现在 leaf_schedules 里的作业没有进度');
  eq(Object.keys(completionFromSchedule(null)).length, 0, 'null 不抛错');
  // total=0 时不能算完成 —— 否则一门空作业会被当成做完了直接隐藏掉
  eq(completionFromSchedule({ data: { leaf_schedules: { a: { total: 0, done: 0 } } } }).a.complete, false, 'total=0 不算完成（避免把空作业误判成已完成而隐藏）');
});

section('雨课堂：作业条目与归类合并', () => {
  const hw = homeworkFromChapter(YKT_CHAPTER_JSON);
  const completion = completionFromSchedule(YKT_SCHEDULE_JSON);
  const done = toYktHomework(hw[0], { classroomId: '3000001', wlkcid: '100', sign: 'S', completion });
  const pending = toYktHomework(hw[1], { classroomId: '3000001', wlkcid: '100', sign: 'S', completion });

  eq(done.id, 'zy:100:ykt:3000001:5000001', 'id 带 ykt 命名空间，绝不会和网络学堂的 id 撞车');
  eq(done.platform, 'yuketang', '平台被标记出来');
  eq(done.title, '第0次作业', '标题');
  eq(done.completed, true, '2/2 -> 已完成');
  eq(done.status, 'done', '状态 done —— 面板的「隐藏已完成」依据它');
  eq(done.progressText, '2/2', '原始题数进度一起带上，方便一眼核对');
  eq(done.statusText.includes('雨课堂'), true, '措辞标明是雨课堂的口径');
  eq(pending.completed, false, '0/6 -> 未完成');
  eq(pending.status, 'pending', '未完成不会被隐藏');
  eq(pending.progressText, '0/6', '进度 0/6');
  eq(done.description, '', '雨课堂作业没有说明字段，保持为空');
  eq(done.attachments.length, 0, '没有附件时不造假');
  eq(done.detailEnriched, true, '标记为「无需补全」，免得补全流程去抓它根本不存在的说明');
  eq(done.url, 'https://pro.yuketang.cn/ai-workspace/lms-graph/3000001/exercise/5000001?is_chapter=1&node_id=6000001', '点开跳雨课堂作业页');
  eq(done.section, 'homework', '与网络学堂作业同形，面板逻辑不用改');
  eq(done.source, 'yuketang', '来源标记');

  // 没有完成度数据时不能假装知道状态
  const unknown = toYktHomework(hw[1], { classroomId: '3000001', wlkcid: '100', completion: {} });
  eq(unknown.completed, false, '拿不到进度 -> 不算完成');
  eq(unknown.status, 'unknown', '拿不到进度 -> 状态未知，而不是猜成未提交');
  eq(unknown.statusText.includes('未知'), true, '状态未知要如实说');

  /* ---- 合并 ---- */
  const makeLearn = () => ([
    { id: '100', name: '示例课程A(1)', homework: [{ id: 'zy:100:orig', title: '网络学堂的作业', completed: false }] },
    { id: '200', name: '大学英语', homework: [] },
  ]);
  const rooms = [normalizeYktClassroom(YKT_CLASSROOM_JSON.data), normalizeYktClassroom({ id: 999, name: '2026秋-示例课程K-3', course_name: '示例课程K' })];
  const byClassroom = {
    3000001: { homework: hw, completion, sign: 'testsign-001' },
    999: { homework: [{ leafId: '1', title: '雨课堂孤儿作业', chapterId: '9', deadline: null }], completion: {}, sign: 'X' },
  };

  const learn = makeLearn();
  const res = mergeYuketang(learn, { classrooms: rooms, byClassroom });
  eq(res.added, 2, '两门作业并进了微积分那门课');
  eq(res.matched.length, 1, '匹配上的只有微积分');
  eq(res.matched[0].course, '示例课程A(1)', '并到了正确的课程上');
  eq(res.matched[0].count, 2, '并进去 2 条');
  eq(res.unmatched.length, 1, '对不上的课程如实报告');
  eq(res.unmatched[0].classroom.name, '2026秋-示例课程K-3', '报告出来的是哪一门');
  eq(learn[0].homework.length, 3, '原本那条作业还在，没有被覆盖');
  eq(learn[0].homework[0].id, 'zy:100:orig', '原有作业排在前面');
  eq(learn[0].homework[2].platform, 'yuketang', '新增的带平台标记');
  eq(learn[1].homework.length, 0, '没匹配上的课程不会被塞东西');

  // 再跑一次不能重复添加（刷新很频繁，重复会越滚越多）
  const again = mergeYuketang(learn, { classrooms: rooms, byClassroom });
  eq(again.added, 0, '重复合并不会再加一遍（去重靠 id）');
  eq(learn[0].homework.length, 3, '条目数不变');

  eq(mergeYuketang([], { classrooms: rooms, byClassroom }).added, 0, '没有网络学堂课程时不抛错');
  eq(mergeYuketang(makeLearn(), {}).added, 0, '没有雨课堂数据时啥也不做');
});

section('雨课堂：首页兜底抠 id', () => {
  const records = [
    { url: 'https://pro.yuketang.cn/v2/api/web/classrooms/3000002?role=5' },
    { url: 'https://pro.yuketang.cn/c27/online_courseware/course/classroom/3000001/has_kg/' },
    { url: 'https://pro.yuketang.cn/mooc-api/v1/lms/learn/course/chapter?cid=3000003&sign=x' },
    { url: 'https://pro.yuketang.cn/v2/api/web/userinfo' },
    { url: '' },
  ];
  const ids = classroomIdsFromRecords(records);
  eq(ids.includes('3000002'), true, '从 /classrooms/{id} 抠出来');
  eq(ids.includes('3000001'), true, '从 /course/classroom/{id} 抠出来');
  eq(ids.includes('3000003'), true, '从 ?cid= 抠出来');
  eq(ids.length, 3, '同一个 id 不重复，userinfo 这种没有 id 的不产生噪声');
  eq(classroomIdsFromRecords(null).length, 0, 'null 不抛错');

  const html = '<a href="/ai-workspace/lms-graph/3000002/exercise/1">x</a><a href="/v2/web/studentLog/3000001">y</a>';
  const fromHtml = classroomIdsFromHtml(html);
  eq(fromHtml.includes('3000002'), true, 'HTML 兜底：从 lms-graph 链接抠');
  eq(fromHtml.includes('3000001'), true, 'HTML 兜底：从 studentLog 链接抠');
  // 从站点自己的请求里学自定义头（XTBZ 之类）—— 猜值是不行的，只能学
  const recs = [
    { url: 'https://pro.yuketang.cn/a', safeHeaders: { xtbz: 'ykt', 'x-client': 'web' } },
    { url: 'https://pro.yuketang.cn/b', safeHeaders: { xtbz: 'ykt', 'x-platform': '3' } },
    { url: 'https://pro.yuketang.cn/c' },
    { url: 'https://pro.yuketang.cn/d', safeHeaders: {} },
    { url: 'https://pro.yuketang.cn/e', safeHeaders: { xtbz: '' } },
  ];
  const learned = learnedHeaders(recs);
  eq(learned.xtbz, 'ykt', '学到 xtbz 的值');
  eq(learned['x-client'], 'web', '学到 x-client');
  eq(learned['x-platform'], '3', '后续请求补上前面没有的头');
  eq(Object.keys(learnedHeaders([])).length, 0, '空输入返回空对象');
  eq(Object.keys(learnedHeaders(null)).length, 0, 'null 不抛错');
  eq(learnedHeaders([{ url: 'x' }]).xtbz, undefined, '没有 safeHeaders 的记录不产生噪声');
  eq(learnedHeaders([{ safeHeaders: { xtbz: 0 } }]).xtbz, undefined, '空值不算学到');

  // 8 门课全栽在这一句 —— 它必须能被原样报出来，且带出头名
  const xtbzErr = apiError({ success: false, msg: 'XTBZ IS REQUIRED', error_code: 40000, sub_code: 400, data: {} });
  eq(xtbzErr.includes('XTBZ IS REQUIRED'), true, '实机见到的 XTBZ 报错原文被识别为失败');
  eq(xtbzErr.includes('XTBZ'), true, '报错里带出头名 —— 下次缺别的头也能立刻看出是哪个');

  eq(classroomIdsFromHtml('').length, 0, '空 HTML 返回空数组');
  eq(classroomIdsFromHtml(null).length, 0, 'null 不抛错');

  // 站点自己取回来的章节数据 —— 比我们复现请求更可靠（请求头不一定复现得对）
  const harvested = harvestedCourseData([
    { url: 'https://pro.yuketang.cn/mooc-api/v1/lms/learn/course/chapter?cid=3000001&sign=x', responseSnippet: JSON.stringify(YKT_CHAPTER_JSON) },
    { url: 'https://pro.yuketang.cn/mooc-api/v1/lms/learn/course/schedule?cid=3000001&sign=x', responseSnippet: JSON.stringify(YKT_SCHEDULE_JSON) },
    { url: 'https://pro.yuketang.cn/mooc-api/v1/lms/learn/leaf_info/3000001/1/', responseSnippet: '{"success":true}' },
    { url: 'https://pro.yuketang.cn/v2/api/web/userinfo', responseSnippet: '{"errcode":0}' },
    { url: 'https://pro.yuketang.cn/mooc-api/v1/lms/learn/course/chapter?cid=3000002', responseSnippet: '不是 JSON' },
  ]);
  eq(Object.keys(harvested).length, 1, '只归档确实拿到数据的教室');
  eq(harvested['3000001'].chapter.data.course_id, 4000001, '章节树被捡回来了');
  eq(harvested['3000001'].schedule.data.leaf_schedules['5000001'].done, 2, '完成度也被捡回来了');
  eq(harvested['3000002'], undefined, '响应不是 JSON 的不算数');

  // 关键：站点自己拿到的如果是报错，绝不能当成数据用（否则会把失败伪装成"这门课没作业"）
  const badHarvest = harvestedCourseData([
    { url: 'https://pro.yuketang.cn/mooc-api/v1/lms/learn/course/chapter?cid=1', responseSnippet: '{"msg":"XTBZ IS REQUIRED","success":false}' },
  ]);
  eq(Object.keys(badHarvest).length, 0, '站点自己取到的报错响应不会被当成数据');

  eq(Object.keys(harvestedCourseData([])).length, 0, '空输入返回空对象');
  eq(Object.keys(harvestedCourseData(null)).length, 0, 'null 不抛错');
});

section('雨课堂：HTTP 200 也可能是一次失败', () => {
  // 这条是实机见过的原文：接口用 HTTP 200 + success:false 表示失败。
  // 不显式检查的话，「接口报错」会被读成「这门课没有数据」—— 一个会安静骗过所有人的 bug。
  eq(apiError({ success: false, msg: '数据错误', error_code: 20002, data: {} }).includes('数据错误'), true, 'success:false 被识别为失败，并带出 msg');
  eq(apiError({ success: false }).includes('20002') || apiError({ success: false }).includes('error_code'), true, '没有 msg 时退化到 error_code');
  eq(apiError({ errcode: 1, errmsg: '未登录' }).includes('未登录'), true, 'errcode 非 0 也算失败');
  eq(apiError({ errcode: 0, errmsg: 'Success' }), '', 'errcode=0 是成功');
  eq(apiError({ success: true, data: {} }), '', 'success:true 是成功');
  eq(apiError({ data: { course_chapter: [] } }), '', '既没有 success 也没有 errcode 时不误判（章节树正常响应就长这样）');
  eq(apiError(null).length > 0, true, 'null 视为异常');
  // 章节树正常响应里没有 success 字段，不能被当成失败 —— 否则所有课都会被判定为出错
  eq(apiError({ data: { course_id: 1, course_chapter: [] }, success: true }), '', '真实章节树响应不误判');
});

for (const s of sections) {
  const mark = s.failed === 0 ? '✓' : '✗';
  const line = `${mark} ${s.name} —— ${s.passed} 条通过${s.failed ? `，${s.failed} 条失败` : ''}`;
  console.log(line);
  for (const m of s.messages) console.log(`    ✗ ${m}`);
}

const failed = sections.reduce((n, s) => n + s.failed, 0);
const passed = sections.reduce((n, s) => n + s.passed, 0);

console.log('');
console.log(`断言合计：${passed + failed}（通过 ${passed}，失败 ${failed}）`);
console.log(`固定时间基准：NOW=${new Date(NOW).toLocaleString()}，NOW_HW=${new Date(NOW_HW).toLocaleString()}`);
console.log(`Node ${process.version}，时区 ${process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone}`);

if (warnings.length) {
  console.log('');
  console.log(`观察到 ${warnings.length} 处可疑行为（不计入失败，未修改源码）：`);
  warnings.forEach((w, i) => console.log(`  ${i + 1}. ${w}`));
}

console.log('');
console.log(failed === 0 ? '全部通过。' : `有 ${failed} 条断言失败。`);
process.exitCode = failed === 0 ? 0 : 1;
