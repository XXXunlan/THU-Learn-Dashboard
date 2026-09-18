/**
 * 作业详情补全。
 *
 * 为什么需要单独一步：作业列表接口返回的是表格行，按站点自己的列定义，
 * 里面只有标题/状态/截止时间/成绩这些字段 —— **没有作业说明，也没有附件清单**。
 * 那两样在详情页（viewZy / viewTj / viewCj）上。
 *
 * 三个设计取舍：
 *  1) **不放进主抓取流程**：主流程要保持"一秒刷新"。补全放在主流程之后单独跑，
 *     失败也不影响已经拿到的数据。
 *  2) **限量 + 并发**：默认最多补全 20 条待交作业，并发 4。详情页是服务端渲染的
 *     HTML，直接 fetch 即可，不用开标签页。
 *  3) **只在有需要时抓**：列表行里已经有说明/附件的就不再抓（有些接口版本会带）。
 */

import { createLogger } from '../common/logger.js';
import { mapLimit } from '../common/utils.js';
import { fetchText } from './http-lite.js';
import { parseHomeworkDetail } from './offscreen-client.js';
import { snapshotViaTab } from './tab-scraper.js';
import { memory } from './store.js';

const log = createLogger('enrich');

const MAX_ITEMS = 20;
const CONCURRENCY = 4;
const MAX_HTML = 600000;
/** 补全结果缓存多久（小时）。作业说明很少变，没必要每次刷新都重新渲染一遍 */
const CACHE_HOURS = 12;
const CACHE_MAX_ENTRIES = 300;
const CACHE_KEY = 'homeworkDetails';

/** 读上次的补全结果。作业说明不会天天变，命中就直接用，省掉一次页面渲染。 */
async function loadDetailCache() {
  try {
    const { [CACHE_KEY]: cache = {} } = await chrome.storage.local.get(CACHE_KEY);
    return cache && typeof cache === 'object' ? cache : {};
  } catch {
    return {};
  }
}

async function saveDetailCache(cache) {
  try {
    const entries = Object.entries(cache).sort((a, b) => (b[1].at || 0) - (a[1].at || 0)).slice(0, CACHE_MAX_ENTRIES);
    await chrome.storage.local.set({ [CACHE_KEY]: Object.fromEntries(entries) });
  } catch { /* 存不下就算了，不影响主流程 */ }
}

export function freshEntry(entry) {
  return !!(entry && entry.at && Date.now() - entry.at < CACHE_HOURS * 3600 * 1000);
}

/**
 * 这次解析结果是不是「说明没拿到」，值得改用渲染后的页面再试一次？
 *
 * 为什么需要这一步：作业详情页的「作业说明」是**页面 JS 填进去的**，
 * 服务端返回的原始 HTML 里那个容器是空的（实测 htmlLength≈59KB，说明长度 0）。
 *
 * ⚠️ 判据只能是**说明本身**，不能把「附件有没有拿到」也算进来 ——
 * 附件链接是服务端渲染的，原始 HTML 里就有；于是「说明空 + 附件有」
 * 这个最常见的组合会被误判成“成功”，重试永远不触发（实测 renderedRetry=0，
 * 说明一条都没出来）。这是我踩过的坑，测试里专门钉住了。
 */
export function needsRenderedRetry(detail) {
  if (!detail) return true;
  return !(detail.description && detail.description.trim());
}

/** 直接抓原始 HTML 解析（快，不用开页面） */
async function parseRaw(url) {
  const res = await fetchText(url, { timeoutMs: 15000, retries: 0 });
  if (!res.ok && res.status >= 400) throw new Error(`HTTP ${res.status}`);
  const html = res.html.slice(0, MAX_HTML);
  const detail = await parseHomeworkDetail(html, res.url);
  return { detail, html, htmlLength: html.length, via: 'raw' };
}

/** 让浏览器把页面渲染出来再解析（慢，但 JS 填的内容才拿得到） */
async function parseRendered(url, settleMs) {
  // waitFor:'settle' —— 详情页没有列表表格，等正文稳定即可（否则会白等满超时）
  const shot = await snapshotViaTab(url, { settleMs, kind: 'homework', waitFor: 'settle' });
  const detail = await parseHomeworkDetail(shot.html, shot.url);
  return { detail, htmlLength: shot.html.length, via: 'rendered', waitedMs: shot.waitedMs };
}

/**
 * 给一批课程里的作业补上「作业说明」与「作业附件」。
 * 就地修改传入的 homework 数组元素，返回统计信息。
 *
 * @param {Array} courses 抓取结果里的课程数组
 * @param {{maxItems?:number, concurrency?:number, onProgress?:Function, settleMs?:number}} opts
 */
export async function enrichHomework(courses, {
  maxItems = MAX_ITEMS, concurrency = CONCURRENCY, onProgress, settleMs = 3000,
} = {}) {
  const targets = [];
  const cache = await loadDetailCache();
  let cacheHits = 0;
  for (const course of courses || []) {
    for (const hw of course.homework || []) {
      if (hw.completed) continue;                 // 已完成的作业默认不展示，不必花流量
      // 雨课堂的作业**没有「作业说明」这种字段**（已确认），而且它的详情页是另一个
      // 平台的 SPA，网络学堂那套解析器在那里只会得到垃圾 —— 所以直接跳过，别浪费流量。
      if (hw.platform === 'yuketang' || hw.source === 'yuketang') continue;
      if (hw.description || (hw.attachments && hw.attachments.length)) continue;  // 列表里已经有了

      // 上次补全过而且还没过期 —— 直接用，不必再开页面渲染
      const hit = cache[hw.id];
      if (freshEntry(hit)) {
        hw.description = hit.description || '';
        hw.descriptionSource = hit.descriptionSource || '';
        hw.attachments = Array.isArray(hit.attachments) ? hit.attachments : [];
        hw.detailEnriched = true;
        hw.detailFromCache = true;
        cacheHits++;
        continue;
      }

      if (!hw.url) continue;
      targets.push({ course, hw });
      if (targets.length >= maxItems) break;
    }
    if (targets.length >= maxItems) break;
  }

  if (!targets.length) {
    return {
      attempted: 0, enriched: 0, withAttachments: 0, failed: 0, renderedRetry: 0, cacheHits,
      samples: [], hasEvidence: false,
    };
  }
  log.info(`开始补全 ${targets.length} 条作业的说明与附件（另有 ${cacheHits} 条命中缓存）`);
  onProgress && onProgress({ message: `补全作业说明与附件（${targets.length} 条）…` });

  let enriched = 0;
  let withAttachments = 0;
  let failed = 0;
  let renderedRetry = 0;
  let processed = 0;
  const samples = [];
  let evidence = null;

  await mapLimit(targets, concurrency, async ({ hw }) => {
    if (memory.abort) return null;
    const trace = { title: hw.title };
    try {
      let attempt;
      try {
        attempt = await parseRaw(hw.url);
        trace.raw = { source: attempt.detail.descriptionSource, len: attempt.detail.description.length, htmlLength: attempt.htmlLength };
      } catch (err) {
        trace.rawError = err.message;
        attempt = null;
      }

      // 原始 HTML 里没有说明（是 JS 填的）→ 换成渲染后的页面
      if (!attempt || needsRenderedRetry(attempt.detail)) {
        renderedRetry++;
        const rendered = await parseRendered(hw.url, settleMs);
        trace.rendered = { source: rendered.detail.descriptionSource, len: rendered.detail.description.length, htmlLength: rendered.htmlLength };
        // 渲染页主要补「说明」；附件两边都可能有，取并集，别把原始 HTML 里的丢掉
        if (attempt) {
          const merged = new Set((attempt.detail.attachments || []).map((a) => a.url || a.name));
          const extra = (rendered.detail.attachments || []).filter((a) => !merged.has(a.url || a.name));
          rendered.detail.attachments = [...(attempt.detail.attachments || []), ...extra];
          if (!rendered.detail.description && attempt.detail.description) {
            rendered.detail.description = attempt.detail.description;
          }
        }
        attempt = rendered;
      }

      const detail = attempt.detail;
      trace.used = attempt.via;
      // ⚠️ 这里**不能**用 squash：它会把说明里的换行压掉，
      // 而面板正是靠换行才把那两行截断显示得可读的。
      hw.description = String(detail.description || '')
        .replace(/[\u00a0\u2000-\u200b\u3000]/g, ' ')
        .replace(/[ \t]+/g, ' ')
        .replace(/ *\n */g, '\n')
        .replace(/\n+/g, '\n')
        .trim();
      hw.descriptionSource = detail.descriptionSource || '';
      hw.attachments = Array.isArray(detail.attachments) ? detail.attachments : [];
      hw.detailEnriched = true;
      if (hw.attachments.length) withAttachments++;
      if (hw.description || hw.attachments.length) enriched++;
      // 记进缓存，下次刷新就不必再渲染这一页
      cache[hw.id] = {
        description: hw.description, descriptionSource: hw.descriptionSource,
        attachments: hw.attachments, at: Date.now(),
      };
      // 万一连渲染都拿不到说明，把这条作业的**原始 HTML** 留下来当证据 ——
      // 下次诊断包里就能直接看到那一页长什么样，不用再单独跑一次取证。
      if (!hw.description && !evidence && attempt.html) {
        evidence = { url: hw.url, title: hw.title, html: String(attempt.html).slice(0, 300000) };
      }
      if (samples.length < 6) samples.push(trace);
      return true;
    } catch (err) {
      failed++;
      hw.detailEnriched = false;
      hw.detailError = err.message;
      trace.error = err.message;
      if (samples.length < 6) samples.push(trace);
      log.debug(`作业详情补全失败：${hw.title}（${err.message}）`);
      return null;
    } finally {
      // 把进度报出来，别让面板在收尾阶段显示成“卡住”
      processed++;
      onProgress && onProgress({ message: `补全作业说明与附件 ${processed}/${targets.length}…` });
    }
  });

  log.info(`作业补全完成：成功 ${enriched} 条（其中 ${withAttachments} 条有附件），失败 ${failed} 条，改用渲染页 ${renderedRetry} 次，命中缓存 ${cacheHits} 条`);
  await saveDetailCache(cache);

  // 把失败现场存进快照，供诊断包导出
  if (evidence) {
    try {
      const { snapshots = [] } = await chrome.storage.local.get('snapshots');
      await chrome.storage.local.set({
        snapshots: [{ ...evidence, kind: 'homework-raw', method: 'raw-html', at: Date.now(), failed: true, reason: '说明仍然为空，留下原始 HTML 供排查' }, ...snapshots].slice(0, 6),
      });
      log.warn(`有作业的说明仍为空，已保存其原始 HTML（${evidence.title}）`);
    } catch { /* 存不下就算了 */ }
  }

  return { attempted: targets.length, enriched, withAttachments, failed, renderedRetry, cacheHits, samples, hasEvidence: !!evidence };
}
