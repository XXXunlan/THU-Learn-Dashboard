/**
 * 课程清单解析。
 *
 * 学生课程列表页（/f/wlxt/index/course/student/）在不同版本里长得不一样，
 * 但每门课一定会有一个带 wlkcid / courseId 的链接，这里以链接为锚点反推课程，
 * 再从“只属于这门课的那个祖先容器”里读教师、学期等元信息。
 */

import { textOfSafe } from './dom-text.js';
import { squash, absolutize, extractCourseKey } from '../common/utils.js';

const COURSE_HREF_RE = /(\/f\/wlxt\/(course|kc)\/)|([?&](wlkcid|kcid|courseid|course_id|wlkc_id)=)/i;
const TEACHER_RE = /(?:授课教师|任课教师|教师|老师|主讲)\s*[:：]?\s*([^\s,，、;；|·/]{2,24})/;
const TERM_RE = /(\d{4}\s*[-–~至]\s*\d{4}\s*(?:学年)?\s*[^\s,，|]{0,8}(?:秋季|春季|夏季|秋|春|夏)?\s*学期?)/;
const TERM_SHORT_RE = /(\d{4})\s*[-–~]?\s*(?:学年)?\s*(秋季|春季|夏季|秋|春|夏)\s*学期?/;
const CODE_RE = /\b(\d{4}\s*[-–]\s*\d{4}\s*[-–]\s*[12]\s*\)?\s*[-–]?\s*[A-Za-z0-9]{0,20})/;
const CLASS_RE = /(?:班级|教学班|课堂)\s*[:：]?\s*([^\s,，、;；|·]{1,30})/;

/** 从任意文本里挖出学期 / 教师 / 班级 */
export function extractMeta(text) {
  const t = squash(text);
  const teacher = (t.match(TEACHER_RE) || [])[1] || '';
  let term = (t.match(TERM_RE) || [])[1] || '';
  if (!term) {
    const m = t.match(TERM_SHORT_RE);
    if (m) term = `${m[1]}${m[2].startsWith('秋') ? '秋季' : m[2].startsWith('春') ? '春季' : '夏季'}学期`;
  }
  const klass = (t.match(CLASS_RE) || [])[1] || '';
  const code = (t.match(CODE_RE) || [])[1] || '';
  return {
    teacher: squash(teacher),
    term: squash(term),
    klass: squash(klass),
    code: squash(code),
  };
}

/**
 * 找到“专属这门课”的祖先容器：向上爬，只要容器里仍然只有这一门课的链接就继续，
 * 这样可以拿到包含教师/学期的卡片，而不是整个课程列表。
 */
function courseContext(anchor, key, baseUrl) {
  let best = anchor.parentElement || anchor;
  let node = best;
  for (let i = 0; i < 8 && node && node.parentElement; i++) {
    const parent = node.parentElement;
    if (!parent || parent.tagName === 'BODY' || parent.tagName === 'HTML') break;
    // 注意：必须先把 href 绝对化再取 key。extractCourseKey 内部用 new URL() 解析，
    // 直接喂相对路径（站点模板里的 href 就是相对的）会抛错，于是每个 key 都是空串、
    // keys.size 恒为 0，“容器里只有这一门课”的守卫就完全失效了。
    const keys = new Set(
      Array.from(parent.querySelectorAll('a[href]'))
        .filter((a) => COURSE_HREF_RE.test(a.getAttribute('href') || ''))
        .map((a) => courseKeyOf(absolutize(a.getAttribute('href'), baseUrl)))
        .filter(Boolean),
    );
    const textLen = squash(parent.textContent).length;
    if (keys.size <= 1 && textLen <= 600) {
      best = parent;
      node = parent;
      continue;
    }
    break;
  }
  return best;
}

function courseKeyOf(href) {
  const { wlkcid, courseId, raw } = extractCourseKey(href);
  return wlkcid || courseId || raw || '';
}

function cleanName(raw) {
  let n = squash(raw);
  n = n.replace(/\s*[(（]\s*\d{4}\s*[-–]\s*\d{4}.*$/, '');
  n = n.replace(/^\d{4}\s*[-–]\s*\d{4}\s*学年\s*[^\s]*学期\s*/, '');
  n = n.replace(/^(本科|研究生|公共)\s*[:：]\s*/, '');
  return squash(n);
}

/**
 * @param {Document} doc
 * @param {string} baseUrl
 * @returns {{courses: Array, method: string, stats: object}}
 */
export function extractCourses(doc, baseUrl) {
  const anchors = Array.from(doc.querySelectorAll('a[href]'))
    .filter((a) => COURSE_HREF_RE.test(a.getAttribute('href') || ''));

  const stats = { anchors: anchors.length };
  const byKey = new Map();

  for (const a of anchors) {
    const href = absolutize(a.getAttribute('href'), baseUrl);
    const key = courseKeyOf(href);
    if (!key) continue;
    const anchorText = squash(textOfSafe(a) || a.getAttribute('title') || '');
    const ctx = courseContext(a, key, baseUrl);
    const ctxText = squash(textOfSafe(ctx));

    const existing = byKey.get(key);
    const score = anchorText.length + (ctxText.length > anchorText.length ? 5 : 0);
    if (existing && existing.score >= score) continue;

    const heading = ctx.querySelector && ctx.querySelector('h1,h2,h3,h4,h5,h6,[class*="title"],[class*="name"]');
    const headingText = heading ? squash(textOfSafe(heading)) : '';
    const name = cleanName(anchorText.length >= 2 ? anchorText : headingText || ctxText.slice(0, 40));
    if (!name) continue;

    const meta = extractMeta(ctxText);
    // 站点原样的卡片是 <span class="teacherName">张三</span>，名字前面并没有“授课教师”标签，
    // 所以除了文本正则，还要直接读这些语义化的节点
    const teacherEl = ctx.querySelector && ctx.querySelector('.teacherName, [class*="teacherName"], [class*="teacher-name"], [class*="teacher"]');
    const teacher = meta.teacher || (teacherEl ? squash(textOfSafe(teacherEl)) : '');
    byKey.set(key, {
      score,
      id: key,
      name,
      url: href,
      teacher,
      term: meta.term,
      klass: meta.klass,
      code: meta.code,
      rawText: ctxText.slice(0, 300),
      sectionLinks: {},
      announcements: [],
      files: [],
      homework: [],
      fetchedAt: 0,
      errors: [],
    });
  }

  const courses = Array.from(byKey.values())
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
    .map(({ score, ...c }) => c);

  return {
    courses,
    method: courses.length ? 'anchor:course-href' : 'none',
    stats: { ...stats, courses: courses.length },
  };
}

/** 兜底：页面是 SPA、DOM 里还没有课程时，直接在原始 HTML 里找 wlkcid */
export function extractCoursesFromHtml(html, baseUrl) {
  const out = new Map();
  const re = /["']?wlkcid["']?\s*[:=]\s*["']?([\w-]+)["']?/gi;
  let m;
  while ((m = re.exec(html))) {
    const id = m[1];
    if (!id || out.has(id)) continue;
    out.set(id, {
      id,
      name: '',
      url: absolutize(`/f/wlxt/course/index?wlkcid=${id}`, baseUrl),
      teacher: '', term: '', klass: '', code: '',
      rawText: '', sectionLinks: {}, announcements: [], files: [], homework: [],
      fetchedAt: 0, errors: [], incomplete: true,
    });
  }
  return Array.from(out.values());
}
