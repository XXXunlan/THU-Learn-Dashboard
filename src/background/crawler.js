/**
 * 抓取编排（接口优先 + 渲染兜底）。
 *
 * 为什么是这个结构：网络学堂 2018 版前端是**客户端渲染**的 ——
 * 课程列表页返回的 HTML 里只有空容器和一个 mustache 模板，
 * 公告/文件/作业列表也都是 DataTables 服务端分页。
 * 所以“抓 HTML 再解析”这条路在真实站点上拿不到任何数据。
 *
 * 于是分两层：
 *   第一层（默认）：直接调站点自己的 JSON 接口，快、全、可翻页；
 *   第二层（兜底）：接口参数对不上时，让浏览器去打开那个列表页，
 *                  等站点自己把表格画出来，再从 DOM 里读（见 tab-scraper.js）。
 * 两层都失败才会在面板上报错，并把失败原因写进诊断。
 */

import { DAY, URGENCY, HOUR } from '../common/constants.js';
import { createLogger } from '../common/logger.js';
import { mapLimit, squash, uniqBy, sortByDeadlineThenDate, hashString } from '../common/utils.js';
import { API, PAGE, guessSemester, neighborSemesters, extractSemester, SEMESTER_RE, FILE_CATEGORY_COLUMNS } from '../api/endpoints.js';
import { apiJson, apiListViaTemplate, extractRowsDetailed } from '../api/client.js';
import { pickTemplates, rowsFromArrays } from '../api/learned.js';
import {
  normalizeCourse, normalizeNotice, normalizeFile, normalizeHomework,
  pickSemester, fromScrapedItem, fromDomItem,
} from '../api/normalize.js';
import { resolveCsrf, tokenSource, clearToken } from './csrf.js';
import { snapshotViaTab, scrapeViaTab, closeHelperTab } from './tab-scraper.js';
import { parseCourseList, parseItemList } from './offscreen-client.js';
import { ensureLogin, AuthError } from './auth.js';
import { enrichHomework } from './enrich.js';
import { crawlYuketang } from './yuketang.js';
import { getSettings, memory, setCache, appendDiagnostic } from './store.js';

const log = createLogger('crawler');

export class CancelledError extends Error {
  constructor(reason = '抓取已取消') {
    super(reason);
    this.name = 'CancelledError';
  }
}

/**
 * 抓取代次。每开始一次 crawlAll 就 +1。
 *
 * 为什么需要它：卡住的抓取不会凭空消失 —— 看门狗把它「放弃」之后，它其实还挂在
 * 某个 `await` 上；等它醒过来会继续往下跑。有了代次，它就能在下一个检查点认出
 * 自己已经被新的一次抓取取代，然后停下来 —— 否则两次抓取会同时往缓存里写。
 */
let runToken = 0;

export function currentRunToken() { return runToken; }

function assertNotCancelled(ctx) {
  if (memory.abort) throw new CancelledError();
  // ctx 里是这次抓取启动时领到的代次；不等于当前值说明已被后来的抓取取代
  if (ctx && ctx.token !== undefined && ctx.token !== runToken) {
    throw new CancelledError('这次抓取已被新的抓取取代');
  }
}

/** 截止紧急度，供 UI 上色 */
export function urgencyOf(deadline, now = Date.now()) {
  if (!deadline) return null;
  const diff = deadline - now;
  if (diff < 0) return URGENCY.OVERDUE;
  if (diff < 24 * HOUR) return URGENCY.CRITICAL;
  if (diff < 72 * HOUR) return URGENCY.SOON;
  if (diff < 7 * 24 * HOUR) return URGENCY.NORMAL;
  return URGENCY.FAR;
}

/**
 * 一个板块拿不到条目，算不算“抓取失败”？
 *
 * **接口正常应答但确实没有内容，不算失败。** 一门课没有作业、没有课件是常态，
 * 以前把这种情况也记成错误，面板就会无脑弹「部分内容可能不完整」（实测 8 门课都这样）。
 * 只有真的没走通（failed / 报错）才值得提示用户。
 */
export function isSectionFailure(section) {
  if (!section || section.items.length) return false;
  return section.method !== 'api:empty';
}

const SECTION = {
  notice: {
    label: '公告',
    tabLabel: '公告',
    listPage: PAGE.noticeList,
    normalize: normalizeNotice,
    // 全部来自真实观测：前者是课程主页用的简单 GET，后者是列表页的 DataTables 版
    endpoints: [
      { path: API.noticesBySize, params: (c) => ({ wlkcid: c.id, size: 200 }) },
      { path: API.notices, dt: true },
    ],
  },
  file: {
    label: '文件',
    tabLabel: '文件',
    listPage: PAGE.fileList,
    normalize: normalizeFile,
    endpoints: [
      // 首选：课程主页用的那个简单 GET，object 直接是对象数组，字段名与 normalizeFile 完全对应
      { path: API.filesBySize, params: (c) => ({ wlkcid: c.id, size: 300 }) },
      // 备用：分类列表 -> 逐个分类取文件（分类内文件是二维数组，靠位置化字段表还原）
      { path: API.fileCategories, params: (c) => ({ wlkcid: c.id }), expandCategories: true },
    ],
  },
  homework: {
    label: '作业',
    tabLabel: '作业',
    listPage: PAGE.homeworkList,
    normalize: normalizeHomework,
    // 站点把作业按状态分成三个接口，三个都取、合并 —— 正好符合“不列已完成作业”的需求
    merge: true,
    endpoints: [
      { path: API.homeworkNotSubmitted, params: (c) => ({ wlkcid: c.id, size: 200 }) },
      { path: API.homeworkSubmitted, params: (c) => ({ wlkcid: c.id, size: 200 }) },
      { path: API.homeworkGraded, params: (c) => ({ wlkcid: c.id, size: 200 }) },
    ],
  },
};

/**
 * 走接口取一个板块的数据。
 *
 * 与以前"猜一个接口"不同，这里每个板块有一组**已经被取证证实**的端点，
 * 逐个尝试、按需合并；响应可能是对象数组，也可能是二维数组（用位置化字段表还原）。
 */
async function fetchByApi(course, kind, ctx) {
  const conf = SECTION[kind];
  const collected = [];
  const reasons = [];
  let trusted = false;

  for (const ep of conf.endpoints) {
    const params = typeof ep.params === 'function' ? ep.params(course) : (ep.params || {});
    const res = await apiJson(ep.path, { csrf: ctx.csrf, params });
    if (!res.ok) { reasons.push(`${ep.path}: ${res.reason || '无响应'}`); continue; }

    const detail = extractRowsDetailed(res.json);
    if (!detail.matchedKey) { reasons.push(`${ep.path}: 响应里没有列表字段`); continue; }
    trusted = true;

    let rows = detail.rows;
    if (rows.length && Array.isArray(rows[0])) rows = rowsFromArrays(rows, FILE_CATEGORY_COLUMNS);

    if (ep.expandCategories) {
      // 分类列表：还要逐个分类去取里面的文件
      let expanded = 0;
      for (const cat of rows) {
        const kjflid = cat && (cat.kjflid || cat.id);
        if (!kjflid) continue;
        const sub = await apiJson(API.filesInCategory(course.id, kjflid), { csrf: ctx.csrf });
        if (!sub.ok) continue;
        const subDetail = extractRowsDetailed(sub.json);
        let subRows = subDetail.rows;
        if (subRows.length && Array.isArray(subRows[0])) subRows = rowsFromArrays(subRows, FILE_CATEGORY_COLUMNS);
        collected.push(...subRows);
        expanded += subRows.length;
      }
      log.info(`${course.name} 的文件分类展开：${rows.length} 个分类 -> ${expanded} 个文件`);
      continue;
    }

    collected.push(...rows);
    if (!conf.merge && rows.length) break;   // 非合并模式：拿到就走，不必再试后面的端点
  }

  return { rows: collected, reasons, trusted };
}

function finalize(items, kind, { now, max }) {
  const mapped = items.filter(Boolean).map((it) => {
    const deadline = kind === 'homework' ? it.deadline || null : null;
    return {
      ...it,
      section: kind,
      id: it.id || hashString(`${it.title}|${it.url}`),
      deadline,
      urgency: kind === 'homework' ? urgencyOf(deadline, now) : null,
      completed: kind === 'homework' ? it.status === 'done' : false,
    };
  });
  const deduped = uniqBy(mapped, (it) => `${squash(it.title)}|${it.url}`);
  if (kind === 'homework') return sortByDeadlineThenDate(deduped).slice(0, max);
  return deduped.sort((a, b) => (b.date || 0) - (a.date || 0)).slice(0, max);
}

/**
 * 课程主页兜底。
 *
 * 站点把公告 / 文件 / 作业三张表都聚合在课程主页上
 * （`#ggalltable` / `#kjalltable` / `#zyalltable` 都在那一页，这是它自己模板里的 id）。
 * 所以当某个板块的“专用列表页”拿不到东西时，课程主页是最可靠的退路。
 * 每门课只拉一次，三个板块共用同一份结果。
 */
async function courseHomeItems(course, ctx) {
  if (ctx.homeCache.has(course.id)) return ctx.homeCache.get(course.id);
  const payload = { byKind: { notice: [], file: [], homework: [] }, error: '', method: '' };
  try {
    const shot = await snapshotViaTab(course.url, { settleMs: ctx.settings.tabSettleMs || 3500, kind: 'auto' });
    learnFrom(shot.sniffed, ctx);
    const parsed = await parseItemList(shot.html, shot.url, 'auto', { now: ctx.now, maxItems: ctx.settings.maxItemsPerCourse });
    payload.method = parsed.method;
    for (const it of parsed.items) {
      const bucket = payload.byKind[it.section] ? it.section : 'notice';
      payload.byKind[bucket].push(it);
    }
    const total = parsed.items.length;
    log.info(`课程主页兜底：${course.name} 解析到 ${total} 条（公告 ${payload.byKind.notice.length} / 文件 ${payload.byKind.file.length} / 作业 ${payload.byKind.homework.length}）`);
    if (!total) {
      payload.error = `课程主页也没有解析到条目（${parsed.method}）`;
      ctx.captureFailure && ctx.captureFailure({ url: shot.url, kind: 'home', html: shot.html, method: parsed.method, rows: shot.rows, reason: payload.error });
    }
  } catch (err) {
    payload.error = `课程主页兜底失败：${err.message}`;
  }
  ctx.homeCache.set(course.id, payload);
  return payload;
}

/** 一个板块：先模板重放，再猜参数的接口，最后页面兜底 */
async function fetchSection(course, kind, ctx) {
  const { csrf, settings, now, samples } = ctx;
  const conf = SECTION[kind];
  const result = { items: [], method: '', reason: '', viaFallback: false };

  // 路径 0：用学到的模板重放站点自己的请求（参数是它的原话，最可靠）
  const tpl = ctx.templates && ctx.templates[kind];
  if (tpl) {
    const viaTpl = await apiListViaTemplate(tpl, { wlkcid: course.id, csrf });
    const rows = viaTpl.rows.map((row) => conf.normalize(row, course.id, now)).filter(Boolean);
    if (rows.length) {
      result.items = rows;
      result.method = viaTpl.via;
      return result;
    }
    result.reason = `模板重放没拿到数据：${viaTpl.reason}`;
  }

  const api = await fetchByApi(course, kind, ctx);
  const fromApi = api.rows.map((row) => conf.normalize(row, course.id, now)).filter(Boolean);
  if (fromApi.length) {
    result.items = fromApi;
    result.method = `api:${api.rows.length}条`;
    return result;
  }
  result.reason = result.reason ? `${result.reason}；接口也没拿到：${api.reasons.join('；')}` : (api.reasons.join('；') || '接口没有返回数据');

  // 接口按约定的形状回答了「就是没有」，那就是真的没有 —— 不要为每个空板块
  // 都去开一次隐藏标签页（一门课三个板块 × 十几门课，那会白白多花几分钟）
  if (api.trusted) {
    result.method = 'api:empty';
    return result;
  }

  if (!settings.tabFallback) {
    result.method = 'api:empty';
    return result;
  }

  // 兜底很贵（要开页面、等渲染）。在付出这个代价之前**再确认一次**：
  // 刚才这段时间里，别的课程可能已经把模板学出来了 —— 那就直接走接口。
  // 这一条能砍掉绝大部分兜底次数（第一门课学会模板，后面的课全都受益）。
  const lateTpl = ctx.templates && ctx.templates[kind];
  if (lateTpl && lateTpl !== tpl) {
    const retry = await apiListViaTemplate(lateTpl, { wlkcid: course.id, csrf });
    const rows = retry.rows.map((row) => conf.normalize(row, course.id, now)).filter(Boolean);
    if (rows.length) {
      result.items = rows;
      result.method = `${retry.via}(晚到)`;
      return result;
    }
  }

  const pageUrl = conf.listPage(course.id);
  const settle = { settleMs: settings.tabSettleMs || 3500, kind, tabLabel: conf.tabLabel };

  // 兜底 1：让站点渲染这一页，把 HTML 交给离屏解析器（与主路径同一套解析器）
  try {
    const shot = await snapshotViaTab(pageUrl, settle);
    // 顺手把站点自己发的请求学下来，下次就能直接重放（不必再渲染页面）
    learnFrom(shot.sniffed, ctx);
    const parsed = await parseItemList(shot.html, shot.url, kind, { now, maxItems: settings.maxItemsPerCourse });
    const items = parsed.items.map((it) => fromDomItem(it, kind, course.id, now)).filter(Boolean);
    if (items.length) {
      result.items = items;
      result.method = `tab:${parsed.method}`;
      result.viaFallback = true;
      if (samples.length < 3) samples.push({ url: shot.url, kind, method: result.method, count: items.length });
      return result;
    }
    result.reason += `；兜底渲染后仍无条目（${parsed.method}）`;
    // 解析不出东西时，把这一页的 HTML 存下来当证据 —— 下次诊断包里就能直接看到它长什么样
    ctx.captureFailure && ctx.captureFailure({ url: shot.url, kind, html: shot.html, method: parsed.method, rows: shot.rows, reason: result.reason });
  } catch (err) {
    result.reason += `；兜底渲染失败：${err.message}`;
    ctx.captureFailure && ctx.captureFailure({ url: pageUrl, kind, html: '', method: 'error', reason: result.reason });
  }

  // 兜底 2：内容脚本按表头定位列，直接从渲染好的表格里读
  try {
    const scraped = await scrapeViaTab(pageUrl, kind, settle);
    const items = scraped.items.map((raw) => fromScrapedItem(raw, kind, course.id, now)).filter(Boolean);
    if (items.length) {
      result.items = items;
      result.method = `tab2:${scraped.method}`;
      result.viaFallback = true;
      return result;
    }
    result.reason += '；按表头读取也是空';
  } catch (err) {
    result.reason += `；按表头读取失败：${err.message}`;
  }

  // 兜底 3：课程主页（三个板块的表都在那一页，且每门课只拉一次）
  const home = await courseHomeItems(course, ctx);
  const fromHome = (home.byKind[kind] || []).map((it) => fromDomItem(it, kind, course.id, now)).filter(Boolean);
  if (fromHome.length) {
    result.items = fromHome;
    result.method = `tab:课程主页(${home.method})`;
    result.viaFallback = true;
    return result;
  }
  if (home.error) result.reason += `；${home.error}`;

  result.method = 'failed';
  log.warn(`${course.name} 的${conf.label}抓取失败：${result.reason}`);
  return result;
}

/**
 * 把嗅探到的请求变成可重放的模板，存进本次抓取的上下文。
 * @returns {number} 新学到的模板数
 */
function learnFrom(records, ctx) {
  if (!records || !records.length) return 0;
  let learned = 0;
  try {
    const found = pickTemplates(records);
    for (const [kind, tpl] of Object.entries(found)) {
      const old = ctx.templates[kind];
      // 带检索条件、且状态码正常的模板更可信
      if (!old || (tpl.score || 0) > (old.score || 0)) {
        ctx.templates[kind] = { url: tpl.url, method: tpl.method, body: tpl.body, score: tpl.score, learnedAt: Date.now() };
        learned++;
      }
    }
    if (learned) log.info(`从站点自己的请求里学到 ${learned} 个接口模板`);
  } catch (err) {
    log.warn('学习接口模板失败（忽略）', err && err.message);
  }
  return learned;
}

async function crawlCourse(course, ctx) {
  const { csrf, settings, now } = ctx;
  const out = { ...course, announcements: [], files: [], homework: [], errors: [], fetchedAt: 0, stats: {} };

  for (const kind of ['homework', 'notice', 'file']) {
    assertNotCancelled(ctx);
    try {
      const sec = await fetchSection(course, kind, ctx);
      out.stats[kind] = `${sec.items.length} 条 · ${sec.method}`;
      if (kind === 'homework') out.homework = sec.items;
      else if (kind === 'notice') out.announcements = sec.items;
      else out.files = sec.items;
      // 只有**真的失败**才算错误。接口正常应答但确实没有内容（api:empty）是常态 ——
      // 以前把它也记成错误，面板就会无脑弹「部分内容可能不完整」（8 门课都这样）。
      if (isSectionFailure(sec)) {
        out.errors.push({ scope: kind, message: sec.reason || '没有解析到任何条目' });
      }
    } catch (err) {
      if (err instanceof CancelledError) throw err;
      out.errors.push({ scope: kind, message: err.message });
    } finally {
      // 进度按**板块**推进（3 个/门课），而不是等整门课跑完才动一下 ——
      // 否则并发 worker 都堵在辅助标签页上时，进度条会长时间纹丝不动。
      ctx.step && ctx.step(course.name, kind);
    }
  }

  const max = settings.maxItemsPerCourse;
  out.announcements = finalize(out.announcements, 'notice', { now, max });
  out.files = finalize(out.files, 'file', { now, max });
  out.homework = finalize(out.homework, 'homework', { now, max });
  out.pendingCount = out.homework.filter((h) => !h.completed).length;
  out.errorCount = out.errors.length;
  out.fetchedAt = Date.now();
  return out;
}

/**
 * 确定当前学期。
 *
 * 站点那个"当前学期"接口**实测返回不了可用值**（`resultList` 是空的），
 * 所以不能只靠它。这里改成三级策略，而且**最终以课程数据为准**：
 *
 *   1. 用户在设置里手动指定的（最高优先级，永远说了算）
 *   2. 学期接口 —— 但不再按字段名解析，而是直接在序列化结果里找 "2026-2027-1" 这种串，
 *      它包几层、字段叫什么都能捞出来
 *   3. 用日期推断，然后**拿课程清单去验证**：有课就说明猜对了；
 *      没课就试前后相邻的学期 —— 这样即便猜错也能自己纠正回来
 *
 * 只有三级全失败（真的没课）才提示用户手动填，而不是一上来就报"可能不完整"。
 */
async function resolveSemester(csrf, settings, notes) {
  const override = String(settings.semesterOverride || '').trim();
  if (SEMESTER_RE.test(override)) {
    const m = override.match(SEMESTER_RE);
    return { semester: m[1], source: 'user', notes };
  }

  const fromApi = [];
  for (const [label, path] of [
    ['当前学期接口', API.currentSemester],
    ['学期列表接口', API.semesterList],
  ]) {
    try {
      const res = await apiJson(path, { csrf });
      if (!res.ok) continue;
      // 先按已知结构取；取不到再退到“在序列化结果里直接找学期码”，
      // 这样它换个字段名、多包一层也照样能捞出来
      const found = pickSemester(res.json, '') || extractSemester(res.json);
      if (found) fromApi.push({ label, semester: found });
    } catch { /* 接口不可用就跳过 */ }
  }
  if (fromApi.length) {
    notes.push(`学期取自${fromApi[0].label}：${fromApi[0].semester}`);
    return { semester: fromApi[0].semester, source: `${fromApi[0].label}`, notes };
  }

  // 接口都没给 → 用日期推断 + 用课程数据反证
  const guess = guessSemester();
  const candidates = [guess, ...neighborSemesters(guess)];
  const tried = [];
  for (const sem of candidates) {
    try {
      const res = await apiJson(API.coursesBySemester(sem), { csrf });
      const rows = rowsOf(res.json);
      tried.push(`${sem}:${rows.length}门`);
      if (rows.length) {
        if (sem === guess) {
          notes.push(`站点没有提供「当前学期」接口值，已按日期推断为 ${sem}，并用课程清单验证通过（${rows.length} 门课）`);
        } else {
          notes.push(`按日期推断的 ${guess} 没有课程，改用邻近学期 ${sem}（验证到 ${rows.length} 门课）`);
        }
        return { semester: sem, source: sem === guess ? 'guess-verified' : 'guess-neighbor', notes, prefetched: rows, tried };
      }
    } catch (err) {
      tried.push(`${sem}:${err.message}`);
    }
  }

  notes.push(`无法确定学期（试过 ${tried.join('、')}，都没有课程）。可以在「设置」里手动指定学期。`);
  return { semester: guess, source: 'guess-unverified', notes, tried, needUserInput: true };
}

/** 从课程接口响应里取出行（兼容 {message,resultList} 与 {object:{...}} 等外壳） */
function rowsOf(json) {
  if (Array.isArray(json)) return json.filter((x) => x && typeof x === 'object');
  const detail = extractRowsDetailed(json);
  return detail.rows.filter((x) => x && typeof x === 'object' && !Array.isArray(x));
}

/** 取课程清单（主修 + 辅修/双学位） */
async function loadCourses(csrf, settings, { onProgress }) {
  const notes = [];      // 信息性说明（例如“学期是这么定下来的”），不该报警
  const problems = [];   // 真正的失败
  const resolved = await resolveSemester(csrf, settings, notes);
  const semester = resolved.semester;

  const raw = [...(resolved.prefetched || [])];
  if (!raw.length) {
    const main = await apiJson(API.coursesBySemester(semester), { csrf });
    const mainRows = rowsOf(main.json);
    raw.push(...mainRows);
    if (!main.ok) problems.push(`主修课程接口失败：${main.reason || '无响应'}`);
  }

  // 辅修/双学位是另一套接口，单独取一次，能取到就合并
  const asco = await apiJson(API.asCoCourses(semester), { csrf });
  const ascoRows = rowsOf(asco.json);
  if (ascoRows.length) raw.push(...ascoRows);

  let courses = uniqBy(raw.map((r) => normalizeCourse(r)).filter(Boolean), (c) => c.id);

  // 接口只给了 id、没给课程名（真实发生过：10 门课全部退化成「课程 <id>」）。
  // 课程名与教师信息在渲染后的课程列表页上是完整可靠的，从这里补齐。
  const placeholder = /^课程\s/;
  const missingName = courses.filter((c) => placeholder.test(c.name || '')).length;
  const needDom = !courses.length || missingName > 0;
  if (needDom) {
    try {
      const shot = await snapshotViaTab(PAGE.courseList, { settleMs: 4500 });
      const parsed = await parseCourseList(shot.html, shot.url);
      if (!courses.length) {
        // 接口一门课都没给：直接用页面上解析到的课程
        const fromDom = parsed.courses
          .map((c) => normalizeCourse({ kcid: c.id, name: c.name, kcurl: c.url, teacherName: c.teacher }))
          .filter(Boolean);
        if (fromDom.length) {
          notes.push(`接口没返回课程，改从渲染后的课程列表页解析到 ${fromDom.length} 门`);
          onProgress && onProgress({ message: `兜底：从页面解析到 ${fromDom.length} 门课程` });
          return { courses: fromDom, semester, notes, semesterSource: `${resolved.source}+DOM`, needUserInput: false };
        }
        notes.push(`课程列表页也没解析出课程（DOM 方法：${parsed.method}）`);      } else {
        const byId = new Map(parsed.courses.map((c) => [c.id, c]));
        let filled = 0;
        courses = courses.map((c) => {
          const d = byId.get(c.id);
          if (!d) return c;
          const merged = {
            ...c,
            name: (!c.name || placeholder.test(c.name)) && d.name ? d.name : c.name,
            teacher: c.teacher || d.teacher || '',
            term: c.term || d.term || '',
            location: c.location || d.klass || '',
            url: d.url || c.url,
          };
          if (merged.name !== c.name) filled++;
          return merged;
        });
        notes.push(`接口没给课程名（${missingName} 门），已从渲染后的课程列表页补齐 ${filled} 门（DOM 解析到 ${parsed.courses.length} 门）`);
      }
    } catch (err) {
      problems.push(`课程列表页兜底失败：${err.message}`);
    }
  }

  onProgress && onProgress({ message: `学期 ${semester}：发现 ${courses.length} 门课程` });
  return {
    courses, semester, notes, problems,
    semesterSource: resolved.source,
    needUserInput: resolved.needUserInput,
  };
}

/**
 * 主入口。
 * @param {{onProgress?:Function, force?:boolean, onlyCourseIds?:string[]}} opts
 */
export async function crawlAll({ onProgress = () => {}, force = false, onlyCourseIds = null } = {}) {
  const started = Date.now();
  const myToken = ++runToken;
  memory.abort = false;
  const settings = await getSettings();
  const now = Date.now();
  const errors = [];
  const samples = [];
  const methods = {};

  // 已学到的接口模板（上次抓取时从站点自己的请求里学来的），本次优先使用
  let templates = {};
  try {
    const saved = (await chrome.storage.local.get('learnedTemplates')).learnedTemplates;
    if (saved && typeof saved === 'object') templates = saved;
    if (Object.keys(templates).length) methods.templates = Object.keys(templates).join(',');
  } catch { /* 没有就算了 */ }

  const report = (patch) => {
    memory.progress = { ...(memory.progress || {}), ...patch, updatedAt: Date.now() };
    try { onProgress(memory.progress); } catch { /* ignore */ }
  };

  report({ running: true, phase: 'auth', done: 0, total: 0, message: '检查登录状态…' });

  let csrf = '';
  try {
    csrf = await resolveCsrf({ force });
    methods.csrf = tokenSource() || 'none';
  } catch (err) {
    methods.csrf = `error:${err.message}`;
  }

  // 接口探测：能拿到 JSON 就说明会话有效（比解析 HTML 判断登录可靠得多）
  report({ phase: 'auth', message: '校验会话…' });
  let apiBlocked = '';
  const probe = await apiJson(API.currentSemester, { csrf });
  if (!probe.ok) {
    // 可能是缺 token，清掉再试一次
    if (csrf) {
      clearToken();
      csrf = await resolveCsrf({ force: true }).catch(() => '');
    }
    const retry = await apiJson(API.currentSemester, { csrf });
    if (!retry.ok) {
      const session = await ensureLogin({});
      if (!session.loggedIn) {
        memory.progress = null;
        throw new AuthError(session.message || '需要先登录网络学堂', session);
      }
      // 已登录但接口调不通（缺 _csrf、后台请求没带上 cookie、或站点改版）：
      // **不终止**，整体降级到“让浏览器自己渲染页面再读”的兜底路径。
      apiBlocked = `接口不可用（${retry.reason || '未知原因'}），本次抓取改用页面兜底路径`;
      errors.push({ scope: 'auth', message: apiBlocked });
      methods.apiBlocked = true;
      log.warn(apiBlocked);
    }
  }

  assertNotCancelled({ token: myToken });

  report({ phase: 'courses', message: '获取课程清单…' });
  const courseInfo = await loadCourses(csrf, settings, { onProgress: report });
  const { courses: allCourses, semester, notes } = courseInfo;
  methods.semester = `${semester}（${courseInfo.semesterSource || '未知来源'}）`;
  // 信息性说明单独存：以前把它们塞进 errors，面板就无脑弹「部分内容可能不完整」，
  // 而其实什么都没坏 —— 这类提示应该只在真出问题时出现。
  errors.push(...(courseInfo.problems || []));
  if (courseInfo.needUserInput) methods.needSemesterInput = true;

  let courses = allCourses;
  if (!courses.length) {
    errors.push({ scope: 'course-list', message: '课程清单为空：接口没有返回课程（可能是学期码不对，或本学期没有选课）' });
  }
  if (onlyCourseIds && onlyCourseIds.length) courses = courses.filter((c) => onlyCourseIds.includes(c.id));

  const totalSteps = courses.length * 3;
  let stepDone = 0;
  const failures = [];
  const ctx = {
    csrf, settings, now, samples, templates,
    token: myToken,
    homeCache: new Map(),
    step: (courseName, kind) => {
      stepDone++;
      report({
        done: stepDone,
        total: totalSteps,
        current: courseName,
        message: `已完成 ${stepDone}/${totalSteps} 个板块（${courseName} · ${SECTION[kind].label}）`,
      });
    },
    // 某个板块解析不出东西时，把那一页的 HTML 留下来当证据
    captureFailure: ({ url, kind, html, method, rows, reason }) => {
      if (failures.length >= 4) return;
      failures.push({
        url, kind, method, rows: rows || 0, reason: (reason || '').slice(0, 200),
        at: Date.now(),
        html: String(html || '').slice(0, 300000),
      });
    },
  };

  report({ phase: 'detail', done: 0, total: totalSteps, message: `共 ${courses.length} 门课程、${totalSteps} 个板块，开始抓取…` });

  const results = [];
  const wrap = (course) => async () => {
    assertNotCancelled(ctx);
    try {
      return await crawlCourse(course, ctx);
    } catch (err) {
      if (err instanceof CancelledError) throw err;
      return {
        ...course,
        announcements: [], files: [], homework: [],
        errors: [{ scope: 'course', message: err.message }],
        pendingCount: 0, errorCount: 1, stats: {}, fetchedAt: Date.now(),
      };
    }
  };

  try {
    // **先单独跑第一门课**：它的兜底会把站点自己的接口请求学下来变成模板，
    // 后面的课就能直接走接口，不必再一个个开页面渲染。
    // 实测这一步能把兜底页面加载次数从 30 次降到 3 次左右。
    if (courses.length > 1) {
      report({ message: `先抓「${courses[0].name}」以学习站点接口…`, done: 0, total: totalSteps });
      results.push(await wrap(courses[0])());
    }
    const rest = courses.length > 1 ? courses.slice(1) : courses;
    if (rest.length) {
      const batch = await mapLimit(rest, Math.max(1, Math.min(settings.concurrency || 4, 8)), (c) => wrap(c)());
      results.push(...batch);
    }
    assertNotCancelled({ token: myToken });
  } finally {
    // 无论成功、失败还是被取消，兜底用的辅助窗口都要收掉
    await closeHelperTab();
  }

  const good = results.filter((c) => c && !c.__error);
  for (const r of results) if (r && r.__error) errors.push({ scope: 'course', message: r.__error });

  const stats = {
    courses: good.length,
    semester,
    notices: good.reduce((s, c) => s + c.announcements.length, 0),
    files: good.reduce((s, c) => s + c.files.length, 0),
    homework: good.reduce((s, c) => s + c.homework.length, 0),
    pending: good.reduce((s, c) => s + c.homework.filter((h) => !h.completed).length, 0),
    dueSoon: good.reduce((s, c) => s + c.homework.filter((h) => !h.completed && h.urgency && h.urgency !== URGENCY.FAR).length, 0),
    courseErrors: good.filter((c) => c.errors && c.errors.length).length,
    usedFallback: good.filter((c) => Object.values(c.stats || {}).some((v) => String(v).includes('tab:'))).length,
    methods,
  };

  const cache = {
    fetchedAt: Date.now(),
    startedAt: started,
    finishedAt: Date.now(),
    durationMs: Date.now() - started,
    courses: good,
    errors: errors.slice(0, 40),
    // 信息性说明（例如学期是怎么定下来的）与错误分开存：
    // 面板只在 errors 非空时才提示「部分内容可能不完整」
    notes: notes.slice(0, 40),
    stats,
    scope: onlyCourseIds && onlyCourseIds.length ? 'partial' : 'all',
  };

  // 主抓取先落盘：这样即使后面的补全很慢或失败，用户也已经能看到完整列表了
  await setCache(cache);

  // ---- 3.5 雨课堂作业（另一个平台、另一套账号体系）----
  // 放在主抓取之后：网络学堂那一秒刷新不该被另一个平台的登录状态拖累。
  if (settings.yuketangHomework !== false) {
    try {
      report({ phase: 'yuketang', message: '获取雨课堂作业…' });
      const ykt = await crawlYuketang({
        learnCourses: good,
        settleMs: settings.tabSettleMs || 4500,
        onProgress: (p) => report({ phase: 'yuketang', message: p.message }),
      });

      stats.yuketang = {
        ok: ykt.ok,
        needPermission: !!ykt.needPermission,
        classrooms: ykt.classrooms.length,
        matched: ykt.matched.length,
        unmatched: ykt.unmatched.length,
        found: ykt.homeworkCount,
        added: ykt.added,
        listVia: ykt.listVia,
        listPath: ykt.listPath,
      };
      notes.push(...(ykt.notes || []));
      errors.push(...(ykt.errors || []));
      // ⚠️ 必须同步写回 cache 上的这两个数组：它们是**雨课堂那步之前**做的快照，
      // 而后面「补全说明」那一步还会拿 {...cache} 再写一次缓存 ——
      // 不在这里更新，雨课堂的报错和说明会被那一步悄悄抹掉，界面上一片安静。
      cache.errors = errors.slice(0, 40);
      cache.notes = notes.slice(0, 40);

      if (ykt.added) {
        // 并入之后必须重新过一遍 finalize：
        // urgency 和 completed 是 finalize 算出来的，而雨课堂的条目是它之后才加进来的，
        // 不补这一步排序会乱、紧急度会缺失（角标和筛选都依赖它们）。
        for (const c of good) {
          if (!(c.homework || []).some((h) => h.platform === 'yuketang')) continue;
          const cap = Math.max(settings.maxItemsPerCourse || 60, c.homework.length);
          c.homework = finalize(c.homework, 'homework', { now: Date.now(), max: cap });
        }
        stats.homework = good.reduce((s, c) => s + c.homework.length, 0);
        stats.pending = good.reduce((s, c) => s + c.homework.filter((h) => !h.completed).length, 0);
        stats.dueSoon = good.reduce((s, c) => s + c.homework.filter((h) => !h.completed && h.urgency && h.urgency !== URGENCY.FAR).length, 0);
      }

      await setCache({ ...cache, courses: good, stats, notes: notes.slice(0, 40), errors: errors.slice(0, 40) });
      log.info('雨课堂并入完成', stats.yuketang);
    } catch (err) {
      if (err instanceof CancelledError) throw err;
      // 雨课堂失败**不能**影响网络学堂已经拿到的数据
      log.warn('雨课堂抓取失败（不影响网络学堂数据）', err && err.message);
      errors.push({ scope: 'yuketang', message: `雨课堂抓取失败：${err.message}` });
    } finally {
      await closeHelperTab();
    }
  }

  // ---- 4. 补全作业说明与附件（放在主流程之后，不拖慢上面的一秒刷新）----
  if (settings.enrichHomework !== false) {
    try {
      report({ phase: 'enrich', message: '补全作业说明与附件…' });
      const stat = await enrichHomework(good, {
        maxItems: settings.enrichMaxItems || 20,
        settleMs: settings.tabSettleMs || 3500,
        onProgress: (p) => report({ phase: 'enrich', message: p.message }),
      });
      stats.enrich = stat;
      // 只要真的尝试过补全就重写缓存 —— 哪怕一条都没拿到。
      // 否则"补全一无所获"这种情况下诊断包里看不到任何线索（而这正是最需要排查的情形）。
      // errors / notes 用**当前的**数组，不要用 cache 上那份旧快照（那会抹掉雨课堂那步的报错）。
      cache.errors = errors.slice(0, 40);
      cache.notes = notes.slice(0, 40);
      await setCache({ ...cache, courses: good, stats });
    } catch (err) {
      if (err instanceof CancelledError) throw err;
      log.warn('作业补全失败（不影响已有数据）', err && err.message);
      errors.push({ scope: 'enrich', message: `作业说明/附件补全失败：${err.message}` });
    } finally {
      // 补全会重新开一个辅助窗口（主流程那个 earlier 已经关了），这里必须再收一次，
      // 否则用户的任务栏里会一直留着一个最小化的窗口。
      await closeHelperTab();
    }
  }

  // 把这次学到的接口模板持久化，下次抓取就能直接走接口（快很多）
  try {
    if (Object.keys(templates).length) {
      await chrome.storage.local.set({ learnedTemplates: templates });
      stats.methods.templates = Object.keys(templates).join(',');
    }
  } catch (err) {
    log.warn('保存接口模板失败', err && err.message);
  }

  await appendDiagnostic({
    at: Date.now(),
    durationMs: cache.durationMs,
    stats,
    errors: errors.slice(0, 20),
    sampleErrors: good.filter((c) => c.errors.length).slice(0, 5).map((c) => ({ course: c.name, errors: c.errors.slice(0, 3) })),
    samples,
    failureSnapshots: failures.map((f) => ({ url: f.url, kind: f.kind, method: f.method, rows: f.rows, reason: f.reason, htmlLength: (f.html || '').length })),
  });

  // 整页 HTML 单独存：**失败页面的 HTML 是最有价值的证据** ——
  // 导出诊断后就能直接看到"那一页到底长什么样"，不用再让用户手动去页面上采集。
  try {
    const failSnaps = failures.map((f) => ({
      url: f.url, kind: f.kind, method: f.method, count: f.rows, at: f.at,
      reason: f.reason, failed: true, html: f.html,
    }));
    const okSnaps = samples
      .filter((s) => s.html)
      .map((s) => ({ url: s.url, kind: s.kind, method: s.method, count: s.count, at: Date.now(), html: s.html }));
    await chrome.storage.local.set({ snapshots: [...failSnaps, ...okSnaps].slice(0, 6) });
    log.info(`已保存 ${failSnaps.length} 份失败页样本、${okSnaps.length} 份成功页样本`);
  } catch (err) {
    log.warn('保存页面样本失败', err && err.message);
  }

  memory.progress = {
    running: false, phase: 'done', done: totalSteps, total: totalSteps,
    message: `完成，用时 ${(cache.durationMs / 1000).toFixed(1)}s`,
  };  report({ running: false, phase: 'done' });
  log.info('抓取完成', stats);
  return cache;
}

/** 角标：3 天内截止的未交作业数 */
export function countUrgent(cache, now = Date.now()) {
  if (!cache || !cache.courses) return 0;
  let n = 0;
  for (const c of cache.courses) {
    for (const hw of c.homework || []) {
      if (hw.completed || !hw.deadline) continue;
      if (hw.deadline - now < 3 * DAY) n++;
    }
  }
  return n;
}

export { AuthError };
