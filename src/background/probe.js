/**
 * 全面取证（一次性收集）。
 *
 * 存在的理由：排查这个站点靠一来一回地"改一版、你跑一次、发我诊断"效率太低。
 * 站点的列表页是聚合页 + 标签切换 + 服务端分页，接口参数又只能从它自己的请求里学，
 * 所以把**所有可能需要的东西一次性抓齐**，之后就能离线把接口层和解析层写对。
 *
 * 收集内容：
 *   1. 环境：版本、会话判定、_csrf 来源、已学到的模板
 *   2. 站点自己的 `/b/` 请求：**URL + 方法 + 请求体 + 响应体**（响应体是最关键的）
 *   3. 各类页面的**结构化骨架**：每张表的 id/class、表头文字、行数、首行 HTML
 *   4. 精简后的整页 HTML（保留全部元素，只去掉 script/style）
 *   5. 直接调用各个候选接口的原始响应（用于确认哪个接口是活的）
 *
 * 输出是一个自包含的 JSON，离线看它就能知道：哪个接口、什么参数、什么字段。
 */

import { ORIGIN, API, PAGE } from '../api/endpoints.js';
import { createLogger } from '../common/logger.js';
import { snapshotViaTab, closeHelperTab } from './tab-scraper.js';
import { checkSession } from './auth.js';
import { resolveCsrf, cachedToken, tokenSource } from './csrf.js';
import { getSettings, getCache, getDiagnostics } from './store.js';
import { apiJson } from '../api/client.js';

const log = createLogger('probe');

const HTML_LIMIT = 200000;
const RESPONSE_LIMIT = 20000;

/**
 * 去掉 script/style/注释，但**保留全部元素** —— 我们要看的是结构。
 *
 * ⚠️ 第一版把脚本替换成 `<script/>`，这是个**真 bug**：HTML 里 `<script/>` 不是自闭合，
 * 真实浏览器会把它当成「脚本开始」，把后面整个文档都吞进脚本内容里，
 * 于是导出的快照再用 DOMParser 解析时 body 直接是空的。（我自己就被它误导了一轮。）
 * 换成注释标记就安全了。
 */
export function slimHtml(html, max = HTML_LIMIT) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, '<!--script-->')
    .replace(/<style[\s\S]*?<\/style>/gi, '<!--style-->')
    .replace(/<!--(?!script|style)[\s\S]*?-->/g, '')
    .replace(/\s{2,}/g, ' ')
    .slice(0, max);
}

/** 纯文本骨架：把 HTML 里可能藏字段名的地方挑出来 */
export function outline(html) {
  const text = String(html || '');
  const tables = [];
  for (const m of text.matchAll(/<table\b[^>]*>[\s\S]*?<\/table>/gi)) {
    const seg = m[0];
    const id = (seg.match(/\bid\s*=\s*"([^"]*)"/) || [])[1] || '';
    const cls = (seg.match(/\bclass\s*=\s*"([^"]*)"/) || [])[1] || '';
    const heads = [...seg.matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/gi)].map((x) => stripTags(x[1]));
    const bodyRows = [...seg.matchAll(/<tbody\b[^>]*>([\s\S]*?)<\/tbody>/gi)]
      .map((x) => (x[1].match(/<tr\b/gi) || []).length)
      .reduce((a, b) => a + b, 0);
    const firstRow = (seg.match(/<tbody\b[^>]*>[\s\S]*?<tr\b[^>]*>[\s\S]*?<\/tr>/i) || [''])[0];
    tables.push({ id, cls, heads, rows: bodyRows, firstRowHtml: firstRow.slice(0, 800) });
  }
  const ids = [...text.matchAll(/\bid\s*=\s*"([^"]+)"/g)].map((x) => x[1]);
  const tabTexts = [...text.matchAll(/<a\b[^>]*onclick\s*=\s*"([^"]*tabchange[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi)]
    .map((x) => ({ onclick: x[1], text: stripTags(x[2]) }));
  return {
    tables,
    ids: [...new Set(ids)].slice(0, 120),
    tabLinks: tabTexts,
    hasDataTablesEmpty: /dataTables_empty/.test(text),
    emptyStateTexts: [...new Set((text.match(/没有您要搜索的内容|表中数据为空|暂无数据|暂无记录/g) || []))],
    bodyTextSample: stripTags(text).slice(0, 1500),
  };
}

function stripTags(html) {
  return String(html || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

/** 站点自己的请求：把最有价值的那部分挑出来（含响应体） */
export function summarizeRequests(records) {
  const seen = new Set();
  const out = [];
  for (const r of records || []) {
    if (!r || !r.url) continue;
    // 只留网络学堂自己的请求。嗅探器本来就只记 /b/(wlxt|kc)/，
    // 但万一有第三方请求的地址里也带这段，别让它污染取证结果。
    const raw = String(r.url);
    if (/^https?:/i.test(raw)) {
      try {
        if (!/learn\.tsinghua\.edu\.cn$/i.test(new URL(raw).hostname)) continue;
      } catch { continue; }
    }
    const key = `${r.method || 'GET'} ${raw.split('?')[0]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      method: r.method || 'GET',
      url: raw,
      body: (r.body || '').slice(0, 4000),
      status: r.status,
      responseSnippet: String(r.responseSnippet || '').slice(0, RESPONSE_LIMIT),
      responseLength: String(r.responseSnippet || '').length,
    });
  }
  return out;
}

/** 直接调一批候选接口，看哪个是活的（原始响应最有说服力） */
async function probeEndpoints(csrf, wlkcid) {
  const out = [];
  const size = 100;

  /** 统一的 GET 探针：把 URL、状态、响应体原文都记下来 */
  const get = async (label, path, params = {}) => {
    const qs = new URLSearchParams({ ...params, _csrf: csrf || '' }).toString();
    const url = `${ORIGIN}${path}?${qs}`;
    const rec = { label, method: 'GET', path, url, status: 0, note: '', responseSnippet: '' };
    try {
      const res = await fetch(url, {
        credentials: 'include', redirect: 'manual', cache: 'no-store',
        headers: { Accept: 'application/json, text/javascript, */*; q=0.01', 'X-Requested-With': 'XMLHttpRequest' },
      });
      if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) {
        rec.status = res.status; rec.note = '被重定向';
      } else {
        const text = await res.text();
        rec.status = res.status;
        rec.responseSnippet = text.slice(0, RESPONSE_LIMIT);
        rec.note = /^\s*</.test(text) ? '返回 HTML' : '返回疑似 JSON';
      }
    } catch (err) { rec.note = `请求失败：${err.message}`; }
    out.push(rec);
    return rec;
  };

  if (!wlkcid) return out;

  // —— 本站点真实使用的端点（来自上一轮取证）——
  await get('公告 kcggListXs', API.noticesBySize, { wlkcid, size: 5 });
  await get('文件 kjxxbByWlkcidAndSizeForStudent', API.filesBySize, { wlkcid, size: 5 });
  await get('文件分类 wlkc_flb/pageList', API.fileCategories, { wlkcid });
  await get('作业 zyListWj(未交)', API.homeworkNotSubmitted, { wlkcid, size: size });
  await get('作业 zyListYjwg(已交未改)', API.homeworkSubmitted, { wlkcid, size: 5 });
  await get('作业 zyListYpg(已批改)', API.homeworkGraded, { wlkcid, size: 5 });

  // 分类下的文件（响应是二维数组，位置化字段表就靠它校准）
  const cats = out.find((r) => r.label.includes('文件分类'));
  if (cats && cats.responseSnippet) {
    try {
      const json = JSON.parse(cats.responseSnippet);
      const rows = json && json.object && json.object.rows ? json.object.rows : [];
      for (const cat of rows.slice(0, 3)) {
        if (cat && cat.kjflid) await get(`分类文件 ${cat.bt || cat.kjflid}`, API.filesInCategory(wlkcid, cat.kjflid));
      }
    } catch { /* 分类响应不是预期形状就跳过 */ }
  }

  return out;
}

/**
 * 跑一次全面取证。
 * @param {{courseIndex?:number, maxPages?:number}} opts
 */
export async function runForensics({ courseIndex = 0, maxPages = 6 } = {}) {
  const started = Date.now();
  const report = {
    generatedAt: new Date().toISOString(),
    extension: chrome.runtime.getManifest().version,
    userAgent: navigator.userAgent,
    note: '全面取证：接口候选 + 站点自己的请求/响应 + 页面结构骨架 + 精简 HTML',
    session: null,
    csrf: null,
    settings: null,
    learnedTemplates: {},
    courses: [],
    pages: [],
    endpointProbes: [],
    cacheStats: null,
    logs: [],
    durationMs: 0,
  };

  // 1) 环境
  try { report.session = await checkSession(); } catch (err) { report.session = { error: err.message }; }
  const csrf = cachedToken() || (await resolveCsrf().catch(() => ''));
  report.csrf = { present: !!csrf, source: tokenSource() || '' };
  try { report.settings = await getSettings(); } catch { /* ignore */ }
  try { report.learnedTemplates = (await chrome.storage.local.get('learnedTemplates')).learnedTemplates || {}; } catch { /* ignore */ }
  try { report.cacheStats = (await getCache()).stats || null; } catch { /* ignore */ }
  try { report.diagnostics = await getDiagnostics(); } catch { /* ignore */ }

  // 2) 课程清单（接口原始响应一起带上）
  try {
    const listJson = await apiJson(API.coursesBySemester('2026-2027-1'), { csrf });
    report.courseApi = {
      url: API.coursesBySemester('2026-2027-1'),
      ok: listJson.ok,
      reason: listJson.reason || '',
      raw: JSON.stringify(listJson.json || null).slice(0, RESPONSE_LIMIT),
    };
  } catch (err) {
    report.courseApi = { error: err.message };
  }
  try {
    const cache = await getCache();
    report.courses = (cache.courses || []).map((c) => ({ id: c.id, name: c.name, url: c.url, teacher: c.teacher }));
  } catch { /* ignore */ }

  let course = (report.courses || [])[courseIndex] || null;
  // 尽量挑一门**有内容**的课去取证 —— 对着一门空课取证，拿回来的全是空数组，
  // 等于白跑一趟（上一轮就吃了这个亏：抽到的那门课没有作业）。
  try {
    const cache = await getCache();
    const ranked = (cache.courses || [])
      .map((c) => ({
        c,
        score: (c.pendingCount || 0) * 10 + (c.files || []).length * 3 + (c.announcements || []).length,
      }))
      .sort((a, b) => b.score - a.score);
    if (ranked.length && ranked[0].score > 0) {
      course = ranked[0].c;
      report.probedCourseReason = `按内容多少自动挑选：待交作业 ${course.pendingCount || 0}、文件 ${(course.files || []).length}、公告 ${(course.announcements || []).length}`;
    }
  } catch { /* 没有缓存就用第一门课 */ }
  report.probedCourse = course ? { id: course.id, name: course.name, url: course.url, reason: report.probedCourseReason || '默认取第一门课' } : null;

  // 3) 逐页取证
  const targets = [];
  if (course) {
    // 课程主页是聚合页：一次能触发公告/文件/作业三套请求，价值最高
    targets.push({ label: '课程主页', url: ORIGIN + PAGE.courseHome(course.id), tabs: ['', '文件', '作业'] });
    targets.push({ label: '公告列表页', url: ORIGIN + PAGE.noticeList(course.id), tabs: [''] });
    targets.push({ label: '文件列表页', url: ORIGIN + PAGE.fileList(course.id), tabs: ['', '文件'] });
    targets.push({ label: '作业列表页', url: ORIGIN + PAGE.homeworkList(course.id), tabs: ['', '作业'] });
  } else {
    targets.push({ label: '课程列表页', url: ORIGIN + PAGE.courseList, tabs: [''] });
  }

  // 作业详情页：作业说明与附件只存在于这里，必须取一份真实样本
  try {
    const cache = await getCache();
    for (const c of cache.courses || []) {
      const hw = (c.homework || []).find((h) => !h.completed && h.url);
      if (hw) {
        targets.push({ label: '作业详情页', url: hw.url, tabs: [''] });
        report.probedHomework = { course: c.name, title: hw.title, url: hw.url };
        break;
      }
    }
  } catch { /* 没有缓存就跳过 */ }

  for (const t of targets.slice(0, maxPages)) {
    for (const tabLabel of t.tabs) {
      try {
        const shot = await snapshotViaTab(t.url, { settleMs: 4000, kind: 'auto', tabLabel });
        report.pages.push({
          label: tabLabel ? `${t.label}（点开「${tabLabel}」后）` : t.label,
          url: shot.url,
          requestedUrl: t.url,
          tabLabel,
          activated: shot.activated || null,
          renderedRows: shot.rows,
          sniffed: summarizeRequests(shot.sniffed),
          outline: outline(shot.html),
          html: slimHtml(shot.html),
        });
      } catch (err) {
        report.pages.push({ label: t.label, url: t.url, error: err.message });
      }
    }
  }

  await closeHelperTab();

  // 4) 直接调候选接口
  try {
    report.endpointProbes = await probeEndpoints(csrf, course ? course.id : '');
  } catch (err) {
    report.endpointProbes = [{ error: err.message }];
  }

  report.durationMs = Date.now() - started;
  log.info(`全面取证完成，用时 ${(report.durationMs / 1000).toFixed(1)}s，${report.pages.length} 个页面快照`);
  return report;
}
