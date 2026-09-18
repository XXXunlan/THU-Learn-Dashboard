/**
 * 雨课堂（yuketang.cn）接入所需的「记录并取证」流程。
 *
 * 背景：雨课堂是独立的账号体系 + 纯前端 SPA。我没法登录、也没法靠猜接口
 * （这一点这个项目已经吃过太多次亏了）。所以这里做的是**持续嗅探**：
 *
 *   1) 申请 yuketang.cn 的可选权限，动态注册两个内容脚本
 *      （sniffer 在页面环境里捕获请求，collector 把记录回传后台）；
 *   2) 打开雨课堂，让你自己点几下（进课程 → 打开作业列表 → 打开一份作业）；
 *   3) 期间站点自己发的所有 API 请求 —— **URL + 方法 + 请求体 + 响应体** ——
 *      都会实时汇总到后台，跨页面导航也不会丢；
 *   4) 结束时把汇总结果导出成一个 JSON。
 *
 * 有了这份 JSON，接口路径、参数、响应字段就全是站点自己的原话，
 * 不需要任何猜测。这和网络学堂那条路径用的是同一套思路。
 */

import { createLogger } from '../common/logger.js';
import { SITE_YUKETANG } from '../common/constants.js';
import { slimHtml } from './probe.js';
import { inHelperTab } from './tab-scraper.js';
import {
  YKT_INDEX_URL,
  YKT_ORIGIN,
  YKT_COURSES_LIST_URL,
  yktUrl,
  pickClassroomList,
  classroomListCandidates,
  normalizeYktClassroom,
  classroomIdsFromRecords,
  classroomIdsFromHtml,
  homeworkFromChapter,
  leafTypeHistogram,
  harvestedCourseData,
  completionFromSchedule,
  matchLearnCourse,
  mergeYuketang,
  apiError,
} from '../parsers/yuketang.js';

const log = createLogger('yuketang');

const SNIFFER_ID = 'thul-sniffer-ykt';
const COLLECTOR_ID = 'thul-collector-ykt';
const SNIFF_KEY = 'yuketangSniff';

/** 累积的嗅探记录（后台内存 + storage.session，SW 重启也不丢） */
export async function loadRecords() {
  try {
    const { [SNIFF_KEY]: data } = await chrome.storage.session.get(SNIFF_KEY);
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

export async function appendRecord(record) {
  if (!record || !record.url) return;
  const list = await loadRecords();
  // 同一请求重复出现（轮询、重试）时只留最新的一条，避免把噪声灌满
  const key = `${record.method || 'GET'} ${record.url}`;
  const idx = list.findIndex((r) => `${r.method || 'GET'} ${r.url}` === key);
  if (idx >= 0) list[idx] = record; else list.push(record);
  const trimmed = list.slice(-200);
  try {
    await chrome.storage.session.set({ [SNIFF_KEY]: trimmed });
  } catch { /* ignore */ }
}

export async function clearRecords() {
  try { await chrome.storage.session.remove(SNIFF_KEY); } catch { /* ignore */ }
}

/** 动态注册采集用的内容脚本（需要已获得 yuketang.cn 的权限） */
async function registerCollectors() {
  const ids = [SNIFFER_ID, COLLECTOR_ID];
  try { await chrome.scripting.unregisterContentScripts({ ids }); } catch { /* 没注册过 */ }
  await chrome.scripting.registerContentScripts([
    {
      id: SNIFFER_ID,
      matches: SITE_YUKETANG.matches,
      js: ['src/content/sniffer.js'],
      runAt: 'document_start',
      world: 'MAIN',
      allFrames: false,
      persistAcrossSessions: false,
    },
    {
      id: COLLECTOR_ID,
      matches: SITE_YUKETANG.matches,
      js: ['src/content/collector.js'],
      // 必须是 document_start：首页那次「课程列表」请求可能在 document_idle 之前
      // 就已经发完了，晚一步注入就永远听不到它（上一轮取证正是这样漏掉列表接口的）。
      runAt: 'document_start',
      allFrames: false,
      persistAcrossSessions: false,
    },
  ]);
  log.info('已注册雨课堂采集脚本');
}

export async function unregisterCollectors() {
  try { await chrome.scripting.unregisterContentScripts({ ids: [SNIFFER_ID, COLLECTOR_ID] }); } catch { /* ignore */ }
}

/** 是否已获得 yuketang.cn 的权限 */
export async function hasPermission() {
  try {
    return await chrome.permissions.contains(SITE_YUKETANG.permission);
  } catch {
    return false;
  }
}

/**
 * 开始记录：注册脚本 → 打开雨课堂。
 * 权限没给时**不自己申请**（必须由用户在点击手势里发起），而是如实返回让界面去申请。
 */
export async function startSniff({ url = SITE_YUKETANG.indexUrl } = {}) {
  if (!(await hasPermission())) {
    return { ok: false, needPermission: true, origins: SITE_YUKETANG.permission.origins, message: `需要先授予 ${SITE_YUKETANG.domain} 的访问权限` };
  }
  await registerCollectors();
  await clearRecords();

  // 已经开着的雨课堂标签页就复用，省得开一堆
  let tabId = null;
  try {
    const tabs = await chrome.tabs.query({ url: SITE_YUKETANG.matches });
    if (tabs.length) {
      tabId = tabs[0].id;
      await chrome.tabs.update(tabId, { active: true, url });
    }
  } catch { /* 查询失败就新建 */ }
  if (tabId === null) {
    const tab = await chrome.tabs.create({ url, active: true });
    tabId = tab.id;
  }
  log.info(`开始记录雨课堂（tab ${tabId}）`);
  return {
    ok: true,
    tabId,
    message: '已开始记录。请按顺序走一遍：① 在首页（课程列表）等它加载完 → ② 点进一门课 → '
      + '③ 打开作业列表 → ④ 打开一份**界面上能看到作业说明文字**的作业。'
      + '然后再回来点「结束记录并导出」。',
  };
}

/** 从标签页收集页面结构（正文、列表容器、存储键名等） */
async function collectPageSnapshots() {
  let tabs = [];
  try { tabs = await chrome.tabs.query({ url: SITE_YUKETANG.matches }); } catch { /* ignore */ }
  const pages = [];
  for (const tab of tabs.slice(0, 5)) {
    try {
      const res = await chrome.tabs.sendMessage(tab.id, { target: 'content', type: 'snapshot' });
      if (res && res.ok) {
        pages.push({
          url: res.url || tab.url,
          title: (res.outline && res.outline.title) || tab.title || '',
          outline: res.outline || null,
          // 渲染后的正文放最前面：判断「作业说明到底显示在哪里」靠的就是它
          text: String(res.text || '').slice(0, 40000),
          // 原始 HTML 对 SPA 几乎没有信息量（前 20 万字符全是脚本），去掉脚本再看结构
          html: slimHtml(res.html, 150000),
        });
      }
    } catch { /* 该标签页没有采集脚本（还没重新加载），跳过 */ }
  }
  return pages;
}

/**
 * 把原始记录按「方法 + 路径」归类，并带上响应体。
 *
 * 为什么要归类：一个 SPA 页面上同一个接口会被调用很多次（轮询、翻页），
 * 平铺在一起根本看不出有哪些接口；归类后每个接口只留几份样本，
 * **响应体才是判断字段的关键**（纯函数，可单测）。
 */
export function groupEndpoints(records, { maxSamples = 3, responseLimit = 20000 } = {}) {
  const byPath = new Map();
  for (const r of records || []) {
    if (!r || !r.url) continue;
    let path = r.url;
    try { path = new URL(r.url).pathname; } catch { /* 相对地址就保留原值 */ }
    const key = `${r.method || 'GET'} ${path}`;
    if (!byPath.has(key)) byPath.set(key, { method: r.method || 'GET', path, count: 0, samples: [] });
    const entry = byPath.get(key);
    entry.count++;
    if (entry.samples.length < maxSamples) {
      entry.samples.push({
        url: r.url,
        body: String(r.body || '').slice(0, 2000),
        status: r.status,
        headerNames: Array.isArray(r.headerNames) ? r.headerNames : [],
        // 只记白名单里的「客户端标识头」的值（XTBZ 这类必须带的自定义头），
        // 其余一律只留名字 —— 诊断包是要贴出来的，别把令牌带出去。
        safeHeaders: (r.safeHeaders && typeof r.safeHeaders === 'object') ? r.safeHeaders : {},
        responseSnippet: String(r.responseSnippet || '').slice(0, responseLimit),
      });
    }
  }
  return Array.from(byPath.values()).sort((a, b) => b.count - a.count);
}

/** 结束记录并汇总成一份可导出的报告 */
export async function stopSniff() {
  const records = await loadRecords();
  const pages = await collectPageSnapshots();
  const endpoints = groupEndpoints(records);

  const report = {
    generatedAt: new Date().toISOString(),
    extension: chrome.runtime.getManifest().version,
    site: SITE_YUKETANG.label,
    note: '雨课堂接口取证：站点自己发出的请求（URL + 方法 + 请求体 + 响应体）+ 页面结构',
    domain: SITE_YUKETANG.domain,
    recordCount: records.length,
    endpoints,
    pages,
  };
  log.info(`雨课堂记录结束：${records.length} 条请求、${endpoints.length} 个不同接口、${pages.length} 个页面快照`);
  return report;
}

/* ======================= 正式抓取：雨课堂作业 ======================= */

/**
 * 把雨课堂的作业抓下来，并**并进网络学堂的同名课程**。
 *
 * 整体思路（和网络学堂那条路径一样：先学、再重放，绝不猜接口）：
 *
 *   1) 在不可见的辅助标签页里打开雨课堂首页。首页自己一定会去取课程列表，
 *      我们不去猜那个接口叫什么，而是**把它发的请求读下来**，再从响应形状里
 *      认出哪一个是课程列表（pickClassroomList）。
 *   2) 万一认不出来，退一步从「请求过的 URL」和页面 HTML 里抠教室 id，
 *      再逐个用**已确证的** /v2/api/web/classrooms/{id} 回填权威名称 ——
 *      也就是说抠错了也不会污染数据，最多白跑几次。
 *   3) 每门课：章节树里 leaf_type === 6 的叶子就是作业；完成度取自 leaf_schedules。
 *   4) 按课程名并进网络学堂对应课程。
 *
 * 另外两个刻意的选择：
 *   · 所有接口请求都由**页面自身的源**发出（inHelperTab 的 fetchJson），
 *     而不是由 Service Worker 发 —— 雨课堂的会话 cookie 若是 SameSite=Lax，
 *     后台发出的请求会被当成跨站，cookie 根本带不上。
 *   · 任何一步失败都**如实记进 errors / notes**，绝不假装成功。
 */
export async function crawlYuketang({ learnCourses = [], onProgress = () => {}, settleMs = 4500, maxClassrooms = 40 } = {}) {
  const report = (message) => { try { onProgress({ phase: 'yuketang', message }); } catch { /* ignore */ } };

  const out = {
    ok: false,
    needPermission: false,
    classrooms: [],
    perClassroom: [],
    matched: [],
    unmatched: [],
    added: 0,
    homeworkCount: 0,
    listVia: '',
    listPath: '',
    errors: [],
    notes: [],
  };

  if (!(await hasPermission())) {
    out.needPermission = true;
    out.notes.push('还没有 yuketang.cn 的访问权限，本次跳过雨课堂（可在面板里点「授权雨课堂」）');
    return out;
  }

  try {
    await registerCollectors();
    await clearRecords();
  } catch (err) {
    out.errors.push({ scope: 'yuketang', message: `注入雨课堂采集脚本失败：${(err && err.message) || String(err)}` });
    return out;
  }

  // 后台如果能自己带 cookie，就完全不必依赖那个最小化的辅助窗口 —— 少一层会出问题的地方。
  const swDirect = await swCanReachYuketang();
  out.directFetch = swDirect;
  if (swDirect) out.notes.push('雨课堂接口由扩展后台直接请求（cookie 能带上），未使用渲染兜底');
  else out.notes.push('雨课堂的 cookie 没能在后台请求里带上，改用「页面自己发请求」的方式（SameSite 所致）');

  // 站点要求的那几个自定义头（XTBZ 之类）。学过一次就存下来，之后直接用。
  let apiHeaders = await loadLearnedHeaders();
  let classrooms = [];
  /** 站点自己取回来过的章节树/完成度（按教室 id），优先于我们自己去请求 */
  const harvested = {};

  /* ---- 阶段 A：打开首页，拿到课程列表，并顺手学一次请求头 ---- */
  try {
    await inHelperTab(YKT_INDEX_URL, async ({ snapshot, fetchJson: pageFetch }) => {
      /** 统一取数入口：优先后台直连，不行就走页面自己的源；两者都带上学到的头 */
      const fetchJson = swDirect
        ? (url) => swFetchText(url, apiHeaders)
        : (url) => pageFetch(url, apiHeaders);

      // 顺手从首页自己的请求里学一遍（很多站点是全局拦截器加的，首页的请求上就有）
      const idxRecords = mergeSniffed(await loadRecords(), (snapshot && snapshot.sniffed) || []);
      const fromIndex = learnedHeaders(idxRecords);
      if (Object.keys(fromIndex).length) {
        apiHeaders = { ...fromIndex, ...apiHeaders };
        out.learnedHeaders = Object.keys(apiHeaders);
      }
      /* ---- 1. 学课程列表 ---- */
      report('打开雨课堂首页，读它自己的课程列表请求…');
      const pageRecords = (snapshot && Array.isArray(snapshot.sniffed)) ? snapshot.sniffed : [];
      const records = mergeSniffed(await loadRecords(), pageRecords);

      const picked = pickClassroomList(records);
      classrooms = (picked.rows || []).map(normalizeYktClassroom).filter(Boolean);
      out.listPath = picked.path || '';
      if (classrooms.length) {
        out.listVia = `接口响应（${picked.path}）`;
        out.notes.push(`雨课堂课程列表取自 ${picked.path} —— ${picked.reason}，共 ${classrooms.length} 门`);
      }

      /* ---- 2. 兜底：先试学到的列表接口，再退到抠 id ---- */
      if (!classrooms.length && swDirect) {
        report('首页没认到列表接口，直接请求已学到的课程列表接口…');
        const r = await getJson(fetchJson, YKT_COURSES_LIST_URL);
        if (r.ok) {
          const c2 = pickClassroomList([{ url: YKT_COURSES_LIST_URL, responseSnippet: JSON.stringify(r.json) }]);
          const rows = (c2.rows || []).map(normalizeYktClassroom).filter(Boolean);
          if (rows.length) {
            classrooms = rows;
            out.listVia = '已学到的 /v2/api/web/courses/list（实机抓包得到）';
            out.notes.push(`首页没能认出课程列表接口，改用已学到的 ${YKT_COURSES_LIST_URL}，拿到 ${rows.length} 门`);
          }
        } else {
          out.notes.push(`已学到的课程列表接口也没成功：${r.reason}`);
        }
      }

      if (!classrooms.length) {
        const ids = [];
        for (const id of classroomIdsFromRecords(records)) if (!ids.includes(id)) ids.push(id);
        for (const id of classroomIdsFromHtml(snapshot && snapshot.html)) if (!ids.includes(id)) ids.push(id);
        const limited = ids.slice(0, maxClassrooms);

        if (!limited.length) {
          out.errors.push({
            scope: 'yuketang',
            message: '找不到雨课堂的课程列表：既没从首页的请求里认出列表接口，也没在请求 URL / 页面里找到课程 id。'
              + '（如果雨课堂那边没登录，也会是这个结果。）',
          });
          return;
        }

        report(`首页的列表接口没认出来，改用兜底：逐个核实 ${limited.length} 个课程 id…`);
        const resolved = [];
        for (const id of limited) {
          const r = await getJson(fetchJson, yktUrl.classroom(id));
          if (!r.ok) continue;
          const c = normalizeYktClassroom(r.json && r.json.data);
          if (c) resolved.push(c);
        }
        classrooms = resolved;
        if (resolved.length) {
          out.listVia = '页面 / 请求 URL 兜底 + 逐课核实';
          out.notes.push(`雨课堂首页的课程列表接口没能直接认出来，改从页面与请求 URL 里提取到 ${limited.length} 个课程 id，`
            + `经 /v2/api/web/classrooms 逐个核实后确认 ${resolved.length} 门`);
        }
      }
    }, { settleMs });
  } catch (err) {
    out.errors.push({ scope: 'yuketang', message: `雨课堂抓取中断（阶段A 打开首页）：${(err && err.message) || String(err)}` });
    return out;
  }

  out.classrooms = classrooms;
  if (!classrooms.length) {
    out.errors.push({ scope: 'yuketang', message: '雨课堂一门课都没拿到 —— 大概率是雨课堂那边未登录，或首页结构变了' });
    return out;
  }

  /* ---- 阶段 B：还没学到自定义头的话，进一门课去学 ----
     为什么单独一趟：章节树会返回 `{"msg":"XTBZ IS REQUIRED","error_code":40000}`，
     也就是**必须带某个自定义头**，而它的值只存在于站点自己的请求里。
     首页的请求上通常就有（多数站点是全局拦截器加的）；万一没有，进一门课基本就一定有。
     ⚠️ 这一趟必须放在阶段 A 的 inHelperTab **之外** —— 辅助标签页是互斥队列，
        在它自己的任务里再调一次会永远等自己。 */
  if (!apiHeaders.xtbz) {
    report('进一门课，学习站点要求的自定义请求头…');
    try {
      await clearRecords();
      await inHelperTab(yktUrl.courseHome(classrooms[0].id), async ({ snapshot }) => {
        const recs = mergeSniffed(await loadRecords(), (snapshot && snapshot.sniffed) || []);
        apiHeaders = { ...learnedHeaders(recs), ...apiHeaders };
        // 顺手把站点**自己已经取到**的章节树/完成度捡走（见 harvestedCourseData 的说明）。
        // XTBZ 也许只由 mooc-api 那个客户端模块加，首页不一定是它的宿主，
        // 所以这一趟是在"可能没有收获"和"直接拿到权威数据"之间做的对冲。
        Object.assign(harvested, harvestedCourseData(recs));
      }, { settleMs: 3500 });
    } catch (err) {
      out.notes.push(`进课程页学请求头失败：${(err && err.message) || err}`);
    }
    if (Object.keys(harvested).length) {
      out.notes.push(`在课程页顺手捡到站点自己取回的章节数据：${Object.keys(harvested).join('、')}`);
    }
  }
  out.learnedHeaders = Object.keys(apiHeaders);
  if (Object.keys(apiHeaders).length) {
    await saveLearnedHeaders(apiHeaders);
    out.notes.push(`已学到站点要求的自定义请求头：${Object.keys(apiHeaders).join(', ')}`);
  } else {
    out.notes.push('没能从站点自己的请求里学到任何自定义请求头；'
      + '若章节树返回「XXX IS REQUIRED」，缺的就是那个头（报错信息里会写出名字）');
  }

  /* ---- 阶段 C：逐门课取作业 ---- */
  const loop = async (fetchJson) => {
    let i = 0;
    for (const room of classrooms) {
      i++;
      report(`雨课堂 ${i}/${classrooms.length}：${room.name}`);
      const entry = { id: room.id, name: room.name, sign: room.sign || '', homework: [], completion: null, error: '' };
      try {
        if (!entry.sign) {
          const detail = {};
          entry.sign = await resolveSign(fetchJson, room, detail);
          // resolveSign 可能把 id 校正成权威的「教室 id」，这里必须跟着更新，
          // 否则后面按 id 归并时会和 out.classrooms 上的 id 对不上。
          entry.id = room.id;
          entry.name = room.name;
          if (detail.signError) entry.signError = detail.signError;
        }
        if (!entry.sign) {
          entry.error = `拿不到 course_sign，无法请求章节树${entry.signError ? `（试过 ${entry.signError}）` : ''}`;
          out.perClassroom.push(entry);
          continue;
        }

        const pre = harvested[room.id] || {};
        if (pre.chapter) {
          // 站点自己带着正确的头取回来的 —— 比我们复现请求更可靠，直接用
          entry.homework = homeworkFromChapter(pre.chapter);
          entry.fromHarvest = true;
        } else {
          const chRes = await getJson(fetchJson, yktUrl.chapter(room.id, entry.sign));
          if (!chRes.ok) {
            entry.error = `章节树请求失败：${chRes.reason}`;
            out.perClassroom.push(entry);
            continue;
          }
          entry.homework = homeworkFromChapter(chRes.json);
        }

        if (pre.schedule) {
          entry.completion = completionFromSchedule(pre.schedule);
        } else {
          const scRes = await getJson(fetchJson, yktUrl.schedule(room.id, entry.sign));
          if (scRes.ok) entry.completion = completionFromSchedule(scRes.json);
          else entry.error = `完成度请求失败，作业仍会列出但状态显示为未知：${scRes.reason}`;
        }
      } catch (err) {
        entry.error = (err && err.message) || String(err);
      }
      out.perClassroom.push(entry);
    }
  };

  try {
    if (swDirect) {
      // 后台直连最省事：不需要辅助标签页停在雨课堂域上
      await loop((url) => swFetchText(url, apiHeaders));
    } else {
      // cookie 只能靠页面带 —— 再占一次辅助标签页，整段循环都在它里面跑完
      await inHelperTab(YKT_INDEX_URL, async ({ fetchJson: pageFetch }) => {
        await loop((url) => pageFetch(url, apiHeaders));
      }, { settleMs: 1500 });
    }
  } catch (err) {
    out.errors.push({ scope: 'yuketang', message: `雨课堂抓取中断（阶段C 取作业）：${(err && err.message) || String(err)}` });
    return out;
  }

  /* ---- 4. 并进网络学堂的对应课程 ---- */
  const byClassroom = {};
  for (const e of out.perClassroom) byClassroom[e.id] = e;
  const merged = mergeYuketang(learnCourses, { classrooms: out.classrooms, byClassroom });
  out.matched = merged.matched.map((m) => ({
    classroom: m.classroom.name, course: m.course, courseId: m.courseId, count: m.count,
  }));
  out.unmatched = merged.unmatched.map((u) => ({ classroom: u.classroom.name, reason: u.reason, count: (byClassroom[u.classroom.id] || {}).homework?.length || 0 }));
  out.added = merged.added;

  out.homeworkCount = out.perClassroom.reduce((s, e) => s + (e.homework ? e.homework.length : 0), 0);
  out.ok = true;

  for (const e of out.perClassroom) {
    if (e.error) out.errors.push({ scope: 'yuketang', message: `雨课堂「${e.name}」：${e.error}` });
  }
  for (const u of out.unmatched) {
    const line = `雨课堂「${u.classroom}」在网络学堂的课程清单里没有同名课程，`
      + `${u.count ? `它的 ${u.count} 条作业没有并入` : '它也没有作业'}`;
    // 有作业却没地方放 → 这属于"内容可能不完整"，要报警；没作业 → 只是说明
    if (u.count) out.errors.push({ scope: 'yuketang', message: line });
    else out.notes.push(line);
  }
  if (out.ok && !out.homeworkCount) {
    out.notes.push('雨课堂这边一门课的章节树里都没有 leaf_type=6 的作业叶子');
  }

  log.info(`雨课堂抓取完成：${out.classrooms.length} 门课、${out.homeworkCount} 条作业、并入 ${out.added} 条`);
  return out;
}

/** 去重合并两批嗅探记录（同一请求以页面里那份为准） */
function mergeSniffed(a = [], b = []) {
  const map = new Map();
  for (const r of [...a, ...b]) {
    if (!r || !r.url) continue;
    map.set(`${r.method || 'GET'} ${r.url}`, r);
  }
  return Array.from(map.values());
}

/** 文本 -> JSON，并把「为什么不是 JSON」一起带回来 */
function parseJsonText(text) {
  const t = String(text || '');
  if (/^\s*</.test(t)) return { ok: false, reason: '返回的是 HTML，很可能雨课堂那边没有登录' };
  try {
    return { ok: true, json: JSON.parse(t) };
  } catch {
    return { ok: false, reason: `响应不是 JSON（前 60 字：${t.slice(0, 60)}）` };
  }
}

/** 取 JSON；解析不了就把原因带回去，而不是静默当成"没有数据" */
async function getJson(fetchJson, url) {
  const res = await fetchJson(url);
  if (!res || !res.ok) return { ok: false, reason: (res && res.error) || '请求失败', status: 0 };
  const parsed = parseJsonText(res.text);
  if (!parsed.ok) return { ok: false, reason: parsed.reason, status: res.status };
  // 雨课堂会用 HTTP 200 + success:false 表示失败 —— 这种响应也是合法 JSON，
  // 不显式检查的话「接口报错」会被读成「这门课没有数据」。
  const err = apiError(parsed.json);
  if (err) {
    return { ok: false, reason: err, status: res.status, json: parsed.json, apiFailed: true, raw: String(res.text || '').slice(0, 300) };
  }
  return { ok: true, json: parsed.json, status: res.status };
}

/**
 * 拿到一门课的 `course_sign`。
 *
 * 为什么需要这一步：章节树和完成度接口**都必须带 sign**，而**课程列表接口并不返回它**
 * （实测 `/v2/api/web/courses/list` 的条目里没有 `course_sign`，它只出现在
 *  `/v2/api/web/classrooms/{id}?role=5` 上）。所以列表认得出来只是第一步。
 *
 * 「教室 id」和「course_id」是两个不同的编号（实测 3000001 是教室、4000001 是课程），
 * 而列表接口给的是哪一个我没法预先确定 —— 所以两个都试，
 * **以单课接口真正答出来的那个为准**（它回什么 id 就说明哪个是对的）。
 *
 * @returns {Promise<string>} sign；拿不到返回空串，原因写进 detail
 */
async function resolveSign(fetchJson, room, detail = {}) {
  if (room.sign) return room.sign;
  const tried = [];
  const cands = [...new Set([room.id, room.courseId].filter(Boolean))];
  for (const id of cands) {
    const r = await getJson(fetchJson, yktUrl.classroom(id));
    if (!r.ok) { tried.push(`${id}: ${r.reason}`); continue; }
    const c = normalizeYktClassroom(r.json && r.json.data);
    if (c && c.sign) {
      // 用权威结果覆盖：单课接口回的 id 才是「教室 id」，名称也以它为准
      if (c.id) room.id = c.id;
      if (c.name) room.name = c.name;
      if (c.courseName) room.courseName = c.courseName;
      if (c.courseId) room.courseId = c.courseId;
      detail.signFrom = id;
      return c.sign;
    }
    const keys = r.json && r.json.data ? Object.keys(r.json.data).slice(0, 12).join(',') : '(没有 data)';
    tried.push(`${id}: 响应里没有 course_sign（字段：${keys}）`);
  }
  detail.signError = tried.join('；') || '列表里没有 id 可用';
  return '';
}

/* ======================= 雨课堂自检（一次点击定位问题） ======================= */

/**
 * 由 **Service Worker 自己**发一次 GET。
 * 返回形状刻意和页面里那份 `fetchJson` **完全一致**（{ok,status,url,text}），
 * 这样取数通道可以随时在「后台直连」和「页面自己发」之间切换而不改调用方。
 */
async function swFetchText(url, headers = {}) {
  try {
    const res = await fetch(url, {
      credentials: 'include',
      redirect: 'follow',
      cache: 'no-store',
      headers: { Accept: 'application/json, text/plain, */*', ...headers },
    });
    const text = await res.text();
    return { ok: true, status: res.status, url: res.url || url, text: text.slice(0, 300000) };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
}

/**
 * 从站点自己发出的请求里，学出 `mooc-api` 需要的那几个自定义头。
 *
 * 为什么非这样不可：章节树接口会返回
 * `{"msg":"XTBZ IS REQUIRED","error_code":40000,"success":false}` ——
 * 它要求一个**自定义请求头**，而那个头的值只存在于站点自己的请求里。
 * 猜值是绝对不行的（这个项目在"猜"上吃的亏已经够多了），所以让嗅探器把它记下来。
 *
 * @returns {object} 形如 { xtbz: '...' }；没学到就是空对象
 */
export function learnedHeaders(records) {
  const out = {};
  for (const r of records || []) {
    const safe = r && r.safeHeaders;
    if (!safe || typeof safe !== 'object') continue;
    for (const [k, v] of Object.entries(safe)) {
      if (v && !out[k]) out[k] = v;
    }
  }
  return out;
}

/** 学到的请求头持久化下来 —— 和网络学堂那边的「接口模板」是同一个思路：学一次，之后直接用 */
async function loadLearnedHeaders() {
  try {
    const got = await chrome.storage.local.get('yktHeaders');
    const h = got && got.yktHeaders;
    return h && typeof h === 'object' ? h : {};
  } catch {
    return {};
  }
}

export async function saveLearnedHeaders(headers) {
  try {
    if (headers && Object.keys(headers).length) await chrome.storage.local.set({ yktHeaders: headers });
  } catch { /* 存不下就算了，下次再学一遍 */ }
}

/**
 * 后台**能不能直接**跟雨课堂说话？
 *
 * 判断依据是拿一个已知存在的接口试一次，看它有没有按登录态回答。
 * 这一步很值得做：如果后台自己就能带 cookie，那么整条抓取就**不必依赖**
 * 那个最小化的辅助窗口（少一层可能出问题的地方，也快得多）。
 * 反过来说，如果这里失败，就说明雨课堂的 cookie 确实被 SameSite 挡住了，
 * 必须走「页面自己发请求」那条路。
 */
async function swCanReachYuketang() {
  const r = await swFetchText(`${YKT_ORIGIN}/v2/api/web/userinfo`);
  if (!r.ok) return false;
  const parsed = parseJsonText(r.text);
  return !!(parsed.ok && parsed.json && Number(parsed.json.errcode) === 0);
}

/**
 * 雨课堂自检：把「为什么没抓到作业」这件事一次说清楚。
 *
 * 存在的理由：集成这一步链条长（权限 → 登录 → 首页 → 认接口 → 逐课取 → 课程名匹配），
 * 任何一环断了在界面上都只表现为"没有雨课堂作业"这一个结果。
 * 与其让你反复刷新、我反复猜，不如把每一环的实际观测值直接摆出来。
 *
 * @returns {{ok:boolean, lines:string[], summary:object}}
 */
export async function selfCheckYuketang({ learnCourses = [], settleMs = 4500 } = {}) {
  const lines = [];
  const put = (s = '') => lines.push(s);
  const summary = {};

  /* ① 权限 */
  const perm = await hasPermission();
  summary.permission = perm;
  put(`① 权限：${perm ? '已授予 *.yuketang.cn ✅' : '❌ 没有 *.yuketang.cn 的权限 —— 先点上面的「授权雨课堂」'}`);
  if (!perm) {
    put('');
    put('到此为止：没有权限，采集脚本根本注入不进去。');
    return { ok: false, lines, summary };
  }

  /* ② 登录与否：两条路各发一次请求对比 */
  put('');
  put('② 雨课堂登录状态（同一个接口，两条路各发一次）');
  const swRes = await swFetchText(`${YKT_ORIGIN}/v2/api/web/userinfo`);
  const swParsed = swRes.ok ? parseJsonText(swRes.text) : { ok: false, reason: swRes.error || '请求失败' };
  const swName = swParsed.ok && swParsed.json && swParsed.json.data && swParsed.json.data[0] ? swParsed.json.data[0].name : '';
  summary.swFetch = swRes.ok
    ? `status:${swRes.status}${swName ? ` user:${swName}` : ` ${swParsed.reason || 'no-user'}`}`
    : `error:${swRes.error}`;
  if (!swRes.ok) put(`   后台直接请求：❌ ${swRes.error}`);
  else if (swName) put(`   后台直接请求：✅ 拿到用户「${swName}」（cookie 能带上，这条路可用，抓取会优先用它）`);
  else put(`   后台直接请求：❌ status ${swRes.status} —— ${swParsed.reason || '响应里没有用户信息'}（cookie 没带上，会改用页面自己发请求）`);

  /* ③ 注册采集脚本，打开首页 */
  put('');
  put('③ 打开雨课堂首页并采集它自己发出的请求…');
  try {
    await registerCollectors();
    await clearRecords();
  } catch (err) {
    put(`   ❌ 注入采集脚本失败：${(err && err.message) || err}`);
    return { ok: false, lines, summary };
  }

  let snapshot = null;
  let pageProbe = null;
  let records = [];
  let picked = null;
  let candidates = [];
  const debug = [];
  let pageUser = '';
  let pageFetchRef = null;

  try {
    await inHelperTab(YKT_INDEX_URL, async ({ snapshot: snap, probe, fetchJson }) => {
      snapshot = snap;
      pageProbe = probe;
      pageFetchRef = fetchJson;

      if (!snap) {
        put('   ❌ 内容脚本没有回应快照请求 —— 采集脚本没有注入到这个页面');
      } else {
        put(`   页面地址：${snap.url || '(未知)'}`);
        put(`   页面标题：${(snap.outline && snap.outline.title) || '(空)'}`);
        put(`   正文长度：${(probe && probe.textLength) || 0}（等了 ${(probe && probe.waitedMs) || 0}ms）`);
        const head = String(snap.text || '').replace(/\s+/g, ' ').slice(0, 140);
        put(`   正文开头：${head || '(空 —— 页面可能没渲染出来，或被重定向到了登录页)'}`);
      }

      // 用页面自己的源再问一次登录状态（同源，cookie 一定带得上）
      const pageUserRes = await getJson(fetchJson, `${YKT_ORIGIN}/v2/api/web/userinfo`);
      pageUser = pageUserRes.ok && pageUserRes.json && pageUserRes.json.data && pageUserRes.json.data[0]
        ? pageUserRes.json.data[0].name : '';
      summary.pageFetch = pageUser ? `user:${pageUser}` : (pageUserRes.reason || `status:${pageUserRes.status}`);
      put(`   在页面里请求同一接口：${pageUser ? `✅ 拿到用户「${pageUser}」` : `❌ ${pageUserRes.reason || `status ${pageUserRes.status}`}`}`);
      if (!pageUser) {
        put('   → 雨课堂这边**没有登录**（或者该标签页被重定向到了登录页）。先在浏览器里登录雨课堂，再重跑自检。');
      }

      const pageRecords = (snap && Array.isArray(snap.sniffed)) ? snap.sniffed : [];
      records = mergeSniffed(await loadRecords(), pageRecords);
    }, { settleMs });
  } catch (err) {
    put(`   ❌ 打开首页失败：${(err && err.message) || err}`);
    return { ok: false, lines, summary };
  }

  /* ④ 采集到了什么 */
  put('');
  put(`④ 采集到的请求：${records.length} 条，涉及 ${new Set(records.map((r) => r.url)).size} 个地址`);
  summary.recordCount = records.length;
  if (records.length) {
    const paths = [...new Set(records.map((r) => { try { return new URL(r.url).pathname; } catch { return r.url; } }))];
    paths.slice(0, 25).forEach((p) => put(`   · ${p}`));
    if (paths.length > 25) put(`   …（还有 ${paths.length - 25} 个）`);
  } else {
    put('   ❌ 一条都没采到 —— 采集脚本没注入成功，或页面根本没发请求。');
  }

  /* ④.5 站点要求的自定义请求头 */
  const apiHeaders = { ...learnedHeaders(records), ...(await loadLearnedHeaders()) };
  summary.headers = Object.keys(apiHeaders);
  put('');
  put('④.5 站点自己请求里带的自定义头（章节树必须要的这些）');
  if (Object.keys(apiHeaders).length) {
    put(`   学到：${Object.entries(apiHeaders).map(([k, v]) => `${k}=${v}`).join('，')}`);
  } else {
    put('   ⚠️ 一条都没学到。首页的请求上没带这些头的话，章节树会返回「XTBZ IS REQUIRED」；');
    put('      正式抓取时会自动再进一门课去学一次。');
  }

  /* ⑤ 课程列表识别 */
  put('');
  put('⑤ 课程列表识别');
  candidates = classroomListCandidates(records, debug);
  picked = candidates[0] || { rows: [], path: '', reason: '没有候选' };
  summary.listPath = picked.path || '';
  summary.listScore = picked.score || 0;
  if (candidates.length) {
    put(`   ✅ 认出 ${candidates.length} 个候选，采用：${picked.path}（得分 ${picked.score}，${picked.reason}，${picked.rows.length} 条）`);
    put(`      完整地址：${picked.url}`);
    const first = picked.rows[0];
    if (first) {
      put(`      第一个条目的字段：${Object.keys(first).join(', ')}`);
      const sample = Object.entries(first)
        .map(([k, v]) => `${k}=${String(typeof v === 'object' ? JSON.stringify(v) : v).slice(0, 40)}`)
        .join(' | ');
      put(`      第一个条目的值：${sample.slice(0, 400)}`);
    }
  } else {
    put('   ❌ 没有认到课程列表。下面是所有被考虑过、但被拒的对象数组：');
    if (!debug.length) put('      （连一个对象数组都没有 —— 说明响应体没采到，或首页那次请求根本没发生）');
    debug.slice(0, 20).forEach((d) => put(`      · ${d.path}${d.key ? ` [${d.key}]` : ''} ${d.length != null ? `(${d.length} 条)` : ''} —— ${d.why}${d.keys ? `；字段：${d.keys.join(',')}` : ''}`));
  }
  summary.debugCount = debug.length;

  /* ⑥ 兜底能抠出什么 + 课程与匹配 */
  const idsFromReq = classroomIdsFromRecords(records);
  const idsFromHtml = classroomIdsFromHtml(snapshot && snapshot.html);
  summary.idsFromRequests = idsFromReq.length;
  summary.idsFromHtml = idsFromHtml.length;
  put('');
  put(`⑥ 兜底线索：从请求 URL 抠到 ${idsFromReq.length} 个教室 id，从页面 HTML 抠到 ${idsFromHtml.length} 个`);

  let classrooms = (picked.rows || []).map(normalizeYktClassroom).filter(Boolean);
  summary.classrooms = classrooms.length;
  const matchedRooms = [];
  if (classrooms.length) {
    put('');
    put(`⑦ 识别到的雨课堂课程（${classrooms.length} 门）与网络学堂的匹配情况：`);
    for (const room of classrooms) {
      const hit = matchLearnCourse(room, learnCourses);
      if (hit) matchedRooms.push({ room, hit });
      put(`   · ${room.name}${room.sign ? '' : '（⚠️ 列表里没有 course_sign，需要单独取）'} → ${hit ? `✅ 对上「${hit.name}」` : '❌ 网络学堂里没有同名课程'}`);
    }
  } else {
    put('');
    put('⑦ 没识别出任何雨课堂课程，所以不会有作业并入。');
  }

  /* ⑧ 真的往下走一步：取 sign → 章节树 → 作业。
        只看①~⑦ 还不够 —— sign 和章节树才是作业真正的入口。
        这里对**每一门匹配上的课**都实际跑一遍，并把接口的原始报错原样带出来。 */
  if (matchedRooms.length) {
    const swDirect = await swCanReachYuketang();
    const fetchJson = swDirect
      ? (url) => swFetchText(url, apiHeaders)
      : (pageFetchRef ? (url) => pageFetchRef(url, apiHeaders) : null);
    put('');
    put(`⑧ 实际把每门匹配上的课都走一遍（通道：${swDirect ? '后台直连' : (pageFetchRef ? '页面自己发请求' : '不可用')}`
      + `${Object.keys(apiHeaders).length ? `，带 ${Object.keys(apiHeaders).join('/')} 头` : '，没有自定义头'}）`);
    if (!fetchJson) {
      put('   ❌ 两条取数通道都不可用，无法继续');
    } else {
      let totalHw = 0;
      let coursesWithHw = 0;
      let firstRawDumped = false;
      for (const { room, hit } of matchedRooms) {
        const detail = {};
        const sign = await resolveSign(fetchJson, room, detail);
        if (!sign) {
          put(`   ❌ ${room.name}：取不到 course_sign —— ${detail.signError || '未知原因'}`);
          continue;
        }
        const ch = await getJson(fetchJson, yktUrl.chapter(room.id, sign));
        if (!ch.ok) {
          put(`   ❌ ${room.name}（id=${room.id}，sign=${sign}）：章节树请求失败 —— ${ch.reason}`);
          if (ch.raw) put(`        原始响应前 200 字：${ch.raw.slice(0, 200)}`);
          continue;
        }
        const hw = homeworkFromChapter(ch.json);
        totalHw += hw.length;
        if (hw.length) coursesWithHw++;
        const hist = leafTypeHistogram(ch.json);
        put(`   ${hw.length ? '✅' : '·'} ${room.name} → 「${hit.name}」：章节 ${hist.chapters} 个、叶子 ${hist.leaves} 个，其中作业 ${hw.length} 条`
          + `${hw.length ? `（${hw.slice(0, 3).map((h) => h.title).join('、')}）` : ''}`);
        if (!hw.length) {
          const distText = Object.entries(hist.dist).map(([k, v]) => `${k} ×${v}`).join('，');
          put(`        叶子分布：${distText || '一个叶子都没有'}；响应顶层字段：${Object.keys(ch.json || {}).join(',')}`);
          if (!firstRawDumped) {
            firstRawDumped = true;
            put(`        原始响应前 240 字：${JSON.stringify(ch.json).slice(0, 240)}`);
          }
        }
      }
      put('');
      put(`   小结：${matchedRooms.length} 门匹配上的课里，${coursesWithHw} 门有雨课堂作业，共 ${totalHw} 条。`);
      if (!totalHw) {
        put('   ⚠️ 一条作业都没有。如果上面每门课都显示"章节 N 个 / 一个叶子都没有"，');
        put('      说明这些课的章节树本来就是空的（雨课堂那边没往里放内容），不是抓取出错。');
      }
    }
  }

  const ok = !!(pageUser && classrooms.length);
  put('');
  put(ok
    ? '结论：链路是通的。如果作业列表里还是看不到雨课堂作业，问题在「课程名没对上」这一步 —— 把上面 ⑦ 的对照结果发给我。'
    : '结论：链路上游就断了，看上面标 ❌ 的那一行。');

  return { ok, lines, summary };
}
